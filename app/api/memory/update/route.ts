import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { applyHermesMemoryOperation } from "@/lib/hermes-memory";
import type { HermesMemoryTarget } from "@/lib/hermes-memory";

export const dynamic = "force-dynamic";

const TARGETS: readonly HermesMemoryTarget[] = ["memory", "user", "failure", "project"];
const ACTIONS = ["add", "replace", "remove"] as const;

interface UpdateBody {
  cwd?: string;
  target?: string;
  action?: string;
  text?: string;
  newText?: string;
  project?: string | null;
}

// POST /api/memory/update — 对 pi-hermes-memory 的 markdown 权威源做条目级
// 增删改。写入为同目录 temp+rename 原子写，并复用插件的防注入/防密钥扫描。
// 写入后 SQLite 检索镜像可能短暂陈旧，插件在下一次记忆操作时会自动 reconcile。
export async function POST(req: Request) {
  let body: UpdateBody;
  try {
    body = await req.json() as UpdateBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { cwd, target, action } = body;
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  if (!target || !TARGETS.includes(target as HermesMemoryTarget)) {
    return NextResponse.json({ error: "target must be memory|user|failure|project" }, { status: 400 });
  }
  if (!action || !ACTIONS.includes(action as (typeof ACTIONS)[number])) {
    return NextResponse.json({ error: "action must be add|replace|remove" }, { status: 400 });
  }

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const result = await applyHermesMemoryOperation(cwd, {
      target: target as HermesMemoryTarget,
      action: action as (typeof ACTIONS)[number],
      text: body.text,
      newText: body.newText,
      project: body.project,
    });
    if (!result.success) {
      return NextResponse.json({ error: result.error ?? "update failed" }, { status: 409 });
    }
    return NextResponse.json({ success: true, usage: result.usage });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
