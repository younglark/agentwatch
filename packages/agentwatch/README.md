# agentwatch task core — built-in Connect/HTTP adapters

This is modular implementation code, not another generic PoC. It is **not yet a
production-ready runner**. 身份查询和通知由 agentwatch 内建的 Bun HTTP 客户端直接请求；
`grokbot-control` npm-v0.7.0 **只作只读协议参考**，不调用外部 `gbc`，不安装/内嵌它、
官方 App、Node、模型 SDK、ACP、webhook 或 Stop Hook。这里使用的后端契约来自非官方
逆向资料，不是官方公开 API。本轮只做合成凭据 + 本地 mock Connect 后端验收，没有 live。
无可用自有凭据 → `AUTH_NOT_CONFIGURED`（exit 4），不插任务、不启动 native 命令。
没有生产 fake-verifier flag / 环境开关，不读取真实 ~/.gbc、官方桌面凭据或 keychain。

The original root src/ and experiments/bun-daemon-spike remain historical code.
This package is built independently; it does not replace the legacy root bin yet.

## Build and verify (Bun 1.4.4)

```sh
cd packages/agentwatch
bun install --frozen-lockfile && bun run verify
```

Production artifact: dist/agentwatch, same executable for CLI/internal-serve.
The separately built dist/test-host is only a test fixture and excluded from the
package files list. test/host.ts injects a fixed fixture executor and test verifier;
production main.ts never imports it. No actual four-vendor CLI is run by tests.

## Minimal command contract

```
agentwatch run --bot BOT --request-id ID [--cwd DIR] [--state DIR] [--json] -- claude ...
agentwatch status TASK_ID [--state DIR] [--json]
agentwatch logs TASK_ID [--stream stdout|stderr] [--offset BYTES] [--limit BYTES] [--state DIR] [--json]
agentwatch wait TASK_ID [--timeout SECONDS] [--state DIR] [--json]
agentwatch cancel TASK_ID [--state DIR] [--json]
```

- `--` splits bot-native argv from our flags; no joining, shell parsing or resume /
  permission semantics. Program basename allowlist: claude, opencode, codex, grok.
  This allowlist is not a sandbox. Absolute paths with these basenames are allowed.
- request-id is required in this slice. Its scope is the state directory; it never
  expires here. Fingerprint covers canonical cwd, bot and every argv element.
  Same ID/request returns the original task; a changed request conflicts.
- Operational stdout is one `{version:1,command,data}` JSON line, including without
  a TTY; --json is accepted explicitly. Errors are one `{version:1,error:{code,
  message}}` JSON line on stderr, with no raw args, stack, IPC token or app secrets.
  Explicit --help / --version remain human help output. Interactive --wizard and
  unrelated built-in flags are disabled, rather than waiting for bot input.
- Status/wait expose task state and independent notification state. Wait completes
  on task termination, not on notification acceptance. A successful wait never
  proves vendor business/permission success or durable bot inbox delivery.
- logs defaults to 4096 bytes, max 65536, using byte offset/next_offset. data_base64
  preserves bytes across UTF-8 boundaries; text is a preview and may split a code
  point. Raw private files are not retained/truncated by a disk-quota policy yet.
- wait defaults to 30 seconds, max 300; timeout exits 9 without killing anything;
  unknown exits 10 immediately. Observed child failure exits 1. Running cancel
  becomes cancelled only after observed close; pre-start cancel cannot spawn.
- Other codes: 2 usage; 3 not found; 4 auth unavailable; 5 bot forbidden; 6 request
  conflict; 7 IPC auth; 8 local/external lookup transport unavailable; 11 draining; 12 version /
  migration incompatibility. Unknown transport interruptions are not called success.

## Agentwatch 自有凭据（登录/刷新命令后置）

本轮只支持安全预配置的有效 access token。**浏览器登录、OAuth refresh、自动迁移、
真实用户/bot/团队绑定验证均未实现**；不会从 gbc 或官方 App 导入凭据。过期/缺失/不安全
文件一律 exit 4；不自动登录或重放请求，也不把 client_id 从 JWT、App 或包内常量猜出来。

默认凭据路径：`~/.agentwatch/auth/credentials.json`；仅 `AGENTWATCH_CREDENTIALS` 可显式
指定另一份 agentwatch 自有文件。文件须由当前用户持有、普通文件、无 symlink/hardlink、
权限 0600（或更窄），直接父目录私有 0700（或更窄），路径不经 symlink，最大 16 KiB。
Windows ACL 尚未实现，Windows 凭据读取失败关闭。它不是对任意同 UID 程序的秘密沙箱。
凭据加载有界、不回显解析异常；本轮不提供生成/编辑凭据的产品命令。请通过受信任的
私有配置/安全编辑方式 provision，不把 token 放在 argv 或聊天、日志里。

agentwatch 独立格式如下（**全部是合成占位符，不是真实凭据**）：

```json
{"version":1,"backend":"https://YOUR-EXPLICIT-BACKEND","client_id":"YOUR-EXPLICIT-CLIENT-ID","access_token":"SYNTHETIC_TOKEN","expires_at_ms":1893456000000}
```

- `backend` 与 token 同文件绑定，仅 HTTPS origin，无用户信息/路径/query/fragment；
  本地 mock 仅额外允许 `http://127.0.0.1:PORT` / `[::1]`。不另行猜后端、team id 或覆盖
  endpoint，不允许重定向。自定义 HTTPS origin 必须由操作者在这份私有配置中显式信任。
- `client_id` 只来自显式 `AGENTWATCH_CLIENT_ID` 或预配置/未来登录时持久化绑定；两者
  都有时必须一致。没有内置值，不从 token 解码推导，也不伪造官方身份头。
  client_id 只做本地绑定校验；RPC 只发送 Bearer，不把 client_id 当认证头发出。
- `expires_at_ms` 是安全整数且必须晚于现在；本切片不会 refresh。缺失或过期须重新
  provision 有效凭据；不使用 refresh_token。已运行 daemon 的 env 是启动时快照，文件则
  每次请求重读。仅改 shell env 须先停止原 daemon 再启动；不会自动替换现有实例。
- health 读取安全配置是否就绪：`bot_verifier:connect_http`、
  `notification_transport:connect_http`，否则 `not_configured`。这不证明远端认证或 bot
  权限有效。`test_only` 仅独立 testhost 使用，生产不会返回它。

## 内建身份门闩与 HTTP 边界

每个新任务入账前、实际 native spawn 前，分别直接 POST：
`/aiserver.v1.GrokBotService/ListGrokBotAgents`，请求 `{}`。只按 protobuf JSON
`agents[].agentId` 精确匹配 `--bot`；拒绝 name / numeric server id / legacy alias。
不传未证实的 team 参数。空完整列表或禁止 → `BOT_FORBIDDEN` / 5；截断列表里未找到
→ `UNKNOWN` / 10。入账前失败零任务行；入账后第二次失败保留 failed、pid=null，不启动。

Connect unary JSON 没有 CLI `schema_version/outcome` 封套：请求/成功响应是 bare protobuf
JSON；非 200 的 JSON `code` 错误只用受控码、不回显原始 body。精确 auth 白名单：
`auth`、`unauthenticated`、`auth_revoked`、`auth_refresh_unconfigured`、
`auth_refresh_client_mismatch`、`auth_refresh_subject_mismatch` → exit 4；其它失败不泛化
成鉴权失败。其它坏响应/传输错误 → `TRANSPORT_NOT_CONFIGURED` / 8。

所有 RPC 使用 `Content-Type:application/json`、`Connect-Protocol-Version:1` 与 Bearer；
3 秒绝对请求/响应读取超时、响应流解码后最大 1 MiB、禁重定向，结束/超限/取消均释放
响应 reader。不依赖 PATH，不启动网络 CLI，无 token argv，不转发后端异常或原始错误体。
契约来源与 JSON/枚举映射见 `evidence/direct-http/upstream-contract.md`。

## 通知：持久 outbox + 内建直接请求（仅 mock 验收）

终态与稳定 `event_id = task_id:terminal:1` 同事务落盘；先事务 claim inflight，再发 HTTP。
首次 claim 生成并持久化 message_id；稳定 ID 只是关联键，**不是已证明的远端去重键**。
直接 POST 到同一 service：

- `SendGrokBotUserMessage`：`agentId,messageId,sessionId:"",text,sentAtMs`；int64 时间按
  protobuf JSON 十进制字符串发送。空 sessionId 沿用参考请求的默认未报告会话，不猜 ID。
- `GetGrokBotSendStatus`：`agentId,messageId,sessionId:""`，仅 unknown 时最多一次只读对账。

text 只有冻结的有界 JSON 六字段：version、event_id、task_id、state、exit_code、error_code。
不发送 argv、cwd、request_id、日志全文、原始异常、token、report 文件或总结。通知失败
不改任务结果，wait 只等待任务终结。

| 通知状态 | 只说明什么 |
|---|---|
| pending | 尚未请求；缺配置时不 claim；本地明确未 dispatch 的重试可在此退避 |
| inflight | claim 已落盘，外部写可能进行中 |
| accepted | delivery=accepted_box/1、accepted_temporal/2、duplicate/3，或只读 status=accepted/2 |
| rejected | delivery=refused/4，或只读 status=rejected/3，不重发 |
| not_dispatched | 仅本地可证明未请求的不可重试结果，或本地安全重试预算用尽 |
| unknown | 可能已写，禁止自动重放；needs_reconciliation=true |

- 超时、崩溃、丢响应、坏 JSON、超限、矛盾或未知枚举一律 unknown；启动恢复 inflight
  → unknown。只读状态 not_found/pending/unknown_durability、查询失败都不触发补发。
- **后端错误体的 rpc_dispatched:false / retryable 不再是本地未 dispatch 证据**：HTTP
  已请求即可能发生副作用，即使 401/503 也不自动重试。当前直接适配器没有自动网络重试，
  也未实现 token refresh；本地凭据加载失败保留 pending/NOT_CONFIGURED，不丢 outbox。
- worker 保留本地可证明未 dispatch + 可重试的注入式结果契约；公共 engine/store seam
  验证最多 3 次总尝试、250/500ms 有界退避，预算/时间落盘，重启不重置。不把这个 DI
  测试说成 live 刷新重试已实现。生产 HTTP 错误绝不映射到该安全重试结果。
- accepted/rejected/unknown/not_dispatched 不回到 pending。unknown 最多一次只读 status，
  尝试数先落盘；没有后续人工覆写/重复对账命令。未读 history/transcript。
- receipt 只留有界白名单字段，凭据形态/超长标识置 null；不回显 refusal 原文/额外字段。
  `dispatched` 是业务工作流字段，不是「RPC 没发出」证据。
- durability 恒 `unverified`。accepted、duplicate、echo、accepted_at 都不是持久 ACK、
  已读或任务业务成功证明；不承诺 exactly-once。drain 取消当前 HTTP、停止领取并有界
  落盘，不等无限网络；无凭据 pending 可在配置恢复后继续。

本轮源码与编译合约均使用本地 loopback Connect mock + 临时 HOME/合成私有凭据；PATH
只含 native shell fixture（编译测试没有工具链且暂移源码）。没有真实登录、refresh、
真实后端请求、真实 bot 发信、真实 ~/.gbc/官方凭据读取或四家 CLI E2E。

## Service and storage boundaries

Default state: ~/.local/state/agentwatch-core (not legacy auth home). Tests always
use isolated directories. POSIX state must be owned and 0700; database, registration
and generated per-instance IPC capability are 0600. Local HTTP binds 127.0.0.1 only,
requires capability + instance + canonical-state scope, and validates protocol /
version on health. The registration is atomically replaced; shutdown removes only
its own instance. A separate SQLite lifetime exclusive transaction elects one
owner; it does not lock the task database. Crash releases ownership without stale
PID killing. See the explicit adaptation in ../../docs/task-core-opencode-map.md.

Effect Layer/Scope owns the SQLite client; Drizzle uses that same Effect client.
Embedded migration has a checksum/version gate. Task terminal state and stable
outbox event commit together. Lost starting/running/cancelling tasks become unknown,
never replayed. After an abrupt termination, previously queued (unstarted) records
remain eligible for dispatch with a new pre-spawn verifier check. Successful drain
has a stronger guarantee: synchronously close admission, settle all admitted commit
promises, finish the current preparing/worker activity, then transactionally cancel
all remaining queued records before returning. A submission admitted before drain
may return queued while drain is in progress, but cannot remain queued and launch
after successful drain/restart. A verifier-pending request not yet admitted is
rejected without a ledger row. Historical unknown does not block drain.

Only internal authenticated protocol supports health/drain/shutdown; these are not
new user-facing business commands. Automatic version replacement, ownership-file
watchdog and a full contender retry pool are not in this slice.

## Explicit remaining gates

Live direct identity/target/send verification, browser login and OAuth refresh, durable ACK/deduplication evidence, further reconciliation UX, four-vendor E2E,
production process-tree cancellation (.cmd / Windows included), redaction policy
for potentially sensitive native output, disk retention, upgrades/distribution,
and full multi-user/Windows ACL hardening remain unfinished. No production
ready/supported-platform claim follows from Linux-only tests or OpenCode's usage.

## Review-fix log safety boundary

Task log IDs must be UUID-shaped, including IDs read back from SQLite. On Linux,
read and append opens pin the canonical private state directory with a descriptor,
use `/proc/self/fd`-relative `O_NOFOLLOW` opens, and validate the opened inode with
fstat (regular, current owner, private, single link). Reads use that same descriptor
for size/data; append writers share the same guard. Path replacement cannot
redirect an already pinned open. Bounded allocation happens before acquiring the
read descriptor, and all acquired descriptors have exception-safe cleanup.
Failed inode/path validation uses a keep flag and finally to close the file
descriptor; a closeSync failure is swallowed separately so it cannot replace the
IPC_AUTH mapping or skip that close attempt. A kernel close that does not
release the descriptor is not retried and is not claimed leak-free. The
directory descriptor remains in its existing finally.

This specific guarantee requires Linux O_NOFOLLOW/O_DIRECTORY and procfs; other
platforms fail closed for log access, with no insecure fallback and no new native
platform PoC. It is not a sandbox against arbitrary same-UID native code. Review
fix evidence and exact test/mutation results are in RESULTS.md; independent parent
review is still required.
