"use client";

import { useEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { DirectoryPicker } from "./DirectoryPicker";
import type { Section } from "./SettingsDialog";

declare global {
  interface Window {
    piDesktop?: {
      isDesktop?: boolean;
      platform?: string;
      info?: () => Promise<{
        version: string;
        platform: string;
        electron: string;
        serverUrl: string | null;
      }>;
      selectDirectory?: () => Promise<string | null>;
      // online updater methods (desktop/preload.js)
      checkForUpdates?: () => Promise<unknown>;
      downloadUpdate?: () => Promise<unknown>;
      installUpdate?: () => Promise<unknown>;
      updateState?: () => Promise<unknown>;
      onUpdateProgress?: (cb: (data: { percent: number; transferred: number; total: number }) => void) => (() => void) | void;
      // built-in browser bridge (desktop/preload.js)
      browserCdpInfo?: () => Promise<unknown>;
      clearBrowserData?: (flags: {
        cache?: boolean;
        cookies?: boolean;
        local?: boolean;
        serviceWorkers?: boolean;
      }) => Promise<{ ok?: boolean } | undefined>;
      // system tray toggle (desktop/preload.js)
      getWindowConfig?: () => Promise<{ minimizeToTray: boolean }>;
      setWindowConfig?: (config: { minimizeToTray: boolean }) => Promise<{ minimizeToTray: boolean }>;
    };
  }
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
  /** Fired when a session that is not currently selected finishes running.
   *  Lets the app play a cross-workspace completion tone. */
  onBackgroundTaskDone?: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  /** Open the settings dialog on a specific section. */
  onOpenSettings?: (section: Section) => void;
  /** The just-sent brand-new session (real pi id, no file on disk yet). Rendered
   *  as an instant running placeholder until the real item appears in the list. */
  pendingNewSession?: SessionInfo | null;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const RUNNING_SESSIONS_POLL_MS = 2500;

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

const COLLAPSED_PROJECTS_STORAGE_KEY = "pi-sidebar-collapsed-projects";

function loadCollapsedProjects(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((p): p is string => typeof p === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedProjects(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(COLLAPSED_PROJECTS_STORAGE_KEY);
    else window.localStorage.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

/**
 * Return all projects (deduped by projectRoot) sorted by most recent session
 * activity.
 */
function getRecentProjects(sessions: SessionInfo[]): string[] {
  const latestByRoot = new Map<string, string>(); // projectRoot -> most recent modified
  for (const s of sessions) {
    const root = s.projectRoot ?? s.cwd;
    if (!root) continue;
    const prev = latestByRoot.get(root);
    if (!prev || s.modified > prev) {
      latestByRoot.set(root, s.modified);
    }
  }
  return [...latestByRoot.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([root]) => root);
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

function PiWebTitle() {
  const [scrambling, setScrambling] = useState(false);

  const display = useScramble("pi-studio", scrambling);

  const handleClick = useCallback(() => {
    setScrambling(true);
    setTimeout(() => setScrambling(false), "pi-studio".length * 4 * (1000 / 60) + 100);
  }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "default",
        fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em",
        color: "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
      }}
    >
      {display}
    </button>
  );
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onBackgroundTaskDone, onRunningSessionIdsChange, onOpenSettings, pendingNewSession }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  // Brand-new sessions that were sent but have no file on disk yet (pi buffers
  // everything until the first assistant reply). Rendered as running
  // placeholders and pruned once the real item lands in allSessions or the run
  // dies without ever persisting.
  const [pendingSessions, setPendingSessions] = useState<SessionInfo[]>([]);
  // Project cwds discovered from ~/.pi-studio/sessions/ subdirectories — includes
  // projects that have zero sessions (empty dirs) so they still show up.
  const [knownProjectDirs, setKnownProjectDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [projectFilter, setProjectFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  /** { projectRoot, sessionCount, busy } for the in-place delete confirmation UI. */
  const [deleteProjectConfirm, setDeleteProjectConfirm] = useState<{ projectRoot: string; sessionCount: number } | null>(null);
  /** Controls the global expand-all / collapse-all button in the title bar. */
  const [allCollapsed, setAllCollapsed] = useState(false);
  /** Sort order for the project list. Persisted to localStorage. */
  const [projectSort, setProjectSort] = useState<"recent" | "created" | "name">(
    () => ((typeof window !== "undefined" ? localStorage.getItem("pi-sidebar:project-sort") : null) as "recent" | "created" | "name") ?? "recent",
  );
  /** Whether the sort dropdown menu is open. */
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  // Projects the user has collapsed in the sidebar (persisted). The active
  // project is always expanded regardless of this set.
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => loadCollapsedProjects());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of allSessions for effects that react to the running set without
  // depending on the list itself — a reload always creates a fresh array
  // reference, which would otherwise re-trigger the effect and loop.
  const allSessionsRef = useRef<SessionInfo[]>(allSessions);
  allSessionsRef.current = allSessions;

  const loadSessions = useCallback(async (showLoading = false, quiet = false) => {
    try {
      if (showLoading) setLoading(true);
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[]; projectDirs?: string[] };
      setAllSessions(data.sessions);
      setKnownProjectDirs(data.projectDirs ?? []);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      const existingIds = new Set(data.sessions.map((s) => s.id));
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => existingIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading && !quiet) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  // Merge the latest just-created session into the placeholder list (one per id).
  useEffect(() => {
    if (!pendingNewSession) return;
    setPendingSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === pendingNewSession.id);
      if (idx === -1) return [...prev, pendingNewSession];
      if (prev[idx] === pendingNewSession) return prev;
      const next = [...prev];
      next[idx] = pendingNewSession;
      return next;
    });
  }, [pendingNewSession]);

  // Drop placeholders once the real session file lands (now in allSessions) or
  // the run ends without ever persisting (no longer running and still not in
  // the list). Keeps an aborted/failed run from leaving a ghost item behind.
  useEffect(() => {
    setPendingSessions((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.filter((s) => (
        runningSessionIds.has(s.id) && !allSessions.some((x) => x.id === s.id)
      ));
      return next.length === prev.length ? prev : next;
    });
  }, [allSessions, runningSessionIds]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    saveCollapsedProjects(collapsedProjects);
  }, [collapsedProjects]);

  // Close the sort dropdown when clicking outside it.
  useEffect(() => {
    if (!sortDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!document.getElementById("sidebar-sort-dropdown")?.contains(target)) {
        setSortDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [sortDropdownOpen]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as { runningSessionIds?: string[] };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds];

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        newlyRunning.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }
    if (completedInBackground.length > 0) {
      loadSessions(false);
      onBackgroundTaskDone?.();
    }

    // A running session missing from the list is either a brand-new session
    // whose file has not flushed yet (shown as a placeholder) or a run started
    // elsewhere. Re-read the list so it appears as soon as the file lands on
    // disk — the server invalidates its list cache when the file is written.
    // Quiet: this fires on every poll tick while the file is still absent, so
    // it must not flash the refresh button each time.
    const runningNotListed = [...runningSessionIds].filter((id) => !allSessionsRef.current.some((s) => s.id === id));
    if (runningNotListed.length > 0) {
      loadSessions(false, true);
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  /** Resolve the project root for a cwd from the freshest data available */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    const match = allSessions.find((s) => s.cwd === cwd);
    return match?.projectRoot ?? cwd;
  }, [allSessions]);

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session refreshes).
  const lastNotifiedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd));
  }, [selectedCwd, onCwdChange, projectRootFor]);

  // Sync the effective cwd to the selected session's directory. Only fires
  // when the prop value changes, so a manual selection is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) setSelectedCwd(projects[0]);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setSelectedCwd(data.cwd ?? path);
      setCustomPathOpen(false);
      setCustomPathValue("");
      // Re-fetch so the newly-marked project (ensureProjectDir ran server-side)
      // shows up immediately, even with zero sessions.
      loadSessions();
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating, loadSessions]);

  const handleOpenProject = useCallback(async () => {
    // Desktop: use the native OS folder picker (dialog.showOpenDialog).
    if (typeof window !== "undefined" && window.piDesktop?.selectDirectory) {
      try {
        const picked = await window.piDesktop.selectDirectory();
        if (picked) {
          await commitCustomPath(picked);
          return;
        }
        // User cancelled the native dialog — do nothing.
        return;
      } catch {
        // IPC failure — fall through to the in-app picker below.
      }
    }
    // Web build (or desktop IPC unavailable): fall back to DirectoryPicker.
    setCustomPathOpen(true);
    setCustomPathError(null);
  }, [commitCustomPath]);
  // Clicking a session moves the effective cwd to that session's directory.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s);
  }, [onSelectSession]);

  const handleNewSession = useCallback((cwdOverride?: string) => {
    const cwd = cwdOverride ?? selectedCwd;
    if (!cwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, cwd);
  }, [selectedCwd, onNewSession]);

  // Projects = sessions-derived + empty project dirs. Sorted by projectSort.
  const recentProjects = useMemo(() => {
    const fromSessions = getRecentProjects(allSessions);
    const known = new Set<string>(fromSessions);
    for (const s of allSessions) {
      known.add(s.cwd);
      if (s.projectRoot) known.add(s.projectRoot);
    }
    const orphanDirs = knownProjectDirs.filter((cwd) => !known.has(cwd));
    const allProjects = [...fromSessions, ...orphanDirs];
    if (projectSort === "recent") return allProjects;
    // name sort: direct string comparison
    if (projectSort === "name") {
      return [...allProjects].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    }
    // created sort: each project's earliest session creation time
    const createdOf = new Map<string, string>();
    for (const s of allSessions) {
      const key = s.projectRoot ?? s.cwd;
      if (!key) continue;
      const prev = createdOf.get(key);
      if (!prev || s.created < prev) createdOf.set(key, s.created);
    }
    return [...allProjects].sort((a, b) => {
      const ca = createdOf.get(a) ?? "";
      const cb = createdOf.get(b) ?? "";
      return cb.localeCompare(ca); // newest first
    });
  }, [allSessions, knownProjectDirs, projectSort]);

  // Sessions grouped by project (projectRoot ?? cwd), same key as getRecentProjects.
  const sessionsByProject = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    for (const s of allSessions) {
      const key = s.projectRoot ?? s.cwd;
      if (!key) continue;
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push(s);
    }
    return map;
  }, [allSessions]);

  // Per-project activity counts (running / unread). Keyed the same way as
  // getRecentProjects (projectRoot ?? cwd) so the counts line up with each
  // project row. Small data set — cheap to recompute.
  const projectActivity = useMemo(() => {
    const counts = new Map<string, { running: number; unread: number }>();
    for (const s of allSessions) {
      const key = s.projectRoot ?? s.cwd;
      if (!key) continue;
      let entry = counts.get(key);
      if (!entry) { entry = { running: 0, unread: 0 }; counts.set(key, entry); }
      if (runningSessionIds.has(s.id)) entry.running++;
      if (unreadSessionIds.has(s.id)) entry.unread++;
    }
    return counts;
  }, [allSessions, runningSessionIds, unreadSessionIds]);

  // Pending placeholders grouped by project, keyed the same as sessionsByProject.
  // Visibility is derived here (not from effect timing): a placeholder renders
  // only while its session is still running AND not yet listed, so it can never
  // coexist with the real item of the same id in a single render (duplicate key).
  const pendingByProject = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    for (const s of pendingSessions) {
      if (allSessions.some((x) => x.id === s.id)) continue; // real item landed
      if (!runningSessionIds.has(s.id)) continue;           // run died unpersisted
      const key = projectRootFor(s.cwd) ?? s.cwd;
      if (!key) continue;
      const arr = map.get(key);
      if (arr) arr.push(s);
      else map.set(key, [s]);
    }
    return map;
  }, [pendingSessions, allSessions, runningSessionIds, projectRootFor]);

  // Search filters across project paths AND session titles. When a query is
  // active, matching sessions are shown and their projects auto-expand.
  const searchQuery = projectFilter.trim().toLowerCase();
  const filteredProjects = useMemo(() => {
    if (!searchQuery) return recentProjects;
    return recentProjects.filter((project) => {
      if (project.toLowerCase().includes(searchQuery)) return true;
      const sessions = sessionsByProject.get(project) ?? [];
      return sessions.some((s) =>
        (s.name ?? s.firstMessage ?? "").toLowerCase().includes(searchQuery),
      );
    });
  }, [recentProjects, searchQuery, sessionsByProject]);

  // Expand / collapse all: toggles all projects into collapsedProjects at once.
  const handleToggleAll = useCallback(() => {
    if (allCollapsed) {
      // Expand all: clear collapsedProjects.
      setCollapsedProjects(new Set());
    } else {
      // Collapse all: add every known project to collapsedProjects.
      const all = recentProjects;
      setCollapsedProjects((prev) => {
        const next = new Set(prev);
        for (const p of all) next.add(p);
        return next;
      });
    }
    setAllCollapsed((v) => !v);
  }, [allCollapsed, recentProjects]);

  // Sort order change: update state + persist to localStorage.
  const handleSortChange = useCallback((sort: "recent" | "created" | "name") => {
    setProjectSort(sort);
    setSortDropdownOpen(false);
    try { localStorage.setItem("pi-sidebar:project-sort", sort); } catch { /* quota */ }
  }, []);

  // Sessions visible within a project after applying the search filter.
  const visibleSessionsFor = useCallback((project: string): SessionInfo[] => {
    const sessions = sessionsByProject.get(project) ?? [];
    if (!searchQuery) return sessions;
    return sessions.filter((s) => {
      if (project.toLowerCase().includes(searchQuery)) return true;
      return (s.name ?? s.firstMessage ?? "").toLowerCase().includes(searchQuery);
    });
  }, [sessionsByProject, searchQuery]);

  // A project is expanded when it is NOT collapsed, OR a search query is active.
  // Unlike the old logic, the active project no longer bypasses collapsedProjects —
  // that caused the collapse arrow to do nothing when the project was selected.
  const isProjectExpanded = useCallback((project: string): boolean => {
    if (searchQuery) return true;
    return !collapsedProjects.has(project);
  }, [collapsedProjects, searchQuery]);

  const toggleProjectCollapsed = useCallback((project: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }, []);

  // Show the delete confirmation for a project (collects all session ids first).
  const handleDeleteProjectRequest = useCallback((projectRoot: string) => {
    const sessions = sessionsByProject.get(projectRoot) ?? [];
    setDeleteProjectConfirm({ projectRoot, sessionCount: sessions.length });
  }, [sessionsByProject]);

  // Actually delete every session in the project, then refresh the list.
  const handleDeleteProjectConfirm = useCallback(async () => {
    if (!deleteProjectConfirm) return;
    const { projectRoot } = deleteProjectConfirm;
    setDeleteProjectConfirm(null);
    const sessions = sessionsByProject.get(projectRoot) ?? [];
    // Delete every session in parallel; individual failures are non-fatal.
    await Promise.allSettled(sessions.map((s) =>
      fetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" })
    ));
    // Remove the project's session-storage directory so the (now-empty) project
    // stops reappearing in the sidebar. Sessions can live under several cwds
    // (e.g. worktrees share a projectRoot but each has its own session dir), so
    // delete one dir per unique cwd plus the project root itself.
    const cwds = new Set<string>(
      sessions.map((s) => s.cwd).filter((c): c is string => Boolean(c)),
    );
    cwds.add(projectRoot);
    await Promise.allSettled([...cwds].map((cwd) =>
      fetch("/api/sessions/project", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      })
    ));
    await loadSessions();
    // If the deleted project is the current cwd, clear the active session/cwd so
    // the app falls back to the "select a project" state (or another project)
    // and the just-deleted directory does not linger as the active cwd — which
    // would otherwise reappear with a fresh session on the next new-session.
    if (selectedCwd === projectRoot) {
      setSelectedCwd(null);
      onSessionDeleted?.("");
    }
  }, [deleteProjectConfirm, sessionsByProject, selectedCwd, onSessionDeleted, loadSessions]);

  // Activate a project as the current cwd (clicking the project row).
  const handleActivateProject = useCallback(async (project: string) => {
    // Allow the cwd BEFORE notifying AppShell: setSelectedCwd synchronously
    // drives AppShell's activeCwd change, which immediately fires
    // GET /api/worktrees (and the file explorer) for the new folder. When this
    // validate call raced that fetch, the allow-list check 403'd — the chip
    // then silently fell back to the no-git state (git buttons gone) with no
    // retry. The race was real for any project without sessions: project dirs
    // discovered via listProjectDirs were never allowFileRoot-ed, and the
    // in-memory allow-list is lost on every server restart. validate is
    // idempotent and fast (ensureProjectDir only invalidates caches on first
    // creation), so awaiting it keeps the switch snappy.
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: project }),
      });
      if (!res.ok) return;
    } catch {
      // Server unreachable — do not switch into an unauthorized folder.
      return;
    }
    // Optimistic: highlight + expand immediately so the click feels instant.
    // setSelectedCwd triggers the onCwdChange effect, driving AppShell's switch.
    setSelectedCwd(project);
    setCollapsedProjects((prev) => {
      if (!prev.has(project)) return prev;
      const next = new Set(prev);
      next.delete(project);
      return next;
    });
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {customPathOpen && (
        <DirectoryPicker
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      {/* Header */}
      <div
        style={{
          padding: "12px 10px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <PiWebTitle />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => handleNewSession()}
              disabled={!selectedCwd}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: selectedCwd ? "var(--text-muted)" : "var(--text-dim)",
                cursor: selectedCwd ? "pointer" : "not-allowed",
                height: 32,
                paddingLeft: 10,
                paddingRight: 12,
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                flexShrink: 0,
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
             title={selectedCwd ? t("sidebar.newSessionTitle", { path: selectedCwd }) : t("sidebar.selectProject")}
              onMouseEnter={(e) => {
                if (!selectedCwd) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = selectedCwd ? "var(--text-muted)" : "var(--text-dim)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
              {t("sidebar.new")}
            </button>
            <button
              onClick={() => loadSessions(false)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: sessionRefreshDone ? "rgba(74,222,128,0.18)" : "var(--bg-hover)",
                border: `1px solid ${sessionRefreshDone ? "rgba(74,222,128,0.4)" : "var(--border)"}`,
                color: sessionRefreshDone ? "#4ade80" : "var(--text-muted)",
                cursor: "pointer",
                width: 32, height: 32,
                borderRadius: 7,
                padding: 0,
                flexShrink: 0,
                transition: "background 0.3s, color 0.3s, border-color 0.3s",
              }}
              onMouseEnter={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
               title={t("sidebar.refresh")}
            >
              {sessionRefreshDone ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
          </div>
        </div>

      {/* Session list */}
      {/* Title row: "工作区" label + expand/collapse all + sort */}
        {!loading && !error && (
          <button
            onClick={() => void handleOpenProject()}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              marginTop: 8,
              padding: "7px 10px",
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent) 42%, transparent)",
              borderRadius: 7,
              color: "var(--accent)",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 12,
              fontWeight: 600,
              transition: "background 0.12s, color 0.12s, border-color 0.12s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 20%, transparent)";
              e.currentTarget.style.color = "var(--accent)";
              e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 60%, transparent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 12%, transparent)";
              e.currentTarget.style.color = "var(--accent)";
              e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 42%, transparent)";
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
            <span>{t("sidebar.openProject")}</span>
          </button>
        )}

        {/* Shortcuts → settings sections (skills / connectors / prompts) */}
        {onOpenSettings && (
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 1 }}>
            {([
              {
                section: "skills",
                label: t("common.skills"),
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                    <path d="M2 17l10 5 10-5" />
                    <path d="M2 12l10 5 10-5" />
                  </svg>
                ),
              },
              {
                section: "mcp",
                label: t("common.connectors"),
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22v-5" />
                    <path d="M9 8V2" />
                    <path d="M15 8V2" />
                    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
                  </svg>
                ),
              },
              {
                section: "prompts",
                label: t("common.prompts"),
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                    <path d="M9 13h6" />
                    <path d="M9 17h6" />
                  </svg>
                ),
              },
              {
                section: "experts",
                label: t("common.experts"),
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                ),
              },
              {
                section: "memory",
                label: t("common.memory"),
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V8a3 3 0 0 0-3-3z" />
                    <path d="M19 9a2 2 0 0 0-2 2v1a2 2 0 0 0 4 0v-1a2 2 0 0 0-2-2z" />
                    <path d="M5 9a2 2 0 0 0-2 2v1a2 2 0 0 0 4 0v-1a2 2 0 0 0-2-2z" />
                  </svg>
                ),
              },
            ] as { section: Section; label: string; icon: ReactNode }[]).map((item) => (
              <button
                key={item.section}
                onClick={() => onOpenSettings(item.section)}
                title={item.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "6px 10px",
                  background: "transparent",
                  border: "none",
                  borderRadius: 6,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 12,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <span style={{ display: "flex", flexShrink: 0, color: "var(--accent)" }}>{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Session list */}
      {/* Title row: "工作区" label + expand/collapse all + sort */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.03em", textTransform: "uppercase" }}>
          {t("sidebar.workspace")}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {/* Expand / collapse all */}
          <button
            onClick={handleToggleAll}
            title={allCollapsed ? t("sidebar.expandAll") : t("sidebar.collapseAll")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, padding: 0, flexShrink: 0,
              background: "none", border: "none",
              color: "var(--text-dim)", cursor: "pointer", borderRadius: 4,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            {allCollapsed ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <polyline points="3 5 7 9 11 5" />
                <polyline points="3 8 7 12 11 8" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <polyline points="3 9 7 5 11 9" />
                <polyline points="3 12 7 8 11 12" />
              </svg>
            )}
          </button>

          {/* Sort dropdown */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setSortDropdownOpen((v) => !v)}
              title={t("sidebar.sort")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24, padding: 0, flexShrink: 0,
                background: sortDropdownOpen ? "var(--bg-hover)" : "none", border: "none",
                color: sortDropdownOpen ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer", borderRadius: 4, transition: "background 0.1s, color 0.1s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
              onMouseLeave={(e) => { if (!sortDropdownOpen) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <line x1="2" y1="4" x2="12" y2="4" />
                <line x1="4" y1="7" x2="10" y2="7" />
                <line x1="6" y1="10" x2="8" y2="10" />
              </svg>
            </button>
            {sortDropdownOpen && (
              <div
                id="sidebar-sort-dropdown"
                style={{
                  position: "absolute", right: 0, top: "100%", marginTop: 4,
                  background: "var(--bg-panel)", border: "1px solid var(--border)",
                  borderRadius: 8, padding: "4px 0", minWidth: 130, zIndex: 300,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
                }}
                onClick={() => setSortDropdownOpen(false)}
              >
                {([
                  { key: "recent", label: t("sidebar.sortRecent") },
                  { key: "created", label: t("sidebar.sortCreated") },
                  { key: "name", label: t("sidebar.sortName") },
                ] as const).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => handleSortChange(key)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      width: "100%", padding: "7px 12px",
                      background: projectSort === key ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "none",
                      border: "none",
                      color: projectSort === key ? "var(--accent)" : "var(--text-muted)",
                      cursor: "pointer", fontSize: 12, textAlign: "left",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = projectSort === key
                        ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                        : "none";
                    }}
                  >
                    {label}
                    {projectSort === key && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" style={{ marginLeft: "auto", flexShrink: 0 }}>
                        <polyline points="2 6 5 9 10 3" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "0", minHeight: 80 }}>
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.loading")}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && !searchQuery && recentProjects.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.noSessions")}
          </div>
        )}
        {!loading && !error && searchQuery && filteredProjects.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-dim)", fontSize: 12 }}>
            {t("sidebar.noMatchingProjects")}
          </div>
        )}

        {/* Search box between title and project list */}
        <div style={{ position: "relative", padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
          <input
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setProjectFilter(""); }}
            placeholder={t("sidebar.searchProjects")}
            style={{
              width: "100%",
              padding: "6px 10px 6px 28px",
              background: "var(--bg-hover)",
              border: "1px solid var(--border)",
              borderRadius: 7,
              fontSize: 12,
              color: "var(--text)",
              outline: "none",
              boxSizing: "border-box",
              transition: "border-color 0.15s, background 0.15s",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "rgba(37,99,235,0.4)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
          />
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", left: 18, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          {projectFilter && (
            <button
              onClick={() => setProjectFilter("")}
              title={t("sidebar.cancel")}
              style={{
                position: "absolute", right: 16, top: "50%", transform: "translateY(-50%)",
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 18, height: 18, padding: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {filteredProjects.map((project) => (
          <ProjectGroupItem
            key={project}
            projectRoot={project}
            sessions={visibleSessionsFor(project)}
            pendingSessions={pendingByProject.get(project) ?? []}
            isExpanded={isProjectExpanded(project)}
            activity={projectActivity.get(project)}
            homeDir={homeDir}
            selectedSessionId={selectedSessionId}
            runningSessionIds={runningSessionIds}
            unreadSessionIds={unreadSessionIds}
            onSelectSession={handleSelectSessionFromList}
            onActivateProject={handleActivateProject}
            onToggleCollapse={() => toggleProjectCollapsed(project)}
            onNewSessionHere={() => handleNewSession(project)}
            onDeleteProjectRequest={handleDeleteProjectRequest}
            onRenamed={loadSessions}
            onSessionDeleted={(id) => {
              onSessionDeleted?.(id);
              loadSessions();
            }}
          />
        ))}

      </div>

      {/* Delete project confirmation */}
      {deleteProjectConfirm && (
        <div
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 999,
          }}
          onClick={() => setDeleteProjectConfirm(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "20px 22px",
              maxWidth: 340,
              width: "100%",
              boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                {t("sidebar.deleteProject")}
              </span>
            </div>
            <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("sidebar.deleteProjectConfirm", {
                count: deleteProjectConfirm.sessionCount,
                name: displayCwd(deleteProjectConfirm.projectRoot, homeDir),
              })}
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setDeleteProjectConfirm(null)}
                style={{
                  height: 32, padding: "0 14px",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", fontSize: 13, fontWeight: 500,
                }}
              >
                {t("sidebar.cancel")}
              </button>
              <button
                onClick={handleDeleteProjectConfirm}
                style={{
                  height: 32, padding: "0 14px",
                  background: "#ef4444", border: "none",
                  borderRadius: 7, color: "#fff",
                  cursor: "pointer", fontSize: 13, fontWeight: 600,
                }}
              >
                {t("sidebar.delete")}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function ProjectGroupItem({
  projectRoot,
  sessions,
  pendingSessions,
  isExpanded,
  activity,
  homeDir,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  onSelectSession,
  onActivateProject,
  onToggleCollapse,
  onNewSessionHere,
  onDeleteProjectRequest,
  onRenamed,
  onSessionDeleted,
}: {
  projectRoot: string;
  sessions: SessionInfo[];
  /** Running placeholders for brand-new sessions in this project not yet on disk. */
  pendingSessions: SessionInfo[];
  isExpanded: boolean;
  activity?: { running: number; unread: number };
  homeDir: string;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onActivateProject: (project: string) => void;
  onToggleCollapse: () => void;
  onNewSessionHere: () => void;
  onDeleteProjectRequest: (projectRoot: string) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);

  // Build the parent-child tree within this project's (filtered) sessions.
  const sessionTree = useMemo(() => buildSessionTree(sessions), [sessions]);

  // Project display name: trailing path segment (with ~ for home).
  const projectName = useMemo(() => {
    const display = displayCwd(projectRoot, homeDir);
    const parts = display.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || display || projectRoot;
  }, [projectRoot, homeDir]);

  return (
    <div>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 32,
          paddingLeft: 10,
          paddingRight: 8,
          cursor: "pointer",
          background: hovered ? "var(--bg-hover)" : "transparent",
          borderLeft: "2px solid transparent",
          transition: "background 0.1s",
        }}
      >
        {/* Collapse toggle — only folds/expands, does not activate the project */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          title={isExpanded ? t("sidebar.collapseProject") : t("sidebar.expandProject")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 16, height: 16, padding: 0, flexShrink: 0,
            background: "none", border: "none",
            color: "var(--text-dim)", cursor: "pointer",
            transform: isExpanded ? "none" : "rotate(-90deg)",
            transition: "transform 0.15s",
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>

        {/* Folder icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>

        {/* Project name + activity — clicking activates the project */}
        <button
          onClick={() => onActivateProject(projectRoot)}
          title={displayCwd(projectRoot, homeDir)}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            padding: 0,
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 500,
            textAlign: "left",
            overflow: "hidden",
          }}
        >
          <PathLabel text={projectName} style={{ fontFamily: "var(--font-mono)" }} />
          {showProjectActivity(activity, t)}
        </button>

        {/* New session + delete project — visible on hover */}
        {hovered && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); onNewSessionHere(); }}
              title={t("sidebar.newSessionHere")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 22, height: 22, padding: 0, flexShrink: 0,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text-muted)",
                cursor: "pointer",
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDeleteProjectRequest(projectRoot); }}
              title={t("sidebar.deleteProject")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 22, height: 22, padding: 0, flexShrink: 0,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text-muted)",
                cursor: "pointer",
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                e.currentTarget.style.color = "#ef4444";
                e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
          </>
        )}
      </div>

      {/* Session tree within this project */}
      {isExpanded && (
        <div>
          {sessionTree.length === 0 && pendingSessions.length === 0 ? (
            <div style={{ padding: "8px 14px 10px 28px", color: "var(--text-dim)", fontSize: 11 }}>
              {t("sidebar.emptyProject")}
            </div>
          ) : (
            <>
              {sessionTree.map((node) => (
                <SessionTreeItem
                  key={node.session.id}
                  node={node}
                  selectedSessionId={selectedSessionId}
                  runningSessionIds={runningSessionIds}
                  unreadSessionIds={unreadSessionIds}
                  onSelectSession={onSelectSession}
                  onRenamed={onRenamed}
                  onSessionDeleted={onSessionDeleted}
                  depth={0}
                />
              ))}
              {/* Running placeholders — new sessions sent but not yet on disk.
                  They carry the running indicator and drop once the real item
                  lands in allSessions (same id reconciles the row). */}
              {pendingSessions.map((s) => (
                <SessionTreeItem
                  key={s.id}
                  node={{ session: s, children: [] }}
                  selectedSessionId={selectedSessionId}
                  runningSessionIds={runningSessionIds}
                  unreadSessionIds={unreadSessionIds}
                  onSelectSession={onSelectSession}
                  onRenamed={onRenamed}
                  onSessionDeleted={onSessionDeleted}
                  depth={0}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          isRunning={runningSessionIds.has(node.session.id)}
          isUnread={unreadSessionIds.has(node.session.id)}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.agentRunning")}
      aria-label={t("sidebar.agentRunning")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.newActivity")}
      aria-label={t("sidebar.newSessionActivity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

/**
 * Compact per-project activity badges for the workspace selector dropdown items:
 * a spinning running icon + count and an unread dot + count. Renders nothing
 * when the project has no activity. Counts share the accent / unread colors of
 * the per-session indicators so the two stay visually consistent.
 */
function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
  t: (key: string) => string,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6 }}>
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
            </g>
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#0891b2", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Select the whole name once the rename input is mounted (startRename's
  // immediate setTimeout can fire before the input exists).
  useEffect(() => {
    if (renaming) {
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renaming]);

  const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12));
    setRenaming(true);
  }, [session.name, session.firstMessage, session.id]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    // No-op when unchanged: the fallback title (first message / id) isn't a
    // real stored name, so don't persist it as one.
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed, title]);

  const performDelete = useCallback(async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, onDeleted]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey) {
      void performDelete();
    } else {
      setConfirmDelete(true);
    }
  }, [performDelete]);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = 54;

  return (
    <div
      onClick={confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
          paddingLeft: depth > 0 ? depth * 12 + 14 : 22,
        paddingRight: 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: confirmDelete
          ? "2px solid #ef4444"
          : isSelected ? "2px solid color-mix(in srgb, var(--text-muted) 35%, var(--border))" : "2px solid transparent",
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.deleteSession", { title: title.slice(0, 22) + (title.length > 22 ? "…" : "") })}
          </div>
          {/* Order: [取消] [删除] — 删除按钮贴右边缘，与删除图标位置重合，连点两下即可删除 */}
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.cancel")}
            </button>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("sidebar.delete")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Child session indicator: subagent (bot) vs fork (branch) */}
          {depth > 0 && session.isSubagent ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-label="Subagent">
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <circle cx="12" cy="5" r="2.5" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
          ) : depth > 0 ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-label="Fork">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          ) : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: 12,
                fontWeight: isSelected ? 500 : 400,
                lineHeight: 1.4,
                color: "var(--text)",
              }}
              title={title}
            >
              {session.isSubagent && (
                <span style={{
                  display: "inline-flex", alignItems: "center", flexShrink: 0,
                  padding: "0 5px", height: 16, borderRadius: 3,
                  fontSize: 9, fontWeight: 600, letterSpacing: "0.03em",
                  background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                  color: "var(--accent)",
                }}>
                  AGENT
                </span>
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
            </div>
            <div style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 11, minWidth: 0 }}>
              {isRunning ? (
                <RunningSessionIndicator />
              ) : isUnread ? (
                <UnreadSessionIndicator />
              ) : (
                <span title={session.modified}>{formatRelativeTime(session.modified)}</span>
              )}
              <span>{t("sidebar.messagesCount", { count: session.messageCount })}</span>
            </div>
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? "Expand forks" : "Collapse forks"}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Action buttons — shown on hover */}
          {hovered && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <button
                onClick={startRename}
                title={t("sidebar.rename")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                onClick={handleDeleteClick}
                title={t("sidebar.deleteWithShiftClick")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                  e.currentTarget.style.color = "#ef4444";
                  e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
