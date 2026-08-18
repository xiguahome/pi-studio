# pi-studio 开发指南

pi-studio 是 [pi coding agent](https://github.com/earendil-works/pi) 的跨平台桌面端，由 **Electron + Next.js + pi agent SDK** 组成。pi agent 以 SDK（`@earendil-works/pi-coding-agent`）形式进程内嵌，无需单独安装命令行工具。

---

## 环境要求

- **Node.js >= 22.19.0**（与 pi SDK 的 `engines` 一致；打包用的独立 Node runtime 也是这个版本）
- npm

检查：
```bash
node -v
```

---

## 首次准备

```bash
npm install
```

这会安装运行时依赖（含 pi SDK）和开发工具。pi agent 相关包（`@earendil-works/*`）已在 `dependencies` 中，随应用一起分发，终端用户无需另行安装。

---

## 数据目录

所有 pi agent 数据统一存放在 **`~/.pi-studio/`**，开发期与打包后完全一致：

| 平台 | 路径 |
|---|---|
| Windows | `C:\Users\<用户名>\.pi-studio` |
| macOS | `~/.pi-studio` |
| Linux | `~/.pi-studio` |

包含：`settings.json`、`models.json`、`auth.json`、`sessions/`、`skills/`、`themes/`、`trust.json` 等。

- 由 `PI_CODING_AGENT_DIR` 环境变量控制（桌面端在 `desktop/main.js` 注入；`npm run dev` 直跑时由 `next.config.ts` 兜底）。
- 与 `pi` 命令行工具（默认用 `~/.pi/agent`）**数据隔离**，互不影响。
- 全局 skills 的真实文件由外部 `skills` CLI 写到 `~/.pi-studio/skills`，与 SDK 的 `<agentDir>/skills` 天然重合，无需额外配置。

---

## 三种运行方式

### 方式 A：热更新开发（日常推荐）⭐

两个终端配合——Next dev server 提供热更新，Electron 壳作为 UI 容器连过去：

```bash
# 终端 1：启动 Next dev server（热更新，自动用 ~/.pi-studio）
npm run dev

# 终端 2：Electron 壳连到 dev server（不再自己起 server）
npm run desktop:dev
```

`desktop:dev` 内部用 `cross-env` 设置 `PI_DESKTOP_SERVER_URL`，跨 PowerShell / cmd / Bash 通用，无需手动处理环境变量语法。

**特点**：
- 改前端组件（React/TSX）、后端 API route、`lib/` 代码 → 保存即热更新
- 只有改 `desktop/main.js` 或 `desktop/server.js`（Electron 主进程）才需要重启终端 2
- pi agent 逻辑全跑在终端 1 的 dev server 进程里

> **手动设置环境变量**（不走 `desktop:dev` 时）：PowerShell 用 `$env:PI_DESKTOP_SERVER_URL="http://127.0.0.1:30141"; npm run desktop`；cmd 用 `set PI_DESKTOP_SERVER_URL=http://127.0.0.1:30141 && npm run desktop`；Bash 用 `PI_DESKTOP_SERVER_URL=http://127.0.0.1:30141 npm run desktop`。

### 方式 B：构建后运行（验证 build 产物）

```bash
npm run build && npm run desktop
```

Electron 自己 spawn `next start`（需要 `.next` 构建产物）。每次改代码都要重新 `npm run build`，速度慢，适合偶尔验证打包后的运行表现，不适合频繁迭代。

### 方式 C：打包完整安装包（发版前验证）

```bash
npm run desktop:dist
```

依次执行：`next build` → 下载独立 Node v22.19.0 runtime → `electron-builder` 打包。产物在 `dist-desktop/`：

| 平台 | 产物 |
|---|---|
| Windows | `pi-studio-Setup-<version>.exe`（NSIS 安装包） |
| macOS | `.dmg` + `.zip`（x64 + arm64 双架构） |
| Linux | `.AppImage` + `.deb` |

**Node runtime 是什么、为什么打包要"下载"**：`desktop/runtime/node-runtime/`（含 `node` + `npm`）不是仓库自带的，而是 `desktop/scripts/install-node-runtime.mjs` 在打包时从 Node 官方包解压出来的产物——这就是方式 C 里那步"下载"。它的作用是让终端用户**无需自装 Node**：安装包内置了这个 runtime，启动时用它跑 `next start`，首启还用它内置的 npm 联网安装内置扩展（见下文「内置扩展首启 seed」）。注意 npm 必须放在 `<runtime>/npm`，不能放在 `<runtime>/node_modules/npm`——electron-builder 会无条件丢弃 extraResources 源根下的顶层 `node_modules`。下载后缓存到 `desktop/runtime/node-runtime/`（`.gitignore` 忽略），重复打包不重下。

> 只想单独下载 runtime：`npm run desktop:runtime`。下载源默认走 npmmirror 国内镜像，可用 `NODEJS_ORG_MIRROR` 环境变量覆盖（见「联网下载清单」）。

**安装包为什么不带 `node_modules`（首次启动才装）**：生产依赖（next + pi SDK 等，数百 MB）之前整体打进安装包，NSIS 解压极慢。现在 `electron-builder.yml` 的 extraResources **不再打包 node_modules**，只打包安装所需的 `package-lock.json` + `patches/` + `scripts/`。终端用户首次启动时，`desktop/main.js` 检测到 `pi-web/node_modules` 缺失，spawn `desktop/scripts/first-run-install.mjs`，用 runtime 内置的 npm 执行 `npm install --omit=dev`（只装生产依赖，不拉 electron/electron-builder 等构建工具），并把进度/日志实时渲染到 `desktop/loading.html`（进度条 + 已获取包计数 + npm 日志滚动）。安装完成后 `node_modules` 保留在安装目录，后续启动直接跳过；npm 缓存（`~/.npm`）使升级重装基本秒过。失败弹对话框可重试/退出。

- **registry**：默认 `https://registry.npmmirror.com`，终端用户可用环境变量 `PI_NPM_REGISTRY` 覆盖（如官方源）；打包机不受影响
- **postinstall 依赖 patch-package**：首次安装用 `--omit=dev` 装生产依赖，因此 `patch-package` 是 **dependencies** 而非 devDependencies（否则 `.pi → .pi-studio` 的 SDK patch 无法应用）；`patches/` 与 `scripts/` 随 extraResources 打包到 `pi-web/`
- **可写性**：默认 NSIS 每用户安装到 `%LOCALAPPDATA%\Programs` 可写；若被装到 Program Files，脚本会给出明确的权限错误提示

---

## 跨平台打包

`electron-builder` 无法在一台机器上打所有平台——**目标平台必须在对应系统上构建**：

| 打包机 | 可输出的目标 |
|---|---|
| Windows | 仅 `win`（NSIS 安装包） |
| macOS | `win` / `mac` / `linux`（最全） |
| Linux | `linux` / 部分 `win`（需 wine） |

所以：**Windows 包在 Windows 上打，mac 包必须在 macOS 上打**。

### mac 一次打双架构

`electron-builder.yml` 已配置 mac 同时覆盖 Intel 与 Apple Silicon：

```yaml
mac:
  target:
    - target: dmg
      arch: [x64, arm64]
    - target: zip
      arch: [x64, arm64]
```

在 mac 上一次 `npm run desktop:dist` 会产出 4 个文件到 `dist-desktop/`：

| 文件 | 适用 |
|---|---|
| `pi-studio-<version>-x64.dmg` / `.zip` | Intel Mac |
| `pi-studio-<version>-arm64.dmg` / `.zip` | Apple Silicon（M1/M2/M3…） |

### 联网下载清单（打包机 + 终端用户）

打包和首启会联网下载以下内容，国内打包机需按下表配置镜像。除 Node runtime 已默认走国内镜像外，其余二进制都需要手动配：

| 环节 | 下载内容 | 默认源 | 镜像配置 | 何时触发 |
|---|---|---|---|---|
| npm 依赖 | 全部 `dependencies` | npm registry | 用户 `~/.npmrc` 的 `registry` | `npm install` |
| 终端用户首启依赖安装 | 生产依赖（`--omit=dev`） | npmmirror（默认） | `PI_NPM_REGISTRY` 环境变量 | 终端用户首次启动（`desktop/main.js` → `first-run-install.mjs`） |
| Electron 二进制 | electron 运行时 ~90MB | GitHub Releases | 项目 `.npmrc` → `electron_mirror` | `npm install`（electron postinstall） |
| electron-builder 工具 | NSIS / winCodeSign 等 | GitHub Releases | 项目 `.npmrc` → `electron_builder_binaries_mirror` | `electron-builder` 打包 |
| Node runtime | Node v22.19.0 + npm | npmmirror（已默认国内镜像） | `NODEJS_ORG_MIRROR` 环境变量 | `desktop:runtime` / `desktop:dist` |
| 内置扩展 seed | 7 个 npm 扩展 | npmmirror（硬编码） | 无需配 | 终端用户首启（见下文） |

**国内打包机配置**：Electron 和 electron-builder 的二进制默认从 GitHub Releases 下载，**国内直连会长时间卡住**。项目根目录的 `.npmrc` 已入库（含 `electron_mirror` / `electron_builder_binaries_mirror`，提交 `f9d20e5`），全新 `git clone` 自动走 npmmirror 镜像，无需手动配置：

```ini
electron_mirror=https://registry.npmmirror.com/-/binary/electron/
electron_builder_binaries_mirror=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
```

> `.npmrc` 随仓库走，全新 clone 自动生效，每台打包机无需重复配。**唯一需要各机器单独配的是 npm registry**——它由用户全局 `~/.npmrc` 的 `registry` 决定（国内打包机设 `registry=https://registry.npmmirror.com`），项目级 `.npmrc` 故意不覆盖它，避免影响其他项目。

> Node runtime 下载默认已走 npmmirror，无需额外配置；若要切回官方源：`NODEJS_ORG_MIRROR=https://nodejs.org/dist npm run desktop:runtime`。

### Node runtime 指定平台

`npm run desktop:runtime` 默认下载当前系统的 Node v22.19.0。如需为其他平台预备 runtime：

```bash
node desktop/scripts/install-node-runtime.mjs --platform darwin --arch arm64
```

支持 `--platform win|darwin|linux` × `--arch x64|arm64`。

### mac 正式分发还需签名 + 公证

未签名的 `.dmg` 用户双击会被 Gatekeeper 拦截（"无法验证开发者"）。正式发版需配置 Apple Developer 凭证（环境变量）：`CSC_LINK` / `CSC_KEY_PASSWORD`（代码签名）、`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`（公证）。自测阶段不签名也能用（右键 → 打开 可绕过）。

---

## 内置扩展首启 seed（网络更新）

pi-studio 把 7 个 npm 扩展作为**内置能力**（MCP、子代理、记忆、任务、计划/目标模式、ask_user_question），**不预置进安装包**，而是终端用户首次启动时用内置 runtime 的 npm 从国内镜像联网安装：

- **触发**：Next server 启动钩子（`instrumentation.ts`）fire-and-forget，不阻塞服务启动
- **下载源**：`https://registry.npmmirror.com`（硬编码在 `lib/builtin-extensions.ts` 的 `BUILTIN_NPM_REGISTRY`，国内镜像）
- **安装目标**：`~/.pi-studio/npm/node_modules/`（全局，所有项目/会话共享）
- **幂等**：每次启动检查，已装且已在 `settings.json` 登记的跳过；锁文件 `~/.pi-studio/.builtin-seed.lock` 防多窗口并发
- **状态**：进度/结果写 `~/.pi-studio/.builtin-seed.json`，Plugins 页面可见
- **保护**：内置扩展不可卸载（`/api/plugins` 对 builtin 源返回 403）

内置列表（`lib/builtin-extensions.ts` 的 `BUILTIN_EXTENSION_SOURCES`）：

| 扩展 | 作用 |
|---|---|
| `pi-mcp-adapter` | MCP 协议（含 native `@napi-rs/keyring`） |
| `pi-subagents` | 子代理（纯 JS） |
| `pi-hermes-memory` | 记忆（含 native `better-sqlite3`） |
| `@tintinweb/pi-tasks` | 任务跟踪 |
| `@narumitw/pi-plan-mode` | /plan 计划模式 |
| `@narumitw/pi-goal` | /goal 目标模式 |
| `@juicesharp/rpiv-ask-user-question` | ask_user_question 工具 |

> 含 native 的扩展（`pi-hermes-memory`、`pi-mcp-adapter`）首启会从 npmmirror 拉对应平台的预编译二进制，需要联网。离线环境首启 seed 会失败并在 Plugins 页面提示，但不影响应用启动本身——runtime 和 pi SDK 已随包内置。
>
> **native 二进制镜像兜底**：`better-sqlite3`（`pi-hermes-memory` 的依赖）的 install 脚本用 `prebuild-install` 从 GitHub releases 拉预编译 `.node`——国内直连 GitHub 经常 `ECONNRESET`，失败后回退 `node-gyp` 源码编译又需要 VS Build Tools，双重失败。`lib/builtin-extensions.ts` 的 `ensureNpmProjectDir()` 会在 `~/.pi-studio/npm/.npmrc` 写入 `better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3`，让 `prebuild-install` 改从 npmmirror 二进制镜像拉，**无需代理、无需 VS 工具链**即可装上。`/api/plugins` 的 install 分支安装前也会调 `ensureBuiltinNpmDirMirrors()` 保证 Plugins 页手动安装同样生效。镜像配置在 `BUILTIN_NPM_BINARY_MIRRORS` 常量里集中维护，新增其它 native 包时往里加键即可。

---

## 方式对比

| 方式 | 热更新 | 速度 | 适用场景 |
|---|---|---|---|
| **A** dev + desktop | ✅ 即时 | 最快 | 日常开发 |
| **B** build + desktop | ❌ 每次重建 | 慢 | 验证 build 产物 |
| **C** desktop:dist | ❌ | 最慢 | 发版前验证 / 产出安装包 |

> **端口分配（dev 与安装版可并行）**：`npm run dev` 固定绑定 `127.0.0.1:30141`（无避让逻辑）；打包后的安装版由 `desktop/server.js` 的 `findFreePort` **优先绑定 30142**（被占则顺延 30143…）。两者端口空间错开，**dev 与安装版可同时运行，启动顺序无要求**——先开哪个都不会冲突。

---

## 常用命令一览

| 命令 | 作用 |
|---|---|
| `npm run dev` | Next dev server（端口 127.0.0.1:30141） |
| `npm run build` | 生产构建到 `.next/` |
| `npm run start` | 以生产模式启动 Next（需先 build） |
| `npm run desktop` | 启动 Electron 壳（`electron .`） |
| `npm run desktop:runtime` | 下载独立 Node v22.19.0 runtime |
| `npm run desktop:dist` | 完整打包流程（build + runtime + electron-builder） |
| `npm run lint` | ESLint 检查 |
| `node_modules/.bin/tsc --noEmit` | TypeScript 类型检查 |
| `npm test` | 运行单元测试 |

---

## 代码检查

提交前建议跑：

```bash
node_modules/.bin/tsc --noEmit   # 类型检查
npm run lint                     # 代码规范
```

> ⚠️ **切勿在开发期跑 `next build` 之外的方式污染 `.next/`**。若 `tsc` 报告 `.next/dev/types/...` 下陈旧路由类型错误（删过 API route 后常见），删除 `.next/dev/types` 目录即可，下次 `npm run dev` 会重新生成。

---

## 项目结构（关键部分）

```
pi-web/
├── desktop/                 Electron 主进程（壳）
│   ├── main.js              主进程入口：窗口、IPC、注入 PI_CODING_AGENT_DIR
│   ├── server.js            spawn bin/pi-web.js（next start）的生命周期管理
│   ├── preload.js           沙箱预加载
│   ├── loading.html         启动加载页
│   └── scripts/
│       └── install-node-runtime.mjs   下载独立 Node runtime
├── bin/                     Next server 启动器（桌面端 spawn 它）
│   ├── pi-web.js            解析参数 → spawn next start（固定 127.0.0.1）
│   ├── pi-web-options.js    启动参数解析
│   └── node-version.js      Node 版本校验
├── app/                     Next.js App Router
│   ├── layout.tsx           根布局
│   └── api/                 API routes（agent/sessions/skills/models/...）
├── components/              React 组件
├── lib/                     共享逻辑（rpc-manager / session-reader / ...）
├── hooks/                   React hooks
├── electron-builder.yml     electron-builder 打包配置
├── next.config.ts           Next 配置（含 PI_CODING_AGENT_DIR 兜底）
└── package.json
```

---

## 常见问题

**Q: 终端用户需要安装 pi 命令行吗？**
不需要。pi agent 作为 SDK 依赖随安装包分发（`electron-builder.yml` 把 `node_modules` 打进 `resources/pi-web/node_modules`），终端用户装完桌面端即可使用。

**Q: `desktop/` 里已经内置了 npm，为什么打包时还要"下载 Node runtime"？**
`desktop/runtime/node-runtime/`（含 `node` + `npm`）不是仓库自带的，而是 `install-node-runtime.mjs` 在打包时从 Node 官方包解压出来的产物——"下载"和"内置 npm"是因果关系：先下载 Node 官方包 → 才解压出 node + npm → 放进 runtime（npm 落在 `<runtime>/npm`，避开 electron-builder 对顶层 `node_modules` 的强制剔除）→ 打进安装包。下载一次后缓存到 `desktop/runtime/`（`.gitignore` 忽略），重复打包不重下。终端用户拿到包时 runtime 已内置，无需自装 Node。默认走 npmmirror 国内镜像，可用 `NODEJS_ORG_MIRROR` 覆盖。

**Q: 为什么桌面端数据在 `~/.pi-studio` 而不是 `~/.pi/agent`？**
为了让 pi 的全局 skills 目录（`<agentDir>/skills`）与外部 skills CLI 的 canonical 存储（`~/.pi-studio/skills`）天然重合，实现真正的数据自包含。`pi` 命令行仍用 `~/.pi/agent`，两者隔离。

**Q: 改了 `desktop/main.js` 为什么没生效？**
Electron 主进程代码不会热更新，需要在终端 2 按 `Ctrl+C` 停止后重新 `npm run desktop`（或带 `PI_DESKTOP_SERVER_URL` 的命令）。

**Q: `npm run dev` 单独跑能用来开发桌面端吗？**
能用来开发 UI 和 agent 逻辑（浏览器访问 `http://127.0.0.1:30141`），但拿不到 Electron 的原生能力（窗口、IPC）。要完整测试桌面端体验，请用方式 A 的两个终端。

**Q: 打包后应用图标在哪改？**
`electron-builder.yml` 的 `win/mac/linux.icon` 字段，当前指向 `public/icons/icon-512.png`。替换该文件或改路径即可。

**Q: `npm run dev` 报 `TurbopackInternalError: failed to create junction point ... 目录不是空的 (os error 145)`？**
Windows 下 Turbopack 在 `.next/dev/node_modules/` 创建的 junction（符号链接）缓存损坏。删除整个 `.next` 目录后重跑即可：
```bash
rm -rf .next
npm run dev
```
常见触发原因：切换分支、改了 `serverExternalPackages`、或手动删过 `.next` 的部分内容导致状态不一致。
