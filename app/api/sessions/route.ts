import { NextResponse } from "next/server";
import { listAllSessions, listProjectDirs } from "@/lib/session-reader";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

export async function GET() {
  try {
    const sessions = await listAllSessions();
    const projectDirs = listProjectDirs();
    return NextResponse.json({ sessions, runningSessionIds: getRunningRpcSessionIds(), projectDirs });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
