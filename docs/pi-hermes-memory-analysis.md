# pi-hermes-memory 记忆存储机制结构化梳理

> 分析对象：`pi-hermes-memory@0.9.4`（源码位于 `~/.pi-studio/npm/node_modules/pi-hermes-memory`）
> 实测数据目录：`~/.pi-studio`（本机 pi-studio 注入 `PI_CODING_AGENT_DIR=~/.pi-studio`，故路径落在 `~/.pi-studio` 而非 README 写的 `~/.pi/agent`）
> 方法：通读 `src/store/*`、`src/tools/*`、`src/index.ts`、`src/config.ts`、`src/constants.ts`、`src/project.ts`，并实际打开 `sessions.db` 与 `.pi-hermes-locks.sqlite` 核对

---

## 0. 核心架构：双轨 + 派生镜像

```
           权威源 (Source of Truth)              可检索/派生 (Search Mirror)
  ┌──────────────────────────────────┐    ┌──────────────────────────────────┐
  │ MEMORY.md / USER.md / failures.md │    │ sessions.db :: memories 表        │
  │ STANDING.md                       │──▶ │   + memory_fts (FTS5)             │
  │ projects-memory/<proj>/MEMORY.md  │    │ （由 markdown mutation 监听驱动   │
  │ skills/<slug>/SKILL.md            │    │  reconcile，幂等 upsert）          │
  └──────────────────────────────────┘    └──────────────────────────────────┘
                  │                                      │
                  │ session_start / message_end          │ 同库另含
                  ▼                                      ▼
           冻结 snapshot 注入 prompt              sessions / session_files / messages
                                                + message_fts（历史会话检索）
```

关键结论：**markdown 是权威源，SQLite `memories` 表是其可重建的检索镜像**。UI 可视化若只查 SQLite 会漏掉未 sync 的 markdown 内容（见 §4 风险）。

---

## 1. 记忆类型

按作用域 / 结构 / 生命周期三维划分：

| # | 类型 | 作用域 | 结构 | 落地介质 | 生命周期 / 容量 |
|---|------|--------|------|----------|----------------|
| 1 | **MEMORY.md**（agent 笔记） | 全局 | § 分隔纯文本条目，每条带 HTML 注释元数据 | markdown 文件 | 跨会话持久；默认 5000 字符 |
| 2 | **USER.md**（用户画像） | 全局 | 同上 | markdown 文件 | 跨会话持久；5000 字符 |
| 3 | **failures.md**（失败/教训） | 全局 | `[category] 文本 — Failed: … — Tool state: … — Corrected to: …` | markdown 文件 | 跨会话持久；10000 字符（memoryCharLimit×2）；最近 7 天/≤5 条注入 prompt |
| 4 | **project MEMORY.md** | 项目级 | 同 #1，但 `project` 字段=项目名 | markdown 文件（`projects-memory/<proj>/`） | 跨会话持久；projectCharLimit=5000 |
| 5 | **STANDING.md**（站立指令） | 全局/用户手写 | 一行一条指令 | markdown 文件 | 始终注入 prompt；硬上限 20 条 / 2000 字符；仅用户或 `/memory-pin` 写 |
| 6 | **SQLite `memories` 镜像** | 全局/项目 | 结构化字段 + FTS5 | SQLite | 派生；由 markdown 变更驱动；当前实测 0 行 |
| 7 | **会话索引**（`sessions`/`messages`） | 全局 | 行式 + FTS5 | SQLite | 增量索引；非"记忆"语义但同库；实测 1 session / 1 message |
| 8 | **技能 SKILL.md** | 全局/项目 | YAML frontmatter + body | markdown 文件 | 跨会话持久；程序化/流程记忆 |
| 9 | **进程内缓存** | — | `entries[]` 数组 + frozen snapshot | 内存 | 仅本会话；prompt 注入用 |

**category 枚举**（仅 failure 镜像/失败条目使用）：`failure` / `correction` / `insight` / `preference` / `convention` / `tool-quirk`

**作用域细节（实测代码）**：
- `memory_add target=project` → 写入 `projects-memory/<proj>/MEMORY.md`；
- `target=failure` / `user` 始终落到**全局**文件；SQLite 镜像里 `failure` 的 `project` 字段恒为 `NULL`（见 `memory-tool.ts` `sqliteProjectFor`）；
- 项目名 = git 仓库根目录 basename（无 git 则用 cwd basename）；本机为 `pi-studio`。

---

## 2. 存储介质与目录结构 / 表结构

### 2.1 目录结构（实测 `~/.pi-studio`）

```
~/.pi-studio/
├─ pi-hermes-memory/
│  ├─ MEMORY.md              # 全局笔记（当前不存在→空）
│  ├─ USER.md                # 用户画像（当前不存在）
│  ├─ failures.md            # 失败记忆（当前不存在）
│  ├─ STANDING.md            # 站立指令（当前不存在）
│  ├─ sessions.db            # 主 SQLite（含 memories/sessions/messages）
│  ├─ sessions.db-wal        # WAL 侧车（journal_mode=WAL）
│  ├─ sessions.db-shm
│  ├─ .skills-migrated-to-extension-storage   # 技能迁移哨兵
│  └─ skills/<slug>/SKILL.md                 # 全局技能
├─ projects-memory/
│  └─ pi-studio/             # 项目名=pi-studio
│     ├─ MEMORY.md           # 项目笔记（当前不存在）
│     └─ skills/<slug>/SKILL.md              # 项目技能
├─ skills/                   # Pi 自身全局技能根（本扩展只读，用于拒绝 shadow 写）
├─ .pi-hermes-locks.sqlite   # 锁库（markdown 突变锁 + 恢复锁）
├─ .pi-hermes-locks.sqlite-wal / -shm
└─ hermes-memory-config.json # 配置文件（当前不存在→用 DEFAULT_CONFIG）
```

### 2.2 配置（JSON，可选）

路径 `~/.pi-studio/hermes-memory-config.json`；不存在则用 `config.ts` 的 `DEFAULT_CONFIG`。关键可读字段：

`memoryMode`(policy-only|legacy-inject)、`memoryCharLimit`(5000)、`userCharLimit`(5000)、`projectCharLimit`(5000)、`nudgeInterval`(10)、`flushOnCompact`/`flushOnShutdown`(true)、`memoryOverflowStrategy`(auto-consolidate|reject|fifo-evict)、`correctionDetection`(true)、`failureInjectionEnabled`(true)、`failureInjectionMaxAgeDays`(7)、`failureInjectionMaxEntries`(5)、`standingInstructionsEnabled`(true)、`sessionSearch.variant`(legacy|anchors)、`memoryDir`、`projectsMemoryDir`(projects-memory)。

### 2.3 主库 `sessions.db` 表结构

**`memories`**（扩展记忆镜像 + FTS5）

| 字段 | 类型 | 约束 / 说明 |
|------|------|-------------|
| id | INTEGER | PK AUTOINCREMENT |
| project | TEXT | 项目名；全局记忆为 NULL |
| target | TEXT | NOT NULL, CHECK IN ('memory','user','failure') |
| category | TEXT | CHECK IN (6 类) 或 NULL |
| content | TEXT | NOT NULL |
| failure_reason | TEXT | 失败原因 |
| tool_state | TEXT | 工具状态 |
| corrected_to | TEXT | 修正后内容 |
| created | DATE | NOT NULL |
| last_referenced | DATE | NOT NULL |

索引：`idx_memories_project` / `idx_memories_target` / `idx_memories_category`。
FTS：`memory_fts`（`content='memories', content_rowid='id'`，外部内容表，不重复存；由 `memories_ai/ad/au` 三个触发器同步）。

**`sessions`**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | PK |
| project | TEXT | 项目名 |
| cwd | TEXT | 工作目录 |
| started_at | TEXT | 开始时间 |
| ended_at | TEXT | 结束时间（可空） |
| message_count | INTEGER | 消息数 |

索引：`idx_sessions_project` / `idx_sessions_started_at`。

**`session_files`**：`path`(PK) / `session_id`(FK) / `size` / `mtime_ms` / `indexed_at`（增量 backfill 用）。
**`messages`**：`id`(PK) / `session_id`(FK) / `role`(CHECK user|assistant|system) / `content` / `timestamp` / `tool_calls`。
索引：`idx_messages_session_id` / `idx_messages_timestamp`。FTS：`message_fts`（同结构）。
**`extension_metadata`**：`key`(PK) / `value`（键值元数据）。

### 2.4 锁库 `.pi-hermes-locks.sqlite` 表结构

**`locks`**

| 字段 | 类型 | 说明 |
|------|------|------|
| lock_key | TEXT | PK（如 `mutation:<canonical-path>`、`recovery:<dbPath>`） |
| token | TEXT | 租约令牌（防误抢） |
| pid | INTEGER | 持有进程 |
| incarnation | TEXT | 进程启动时间戳（用于识别 stale） |
| acquired_at | INTEGER | 获取时间（ms） |

`PRAGMA busy_timeout=5000; journal_mode=WAL`。markdown 突变锁：等待 5s、stale 300s；恢复锁用于损坏自修复。

---

## 3. 数据流

### 写入
```
memory_add/replace/remove 工具
  → MemoryStore 对应 markdown 文件
      · content-scanner 扫描（防密钥注入）
      · temp 文件 + fs.rename 原子写
      · 指纹比对防止外部并发覆盖（ExternalMemoryWriteConflict 重试）
  → mutation observer（setMutationObserver）触发 reconcileStoreScope
      → sqlite-memory-store.reconcileMarkdownMemoryScope / syncMemoryEntry
        · 按 (project+target+category+content) 幂等 upsert
        · 孤儿行在事务内删除（reconcileMarkdownMemoryScope 用 db.transaction）
  → FIFO 满时 evict → removeExactSyncedMemories 同步删镜像
```
- `failure` 走 `addFailure` → `failures.md` + `memories(target='failure')`。
- 配置 `memoryOverflowStrategy=auto-consolidate` 满时启动子 agent（pi -p）合并 markdown，再触发重新 reconcile。

### 检索
- **prompt 注入**：`session_start` 后 `formatForSystemPrompt()` 取冻结 snapshot（MEMORY/USER）+ 最近 7 天失败条（≤5）注入；STANDING 始终注入。
- **搜索**：`memory_search` 工具 → `searchMemories()`（FTS5 over `memory_fts`，支持 project/target/category/limit）；`session_search` → FTS5 over `message_fts`。
- **统计**：`getMemoryStats()`（total / byProject / byTarget）。

### 更新 / 清理
- 更新：`memory_replace`（markdown 子串匹配）+ 镜像 `replaceSyncedMemories`（LIKE 匹配）。
- 清理：容量超限制 → reject / auto-consolidate / fifo-evict；合并时删除 30 天未引用条目；recovery 文件（`.recovery-*`/`.retired-*`/`.conflict-*`）按年龄/数量/大小 pruning。

### 关联关系
- markdown（权威）⇄ SQLite `memories`（镜像）：单向衍生，可经 `/memory-sync-markdown` 全量重建。
- `sessions`/`messages` 与 `memories` 同库但**无外键关联**（`memories` 不引用 session）。
- 技能（SKILL.md 文件树）与记忆**完全独立**。
- STANDING.md 写路径**不经过** MemoryStore（任何 review/consolidation/纠错都不写它）。

---

## 4. 可读取接口

### 4.1 LLM 工具（运行时注册）
- 写：`memory_add` / `memory_replace` / `memory_remove`（参数 `target`∈memory|user|project|failure）
- 读：`memory_search`（query, project, target, category, limit≤20）、`session_search`
- 技能：`skill_manage`（list/view/create/patch/update/delete/move）

### 4.2 斜杠命令
`/memory-insights`、`/memory-skills`、`/memory-consolidate`、`/memory-interview`、`/memory-switch-project`、`/memory-sync-markdown`、`/memory-preview-context`、`/memory-pin`、`/memory-index-sessions`

### 4.3 程序化读取（设置界面可复用，代码层导出）
- `MemoryStore`：`getMemoryEntries()` / `getUserEntries()` / `getAllFailureEntries()` / `getRawEntriesForSync(target)` / `formatForSystemPrompt()` / `formatProjectBlock(name)`
- `DatabaseManager.getStats()`；`sqlite-memory-store`：`getMemories({project,target,category})` / `getMemoryStats()` / `searchMemories()` / `getRecentFailures()`
- `StandingInstructions.list()` / `render()`
- `SkillStore.loadIndex(scope)` / `loadSkill(id)`
- **直接 SQL**：`better-sqlite3` 以 `readonly` 打开 `sessions.db`（已实测可行，WAL + busy_timeout=5000）

### 4.4 可修改项
- markdown 文件：可改，但必须 Mimic 原子写 + 触发 reconcile（否则镜像陈旧）。
- SQLite `memories`：可改，但为派生镜像，下次 markdown 变更会被覆盖；直接 UPDATE/DELETE 会正确触发 `memory_fts` 触发器。
- `sessions`/`messages`：建议只读。

---

## 5. 可视化「设置界面展示记忆数据」评估

### 5.1 各类记忆的可视化字段与形式

| 记忆 | 推荐字段 | 呈现形式 |
|------|----------|----------|
| MEMORY.md / USER.md | content、created、last_referenced | 分组卡片列表（按 target）；可按 `last_referenced` 排序 |
| failures.md | category、`[cat] text`、failure_reason、created | 标签 + **时间线**（按 created/last，最近 7 天高亮） |
| SQLite `memories` 镜像 | id、target、category、project、content(截断)、created、last_referenced | 可筛选**表格**（target/category/project 下拉） |
| STANDING.md | 指令文本、序号 | 编号列表 + **预算条**（条数/字符占用，上限 20/2000） |
| 技能 | scope、name、description、version、created、updated、sections | **树形**（global/project → skill 卡片） |
| 会话索引 | project、started_at、message_count | 时间线 / 列表，drill 到 message 搜索 |
| 配置 | 各开关/阈值 | 表单 / 开关 |

### 5.2 读取接口与查询方式
- **首选**：复用插件导出函数（`MemoryStore`/`SkillStore`/`sqlite-memory-store`/`DatabaseManager`）。它们在 pi-studio 内以 `.ts` 直接加载；设置界面若在同一进程可直接 import。
- **最稳健兜底**：只读 SQL 打开 `sessions.db` + `fs` 读 markdown（实测可行）。markdown 解析：按 `§`（即 `\n§\n`）切分；元数据在 `<!-- created=.., last=.., project64=.. -->`；STANDING 按行解析（忽略 `#` 注释、`-`/`*` 前缀）。
- 锁库一般无需展示；如展示仅只读 `locks` 表看当前持有者。

### 5.3 性能与并发（SQLite 锁）注意
- `better-sqlite3` 同步、单连接、单 writer；`busy_timeout=5000ms`、`journal_mode=WAL`。
- **WAL 下读者不受写者阻塞**（读一致快照），但写者之间互斥；设置界面用**独立只读连接**安全，仅在插件写入瞬间短暂等待（≤5s）。
- 多进程：AgentSession（主进程）、consolidation 子进程（pi -p）各自开连接，均通过 `.pi-hermes-locks.sqlite` 协调 markdown 锁；SQLite 自身靠 WAL+busy_timeout。
- 建议：UI 只读连接设小 `busy_timeout`、不长期持有事务、查询加 `LIMIT`；避免对 `sessions.db` 发起写事务（会与 `session_shutdown` 的 `dbManager.close()` 顺序冲突——该 close 是最后的 DB 操作）。

### 5.4 增删改支持与风险
- **读取**：完全支持（list/search/stats）。
- **写入入口**：
  - 安全路径：经插件工具/命令改（保证 markdown↔镜像一致、content-scanner 防注入、锁保护）。
  - UI 直编风险：
    1. **镜像不一致（主要风险）**：直接改 markdown 后若不触发 reconcile，SQLite 搜索结果陈旧；直接改 `memories` 会被下次 markdown 变更覆盖。
    2. **并发覆盖**：直编 markdown 必须复用 `.pi-hermes-locks.sqlite` 的 mutation 锁 + 原子写（temp+rename），否则与 agent 互相覆盖（见 `memory-store.ts` 的冲突恢复逻辑）。
    3. **密钥泄露**：所有写本应过 `scanContent` 拒绝含密钥内容；UI 直写若不复用会绕过此防护。
- **建议架构**：UI = 只读可视化 + 「通过插件 action 发起写」的入口；不直接动 SQLite 镜像；如要直编 markdown，必须走同一 mutation 锁 + 写后调用 `/memory-sync-markdown` 或 `reconcileMarkdownMemoryScope`。

### 5.5 一个关键陷阱
`memories` 镜像当前为 **0 行**（实测），而 markdown 文件尚不存在。即：**在用户首次 `memory_add` 或运行 `/memory-sync-markdown` 之前，SQLite 镜像为空**。因此「记忆概览」视图应以 **markdown 文件为权威源**展示，「搜索/聚合统计」才依赖 SQLite。

---

## 附：实测数据库快照（`~/.pi-studio/pi-hermes-memory/sessions.db`）
- tables：extension_metadata(1)、sessions(1)、session_files(1)、messages(1)、memories(0)、memory_fts*、message_fts*、sqlite_sequence
- 已索引会话：`D:\wwwroot\pi-studio`（started 2026-08-14），1 条 user 消息
- journal_mode = wal
- 锁库 `.pi-hermes-locks.sqlite` 仅 `locks` 表
