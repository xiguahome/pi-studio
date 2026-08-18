import { readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { mkdirSync } from "fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * 提示词文件（AGENTS.md）读写辅助。
 *
 * pi 在构建 system prompt 时按以下顺序自动加载上下文文件（见 SDK 的
 * resource-loader.ts）：全局为 <agentDir>/AGENTS.md（~/.pi-studio/AGENTS.md），
 * 项目为从 cwd 向上逐层发现的 AGENTS.md。pi-studio 只编辑这两处中最直接
 * 对应的文件：全局 <agentDir>/AGENTS.md 与项目 <cwd>/AGENTS.md。
 */

export interface PromptFileInfo {
  /** 目标文件绝对路径 */
  path: string;
  /** 文件内容（不存在时为空字符串） */
  content: string;
  /** 文件是否已存在于磁盘 */
  exists: boolean;
}

/** 全局提示词文件：<agentDir>/AGENTS.md */
export function getGlobalPromptPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "AGENTS.md");
}

/** 项目提示词文件：<cwd>/AGENTS.md */
export function getProjectPromptPath(cwd: string): string {
  return resolve(cwd, "AGENTS.md");
}

/** 读取提示词文件；不存在时返回空内容 + exists:false，不抛错。 */
export async function readPromptFile(filePath: string): Promise<PromptFileInfo> {
  try {
    const content = await readFile(filePath, "utf-8");
    return { path: filePath, content, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: filePath, content: "", exists: false };
    }
    throw error;
  }
}

/** 写入提示词文件（创建父目录），返回写入后的信息。 */
export async function writePromptFile(filePath: string, content: string): Promise<PromptFileInfo> {
  mkdirSync(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
  return { path: filePath, content, exists: true };
}
