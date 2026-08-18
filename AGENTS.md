# pi-studio - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

---

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi-studio/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running ───────▶ running id snapshot   │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession created.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

**Data directory**: all pi-studio data (sessions, models, settings, auth) lives under `$PI_CODING_AGENT_DIR`, which defaults to `~/.pi-studio/` — injected by `desktop/main.js` for the desktop build and by `next.config.ts` as a dev fallback. This is **intentionally isolated** from the pi CLI's `~/.pi/agent/`.

**Project-local config dir is `.pi-studio/`, not `.pi/`**: the SDK's project-level dir name (`CONFIG_DIR_NAME` in `pi-coding-agent/dist/config.js`) is patched `.pi` → `.pi-studio` via `patch-package` — see `patches/@earendil-works+pi-coding-agent+0.84.0.patch`, auto-applied by the `postinstall` script. So project extensions / skills / prompts / themes / settings / project-scoped plugins all live under `cwd/.pi-studio/`; the `.pi` name never appears at runtime. If a pi upgrade makes the patch conflict, `npm install` errors out — re-apply the one-line edit (`CONFIG_DIR_NAME = ".pi-studio"`) to `dist/config.js` and run `npx patch-package @earendil-works/pi-coding-agent` to regenerate it.

**Hardcoded `.pi` in built-in npm extensions**: `patch-package` only reaches the project `node_modules`, but some built-in extensions installed in pi's managed npm dir (`~/.pi-studio/npm/node_modules/`) hardcode `.pi` paths that ignore `CONFIG_DIR_NAME` and `PI_CODING_AGENT_DIR`. Two idempotent `postinstall` scripts patch those at the source (TS loaded raw via `pi.extensions`, no build step); re-run the relevant script after upgrading that extension:
- `scripts/patch-pi-tasks.mjs` — `@tintinweb/pi-tasks`: `.pi/tasks` → `.pi-studio/tasks`, and makes the store path follow the session cwd (`process.cwd()` → `ExtensionContext.cwd`).
- `scripts/patch-pi-subagents.mjs` — `pi-subagents`: (1) project-scoped `PROJECT_SUBAGENTS_RELATIVE_DIR` `.pi/subagents` → `.pi-studio/subagents` (artifacts/missions/chain-runs); (2) `shared/utils.ts` `resolveConfigDirName()` — makes `getProjectConfigDir()` honor `PI_CODING_AGENT_DIR` (pi-studio injects `~/.pi-studio`) instead of falling back to the legacy `.pi` default. Without (2), the directory walk in `resolveConfigDirNameFromPackageJson` only inspects *ancestor* dirs of the process entry point and never reaches the SDK package.json, so it silently drops every project-level subagent/skill/prompt/mcp-allowlist living under `.pi-studio`. `getAgentDir()` already honors `PI_CODING_AGENT_DIR`, so it needed no change.

**`pi-chrome-devtools` drives only `<webview>`, never the main window**: `@narumitw/pi-chrome-devtools`' `listPages()` keeps only CDP targets of `type === "page"`, but Electron `<webview>` targets are `type === "webview"`. Without a patch the sole drivable page on CDP :9333 is the pi-studio main window, so any `chrome_devtools_*` call (e.g. agent "open baidu.com") navigates the whole app window and wipes out the UI. `scripts/patch-pi-chrome-devtools.mjs` (same postinstall idempotent pattern) patches `src/cdp-client.ts` + `src/tools.ts`: (1) `listPages` returns only `<webview>` targets (main window never listed); (2) `resolvePageForNavigation` uses an origin heuristic — same-origin or an `about:blank` placeholder reuses the current tab, different origin opens a new one; (3) `createPage` no longer calls `/json/new` (disabled by Electron) — instead it asks pi-studio to mount a new `<webview>` tab via the in-process `globalThis.__piBrowserTabBridge` (`lib/browser-tab-bridge.ts` → `/api/browser-tabs/events` SSE → `AppShell.handleOpenBrowser`) and waits for the new target by id; (4) `tools.ts` `navigateTool` passes the URL through. Net effect: agent "open baidu and google" yields two right-pane webview tabs. AppShell auto-opens an `about:blank` webview on the first `chrome_devtools_*` tool (`onToolStart`, builtin mode only), and the main window has a `did-navigate` last-resort guard that reloads the app if anything ever navigates it off `serverInfo.url` (`will-navigate`/`preventDefault` cannot stop CDP `Page.navigate`).

The package is a **built-in extension** (`lib/builtin-extension-sources.ts` → `BUILTIN_EXTENSION_SOURCES`: seeded on boot, not removable from the plugin panel). The patch is therefore applied by `runPostInstallPatches()` (`lib/builtin-extensions.ts`, shared by the built-in seed and `/api/plugins` install/update — the same idempotent script list as the `postinstall` hook), so a fresh seed install is patched immediately and panel upgrades re-patch automatically. If you ever upgrade the extension by hand, re-run `node scripts/patch-pi-chrome-devtools.mjs` (add `--mode=builtin|external` to pick a side; no arg reads `~/.pi-studio/browser-config.json`, default builtin).

**Built-in vs external browser toggle** (`lib/browser-config.ts`, `~/.pi-studio/browser-config.json`): the Settings → General "Built-in browser" switch picks whether the agent drives pi-studio's `<webview>` (CDP :9333) or a user-launched external Chrome (:9222). `--mode=external` **reverses every patch rule** — `listPages`→`type === "page"`, `createPage`→`/json/new`, `resolvePageForNavigation`→upstream — so the plugin drives the external Chrome whose CDP targets are all `page`; `--mode=builtin` re-applies the webview patch. `PUT /api/browser-mode` persists the toggle, force-rewrites `pi-chrome-devtools.json` (`writeChromeDevtoolsConfig`), and re-runs the patch. The switch only takes effect after restarting pi-studio (plugin source is patched on disk + AgentSession already required the old code). In external mode AppShell hides the "open built-in browser" button and `handleToolStart` skips auto-mounting an `about:blank` webview; the `<webview>` panel/bridge stay but idle. External mode needs Chrome launched with `--remote-debugging-port=9222 --remote-allow-origins=*`.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/all-providers/route.ts     GET API-key provider list
  auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth provider list
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.pi-studio/models.json
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  worktrees/route.ts              GET read-only project/git context (worktrees, branches)
  git/checkout/route.ts           POST { cwd, branch } — in-place `git switch`

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for pi SDK objects
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  tool-presets.ts     PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts  browser-persisted default for fresh sessions
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts         project/branch resolution; worktrees are queried, never created

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer + Window.piDesktop type declarations
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  UpdatesConfig.tsx   Settings → 软件更新面板（检查/下载/安装，状态机驱动）
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)

desktop/
  main.js             Electron main process: BrowserWindow + Next.js server + IPC handlers + first-run deps check
  preload.js          Context bridge: window.piDesktop (info/selectDirectory/updater methods)
  updater.js          Online updater: HTTP version check + download + detached spawn installer
  loading.html        Boot/loading screen: status + progress bar + npm log panel (setLoadingStatus/Progress/Log)

scripts/
  patch-pi-*.mjs      idempotent postinstall patches for built-in npm extensions
  gen-update-manifest.mjs  generates latest.json next to installers

desktop/scripts/
  install-node-runtime.mjs  downloads pinned Node v22.19.0 + bundled npm into desktop/runtime/node-runtime
  first-run-install.mjs     packaged first-launch install: npm install --omit=dev via bundled npm, JSON events
                            (stage/progress/log/error/done) → loading.html

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useTheme.ts         theme state
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)
- **Every teardown path must reach extensions**: `shutdown()` emits `session_shutdown` then destroys; `destroy()` fires the same event fire-and-forget when `shutdown()` never ran (process exit, direct destroy). Without this, extension background tasks (pi-subagents pollers/watchers/IPC) outlive the invalidated runtime and surface 'extension ctx is stale' errors on later traffic. Handler sync cleanup prefixes run before `dispose()` invalidates; async continuations are swallowed by the stale-ctx filter in the `bindExtensions` onError callback (logged server-side with extensionPath + event, never a popup). Never remove either layer.

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` passes an empty tool allow-list and forces `agent.state.systemPrompt = ""` after startup/reload/resource discovery.

The last preset explicitly selected by the user is stored in browser `localStorage` and initializes fresh-session composers only. Existing sessions never trust that preference; they use their live `get_tools` state or pi's default when no wrapper exists.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi-studio/settings.json`. `ChatWindow` pre-selects this on mount for new sessions. Explicit browser model/thinking selections are applied atomically during AgentSession construction, then `lib/startup-preferences.ts` persists their effective values without replaying `set_model`/`set_thinking_level`; implicit `enabledModels` fallbacks and thinking pins are not persisted.

### Model list is global — never re-couple it to the cwd
`GET /api/models` takes **no cwd**: it builds agent services once against `homedir()` and caches a single entry (`lib/models-cache.ts`), so global `~/.pi-studio/settings.json` applies and switching projects never rebuilds services or blanks the selector (the per-cwd rebuild was why "new session" briefly/permahid the model button). `ModelsProvider` fetches once on mount and stays alive across project/session switches; failures set `modelError` and are never written to the client cache, so the next mount retries instead of hiding the selector for the TTL. Project-level `.pi-studio/settings.json` `enabledModels` and project-extension-registered models intentionally do **not** affect the selector list anymore.

`lib/models-cache.ts` keeps its state on `globalThis.__piModelsCacheState` — if you ever change that state's shape, keep the shape-validation guard in `getModelsCacheState()`: globalThis survives hot reloads, and after the Map-keyed → single-slot migration a stale Map `inFlight` was returned as the load promise and `Response.json(Map)` serialized to `{}`, permanently returning an empty list until process restart.

### `enabledModels` scoping
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. `startRpcSession()` resolves that scope (per session cwd) before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display (against global settings — see "Model list is global"). If the user hand-picks a model that the project scope excludes, `/api/agent/new` fails via `selectInitialModelScope` throwing — that error path is intentional.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Branch switching and project grouping
- Branch switching is a plain in-place `git switch` on the active project directory (`POST /api/git/checkout`, falls back to `git checkout` on git < 2.23). **pi-studio never creates or removes worktrees** — the old worktree-isolation flow was removed; don't reintroduce it.
- `lib/worktree.ts` still resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so sessions from any checkout of one repo group together in the sidebar.
- `GET /api/worktrees` remains the read-only project/git context endpoint (chip + branch list) and is guarded by the same allowed-root rules as `/api/files`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- git prints POSIX-style absolute paths even on Windows, so every path read out of git goes through `toNativePath()` (`lib/paths.ts`) before it is compared or returned. Compare paths with `samePath()`, never `===` — raw equality made `isTopLevel` permanently false on Windows. Branch names are not paths and must keep their forward slashes.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.
- Allowed roots are stored slash-normalized, but that is a Set-key convention, not a correctness requirement: `isPathWithinRoots()` (`lib/path-security.ts`, the single implementation behind `isFilePathAllowed()`) re-resolves and case-folds both sides, so either path form authorizes correctly. Keep that one implementation — it is the security boundary.

### Plugins and skills
- **Built-in extension versions are pinned** (`lib/builtin-extension-sources.ts`): every spec carries an exact `@version`. Never revert to a bare `npm:<name>` — a floating spec resolves to an untested latest and reinstates the native-binary failure window. To upgrade: bump the version there, cold-verify the install chain (clean `~/.pi-studio/npm` + npm cache, install via the bundled runtime node), then release — existing installs migrate automatically because the seed compares spec strings and the SDK's `addSourceToSettings()` replaces the settings entry by package-name match key.
- **better-sqlite3 is pinned to 12.9.0 via npm overrides** (`BUILTIN_NPM_OVERRIDES` merged into `~/.pi-studio/npm/package.json` by `ensureNpmProjectDir()`): better-sqlite3 >= 12.10 dropped Node 20 (ABI 115) Windows prebuilds, and legacy installs (pi-studio <= 1.0.9) ran npm under a PATH-resolved Node 20 — exactly the "pi-hermes-memory 安装失败" report. 12.9.0 is the last release with BOTH ABI 115 and 127 win32 prebuilds on npmmirror, so installs succeed regardless of which Node runs npm. The merge is idempotent and merges into an existing package.json (the file outlives app upgrades).
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- **SDK npm invocations must go through the bundled runtime npm** (`ensureSdkNpmCommand()` in `lib/builtin-extensions.ts`, called from the boot seed inside the lock and from `/api/plugins` POST): with `npmCommand` unset the SDK resolves a bare `npm` from the server's PATH — the runtime dir is NOT on it — so machines without Node fail with ENOENT and mainland users hit registry.npmjs.org (the usual "pi-hermes-memory 安装失败"). It sets `npmCommand = [<runtime>/node(.exe), <runtime>/npm/bin/npm-cli.js, --registry=npmmirror]` (args are prepended to every SDK npm call, incl. `npm view` update checks; layout resolution via `resolveBuiltinNpmRunner()` covers win `node.exe` and mac `bin/node`). Never clobbers a user-configured `npmCommand`; refreshes its own value every boot (install dir moves between installs); dev (no runtime next to `process.execPath`) clears a stale value it set earlier. `desktop/runtime/node-runtime` stays a per-build download (git-ignored): mac installers are built on macOS anyway, and co-storing both platforms' binaries would ship both in every installer (extraResources copies the whole dir).
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.pi-studio/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent cline`; project installs run with the selected cwd. The skills CLI hardcodes `--agent pi` to `~/.pi/agent/skills` (the pi CLI's isolated dir), while its `cline` agent id maps to `~/.pi-studio/skills` (global) and `cwd/.pi-studio/skills` (project) — exactly pi-studio's skill roots. Never switch back to `--agent pi`.

### Auth and model config
- `ModelsConfig` combines models from `~/.pi-studio/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

### First-run dependency installation (installer ships without node_modules)
**node_modules lives in `~/.pi-studio/app-runtime/`, NOT the install dir** (`sharedRuntimeRoot()` in `desktop/main.js`): the bundled pi-web gets a directory link `pi-web/node_modules → ~/.pi-studio/app-runtime/node_modules` — a `junction` on Windows (no admin rights), a plain symlink on macOS (fine while the app is unsigned; **a link inside the .app bundle would break code signing/notarization when that ever happens**). Linux **AppImage is a read-only squashfs mount**, so neither this link nor the original first-run `npm install` into the install dir can work there — AppImage support would need the whole runtime layout moved user-side (pre-existing limitation, not a regression). NSIS updates wipe the install dir (old-uninstaller pass) but `RMDir /r` removes the junction without following it, so the ~1GB dependency tree survives updates — relaunch just recreates the link and boots (updates went from ~4 min to ~1 min). Guards: `.lock-fingerprint` (sha1 of `package-lock.json`) triggers a reinstall only when a new app version changes deps; legacy real-`node_modules` installs migrate via `rename` on first launch. `first-run-install.mjs` runs npm against the shared dir (always writable — also kills the old "install dir not writable" failure). `missingDependencies()` is the completeness check (deps present + npm's `.package-lock.json` marker).
`electron-builder.yml` does NOT ship `node_modules` (it accounted for most of the installer size and made NSIS extraction slow). Packaged launches install production deps on first run:
- `desktop/main.js` `ensureDependencies()` (called from `boot()`, packaged only) checks every `package.json` dependency + `.package-lock.json` marker under `getAppRoot()`; if missing it spawns `desktop/scripts/first-run-install.mjs` with the bundled node from `node-runtime`.
- The script runs `npm install --omit=dev --no-audit --no-fund --loglevel=http` (bundled npm at `<runtime>/npm/bin/npm-cli.js`, so no system Node/npm needed; dev fallback uses PATH npm). Registry defaults to npmmirror, overridable via `PI_NPM_REGISTRY`.
- The **download phase is an indeterminate bar** (progress events carry `percent: null`): the lock file lists every platform's optional deps, so a pretend percentage would mislead. The label shows live tarball counts; a rolling npm log panel shows real output.
- Progress events (`stage`/`progress`/`log`/`error`/`done`, one JSON per stdout line) are rendered on `desktop/loading.html` via `setLoadingStatus`/`setLoadingProgress`/`setLoadingLog`. Failure shows a Retry/Quit dialog; `before-quit` kills the install child (taskkill /T on win).
- **postinstall needs `patch-package` as a runtime dep**: `--omit=dev` skips devDependencies, so patch-package is listed under `dependencies` (not dev) or the `.pi → .pi-studio` SDK patch never applies. `patches/`, `scripts/` and `package-lock.json` are shipped to `pi-web/` via extraResources for exactly this reason.

**Ghost-package audit (`unhealthyPackages()` in `desktop/main.js`)**: a package dir can exist with a fresh `package.json` but gutted contents (1.0.6 shipped with `typebox/` reporting 1.3.7 while `build/index.mjs` was missing — `/api/models` 500'd because pi-ai is a `serverExternalPackage` loaded straight from `app-runtime/node_modules` at runtime). npm never self-heals that and the top-level `missingDependencies()` check can't see transitive deps, so every boot audits each lockfile entry that is on disk (version must match the lock, and an entry point — with Node extensionless resolution — must exist). Broken dirs are deleted before the install runs so npm re-fetches exactly those; entry matching must go through `packageEntryExists()` (plain `existsSync` false-positives on `main: "./lib/index"` style entries).
- Installed `node_modules` persists under the install dir, so later launches skip install; npm cache (`~/.npm`) makes upgrades near-instant. Installing into Program Files (non-writable) produces a clear permission error message.

### Online updater (`desktop/updater.js`)
Pure HTTP update mechanism — no `electron-updater` dependency. Reads current version from `app.getVersion()`, fetches `latest.json` from cloud storage (OSS/COS), compares semver-like version strings (simple split + numeric compare, no external semver library). Installers download into the **persistent** `~/.pi-studio/updates/` dir (`.part` file renamed on completion) — when `checkForUpdates()` finds an installer for the manifest version already cached there, it goes straight to `downloaded` so an interrupted install never re-downloads (no size check: the file only exists via rename of a completed download, so existence implies completeness — and hand-written manifests don't need per-platform sizes). Install is per-platform (`applyUpdate()`): **win32** returns the installer path and the install IPC handler spawns the installer **without `/S`** — the assisted NSIS wizard itself is the update UI. There is no dedicated updater exe any more (the C# `pi-studio-updater.exe` was removed): on update the wizard auto-skips the install-mode and directory pages (`skipPageIfUpdated` + existing per-user install detection in electron-builder's assistedInstaller.nsh / multiUserUi.nsh templates), so the user sees native progress → finish page with "运行 pi-studio" pre-checked (`MUI_FINISHPAGE_RUN`, launches the new build with `--updated`) — no external watcher process is needed because the installer runs from `~/.pi-studio/updates/` (outside the install dir, no self-lock) and relaunches the app itself. `customCheckAppRunning` (`desktop/build/installer.nsh`) silently force-closes every process running from `$INSTDIR` (app leftovers + node server) in both wizard and silent modes. NSIS templates are patched by `scripts/patch-app-builder-nsis.mjs`: (1) MessageBoxes missing `/SD` auto-answer in silent mode; (2) **the old-uninstaller pass is disabled** — early `Return` in `uninstallOldVersion`/`handleUninstallResult` (after the stack-balancing `Exch`, or NSIS warns at build time) makes every update a pure extract-overwrite: no INSTDIR rename, no `old-uninstaller.exe`, exit code 2 structurally impossible; (3) the extract-retry dialog becomes a patient bounded retry (AV real-time scanning locks freshly written files for seconds). The patch runs BOTH on `postinstall` AND as a gate inside `desktop:dist` (immediately before `electron-builder`): the postinstall hook alone let v1.0.11 ship from a machine whose node_modules predated the patch commit — old-uninstaller resurrected, AV blocked the dir rename, updates died in an exit-2 retry loop. The build-time gate (idempotent, exits 1 on pattern mismatch → build aborts) makes that unshippable. Corollary: never "fix" a broken installer by re-uploading the same version — clients cache installers by version (OSS + `~/.pi-studio/updates/`) and skip the download; always bump `package.json` version. **linux** atomically replaces the running AppImage (`$APPIMAGE`, tmp+rename keeps the old inode for the running process) and the handler `app.relaunch()`es. **darwin** mounts the dmg (`hdiutil attach`) and `ditto`s the .app over the current install, falling back to `shell.openPath(dmg)` (manual drag-install) on failure; the handler `app.relaunch()`es there too. On win32 the handler `app.exit(0)`s right after the detached spawn (cwd `%TEMP%` so no inherited handle pins the install dir); on linux/mac it `stopServer()`s then exits and lets `app.relaunch()` bring the new build up.

- **State machine**: `idle → checking → available → downloading → downloaded → installing`, with `upToDate` and `error` terminal states. State tracked in a plain object; `getState()` returns a shallow-copied snapshot.
- **IPC bridge**: 4 handlers in `desktop/main.js` (`pi-desktop:update-check`/`-download`/`-install`/`-state`). Download progress pushed via `event.sender.send("pi-desktop:update-progress", data)`.
- **preload.js**: exposes `checkForUpdates()`/`downloadUpdate()`/`installUpdate()`/`updateState()` + `onUpdateProgress(callback)` on `window.piDesktop`. The progress listener uses a named function reference + `removeListener` for cleanup (not `removeAllListeners`).
- **Configuration**: base URL defaults to the built-in production source (`https://ibi-global-test.oss-cn-beijing.aliyuncs.com/ibi-agent`) — users never need to configure anything. Overrides, in precedence order: `PI_UPDATE_BASE_URL` env var > `~/.pi-studio/update-config.json` (`{ "baseUrl": ..., "force": true }`, re-read on every check so edits apply without restart) > default. `baseUrl` may be an HTTP origin or a **local directory** — for a directory the manifest is read from disk and the installer is file-copied, so update flows can be tested against `dist-desktop/` with no web server. `"force": true` (or `PI_UPDATE_FORCE=1`) skips the version comparison so a manifest whose version equals the installed build still triggers the full flow — without it a freshly installed build always reports "up-to-date".
- **Background check**: `initUpdater()` schedules a 30-second delayed silent check on startup; failures are silently swallowed.
- **UI**: `UpdatesConfig.tsx` renders in Settings → 软件更新 (embedded mode), subscribed to real-time progress via `onUpdateProgress`.
- **Manifest helper**: `scripts/gen-update-manifest.mjs` generates a `latest.json` template from `package.json` version. User fills in actual URLs/sizes and uploads to cloud storage alongside the installer.
- **`Window.piDesktop` type**: declared in `SessionSidebar.tsx` (canonical location); includes updater methods. `UpdatesConfig.tsx` relies on this shared declaration — don't add a separate `declare global` block there.

### Dead-code removal must trace both directions
When deleting a feature or cleaning dead code, never grep by a single namespace alone. After removing a server endpoint / exported symbol / public API, **reverse-trace every caller**: grep the removed URL, path, or export name across the whole repo — including extension/seed sources and hardcoded string literals, not just matching import names. The browser-control bridge was removed across two commits (`325eb1a` deleted `app/api/browser/control/route.ts` + `lib/browser-control.ts` + `hooks/useBrowserControlBridge.ts`; `62824f6` later deleted `resources/builtin-extensions/browser-automation/index.ts` + `lib/builtin-browser-extension.ts`) because the agent-side `browser_navigate` tool hardcoded the deleted endpoint as `http://127.0.0.1:30141/api/browser/control` under a different namespace (`browser-automation` vs `browser-control`) that the first pass never surfaced. Rule: when you delete an endpoint, delete its consumers in the same cleanup pass.

## Pi Session File Format

Location: `~/.pi-studio/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`
(resolved from `$PI_CODING_AGENT_DIR`, default `~/.pi-studio`; isolated from the pi CLI's `~/.pi/agent`)

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
