import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  BUILTIN_SKILL_NAMES,
  decideSeedAction,
  ensureBuiltinSkills,
  getBuiltinSkillsManifestPath,
  getBuiltinSkillsRoot,
  readBuiltinSkillManifestEntries,
  readBuiltinSkillsRecord,
} = await jiti.import("./builtin-skills.ts");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function makeFixture(root, name, content) {
  const appRoot = join(root, "app");
  const skillDir = join(appRoot, "resources", "builtin-skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf8");
  writeFileSync(
    join(appRoot, "resources", "builtin-skills", "manifest.json"),
    `${JSON.stringify({ skills: [{ name, hash: sha256(content) }] }, null, 2)}\n`,
    "utf8",
  );
  return appRoot;
}

test("decideSeedAction covers seed / skip / upgrade / ok", () => {
  assert.equal(
    decideSeedAction({ exists: false, bundledHash: "b" }),
    "seed",
  );
  // Disk differs from the recorded hash -> user modified, never touch.
  assert.equal(
    decideSeedAction({ exists: true, diskHash: "x", recordedHash: "y", bundledHash: "b" }),
    "skip",
  );
  // Pre-existing directory never recorded -> treated as user content.
  assert.equal(
    decideSeedAction({ exists: true, diskHash: "x", bundledHash: "b" }),
    "skip",
  );
  // Unchanged since seeding but the bundle is newer -> upgrade.
  assert.equal(
    decideSeedAction({ exists: true, diskHash: "a", recordedHash: "a", bundledHash: "b" }),
    "upgrade",
  );
  // Everything matches -> nothing to do.
  assert.equal(
    decideSeedAction({ exists: true, diskHash: "a", recordedHash: "a", bundledHash: "a" }),
    "ok",
  );
});

test("readBuiltinSkillsRecord tolerates missing and corrupt files", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-builtin-skills-"));
  try {
    assert.deepEqual(readBuiltinSkillsRecord(join(root, "missing.json")), {});
    const corrupt = join(root, "corrupt.json");
    writeFileSync(corrupt, "{ not json", "utf8");
    assert.deepEqual(readBuiltinSkillsRecord(corrupt), {});
    const wrongShape = join(root, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ skills: { a: { nope: 1 } } }), "utf8");
    assert.deepEqual(readBuiltinSkillsRecord(wrongShape), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuiltinSkillManifestEntries filters malformed entries", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-builtin-skills-"));
  try {
    const dir = join(root, "resources", "builtin-skills");
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(readBuiltinSkillManifestEntries(dir), []);
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        skills: [
          { name: "ok", hash: "abc" },
          { name: 42 },
          null,
          { hash: "no-name" },
        ],
      }),
      "utf8",
    );
    assert.deepEqual(readBuiltinSkillManifestEntries(dir), [
      { name: "ok", hash: "abc" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BUILTIN_SKILL_NAMES matches the shipped manifest and directories", () => {
  const bundledDir = join(repoRoot, "resources", "builtin-skills");
  const entries = readBuiltinSkillManifestEntries(bundledDir);
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    [...BUILTIN_SKILL_NAMES].sort(),
  );
  for (const { name, hash } of entries) {
    const skillMd = join(bundledDir, name, "SKILL.md");
    assert.ok(existsSync(skillMd), `${name}/SKILL.md must exist`);
    assert.match(hash, /^[0-9a-f]{64}$/, `${name} hash must be sha256`);
  }
});

test("ensureBuiltinSkills seeds, preserves edits, restores deletes, upgrades", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-builtin-skills-"));
  try {
    const agentDir = join(root, "agent");
    const v1 = "---\nname: demo\ndescription: demo skill\n---\nbody v1\n";
    const appRoot = makeFixture(root, "demo", v1);
    const targetMd = join(getBuiltinSkillsRoot(agentDir), "demo", "SKILL.md");
    const recordPath = getBuiltinSkillsManifestPath(agentDir);

    // Missing target -> seed.
    let results = await ensureBuiltinSkills({ appRoot, agentDir });
    assert.deepEqual(results, [{ name: "demo", action: "seed" }]);
    assert.equal(readFileSync(targetMd, "utf8"), v1);
    assert.equal(readBuiltinSkillsRecord(recordPath).demo.hash, sha256(v1));

    // Nothing changed -> ok.
    results = await ensureBuiltinSkills({ appRoot, agentDir });
    assert.deepEqual(results, [{ name: "demo", action: "ok" }]);

    // User edited the seeded file (e.g. toggle wrote disable-model-invocation)
    // -> skip and keep the user version.
    const edited = v1.replace("body v1", "disable-model-invocation: true");
    writeFileSync(targetMd, edited, "utf8");
    results = await ensureBuiltinSkills({ appRoot, agentDir });
    assert.deepEqual(results, [{ name: "demo", action: "skip" }]);
    assert.equal(readFileSync(targetMd, "utf8"), edited);

    // User deleted the whole skill dir -> restore on next boot.
    rmSync(dirname(targetMd), { recursive: true, force: true });
    results = await ensureBuiltinSkills({ appRoot, agentDir });
    assert.deepEqual(results, [{ name: "demo", action: "seed" }]);
    assert.equal(readFileSync(targetMd, "utf8"), v1);

    // App upgrade: bundle changed and disk still matches the record -> upgrade.
    const v2 = v1.replace("body v1", "body v2");
    makeFixture(root, "demo", v2);
    results = await ensureBuiltinSkills({ appRoot, agentDir });
    assert.deepEqual(results, [{ name: "demo", action: "upgrade" }]);
    assert.equal(readFileSync(targetMd, "utf8"), v2);
    assert.equal(readBuiltinSkillsRecord(recordPath).demo.hash, sha256(v2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureBuiltinSkills is a no-op without a bundled manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-builtin-skills-"));
  try {
    const agentDir = join(root, "agent");
    const results = await ensureBuiltinSkills({ appRoot: root, agentDir });
    assert.deepEqual(results, []);
    assert.equal(existsSync(getBuiltinSkillsRoot(agentDir)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
