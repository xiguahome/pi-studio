import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";

const execFileAsync = promisify(execFile);

/** Same gate as /api/files: only session cwds / project roots / explicitly
 *  allowed dirs may be mutated through this endpoint. */
async function checkCwdAllowed(cwd: string): Promise<NextResponse | null> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    // Pin the message locale so error text stays predictable.
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

function extractGitError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

// POST /api/git/branch/delete  body: { cwd, branch }  →  { success: true, branch }
// Safely delete a *non-current* local branch with `git branch -d` (refuses to
// delete unmerged branches; errors are surfaced verbatim). The currently
// checked-out branch is rejected up front.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; branch?: string };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const branch = body.branch?.trim();
    if (!branch || typeof body.branch !== "string") {
      return NextResponse.json({ error: "branch is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(body.cwd);
    if (denied) return denied;

    try {
      // Validate the branch name through git itself before touching anything.
      await git(body.cwd, ["check-ref-format", "--branch", branch]);
    } catch (error) {
      return NextResponse.json(
        { error: extractGitError(error) || "invalid branch name" },
        { status: 400 },
      );
    }

    try {
      // Refuse the current branch up front (git branch -d would also refuse,
      // but with a less precise message).
      const head = await git(body.cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
      if (head === branch) {
        return NextResponse.json(
          { error: `cannot delete the current branch '${branch}'` },
          { status: 400 },
        );
      }
      await git(body.cwd, ["branch", "-d", branch]);
    } catch (error) {
      return NextResponse.json({ error: extractGitError(error) }, { status: 400 });
    }

    return NextResponse.json({ success: true, branch });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
