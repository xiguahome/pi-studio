import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { statSync } from "fs";
import { dirname } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";

/** Same gate as /api/files: only session cwds / project roots / explicitly
 *  allowed dirs may be opened through this endpoint. */
async function checkPathAllowed(target: string): Promise<NextResponse | null> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(target, allowedRoots) || !isExistingFilePathAllowed(target, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return null;
}

function openInFileManager(dir: string): void {
  // Windows `explorer` exits non-zero even on success, so spawn detached and
  // never wait for the result — a launch failure is harmless here.
  const [cmd, args] = process.platform === "win32"
    ? ["explorer", [dir]]
    : process.platform === "darwin"
      ? ["open", [dir]]
      : ["xdg-open", [dir]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function spawnDetached(cmd: string, args: string[], onError?: () => void): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => onError?.());
  child.unref();
}

function openTerminal(dir: string): void {
  if (process.platform === "win32") {
    // Prefer Windows Terminal (ships with Windows 11); when it is missing the
    // spawn fails with ENOENT and we fall back to a PowerShell window.
    spawnDetached("wt", ["-d", dir], () => {
      const escaped = dir.replace(/'/g, "''");
      spawnDetached("powershell", [
        "-NoExit",
        "-Command",
        `Set-Location -LiteralPath '${escaped}'`,
      ]);
    });
    return;
  }
  if (process.platform === "darwin") {
    spawnDetached("open", ["-a", "Terminal", dir]);
    return;
  }
  // Linux: best-effort chain over common emulators.
  const candidates: Array<[string, string[]]> = [
    ["gnome-terminal", ["--working-directory", dir]],
    ["konsole", ["--workdir", dir]],
    ["xfce4-terminal", ["--working-directory", dir]],
    ["xterm", ["-e", `cd '${dir.replace(/'/g, "'\\''")}' && $SHELL`]],
  ];
  const trySpawn = (index: number) => {
    if (index >= candidates.length) return;
    const [cmd, args] = candidates[index];
    spawnDetached(cmd, args, () => trySpawn(index + 1));
  };
  trySpawn(0);
}

// POST /api/files/open  body: { path, kind?: "filemanager" | "terminal" }
export async function POST(req: Request) {
  try {
    const body = await req.json() as { path?: string; kind?: string };
    if (!body.path || typeof body.path !== "string") {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    const kind = body.kind === "terminal" ? "terminal" : "filemanager";
    const denied = await checkPathAllowed(body.path);
    if (denied) return denied;

    let isDir: boolean;
    try {
      isDir = statSync(body.path).isDirectory();
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Directories open directly; a file path opens its parent folder.
    const dir = isDir ? body.path : dirname(body.path);

    if (kind === "terminal") {
      openTerminal(dir);
    } else {
      openInFileManager(dir);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
