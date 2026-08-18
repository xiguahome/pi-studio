import { NextResponse } from "next/server";
import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const OPTIMIZE_TIMEOUT_MS = 30_000;

const OPTIMIZE_SYSTEM_PROMPT = [
  "你是一个提示词优化助手。将用户输入的提示词改写得更清晰、具体、高效：",
  "- 补全隐含的上下文与目标，明确期望的输出形式",
  "- 必要时分点结构化，去除口语化冗余",
  "- 严格保留用户的原始意图与输入语言，不添加用户没有提出的要求，不编造细节",
  "- 若输入已经足够完善，仅做轻微润色",
  "直接输出改写后的提示词文本，不要任何解释、前后缀或引号包裹。",
].join("\n");

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function POST(req: Request) {
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { ok: false, error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  try {
    const body = await req.json() as { prompt?: unknown; provider?: unknown; modelId?: unknown };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const providerName = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!prompt) return NextResponse.json({ ok: false, error: "prompt is required" }, { status: 400 });
    if (!providerName || !modelId) {
      return NextResponse.json({ ok: false, error: "provider and modelId are required" }, { status: 400 });
    }

    const modelRuntime = await ModelRuntime.create();
    const loadError = modelRuntime.getError();
    if (loadError) return NextResponse.json({ ok: false, error: loadError });

    const model = modelRuntime.getModel(providerName, modelId);
    if (!model) {
      return NextResponse.json({ ok: false, error: `Model not found: ${providerName}/${modelId}` });
    }

    const resolved = await modelRuntime.getAuth(model);
    if (!resolved?.auth.apiKey) {
      return NextResponse.json({ ok: false, error: `No API key found for "${providerName}"` });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPTIMIZE_TIMEOUT_MS);

    try {
      const message = await completeSimple(model, {
        systemPrompt: OPTIMIZE_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        }],
      }, {
        apiKey: resolved.auth.apiKey,
        headers: resolved.auth.headers,
        maxTokens: 2048,
        timeoutMs: OPTIMIZE_TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
      });

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return NextResponse.json({
          ok: false,
          error: message.errorMessage ?? (controller.signal.aborted ? "Optimize request timed out" : "Model returned an error"),
        });
      }

      const optimizedPrompt = getAssistantText(message).trim();
      if (!optimizedPrompt) {
        return NextResponse.json({ ok: false, error: "Model returned an empty response" });
      }

      return NextResponse.json({ ok: true, optimizedPrompt });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
