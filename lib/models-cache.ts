export interface ModelsData {
  models: Record<string, string>;
  modelList: { id: string; name: string; provider: string; contextWindow?: number }[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  /** `provider/modelId` → thinking level pinned by an `enabledModels` `:level` suffix. */
  thinkingLevelPins: Record<string, string>;
  modelError?: string;
  /** Warnings from resolving the `enabledModels` scope (e.g. a pattern matched nothing). */
  modelScopeWarnings?: string[];
}

interface ModelsCacheState {
  entry: { data: ModelsData; expiresAt: number } | null;
  inFlight: Promise<ModelsData> | null;
  generation: number;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;

function getModelsCacheState(): ModelsCacheState {
  const existing = globalThis.__piModelsCacheState;
  // globalThis survives hot reloads, so a state shaped by an older version of
  // this module (Map-keyed `entries`, Map `inFlight`) may still be there and
  // would poison the single-slot logic (a truthy Map `inFlight` is returned as
  // the load promise and serializes to `{}`). Validate the shape before reuse.
  if (
    !existing
    || typeof existing !== "object"
    || !("entry" in existing)
    || !("inFlight" in existing)
    || typeof existing.generation !== "number"
  ) {
    const state: ModelsCacheState = {
      entry: null,
      inFlight: null,
      generation: 0,
    };
    globalThis.__piModelsCacheState = state;
    return state;
  }
  return existing;
}

export function invalidateModelsCache(): void {
  const state = getModelsCacheState();
  state.generation += 1;
  state.entry = null;
  state.inFlight = null;
}

export function withModelRuntimeError(data: ModelsData, modelError: string | undefined): ModelsData {
  return modelError ? { ...data, modelError } : data;
}

// The list is global (cwd-independent), so a single cache slot is enough.
export function loadModelsWithCache(loader: () => Promise<ModelsData>): Promise<ModelsData> {
  const state = getModelsCacheState();
  if (state.entry) {
    if (state.entry.expiresAt > Date.now()) return Promise.resolve(state.entry.data);
    state.entry = null;
  }

  if (state.inFlight) return state.inFlight;

  const generation = state.generation;
  const loadPromise: Promise<ModelsData> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (state.generation === generation && state.inFlight === loadPromise) {
        state.entry = { data, expiresAt: Date.now() + MODELS_CACHE_TTL_MS };
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight === loadPromise) state.inFlight = null;
    });

  state.inFlight = loadPromise;
  return loadPromise;
}
