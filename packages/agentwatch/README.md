# agentwatch task core — first implementation slice

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
- Status/returned tasks show notification state and `transport:not_configured`;
  a terminal outbox row is only pending, not a delivery receipt. Wait success only
  describes process termination, never vendor business/permission success.
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
   `test_only`。`notification_transport` 仍是 `not_configured`。

契约依据：[npm-v0.7.0 README](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/README.md)、
`dist/cli/{main,io,config}.js`、`dist/{errors,dto/result,ops/bot}.js`、
`dist/connect/client.js`、`dist/auth/provider.js`。
这是用户选定的非官方逆向控制面，**不是官方公开 API**。本轮没有 live 登录、
OAuth 刷新、真实 bot / 团队绑定或四家 CLI E2E 验证；不因 mock 测试通过而声称已验证。
通知 transport 已获准在后续实现，但本轮未做。二进制只含 agentwatch 本体与现有依赖，
不打包 gbc/Node；测试的 mock gbc 和 claude 是 `/bin/sh` 内建命令 stand-in，
PATH 仅含每例私有 mock 目录，无系统工具链泄入。

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

Live gbc identity/target verification, notification transport/ACK/retries, four-vendor E2E,
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
