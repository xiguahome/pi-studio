// pi-hermes-memory markdown 编辑服务端逻辑。
//
// 该插件以 markdown 文件为权威源（MEMORY.md / USER.md / failures.md /
// projects-memory/<project>/MEMORY.md），SQLite memories 表只是可重建的检索
// 镜像。本模块只读写 markdown，不碰 SQLite：插件在每次增删改前都会从磁盘
// 重载条目（syncTargetFromDiskIfChanged）并在写盘时做指纹比对，外部编辑
// 不会被它覆盖，反而会在下一次记忆操作时触发镜像 reconcile。
//
// 条目格式与插件 memory-store.ts 保持一致：
//   <text> <!-- created=YYYY-MM-DD, last=YYYY-MM-DD, project64=base64url -->
//   条目之间以 "\n§\n" 分隔；元数据注释可缺失（legacy 条目）。

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveProject } from "./worktree";

export type HermesMemoryTarget = "memory" | "user" | "failure" | "project";

export const HERMES_ENTRY_DELIMITER = "\n§\n";

const DEFAULT_MEMORY_CHAR_LIMIT = 5000;
const DEFAULT_USER_CHAR_LIMIT = 5000;
const DEFAULT_PROJECT_CHAR_LIMIT = 5000;

export const FAILURE_CATEGORIES = [
  "failure",
  "correction",
  "insight",
  "preference",
  "convention",
  "tool-quirk",
] as const;

export interface HermesMemoryEntry {
  /** 条目正文（已剥离元数据注释） */
  text: string;
  created: string;
  last: string;
  /** base64url 解码后的项目名（仅 failure 条目可能携带），null 表示无 */
  project: string | null;
  /** failure 条目开头的 [category] 标签，非 failure 条目为 null */
  category: string | null;
  /** 未修改条目写回时原样保留，避免重编码引入格式漂移 */
  raw: string;
}

export interface HermesUsage {
  current: number;
  limit: number;
  percent: number;
  entryCount: number;
}

export interface HermesMemoryMutationResult {
  success: boolean;
  error?: string;
  usage?: HermesUsage;
}

// ─── 内容扫描（移植自插件 content-scanner.ts，UI 写入不得绕过防注入/防密钥防护） ───

const MEMORY_THREAT_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { pattern: /you\s+are\s+now\s+/i, id: "role_hijack" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
  { pattern: /system\s+prompt\s+override/i, id: "sys_prompt_override" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: "disregard_rules" },
  { pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, id: "bypass_restrictions" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_curl" },
  { pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_wget" },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, id: "read_secrets" },
  { pattern: /authorized_keys/i, id: "ssh_backdoor" },
  { pattern: /\$HOME\/\.ssh|~\/\.ssh/i, id: "ssh_access" },
];

const SECRET_PATTERNS: Array<{ pattern: RegExp; id: string; severity: "high" | "medium" }> = [
  { pattern: /\bsk-ant-api\S{10,}\b/, id: "anthropic_api_key", severity: "high" },
  { pattern: /\bsk-or-v1-\S{10,}\b/, id: "openrouter_api_key", severity: "high" },
  { pattern: /\bsk-\S{20,}\b/, id: "openai_api_key", severity: "high" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, id: "aws_access_key", severity: "high" },
  { pattern: /\bghp_\S{10,}\b/, id: "github_personal_token", severity: "high" },
  { pattern: /\bghu_\S{10,}\b/, id: "github_user_token", severity: "high" },
  { pattern: /\bxoxb-\S{10,}\b/, id: "slack_bot_token", severity: "high" },
  { pattern: /\bxapp-\S{10,}\b/, id: "slack_app_token", severity: "high" },
  { pattern: /\bntn_\S{10,}\b/, id: "notion_token", severity: "high" },
  { pattern: /\bBearer\s+\S{20,}\b/, id: "bearer_auth_token", severity: "high" },
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\sKEY-----/, id: "private_key_block", severity: "high" },
  { pattern: /\bANTHROPIC_API_KEY\b/, id: "env_anthropic_key", severity: "medium" },
  { pattern: /\bOPENAI_API_KEY\b/, id: "env_openai_key", severity: "medium" },
  { pattern: /\bOPENROUTER_API_KEY\b/, id: "env_openrouter_key", severity: "medium" },
  { pattern: /\bGITHUB_TOKEN\b/, id: "env_github_token", severity: "medium" },
  { pattern: /\bAWS_SECRET_ACCESS_KEY\b/, id: "env_aws_secret", severity: "medium" },
  { pattern: /\bDATABASE_URL\b/, id: "env_database_url", severity: "medium" },
  { pattern: /\bpassword\s*[=:]\s*\S{6,}\b/i, id: "password_assignment", severity: "medium" },
  { pattern: /\bsecret\s*[=:]\s*\S{6,}\b/i, id: "secret_assignment", severity: "medium" },
  { pattern: /\btoken\s*[=:]\s*\S{10,}\b/i, id: "token_assignment", severity: "medium" },
];

const INVISIBLE_CHARS = new Set([
  "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff",
  "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
]);

/** 返回错误信息表示内容被拦截，null 表示安全。语义与插件 scanContent 一致。 */
export function scanMemoryContent(content: string): string | null {
  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      return `Blocked: content contains invisible unicode character U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} (possible injection).`;
    }
  }
  for (const { pattern, id } of MEMORY_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content matches threat pattern '${id}'.`;
    }
  }
  for (const { pattern, id, severity } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content looks like a ${severity}-severity credential or secret ('${id}'). Never persist API keys, tokens, or passwords to memory.`;
    }
  }
  return null;
}

// ─── 配置（只读 hermes-memory-config.json 中影响路径/限额的字段） ───

interface HermesConfigView {
  memoryDir: string;
  projectsMemoryDir: string;
  memoryCharLimit: number;
  userCharLimit: number;
  projectCharLimit: number;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

function readHermesConfig(): Record<string, unknown> {
  const configPath = join(getAgentDir(), "hermes-memory-config.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function configView(): HermesConfigView {
  const agentDir = getAgentDir();
  const cfg = readHermesConfig();

  let memoryDir = join(agentDir, "pi-hermes-memory");
  if (typeof cfg.memoryDir === "string" && cfg.memoryDir.trim()) {
    const expanded = expandHome(cfg.memoryDir.trim());
    memoryDir = isAbsolute(expanded) ? resolve(expanded) : resolve(agentDir, expanded);
  }

  let projectsMemoryDir = "projects-memory";
  if (typeof cfg.projectsMemoryDir === "string" && cfg.projectsMemoryDir.trim()) {
    // 插件 normalizeProjectsMemoryDir 只接受 agent 根下的单层相对目录
    const segments = cfg.projectsMemoryDir.trim().replace(/^[/\\]+|[/\\]+$/g, "").split(/[/\\]+/).filter(Boolean);
    if (segments.length === 1 && segments[0] !== "." && segments[0] !== "..") {
      projectsMemoryDir = segments[0];
    }
  }

  const memoryCharLimit = typeof cfg.memoryCharLimit === "number" && cfg.memoryCharLimit > 0
    ? cfg.memoryCharLimit : DEFAULT_MEMORY_CHAR_LIMIT;
  const userCharLimit = typeof cfg.userCharLimit === "number" && cfg.userCharLimit > 0
    ? cfg.userCharLimit : DEFAULT_USER_CHAR_LIMIT;
  const projectCharLimit = typeof cfg.projectCharLimit === "number" && cfg.projectCharLimit > 0
    ? cfg.projectCharLimit : DEFAULT_PROJECT_CHAR_LIMIT;

  return { memoryDir, projectsMemoryDir, memoryCharLimit, userCharLimit, projectCharLimit };
}

// ─── 路径与条目解析 ───

/** cwd → 插件使用的项目名（git 根目录 basename，无 git 则 cwd basename）。 */
export async function hermesProjectNameForCwd(cwd: string): Promise<string> {
  const info = await resolveProject(cwd);
  return basename(info.projectRoot) || basename(cwd);
}

export function hermesMemoryFilePath(target: HermesMemoryTarget, projectName: string): string {
  const agentDir = getAgentDir();
  const { memoryDir, projectsMemoryDir } = configView();
  switch (target) {
    case "user":
      return join(memoryDir, "USER.md");
    case "failure":
      return join(memoryDir, "failures.md");
    case "project":
      // projects 根固定在 <agentDir>/<projectsMemoryDir> 下，与 memoryDir 无关
      return join(agentDir, projectsMemoryDir, projectName, "MEMORY.md");
    default:
      return join(memoryDir, "MEMORY.md");
  }
}

function parseFailureCategory(text: string): string | null {
  const match = text.match(/^\[(failure|correction|insight|preference|convention|tool-quirk)\]\s*/);
  return match ? match[1] : null;
}

/** 与插件 decodeEntry 相同的元数据正则（含 legacy 无元数据回退）。
 *  注意用 [\s\S]*? 而不是 .*? 匹配正文：条目常为多行，`.` 不跨行会导致
 *  多行条目匹配失败、把元数据注释当正文泄漏到 UI（插件正则有同样局限，
 *  这里做得更稳）。 */
function decodeEntry(raw: string): { text: string; created: string; last: string; project: string | null } {
  const match = raw.match(/^([\s\S]*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?\s*-->\s*$/);
  if (match) {
    let project: string | null = null;
    if (match[4]) {
      try {
        project = Buffer.from(match[4], "base64url").toString("utf-8").trim() || null;
      } catch {
        // 非法 base64 按无项目处理
      }
    }
    return { text: match[1].trim(), created: match[2].trim(), last: match[3].trim(), project };
  }
  const today = new Date().toISOString().split("T")[0];
  return { text: raw.trim(), created: today, last: today, project: null };
}

/** 与插件 encodeEntry 相同的序列化格式。 */
function encodeEntry(text: string, created: string, last: string, project?: string | null): string {
  const projectMetadata = project?.trim()
    ? `, project64=${Buffer.from(project.trim(), "utf-8").toString("base64url")}`
    : "";
  return `${text} <!-- created=${created}, last=${last}${projectMetadata} -->`;
}

export function parseHermesMemoryFile(content: string): HermesMemoryEntry[] {
  if (!content.trim()) return [];
  return content
    .split(HERMES_ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((raw) => {
      const decoded = decodeEntry(raw);
      return {
        ...decoded,
        category: parseFailureCategory(decoded.text),
        raw,
      };
    });
}

function serializeEntries(entries: HermesMemoryEntry[]): string {
  return entries.length ? entries.map((e) => e.raw).join(HERMES_ENTRY_DELIMITER) : "";
}

export function usageFor(entries: HermesMemoryEntry[], limit: number): HermesUsage {
  const current = entries.length ? entries.map((e) => e.raw).join(HERMES_ENTRY_DELIMITER).length : 0;
  return {
    current,
    limit,
    percent: limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0,
    entryCount: entries.length,
  };
}

export function charLimitFor(target: HermesMemoryTarget): number {
  const { memoryCharLimit, userCharLimit, projectCharLimit } = configView();
  switch (target) {
    case "user":
      return userCharLimit;
    case "failure":
      return memoryCharLimit * 2; // failures.md 上限为 memory 限额 ×2，与插件一致
    case "project":
      return projectCharLimit;
    default:
      return memoryCharLimit;
  }
}

// ─── 读写与增删改 ───

function readEntries(filePath: string): HermesMemoryEntry[] {
  if (!existsSync(filePath)) return [];
  return parseHermesMemoryFile(readFileSync(filePath, "utf-8"));
}

/** 同目录 temp 文件 + rename，避免 Windows 跨盘 rename 报 EXDEV。 */
function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = join(dirname(filePath), `.pi-studio-edit-${Date.now()}-${randomUUID()}`);
  try {
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw err;
  }
}

export interface HermesMemoryOperation {
  target: HermesMemoryTarget;
  action: "add" | "replace" | "remove";
  /** add 的内容 / replace-remove 目标条目的正文（精确匹配） */
  text?: string;
  /** replace 的新正文 */
  newText?: string;
  /** 条目定位辅助：同正文多副本（distinct scoped failure copies）时区分 */
  project?: string | null;
}

/**
 * 读取-修改-原子写。定位用解码后正文精确匹配（比插件的子串匹配更稳），
 * 未修改条目原样保留 raw；replace 保留 created、last 更新为今天、保留 project64。
 * 超出字符限额直接拒绝（对应插件默认 reject 策略）。
 */
export async function applyHermesMemoryOperation(
  cwd: string,
  op: HermesMemoryOperation,
): Promise<HermesMemoryMutationResult> {
  const projectName = await hermesProjectNameForCwd(cwd);
  const filePath = hermesMemoryFilePath(op.target, projectName);
  const limit = charLimitFor(op.target);
  const entries = readEntries(filePath);
  const today = new Date().toISOString().split("T")[0];

  if (op.action === "add") {
    const content = (op.text ?? "").trim();
    if (!content) return { success: false, error: "Content cannot be empty." };
    const scanError = scanMemoryContent(content);
    if (scanError) return { success: false, error: scanError };
    const duplicate = entries.some(
      (e) => e.text === content && (op.target !== "failure" || e.project === (op.project?.trim() || null)),
    );
    if (duplicate) return { success: false, error: "Entry already exists (no duplicate added)." };
    const encoded = encodeEntry(content, today, today, op.target === "failure" ? (op.project ?? null) : null);
    const newTotal = [...entries.map((e) => e.raw), encoded].join(HERMES_ENTRY_DELIMITER).length;
    if (newTotal > limit) {
      return { success: false, error: `Memory at ${usageFor(entries, limit).current}/${limit} chars. Adding this entry would exceed the limit.` };
    }
    const next = [...entries, { ...decodeEntry(encoded), category: parseFailureCategory(content), raw: encoded }];
    atomicWrite(filePath, serializeEntries(next));
    return { success: true, usage: usageFor(next, limit) };
  }

  // replace / remove：按（正文 + 可选 project）精确定位
  const targetText = (op.text ?? "").trim();
  if (!targetText) return { success: false, error: "Entry text required." };
  const matches = entries.filter(
    (e) => e.text === targetText
      && (op.project === undefined || op.project === null || e.project === op.project),
  );
  if (matches.length === 0) {
    return { success: false, error: "Entry not found — the file may have changed. Reload and try again." };
  }
  if (matches.length > 1) {
    return { success: false, error: "Multiple entries share this text. Disambiguate by project scope." };
  }
  const matched = matches[0];

  if (op.action === "remove") {
    const next = entries.filter((e) => e !== matched);
    atomicWrite(filePath, serializeEntries(next));
    return { success: true, usage: usageFor(next, limit) };
  }

  // replace
  const newContent = (op.newText ?? "").trim();
  if (!newContent) return { success: false, error: "New content cannot be empty. Use 'remove' to delete an entry." };
  const scanError = scanMemoryContent(newContent);
  if (scanError) return { success: false, error: scanError };
  const encoded = encodeEntry(newContent, matched.created, today, matched.project);
  const replaced = entries.map((e) => (e === matched
    ? { ...decodeEntry(encoded), category: parseFailureCategory(newContent), raw: encoded }
    : e));
  const newTotal = replaced.map((e) => e.raw).join(HERMES_ENTRY_DELIMITER).length;
  if (newTotal > limit) {
    return { success: false, error: `Replacement would put memory at ${newTotal}/${limit} chars.` };
  }
  atomicWrite(filePath, serializeEntries(replaced));
  return { success: true, usage: usageFor(replaced, limit) };
}

/** 读取单个目标的条目与用量（文件不存在视为空）。 */
export async function loadHermesMemoryTarget(
  cwd: string,
  target: HermesMemoryTarget,
): Promise<{ projectName: string; entries: HermesMemoryEntry[]; usage: HermesUsage }> {
  const projectName = await hermesProjectNameForCwd(cwd);
  const filePath = hermesMemoryFilePath(target, projectName);
  const entries = readEntries(filePath);
  return { projectName, entries, usage: usageFor(entries, charLimitFor(target)) };
}
