#!/usr/bin/env node
// @ts-check
/**
 * patch-pi-mcp-adapter.mjs — point pi-mcp-adapter's *project-level* paths at
 * `.pi-studio` instead of the hardcoded `.pi` / `.agents`, consistent with
 * pi-studio's CONFIG_DIR_NAME patch on the SDK.
 *
 * pi-mcp-adapter already resolves its *user/agent-level* config from
 * PI_CODING_AGENT_DIR (agent-dir.ts → getAgentDir()), and the global candidate
 * list at the top of config.ts already uses `.pi-studio` (homedir/.pi-studio/...).
 * Only the project-scoped paths below are still hardcoded `.pi` (or the legacy
 * `.agents` left by an earlier pi-studio patch):
 *   - PROJECT_PI_CONFIG_NAME = ".pi/mcp.json"   (project override — getProjectPiConfigPath)
 *   - findProjectRoot() existence check          `existsSync(join(current, ".pi"))`
 *   - mcp-trace writer default                   `<cwd>/.pi/mcp-traces/...`
 *   - the discovery-precedence UI label          "6. .pi/mcp.json"
 *
 * The plugin ships as raw TS loaded via `pi.extensions` → ./src/index.ts, so
 * patching the source is enough — no build step.
 *
 * It lives in pi's managed npm dir, which patch-package cannot reach (it only
 * patches the project node_modules), hence this dedicated idempotent script.
 * Re-run it after upgrading the plugin.
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
const pkgDir = join(agentDir, "npm", "node_modules", "pi-mcp-adapter");
const strayDir = join(agentDir, "agent", "npm", "node_modules", "pi-mcp-adapter");

// [file, [{ sources: string[], target: string }]]
// `sources` lists every upstream spelling we may meet (pristine `.pi`, or the
// legacy `.agents` left by an earlier patch); all are rewritten to `target`,
// which keeps the script idempotent across fresh installs and re-runs.
const PATCHES = [
  [
    "config.ts",
    [
      {
        sources: [
          'const PROJECT_PI_CONFIG_NAME = ".pi/mcp.json";',
          'const PROJECT_PI_CONFIG_NAME = ".agents/mcp.json";',
        ],
        target: 'const PROJECT_PI_CONFIG_NAME = ".pi-studio/mcp.json";',
      },
      {
        sources: [
          'existsSync(join(current, ".pi"))',
          'existsSync(join(current, ".agents"))',
        ],
        target: 'existsSync(join(current, ".pi-studio"))',
      },
      {
        // Global MCP candidate paths are hardcoded homedir()/.agents — they do
        // NOT honor PI_CODING_AGENT_DIR, so the renamed agent dir must be
        // written explicitly or global mcp.json is never found after the rename.
        sources: ['join(homedir(), ".agents", "mcp.json")'],
        target: 'join(homedir(), ".pi-studio", "mcp.json")',
      },
      {
        sources: ['join(homedir(), ".agents", "mcp", "mcp.json")'],
        target: 'join(homedir(), ".pi-studio", "mcp", "mcp.json")',
      },
      {
        sources: ['"user-global .agents MCP"'],
        target: '"user-global .pi-studio MCP"',
      },
      {
        sources: ['"user-global .agents nested MCP"'],
        target: '"user-global .pi-studio nested MCP"',
      },
      {
        sources: ['.agents MCP config'],
        target: '.pi-studio MCP config',
      },
      {
        sources: ['.agents/mcp MCP config'],
        target: '.pi-studio/mcp MCP config',
      },
    ],
  ],
  [
    "mcp-trace.ts",
    [
      {
        sources: [
          'resolve(sessionCwd ?? process.cwd(), ".pi", "mcp-traces",',
          'resolve(sessionCwd ?? process.cwd(), ".agents", "mcp-traces",',
        ],
        target: 'resolve(sessionCwd ?? process.cwd(), ".pi-studio", "mcp-traces",',
      },
    ],
  ],
  [
    "mcp-setup-panel.ts",
    [
      {
        sources: ['"6. .pi/mcp.json"', '"6. .agents/mcp.json"'],
        target: '"6. .pi-studio/mcp.json"',
      },
      {
        // Discovery-precedence UI labels for the global candidates must match
        // the renamed agent dir (~/.pi-studio), else the panel misleads.
        sources: ['"2. ~/.agents/mcp.json"', '"2. ~/.pi-studio/mcp.json"'],
        target: '"2. ~/.pi-studio/mcp.json"',
      },
      {
        sources: ['"3. ~/.agents/mcp/mcp.json"', '"3. ~/.pi-studio/mcp/mcp.json"'],
        target: '"3. ~/.pi-studio/mcp/mcp.json"',
      },
    ],
  ],
];

if (!existsSync(pkgDir)) {
  if (existsSync(strayDir)) {
    console.warn(
      `[patch-pi-mcp-adapter] WARN redundant copy at ${strayDir} (created by a pi CLI run without ` +
        `PI_CODING_AGENT_DIR) is NOT patched — pi-studio never loads it. Delete ~/.pi-studio/agent to clean it up.`,
    );
  }
  console.log(`[patch-pi-mcp-adapter] plugin not found at ${pkgDir} — skipping (install it first).`);
  process.exit(0);
}

let patched = 0;
for (const [relFile, rules] of PATCHES) {
  const filePath = join(pkgDir, relFile);
  if (!existsSync(filePath)) {
    console.warn(`[patch-pi-mcp-adapter] WARN ${relFile} missing — plugin structure changed?`);
    continue;
  }
  let content = readFileSync(filePath, "utf8");
  let changed = false;
  let skipped = 0;
  for (const { sources, target } of rules) {
    const hit = sources.find((s) => content.includes(s));
    if (hit) {
      for (const s of sources) content = content.replaceAll(s, target);
      changed = true;
    } else if (content.includes(target)) {
      skipped++; // already patched
    } else {
      console.warn(
        `[patch-pi-mcp-adapter] WARN ${relFile}: none of ${JSON.stringify(sources)} nor "${target}" found — structure changed?`,
      );
    }
  }
  if (changed) {
    writeFileSync(filePath, content, "utf8");
    patched++;
    console.log(`[patch-pi-mcp-adapter] patched ${relFile}`);
  } else if (skipped) {
    console.log(`[patch-pi-mcp-adapter] ${relFile} already patched — skipping.`);
  }
}

if (patched > 0) {
  console.log(`[patch-pi-mcp-adapter] done (${patched} file(s) patched). Restart pi-studio so the plugin reloads.`);
} else if (!existsSync(pkgDir)) {
  console.log("[patch-pi-mcp-adapter] nothing to do.");
}
