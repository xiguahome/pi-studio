"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme, type ThemePreference } from "@/hooks/useTheme";
import { useBrowserMode } from "@/hooks/useBrowserMode";
import { NetworkConfig } from "./NetworkConfig";

const THEME_OPTIONS: { value: ThemePreference; labelKey: string }[] = [
  { value: "auto", labelKey: "general.theme.auto" },
  { value: "dark", labelKey: "general.theme.dark" },
  { value: "light", labelKey: "general.theme.light" },
];

const BROWSER_OPTIONS: { value: boolean; labelKey: string }[] = [
  { value: true, labelKey: "general.browser.builtin" },
  { value: false, labelKey: "general.browser.external" },
];

const TRAY_OPTIONS: { value: boolean; labelKey: string }[] = [
  { value: true, labelKey: "general.tray.minimize" },
  { value: false, labelKey: "general.tray.quit" },
];

function SectionHeading({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{title}</span>
      <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>{desc}</span>
    </div>
  );
}

/**
 * 「通用」设置面板（embedded in SettingsDialog）：纵向排列区块 ——
 * 界面语言 / 界面主题 / HTTP 代理（复用 NetworkConfig）/ 内置浏览器 /
 * 关闭窗口行为（仅桌面版，托盘开关经 window.piDesktop IPC 即时生效）。
 * 语言与主题写 localStorage、代理写 ~/.pi-studio/proxy.json，重启后自动生效。
 */
export function GeneralConfig({ embedded = false }: { embedded?: boolean }) {
  const { t, locale, setLocale, supportedLocales } = useI18n();
  const { preference, setPreference } = useTheme();
  const { builtin, saving, setBuiltin } = useBrowserMode();
  const [restartNotice, setRestartNotice] = useState(false);
  const [isElectron, setIsElectron] = useState(false);
  // null = config still loading (buttons disabled until the IPC round-trip)
  const [trayValue, setTrayValue] = useState<boolean | null>(null);
  const [traySaving, setTraySaving] = useState(false);
  const [trayError, setTrayError] = useState(false);

  useEffect(() => {
    const desktop = typeof window !== "undefined" && !!window.piDesktop?.isDesktop;
    setIsElectron(desktop);
    if (!desktop || !window.piDesktop?.getWindowConfig) return;
    window.piDesktop
      .getWindowConfig()
      .then((config) => setTrayValue(Boolean(config?.minimizeToTray)))
      .catch(() => setTrayValue(false));
  }, []);

  const handleTraySelect = (value: boolean) => {
    if (value === trayValue || traySaving) return;
    const apply = window.piDesktop?.setWindowConfig;
    if (!apply) return;
    setTraySaving(true);
    setTrayError(false);
    apply({ minimizeToTray: value })
      .then((config) => setTrayValue(Boolean(config?.minimizeToTray)))
      .catch(() => setTrayError(true))
      .finally(() => setTraySaving(false));
  };

  const handleBrowserSelect = (value: boolean) => {
    if (value === builtin || saving) return;
    void setBuiltin(value).then(() => setRestartNotice(true));
  };

  return (
    <div
      style={
        embedded
          ? { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", padding: 20, gap: 20 }
          : { display: "flex", flexDirection: "column", padding: 20, gap: 20 }
      }
    >
      {/* ① 界面语言 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionHeading title={t("general.language")} desc={t("general.languageDesc")} />
        <select
          value={locale}
          onChange={(e) => setLocale(e.target.value as typeof locale)}
          style={{
            alignSelf: "flex-start",
            minWidth: 200,
            padding: "7px 10px",
            fontSize: 13,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            outline: "none",
          }}
        >
          {supportedLocales.map((plugin) => (
            <option key={plugin.id} value={plugin.id}>
              {plugin.label}
            </option>
          ))}
        </select>
      </div>

      {/* ② 界面主题 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionHeading title={t("general.theme")} desc={t("general.themeDesc")} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {THEME_OPTIONS.map(({ value, labelKey }) => {
            const active = preference === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setPreference(value)}
                aria-pressed={active}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 14px",
                  fontSize: 13,
                  borderRadius: 6,
                  border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                  background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    border: active ? "2px solid var(--accent)" : "2px solid var(--text-dim)",
                  }}
                />
                {t(labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {/* ③ HTTP 代理 — 复用 NetworkConfig 自带的标题/说明/输入区 */}
      {/* 负外边距抵消 NetworkConfig 自身 padding，使其与同级区块对齐 */}
      <div style={{ margin: -20 }}>
        <NetworkConfig embedded />
      </div>

      {/* ④ 内置浏览器 — agent 驱动内嵌 webview(:9333) 还是外部 Chrome(:9222) */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionHeading title={t("general.browser")} desc={t("general.browserDesc")} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {BROWSER_OPTIONS.map(({ value, labelKey }) => {
            const active = builtin === value;
            return (
              <button
                key={String(value)}
                type="button"
                onClick={() => handleBrowserSelect(value)}
                aria-pressed={active}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 14px",
                  fontSize: 13,
                  borderRadius: 6,
                  border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                  background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    border: active ? "2px solid var(--accent)" : "2px solid var(--text-dim)",
                  }}
                />
                {t(labelKey)}
              </button>
            );
          })}
        </div>
        {!builtin && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "8px 10px",
              background: "var(--bg-hover)",
              border: "1px solid var(--border)",
              borderRadius: 6,
            }}
          >
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("general.browser.externalHint")}</span>
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--text)",
                userSelect: "text",
                whiteSpace: "nowrap",
                overflowX: "auto",
              }}
            >
              chrome --remote-debugging-port=9222 --remote-allow-origins=*
            </code>
          </div>
        )}
        {restartNotice && (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>↻ {t("general.browser.restartHint")}</span>
        )}
      </div>

      {/* ⑤ 关闭窗口时 — 桌面版专属：点 X 收进系统托盘（后台保活）还是直接退出 */}
      {isElectron && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionHeading title={t("general.tray")} desc={t("general.trayDesc")} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {TRAY_OPTIONS.map(({ value, labelKey }) => {
              const active = trayValue === value;
              const disabled = trayValue === null || traySaving;
              return (
                <button
                  key={String(value)}
                  type="button"
                  onClick={() => handleTraySelect(value)}
                  disabled={disabled}
                  aria-pressed={active}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "7px 14px",
                    fontSize: 13,
                    borderRadius: 6,
                    border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                    color: active ? "var(--text)" : "var(--text-muted)",
                    cursor: disabled ? "default" : "pointer",
                    opacity: disabled ? 0.6 : 1,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      border: active ? "2px solid var(--accent)" : "2px solid var(--text-dim)",
                    }}
                  />
                  {t(labelKey)}
                </button>
              );
            })}
          </div>
          {trayError && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>⚠ {t("general.tray.error")}</span>
          )}
        </div>
      )}
    </div>
  );
}
