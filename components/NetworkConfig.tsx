"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * Network settings panel (embedded in SettingsDialog): configures the HTTP
 * proxy used by skill install/update/search, update checks and built-in
 * extension installs. Stored server-side in ~/.pi-studio/proxy.json.
 */
export function NetworkConfig({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/network/proxy");
        const d = (await res.json()) as { url?: string | null; error?: string };
        if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setUrl(d.url ?? "");
          setSavedUrl(d.url ?? null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next: string) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/network/proxy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: next }),
      });
      const d = (await res.json()) as { success?: boolean; url?: string | null; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setSavedUrl(d.url ?? null);
      setUrl(d.url ?? "");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, []);

  const dirty = url.trim() !== (savedUrl ?? "");

  return (
    <div
      style={
        embedded
          ? { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", padding: 20, gap: 16 }
          : { display: "flex", flexDirection: "column", padding: 20, gap: 16 }
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
          {t("i18n.proxyTitle")}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
          {t("i18n.proxyDescription")}
        </span>
      </div>

      {loading ? (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("i18n.loading")}
        </span>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setSaved(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty && !saving) void save(url.trim());
            }}
            placeholder="http://127.0.0.1:7890"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 220,
              padding: "7px 10px",
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              outline: "none",
            }}
          />
          <button
            onClick={() => void save(url.trim())}
            disabled={saving || !dirty}
            style={{
              padding: "7px 16px",
              fontSize: 13,
              borderRadius: 6,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              cursor: saving || !dirty ? "not-allowed" : "pointer",
              opacity: saving || !dirty ? 0.5 : 1,
            }}
          >
            {saving ? t("i18n.saving") : t("i18n.save")}
          </button>
          {savedUrl && (
            <button
              onClick={() => void save("")}
              disabled={saving}
              style={{
                padding: "7px 14px",
                fontSize: 13,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "none",
                color: "var(--text-muted)",
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              {t("i18n.proxyClear")}
            </button>
          )}
        </div>
      )}

      {error && (
        <span style={{ fontSize: 12, color: "#f87171", overflowWrap: "anywhere" }}>
          {error}
        </span>
      )}
      {saved && !error && (
        <span style={{ fontSize: 12, color: "#16a34a" }}>
          {savedUrl ? t("i18n.proxySaved") : t("i18n.proxyCleared")}
        </span>
      )}
    </div>
  );
}
