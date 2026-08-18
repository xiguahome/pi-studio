import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { allowFileRoot } from "@/lib/file-access";

// POST /api/default-cwd
// Creates <agentDir>/default-project/cwd-<YYYYMMDD> if it doesn't exist and
// returns the path. Used as the fallback workspace context for the settings
// skills/plugins panels when no project directory is active. Lives under the
// agent data dir (~/.pi-studio by default, overridable via PI_CODING_AGENT_DIR)
// so it never pollutes the real home directory.
export async function POST() {
  try {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dir = join(getAgentDir(), "default-project", `cwd-${date}`);
    mkdirSync(dir, { recursive: true });
    allowFileRoot(dir);
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
