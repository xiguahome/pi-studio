#!/usr/bin/env node

// Downloads a pinned standalone Node runtime used by the packaged desktop app
// to run `next start`, so end users need no system Node installation and the
// Electron-embedded Node version never matters (engines requires >=22.19.0).
//
// Bundles npm from the same archive. NOTE the archive layouts differ:
//   win .zip    → <top>/node.exe        + <top>/node_modules/npm
//   darwin/linux → <top>/bin/node + <top>/lib/node_modules/npm
// npm is copied to <runtime>/npm on EVERY platform (see below for why).
//
// Usage:
//   node desktop/scripts/install-node-runtime.mjs [--platform win|darwin|linux] [--arch x64|arm64]
//
// Output: desktop/runtime/node-runtime/node(.exe)  (win)
//         desktop/runtime/node-runtime/bin/node     (darwin/linux)
// electron-builder maps that folder into the app's resources as `node-runtime`.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const NODE_RUNTIME_VERSION = "22.19.0";

// Base URL for the Node.js dist archive. npmmirror mirrors nodejs.org/dist
// 1:1 (same /v<version>/<archive> layout), so CN build machines download from
// the domestic mirror by default and avoid the slow nodejs.org fetch. Set
// NODEJS_ORG_MIRROR=https://nodejs.org/dist to fall back to the official source
// (or any other mirror that preserves the layout).
const NODE_DIST_MIRROR =
  process.env.NODEJS_ORG_MIRROR || "https://registry.npmmirror.com/-/binary/node";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "runtime", "node-runtime");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--platform") options.platform = args[i + 1];
    if (args[i] === "--arch") options.arch = args[i + 1];
  }
  const platformMap = { win32: "win", darwin: "darwin", linux: "linux" };
  return {
    platform: options.platform ?? platformMap[process.platform] ?? process.platform,
    arch: options.arch ?? process.arch,
  };
}

function archiveName(platform, arch) {
  const extension = platform === "win" ? "zip" : "tar.gz";
  return `node-v${NODE_RUNTIME_VERSION}-${platform}-${arch}.${extension}`;
}

async function download(url, targetFile) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(targetFile));
}

function extract(archiveFile, intoDir, isZip) {
  if (isZip) {
    // Windows .zip: do NOT use tar. MSYS tar (Git Bash) parses "C:\..." as
    // host:path and fails with "Cannot connect to C:", and we can't rely on
    // bsdtar being the tar on PATH. PowerShell's Expand-Archive handles
    // Windows paths natively and ships on every Windows 10+ install.
    const quoted = (p) => `'${String(p).replace(/'/g, "''")}'`;
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${quoted(archiveFile)} -DestinationPath ${quoted(intoDir)} -Force`,
      ],
      { stdio: "inherit" },
    );
    if (ps.status !== 0) {
      throw new Error(`PowerShell Expand-Archive failed (exit ${ps.status}).`);
    }
    return;
  }
  // macOS/Linux .tar.gz: tar handles POSIX paths natively (no drive letters).
  const result = spawnSync("tar", ["-zxf", archiveFile, "-C", intoDir], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`tar extraction failed (exit ${result.status}). Is "tar" available on PATH?`);
  }
}

function findFile(rootDir, relativePaths) {
  for (const relative of relativePaths) {
    const candidate = path.join(rootDir, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`node binary not found inside extracted archive under ${rootDir}`);
}

async function main() {
  const { platform, arch } = parseArgs();
  const supported = [
    ["win", "x64"], ["win", "arm64"],
    ["darwin", "x64"], ["darwin", "arm64"],
    ["linux", "x64"], ["linux", "arm64"],
  ];
  if (!supported.some(([p, a]) => p === platform && a === arch)) {
    throw new Error(`Unsupported platform/arch: ${platform}-${arch}`);
  }

  const isWindows = platform === "win";
  const archive = archiveName(platform, arch);
  const url = `${NODE_DIST_MIRROR}/v${NODE_RUNTIME_VERSION}/${archive}`;

  const targetBinary = isWindows
    ? path.join(OUTPUT_DIR, "node.exe")
    : path.join(OUTPUT_DIR, "bin", "node");
  // npm MUST also be present or the packaged app cannot run its first-run
  // dependency install (first-run-install.mjs falls back to system npm and
  // dies with ENOENT on machines without Node). A runtime dir that has node
  // but no npm (e.g. staged by an older version of this script, which never
  // bundled npm from darwin/linux archives) must be repaired, not skipped.
  const npmCliDst = path.join(OUTPUT_DIR, "npm", "bin", "npm-cli.js");
  if (fs.existsSync(targetBinary) && fs.existsSync(npmCliDst)) {
    console.log(
      `Node v${NODE_RUNTIME_VERSION} (${platform}-${arch}) + npm already present at ${OUTPUT_DIR}; skipping download.`,
    );
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-node-runtime-"));
  const archiveFile = path.join(workDir, archive);
  const extractDir = path.join(workDir, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await download(url, archiveFile);
    extract(archiveFile, extractDir, isWindows);

    const topLevel = path.join(extractDir, `node-v${NODE_RUNTIME_VERSION}-${platform}-${arch}`);
    const sourceBinary = findFile(topLevel, isWindows ? ["node.exe"] : [path.join("bin", "node")]);

    fs.mkdirSync(path.dirname(targetBinary), { recursive: true });
    fs.copyFileSync(sourceBinary, targetBinary);
    if (!isWindows) fs.chmodSync(targetBinary, 0o755);

    // Also bundle npm from the same official archive. pi-studio seeds its
    // built-in extensions (pi-mcp-adapter, pi-subagents) on first boot by
    // calling `node <runtime>/npm/bin/npm-cli.js` with an absolute path.
    //
    // IMPORTANT: npm MUST live at <runtime>/npm, NOT <runtime>/node_modules/npm.
    // electron-builder unconditionally drops a top-level `node_modules` from any
    // extraResources source root (app-builder-lib/out/util/filter.js: the
    // `relative === "node_modules" -> return false` rule), so a bundled npm
    // under node_modules would never reach the shipped app — leaving only
    // node.exe and breaking first-run `npm install` ("首次运行依赖安装失败").
    // The npm/npm.cmd wrappers are intentionally NOT copied: they look up node
    // via PATH, which is exactly the failure mode this avoids. Keeping npm out
    // of PATH also means the user's own npm/node setup is never shadowed.
    //
    // Source layout differs by archive type: Windows .zip puts npm at
    // <top>/node_modules/npm, macOS/Linux .tar.gz at <top>/lib/node_modules/npm.
    // The old lookup only handled the zip layout, so darwin/linux builds
    // silently shipped WITHOUT npm and first-run install died with
    // `spawn npm ENOENT` on machines without a system Node.
    const npmSrc =
      [
        path.join(topLevel, "node_modules", "npm"), // Windows .zip layout
        path.join(topLevel, "lib", "node_modules", "npm"), // macOS/Linux .tar.gz layout
      ].find((candidate) => fs.existsSync(candidate)) ?? null;
    const npmDst = path.join(OUTPUT_DIR, "npm");
    if (npmSrc) {
      fs.mkdirSync(path.dirname(npmDst), { recursive: true });
      fs.rmSync(npmDst, { recursive: true, force: true }); // stale npm from an older runtime
      fs.cpSync(npmSrc, npmDst, { recursive: true });
      console.log(`npm bundled at ${npmDst}`);
    } else {
      // Fatal, not a warning: an archive without npm produces an installer that
      // cannot finish its first-run dependency install (this exact bug shipped
      // a broken macOS build). Fail the build here instead of on user machines.
      throw new Error(
        `npm not found in the Node archive (expected node_modules/npm or lib/node_modules/npm under ${topLevel}) — without a bundled npm the packaged app cannot install its dependencies on first run.`,
      );
    }

    console.log(`Node v${NODE_RUNTIME_VERSION} (${platform}-${arch}) installed at ${targetBinary}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
