import { NextRequest, NextResponse } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ExpertInfo {
  name: string;
  description: string;
  source: "builtin" | "package" | "user" | "project";
  filePath: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  skills?: string[];
  disabled?: boolean;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const [, yamlStr, body] = match;
  const frontmatter: Record<string, string> = {};

  for (const line of yamlStr.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key) frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

function parseListField(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function loadExpertFromFile(filePath: string, source: ExpertInfo["source"]): ExpertInfo | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter } = parseFrontmatter(content);

    if (!frontmatter.name || !frontmatter.description) {
      return null;
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      source,
      filePath,
      tools: parseListField(frontmatter.tools),
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      systemPromptMode: frontmatter.systemPromptMode as "append" | "replace" | undefined,
      inheritProjectContext: frontmatter.inheritProjectContext === "true",
      inheritSkills: frontmatter.inheritSkills === "true",
      skills: parseListField(frontmatter.skills),
      disabled: frontmatter.disabled === "true",
    };
  } catch {
    return null;
  }
}

function discoverExpertsInDir(dir: string, source: ExpertInfo["source"]): ExpertInfo[] {
  const experts: ExpertInfo[] = [];
  if (!fs.existsSync(dir)) return experts;

  function walk(currentDir: string): void {
    try {
      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(currentDir, entry.name));
        } else if (entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md")) {
          const filePath = path.join(currentDir, entry.name);
          const expert = loadExpertFromFile(filePath, source);
          if (expert) experts.push(expert);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  walk(dir);
  return experts;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const cwd = searchParams.get("cwd");

  // pi-studio data directory
  const piStudioDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".pi-studio");

  // Discover experts from different sources
  const builtinExperts: ExpertInfo[] = [];

  // 1. Builtin experts from pi-subagents npm package
  const npmNodeModules = path.join(piStudioDir, "npm", "node_modules");
  const piSubagentsAgents = path.join(npmNodeModules, "pi-subagents", "agents");
  if (fs.existsSync(piSubagentsAgents)) {
    builtinExperts.push(...discoverExpertsInDir(piSubagentsAgents, "builtin"));
  }

  // 2. User experts
  const userAgentsDir = path.join(piStudioDir, "agents");
  const userExperts = discoverExpertsInDir(userAgentsDir, "user");

  // 3. Project experts (if cwd provided)
  const projectExperts: ExpertInfo[] = [];
  if (cwd) {
    // Try .pi-studio/agents first (our patched name), then .pi/agents (legacy)
    const projectAgents1 = path.join(cwd, ".pi-studio", "agents");
    const projectAgents2 = path.join(cwd, ".pi", "agents");
    projectExperts.push(...discoverExpertsInDir(projectAgents1, "project"));
    if (projectExperts.length === 0) {
      projectExperts.push(...discoverExpertsInDir(projectAgents2, "project"));
    }
  }

  const allExperts = [...builtinExperts, ...projectExperts, ...userExperts];

  // If a specific expert file is requested, return its raw content.
  // This is used by the "View Prompt" button and reuses the experts domain's
  // own file access (which is allowed) instead of /api/files, whose allowed
  // roots do NOT cover ~/.pi-studio/agents — that would 403 for global experts.
  const filePath = searchParams.get("filePath");
  if (filePath) {
    const requested = path.resolve(filePath);
    const match = allExperts.find((e) => path.resolve(e.filePath) === requested);
    if (!match) {
      return NextResponse.json(
        { error: "Expert file not found or not accessible" },
        { status: 404 }
      );
    }
    try {
      const content = fs.readFileSync(match.filePath, "utf-8");
      return NextResponse.json({ content });
    } catch {
      return NextResponse.json({ error: "Failed to read expert file" }, { status: 500 });
    }
  }

  return NextResponse.json({
    builtin: builtinExperts,
    project: projectExperts,
    user: userExperts,
    all: allExperts,
  });
}
