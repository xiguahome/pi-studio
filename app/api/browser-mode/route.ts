import { NextResponse } from "next/server";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { readBrowserConfig, saveBrowserConfig } from "@/lib/browser-config";
import { writeChromeDevtoolsConfig } from "@/lib/chrome-devtools-config";
import { hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// GET /api/browser-mode — current built-in/external toggle
export async function GET() {
  try {
    return NextResponse.json(readBrowserConfig());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PUT /api/browser-mode — { builtin: boolean }. Persists the toggle, rewrites the
// chrome-devtools endpoint, and re-patches the plugin so the new target type
// (webview vs page) takes effect. The change requires a pi-studio restart.
export async function PUT(req: Request) {
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }
  let builtin: boolean;
  try {
    const body = (await req.json()) as { builtin?: unknown };
    if (typeof body.builtin !== "boolean") {
      return NextResponse.json({ error: "builtin must be a boolean" }, { status: 400 });
    }
    builtin = body.builtin;
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }

  try {
    // Persist state + rewrite the endpoint first so they survive even if the
    // patch step below fails.
    saveBrowserConfig(builtin);
    writeChromeDevtoolsConfig(builtin);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  // Re-patch the plugin source for the new target type (webview <-> page).
  // Best-effort: a missing or failing patch is surfaced as a warning rather
  // than a hard error, since the persisted state + endpoint are already correct.
  let patchOutput = "";
  let patchError: string | undefined;
  const mode = builtin ? "builtin" : "external";
  try {
    const patchScript = path.join(process.cwd(), "scripts", "patch-pi-chrome-devtools.mjs");
    if (existsSync(patchScript)) {
      patchOutput = execFileSync(process.execPath, [patchScript, `--mode=${mode}`], {
        encoding: "utf8",
        timeout: 30000,
      });
    } else {
      patchError = `patch script not found; run scripts/patch-pi-chrome-devtools.mjs --mode=${mode} manually.`;
    }
  } catch (e) {
    patchError = String(e);
  }

  return NextResponse.json({ builtin, needsRestart: true, patchOutput, patchError });
}
