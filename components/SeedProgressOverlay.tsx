"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { BUILTIN_EXTENSION_SOURCES, npmSourceName } from "@/lib/builtin-extension-sources";
import type { BuiltinSeedStatus } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";

// First-run progress overlay. When pi-studio boots for the first time the
// server (instrumentation.ts) fire-and-forget installs the built-in npm
// extensions from npmmirror. That can take a few seconds (native packages like
// better-sqlite3 / @napi-rs/keyring), and the user otherwise has no idea why
// MCP / memory features are not ready. This overlay shows per-extension
// progress polled from /api/seed-status and dismisses itself once seeding
// finishes cleanly.
//
// Flash prevention: the very first poll decides whether to render at all. On a
// normal (non-first-run) boot seeding is already false by the time we poll, so
// we dismiss without ever painting — no flicker.

const POLL_INTERVAL_MS = 2000;
const TOTAL = BUILTIN_EXTENSION_SOURCES.length;

type ItemState = "ready" | "installing" | "failed" | "pending";
type T = ReturnType<typeof useI18n>["t"];

const STATE_COLOR: Record<ItemState, string> = {
  ready: "var(--accent)",
  installing: "var(--text-muted)",
  failed: "#ef4444",
  pending: "var(--text-dim)",
};

function itemState(index: number, status: BuiltinSeedStatus | null): ItemState {
  if (!status) return "pending";
  if (index < status.results.length) {
    return status.results[index].action === "failed" ? "failed" : "ready";
  }
  if (index === status.results.length && status.seeding) return "installing";
  return "pending";
}

function shortName(source: string): string {
  // Strip both the npm: prefix and the pinned @version — the overlay lists
  // package identities, not install specs.
  return npmSourceName(source).slice(4);
}

function stateLabelKey(state: ItemState): string {
  switch (state) {
    case "ready":
      return "plugin.seedStateReady";
    case "installing":
      return "plugin.seedStateInstalling";
    case "failed":
      return "plugin.seedStateFailed";
    default:
      return "plugin.seedStatePending";
  }
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1200,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  background: "rgba(0,0,0,0.4)",
};

const cardStyle: CSSProperties = {
  width: 440,
  maxWidth: "100%",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-panel)",
  boxShadow: "0 12px 36px rgba(0,0,0,0.24)",
  overflow: "hidden",
};

const footerStyle: CSSProperties = {
  padding: "10px 18px",
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};

const primaryBtnStyle: CSSProperties = {
  padding: "6px 14px",
  border: "1px solid var(--accent)",
  borderRadius: 6,
  background: "var(--accent)",
  color: "#fff",
  fontSize: 13,
  cursor: "pointer",
};

const linkBtnStyle: CSSProperties = {
  padding: "6px 10px",
  border: "none",
  background: "transparent",
  color: "var(--text-muted)",
  fontSize: 12,
  cursor: "pointer",
};

function SeedRow({ source, state, t }: { source: string; state: ItemState; t: T }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "6px 0",
        gap: 12,
      }}
    >
      <span
        style={{
          fontSize: 13,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {shortName(source)}
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          color: STATE_COLOR[state],
          flexShrink: 0,
        }}
      >
        {state === "installing" ? (
          <span
            style={{
              display: "inline-block",
              width: 12,
              height: 12,
              border: "2px solid var(--text-dim)",
              borderTopColor: "transparent",
              borderRadius: "50%",
              animation: "pi-seed-spin 0.6s linear infinite",
            }}
          />
        ) : state === "ready" ? (
          "✓"
        ) : state === "failed" ? (
          "✗"
        ) : (
          "•"
        )}
        {t(stateLabelKey(state))}
      </span>
    </div>
  );
}

export function SeedProgressOverlay({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<BuiltinSeedStatus | null>(null);

  // Keep the latest onDismiss without retriggering the poll effect.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  const poll = useCallback(async (signal: AbortSignal): Promise<BuiltinSeedStatus | null> => {
    const res = await fetch("/api/seed-status", { cache: "no-store", signal });
    if (!res.ok) return null;
    return (await res.json()) as BuiltinSeedStatus;
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let firstResolveDone = false;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    const tick = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const next = await poll(current.signal);
        if (stopped || controller !== current || !next) return;
        const failed = next.results.some((r) => r.action === "failed");
        // First poll decides whether to show at all: if seeding already
        // finished cleanly (the common non-first-run case), dismiss without
        // ever rendering — no flash.
        if (!firstResolveDone) {
          firstResolveDone = true;
          if (!next.seeding && !failed) {
            stopped = true;
            clearTimer();
            onDismissRef.current();
            return;
          }
          setReady(true);
        }
        setStatus(next);
        if (!next.seeding && !failed) {
          // Clean finish — auto-dismiss.
          stopped = true;
          clearTimer();
          onDismissRef.current();
          return;
        }
        if (!next.seeding && failed) {
          // Seeding ended with failures — keep the overlay open so the user
          // sees them, but stop polling (state won't change until restart).
          stopped = true;
          clearTimer();
          return;
        }
      } catch {
        // Keep last state; retry on the next tick.
      } finally {
        if (controller === current) controller = null;
      }
      if (!stopped) schedule();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void tick();
      } else {
        clearTimer();
        controller?.abort();
        controller = null;
      }
    };

    void tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poll]);

  // First poll not resolved yet → render nothing (flash prevention).
  if (!ready) return null;

  const failed = status?.results.some((r) => r.action === "failed") ?? false;
  const done = status?.results.filter((r) => r.action !== "failed").length ?? 0;
  const finished = status !== null && !status.seeding;

  return (
    <div role="presentation" style={overlayStyle}>
      <style>{`@keyframes pi-seed-spin { to { transform: rotate(360deg); } }`}</style>
      <div role="dialog" aria-modal="true" aria-label={t("plugin.seedOverlayTitle")} style={cardStyle}>
        <div style={{ padding: "18px 20px 14px" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>
            {t("plugin.seedOverlayTitle")}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
            {failed ? t("plugin.seedPartialFail") : t("plugin.seedOverlayDesc")}
          </div>
          {!finished && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
              {t("plugin.seedProgress", { done, total: TOTAL })}
            </div>
          )}
        </div>

        <div
          style={{
            borderTop: "1px solid var(--border)",
            borderBottom: failed ? "1px solid var(--border)" : undefined,
            padding: "8px 20px",
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          {BUILTIN_EXTENSION_SOURCES.map((source, index) => (
            <SeedRow key={source} source={source} state={itemState(index, status)} t={t} />
          ))}
        </div>

        <div style={footerStyle}>
          {failed ? (
            <button type="button" onClick={onDismiss} style={primaryBtnStyle}>
              {t("plugin.seedEnterApp")}
            </button>
          ) : (
            <button type="button" onClick={onDismiss} style={linkBtnStyle}>
              {t("plugin.seedSkip")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
