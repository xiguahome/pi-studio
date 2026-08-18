// Built-in browser mode toggle: whether the chrome-devtools extension drives
// pi-studio's embedded <webview> (builtin, CDP :9333) or an external browser the
// user launched themselves (external, CDP :9222). Stored in
// <agentDir>/browser-config.json so the server (config seed), the patch script
// (postinstall) and the UI (via /api/browser-mode) share one source of truth.
// Defaults to builtin to preserve the existing behavior.

import { readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeFileAtomicSync } from "./atomic-file";

export interface BrowserConfig {
  /** true = drive the embedded <webview> (CDP :9333); false = external browser (:9222). */
  builtin: boolean;
}

const FILE_NAME = "browser-config.json";

export function getBrowserConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, FILE_NAME);
}

/** Read the toggle; missing or corrupt files mean "builtin" (the default). */
export function readBrowserConfig(path: string = getBrowserConfigPath()): BrowserConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { builtin?: unknown };
    if (typeof parsed.builtin === "boolean") return { builtin: parsed.builtin };
  } catch {
    // missing or corrupt — fall through to default
  }
  return { builtin: true };
}

export function saveBrowserConfig(builtin: boolean, path: string = getBrowserConfigPath()): void {
  writeFileAtomicSync(path, `${JSON.stringify({ builtin }, null, 2)}\n`);
}

/**
 * The CDP port the chrome-devtools extension should connect to for this mode.
 * Builtin mode follows pi-studio's own Electron CDP port (PI_DESKTOP_CDP_PORT,
 * default 9333); external mode targets a user-launched Chrome on the fixed 9222.
 */
export function cdpPortForMode(builtin: boolean): number {
  if (builtin) return Number(process.env.PI_DESKTOP_CDP_PORT) || 9333;
  return 9222;
}
