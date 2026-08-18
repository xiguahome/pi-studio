"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";

// Lazy-load settings sub-panels so each panel's code only loads when the user
// navigates to that section, keeping the settings dialog chunk small.
const ModelsConfig = dynamic(() => import("./ModelsConfig").then(m => ({ default: m.ModelsConfig })), { ssr: false });
const SkillsConfig = dynamic(() => import("./SkillsConfig").then(m => ({ default: m.SkillsConfig })), { ssr: false });
const ExpertsConfig = dynamic(() => import("./ExpertsConfig").then(m => ({ default: m.ExpertsConfig })), { ssr: false });
const MemoryConfig = dynamic(() => import("./MemoryConfig").then(m => ({ default: m.MemoryConfig })), { ssr: false });
const PluginsConfig = dynamic(() => import("./PluginsConfig").then(m => ({ default: m.PluginsConfig })), { ssr: false });
const GeneralConfig = dynamic(() => import("./GeneralConfig").then(m => ({ default: m.GeneralConfig })), { ssr: false });
const McpConfig = dynamic(() => import("./McpConfig").then(m => ({ default: m.McpConfig })), { ssr: false });
const PromptsConfig = dynamic(() => import("./PromptsConfig").then(m => ({ default: m.PromptsConfig })), { ssr: false });
const UpdatesConfig = dynamic(() => import("./UpdatesConfig").then(m => ({ default: m.UpdatesConfig })), { ssr: false });

export type Section = "models" | "skills" | "experts" | "plugins" | "general" | "mcp" | "prompts" | "updates" | "memory";

/**
 * 统一设置弹框：左栏导航（通用 / 模型 / 技能 / 插件）+ 右栏复用现有配置面板（embedded 模式）。
 *
 * 模型 / 通用面板不依赖 cwd，始终可用；技能 / 插件面板不依赖活动项目——
 * 无 cwd 时自动用默认工作区 <agentDir>/default-project/cwd-* 兜底
 * （agentDir 默认 ~/.pi-studio），保证未配置模型、未打开
 * 项目也能浏览和安装全局技能 / 插件。
 */
function PanelLoading() {
  const { t } = useI18n();
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        color: "var(--text-muted)",
      }}
    >
      {t("i18n.loading")}
    </div>
  );
}

function PanelError() {
  const { t } = useI18n();
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        color: "#f87171",
      }}
    >
      {t("i18n.fallbackWorkspaceError")}
    </div>
  );
}
export function SettingsDialog({
  onClose,
  cwd,
  sessionId,
  onModelsClosed,
  onPluginsReloaded,
  onUseExpert,
  initialSection = "general",
}: {
  onClose: () => void;
  cwd: string | null;
  sessionId: string | null;
  onModelsClosed?: () => void;
  onPluginsReloaded?: () => void;
  /** Called when user clicks "Use Expert" — injects prompt into the chat input. */
  onUseExpert?: (prompt: string) => void;
  /** Open the dialog on a specific section (e.g. from sidebar shortcuts). */
  initialSection?: Section;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [section, setSection] = useState<Section>(initialSection);

  // 技能 / 插件面板不依赖活动项目：无 cwd（未打开项目/会话）时用
  // 默认工作区 <agentDir>/default-project/cwd-<YYYYMMDD> 兜底（agentDir
  // 默认 ~/.pi-studio），保证"未配置模型、未激活目录"
  // 也能浏览和安装全局技能 / 插件。该目录由 /api/default-cwd 创建并
  // 注入允许根，作为纯上下文使用，不影响任何真实项目。
  const [fallbackCwd, setFallbackCwd] = useState<string | null>(null);
  const [fallbackFailed, setFallbackFailed] = useState(false);
  // 请求已发起标记（ref，不参与渲染）：只用来防止重复请求，绝不依赖
  // loading 状态做闸门——dev StrictMode/HMR 下 effect 会被 cleanup 取消
  // 再重跑，若把"加载中"状态当守卫，残留 true 会永久拦住重试，面板就
  // 永远停在"加载中"。
  const fallbackRequestedRef = useRef(false);

  useEffect(() => {
    if (cwd) {
      setFallbackCwd(null);
      setFallbackFailed(false);
      fallbackRequestedRef.current = false;
      return;
    }
    if (section !== "skills" && section !== "plugins" && section !== "experts" && section !== "memory") return;
    if (fallbackRequestedRef.current) return;
    fallbackRequestedRef.current = true;
    let cancelled = false;
    fetch("/api/default-cwd", { method: "POST" })
      .then(async (res) => {
        const d = (await res.json()) as { cwd?: string };
        if (!cancelled && d?.cwd) setFallbackCwd(d.cwd);
        else if (!cancelled) setFallbackFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFallbackFailed(true);
      });
    return () => {
      cancelled = true;
      fallbackRequestedRef.current = false;
    };
  }, [cwd, section, fallbackCwd, fallbackFailed]);

  const effectiveCwd = cwd ?? fallbackCwd;

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 关闭模型面板时刷新模型列表（与原 ModelsConfig onClose 行为一致）
  function handleClose() {
    if (section === "models") onModelsClosed?.();
    onClose();
  }

  const sections: {
    key: Section;
    label: string;
    disabled: boolean;
    icon: React.ReactNode;
  }[] = [
    {
      key: "general",
      label: t("common.general"),
      disabled: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
    },
    {
      key: "models",
      label: t("common.models"),
      disabled: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
          <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
          <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
          <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
          <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
        </svg>
      ),
    },
    {
      key: "skills",
      label: t("common.skills"),
      disabled: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      ),
    },
    {
      key: "experts",
      label: t("common.experts"),
      disabled: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
    },
    {
      key: "memory",
      label: t("common.memory"),
      disabled: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V8a3 3 0 0 0-3-3z" />
          <path d="M19 9a2 2 0 0 0-2 2v1a2 2 0 0 0 4 0v-1a2 2 0 0 0-2-2z" />
          <path d="M5 9a2 2 0 0 0-2 2v1a2 2 0 0 0 4 0v-1a2 2 0 0 0-2-2z" />
        </svg>
      ),
    },
    {
      key: "mcp",
      label: t("common.connectors"),
      disabled: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22v-5" />
          <path d="M9 8V2" />
          <path d="M15 8V2" />
          <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
        </svg>
      ),
    },
    {
      key: "prompts",
      label: t("common.prompts"),
      disabled: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 13h6" />
          <path d="M9 17h6" />
        </svg>
      ),
    },
    {
      key: "plugins",
      label: t("common.plugins"),
      disabled: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 7V2" />
          <path d="M15 7V2" />
          <path d="M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0Z" />
          <path d="M12 19v3" />
        </svg>
      ),
    },
    {
      key: "updates",
      label: t("common.updates"),
      disabled: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
          <path d="M16 16h5v5" />
        </svg>
      ),
    },
  ];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 1080,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "80vh",
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
            {t("common.settings")}
          </span>
          <button
            onClick={handleClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 20,
              lineHeight: 1,
              padding: "2px 6px",
            }}
          >
            ×
          </button>
        </div>

        {/* Body: 左导航 + 右内容 */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            overflow: "hidden",
          }}
        >
          {/* 左导航 */}
          <div
            style={{
              width: isMobile ? "100%" : 180,
              flexShrink: 0,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              background: "var(--bg-panel)",
              display: "flex",
              flexDirection: "column",
              padding: "8px 6px",
              gap: 2,
            }}
          >
            {sections.map(({ key, label, disabled, icon }) => {
              const active = section === key;
              return (
                <button
                  key={key}
                  onClick={() => {
                    if (!disabled) setSection(key);
                  }}
                  disabled={disabled}
                  title={label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "none",
                    background: active ? "var(--bg-selected)" : "none",
                    color: disabled
                      ? "var(--text-dim)"
                      : active
                        ? "var(--text)"
                        : "var(--text-muted)",
                    cursor: disabled ? "not-allowed" : "pointer",
                    fontSize: 13,
                    fontWeight: active ? 600 : 400,
                    textAlign: "left",
                    transition: "background 0.1s, color 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    if (!disabled && !active) {
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!disabled && !active) {
                      e.currentTarget.style.background = "none";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }
                  }}
                >
                  {icon}
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 右内容区：嵌入对应配置面板（embedded 模式，不含自己的遮罩/外壳/Header） */}
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            {section === "models" && (
              <ModelsConfig key="models" embedded onClose={handleClose} />
            )}
            {section === "skills" &&
              (effectiveCwd ? (
                <SkillsConfig key="skills" embedded cwd={effectiveCwd} onClose={handleClose} />
              ) : fallbackFailed ? (
                <PanelError />
              ) : (
                <PanelLoading />
              ))}
            {section === "experts" &&
              (effectiveCwd ? (
                <ExpertsConfig
                  key="experts"
                  embedded
                  cwd={effectiveCwd}
                  onClose={handleClose}
                  onUseExpert={(prompt) => {
                    onUseExpert?.(prompt);
                    handleClose();
                  }}
                />
              ) : fallbackFailed ? (
                <PanelError />
              ) : (
                <PanelLoading />
              ))}
            {section === "plugins" &&
              (effectiveCwd ? (
                <PluginsConfig
                  key="plugins"
                  embedded
                  cwd={effectiveCwd}
                  sessionId={sessionId}
                  onClose={handleClose}
                  onReloaded={onPluginsReloaded}
                />
              ) : fallbackFailed ? (
                <PanelError />
              ) : (
                <PanelLoading />
              ))}
            {section === "memory" &&
              (effectiveCwd ? (
                <MemoryConfig key="memory" embedded cwd={effectiveCwd} sessionId={sessionId} onClose={handleClose} />
              ) : fallbackFailed ? (
                <PanelError />
              ) : (
                <PanelLoading />
              ))}
            {section === "general" && <GeneralConfig key="general" embedded />}
            {section === "mcp" && <McpConfig key="mcp" embedded cwd={cwd} />}
            {section === "prompts" && <PromptsConfig key="prompts" embedded cwd={cwd} />}
            {section === "updates" && <UpdatesConfig key="updates" embedded />}
          </div>
        </div>
      </div>
    </div>
  );
}
