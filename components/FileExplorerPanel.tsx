"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { useI18n } from "@/hooks/useI18n";

type OpenFileOptions = { sourceSessionId?: string | null; modeHint?: "diff" };

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  /** Monotonic refresh counter — bump it to force a re-fetch (shared with the file viewer). */
  refreshKey?: number;
  /** Called when the user clicks the in-panel refresh button; parent should bump refreshKey. */
  onRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Reported by FileExplorer once git changes load; parent shows the badge. */
  onChangesCountChange?: (count: number) => void;
  /** Bump to expand the changes list and scroll it into view. */
  changesRevealNonce?: number;
}

function ToolbarIconButton({
  onClick,
  title,
  disabled,
  skipHover,
  color,
  background = "none",
  marginRight,
  ariaPressed,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  skipHover?: boolean;
  color: string;
  background?: string;
  marginRight?: number;
  ariaPressed?: boolean;
  children: ReactNode;
}) {
  const enter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = "var(--text-muted)";
    e.currentTarget.style.background = "var(--bg-hover)";
  };
  const leave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = color;
    e.currentTarget.style.background = background;
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={ariaPressed}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, marginRight,
        background,
        border: "none",
        color,
        cursor: disabled ? "default" : "pointer",
        borderRadius: 5,
        flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
        transition: "color 0.3s, background 0.3s",
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {children}
    </button>
  );
}

/**
 * File tree + toolbar (changes toggle / upload / refresh), designed to live as
 * the content of the pinned "Explorer" tab in the right panel. Refresh is
 * delegated to the parent (onRefresh) so the file viewer's git diff stays in
 * sync with the same refresh counter.
 */
export function FileExplorerPanel({ cwd, onOpenFile, refreshKey, onRefresh, onAtMention, onAtMentions, onChangesCountChange, changesRevealNonce }: Props) {
  const { t } = useI18n();
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Report the changes count upward so the chip can show a badge.
  useEffect(() => {
    onChangesCountChange?.(changesCount);
  }, [changesCount, onChangesCountChange]);

  // Reveal + scroll to the git changes list when the chip's 改动 button fires.
  useEffect(() => {
    if (!changesRevealNonce) return;
    setChangesCollapsed(false);
    const raf = requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({ top: 0 });
    });
    return () => cancelAnimationFrame(raf);
  }, [changesRevealNonce]);

  const triggerRefresh = () => {
    onRefresh?.();
    setExplorerRefreshDone(true);
    if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
    explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        flexShrink: 0,
        padding: "4px 6px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
      }}>
        {changesCount > 0 && (
          <ToolbarIconButton
            onClick={() => setChangesCollapsed((v) => !v)}
            title={t("sidebar.changedFiles", { count: changesCount })}
            ariaPressed={!changesCollapsed}
            color={changesCollapsed ? "var(--text-dim)" : "var(--accent)"}
            background={changesCollapsed ? "none" : "var(--bg-selected)"}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M3 12h6" />
              <path d="M15 12h6" />
            </svg>
          </ToolbarIconButton>
        )}
        <ToolbarIconButton
          onClick={() => fileExplorerRef.current?.openUploadPicker()}
          disabled={explorerUploadBusy}
          title={t("sidebar.uploadFilesTitle")}
          color="var(--text-dim)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="m17 8-5-5-5 5" />
            <path d="M12 3v12" />
          </svg>
        </ToolbarIconButton>
        <ToolbarIconButton
          onClick={triggerRefresh}
          title={t("sidebar.refreshExplorer")}
          skipHover={explorerRefreshDone}
          color={explorerRefreshDone ? "#4ade80" : "var(--text-dim)"}
          background={explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none"}
          marginRight={2}
        >
          {explorerRefreshDone ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          )}
        </ToolbarIconButton>
      </div>

      {/* File tree */}
      <div ref={scrollContainerRef} style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0 }}>
        <FileExplorer
          ref={fileExplorerRef}
          cwd={cwd}
          onOpenFile={onOpenFile}
          refreshKey={refreshKey ?? 0}
          onAtMention={onAtMention}
          onAtMentions={onAtMentions}
          onUploadBusyChange={setExplorerUploadBusy}
          changesCollapsed={changesCollapsed}
          onChangesCountChange={setChangesCount}
        />
      </div>
    </div>
  );
}
