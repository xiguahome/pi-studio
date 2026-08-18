import { NextResponse } from "next/server";
import {
  applyProxyToProcessEnv,
  readProxyConfig,
  saveProxyConfig,
  validateProxyUrl,
} from "@/lib/proxy-config";
import { hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// GET /api/network/proxy — current proxy configuration
export async function GET() {
  try {
    return NextResponse.json(readProxyConfig());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PUT /api/network/proxy — { url: string | null } (null/"" clears)
export async function PUT(req: Request) {
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }
  try {
    const body = (await req.json()) as { url?: unknown };
    const raw = typeof body.url === "string" ? body.url.trim() : "";
    if (!raw) {
      saveProxyConfig(null);
      applyProxyToProcessEnv({ url: null });
      return NextResponse.json({ success: true, url: null });
    }
    const validationError = validateProxyUrl(raw);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
    saveProxyConfig(raw);
    applyProxyToProcessEnv({ url: raw });
    return NextResponse.json({ success: true, url: raw });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
