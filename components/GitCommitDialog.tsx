"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { parseUnifiedPatch, type SplitDiffCell, type SplitDiffFile } from "@/lib/patch";
import type { GitShowResponse } from "@/lib/git-types";
import { copyText } from "@/lib/clipboard";

interface Props {
  cwd: string;
  hash: string;
  onClose: () => void;
}

const LINE_NUMBER_STYLE: CSSProperties = {
  width: 40,
  minWidth: 40,
  padding: "0 8px",
  textAlign: "right",
  color: "var(--text-dim)",
  background: "var(--bg-panel)",
  borderRight: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
  lineHeight: "20.8px",
  userSelect: "none",
  flexShrink: 0,
};

const CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.6,
};

/** Lines longer than this (typically base64 blobs from binary/icon diffs)
 *  are truncated instead of stretching the side-by-side grid. */
const MAX_INLINE_LINE_LENGTH = 1500;

function SideCell({ cell }: { cell: SplitDiffCell }) {
  const isEmpty = cell.type === "empty";
  const isHuge = cell.text.length > MAX_INLINE_LINE_LENGTH;
  const bg = cell.type === "removed"
    ? "rgba(240,60,60,0.14)"
    : cell.type === "added"
    ? "rgba(0,200,80,0.12)"
    : "transparent";
  const border = cell.type === "removed"
    ? "3px solid #f87171"
    : cell.type === "added"
    ? "3px solid #4ade80"
    : "3px solid transparent";
  const prefix = cell.type === "removed" ? "-" : cell.type === "added" ? "+" : "";
  const prefixColor = cell.type === "removed" ? "#f87171" : cell.type === "added" ? "#4ade80" : "var(--text-dim)";

  return (
    <div style={{ display: "flex", minWidth: 0, background: bg, borderLeft: border }}>
      <span style={LINE_NUMBER_STYLE}>{isEmpty ? "" : (cell.lineNo ?? "")}</span>
      <span
        style={{
          minWidth: 15,
          padding: "0 5px",
          color: prefixColor,
          userSelect: "none",
          flexShrink: 0,
          fontWeight: 600,
        }}
      >
        {isEmpty ? "" : prefix}
      </span>
      <span
        title={isHuge ? cell.text.slice(0, 500) : undefined}
        style={{
          flexShrink: 0,
          paddingRight: 12,
          whiteSpace: "pre",
          color: "var(--text)",
          ...(isHuge
            ? { maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" as const }
            : {}),
        }}
      >
        {isEmpty ? "\u00a0" : (cell.text || "\u00a0")}
      </span>
    </div>
  );
}

function DiffFileSection({ file, additions, deletions, expanded, onToggle }: {
  file: SplitDiffFile;
  additions: number;
  deletions: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const name = file.newPath || file.oldPath || "";
  const isBinary = additions < 0 || deletions < 0;

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={onToggle}
        title={expanded ? "折叠" : "展开"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "6px 14px",
          background: expanded ? "var(--bg-selected)" : "var(--bg-panel)",
          border: "none",
          borderBottom: expanded ? "1px solid var(--border)" : "none",
          cursor: "pointer",
          textAlign: "left",
          fontSize: 12,
          color: "var(--text)",
        }}
      >
        <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0, width: 10 }}>{expanded ? "▾" : "▸"}</span>
        <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {name}
        </span>
        {isBinary ? (
          <span style={{ color: "var(--text-dim)", flexShrink: 0, fontSize: 11 }}>Bin</span>
        ) : (
          <span style={{ flexShrink: 0, fontSize: 11, fontFamily: "var(--font-mono)" }}>
            <span style={{ color: "#4ade80" }}>+{additions}</span>
            <span style={{ color: "var(--text-dim)" }}> / </span>
            <span style={{ color: "#f87171" }}>-{deletions}</span>
          </span>
        )}
      </button>
      <div
        style={{
          overflowX: "auto",
          overflowY: expanded ? "auto" : "hidden",
          maxHeight: expanded ? 420 : 0,
          transition: "max-height 0.18s ease",
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", minWidth: "100%", ...CODE_STYLE }}>
          {file.rows.map((row, i) =>
            row.type === "hunk" ? (
              <div
                key={i}
                style={{
                  gridColumn: "1 / -1",
                  padding: "1px 12px",
                  color: "var(--text-dim)",
                  background: "var(--bg-panel)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  borderTop: "1px solid var(--border)",
                  borderBottom: "1px solid var(--border)",
                  whiteSpace: "pre",
                }}
              >
                {row.text}
              </div>
            ) : (
              <div key={i} style={{ display: "contents" }}>
                <SideCell cell={row.left} />
                <SideCell cell={row.right} />
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

export function GitCommitDialog({ cwd, hash, onClose }: Props) {
  const { locale, t } = useI18n();
  const isMobile = useIsMobile();
  const [data, setData] = useState<GitShowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  // Accordion: only one file section is expanded at a time (null = all collapsed).
  const [expandedFile, setExpandedFile] = useState<number | null>(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setData(null);
    void (async () => {
      try {
        const res = await fetch(`/api/git/show?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}`);
        if (!res.ok) throw new Error(String(res.status));
        const json: GitShowResponse = await res.json();
        if (!json.supported) throw new Error("unsupported");
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, hash]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const date = data?.date ? new Date(data.date) : null;
  const dateText = date && !Number.isNaN(date.getTime())
    ? date.toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : data?.date ?? "";
  const files = data?.patch ? parseUnifiedPatch(data.patch) : null;
  const stats = data?.stats ?? [];

  const handleCopy = async () => {
    if (!data?.hash) return;
    await copyText(data.hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 12,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: isMobile ? "100%" : "94vw",
          maxWidth: 1400,
          height: isMobile ? "100%" : "90vh",
          maxHeight: "calc(100dvh - 24px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.22)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="12" r="3" />
            <path d="M6 9v6" />
            <path d="M18 9c0 3-4 3-6 3" />
            <path d="M6 9c0 3 3 3 4.5 3" />
          </svg>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("git.commitDetail")}
          </span>
          <button
            type="button"
            onClick={onClose}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              border: "none",
              borderRadius: 5,
              background: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        {loading ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
            {t("git.loading")}
          </div>
        ) : error || !data ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
            {t("git.showError")}
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* Commit metadata */}
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0, maxHeight: "38vh", overflowY: "auto", minHeight: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)", wordBreak: "break-all" }}>{data.hash}</span>
                <button
                  type="button"
                  onClick={() => void handleCopy()}
                  title={t("git.copyHash")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "2px 7px",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    background: copied ? "var(--bg-selected)" : "none",
                    color: copied ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 10,
                    flexShrink: 0,
                  }}
                >
                  {copied ? "✓" : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                    </svg>
                  )}
                  {copied ? t("git.copied") : t("git.copyHash")}
                </button>
              </div>
              {data.subject && (
                <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", marginTop: 8, wordBreak: "break-word" }}>{data.subject}</div>
              )}
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
                <span style={{ fontWeight: 500 }}>{data.authorName}</span>
                {data.authorEmail && <span style={{ color: "var(--text-dim)" }}>{data.authorEmail}</span>}
                <span style={{ color: "var(--text-dim)" }}>{dateText}</span>
              </div>
              {data.body && (
                <pre
                  style={{
                    margin: "10px 0 0",
                    padding: "10px 12px",
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-muted)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {data.body}
                </pre>
              )}
              {stats.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-dim)" }}>
                  {t("git.filesChanged", { count: stats.length })}
                </div>
              )}
            </div>

            {/* Diff area */}
            <div style={{ flex: 1, overflowY: "auto", minHeight: 0, background: "var(--bg)" }}>
              {files && files.length > 0 ? (
                files.map((file, i) => {
                  const stat = stats[i];
                  return (
                    <DiffFileSection
                      key={file.newPath || file.oldPath || i}
                      file={file}
                      additions={stat?.additions ?? 0}
                      deletions={stat?.deletions ?? 0}
                      expanded={expandedFile === i}
                      onToggle={() => setExpandedFile((cur) => (cur === i ? null : i))}
                    />
                  );
                })
              ) : stats.length > 0 ? (
                // Merge commit / no patch: only the file list.
                stats.map((stat) => (
                  <div key={stat.file} style={{ display: "flex", gap: 10, padding: "5px 16px", fontSize: 12, fontFamily: "var(--font-mono)", borderBottom: "1px solid var(--border)" }}>
                    <span style={{ color: "var(--text-dim)", width: 90, flexShrink: 0 }}>
                      {stat.additions < 0 ? "Bin" : <><span style={{ color: "#4ade80" }}>+{stat.additions}</span> / <span style={{ color: "#f87171" }}>-{stat.deletions}</span></>}
                    </span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>{stat.file}</span>
                  </div>
                ))
              ) : (
                <div style={{ padding: "24px", textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
                  {t("git.mergeCommit")}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
