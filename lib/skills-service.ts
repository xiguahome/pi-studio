import { existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo, isWithin } from "@/lib/skill-lock";
import { getBuiltinSkillsRoot } from "@/lib/builtin-skills";
import { BUILTIN_EXTENSION_SOURCES, npmSourceName } from "@/lib/builtin-extensions";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";

/** Install roots of built-in extensions whose bundled skills are read-only. */
function builtinExtensionSkillRoots(agentDir: string): string[] {
  // Sources carry pinned @version specs; the install dir is keyed by package
  // name only, so strip the version before joining the path.
  return BUILTIN_EXTENSION_SOURCES.map((source) =>
    path.join(agentDir, "npm", "node_modules", npmSourceName(source).slice(4)),
  );
}

/**
 * Built-in = seeded under <agentDir>/skills/builtin/, or shipped inside a
 * built-in extension package (pi-mcp-adapter -> mcp-scripting, pi-subagents).
 */
export function isBuiltinSkillPath(filePath: string, agentDir: string): boolean {
  if (isWithin(filePath, getBuiltinSkillsRoot(agentDir))) return true;
  return builtinExtensionSkillRoots(agentDir).some((root) => isWithin(filePath, root));
}

export async function loadSkillsWithInstallInfo(cwd: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills, diagnostics } = loader.getSkills();
  const annotated = annotateSkillsWithInstallInfo(skills as SkillInfo[], { cwd, agentDir });
  return {
    skills: annotated.map((skill) =>
      isBuiltinSkillPath(skill.filePath, agentDir)
        ? { ...skill, builtin: true }
        : skill,
    ),
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}

/**
 * Shared authorization for endpoints that touch SKILL.md files on disk
 * (PATCH toggle + GET/PUT content editing). Mirrors the allowed-roots rules
 * plus the agent dir and the global skills root (globally installed skills
 * are symlinked into ~/.pi-studio/skills, and isExistingFilePathAllowed resolves
 * the symlink, so the real target can sit outside getAgentDir()).
 */
export async function checkSkillPathAccess(
  filePath: string,
): Promise<{ allowed: boolean; builtin: boolean }> {
  const agentDir = getAgentDir();
  const allowedRoots = new Set(await getAllowedFileRoots());
  allowedRoots.add(agentDir);
  const globalSkillsDir = path.join(homedir(), ".pi-studio", "skills");
  if (existsSync(globalSkillsDir)) allowedRoots.add(globalSkillsDir);
  return {
    allowed: isExistingFilePathAllowed(filePath, allowedRoots),
    builtin: isBuiltinSkillPath(filePath, agentDir),
  };
}
