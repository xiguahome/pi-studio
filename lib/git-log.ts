import { execFile } from "child_process";
import { promisify } from "util";
import type {
  GitLogResponse,
  GitShowFileStat,
  GitShowResponse,
} from "./git-types";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_LOG_MAX_BUFFER = 16 * 1024 * 1024;

async function git(cwd: string, args: string[], maxBuffer = GIT_LOG_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

/** Accepts full (40-hex) or abbreviated (>=7) commit hashes. */
const HASH_PATTERN = /^[0-9a-f]{7,40}$/;

export const GIT_LOG_DEFAULT_LIMIT = 100;
export const GIT_LOG_MAX_LIMIT = 500;

/**
 * List the most recent commits. Fields are joined with \x1f so subjects
 * containing spaces (or even newlines) do not break parsing; git subjects
 * are single-line by construction, and \x1f never appears in %s/%D output.
 */
export async function getGitLog(cwd: string, limit = GIT_LOG_DEFAULT_LIMIT): Promise<GitLogResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) {
    return { isGitRepository: false, repositoryRoot: null, commits: [] };
  }

  try {
    const count = Math.max(1, Math.min(Math.floor(limit) || GIT_LOG_DEFAULT_LIMIT, GIT_LOG_MAX_LIMIT));
    const output = await git(repositoryRoot, [
      "log",
      "-n",
      String(count),
      "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D",
    ]);
    const commits = output.split("\n").filter(Boolean).map((line) => {
      const [hash = "", shortHash = "", authorName = "", authorEmail = "", date = "", subject = "", refs = ""] = line.split("\x1f");
      return { hash, shortHash, authorName, authorEmail, date, subject, refs };
    });
    return { isGitRepository: true, repositoryRoot, commits };
  } catch {
    return { isGitRepository: true, repositoryRoot, commits: [] };
  }
}

/**
 * Fetch one commit: metadata, per-file line stats, and the full patch.
 * Merge commits have no direct patch (git show omits it) — the frontend
 * renders metadata + stats and a friendly note instead.
 */
export async function getGitShow(cwd: string, hash: string): Promise<GitShowResponse> {
  if (!HASH_PATTERN.test(hash)) return { supported: false, isGitRepository: false };

  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) return { supported: false, isGitRepository: false };

  try {
    const meta = await git(repositoryRoot, [
      "show",
      "--no-color",
      "--no-ext-diff",
      "--no-patch",
      "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b",
      hash,
    ]);
    // Metadata block is the first line (single line up to %s; %b follows on
    // subsequent lines). Truncate the body to keep responses bounded.
    const newlineIndex = meta.indexOf("\n");
    const header = newlineIndex === -1 ? meta : meta.slice(0, newlineIndex);
    const body = newlineIndex === -1 ? "" : meta.slice(newlineIndex + 1).trim();
    const [fullHash = "", authorName = "", authorEmail = "", date = "", subject = ""] = header.split("\x1f");
    if (!HASH_PATTERN.test(fullHash)) return { supported: false, isGitRepository: true };

    // Per-file line counts + patch in one call; --format= suppresses the header.
    const bodyOut = await git(repositoryRoot, [
      "show",
      "--no-color",
      "--no-ext-diff",
      "--format=",
      "--numstat",
      "-p",
      hash,
    ]);
    const lines = bodyOut.split("\n");
    const stats: GitShowFileStat[] = [];
    let i = 0;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      // numstat rows are "<added>\t<deleted>\t<path>"; the patch starts at "diff --git ".
      if (line.startsWith("diff --git ")) break;
      const [added, deleted, file = ""] = line.split("\t");
      if (file === "" || !/^-?\d+$/.test(added) || !/^-?\d+$/.test(deleted)) continue;
      stats.push({
        file,
        additions: added === "-" ? -1 : Number(added),
        deletions: deleted === "-" ? -1 : Number(deleted),
      });
    }
    const patch = lines.slice(i).join("\n");

    return {
      supported: true,
      isGitRepository: true,
      hash: fullHash,
      authorName,
      authorEmail,
      date,
      subject,
      body,
      stats,
      patch,
    };
  } catch {
    return { supported: false, isGitRepository: true };
  }
}
