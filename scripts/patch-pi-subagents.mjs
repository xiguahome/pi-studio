#!/usr/bin/env node
// @ts-check
/**
 * patch-pi-subagents.mjs — point pi-subagents' project-scoped runtime dir at
 * `.pi-studio/subagents` instead of the hardcoded `.pi/subagents` / `.agents/subagents`.
 *
 * pi-subagents writes durable per-project state (artifacts, missions, chain
 * runs) under `<cwd>/.pi/subagents` (or the legacy `.agents/subagents` left by
 * an earlier pi-studio patch). The dir is the literal constant
 * `PROJECT_SUBAGENTS_RELATIVE_DIR` in src/shared/artifacts.ts, consumed verbatim
 * by getProjectSubagentsDir / getProjectArtifactsDir / getProjectChainRunsDir
 * and the writeArtifact/writeMetadata helpers. Unlike getAgentDir(), it does
 * NOT consult PI_CODING_AGENT_DIR or the SDK's CONFIG_DIR_NAME, so it must be
 * patched at the source.
 *
 * The package ships as raw TS loaded via `pi.extensions` → ./index.ts, so
 * patching the source is enough — no build step.
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
const pkgDir = join(agentDir, "npm", "node_modules", "pi-subagents");
const strayDir = join(agentDir, "agent", "npm", "node_modules", "pi-subagents");

// [file, [{ sources: string[], target: string }]]
// `sources` lists every upstream spelling we may meet (pristine `.pi`, or the
// legacy `.agents` left by an earlier pi-studio patch); all are rewritten to
// `target`, which keeps the script idempotent across fresh installs and re-runs.
const PATCHES = [
  [
    "src/shared/artifacts.ts",
    [
      {
        // The project-scoped dir constant. This single change redirects
        // getProjectSubagentsDir / getProjectArtifactsDir / getProjectChainRunsDir
        // (and thus every artifact/mission/chain-run write) to .pi-studio/subagents.
        sources: [
          'export const PROJECT_SUBAGENTS_RELATIVE_DIR = ".pi/subagents";',
          'export const PROJECT_SUBAGENTS_RELATIVE_DIR = ".agents/subagents";',
        ],
        target: 'export const PROJECT_SUBAGENTS_RELATIVE_DIR = ".pi-studio/subagents";',
      },
      {
        sources: [
          "Add '.pi/subagents/' to .npmignore",
          "Add '.agents/subagents/' to .npmignore",
        ],
        target: "Add '.pi-studio/subagents/' to .npmignore",
      },
    ],
  ],
  [
    "src/runs/shared/worktree.ts",
    [
      {
        sources: ["under .pi/subagents/ by default", "under .agents/subagents/ by default"],
        target: "under .pi-studio/subagents/ by default",
      },
    ],
  ],
  [
    "src/shared/types.ts",
    [
      {
        sources: ["(cwd/.pi/subagents)", "(cwd/.agents/subagents)"],
        target: "(cwd/.pi-studio/subagents)",
      },
    ],
  ],
  [
    "src/shared/utils.ts",
    [
      {
        // Make getProjectConfigDir() honor PI_CODING_AGENT_DIR (pi-studio injects
        // ~/.pi-studio) so every project-scoped resource (subagents, skills, prompts,
        // tool-descriptions, mcp allowlist) resolves to .pi-studio. Without this, the
        // directory walk in resolveConfigDirNameFromPackageJson never reaches the SDK
        // package.json (it only inspects *ancestor* dirs of the process entry point) and
        // falls back to the legacy ".pi" default — silently dropping all project-level
        // subagents/skills/prompts living under .pi-studio. PI_CODING_AGENT_DIR is either
        // the agent dir (~/.pi/agent, vanilla pi) or its parent (~/.pi-studio, pi-studio);
        // strip a trailing "/agent" so the config dir name derives correctly in both cases.
        sources: [
          "\treturn moduleValue\n\t\t?? resolveConfigDirNameFromPackageJson(entryPoint, packageRoot)\n\t\t?? DEFAULT_CONFIG_DIR_NAME;",
        ],
        target:
          "\t// pi-studio sets PI_CODING_AGENT_DIR to the agent data dir (e.g. ~/.pi-studio) so\n\t// project-scoped resources resolve to .pi-studio even when pi-subagents runs outside a\n\t// pi CLI that would otherwise fall back to the legacy \".pi\" default. PI_CODING_AGENT_DIR\n\t// is either the agent dir (~/.pi/agent, vanilla pi) or its parent (~/.pi-studio, pi-studio);\n\t// strip a trailing \"/agent\" so the config dir name derives correctly in both cases.\n\tconst fromAgentDir = (() => {\n\t\tconst raw = process.env.PI_CODING_AGENT_DIR;\n\t\tif (!raw || raw === \"~\") return undefined;\n\t\tlet base = raw.startsWith(\"~/\") ? raw.slice(2) : raw;\n\t\tif (path.basename(base) === \"agent\") base = path.dirname(base);\n\t\treturn validConfigDirName(path.basename(base));\n\t})();\n\treturn fromAgentDir\n\t\t?? moduleValue\n\t\t?? resolveConfigDirNameFromPackageJson(entryPoint, packageRoot)\n\t\t?? DEFAULT_CONFIG_DIR_NAME;",
      },
    ],
  ],
];

if (!existsSync(pkgDir)) {
  if (existsSync(strayDir)) {
    console.warn(
      `[patch-pi-subagents] WARN redundant copy at ${strayDir} (created by a pi CLI run without ` +
        `PI_CODING_AGENT_DIR) is NOT patched — pi-studio never loads it. Delete ~/.pi-studio/agent to clean it up.`,
    );
  }
  console.log(`[patch-pi-subagents] plugin not found at ${pkgDir} — skipping (install it first).`);
  process.exit(0);
}

let patched = 0;
for (const [relFile, rules] of PATCHES) {
  const filePath = join(pkgDir, relFile);
  if (!existsSync(filePath)) {
    console.warn(`[patch-pi-subagents] WARN ${relFile} missing — plugin structure changed?`);
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
        `[patch-pi-subagents] WARN ${relFile}: none of ${JSON.stringify(sources)} nor "${target}" found — structure changed?`,
      );
    }
  }
  if (changed) {
    writeFileSync(filePath, content, "utf8");
    patched++;
    console.log(`[patch-pi-subagents] patched ${relFile}`);
  } else if (skipped) {
    console.log(`[patch-pi-subagents] ${relFile} already patched — skipping.`);
  }
}

if (patched > 0) {
  console.log(`[patch-pi-subagents] done (${patched} file(s) patched). Restart pi-studio so the plugin reloads.`);
} else if (!existsSync(pkgDir)) {
  console.log("[patch-pi-subagents] nothing to do.");
}
