import { NextResponse } from "next/server";
import { existsSync, readFileSync, statSync } from "fs";
import { basename } from "path";
import { checkSkillPathAccess } from "@/lib/skills-service";
import { validateSkillMarkdown } from "@/lib/skill-edit";
import { writeFileAtomicSync } from "@/lib/atomic-file";

export const dynamic = "force-dynamic";

function denyAccess() {
  return NextResponse.json({ error: "Access denied" }, { status: 403 });
}

function denyBuiltin() {
  return NextResponse.json(
    { error: "builtin skills are read-only" },
    { status: 403 },
  );
}

async function authorize(filePath: string | undefined | null) {
  if (!filePath) {
    return { response: NextResponse.json({ error: "filePath required" }, { status: 400 }) };
  }
  if (!existsSync(filePath)) {
    return { response: NextResponse.json({ error: "file not found" }, { status: 404 }) };
  }
  if (basename(filePath) !== "SKILL.md") {
    return { response: NextResponse.json({ error: "only SKILL.md files are editable" }, { status: 400 }) };
  }
  const { allowed, builtin } = await checkSkillPathAccess(filePath);
  if (!allowed) return { response: denyAccess() };
  if (builtin) return { response: denyBuiltin() };
  return { response: null };
}

// GET /api/skills/content?filePath=<path-to-SKILL.md>
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("filePath");
  try {
    const { response } = await authorize(filePath);
    if (response) return response;
    const content = readFileSync(filePath!, "utf8");
    const mtime = statSync(filePath!).mtimeMs;
    return NextResponse.json({ content, mtime });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PUT /api/skills/content — { filePath, content, baseMtime? }
// baseMtime is the mtime returned by GET; when provided and stale, the file
// changed on disk meanwhile and the save is rejected with 409.
export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as {
      filePath?: string;
      content?: string;
      baseMtime?: number;
    };
    const { filePath, content, baseMtime } = body;
    if (typeof content !== "string") {
      return NextResponse.json({ error: "content required" }, { status: 400 });
    }
    const { response } = await authorize(filePath);
    if (response) return response;

    if (typeof baseMtime === "number") {
      const currentMtime = statSync(filePath!).mtimeMs;
      if (currentMtime !== baseMtime) {
        return NextResponse.json(
          { error: "file changed on disk; reload before saving" },
          { status: 409 },
        );
      }
    }

    const validation = validateSkillMarkdown(content);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    writeFileAtomicSync(filePath!, content);
    return NextResponse.json({ success: true, mtime: statSync(filePath!).mtimeMs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
