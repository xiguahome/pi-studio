import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  proxyEnvVars,
  readProxyConfig,
  saveProxyConfig,
  validateProxyUrl,
  withProxyEnv,
} = await jiti.import("./proxy-config.ts");

test("readProxyConfig tolerates missing and corrupt files", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-proxy-"));
  try {
    assert.deepEqual(readProxyConfig(join(root, "missing.json")), { url: null });
    const corrupt = join(root, "corrupt.json");
    writeFileSync(corrupt, "{ nope", "utf8");
    assert.deepEqual(readProxyConfig(corrupt), { url: null });
    const blank = join(root, "blank.json");
    writeFileSync(blank, JSON.stringify({ url: "  " }), "utf8");
    assert.deepEqual(readProxyConfig(blank), { url: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveProxyConfig round-trips and can clear", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-proxy-"));
  const path = join(root, "proxy.json");
  try {
    saveProxyConfig("http://127.0.0.1:7890", path);
    assert.deepEqual(readProxyConfig(path), { url: "http://127.0.0.1:7890" });
    assert.match(readFileSync(path, "utf8"), /"url": "http:\/\/127\.0\.0\.1:7890"/);
    saveProxyConfig(null, path);
    assert.deepEqual(readProxyConfig(path), { url: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateProxyUrl accepts http/https/socks and rejects the rest", () => {
  assert.equal(validateProxyUrl("http://127.0.0.1:7890"), null);
  assert.equal(validateProxyUrl("https://proxy.example.com:8080"), null);
  assert.equal(validateProxyUrl("socks5://127.0.0.1:1080"), null);
  assert.match(validateProxyUrl("not a url"), /valid URL/);
  assert.match(validateProxyUrl("ftp://127.0.0.1:21"), /protocol/);
});

test("proxyEnvVars covers both env var cases", () => {
  const vars = proxyEnvVars("http://p:1");
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    assert.equal(vars[key], "http://p:1", key);
  }
});

test("withProxyEnv passes through when unconfigured, merges when set", () => {
  const base = { FOO: "bar" };
  assert.equal(withProxyEnv(base, { url: null }), base);
  const merged = withProxyEnv(base, { url: "http://p:1" });
  assert.equal(merged.FOO, "bar");
  assert.equal(merged.HTTPS_PROXY, "http://p:1");
  assert.equal(merged.https_proxy, "http://p:1");
});
