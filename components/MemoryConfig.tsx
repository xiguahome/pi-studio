"use client";

// 记忆管理面板：pi-hermes-memory 的 markdown 权威源可视化 + 条目级编辑。
//
// 数据走 /api/memory（读）与 /api/memory/update（增删改）——/api/files 的
// allowed roots 不覆盖 ~/.pi-studio，必须走域内 API（与 experts 一致）。
// 检索镜像（SQLite memories 表）是派生数据，不在此展示：编辑写入 markdown
// 后，插件在下一次记忆操作时会自动 reconcile；「立即同步镜像」按钮向当前
// 会话发送 /memory-sync-markdown 扩展命令以触发即时全量重建。

import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";

type MemoryTargetKey = "memory" | "user" | "failure" | "project";

interface MemoryEntryView {
  text: string;
  created: string;
  last: string;
  project: string | null;
  category: string | null;
}

interface MemoryTargetData {
  entries: MemoryEntryView[];
  usage: { current: number; limit: number; percent: number; entryCount: number };
}

interface MemoryData {
  projectName: string;
  memory: MemoryTargetData;
  user: MemoryTargetData;
  failure: MemoryTargetData;
  project: MemoryTargetData;
}

const TARGET_KEYS: MemoryTargetKey[] = ["memory", "user", "failure", "project"];

const FAILURE_CATEGORIES = [
  "failure",
  "correction",
  "insight",
  "preference",
  "convention",
  "tool-quirk",
] as const;

const categoryColors: Record<string, string> = {
  failure: "#f87171",
  correction: "#fbbf24",
  insight: "#34d399",
  preference: "#60a5fa",
  convention: "#a78bfa",
  "tool-quirk": "#f472b6",
};

export function MemoryConfig({
  cwd,
  sessionId,
  onClose,
  embedded = false,
}: {
  cwd: string;
  sessionId: string | null;
  onClose?: () => void;
  embedded?: boolean;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [data, setData] = useState<MemoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<MemoryTargetKey>("memory");
  const [notice, setNotice] = useState<string | null>(null);

  // 条目编辑 / 新增状态
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addText, setAddText] = useState("");
  const [addCategory, setAddCategory] = useState<string>("insight");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // 弹性提示（保存/同步结果），3.5s 后自动消失
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((message: string, durationMs = 3500) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  const load = useCallback(async (): Promise<MemoryData | null> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/memory?cwd=${encodeURIComponent(cwd)}`);
      const body = await res.json() as (Partial<MemoryData> & { error?: string }) | null;
      if (!res.ok || !body || body.error || !body.memory) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setData(body as MemoryData);
      return body as MemoryData;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (op: {
      target: MemoryTargetKey;
      action: "add" | "replace" | "remove";
      text?: string;
      newText?: string;
      project?: string | null;
    }) => {
      setBusy(true);
      try {
        const res = await fetch("/api/memory/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, ...op }),
        });
        const body = await res.json().catch(() => null) as { success?: boolean; error?: string } | null;
        if (!res.ok || !body?.success) {
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        await load();
        showNotice(t("memory.savedMirrorHint"));
        return true;
      } catch (e) {
        if (typeof window !== "undefined") {
          window.alert(`${t("memory.saveFailed")}: ${e instanceof Error ? e.message : String(e)}`);
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [cwd, load, showNotice, t],
  );

  const targetLabel = useCallback(
    (key: MemoryTargetKey): string => {
      switch (key) {
        case "user":
          return t("memory.targetUser");
        case "failure":
          return t("memory.targetFailure");
        case "project":
          return data ? `${t("memory.targetProject")} · ${data.projectName}` : t("memory.targetProject");
        default:
          return t("memory.targetMemory");
      }
    },
    [data, t],
  );

  const handleSyncMirror = useCallback(async () => {
    if (!sessionId) {
      showNotice(t("memory.syncNoSession"));
      return;
    }
    setSyncing(true);
    try {
      await sendAgentCommand(sessionId, { type: "prompt", message: "/memory-sync-markdown" });
      showNotice(t("memory.syncSent"));
    } catch (e) {
      showNotice(`${t("memory.syncFailed")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  }, [sessionId, showNotice, t]);

  const activeData = data ? data[active] : null;

  // 项目记忆只在当前项目存在记忆条目时展示：没有当前项目记忆就隐藏入口。
  const visibleTargets = data
    ? TARGET_KEYS.filter(
        (key) => key !== "project" || (data.project.usage.entryCount ?? 0) > 0,
      )
    : TARGET_KEYS;

  // active 指向被隐藏的 target（如项目记忆为空）时回退到第一个可见项。
  useEffect(() => {
    if (!data) return;
    if (!visibleTargets.includes(active)) setActive(visibleTargets[0] ?? "memory");
  }, [data, visibleTargets, active]);

  const handleAdd = useCallback(async () => {
    const raw = addText.trim();
    if (!raw) return;
    const content = active === "failure" ? `[${addCategory}] ${raw}` : raw;
    const ok = await mutate({ target: active, action: "add", text: content });
    if (ok) {
      setAddText("");
      setAddOpen(false);
    }
  }, [active, addCategory, addText, mutate]);

  const handleSaveEdit = useCallback(async (entry: MemoryEntryView) => {
    const content = editText.trim();
    if (!content) return;
    const ok = await mutate({
      target: active,
      action: "replace",
      text: entry.text,
      newText: content,
      project: entry.project,
    });
    if (ok) {
      setEditIndex(null);
      setEditText("");
    }
  }, [active, editText, mutate]);

  const handleRemove = useCallback(async (entry: MemoryEntryView) => {
    if (typeof window !== "undefined" && !window.confirm(t("memory.deleteConfirm"))) return;
    await mutate({ target: active, action: "remove", text: entry.text, project: entry.project });
  }, [active, mutate, t]);

  const usageBar = (usage: MemoryTargetData["usage"]) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
      <div
        style={{
          flex: 1,
          height: 4,
          borderRadius: 2,
          background: "var(--border)",
          overflow: "hidden",
          minWidth: 40,
        }}
      >
        <div
          style={{
            width: `${Math.min(100, usage.percent)}%`,
            height: "100%",
            background: usage.percent >= 90 ? "#f87171" : "var(--accent)",
            transition: "width 0.15s",
          }}
        />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
        {usage.current}/{usage.limit}
      </span>
    </div>
  );

  const entryCard = (entry: MemoryEntryView, index: number) => {
    const editing = editIndex === index;
    return (
      <div
        key={`${entry.created}-${entry.text.slice(0, 40)}-${index}`}
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "10px 12px",
          background: "var(--bg-panel)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {entry.category && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                color: categoryColors[entry.category] ?? "var(--text-muted)",
                border: `1px solid ${categoryColors[entry.category] ?? "var(--border)"}`,
                fontFamily: "var(--font-mono)",
              }}
            >
              {entry.category}
            </span>
          )}
          {entry.project && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 4,
                color: "var(--text-muted)",
                border: "1px solid var(--border)",
                fontFamily: "var(--font-mono)",
              }}
              title={t("memory.projectScope")}
            >
              {entry.project}
            </span>
          )}
          <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {t("memory.created")} {entry.created} · {t("memory.last")} {entry.last}
          </span>
          <span style={{ flex: 1 }} />
          {!editing && (
            <>
              <button
                onClick={() => {
                  setEditIndex(index);
                  setEditText(entry.text);
                }}
                disabled={busy}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: busy ? "wait" : "pointer",
                  fontSize: 12,
                  padding: "2px 6px",
                }}
              >
                {t("memory.edit")}
              </button>
              <button
                onClick={() => void handleRemove(entry)}
                disabled={busy}
                style={{
                  background: "none",
                  border: "none",
                  color: "#f87171",
                  cursor: busy ? "wait" : "pointer",
                  fontSize: 12,
                  padding: "2px 6px",
                }}
              >
                {t("memory.delete")}
              </button>
            </>
          )}
        </div>
        {editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={4}
              style={{
                width: "100%",
                boxSizing: "border-box",
                resize: "vertical",
                fontSize: 13,
                fontFamily: "var(--font-mono)",
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setEditIndex(null);
                  setEditText("");
                }}
                disabled={busy}
                style={secondaryButtonStyle}
              >
                {t("memory.cancel")}
              </button>
              <button
                onClick={() => void handleSaveEdit(entry)}
                disabled={busy || !editText.trim()}
                style={primaryButtonStyle}
              >
                {t("memory.save")}
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              fontSize: 13,
              color: "var(--text)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: 1.5,
            }}
          >
            {entry.text}
          </div>
        )}
      </div>
    );
  };

  const primaryButtonStyle: React.CSSProperties = {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "5px 14px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };

  const secondaryButtonStyle: React.CSSProperties = {
    background: "none",
    color: "var(--text-muted)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "5px 14px",
    fontSize: 12,
    cursor: "pointer",
  };

  return (
    <div
      style={embedded
        ? { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }
        : {
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
      onClick={embedded ? undefined : (e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        style={embedded
          ? { flex: 1, minWidth: 0, minHeight: 0, background: "var(--bg)", display: "flex", flexDirection: "column", overflow: "hidden" }
          : {
              width: isMobile ? "calc(100vw - 16px)" : 860,
              maxWidth: "calc(100vw - 16px)",
              height: isMobile ? "calc(100dvh - 16px)" : "75vh",
              maxHeight: "calc(100dvh - 16px)",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
              overflow: "hidden",
            }}
      >
        {/* Header */}
        {!embedded && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 18px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              {t("memory.title")}
            </span>
            <button onClick={() => onClose?.()} style={closeButtonStyle}>×</button>
          </div>
        )}

        {/* 工具条 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
            {t("memory.title")}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("memory.mirrorHint")}</span>
          <span style={{ flex: 1 }} />
          {notice && (
            <span style={{ fontSize: 11, color: "var(--accent)", maxWidth: 320 }}>{notice}</span>
          )}
          <button
            onClick={() => void load()}
            disabled={loading}
            style={secondaryButtonStyle}
            title={t("memory.refresh")}
          >
            {loading ? t("memory.loading") : t("memory.refresh")}
          </button>
          <button
            onClick={() => void handleSyncMirror()}
            disabled={syncing || !sessionId}
            title={sessionId ? t("memory.syncTooltip") : t("memory.syncNoSession")}
            style={{ ...secondaryButtonStyle, cursor: sessionId ? "pointer" : "not-allowed", opacity: sessionId ? 1 : 0.5 }}
          >
            {syncing ? t("memory.syncing") : t("memory.sync")}
          </button>
        </div>

        {/* Body */}
        {loading && !data ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "var(--text-muted)" }}>
            {t("memory.loading")}
          </div>
        ) : error ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: "#f87171" }}>{error}</span>
            <button onClick={() => void load()} style={secondaryButtonStyle}>{t("memory.refresh")}</button>
          </div>
        ) : data && activeData ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: isMobile ? "column" : "row",
              overflow: "hidden",
              minHeight: 0,
            }}
          >
            {/* 左：目标列表 */}
            <div
              style={{
                width: isMobile ? "100%" : 190,
                flexShrink: 0,
                borderRight: isMobile ? "none" : "1px solid var(--border)",
                borderBottom: isMobile ? "1px solid var(--border)" : "none",
                background: "var(--bg-panel)",
                padding: "8px 6px",
                display: "flex",
                flexDirection: "column",
                gap: 2,
                overflow: "auto",
              }}
            >
              {visibleTargets.map((key) => {
                const targetData = data[key];
                const activeItem = active === key;
                return (
                  <button
                    key={key}
                    onClick={() => {
                      setActive(key);
                      setEditIndex(null);
                      setAddOpen(false);
                    }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: "none",
                      background: activeItem ? "var(--bg-selected)" : "none",
                      color: activeItem ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: activeItem ? 600 : 400,
                      textAlign: "left",
                    }}
                    onMouseEnter={(e) => {
                      if (!activeItem) e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!activeItem) e.currentTarget.style.background = "none";
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {targetLabel(key)}
                    </span>
                    {usageBar(targetData.usage)}
                  </button>
                );
              })}
            </div>

            {/* 右：条目列表 */}
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 16px",
                  flexShrink: 0,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                  {targetLabel(active)}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {t("memory.entryCount", { count: activeData.usage.entryCount })}
                </span>
                <span style={{ flex: 1 }} />
                {activeData.usage.entryCount > 0 && (
                  <div style={{ width: isMobile ? "40%" : 180 }}>{usageBar(activeData.usage)}</div>
                )}
                <button
                  onClick={() => {
                    setAddOpen((v) => !v);
                    setEditIndex(null);
                  }}
                  disabled={busy}
                  style={primaryButtonStyle}
                >
                  {t("memory.add")}
                </button>
              </div>

              <div
                style={{
                  flex: 1,
                  overflow: "auto",
                  padding: "0 16px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {addOpen && (
                  <div
                    style={{
                      border: "1px dashed var(--border)",
                      borderRadius: 8,
                      padding: "10px 12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    {active === "failure" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("memory.category")}</span>
                        <select
                          value={addCategory}
                          onChange={(e) => setAddCategory(e.target.value)}
                          style={{
                            fontSize: 12,
                            padding: "3px 6px",
                            borderRadius: 4,
                            border: "1px solid var(--border)",
                            background: "var(--bg)",
                            color: "var(--text)",
                          }}
                        >
                          {FAILURE_CATEGORIES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <textarea
                      value={addText}
                      onChange={(e) => setAddText(e.target.value)}
                      rows={3}
                      placeholder={t("memory.contentPlaceholder")}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        resize: "vertical",
                        fontSize: 13,
                        fontFamily: "var(--font-mono)",
                        padding: "8px 10px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "var(--bg)",
                        color: "var(--text)",
                      }}
                    />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button
                        onClick={() => {
                          setAddOpen(false);
                          setAddText("");
                        }}
                        disabled={busy}
                        style={secondaryButtonStyle}
                      >
                        {t("memory.cancel")}
                      </button>
                      <button
                        onClick={() => void handleAdd()}
                        disabled={busy || !addText.trim()}
                        style={primaryButtonStyle}
                      >
                        {t("memory.add")}
                      </button>
                    </div>
                  </div>
                )}

                {activeData.entries.length === 0 && !addOpen && (
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 13,
                      color: "var(--text-dim)",
                    }}
                  >
                    {t("memory.empty")}
                  </div>
                )}

                {activeData.entries.map((entry, index) => entryCard(entry, index))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 20,
  lineHeight: 1,
  padding: "2px 6px",
};
