import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { validateSkillMarkdown } = await jiti.import("./skill-edit.ts");

test("accepts a valid SKILL.md", () => {
  const result = validateSkillMarkdown(
    "---\nname: demo\ndescription: A demo skill\n---\nBody text\n",
  );
  assert.deepEqual(result, { ok: true });
});

test("accepts CRLF line endings", () => {
  const result = validateSkillMarkdown(
    "---\r\nname: demo\r\ndescription: A demo skill\r\n---\r\nBody\r\n",
  );
  assert.deepEqual(result, { ok: true });
});

test("rejects empty content", () => {
  const result = validateSkillMarkdown("   \n");
  assert.equal(result.ok, false);
  assert.match(result.error, /empty/);
});

test("rejects content without a frontmatter block", () => {
  const result = validateSkillMarkdown("# Just markdown\nno frontmatter\n");
  assert.equal(result.ok, false);
  assert.match(result.error, /frontmatter/);
});

test("rejects invalid YAML in frontmatter", () => {
  const result = validateSkillMarkdown(
    "---\nname: [unclosed\ndescription: x\n---\nbody\n",
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid frontmatter/);
});

test("rejects missing or empty name", () => {
  for (const content of [
    "---\ndescription: has description\n---\nbody\n",
    "---\nname: \"\"\ndescription: has description\n---\nbody\n",
  ]) {
    const result = validateSkillMarkdown(content);
    assert.equal(result.ok, false);
    assert.match(result.error, /"name"/);
  }
});

test("rejects missing or empty description", () => {
  for (const content of [
    "---\nname: demo\n---\nbody\n",
    "---\nname: demo\ndescription:\n---\nbody\n",
  ]) {
    const result = validateSkillMarkdown(content);
    assert.equal(result.ok, false);
    assert.match(result.error, /"description"/);
  }
});

test("rejects oversized name and description", () => {
  const longName = validateSkillMarkdown(
    `---\nname: ${"a".repeat(65)}\ndescription: ok\n---\nbody\n`,
  );
  assert.equal(longName.ok, false);
  assert.match(longName.error, /"name" exceeds 64/);

  const longDescription = validateSkillMarkdown(
    `---\nname: demo\ndescription: ${"a".repeat(1025)}\n---\nbody\n`,
  );
  assert.equal(longDescription.ok, false);
  assert.match(longDescription.error, /"description" exceeds 1024/);
});

test("keeps disable-model-invocation and other fields valid", () => {
  const result = validateSkillMarkdown(
    "---\nname: demo\ndisable-model-invocation: true\ndescription: A demo skill\n---\nbody\n",
  );
  assert.deepEqual(result, { ok: true });
});
