import { NextResponse } from "next/server";
import {
  listEffectiveServers,
  McpConfigValidationError,
  readMcpCacheInfo,
  readMcpConfig,
  writeMcpConfig,
} from "@/lib/mcp-config-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd");
  return NextResponse.json({
    global: readMcpConfig("global"),
    project: cwd ? readMcpConfig("project", cwd) : null,
    effective: listEffectiveServers(cwd),
    cache: readMcpCacheInfo(),
  });
}

export async function PUT(req: Request) {
  let body: { scope?: unknown; cwd?: unknown; content?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const scope = body.scope;
  if (scope !== "global" && scope !== "project") {
    return NextResponse.json({ error: "scope must be global or project" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 });
  }
  if (scope === "project" && (typeof body.cwd !== "string" || !body.cwd)) {
    return NextResponse.json({ error: "project scope requires cwd" }, { status: 400 });
  }

  try {
    const path = writeMcpConfig(
      scope,
      body.content,
      scope === "project" ? (body.cwd as string) : undefined,
    );
    return NextResponse.json({ success: true, path });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof McpConfigValidationError) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
