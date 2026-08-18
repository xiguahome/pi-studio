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
    timeout: 20_000,
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

// POST /api/git/branch  body: { cwd, name, startPoint? }  →  { success: true, branch }
// Create a new local branch, optionally tracking a remote branch. When
// startPoint (e.g. "origin/main") is given, that remote ref is fetched first
// (the "pull" step) so the new branch starts from the latest remote state,
// then `git switch -c <name> --track <startPoint>` attaches the upstream.
// Plain in-place branch creation — no worktrees are involved.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; name?: string; startPoint?: string };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const name = body.name?.trim();
    if (!name || typeof body.name !== "string") {
      return NextResponse.json({ error: "branch name is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(body.cwd);
    if (denied) return denied;

    const startPoint = typeof body.startPoint === "string" ? body.startPoint.trim() : "";
    // startPoint must look like "<remote>/<branch>", with no whitespace either
    // side (it flows into a refspec below).
    if (startPoint && !/^[^/\s]+\/[^\s]+$/.test(startPoint)) {
      return NextResponse.json({ error: "invalid start point" }, { status: 400 });
    }

    try {
      // Validate the branch name through git itself ("..", "~", "?", empty…).
      await git(body.cwd, ["check-ref-format", "--branch", name]);
    } catch (error) {
      return NextResponse.json(
        { error: extractGitError(error) || "invalid branch name" },
        { status: 400 },
      );
    }

    try {
      if (startPoint) {
        const slash = startPoint.indexOf("/");
        const remote = startPoint.slice(0, slash);
        const remoteBranch = startPoint.slice(slash + 1);
        // Explicit refspec so the remote-tracking ref is updated even when the
        // repo's fetch refspec is non-default, then `--track` has a fresh ref.
        await git(body.cwd, ["fetch", remote, `${remoteBranch}:refs/remotes/${startPoint}`]);
      }
      try {
        await git(body.cwd, startPoint
          ? ["switch", "-c", name, "--track", startPoint]
          : ["switch", "-c", name]);
      } catch (error) {
        // `git switch` does not exist before git 2.23 — fall back to checkout.
        if (/not a git command/i.test(extractGitError(error))) {
          await git(body.cwd, startPoint
            ? ["checkout", "-b", name, "--track", startPoint]
            : ["checkout", "-b", name]);
        } else {
          throw error;
        }
      }
    } catch (error) {
      return NextResponse.json({ error: extractGitError(error) }, { status: 400 });
    }

    return NextResponse.json({ success: true, branch: name });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
