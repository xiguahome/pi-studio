import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// 默认 pi 数据目录：开发期 `npm run dev`（直跑 Next，无 Electron 注入）也用 ~/.pi-studio，
// 与桌面端一致。生产桌面端由 desktop/main.js 先注入 PI_CODING_AGENT_DIR，此处不覆盖。
if (!process.env.PI_CODING_AGENT_DIR) {
  process.env.PI_CODING_AGENT_DIR = join(homedir(), ".pi-studio");
}

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  // Permanently hide the next dev Dev Tools indicator (bottom-right floating ball).
  devIndicators: false,
  serverExternalPackages: [
    "undici",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
