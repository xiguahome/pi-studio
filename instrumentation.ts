export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Sync the stored network proxy (~/.pi-studio/proxy.json) into process.env so
  // every spawned child (SDK npm/git installs, npx skills CLI) inherits it.
  const { applyProxyToProcessEnv } = await import("@/lib/proxy-config");
  applyProxyToProcessEnv();

  // Seed built-in extensions (pi-mcp-adapter, pi-subagents) into ~/.pi-studio on
  // boot, so MCP + subagent support is available out of the box. Fire-and-
  // forget: a slow or failing npm install must never block the server from
  // accepting requests. Progress is persisted to ~/.pi-studio/.builtin-seed.json
  // and surfaced on the Plugins page.
  void import("@/lib/builtin-extensions").then(({ ensureBuiltinExtensions }) =>
    ensureBuiltinExtensions().catch((error) => {
      console.error("[pi-studio] built-in extension seed failed:", error);
    }),
  );

  // Seed bundled skills (resources/builtin-skills) into ~/.pi-studio/skills/builtin.
  // Pure file copy, no network, so it is safe to run on every boot.
  void import("@/lib/builtin-skills").then(({ ensureBuiltinSkills }) =>
    ensureBuiltinSkills().catch((error) => {
      console.error("[pi-studio] built-in skill seed failed:", error);
    }),
  );

  // Seed the default global AGENTS.md (~/.pi-studio/AGENTS.md) from the bundled
  // copy. Missing-only: once present (stock or user-edited) it is never touched.
  try {
    const { ensureBuiltinAgentsMd } = await import("@/lib/builtin-agents");
    ensureBuiltinAgentsMd();
  } catch (error) {
    console.error("[pi-studio] built-in AGENTS.md seed failed:", error);
  }

  // Seed ~/.pi-studio/pi-chrome-devtools.json so the chrome-devtools extension
  // attaches to pi-studio's built-in browser (CDP :9333) instead of its default
  // :9222. Missing-only: a user-created/customized file is never overwritten.
  try {
    const { ensureChromeDevtoolsConfig } = await import("@/lib/chrome-devtools-config");
    ensureChromeDevtoolsConfig();
  } catch (error) {
    console.error("[pi-studio] chrome-devtools config seed failed:", error);
  }

  // Seed ~/.pi-studio/hermes-memory-config.json so fresh installs default to a
  // low-frequency background memory review (50 turns / 100 tool calls) instead
  // of the chatty upstream 10/15. Missing-only: a user-created/customized file
  // is never overwritten.
  try {
    const { ensureHermesMemoryConfig } = await import("@/lib/builtin-hermes-memory-config");
    ensureHermesMemoryConfig();
  } catch (error) {
    console.error("[pi-studio] hermes-memory config seed failed:", error);
  }
}
