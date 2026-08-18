// Real connectivity probing for configured MCP servers, independent of any
// running agent session. HTTP servers get a JSON-RPC handshake (mirroring
// pi-mcp-adapter's probe strategy but with the configured auth headers), and
// stdio servers get a short-lived child process speaking MCP over stdin.

import { spawn } from "node:child_process";
import {
  serverTypeOf,
  type McpServerEntry,
  type McpServerType,
} from "./mcp-config-store";
import { proxiedFetch, withProxyEnv } from "./proxy-config";

export const HTTP_PROBE_TIMEOUT_MS = 10_000;
export const STDIO_PROBE_TIMEOUT_MS = 30_000;

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const JSON_ACCEPT = "application/json, text/event-stream";
/** Statuses where the modern strategy just mismatches the endpoint shape. */
const MODERN_FALLBACK_STATUSES = new Set([400, 401, 404, 405, 406, 415]);

export type McpProbeStatus = "connected" | "needs-auth" | "failed" | "skipped";

export interface McpProbeRequest {
  name: string;
  entry: McpServerEntry;
}

export interface McpProbeOutcome {
  name: string;
  type: McpServerType;
  status: McpProbeStatus;
  latencyMs: number | null;
  protocolVersion?: string;
  serverInfo?: string;
  error?: string;
}

/** Values like `$env:API_KEY` reference the server process environment. */
function interpolateValue(value: string): string {
  if (value.startsWith("$env:")) {
    return process.env[value.slice("$env:".length)] ?? "";
  }
  return value;
}

function buildAuthHeaders(entry: McpServerEntry): Record<string, string> {
  const headers: Record<string, string> = {};
  if (entry.headers && typeof entry.headers === "object") {
    for (const [key, value] of Object.entries(entry.headers)) {
      if (typeof value === "string") headers[key] = interpolateValue(value);
    }
  }
  if (typeof entry.bearerToken === "string" && entry.bearerToken) {
    headers.Authorization = `Bearer ${interpolateValue(entry.bearerToken)}`;
  } else if (typeof entry.bearerTokenEnv === "string" && entry.bearerTokenEnv) {
    const token = process.env[entry.bearerTokenEnv];
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function isBearerChallenge(response: Response): boolean {
  return /(?:^|,)\s*Bearer\b/i.test(response.headers.get("www-authenticate") ?? "");
}

interface JsonRpcEnvelope {
  kind: "result" | "error";
  protocolVersion?: string;
  serverInfo?: string;
}

function parseJsonRpcEnvelope(value: unknown): JsonRpcEnvelope | null {
  if (
    !value || typeof value !== "object"
    || (value as { jsonrpc?: unknown }).jsonrpc !== "2.0"
  ) {
    return null;
  }
  const obj = value as { result?: unknown; error?: unknown };
  if ("result" in obj) {
    const result = (obj.result && typeof obj.result === "object")
      ? obj.result as Record<string, unknown>
      : {};
    const serverInfo = (result.serverInfo && typeof result.serverInfo === "object")
      ? result.serverInfo as Record<string, unknown>
      : null;
    return {
      kind: "result",
      protocolVersion: typeof result.protocolVersion === "string"
        ? result.protocolVersion
        : undefined,
      serverInfo: serverInfo && typeof serverInfo.name === "string"
        ? serverInfo.name
        : undefined,
    };
  }
  if ("error" in obj) return { kind: "error" };
  return null;
}

async function readEnvelope(response: Response): Promise<JsonRpcEnvelope | null> {
  try {
    return parseJsonRpcEnvelope(JSON.parse(await response.text()));
  } catch {
    return null;
  }
}

function failedResponseSummary(response: Response): string {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  return `HTTP ${response.status}${contentType ? ` (${contentType})` : ""}`;
}

async function probeHttpUrl(
  url: string,
  authHeaders: Record<string, string>,
): Promise<Omit<McpProbeOutcome, "name" | "type">> {
  // Strategy 1: modern stateless `server/discover`.
  try {
    const response = await proxiedFetch(url, {
      method: "POST",
      headers: {
        ...authHeaders,
        Accept: JSON_ACCEPT,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
        "Mcp-Method": "server/discover",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
      signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
    });
    const isSse = response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream");
    if (response.ok && isSse) {
      return { status: "connected", latencyMs: null, protocolVersion: MODERN_PROTOCOL_VERSION };
    }
    const envelope = await readEnvelope(response);
    if (response.ok && envelope) {
      if (envelope.kind !== "error" && envelope.protocolVersion === MODERN_PROTOCOL_VERSION) {
        return {
          status: "connected",
          latencyMs: null,
          protocolVersion: envelope.protocolVersion,
          ...(envelope.serverInfo ? { serverInfo: envelope.serverInfo } : {}),
        };
      }
      // Endpoint speaks MCP but not the modern version — try legacy below.
    } else if (response.status === 401 && isBearerChallenge(response)) {
      return { status: "needs-auth", latencyMs: null, error: "endpoint requires Bearer authentication" };
    } else if (!MODERN_FALLBACK_STATUSES.has(response.status)) {
      return { status: "failed", latencyMs: null, error: failedResponseSummary(response) };
    }
  } catch (error) {
    return { status: "failed", latencyMs: null, error: error instanceof Error ? error.message : String(error) };
  }

  // Strategy 2: legacy `initialize` POST.
  try {
    const response = await proxiedFetch(url, {
      method: "POST",
      headers: {
        ...authHeaders,
        Accept: JSON_ACCEPT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "pi-studio-probe", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
    });
    const isSse = response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream");
    if (response.ok && isSse) {
      return { status: "connected", latencyMs: null };
    }
    const envelope = await readEnvelope(response);
    if (response.ok && envelope) {
      return {
        status: "connected",
        latencyMs: null,
        ...(envelope.protocolVersion ? { protocolVersion: envelope.protocolVersion } : {}),
        ...(envelope.serverInfo ? { serverInfo: envelope.serverInfo } : {}),
      };
    }
    if (response.status === 401 && isBearerChallenge(response)) {
      return { status: "needs-auth", latencyMs: null, error: "endpoint requires Bearer authentication" };
    }
  } catch (error) {
    return { status: "failed", latencyMs: null, error: error instanceof Error ? error.message : String(error) };
  }

  // Strategy 3: plain GET expecting an SSE stream (older HTTP transports).
  try {
    const response = await proxiedFetch(url, {
      headers: { ...authHeaders, Accept: "text/event-stream" },
      signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
    });
    const isSse = response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream");
    if (response.ok && isSse) {
      return { status: "connected", latencyMs: null };
    }
    if (response.status === 401 && isBearerChallenge(response)) {
      return { status: "needs-auth", latencyMs: null, error: "endpoint requires Bearer authentication" };
    }
    return { status: "failed", latencyMs: null, error: `endpoint did not speak MCP: ${failedResponseSummary(response)}` };
  } catch (error) {
    return { status: "failed", latencyMs: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function probeStdioEntry(
  entry: McpServerEntry,
  timeoutMs: number,
): Promise<Omit<McpProbeOutcome, "name" | "type">> {
  return new Promise((resolve) => {
    const command = entry.command;
    if (!command) {
      resolve({ status: "failed", latencyMs: null, error: "missing command" });
      return;
    }

    let env: NodeJS.ProcessEnv;
    try {
      const merged = { ...process.env };
      if (entry.env && typeof entry.env === "object") {
        for (const [key, value] of Object.entries(entry.env)) {
          if (typeof value === "string") merged[key] = interpolateValue(value);
        }
      }
      env = withProxyEnv(merged);
    } catch (error) {
      resolve({ status: "failed", latencyMs: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, Array.isArray(entry.args) ? entry.args : [], {
        env,
        cwd: typeof entry.cwd === "string" && entry.cwd ? entry.cwd : undefined,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ status: "failed", latencyMs: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const started = Date.now();
    let settled = false;
    let stdoutBuffer = "";
    let stderrTail = "";

    const finish = (outcome: Omit<McpProbeOutcome, "name" | "type">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Already exited; nothing to clean up.
      }
      resolve({ ...outcome, latencyMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      const context = stderrTail.trim() ? ` — ${stderrTail.trim().slice(-300)}` : "";
      finish({
        status: "failed",
        latencyMs: null,
        error: `no MCP response within ${Math.round(timeoutMs / 1000)}s${context}`,
      });
    }, timeoutMs);

    child.on("error", (error) => {
      finish({ status: "failed", latencyMs: null, error: error.message });
    });
    child.on("close", (code) => {
      const context = stderrTail.trim() ? ` — ${stderrTail.trim().slice(-300)}` : "";
      finish({
        status: "failed",
        latencyMs: null,
        error: `process exited (code ${code ?? "null"}) before responding${context}`,
      });
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      let newline = stdoutBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as { id?: unknown; result?: unknown };
            if (message.id === 1 && message.result) {
              const envelope = parseJsonRpcEnvelope({ jsonrpc: "2.0", id: 1, result: message.result });
              finish({
                status: "connected",
                latencyMs: null,
                ...(envelope?.protocolVersion ? { protocolVersion: envelope.protocolVersion } : {}),
                ...(envelope?.serverInfo ? { serverInfo: envelope.serverInfo } : {}),
              });
            }
          } catch {
            // Not a JSON-RPC line (installer noise etc.) — keep waiting.
          }
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    try {
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LEGACY_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "pi-studio-probe", version: "1.0.0" },
          },
        })}\n`,
      );
    } catch (error) {
      finish({ status: "failed", latencyMs: null, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** Probe one server; never throws — every failure lands in the outcome. */
export async function probeMcpServer(request: McpProbeRequest): Promise<McpProbeOutcome> {
  const { name, entry } = request;
  const type = serverTypeOf(entry);
  const started = Date.now();
  try {
    if (type === "http" && entry.url) {
      const result = await probeHttpUrl(entry.url, buildAuthHeaders(entry));
      return { name, type, ...result, latencyMs: Date.now() - started };
    }
    if (type === "stdio") {
      const result = await probeStdioEntry(entry, STDIO_PROBE_TIMEOUT_MS);
      return { name, type, ...result, latencyMs: Date.now() - started };
    }
    return {
      name,
      type,
      status: "skipped",
      latencyMs: null,
      error: type === "socket" ? "socket servers are not probed" : "entry has no url or command",
    };
  } catch (error) {
    return {
      name,
      type,
      status: "failed",
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Probe many servers concurrently, preserving request order in results. */
export async function probeMcpServers(
  requests: McpProbeRequest[],
): Promise<McpProbeOutcome[]> {
  return Promise.all(requests.map((request) => probeMcpServer(request)));
}
