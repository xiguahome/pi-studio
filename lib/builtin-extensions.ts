// Built-in extensions: pi-studio ships pi-mcp-adapter, pi-subagents, pi-tasks
// and pi-plan-mode as always-on capabilities. On boot the Next server seeds
// them into the global agent dir (~/.pi-studio) so every project/session gets
// MCP + subagent + task-tracking + plan-mode support without the user having
// to install anything by hand.
//
// The seed runs in the Next server process (kicked off by instrumentation.ts),
// which inherits PI_CODING_AGENT_DIR from desktop/main.js, so getAgentDir()
// resolves to ~/.pi-studio the same way /api/plugins sees it.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type PackageSource,
} from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import type { BuiltinSeedResult, BuiltinSeedStatus } from "@/lib/api-types";
import { withProxyEnv } from "@/lib/proxy-config";
import { BUILTIN_EXTENSION_SOURCES, npmSourceName } from "@/lib/builtin-extension-sources";

export { BUILTIN_EXTENSION_SOURCES, npmSourceName };

/**
 * Registry used for every built-in install. npmmirror mirrors all of npm,
 * including the platform-specific optionalDependencies that @napi-rs/keyring
 * and recheck rely on, so native binaries resolve the same way.
 */
export const BUILTIN_NPM_REGISTRY = "https://registry.npmmirror.com";

/**
 * npmrc keys that redirect prebuild-install binary downloads from GitHub to
 * npmmirror. better-sqlite3 (dependency of pi-hermes-memory) fetches its
 * prebuilt .node binary via prebuild-install, which defaults to github.com —
 * unreachable from mainland China without a proxy. Without a mirror the
 * install falls back to node-gyp source compilation, which additionally
 * requires VS Build Tools and fails on most dev machines. npmmirror mirrors
 * these binaries under /-/binary/<pkg>; the key must match npm's
 * env-injection convention (npm_config_<key>), which prebuild-install reads.
 */
export const BUILTIN_NPM_BINARY_MIRRORS: Record<string, string> = {
  "better_sqlite3_binary_host": "https://registry.npmmirror.com/-/binary/better-sqlite3",
};

/**
 * Transitive-dependency pins merged into the managed npm dir's package.json
 * (npm `overrides`). Pinning the top-level spec alone is NOT enough: a range
 * like pi-hermes-memory@0.9.6 → better-sqlite3@^12.9.0 still resolves to the
 * newest 12.x, and better-sqlite3 >= 12.10 dropped Node 20 (ABI 115) Windows
 * prebuilds — the exact "pi-hermes-memory 安装失败" report from machines where
 * npm runs under a PATH-resolved Node 20 (legacy pi-studio <= 1.0.9 panel
 * installs). 12.9.0 is the last release shipping BOTH ABI 115 and 127 win32
 * prebuilds on npmmirror, so installs succeed regardless of which Node runs
 * npm. When bumping, verify the target version has prebuilds for every Node
 * ABI you still care about on npmmirror's /-/binary/ mirror.
 */
export const BUILTIN_NPM_OVERRIDES: Record<string, string> = {
  "better-sqlite3": "12.9.0",
};

const SEED_LOCK_STALE_MS = 5 * 60_000;

export function isBuiltinSource(source: string): boolean {
  // Compare by package name: legacy settings entries (pre-pinning) and the
  // current pinned specs must both resolve to the same built-in identity,
  // otherwise a stored "npm:pi-hermes-memory" could be removed through the
  // plugin panel even though its pinned counterpart is non-removable.
  const name = npmSourceName(source);
  return (BUILTIN_EXTENSION_SOURCES as readonly string[]).some(
    (builtin) => npmSourceName(builtin) === name,
  );
}

/**
 * Resolve an npm runner that does NOT depend on PATH.
 *
 * The desktop runtime bundles node + npm (see desktop/scripts/install-node-runtime.mjs),
 * so in a packaged app we invoke `node <runtime>/npm/bin/npm-cli.js` directly. npm lives
 * at <runtime>/npm (NOT <runtime>/node_modules/npm — electron-builder drops a top-level
 * node_modules from extraResources). On Windows node is at <runtime>/node.exe; on
 * macOS/Linux it is at <runtime>/bin/node, so the npm dir is one level up from the exe.
 * This bypasses the npm/npm.cmd wrappers, which look up node via PATH and are the fragile
 * bit. Dev falls back to the system npm on the developer's machine.
 */
export function resolveBuiltinNpmRunner(): { cmd: string; args: string[] } {
  const nodeExe = process.execPath;
  const exeDir = dirname(nodeExe);
  // Third candidate covers a runtime dir staged straight from a POSIX node
  // tarball (<runtime>/lib/node_modules/npm); the bundled script normally
  // reshuffles that to <runtime>/npm on every platform.
  const cli = [
    join(exeDir, "npm", "bin", "npm-cli.js"),
    join(exeDir, "..", "npm", "bin", "npm-cli.js"),
    join(exeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((candidate) => existsSync(candidate));
  if (cli) return { cmd: nodeExe, args: [cli] };
  return { cmd: "npm", args: [] };
}

/** True when cmd is an npmCommand this app set (bundled runtime node), not a user's own. */
function isOurNpmCommand(cmd: string[] | undefined): boolean {
  const first = cmd?.[0];
  if (!first) return false;
  const bin = basename(first).replace(/\.(exe|cmd)$/i, "");
  return first === process.execPath || (first.includes("node-runtime") && bin.startsWith("node"));
}

/**
 * Point the SDK's DefaultPackageManager at the bundled node-runtime npm so
 * user-triggered plugin installs/updates (Plugins panel → /api/plugins) work
 * on machines without Node.js on PATH and never hit registry.npmjs.org.
 *
 * Why: with npmCommand unset the SDK resolves a bare `npm` from the server's
 * PATH (the runtime dir is NOT on it) — no-Node machines fail with ENOENT and
 * mainland users without a user-level registry mirror get flaky npmjs.org
 * fetches, which is the usual "pi-hermes-memory 安装失败" report. npmCommand's
 * args are prepended to EVERY SDK npm invocation (install/uninstall/view), so
 * one --registry flag covers them all.
 *
 * Runs on every boot — the install dir moves between installs, so the absolute
 * paths must be refreshed — and never clobbers a user-configured npmCommand.
 * Dev (no bundled runtime next to process.execPath) clears a stale value we
 * set earlier, e.g. after the packaged app was uninstalled. Never throws.
 */
export async function ensureSdkNpmCommand(settingsManager: SettingsManager): Promise<void> {
  try {
    const runner = resolveBuiltinNpmRunner();
    const existing = settingsManager.getNpmCommand();
    if (runner.args.length === 0) {
      if (existing && isOurNpmCommand(existing)) {
        settingsManager.setNpmCommand(undefined);
        await settingsManager.flush();
      }
      return;
    }
    if (existing && !isOurNpmCommand(existing)) return;
    const next = [runner.cmd, ...runner.args, `--registry=${BUILTIN_NPM_REGISTRY}`];
    if (existing && existing.length === next.length && next.every((value, i) => value === existing[i])) return;
    settingsManager.setNpmCommand(next);
    await settingsManager.flush();
    console.log(`[pi-studio] SDK npmCommand → bundled runtime (${runner.cmd})`);
  } catch (error) {
    console.warn("[pi-studio] failed to set SDK npmCommand:", error);
  }
}

/**
 * Patch scripts that must re-run after every install/update of a built-in npm
 * extension. Mirrors the `postinstall` hook in package.json — but that hook
 * only fires on the project's own `npm install`, while built-in seeding (a
 * spawned bare `npm install`) and the plugin panel's DefaultPackageManager
 * never go through it. Each script is idempotent: it skips cleanly when the
 * package is absent or already in the patched state.
 */
export const BUILTIN_PATCH_SCRIPTS = [
  "patch-pi-tasks.mjs",
  "patch-pi-subagents.mjs",
  "patch-pi-mcp-adapter.mjs",
  "patch-pi-chrome-devtools.mjs",
  "patch-pi-plan-mode.mjs",
  "patch-pi-hermes-memory.mjs",
] as const;

const execFileAsync = promisify(execFile);

/**
 * Run every built-in patch script against <agentDir>/npm/node_modules.
 * Failures are logged, never thrown, so a broken patch can never block the
 * seed or the plugin API response.
 */
export async function runPostInstallPatches(): Promise<void> {
  for (const name of BUILTIN_PATCH_SCRIPTS) {
    const script = resolve(process.cwd(), "scripts", name);
    if (!existsSync(script)) continue;
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [script], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      if (stdout.trim()) console.log(`[patches] ${stdout.trim()}`);
      if (stderr.trim()) console.warn(`[patches] ${stderr.trim()}`);
    } catch (error) {
      console.warn(`[patches] post-install patch script ${name} failed:`, error);
    }
  }
}

function packageSourceOf(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function seedStatusPath(): string {
  return join(getAgentDir(), ".builtin-seed.json");
}

function seedLockPath(): string {
  return join(getAgentDir(), ".builtin-seed.lock");
}

function writeSeedStatus(status: BuiltinSeedStatus): void {
  writeFileSync(seedStatusPath(), JSON.stringify(status, null, 2), "utf8");
}

/** Read the most recent seed outcome so the UI can show progress/failure. */
export function readBuiltinSeedStatus(): BuiltinSeedStatus | null {
  try {
    const raw = readFileSync(seedStatusPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<BuiltinSeedStatus>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      seeding: Boolean(parsed.seeding),
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      results: Array.isArray(parsed.results) ? parsed.results : [],
    };
  } catch {
    return null;
  }
}

// Replicates DefaultPackageManager.ensureNpmProject (which is private in the
// SDK's .d.ts): make the managed npm dir look like a real npm project so
// `npm install --prefix` behaves. We skip pi's cloud-sync marker — it only
// tags the dir to avoid OneDrive/iCloud syncing, which is cosmetic here.
function ensureNpmProjectDir(installRoot: string): void {
  if (!existsSync(installRoot)) mkdirSync(installRoot, { recursive: true });
  const gitignore = join(installRoot, ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n!.gitignore\n", "utf8");
  const pkgJson = join(installRoot, "package.json");
  let pkg: { name?: string; private?: boolean; overrides?: Record<string, string> } = {};
  if (existsSync(pkgJson)) {
    try {
      pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
    } catch {
      pkg = {}; // corrupted — rewritten below
    }
  }
  let pkgChanged = false;
  if (!pkg.name || pkg.private !== true) {
    pkg.name = pkg.name ?? "pi-extensions";
    pkg.private = true;
    pkgChanged = true;
  }
  // Keep transitive deps pinned (see BUILTIN_NPM_OVERRIDES). Must MERGE into
  // an existing package.json — the file is created once and outlives app
  // upgrades, so writing it only when absent would never pin old installs.
  const overrides = { ...(pkg.overrides ?? {}) };
  for (const [key, value] of Object.entries(BUILTIN_NPM_OVERRIDES)) {
    if (overrides[key] !== value) {
      overrides[key] = value;
      pkgChanged = true;
    }
  }
  if (Object.keys(overrides).length > 0) pkg.overrides = overrides;
  if (pkgChanged || !existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify(pkg, null, 2), "utf8");
  }
  mergeNpmBinaryMirrors(installRoot);
}

/**
 * Merge the npmmirror binary mirror keys into the managed npm dir's .npmrc.
 * Never clobbers keys the user already set.
 */
function mergeNpmBinaryMirrors(installRoot: string): void {
  const npmrcPath = join(installRoot, ".npmrc");
  let npmrc = "";
  try {
    npmrc = readFileSync(npmrcPath, "utf8");
  } catch { /* missing — start empty */ }
  let updated = npmrc;
  for (const [key, value] of Object.entries(BUILTIN_NPM_BINARY_MIRRORS)) {
    if (!npmrc.split("\n").some((line) => line.trim() === `${key}=${value}`)) {
      updated += `${updated && !updated.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
    }
  }
  if (updated !== npmrc) writeFileSync(npmrcPath, updated, "utf8");
}

/**
 * Ensure the managed npm dir looks like a real npm project (dir, package.json,
 * .gitignore) and carries the npmmirror binary mirrors in its .npmrc, so
 * prebuild-install pulls prebuilt binaries (better-sqlite3's .node etc.) from
 * npmmirror instead of GitHub — no proxy required, works out of the box in
 * mainland China. Called by /api/plugins before SDK-driven installs, which
 * never go through ensureNpmProjectDir. Merge, never clobber, keys the user
 * already set. Returns the installRoot used (for callers that don't know it
 * yet).
 */
export function ensureBuiltinNpmDirMirrors(installRoot = join(getAgentDir(), "npm")): string {
  ensureNpmProjectDir(installRoot);
  return installRoot;
}

function runNpm(
  runner: { cmd: string; args: string[] },
  npmArgs: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(runner.cmd, [...runner.args, ...npmArgs], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: withProxyEnv({ ...process.env }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function npmSpecFrom(source: string): string {
  return source.startsWith("npm:") ? source.slice("npm:".length) : source;
}

/**
 * Idempotently ensure every built-in extension is installed globally and
 * recorded in ~/.pi-studio/settings.json. Safe to call on every boot: already
 * installed packages are skipped, and a lockfile guards against concurrent
 * runs from multiple windows. Never throws — failures land in the status file
 * so the UI can surface them.
 */
export async function ensureBuiltinExtensions(): Promise<BuiltinSeedStatus> {
  const agentDir = getAgentDir();
  mkdirSync(agentDir, { recursive: true });

  // proper-lockfile locks an existing file (it opens the target and holds a
  // lock on it), so the lock file must exist before we ask it to lock — same
  // pattern as lib/provider-credential-store.ts ensureAuthFile before lock().
  const lockPath = seedLockPath();
  if (!existsSync(lockPath)) writeFileSync(lockPath, "", "utf8");

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockPath, {
      retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 3_000, randomize: true },
      stale: SEED_LOCK_STALE_MS,
      onCompromised: () => {
        // Ignore; a stale lock just means we may re-run — the work is idempotent.
      },
    });
  } catch {
    // Another instance is seeding. Report in-progress and bow out.
    return (
      readBuiltinSeedStatus() ?? {
        seeding: true,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        results: [],
      }
    );
  }

  try {
    const cwd = homedir();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    const runner = resolveBuiltinNpmRunner();
    // Inside the seed lock: also (re)point the SDK's npmCommand at the bundled
    // runtime every boot, so panel-triggered installs never depend on PATH npm.
    await ensureSdkNpmCommand(settingsManager);
    const installRoot = join(agentDir, "npm");
    const startedAt = new Date().toISOString();

    const results: BuiltinSeedResult[] = [];
    const mark = (seeding: boolean): BuiltinSeedStatus => {
      const status: BuiltinSeedStatus = {
        seeding,
        startedAt,
        updatedAt: new Date().toISOString(),
        results,
      };
      writeSeedStatus(status);
      return status;
    };
    mark(true);

    const configuredSources = new Set(
      (settingsManager.getGlobalSettings().packages ?? []).map(packageSourceOf),
    );

    for (const source of BUILTIN_EXTENSION_SOURCES) {
      const alreadyInstalled = Boolean(pm.getInstalledPath(source, "user"));
      // Case 1: installed AND configured → nothing to do (idempotent, old users who
      // upgraded from a version where built-ins were already seeded correctly).
      if (alreadyInstalled && configuredSources.has(source)) {
        results.push({ source, action: "skipped" });
        mark(true);
        continue;
      }
      // Case 2: installed but NOT in settings → just add the entry, don't re-install
      // (covers old users who had the packages from a previous manual install or
      // an earlier migration that put the files on disk without writing settings).
      if (alreadyInstalled) {
        pm.addSourceToSettings(source, { local: false });
        await settingsManager.flush();
        results.push({ source, action: "installed" });
        mark(true);
        continue;
      }
      // Case 3: not installed → do a fresh install.
      ensureNpmProjectDir(installRoot);
      const spec = npmSpecFrom(source);
      try {
        const { code, stderr } = await runNpm(
          runner,
          ["install", spec, "--prefix", installRoot, "--legacy-peer-deps", "--registry", BUILTIN_NPM_REGISTRY],
          installRoot,
        );
        if (code !== 0) {
          results.push({
            source,
            action: "failed",
            error: (stderr || `npm exited with code ${code}`).slice(-2000),
          });
        } else {
          pm.addSourceToSettings(source, { local: false });
          await settingsManager.flush();
          // The seed's bare `npm install` never fires the project's postinstall
          // hook, so freshly installed built-ins would ship unpatched (e.g.
          // chrome-devtools would drive the main window). Re-run the patches
          // here — idempotent, logs failures without throwing.
          await runPostInstallPatches();
          results.push({ source, action: "installed" });
        }
      } catch (error) {
        results.push({
          source,
          action: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      mark(true);
    }

    return mark(false);
  } finally {
    try {
      await release();
    } catch {
      // Lock release failure is not actionable; the stale guard covers it.
    }
  }
}
