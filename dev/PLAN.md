# 从 Codex 继续（resume-codex）— 插件设计与实施计划

状态：规划稿（未开始编码）
日期：2026-11-21
目标位置：新建会话页，工作区 / 模式选择器所在那一行的红框处

---

## 1. 目标与非目标

**目标**

在 DSH 新建会话页加入「从 Codex 继续」入口。点开后选择一个本机 Codex 会话，插件完成三件事：

1. 把 Codex 原会话的上下文（对话文本、可选工具调用、Codex 压缩摘要）写成 DSH 会话历史；
2. 把 Codex 会话的工作目录（`cwd`）登记为 DSH 工作区，并让新会话使用该目录；
3. 导入完成后自动打开新会话，用户直接接着聊。

**非目标**

- 不调用 `codex` CLI，不消耗 Codex 额度，不做双向同步；
- 不修改 `~/.codex` 下任何文件（只读）；
- 不导入图片 / 附件二进制（文本占位）；
- 不做 Codex 会话的删除、归档、重命名。

---

## 2. 可行性结论（已在当前安装上验证）

| 事项 | 结论 | 证据 |
|---|---|---|
| 按钮位置 | 红框那一行就是 `conversation.hero.options` 槽位（list / scope=session） | `Slots.listSubTree` 实时查询；purpose 写着 "Compact options right-aligned in the New Session row after the workspace and preset controls" |
| 该槽位的布局 | `heroOptions { margin-left: auto }`，即选项组右对齐到这一行最右端 | `dsh-client-ui-conversation` 的 `ConversationRoot.module.css` |
| Codex 数据 | `%CODEX_HOME%`（默认 `~/.codex`）下 `sessions/YYYY/MM/DD/rollout-*.jsonl`；本机共 28 个会话 | 目录扫描 |
| Codex 会话元信息 | 首行 `session_meta.payload.cwd`（工作目录）、`id`、`forked_from_id`、时间戳；`turn_context.payload.model` | 抽样解析 |
| Codex 对话内容 | `response_item.payload.type = message`（role: user / assistant / developer）；`function_call` / `custom_tool_call` 及对应 output | 抽样解析 |
| Codex 压缩摘要 | `compacted` 事件里 `replacement_history` 的 `compaction` 项是 `ccswitch-compaction-v1:` + base64，解码后是完整中文摘要（样例 15 KB） | 解码验证 |
| DSH 写入历史会话 | 官方「DeepSeek 会话导入」插件用 `sessionPersistence.create` + `Session.create` 校验 + `workspace.attachSession` 写种子事件，客户端 `sessions.refresh()` 后会话可见 | `@deepseek-ai/dsh-deepseek-chat-import` 源码 |
| 打开并继续 | 客户端 `ctx.uiWorkspace.openSession(sessionId)`；会话带历史打开后即可继续对话 | 客户端 Service 契约 `uiWorkspace` / `sessions` |
| 安装方式 | `plugin_manager install_bundle`（本地目录 link 安装），danger-full-access 下无需审批；本机已有同类先例 `@local/dsh-chaoxian-preset` | `list_bundles` + 现有 profile |

**一个必须说明的取舍**：按 DSH 的布局，该槽位的条目会被推到这一行最右端，不会紧贴「创造模式」右侧。若要求紧贴，只能改 DSH 源码或做脆弱的 DOM 定位，不建议。

---

## 3. 总体架构

单包 bundle，Host 与 Client 两半，无需构建（纯 ESM / 浏览器模块）。

```
┌──────────────────────────── Client（Web） ────────────────────────────┐
│ conversation.hero.options 槽位                                        │
│   <中控按钮 "从 Codex 继续">                                          │
│         │ 点击                                                         │
│         ▼                                                              │
│   <dialog> 选择器：搜索 / 当前工作区过滤 / 列表 / 导入选项 / 进度       │
│         │ fetch('/api/resume-codex/...')                              │
└─────────┼──────────────────────────────────────────────────────────────┘
          │ 同源、owner 认证（connection.fetch）
┌─────────▼──────────────────────── Host ────────────────────────────────┐
│ GET  /api/resume-codex/sessions   扫描 + 解析 + 缓存列表                │
│ POST /api/resume-codex/import     { path, mode, includeTools, ... }    │
│        │                                                               │
│        ├─ codex scanner：读 rollout-*.jsonl（流式逐行）                 │
│        ├─ converter：Codex item → DSH SessionEvent（含预算裁剪）        │
│        ├─ Session.create(id, events, header)  ← 种子校验，失败即不动盘  │
│        ├─ sessionPersistence.create / append / flush / close           │
│        ├─ projectionCache.coldSnapshot(...)（可选）                     │
│        └─ workspaceRegistry.create(cwd) → workspace.attachSession(id)  │
└────────────────────────────────────────────────────────────────────────┘
```

**为什么用 HTTP 路由而不是 Typert Remote**：官方插件用了生成式 Remote，需要部署侧构建产物；用 `connection.fetch.register` + 同源 `fetch` 可以零构建、同样走 owner 认证，上传型插件已有先例。

---

## 4. HTTP 接口

### `GET /api/resume-codex/sessions`

返回：

```jsonc
{
  "codexHome": "C:\\Users\\lycohana\\.codex",
  "sessions": [{
    "path": "...\\2026\\11\\19\\rollout-....jsonl",
    "id": "01a1f38b-...",
    "title": "首条用户消息截断",
    "cwd": "D:\\desktop\\code\\AI-_-",
    "createdAt": 1794996341710,
    "updatedAt": 1795100000000,       // 文件 mtime
    "turns": 12,                       // 用户消息条数（轻量估算）
    "model": "gpt-6.2-astra",
    "forkedFrom": null,
    "hasCompaction": true,
    "summaryChars": 15890
  }],
  "diagnostics": ["跳过 1 个无法解析的文件：..."]
}
```

- 列表结果按 `updatedAt` 倒序，内存缓存（按 mtime 失效）。
- 只读取每个文件首部若干行（取 `session_meta`、首条用户消息、`turn_context.model`），大文件不整读。

### `POST /api/resume-codex/import`

请求：

```jsonc
{
  "path": "rollout 文件绝对路径",
  "mode": "smart",              // smart | full
  "includeTools": false,        // 是否导入工具调用与输出
  "maxTurns": 30,               // smart 模式下保留的最近轮数
  "workspacePath": null         // 可选：cwd 不存在时的兜底工作区
}
```

响应（成功）：

```jsonc
{
  "workspaceId": "...",
  "workspacePath": "D:\\desktop\\code\\AI-_-",
  "sessionId": "...",
  "title": "...",
  "turns": 12,
  "events": 214,
  "summaryIncluded": true,
  "warnings": ["原目录不存在，已归入 ..."]
}
```

失败时返回 `{ error: { reason, message, detail? } }`，`reason` 用于 UI 文案（`source-missing` / `parse-failed` / `seed-invalid` / `workspace-failed` / `no-user-message` / `busy`）。`detail` 带 `Session.create` 的校验报错，便于迭代。

安全：路径必须 `realpath` 落在 `codexHome/sessions` 下，且只允许 `.jsonl`；只接受 owner 连接。

---

## 5. Codex → DSH 事件映射

| Codex item | 处理 |
|---|---|
| `session_meta` | 生成 `SessionHeader { version, id: uuid, createdAt, cwd, isSeeded: false }`；cwd 用于工作区与 header |
| `turn_context.payload.model` | 记录该轮 assistant 消息的 `source.provider = 'codex'`、`source.model` |
| `response_item` / role `user` | → `user/message`（`input_text` 拼文本；`input_image` 变成 `[图片]` 占位） |
| `response_item` / role `assistant` | → `assistant/message`（`output_text`；同一轮多条按 step 递增） |
| `function_call` / `custom_tool_call` + output | `includeTools` 为真时 → `tool/call` + `tool/result`；为假时跳过（保留 assistant 文本） |
| `response_item` / role `developer` | 跳过（系统提示类内容，不进入对话历史） |
| `reasoning` | 跳过（本机为加密内容，无文本） |
| `compacted` | 取最近一次：解码 `replacement_history.compaction.encrypted_content` 的 base64 → 摘要块；用它代表压缩前的上下文，并丢弃压缩点之前的消息 |
| `event_msg` / `world_state` / `token_usage_record` / `inter_agent_communication_metadata` | 忽略（未知类型统一忽略并计数） |

**回合结构**（直接沿用官方导入插件的 `LogBuilder` 约束，保证种子校验通过）：

```
turn/start(turn=N) → step/start(N,1)
  [第一轮：system/message（空头，占 surface 节点 0；
            续聊时被真实系统提示替换，这是官方插件已验证的做法）]
  user/message            surfaceOp=append
  assistant/message       surfaceOp=append（同轮多条各自 step）
  [tool/call, tool/result surfaceOp=append]  ...
step/end(N,step) → turn/end(N, completed)
```

- 首轮追加 `session/title`（Codex 标题 = 首条用户消息，规范化 + 截断）；
- `seq` 从 0 连续，`time` 单调不减（取事件时间戳）；
- 摘要块作为**首条标注过的用户消息**：`〔Codex 会话摘要 · 压缩前上下文〕…`。原因：system 消息出现在历史中段可能被模型服务拒绝；developer 消息在 DSH 请求组装时会被丢弃。这是透明且能被模型正确读到的折中。

**导入范围**

| 模式 | 内容 | 适用 |
|---|---|---|
| `smart`（默认） | 最近一次压缩摘要 + 压缩点之后的最近 N 轮（默认 30） | 日常续聊，体积小 |
| `smart`（无压缩） | 最近 N 轮 | 普通会话 |
| `full` | 全部对话（工具可选），超过字符预算时截断头部并给出警告 | 需要完整回溯 |

预算：字符预算默认 240 000（≈60k token），超预算从最旧的轮次开始丢，保证最新上下文完整。

---

## 6. 工作区注入

1. `cwd` 目录存在 → `workspaceRegistry.create(canonicalPath)`（已存在则复用，不改标题）→ `workspace.attachSession(newSessionId)`。
2. `cwd` 不存在（被删/挪走）→ 使用请求里的 `workspacePath`，否则用当前会话工作区；结果里给 warning，按钮流程不中断。
3. `SessionHeader.cwd` 始终写 Codex 原 cwd（存在时），使 `workingDirectory` 服务与会话内工具都在原目录工作。

---

## 7. UI 设计

**按钮**（`conversation.hero.options`，自定 id `resume-codex`）
- 图标 + 文案「从 Codex 继续」；尺寸与同行 chip 一致；`--dsw-alias-*` 主题变量；中英文按 locale 切换。
- 只在新建会话页出现（槽位自带的条件），标题栏不额外加。

**选择器（native `<dialog>`，top-layer，无 DOM 侵入）**
- 头部：标题 + 关闭；搜索框（按标题 / cwd / id 模糊过滤）；范围切换「全部 / 当前工作区」。
- 列表行：标题（最多两行）、cwd（等宽、省略）、相对时间、「N 轮」、模型、`有摘要` 徽标、`已导入` 徽标（M4）。
- 行的主操作为「继续」；缺目录的行提示「原目录不存在」。
- 底部选项：导入范围（智能最近 30 轮 / 全部）、「包含工具调用」开关；主按钮「继续」。
- 状态：空态、加载态、导入进度（读取 → 转换 → 写入 → 打开）、错误态（可重试）。

**导入成功后**：`ctx.sessions.refresh()` → `ctx.uiWorkspace.openSession(sessionId)` → 关闭弹窗。

---

## 8. 包结构与安装

```

  package.json            # dsh.bundle.patch + dsh.client（platform: web, inject: [ui-conversation]）
  cordis.patch.yml        # 插入一个 host 行
  index.js                # Host：路由 + 配置
  lib/codex.js            # 扫描 / 解析 rollout
  lib/convert.js          # 事件转换 + 预算
  lib/write.js            # Session.create + persistence + workspace
  client.js               # 浏览器模块：按钮 + dialog
  locale/{en,zh,ja,...}.json
  docs/DETAIL.md
  icon.svg
```

安装：

```
plugin_manager action=install_bundle target="D:\\desktop\\code\\resume_codex\\src\\resume-codex"
```

（本地目录以 link 方式装入当前 profile，所有会话生效，重启保留。）

---

## 9. 里程碑

| 阶段 | 内容 | 产出 / 验证 |
|---|---|---|
| M0 | 结构验证（半天） | 用一次性动态插件或临时路由，对一条真实 rollout 生成事件并跑 `Session.create` 校验；确认空 system 头 + turn 结构可用 |
| M1 | Host 数据层（1 天） | 扫描器 + 解析器 + 转换器 + 两个路由；列表在页面 console / 临时脚本可读；转换统计（轮数/事件数/丢弃原因） |
| M2 | 写会话与工作区（半天） | 真实导入一条会话：侧边栏出现新工作区 + 会话；header.cwd 正确；重启后仍在 |
| M3 | UI（1 天） | 按钮 + 选择器 + 导入 + 自动打开；中英文；错误提示 |
| M4 | 打磨（半天到 1 天） | 智能摘要导入、工具调用开关、重复导入标记、图标/详情页、侧栏提示 |
| M5 | 验收 | 3 条真实会话（普通 / 长会话 / 带压缩）；续聊时模型能引用上文；插件禁用后无残留 |

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 事件流校验不通过（`Session.create` 抛错） | 完全对齐官方导入插件的构造；导入接口回传校验详情；M0 先验证再写 UI |
| 超长会话（本机有 50 MB 级日志） | 流式逐行解析 + 字符预算 + 摘要；`full` 模式显式确认 |
| Codex 格式迭代（新 item 类型） | 已知类型映射、未知类型忽略并计数；解析失败只影响该文件并在诊断里列出 |
| 旧会话 cwd 已不存在 | 兜底到当前/指定工作区，warning 提示 |
| 重复导入 | 插件数据目录记录 `rollout path → dsh sessionId`，UI 标「已导入」，可强制再导 |
| 工具名差异（exec / wait / shell） | 仅作为历史记录，DSH 通用工具视图渲染即可，不参与执行 |
| 位置与红框不完全重合 | 该行唯一支持的槽位右对齐；验收时确认是否可接受，备选放会话标题栏 |
| 中文路径 / 编码 | 全程 UTF-8 读写，JSONL 按行解析，不整文件字符串处理 |

---

## 11. 待确认（已被用户确认为：全部实现、全部可选）

用户答复：三个选项都要可选，直接全部完成，UI 与 DSH 原生对齐。

---

## 12. 实施结果（2026-11-21）

已完成并安装为 DSH 本地 bundle（包名 `dsh-resume-codex`，仓库根目录即插件包）。

- **入口**：`conversation.hero.options`，id `resume-codex`，order 10；客户端注册已通过 `Slots.listSubTree` 确认为 active。
- **弹窗**：原生 `<dialog>`（top-layer），搜索、全部/当前目录、三档导入范围（智能 30 轮 / 摘要 + 50 轮 / 全部）、包含工具调用开关、已导入标记、空/错误/导入中状态。
- **Host**：`GET /api/resume-codex/sessions`、`POST /api/resume-codex/import`，走 owner 认证连接；单并发导入槽。
- **写入**：`ctx.sessions.prepare` 校验种子并取得存储格式版本 → `sessionPersistence.create/append/flush` → 投影缓存刷新 → `workspaceRegistry` 复用或创建工作区 → `attachSession`。
- **Conda 格式兼容**：智能模式解码最近一次 `compacted` 摘要（`ccswitch-compaction-v1:` + base64），丢弃压缩点之前消息；全部模式从文件头解析；过滤 Codex 注入的 fork 边界、`<environment_context>`、`<user_instructions>` 等伪用户消息。
- **实测**：本机 28 个 Codex 会话可列出；对普通会话、长会话（37 MB）、含工具调用会话、fork 会话分别做了 dry-run 种子校验（均通过，存储格式 v4）；真实导入 3 次，落盘日志解压后结构正确（1 个空 system 头、turn/step 配对、tool call/result 配对、title 事件）；工作区复用与新建均正确；验证产生的会话与工作区已全部清理。
- **视觉验证**：见 12.1。

### 12.1 UI 对齐返工（2026-11-21 第二轮）

第一版弹窗用了 `--dsw-alias-bg-overlay`（深色主题下是中性灰）导致面板发灰、主按钮白底白字不可见。返工按 DSH 真实的 Modal 与 Chip 规格重写：

- 面板：`bg-layer-2`、`--dsw-radius-panel`（28px）、`--dsw-elevation-prominent`、`dialog::backdrop` 使用 `bg-mask-1` + `mask-blur`；
- 头部：`22px 14px 12px 24px`，标题 `16px/24px 500`，关闭按钮 28×28、`radius-sm`、`label-secondary`；
- 输入：34px、`.5px` `border-l4`、`radius-md`、`bg-layer-3`；
- 按钮：36px 高、`radius-md`、白底深字的主按钮（`button-primary-fill` / `label-primary-foreground`）、`outline` 次级按钮；
- 列表：无外框，行 `radius-md` + `interactive-bg-hover/active`，标题 14px、元信息 12px `label-tertiary`；
- 入口按钮按同槽位 `WorktreeToggle` 的 chip 规格：28px 高、13px/500、`radius-sm`、`label-secondary`、hover `interactive-bg-hover`；
- 删除了解释性副标题与底部提示语，底部只在选中时显示目标目录；
- 导入范围从原生 select 换成与 DSH 一致的分段控件（智能 30 轮 / 最近 50 轮 / 全部）。

**验证方式**：用临时 token 路由取到带凭证的 GUI URL，在隔离的 Chrome 配置里打开同一 DSH Web GUI，实际点击「新会话 → 从 Codex 继续」，检查按钮、弹窗、选中态与禁用态；再选一条 91 KB 会话完成真实导入，确认自动打开新会话、AI-_- 工作区出现且历史完整。验证产生的会话、工作区成员、注册表记录与临时探针均已清理，只保留用户自己导入的「阅读项目」会话。界面截图见 `hero.png` 与 `dialog.png`。


## 附：参考资料（已清理）

实现期间从 DSH 安装包中提取的官方导入插件、dsh-doc 与会话契约源码副本位于临时目录，交付前已删除；正式依据仍是安装内的 `@deepseek-ai/dsh-deepseek-chat-import` 与 `@deepseek-ai/dsh-session`。

