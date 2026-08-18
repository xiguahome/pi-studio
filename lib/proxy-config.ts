// Network proxy configuration for outbound operations (skill install/update/
// search, built-in extension npm installs, update checks against GitHub and
// skills.sh). Stored in <agentDir>/proxy.json; when set, HTTP(S) proxy env
// vars are injected into spawned git/npm/npx children and server-side fetch
// goes through an undici EnvHttpProxyAgent.

import { readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { writeFileAtomicSync } from "./atomic-file";

export interface ProxyConfig {
  /** Proxy URL (http://, https:// or socks5://); null when unconfigured. */
  url: string | null;
}

const ALLOWED_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks5:",
  "socks5h:",
  "socks4:",
  "socks4a:",
]);

export function getProxyConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "proxy.json");
}

/** Read the stored proxy; missing or corrupt files mean "unconfigured". */
export function readProxyConfig(path: string = getProxyConfigPath()): ProxyConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { url?: unknown };
    if (typeof parsed.url === "string" && parsed.url.trim()) {
      return { url: parsed.url.trim() };
    }
    return { url: null };
  } catch {
    return { url: null };
  }
}

/** Validate a proxy URL; returns an error message or null when valid. */
export function validateProxyUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Proxy must be a valid URL, e.g. http://127.0.0.1:7890";
  }
  if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    return "Proxy protocol must be http(s):// or socks5://";
  }
  if (!parsed.hostname) {
    return "Proxy URL must include a host";
  }
  return null;
}

export function saveProxyConfig(
  url: string | null,
  path: string = getProxyConfigPath(),
): void {
  writeFileAtomicSync(path, `${JSON.stringify({ url }, null, 2)}\n`);
}

/** Env vars git/npm/npx understand; both cases because tools differ. */
export function proxyEnvVars(url: string): Record<string, string> {
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
  };
}

/**
 * Merge the configured proxy into a child-process env. With no configured
 * proxy the input env passes through untouched (inherited HTTP_PROXY etc.
 * keep working).
 */
export function withProxyEnv(
  env: NodeJS.ProcessEnv,
  config: ProxyConfig = readProxyConfig(),
): NodeJS.ProcessEnv {
  if (!config.url) return env;
  return { ...env, ...proxyEnvVars(config.url) };
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

/**
 * Sync the stored proxy into the server process env. Needed for code paths
 * we do not control — e.g. the SDK's DefaultPackageManager spawns npm/git
 * itself and inherits process.env — so every child process picks the proxy
 * up without per-call injection. Call on boot and after every config change.
 */
export function applyProxyToProcessEnv(config: ProxyConfig = readProxyConfig()): void {
  for (const key of PROXY_ENV_KEYS) {
    if (config.url) process.env[key] = config.url;
    else delete process.env[key];
  }
}

// One shared dispatcher per proxy URL: ProxyAgent keeps a connection pool,
// and EnvHttpProxyAgent's `env` option proved unreliable here (requests
// silently fell back to direct connections). Explicit uri always works.
let cachedAgent: { url: string; agent: ProxyAgent } | null = null;

function getProxyAgent(url: string): ProxyAgent {
  if (cachedAgent && cachedAgent.url === url) return cachedAgent.agent;
  cachedAgent?.agent.close().catch(() => {});
  const agent = new ProxyAgent(url);
  cachedAgent = { url, agent };
  return agent;
}

/**
 * fetch() that honors the configured proxy. Node's global fetch ignores
 * HTTP_PROXY by default, and mixing an undici dispatcher into it is fragile
 * (the bundled undici version differs from Node's internal one), so route
 * through undici's own fetch + ProxyAgent. Falls back to plain fetch when
 * unconfigured.
 */
export async function proxiedFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const { url } = readProxyConfig();
  if (!url) return fetch(input, init);
  const response = await undiciFetch(input, {
    ...(init ?? {}),
    dispatcher: getProxyAgent(url),
  } as Parameters<typeof undiciFetch>[1]);
  return response as unknown as Response;
}
