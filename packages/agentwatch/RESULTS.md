# t185：内建直接 Connect/HTTP — current

2026-11-20，Asia/Shanghai。固定基线 `c378e8f`；用户明确纠正 gbc 仅作参考。
本节和 README 为当前边界；以下所有 t183 外部 CLI 章节只保留历史证据。

## 结果与保持的语义

- 删除 `gbc-verifier.ts`，没有生产 `execFile`/`Bun.which('gbc')`/SDK 运行依赖；新
  `connect-client.ts` 共用有界 HTTP/安全自有凭据加载，`connect-verifier.ts` 负责精确
  bot 权限映射，notifications 改直接请求，不改原有任务/outbox 事务与状态迁移。
- 直接 POST `aiserver.v1.GrokBotService/{ListGrokBotAgents,SendGrokBotUserMessage,
  GetGrokBotSendStatus}`。使用 Connect unary JSON 和 Schema 校验，而不是 CLI 结果封套。
  protobuf int64 为十进制字符串，枚举从固定参考 schema 映射；不猜 team/session/client id。
- 身份查询仍在入账前/启动前两次执行，精确 agentId 匹配；六个结构化 auth 码和本地缺
  配置映射4、禁止/完整列表缺失5、截断缺失10、其它坏响应/传输8。不存在生产 fake bypass。
- 自有默认 `~/.agentwatch/auth/credentials.json`，或显式 `AGENTWATCH_CREDENTIALS`；
  version/backend/access_token/expires_at_ms + client_id。client_id 只文件绑定或显式
  `AGENTWATCH_CLIENT_ID`，冲突拒绝。未内置/推导值，未导入旧凭据。
  文件/目录 owner+私有权限、单链接、无 symlink（含祖先）、no-follow、同 fd 有界16KiB读取；
  HTTPS origin 绑定，只有 numeric loopback mock 允许 HTTP；Windows ACL 未实现则失败关闭。
- 3s绝对请求/响应读取超时、流读取1MiB上限、禁redirect、reader finally取消/释放、AbortSignal
  贯穿发送/对账/drain。秘密只在私有文件与 Authorization 内，不进 argv/诊断，不回显后端body。
- 通知继续先持久claim inflight；终态不被通知结果污染；崩溃inflight→unknown、可能已dispatch
  不重放、unknown最多一次先持久登记的只读status、durability恒unverified。六字段冻结正文
  不含日志/argv/cwd/token/request_id/report；receipt只有有界白名单。
- 必须区分旧CLI的**本地**预请求证据和现在的**远端**错误体：HTTP发出后，即使对端自称
  rpc_dispatched:false/retryable，也维持unknown，不自动重放。公共worker保留可注入的本地
  明确未dispatch+可重试结果，三次总预算和250/500ms退避落盘，engine/store seam验证。
  当前生产直接适配器没有refresh/本地瞬态重试源，不伪称网络安全重试已实现；本地凭据失效
  保留pending/NOT_CONFIGURED。无凭据时available=false，不领取、不丢outbox。
- health/通知transport用 `connect_http` 或 `not_configured`；生产不再报gbc/test_only。

## TDD / 回归证据

只用既定公共 command-contracts / compiled 及 core engine/store seams：

- lookup-red/green：有安全合成凭据和本地HTTP、PATH没有gbc，旧实现4→直接查询放行。
- notification-red/green：直接接受回执、冻结请求字段、稳定message_id/重启不重发。
- retry-red/green：移除外部CLI后，有证据的本地DI重试预算从无界pending红到三次退避绿；
  非重试结果一次终结。初次测试超时不作为最终red，重跑后用实际pending/预算断言失败证据。
- hardening-red/green：hardlink/祖先symlink、200里伪错误封套、accepted与refusal矛盾先红后绿。
  硬化测试green后曾出现TS平台分支收窄错误，最终简化POSIX检查后完整typecheck通过；
  中间失败不作为正式通过证据。
- 更广矩阵：六种auth码在入账前/启动前、别名拒绝、列表截断、坏JSON/错类型/未知枚举、
  超时/超限/redirect、401/503与伪未dispatch/矛盾/CLI封套、credential在两处丢失、
  crash-inflight、只读接受/拒绝/未决/未知持久性、查询失败只一次、发送/查询drain取消、
  无凭据pending跨重启和恢复、回执秘密形态过滤。旧核心/迁移/取消/日志契约保留。
- 主夹具是父测试进程中的真实loopback HTTP服务和合成私有文件，不是mock gbc；
  compiled复制二进制、隔离HOME/PATH/cwd并暂移源码，只保留native /bin/sh fixture。
  一个故意失败的gbc PATH陷阱仅用于证明它不会被调用。

正式完整 `bun run verify` **exit 0**（含typecheck、源码、重建两产物、编译验收）；
原spike独立完整 `bun run verify` **exit 0**，两包typecheck均通过：

| 套件 | pass / fail | expect calls | 实测时间 |
|---|---:|---:|---:|
| 正式源码 | 101 / 0 | 685 | 88.44s |
| 正式编译 | 78 / 0 | 580 | 37.07s |
| spike源码 | 11 / 0 | 194 | 28.41s |
| spike编译 | 11 / 0 | 193 | 10.46s |

日志、固定参考契约、环境、二进制SHA256/大小均在 `evidence/direct-http/`。
Bun1.4.4；生产产物109,959,344 bytes，test-host109,648,048 bytes。
cleanup-audit显示无本轮存活fixture/daemon进程，源码已复原；spike hard-crash测试的
safety cleanup如实记录在日志，不冒充正常停止成功。没有改迁移SQL/checksum或依赖清单。

## 未做 / 不得声称

没有真实后端请求、真实登录、真实发送、真实 ~/.gbc/官方App/keychain凭据读取，未live
验证JSON端点兼容性、token刷新、bot/团队绑定、四家CLI E2E。浏览器登录/refresh命令本轮
明确后置，当前仅能使用安全预配置有效token；过期失败关闭，不提供静默导入/刷新。
不声称远端去重、持久入箱ACK、已读或业务成功；稳定本地ID和accepted/duplicate不证明这些。
Windows ACL、跨平台/进程树取消、日志保留/脱敏、发行升级和人工再次对账UX仍未完成。
只完成自审与机械验收，尚待父代理独立复审；不push/PR/merge/发布。
尝试本地commit时因仓库未配置author identity失败；未猜测/更改身份，全部改动已stage，
HEAD仍是c378e8fa4921bf2f544229aa27cfd9116c1074af，请用cached diff复审。

---

# t183 后续：外部 gbc 通知 transport 与持久状态 — historical

2026-11-20，Asia/Shanghai。固定基线 `a9cb935f2a67e659f5f5cc93845fcc4227ee6eb6`。
身份适配已独立审查后继续本切片。只实现/测试外部 CLI 通知与本地状态，没有真实发送。
旧章节里的「通知未实现/搁置」均为历史；本节与 README 描述当前边界。

## 实现结果

- 新 `src/notifications.ts`：独立于任务执行的通知 worker，通过外部 gbc 的已核 CLI
  message send + --text-stdin 发送六字段冻结结果 JSON，只读 message status 对账。
  不发日志、argv、cwd、报告文件或 request_id；不总结、不读取 history/transcript。
- 新 `migrations/002.sql` 与 storage 公共方法：显式 pending / inflight / accepted /
  rejected / not_dispatched / unknown；claim 先持久化，再启动外部副作用；稳定本地
  event_id 不改，message_id 仅首次生成。001 内容/checksum 不变，旧库逐版校验升级。
  旧 delivered 列不重用：0 → pending，非 0 → unknown/LEGACY_DELIVERY_UNVERIFIED。
- 启动恢复 inflight → unknown；accepted/unknown 不重发。unknown 有 message_id 时
  最多一次持久记录的自动只读 send status；accepted/rejected 可更新接受路径分类，
  其它结果维持 unknown，不会因 not_found、pending、unknown_durability 而补发。
- 唯一可重试路径是 known_failure、无 data、rpc_dispatched:false、retryable:true、
  gbc exit8；三次总预算，250/500ms 退避，预算和时间落盘。矛盾、未知或可能已写不重试。
- status/wait 公开独立通知状态、计数、下次时间、有限白名单 receipt、last_code、
  needs_reconciliation；durability 永远 unverified。任务终态/退出码不受通知失败影响。
- 3 秒超时、stdout/stderr 各 1 MiB，stdin 结束，无 shell，无 token 参数；不回显原始
  两路输出、错误详情、refusal.message 或多余响应字段。明显凭据形态/超长 receipt ID
  省略为 null，不截短后冒充原始值。drain abort 当前发送/查询进程，观察 close 后落盘。
- health.notification_transport 在可定位外部 gbc 时为 gbc，否则 not_configured；
  testhost 未配置发送，仍 not_configured。bot_verifier 既有语义与 fake 防绕过保持。

上游路径/参数/枚举/结果封套及 OpenCode 失败机制差异见
`evidence/notifications/upstream-contract.md`，只读核对 npm-v0.7.0，没有运行真实 gbc。

## TDD 与完整验证

迁移、接受、拒绝、明确未 dispatch、有界安全重试、inflight 恢复、只读对账、其它
接受枚举、回执保密、矛盾 non-dispatch 证据均先实际 red，再最少代码 green。
red/green 日志保存在 `evidence/notifications/`。迁移测试初始建旧表语句的占位数修正，
及旧「更新所有迁移行为999」在双版本下的主键冲突，均在最终验收前修正；不是通过证据。
没有新私有函数测试；仍只用约定 core/store、公共 CLI/IPC 与编译 seams。

新增 25 个共享源码/编译 CLI 契约与 1 个历史库迁移测试，覆盖：接受回执持久化与重启
不再发送、拒绝不污染任务、未 dispatch 分类、三次预算、崩溃未知不重放、只读接受/
拒绝/未决/未知持久性、超时/丢响应/坏 JSON/双流超限/模拟/错 ID/矛盾证据不重放、
缺 gbc 保留 pending 且恢复后可发送、发送/查询 drain 都有界且进程消失、秘密不外发。
mock shell 内建命令计数，临时 HOME/PATH；编译测试复制二进制、隔离 cwd 并暂移源码。

正式包和原 spike 均完整 `bun run verify`，exit **0**；两包类型检查通过：

| 套件 | pass / fail | expect calls | 实测时间 |
|---|---:|---:|---:|
| 正式源码 | 77 / 0 | 515 | 59.25s |
| 正式编译 | 56 / 0 | 428 | 28.57s |
| spike 源码 | 11 / 0 | 194 | 27.41s |
| spike 编译 | 11 / 0 | 194 | 10.80s |

日志：`evidence/notifications/{verify,spike-regression}.log`。
Bun 1.4.4；生产二进制 109,959,344 bytes，独立 test-host 109,643,952 bytes；
SHA256 见同目录 artifacts.txt。任务进程审计无残留，见 cleanup-audit.json。
这是 Linux/procfs 和 /bin/sh 内建 mock 的验收，不是跨平台或干净 VM 证明。

## 未覆盖与故意保守的缺口

- 没有真实发送、登录、真实 ~/.gbc/官方凭据读取、后端访问、OAuth 刷新、真实 bot/
  团队绑定、四家 CLI E2E、progress、report 文件采集或 summarize。
- 服务端稳定 ID 去重和持久入箱 ACK 未证明；不承诺 exactly-once，不把 accepted/
  duplicate/accepted_box、echo、accepted_at 当已读或任务业务成功，也不声称完整原始
  HTTP receipt 已捕获。
- 自动只读对账只一次，可能早于远端最终可见；后续本地结论覆写/再次手工对账命令
  未实现。status 保留未知和关联 ID；外部人工 gbc status 不会自动回写本地账本。
- 不验证恶意同 UID 替换 gbc、任意同 UID 篡改库、进程树取消、Windows ACL、日志保留
  和分发升级；PATH 上外部 gbc/Node 仍由操作者信任与维护。

未 push / PR / merge / 发布；本地单独提交后停止扩展，等待父代理独立复审。

---

# t183 独立审查 P2：结构化鉴权错误映射修复 — historical

2026-11-20，Asia/Shanghai。固定基线 `94dd83de453ae1eae7617110897ed9c0f13ec3e3`。
本轮仅修独立 Spec 审查发现的 P2，不实现通知、不改变外部 gbc 边界。

## 核验与修复

重新只读核对 `npm-v0.7.0` 的 `dist/connect/client.js`、`dist/auth/provider.js`、
`dist/errors.js`，并对照已读的 bot.fromErr / emitResult：四个结构化凭据错误会被
保留在失败封套里，emitResult/mapExitCode 对其 known_failure + 非 retryable 结果
返回 **9**，不能仅按 auth/unauthenticated 的 exit 4 识别。
精确来源链记录在 `evidence/gbc-auth-review/upstream-contract.md`。

修复新增精确白名单：auth_revoked、auth_refresh_unconfigured、
auth_refresh_client_mismatch、auth_refresh_subject_mismatch，仅当 gbc exit 9、
非模拟、ok:false、known_failure、retryable:false 时映射为 AUTH_NOT_CONFIGURED / 4。
保留 unknown 与 simulated 优先拒绝，不泛化全部 exit 9 或任意 auth 前缀。
无新增凭据读取、登录、协议/RPC、后端访问或通知代码。

## TDD 与公共契约验收

四个码逐个加入同一公共 CLI contract，分别先观察 **8 而非预期 4** 的 red，
仅加入对应码后 green。每个 green 12 assertions：入账前返回4且该 request_id 零行；
入账后、启动前失败保留任务并记 AUTH_NOT_CONFIGURED，pid 为 null，native fixture
未启动；合成秘密不进入 stdout/stderr 或私有诊断日志。该契约由源码与编译测试共用。
每码的 red/green 日志均保留在 `evidence/gbc-auth-review/`。

另补三项负向回归：unsupported + exit9、未知 auth 前缀 + exit9、retryable 的
refresh network 错误，均维持 TRANSPORT_NOT_CONFIGURED / 8、零入账，不误判为 auth。

最终正式包 `bun run verify` **exit 0**（含型别检查、源码测试、重建两个二进制、编译契约）：

| 套件 | pass / fail | expect calls | 实测时间 |
|---|---:|---:|---:|
| 正式源码 | 51 / 0 | 326 | 27.21s |
| 正式编译 | 31 / 0 | 242 | 12.66s |

完整日志 `evidence/gbc-auth-review/verify.log`。生产产物 109,947,056 bytes。
编译验收继续隔离 HOME/cwd、仅 mock 目录的 PATH、暂移源码；没有真实凭据或后端。
未修改 spike，本轮未重跑 spike（上一阶段结果仅保留为历史）。

health 字段不变：gbc 可定位为 gbc，否则 not_configured；test_only 仅 testhost；
notification_transport 仍 not_configured。仍不声称 live OAuth 刷新、真实 bot/团队绑定、
四家 E2E 或通知完成。进程审计见同目录 cleanup-audit.json。
单独本地提交，不 amend、不 push、不发布；修复后等待父代理复审。

---

# t183 外部 gbc 身份门闩 — historical

2026-11-20，Asia/Shanghai。固定基线：`b41b4d50b8582744e595a8d3b740dbe9f41a4867`。
仅实现生产身份门闩；通知 transport 虽已解禁，但本轮未实现。下面旧阶段的
「verifier 未接通 / 通知搁置」是历史记录，当前边界以本节与 README 为准。

## 实现与契约来源

只读核对 `younglark/grokbot-control` 的 `npm-v0.7.0` tag README、
`dist/cli/{main,io,config}.js`、`dist/{errors,dto/result,ops/bot}.js`。
外部 argv 固定为 `gbc --json bot get --agent-id=BOT`；gbc get 是
ListGrokBotAgents + 筛选，并支持 server id，因此本体另做精确 agent_id 复核。
无依赖新增，不打包 gbc、协议或 App；不另造登录/List/Connect RPC。

- PATH 缺失/不可执行、auth → 4 / AUTH_NOT_CONFIGURED；not_found、权限拒绝、
  agent_id 不匹配 → 5 / BOT_FORBIDDEN；unknown outcome → 10 / UNKNOWN。
- 超时（3 秒）、非 JSON、异常封套、超 1 MiB 输出、其余查询错误 →
  8 / TRANSPORT_NOT_CONFIGURED。所有入账前失败均断言对应 request_id 零行。
- 仅 known_success + code ok + exit 0 + 相符 agent_id 放行。拒绝 simulated，
  删除子进程 GBT_MOCK* / GBT_ALLOW_WRITES。保留入账与启动前两道 verify。
- health：有可执行 gbc 报 gbc；无则 not_configured；testhost 独占 test_only。
  notification_transport 始终 not_configured。gbc 存在不代表登录已有效。
- 不转发 gbc 原始 stdout/stderr/error，不读其 store 或官方 App 凭据，stdin 关闭。

## TDD 与最终核验

逐片实际观察 red→green：auth 查询收据缺失；not_found 原得 8 需 5；
成功原得 8 需 0；unknown 原得 8 需 10；permission_denied 原得 8 需 5。
每片随后单文件运行通过；中途一次型别检查发现 execFile error.code 的 string|number
收窄问题，修正后通过。这些 red 是运行时控制台记录，不伪称保留了 red 日志文件。
随后补充 exact id/伪造 IPC、模拟环境、坏响应/超时/超限、无执行权限、帮助文本保密、
启动前凭据失效等公共 CLI 契约回归；未测试私有 verifier 函数或 mock 内部协作者。

最终执行正式包和原 spike 的 `bun run verify`，二者 exit 0：

| 套件 | pass / fail | expect calls | 实测时间 |
|---|---:|---:|---:|
| 正式源码 | 44 / 0 | 260 | 21.72s |
| 正式编译 | 24 / 0 | 176 | 10.36s |
| spike 源码 | 11 / 0 | 193 | 25.75s |
| spike 编译 | 11 / 0 | 193 | 10.41s |

两包型别检查通过。日志：`evidence/gbc-verifier/{verify,spike-regression}.log`。
生产二进制 109,947,056 bytes；独立 test-host 109,631,664 bytes。
编译契约复制二进制到隔离 cwd、暂时移走源码；每例 HOME 私有、PATH 仅有该例
初始为空的 mock 目录。mock gbc/claude 使用 /bin/sh 的内建命令，无 PATH 工具链。
这是 Linux + procfs + /bin/sh 环境验收，不是无系统依赖或跨平台证明。

## 未做与证据界限

这是 **mock gbc 身份门闩验收**，不是 live OAuth、刷新、真实 bot、团队绑定或
四家 CLI E2E。未访问真实 ~/.gbc、官方凭据、真实后端、App 二进制或用户机器。
操作者应自行完成 gbc 独立登录，Linux daemon 使用其既有凭据与启动时环境。
外部 PATH 上的 gbc 必须由操作者信任，不防同 UID 恶意替换。
没有实现通知、ACK/重试、浏览器登录、agentwatch auth login 或平台扩展。
未 push / 开 PR / merge / 发布；需父代理独立审查。

---

# t179 cleanup results — historical

2026-11-20, Asia/Shanghai. Fixed base: `43b8c5b7d8fb2a077b99cc10795a4632b108c05e`.
Scope is only the two low-risk Standards cleanup suggestions. Previously closed
t178 findings and contracts are unchanged. Historical measurements follow below.

| Finding | Resolution and evidence in `evidence/review-cleanup/` |
|---|---|
| File fd leak if closeSync throws during inode rejection | `cleanup-red.log`: after a rejected 0644 inode check, injecting a first closeSync throw that does not release left fd 11 open (`expect([]).toEqual` failed; received `[11]`), exit 1. Implementation now uses a keep flag and finally to close the failure-path fd, swallowing close errors separately, then maps `CoreError('IPC_AUTH')`. Kept regression `inode validation maps IPC_AUTH, does not leak, and swallows a later closeSync throw` asserts no leftover descriptor and that a closeSync throw after a successful release still surfaces IPC_AUTH, never the raw close error. A close(2) that fails without releasing is not retried and is not claimed leak-free. `cleanup-green.log` exit 0. |
| Swap-test finally skipped engine/db/temp cleanup if path restore threw | `cleanup-red.log`: injected path-restore throw left the temporary root in place (`existsSync(root)` true), exit 1. Test helper `restoreThenDispose` now does restore in try and engine.close/db.close/rmSync in finally. The directory-swap test uses that helper after mockRestore. The new test proves the restore error still propagates and the tree is gone. `cleanup-green.log` exit 0. |

## Full final verification

Reproduce unchanged: `bun install --frozen-lockfile && bun run verify` in this package.
Formal `bun run verify` and original experiment `bun run verify` both exit **0**.

| Actual suite | Pass/fail | Assertions | Time |
|---|---|---|---|
| Formal source | 29 / 0 | 170 | 10.33s |
| Formal compiled | 9 / 0 | 86 | 3.92s |
| Original experiment source | 11 / 0 | 194 | 25.72s |
| Original experiment compiled | 11 / 0 | 194 | 9.54s |

Formal and experiment typechecks pass. Production bundle: 400 modules, 63ms;
compile: 730ms; **109,942,960 bytes**. Separate test host: 350 modules, 36ms
bundle / 456ms compile; **109,631,664 bytes**. Exact tools and hashes:
`evidence/review-cleanup/environment.txt`. Compiled tests retain empty PATH,
isolated HOME/cwd, and temporarily moved source/migration resources. Controller
still uses installed Bun; this is Linux x86_64 + procfs evidence, not a clean
VM or another platform claim.

Logs: `evidence/review-cleanup/{verify,spike-regression,cleanup-red,cleanup-green}.log`.
Production run remains AUTH_NOT_CONFIGURED, with no fake flag/env bypass. No
real Agent/model/notification/identity integration or user machine was touched.
No new dependency or generic PoC; no push/PR/merge/release/history rewrite.
Independent parent review is still required. Remaining production gates below
are unchanged. Owned-process audit: `evidence/review-cleanup/cleanup-audit.json`.

---

# t178 review-fix results — historical

2026-11-20, Asia/Shanghai. Fixed base: `cb8fa40330dfdbddbfb028901e46d90a957ef729`.
Scope is only the five reviewed findings; original implementation/experiment
measurements are retained below as historical evidence, not current test counts.

| Finding | Resolution and evidence in `evidence/review-fixes/` |
|---|---|
| Admission/drain commit window | `admission-red.log`: original code launches 1 old task after restart (expected 0), exit 1. `admission-green.log`: 0 late launches. Drain closes admission synchronously, settles admitted commits/current worker, cancels all remaining queued + outbox before returning. Verifier-pending/pre-admission requests leave no row. |
| Unsafe log read/write/ID and directory race | `log-security-red.log` catches original symlink reads/writes; `log-security-green.log` passes. UUID identity validation, descriptor-pinned Linux directory, final no-follow open, same-inode fstat/read/append. IPC suite covers both streams, nonregular files and tampered traversal ID. `directory-pin-mutant-red.log` returns OUTSIDE_SENTINEL after deliberately removing directory-relative opening; restored code passes. All sentinels are synthetic task-owned files. |
| Auth negative tests did not prove no insert | Read-only ledger queries assert no rows for rejected request IDs (unconfigured, forged fake adapter, forbidden bot, rejected program/flag). `auth-order-mutant-red.log`: moving verify after insert makes both relevant tests fail with row count 1 despite correct auth error/zero fixture receipts. Original verify order restored; green log passes. Pre-launch verifier retained during mutation, so no real Agent can execute. |
| Allocation before try leaked read FD | `allocation-red.log` catches one leaked descriptor on injected Buffer.alloc failure; green allocates bounded memory before open. Test restores allocator and closes only its own leaked descriptor on the red run. |
| Duplicate error code list | service reuses domain.exitCodes with Object.hasOwn; protocol tests cover every own code plus constructor/toString/__proto__/unknown. This is a refactor: baseline and changed behavior both green, not a fabricated original red failure. |

## Full final verification

Reproduce unchanged: `bun install --frozen-lockfile && bun run verify` in this package.
`bun run verify` and original experiment `bun run verify` both exit **0**.

| Actual suite | Pass/fail | Assertions | Time |
|---|---|---|---|
| Formal source | 27 / 0 | 165 | 8.69s |
| Formal compiled | 9 / 0 | 86 | 3.75s |
| Original experiment source | 11 / 0 | 193 | 23.09s |
| Original experiment compiled | 11 / 0 | 194 | 9.20s |

Formal and experiment typechecks pass. Production bundle: 400 modules, 36ms;
compile: 314ms. Separate test host: 350 modules, 56ms bundle / 336ms compile.
Production bytes: **109,942,960**; test host: **109,631,664**. Exact tools/pins/hashes
are in `evidence/review-fixes/environment.txt`; dependencies/lock unchanged.
Compiled tests retain empty PATH, isolated HOME/cwd, moved source/migration
resources and same-executable launch. Controller still uses installed Bun; this
is Linux x86_64 + procfs evidence, not a clean VM or another platform claim.

Logs: `evidence/review-fixes/{verify,spike-regression}.log`. Initial failed full
verification `verify-hung-test.log` is retained: a new test evaluated Bun's rejects
matcher before releasing its gate, blocking the test. After 61.562s the exact
owned runner was killed (exit 137), its recorded temporary state cleaned, and the
test reordered to observe a settled outcome after barrier release. This was not
a product pass. The corrected focused test and full suites above pass.

Production run remains AUTH_NOT_CONFIGURED, with no fake flag/env bypass. No
real Agent/model/notification/identity integration or user machine was touched.
No new dependency or generic PoC; no push/PR/merge/release/history rewrite.
Independent review is **pending parent**: this executor has no independent
sub-agent launch tool; self-review is recorded separately, not called independent.
Original remaining production gates below are unchanged. Final owned-process
and temporary-source restoration audit is recorded in `evidence/review-fixes/cleanup-audit.json`.

---

# Baseline implementation measurements (cb8fa40)

2026-11-20, Asia/Shanghai. Base: `879ae27f4f319de6c79d0bb32f6640a1292f75a7`.
This is bounded modular implementation, **not production-ready** and not another
platform PoC. Source/reference mapping: `../../docs/task-core-opencode-map.md`.
Root legacy src/auth/RPC/package/lock and the old experiment were not modified.

## Reproduce

```sh
cd packages/agentwatch && bun install --frozen-lockfile && bun run verify
```

The production binary is `dist/agentwatch`; its `run` is intentionally gated with
`AUTH_NOT_CONFIGURED` / exit 4. Fixture authorization/process execution exists
only in the separately compiled test host, never a production fake flag.

## Commands and measurements

All final commands below exited **0**. Logs are checked in (initial CLI help
output has trailing spaces stripped only); binaries/node_modules
are not. Final verification wall time reported by the command runner: **12.458s**.

| Command | Actual result |
|---|---|
| `bun run typecheck` | TypeScript compiler 6.0.3, no errors |
| `bun test test/core.test.ts test/cli.test.ts` | 19 pass, 0 fail, 115 assertions, 6.86s |
| `bun run build` | 399 modules; bundle 35ms, compile 292ms |
| `bun run build:test-host` | 349 modules; bundle 31ms, compile 351ms |
| `bun test test/compiled.test.ts` | 8 pass, 0 fail, 70 assertions, 3.22s |
| Existing experiment `bun run verify` | Typecheck/build pass; source 11/0, 193 assertions, 22.74s; compiled 11/0, 194 assertions, 9.62s |

Runtime: Bun **1.4.4**, Linux x86_64 / kernel 6.12.113+. Locked packages:
Effect/platform-bun/sql-sqlite-bun 4.1.0; Drizzle 1.0.0-rc.5-169397b.
Full direct versions/overrides and artifact SHA-256: `evidence/environment.txt`.
Production executable: **109,942,960 bytes**; separate test host: **109,627,568 bytes**.

The compiled suite copies only the two executables into a private independent
space/Unicode directory, uses empty PATH and isolated HOME, and temporarily moves
`src/` (including SQL migration resources) away, restoring it after tests. The
executables self-launch their internal entries; fixture children use the same test
executable. The test controller itself still uses Bun and already-loaded helper
modules. Bun/Node remain installed on the host: **not a clean VM/container proof**,
not a no-shared-library claim, and not macOS/Windows/other-architecture evidence.

## Contract matrix

| Contract | Result / exact seam |
|---|---|
| Effect CLI/Schema/Layer/Scope and SQLite/Drizzle real path | PASS: CLI parsing, validated requests, scoped client, same-client ORM, embedded checksum/version migration |
| Five commands; JSON without TTY; stderr-only bounded errors | PASS source + compiled; native flags, empty argv, spaces/Unicode, help-on-error suppression; wizard rejected |
| Defaults/limits and separate stdout/stderr | PASS: 4096-byte default / 65536 max, offsets, byte-preserving base64; raw log retention is NOT implemented |
| Request ID uniqueness/fingerprint conflicts | PASS: exact concurrent requests produce one real fixture receipt; changed argv conflicts |
| Lost submit response simulation | Existing spike PASS; formal slice uses same-ID retry/concurrency coverage, no separate lost-response injection |
| Queued/starting cancellation cannot launch afterward | PASS core: deterministic beforeClaim/beforeLaunch barriers, cancellation acknowledged before release, zero executor launches |
| Running cancel / wait timeout | PASS source + compiled: timeout leaves child running; cancelled terminal only after observed child close |
| Revalidate authorization before actual launch | PASS injected verifier revocation, no child launched |
| Crash → unknown; no replay; drain excludes historical unknown | PASS core + source/compiled actual daemon SIGKILL and fixture receipt checks |
| Terminal + outbox atomic; stable event ID | PASS: migration/ORM path and injected outbox INSERT failure rollback; status visibly pending/not_configured |
| Private discovery / singleton / auth / state isolation | PASS source + compiled: loopback capability, instance/scope, private registration, duplicate ownership and concurrent self-start |
| Graceful shutdown | PASS source + compiled: explicit exit/fixture-close assertions before cleanup; `FORMAL_SHUTDOWN_EXIT_OBSERVED_BEFORE_CLEANUP` |
| Production authorization bypass rejected | PASS source + compiled: real production run returns AUTH_NOT_CONFIGURED; fake CLI flag and forged RPC data do not enable it |
| Spawn ENOENT / incompatible future migration | PASS core: failed without PID; future migration fails closed |
| Actual vendor Agents / bot identity adapter | NOT IMPLEMENTED / NOT TESTED; production run stays closed |
| Real notification transport, retry, remote ACK/dedupe | NOT IMPLEMENTED / NOT TESTED; user suspension retained, outbox is not delivery proof |
| Process-tree cancellation, Windows .cmd/ACL, platform distribution | NOT IMPLEMENTED / NOT TESTED; no additional generic native-platform PoC |

One worker executes at a time in this slice. No throughput, upgrade/replacement,
watchdog/contender-pool, hostile-same-user, output redaction/retention, or production
availability claim is made. SQLite lifetime ownership is explicitly an adaptation
from the reference, not a claim of identical OpenCode flock behavior.

## Evidence and failures retained honestly

- `evidence/verify.log`: final complete formal verification.
- `evidence/spike-regression.log`: unchanged experiment regression. Forced cleanup
  in intentional hard-crash cases is not graceful-stop proof; strict stop cases
  separately assert successful exit before fallback.
- `evidence/{storage,engine,ipc}-red.log`: initial missing-module tracer bullets
  (expected nonzero), not semantic mutation tests.
- `evidence/cli-initial-failure.log`: 6 real CLI integration failures before fixing
  Effect optional booleans, implicit error help on stdout, and wrapped error codes.
- `evidence/install.log`, `evidence/environment.txt`: local dependencies and tools.

No real Agent/model/notification or user machine was used; no app credentials read.
Final audit found no remaining owned daemon/fixture processes. Intentional crash
orphans were cleaned by verified task-owned PID only. No push/PR/release performed.

## Smallest next step

Parent independently reviews this local slice. Then agree the supported production
identity-to-bot verifier seam and its deny-path tests before opening production run.
Do not reopen real notification delivery or add broad platform experiments here.
