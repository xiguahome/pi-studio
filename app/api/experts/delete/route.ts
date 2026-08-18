import { NextRequest, NextResponse } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";

// Mirror the discovery logic from the GET handler so we can validate that the
// requested path is actually a known project/user expert before deleting.
function discoverExpertsInDir(dir: string, source: string): { filePath: string; source: string }[] {
  const out: { filePath: string; source: string }[] = [];
  if (!fs.existsSync(dir)) return out;

  function walk(currentDir: string): void {
    try {
      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(currentDir, entry.name));
        } else if (entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md")) {
          out.push({ filePath: path.join(currentDir, entry.name), source });
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  walk(dir);
  return out;
}

export async function POST(request: NextRequest) {
  let body: { filePath?: string; cwd?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const filePath = body.filePath;
  const cwd = body.cwd;
  if (!filePath || typeof filePath !== "string") {
    return NextResponse.json({ error: "filePath is required" }, { status: 400 });
  }

  const piStudioDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".pi-studio");

  const candidates: { filePath: string; source: string }[] = [
    ...discoverExpertsInDir(path.join(piStudioDir, "agents"), "user"),
  ];
  if (cwd) {
    candidates.push(...discoverExpertsInDir(path.join(cwd, ".pi-studio", "agents"), "project"));
    candidates.push(...discoverExpertsInDir(path.join(cwd, ".pi", "agents"), "project"));
  }

  const requested = path.resolve(filePath);
  const match = candidates.find((e) => path.resolve(e.filePath) === requested);
  if (!match) {
    return NextResponse.json({ error: "Expert not found or not deletable" }, { status: 404 });
  }

  // Never delete builtin/package experts — only user & project scoped ones.
  if (match.source !== "user" && match.source !== "project") {
    return NextResponse.json({ error: "Only user/project experts can be deleted" }, { status: 403 });
  }

  try {
    fs.rmSync(match.filePath, { force: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to delete expert" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
