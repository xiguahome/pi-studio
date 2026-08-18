#!/usr/bin/env node
// @ts-check
/**
 * patch-pi-tasks.mjs — point @tintinweb/pi-tasks at the project-local `.pi-studio`
 * dir instead of `.pi` / `.agents`, and make the store path follow the *session* cwd.
 *
 * The plugin hardcodes the project dir in the task store path (src/index.ts),
 * project config path (src/tasks-config.ts) and global fallback
 * (src/task-store.ts). It ships as raw TS loaded via `pi.extensions` pointing at
 * ./src/index.ts, so patching the source is enough — no build step.
 *
 * Version drift history:
 *  - <=0.7.x resolved the store path with `process.cwd()` and used a
 *    `resolveStorePath(sessionId?)` helper, so the patch also threaded a `cwd`
 *    parameter and passed `ExtensionContext.cwd` at the session-scoped upgrade.
 *  - 0.8.0 renamed the helper to `resolveStoreTarget(cwd?, sessionId?)` and
 *    already passes `ctx.cwd` at the call site (line ~370), but still writes
 *    `.pi` for the backing path. The signature/arg rules below are therefore
 *    OPTIONAL (silently skipped when the newer shape is present).
 *
 * The package lives in pi's managed npm dir, which patch-package cannot reach
 * (it only patches the project node_modules), hence this dedicated idempotent
 * script. Re-run it after upgrading the plugin.
 *
 * Only the directory pi-studio actually loads is patched:
 *   PI_CODING_AGENT_DIR set (pi-studio does this) → <agentDir>/npm/node_modules
 * A stray <agentDir>/agent/npm/node_modules copy (created by a pi CLI process
 * run without PI_CODING_AGENT_DIR — see getAgentDir() in the SDK) is NOT
 * patched; it is reported as redundant so it can be deleted.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi-studio");
const pkgDir = join(agentDir, "npm", "node_modules", "@tintinweb", "pi-tasks");
const strayDir = join(agentDir, "agent", "npm", "node_modules", "@tintinweb", "pi-tasks");

// [file, [{ sources: string[], target: string }]]
// `sources` lists every upstream spelling we may meet (pristine `.pi`, or the
// legacy `.agents` left by an earlier pi-studio patch); all are rewritten to
// `target`, which keeps the script idempotent across fresh installs and re-runs.
const PATCHES = [
  [
    "src/index.ts",
    [
      {
        // Store path, in one replacement: `.pi`/`.agents` → `.pi-studio`.
        // `sources` covers every spelling met so far: the pristine <=0.7.x
        // form (process.cwd), the already-patched `.agents` form, and the
        // 0.8.0 form (cwd, helper already takes it). For 0.8.0 the bare
        // `join(cwd, ".pi", "tasks"` → `.pi-studio` rewrite is all that's
        // needed because the call site already passes ctx.cwd.
        sources: [
          'join(process.cwd(), ".pi", "tasks"',
          'join(cwd, ".agents", "tasks"',
          'join(cwd, ".pi", "tasks"',
        ],
        target: 'join(cwd, ".pi-studio", "tasks"',
      },
      // OPTIONAL (<=0.7.x only): resolveStorePath() gains a `cwd` parameter
      // (defaults to process.cwd() so the init-time call stays working).
      // 0.8.0+ already has it via resolveStoreTarget — skip silently.
      {
        optional: true,
        sources: [
          "function resolveStorePath(sessionId?: string): string | undefined {",
        ],
        target: "function resolveStorePath(sessionId?: string, cwd = process.cwd()): string | undefined {",
      },
      // OPTIONAL (<=0.7.x only): session-scoped upgrade passes ExtensionContext.cwd.
      {
        optional: true,
        sources: ["const path = resolveStorePath(sessionId);"],
        target: "const path = resolveStorePath(sessionId, ctx.cwd);",
      },
    ],
  ],
  [
    "src/tasks-config.ts",
    [
      {
        sources: ['cwd, ".pi", "tasks-config.json"', 'cwd, ".agents", "tasks-config.json"'],
        target: 'cwd, ".pi-studio", "tasks-config.json"',
      },
      {
        sources: ["<cwd>/.pi/tasks-config.json", "<cwd>/.agents/tasks-config.json"],
        target: "<cwd>/.pi-studio/tasks-config.json",
      },
    ],
  ],
  [
    "src/task-store.ts",
    [
      {
        sources: ['homedir(), ".pi", "tasks"', 'homedir(), ".agents", "tasks"'],
        target: 'homedir(), ".pi-studio", "tasks"',
      },
    ],
  ],
];

if (!existsSync(pkgDir)) {
  if (existsSync(strayDir)) {
    console.warn(
      `[patch-pi-tasks] WARN redundant copy at ${strayDir} (created by a pi CLI run without ` +
        `PI_CODING_AGENT_DIR) is NOT patched — pi-studio never loads it. Delete ~/.pi-studio/agent to clean it up.`,
    );
  }
  console.log(`[patch-pi-tasks] plugin not found at ${pkgDir} — skipping (install it first).`);
  process.exit(0);
}

let patched = 0;
for (const [relFile, rules] of PATCHES) {
  const filePath = join(pkgDir, relFile);
  if (!existsSync(filePath)) {
    console.warn(`[patch-pi-tasks] WARN ${relFile} missing — plugin structure changed?`);
    continue;
  }
  let content = readFileSync(filePath, "utf8");
  let changed = false;
  let skipped = 0;
  for (const { sources, target, optional } of rules) {
    const hit = sources.find((s) => content.includes(s));
    if (hit) {
      for (const s of sources) content = content.replaceAll(s, target);
      changed = true;
    } else if (content.includes(target)) {
      skipped++; // already patched
    } else if (!optional) {
      // Missing non-optional rule = the plugin's structure changed again.
      console.warn(
        `[patch-pi-tasks] WARN ${relFile}: none of ${JSON.stringify(sources)} nor "${target}" found — structure changed?`,
      );
    }
    // optional rules that don't match are silently skipped (newer plugin
    // version already has that capability built in).
  }
  if (changed) {
    writeFileSync(filePath, content, "utf8");
    patched++;
    console.log(`[patch-pi-tasks] patched ${relFile}`);
  } else if (skipped) {
    console.log(`[patch-pi-tasks] ${relFile} already patched — skipping.`);
  }
}

if (patched > 0) {
  console.log(`[patch-pi-tasks] done (${patched} file(s) patched). Restart pi-studio so the plugin reloads.`);
} else if (!existsSync(pkgDir)) {
  console.log("[patch-pi-tasks] nothing to do.");
}
