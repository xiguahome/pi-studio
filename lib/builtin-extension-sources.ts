// Pure constant module — deliberately free of any imports. Client components
// (SeedProgressOverlay) render this list, and importing it must not drag the
// server-only pi SDK / node builtins into the browser bundle. Keep this file
// free of imports; the seed logic lives in lib/builtin-extensions.ts.
//
// Versions are PINNED to exact releases (never bare `npm:<name>`):
//  - A floating spec resolves to whatever upstream published minutes ago —
//    untested by us, and native deps (better-sqlite3) may lack prebuilt
//    binaries on npmmirror for a while after release, which reinstates the
//    github.com fallback / node-gyp path this app cannot ship.
//  - Pinned specs make scripts/patch-pi-*.mjs (text-matching upstream source)
//    deterministic — a floating bump silently degrades patches to WARNs.
//  - The SDK treats `npm:<name>@<exact>` as pinned: plugin-panel "update"
//    reinstalls the pinned spec itself and update checks report up-to-date,
//    so built-ins only change when pi-studio ships.
// To upgrade a built-in: bump the version here, verify the full install chain
// (clean ~/.pi-studio/npm + npm cache, cold install via the bundled runtime
// node), then release. Existing installs migrate automatically: the seed
// compares spec strings, reinstalls, and addSourceToSettings() replaces the
// settings entry in place (match key is package name only).

/** npm sources that pi-studio treats as non-removable built-in capabilities. */
export const BUILTIN_EXTENSION_SOURCES = [
  "npm:pi-mcp-adapter@2.26.0",
  "npm:pi-subagents@0.50.0",
  // Native dep better-sqlite3 is additionally pinned via BUILTIN_NPM_OVERRIDES
  // (lib/builtin-extensions.ts) — see the comment there for why 12.9.0.
  "npm:pi-hermes-memory@0.9.6",
  "npm:@tintinweb/pi-tasks@0.8.0",
  // Codex-like read-only /plan collaboration mode (requires Pi >= 0.80.6;
  // project runs 0.84.0). Pure-source extension, no .pi/cwd patching needed.
  "npm:@narumitw/pi-plan-mode@0.49.3",
  // Autonomous /goal mode: agent loops until goal_complete/goal_blocked.
  // Complementary to /plan (plan -> goal = design -> execute).
  "npm:@narumitw/pi-goal@0.51.0",
  // Provides the ask_user_question tool so grill-me (and any skill that needs
  // structured questions) works out of the box — pi-studio renders its card.
  "npm:@juicesharp/rpiv-ask-user-question@2.6.0",
  // Chrome DevTools Protocol tools driving pi-studio's built-in <webview>
  // browser (CDP :9333). Requires scripts/patch-pi-chrome-devtools.mjs after
  // install (listPages must only see type "webview", never the main window) —
  // see the seed-time + /api/plugins patch hook in lib/builtin-extensions.ts.
  "npm:@narumitw/pi-chrome-devtools@0.52.0",
] as const;

/**
 * Strip the `@<version>` suffix from an `npm:` source spec, keeping scoped
 * package names intact (`npm:@scope/pkg@1.0.0` → `npm:@scope/pkg`).
 * Mirrors the SDK's parseNpmSpec name extraction. Callers compare sources
 * across generations (legacy settings entries carry no version).
 */
export function npmSourceName(source: string): string {
  const spec = source.replace(/^npm:/, "");
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  return `npm:${match?.[1] ?? spec}`;
}
