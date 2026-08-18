#!/usr/bin/env node
// @ts-check
/**
 * first-run-install.mjs — install production dependencies for a packaged
 * pi-studio whose installer ships WITHOUT node_modules (see electron-builder.yml).
 *
 * Spawned by desktop/main.js on first launch. It runs `npm install --omit=dev`
 * against the bundled npm from node-runtime (node -v 22.x ships npm 10.x), so
 * the on-device install never depends on a system Node/npm and devDependencies
 * (electron, electron-builder, markdown/mermaid tooling — already bundled into
 * the .next client) are skipped. postinstall still runs: patch-package is a
 * production dependency (package.json) so the `@earendil-works/pi-coding-agent`
 * `.pi → .pi-studio` patch and the idempotent patch-pi-*.mjs scripts apply.
 *
 * Usage:
 *   node desktop/scripts/first-run-install.mjs --app-root <pi-web dir>
 *
 * Env:
 *   PI_NPM_REGISTRY  override the npm registry (default npmmirror; set to
 *                    https://registry.npmjs.org for the official source)
 *
 * Output: one JSON event per stdout line, consumed by desktop/main.js:
 *   {"type":"stage","stage":"check|download|install|verify","message":"..."}
 *   {"type":"progress","percent":number|null,"label":"..."}
 *   {"type":"log","line":"..."}                 (npm output, trimmed)
 *   {"type":"done","skipped":boolean,"seconds":number}
 *   {"type":"error","message":"..."}
 *
 * The download phase reports percent:null (indeterminate) — the lock file
 * lists every platform's optional deps, so an exact download percentage is
 * unknowable; the label carries a live tarball count instead.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_REGISTRY = "https://registry.npmmirror.com";

// --- install log file (debugging failed first-run installs) ---
// Primary location is the install dir (next to node_modules); if that is not
// writable we fall back to the OS temp dir. Every raw npm line plus the
// resolved node/npm/registry and the final exit code are persisted so a
// failing install can be debugged without scraping the electron dialog.
let LOG_PATH = null;

function resolveLogFile(appRoot) {
  const candidates = [
    path.join(appRoot, "first-run-install.log"),
    path.join(os.tmpdir(), `pi-studio-first-run-install-${Date.now()}.log`),
  ];
  for (const candidate of candidates) {
    try {
      fs.writeFileSync(candidate, ""); // create / truncate
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function logLine(line) {
  if (!LOG_PATH) return;
  try {
    fs.appendFileSync(LOG_PATH, line.endsWith("\n") ? line : `${line}\n`);
  } catch {
    // best-effort logging; never let it break the install
  }
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function fail(message) {
  logLine(`FAILED: ${message}`);
  emit({ type: "error", message });
  if (LOG_PATH) emit({ type: "logfile", path: LOG_PATH });
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let appRoot = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--app-root" && args[i + 1]) appRoot = args[++i];
  }
  if (!appRoot) fail("Missing --app-root argument.");
  appRoot = path.resolve(appRoot);
  if (!fs.existsSync(path.join(appRoot, "package.json"))) {
    fail(`No package.json found at ${appRoot}.`);
  }
  return appRoot;
}

/**
 * Any production dependency missing from node_modules? Also treats an install
 * that never wrote its marker file (.package-lock.json) as incomplete.
 */
function missingDependencies(appRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  const deps = pkg.dependencies || {};
  const nm = path.join(appRoot, "node_modules");
  for (const name of Object.keys(deps)) {
    if (!fs.existsSync(path.join(nm, name))) return true;
  }
  // npm writes this marker on every completed install.
  if (!fs.existsSync(path.join(nm, ".package-lock.json"))) return true;
  return false;
}

/** Locate the npm bundled next to the running node binary. */
function findNpmCli() {
  // Packaged layout is <runtime>/npm/bin/npm-cli.js on every platform (NOT
  // <runtime>/node_modules/npm — that is dropped by electron-builder's
  // top-level node_modules exclusion). On Windows node sits at
  // <runtime>/node.exe; on macOS/Linux it sits at <runtime>/bin/node, so the
  // npm dir is one level up from the exe's dirname. The last candidate covers
  // a runtime dir staged straight from a POSIX node tarball (lib/node_modules).
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(exeDir, "npm", "bin", "npm-cli.js"),
    path.join(exeDir, "..", "npm", "bin", "npm-cli.js"),
    path.join(exeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null; // fall back to "npm" on PATH (dev environments)
}

/** Extract the package name from a registry tarball URL, if it is one. */
function tarballPackageName(line) {
  const match = line.match(/https?:\/\/\S+\.tgz/);
  if (!match) return null;
  try {
    const pathname = new URL(match[0]).pathname; // /<name>/-/<tarball>.tgz
    const segment = pathname.split("/").filter(Boolean)[0];
    if (!segment || segment === "-") return null;
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

async function main() {
  const appRoot = parseArgs();
  const registry = process.env.PI_NPM_REGISTRY || DEFAULT_REGISTRY;
  const t0 = Date.now();

  LOG_PATH = resolveLogFile(appRoot);
  logLine("=== pi-studio first-run dependency install ===");
  logLine(`time:     ${new Date().toISOString()}`);
  logLine(`appRoot:  ${appRoot}`);
  logLine(`registry: ${registry}`);

  emit({ type: "stage", stage: "check", message: "检查依赖环境…" });

  // Writable check up front so the user gets a clear message instead of a
  // wall of EACCES from npm (e.g. the app was installed into Program Files).
  try {
    fs.accessSync(appRoot, fs.constants.W_OK);
  } catch {
    fail(`安装目录不可写：${appRoot}\n请把 pi-studio 安装到用户目录（默认位置），或使用管理员身份运行一次。`);
  }

  if (!missingDependencies(appRoot)) {
    emit({ type: "done", skipped: true, seconds: 0 });
    return;
  }

  const downloaded = new Set();

  const installArgs = [
    "install",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--loglevel=http",
    "--registry",
    registry,
  ];
  const npmCli = findNpmCli();
  logLine(`node:     ${process.execPath}`);
  logLine(`npmCli:   ${npmCli ?? "(system npm on PATH)"}`);
  let command;
  let args;
  if (npmCli) {
    // Packaged: run npm-cli.js with the bundled node (never depends on PATH).
    command = process.execPath;
    args = [npmCli, ...installArgs];
  } else {
    // Dev convenience fallback: system npm on PATH.
    command = process.platform === "win32" ? "npm.cmd" : "npm";
    args = installArgs;
  }

  emit({ type: "stage", stage: "download", message: "正在下载依赖包…" });

  // npm lifecycle scripts (patch-package, protobufjs, esbuild…) invoke `node`
  // from PATH. macOS GUI apps launch with launchd's minimal PATH
  // (/usr/bin:/bin:/usr/sbin:/sbin), and Windows GUI processes inherit the
  // user PATH only — a machine without a system Node fails every postinstall
  // with "node: command not found" (npm error code 127). Prepend the bundled
  // runtime node's directory so lifecycle scripts resolve the same node that
  // launched npm-cli.js, regardless of what the shell PATH contains.
  const nodeDir = path.dirname(process.execPath);
  const pathSep = process.platform === "win32" ? ";" : ":";

  const child = spawn(command, args, {
    cwd: appRoot,
    env: {
      ...process.env,
      PATH: `${nodeDir}${pathSep}${process.env.PATH || ""}`,
      npm_config_loglevel: "http",
      CI: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  logLine(`spawn:    ${command} ${args.join(" ")}`);
  logLine(`cwd:      ${appRoot}`);

  let errorMessage = null;
  let lastProgressEmit = 0;

  const handleOutput = (chunk) => {
    for (const rawLine of chunk.toString().split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      logLine(line);

      // Surface a rolling view of npm's own output in the UI log panel.
      emit({ type: "log", line: line.length > 260 ? `${line.slice(0, 260)}…` : line });

      if (/npm (ERR|error)[! ]/.test(line)) {
        errorMessage = errorMessage ? `${errorMessage}\n${line}` : line;
        continue;
      }
      const pkg = tarballPackageName(line);
      if (pkg) downloaded.add(pkg);

      // Throttle progress events to ~4/s. The download phase uses an
      // indeterminate bar (percent null): npm's real download count is not
      // knowable up front (lock files list every platform's optional deps), so
      // a pretend percentage would just mislead. The label shows live progress.
      const now = Date.now();
      if (now - lastProgressEmit < 250) continue;
      lastProgressEmit = now;
      emit({ type: "progress", percent: null, label: `已获取 ${downloaded.size} 个依赖包` });
    }
  };

  child.stdout.on("data", handleOutput);
  child.stderr.on("data", handleOutput);

  const exitCode = await new Promise((resolve) => {
    child.on("exit", resolve);
    child.on("error", (error) => {
      errorMessage = `无法启动 npm：${error.message}`;
      resolve(127);
    });
  });

  logLine(`npm exit code: ${exitCode}`);
  if (errorMessage) logLine(`npm error output:\n${errorMessage}`);
  if (exitCode !== 0) {
    fail(errorMessage || `npm install 失败（退出码 ${exitCode}），请检查网络后重试。`);
  }

  // Install phase complete — tarball counting no longer applies.
  emit({ type: "stage", stage: "install", message: "正在完成安装…" });
  emit({ type: "progress", percent: 90, label: "依赖安装完成，正在校验…" });

  emit({ type: "stage", stage: "verify", message: "正在校验运行环境…" });
  if (missingDependencies(appRoot)) {
    fail("依赖安装后校验未通过，node_modules 仍不完整。请重新安装 pi-studio。");
  }

  const seconds = Math.round((Date.now() - t0) / 1000);
  emit({ type: "progress", percent: 100, label: `依赖安装完成（用时 ${seconds} 秒）` });
  logLine(`SUCCESS in ${seconds}s`);
  if (LOG_PATH) emit({ type: "logfile", path: LOG_PATH });
  emit({ type: "done", skipped: false, seconds });
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
