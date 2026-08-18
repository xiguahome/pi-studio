import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readBrowserConfig, cdpPortForMode } from "./browser-config";

// pi-studio exposes its built-in browser (<webview>) over CDP on port 9333 by
// default (desktop/main.js). The @narumitw/pi-chrome-devtools extension drives
// the browser via CDP but defaults to 127.0.0.1:9222, so without this config
// file it cannot find pi-studio's webview targets. We seed the canonical user
// file (${PI_CODING_AGENT_DIR}/pi-chrome-devtools.json) with the matching
// endpoint so the extension attaches to pi-studio's built-in browser instead of
// trying to auto-launch its own Chromium.
//
// The built-in/external toggle (lib/browser-config.ts) picks the port: builtin
// mode connects to pi-studio's webview (CDP :9333, or PI_DESKTOP_CDP_PORT);
// external mode connects to a user-launched Chrome (:9222). ensureChromeDevtools
// Config() seeds missing-only on boot; writeChromeDevtoolsConfig() force-writes
// on toggle so the switch takes effect after the next pi-studio restart.

const FILE_NAME = "pi-chrome-devtools.json";

function settingsFilePath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi-studio");
  return path.join(dir, FILE_NAME);
}

function buildConfig(port: number): { browser: { endpoint: string; autoLaunch: boolean } } {
  return {
    browser: {
      endpoint: `http://127.0.0.1:${port}`,
      // Reuse the already-open browser (built-in webview or the user's Chrome);
      // never auto-launch a separate Chromium that would not share its targets.
      autoLaunch: false,
    },
  };
}

function writeConfig(filePath: string, config: ReturnType<typeof buildConfig>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Seed the default config file on boot (missing-only — never overwrites user edits). */
export function ensureChromeDevtoolsConfig(): void {
  const filePath = settingsFilePath();
  try {
    if (fs.existsSync(filePath)) return;
    const { builtin } = readBrowserConfig();
    const port = cdpPortForMode(builtin);
    const config = buildConfig(port);
    writeConfig(filePath, config);
    console.log(`[pi-studio] wrote default ${FILE_NAME} (endpoint ${config.browser.endpoint})`);
  } catch (error) {
    console.error("[pi-studio] chrome-devtools config seed failed:", error);
  }
}

/**
 * Force-write the endpoint for the given mode. Used when the user toggles the
 * built-in/external switch — the file is overwritten regardless of prior edits
 * so the new port takes effect after the next pi-studio restart.
 */
export function writeChromeDevtoolsConfig(builtin: boolean): void {
  const filePath = settingsFilePath();
  const port = cdpPortForMode(builtin);
  const config = buildConfig(port);
  writeConfig(filePath, config);
  console.log(`[pi-studio] updated ${FILE_NAME} (endpoint ${config.browser.endpoint})`);
}
