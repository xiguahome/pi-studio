import { NextRequest, NextResponse } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CreateExpertRequest {
  name: string;
  description: string;
  prompt?: string;
  aliases?: string[];
  tools?: string[];
  model?: string;
  skills?: string[];
  thinking?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  defaultContext?: "fresh" | "fork";
  output?: string;
  defaultProgress?: boolean;
  scope: "global" | "project";
  cwd: string;
}

function sanitizeFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-");
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as CreateExpertRequest;
    const {
      name,
      description,
      prompt,
      aliases,
      tools,
      model,
      skills,
      thinking,
      systemPromptMode,
      inheritProjectContext,
      inheritSkills,
      defaultContext,
      output,
      defaultProgress,
      scope,
      cwd,
    } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "Expert name is required" }, { status: 400 });
    }
    if (!description?.trim()) {
      return NextResponse.json({ error: "Description is required" }, { status: 400 });
    }

    // Determine target directory
    const piStudioDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".pi-studio");
    let agentsDir: string;

    if (scope === "project" && cwd) {
      // Project scope: use .pi-studio/agents (our patched name)
      agentsDir = path.join(cwd, ".pi-studio", "agents");
    } else {
      // Global scope
      agentsDir = path.join(piStudioDir, "agents");
    }

    // Ensure directory exists
    fs.mkdirSync(agentsDir, { recursive: true });

    // Check for duplicate name
    const fileName = `${sanitizeFileName(name)}.md`;
    const filePath = path.join(agentsDir, fileName);

    if (fs.existsSync(filePath)) {
      return NextResponse.json({ error: `Expert "${name}" already exists` }, { status: 409 });
    }

    // Build agent content
    const frontmatter: string[] = [
      "---",
      `name: ${name.trim()}`,
      `description: ${description.trim()}`,
    ];

    if (aliases && aliases.length > 0) {
      frontmatter.push(`aliases: ${aliases.join(", ")}`);
    }

    if (tools && tools.length > 0) {
      frontmatter.push(`tools: ${tools.join(", ")}`);
    }

    if (model && model.trim()) {
      frontmatter.push(`model: ${model.trim()}`);
    }

    if (skills && skills.length > 0) {
      frontmatter.push(`skills: ${skills.join(", ")}`);
    }

    if (thinking) {
      frontmatter.push(`thinking: ${thinking}`);
    }

    frontmatter.push(`systemPromptMode: ${systemPromptMode || "replace"}`);
    frontmatter.push(`inheritProjectContext: ${inheritProjectContext !== false}`);

    if (inheritSkills === true) {
      frontmatter.push("inheritSkills: true");
    }

    if (defaultContext) {
      frontmatter.push(`defaultContext: ${defaultContext}`);
    }

    if (output && output.trim()) {
      frontmatter.push(`output: ${output.trim()}`);
    }

    if (defaultProgress === true) {
      frontmatter.push("defaultProgress: true");
    }

    frontmatter.push("---");

    const systemPrompt = (prompt && prompt.trim())
      ? prompt.trim()
      : `You are a ${name.trim()} expert. ${description.trim()}

Your role:
- ${description.trim()}
- Follow best practices and coding standards
- Always verify your changes before completing

When working:
1. Understand the task and context
2. Plan your approach
3. Execute carefully
4. Review and verify results
5. Report findings clearly

Do not make assumptions. Ask for clarification when needed.`;

    const content = [...frontmatter, "", systemPrompt].join("\n");

    // Write the file
    fs.writeFileSync(filePath, content, "utf-8");

    return NextResponse.json({
      success: true,
      expert: {
        name: name.trim(),
        description: description.trim(),
        source: scope === "project" ? "project" : "user",
        filePath,
        tools,
        thinking,
        systemPromptMode: "replace",
        inheritProjectContext: true,
      },
    });
  } catch (error) {
    console.error("Failed to create expert:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create expert" },
      { status: 500 }
    );
  }
}
