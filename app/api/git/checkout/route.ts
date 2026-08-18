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

// POST /api/git/checkout  body: { cwd, branch }  →  { success: true, branch }
// Plain in-place branch switch (`git switch`) — no worktrees are involved.
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
      try {
        await git(body.cwd, ["switch", "--", branch]);
      } catch (error) {
        // `git switch` does not exist before git 2.23 — fall back to checkout.
        if (/not a git command/i.test(extractGitError(error))) {
          await git(body.cwd, ["checkout", "--", branch]);
        } else {
          throw error;
        }
      }
    } catch (error) {
      return NextResponse.json({ error: extractGitError(error) }, { status: 400 });
    }

    return NextResponse.json({ success: true, branch });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
