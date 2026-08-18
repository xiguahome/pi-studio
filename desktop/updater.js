"use strict";

// pi-studio online updater — pure HTTP implementation, no electron-updater.
//
// Flow:
//   1. Fetch latest.json from the update server → compare version → mark "available"
//      (or "downloaded" straight away if the installer is already cached
//      under ~/.pi-studio/updates from a previous download)
//   2. User confirms download → HTTP GET installer into ~/.pi-studio/updates
//      (progress streamed; written as .part and renamed on completion)
//   3. Download complete → shell.openPath(installer) → app.quit()

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, shell } = require("electron");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFile } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const https = require("https");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");

// ---------- configuration ----------

// Manifest lives on the main site; installer urls inside latest.json point
// at a separate file host as absolute URLs.
// Override at runtime via the PI_STUDIO_UPDATE_BASE_URL env var (self-hosting).
const DEFAULT_UPDATE_BASE_URL = process.env.PI_STUDIO_UPDATE_BASE_URL || "https://update.example.com";

/**
 * Root of all pi-studio user data (~/.pi-studio by default).
 * @returns {string}
 */
function getDataDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi-studio");
}

/**
 * User-editable test overrides, re-read on every check so edits apply without
 * restarting the app. File: ~/.pi-studio/update-config.json
 *   { "baseUrl": "http://127.0.0.1:8000" | "D:/path/to/dist-desktop",
 *     "force": true }
 * baseUrl may be an HTTP origin (latest.json + installer fetched over HTTP)
 * or a local directory (latest.json read from disk, installer file-copied —
 * no local web server needed). "force" skips the version comparison so a
 * manifest whose version equals the installed build still triggers the flow.
 * @returns {{ baseUrl?: string, force?: boolean }}
 */
function readUpdateConfig() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(getDataDir(), "update-config.json"), "utf8")
    );
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

/**
 * App-bundled update config, baked into the installer by electron-builder
 * extraResources (resources/update-config.local.json →
 * resources/pi-web/resources/update-config.json). Lets a *distributed build*
 * point at its own update server without hardcoding the URL in source — the
 * operator's real host lives only in the gitignored local file and the shipped
 * installer, never in the repo. Falls through to {} when running from source /
 * not yet packaged.
 * @returns {{ baseUrl?: string }}
 */
function getAppUpdateConfig() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(
        path.join(process.resourcesPath || "", "pi-web", "resources", "update-config.json"),
        "utf8"
      )
    );
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

/**
 * Effective manifest base URL: env override > user update-config.json >
 * app-bundled config (distributed build) > default.
 * @returns {string}
 */
function getBaseUpdateUrl() {
  const envUrl = process.env.PI_UPDATE_BASE_URL;
  if (envUrl) return envUrl;
  const userCfg = readUpdateConfig();
  if (typeof userCfg.baseUrl === "string" && userCfg.baseUrl.trim()) return userCfg.baseUrl.trim();
  const appCfg = getAppUpdateConfig();
  if (typeof appCfg.baseUrl === "string" && appCfg.baseUrl.trim()) return appCfg.baseUrl.trim();
  return DEFAULT_UPDATE_BASE_URL;
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}

/**
 * Fetch the latest.json manifest body from an HTTP origin or local dir.
 * @param {string} baseUrl
 * @returns {Promise<string>}
 */
async function fetchManifest(baseUrl) {
  const manifestPath = `${baseUrl.replace(/[\/\\]+$/, "")}/latest.json`;
  if (isHttpUrl(baseUrl)) return httpGet(manifestPath);
  return fs.promises.readFile(manifestPath, "utf8");
}

/**
 * Resolve the installer source for a manifest url field: http(s) URLs pass
 * through, anything else is treated as a local path (absolute, or relative
 * to the base dir for hand-written test manifests). When the base is a local
 * test dir but the manifest carries a production-style http URL (gen-update-
 * manifest always writes one), map it back to the local file by name so a
 * freshly generated latest.json works unedited against dist-desktop/.
 * @param {string} baseUrl
 * @param {string} url
 * @returns {string}
 */
function resolveInstallerSource(baseUrl, url) {
  if (isHttpUrl(url)) {
    if (isHttpUrl(baseUrl)) return url;
    try {
      return path.join(baseUrl, path.basename(new URL(url).pathname));
    } catch {
      return path.join(baseUrl, path.basename(url));
    }
  }
  if (path.isAbsolute(url)) return url;
  return path.join(baseUrl, url);
}

/**
 * Copy a local installer file with a single 100% progress event.
 * @param {string} src
 * @param {string} destPath
 * @param {(progress: import('./updater').DownloadProgress) => void} onProgress
 * @returns {Promise<void>}
 */
async function copyLocalInstaller(src, destPath, onProgress) {
  const total = fs.statSync(src).size;
  await fs.promises.copyFile(src, destPath);
  onProgress({ percent: 100, transferred: total, total });
}

// ---------- state ----------

/** @type {import('./updater').UpdateState} */
const state = {
  state: "idle", // idle | checking | available | downloading | downloaded | upToDate | error
  currentVersion: "",
  latestVersion: "",
  releaseNotes: "",
  downloadPath: "",
  downloadProgress: { percent: 0, transferred: 0, total: 0 },
  errorMessage: "",
};

/** @type {((data: import('./updater').DownloadProgress) => void) | null} */
let progressCallback = null;

// ---------- helpers ----------

/**
 * Compare two semver-like version strings ("1.2.3").
 * @param {string} a
 * @param {string} b
 * @returns {number} positive if a > b
 */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Get the platform key for the current OS/arch combination.
 * @returns {string}
 */
function getPlatformKey() {
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${process.platform}-${arch}`;
}

/**
 * Persistent directory for downloaded installers. Lives under the agent data
 * dir (~/.pi-studio) instead of the temp dir so a completed download survives
 * restarts — if the install was interrupted, the next check jumps straight
 * back to "downloaded" instead of re-downloading.
 * @returns {string}
 */
function getUpdatesDir() {
  const dir = path.join(getDataDir(), "updates");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Expected on-disk path of the installer for a given version.
 * @param {string} version
 * @returns {string}
 */
function installerFilePath(version) {
  const ext = process.platform === "win32" ? ".exe" : process.platform === "darwin" ? ".dmg" : ".AppImage";
  return path.join(getUpdatesDir(), `pi-studio-update-Setup-${version}${ext}`);
}

/**
 * HTTP GET that returns the response body as text.
 * Follows redirects (up to 5 hops).
 * @param {string} url
 * @returns {Promise<string>}
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const get = (currentUrl, redirects) => {
      if (redirects > 5) {
        reject(new Error("Too many redirects"));
        return;
      }
      const mod = currentUrl.startsWith("https") ? https : http;
      mod
        .get(currentUrl, { timeout: 15000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            get(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} from ${currentUrl}`));
            return;
          }
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          res.on("error", reject);
        })
        .on("error", reject)
        .on("timeout", function () {
          this.destroy();
          reject(new Error("Request timed out"));
        });
    };
    get(url, 0);
  });
}

/**
 * HTTP GET that streams the response to a file, reporting download progress.
 * @param {string} url
 * @param {string} destPath
 * @param {(progress: import('./updater').DownloadProgress) => void} onProgress
 * @returns {Promise<void>}
 */
function httpDownload(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const get = (currentUrl, redirects) => {
      if (redirects > 5) {
        reject(new Error("Too many redirects"));
        return;
      }
      const mod = currentUrl.startsWith("https") ? https : http;
      mod
        .get(currentUrl, { timeout: 30000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            get(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} from ${currentUrl}`));
            return;
          }
          const total = Number(res.headers["content-length"]) || 0;
          let transferred = 0;

          const file = fs.createWriteStream(destPath);
          res.on("data", (chunk) => {
            transferred += chunk.length;
            file.write(chunk);
            const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;
            onProgress({ percent, transferred, total });
          });
          res.on("end", () => {
            file.end();
            resolve();
          });
          res.on("error", (err) => {
            file.close();
            reject(err);
          });
          file.on("error", reject);
        })
        .on("error", reject)
        .on("timeout", function () {
          this.destroy();
          reject(new Error("Download timed out"));
        });
    };
    get(url, 0);
  });
}

// ---------- public API ----------

/**
 * Initialize the updater. Call once after app is ready.
 * Reads current version and schedules a delayed background check.
 */
function initUpdater() {
  state.currentVersion = app.getVersion();

  // Background check after 30 seconds — non-blocking, silent.
  setTimeout(() => {
    void checkForUpdates().catch(() => {
      // Silent failure for background checks.
    });
  }, 30_000);
}

/**
 * Check for updates by fetching latest.json from the update server.
 * @returns {Promise<import('./updater').CheckResult>}
 */
async function checkForUpdates() {
  if (state.state === "checking" || state.state === "downloading") {
    return { status: state.state };
  }

  state.state = "checking";
  state.errorMessage = "";

  try {
    const baseUrl = getBaseUpdateUrl();
    const body = await fetchManifest(baseUrl);
    /** @type {any} */
    const manifest = JSON.parse(body);

    if (!manifest.version || !manifest.platforms) {
      throw new Error("Invalid update manifest format");
    }

    const platformKey = getPlatformKey();
    const platformEntry = manifest.platforms[platformKey];

    if (!platformEntry || !platformEntry.url) {
      // No build available for this platform — treat as up-to-date.
      state.state = "upToDate";
      return { status: "upToDate", currentVersion: state.currentVersion };
    }

    state.latestVersion = manifest.version;
    state.releaseNotes = manifest.releaseNotes || "";

    // Test override: env PI_UPDATE_FORCE or update-config.json "force" skips
    // the version comparison so the whole flow (available → download →
    // install) can be tested against a manifest whose version equals the
    // installed one — otherwise a freshly installed build always reports
    // "up-to-date" and the updater can never be exercised.
    const force =
      ["1", "true"].includes(String(process.env.PI_UPDATE_FORCE || "").toLowerCase()) ||
      readUpdateConfig().force === true;

    if (force || compareVersions(manifest.version, state.currentVersion) > 0) {
      // Cache so downloadUpdate() can skip re-fetching the manifest.
      state._downloadUrl = resolveInstallerSource(baseUrl, platformEntry.url);

      // An installer already on disk (e.g. from an interrupted install before
      // the app was closed) short-circuits to "downloaded". Safe without a
      // size check: the file only ever appears via a rename of the completed
      // .part download, so its existence implies completeness.
      const cachedPath = installerFilePath(manifest.version);
      let cached = false;
      try {
        cached = fs.existsSync(cachedPath);
      } catch {
        cached = false;
      }
      if (cached) {
        state.state = "downloaded";
        state.downloadPath = cachedPath;
        return {
          status: "downloaded",
          currentVersion: state.currentVersion,
          latestVersion: manifest.version,
          releaseNotes: state.releaseNotes,
          downloadPath: cachedPath,
        };
      }

      state.state = "available";
      return {
        status: "available",
        currentVersion: state.currentVersion,
        latestVersion: manifest.version,
        releaseNotes: manifest.releaseNotes || "",
        downloadUrl: platformEntry.url,
        downloadSize: platformEntry.size || 0,
      };
    }

    state.state = "upToDate";
    return { status: "upToDate", currentVersion: state.currentVersion };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[updater] check failed:", message);
    state.state = "error";
    state.errorMessage = message;
    return { status: "error", errorMessage: message };
  }
}

/**
 * Download the installer for the detected update.
 * @param {import('electron').IpcMainInvokeEvent} event
 * @returns {Promise<import('./updater').DownloadResult>}
 */
async function downloadUpdate(event) {
  if (state.state !== "available") {
    return { status: state.state, errorMessage: "No update available to download" };
  }

  // Re-fetch manifest to get the download URL if not cached.
  if (!state._downloadUrl) {
    try {
      const baseUrl = getBaseUpdateUrl();
      const body = await fetchManifest(baseUrl);
      const manifest = JSON.parse(body);
      const platformKey = getPlatformKey();
      const platformEntry = manifest.platforms[platformKey];
      if (!platformEntry?.url) {
        throw new Error("Download URL not found in manifest");
      }
      state._downloadUrl = resolveInstallerSource(baseUrl, platformEntry.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.state = "error";
      state.errorMessage = message;
      return { status: "error", errorMessage: message };
    }
  }

  state.state = "downloading";
  state.downloadProgress = { percent: 0, transferred: 0, total: 0 };

  // Download into the persistent updates dir, via a .part file that is
  // renamed on completion so a partial file is never mistaken for a
  // complete installer by the cached-file check in checkForUpdates().
  const destPath = installerFilePath(state.latestVersion);
  const partPath = `${destPath}.part`;
  try {
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
  } catch {
    // ignore
  }

  try {
    progressCallback = (data) => {
      state.downloadProgress = data;
      // Push progress to renderer via IPC.
      if (event && !event.sender.isDestroyed()) {
        event.sender.send("pi-desktop:update-progress", data);
      }
    };

    if (isHttpUrl(state._downloadUrl)) {
      await httpDownload(state._downloadUrl, partPath, (data) => {
        progressCallback?.(data);
      });
    } else {
      await copyLocalInstaller(state._downloadUrl, partPath, (data) => {
        progressCallback?.(data);
      });
    }

    fs.renameSync(partPath, destPath);
    state.downloadPath = destPath;
    state.state = "downloaded";
    progressCallback = null;
    return { status: "downloaded", downloadPath: destPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[updater] download failed:", message);
    state.state = "error";
    state.errorMessage = message;
    progressCallback = null;
    return { status: "error", errorMessage: message };
  }
}

/**
 * macOS: mount the downloaded dmg and copy the .app bundle over the current
 * installation with ditto, then unmount. Throws on failure so the caller can
 * fall back to opening the dmg for a manual drag-install.
 * @param {string} dmgPath
 * @returns {Promise<void>}
 */
async function applyDmgUpdate(dmgPath) {
  /** @type {(cmd: string, args: string[]) => Promise<string>} */
  const execFileAsync = (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
  const mountPoint = "/Volumes/pi-studio-update";
  // pi-studio.app — execPath is <app>.app/Contents/MacOS/pi-studio
  const currentApp = path.resolve(process.execPath, "..", "..", "..");
  try {
    await execFileAsync("hdiutil", ["detach", mountPoint, "-force"]);
  } catch {
    // not mounted — fine
  }
  await execFileAsync("hdiutil", ["attach", dmgPath, "-mountpoint", mountPoint, "-nobrowse", "-readonly"]);
  try {
    const entries = fs.readdirSync(mountPoint).filter((name) => name.endsWith(".app"));
    if (!entries.length) throw new Error("No .app bundle found in the downloaded dmg");
    await execFileAsync("ditto", [path.join(mountPoint, entries[0]), currentApp]);
  } finally {
    try {
      await execFileAsync("hdiutil", ["detach", mountPoint]);
    } catch {
      // best-effort unmount
    }
  }
}

/**
 * Apply the downloaded update, per platform:
 *  - win32:  return the installer path — main.js spawns the NSIS installer
 *    WITHOUT /S. The assisted wizard itself is the update UI: on update it
 *    auto-skips the install-mode/directory pages (skipPageIfUpdated +
 *    existing per-user install), shows native progress, and its finish page
 *    ("运行 pi-studio" pre-checked) relaunches the new build with --updated.
 *    AV real-time scanning locks freshly extracted exe/dll files for seconds
 *    — the patched extract-retry (Sleep 1000 × 150) self-heals instead of
 *    trapping in a dialog, and customCheckAppRunning (installer.nsh)
 *    silently force-closes every process running from the install dir.
 *    Per-user installs need no elevation, so a plain detached spawn is safe.
 *  - linux:  the download IS the new AppImage — atomically replace the
 *    running image (tmp file + rename keeps the old inode alive for the
 *    running process) and relaunch; no installer involved.
 *  - darwin: mount the dmg and ditto the .app over the current install; on
 *    failure open the dmg so the user can drag-install manually.
 * Quitting the app is the caller's (main.js) job — it hard-exits immediately
 * after this returns (win32), or relaunches after exiting (linux/mac).
 * @returns {Promise<{ status: string, installerPid?: number, errorMessage?: string }>}
 */
async function applyUpdate() {
  if (state.state !== "downloaded" || !state.downloadPath) {
    return { status: "error", errorMessage: "No downloaded update to apply" };
  }

  const installerPath = state.downloadPath;
  console.log(`[updater] applying update (${process.platform}): ${installerPath}`);

  try {
    if (process.platform === "win32") {
      // main.js spawns this installer (no /S) — the wizard itself shows
      // progress and relaunches the app. The app's own exe is being
      // replaced, so it cannot host that UI itself.
      state.state = "installing";
      return { status: "installing", installerPath };
    }

    if (process.platform === "linux") {
      const target = process.env.APPIMAGE || process.execPath;
      const tmp = `${target}.update-${Date.now()}`;
      fs.chmodSync(installerPath, 0o755);
      fs.copyFileSync(installerPath, tmp);
      fs.renameSync(tmp, target); // atomic replace; running instance keeps its inode

      state.state = "installing";
      return { status: "installing" };
    }

    if (process.platform === "darwin") {
      try {
        await applyDmgUpdate(installerPath);
      } catch (error) {
        // Automated copy failed (e.g. /Applications permissions) — fall back
        // to the standard drag-install: mount the dmg and let the user take
        // over. The app still quits as requested.
        const message = error instanceof Error ? error.message : String(error);
        console.error("[updater] dmg update failed, opening for manual install:", message);
        await shell.openPath(installerPath);
      }

      state.state = "installing";
      return { status: "installing" };
    }

    return { status: "error", errorMessage: `Unsupported platform: ${process.platform}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[updater] install failed:", message);
    state.state = "error";
    state.errorMessage = message;
    return { status: "error", errorMessage: message };
  }
}

/**
 * Get a snapshot of the current updater state.
 * @returns {import('./updater').UpdateState}
 */
function getState() {
  const snapshot = { ...state, downloadProgress: { ...state.downloadProgress } };
  delete snapshot._downloadUrl;
  return snapshot;
}

// Export everything as a plain object — no named exports so the
// require("electron") call in this file stays in the main-process bundle.
module.exports = { initUpdater, checkForUpdates, downloadUpdate, applyUpdate, getState };
