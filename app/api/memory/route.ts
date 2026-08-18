import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { charLimitFor, loadHermesMemoryTarget, usageFor } from "@/lib/hermes-memory";
import type { HermesMemoryEntry, HermesUsage } from "@/lib/hermes-memory";

export const dynamic = "force-dynamic";

interface MemoryTargetView {
  entries: Array<Omit<HermesMemoryEntry, "raw">>;
  usage: HermesUsage;
}

// GET /api/memory?cwd=<path>
// 列出 pi-hermes-memory 四类记忆目标（markdown 为权威源；SQLite 镜像不在此
// 返回——它是派生数据，会在插件下次记忆操作时自动 reconcile）。
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const [memory, user, failure, project] = await Promise.all([
      loadHermesMemoryTarget(cwd, "memory"),
      loadHermesMemoryTarget(cwd, "user"),
      loadHermesMemoryTarget(cwd, "failure"),
      loadHermesMemoryTarget(cwd, "project"),
    ]);

    // failures.md 是全局文件，含所有项目的条目（带 project 标记）。设置界面
    // 只展示当前项目 + 无项目归属的全局条目，避免多个项目的失败教训混排。
    const scopedFailureEntries = failure.entries.filter(
      (e) => !e.project || e.project === project.projectName,
    );
    const scopedFailure = {
      projectName: failure.projectName,
      entries: scopedFailureEntries,
      usage: usageFor(scopedFailureEntries, charLimitFor("failure")),
    };

    const view = (t: { entries: HermesMemoryEntry[]; usage: HermesUsage }): MemoryTargetView => ({
      entries: t.entries.map(({ text, created, last, project: p, category }) => ({
        text, created, last, project: p, category,
      })),
      usage: t.usage,
    });

    return NextResponse.json({
      projectName: project.projectName,
      memory: view(memory),
      user: view(user),
      failure: view(scopedFailure),
      project: view(project),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
