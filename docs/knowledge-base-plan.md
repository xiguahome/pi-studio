# 知识库（Knowledge Base）模块实现方案 — pi-studio

> 目标：在 `D:\wwwroot\pi-studio`（Next.js 16 + React 19 + Tailwind 4 + Electron 桌面单用户 AI Agent 工具）中，新增一个**独立**的知识库数据域，复用既有架构范式（原子文件真相源 + 域内 API + `MarkdownBody` 渲染），以 SQLite FTS5 做全文检索，敏感标记 + append-only 本地审计，文件驱动、无现成 ORM。

---

## 0. 三项核实结论（A / B / C）

### A. SQLite 选型 → 复用 **better-sqlite3@^12.9.0**（与 pi-hermes-memory 同版本，原生模块，本环境已验证可用）

**已核实事实（关键修正）：**
- `pi-hermes-memory@0.9.6`（项目内置扩展，见 `lib/builtin-extension-sources.ts:28`）的 `package.json` 第 63 行：`"better-sqlite3": "^12.9.0"`，description 明确写 "SQLite FTS5 search"。**它已经在用 better-sqlite3 原生模块在本桌面环境跑通**（FTS5 检索镜像）。
- 重要架构澄清：`pi-hermes-memory` 的 SQLite **封装在扩展包内部**（`~/.pi-studio/npm/node_modules/pi-hermes-memory/`，独立于主项目 `node_modules`）。主项目的 `lib/hermes-memory.ts` 只读写 markdown、**不碰 SQLite**——SQLite 由扩展运行时（agent session）使用。因此主项目的 Next.js 服务端**不能直接 import** hermes-memory 的 SQLite 实例，知识库需要自己的 DB 文件 + 自己的依赖。
- 既然 hermes-memory 的 better-sqlite3@12.9.0 在本环境编译/预编译成功，**原生模块风险已被证伪**：要么首装 `npm install` 抓到了匹配运行时的预编译二进制，要么构建链可用。知识库复用同一版本，风险一致且已知可控。

**结论与落地步骤（better-sqlite3）：**
1. 主项目 `package.json` 的 `dependencies` 增加 `"better-sqlite3": "^12.9.0"`（与 hermes-memory 同版本，复用其已验证的预编译缓存），确保 `first-run-install.mjs` 首装会装它。
2. 服务端初始化：`import Database from "better-sqlite3"; const db = new Database(knowledgeDbPath, { ... });` 直接以文件为库（路径 `~/.pi-studio/knowledge/index.sqlite`），**无需 WASM 加载、无需 export/load 往返**。
3. 写串行化：better-sqlite3 是单连接同步 API，用 `db.transaction(() => { ... })()` 包裹变更即可保证原子；再叠加一个进程内异步互斥（Promise 链）避免并发请求交错（轻量即可）。读操作 `db.prepare(sql).all(params)` 同步返回。
4. 持久化：better-sqlite3 自带 WAL/回滚日志，崩溃安全；`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` 提升并发读性能。
5. 中文分词：FTS5 默认按空白/标点分词、无中文词边界，需验证召回率（见风险 2）；必要时加 `trigram` 辅助子表或 bigram 预处理。**这是唯一仍需实测的点，与"用哪种 SQLite"无关。**

**备选（仅兜底，不推荐为主）：sql.js（WASM）** — 若某平台首装 better-sqlite3 预编译失败，可退回 sql.js（纯 WASM 无原生编译）。但会引入第二套 SQLite 栈 + WASM 加载 + `db.export()` 手动落盘，复杂度更高，故不作为首选。

### B. 文件上传 route 与大小限制现状 → 复用既有 `parseFormDataWithinLimit`

**已核实事实：**
- 现有上传机制：`app/api/files/[...path]/route.ts` 使用 `lib/bounded-form-data.ts` 的 `parseFormDataWithinLimit(request, MAX_UPLOAD_REQUEST_BYTES)` 做**流式大小封顶**（同时校验 `content-length` 声明值与逐块累加），超限抛 `RequestBodyTooLargeError` 返回 413。
- 既有大小约定（`app/api/files/[...path]/route.ts:41-44`）：
  - `MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024`（单文件 25MB）
  - `MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024`（单次请求总 100MB）
  - `MAX_UPLOAD_REQUEST_BYTES = 100MB + 1MB`（含 multipart 边界/头）
- 既有 `lib/file-upload.ts` 提供 `validateUploadFileNames` / `inspectUploadTargets`（文件名消毒、冲突检测），可直接复用其文件名校验逻辑。

**结论与建议值：**
- 知识库附件**不接入** `/api/files`（其 `allowedFileRoots` 不包含 `~/.pi-studio`，参见 MemoryConfig 注释），新建域内 `POST /api/knowledge/upload`，**复用** `parseFormDataWithinLimit` 与 `validateUploadFileNames`。
- 大小上限建议：单个附件 **20MB**（贴合用户其他项目 20MB 习惯，略低于既有的 25MB 以免与 files 路由混为一谈），单次批量上传总请求 **100MB**（复用既有总上限）。markdown 正文软上限 **512KB**（硬上限 1MB，超限拒绝并提示）。单个文档附件数上限 **10 个**。这些常量集中在 `lib/knowledge-store.ts` 顶部，便于调整。

### C. 单机场景的去重与垃圾防护

单机单用户，无需分布式算法。策略（全部在 `create`/`update` 时服务端校验）：

1. **内容哈希去重**：对「归一化后的 markdown 正文」（去首尾空白、统一换行、去 BOM）计算 `sha256`（Node `crypto`）。创建时若已存在相同 `content_hash` 且同 `category`，**直接返回已存在文档 id 并提示「内容重复」**；允许「同内容不同分类」但 UI 给出警告。哈希用全文即可（正文规模可控），不必只取前 N 字节。
2. **最小内容长度**：归一化正文非空白字符数 **< 10** 直接拒绝（空文档/无意义）。
3. **最大内容长度**：> 512KB（可配）拒绝，防膨胀。
4. **标题相似度**：用归一化标题（小写、去标点、按词/字符 n-gram 或 Levenshtein）计算相似度；与**同一分类**下现有文档相似度 **> 0.9** 时，创建/更新返回 `warning: "疑似重复标题"`，前端用 `window.confirm` 二次确认（参考 MemoryConfig 删除确认范式），确认后才落库。
5. **不可见字符拦截**：复用 `lib/hermes-memory.ts` 中 `INVISIBLE_CHARS` 检查思路（U+200B/200C/200D/202A–202E/2060/FEFF 等），命中即拒绝，防注入/隐藏内容。
6. **轻量垃圾启发**：正文「重复字符比」过高（如单字符重复 > 80%）或纯控制字符，拒绝；不做复杂 ML。
7. **导出/批量操作**：批量删除/导出前同样 `window.confirm`，并写入审计。

以上校验集中在 `lib/knowledge-dedup.ts`（纯函数，便于 `*.test.mjs` 单测，参考 `lib/bounded-form-data.test.mjs` 风格）。

### 0.5 附件 / Office / PDF 文本抽取与入库（混合策略，已确认）

**目标**：用户上传 Word / Excel / PDF 时，文档、Office、PDF 在知识库里都是**一等公民**——原件当附件可下载，抽取文本当正文入库检索。按格式分别处理（混合策略）：Word 转 Markdown 可渲染，PDF/Excel 抽纯文本可检索。

**已核实事实**：
- `mammoth@^1.12.0` **已是主项目直接依赖**（`package.json:78`，纯 JS，docx→HTML），Word 入库**零新增依赖**。
- PDF / Excel 解析库在主项目 `node_modules` **均无**（grep 过 pdf-parse / pdfjs / xlsx / exceljs / pptx 全部无命中），需新增；均用**纯 JS 库**（不碰原生编译，与 better-sqlite3 已验证思路一致，Electron 桌面首装安全）。
- 不 shell 调 LibreOffice（桌面不保证安装），走纯 JS 抽取。

**抽取分派器 `lib/knowledge-ingest.ts`（新增）**——按扩展名路由：
| 扩展名 | 抽取方式 | 产出正文形态 | 新增依赖 |
|---|---|---|---|
| `.docx` | `mammoth.convertToHtml` → `turndown` → Markdown | **Markdown（可渲染）** | `mammoth`(已装) + `turndown`(新增, 纯JS) |
| `.pdf` | `pdfjs-dist`（legacy/Node build）`getDocument→getTextContent` 抽纯文本；或 `unpdf`（更轻量，服务端友好） | 纯文本 | `pdfjs-dist` 或 `unpdf`(新增, 纯JS) |
| `.xlsx`/`.xls` | `exceljs` 逐 worksheet 读单元格 → 拼接纯文本（含 sheet 名） | 纯文本 | `exceljs`(新增, 纯JS, 维护活跃、无已知未修 CVE) |
| `.csv` | 直接读文本（可选精简） | 纯文本 | 无（Node `fs`） |
| 图片/其他 | 仅作附件存储，**不解析内容**（本地无 OCR 引擎） | — | — |

- **为什么 docx 走 markdown、pdf/xlsx 走纯文本**：`MarkdownBody` 只渲染 Markdown；Word 经 mammoth+turndown 能产出干净 Markdown，体验最佳；PDF/Excel 产出纯文本，直接以 Markdown 正文存储（渲染为纯文本块），并提供原件下载。
- **可选增强（不在本期）**：PPT 用 `pptx-parser` 抽文本；图片 OCR 需引入 `@napi-rs/canvas`+OCR 引擎（原生/重依赖），留作后续。

**两条上传/入库路径（`app/api/knowledge/`）**：
1. `POST /import` — 「以文件新建文档」：multipart 收文件 → `ingestFile()` 得 `{markdown, title, suggestedMeta}` → 走与 `POST /` 相同的 `knowledge-dedup` 校验 + 写 md + 更新 `docs`/`docs_fts` + 审计（action=`import`）；`title` 默认取文件名（去扩展名），允许前端覆盖；原始文件存为首个附件（`attachments/<docId>/<原名>`），`attachment_count=1`。
2. `POST /upload`（既有）— 「追加附件到已有文档」：`docId` 必填，文件**仅存储、不解析**（图片/补充材料），更新 `attachment_count`，审计（action=`upload`）。

**抽取文本长度封顶**：`MAX_EXTRACTED_TEXT_CHARS = 500_000`（约 500KB 文本）。超大 PDF/Excel 超出部分截断并附注「内容过长已截断，请下载原件查看」，避免 `docs.markdown`/FTS5 膨胀；原件完整保留。

**入库后一致性**：抽取文本作为文档 `markdown` 正文 → 写 markdown 真相源 → `content_hash` 取归一化正文 sha256（与其他文档统一去重）→ 索引仅重插该 doc（不必全量 `reindex`）。

---

## 1. 目录 / 文件结构（新增清单，绝对路径）

> 数据域根：`~/.pi-studio/knowledge/`（用既有 `getAgentDir()` 取得，与 `pi-hermes-memory` 平行、零重叠）。

```
~/.pi-studio/knowledge/                  # 运行时数据（不入库，属于用户数据）
  docs/<docId>.md                        # 文档真相源（frontmatter + markdown 正文）
  attachments/<docId>/<filename>         # 附件/图片（按文档隔离）
  index.sqlite                           # better-sqlite3 FTS5 检索镜像（可重建）
  audit.log                              # append-only 审计日志（JSONL）
  knowledge-config.json                  # 模块配置（大小上限、是否启用敏感确认等，可选）

D:\wwwroot\pi-studio\
  package.json                           # dependencies 增加 "better-sqlite3": "^12.9.0"（与 hermes-memory 同版本）；"turndown"（docx→md）；"pdfjs-dist" 或 "unpdf"（PDF 抽取）；"exceljs"（Excel 抽取）。注：mammoth 已装
  lib/
    knowledge-store.ts                  # 数据访问层：路径、原子读写 markdown、better-sqlite3 单例/事务/写互斥、大小常量
    knowledge-schema.ts                 # FTS5 建表 SQL + 类型定义 + 表结构常量
    knowledge-dedup.ts                  # 哈希去重/相似度/垃圾防护（纯函数）
    knowledge-ingest.ts                 # Office/PDF 文本抽取分派器（docx→md, pdf/xlsx→text）
    knowledge-audit.ts                  # 审计日志写入（append JSONL，经写互斥）
    knowledge-types.ts                  # DocMeta / Category / Tag / Author / 列表/分页/批量请求响应类型
  app/api/knowledge/
    route.ts                            # GET 列表(分页+过滤+检索) / POST 新建
    [id]/route.ts                       # GET 详情 / PUT|PATCH 更新 / DELETE 删除
    [id]/export/route.ts                # GET 单文档导出（审计）
    [id]/attachment/[name]/route.ts     # GET 附件读取（路径越界校验，供 MarkdownBody img 渲染）
    batch/route.ts                      # POST 批量（删除/打标签/移动分类）
    upload/route.ts                     # POST 附件上传（multipart, 复用 parseFormDataWithinLimit）
    meta/route.ts                       # GET 分类/标签/作者枚举（也可 POST 新建分类）
    audit/route.ts                      # GET 审计日志读取（分页）
    reindex/route.ts                    # POST 重建 FTS5（从 markdown 全量）
  components/
    KnowledgeConfig.tsx                 # 列表页（搜索框 + 左分类/标签筛选 + 右文档列表），对标 MemoryConfig
    KnowledgeDetail.tsx                 # 详情/编辑页（MarkdownBody 渲染 + react-simple-code-editor 编辑 + 敏感确认）
    KnowledgeAuditViewer.tsx            # 审计日志查看面板（可选，挂在 KnowledgeConfig 内页签）
  hooks/
    useKnowledge.ts                     # 前端数据请求封装（GET/POST/分页/批量），对标 MemoryConfig 内联 fetch
  instrumentation.ts                    # （复用现有）启动时 ensureKnowledgeDir()，自愈建目录 + 必要时 reindex
  lib/i18n/messages/zh-CN.ts, en.ts     # 新增 knowledge.* 文案（沿用现有 i18n 键约定）
```

---

## 2. 数据模型 schema

### 2.1 文档真相源（markdown 文件）
路径：`~/.pi-studio/knowledge/docs/<docId>.md`。`<docId>` 用 `randomUUID()`（复用 `crypto`）。文件结构：
```
---
id: <uuid>
title: 文档标题
category: <categoryId 或 "">
tags: ["tag-a", "tag-b"]
author: <authorName 或 "">
sensitive: false
createdAt: 2026-08-18T12:00:00.000Z
updatedAt: 2026-08-18T12:00:00.000Z
contentHash: <sha256>
attachmentCount: 0
---
<markdown 正文>
```
- 解析用既有依赖 `js-yaml`（已在 `dependencies`）+ `remark-frontmatter`（已装）。frontmatter 缺失时按默认值 + 正文兜底。
- 写盘用 `lib/hermes-memory.ts` 的 `atomicWrite` 范式（同目录 tmp + rename，避免 Windows EXDEV）。

### 2.2 分类 / 标签 / 作者
- **不单独建 JSON 文件**，而是**从文档 frontmatter 派生**：`meta` 枚举接口扫描所有 `docs/*.md` 汇总 `category / tags[] / author` 去重返回（数据量小，单机可接受；如需性能，可缓存到 `index.sqlite` 的 `meta` 表并随变更失效）。
- 分类可带显示名/颜色，可选存 `~/.pi-studio/knowledge/knowledge-config.json` 的 `categories` 映射；初版仅存 id（自由文本），UI 用中性展示。
- 新建文档时输入的分类/标签/作者若不在枚举中，自动纳入（create-on-use），无需预注册。

### 2.3 SQLite（better-sqlite3）表结构
Truth mirror（加速列表/分页，避免每页读全部 md 文件）+ FTS5 检索。建表 SQL（`lib/knowledge-schema.ts`）：

```sql
-- 权威镜像表（含 markdown 正文，便于列表/详情直读，避免频繁文件 IO）
CREATE TABLE IF NOT EXISTS docs (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT '',
  tags            TEXT NOT NULL DEFAULT '',   -- JSON 数组字符串
  author          TEXT NOT NULL DEFAULT '',
  sensitive       INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT NOT NULL,
  markdown        TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  attachment_count INTEGER NOT NULL DEFAULT 0
);

-- FTS5 检索表（standalone，doc_id 为 UNINDEXED 外键列；重建 = 清空后从 docs 重插）
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title,
  body,
  category UNINDEXED,
  tags     UNINDEXED,
  author   UNINDEXED,
  doc_id   UNINDEXED
);
CREATE INDEX IF NOT EXISTS idx_docs_category ON docs(category);
CREATE INDEX IF NOT EXISTS idx_docs_sensitive ON docs(sensitive);
```

- **为什么 standalone 而非 external-content**：docs 主键是 TEXT uuid，FTS5 external-content 要求 `content_rowid` 为整型 rowid，类型不匹配易踩坑；standalone 表把 `doc_id` 作为普通 UNINDEXED 列，简单稳健，内容略有冗余（markdown 同时在 `docs` 与 `docs_fts.body`），单机规模完全可接受。
- **重建**：`reindex` = `DELETE FROM docs; DELETE FROM docs_fts;` 后逐文件重插（doc_id 与 docs.id 一致）。
- **检索查询示例**（better-sqlite3 同步 API）：
  ```ts
  const rows = db.prepare(`
    SELECT d.* FROM docs_fts f JOIN docs d ON d.id = f.doc_id
    WHERE docs_fts MATCH @q
      AND (@category = '' OR f.category = @category)
      AND (@author   = '' OR f.author   = @author)
      AND (@tag      = '' OR f.tags LIKE '%"' || @tag || '"%')
      AND (@includeSensitive = 1 OR d.sensitive = 0)
    ORDER BY rank
    LIMIT @pageSize OFFSET (@page-1)*@pageSize
  `).all({ q, category, author, tag, includeSensitive, page, pageSize });
  ```
  （`MATCH` 用 FTS5 语法：`title:foo OR body:bar`；UNINDEXED 列用普通 `=`/LIKE 过滤。`LIKE` 匹配 JSON 数组中的 `"tag"` 形式。）

---

## 3. API route 清单与签名

统一范式：返回 `{error, code}` / `{success, data}`（参考 `app/api/memory/route.ts` 与既有约定）；`export const dynamic = "force-dynamic"`。所有写/删/导出/读操作经 `knowledge-audit.ts` 写审计。分页参数 `page`（从 1 起）与 `pageSize`（默认 20，上限 100）。

| 方法 | 路径 | 作用 | 关键参数 / 响应 |
|---|---|---|---|
| GET | `/api/knowledge` | 列表 + 分页 + 过滤 + 检索 | `?page&pageSize&q&category&tag&author&sensitive(0\|1)&sort(updated\|created\|title)` → `{items: DocMeta[], total, page, pageSize}`；读操作写审计（action=`list`） |
| POST | `/api/knowledge` | 新建文档 | body `{title, category, tags[], author, sensitive, markdown}` → 经 `knowledge-dedup` 校验（哈希/长度/相似度/不可见字符）→ 写 md + 更新 `docs`/`docs_fts` → 审计（action=`create`）；重复返回 `{success:false, code:"DUP", existingId}` |
| GET | `/api/knowledge/[id]` | 详情 | → `DocMeta & {markdown, attachments[]}`；审计（action=`read`） |
| PUT/PATCH | `/api/knowledge/[id]` | 更新 | body 同新建（部分字段）；重算 `content_hash`/`updated_at`；审计（action=`update`） |
| DELETE | `/api/knowledge/[id]` | 删除 | 删 md + 附件目录 + `docs`/`docs_fts` 行；审计（action=`delete`）；前端 `window.confirm` |
| GET | `/api/knowledge/[id]/export` | 单文档导出 | 返回 `.md` 下载（`type=download`）或 zip（含附件）；审计（action=`export`） |
| GET | `/api/knowledge/[id]/attachment/[name]` | 附件读取 | 路径越界校验（仅限 `~/.pi-studio/knowledge/attachments/<docId>/`），供 MarkdownBody 的 `img` 渲染；审计（action=`read_attachment`，可选） |
| POST | `/api/knowledge/batch` | 批量操作 | body `{ids:[], op:"delete"\|"tag"\|"setCategory"\|"export", payload?}`；逐条执行 + 审计（action=`batch`）；前端 `window.confirm` |
| POST | `/api/knowledge/import` | 以文件新建文档 | `multipart/form-data` 单文件；`ingestFile()` 抽文本（docx→md / pdf·xlsx→text）→ 复用 `POST /` 校验+落库+索引+审计（action=`import`）；`title` 默认文件名；原件存为首附件 |
| POST | `/api/knowledge/upload` | 附件上传 | `multipart/form-data`，字段 `docId` + `files[]`；复用 `parseFormDataWithinLimit(req, MAX_KB_UPLOAD_REQUEST_BYTES)` + `validateUploadFileNames`；落 `~/.pi-studio/knowledge/attachments/<docId>/<filename>`（冲突策略 `error`）；文件**仅存储不解析**；更新 `attachment_count`；审计（action=`upload`） |
| GET | `/api/knowledge/meta` | 枚举 | → `{categories:[], tags:[], authors:[]}`（派生自 docs）；GET 列表时可选并行调用 |
| POST | `/api/knowledge/meta` | 新建分类 | body `{type:"category", name}`（可选）；返回归一化 id |
| GET | `/api/knowledge/audit` | 读审计 | `?page&pageSize&action?` → 分页返回审计行（只读，不写审计，避免循环） |
| POST | `/api/knowledge/reindex` | 重建索引 | 从 `docs/*.md` 全量重建 `docs`+`docs_fts`；审计（action=`reindex`）；幂等 |

---

## 4. 前端：列表页 + 详情页设计

**入口挂载（AppShell）**：参考 MemoryConfig 被 `SettingsDialog` 以 `embedded` 模式嵌入的范式，但知识库是**一级功能**，建议在 AppShell 顶栏/侧栏增加一个「知识库」按钮（对标 memory 入口），点击打开 `KnowledgeConfig` 模态（用其**非 embedded** 全屏模态形态，参考 MemoryConfig 的 `position:fixed` 覆盖层）。状态用 `useState` 控制 `knowledgeOpen`，与现有 `useState`/`useCallback` 风格一致，**不引入 zustand/redux**。

**`KnowledgeConfig.tsx`（列表页，对标 MemoryConfig）**：
- 布局复用 MemoryConfig 的「左筛选 + 右列表」双栏：左侧为分类/标签/作者筛选 + 搜索框（`?q`）；右侧为文档卡片列表（标题、分类标签、sensitive 红色徽标、created/updated 时间、`attachment_count`）。
- 顶部工具条：搜索输入、`刷新`、`新建`、`批量操作`（多选 + 删除/打标签/导出，用 `window.confirm`）、`重建索引`、可选「审计日志」页签（嵌 `KnowledgeAuditViewer`）。
- 数据请求封装到 `hooks/useKnowledge.ts`（`fetch(/api/knowledge?...)` + 分页 + 加载/错误态），对标 MemoryConfig 内联 `load`/`mutate` 回调；分页用「加载更多」或页码控件（预留 `page/pageSize`）。
- 新建/编辑走 `KnowledgeDetail` 模态或右侧抽屉；批量 `POST /batch`。

**`KnowledgeDetail.tsx`（详情/编辑页）**：
- 渲染：**复用 `components/MarkdownBody.tsx`**（`react-markdown@10 + remark-gfm + rehype-katex/raw/sanitize` 已就绪），传入 `markdown` 正文即可，零新增渲染依赖。图片经 `/api/knowledge/[id]/attachment/[name]` 渲染。
- 编辑：轻量编辑器用既有依赖 **`react-simple-code-editor`**（已在 `dependencies`，`0.14.1`）做 Markdown 源码编辑（带语法高亮可选），**不引入 tiptap/quill**。查看/编辑切换，保存 `PUT`。
- 敏感内容：`sensitive=true` 时顶部红色横幅「敏感内容」，首次打开需 `window.confirm("确认查看敏感文档？")` 后才渲染正文（单机无 RBAC，此为软权限校验 + 审计）；任何查看/导出都写审计。
- 附件：列表展示 + 上传按钮（`POST /upload`，复用 `parseFormDataWithinLimit` 客户端需在请求前做大小预检）；图片在 MarkdownBody 中经附件 route 渲染。

**i18n**：在 `lib/i18n/messages/{zh-CN,en}.ts` 增 `knowledge.*` 键，沿用现有 `t("knowledge.title")` 调用风格。

---

## 5. 审计日志格式与写入点

**文件**：`~/.pi-studio/knowledge/audit.log`（JSONL，append-only，每行一条）。

**行格式**：
```json
{"ts":"2026-08-18T12:00:00.000Z","action":"read|create|update|delete|export|list|batch|upload|reindex","docId":"<uuid|null>","actor":"local","detail":{ "ip":null, "q":null, "category":null, "tag":null, "bytes":null, "count":null }, "ok":true,"error":null}
```
- `action` 取值覆盖第 3 节所有操作；批量操作 `detail.count` 记录影响条数；上传 `detail.bytes` 记录大小；检索 `detail.q/category/tag`。
- **写入点**：所有 API route 在成功/失败后调用 `knowledge-audit.ts` 的 `appendAudit(entry)`。**读取（GET 详情/list/search）、写入（POST/PUT）、删除（DELETE）、导出、上传、reindex** 全部记录；`/api/knowledge/audit` 自身只读、**不写**审计（防递归）。
- **并发安全**：审计写入与 DB 变更共用同一进程内异步写互斥（Promise 链串行化），保证 JSONL 行完整、不交错；用 `fs.appendFile` 经互斥串行化（单行 < 几 KB，POSIX 原子，Windows 单进程亦安全）。

---

## 6. 去重 / 垃圾防护 / 大小限制 具体参数（集中 `lib/knowledge-store.ts` 顶部常量）

| 项 | 值 | 说明 |
|---|---|---|
| `MAX_DOC_MARKDOWN_BYTES` | 512KB（硬 1MB） | markdown 正文上限，超限拒绝 |
| `MAX_ATTACHMENT_FILE_BYTES` | 20MB | 单附件上限（贴合用户既有 20MB 习惯） |
| `MAX_KB_UPLOAD_REQUEST_BYTES` | 100MB + 1MB | 复用 files 路由总上限 |
| `MAX_ATTACHMENTS_PER_DOC` | 10 | 单文档附件数上限 |
| `MIN_CONTENT_CHARS` | 10 | 归一化正文非空白 < 10 拒绝 |
| `DEDUP_HASH_ALGO` | sha256（全文归一化） | 相同 hash + 同分类 → 拒绝（返回 existingId） |
| `TITLE_SIMILARITY_THRESHOLD` | 0.9 | 同分类标题相似度 > 0.9 → 警告 + `window.confirm` |
| `INVISIBLE_CHARS_REJECT` | 同 hermes-memory | 命中不可见 Unicode 拒绝 |
| `SPAM_REPEAT_CHAR_RATIO` | 0.8 | 单字符重复比过高拒绝 |
| `MAX_EXTRACTED_TEXT_CHARS` | 500_000 | 抽取文本（PDF/Excel）封顶，超出截断并附注，避免 FTS5/正文膨胀 |

---

## 7. 实施风险与待验证项

1. **【低·已证伪原生风险】better-sqlite3 首装**：hermes-memory@0.9.6 已用 `better-sqlite3@12.9.0` 且在本环境跑通，证明预编译/构建链可用。仍建议在 Phase 0 实测一次：主项目加同版本依赖后，`first-run-install.mjs` 首装成功且 `require('better-sqlite3')` 能 `new Database()`。若个别平台失败，回退 sql.js（WASM，见 A 备选）。
2. **【中】FTS5 中文分词召回率**：FTS5 默认按空白/标点分词、中文无词边界，全文检索可能漏召回。Phase 0 即做实测：插入若干中文文档、用 `MATCH '关键词'` 验证召回；必要时加 `fts5` `trigram` 子表（对 `LIKE '%词%'` 友好）或 bigram 预处理索引列。
3. **【中】并发与原子**：better-sqlite3 单连接同步，变更用 `db.transaction()` 包裹；再叠加进程内写互斥保证请求级串行。需单测覆盖「写-崩-重加载」一致性（better-sqlite3 自带 WAL 应已保证，验证即可）。
4. **【中】附件 route 与文件闸门**：`/api/files` 的 `allowedFileRoots` 不覆盖 `~/.pi-studio`，需新建 knowledge 域内附件读取 route 并做路径越界校验（复用 `lib/path-security.ts` 的 `isPathWithinRoots`，限定根 `~/.pi-studio/knowledge/attachments`）。
5. **【中】Office/PDF 抽取在 Electron/Node 服务端的可行性**：`pdfjs-dist` 在 Node 需 legacy build（无 DOM），`unpdf` 更省心；`exceljs` 纯 JS 通常无碍；`turndown` 纯 JS 安全。需在 Phase 3 实测：以真实 `.docx`/`.pdf`/`.xlsx` 各一个样例验证抽取文本质量与中文正确性，确认 `first-run-install.mjs` 能装齐这些纯 JS 依赖。
6. **【低】首装体积**：better-sqlite3 预编译二进制体积可控，对首次安装影响可忽略（与 hermes-memory 同量级）。
7. **【低】i18n 与既有 UX 一致性**：KnowledgeConfig 需对齐 MemoryConfig 的按钮样式（`primaryButtonStyle`/`secondaryButtonStyle`）、notice 自动消失等既有范式。

---

## 8. 实施阶段拆分

**Phase 0 — 基建与决策落地**
- 主项目 `package.json` 增加 `better-sqlite3@^12.9.0`；写 `lib/knowledge-schema.ts`、`lib/knowledge-store.ts`（`getAgentDir` 路径、better-sqlite3 单例、事务、写互斥、`PRAGMA`）。
- `instrumentation.ts` 启动 `ensureKnowledgeDir()` + 自愈 reindex。
- 验证 better-sqlite3 加载 + FTS5 中文召回率实测（风险 1、2）。

**Phase 1 — 数据模型与 CRUD API**
- `lib/knowledge-types.ts`、`knowledge-dedup.ts`（哈希/相似度/垃圾防护，附 `*.test.mjs`）。
- `app/api/knowledge/route.ts`（GET 列表分页 + POST 新建）、`[id]/route.ts`（GET/PUT/DELETE）。
- markdown 真相源读写（frontmatter + atomicWrite）。

**Phase 2 — 全文检索 + 过滤 + 重建**
- `docs_fts` FTS5 建表与写入同步；`GET ?q&category&tag&author` 检索；`reindex` route。
- `meta` 枚举 route（分类/标签/作者）。

**Phase 3 — 附件、Office/PDF 抽取与上传**
- `lib/knowledge-ingest.ts`（docx→md via mammoth+turndown、pdf/xlsx→text via pdfjs-dist/exceljs），`POST /import` 以文件新建文档。
- `upload` route（复用 `parseFormDataWithinLimit` + `validateUploadFileNames`）、附件读取 route + 路径校验，详情页图片渲染对接 `MarkdownBody`。
- 实测抽取质量（风险 5）。

**Phase 4 — 审计日志**
- `knowledge-audit.ts` 写互斥 + JSONL；所有 API 写入点接入；`audit` 读取 route + `KnowledgeAuditViewer`。

**Phase 5 — 前端界面**
- `KnowledgeConfig.tsx`（列表/搜索/筛选/批量）、`KnowledgeDetail.tsx`（MarkdownBody 渲染 + react-simple-code-editor 编辑 + 敏感确认）、`useKnowledge.ts`、`AppShell` 入口按钮、i18n 文案。

**Phase 6 — 批量 / 导出 / 收尾**
- `batch` route（删除/打标签/移动分类/导出）、单文档与批量导出、全量冒烟测试、electron-builder 打包实测（首装含 better-sqlite3 落地）。

---

## 关键复用清单（避免重复造轮子）
- **SQLite 实现**：复用与 hermes-memory 同版本的 `better-sqlite3@^12.9.0`（原生模块，本环境已验证），知识库用独立 DB 文件 `~/.pi-studio/knowledge/index.sqlite`
- 原子写：`lib/atomic-file.ts` / `lib/hermes-memory.ts` 的 `atomicWrite` 范式
- 上传限流：`lib/bounded-form-data.ts` 的 `parseFormDataWithinLimit` + `RequestBodyTooLargeError`
- 文件名校验：`lib/file-upload.ts` 的 `validateUploadFileNames`
- Markdown 渲染：`components/MarkdownBody.tsx`（react-markdown@10 + remark-gfm + rehype-katex/raw/sanitize）
- 轻量编辑器：`react-simple-code-editor`（已装，0.14.1）
- 不可见字符拦截：`lib/hermes-memory.ts` 的 `INVISIBLE_CHARS` 思路
- 列表/详情 UX 范式：`components/MemoryConfig.tsx`（左筛选 + 右列表、批量 `window.confirm`、按钮样式）
- 路径安全：`lib/path-security.ts` 的 `isPathWithinRoots`（附件越界校验）
- Office/PDF 抽取：`mammoth`(已装, docx→HTML) + `turndown`(docx→md) / `pdfjs-dist` 或 `unpdf`(PDF) / `exceljs`(Excel)，均纯 JS、无原生编译
- i18n：`hooks/useI18n` + `lib/i18n/messages/*`
