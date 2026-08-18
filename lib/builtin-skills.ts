// Built-in skills: pi-studio ships a fixed set of skills (see
// resources/builtin-skills/) and seeds them into <agentDir>/skills/builtin/
// on boot. Seeding is idempotent:
//   - missing target dir        -> copy from the bundled source
//   - unchanged since seeding   -> upgrade when the bundled copy changed
//   - modified by the user      -> never overwritten (incl. toggle edits of
//                                  disable-model-invocation)
// Built-in skills can be disabled but not uninstalled: deleting a seeded
// directory restores it on the next boot.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

/** Skills bundled under resources/builtin-skills/ (mirrors manifest.json). */
export const BUILTIN_SKILL_NAMES = [
  "docx",
  "find-skills",
  "frontend-design",
  "grill-me",
  "pdf",
  "pptx",
  "skill-creator",
  "xlsx",
] as const;

const SEED_LOCK_STALE_MS = 2 * 60_000;

export interface BuiltinSkillManifestEntry {
  name: string;
  hash: string;
}

interface BuiltinSkillManifestFile {
  skills?: unknown;
}

export interface RecordedBuiltinSkill {
  hash: string;
  seededAt: string;
}

export type BuiltinSkillManifest = Record<string, RecordedBuiltinSkill>;

export type BuiltinSeedAction = "seed" | "upgrade" | "skip" | "ok";

interface SeedDecisionInput {
  /** Whether <target>/<name>/SKILL.md already exists on disk. */
  exists: boolean;
  /** sha256 of the on-disk SKILL.md; undefined when missing. */
  diskHash?: string;
  /** Hash recorded when pi-studio last seeded this skill; undefined if never. */
  recordedHash?: string;
  /** sha256 of the SKILL.md bundled with this pi-studio build. */
  bundledHash: string;
}

/**
 * Pure seeding decision, split out for tests:
 * - missing target -> seed (also covers "user deleted it, restore it")
 * - disk differs from the recorded hash -> user modified, never touch it
 * - disk matches record but bundle is newer -> upgrade
 * - otherwise nothing to do
 */
export function decideSeedAction({
  exists,
  diskHash,
  recordedHash,
  bundledHash,
}: SeedDecisionInput): BuiltinSeedAction {
  if (!exists) return "seed";
  if (diskHash !== recordedHash) return "skip";
  if (diskHash !== bundledHash) return "upgrade";
  return "ok";
}

export function getBuiltinSkillsRoot(agentDir: string): string {
  return join(agentDir, "skills", "builtin");
}

export function getBuiltinSkillsManifestPath(agentDir: string): string {
  return join(agentDir, ".builtin-skills.json");
}

function seedLockPath(agentDir: string): string {
  return join(agentDir, ".builtin-skills.lock");
}

/** Directory holding the bundled skill sources for this build. */
export function getBundledSkillsDir(appRoot: string = process.cwd()): string {
  return join(appRoot, "resources", "builtin-skills");
}

export function readBuiltinSkillManifestEntries(
  bundledDir: string,
): BuiltinSkillManifestEntry[] {
  try {
    const parsed = JSON.parse(
      readFileSync(join(bundledDir, "manifest.json"), "utf8"),
    ) as BuiltinSkillManifestFile;
    if (!Array.isArray(parsed.skills)) return [];
    return parsed.skills.filter(
      (entry): entry is BuiltinSkillManifestEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as BuiltinSkillManifestEntry).name === "string" &&
        typeof (entry as BuiltinSkillManifestEntry).hash === "string",
    );
  } catch {
    return [];
  }
}

/** Recorded seed state; a corrupt file is treated as "never seeded". */
export function readBuiltinSkillsRecord(path: string): BuiltinSkillManifest {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      skills?: unknown;
    };
    const skills = parsed.skills;
    if (!skills || typeof skills !== "object") return {};
    const result: BuiltinSkillManifest = {};
    for (const [name, entry] of Object.entries(
      skills as Record<string, unknown>,
    )) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as RecordedBuiltinSkill).hash === "string"
      ) {
        const recorded = entry as Partial<RecordedBuiltinSkill>;
        result[name] = {
          hash: recorded.hash as string,
          seededAt:
            typeof recorded.seededAt === "string"
              ? recorded.seededAt
              : new Date(0).toISOString(),
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function hashSkillMarkdown(filePath: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

interface EnsureBuiltinSkillsOptions {
  appRoot?: string;
  agentDir?: string;
}

export interface BuiltinSkillSeedResult {
  name: string;
  action: BuiltinSeedAction;
}

/**
 * Idempotently seed every bundled skill into <agentDir>/skills/builtin/.
 * Safe to call on every boot; guarded by a lockfile against concurrent runs
 * from multiple windows. Never throws — a failing skill is skipped, and the
 * SDK's loader simply won't see it until the next successful boot.
 */
export async function ensureBuiltinSkills(
  options: EnsureBuiltinSkillsOptions = {},
): Promise<BuiltinSkillSeedResult[]> {
  const agentDir = options.agentDir ?? getAgentDir();
  const bundledDir = getBundledSkillsDir(options.appRoot);
  const entries = readBuiltinSkillManifestEntries(bundledDir);
  if (entries.length === 0) return [];

  mkdirSync(agentDir, { recursive: true });

  // proper-lockfile locks an existing file, so create it first — same pattern
  // as ensureBuiltinExtensions in lib/builtin-extensions.ts.
  const lockPath = seedLockPath(agentDir);
  if (!existsSync(lockPath)) writeFileSync(lockPath, "", "utf8");

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockPath, {
      retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 2_000, randomize: true },
      stale: SEED_LOCK_STALE_MS,
      onCompromised: () => {
        // A stale lock just means we may re-run — the work is idempotent.
      },
    });
  } catch {
    // Another instance is seeding; bow out.
    return [];
  }

  try {
    const targetRoot = getBuiltinSkillsRoot(agentDir);
    const recordPath = getBuiltinSkillsManifestPath(agentDir);
    const record = readBuiltinSkillsRecord(recordPath);
    const results: BuiltinSkillSeedResult[] = [];

    for (const { name, hash: bundledHash } of entries) {
      const sourceDir = join(bundledDir, name);
      const targetDir = join(targetRoot, name);
      const skillMd = join(targetDir, "SKILL.md");
      const exists = existsSync(skillMd);
      const action = decideSeedAction({
        exists,
        diskHash: exists ? hashSkillMarkdown(skillMd) : undefined,
        recordedHash: record[name]?.hash,
        bundledHash,
      });
      results.push({ name, action });

      if (action === "seed" || action === "upgrade") {
        if (!existsSync(sourceDir)) continue;
        if (action === "upgrade") rmSync(targetDir, { recursive: true, force: true });
        mkdirSync(targetRoot, { recursive: true });
        cpSync(sourceDir, targetDir, { recursive: true });
        record[name] = { hash: bundledHash, seededAt: new Date().toISOString() };
        writeFileSync(
          recordPath,
          `${JSON.stringify({ skills: record }, null, 2)}\n`,
          "utf8",
        );
      }
    }

    return results;
  } finally {
    try {
      await release();
    } catch {
      // Lock release failure is not actionable; the stale guard covers it.
    }
  }
}
