# agentwatch task core — external gbc adapters

This is modular implementation code, not another generic PoC. It is **not yet a
production runner**. 生产身份门闩通过独立安装的 `gbc`（`npm-v0.7.0`
契约）执行只读目标查询；本轮仅以 mock gbc 验收，不代表 live 身份验证已通过。
无可执行 gbc / 无凭据仍返回 `AUTH_NOT_CONFIGURED`（exit 4），不插入任务。
没有生产 fake-verifier flag / 环境开关；不读取官方 App 凭据，不内嵌 gbc、
非公开协议、App 二进制、模型 SDK、ACP、webhook 或 Stop Hook。

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

## 外部 gbc 身份门闩（本轮实现）

1. 操作者先自行独立安装/登录 `grokbot-control` 的 `npm-v0.7.0` 版本，并让
   Linux daemon 的 PATH 能定位可执行的 `gbc`（及 gbc 所需的 Node 运行时）。
   `agentwatch` 不安装 gbc、不启动浏览器、不提供 `auth login`，也不接收 token 参数。
   `gbc` 自己使用其已有凭据存储（默认 `~/.gbc`）；agentwatch 不直接读取它。
   daemon 继承启动时的 HOME/PATH；已运行 daemon 不会采用后来 shell 的环境更改。
2. 每个新任务入账前，和实际 native spawn 前，分别执行一次：
   `gbc --json bot get --agent-id=BOT`。`--bot` 必须是精确 `agent_id`，不是名称或
   numeric server id；即使 gbc 自身支持 server id，agentwatch 仍核对返回的 agent_id。
   gbc 的 get 实质是 `ListGrokBotAgents` + 本地筛选，不是独立 GetBot RPC。
3. 校验 `schema_version:1.0.0` 结果封套、退出码、`known_success`、`code:ok` 与
   `data.bot.agent_id`。拒绝 `simulated:true`，子进程环境移除 `GBT_MOCK*` 和
   `GBT_ALLOW_WRITES`；生产 IPC 中伪造 `testOnly` / `verifier:fake` 也无效。
   PATH 上的 gbc 是操作者信任的外部程序，本门闩不是对恶意同 UID 程序的认证或沙箱。
4. 缺失/不可执行、gbc auth/unauthenticated → exit 4；另对 exit 9 的合法
   `known_failure`、非 retryable 封套，精确识别 `auth_revoked`、
   `auth_refresh_unconfigured`、`auth_refresh_client_mismatch`、
   `auth_refresh_subject_mismatch` 为 `AUTH_NOT_CONFIGURED` / 4。
   这是 gbc 保留结构化凭据错误后经 emitResult/mapExitCode 得到的退出码；
   不把其它 exit 9 或任意 auth 前缀码当鉴权错误。not_found、denied/
   permission_denied、返回别的 agent_id → `BOT_FORBIDDEN` / 5；unknown outcome
   （包括列表截断）→ `UNKNOWN` / 10；非 JSON、封套不匹配、其它查询失败、3 秒超时、
   任一流超出 1 MiB → `TRANSPORT_NOT_CONFIGURED` / 8。所有入账前失败均零任务行。
   入账后第二次核验失败会保留任务行并标记 failed，绝不启动 native 命令。
5. gbc 成功从 stdout 解析，失败从 stderr 解析；不原样转发这两路、异常、token 或
   刷新令到输出/日志，不在 argv 放秘密。stdin 关闭；无 shell 拼接。
   成功复用 request-id 返回历史任务的幂等语义不变，不会因此重启任务。
6. 内部 health：可定位 gbc 为 `bot_verifier:gbc`，否则 `not_configured`；
   这里只反映适配器可用性，不等于凭据有效或 bot 有权限。只有独立 testhost 才报
   `test_only`。生产 `notification_transport` 同样只反映 gbc 可定位性；testhost 未配置发送。

契约依据：[npm-v0.7.0 README](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/README.md)、
`dist/cli/{main,io,config}.js`、`dist/{errors,dto/result,ops/bot}.js`、
`dist/connect/client.js`、`dist/auth/provider.js`。
这是用户选定的非官方逆向控制面，**不是官方公开 API**。本轮没有 live 登录、
OAuth 刷新、真实 bot / 团队绑定或四家 CLI E2E 验证；不因 mock 测试通过而声称已验证。
通知 transport 的当前实现与界限见下节。二进制只含 agentwatch 本体与现有依赖，
不打包 gbc/Node；测试的 mock gbc 和 claude 是 `/bin/sh` 内建命令 stand-in，
PATH 仅含每例私有 mock 目录，无系统工具链泄入。

## 通知：持久 outbox + 外部 gbc（仅 mock 验收）

任务终态与稳定 `event_id = task_id:terminal:1` 在同一事务落盘。通知 worker 独立于
执行 worker；通知失败不改变任务 succeeded/failed/cancelled/unknown，也不改变 wait
的任务退出语义。status/wait 的 `notification` 显示状态、event_id、message_id、
attempts、next_attempt_at、reconciliation_attempts、last_code、receipt、
needs_reconciliation 与 `durability:unverified`。

| 通知状态 | 只说明什么 |
|---|---|
| pending | 未发送；可能无 gbc，或有明确未 dispatch 的可重试证据、正在退避 |
| inflight | 已持久 claim，外部写可能进行中；不意味着已接受 |
| accepted | gbc 的已知接受路径／duplicate，或只读 send status 报 accepted；不是已读、持久入箱或任务业务成功 |
| rejected | 明确 delivery=refused，或只读 send status 报 rejected；不重发 |
| not_dispatched | 合法 known_failure 明确 rpc_dispatched=false；非重试错误或三次预算已用完 |
| unknown | 可能已写，必须对账；不能自动重发。needs_reconciliation=true |

### 发什么、怎么发

只调用已经核对 `npm-v0.7.0` 的 CLI：

```text
gbc --json --allow-writes message send --agent-id=BOT --message-id=MESSAGE_ID --text-stdin
gbc --json message status --agent-id=BOT --message-id=MESSAGE_ID
```

正文从 stdin 传一行已冻结的有界 JSON：version、event_id、task_id、state、exit_code、
error_code。error_code 仅本体白名单，正文不含 argv、cwd、request_id、stdout/stderr、
原始异常、token 或报告文件内容。本轮不采集 AGENTWATCH_REPORT_FILE，不做总结。
message_id 在首次 claim 事务内生成并持久化；稳定 ID 供关联/对账，不是远端去重证明。
不传 session-id、不猜默认会话或 team id；gbc 返回的 default_unreported 也不是服务端
确认的 session ID。发往任务已记录的目标 bot，不新建 bot，不重跑源任务。

接收必须匹配 agent_id/message_id、非 simulated、合法封套/退出码和已核枚举对：
accepted_box/1、accepted_temporal/2、duplicate/3；refused/4 明确拒绝。
receipt 只保留 delivery/dispatched/workflow_id 等白名单字段，或 send status 的
status/status_code/echo_entry_id/rejection_code/accepted_at_ms。过长或明显凭据形态的
标识符置 null，未截短后冒充原始回执；拒绝原因原文、notes、额外响应字段不回显。
这不是完整原始 HTTP 回执。dispatched 是消息工作流字段，**不等于 RPC 未发送证据**。

### 重试、崩溃与对账

- 唯一可自动重试路径：失败封套 known_failure、无 data、显式
  error.details.rpc_dispatched=false、retryable=true、gbc exit 8。最多三次
  （总尝试数），间隔 250ms/500ms，持久化下一次时间；重启不重置预算。
- 超时、进程崩溃、响应丢失/坏 JSON、超限、unknown、模拟响应、身份不匹配或可能已
  dispatch，一律 unknown，不自动重放写。即使 error 自称 retryable 也不能绕过此规则。
- 发送前先提交 inflight；重启把 inflight 改 unknown。accepted、rejected、unknown、
  not_dispatched 均不会被当作 pending 重发。旧 delivered 布尔列保留但不复用含义：
  迁移 002 把旧 0 保留 pending，旧非 0 记 unknown/LEGACY_DELIVERY_UNVERIFIED；
  没有伪造 message_id 或 accepted。001 checksum 不改，未知迁移仍拒绝。
- 有 message_id 的 unknown 最多做一次自动只读 message status（持久记录尝试）。
  accepted/2 或 rejected/3 可更新接受路径分类；not_found、pending、unknown_durability、
  查询失败/超时/不匹配都仍 unknown，**从不因查不到就补发**。历史布尔标记无 message_id
  则无法自动查。未抓取 history/transcript，避免无关内容读取和模糊匹配。
- 自动查询可能早于服务端最终可见性；本轮没有后续手工「重新对账/覆盖结论」命令。
  status 持续展示未知与稳定 message_id；操作者可独立运行上面的只读 gbc status，
  但该外部查询不会自动回写本地账本。这是刻意保守的剩余缺口，不是持久 ACK 证明。

gbc 子进程 stdin 关闭，无 shell；每次超时 3 秒、stdout/stderr 各限 1 MiB，异常与
原始两路输出不转发。drain 停止新领取，杀掉当前 gbc 进程并观察 close、持久化未知，
不无限等待网络；尚未发送的 pending 保留。没有 gbc 时不 claim，不丢 outbox；以后
可定位到 gbc 再处理 pending。进程树取消与恶意同 UID 程序仍不是本轮保证。

本轮只在临时 HOME/PATH 的 mock gbc 上验证；没有真实发送、登录、读取真实 ~/.gbc、
后端请求、OAuth 刷新或四家 E2E。服务端稳定 ID 去重与持久入箱 ACK 仍未证明，
不承诺 exactly-once，也不把 accepted_box 的名字当持久性证明。

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

Live gbc identity/target/send verification, durable ACK/deduplication evidence, further reconciliation UX, four-vendor E2E,
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
