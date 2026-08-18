#!/usr/bin/env node

// Generate a latest.json manifest for the online updater.
// Runs automatically at the end of `npm run desktop:dist` — scans
// dist-desktop/ for the installers just built, fills in real file sizes,
// and writes latest.json next to them so both files can be uploaded
// to the update server together.
//
// Usage:
//   node scripts/gen-update-manifest.mjs                       (after desktop:dist)
//   node scripts/gen-update-manifest.mjs --base-url URL        (different server)
//   node scripts/gen-update-manifest.mjs --release-notes "..." (real release notes)
//   node scripts/gen-update-manifest.mjs --out -               (stdout only)
//
// Platform entries are always emitted for the declared platforms (win + mac);
// installers present in dist-desktop/ get their real size, absent ones get a
// size: 0 placeholder. This keeps the manifest structure identical no matter
// which machine ran the build, so uploading the manifest from a win build and
// later from a mac build can't drop the other platform's entry.

import { readFileSync, existsSync, statSync, writeFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Read resources/update-config.local.json (gitignored) for the operator's real
// update hosts. Returns { baseUrl?, installerBaseUrl? }.
function loadLocalConfig() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(root, "resources", "update-config.local.json"), "utf8")
    );
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

// Parse args.
const args = process.argv.slice(2);
// Installer download host — platforms[].url is written as `${baseUrl}/<file>`
// (absolute URLs, transparently passed through by the client). latest.json
// itself is uploaded to the main site (the client's DEFAULT_UPDATE_BASE_URL);
// installers go to this file host.
// Resolution order: --base-url arg > PI_STUDIO_UPDATE_BASE_URL env >
// resources/update-config.local.json "installerBaseUrl" (gitignored, the
// operator's real host) > placeholder. This lets a distributed build's
// installer URL point at the right file host without the URL entering VCS.
let baseUrl = "";
let outPath = join(root, "dist-desktop", "latest.json"); // default: next to installers
let releaseNotes = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--base-url" && args[i + 1]) {
    baseUrl = args[++i];
  } else if (args[i] === "--release-notes" && args[i + 1]) {
    releaseNotes = args[++i];
  } else if (args[i] === "--out" && args[i + 1]) {
    outPath = args[++i];
  }
}

if (!baseUrl) {
  baseUrl =
    process.env.PI_STUDIO_UPDATE_BASE_URL ||
    loadLocalConfig().installerBaseUrl ||
    "https://update.example.com";
}

// Read version from package.json.
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;

// Installer naming rules, mirroring electron-builder.yml artifactName.
// ALL platform entries are always emitted (url pre-written) so the manifest
// structure stays stable no matter which machine ran the build — the file
// uploaded last (win or mac) never drops the other platform's entry.
// Missing installers get size: 0 as a placeholder; a platform entry without
// its installer uploaded yet will let that platform's users see "update
// available" but fail on download — so keep the manifest and every declared
// platform's installer in sync when publishing a new version.
const PLATFORM_PATTERNS = [
  { key: "win32-x64", file: `pi-studio-Setup-${version}.exe`, label: "Windows" },
  { key: "darwin-x64", file: `pi-studio-${version}.dmg`, label: "macOS (Intel)" },
  { key: "darwin-arm64", file: `pi-studio-${version}-arm64.dmg`, label: "macOS (Apple Silicon)" },
  { key: "linux-x64", file: `pi-studio-${version}-x64.AppImage`, label: "Linux" },
];

// Emit every entry; real size when the installer exists, 0 as placeholder.
const platforms = {};
let found = 0;
for (const { key, file, label } of PLATFORM_PATTERNS) {
  const fullPath = join(root, "dist-desktop", file);
  if (existsSync(fullPath)) {
    platforms[key] = {
      url: `${baseUrl.replace(/\/+$/, "")}/${file}`,
      size: statSync(fullPath).size,
    };
    found++;
    console.error(`[gen-update-manifest] ${label}: ${file} (${statSync(fullPath).size} bytes)`);
  } else {
    platforms[key] = { url: `${baseUrl.replace(/\/+$/, "")}/${file}`, size: 0 };
    console.error(`[gen-update-manifest] ${label}: placeholder (installer not in dist-desktop/)`);
  }
}

if (found === 0) {
  console.error(
    `[gen-update-manifest] ERROR: no installer matching version ${version} found in dist-desktop/ — ` +
      "did the build produce the expected artifactName?"
  );
  process.exit(1);
}

const manifest = {
  version,
  releaseNotes: releaseNotes || `## ${version}\n- TODO: fill in release notes`,
  pubDate: new Date().toISOString(),
  platforms,
};

const json = JSON.stringify(manifest, null, 2) + "\n";

if (outPath === "-") {
  process.stdout.write(json);
} else {
  writeFileSync(outPath, json, "utf8");
  console.error(`[gen-update-manifest] written to ${outPath}`);
  console.error("[gen-update-manifest] REMINDER: edit releaseNotes in latest.json before uploading!");
}
