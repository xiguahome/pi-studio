import type { ModelsData } from "./models-cache";

const MODELS_CLIENT_TTL_MS = 60_000;

let entry: { data: ModelsData; expiresAt: number } | null = null;

export function getClientModels(): ModelsData | undefined {
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entry = null;
    return undefined;
  }
  return entry.data;
}

export function setClientModels(data: ModelsData): void {
  entry = { data, expiresAt: Date.now() + MODELS_CLIENT_TTL_MS };
}

export function invalidateClientModels(): void {
  entry = null;
}
