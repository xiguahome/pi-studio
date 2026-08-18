import { NextResponse } from "next/server";
import { requestNewBrowserTab } from "@/lib/browser-tab-bridge";

export const dynamic = "force-dynamic";

// POST /api/browser-tabs/open - fallback entry point for "open a new built-in
// browser tab". Normally the chrome-devtools extension calls
// requestNewBrowserTab() directly via globalThis (same process); this route
// covers the edge case where the extension runs out-of-process and can only
// reach pi-studio over HTTP. Body: { "url": string }.
export async function POST(request: Request) {
  let url: unknown;
  try {
    const body = await request.json();
    url = body?.url;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof url !== "string" || url.length === 0) {
    return NextResponse.json({ ok: false, error: "expected { url: string }" }, { status: 400 });
  }
  requestNewBrowserTab(url);
  return NextResponse.json({ ok: true });
}
