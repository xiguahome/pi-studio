import { NextResponse } from "next/server";
import { probeMcpServers, type McpProbeRequest } from "@/lib/mcp-probe";
import type { McpServerEntry } from "@/lib/mcp-config-store";

export const dynamic = "force-dynamic";

// stdio probes can run up to 30s each (concurrently); keep Next from cutting
// the request short in serverless-style deployments.
export const maxDuration = 60;

const MAX_SERVERS_PER_REQUEST = 50;

export async function POST(req: Request) {
  let body: { servers?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.servers) || body.servers.length === 0) {
    return NextResponse.json({ error: "servers must be a non-empty array" }, { status: 400 });
  }
  if (body.servers.length > MAX_SERVERS_PER_REQUEST) {
    return NextResponse.json(
      { error: `at most ${MAX_SERVERS_PER_REQUEST} servers per request` },
      { status: 400 },
    );
  }

  const requests: McpProbeRequest[] = [];
  for (const item of body.servers) {
    if (!item || typeof item !== "object") continue;
    const { name, entry } = item as { name?: unknown; entry?: unknown };
    if (typeof name !== "string" || !name) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    requests.push({ name, entry: entry as McpServerEntry });
  }
  if (requests.length === 0) {
    return NextResponse.json({ error: "no valid server entries" }, { status: 400 });
  }

  const results = await probeMcpServers(requests);
  return NextResponse.json({ results });
}
