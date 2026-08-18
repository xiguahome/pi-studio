import { existsSync } from "fs";
import { stat } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getGlobalPromptPath, getProjectPromptPath, readPromptFile, writePromptFile } from "@/lib/prompts";

export const dynamic = "force-dynamic";

/**
 * 全局提示词（<agentDir>/AGENTS.md）与项目提示词（<cwd>/AGENTS.md）的读取与写入。
 *
 * GET  ?cwd=...  ->  { global: PromptFileInfo, project: PromptFileInfo | null }
 * PUT  { cwd?, global?, project? }  ->  { global?, project? }（仅返回被写入的字段）
 *
 * 项目文件路径由 cwd 解析而来，cwd 必须位于文件访问允许根内（与 /api/project-trust
 * 同一套校验）；全局文件路径是固定的 agentDir 路径，无用户可控部分，无需额外校验。
 */
async function validateCwd(value: unknown): Promise<{ cwd: string } | { response: NextResponse }> {
  if (typeof value !== "string" || !value.trim()) {
    return { response: NextResponse.json({ error: "cwd required" }, { status: 400 }) };
  }

  const cwd = resolve(value);
  try {
    if (!(await stat(cwd)).isDirectory()) {
      return { response: NextResponse.json({ error: "cwd must be a directory" }, { status: 400 }) };
    }
  } catch {
    return { response: NextResponse.json({ error: "Directory does not exist" }, { status: 400 }) };
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd };
}

export async function GET(req: Request) {
  const agentDir = getAgentDir();
  const global = await readPromptFile(getGlobalPromptPath(agentDir));

  const cwdValue = new URL(req.url).searchParams.get("cwd");
  if (!cwdValue || !cwdValue.trim()) {
    return NextResponse.json({ global, project: null });
  }
  const result = await validateCwd(cwdValue);
  if ("response" in result) return result.response;

  const project = await readPromptFile(getProjectPromptPath(result.cwd));
  return NextResponse.json({ global, project });
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { cwd?: unknown; global?: unknown; project?: unknown };
    const hasGlobal = typeof body.global === "string";
    const hasProject = typeof body.project === "string";
    if (!hasGlobal && !hasProject) {
      return NextResponse.json({ error: "global or project content required" }, { status: 400 });
    }

    const agentDir = getAgentDir();
    const result: { global?: unknown; project?: unknown } = {};
    if (hasGlobal) {
      result.global = await writePromptFile(getGlobalPromptPath(agentDir), body.global as string);
    }
    if (hasProject) {
      const cwdResult = await validateCwd(body.cwd);
      if ("response" in cwdResult) return cwdResult.response;
      const projectPath = getProjectPromptPath(cwdResult.cwd);
      // cwd 已通过 realpath 校验；若目标文件已存在，它可能是符号链接，
      // 写入前需确认其真实位置仍在允许根内，防止通过 symlink 写穿到外部。
      if (existsSync(projectPath)) {
        const allowedRoots = await getAllowedFileRoots();
        if (!isExistingFilePathAllowed(projectPath, allowedRoots)) {
          return NextResponse.json({ error: "Access denied" }, { status: 403 });
        }
      }
      result.project = await writePromptFile(projectPath, body.project as string);
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
