import { NextRequest, NextResponse } from "next/server";
import { removeProjectDir } from "@/lib/session-reader";

// DELETE /api/sessions/project  body: { cwd: string }
// Remove a project's session-storage directory so the project disappears from
// the sidebar once all of its sessions are gone. Does NOT touch the user's
// real project folder.
export async function DELETE(req: NextRequest) {
  try {
    const { cwd } = (await req.json()) as { cwd?: string };
    if (typeof cwd !== "string" || !cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    removeProjectDir(cwd);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
