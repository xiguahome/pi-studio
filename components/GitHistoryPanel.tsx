"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { GitLogEntry, GitLogResponse } from "@/lib/git-types";
import { GitCommitDialog } from "./GitCommitDialog";

interface Props {
  cwd: string;
}

interface ParsedRef {
  kind: "head" | "tag" | "branch";
  name: string;
}

function parseRefs(refs: string): ParsedRef[] {
  if (!refs) return [];
  return refs.split(", ").filter(Boolean).map((raw) => {
    const tag = raw.match(/^tag: (.+)$/);
    if (tag) return { kind: "tag", name: tag[1] };
    const head = raw.match(/^HEAD -> (.+)$/);
    if (head) return { kind: "head", name: head[1] };
    return { kind: "branch", name: raw };
  });
}

function relativeTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const seconds = Math.round(abs / 1000);
  if (seconds < 60) return rtf.format(-seconds, "second");
  const minutes = Math.round(abs / 60_000);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(abs / 3_600_000);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.round(abs / 86_400_000);
  if (days < 7) return rtf.format(-days, "day");
  const weeks = Math.round(abs / 604_800_000);
  if (weeks < 5) return rtf.format(-weeks, "week");
  const months = Math.round(abs / 2_592_000_000);
  if (months < 12) return rtf.format(-months, "month");
  const years = Math.round(abs / 31_536_000_000);
  return rtf.format(-years, "year");
}

function RefBadges({ refs }: { refs: string }) {
  const parsed = parseRefs(refs);
  if (parsed.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
      {parsed.map((ref) => (
        <span
          key={`${ref.kind}:${ref.name}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            padding: "0 6px",
            height: 16,
            borderRadius: 4,
            fontSize: 10,
            lineHeight: 1,
            whiteSpace: "nowrap",
            background: ref.kind === "head" ? "var(--accent)" : "var(--bg-selected)",
            color: ref.kind === "head" ? "#fff" : "var(--text-muted)",
            border: `1px solid ${ref.kind === "tag" ? "var(--accent)" : "var(--border)"}`,
          }}
        >
          {ref.kind === "tag" && <span style={{ opacity: 0.7 }}>tag</span>}
          {ref.name}
        </span>
      ))}
    </span>
  );
}

export function GitHistoryPanel({ cwd }: Props) {
  const { locale, t } = useI18n();
  const [commits, setCommits] = useState<GitLogEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [notRepository, setNotRepository] = useState(false);
  const [error, setError] = useState(false);
  const [dialogHash, setDialogHash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    setNotRepository(false);
    try {
      const res = await fetch(`/api/git/log?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) throw new Error(String(res.status));
      const data: GitLogResponse = await res.json();
      setNotRepository(!data.isGitRepository);
      setCommits(data.commits);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)" }}>
      {/* Panel header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("git.history")}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          title={t("git.refresh")}
          aria-label={t("git.refresh")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            border: "none",
            borderRadius: 4,
            background: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            flexShrink: 0,
            padding: 0,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>{t("git.loading")}</div>
        ) : error ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>{t("git.error")}</div>
        ) : notRepository ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>{t("git.notRepository")}</div>
        ) : !commits || commits.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>{t("git.empty")}</div>
        ) : (
          <div>
            {commits.map((commit) => (
              <button
                key={commit.hash}
                type="button"
                onClick={() => setDialogHash(commit.hash)}
                title={commit.subject}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 16px",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  background: "none",
                  cursor: "pointer",
                  color: "var(--text)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", flexShrink: 0 }}>
                    {commit.shortHash}
                  </span>
                  <RefBadges refs={commit.refs} />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 12,
                    }}
                  >
                    {commit.subject || "\u00a0"}
                  </span>
                </div>
                <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 8 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "55%" }}>{commit.authorName}</span>
                  <span style={{ color: "var(--text-dim)", flexShrink: 0 }} title={new Date(commit.date).toLocaleString(locale)}>
                    {relativeTime(commit.date, locale)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Commit detail dialog */}
      {dialogHash && (
        <GitCommitDialog
          key={dialogHash}
          cwd={cwd}
          hash={dialogHash}
          onClose={() => setDialogHash(null)}
        />
      )}
    </div>
  );
}
