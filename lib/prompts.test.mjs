import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-prompts-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url);
const {
  getGlobalPromptPath,
  getProjectPromptPath,
  readPromptFile,
  writePromptFile,
} = await jiti.import("./prompts.ts");

test("getGlobalPromptPath resolves inside the agent dir", () => {
  assert.equal(getGlobalPromptPath(agentDir), join(agentDir, "AGENTS.md"));
  // default agentDir comes from PI_CODING_AGENT_DIR
  assert.equal(getGlobalPromptPath(), join(agentDir, "AGENTS.md"));
});

test("getProjectPromptPath resolves cwd/AGENTS.md", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-prompts-cwd-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(getProjectPromptPath(cwd), join(cwd, "AGENTS.md"));
});

test("readPromptFile returns empty content for a missing file", async () => {
  const info = await readPromptFile(join(agentDir, "AGENTS.md"));
  assert.deepEqual(info, { path: join(agentDir, "AGENTS.md"), content: "", exists: false });
});

test("writePromptFile creates parent dirs and round-trips content", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-prompts-write-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const filePath = join(root, "nested", "AGENTS.md");
  const written = await writePromptFile(filePath, "# 项目规范\n\n- 用中文回复");
  assert.equal(written.exists, true);
  assert.equal(readFileSync(filePath, "utf-8"), "# 项目规范\n\n- 用中文回复");

  const reread = await readPromptFile(filePath);
  assert.equal(reread.exists, true);
  assert.equal(reread.content, "# 项目规范\n\n- 用中文回复");
});

test("writePromptFile overwrites existing content", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-prompts-overwrite-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const filePath = join(root, "AGENTS.md");
  await writePromptFile(filePath, "v1");
  const updated = await writePromptFile(filePath, "v2");
  assert.equal(updated.content, "v2");
  assert.equal(readFileSync(filePath, "utf-8"), "v2");
});
