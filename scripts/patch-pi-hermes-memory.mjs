#!/usr/bin/env node
// @ts-check
/**
 * patch-pi-hermes-memory.mjs — default background memory review cadence.
 *
 * pi-hermes-memory auto-saves memory every DEFAULT_NUDGE_INTERVAL turns /
 * DEFAULT_NUDGE_TOOL_CALLS tool calls (10 / 15 upstream). That cadence is too
 * chatty for pi-studio: each review appends entries without dedup (and spawns
 * recovery files), which makes the memory store look messy. Patch the defaults
 * to a low-frequency cadence so every install behaves the same without
 * shipping a per-user hermes-memory-config.json. A user config file still
 * wins via loadConfig() merge (?? semantics: config overrides defaults).
 *
 * The plugin ships as raw TS loaded via `pi.extensions` → src/index.ts, so
 * patching src/constants.ts is enough — no build step. It lives in pi's
 * managed npm dir, which patch-package cannot reach, hence this dedicated
 * idempotent script (same pattern as patch-pi-plan-mode.mjs). Re-run it after
 * upgrading the plugin.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi-studio");
const pkgDir = join(agentDir, "npm", "node_modules", "pi-hermes-memory");

// Text rewrites. `sources` lists the upstream spelling; all hits are rewritten
// to `target`. A rule is considered applied when `target` is present and no
// source matches — keeping the script idempotent across re-runs.
const REPLACEMENTS = [
  {
    file: join("src", "constants.ts"),
    rules: [
      {
        sources: ["export const DEFAULT_NUDGE_INTERVAL = 10;"],
        target: "export const DEFAULT_NUDGE_INTERVAL = 50;",
      },
      {
        sources: ["export const DEFAULT_NUDGE_TOOL_CALLS = 15;"],
        target: "export const DEFAULT_NUDGE_TOOL_CALLS = 100;",
      },
    ],
  },
];

if (!existsSync(pkgDir)) {
  console.log(`[patch-pi-hermes-memory] plugin not found at ${pkgDir} — skipping (install it first).`);
  process.exit(0);
}

let replaced = 0;
for (const { file, rules } of REPLACEMENTS) {
  const target = join(pkgDir, file);
  if (!existsSync(target)) {
    console.warn(`[patch-pi-hermes-memory] WARN ${file} missing — plugin structure changed?`);
    continue;
  }
  let content = readFileSync(target, "utf8");
  let changed = false;
  let skipped = 0;
  for (const { sources, target: replacement } of rules) {
    const hit = sources.find((s) => content.includes(s));
    if (hit) {
      content = content.replaceAll(hit, replacement);
      changed = true;
    } else if (content.includes(replacement)) {
      skipped++;
    } else {
      console.warn(
        `[patch-pi-hermes-memory] WARN ${file}: none of ${JSON.stringify(sources)} nor target found — structure changed?`,
      );
    }
  }
  if (changed) {
    writeFileSync(target, content, "utf8");
    replaced++;
    console.log(`[patch-pi-hermes-memory] patched ${file}`);
  } else if (skipped) {
    console.log(`[patch-pi-hermes-memory] ${file} already patched — skipping.`);
  }
}

if (replaced > 0) {
  console.log("[patch-pi-hermes-memory] restart pi-studio so the plugin reloads.");
}
