# t183 独立审查 P2：结构化鉴权错误映射修复 — current

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
