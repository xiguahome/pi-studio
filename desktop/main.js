"use strict";

// Electron main process for pi-studio. Boots the existing Next.js app through
// bin/pi-web.js (see ./server.js) and shows it in a BrowserWindow. The web
// app itself is untouched — desktop mode is just another host for it.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } = require("electron");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require("crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAppRoot, resolveNodeRuntime, startServer, stopServer } = require("./server");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { initUpdater, checkForUpdates, downloadUpdate, applyUpdate, getState } = require("./updater");

// ---------- built-in browser CDP exposure ----------
// Expose the Electron <webview> (right-sidebar built-in browser) over the
// Chrome DevTools Protocol so external tools (e.g. the chrome-devtools MCP)
// can drive it directly. Disabled when PI_DESKTOP_CDP === "0". Port is
// overridable via PI_DESKTOP_CDP_PORT — default 9333 to avoid clashing with
// CentBrowser's 9222 that WorkBuddy uses on this machine.
const CDP_ENABLED = process.env.PI_DESKTOP_CDP !== "0";
const CDP_PORT = Number(process.env.PI_DESKTOP_CDP_PORT) || 9333;
if (CDP_ENABLED) {
  // Must be set before the app is ready; binds to localhost only.
  app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

// ---------- agent data directory ----------
// pi-studio keeps all pi agent data (settings/models/auth/sessions/skills/…)
// under ~/.pi-studio so the SDK's <agentDir>/skills coincides with the canonical
// skills store the external skills CLI writes to. PI_CODING_AGENT_DIR is read
// by the pi SDK's getAgentDir() (see @earendil-works/pi-coding-agent config).
function configureAgentDataDir() {
  const agentDir = path.join(os.homedir(), ".pi-studio");
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  console.log(`[pi-studio] agent data dir: ${agentDir}`);
}

let mainWindow = null;
let serverInfo = null; // { url, port } once the local server is up
let bootFailed = false;
// First-run dependency install child, so it can be killed on quit.
let installChild = null;
// URL currently loaded in the right-sidebar <webview>, kept so the CDP
// endpoint can report which target corresponds to the built-in browser.
let browserWebviewUrl = null;

// ---------- window state persistence ----------

function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStateFile(), "utf8"));
    const bounds = state.bounds;
    if (
      bounds &&
      [bounds.x, bounds.y, bounds.width, bounds.height].every((v) => typeof v === "number" && Number.isFinite(v)) &&
      bounds.width >= 480 &&
      bounds.height >= 360
    ) {
      return state;
    }
  } catch {
    // missing/corrupt state file falls back to defaults
  }
  return undefined;
}

function saveWindowState(win) {
  try {
    const maximized = win.isMaximized();
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(windowStateFile(), JSON.stringify({ bounds, maximized }), "utf8");
  } catch {
    // best-effort persistence
  }
}

// ---------- navigation guards ----------

function isAllowedNavigation(url) {
  if (!serverInfo) return url.startsWith("file://");
  return url.startsWith(serverInfo.url) || url.startsWith("file://");
}

function attachNavigationGuards(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  // Last-resort guard: CDP Page.navigate (and some programmatic navigations)
  // bypass will-navigate's preventDefault. If an external tool ever lands the
  // main window on a non-allowable URL (e.g. an agent drove it to baidu.com via
  // chrome-devtools before the webview-only patch was in place), snap it back to
  // the pi-studio app so the UI is never replaced by external content.
  win.webContents.on("did-navigate", (_event, url) => {
    if (serverInfo && !isAllowedNavigation(url)) {
      void win.loadURL(serverInfo.url);
    }
  });
}

// ---------- window lifecycle ----------

function createWindow() {
  const saved = loadWindowState();
  const win = new BrowserWindow({
    ...(saved?.bounds ?? { width: 1280, height: 840 }),
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: "#1a1a1a",
    title: "pi-studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  if (saved?.maximized) win.maximize();
  attachNavigationGuards(win);

  win.once("ready-to-show", () => win.show());
  win.on("close", (event) => {
    saveWindowState(win);
    // With the tray toggle on, closing hides to the tray instead of quitting
    // (WeChat-style). `app.quitting` is set by before-quit so real quit paths
    // (tray menu / update install) still exit; the serverInfo guard keeps the
    // first-run dependency install (loading screen, no server yet) closable.
    if (!app.quitting && windowConfig.minimizeToTray && serverInfo?.url) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    if (bootFailed) return;
    console.error(`[desktop] failed to load app: ${errorCode} ${errorDescription}`);
  });

  mainWindow = win;
  void win.loadFile(path.join(__dirname, "loading.html"));
  return win;
}

// ---------- system tray (Settings → General "minimize to tray") ----------
// The main process is the only reader/writer of window-config.json; the
// Settings → General toggle talks to it over IPC, so changes apply live
// without a restart (unlike the browser-mode toggle).

let windowConfig = { minimizeToTray: false };
let tray = null;

function windowConfigFile() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi-studio");
  return path.join(agentDir, "window-config.json");
}

function readWindowConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(windowConfigFile(), "utf8"));
    if (typeof parsed.minimizeToTray === "boolean") return { minimizeToTray: parsed.minimizeToTray };
  } catch {
    // missing/corrupt file keeps the default
  }
  return { minimizeToTray: false };
}

function saveWindowConfig(config) {
  try {
    fs.writeFileSync(windowConfigFile(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error("[desktop] save window config failed:", error);
  }
}

function showMainWindowFromTray() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function resolveTrayIcon() {
  // getAppRoot() is <project root> in dev and resources/pi-web when packaged,
  // and public/ is shipped to pi-web/public via extraResources — one path for
  // both layouts.
  const image = nativeImage.createFromPath(path.join(getAppRoot(), "public", "icons", "icon-512.png"));
  if (!image.isEmpty()) {
    // The 512px source gets muddy in the 16-32px tray area; resize crisply.
    const size = process.platform === "darwin" ? 16 : 32;
    return image.resize({ width: size, height: size });
  }
  // Fallback (Windows): pull the small icon straight from the executable.
  if (process.platform === "win32") {
    try {
      return await app.getFileIcon(process.execPath, { size: "small" });
    } catch {
      // fall through
    }
  }
  return image;
}

async function createTray() {
  if (tray && !tray.isDestroyed()) return;
  const image = await resolveTrayIcon();
  tray = new Tray(image);
  tray.setToolTip("pi-studio");
  const zh = String(app.getLocale()).toLowerCase().startsWith("zh");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: zh ? "显示主窗口" : "Show main window", click: () => showMainWindowFromTray() },
      { type: "separator" },
      { label: zh ? "退出 pi-studio" : "Quit pi-studio", click: () => app.quit() },
    ])
  );
  // Windows/Linux: left click restores the window (right click opens the
  // context menu). macOS: left click opens the menu, restore on double-click.
  if (process.platform === "darwin") {
    tray.on("double-click", () => showMainWindowFromTray());
  } else {
    tray.on("click", () => showMainWindowFromTray());
  }
}

function destroyTray() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

function applyMinimizeToTray(enabled) {
  windowConfig = { minimizeToTray: enabled };
  if (enabled) {
    void createTray();
    return;
  }
  destroyTray();
  // The window may be sitting hidden in the tray right now — bring it back,
  // otherwise there is no way to reach the app anymore.
  const win = mainWindow;
  if (win && !win.isDestroyed() && !win.isVisible()) showMainWindowFromTray();
}

function setLoadingStatus(text, isError = false) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const safeText = JSON.stringify(text);
  win.webContents
    .executeJavaScript(`window.setLoadingStatus && window.setLoadingStatus(${safeText}, ${isError});`, true)
    .catch(() => {});
}

function setLoadingProgress(percent, label) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const safeLabel = label == null ? null : JSON.stringify(label);
  win.webContents
    .executeJavaScript(`window.setLoadingProgress && window.setLoadingProgress(${Number.isFinite(percent) ? percent : "null"}, ${safeLabel});`, true)
    .catch(() => {});
}

// ---------- first-run dependency installation ----------
// The packaged installer ships WITHOUT node_modules (electron-builder.yml
// header); on first launch we install production dependencies with the bundled
// npm (node-runtime) and render progress on loading.html. After a successful
// install node_modules persists, so subsequent launches skip straight to boot.

// npm emits a torrent of http-fetch lines while downloading; batch them so we
// don't hammer the loading page with an executeJavaScript round-trip per line.
let logBuffer = [];
let logFlushTimer = null;

function pushInstallLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > 200) logBuffer.splice(0, logBuffer.length - 200);
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    const lines = logBuffer;
    logBuffer = [];
    if (!lines.length) return;
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    const payload = JSON.stringify(lines);
    win.webContents
      .executeJavaScript(`window.setLoadingLogs && window.setLoadingLogs(${payload});`, true)
      .catch(() => {});
  }, 80);
}

/** Any production dependency missing from the bundled pi-web? */
function missingDependencies(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const deps = pkg.dependencies || {};
    const nm = path.join(root, "node_modules");
    for (const name of Object.keys(deps)) {
      if (!fs.existsSync(path.join(nm, name))) return true;
    }
    // npm writes this marker on every completed install.
    if (!fs.existsSync(path.join(nm, ".package-lock.json"))) return true;
    return false;
  } catch {
    return true;
  }
}

// A package directory can exist with a fresh package.json but gutted contents
// (an interrupted install once left typebox/ without build/index.mjs while
// still reporting version 1.3.7). npm never self-heals that, and the top-level
// check above cannot see transitive packages — so audit every lockfile entry
// that is actually on disk: its version must match the lock and at least one
// resolved entry point must exist. Returns the lock dirs of broken packages.

// Node resolves extensionless entries (main: "./lib/index") against
// lib/index.js etc. — mirror that before declaring an entry missing.
function packageEntryExists(pkgDir, entry) {
  const p = path.join(pkgDir, entry);
  if (fs.existsSync(p)) return true;
  for (const ext of [".js", ".mjs", ".cjs", ".json", ".node"]) {
    if (fs.existsSync(p + ext)) return true;
  }
  return fs.existsSync(path.join(p, "index.js"));
}

function unhealthyPackages(root) {
  const broken = [];
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    for (const [dir, meta] of Object.entries(lock.packages || {})) {
      if (!dir.startsWith("node_modules/") || !meta || !meta.version) continue;
      const pkgDir = path.join(root, dir);
      let pkg;
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      } catch {
        continue; // not installed here (platform optional npm skipped) — npm's call
      }
      if (pkg.version !== meta.version) {
        broken.push(dir);
        continue;
      }
      const entries = [];
      const collectExport = (e) => {
        if (typeof e === "string") entries.push(e);
        else if (e && typeof e === "object") {
          for (const key of ["import", "require", "node", "default"]) {
            if (key in e) collectExport(e[key]);
          }
        }
      };
      collectExport(pkg.exports?.["."]);
      if (typeof pkg.main === "string") entries.push(pkg.main);
      if (typeof pkg.module === "string") entries.push(pkg.module);
      const paths = entries
        .map((e) => e.split("?")[0])
        .filter((e) => e.startsWith("./") || e.startsWith("../"));
      if (paths.length > 0 && !paths.some((p) => packageEntryExists(pkgDir, p))) {
        broken.push(dir);
      }
    }
  } catch {
    // A broken probe must never block boot — treat as healthy.
  }
  return broken;
}

// ---------- shared runtime dir (~/.pi-studio/app-runtime) ----------
// node_modules lives OUTSIDE the install dir so an app update never has to
// delete and re-download ~1GB of dependencies: the NSIS update wipes the
// install dir (its old-uninstaller pass), and the next launch just recreates
// a junction appRoot/node_modules → sharedRoot/node_modules. NSIS RMDir /r
// removes the junction itself without following it, so the shared copy
// survives updates untouched. A fingerprint of package-lock.json guards
// against stale deps when a new app version changes dependencies.

function sharedRuntimeRoot() {
  return path.join(os.homedir(), ".pi-studio", "app-runtime");
}

function lockFingerprint(appRoot) {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(path.join(appRoot, "package-lock.json"))).digest("hex");
  } catch {
    return null;
  }
}

function readStoredFingerprint(sharedRoot) {
  try {
    return fs.readFileSync(path.join(sharedRoot, ".lock-fingerprint"), "utf8").trim();
  } catch {
    return null;
  }
}

function writeStoredFingerprint(sharedRoot, fingerprint) {
  try {
    fs.writeFileSync(path.join(sharedRoot, ".lock-fingerprint"), `${fingerprint}\n`, "utf8");
  } catch {
    // best-effort; a stale fingerprint only costs one reinstall
  }
}

function isJunction(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink(); // junctions report as symlinks
  } catch {
    return false;
  }
}

/** (Re)create appRoot/node_modules as a junction into the shared copy. */
function ensureJunction(appRoot, sharedRoot) {
  const appNm = path.join(appRoot, "node_modules");
  // Remove whatever is there (dangling junction, stale link) without
  // following it, then link to the shared copy. "junction" needs no admin
  // rights on Windows; on macOS/Linux the type is ignored and a plain
  // directory symlink is created.
  try {
    fs.lstatSync(appNm);
    fs.rmSync(appNm, { recursive: true, force: true });
  } catch {
    // nothing there
  }
  fs.symlinkSync(path.join(sharedRoot, "node_modules"), appNm, process.platform === "win32" ? "junction" : "dir");
}

/** Stage manifests + patch assets into the shared runtime dir for npm. */
function stageSharedRuntime(appRoot, sharedRoot) {
  fs.mkdirSync(sharedRoot, { recursive: true });
  for (const name of ["package.json", "package-lock.json", "patches", "scripts"]) {
    try {
      fs.rmSync(path.join(sharedRoot, name), { recursive: true, force: true });
      fs.cpSync(path.join(appRoot, name), path.join(sharedRoot, name), { recursive: true });
    } catch {
      // a missing optional asset must not block the install
    }
  }
}

/**
 * Ensure the shared runtime node_modules exists (installing with visual
 * progress when missing) and junction it into pi-web. Resolves true when
 * boot can continue, false when the user quit.
 */
async function ensureDependencies(win) {
  if (!app.isPackaged) return true; // dev runs straight from the repo
  const appRoot = getAppRoot();
  const sharedRoot = sharedRuntimeRoot();
  const sharedNm = path.join(sharedRoot, "node_modules");
  const appNm = path.join(appRoot, "node_modules");
  const fingerprint = lockFingerprint(appRoot);

  // Legacy migration: a REAL node_modules inside the install dir (pre-junction
  // installs) becomes the shared copy via rename — instant on the same volume.
  if (fs.existsSync(appNm) && !isJunction(appNm)) {
    try {
      fs.mkdirSync(sharedRoot, { recursive: true });
      fs.rmSync(sharedNm, { recursive: true, force: true });
      fs.renameSync(appNm, sharedNm);
      if (fingerprint) writeStoredFingerprint(sharedRoot, fingerprint);
    } catch {
      // Cross-volume rename or locked files: drop it and reinstall clean.
      try {
        fs.rmSync(appNm, { recursive: true, force: true });
      } catch {
        // leave it; the junction step below will surface the failure
      }
    }
  }

  const brokenPkgs = unhealthyPackages(sharedRoot);
  const sharedUsable =
    !missingDependencies(sharedRoot) && brokenPkgs.length === 0 && fingerprint !== null && fingerprint === readStoredFingerprint(sharedRoot);

  if (sharedUsable) {
    ensureJunction(appRoot, sharedRoot);
    return true;
  }

  setLoadingStatus("正在准备运行依赖…");
  stageSharedRuntime(appRoot, sharedRoot);
  // Ghost packages (fresh version in package.json, gutted contents) are
  // invisible to npm's up-to-date check and would survive a plain install —
  // delete them so the install below re-fetches exactly those.
  for (const dir of brokenPkgs) {
    try {
      fs.rmSync(path.join(sharedRoot, dir), { recursive: true, force: true });
    } catch {
      // best-effort; a leftover ghost still fails the audit and retries next boot
    }
  }
  const { command: nodeBin } = resolveNodeRuntime();
  let script = path.join(__dirname, "scripts", "first-run-install.mjs");
  if (app.isPackaged) {
    // The installer runs under the standalone node-runtime node.exe, which
    // cannot read inside app.asar (an Electron-only virtual FS). electron-builder
    // asarUnpack puts a physical copy in app.asar.unpacked — point the child at
    // that file, otherwise node exits with ENOENT and the install never starts.
    script = script.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  }

  return new Promise((resolve) => {
    let settled = false;
    let installError = null;
    let installLogPath = null;
    const settle = (ok) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };

    const proc = spawn(nodeBin, [script, "--app-root", sharedRoot], {
      cwd: sharedRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    installChild = proc;

    proc.stdout.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (event.type === "stage") setLoadingStatus(event.message);
        else if (event.type === "progress") setLoadingProgress(event.percent, event.label);
        else if (event.type === "log") pushInstallLog(event.line);
        else if (event.type === "error") installError = event.message;
        else if (event.type === "logfile") installLogPath = event.path;
      }
    });
    // Script failures are reported as {type:"error"} on stdout; stderr is
    // just npm noise already surfaced through log events.
    proc.stderr.on("data", () => {});

    const reportFailure = async (code, error) => {
      const { response } = await dialog.showMessageBox(win, {
        type: "error",
        title: "依赖安装失败",
        message: "首次运行依赖安装失败，pi-studio 需要这些依赖才能启动。",
        detail:
          (error || `安装进程退出码 ${code}。请检查网络连接后重试。`) +
          (installLogPath ? `\n\n安装日志已保存到：\n${installLogPath}` : ""),
        buttons: ["重试", "退出"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        settle(await ensureDependencies(win));
      } else {
        settle(false);
      }
    };

    proc.on("exit", (code) => {
      installChild = null;
      if (code === 0 && !installError) {
        if (fingerprint) writeStoredFingerprint(sharedRoot, fingerprint);
        try {
          ensureJunction(appRoot, sharedRoot);
        } catch (error) {
          reportFailure(1, `无法链接共享依赖目录：${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        settle(true);
        return;
      }
      reportFailure(code, installError);
    });
    // Spawn-level failure (e.g. node-runtime missing): 'exit' never fires, so
    // without this handler ensureDependencies would hang the loading screen.
    proc.on("error", (error) => {
      installChild = null;
      reportFailure(127, `无法启动依赖安装进程：${error.message}`);
    });
  });
}

async function boot(win) {
  // Dev convenience: attach to an already-running pi-studio server (e.g. one
  // started with `npm run dev`) instead of spawning another one.
  const externalUrl = process.env.PI_DESKTOP_SERVER_URL;
  if (externalUrl) {
    serverInfo = { url: externalUrl.replace(/\/$/, ""), port: 0 };
    setLoadingStatus("Connecting to external pi-studio server…");
    try {
      await win.loadURL(serverInfo.url);
    } catch (error) {
      // loadURL rejects when the external server is unreachable (ERR_FAILED).
      // Without this catch the rejection stays unhandled and the window is
      // left on the dark loading page with no explanation.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[desktop] external server unreachable at ${serverInfo.url}: ${message}`);
      setLoadingStatus(
        `Cannot reach ${serverInfo.url} — start it with "npm run dev" first. ${message}`,
        true,
      );
    }
    return;
  }

  setLoadingStatus("Preparing environment…");
  try {
    const ready = await ensureDependencies(win);
    if (!ready) {
      app.quit();
      return;
    }
  } catch (error) {
    bootFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error("[desktop] dependency preparation failed:", message);
    setLoadingStatus(message, true);
    app.quit();
    return;
  }

  setLoadingStatus("Starting local server…");
  try {
    serverInfo = await startServer({
      onLog: (line) => console.log(`[pi-studio] ${line}`),
      onUnexpectedExit: handleServerCrash,
    });
  } catch (error) {
    bootFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error("[desktop] server failed to start:", message);
    setLoadingStatus(message, true);
    const { response } = await dialog.showMessageBox(win, {
      type: "error",
      title: "pi-studio failed to start",
      message: "The local pi-studio server could not be started.",
      detail: message,
      buttons: ["Retry", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      bootFailed = false;
      void boot(win);
    } else {
      app.quit();
    }
    return;
  }

  setLoadingStatus("Loading interface…");
  await win.loadURL(serverInfo.url);
}

function handleServerCrash(code) {
  if (bootFailed || app.quitting) return;
  const win = mainWindow;
  const buttons = ["Restart pi-studio", "Quit"];
  void dialog
    .showMessageBox(win ?? undefined, {
      type: "error",
      title: "pi-studio server stopped",
      message: "The local pi-studio server exited unexpectedly.",
      detail: `Exit code: ${code ?? "unknown"}. Sessions on disk are unaffected.`,
      buttons,
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) {
        app.relaunch();
      }
      app.exit(response === 0 ? 0 : 1);
    });
}

// ---------- application menu ----------
// Electron ships a default File/Edit/View/Window/Help menu when no menu is
// set. The web app owns its own toolbar, so drop it entirely. macOS keeps a
// minimal menu because the system menu bar is mandatory and provides the
// copy/paste accelerators there.
function configureMenu() {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        { role: "windowMenu" },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
}

// ---------- built-in browser webview tracking ----------
// Keep browserWebviewUrl in sync so the CDP endpoint can point external tools
// at the exact <webview> target that backs the right-sidebar built-in browser.
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  // Route target="_blank" / window.open() clicks to an in-webview navigation
  // instead of dropping them. Without this (plus <webview allowpopups>), links
  // on most modern sites are silently dead. Only http(s) navigates in place;
  // everything else (mailto:, custom schemes) is simply denied.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void contents.loadURL(url);
    return { action: "deny" };
  });
  const sync = () => {
    browserWebviewUrl = contents.getURL();
  };
  contents.on("did-navigate", sync);
  contents.on("did-navigate-in-page", sync);
  contents.on("did-start-loading", sync);
  contents.on("did-stop-loading", sync);
});

// ---------- app lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = mainWindow;
    if (!win) return;
    // win.show() matters when the window is hidden in the tray — focus alone
    // does not reveal a hidden window.
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  ipcMain.handle("pi-desktop:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    serverUrl: serverInfo?.url ?? null,
  }));

  // Native OS folder picker for the "Open project…" entry. Returns the chosen
  // absolute path, or null when the user cancels. The web build falls back to
  // the in-app DirectoryPicker instead.
  ipcMain.handle("pi-desktop:select-directory", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    return canceled ? null : (filePaths[0] ?? null);
  });

  // Report the CDP endpoint + ALL built-in browser webview targets so the UI
  // can show connection hints and external tools (chrome-devtools) can attach.
  // Each <webview> (i.e. each browser tab) is a separate CDP target on the SAME
  // port — multiple browser tabs coexist without any port conflict.
  ipcMain.handle("pi-desktop:browser-cdp-info", async () => {
    if (!CDP_ENABLED) return null;
    let webviews = [];
    try {
      if (typeof fetch === "function") {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list)) {
            webviews = list
              .filter((t) => t.type === "webview")
              .map((t) => ({
                targetId: t.id ?? null,
                url: t.url ?? null,
                webSocketDebuggerUrl: t.webSocketDebuggerUrl ?? null,
              }));
          }
        }
      }
    } catch {
      // Endpoint may not be ready yet; the badge still shows the base URL.
    }
    const first = webviews[0] ?? null;
    return {
      port: CDP_PORT,
      endpoint: `http://127.0.0.1:${CDP_PORT}`,
      webviewUrl: first?.url ?? browserWebviewUrl,
      targetId: first?.targetId ?? null,
      webSocketDebuggerUrl: first?.webSocketDebuggerUrl ?? null,
      webviews,
    };
  });

  // Clear built-in browser data from the isolated `persist:browser` partition.
  // Flags select which categories to wipe; the UI defaults to cache-only so
  // login state (cookies) survives unless explicitly requested.
  ipcMain.handle("pi-desktop:clear-browser-data", async (_event, flags) => {
    const f = flags ?? {};
    try {
      const ses = session.fromPartition("persist:browser");
      const tasks = [];
      if (f.cache) {
        tasks.push(ses.clearCache());
        tasks.push(ses.clearStorageData({ storages: ["shadercache", "cachestorage"] }));
      }
      const storages = [];
      if (f.cookies) storages.push("cookies");
      if (f.local) storages.push("localstorage", "indexdb", "filesystem");
      if (f.serviceWorkers) storages.push("serviceworkers");
      if (storages.length > 0) tasks.push(ses.clearStorageData({ storages }));
      await Promise.all(tasks);
      return { ok: true };
    } catch (error) {
      console.error("[desktop] clear browser data failed:", error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ---------- online updater IPC ----------

  ipcMain.handle("pi-desktop:update-check", () => checkForUpdates());
  ipcMain.handle("pi-desktop:update-download", (event) => downloadUpdate(event));
  ipcMain.handle("pi-desktop:update-install", async () => {
    const result = await applyUpdate();
    if (result.status === "installing") {
      // Windows: spawn the NSIS installer WITHOUT /S — the assisted wizard
      // itself is the update UI (native title bar: draggable, closable,
      // real progress). On update it auto-skips the install-mode and
      // directory pages (skipPageIfUpdated + existing per-user install), so
      // the user sees progress → finish page with "运行 pi-studio"
      // pre-checked → clicking 完成 launches the new build with --updated.
      // No external watcher is needed: the installer runs from
      // ~/.pi-studio/updates (outside the install dir) and relaunches the
      // app itself via MUI_FINISHPAGE_RUN. customCheckAppRunning
      // (installer.nsh) force-closes any leftover install-dir process, and
      // cwd stays in %TEMP% so no inherited handle pins the install dir.
      if (process.platform === "win32" && result.installerPath) {
        spawn(result.installerPath, [], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
          cwd: os.tmpdir(),
        }).unref();
        app.exit(0);
        return result;
      }

      // linux / macOS: the update was applied in place inside applyUpdate()
      // (AppImage atomic replace / ditto over the .app bundle) — same path,
      // new content. Relaunch after we exit.
      app.relaunch();
      try {
        await stopServer();
      } catch {
        // best-effort; the OS reaps the node server with us
      }
      app.exit(0);
    }
    return result;
  });
  ipcMain.handle("pi-desktop:update-state", () => getState());

  // ---------- system tray IPC (Settings → General "minimize to tray") ----------

  ipcMain.handle("pi-desktop:get-window-config", () => windowConfig);
  ipcMain.handle("pi-desktop:set-window-config", (_event, config) => {
    if (!config || typeof config.minimizeToTray !== "boolean") {
      throw new Error("invalid window config: minimizeToTray must be a boolean");
    }
    applyMinimizeToTray(config.minimizeToTray);
    saveWindowConfig(windowConfig);
    return windowConfig;
  });

  void app.whenReady().then(() => {
    configureAgentDataDir();
    configureMenu();
    initUpdater();
    if (CDP_ENABLED) {
      console.log(`[pi-studio] CDP remote debugging enabled at http://127.0.0.1:${CDP_PORT}`);
    }
    const win = createWindow();
    windowConfig = readWindowConfig();
    if (windowConfig.minimizeToTray) void createTray();
    void boot(win);
  });

  app.on("window-all-closed", () => {
    // On macOS keep the app (and its local server) alive; the window is
    // recreated on activate and reconnects to the still-running server.
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (mainWindow) {
      // Window kept alive but hidden (closed to the tray) — bring it back.
      showMainWindowFromTray();
      return;
    }
    const win = createWindow();
    if (serverInfo) {
      void win.loadURL(serverInfo.url);
    } else {
      void boot(win);
    }
  });

  app.on("before-quit", () => {
    app.quitting = true;
    setLoadingStatus("Shutting down…");
    // Don't leave the first-run npm install running if the user quits mid-setup.
    if (installChild) {
      const proc = installChild;
      const pid = proc.pid;
      installChild = null;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            proc.kill();
          } catch {
            // already gone
          }
        }
      }
    }
    void stopServer();
  });
}
