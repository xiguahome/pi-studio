"use client";

import { useEffect, useCallback, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";

interface Props {
  open: boolean;
  sessionId: string | null;
  onClose: () => void;
}

export function FullHistoryDialog({ open, sessionId, onClose }: Props) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const { theme } = useTheme();
  const [iframeLoaded, setIframeLoaded] = useState(false);

  // 弹框打开或主题切换时重置加载状态（iframe 会按新主题重新加载）
  useEffect(() => {
    if (open) setIframeLoaded(false);
  }, [open, sessionId, theme]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 导出会话为 HTML 文件（按当前 app 主题着色）
  const handleExport = useCallback(() => {
    if (!sessionId) return;
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/export?theme=${theme}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [sessionId, theme]);

  if (!open) return null;

  const src = sessionId
    ? `/api/sessions/${encodeURIComponent(sessionId)}/export?inline=1&theme=${theme}`
    : null;

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
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : "90vw",
          maxWidth: 1200,
          height: isMobile ? "calc(100dvh - 16px)" : "85vh",
          maxHeight: "calc(100dvh - 16px)",
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
            justifyContent: "space-between",
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
            {t("history.dialogTitle")}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* 导出会话按钮 */}
            <button
              onClick={handleExport}
              disabled={!sessionId}
              title={t("history.export")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                background: sessionId ? "var(--accent)" : "transparent",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: sessionId ? "#fff" : "var(--text-dim)",
                cursor: sessionId ? "pointer" : "not-allowed",
                fontSize: 12,
                fontWeight: 500,
                transition: "background 0.1s, opacity 0.1s",
              }}
              onMouseEnter={(e) => {
                if (sessionId) e.currentTarget.style.opacity = "0.85";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "1";
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {t("history.export")}
            </button>

            {/* 关闭按钮 */}
            <button
              onClick={onClose}
              title="Close"
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
        </div>

        {/* Content: iframe 展示会话历史 */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative", background: "var(--bg)" }}>
          {src && !iframeLoaded && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                zIndex: 1,
              }}
            >
              {/* 加载动画 */}
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" style={{ animation: "history-dialog-spin 1s linear infinite" }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{t("history.loading")}</span>
              <style>{`@keyframes history-dialog-spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}
          {src && (
            <iframe
              key={`${sessionId}-${theme}`}
              src={src}
              title={t("history.dialogTitle")}
              onLoad={() => setIframeLoaded(true)}
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                opacity: iframeLoaded ? 1 : 0,
                transition: "opacity 0.2s ease",
              }}
              sandbox="allow-scripts"
            />
          )}
        </div>
      </div>
    </div>
  );
}
