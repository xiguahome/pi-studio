#!/usr/bin/env node
// @ts-check
/**
 * patch-pi-chrome-devtools.mjs — make @narumitw/pi-chrome-devtools drive pi-studio's
 * built-in <webview> browser (and open NEW webview tabs) instead of the main window.
 *
 * Background: chrome-devtools' listPages() only treats CDP targets of type "page"
 * as drivable, but Electron <webview> targets are type "webview". Without this
 * patch the sole drivable page on CDP :9333 is the main BrowserWindow — every
 * chrome_devtools_* call drives the app UI itself (e.g. "open baidu.com" wipes
 * out the whole interface). Also, navigate reused one webview for every URL
 * (overwriting), and new_page/createPage used /json/new which Electron disables.
 *
 * This patch (cdp-client.ts):
 *   1. listPages(): keep only type === "webview". The main window is never listed.
 *   2. resolvePageForNavigation(): origin-heuristic — same-origin reuse the
 *      current tab (baidu -> baidu/s?wd=), different origin open a NEW tab.
 *   3. createPage(): ask pi-studio to open a new <webview> tab (via the in-process
 *      globalThis bridge; HTTP fallback) and wait for its CDP target by id.
 * And tools.ts: pass the navigate URL into resolvePageForNavigation so the
 * origin check can see it.
 *
 * --mode=builtin|external (or read from ~/.pi-studio/browser-config.json, default
 * builtin). Builtin mode applies the webview patch above so the agent drives
 * pi-studio's embedded <webview>. External mode REVERSES it — restore listPages
 * to type === "page", createPage to /json/new, etc. — so the agent can drive a
 * user-launched external Chrome (CDP :9222) whose targets are all "page" type.
 *
 * The package ships as raw TS loaded via `pi.extensions` → ./src/index.ts, so
 * patching the source is enough — no build step. It lives in pi's managed npm
 * dir (patch-package cannot reach it), hence this idempotent postinstall script.
 * Re-run after upgrading the plugin. Restart pi-studio (or /reload) to reload.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi-studio");
const pkgDir = join(agentDir, "npm", "node_modules", "@narumitw", "pi-chrome-devtools");
const strayDir = join(agentDir, "agent", "npm", "node_modules", "@narumitw", "pi-chrome-devtools");

// --- cdp-client.ts: listPages() — only <webview> targets (builtin) ---
const LISTPAGES_SOURCE = 'return pages.filter((page) => page.type === "page" && page.webSocketDebuggerUrl);';
const LISTPAGES_TARGET = 'return pages.filter((page) => page.type === "webview" && page.webSocketDebuggerUrl);';

// --- cdp-client.ts: resolvePageForNavigation() — origin heuristic ---
// Sources cover BOTH the upstream original and the earlier "wait for webview"
// intermediate patch, so re-running reaches the final state from either.
const RESOLVE_UPSTREAM =
  'export async function resolvePageForNavigation(pageId?: string) {\n' +
  '\tconst pages = await listPages();\n' +
  '\tif (pageId) return { created: false, page: requirePage(pageId, pages) };\n' +
  '\n' +
  '\tconst page = resolveDefaultPage(pages);\n' +
  '\tif (page) return { created: false, page };\n' +
  '\n' +
  '\treturn { created: true, page: await createPage("about:blank") };\n' +
  '}';

const RESOLVE_WAIT =
  'export async function resolvePageForNavigation(pageId?: string) {\n' +
  '\tconst pages = await listPages();\n' +
  '\tif (pageId) return { created: false, page: requirePage(pageId, pages) };\n' +
  '\n' +
  '\tconst page = resolveDefaultPage(pages);\n' +
  '\tif (page) return { created: false, page };\n' +
  '\n' +
  '\t// pi-studio: the built-in browser is an Electron <webview>, whose CDP target\n' +
  '\t// appears only once the webview is mounted. Never createPage here - Electron\n' +
  '\t// /json/new would spawn a detached BrowserWindow. AppShell auto-opens a\n' +
  '\t// webview when a chrome_devtools_* tool starts, so wait briefly then reuse it.\n' +
  '\tconst deadline = Date.now() + 5000;\n' +
  '\tfor (;;) {\n' +
  '\t\tconst all = await fetchDevToolsJson<DevToolsPage[]>("/json/list");\n' +
  '\t\tconst webviews = all.filter((p) => p.type === "webview" && p.webSocketDebuggerUrl);\n' +
  '\t\tif (webviews.length > 0) return { created: false, page: webviews[0] };\n' +
  '\t\tif (Date.now() >= deadline) {\n' +
  '\t\t\tthrow new Error(\n' +
  '\t\t\t\t"No built-in browser webview found at " +\n' +
  '\t\t\t\t\tdevToolsEndpoint() +\n' +
  '\t\t\t\t\t". Open the built-in browser in pi-studio (it auto-opens when a chrome_devtools tool runs). " +\n' +
  '\t\t\t\t\tlaunchHint(),\n' +
  '\t\t\t);\n' +
  '\t\t}\n' +
  '\t\tawait new Promise((r) => setTimeout(r, 250));\n' +
  '\t}\n' +
  '}';

const RESOLVE_ORIGIN_V1 =
  'export async function resolvePageForNavigation(pageId?: string, targetUrl?: string) {\n' +
  '\tconst pages = await listPages();\n' +
  '\tif (pageId) return { created: false, page: requirePage(pageId, pages) };\n' +
  '\n' +
  '\tconst page = resolveDefaultPage(pages);\n' +
  '\tlet sameOrigin = false;\n' +
  '\tif (page && targetUrl) {\n' +
  '\t\ttry {\n' +
  '\t\t\tsameOrigin = new URL(page.url).origin === new URL(targetUrl).origin;\n' +
  '\t\t} catch {\n' +
  '\t\t\tsameOrigin = false;\n' +
  '\t\t}\n' +
  '\t}\n' +
  '\tif (page && (!targetUrl || sameOrigin)) {\n' +
  '\t\treturn { created: false, page };\n' +
  '\t}\n' +
  '\t// pi-studio: different origin (or no tab yet) opens a new <webview> tab via\n' +
  '\t// createPage; same-origin reuses the current tab (baidu -> baidu/s?wd=).\n' +
  '\treturn { created: false, page: await createPage(targetUrl || "about:blank") };\n' +
  '}';

const RESOLVE_ORIGIN =
  'export async function resolvePageForNavigation(pageId?: string, targetUrl?: string) {\n' +
  '\tconst pages = await listPages();\n' +
  '\tif (pageId) return { created: false, page: requirePage(pageId, pages) };\n' +
  '\n' +
  '\tconst page = resolveDefaultPage(pages);\n' +
  '\tlet sameOrigin = false;\n' +
  '\tif (page && targetUrl) {\n' +
  '\t\ttry {\n' +
  '\t\t\tsameOrigin = new URL(page.url).origin === new URL(targetUrl).origin;\n' +
  '\t\t} catch {\n' +
  '\t\t\tsameOrigin = false;\n' +
  '\t\t}\n' +
  '\t}\n' +
  '\tif (page && (!targetUrl || sameOrigin || page.url === "about:blank")) {\n' +
  '\t\treturn { created: false, page };\n' +
  '\t}\n' +
  '\t// pi-studio: different origin opens a new <webview> tab via createPage;\n' +
  '\t// same-origin (or a fresh about:blank placeholder) reuses the current tab.\n' +
  '\treturn { created: false, page: await createPage(targetUrl || "about:blank") };\n' +
  '}';

// --- cdp-client.ts: createPage() — open a new pi-studio <webview> tab ---
const CREATEPAGE_UPSTREAM =
  'export async function createPage(url: string, options: { waitMs?: number } = {}) {\n' +
  '\tconst waitMs = options.waitMs ?? DEFAULT_ENDPOINT_WAIT_MS;\n' +
  '\tawait ensureDevToolsEndpoint(waitMs);\n' +
  '\tconst page = await withEndpointRetry(\n' +
  '\t\t() =>\n' +
  '\t\t\tfetchDevToolsJson<DevToolsPage>(`/json/new?${encodeURIComponent(url)}`, {\n' +
  '\t\t\t\tmethod: "PUT",\n' +
  '\t\t\t}),\n' +
  '\t\twaitMs,\n' +
  '\t);\n' +
  '\tif (page.type !== "page" || !page.webSocketDebuggerUrl) {\n' +
  '\t\tthrow new Error("Chrome DevTools created a target that is not an inspectable page.");\n' +
  '\t}\n' +
  '\n' +
  '\treturn page;\n' +
  '}';

const CREATEPAGE_NEW =
  'export async function createPage(url: string) {\n' +
  '\tawait ensureDevToolsEndpoint(DEFAULT_ENDPOINT_WAIT_MS);\n' +
  '\t// pi-studio: the built-in browser is an Electron <webview>. Electron disables\n' +
  '\t// /json/new, so ask pi-studio to open a new webview tab and wait for its CDP\n' +
  '\t// target to appear (matched by id, not url, to survive redirects).\n' +
  '\tconst before = new Set((await listPages()).map((p) => p.id));\n' +
  '\tconst bridge = (globalThis as any).__piBrowserTabBridge;\n' +
  '\tif (bridge?.requestNewTab) {\n' +
  '\t\tbridge.requestNewTab(url);\n' +
  '\t} else {\n' +
  '\t\tconst port = process.env.PORT || 30141;\n' +
  '\t\tawait fetch(`http://127.0.0.1:${port}/api/browser-tabs/open`, {\n' +
  '\t\t\tmethod: "POST",\n' +
  '\t\t\theaders: { "Content-Type": "application/json" },\n' +
  '\t\t\tbody: JSON.stringify({ url }),\n' +
  '\t\t}).catch(() => {});\n' +
  '\t}\n' +
  '\tconst deadline = Date.now() + 5000;\n' +
  '\twhile (Date.now() < deadline) {\n' +
  '\t\tconst created = (await listPages()).find((p) => !before.has(p.id));\n' +
  '\t\tif (created) return created;\n' +
  '\t\tawait new Promise((r) => setTimeout(r, 250));\n' +
  '\t}\n' +
  '\tthrow new Error(\n' +
  '\t\t"No built-in browser webview tab appeared at " +\n' +
  '\t\t\tdevToolsEndpoint() +\n' +
  '\t\t\t". Open the built-in browser in pi-studio and retry.",\n' +
  '\t);\n' +
  '}';

// --- tools.ts: pass navigate URL into resolvePageForNavigation ---
const NAVIGATE_SOURCE = 'const { created, page } = await resolvePageForNavigation(params.pageId);';
const NAVIGATE_TARGET = 'const { created, page } = await resolvePageForNavigation(params.pageId, params.url);';

// Builtin: page/webview-agnostic upstream → pi-studio webview patch (drive <webview>).
// Each rule: any of `sources` (upstream + historical intermediate states) → `target`.
const BUILTIN_PATCHES = [
  [
    "src/cdp-client.ts",
    [
      { sources: [LISTPAGES_SOURCE], target: LISTPAGES_TARGET },
      { sources: [RESOLVE_UPSTREAM, RESOLVE_WAIT, RESOLVE_ORIGIN_V1], target: RESOLVE_ORIGIN },
      { sources: [CREATEPAGE_UPSTREAM], target: CREATEPAGE_NEW },
    ],
  ],
  [
    "src/tools.ts",
    [{ sources: [NAVIGATE_SOURCE], target: NAVIGATE_TARGET }],
  ],
];

// External: reverse — pi-studio webview patch → upstream original (drive an external
// Chrome whose CDP targets are type "page"). Sources cover every state builtin mode
// can produce so the reverse is idempotent from any of them.
const EXTERNAL_PATCHES = [
  [
    "src/cdp-client.ts",
    [
      { sources: [LISTPAGES_TARGET], target: LISTPAGES_SOURCE },
      { sources: [RESOLVE_ORIGIN, RESOLVE_ORIGIN_V1, RESOLVE_WAIT], target: RESOLVE_UPSTREAM },
      { sources: [CREATEPAGE_NEW], target: CREATEPAGE_UPSTREAM },
    ],
  ],
  [
    "src/tools.ts",
    [{ sources: [NAVIGATE_TARGET], target: NAVIGATE_SOURCE }],
  ],
];

/** Resolve the patch mode: explicit --mode= arg wins; otherwise read the shared
 *  browser-config.json (so postinstall with no args follows the user's toggle);
 *  default to builtin to preserve the existing behavior. */
function resolveMode() {
  const arg = process.argv.find((a) => a.startsWith("--mode="));
  if (arg) {
    const value = arg.slice("--mode=".length);
    if (value === "builtin" || value === "external") return value;
    console.warn(`[patch-pi-chrome-devtools] unknown --mode=${value}, falling back to config/default.`);
  }
  try {
    const cfgPath = join(agentDir, "browser-config.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      if (cfg.builtin === false) return "external";
    }
  } catch {
    // ignore — fall through to default
  }
  return "builtin";
}

if (!existsSync(pkgDir)) {
  if (existsSync(strayDir)) {
    console.warn(
      `[patch-pi-chrome-devtools] WARN redundant copy at ${strayDir} (created by a pi CLI run without ` +
        `PI_CODING_AGENT_DIR) is NOT patched — pi-studio never loads it. Delete ~/.pi-studio/agent to clean it up.`,
    );
  }
  console.log(`[patch-pi-chrome-devtools] plugin not found at ${pkgDir} — skipping (install it first).`);
  process.exit(0);
}

const mode = resolveMode();
const PATCHES = mode === "external" ? EXTERNAL_PATCHES : BUILTIN_PATCHES;

let patched = 0;
for (const [relFile, rules] of PATCHES) {
  const filePath = join(pkgDir, relFile);
  if (!existsSync(filePath)) {
    console.warn(`[patch-pi-chrome-devtools] WARN ${relFile} missing — plugin structure changed?`);
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
      skipped++; // already in the desired state
    } else {
      console.warn(
        `[patch-pi-chrome-devtools] WARN ${relFile}: none of ${JSON.stringify(sources)} nor the expected target found — structure changed?`,
      );
    }
  }
  if (changed) {
    writeFileSync(filePath, content, "utf8");
    patched++;
    console.log(`[patch-pi-chrome-devtools] patched ${relFile} (mode=${mode})`);
  } else if (skipped) {
    console.log(`[patch-pi-chrome-devtools] ${relFile} already in mode=${mode} state — skipping.`);
  }
}

if (patched > 0) {
  console.log(
    `[patch-pi-chrome-devtools] done (mode=${mode}, ${patched} file(s) patched). Restart pi-studio (or /reload) so the plugin reloads.`,
  );
} else {
  console.log(`[patch-pi-chrome-devtools] nothing to do (mode=${mode}).`);
}
