"use client";

import { useEffect, useState, useCallback } from "react";
import { useI18n } from "@/hooks/useI18n";
import packageJson from "@/package.json";

/* ---------- types ---------- */

interface UpdateState {
  state: string;
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string;
  downloadPath: string;
  downloadProgress: { percent: number; transferred: number; total: number };
  errorMessage: string;
}

interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
}

interface CheckResult {
  status: string;
  currentVersion?: string;
  latestVersion?: string;
  releaseNotes?: string;
  downloadUrl?: string;
  downloadSize?: number;
  errorMessage?: string;
}

/* ---------- helpers ---------- */

function SectionHeading({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{title}</span>
      <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>{desc}</span>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ---------- component ---------- */

export function UpdatesConfig({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [currentVersion, setCurrentVersion] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);

  // Load initial state on mount.
  useEffect(() => {
    const pi = window.piDesktop;

    // Desktop bridge (Electron preload) reflects the real installed version
    // (app.getVersion()), so prefer it. In web/dev mode (no preload) we fall
    // back to packageJson.version below — otherwise the version stays "" and
    // the panel renders a bare "v".
    if (pi) {
      setIsDesktop(true);
      pi.info?.().then((info) => setCurrentVersion(info.version)).catch(() => {});

      pi.updateState?.().then((s) => {
        if (s) setUpdateState(s as UpdateState);
      }).catch(() => {});
    }

    // Subscribe to real-time download progress (desktop only; no-op in web/dev).
    // Main sets state to "downloading" before streaming progress, but the
    // renderer won't see it until refreshState() — which runs only after the
    // whole download resolves. Force the state here so one click switches UI.
    const unsubscribe = window.piDesktop?.onUpdateProgress?.((data: DownloadProgress) => {
      setUpdateState((prev) =>
        prev
          ? { ...prev, state: "downloading", downloadProgress: data }
          : { state: "downloading", currentVersion: "", latestVersion: "", releaseNotes: "", downloadPath: "", downloadProgress: data, errorMessage: "" },
      );
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  const refreshState = useCallback(async () => {
    const s = await window.piDesktop?.updateState?.();
    if (s) setUpdateState(s as UpdateState);
  }, []);

  const handleCheck = useCallback(async () => {
    // Optimistic "checking" so the button gives immediate feedback and can't
    // be double-clicked while the manifest request is in flight.
    setUpdateState((prev) => (prev ? { ...prev, state: "checking" } : null));
    const result = (await window.piDesktop?.checkForUpdates?.()) as CheckResult | undefined;
    if (result) await refreshState();
  }, [refreshState]);

  const handleDownload = useCallback(async () => {
    // Main's downloadUpdate promise resolves only after the full download;
    // switch locally right away so the progress screen shows immediately.
    setUpdateState((prev) => (prev ? { ...prev, state: "downloading" } : null));
    const result = await window.piDesktop?.downloadUpdate?.();
    if (result) await refreshState();
    // Self-heal: if the awaited response was lost (observed on real network
    // downloads — UI stuck at 100% until remount), poll until main reports a
    // state past "downloading".
    if (((await window.piDesktop?.updateState?.()) as UpdateState | undefined)?.state === "downloading") {
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = (await window.piDesktop?.updateState?.()) as UpdateState | undefined;
        if (s && s.state !== "downloading") {
          setUpdateState(s);
          break;
        }
      }
    }
  }, [refreshState]);

  const handleInstall = useCallback(async () => {
    // On success the app quits (installer takes over); on failure applyUpdate
    // keeps the app alive and returns "error" — refresh so the UI shows it.
    await window.piDesktop?.installUpdate?.();
    await refreshState();
  }, [refreshState]);

  const st = updateState?.state || "idle";
  const displayVersion = currentVersion || updateState?.currentVersion || packageJson.version;

  return (
    <div
      style={
        embedded
          ? { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", padding: 20, gap: 20 }
          : { display: "flex", flexDirection: "column", padding: 20, gap: 20 }
      }
    >
      {/* Heading */}
      <SectionHeading title={t("updates.title")} desc={t("updates.desc")} />

      {/* Current version */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("updates.currentVersion")}</span>
        <span style={{ fontSize: 13, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
          {displayVersion ? `v${displayVersion}` : "—"}
        </span>
      </div>

      {/* State-dependent action area */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* idle */}
        {st === "idle" && (
          <>
            <ActionButton label={t("updates.checkForUpdates")} onClick={handleCheck} disabled={!isDesktop} />
            {!isDesktop && (
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("updates.desktopOnly")}</span>
            )}
          </>
        )}

        {/* checking */}
        {st === "checking" && (
          <ActionButton label={t("updates.checking")} disabled />
        )}

        {/* up-to-date */}
        {st === "upToDate" && (
          <span style={{ fontSize: 13, color: "var(--accent)" }}>✓ {t("updates.upToDate")}</span>
        )}

        {/* update available */}
        {st === "available" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, color: "var(--text)" }}>
                {t("updates.newVersion")}:{" "}
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                  v{updateState?.latestVersion}
                </span>
              </span>
            </div>
            {updateState?.releaseNotes && (
              <div
                style={{
                  padding: "10px 12px",
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "var(--text-muted)",
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  maxHeight: 200,
                  overflowY: "auto",
                }}
              >
                {updateState.releaseNotes}
              </div>
            )}
            <ActionButton label={t("updates.download")} onClick={handleDownload} />
          </div>
        )}

        {/* downloading */}
        {st === "downloading" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div
              style={{
                width: "100%",
                height: 6,
                background: "var(--bg-panel)",
                borderRadius: 3,
                overflow: "hidden",
                border: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${updateState?.downloadProgress.percent || 0}%`,
                  background: "var(--accent)",
                  borderRadius: 3,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {t("updates.downloading")} {updateState?.downloadProgress.percent || 0}%
              {" — "}
              {formatBytes(updateState?.downloadProgress.transferred || 0)}
              {" / "}
              {formatBytes(updateState?.downloadProgress.total || 0)}
            </span>
          </div>
        )}

        {/* downloaded */}
        {st === "downloaded" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span style={{ fontSize: 13, color: "var(--accent)" }}>✓ {t("updates.downloadComplete")}</span>
            <ActionButton label={t("updates.installAndRestart")} onClick={handleInstall} />
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("updates.quitHint")}</span>
          </div>
        )}

        {/* installing */}
        {st === "installing" && (
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("updates.checking")}…</span>
        )}

        {/* error */}
        {st === "error" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span style={{ fontSize: 12, color: "#e55" }}>
              {t("updates.error")}: {updateState?.errorMessage || "Unknown error"}
            </span>
            <ActionButton label={t("updates.retry")} onClick={handleCheck} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- shared button ---------- */

function ActionButton({
  label,
  onClick,
  disabled = false,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        alignSelf: "flex-start",
        padding: "7px 16px",
        fontSize: 13,
        borderRadius: 6,
        border: "1px solid var(--accent)",
        background: "var(--accent)",
        color: "#fff",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "opacity 0.15s",
      }}
    >
      {label}
    </button>
  );
}
