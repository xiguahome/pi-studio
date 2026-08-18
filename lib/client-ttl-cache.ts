export interface ClientTtlCache<T> {
  get(key: string): T | undefined;
  set(key: string, data: T): void;
  delete(key: string): void;
}

/**
 * Minimal in-memory TTL cache for client-side API responses (git status, file
 * listings, worktrees). Entries expire after `ttlMs`; expired entries are
 * lazily evicted on read.
 */
export function createClientTtlCache<T>(ttlMs: number): ClientTtlCache<T> {
  const map = new Map<string, { data: T; expiresAt: number }>();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        map.delete(key);
        return undefined;
      }
      return entry.data;
    },
    set(key, data) {
      map.set(key, { data, expiresAt: Date.now() + ttlMs });
    },
    delete(key) {
      map.delete(key);
    },
  };
}
