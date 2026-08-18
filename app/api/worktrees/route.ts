import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { findCurrentWorktreePath, listBranches, listRemoteBranches, listWorktrees, resolveProject } from "@/lib/worktree";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";

/** Same gate as /api/files: only session cwds / project roots / explicitly
 *  allowed dirs may be inspected or mutated through this endpoint. */
async function checkCwdAllowed(cwd: string): Promise<NextResponse | null> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return null;
}

// GET /api/worktrees?cwd=  →  { projectRoot, isGit, isTopLevel, currentWorktreePath, worktrees }
export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd");
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(cwd);
    if (denied) return denied;

    const project = await resolveProject(cwd);
    // For a removed-worktree cwd (session of a deleted worktree), fall back to
    // the inferred project root so the switcher still shows the project.
    const base = existsSync(cwd) ? cwd : project.projectRoot;

    // listWorktrees / listBranches / listRemoteBranches are independent git
    // invocations — run them in parallel instead of serially. listWorktrees'
    // success still defines isGit; branch results are only honored for git dirs.
    const [worktreesResult, branchesResult, remoteBranchesResult] = await Promise.allSettled([
      listWorktrees(base),
      listBranches(base),
      listRemoteBranches(base),
    ]);

    let worktrees: Awaited<ReturnType<typeof listWorktrees>> = [];
    let currentWorktreePath: string | null = null;
    let isGit = true;
    if (worktreesResult.status === "fulfilled") {
      worktrees = worktreesResult.value;
      currentWorktreePath = findCurrentWorktreePath(worktrees, cwd);
    } else {
      isGit = false;
    }
    // Every listed path is a git-verified worktree of this project; allow the
    // file explorer to browse them even before they have any session.
    for (const w of worktrees) allowFileRoot(w.path);
    // All local branches for the branch switcher.
    const branches: Awaited<ReturnType<typeof listBranches>> =
      isGit && branchesResult.status === "fulfilled" ? branchesResult.value : [];
    // Remote-tracking branches (<remote>/<branch>) for "new branch from remote".
    const remoteBranches: string[] =
      isGit && remoteBranchesResult.status === "fulfilled" ? remoteBranchesResult.value : [];
    return NextResponse.json({
      projectRoot: project.projectRoot,
      isGit,
      isTopLevel: project.isTopLevel,
      currentWorktreePath,
      worktrees,
      branches,
      remoteBranches,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
