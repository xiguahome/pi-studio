import { NextResponse } from "next/server";
import { statSync } from "fs";
import { readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { resolveProject } from "@/lib/worktree";

// GET /api/sessions/[id]/meta
// Header-only lookup used by workspace restore after a project switch.
// resolveSessionPath() is O(1) once the path cache is warm (populated when the
// sidebar first loads the session list), and readSessionHeader() reads just the
// first line — so this never scans session bodies, unlike GET /api/sessions
// which runs SessionManager.listAll() over every .jsonl on disk.
//
// Returns { exists: false } with 200 when the session is gone, so the caller can
// distinguish "deleted" (forget the remembered session) from a transient network
// failure (keep it for a later retry).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ exists: false });
    const header = readSessionHeader(filePath);
    if (!header) return NextResponse.json({ exists: false });

    const cwd = header.cwd ?? "";
    const project = cwd ? await resolveProject(cwd) : null;
    let modified = header.timestamp;
    try {
      modified = statSync(filePath).mtime.toISOString();
    } catch {
      // fall back to the header timestamp if stat fails
    }
    return NextResponse.json({
      exists: true,
      id: header.id,
      cwd,
      projectRoot: project?.projectRoot ?? cwd,
      path: filePath,
      created: header.timestamp,
      modified,
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
