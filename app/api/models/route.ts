import { homedir } from "os";
import { getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { loadModelsWithCache, withModelRuntimeError, type ModelsData } from "@/lib/models-cache";
import { getOrCreateAgentSessionServices } from "@/lib/rpc-manager";
import { resolveVisibleModels, selectInitialModelScope } from "@/lib/model-scope";
import { projectTrustReloadOptions } from "@/lib/project-trust";

export const dynamic = "force-dynamic";

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string },
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

// The model list is deliberately cwd-independent: services are built once
// against the home directory, so global `~/.pi-studio/settings.json` applies
// (enabledModels, default model, thinking pins) and switching projects never
// rebuilds services or blanks the selector. Session creation
// (`startRpcSession`) still resolves the per-project scope atomically.
async function loadModels(): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  const cwd = homedir();
  const agentDir = getAgentDir();
  // Even against the home directory, keep the trust gate so a stray
  // ~/.pi-studio/extensions factory never runs from an untrusted context (#236).
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  // Share the per-cwd services build with startRpcSession() — building it here
  // from scratch was the main cause of the 13-15s server freeze on cross-project
  // session switches (jiti re-transpiles every extension when the cwd changes).
  const services = await getOrCreateAgentSessionServices(cwd, trustReloadOptions);
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManager = services.settingsManager;
  // `enabledModels` supports globs and fuzzy patterns, so resolve it the same
  // way the CLI does instead of comparing pattern strings literally (#307).
  const scope = await resolveVisibleModels(
    services.modelRuntime,
    settings.getEnabledModels(),
  );
  const { visible, thinkingLevelPins, warnings } = scope;
  modelList = visible.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    contextWindow: m.contextWindow,
  })).sort(compareModelEntries);
  for (const m of visible) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = getSupportedThinkingLevels(m);
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
  }

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const initial = selectInitialModelScope(scope, {
    ...(defaultProvider && defaultModelId
      ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
      : {}),
  });
  if (initial.model) {
    defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
  }

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins,
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
    },
    modelError,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

export async function GET() {
  try {
    return Response.json(await loadModelsWithCache(() => loadModels()));
  } catch {
    // Surface the failure instead of a silent empty list — an empty list gets
    // cached client-side and the model selector stays hidden for the TTL.
    return Response.json({ ...EMPTY_MODELS, modelError: "Failed to load models" });
  }
}
