"use strict";

// Local pi-studio server lifecycle for the Electron shell: resolves a Node
// runtime, picks a free port, spawns `bin/pi-web.js` (the existing CLI entry,
// so Node-version checks and next-bin resolution stay shared), waits until
// the server answers, and kills the whole process tree on shutdown.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app } = require("electron");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("net");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

const PREFERRED_PORT = 30142;
const PORT_PROBE_RANGE = 50;
const READY_TIMEOUT_MS = 90_000;
const PROBE_INTERVAL_MS = 300;
const STOP_TIMEOUT_MS = 5_000;

let child = null;
let stopping = false;

/** Root of the pi-studio app: repo checkout in dev, bundled resources when packaged. */
function getAppRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, "pi-web") : path.join(__dirname, "..");
}

/**
 * Pick the Node binary used to run `next start`.
 * Order: explicit override > bundled runtime (packaged) > node running npm
 * (dev) > Electron itself via ELECTRON_RUN_AS_NODE (last resort; its Node
 * version may be older than what engines requires, bin/pi-web.js validates).
 */
function resolveNodeRuntime() {
  if (process.env.PI_DESKTOP_NODE) {
    return { command: process.env.PI_DESKTOP_NODE, env: {} };
  }

  const binaryName = process.platform === "win32" ? "node.exe" : "node";
  if (app.isPackaged) {
    const candidates = [
      path.join(process.resourcesPath, "node-runtime", binaryName),
      path.join(process.resourcesPath, "node-runtime", "bin", binaryName),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return { command: candidate, env: {} };
    }
  }

  if (!app.isPackaged && process.env.npm_node_execpath && fs.existsSync(process.env.npm_node_execpath)) {
    return { command: process.env.npm_node_execpath, env: {} };
  }

  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(preferred) {
  for (let port = preferred; port < preferred + PORT_PROBE_RANGE; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${preferred}-${preferred + PORT_PROBE_RANGE - 1}`);
}

async function probeServer(url) {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2_000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

function killProcessTree(pid) {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => {});
    return;
  }
  try {
    // Detached spawn puts bin/pi-web.js and its `next start` child in one
    // process group, so a single signal reaches both.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

function waitForReady(proc, url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(probeTimer);
      clearTimeout(timeoutTimer);
      proc.stdout.removeListener("data", onStdout);
      proc.removeListener("exit", onEarlyExit);
      if (error) reject(error);
      else resolve();
    };

    const onStdout = (chunk) => {
      if (chunk.toString().includes("Ready")) finish();
    };
    const onEarlyExit = (code) => {
      finish(new Error(`pi-studio server exited early with code ${code ?? "unknown"}. Check the desktop log output.`));
    };

    proc.stdout.on("data", onStdout);
    proc.on("exit", onEarlyExit);

    const probeTimer = setInterval(() => {
      void probeServer(url).then((ok) => {
        if (ok) finish();
      });
    }, PROBE_INTERVAL_MS);

    const timeoutTimer = setTimeout(() => {
      finish(new Error(`pi-studio server did not become ready within ${READY_TIMEOUT_MS / 1000}s.`));
    }, READY_TIMEOUT_MS);
  });
}

/**
 * Spawn `bin/pi-web.js` on a free loopback port and wait until it answers.
 * @param {object} options
 * @param {(line: string) => void} [options.onLog] receives server stdout lines
 * @param {(code: number | null) => void} [options.onUnexpectedExit] called when
 *   the server dies while the app is running (crash detection)
 */
async function startServer({ onLog, onUnexpectedExit } = {}) {
  if (child) throw new Error("Server already started");
  stopping = false;

  const appRoot = getAppRoot();
  const entry = path.join(appRoot, "bin", "pi-web.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`pi-studio entry not found at ${entry}. In dev, run "npm run build" once, or set PI_DESKTOP_SERVER_URL to a running pi-studio server.`);
  }

  const port = await findFreePort(PREFERRED_PORT);
  const { command, env: runtimeEnv } = resolveNodeRuntime();
  const url = `http://127.0.0.1:${port}`;

  // bin/pi-web.js defaults to 127.0.0.1 and never opens a browser; no need to
  // pass --hostname/--no-open (those web-only flags were removed).
  const proc = spawn(command, [entry, "--port", String(port)], {
    cwd: appRoot,
    env: { ...process.env, ...runtimeEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  child = proc;

  proc.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim() && onLog) onLog(line);
    }
  });
  proc.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) console.error(`[pi-studio] ${line}`);
    }
  });
  proc.on("exit", (code) => {
    if (child === proc) child = null;
    if (!stopping && onUnexpectedExit) onUnexpectedExit(code);
  });
  proc.on("error", (error) => {
    console.error("[pi-studio] failed to start server process:", error);
  });

  try {
    await waitForReady(proc, url);
  } catch (error) {
    await stopServer();
    throw error;
  }
  return { url, port };
}

async function stopServer() {
  stopping = true;
  const proc = child;
  child = null;
  if (!proc) return;

  killProcessTree(proc.pid);
  await new Promise((resolve) => {
    const force = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve();
    }, STOP_TIMEOUT_MS);
    proc.on("exit", () => {
      clearTimeout(force);
      resolve();
    });
  });
}

module.exports = { getAppRoot, resolveNodeRuntime, startServer, stopServer };
