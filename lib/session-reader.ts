import {
  SessionManager,
  buildContextEntries as piBuildContextEntries,
  buildSessionContext as piBuildSessionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, rmSync } from "fs";
import { join, normalize as normalizePath, resolve } from "path";
import type { AgentMessage, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
import { sessionPathKey } from "./session-path";
import { resolveProject, type ProjectInfo } from "./worktree";

export { getAgentDir };

// ============================================================================
// Project directory discovery
//
// SessionManager.listAll() only returns sessions that have a .jsonl file. But
// ~/.pi-studio/sessions/ also contains one subdirectory per cwd — including dirs
// whose only session was deleted, or dirs created by "Open project" before any
// message was sent. listProjectDirs() scans those subdirectories so projects
// with zero sessions still appear in the sidebar.
//
// Each subdir name is an encoded cwd (see SDK getDefaultSessionDirPath):
//   safePath = "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--"
// e.g. "D:\wwwroot\pi-studio" -> "--D--wwwroot-pi-studio--"
//
// The inverse is ambiguous: a literal "-" in a path segment (like "pi-studio")
// is indistinguishable from a separator. We resolve it with existsSync() —
// trying each hyphen as a split point (greedy, earliest first) and accepting
// the interpretation whose prefix actually exists on disk.
// ============================================================================

/** Recover the original path from an encoded segment under a known prefix. */
function recoverPath(prefix: string, encoded: string, sep: string): string | null {
  const indices: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "-") indices.push(i);
  }

  // No hyphens left: the whole string is the final segment.
  if (indices.length === 0) {
    const candidate = prefix + encoded;
    return existsSync(candidate) ? candidate : null;
  }

  // Try each hyphen as the split point: everything before it (including any
  // earlier hyphens) is one literal segment, it is the separator, recurse on
  // the rest. Greedy — earliest split first.
  for (const idx of indices) {
    const segment = encoded.slice(0, idx);
    const rest = encoded.slice(idx + 1);
    const nextPrefix = prefix + segment + sep;
    if (existsSync(nextPrefix)) {
      const result = recoverPath(nextPrefix, rest, sep);
      if (result) return result;
    }
  }

  // No hyphen worked as a separator: treat the whole encoded string as one
  // literal segment (e.g. a single directory name that contains hyphens).
  const candidate = prefix + encoded;
  return existsSync(candidate) ? candidate : null;
}

/** Decode an encoded session-directory name back to its original cwd. */
function decodeSessionDirName(dirName: string): string | null {
  const match = dirName.match(/^--(.+)--$/);
  if (!match) return null;
  const encoded = match[1];
  // Windows drive letter: "D--..." means "D:\"
  const drive = encoded.match(/^([A-Za-z])--(.*)$/);
  if (drive) {
    return recoverPath(`${drive[1]}:\\`, drive[2], "\\");
  }
  // Unix absolute path: restore the leading "/"
  return recoverPath("/", encoded, "/");
}

function computeProjectDirs(): string[] {
  try {
    const sessionsDir = join(getAgentDir(), "sessions");
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    const cwds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const cwd = decodeSessionDirName(entry.name);
      if (cwd) cwds.push(cwd);
    }
    return cwds;
  } catch {
    return [];
  }
}

const PROJECT_DIRS_CACHE_TTL_MS = 30_000;

// Stored on globalThis (not a module-local `let`) so the cache is shared across
// every route-handler module instance. Next.js bundles each API route with its
// own copy of lib/session-reader; a module-local cache would then be per-route,
// so removeProjectDir() invalidating the cache in the DELETE route would NOT be
// seen by listProjectDirs() in the GET /api/sessions route — leaving a deleted
// project's cwd lingering in the sidebar for up to PROJECT_DIRS_CACHE_TTL_MS.
function getProjectDirsCache(): { data: string[]; ts: number } | null {
  return globalThis.__piProjectDirsCache ?? null;
}

function setProjectDirsCache(value: { data: string[]; ts: number } | null): void {
  globalThis.__piProjectDirsCache = value ?? undefined;
}

/** All project cwds discovered from ~/.pi-studio/sessions/ subdirectories. */
export function listProjectDirs(): string[] {
  const cache = getProjectDirsCache();
  if (cache && Date.now() - cache.ts < PROJECT_DIRS_CACHE_TTL_MS) {
    return cache.data;
  }
  const data = computeProjectDirs();
  setProjectDirsCache({ data, ts: Date.now() });
  return data;
}

/**
 * Mirror the SDK's getDefaultSessionDirPath encoding (the SDK does not export
 * it): resolve to absolute, strip a leading separator, replace / \ : with "-",
 * wrap in "--". e.g. "D:\wwwroot\pi-studio" -> "--D--wwwroot-pi-studio--".
 */
function encodeSessionDirName(cwd: string): string {
  const resolved = resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Ensure ~/.pi-studio/sessions/ contains a subdirectory for this cwd so the
 * project shows up in the sidebar immediately — before any session is created.
 * Idempotent; safe to call on every cwd selection.
 */
export function ensureProjectDir(cwd: string): void {
  try {
    const dir = join(getAgentDir(), "sessions", encodeSessionDirName(cwd));
    // Only invalidate the session-list cache when a new project directory is
    // actually created. Re-selecting an existing project must not blow away the
    // 30s cache — that would force the next /api/sessions to re-scan every
    // .jsonl on disk, which is the main cause of switch-project lag.
    if (existsSync(dir)) return;
    mkdirSync(dir, { recursive: true });
    invalidateSessionListCache();
  } catch {
    // best-effort — never block a cwd switch on a directory-create failure.
  }
}

/**
 * Remove the session-storage subdirectory for a cwd so a project that has had
 * all of its sessions deleted stops reappearing in the sidebar. This only
 * touches pi-studio's own data under ~/.pi-studio/sessions/ — never the user's
 * actual project directory. Best-effort; failures are swallowed.
 */
export function removeProjectDir(cwd: string): void {
  try {
    const dir = join(getAgentDir(), "sessions", encodeSessionDirName(cwd));
    rmSync(dir, { recursive: true, force: true });
    invalidateSessionListCache();
  } catch {
    // best-effort — never block a project delete on a directory-remove failure.
  }
}

async function loadAllSessions(): Promise<SessionInfo[]> {
  const piSessions: PiSessionInfo[] = await SessionManager.listAll();
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(sessionPathKey(s.path), s.id);

  // Resolve each unique cwd to its project root (main repo shared by all
  // worktrees). resolveProject caches per-cwd, so this is cheap after warmup.
  const uniqueCwds = [...new Set(piSessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  const mainSessions: SessionInfo[] = piSessions.map((s) => {
    cacheSessionPath(s.id, s.path);
    const project = s.cwd ? projectByCwd.get(s.cwd) : undefined;
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath ? pathToId.get(sessionPathKey(s.parentSessionPath)) : undefined,
      projectRoot: project?.projectRoot ?? s.cwd,
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    };
  });

  // Scan for subagent child sessions.
  // pi-subagents stores child sessions in a subdirectory named after the parent
  // session file (without extension), e.g.:
  //   sessions/<encoded-cwd>/<parent-timestamp>_<parent-id>.jsonl
  //   sessions/<encoded-cwd>/<parent-timestamp>_<parent-id>/run-0/session.jsonl
  // These are invisible to SessionManager.listAll() which only scans top-level
  // .jsonl files. We discover them here and link them to their parent session
  // via parentSessionId.
  const subagentSessions = discoverSubagentSessions(mainSessions, projectByCwd);

  return [...mainSessions, ...subagentSessions];
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const generation = globalThis.__piSessionListGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  if (globalThis.__piSessionListCache && Date.now() - globalThis.__piSessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return globalThis.__piSessionListCache.data;
  }

  // Coalescing dedup: concurrent callers share the same in-flight promise
  // only while it belongs to the current cache generation.
  if (globalThis.__piSessionListPromise && globalThis.__piSessionListPromiseGeneration === generation) {
    return globalThis.__piSessionListPromise;
  }

  const loadPromise = loadAllSessions().then((data) => {
    // An invalidation may happen while the scan is in flight. Do not let that
    // older result repopulate the cache after a session mutation.
    if ((globalThis.__piSessionListGeneration ?? 0) === generation) {
      globalThis.__piSessionListCache = { data, ts: Date.now() };
    }
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  return trackedPromise;
}

// Discover subagent child sessions stored in nested run directories
// alongside their parent session files.
function discoverSubagentSessions(
  mainSessions: SessionInfo[],
  projectByCwd: Map<string, ProjectInfo>,
): SessionInfo[] {
  const results: SessionInfo[] = [];

  for (const parent of mainSessions) {
    // Derive the expected subagent directory from the parent session path.
    const parentPath = parent.path;
    const baseName = parentPath.replace(/\.jsonl$/, "");
    const subagentDir = baseName;

    try {
      if (!existsSync(subagentDir)) continue;
      const stat = lstatSync(subagentDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Collect run directories. Two layouts exist:
    //   <parent>/run-*/session.jsonl              (direct)
    //   <parent>/<key>/run-*/session.jsonl       (one intermediate dir,
    //                                            e.g. chain-run key)
    let runDirs: string[];
    try {
      runDirs = readdirSync(subagentDir)
        .flatMap((name) => {
          const first = join(subagentDir, name);
          if (name.startsWith("run-")) return [first];
          try {
            // Intermediate layer: scan one level deeper for run-* dirs.
            return readdirSync(first)
              .filter((child) => child.startsWith("run-"))
              .map((child) => join(first, child));
          } catch {
            return [];
          }
        })
        .filter((fullPath) => {
          try {
            return lstatSync(fullPath).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      continue;
    }

    for (const runDir of runDirs) {
      const sessionFile = join(runDir, "session.jsonl");
      try {
        if (!existsSync(sessionFile) || !lstatSync(sessionFile).isFile()) continue;
      } catch {
        continue;
      }

      const header = readSessionHeader(sessionFile);
      if (!header) continue;

      // Count messages cheaply: read lines until EOF, count type=message.
      let messageCount = 0;
      let firstMessage = "";
      let lastMessageTs = header.timestamp;
      try {
        const fd = openSync(sessionFile, "r");
        const buf = Buffer.alloc(8192);
        let partial = "";
        for (;;) {
          const n = readSync(fd, buf, 0, buf.length, null);
          if (n === 0) break;
          partial += buf.subarray(0, n).toString("utf8");
          let nl: number;
          while ((nl = partial.indexOf("\n")) !== -1) {
            const line = partial.slice(0, nl);
            partial = partial.slice(nl + 1);
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.type === "message") {
                messageCount++;
                if (!firstMessage && entry.message?.role === "user") {
                  const text = typeof entry.message.content === "string"
                    ? entry.message.content
                    : Array.isArray(entry.message.content)
                      ? entry.message.content
                          .filter((b: { type: string }) => b.type === "text")
                          .map((b: { text: string }) => b.text)
                          .join(" ")
                      : "";
                  if (text) firstMessage = text.slice(0, 200);
                }
              }
              if (entry.timestamp && entry.timestamp > lastMessageTs) {
                lastMessageTs = entry.timestamp;
              }
            } catch {
              // skip malformed lines
            }
          }
        }
        closeSync(fd);
      } catch {
        // best-effort counting
      }

      // Extract agent name from the run directory name: run-0, run-1, etc.
      const runDirName = runDir.split(/[/\\]/).pop() ?? "run";

      const cwd = header.cwd || parent.cwd;
      const project = cwd ? projectByCwd.get(cwd) : undefined;

      cacheSessionPath(header.id, sessionFile);

      results.push({
        path: sessionFile,
        id: header.id,
        cwd,
        created: header.timestamp,
        modified: lastMessageTs,
        messageCount,
        firstMessage: firstMessage || "(subagent)",
        parentSessionId: parent.id,
        projectRoot: project?.projectRoot ?? cwd,
        isSubagent: true,
        subagentName: runDirName,
      });
    }
  }

  return results;
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number } | undefined;
  var __piProjectDirsCache: { data: string[]; ts: number } | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 30_000;

export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListCache = undefined;
  setProjectDirsCache(null);
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  // Cache miss: scan all sessions to populate cache, then retry
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

  await listAllSessions();
  return getPathToIdCache().get(pathKey);
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const previousPath = pathCache.get(sessionId);
  const previousPathKey = previousPath ? sessionPathKey(previousPath) : undefined;
  const previousSessionId = reverseCache.get(pathKey);
  const previousOwnerPath = previousSessionId ? pathCache.get(previousSessionId) : undefined;
  if (previousPathKey && previousPathKey !== pathKey && reverseCache.get(previousPathKey) === sessionId) {
    reverseCache.delete(previousPathKey);
  }
  if (
    previousSessionId &&
    previousSessionId !== sessionId &&
    previousOwnerPath &&
    sessionPathKey(previousOwnerPath) === pathKey
  ) {
    pathCache.delete(previousSessionId);
  }
  pathCache.set(sessionId, normalizedPath);
  reverseCache.set(pathKey, sessionId);
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const filePath = pathCache.get(sessionId);
  pathCache.delete(sessionId);
  const pathKey = filePath ? sessionPathKey(filePath) : undefined;
  if (pathKey && reverseCache.get(pathKey) === sessionId) {
    reverseCache.delete(pathKey);
  }
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const maxHeaderBytes = 64 * 1024;
    let position = 0;
    let foundNewline = false;

    while (position < maxHeaderBytes && !foundNewline) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxHeaderBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const data = buffer.subarray(0, bytesRead);
      const newlineIndex = data.indexOf(0x0a);
      chunks.push(newlineIndex === -1 ? data : data.subarray(0, newlineIndex));
      position += bytesRead;
      foundNewline = newlineIndex !== -1;
    }

    if (!foundNewline && position >= maxHeaderBytes) return null;
    const firstLine = Buffer.concat(chunks).toString("utf8").trimEnd();
    if (!firstLine) return null;
    try {
      const header = JSON.parse(firstLine) as SessionHeader;
      return header.type === "session" ? header : null;
    } catch {
      return null;
    }
  } finally {
    closeSync(fd);
  }
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean } = {},
): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  const contextEntries = piBuildContextEntries(
    piEntries,
    leafId,
    byId as unknown as Map<string, PiSessionEntry>,
  );

  // Convert the SDK-selected context entries and their IDs together. This keeps
  // fork/navigation targets aligned while preserving pi's compaction ordering.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of contextEntries) {
    const localEntry = entry as unknown as SessionEntry;
    const m = entryToUiMessage(localEntry, options);
    if (m) {
      messages.push(m);
      entryIds.push(localEntry.id);
    }
  }

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
  };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function omitToolResultBase64Images(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
  entry: SessionEntry,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      const message = options.deferToolResultImages
        ? omitToolResultBase64Images(normalizeToolCalls(entry.message))
        : normalizeToolCalls(entry.message);
      if (!options.deferThinking || message.role !== "assistant") return message;
      return {
        ...message,
        content: message.content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: "", deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}
