// Built-in hermes-memory config: pi-studio seeds a default
// ~/.pi-studio/hermes-memory-config.json so fresh installs get a low-frequency
// background memory review cadence (50 turns / 100 tool calls instead of the
// chatty upstream 10/15) out of the box. Seeding is missing-only — once the
// file exists (whether stock or user-edited) it is never overwritten, so user
// customisations survive forever. Bundled source lives at
// resources/hermes-memory-config.json. This mirrors ensureBuiltinAgentsMd()
// (lib/builtin-agents.ts) and ensureChromeDevtoolsConfig().

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Bundled default config source (resources/hermes-memory-config.json). */
export function getBuiltinHermesMemoryConfigSourcePath(appRoot: string = process.cwd()): string {
  return join(appRoot, "resources", "hermes-memory-config.json");
}

/** Where the config lives (~/.pi-studio/hermes-memory-config.json). */
export function getHermesMemoryConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "hermes-memory-config.json");
}

/**
 * Seed the hermes-memory config from the bundled copy. Returns true if it wrote
 * the file (target was missing), false otherwise. Never throws — a missing
 * source is a no-op. Safe to call on every boot.
 */
export function ensureHermesMemoryConfig(
  options: { appRoot?: string; agentDir?: string } = {},
): boolean {
  const agentDir = options.agentDir ?? getAgentDir();
  const target = getHermesMemoryConfigPath(agentDir);
  if (existsSync(target)) return false;
  const source = getBuiltinHermesMemoryConfigSourcePath(options.appRoot);
  if (!existsSync(source)) return false;
  mkdirSync(agentDir, { recursive: true });
  copyFileSync(source, target);
  return true;
}
