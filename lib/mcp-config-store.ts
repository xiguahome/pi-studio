// MCP connector config store for the pi-mcp-adapter extension. The global
// config lives at <agentDir>/mcp.json; a project-local .mcp.json may override
// it per project. Same-name servers merge with project winning, matching the
// precedence pi-mcp-adapter applies when sessions load.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import stripJsonComments from "strip-json-comments";
import { writeFileAtomicSync } from "./atomic-file";

export type McpScope = "global" | "project";
export type McpServerType = "http" | "stdio" | "socket" | "unknown";

export interface McpServerEntry {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  bearerToken?: string;
  bearerTokenEnv?: string;
  socket?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface McpConfigFile {
  scope: McpScope;
  path: string;
  exists: boolean;
  rawText: string;
  servers: Record<string, McpServerEntry>;
  /** Parse error for rawText when the file exists but is invalid. */
  error: string | null;
}

export interface EffectiveMcpServer {
  name: string;
  source: McpScope;
  type: McpServerType;
  summary: string;
  disabled: boolean;
  entry: McpServerEntry;
}

export interface McpCacheInfo {
  toolCount: number;
  resourceCount: number;
  cachedAt: number | null;
}

/** Thrown when user-supplied config text fails validation before writing. */
export class McpConfigValidationError extends Error {}

export function getGlobalMcpConfigPath(): string {
  return join(getAgentDir(), "mcp.json");
}

export function getProjectMcpConfigPath(cwd: string): string {
  return join(cwd, ".mcp.json");
}

export function getMcpCachePath(): string {
  return join(getAgentDir(), "mcp-cache.json");
}

/**
 * Parse config text the way pi-mcp-adapter does: JSON with comments and
 * trailing commas allowed. Throws McpConfigValidationError with a readable
 * message when the text is unusable.
 */
export function parseMcpConfigText(rawText: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(rawText, { trailingCommas: true }));
  } catch (error) {
    throw new McpConfigValidationError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new McpConfigValidationError("config root must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Extract the mcpServers map from a parsed config, validating entry shapes. */
export function extractMcpServers(
  parsed: Record<string, unknown>,
): Record<string, McpServerEntry> {
  const raw = parsed.mcpServers ?? parsed["mcp-servers"];
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new McpConfigValidationError("mcpServers must be an object");
  }
  const servers: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new McpConfigValidationError(`mcpServers.${name} must be an object`);
    }
    servers[name] = entry as McpServerEntry;
  }
  return servers;
}

export function readMcpConfig(
  scope: McpScope,
  cwd?: string | null,
): McpConfigFile {
  const path =
    scope === "global"
      ? getGlobalMcpConfigPath()
      : getProjectMcpConfigPath(cwd ?? process.cwd());
  const result: McpConfigFile = {
    scope,
    path,
    exists: false,
    rawText: "",
    servers: {},
    error: null,
  };
  if (!existsSync(path)) return result;
  result.exists = true;
  try {
    result.rawText = readFileSync(path, "utf8");
    result.servers = extractMcpServers(parseMcpConfigText(result.rawText));
  } catch (error) {
    result.error =
      error instanceof McpConfigValidationError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
  }
  return result;
}

/**
 * Validate and atomically write config text. Empty text clears the servers
 * map (writes a `{ "mcpServers": {} }` skeleton). Returns the written path.
 */
export function writeMcpConfig(
  scope: McpScope,
  content: string,
  cwd?: string | null,
): string {
  const path =
    scope === "global"
      ? getGlobalMcpConfigPath()
      : getProjectMcpConfigPath(cwd ?? process.cwd());

  const trimmed = content.trim();
  let output: string;
  if (!trimmed) {
    output = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
  } else {
    const parsed = parseMcpConfigText(trimmed);
    extractMcpServers(parsed);
    output = trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileAtomicSync(path, output);
  return path;
}

export function serverTypeOf(entry: McpServerEntry): McpServerType {
  if (typeof entry.url === "string") return "http";
  if (typeof entry.command === "string") return "stdio";
  if (typeof entry.socket === "string") return "socket";
  return "unknown";
}

export function summarizeServerEntry(entry: McpServerEntry): string {
  if (typeof entry.url === "string") return entry.url;
  if (typeof entry.command === "string") {
    const args = Array.isArray(entry.args) ? entry.args.join(" ") : "";
    return args ? `${entry.command} ${args}` : entry.command;
  }
  if (typeof entry.socket === "string") return entry.socket;
  return "";
}

/**
 * Merge both config layers into the server set pi-mcp-adapter would load.
 * Same-name entries: project wins wholesale (no per-field merge), which keeps
 * this view honest about which file owns each row for editing and deletion.
 */
export function listEffectiveServers(
  cwd?: string | null,
): EffectiveMcpServer[] {
  const global = readMcpConfig("global");
  const project = cwd ? readMcpConfig("project", cwd) : null;
  const merged = new Map<string, EffectiveMcpServer>();

  for (const [name, entry] of Object.entries(global.servers)) {
    merged.set(name, {
      name,
      source: "global",
      type: serverTypeOf(entry),
      summary: summarizeServerEntry(entry),
      disabled: entry.disabled === true,
      entry,
    });
  }
  if (project) {
    for (const [name, entry] of Object.entries(project.servers)) {
      merged.set(name, {
        name,
        source: "project",
        type: serverTypeOf(entry),
        summary: summarizeServerEntry(entry),
        disabled: entry.disabled === true,
        entry,
      });
    }
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Per-server metadata cached by pi-mcp-adapter after successful connects. */
export function readMcpCacheInfo(
  cachePath = getMcpCachePath(),
): Record<string, McpCacheInfo> {
  const info: Record<string, McpCacheInfo> = {};
  if (!existsSync(cachePath)) return info;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
      servers?: Record<
        string,
        {
          tools?: unknown[];
          resources?: unknown[];
          cachedAt?: unknown;
        }
      >;
    };
    if (!parsed || typeof parsed !== "object" || !parsed.servers) return info;
    for (const [name, entry] of Object.entries(parsed.servers)) {
      if (!entry || typeof entry !== "object") continue;
      info[name] = {
        toolCount: Array.isArray(entry.tools) ? entry.tools.length : 0,
        resourceCount: Array.isArray(entry.resources) ? entry.resources.length : 0,
        cachedAt: typeof entry.cachedAt === "number" ? entry.cachedAt : null,
      };
    }
  } catch {
    // Corrupt cache is not actionable here; pi-mcp-adapter rebuilds it.
  }
  return info;
}
