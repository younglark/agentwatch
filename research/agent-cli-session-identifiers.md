# 常见 Agent CLI 会在输出里给出哪些 session 标识

> 事实清单，供后续「交回时 bot 如何拼下一跳命令」决策票使用。本文不决定 agentwatch 应如何解析或实现。
>
> 调研日期：2026-11-20（Asia/Shanghai）。本环境未安装这些 CLI，未做本地实跑；结论来自当时能访问的官方文档，并在文档不足或互相冲突时对照官方源码。

## 1. 范围与方法

覆盖对象：Claude Code、OpenAI Codex CLI、Cursor Agent CLI、Grok CLI、OpenCode、Gemini CLI。关注非交互运行时，stdout / stderr / 本机状态里会出现哪些可用来交回的 session / thread / conversation 标识，如何稳定识别，以及标识缺失时输出是什么样的。

一手来源以各家官方文档为准；文档未给出字段名、ID 形态或「缺失时」行为时，再引用对应上游仓库当时的 `main`/`dev` 源码，并标明提交。第三方博客、论坛帖不作事实依据。

## 2. 对照摘要

| CLI | 非交互入口 | stdout 里可识别的交回标识 | 字段名 / 形态 | 默认文本输出是否带标识 | 本机状态 | 缺失或失败时 |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `claude -p` | `--output-format json` 的结果对象，或 `stream-json` 事件 | `session_id`（官方要求 `--session-id` 为合法 UUID） | 否（默认 `text` 仅为纯文本） | `~/.claude/projects/<编码后的工作目录>/<session-id>.jsonl`（可用 `CLAUDE_CONFIG_DIR` 改根目录） | 找不到会话时报告 `No conversation found with session ID: `；`--no-session-persistence` 不落盘、不可恢复 |
| Codex CLI | `codex exec`（别名 `codex e`） | 仅在 `--json` 时：JSONL 首类事件 | `thread_id`（官方样例为 UUID） | 否：默认把最终回复打到 stdout，进度在 stderr | `$CODEX_HOME/sessions`（默认 `~/.codex/sessions`）；归档在 `$CODEX_HOME/archived_sessions` | `--ephemeral` 不把 rollout 文件持久化到磁盘；默认文本输出不带 ID。官方文档未给出「JSON 流里没有 `thread_id`」的完整失败样例 |
| Cursor Agent | `agent -p` / `--print` | `--output-format json` 或 `stream-json` | `session_id`（官方标为 uuid）。恢复参数写作 `chatId` / thread id | 否：默认 `text` 只有最终助手文本 | 官方文档未给出 chat 文件的固定磁盘路径；`agent ls` / `create-chat` / `--resume` 是文档中的定位方式 | 失败时非零退出，错误写 stderr，「不会发出形态完好的 JSON 对象」，因此失败路径的 stdout 里没有 `session_id` |
| Grok CLI | `grok -p` / `--single` | `--output-format json` 的最终对象，或 `streaming-json` 的 `end` 事件 | `sessionId`（camelCase）。`--session-id` 创建新会话时要求 UUID | 否：默认 `plain` 是人类可读文本 | `~/.grok/sessions/`（可用 `GROK_HOME` 改根；源码用户指南称会话为 SQLite） | 失败时非零退出，可能发出 `{"type":"error","message":"Couldn't start session: ..."}`，该样例不含 `sessionId`。只读 `~/.grok` 时持久化会静默失败（临时会话） |
| OpenCode | `opencode run` | `--format json` 的 NDJSON 事件；或事后 `opencode session list --format json` | 事件顶层 `sessionID`。ID 以 `ses` 开头，生成形如 `ses_` + 26 字符。官方文档示例 `ses_4f2a1c` 是截断写法 | 官方文档未说默认（formatted）输出会打印 session ID | 源码默认数据目录为 `$XDG_DATA_HOME/opencode`（未设置时 `~/.local/share/opencode`），库文件 `opencode.db`；可用 `opencode debug paths` 打印 | JSON 错误事件仍有 `sessionID` 键；若当时还没有会话，值为空字符串 `""` |
| Gemini CLI | `gemini -p` / `--prompt` | `stream-json` 的 `init` 事件必有 `session_id`。`json` 格式：官方文档未列该字段，当前源码会写可选的 `session_id` | `session_id`（`randomUUID()`） | 否：默认 `--output-format text` | `~/.gemini/tmp/<project_hash>/chats/` | 官方 `json` 文档 schema 只有 `response` / `stats` / 可选 `error`，未保证有 session 字段。`--list-sessions` 展示的是截断方括号 ID，按 ID 恢复时文档要求完整 UUID |

## 3. 分工具事实

### 3.1 Claude Code

**官方文档（检索日 2026-11-20）**

- 非交互：`claude -p`（或 `--print`）。继续最近一次会话用 `--continue`；继续指定会话用 `--resume` / `-r`，参数可以是 session ID、名称，或 transcript `.jsonl` 的绝对路径。
- 捕获 ID 的官方写法：

```bash
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
claude -p "Continue that review" --resume "$session_id"
```

- `--output-format`：`text`（默认，纯文本）、`json`（「structured JSON with result, session ID, and metadata」）、`stream-json`（NDJSON）。`stream-json` 最后一行是带最终文本、费用和 session metadata 的 `result` 消息。事件里可见字段 `session_id`（例如 `system/api_retry` 表：`session_id` | string | session the event belongs to）。
- `--session-id`：「Use a specific session ID for the conversation (must be a valid UUID)」，官方示例为 `550e8400-e29b-41d4-a716-446655440000`。
- 本机存储：「By default, Claude Code stores transcripts as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`」，其中项目目录名由工作目录路径把非字母数字字符换成 `-` 得到；超 200 字符会截断并追加路径哈希。可用 `CLAUDE_CONFIG_DIR` 改根目录。文档明确：JSONL 条目格式是内部实现、版本间会变，「scripts that parse these files directly can break on any release」。
- `-p` / Agent SDK 会话默认不出现在会话选择器和普通 `claude --continue` 里，但仍可用 session ID 做 `claude --resume`；`claude -p --continue` 会把这类会话算进去。
- 缺失：若没有任何已存会话匹配该 ID，官方原文为：`No conversation found with session ID: `（后面跟所查 ID）。手拷副本导致同一 ID 在多个项目各有一份时，跨项目查找会报 not-found，而不是随便恢复一份。
- `--no-session-persistence`（仅 print 模式）或环境变量 `CLAUDE_CODE_SKIP_PROMPT_HISTORY`：不把会话写到磁盘，因而不能 resume。
- `claude agents --json` 可把活动的后台会话打成 JSON 数组（`--json --all` 还包含已完成的后台会话）。这是另一条列出 ID 的官方接口，不是 `-p` 的默认 stdout。

**版本锚点：** 官方 changelog 在检索日可见 2.1.328（2026-11-19）。部分行为按文档标注了最低版本（例如 `--continue` 对仍在运行的后台会话的处理自 v2.1.257 起）。

来源：

- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/changelog

### 3.2 Codex CLI

**官方文档（检索日 2026-11-20）**

- 非交互：`codex exec`（短写 `codex e`）。恢复：`codex exec resume [SESSION_ID]`，或 `--last` 取当前工作目录最近一次；加 `--all` 跨目录。交互侧还有 `codex resume`，参数类型文档写为 `uuid | session name`，「UUIDs take precedence if it parses」。
- 默认输出：「While `codex exec` runs, Codex streams progress to `stderr` and prints only the final agent message to `stdout`.」因此默认 stdout **不**带 session / thread 标识。
- 机器可读：`codex exec --json` 把 stdout 变成 JSONL。事件类型包括 `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.*`、`error`。官方样例：

```
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
```

稳定识别：在 JSONL 中找 `type == "thread.started"` 的 `thread_id`。后面的 `item.id`（如 `item_1`）不是会话标识。
- 恢复指定会话的官方句子是：`You can also target a specific session ID with `codex exec resume <SESSION_ID>``。文档 **没有** 写明「把 `thread_id` 原样传给 `resume`」；两者都按 UUID 描述，同属会话概念，但官方 CLI 文档没有用一句话把字段名等同起来。Codex SDK 文档则使用 thread ID（`thread.id` / `resumeThread(threadId)`）。
- `--ephemeral`：「when you don’t want to persist session rollout files to disk」。
- 本机状态：`$CODEX_HOME` 默认 `~/.codex`。「Session transcripts: `$CODEX_HOME/sessions` (default: `~/.codex/sessions`)」；归档在 `$CODEX_HOME/archived_sessions`。
- 缺失：默认非 JSON 运行的 stdout 只有最终自然语言，没有文档化的 ID。`--ephemeral` 运行不持久化 rollout。官方非交互文档未提供「启动失败因而没有 `thread.started`」的完整 JSON 样例；本文未用本地实跑补这一条。

来源：

- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/cli/reference.md
- https://learn.chatgpt.com/docs/reference/troubleshooting.md
- https://learn.chatgpt.com/docs/config-file/environment-variables
- https://learn.chatgpt.com/docs/codex-sdk

### 3.3 Cursor Agent CLI

**官方文档（检索日 2026-11-20；页面未标 last updated）**

- 非交互：`agent -p` / `--print`，可配 `--output-format text|json|stream-json`（默认 `text`）。
- 恢复：`--resume [chatId]`；`--continue` 是 `--resume=-1` 的别名。文档也写「Continue from an existing thread with `--resume [thread id]`」。`agent resume` 恢复最新会话；`agent ls` 打开既往聊天并挑选；`agent create-chat`：「Create a new empty chat and return its ID」。官方没有给出 `create-chat` 的精确 stdout 样例（是否纯 ID、是否带换行等未写明）。
- `json` 成功时，stdout 是单个 JSON 对象加换行。官方结构：

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 1234,
  "duration_api_ms": 1234,
  "result": "<full assistant text>",
  "session_id": "<uuid>",
  "request_id": "<optional request id>"
}
```

`session_id` 被定义为「Unique session identifier」。`request_id` 是可选的请求标识，可省略；与会话标识不是同一字段。交互里另有 `/copy-conversation-id` 和 `/copy-request-id`，说明 conversation/session 与 request 被分开对待。
- `stream-json`：每条事件都带 `session_id`（官方示例值为 `c6b62c6f-7ead-4fd6-9922-e952131177ff`）。系统初始化事件：

```json
{
  "type": "system",
  "subtype": "init",
  "apiKeySource": "env|flag|login",
  "cwd": "/absolute/path",
  "session_id": "<uuid>",
  "model": "<model display name>",
  "permissionMode": "default"
}
```

文档写：「Session IDs remain consistent throughout a single agent execution」。
- `text` 格式示例只有最终一句话，不含 session 标识。
- 失败：「On failure, the process exits with a non-zero code and writes an error message to stderr. No well-formed JSON object is emitted in failure cases.」`stream-json` 失败时流可能提前结束且没有终端 `result` 事件，错误同样在 stderr。因此 **失败路径的 stdout 不能指望出现 `session_id`**。
- 本机状态：官方 CLI 文档没有给出 chat transcript 的固定文件路径。文档提到 CLI worktree 在 `~/.cursor/worktrees/<repo>/<name>`，那是工作树位置，不是会话 ID 的存储说明。

来源：

- https://cursor.com/docs/cli/reference/output-format
- https://cursor.com/docs/cli/reference/parameters
- https://cursor.com/docs/cli/overview
- https://cursor.com/docs/cli/using

### 3.4 Grok CLI

**已发布的官方文档（https://docs.x.ai，检索日 2026-11-20）**

- 非交互：`grok -p`。从 JSON 读回 ID 的官方写法：

```bash
grok -p "Start the refactor" --output-format json | jq -r '.sessionId'
```

然后把该值传给 `-r` / `--resume`。`--continue` / `-c` 继续当前目录最近一次会话。
- 会话「keyed by working directory」，保存在 `~/.grok/sessions/`。
- `-s, --session-id`：在 [Sessions](https://docs.x.ai/build/features/sessions) 页写的是「names a new session with a UUID you supply; it does not resume existing ones」。但同站 [Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting) 页的表格仍写「Create or resume a named headless session」。这两处官方页面不一致；Sessions 页与下面的上游用户指南一致。
- Headless 页还写：Headless sessions 存在 `~/.grok/sessions`；`--output-format` 可选 `plain`、`json`、`streaming-json`。该页没有给出完整 JSON 对象字段表。

**上游文档源码（xai-org/grok-build 用户指南，比已发布 Headless 页更完整）**

文件：`crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md`（与 Sessions 指南 `17-sessions.md`）。该文件给出：

- 默认 `plain`：人类可读文本，例如 `Here's a summary of the codebase...`，不含 ID。
- `json`：结束后一个对象，含 `text`、`stopReason`、`sessionId`、`requestId`（有推理时还有 `thought`）以及花费字段。指南写：「The `--output-format json` response always includes a `sessionId` you can use with `--resume`」。占位示例：

```json
{
  "text": "Here's a summary of the codebase...",
  "stopReason": "end_turn",
  "sessionId": "abc123",
  "requestId": "xyz789",
  "num_turns": 7
}
```

注意：这里的 `"abc123"` 是文档占位，不是形态规范。同文件要求 `-s/--session-id` 必须是合法 UUID；「UUID-shaped values always take the ID path, so scripts should prefer IDs」。`--resume` 也可以按当前目录的标题匹配（忽略大小写）；重名时可能报错并列出匹配 ID。
- `streaming-json` 结尾事件样例：`{"type":"end","stopReason":"end_turn","sessionId":"abc123","requestId":"xyz789",...}`。`end` 总是最后一条。
- 失败：「On failure, Grok emits an error object (process exit non-zero)」，样例为 `{"type":"error","message":"Couldn't start session: ..."}`，**该样例没有 `sessionId`**。
- `--resume` 在会话不存在时会报错。
- 本机：`~/.grok`（`GROK_HOME` 可覆盖），`sessions/` 为「Session transcripts (SQLite)」。只读挂载 `~/.grok` 时，「Session persistence fails silently (ephemeral)」。
- 中断：SIGINT/SIGTERM 会把状态存到最后一次完成的工具调用；退出码 130/143；可用 `--resume` 或 `--continue` 再进入。

来源：

- https://docs.x.ai/build/features/sessions
- https://docs.x.ai/build/cli/headless-scripting
- https://docs.x.ai/build/cli/reference
- https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md
- https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md

### 3.5 OpenCode

**官方文档（https://opencode.ai/docs/cli/commands，检索日 2026-11-20）**

- 非交互：`opencode run [message..]`。继续最近一次：`opencode run --continue "..."`。继续指定会话：`opencode run --session ses_4f2a1c "..."`。`--format json`：「Emit newline-delimited JSON for scripts。」官方命令页 **没有** 列出 JSON 事件的字段名。
- 管理：`opencode session list`；`opencode session list --max-count 20 --format json`；`opencode session delete ses_9c1b08`；`opencode session export ses_4f2a1c`。文档示例 ID 一律是短形式 `ses_4f2a1c` / `ses_9c1b08`。
- `opencode debug paths` / `opencode debug paths db` 可打印全局路径，文档未写出默认路径字符串。

**官方源码（anomalyco/opencode，默认分支 `dev`，提交 `9fd74ebdb7f3f924871f24540f753c9ce75c0118`，2026-11-19）**

- ID 类型：`SessionID` 必须 `isStartingWith("ses")`；创建函数为 `"ses_" + descending()`。`descending()` 生成 26 个字符（时间排序编码 + 随机），因此完整 ID 形如 `ses_` 后接 26 字符，比文档示例更长。
- `opencode session list --format json` 向 stdout 写出数组，元素为：`id`、`title`、`updated`、`created`、`projectId`、`directory`。默认 table 是制表符分隔的 `id`、标题、本地化时间。
- `opencode run --format json`：每条事件是一行 JSON，由 `emit` 写成 `{ type, timestamp, sessionID, ...data }`。已见到的 `type` 包括：`text`、`reasoning`、`tool_use`、`step_start`、`step_finish`、`error`、`background_wait`、`retry`。`sessionID` 出现在事件顶层，部分 `part` 对象里还会再带一次。
- 缺失 / 失败：`reportRunError` 在 `--format json` 时仍向 stdout 写错误事件，形状为：

```json
{"type":"error","timestamp":<number>,"sessionID":"","error":{"type":"unknown","message":"..."}}
```

若还没有会话，`sessionID` 是空字符串，键仍然存在。默认（非 json）格式则把错误写到 UI/stderr，不保证有 ID。
- 本机状态：源码用 XDG，`app = "opencode"`，数据目录为 `$XDG_DATA_HOME/opencode`，未设置 `XDG_DATA_HOME` 时为 `~/.local/share/opencode`；数据库默认 `opencode.db`（可用 `OPENCODE_DB` 覆盖）。这是源码默认值，不是官方文档正文里的路径说明。

来源：

- https://opencode.ai/docs/cli/commands
- https://github.com/anomalyco/opencode/blob/9fd74ebdb7f3f924871f24540f753c9ce75c0118/packages/schema/src/session-id.ts
- https://github.com/anomalyco/opencode/blob/9fd74ebdb7f3f924871f24540f753c9ce75c0118/packages/cli/src/commands/handlers/session/list.ts
- https://github.com/anomalyco/opencode/blob/9fd74ebdb7f3f924871f24540f753c9ce75c0118/packages/cli/src/run/run.ts
- https://github.com/anomalyco/opencode/blob/9fd74ebdb7f3f924871f24540f753c9ce75c0118/packages/cli/src/run/noninteractive.ts
- https://github.com/anomalyco/opencode/blob/9fd74ebdb7f3f924871f24540f753c9ce75c0118/packages/util/src/global.ts
- https://github.com/anomalyco/opencode/blob/9fd74ebdb7f3f924871f24540f753c9ce75c0118/packages/util/src/global-roots.ts

### 3.6 Gemini CLI

**官方文档**

- 会话管理页（标注 Last updated: Jun 18, 2026）：会话自动保存在 `~/.gemini/tmp/<project_hash>/chats/`，`<project_hash>` 由项目根目录得出，会话按项目隔离。恢复：`gemini --resume`（最近一次）、`gemini --resume 1`（索引）、`gemini --resume a1b2c3d4-e5f6-7890-abcd-ef1234567890`（「full session UUID」）。列出：`gemini --list-sessions`，示例输出为：

```
Available sessions for this project (3):

 1. Fix bug in auth (2 days ago) [a1b2c3d4]
 2. Refactor database schema (5 hours ago) [e5f67890]
 3. Update documentation (Just now) [abcd1234]
```

方括号里是截断展示；按 ID 恢复时文档要求完整 UUID。`--delete-session` 可用索引或 ID。
- 速查页（Last updated: May 1, 2026）另写 `gemini -r "latest"`、`gemini -r "abc123"`，以及 `--output-format` 可选 `text`、`json`、`stream-json`（默认 `text`）。与会话管理页的 `--resume` / UUID 表述并存，同属官方文档。
- Headless 参考（网站标注 Last updated: Mar 10, 2026；与仓库 `docs/cli/headless.md` 正文一致）：
  - `json` schema 只列出：`response`（最终回答）、`stats`、可选 `error`。**该官方 schema 没有 session 字段。**
  - `stream-json` 事件：`init` 为「Session metadata (session ID, model)」；还有 `message`、`tool_use`、`tool_result`、`error`、`result`。该页没有写出 `init` 的精确 JSON 字段名。

**官方源码（google-gemini/gemini-cli `main`，HEAD `808199f5c2f64db0f2b1cf84b529c39f6791ecf7`，检索日 2026-11-20）**

- `createSessionId()` 返回 `randomUUID()`。
- `stream-json` 的 `InitEvent` 必含：`type: "init"`、`timestamp`、`session_id`、`model`。测试里的形状为：

```json
{"type":"init","timestamp":"2025-10-10T12:00:00.000Z","session_id":"test-session-123","model":"gemini-2.0-flash-exp"}
```

终端 `result` 事件有 `status` 和 `stats`，**源码类型里没有 `session_id`**。要在流里拿 ID，应看 `init`，不要只看最后的 `result`。
- `JsonOutput` 类型把 `session_id` 标成可选。`JsonFormatter.format()` 在传入了 `sessionId` 时才写入该字段。当前 `nonInteractiveCli.ts` 在 JSON 模式下调用 `formatter.format(config.getSessionId(), responseText, stats, ...)`，因此 **现行源码的 `json` 输出通常会带 `session_id`**，即使 2026-03-10 的官方 headless 文档还没写这个字段。这是文档与源码的已知偏差，后续决策时应再核对当时安装的 CLI 版本。

来源：

- https://geminicli.com/docs/cli/session-management/ （Last updated: Jun 18, 2026）
- https://geminicli.com/docs/cli/headless/ （Last updated: Mar 10, 2026）
- https://geminicli.com/docs/cli/cli-reference/ （Last updated: May 1, 2026）
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
- https://github.com/google-gemini/gemini-cli/blob/808199f5c2f64db0f2b1cf84b529c39f6791ecf7/packages/core/src/utils/session.ts
- https://github.com/google-gemini/gemini-cli/blob/808199f5c2f64db0f2b1cf84b529c39f6791ecf7/packages/core/src/output/types.ts
- https://github.com/google-gemini/gemini-cli/blob/808199f5c2f64db0f2b1cf84b529c39f6791ecf7/packages/core/src/output/json-formatter.ts
- https://github.com/google-gemini/gemini-cli/blob/808199f5c2f64db0f2b1cf84b529c39f6791ecf7/packages/cli/src/nonInteractiveCli.ts
- https://github.com/google-gemini/gemini-cli/blob/808199f5c2f64db0f2b1cf84b529c39f6791ecf7/packages/core/src/output/stream-json-formatter.test.ts

## 4. 「缺失」时输出长什么样（归纳）

各家「没有可用交回标识」并不只有一种形态，文档/源码里出现过这些情况：

1. **根本没被打印：** 默认文本/plain 模式通常只给最终自然语言（Claude `text`、Codex 默认 exec、Cursor `text`、Grok `plain`、Gemini 默认 `text`）。stdout 里没有稳定字段。
2. **结构化成功输出里没有该字段：** Gemini 官方 `json` schema（2026-03-10 文档）只有 `response` / `stats` / `error`。Cursor / Codex 的纯文本成功输出同样没有 ID。
3. **失败而不发完好 JSON：** Cursor 官方明确：失败时错误在 stderr，不发出 well-formed JSON。此时 stdout 没有 `session_id`。
4. **失败 JSON 不含 ID：** Grok 用户指南的失败样例是 `{"type":"error","message":"Couldn't start session: ..."}`，没有 `sessionId`。
5. **键在、值为空：** OpenCode 源码在 JSON 错误路径把 `sessionID` 写成 `""`（还没有会话时）。
6. **有 ID 但不可恢复：** Claude `--no-session-persistence` / `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 不写磁盘；Codex `--ephemeral` 不持久化 rollout；Grok 在只读 `~/.grok` 上持久化静默失败。即使本次输出里出现过 ID，也不能假定之后还能 resume。
7. **恢复找不到：** Claude 官方句子：`No conversation found with session ID: `。Grok `--resume` 在目标不存在时报错。Gemini 列表展示可能是截断 ID，用截断值当完整 UUID 去 `--resume` 是否成功，官方文档未演示，本文未实跑。

## 5. 明确未核实或存在文档冲突的点

- 未在本机实际运行上述 CLI，因此没有第一手的完整成功/失败终端记录，也没有核对「帮助文本」与文档是否完全一致。
- Codex 官方文档没有一句写明 `thread_id` 就是 `codex exec resume` 所接受的 `SESSION_ID`；只确认前者出现在 `--json` 流里，后者是 resume 参数（UUID 或名称）。
- Cursor `agent create-chat`「return its ID」的精确 stdout 字节级格式，官方未展示。
- Cursor 会话 transcript 的磁盘路径，官方 CLI 文档未给出。
- Grok 已发布 Headless 页与 Sessions 页对 `-s/--session-id` 是否用于 resume 的表述冲突；完整 JSON schema 只在 grok-build 用户指南里出现，已发布 Headless 页较简。
- Gemini 官方 `json` schema（2026-03-10）尚未列出 `session_id`，与 2026-11-20 的 `main` 源码行为不一致。
- OpenCode 官方命令文档里的 `ses_4f2a1c` 是截断示例；完整形态以源码为准。官方文档未描述 `--format json` 的事件 schema。
- 各家「名称 / 标题」与「ID」都可作 resume 参数时（Claude 名称、Codex session name、Grok title），重名与歧义规则并不相同；本文只记录文档已写明的规则，未穷尽错误文案。

## 6. 来源与版本/日期

所有网页均在 2026-11-20（Asia/Shanghai）检索。

| 来源 | 版本或页面日期 |
| --- | --- |
| Claude Code 文档（headless / sessions / CLI reference / changelog） | changelog 可见 2.1.328（2026-11-19） |
| Codex 文档（non-interactive-mode、CLI reference、troubleshooting、environment variables、SDK） | 检索日页面，无单独 last-updated 标注 |
| Cursor CLI 文档（output-format、parameters、overview、using） | 检索日页面，无单独 last-updated 标注 |
| docs.x.ai Grok Build（sessions、headless-scripting、CLI reference） | 检索日页面 |
| xai-org/grok-build 用户指南 14 / 17 | 仓库 `main`，检索日 |
| opencode.ai CLI commands | 检索日页面 |
| anomalyco/opencode | `dev` @ `9fd74ebdb7f3f924871f24540f753c9ce75c0118`（2026-11-19） |
| geminicli.com session-management | Last updated: Jun 18, 2026 |
| geminicli.com headless | Last updated: Mar 10, 2026 |
| geminicli.com CLI cheatsheet | Last updated: May 1, 2026 |
| google-gemini/gemini-cli | `main` @ `808199f5c2f64db0f2b1cf84b529c39f6791ecf7`（检索日 HEAD） |
