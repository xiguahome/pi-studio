// Server-only. Bridges "open a new built-in browser tab" requests from the
// in-process chrome-devtools extension to the renderer, which owns the
// <webview> tabs.
//
// The chrome-devtools extension runs inside the in-process AgentSession
// (lib/rpc-manager.ts), so it shares this Node process's globalThis and calls
// requestNewBrowserTab() directly — no network hop. The renderer cannot see
// globalThis (different process), so it subscribes via the
// /api/browser-tabs/events SSE stream, which calls subscribeBrowserTabs().

export interface BrowserTabRequest {
  url: string;
}

type BrowserTabListener = (req: BrowserTabRequest) => void;

interface BrowserTabBridge {
  requestNewTab(url: string): void;
  subscribe(fn: BrowserTabListener): () => void;
}

// Listeners live on globalThis so they survive Next.js hot-reload (same pattern
// as __piRunningListeners in rpc-manager.ts).
function getBridge(): BrowserTabBridge {
  const g = globalThis as { __piBrowserTabBridge?: BrowserTabBridge };
  if (!g.__piBrowserTabBridge) {
    const listeners = new Set<BrowserTabListener>();
    g.__piBrowserTabBridge = {
      requestNewTab(url) {
        for (const fn of listeners) {
          try {
            fn({ url });
          } catch {
            // ignore listener errors — one dead subscriber must not break others
          }
        }
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    };
  }
  return g.__piBrowserTabBridge;
}

/** Request the renderer to open a new built-in browser tab. Called by the chrome-devtools extension. */
export function requestNewBrowserTab(url: string): void {
  getBridge().requestNewTab(url);
}

/** Subscribe to open-tab requests. Used by the SSE route. Returns an unsubscribe function. */
export function subscribeBrowserTabs(fn: BrowserTabListener): () => void {
  return getBridge().subscribe(fn);
}
