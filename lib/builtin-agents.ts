// Built-in global AGENTS.md: pi-studio ships a default ~/.pi-studio/AGENTS.md so
// every fresh install has a sensible baseline global instruction file. Seeding
// is missing-only — once the file exists (whether untouched or user-edited) it
// is never overwritten, so user customisations survive forever. Bundled source
// lives at resources/builtin-agents.md.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Bundled default AGENTS.md source (resources/builtin-agents.md). */
export function getBuiltinAgentsSourcePath(appRoot: string = process.cwd()): string {
  return join(appRoot, "resources", "builtin-agents.md");
}

/** Where the global AGENTS.md lives (~/.pi-studio/AGENTS.md). */
export function getGlobalAgentsMdPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "AGENTS.md");
}

/**
 * Seed the global AGENTS.md from the bundled copy. Returns true if it wrote
 * the file (target was missing), false otherwise. Never throws — a missing
 * source is a no-op. Safe to call on every boot.
 */
export function ensureBuiltinAgentsMd(
  options: { appRoot?: string; agentDir?: string } = {},
): boolean {
  const agentDir = options.agentDir ?? getAgentDir();
  const target = getGlobalAgentsMdPath(agentDir);
  if (existsSync(target)) return false;
  const source = getBuiltinAgentsSourcePath(options.appRoot);
  if (!existsSync(source)) return false;
  mkdirSync(agentDir, { recursive: true });
  copyFileSync(source, target);
  return true;
}
