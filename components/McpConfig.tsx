"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { JsonEditor } from "./JsonEditor";

type McpScope = "global" | "project";
type McpServerType = "http" | "stdio" | "socket" | "unknown";

interface McpServerEntry {
  url?: string;
  command?: string;
  args?: string[];
  disabled?: boolean;
  [key: string]: unknown;
}

interface McpConfigFile {
  scope: McpScope;
  path: string;
  exists: boolean;
  rawText: string;
  servers: Record<string, McpServerEntry>;
  error: string | null;
}

interface EffectiveServer {
  name: string;
  source: McpScope;
  type: McpServerType;
  summary: string;
  disabled: boolean;
  entry: McpServerEntry;
}

interface McpCacheInfo {
  toolCount: number;
  resourceCount: number;
  cachedAt: number | null;
}

interface ProbeOutcome {
  name: string;
  type: McpServerType;
  status: "connected" | "needs-auth" | "failed" | "skipped";
  latencyMs: number | null;
  protocolVersion?: string;
  serverInfo?: string;
  error?: string;
}

interface McpApiResponse {
  global: McpConfigFile;
  project: McpConfigFile | null;
  effective: EffectiveServer[];
  cache: Record<string, McpCacheInfo>;
}

const STATUS_COLORS: Record<string, string> = {
  connected: "#16a34a",
  "needs-auth": "#d97706",
  failed: "#dc2626",
  skipped: "#9ca3af",
};

function StatusDot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        animation: pulse ? "mcp-pulse 1s ease-in-out infinite" : undefined,
      }}
    />
  );
}

interface DialogState {
  mode: "add" | "edit";
  scope: McpScope;
  /** For edit mode: the original server name being edited. */
  name?: string;
}

/**
 * 「连接器」设置面板（embedded in SettingsDialog）：以列表形式展示合并后
 * 生效的 MCP 服务器，支持测试连通性、删除与编辑。「添加」弹窗对已存在的
 * 同名服务器跳过（不覆盖），更新走「编辑」按钮。
 */
export function McpConfig({ embedded = false, cwd }: { embedded?: boolean; cwd: string | null }) {
  const { t } = useI18n();
  const [data, setData] = useState<McpApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [results, setResults] = useState<Record<string, ProbeOutcome>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});

  // Add/edit dialog state
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);

  const load = useCallback(async () => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const res = await fetch(`/api/mcp${query}`);
    const d = (await res.json()) as McpApiResponse & { error?: string };
    if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
    setData(d);
  }, [cwd]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
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

  async function runTests(targets: EffectiveServer[]) {
    if (targets.length === 0) return;
    setMessage(null);
    setTesting((prev) => {
      const next = { ...prev };
      for (const server of targets) next[server.name] = true;
      return next;
    });
    try {
      const res = await fetch("/api/mcp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ servers: targets.map((s) => ({ name: s.name, entry: s.entry })) }),
      });
      const d = (await res.json()) as { results?: ProbeOutcome[]; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setResults((prev) => {
        const next = { ...prev };
        for (const outcome of d.results ?? []) next[outcome.name] = outcome;
        return next;
      });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting((prev) => {
        const next = { ...prev };
        for (const server of targets) delete next[server.name];
        return next;
      });
    }
  }

  /** Read the raw mcp.json text for a scope (parsed loosely). */
  function readBase(scope: McpScope): { mcpServers: Record<string, unknown> } {
    const baseRaw = (scope === "global" ? data?.global.rawText : data?.project?.rawText) ?? "";
    let base: { mcpServers?: Record<string, unknown> };
    try {
      base = baseRaw.trim() ? JSON.parse(baseRaw) : {};
    } catch {
      base = {};
    }
    if (!base.mcpServers || typeof base.mcpServers !== "object") base.mcpServers = {};
    return base as { mcpServers: Record<string, unknown> };
  }

  async function writeScope(scope: McpScope, base: { mcpServers: Record<string, unknown> }) {
    const newContent = JSON.stringify(base, null, 2);
    const res = await fetch("/api/mcp", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, cwd: cwd ?? undefined, content: newContent }),
    });
    const d = (await res.json()) as { success?: boolean; error?: string };
    if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
  }

  async function deleteServer(server: EffectiveServer) {
    if (!window.confirm(t("mcp.confirmDelete", { name: server.name }))) return;
    const base = readBase(server.source);
    delete base.mcpServers[server.name];
    setSaving(true);
    setMessage(null);
    try {
      await writeScope(server.source, base);
      setMessage({ kind: "ok", text: t("mcp.deleted", { name: server.name }) });
      await load();
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  /**
   * Toggle the `disabled` flag on the owning scope's config entry.
   * Enabling removes the flag entirely so the JSON stays clean.
   */
  async function toggleServer(server: EffectiveServer) {
    const base = readBase(server.source);
    const entry = base.mcpServers[server.name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    if (server.disabled) {
      delete record.disabled;
    } else {
      record.disabled = true;
    }
    setSaving(true);
    setMessage(null);
    try {
      await writeScope(server.source, base);
      setMessage({
        kind: "ok",
        text: server.disabled
          ? t("mcp.enabledMsg", { name: server.name })
          : t("mcp.disabledMsg", { name: server.name }),
      });
      await load();
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  function openAdd() {
    setDialog({ mode: "add", scope: "global" });
    setText("");
    setError(null);
  }

  function openEdit(server: EffectiveServer) {
    setDialog({ mode: "edit", scope: server.source, name: server.name });
    setText(JSON.stringify({ [server.name]: server.entry }, null, 2));
    setError(null);
  }

  function closeDialog() {
    setDialog(null);
    setText("");
    setError(null);
  }

  /** Add = skip entries that already exist, only insert new ones.
   *  Edit = overwrite the server (drops the original name first so renames work). */
  async function saveDialog() {
    if (!dialog) return;
    setError(null);
    let input: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a JSON object");
      }
      input = parsed as Record<string, unknown>;
      // Accept both paste formats: a bare `{ "name": {...}, ... }` map OR the
      // full `{ "mcpServers": { ... } }` wrapper (mcp.json / connector export
      // shape). Unwrap `mcpServers` and merge any sibling keys (e.g. $schema).
      if ("mcpServers" in input && input.mcpServers && typeof input.mcpServers === "object" && !Array.isArray(input.mcpServers)) {
        const wrapped = input.mcpServers as Record<string, unknown>;
        const rest: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input)) if (k !== "mcpServers") rest[k] = v;
        input = { ...rest, ...wrapped };
      }
    } catch (e) {
      setError(`${t("mcp.addServerError")}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const base = readBase(dialog.scope);
    let successMessage: string;

    if (dialog.mode === "edit" && dialog.name) {
      // Edit: drop the original name (handles rename), then merge the input.
      delete base.mcpServers[dialog.name];
      Object.assign(base.mcpServers, input);
      successMessage = t("mcp.updated");
    } else {
      // Add: skip entries that already exist, only insert new ones.
      let added = 0;
      let skipped = 0;
      for (const [key, val] of Object.entries(input)) {
        if (base.mcpServers[key]) {
          skipped++;
        } else {
          base.mcpServers[key] = val;
          added++;
        }
      }
      if (added === 0) {
        setError(t("mcp.allSkipped", { count: String(skipped) }));
        return;
      }
      successMessage = t("mcp.addResult", { added: String(added), skipped: String(skipped) });
    }

    setDialogBusy(true);
    try {
      await writeScope(dialog.scope, base);
      setMessage({ kind: "ok", text: successMessage });
      closeDialog();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDialogBusy(false);
    }
  }

  const effective = data?.effective ?? [];
  const cache = data?.cache ?? {};
  const anyTesting = Object.values(testing).some(Boolean);

  // Live JSON validation — valid when empty or a parseable JSON object.
  const jsonValid = useMemo(() => {
    if (!text.trim()) return true;
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }, [text]);

  function formatText() {
    try {
      const parsed = JSON.parse(text);
      setText(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch (e) {
      setError(`${t("mcp.addServerError")}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function statusLabel(server: EffectiveServer): { text: string; color: string; pulse: boolean } {
    if (testing[server.name]) return { text: t("mcp.testing"), color: "#eab308", pulse: true };
    if (server.disabled) return { text: t("mcp.statusDisabled"), color: "var(--text-dim)", pulse: false };
    const outcome = results[server.name];
    if (!outcome) return { text: t("mcp.statusUntested"), color: "var(--text-dim)", pulse: false };
    switch (outcome.status) {
      case "connected":
        return { text: t("mcp.statusConnected"), color: STATUS_COLORS.connected!, pulse: false };
      case "needs-auth":
        return { text: t("mcp.statusNeedsAuth"), color: STATUS_COLORS["needs-auth"]!, pulse: false };
      case "failed":
        return { text: t("mcp.statusFailed"), color: STATUS_COLORS.failed!, pulse: false };
      default:
        return { text: t("mcp.statusSkipped"), color: STATUS_COLORS.skipped!, pulse: false };
    }
  }

  return (
    <div
      style={
        embedded
          ? { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", padding: 20, gap: 16 }
          : { display: "flex", flexDirection: "column", padding: 20, gap: 16 }
      }
    >
      <style>{`@keyframes mcp-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }`}</style>

      {/* 头部说明 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("mcp.title")}</span>
        <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>{t("mcp.desc")}</span>
      </div>

      {/* 操作行：添加 + 全部测试 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          onClick={openAdd}
          style={{
            padding: "7px 14px",
            fontSize: 13,
            borderRadius: 6,
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="6" y1="1" x2="6" y2="11" />
            <line x1="1" y1="6" x2="11" y2="6" />
          </svg>
          {t("mcp.add")}
        </button>
        <button
          onClick={() => void runTests(effective.filter((s) => !s.disabled))}
          disabled={anyTesting || effective.length === 0}
          style={{
            marginLeft: "auto",
            padding: "7px 14px",
            fontSize: 13,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "none",
            color: anyTesting ? "var(--text-dim)" : "var(--text)",
            cursor: anyTesting || effective.length === 0 ? "not-allowed" : "pointer",
          }}
        >
          {anyTesting ? t("mcp.testing") : t("mcp.testAll")}
        </button>
      </div>

      {message && (
        <span
          style={{
            fontSize: 12,
            color: message.kind === "ok" ? "#16a34a" : "#f87171",
            overflowWrap: "anywhere",
          }}
        >
          {message.text}
        </span>
      )}

      {/* 生效服务器列表 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          {t("mcp.serverList")}（{effective.length}）
        </span>
        {loading ? (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.loading")}</span>
        ) : effective.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("mcp.noServers")}</span>
        ) : (
          effective.map((server) => {
            const status = statusLabel(server);
            const cacheInfo = cache[server.name];
            const outcome = results[server.name];
            return (
              <div
                key={`${server.source}:${server.name}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: "10px 12px",
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  opacity: server.disabled ? 0.6 : 1,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <StatusDot color={status.color} pulse={status.pulse} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{server.name}</span>
                  <span
                    style={{
                      fontSize: 10,
                      padding: "1px 6px",
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {server.type.toUpperCase()}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: "var(--bg-selected)",
                      color: "var(--text-muted)",
                    }}
                  >
                    {server.source === "global" ? t("mcp.sourceGlobal") : t("mcp.sourceProject")}
                  </span>
                  <span style={{ fontSize: 12, color: status.color, fontWeight: 500 }}>{status.text}</span>
                  {outcome?.status === "connected" && typeof outcome.latencyMs === "number" && (
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{outcome.latencyMs} ms</span>
                  )}
                  <button
                    role="switch"
                    aria-checked={!server.disabled}
                    onClick={() => void toggleServer(server)}
                    disabled={saving}
                    title={server.disabled ? t("mcp.enable") : t("mcp.disable")}
                    style={{
                      marginLeft: "auto",
                      position: "relative",
                      display: "inline-flex",
                      width: 34,
                      height: 18,
                      flexShrink: 0,
                      padding: 0,
                      borderRadius: 9,
                      border: "none",
                      background: server.disabled ? "var(--border)" : "var(--accent)",
                      cursor: saving ? "not-allowed" : "pointer",
                      opacity: saving ? 0.5 : 1,
                      transition: "background 0.15s",
                    }}
                  >
                    <span
                      style={{
                        position: "absolute",
                        top: 2,
                        left: server.disabled ? 2 : 18,
                        width: 14,
                        height: 14,
                        borderRadius: "50%",
                        background: "#fff",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
                        transition: "left 0.15s",
                      }}
                    />
                  </button>
                  <button
                    onClick={() => void runTests([server])}
                    disabled={Boolean(testing[server.name]) || server.disabled}
                    style={{
                      padding: "3px 10px",
                      fontSize: 11,
                      borderRadius: 5,
                      border: "1px solid var(--border)",
                      background: "none",
                      color: testing[server.name] || server.disabled ? "var(--text-dim)" : "var(--text-muted)",
                      cursor: testing[server.name] || server.disabled ? "not-allowed" : "pointer",
                    }}
                  >
                    {testing[server.name] ? t("mcp.testing") : t("mcp.test")}
                  </button>
                  <button
                    onClick={() => openEdit(server)}
                    disabled={saving}
                    title={t("mcp.edit")}
                    style={{
                      padding: "3px 10px",
                      fontSize: 11,
                      borderRadius: 5,
                      border: "1px solid var(--border)",
                      background: "none",
                      color: saving ? "var(--text-dim)" : "var(--text-muted)",
                      cursor: saving ? "not-allowed" : "pointer",
                    }}
                  >
                    {t("mcp.edit")}
                  </button>
                  <button
                    onClick={() => void deleteServer(server)}
                    disabled={saving}
                    title={t("mcp.delete")}
                    style={{
                      padding: "3px 10px",
                      fontSize: 11,
                      borderRadius: 5,
                      border: "1px solid var(--border)",
                      background: "none",
                      color: saving ? "var(--text-dim)" : "#ef4444",
                      cursor: saving ? "not-allowed" : "pointer",
                    }}
                  >
                    {t("mcp.delete")}
                  </button>
                </div>
                {server.summary && (
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono)",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {server.summary}
                  </span>
                )}
                {(cacheInfo || outcome?.error || outcome?.serverInfo) && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {cacheInfo && (cacheInfo.toolCount > 0 || cacheInfo.cachedAt !== null) && (
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                        {t("mcp.cachedTools", {
                          count: String(cacheInfo.toolCount),
                          time: cacheInfo.cachedAt !== null ? new Date(cacheInfo.cachedAt).toLocaleString() : "-",
                        })}
                      </span>
                    )}
                    {outcome?.serverInfo && outcome.status === "connected" && (
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{outcome.serverInfo}</span>
                    )}
                    {outcome?.error && outcome.status !== "skipped" && (
                      <span
                        title={outcome.error}
                        style={{
                          fontSize: 11,
                          color: outcome.status === "needs-auth" ? "#d97706" : "#f87171",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {outcome.error.length > 160 ? `${outcome.error.slice(0, 160)}…` : outcome.error}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 添加 / 编辑弹窗 */}
      {dialog && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={closeDialog}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              width: "min(560px, calc(100vw - 32px))",
              maxHeight: "calc(100dvh - 64px)",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              boxShadow: "0 12px 36px rgba(0,0,0,0.22)",
              padding: 18,
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                {dialog.mode === "edit" ? t("mcp.editTitle") : t("mcp.addTitle")}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                {dialog.mode === "edit" ? t("mcp.editDesc") : t("mcp.addDesc")}
              </span>
            </div>

            {/* scope 选择（编辑模式锁定） */}
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              {(["global", "project"] as const).map((key) => {
                const disabled = dialog.mode === "edit" || (key === "project" && !cwd);
                const active = dialog.scope === key;
                return (
                  <button
                    key={key}
                    onClick={() => { if (!disabled) setDialog({ ...dialog, scope: key }); }}
                    disabled={disabled}
                    title={disabled && key === "project" && !cwd ? t("mcp.projectNoCwd") : undefined}
                    style={{
                      padding: "5px 12px",
                      fontSize: 12,
                      borderRadius: 6,
                      border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                      background: active ? "var(--bg-selected)" : "none",
                      color: disabled ? "var(--text-dim)" : active ? "var(--text)" : "var(--text-muted)",
                      cursor: disabled ? "not-allowed" : "pointer",
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {key === "global" ? t("mcp.scopeGlobal") : t("mcp.scopeProject")}
                  </button>
                );
              })}
            </div>

            {/* JSON 编辑器（语法高亮 + 实时校验）；固定高度（JsonEditor 默认
                320px），长内容在编辑器内部滚动，不撑高弹框，底部按钮固定可见 */}
            <JsonEditor
              value={text}
              onChange={setText}
              placeholder={
                '{\n' +
                '  "mcpServers": {\n' +
                '    "my-server": {\n' +
                '      "type": "http",\n' +
                '      "url": "https://example.com/mcp"\n' +
                '    }\n' +
                '  }\n' +
                '}'
              }
              invalid={Boolean(error) || !jsonValid}
            />
            {error && (
              <span style={{ fontSize: 12, color: "#f87171", overflowWrap: "anywhere" }}>{error}</span>
            )}
            {!error && !jsonValid && text.trim() && (
              <span style={{ fontSize: 12, color: "#f87171" }}>{t("mcp.addServerError")}</span>
            )}

            {/* 操作按钮（固定底部，不被长内容顶出视口） */}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexShrink: 0 }}>
              <button
                onClick={formatText}
                disabled={!text.trim() || !jsonValid}
                style={{
                  padding: "7px 14px",
                  fontSize: 13,
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "none",
                  color: "var(--text-muted)",
                  cursor: !text.trim() || !jsonValid ? "not-allowed" : "pointer",
                  marginRight: "auto",
                }}
              >
                {t("mcp.format")}
              </button>
              <button
                onClick={closeDialog}
                style={{
                  padding: "7px 16px",
                  fontSize: 13,
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                {t("mcp.cancel")}
              </button>
              <button
                onClick={() => void saveDialog()}
                disabled={dialogBusy || !text.trim()}
                style={{
                  padding: "7px 16px",
                  fontSize: 13,
                  borderRadius: 6,
                  border: "none",
                  background: "var(--accent)",
                  color: "#fff",
                  cursor: dialogBusy || !text.trim() ? "not-allowed" : "pointer",
                  opacity: dialogBusy || !text.trim() ? 0.5 : 1,
                }}
              >
                {dialogBusy ? t("i18n.saving") : t("i18n.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
