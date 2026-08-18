"use client";

import React, { useEffect, useRef, useState } from "react";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";
import { useI18n } from "@/hooks/useI18n";

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

// Same thresholds as the top-bar context indicator in AppShell.
function usageColor(percent: number | null): string {
  if (percent === null) return "var(--text-dim)";
  if (percent > 90) return "#ef4444";
  if (percent > 70) return "rgba(234,179,8,0.95)";
  return "var(--accent)";
}

const RING_SIZE = 16;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const SHOW_DELAY_MS = 150;
const HIDE_DELAY_MS = 120;

interface Props {
  contextUsage: ContextUsage | null;
  sessionStats?: Pick<SessionStatsInfo, "tokens"> | null;
}

export function ContextProgressRing({ contextUsage, sessionStats }: Props) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
  }, []);

  if (!contextUsage || !contextUsage.contextWindow) return null;

  const percent = contextUsage.percent;
  const clamped = percent !== null ? Math.max(0, Math.min(100, percent)) : 0;
  const color = usageColor(percent);
  const windowTokens = contextUsage.contextWindow;

  const tokens = sessionStats?.tokens;
  // Cache hit rate over the input side: cacheRead / (input + cacheRead + cacheWrite).
  // Same denominator used for prompt-cache cost accounting; hidden when no input
  // tokens have been recorded yet.
  const inputSideTokens = tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : 0;
  const cacheHitRate = tokens && inputSideTokens > 0 ? (tokens.cacheRead / inputSideTokens) * 100 : null;
  const detailRows: Array<{ label: string; value: number; strong?: boolean }> = [];
  if (tokens && tokens.total > 0) {
    detailRows.push(
      { label: t("session.input"), value: tokens.input },
      { label: t("session.output"), value: tokens.output },
      { label: t("session.cacheRead"), value: tokens.cacheRead },
    );
    if (tokens.cacheWrite > 0) detailRows.push({ label: t("session.cacheWrite"), value: tokens.cacheWrite });
    detailRows.push({ label: t("session.total"), value: tokens.total, strong: true });
  }

  const openDelayed = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (open || showTimer.current !== null) return;
    showTimer.current = window.setTimeout(() => {
      showTimer.current = null;
      setOpen(true);
    }, SHOW_DELAY_MS);
  };

  const closeDelayed = () => {
    if (showTimer.current !== null) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    if (!open) return;
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setOpen(false);
    }, HIDE_DELAY_MS);
  };

  return (
    <div
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={openDelayed}
      onMouseLeave={closeDelayed}
    >
      <div
        style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "4px 6px",
          color: "var(--text-muted)",
          cursor: "default",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
          <circle
            cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS}
            fill="none" stroke="var(--border)" strokeWidth={RING_STROKE}
          />
          {percent !== null && (
            <circle
              cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS}
              fill="none" stroke={color} strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - clamped / 100)}
              transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
              style={{ transition: "stroke-dashoffset 0.25s, stroke 0.25s" }}
            />
          )}
        </svg>
        <span style={{ fontSize: 11, color, lineHeight: 1 }}>
          {percent !== null ? `${Math.round(percent)}%` : "—"}
        </span>
      </div>

      {open && (
        <div
          className="ctx-ring-pop"
          role="tooltip"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            right: 0,
            zIndex: 400,
            width: 236,
            boxSizing: "border-box",
            padding: "10px 12px 8px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 -4px 16px rgba(0,0,0,0.12)",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
            {t("chat.contextUsage")}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 18, fontWeight: 600, color, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
              {percent !== null ? `${percent.toFixed(1)}%` : "—"}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
              {t("chat.contextUsed", {
                used: contextUsage.tokens !== null ? formatTokenCount(contextUsage.tokens) : "?",
                total: formatTokenCount(windowTokens),
              })}
            </span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: "var(--bg-hover)", overflow: "hidden", marginBottom: 10 }}>
            <div style={{ height: "100%", width: `${clamped}%`, background: color, borderRadius: 2, transition: "width 0.25s, background 0.25s" }} />
          </div>
          {cacheHitRate !== null && (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginBottom: detailRows.length > 0 ? 8 : 0 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                <span>{t("chat.cacheHitRate")}</span>
                <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text)", fontWeight: 600 }}>
                  {cacheHitRate.toFixed(1)}%
                </span>
              </div>
              <div style={{ height: 4, borderRadius: 2, background: "var(--bg-hover)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.max(0, Math.min(100, cacheHitRate))}%`, background: "var(--accent)", borderRadius: 2, transition: "width 0.25s" }} />
              </div>
            </div>
          )}
          {detailRows.length > 0 && (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <div style={{
                fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4,
              }}>
                {t("chat.sessionTokenTotals")}
              </div>
              {detailRows.map((row) => (
                <div
                  key={row.label}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    fontSize: 11, padding: "2px 0",
                    color: row.strong ? "var(--text)" : "var(--text-muted)",
                    fontWeight: row.strong ? 600 : 400,
                  }}
                >
                  <span>{row.label}</span>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 8, fontVariantNumeric: "tabular-nums" }}>
                    <span style={{ minWidth: 64, textAlign: "right", color: row.strong ? "var(--text)" : "var(--text)" }}>
                      {row.value.toLocaleString(locale)}
                    </span>
                    <span style={{ minWidth: 46, textAlign: "right", color: "var(--text-dim)" }}>
                      {(row.value / windowTokens * 100).toFixed(1)}%
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
