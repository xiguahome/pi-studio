"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ModelsData } from "@/lib/models-cache";
import { getClientModels, invalidateClientModels, setClientModels } from "@/lib/models-client-cache";

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
}

export interface ModelsContextValue {
  modelNames: Record<string, string>;
  modelList: ModelEntry[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevelPins: Record<string, string>;
  modelError: string | null;
  modelScopeWarnings: string[];
  modelThinkingLevels: Record<string, string[]>;
  modelThinkingLevelMaps: Record<string, Record<string, string | null>>;
  modelsLoading: boolean;
  refreshModels: () => void;
}

const ModelsContext = createContext<ModelsContextValue | null>(null);

export function useModelsContext(): ModelsContextValue {
  const ctx = useContext(ModelsContext);
  if (!ctx) {
    return {
      modelNames: {},
      modelList: [],
      defaultModel: null,
      thinkingLevelPins: {},
      modelError: null,
      modelScopeWarnings: [],
      modelThinkingLevels: {},
      modelThinkingLevelMaps: {},
      modelsLoading: false,
      refreshModels: () => {},
    };
  }
  return ctx;
}

interface ModelsProviderProps {
  modelsRefreshKey: number;
  onRefresh: () => void;
  children: ReactNode;
}

// The model list is global (cwd-independent): fetched once on mount and kept
// alive across project/session switches, so the selector never blanks while a
// per-cwd services build would have been running.
export function ModelsProvider({ modelsRefreshKey, onRefresh, children }: ModelsProviderProps) {
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [defaultModel, setDefaultModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [thinkingLevelPins, setThinkingLevelPins] = useState<Record<string, string>>({});
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [modelsLoading, setModelsLoading] = useState(false);

  const lastRefreshKeyRef = useRef(modelsRefreshKey);

  const applyModels = useCallback((data: ModelsData) => {
    setModelNames(data.models);
    setModelList(data.modelList ?? []);
    setDefaultModel(data.defaultModel ?? null);
    setThinkingLevelPins(data.thinkingLevelPins ?? {});
    setModelError(data.modelError ?? null);
    setModelScopeWarnings(data.modelScopeWarnings ?? []);
    setModelThinkingLevels(data.thinkingLevels ?? {});
    setModelThinkingLevelMaps(data.thinkingLevelMaps ?? {});
  }, []);

  useEffect(() => {
    // A refresh key bump (e.g. after trusting a project) forces a re-fetch and
    // bypasses the client cache.
    const isRefresh = lastRefreshKeyRef.current !== modelsRefreshKey;
    lastRefreshKeyRef.current = modelsRefreshKey;
    const cached = isRefresh ? undefined : getClientModels();
    if (cached) {
      applyModels(cached);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    fetch("/api/models")
      .then(async (r) => ({ ok: r.ok, status: r.status, data: r.ok ? (await r.json()) as ModelsData : null }))
      .then(({ ok, status, data }) => {
        if (cancelled) return;
        if (!ok || !data) {
          // Transient failure (server restart, network hiccup): surface the
          // error but never cache it, so the next mount retries immediately
          // instead of showing a hidden selector for the cache TTL.
          setModelError(`Failed to load models (HTTP ${status})`);
          return;
        }
        setClientModels(data);
        applyModels(data);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load models:", e);
        setModelError("Failed to load models");
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modelsRefreshKey, applyModels]);

  const refreshModels = useCallback(() => {
    invalidateClientModels();
    onRefresh();
  }, [onRefresh]);

  return (
    <ModelsContext.Provider
      value={{
        modelNames,
        modelList,
        defaultModel,
        thinkingLevelPins,
        modelError,
        modelScopeWarnings,
        modelThinkingLevels,
        modelThinkingLevelMaps,
        modelsLoading,
        refreshModels,
      }}
    >
      {children}
    </ModelsContext.Provider>
  );
}
