import { subscribeBrowserTabs } from "@/lib/browser-tab-bridge";

export const dynamic = "force-dynamic";

// GET /api/browser-tabs/events - SSE stream of "open a new built-in browser
// tab" requests. The in-process chrome-devtools extension calls
// requestNewBrowserTab() (via globalThis) when it needs a new <webview> tab;
// this stream forwards each request to the renderer so AppShell can mount it.
// Structure mirrors app/api/agent/running/events/route.ts.
export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      const unsubscribe = subscribeBrowserTabs((reqData) => {
        try {
          encode({ type: "open-tab", url: reqData.url });
        } catch {
          // controller already closed
        }
      });

      // Heartbeat to keep the connection alive through proxies/timeouts.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
