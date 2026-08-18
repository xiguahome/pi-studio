import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-mcp-store-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url);
const {
  McpConfigValidationError,
  extractMcpServers,
  getGlobalMcpConfigPath,
  listEffectiveServers,
  parseMcpConfigText,
  readMcpCacheInfo,
  readMcpConfig,
  serverTypeOf,
  summarizeServerEntry,
  writeMcpConfig,
} = await jiti.import("./mcp-config-store.ts");

function createProject(t) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-mcp-project-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test("parseMcpConfigText accepts comments and trailing commas", () => {
  const parsed = parseMcpConfigText(`{
    // global servers
    "mcpServers": {
      "zread": { "url": "https://example.test/mcp" }, // trailing comma below
    },
  }`);
  const servers = extractMcpServers(parsed);
  assert.equal(servers.zread.url, "https://example.test/mcp");
});

test("parseMcpConfigText rejects non-object roots and bad JSON", () => {
  assert.throws(() => parseMcpConfigText("[1,2]"), McpConfigValidationError);
  assert.throws(() => parseMcpConfigText("{ nope"), McpConfigValidationError);
});

test("extractMcpServers validates the mcpServers shape", () => {
  assert.deepEqual(extractMcpServers({}), {});
  assert.throws(() => extractMcpServers({ mcpServers: [] }), /must be an object/);
  assert.throws(() => extractMcpServers({ mcpServers: { a: "x" } }), /mcpServers\.a/);
  // legacy key accepted too, same as pi-mcp-adapter
  assert.deepEqual(extractMcpServers({ "mcp-servers": { a: { url: "u" } } }), { a: { url: "u" } });
});

test("writeMcpConfig validates before writing and round-trips", (t) => {
  const cwd = createProject(t);
  assert.throws(
    () => writeMcpConfig("project", "{ bad json", cwd),
    McpConfigValidationError,
  );
  const path = writeMcpConfig(
    "project",
    JSON.stringify({ mcpServers: { demo: { url: "https://demo.test/mcp" } } }),
    cwd,
  );
  assert.equal(path, join(cwd, ".mcp.json"));
  const read = readMcpConfig("project", cwd);
  assert.equal(read.exists, true);
  assert.equal(read.error, null);
  assert.equal(read.servers.demo.url, "https://demo.test/mcp");
});

test("writeMcpConfig writes an empty skeleton for blank content", (t) => {
  const cwd = createProject(t);
  const path = writeMcpConfig("project", "   \n", cwd);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mcpServers: {} });
});

test("global scope reads and writes <agentDir>/mcp.json", (t) => {
  t.after(() => rmSync(getGlobalMcpConfigPath(), { force: true }));
  const before = readMcpConfig("global");
  assert.equal(before.exists, false);
  assert.deepEqual(before.servers, {});

  writeMcpConfig("global", JSON.stringify({ mcpServers: { g: { command: "node", args: ["server.js"] } } }));
  const after = readMcpConfig("global");
  assert.equal(after.exists, true);
  assert.equal(after.servers.g.command, "node");
});

test("readMcpConfig surfaces parse errors without losing the raw text", (t) => {
  const cwd = createProject(t);
  writeFileSync(join(cwd, ".mcp.json"), "{ broken", "utf8");
  const read = readMcpConfig("project", cwd);
  assert.equal(read.exists, true);
  assert.ok(read.error);
  assert.equal(read.rawText, "{ broken");
  assert.deepEqual(read.servers, {});
});

test("listEffectiveServers merges layers with project winning", (t) => {
  const cwd = createProject(t);
  t.after(() => rmSync(getGlobalMcpConfigPath(), { force: true }));
  writeMcpConfig("global", JSON.stringify({
    mcpServers: {
      shared: { url: "https://global.test/mcp" },
      "global-only": { command: "node" },
      off: { url: "https://off.test/mcp", disabled: true },
    },
  }));
  writeMcpConfig("project", JSON.stringify({
    mcpServers: {
      shared: { command: "npx", args: ["-y", "shared-server"] },
    },
  }));

  const globalOnly = listEffectiveServers(null);
  assert.deepEqual(globalOnly.map((s) => s.name), ["global-only", "off", "shared"]);

  const merged = listEffectiveServers(cwd);
  const byName = Object.fromEntries(merged.map((s) => [s.name, s]));
  assert.equal(byName.shared.source, "project");
  assert.equal(byName.shared.type, "stdio");
  assert.equal(byName.shared.summary, "npx -y shared-server");
  assert.equal(byName["global-only"].source, "global");
  assert.equal(byName["global-only"].type, "stdio");
  assert.equal(byName.off.disabled, true);
});

test("serverTypeOf and summarizeServerEntry cover every transport", () => {
  assert.equal(serverTypeOf({ url: "u" }), "http");
  assert.equal(serverTypeOf({ command: "c" }), "stdio");
  assert.equal(serverTypeOf({ socket: "s" }), "socket");
  assert.equal(serverTypeOf({}), "unknown");
  assert.equal(summarizeServerEntry({ url: "https://x" }), "https://x");
  assert.equal(summarizeServerEntry({ command: "cmd", args: ["/c", "npx"] }), "cmd /c npx");
  assert.equal(summarizeServerEntry({ command: "solo" }), "solo");
  assert.equal(summarizeServerEntry({ socket: "/tmp/s.sock" }), "/tmp/s.sock");
  assert.equal(summarizeServerEntry({}), "");
});

test("readMcpCacheInfo extracts tool counts and tolerates garbage", (t) => {
  const cachePath = join(agentDir, "mcp-cache-test.json");
  t.after(() => rmSync(cachePath, { force: true }));

  assert.deepEqual(readMcpCacheInfo(cachePath), {});

  writeFileSync(cachePath, JSON.stringify({
    version: 1,
    servers: {
      zread: { configHash: "h", cachedAt: 1700000000000, tools: [{}, {}, {}], resources: [{}] },
      broken: null,
    },
  }), "utf8");
  const info = readMcpCacheInfo(cachePath);
  assert.deepEqual(info.zread, { toolCount: 3, resourceCount: 1, cachedAt: 1700000000000 });
  assert.equal(info.broken, undefined);

  writeFileSync(cachePath, "{ not json", "utf8");
  assert.deepEqual(readMcpCacheInfo(cachePath), {});
});
