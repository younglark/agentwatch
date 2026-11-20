# agentwatch task core — built-in Connect/HTTP adapters

This is modular implementation code, not another generic PoC. It is **not yet a
production-ready runner**. 身份查询和通知由 agentwatch 内建的 Bun HTTP 客户端直接请求；
`grokbot-control` npm-v0.7.0 **只作只读协议参考**，不调用外部 `gbc`，不安装/内嵌它、
官方 App、Node、模型 SDK、ACP、webhook 或 Stop Hook。这里使用的后端契约来自非官方
逆向资料，不是官方公开 API。本轮用合成凭据、临时 HOME 和本地 mock HTTP 验收登录/刷新/共享桌面读取，没有 live，
没有读取真实 ~/.gbc、真实官方 sand-secrets 或钥匙串，也没有连接真实 Cursor 后端。
无可用凭据 → `AUTH_NOT_CONFIGURED`（exit 4），不插任务、不启动 native 命令。
没有生产 fake-verifier flag / `--auth` / `AGENTWATCH_AUTH_MODE` 逃逸。

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
agentwatch login [--state DIR]
agentwatch logout [--state DIR]
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

## 平台写死的鉴权（不做 auto，没有 --auth）

三端都有任务 daemon。鉴权路径按平台写死，没有生产 `--auth` / `AGENTWATCH_AUTH_MODE`。

### macOS：独立鉴权

- 只用 agentwatch 自有凭据。默认 `~/.agentwatch/auth/credentials.json`，或显式
  `AGENTWATCH_CREDENTIALS`。永远不读官方 sand-secrets.json / 钥匙串，即使设置了
  `AGENTWATCH_SECRETS_FILE` / `AGENTWATCH_USER_DATA` 也不会改走共享桌面鉴权。
- `agentwatch login`：确保 daemon，立即把
  `https://cursor.com/loginDeepControl?challenge&uuid&mode=login&redirectTarget=cli`
  打到 stderr（只要链接，不要设备码、localhost 回调或隧道；`cli` 预设不加
  `supportsSelectedTeamLogin`）。无 TTY 时 stdout 一行 pending JSON 后立即返回，由 daemon
  后台轮询；有 TTY 才等待完成。守护进程轮询 `GET {api}/auth/poll?uuid&verifier`：
  404 等待，退避 `1s × 1.2^i` 且上限 10s，最多 150 次，连续 3 次非 404 错误则停。
  website 默认 `https://cursor.com`（`AGENTWATCH_WEBSITE`），api 默认
  `https://api2.cursor.sh`（`AGENTWATCH_API_BASE`）。成功体 `{accessToken,refreshToken}`
  写入自有目录；`403 {error:sign_in_policy_violation}` 为策略拒绝；`xaiAccessToken`
  视为不支持。verifier 不得出现在 stdout / stderr / health / argv。
  每次 HTTP 10s（headers 与 body），总体 20min；有界响应读取且总会清理 reader。
  登录落盘核对持久 generation 与 pending CAS；logout/新 login 后，旧 poll 不得复活会话。
  策略拒绝/超时/连续失败会作废 pending、持久化安全失败状态，后续 login 可生成新挑战。
- `agentwatch logout`：清除自有凭据和 pending login，不碰官方凭据。
- 独立凭证安全检查保留：当前用户所有、普通文件、无 symlink/hardlink、文件 0600、
  父目录 0700、路径不含 `.gbc` 或 `sand-secrets`、最大 16 KiB、有界读取且不回显解析异常。
- 可选字段：`refresh_token`、绑定的 `client_id`、`expires_at_ms`、`account_subject`、
  `session_id`、`revision`、内部刷新关联摘要 `refresh_proof`（不输出）。`client_id` 只来自 `AGENTWATCH_CLIENT_ID` 或
  `AGENTWATCH_OAUTH_CLIENT_ID`（两者都有必须一致）或登录/刷新时持久化绑定；绝不内置，
  不从 JWT / App / 包内常量猜。仍有效的 access token 在没有 client_id 时可继续用；
  只有必须 refresh 且缺 client_id 才 `AUTH_NOT_CONFIGURED` / exit 4。
- Refresh：`POST new URL("/oauth/token", backend)`，JSON
  `{client_id, grant_type:"refresh_token", refresh_token}`，`redirect:error`，20s
  截止。缺 `access_token` 不算成功；缺少新 `refresh_token` 则保留旧的。在 JWT `exp`
  前 300s 刷新。跨进程 OS 咨询锁（Linux OFD / macOS flock）+ 进程内 singleflight；
  旧凭据若缺可选 session_id，以完整规范化旧凭据快照的 SHA-256 推导稳定迁移 ID，
  仅刷新成功时保存（失败不改原文件）。复用 peer 结果不能只比较 session/subject：
  每次成功刷新在同一自有凭据文件写入 `refresh_proof={parent,result}` 摘要，绑定完整规范化
  旧快照（含旧摘要）、登录 generation、显式 client_id，以及完整新结果（仅排除摘要自身）。
  等待者只能采用原样未变的快照，或可核对上述关联的直接 peer 后继；backend/client 必须
  保持绑定，session_id 必须保留/按旧快照迁移；已有 subject 绝不能改变或删除，原先未绑定
  时只允许补齐为新 access JWT 的 sub。没有证明、结果被改、跨 generation 均失败关闭。
  关联只支持直接一次轮换，不保留祖先链；若错过多次轮换、无法证明关联，旧请求失败，
  不猜测采用新会话。摘要不是远端账号签名，也不是模糊交换恢复记录。
  刷新 exchange 锁与短 mutation 锁分开（固定 exchange→mutation 顺序），网络期间 login/logout
  可前进；锁下重读，按 session/revision/token 与持久 login generation CAS 原子写入。
  旧 refresh 撤销只条件清理匹配的旧凭证，绝不删除新 pending/generation；只有显式 logout
  撤销相应登录。锁文件不 stale-break、不 unlink。`shouldLogout` / 撤销不回退旧
  token（即便响应为 429/5xx，明确撤销也最高优先）；网络 / 5xx / 429 / 超时保留凭证，
  若旧 access 仍在有效窗内可继续使用。20s 期限覆盖 headers 与 body；响应体超时/连接中断
  同样记为模糊交换，不吞为 malformed。不明交换后的 `invalid_grant` 只有在没有明确
  shouldLogout/策略拒绝时才按同 session/refresh-token 的模糊保护窗保留凭证。
  **该保护仅在同一进程内保留 120 秒，未持久化，不保证跨进程/重启保护**：另一进程或重启后，
  若交换实际已轮换 token，旧 refresh token 可能返回 invalid_grant，届时需重新登录。
  已绑定 account subject 时，新 access JWT 必须
  带匹配的 `sub`，缺失/opaque 也拒绝转换。写 RPC（通知发信）在不确定时绝不因 refresh 自动重放。
- 更换鉴权锁协议前应先停止旧 daemon，不混用旧/新二进制对同一凭据目录写入。
- Windows 上不会使用这条独立鉴权路径。独立凭证的 Windows ACL 仍未实现。

### Linux / Windows：共享桌面鉴权

- 只读官方 Grok Bot 的 `sand-secrets.json`，解密后使用 access token。默认优先稳定版
  「Grok Bot」，否则 「Grok Bot Research」。Linux 在 `$XDG_CONFIG_HOME` 或 `~/.config`
  下；Windows 在 `%APPDATA%\Grok Bot`。测试可用 `AGENTWATCH_SECRETS_FILE` /
  `AGENTWATCH_USER_DATA` 指向临时 fixture。
- **绝不 refresh、绝不回写**官方文件或钥匙串。文件里即使有 refresh cipher 也不会拿去
  `POST /oauth/token`，以免踢掉桌面应用登录。
- 凭证缺失、解密失败或 access 已过期 → `AUTH_NOT_CONFIGURED` / exit 4，提示先打开并
  登录官方 Grok Bot，不退回独立鉴权。
- 在 Linux / Windows 调用 `login` / `logout` 必须失败（exit 4），并提示用官方桌面登录。
- Connect 后端由 `AGENTWATCH_API_BASE`（默认 `https://api2.cursor.sh`）提供，属于
  daemon 启动时的 env 快照；凭证文件则每次请求重读。
- Linux 可用 Chromium basic_text 公开密码 `peanuts`（以及会话内 `secret-tool`）解密
  OSCrypt v10/v11。Windows 已实现同用户 DPAPI 与匹配应用 Local State 的 OSCrypt-GCM；
  密文只通过 PowerShell stdin，不进入 argv。Linux 上用注入 DPAPI + AES-GCM 夹具验收，
  **未在真实 Windows 上验证**；未注入时非 Windows 宿主失败关闭，不冒称 native 验收。
- 官方凭据目录不一定是 0700/0600；本工具不对官方文件做与自有凭证相同的权限强制，
  但会拒绝 secrets 路径上的 symlink，并限制读取大小。

`backend` 仅 HTTPS origin，本地 mock 额外允许 `http://127.0.0.1` / `[::1]`。已运行
daemon 的 env 是启动时快照，独立凭证或官方 secrets 文件则每次请求重读。仅改 shell
env 须先停止原 daemon 再启动。health 在凭证就绪时为 `bot_verifier:connect_http`、
`notification_transport:connect_http`，否则 `not_configured`。这不证明远端已登录或
bot 权限有效。`test_only` 仅独立 testhost 使用。refresh_token / verifier / access
token 不会进入 stdout、stderr、health 或 argv（登录链接里的 challenge/uuid 是协议需要
的公开查询参数，可以出现在 stderr 的 URL 中）。

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
3 秒整体期限包含等待鉴权与请求/响应读取；已取消不启动 refresh，caller 取消只放弃自己的
等待，已开始的共享 refresh 可后台写回成功旋转。响应流解码后最大 1 MiB、禁重定向，结束/超限/取消均释放
响应 reader。不依赖 PATH，不启动网络 CLI，无 token argv，不转发后端异常或原始错误体。
契约来源与 JSON/枚举映射见 `evidence/direct-http/upstream-contract.md`。

## 通知：持久 outbox + 内建直接请求（仅 mock 验收）

终态与稳定 `event_id = task_id:terminal:1` 同事务落盘；先事务 claim inflight，再发 HTTP。
首次 claim 生成并持久化 message_id；稳定 ID 只是关联键，**不是已证明的远端去重键**。
直接 POST 到同一 service：

- `SendGrokBotUserMessage`：`agentId,messageId,sessionId:"",text,sentAtMs`；int64 时间按
  protobuf JSON 十进制字符串发送。空 sessionId 沿用参考请求的默认未报告会话，不猜 ID。
- `GetGrokBotSendStatus`：`agentId,messageId,sessionId:""`，仅 unknown 时最多一次只读对账。

发给目标 bot 的默认终态通知 text 是便于阅读的 Markdown。开头仍是简体中文标题与既有
有界字段：state、task_id、event_id、exit_code，以及非空的 error_code（空则省略该行；
succeeded=任务已成功、failed=任务失败、cancelled=任务已取消、unknown=任务状态未知）。
随后分节附原始 stdout 和 stderr，不做各家 JSON 事件流专用解析，不脱敏。每路最多保留
4 KiB（头尾合计，按字节截断）；超限时保留开头和结尾，中间写明省略字节数。空文件或缺失
日志（含 spawn 前失败、可能尚未创建日志）保留小节标题并写「（无输出）」，不附查询说明。
权限/IO 等读取失败不伪装成无输出，而是写「输出读取失败，无法生成预览」，并仍附本机路径
与 `logs` 查询；正文不泄露原生 error、栈或 `IPC_AUTH` 文案。输出用可变长度 fenced
code block 原样嵌入，内容含反引号时加长围栏；主机名、路径和命令用按内容加长的 Markdown
行内代码，避免路径中的反引号拆破标记。该路被截断或读取失败时，附任务运行主机的操作系统
主机名、该路日志文件的绝对路径（`<state>/<task_id>.stdout` 或 `.stderr`）以及仅针对
当前平台的可运行命令：Linux/macOS 标注为 POSIX shell 并用 POSIX 单引号，Windows 标注为
PowerShell 并用 PowerShell 单引号（`'` 写成 `''`），不把 POSIX 引号冒充为跨平台写法。
命令形如
`agentwatch logs <task_id> --stream stdout|stderr --offset 0 --limit 65536 --state <实际绝对state>`；
并说明若返回 `truncated` 为 true，把 `--offset` 改成 `next_offset`。未截断的短输出不附
查询说明。不以 cat 私有日志为官方入口，也不新增 logs
参数。不发送 argv、cwd、request_id、原始异常、token、report 文件或总结；完整日志仍留本地。
内部 outbox payload 仍以结构化 JSON 存储；CLI 的 run/status/logs/wait/cancel 默认仍是
一行 JSON，`--json` 保持兼容。通知失败不改任务结果，wait 只等待任务终结。

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
  写 RPC 不会因为 refresh 自动重放；本地凭据加载失败保留 pending/NOT_CONFIGURED，不丢 outbox。
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

本轮源码与编译合约均使用本地 loopback Connect mock + 临时 HOME。Linux 生产路径用
合成 sand-secrets（peanuts OSCrypt）夹具；macOS 独立登录/刷新在源码测试里注入
`darwin`，不走生产 `--auth` 逃逸。PATH 只含 native shell fixture（编译测试没有工具链
且暂移源码）。没有真实登录、真实 refresh、真实后端请求、真实 bot 发信、真实 ~/.gbc /
官方凭据 / 钥匙串读取，或四家 CLI E2E。

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

Live identity/target/send verification, live browser login and live OAuth refresh,
durable ACK/deduplication evidence, further reconciliation UX, four-vendor E2E,
production process-tree cancellation (.cmd / Windows included), redaction policy
for potentially sensitive native output, disk retention, upgrades/distribution,
macOS flock / Windows LockFileEx live lock tests, and full multi-user/Windows ACL
hardening remain unfinished or unverified here. Windows decryption is implemented
but only fixture-tested, not native-verified here. No
production ready/supported-platform claim follows from Linux-only tests.

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
