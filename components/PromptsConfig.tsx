"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJsonWithRetry } from "@/lib/resilient-fetch";
import { useI18n } from "@/hooks/useI18n";

type PromptScope = "global" | "project";

interface PromptFileInfo {
  path: string;
  content: string;
  exists: boolean;
}

interface PromptsApiResponse {
  global: PromptFileInfo;
  project: PromptFileInfo | null;
}

/**
 * 「提示词」设置面板（embedded in SettingsDialog）：以 tab 切换编辑
 * 全局提示词（~/.pi-studio/AGENTS.md）与项目提示词（<cwd>/AGENTS.md）。
 *
 * 这两个文件是 pi 构建 system prompt 时自动加载的上下文文件（AGENTS.md），
 * 全局对所有项目生效、项目仅对当前项目生效；保存后新建或重载的会话生效。
 */
export function PromptsConfig({ embedded = false, cwd }: { embedded?: boolean; cwd: string | null }) {
  const { t } = useI18n();
  const [scope, setScope] = useState<PromptScope>("global");
  const [data, setData] = useState<PromptsApiResponse | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<PromptScope, string>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async (): Promise<PromptsApiResponse> => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    // 403（allow-list 竞态）自动重试一次；全局无 cwd 时不会 403，重试无副作用。
    const d = await fetchJsonWithRetry<PromptsApiResponse>(`/api/prompts${query}`);
    setData(d);
    return d;
  }, [cwd]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .then((d) => {
        if (!cancelled) {
          setDrafts({ global: d.global.content, project: d.project?.content ?? "" });
        }
      })
      .catch((e) => {
        if (!cancelled) setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const file = data ? (scope === "global" ? data.global : data.project) : null;
  const draft = drafts[scope] ?? "";
  const dirty = file ? draft !== file.content : draft.trim() !== "";

  function switchScope(next: PromptScope) {
    setScope(next);
    setMessage(null);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/prompts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: cwd ?? undefined, [scope]: draft }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setMessage({ kind: "ok", text: t("prompts.saved") });
      // 只刷新当前 scope 的草稿，保留另一个 tab 未保存的编辑
      const updated = await load();
      setDrafts((prev) => ({ ...prev, [scope]: updated[scope]?.content ?? "" }));
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  function resetDraft() {
    if (!file) return;
    setDrafts((prev) => ({ ...prev, [scope]: file.content }));
    setMessage(null);
  }

  return (
    <div
      style={
        embedded
          ? { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", padding: 20, gap: 16 }
          : { display: "flex", flexDirection: "column", padding: 20, gap: 16 }
      }
    >
      {/* 头部说明 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("prompts.title")}</span>
        <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>{t("prompts.desc")}</span>
      </div>

      {/* tab 切换：全局 / 项目 */}
      <div style={{ display: "flex", gap: 6 }}>
        {(["global", "project"] as const).map((key) => {
          const disabled = key === "project" && !cwd;
          const active = scope === key;
          return (
            <button
              key={key}
              onClick={() => {
                if (!disabled) switchScope(key);
              }}
              disabled={disabled}
              title={disabled ? t("prompts.projectNoCwd") : undefined}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                borderRadius: 6,
                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                background: active ? "var(--bg-selected)" : "none",
                color: disabled ? "var(--text-dim)" : active ? "var(--text)" : "var(--text-muted)",
                cursor: disabled ? "not-allowed" : "pointer",
                fontWeight: active ? 600 : 400,
              }}
            >
              {key === "global" ? t("prompts.scopeGlobal") : t("prompts.scopeProject")}
            </button>
          );
        })}
      </div>

      {/* 目标文件路径 */}
      {file && (
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            overflowWrap: "anywhere",
          }}
        >
          {file.path}
          {!file.exists && <span style={{ color: "var(--text-dim)" }}>（{t("prompts.notExist")}）</span>}
        </span>
      )}

      {/* 编辑区 */}
      <textarea
        value={draft}
        onChange={(e) => setDrafts((prev) => ({ ...prev, [scope]: e.target.value }))}
        placeholder={t("prompts.placeholder")}
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: 240,
          resize: "vertical",
          padding: "10px 12px",
          fontSize: 12,
          lineHeight: 1.6,
          fontFamily: "var(--font-mono)",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          color: "var(--text)",
          outline: "none",
          boxSizing: "border-box",
        }}
      />

      {/* 生效提示 + 操作按钮 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          onClick={() => void save()}
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
        <button
          onClick={resetDraft}
          disabled={!dirty}
          style={{
            padding: "7px 14px",
            fontSize: 13,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "none",
            color: "var(--text-muted)",
            cursor: dirty ? "pointer" : "not-allowed",
          }}
        >
          {t("prompts.reset")}
        </button>
        {message && (
          <span style={{ fontSize: 12, color: message.kind === "ok" ? "#4ade80" : "#f87171" }}>
            {message.text}
          </span>
        )}
      </div>
      {!loading && (
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("prompts.newSessionNote")}</span>
      )}
    </div>
  );
}
