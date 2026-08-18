"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";

/** Project + git context shown as a floating chip above the chat content.
 *  Mirrors the data returned by GET /api/worktrees so AppShell can pass it
 *  through verbatim. */
export interface ProjectInfo {
  isGit: boolean;
  /** Current branch of the active worktree, null for detached HEAD or non-git */
  branch: string | null;
  projectRoot: string | null;
  currentWorktreePath: string | null;
  worktrees: { path: string; branch: string | null; isMain: boolean }[];
  branches: { name: string; current: boolean }[];
  /** Remote-tracking branches as `<remote>/<branch>` short names (e.g. `origin/main`) */
  remoteBranches: string[];
}

export interface BranchSwitchState {
  /** True while a worktree is being created/switched */
  busy: boolean;
  /** Last switch error message (git stderr summary), null when clean */
  error: string | null;
}

interface Props {
  info: ProjectInfo;
  cwd: string | null;
  onSwitch: (branch: string) => void;
  switchState?: BranchSwitchState;
  onCreateBranch?: (name: string, startPoint: string | null) => void;
  createState?: BranchSwitchState;
  onDeleteBranch?: (branch: string) => void;
  deleteState?: BranchSwitchState;
  /** Left offset (px) to align with the chat column padding. */
  offsetLeft?: number;
  /** Active session id — copied by the folder menu's "Copy session ID" item. */
  sessionId?: string | null;
  /** Open the git history panel in the right sidebar (branch menu only). */
  onOpenGitHistory?: () => void;
}

export function ProjectHeader({ info, cwd, onSwitch, switchState, onCreateBranch, createState, onDeleteBranch, deleteState, offsetLeft = 16, sessionId, onOpenGitHistory }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [filter, setFilter] = useState("");
  /** True while the "new branch" form is shown instead of the branch list. */
  const [creating, setCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  /** Selected remote-tracking branch ("origin/main"), null = branch off HEAD. */
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null);
  /** Branch currently showing the inline delete-confirmation bar. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** Branch row currently hovered — shows its delete affordance. */
  const [hoveredBranch, setHoveredBranch] = useState<string | null>(null);
  /** Branch the user just clicked — shows its own spinner until busy clears. */
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [dropRect, setDropRect] = useState<{ top: number; left: number } | null>(null);
  const [folderDropRect, setFolderDropRect] = useState<{ top: number; left: number } | null>(null);
  /** Which copy item shows the "copied" confirmation ("path" | "id"). */
  const [copied, setCopied] = useState<"path" | "id" | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const branchBtnRef = useRef<HTMLButtonElement | null>(null);
  const folderBtnRef = useRef<HTMLButtonElement | null>(null);
  const dropRef = useRef<HTMLDivElement | null>(null);
  const folderDropRef = useRef<HTMLDivElement | null>(null);

  const busy = switchState?.busy ?? false;
  const error = switchState?.error ?? null;
  const createBusy = createState?.busy ?? false;
  const createError = createState?.error ?? null;
  const deleteBusy = deleteState?.busy ?? false;
  const deleteError = deleteState?.error ?? null;
  const remoteBranches = info.remoteBranches ?? [];

  /** Reset the branch dropdown's secondary views back to the plain list. */
  const resetBranchPanel = useCallback(() => {
    setCreating(false);
    setNewBranchName("");
    setSelectedRemote(null);
    setConfirmDelete(null);
    setHoveredBranch(null);
    setFilter("");
  }, []);

  // Close on outside click / Escape. Dropdowns are portaled to <body>, so
  // they must be excluded from the outside-click check separately.
  useEffect(() => {
    if (!open && !folderOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (dropRef.current?.contains(target)) return;
      if (folderDropRef.current?.contains(target)) return;
      resetBranchPanel();
      setOpen(false);
      setFolderOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { resetBranchPanel(); setOpen(false); setFolderOpen(false); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, folderOpen, resetBranchPanel]);

  // Position the dropdown with `fixed` so it escapes the chat column's
  // overflow:hidden ancestors. It is portaled to <body> because the capsule's
  // backdrop-filter would otherwise become its containing block and shift the
  // viewport-relative coordinates. Recomputed on open and window resize.
  useEffect(() => {
    if (!open || !branchBtnRef.current) { setDropRect(null); return; }
    const update = () => {
      const btn = branchBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setDropRect({ top: r.bottom + 6, left: r.left });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open]);

  // Same positioning for the folder action menu, anchored to the folder button.
  useEffect(() => {
    if (!folderOpen || !folderBtnRef.current) { setFolderDropRect(null); return; }
    const update = () => {
      const btn = folderBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setFolderDropRect({ top: r.bottom + 6, left: r.left });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [folderOpen]);

  // Close the panel once a switch actually lands. The in-place `git switch`
  // can finish before the chip refetch delivers the new branch, so a cleared
  // busy state with a pending pick and no error also counts as success.
  const prevBranchRef = useRef<string | null>(info.branch);
  useEffect(() => {
    if (busy) { prevBranchRef.current = info.branch; return; }
    if (error) { setPendingBranch(null); return; }
    const branchChanged = info.branch && info.branch !== prevBranchRef.current;
    if (open && pendingBranch) {
      if (branchChanged || !busy) {
        resetBranchPanel();
        setOpen(false);
        setPendingBranch(null);
      }
    }
    prevBranchRef.current = info.branch;
  }, [info.branch, busy, error, open, pendingBranch, resetBranchPanel]);

  // Clear the per-row spinner once busy ends (success path already closed).
  useEffect(() => { if (!busy) setPendingBranch(null); }, [busy]);

  // Close the panel once a create actually lands, mirroring the switch
  // completion effect above: a busy→idle transition with no error means the
  // parent confirmed success (and bumped the refresh key).
  const prevCreateBusyRef = useRef(false);
  useEffect(() => {
    if (createBusy) { prevCreateBusyRef.current = true; return; }
    const wasBusy = prevCreateBusyRef.current;
    prevCreateBusyRef.current = false;
    if (wasBusy && !createError) {
      resetBranchPanel();
      setOpen(false);
    }
  }, [createBusy, createError, resetBranchPanel]);

  // Same busy→idle completion detection for branch deletion.
  const prevDeleteBusyRef = useRef(false);
  useEffect(() => {
    if (deleteBusy) { prevDeleteBusyRef.current = true; return; }
    const wasBusy = prevDeleteBusyRef.current;
    prevDeleteBusyRef.current = false;
    if (wasBusy && !deleteError) {
      resetBranchPanel();
      setOpen(false);
    }
  }, [deleteBusy, deleteError, resetBranchPanel]);

  const dirName = cwd || null;

  // Server-side spawn (file manager or terminal), so it works in both browser
  // and desktop hosts. Errors are non-fatal.
  const openVia = (kind: "filemanager" | "terminal") => {
    if (!cwd) return;
    void fetch("/api/files/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: cwd, kind }),
    }).catch(() => {});
  };

  const handleCopy = async (kind: "path" | "id") => {
    const text = kind === "path" ? cwd : sessionId;
    if (!text) return;
    try {
      await copyText(text);
      setCopied(kind);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  // Clear the copy-feedback timer on unmount.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const toggleFolderMenu = () => {
    setOpen(false);
    setFolderOpen((v) => !v);
  };
  const branches = info.branches ?? [];
  const showFilter = branches.length >= 8;
  const visible = showFilter && filter.trim()
    ? branches.filter((b) => b.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : branches;

  const handlePick = (name: string) => {
    if (busy || name === info.branch) return;
    setPendingBranch(name);
    onSwitch(name);
  };

  /** Fire the create request; the parent owns busy/error + the refresh. */
  const handleCreate = useCallback(() => {
    if (!onCreateBranch || !newBranchName.trim() || createBusy) return;
    onCreateBranch(newBranchName.trim(), selectedRemote);
  }, [onCreateBranch, newBranchName, selectedRemote, createBusy]);

  /** Confirm the inline delete bar; the parent owns busy/error + the refresh. */
  const handleDeleteConfirm = useCallback((name: string) => {
    if (!onDeleteBranch || deleteBusy) return;
    onDeleteBranch(name);
  }, [onDeleteBranch, deleteBusy]);

  const handleDeleteCancel = useCallback(() => setConfirmDelete(null), []);

  const capsuleStyle: CSSProperties = {
    position: "absolute",
    top: 8,
    left: offsetLeft,
    zIndex: 30,
    display: "flex",
    alignItems: "center",
    gap: 6,
    maxWidth: "calc(100% - 16px)",
    padding: "3px 10px",
    borderRadius: 999,
    background: "color-mix(in srgb, var(--bg-panel) 88%, transparent)",
    border: "1px solid var(--border)",
    boxShadow: "0 1px 2px rgba(15,23,42,0.05), 0 4px 14px -8px rgba(15,23,42,0.20)",
    WebkitBackdropFilter: "blur(6px)",
    backdropFilter: "blur(6px)",
    fontSize: 12,
    lineHeight: 1.4,
    color: "var(--text-muted)",
  };

  const branchDisabled = branches.length === 0 || busy;

  return (
    <div ref={containerRef} style={capsuleStyle}>
      {dirName && (
        <button
          ref={folderBtnRef}
          type="button"
          onClick={toggleFolderMenu}
          title={cwd ?? undefined}
          aria-haspopup="menu"
          aria-expanded={folderOpen}
          style={{
            display: "flex", alignItems: "center", gap: 4, minWidth: 0,
            padding: "1px 7px", borderRadius: 999,
            background: folderOpen ? "var(--bg-hover)" : "transparent",
            border: "1px solid transparent",
            color: folderOpen ? "var(--text)" : "var(--text-muted)", cursor: "pointer",
            fontSize: 12, whiteSpace: "nowrap",
            transition: "background 0.1s, color 0.1s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = folderOpen ? "var(--bg-hover)" : "transparent";
            e.currentTarget.style.color = folderOpen ? "var(--text)" : "var(--text-muted)";
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
          </svg>
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 420 }}>
            {dirName}
          </span>
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
      )}
      {folderOpen && folderDropRect && createPortal(
        <div
          ref={folderDropRef}
          role="menu"
          style={{
            position: "fixed",
            top: folderDropRect.top,
            left: folderDropRect.left,
            minWidth: 180,
            zIndex: 1000,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0,0,0,0.12)",
            overflow: "hidden",
          }}
        >
          {(
            [
              {
                key: "filemanager",
                closeOnSelect: true,
                label: t("branch.openFolder"),
                onSelect: () => openVia("filemanager"),
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
                    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                  </svg>
                ),
              },
              {
                key: "terminal",
                closeOnSelect: true,
                label: t("branch.openTerminal"),
                onSelect: () => openVia("terminal"),
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                ),
              },
              {
                key: "copy-path",
                closeOnSelect: false,
                label: copied === "path" ? t("branch.copied") : t("branch.copyPath"),
                onSelect: () => void handleCopy("path"),
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                ),
              },
              {
                key: "copy-id",
                closeOnSelect: false,
                label: copied === "id" ? t("branch.copied") : t("branch.copySessionId"),
                onSelect: () => void handleCopy("id"),
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
                    <line x1="4" y1="9" x2="20" y2="9" />
                    <line x1="4" y1="15" x2="20" y2="15" />
                    <line x1="10" y1="3" x2="8" y2="21" />
                    <line x1="16" y1="3" x2="14" y2="21" />
                  </svg>
                ),
              },
            ] as Array<{ key: string; closeOnSelect: boolean; label: string; onSelect: () => void; icon: ReactNode }>
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                if (item.closeOnSelect) setFolderOpen(false);
                item.onSelect();
              }}
              style={{
                width: "100%",
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 12px",
                background: "var(--bg)",
                border: "none", borderBottom: "1px solid var(--border)",
                color: "var(--text-muted)",
                cursor: "pointer",
                textAlign: "left", fontSize: 12,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg)"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              {item.icon}
              <span style={{ flex: 1, whiteSpace: "nowrap" }}>{item.label}</span>
              {copied && copied === (item.key === "copy-path" ? "path" : item.key === "copy-id" ? "id" : null) && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
      {info.isGit && (
        <>
          <button
            ref={branchBtnRef}
            type="button"
            onClick={() => {
              setFolderOpen(false);
              if (!open) resetBranchPanel();
              setOpen((v) => !v);
            }}
            disabled={branchDisabled}
            title={t("branch.switch")}
            aria-haspopup="listbox"
            aria-expanded={open}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "1px 7px", borderRadius: 999,
              background: open ? "var(--bg-hover)" : "transparent",
              border: "1px solid transparent",
              color: open ? "var(--text)" : "var(--text-muted)",
              cursor: branchDisabled ? "default" : "pointer",
              fontSize: 12, whiteSpace: "nowrap", flexShrink: 0,
              transition: "background 0.1s, color 0.1s",
            }}
            onMouseEnter={(e) => {
              if (branchDisabled) return;
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = open ? "var(--bg-hover)" : "transparent";
              e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)";
            }}
          >
            {busy ? (
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            )}
            <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>
              {busy && pendingBranch ? pendingBranch : (info.branch ?? t("branch.detached"))}
            </span>
            {branches.length > 0 && !busy && (
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            )}
          </button>
          {open && dropRect && createPortal(
            <div
              ref={dropRef}
              role="listbox"
              style={{
                position: "fixed",
                top: dropRect.top,
                left: dropRect.left,
                minWidth: 200,
                maxWidth: 320,
                zIndex: 1000,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
              }}
            >
              {error && (
                <div style={{ padding: "6px 10px", fontSize: 11, color: "#dc2626", borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.06)", whiteSpace: "normal", wordBreak: "break-word" }}>
                  {t("branch.switchFailed")}: {error}
                </div>
              )}
              {deleteError && (
                <div style={{ padding: "6px 10px", fontSize: 11, color: "#dc2626", borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.06)", whiteSpace: "normal", wordBreak: "break-word" }}>
                  {t("branch.deleteFailed")}: {deleteError}
                </div>
              )}
              {showFilter && (
                <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") { setFilter(""); setOpen(false); } }}
                    placeholder={t("branch.searchPlaceholder")}
                    autoFocus
                    style={{
                      width: "100%", fontSize: 11, fontFamily: "var(--font-mono)",
                      padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 5,
                      outline: "none", background: "var(--bg)", color: "var(--text)", boxSizing: "border-box",
                    }}
                  />
                </div>
              )}
              <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
                {visible.length === 0 ? (
                  <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-dim)" }}>—</div>
                ) : visible.map((b) => {
                  const isPending = busy && pendingBranch === b.name;
                  if (confirmDelete === b.name) {
                    // ── Inline delete confirmation bar, same row height ──
                    return (
                      <div
                        key={b.name}
                        style={{
                          width: "100%",
                          display: "flex", alignItems: "center", gap: 6,
                          padding: "5px 10px",
                          background: "rgba(239,68,68,0.06)",
                          borderBottom: "1px solid var(--border)",
                          borderLeft: "2px solid #ef4444",
                          boxSizing: "border-box",
                        }}
                      >
                        <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t("branch.confirmDeleteBranch", { name: b.name })}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleDeleteConfirm(b.name)}
                          disabled={deleteBusy}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                            height: 24, padding: "0 9px",
                            background: deleteBusy ? "var(--bg-hover)" : "#ef4444",
                            border: "none", borderRadius: 5,
                            color: deleteBusy ? "var(--text-dim)" : "#fff",
                            cursor: deleteBusy ? "default" : "pointer",
                            fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0,
                          }}
                        >
                          {deleteBusy && (
                            <svg className="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            </svg>
                          )}
                          {t("branch.delete")}
                        </button>
                        <button
                          type="button"
                          onClick={handleDeleteCancel}
                          disabled={deleteBusy}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "center",
                            height: 24, padding: "0 9px",
                            background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5,
                            color: "var(--text-muted)",
                            cursor: deleteBusy ? "default" : "pointer",
                            fontSize: 11, whiteSpace: "nowrap", flexShrink: 0,
                          }}
                        >
                          {t("branch.cancel")}
                        </button>
                      </div>
                    );
                  }
                  const isHovered = hoveredBranch === b.name;
                  return (
                    <button
                      key={b.name}
                      type="button"
                      onClick={() => handlePick(b.name)}
                      disabled={busy || b.current || deleteBusy}
                      title={b.name}
                      style={{
                        width: "100%",
                        display: "flex", alignItems: "center", gap: 7,
                        padding: "8px 10px",
                        background: b.current ? "var(--bg-selected)" : "var(--bg)",
                        border: "none", borderBottom: "1px solid var(--border)",
                        color: b.current ? "var(--text)" : "var(--text-muted)",
                        cursor: busy ? "wait" : b.current ? "default" : "pointer",
                        textAlign: "left", fontSize: 11, fontFamily: "var(--font-mono)",
                        opacity: deleteBusy ? 0.6 : 1,
                      }}
                      onMouseEnter={(e) => {
                        setHoveredBranch(b.name);
                        if (!b.current && !busy) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        setHoveredBranch(null);
                        e.currentTarget.style.background = b.current ? "var(--bg-selected)" : "var(--bg)";
                      }}
                    >
                      {b.current ? (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                          <polyline points="1.5 5 4 7.5 8.5 2.5" />
                        </svg>
                      ) : isPending ? (
                        <svg className="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      ) : (
                        <span style={{ width: 10, flexShrink: 0 }} />
                      )}
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                      {isHovered && !b.current && !busy && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); setConfirmDelete(b.name); }}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setConfirmDelete(b.name); } }}
                          title={t("branch.deleteBranch")}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "center",
                            width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                            color: "var(--text-dim)", cursor: "pointer",
                          }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                            <path d="M10 11v6M14 11v6" />
                            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                          </svg>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {!creating && (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  disabled={busy}
                  style={{
                    width: "100%",
                    display: "flex", alignItems: "center", gap: 7,
                    padding: "8px 10px",
                    background: "var(--bg)",
                    border: "none", borderTop: "1px solid var(--border)",
                    color: busy ? "var(--text-dim)" : "var(--text-muted)",
                    cursor: busy ? "default" : "pointer",
                    textAlign: "left", fontSize: 11,
                  }}
                  onMouseEnter={(e) => {
                    if (busy) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg)";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ flexShrink: 0 }}>
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  {t("branch.newBranch")}
                </button>
              )}
              {onOpenGitHistory && !creating && (
                <button
                  type="button"
                  onClick={() => { setOpen(false); resetBranchPanel(); onOpenGitHistory(); }}
                  disabled={busy}
                  style={{
                    width: "100%",
                    display: "flex", alignItems: "center", gap: 7,
                    padding: "8px 10px",
                    background: "var(--bg)",
                    border: "none", borderTop: "1px solid var(--border)",
                    color: busy ? "var(--text-dim)" : "var(--text-muted)",
                    cursor: busy ? "default" : "pointer",
                    textAlign: "left", fontSize: 11,
                  }}
                  onMouseEnter={(e) => {
                    if (busy) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg)";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <circle cx="6" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="12" r="3" />
                    <path d="M6 9v6" />
                    <path d="M18 9c0 3-4 3-6 3" />
                    <path d="M6 9c0 3 3 3 4.5 3" />
                  </svg>
                  {t("git.history")}
                </button>
              )}
              {creating && (
                <div style={{ padding: "8px 10px", borderTop: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("branch.selectRemoteBranch")}</span>
                    <button
                      type="button"
                      onClick={resetBranchPanel}
                      disabled={createBusy}
                      style={{
                        background: "none", border: "none",
                        color: createBusy ? "var(--text-dim)" : "var(--text-muted)",
                        cursor: createBusy ? "default" : "pointer",
                        fontSize: 11, padding: "2px 4px",
                      }}
                    >
                      {t("branch.cancel")}
                    </button>
                  </div>
                  {/* Remote branch picker — click to toggle; none = off HEAD. */}
                  <div style={{ maxHeight: 132, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 5 }}>
                    {remoteBranches.length === 0 ? (
                      <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                        {t("branch.noRemoteBranches")}
                      </div>
                    ) : remoteBranches.map((rb) => {
                      const active = selectedRemote === rb;
                      return (
                        <button
                          key={rb}
                          type="button"
                          onClick={() => {
                            const next = active ? null : rb;
                            setSelectedRemote(next);
                            if (next) {
                              // Copy the branch name (minus the remote prefix)
                              // into the new-name field for convenience.
                              const slash = rb.indexOf("/");
                              setNewBranchName(slash > 0 ? rb.slice(slash + 1) : rb);
                            }
                          }}
                          disabled={createBusy}
                          style={{
                            width: "100%",
                            display: "flex", alignItems: "center", gap: 6,
                            padding: "5px 8px",
                            background: active ? "var(--bg-selected)" : "var(--bg)",
                            border: "none", borderBottom: "1px solid var(--border)",
                            color: active ? "var(--text)" : "var(--text-muted)",
                            cursor: createBusy ? "default" : "pointer",
                            textAlign: "left", fontSize: 11, fontFamily: "var(--font-mono)",
                          }}
                          onMouseEnter={(e) => { if (!active && !createBusy) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = active ? "var(--bg-selected)" : "var(--bg)"; }}
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke={active ? "var(--accent)" : "var(--text-dim)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            {active
                              ? <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              : <circle cx="5" cy="5" r="3.5" />}
                          </svg>
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rb}</span>
                        </button>
                      );
                    })}
                  </div>
                  {/* New branch name */}
                  <input
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreate();
                      if (e.key === "Escape") { resetBranchPanel(); setOpen(false); }
                    }}
                    placeholder={t("branch.newBranchName")}
                    disabled={createBusy}
                    autoFocus
                    style={{
                      width: "100%", fontSize: 11, fontFamily: "var(--font-mono)",
                      padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 5,
                      outline: "none", background: "var(--bg)", color: "var(--text)",
                      boxSizing: "border-box", marginTop: 6,
                    }}
                  />
                  {/* Create */}
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={handleCreate}
                      disabled={!newBranchName.trim() || createBusy}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                        height: 26, padding: "0 10px",
                        background: !newBranchName.trim() || createBusy ? "var(--bg-hover)" : "var(--accent)",
                        border: "none", borderRadius: 5,
                        color: !newBranchName.trim() || createBusy ? "var(--text-dim)" : "#fff",
                        cursor: !newBranchName.trim() || createBusy ? "default" : "pointer",
                        fontSize: 11, fontWeight: 600, flex: 1,
                      }}
                    >
                      {createBusy && (
                        <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      )}
                      {t("branch.create")}
                    </button>
                  </div>
                  {createError && (
                    <div style={{ marginTop: 6, padding: "6px 8px", fontSize: 11, color: "#dc2626", background: "rgba(239,68,68,0.06)", borderRadius: 5, whiteSpace: "normal", wordBreak: "break-word" }}>
                      {t("branch.createFailed")}: {createError}
                    </div>
                  )}
                </div>
              )}
            </div>,
            document.body,
          )}
        </>
      )}
    </div>
  );
}
