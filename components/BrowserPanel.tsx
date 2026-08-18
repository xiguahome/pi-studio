"use client";

import { useState, useRef, useCallback, useEffect, type CSSProperties } from "react";

interface BrowserPanelProps {
  tabId: string;
  initialUrl?: string;
  initialContent?: string;
}

// Minimal shape of the Electron <webview> DOM node we rely on. The full type is
// not available without pulling in Electron's renderer types, and the existing
// webviewRef is untyped, so we keep this narrow and local.
type BrowserWebviewEl = HTMLElement & {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  getURL(): string;
  __cleanupBrowserNav?: () => void;
};

type CdpInfo = {
  port?: number;
  endpoint?: string;
  webviewUrl?: string | null;
  targetId?: string | null;
  webviews?: { targetId?: string | null; url?: string | null; webSocketDebuggerUrl?: string | null }[];
};

export function BrowserPanel({ initialUrl, initialContent }: BrowserPanelProps) {
  const [url, setUrl] = useState(initialUrl ?? "");
  // Navigation target bound to <webview>/<iframe> `src`. MUST stay decoupled
  // from the displayed URL (`url`): if we fed getURL() back into `src`, every
  // redirect/finish would re-assign the `src` attribute and abort the in-flight
  // load (Electron net::ERR_ABORTED -3). `src` is the load target only.
  const [loadUrl, setLoadUrl] = useState(initialUrl ?? "");
  const [inputValue, setInputValue] = useState(initialUrl ?? "");
  const [content, setContent] = useState<string | null>(initialContent ?? null);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const webviewRef = useRef<BrowserWebviewEl | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [isElectron, setIsElectron] = useState(false);
  // Clear-browser-data popover state. Defaults to cache-only so login state
  // (cookies) survives unless the user explicitly opts in.
  const [clearDataOpen, setClearDataOpen] = useState(false);
  const [clearFlags, setClearFlags] = useState({
    cache: true,
    cookies: false,
    local: false,
    serviceWorkers: false,
  });
  const [clearing, setClearing] = useState(false);
  // CDP endpoint info for the right-sidebar built-in browser, surfaced as a
  // toolbar badge so external tools (chrome-devtools) know where to connect.
  const [cdpInfo, setCdpInfo] = useState<CdpInfo | null>(null);

  const refreshCdpInfo = useCallback(() => {
    if (!isElectron) return;
    const api = window.piDesktop;
    if (!api?.browserCdpInfo) return;
    api
      .browserCdpInfo()
      .then((info) => info && setCdpInfo(info as CdpInfo | null))
      .catch(() => {});
  }, [isElectron]);

  useEffect(() => {
    refreshCdpInfo();
  }, [refreshCdpInfo]);

  // Re-read once navigation settles so targetId / webviewUrl stay current.
  useEffect(() => {
    if (!isElectron || !url) return;
    const t = setTimeout(refreshCdpInfo, 700);
    return () => clearTimeout(t);
  }, [url, isElectron, refreshCdpInfo]);

  useEffect(() => {
    setIsElectron(typeof window !== "undefined" && !!window.piDesktop?.isDesktop);
  }, []);

  const navigateInternal = useCallback((targetUrl: string) => {
    if (!targetUrl) return;
    let normalizedUrl = targetUrl;
    if (!/^https?:\/\//i.test(targetUrl) && !targetUrl.startsWith("file://") && !targetUrl.startsWith("data:")) {
      if (targetUrl.startsWith("localhost") || targetUrl.startsWith("127.0.0.1")) {
        normalizedUrl = `http://${targetUrl}`;
      } else if (targetUrl.includes(".") && !targetUrl.includes(" ")) {
        normalizedUrl = `https://${targetUrl}`;
      }
    }
    setUrl(normalizedUrl);
    setLoadUrl(normalizedUrl);
    setInputValue(normalizedUrl);
    setContent(null);
    setIsLoading(true);
  }, []);


  const handleNavigate = useCallback((targetUrl: string) => {
    navigateInternal(targetUrl);
  }, [navigateInternal]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, []);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleNavigate(inputValue);
  }, [inputValue, handleNavigate]);

  const handleBack = useCallback(() => {
    const wv = webviewRef.current;
    if (isElectron && wv?.canGoBack()) wv.goBack();
  }, [isElectron]);

  const handleForward = useCallback(() => {
    const wv = webviewRef.current;
    if (isElectron && wv?.canGoForward()) wv.goForward();
  }, [isElectron]);

  const handleReload = useCallback(() => {
    const wv = webviewRef.current;
    if (isElectron && wv) wv.reload();
    else if (iframeRef.current) iframeRef.current.src = iframeRef.current.src;
  }, [isElectron]);

  const handleClearBrowserData = useCallback(async () => {
    const api = window.piDesktop;
    if (!api?.clearBrowserData) {
      setClearDataOpen(false);
      return;
    }
    setClearing(true);
    try {
      const res = await api.clearBrowserData(clearFlags);
      if (res?.ok) {
        const wv = webviewRef.current;
        if (isElectron && wv) wv.reload();
      }
    } catch {
      // best-effort; ignore IPC failures
    } finally {
      setClearing(false);
      setClearDataOpen(false);
    }
  }, [clearFlags, isElectron]);

  const handleWebviewDidNavigate = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    setUrl(wv.getURL());
    setInputValue(wv.getURL());
    setCanGoBack(wv.canGoBack());
    setCanGoForward(wv.canGoForward());
    setIsLoading(false);
  }, []);

  // Electron <webview> events (did-finish-load / did-navigate) are NOT React
  // synthetic events, so a React onXxx prop is silently ignored and emits
  // "Unknown event handler property" warnings. Attach them imperatively on the
  // real DOM node via addEventListener instead.
  const setWebviewRef = useCallback(
    (el: BrowserWebviewEl | null) => {
      const prev = webviewRef.current;
      if (prev && prev.__cleanupBrowserNav) {
        prev.__cleanupBrowserNav();
      }
      webviewRef.current = el;
      if (!el) return;
      const handler = () => handleWebviewDidNavigate();
      el.addEventListener("did-finish-load", handler);
      el.addEventListener("did-navigate", handler);
      el.__cleanupBrowserNav = () => {
        el.removeEventListener("did-finish-load", handler);
        el.removeEventListener("did-navigate", handler);
      };
    },
    [handleWebviewDidNavigate]
  );

  const handleIframeLoad = useCallback(() => {
    setIsLoading(false);
  }, []);

  const containerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "var(--bg)",
  };

  const toolbarStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 8px",
    background: "var(--bg-panel)",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  };

  const navButtonStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    border: "none",
    borderRadius: 4,
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: 0,
    flexShrink: 0,
  };

  const navButtonDisabledStyle: CSSProperties = {
    ...navButtonStyle,
    color: "var(--text-dim)",
    cursor: "default",
    opacity: 0.5,
  };

  const inputStyle: CSSProperties = {
    flex: 1,
    height: 28,
    padding: "0 10px",
    border: "1px solid var(--border)",
    borderRadius: 4,
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 12,
    outline: "none",
  };

  const contentStyle: CSSProperties = {
    flex: 1,
    overflow: "hidden",
    position: "relative",
  };

  const renderContent = () => {
    if (content) {
      return (
        <iframe
          ref={iframeRef}
          srcDoc={content}
          sandbox="allow-scripts"
          onLoad={handleIframeLoad}
          style={{ width: "100%", height: "100%", border: "none" }}
          title="HTML Preview"
        />
      );
    }

    if (url) {
      if (isElectron) {
        return (
          <webview
            ref={setWebviewRef}
            src={loadUrl}
            partition="persist:browser"
            allowpopups={"true" as unknown as boolean}
            style={{ width: "100%", height: "100%", border: "none" } as CSSProperties}
          />
        );
      }
      return (
        <iframe
          ref={iframeRef}
          src={loadUrl}
          onLoad={handleIframeLoad}
          style={{ width: "100%", height: "100%", border: "none" }}
          title="Browser Preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      );
    }

    return (
      <div style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-dim)",
        fontSize: 12,
      }}>
        Enter a URL or preview HTML content
      </div>
    );
  };

  return (
    <div style={containerStyle}>
      <div style={toolbarStyle}>
        <button onClick={handleBack} disabled={!canGoBack} style={canGoBack ? navButtonStyle : navButtonDisabledStyle} title="Back">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button onClick={handleForward} disabled={!canGoForward} style={canGoForward ? navButtonStyle : navButtonDisabledStyle} title="Forward">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button onClick={handleReload} style={navButtonStyle} title="Reload">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        <input type="text" value={inputValue} onChange={handleInputChange} onKeyDown={handleInputKeyDown} style={inputStyle} placeholder="Enter URL..." />
        {isElectron && (
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button
              onClick={() => setClearDataOpen((v) => !v)}
              style={navButtonStyle}
              title="清除浏览器数据"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
            {clearDataOpen && (
              <>
                <div onClick={() => setClearDataOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
                <div style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  zIndex: 21,
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: 8,
                  minWidth: 220,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                    清除浏览器数据
                  </div>
                  {([
                    { key: "cache", label: "缓存" },
                    { key: "cookies", label: "Cookie（含登录态）" },
                    { key: "local", label: "本地存储 (localStorage/IndexedDB)" },
                    { key: "serviceWorkers", label: "Service Worker" },
                  ] as const).map((item) => (
                    <label
                      key={item.key}
                      style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text)", cursor: "pointer", padding: "3px 0" }}
                    >
                      <input
                        type="checkbox"
                        checked={clearFlags[item.key]}
                        onChange={(e) => setClearFlags((f) => ({ ...f, [item.key]: e.target.checked }))}
                      />
                      {item.label}
                    </label>
                  ))}
                  {(() => {
                    const noneSelected = !clearFlags.cache && !clearFlags.cookies && !clearFlags.local && !clearFlags.serviceWorkers;
                    return (
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <button
                          onClick={handleClearBrowserData}
                          disabled={clearing || noneSelected}
                          style={{
                            flex: 1,
                            height: 26,
                            fontSize: 12,
                            border: "none",
                            borderRadius: 4,
                            background: clearing || noneSelected ? "var(--bg-hover)" : "var(--accent)",
                            color: clearing || noneSelected ? "var(--text-dim)" : "#fff",
                            cursor: clearing || noneSelected ? "default" : "pointer",
                          }}
                        >
                          {clearing ? "清除中…" : "清除"}
                        </button>
                        <button
                          onClick={() => setClearDataOpen(false)}
                          style={{
                            height: 26,
                            padding: "0 10px",
                            fontSize: 12,
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            background: "transparent",
                            color: "var(--text-muted)",
                            cursor: "pointer",
                          }}
                        >
                          取消
                        </button>
                      </div>
                    );
                  })()}
                </div>
              </>
            )}
          </div>
        )}
        {cdpInfo && (
          <div
            title={
              `chrome-devtools 连接命令：\n` +
              `connect_over_cdp({ browserURL: "${cdpInfo.endpoint}" })\n` +
              (cdpInfo.webviews && cdpInfo.webviews.length > 0
                ? `list_pages 可见全部 ${cdpInfo.webviews.length} 个 webview，按 URL 匹配目标：\n` +
                  cdpInfo.webviews
                    .map((w, i) => `[${i + 1}] ${w.url || "(空)"}  targetId: ${w.targetId ?? "-"}`)
                    .join("\n")
                : `在 list_pages 中按 URL 匹配 webview\n`) +
              (cdpInfo.webviewUrl ? `\n当前 webview URL: ${cdpInfo.webviewUrl}` : "")
            }
            style={{
              fontSize: 10,
              lineHeight: 1,
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "4px 6px",
              whiteSpace: "nowrap",
              cursor: "help",
              flexShrink: 0,
            }}
          >
            CDP :{cdpInfo.port ?? 9333}
            {cdpInfo.webviews && cdpInfo.webviews.length > 0 ? ` (${cdpInfo.webviews.length})` : ""}
          </div>
        )}
      </div>
      <div style={contentStyle}>
        {isLoading && (
          <div style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background: "var(--accent)",
            zIndex: 10,
            animation: "browserLoading 1s ease-in-out infinite",
          }} />
        )}
        {renderContent()}
        {url === "about:blank" && (
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "var(--text-dim)",
            fontSize: 13,
            pointerEvents: "none",
          }}>
            <div>等待 chrome-devtools 接管…</div>
            <div style={{ fontSize: 11 }}>CDP :{cdpInfo?.port ?? 9333}</div>
          </div>
        )}
      </div>
    </div>
  );
}
