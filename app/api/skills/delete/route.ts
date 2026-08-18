import { NextResponse } from "next/server";
import { rmSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { checkSkillPathAccess, loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { isWithin, removeSkillLockEntry } from "@/lib/skill-lock";
import { getBuiltinSkillsRoot } from "@/lib/builtin-skills";

// POST /api/skills/delete  body: { filePath, cwd }
// Removes a non-builtin, standalone skill directory and prunes its lock entry.
// Builtin skills (re-seeded on boot) and plugin-package-bundled skills
// (origin "package" — removing one would uninstall the whole package) are refused.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { filePath?: string; cwd?: string };
    const filePath = body.filePath;
    const cwd = body.cwd;
    if (!filePath || typeof filePath !== "string") {
      return NextResponse.json({ error: "filePath is required" }, { status: 400 });
    }
    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }

    // 1. Access gate + builtin refusal.
    const access = await checkSkillPathAccess(filePath);
    if (!access.allowed) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (access.builtin) {
      return NextResponse.json({ error: "builtin-cannot-delete" }, { status: 403 });
    }

    // 2. Load the skill to inspect its origin (package-bundled?) and install info.
    const agentDir = getAgentDir();
    const { skills } = await loadSkillsWithInstallInfo(cwd);
    const skill = skills.find((s) => s.filePath === filePath);
    if (!skill) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }
    if (skill.sourceInfo.origin === "package") {
      // Deletable only via plugin/package uninstall, which removes the whole package.
      return NextResponse.json({ error: "package-skill" }, { status: 422 });
    }

    // 3. Path safety: the skill dir must live under a deletable skills root,
    //    never under the builtin root, and must not be a root itself.
    const baseDir = dirname(filePath);
    const globalSkillsRoot = join(agentDir, "skills");
    const projectSkillsRoot = join(cwd, ".pi-studio", "skills");
    const builtinRoot = getBuiltinSkillsRoot(agentDir);
    if (isWithin(baseDir, builtinRoot)) {
      return NextResponse.json({ error: "builtin-cannot-delete" }, { status: 403 });
    }
    if (baseDir === globalSkillsRoot || baseDir === projectSkillsRoot || baseDir === builtinRoot) {
      return NextResponse.json({ error: "Refusing to delete a skills root" }, { status: 400 });
    }
    if (!isWithin(baseDir, globalSkillsRoot) && !isWithin(baseDir, projectSkillsRoot)) {
      return NextResponse.json(
        { error: "Skill is not under a deletable skills root" },
        { status: 400 },
      );
    }

    // 4. Delete the skill directory.
    rmSync(baseDir, { recursive: true, force: true });

    // 5. Prune the lock entry for skills.sh-installed skills.
    if (skill.install) {
      removeSkillLockEntry(skill.name, skill.install.scope, { cwd, agentDir });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
