"use client";

import { useCallback, useEffect, useState } from "react";

interface PutResult {
  builtin: boolean;
  needsRestart?: boolean;
  patchError?: string;
}

/**
 * Built-in vs external browser toggle (see lib/browser-config.ts). GET
 * /api/browser-mode reads the shared file; PUT writes it, rewrites the
 * chrome-devtools endpoint, and re-runs the plugin patch. A toggle only takes
 * effect after restarting pi-studio, so setBuiltin returns needsRestart: true.
 *
 * `builtin` defaults to true (the existing behavior) until the initial GET
 * resolves, so the UI does not flash the external-mode state on mount.
 */
export function useBrowserMode() {
  const [builtin, setBuiltinState] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/browser-mode")
      .then((r) => r.json())
      .then((data: { builtin?: unknown }) => {
        if (cancelled) return;
        if (typeof data.builtin === "boolean") setBuiltinState(data.builtin);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setBuiltin = useCallback(async (next: boolean): Promise<PutResult> => {
    setSaving(true);
    try {
      const res = await fetch("/api/browser-mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ builtin: next }),
      });
      const data = (await res.json()) as PutResult & { error?: string };
      if (typeof data.builtin === "boolean") setBuiltinState(data.builtin);
      return data;
    } finally {
      setSaving(false);
    }
  }, []);

  return { builtin, loaded, saving, setBuiltin };
}
