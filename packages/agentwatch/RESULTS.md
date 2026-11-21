# t215 原型清理与根入口停用 — current

2026-11-21，Asia/Shanghai。固定基线 `ece162fe42e8a73b1987e84fb32d24ecc6bb39c3`
（`feat/bun-task-core`）。只处理本仓库内已被正式包替代的 PoC；本轮实现/验证完成时
尚未 commit/push，等待独立复审。不改 git config、不做 PR/release。

## 删除、保留与根入口

- 删除 66 个已跟踪旧文件：根 `src/` 30 个、`test/` 10 个；根专属 `package-lock.json`
  与 `tsconfig.json`；最小 `experiments/bun-daemon-spike/` 24 个（含专属配置/锁、
  source/test/scripts、历史实验文档和 6 份实验专属证据）。Git 是原型档案，不复制快照。
- 根 `package.json` 改成 private Bun **脚本门面**（不是 workspace/安装包）；不再有
  Node bin、prepare、依赖、根锁或自动安装/下载脚本。typecheck/test/build/
  build:test-host/verify 只转发 `packages/agentwatch` 的同名脚本。
- 根 README 只指向正式 Bun 构建、验证和 `packages/agentwatch/dist/agentwatch`。
  旧 Node `dist/cli.js`、npm/tsc 与 GitHub npx 入口停用，不提供旧 CLI 自动兼容层，
  不宣称 npm 发布或新分发可用。正式包 CLI 名称/状态目录/IPC/API/任务行为未改。
- 有用接受条件与固定 Git 档案整理到 `docs/historical-prototypes.md`，保留 OpenCode
  研究映射并标明历史时态；更新正式 README 的旧根 bin 描述。
- 正式源码/测试/迁移/依赖锁和全部正式 evidence 原样保留；118 个相对 import 均在
  正式包内解析，不需要迁移旧模块。正式 RESULTS / REVIEW / evidence 的历史命令、
  当时的「未提交」和旧路径作为当轮记录保留，不是当前活入口。
- 不删除 ignored 的旧实验 node_modules/dist 或未知文件，不执行这些旧本地产物。
  根忽略规则仍覆盖它们。无安装操作、无依赖下载、无新锁文件。

## 验证

仓外证据：`/workspace/agentwatch-cleanup-20261121/`。先对根 manifest/停用入口的约束
作 red（旧 bin、非 private），改后 green；删除前后保存 import/fixture/配置引用扫描与
正式包 SHA-256 清单。根脚本实际调用均正确转入正式目录，不只是静态匹配字符串。

| 检查 | 实际结果 |
|---|---|
| 根脚本 `bun run typecheck` | 通过 |
| 根脚本 `bun run test -t 'enrollProcessGroup\|relative --cwd follows'` | 2 pass / 0 fail，25 expects，2.90s |
| 根 `build` / `build:test-host` | 两项通过 |
| 根 `bun run verify` 的 typecheck | 通过 |
| 完整源码套件 | 229 pass / 0 fail，1782 expects，103.23s |
| 正式二进制编译 | 415 modules；bundle 44ms / compile 347ms |
| 编译测试宿主 | 365 modules；bundle 45ms / compile 315ms |
| compiled 套件 | 75 pass / 0 fail，606 expects，36.49s |
| `git diff --check`、当前文档相对链接、活引用检查 | 通过 |

全部测试仍使用临时 HOME、合成凭据、本地 HTTP mock 或自有进程夹具，无真实凭据、
真实后端/通知或厂商 CLI。本次不修通知刷新门闩、同步 keyring 截止、脱敏或 Windows
Job Object。正式包平台验收边界不变。

# t212 全仓审查三项修复（PGID 失效、取消定时器、相对 cwd）— historical

2026-11-21，Asia/Shanghai。基线是已推送的 `9ac8fb94fe93bb20d062b6ff690cde5918742254`
（`feat/bun-task-core`）。本增量未 commit、未 push、未改 git config，不做 live
真实后端，不实现 Windows Job Object。按用户决定，历史根 CLI JSON 脱敏暂不修；
也不修通知过期刷新门闩（S3）和同步 keyring 截止（S5）。只修正式包三项：
重复 cancel 遇到 ESRCH 未注销 PGID、取消观察定时器泄漏、相对 `--cwd` 按 daemon
旧目录解释。

## 行为

- POSIX 组信号：所有信号调用点（初次 TERM、重复 cancel、force 的 SIGKILL、
  存活探测）在 ESRCH 时原子注销 pgid，并把 phase 置为 killed、结束该树的
  force/watch 定时器。EPERM 仍不是消失，保留组号。观察到 ESRCH 之后，即使该
  数字随后再显为 live，也不再向它发信号。
- 取消观察定时器：一棵树同一时刻只持有一个 watch interval；替换前先清旧句柄。
  覆盖「先 cancel，根进程在 1s grace 内 close，孙进程忽略 TERM」的交错，
  `exited` 之后不再留下活动观察 interval。根先退出仍会在 grace 后强杀同组残留；
  `setsid` 出走不追；wait 超时不杀；drain 不取消正在跑的任务；仍只在观察到
  close 后标 cancelled。
- 相对 `--cwd`：CLI 在发出 IPC 前按调用方目录 `resolve` 用户 cwd；daemon 的
  `normalize` 只接受绝对路径，再 `realpath`/目录校验。未显式 `--cwd` 的默认值
  仍是 CLI 进程的绝对 `process.cwd()`，不受影响。

## TDD

先写失败测试再改代码。新增：重复 cancel 第二次 TERM 注入 ESRCH 后，即使该
PGID 再显为 live 也不再发信号，且宽限期后根进程仍存活（证明 force 定时器已
结束）；真实 Linux 树上 cancel 后根在 grace 内退出、孙进程忽略 TERM，`exited`
后 `activeWatches()` 为 0（测试缝；失败时 `releaseWatches()` 清掉残留以免挂住
进程）；源码+编译共享契约「从目录 A 启服务、从目录 B 调 CLI」，覆盖相对
`project`、`.`、省略 `--cwd`、绝对路径，以及 daemon 直接拒绝相对 cwd。组信号
测试只拦截/收割自己创建并记录的 pid/pgid，拒绝 0/1/自身组，不对其他任务组发
真实信号。

日志：`evidence/review-fix-20261121/`。

## 最终验证（本增量全量重跑）

未 commit。`git diff --check` 通过。无 `.compiled-test-src`，无残留
`process-tree-child` 或 `/tmp/aw-tree-*` 夹具。

| 套件 | pass / fail | expect calls | 实测时间 |
|---|---|---|---|
| typecheck（`tsc6 --noEmit`） | 通过 | — | 2.72s |
| 源码 `bun run test`（8 个文件） | 229 / 0 | 1782 | 107.29s |
| 其中 process-tree.test.ts（Linux，含 2 项新回归） | 10 / 0 | — | 约 11s（目标套件内） |
| production 编译 | 通过 | 415 modules | bundle 130ms，compile 1090ms |
| test-host 编译 | 通过 | 365 modules | bundle 37ms，compile 488ms |
| compiled.test.ts（含相对 cwd 共享契约） | 75 / 0 | 606 | 37.28s |

目标测试（10 项：8 项既有取消契约 + ESRCH/定时器回归 + 源码相对 cwd）10 / 0，11.31s。

## 未做

未修历史根 CLI JSON 脱敏。未修 S3 通知刷新门闩与 S5 同步 keyring 截止。
Windows Job Object / `.cmd` 树取消仍未实现，也未做 macOS/Windows 原生验收。
未 commit/push。本文件末的同会话快审不是独立复审。

# t206 进程树协作取消（POSIX killpg）— historical

2026-11-21，Asia/Shanghai。基线仍是已推送的 `f95ba94`（`feat/bun-task-core`）。本增量
未 commit、未 push、未改 git config，不做 live 真实后端。只实现建议项 1：进程树协作
取消；未展开研究清单的其余 4 项。实现就近对照 Grok Build 官方树
`/workspace/grok-build` commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`（1.0.45）：
`ProcessGroup` / `ProcessGroupId`（Unix `killpg`、Windows Job Object）、
`graceful_kill_and_wait`（SIGTERM、1s grace、再 SIGKILL）、`ProcessScope::kill_all`
（reap 后丢弃组身份，避免 PGID 复用）。

## 行为与边界

- POSIX：`spawnArgv` 用 `detached:true` 开新 session/process group；cancel 向已登记
  的组发 SIGTERM，1 秒后若组仍在则 SIGKILL。grace 与既有契约及 Grok Build
  `SIGTERM_GRACE` 相同，不用 OpenCode 的 5s。根进程先退出不会清掉 force 定时器，
  仍会强杀同组残留；根退出后轮询组是否消失，协作树可在 grace 内结束并取消 SIGKILL。
- 登记对齐 `ProcessGroupId::new`：拒绝 0、1、调用方自己的 pgid、非整数与大于
  `i32::MAX` 的值。Linux 还要求 `/proc/<pid>` 显示该 pid 就是组长。组探测仅把
  ESRCH 视为组已消失并丢弃该 pgid（不再对复用号发信号）；EPERM 不是消失，仍保留
  登记并在 grace 后尝试 SIGKILL。
- 外层组信号不是整树通杀：子进程或 vendor CLI 内部 `setsid` / `setpgid` 建的新组
  不在合同内，不追杀。不扫描 /proc 去杀无关进程，不构造 shell 杀令，不向 daemon
  或其他任务的组发信号。wait 超时仍不杀（exit 9）；`drain` 仍等待当前 worker、
  不取消正在运行的任务；仍只在观察到 close 后把 cancelling 标为 cancelled。
- 调用方 pgid 与 `/proc` 组长检查仅 Linux。其他 POSIX 仍拒绝 0/1/越界，但读不到
  自身 pgid 时不做自身组比对。
- Windows 进程树 / Job Object **未实现、未在本机原生验证**，cancel 仍只
  `child.kill` 直接子进程。未引入新依赖，也未用手写、无法验证的 bun:ffi Win32
  结构体布局。Grok Build 的 Job Object 使用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`：
  关闭 job handle——包括 daemon 进程崩溃后内核收回残留 handle——会结束仍在该 job
  中的全部进程。这是内核强制杀树，不是保活；也不同于本包 Unix 契约（丢弃组 handle
  是空操作；`recover` 把残留 starting/running/cancelling 标为 unknown，并不收割
  其进程组）。Grok Build 在成功路径还有 `preserve_descendants()` 清掉该标志，
  避免 Drop 误杀。不得把这两套崩溃语义写成相同。

## TDD

先写失败的真实 Linux 进程树测试，再改 `spawnArgv`。覆盖：协作 SIGTERM 在 1s 内结束；
根先退出后仍强杀同组孙进程；忽略 SIGTERM 则 1s 后 SIGKILL；重复 cancel 不重置
grace；`setsid` 出走的孙进程不追（测试 finally 只收割自己记录的 pid/pgid）；并发
任务隔离；自然退出后的 cancel 不抛；engine wait 超时不杀、后台 `drain` 不取消正在
运行的任务、`cancel()` 在观察到 close 后才是 cancelled。另有登记拒绝用例。测试只
杀自己创建并记录的 pid/pgid，拒绝 pgid≤1 或测试进程自己的组。非 Linux 跳过树测
（不冒称 Windows 原生通过）。

日志：`evidence/process-tree-cancel/`。中途全量曾因协作树在负载下等到 force（根
close 未轮询组退出，`elapsed=1004`）失败一次，补轮询后重跑通过；该失败日志保留为
`05-source-suite.log`，最终以 `13`/`14`/`15`/`16` 为准。

## 最终验证（本增量全量重跑）

未 commit。`git diff --check` 通过。无 `.compiled-test-src`，无残留
`process-tree-child`，无残留 `/tmp/aw-tree-*`。

| 套件 | pass / fail | expect calls | 实测时间 |
|---|---|---|---|
| typecheck（`tsc6 --noEmit`） | 通过 | — | 2.80s |
| 源码 `bun run test`（8 个文件，含新增 process-tree） | 226 / 0 | 1751 | 106.08s |
| 其中 process-tree.test.ts（Linux） | 8 / 0 | 42 | 约 5.81s（单文件） |
| production 编译 | 通过 | 415 modules | bundle 50ms，compile 521ms |
| test-host 编译 | 通过 | 365 modules | bundle 46ms，compile 373ms |
| compiled.test.ts | 74 / 0 | 586 | 38.89s |

## 未做

Windows Job Object / `.cmd` 树取消仍未实现。macOS 未跑原生树测。不承诺杀掉 vendor
内部新建组或 `CREATE_BREAKAWAY_FROM_JOB` 出走的进程。未 commit/push。未实现研究
建议 2–5。

# t201 终态通知附有界原始 stdout/stderr — historical

2026-11-21，Asia/Shanghai。基线仍 `e1d4aad`；在未提交的 Markdown 通知改动上继续，
未 commit/push/git config，不做 live 真实后端。

## 行为

默认发给 bot 的终态正文仍是简体中文 Markdown，CLI stdout 仍是一行 JSON。通知在有界
字段之后分开展示原始 stdout 和 stderr：每路最多 4 KiB 头尾合计，按字节截断，超限写明
省略字节数。空文件或缺失日志（含 spawn 前失败、可能尚未创建日志）写「（无输出）」，
不附查询说明。权限/IO 等读取失败不伪装成无输出，而是写「输出读取失败，无法生成预览」，
并附主机名、该路绝对路径与 `logs` 查询；正文不泄露原生 error、栈或 `IPC_AUTH`。
用可变长度 code fence 原样嵌入；主机名、路径和命令用按内容加长的 Markdown 行内代码，
避免反引号拆破。该路被截断或读取失败时，附必须在该主机上运行的、仅针对当前平台的
`agentwatch logs` 分页命令（`--offset 0 --limit 65536`，若 `truncated` 则继续用
`next_offset`）：Linux/macOS 标注 POSIX shell 并用 POSIX 单引号，Windows 标注
PowerShell 并用 `''` 转义单引号，不把 POSIX 引号冒充为跨平台。不新增 logs
参数，不以 cat 为官方入口，不发 argv/cwd/request_id/token/report。完整日志仍留本地。

## 复核增量（读取失败 / 反引号路径 / 平台相关 quoting）

TDD：先补失败测试再修复。本增量只跑 typecheck 与针对此变更的测试，**未重跑全量**。
上轮全量数字保留对照。

| 套件 | pass / fail | expect calls | 实测时间 |
|---|---:|---:|---:|
| typecheck（本增量） | 通过 | — | 4.25s |
| 源码通知相关（core.test 过滤 16 项，含 3 个新测试） | 16 / 0 | 156 | 0.634s |
| 源码契约（frozen bounded notification） | 1 / 0 | 24 | 2.41s |
| 上轮正式源码全量（未重跑） | 215 / 0 | 1677 | 98.08s |
| 上轮正式编译全量（未重跑） | 74 / 0 | 586 | 38.55s |

本增量证据在 `evidence/notification-output-review/`；上轮全量证据仍在
`evidence/notification-output/`。当前边界以本节与 README 为准。

# t193 默认终态通知改为有界 Markdown — historical

2026-11-20，Asia/Shanghai。基线 `e1d4aad`；只改工作树，未 commit/push/git config。
用户要求发给目标 bot 的默认终态通知以 Markdown 返回。不改 CLI stdout
（run/status/logs/wait/cancel 仍是一行 JSON，`--json` 保持兼容），不做 live 真实后端。

## 行为

- 发送给 bot 的 `text` 改为简体中文 Markdown：一行标题，后接稳定顺序的列表。
  succeeded=任务已成功、failed=任务失败、cancelled=任务已取消、unknown=任务状态未知。
- 正文只含既有有界字段：task_id、event_id 用反引号，exit_code 始终列出，error_code
  为空则省略该行。不发送 argv、cwd、request_id、日志全文、原生错误、token、report。
- 内部 outbox payload 仍为结构化 JSON；只改发送 text。标识符已是受控 UUID 格式，
  不转义破坏反引号内容。

TDD：先改 command-contracts / core 断言为 Markdown（红灯：正文仍是整段 JSON），再改
`notificationText` 只生成发给 bot 的 text。内部 outbox payload 未改。

| 套件 | pass / fail | expect calls | 实测时间 |
|---|---:|---:|---:|
| typecheck | 通过 | — | 3.11s |
| 正式源码 | 209 / 0 | 1627 | 103.69s |
| 正式编译 | 74 / 0 | 583 | 38.53s |

证据在 `evidence/notification-markdown/`。本节为历史记录；当前边界以文首与 README 为准。

# t186 完整可选元数据迁移矩阵与精确 peer 后继 — historical

2026-11-20，Asia/Shanghai，基线仍 `b52ba5e`；只改工作树，未 commit/push/git config。
本节为历史记录，不再将仅 session_id 修复称为完整迁移覆盖；当前边界以文首与 README 为准。

## P2：旧 token 无可解析 sub，首次轮换补齐账号绑定（关闭）

原实现仍按 subject 严格相等识别 peer；旧快照没有 account_subject 且旧 access 是 opaque /
没有 sub 时，首次刷新得到新 JWT sub 会造成等待者误判。不能直接放宽 subject/session 比较。

先新增公开 `getAccessToken` 边界的 28 项测试：
- `01-red.log`：包含 2 个错误使用 localhost（不在 numeric loopback 白名单）的夹具失败；
  不把这 2 个误报当功能 red。修正为另一个真实本地数字 loopback 服务后重跑，才写实现。
- `02-red-corrected-backend-fixture.log`：22 pass / 6 fail。4 项无绑定旧 opaque token 首次
  得到 sub（session_id 有/无 × 同进程/真实子进程）失败；同时发现旧等待路径还会采用变更的
  client_id（2 项）。backend/session/account/logout 反例在有效夹具下保持拒绝。
- `03-green.log`：28 pass / 0 fail。随后扩大边界至 56 项，见 `04-expanded-green.log`。

### 统一迁移条件（不是逐字段宽松匹配）

1. 初始完整规范化凭据、generation、显式解析 client_id 同 mutation 锁读取；交换锁下重读。
2. 等待者仅采用：完全相同的初始快照，或带有效本机 `refresh_proof` 的**直接一次**后继。
3. 成功刷新写回前，在既有自有凭据文件写入 parent/result SHA-256 关联：parent 包含完整旧
   凭据（包括原 session、subject、token pair、backend、client、expiry、revision、source、
   updated_at 和旧关联摘要）、generation、client 绑定；result 包含完整新结果，仅排除摘要自身。
4. 另有显式约束：新 session 必须保留旧 ID 或是完整旧快照的稳定迁移 ID；backend 必须同
   origin（允许原有 URL 规范化）；client 必须同初始显式绑定；revision 必须恰好加一。
   已绑定 subject 不得变更/删除；未绑定时，仅可补齐为收到的新 access JWT sub，不能凭空填账号。
5. 缺关联、关联来自别的完整快照/generation、结果被修改、账号/session/backend/client 更换
   或 logout 均拒绝，不自动采用新会话，不重放交换。写回 CAS 仍比较全部规范化字段。
6. 新 login 不继承 refresh 关联；失败刷新不写任何关联或补齐元数据，原文件不变。

摘要是本机受保护文件内的 CAS 关联，不是远端身份签名/密码学认证。只保留直接后继，不保存
无限祖先链；若等待者已错过多次轮换而无法证明，失败关闭，不猜测换账号。升级仍应停旧 daemon，
避免与不写新关联元数据的旧版本同时操作同一凭据目录。

### 最终 56 项新增边界

- 32 正例：session_id 有/无 × 存储的 account_subject 有/无 × access sub 可解析/缺失，
  同进程及跨进程各跑完整 8 组合，并扩展 opaque / JWT 无 sub、返回仍无 sub、env-only / stored
  client 绑定、旧 backend 尾斜杠规范化。全部只能一次 HTTP exchange，peer 返回同一个新 token；
  跨进程用仅 test child 识别的预期 SHA-256 校验实际 token，仍只输出布尔值，不输出 token/hash。
- 12 更换反例：两种拓扑各覆盖账号、session、backend、client、无证明的 subject 补齐、logout
  后还原旧文件；不重写新凭据、不向替换 backend 发请求、不采用新账号。
- 12 关联反例：使用一次真实 mock 刷新产生的关联，再分别改变初始旧快照、generation、结果
  access（同 sub、只变签名字符串）、结果 refresh、parent hash、result hash。两种拓扑均拒绝，
  不额外交换，保存文件不变。不是由测试重算同一算法来证明自己。

## 最终完整复测

证据目录：`evidence/login-refresh/metadata-matrix/`。
- typecheck：通过；production / test-host 编译：通过。
- 源码：**202 pass / 0 fail，1533 assertions，101.36s**（7 文件）。
- 编译产物：**74 pass / 0 fail，578 assertions，36.78s**。
- `git diff --check`：通过；源码已恢复，无编译暂存目录，无残留测试 daemon/任务/child。
- `boundaries-final.log` 摘录新增56项；完整日志为 final-*；产物及本轮源码 hash、清理和
  时间见 `final-manifest.json`、`cleanup-audit.json`。
第一次全套通过后又强化子进程“实际 token 必须一致”的断言，原日志保留为 pre-exact-token-*；
最终数字只采用强化断言后重跑的 final-*，不拿先前通过替代新断言。

## 不变限制

未访问真实官方文件、~/.gbc、钥匙串或真实后端，未 spawn gbc；未原生 Windows/macOS 验收。
Linux/Windows 桌面鉴权仍不 refresh/不回写。通知写不因刷新重放，通知失败不改任务终态。
模糊交换保护仍仅同进程 120 秒、未持久化：另一进程/重启遇实际已旋转的旧 token 可得到
invalid_grant 并需重新登录。本轮成功刷新关联不记录未知交换，不扩展该恢复能力，不新增状态文件。

---

# t186 旧凭据缺 session_id 的并发迁移 — 历史定向复核记录

2026-11-20，Asia/Shanghai；仍基于 `b52ba5e` 的未提交工作树。本节及 README 是当前边界；
下方早期 Spec 记录保留为历史。当前完整边界以文首最新章节与 README 为准。未 commit/push，未修改 git config，没有真实凭据/后端访问。

## P2 修复与逐项证据

合法旧凭据缺可选 `session_id` 时，首次 refresh 原先随机生成 ID；同进程另一 auth session
或另一进程已读取旧文件，拿到 exchange 锁后误判换会话，无法复用 peer 的轮换。

- 先新增公开 `getAccessToken` 边界测试：`01-red.log` 复现两个独立 session 一成功一失败。
- 最终实现：没有显式 session_id 时，以完整规范化旧凭据快照（版本、backend、账号绑定、
  token pair、client_id、expiry、updated_at、revision、source）推导 namespaced SHA-256 迁移 ID。
  仅成功轮换写入既有 session_id 字段，后续轮换沿用；新 login 仍生成独立随机 ID。
  等待者比较明确 ID / 精确旧快照推导 ID，**不忽略 session_id、不仅按账号匹配**。
- 初始 credential/generation 在短 mutation 锁下读取；取 exchange 后仍核对 generation、
  session、账号，写回仍做完整 CAS。先校验安全凭据路径，再进入会创建/收紧锁目录的 helper，
  保留原所有权、symlink、权限等拒绝行为。
- 新增 `test/auth-legacy-session.test.ts` 共 **12 项**：同进程/真实 Bun 子进程各有一次 exchange
  的正例；两种拓扑各有换账号、相同账号但不同显式 session、另一个无 ID 的不同旧快照、
  logout、logout 后还原完全相同旧文件的反例。反例不采用新会话、不重放 exchange、不改新文件。
  子进程只输出成功/安全错误码，不含 token。

`02-baseline-sensitivity.log` 是初次 red/green 后，将新增 6 项边界回放到修复前加载逻辑的
敏感性检查（不是冒称先写的 TDD red）：同进程与跨进程正例均失败，logout 后还原文件反例
也失败。中间曾尝试提前写随机 ID，`03-migration-write-regression.log` 发现它破坏 subject
不匹配时原文件不变的旧保证；已放弃，改为上述仅成功保存方案。保留两次测试 host 类型修正
的中途 typecheck 日志，不将它们当作功能 red。最终证据以 final-* 为准。

## 最终完整复测

日志：`evidence/login-refresh/legacy-session/final-{typecheck,source,build,compiled}.log`。
- typecheck：通过；production / test-host 编译：通过。
- 源码：**146 pass / 0 fail，1073 assertions，85.57s**（6 文件）。
- 编译产物：**74 pass / 0 fail，578 assertions，38.99s**。
- `git diff --check`：通过；源码目录恢复，无编译暂存目录，无残留本轮测试任务进程。
- 清理、时间、产物及本轮源码 hash 见 `cleanup-audit.json`、`final-manifest.json`。
- 新 12 项的最终通过摘录见 `boundaries-final.log`，完整源码日志含全部旧边界及通知不重放回归。

## 明确限制（不扩大持久化范围）

模糊 refresh 交换保护依旧仅同一进程内 120 秒，**未持久化、不是跨进程保护**。
另一进程或 daemon 重启后，若上次请求实际已旋转 refresh token，旧 token 可能返回
`invalid_grant`，凭据可能按撤销处理并需要重新登录；不承诺跨进程/重启恢复模糊交换。
没有新增 journal/保护状态文件。Linux/Windows 桌面鉴权仍只读 access、不 refresh、不写官方文件。
未真实登录，也未原生 Windows DPAPI/macOS flock 实机验收；通知写不因 refresh 重放，
通知失败不改变任务终态的现有契约保留。

---

# t186 Spec 复核：刷新与新登录交错、响应体模糊交换 — 历史复核记录

2026-11-20，Asia/Shanghai。基线仍 `b52ba5e`，只改工作树；没有 commit/push/git config 修改。
原 8 项直接路径和 Standards 已关闭，本节记录复核新发现 2 项；不是用旧通过数字替代新边界。
本节为上一轮复核历史，当前完整边界以文首最新章节及 README 为准。

## 新发现逐项 red → green

### Recheck1：旧 refresh 撤销误删新 login pending（P1，关闭）

新增 `test/auth-refresh-interleavings.test.ts`：真实 Bun 测试子进程持有新 login poll，
父进程对保留的旧 token 返回 shouldLogout。`01-red.log` 直接复现 pending 文件被删；
其余延迟 refresh 的成功/撤销/503 情形也证明旧全程 mutation 锁会阻塞新 login。

实现 `credentials-refresh.lock`（exchange）与 `credentials.lock`（短 mutation）分离：
refresh 持 exchange，短暂持 mutation 读取快照；HTTP 不持 mutation；响应后重取 mutation，
核对 session、revision、backend、token pair、expiry/updated_at 及持久 login generation CAS。
login/logout 只持 mutation，不反向取 exchange。旧结果遇新 session/generation 时失败关闭，
不返回新账号 token 给旧请求，不覆盖/清理新凭据。撤销仅 `clearCredentialIfUnchangedUnlocked`
清旧凭证文件，绝不删 pending/generation；显式 logout 仍负责推进 generation 并清相应登录。
所有锁文件永久存在，不 stale-break/unlink。

`01-green.log` 中 6 项交错通过：旧 refresh success/revoked/503 保留另一真实进程的 pending，
随后该进程成功存入新账号凭证；另测新 login 在旧交换延迟时先完成，晚到旧成功/撤销/503
均不得覆盖/清除新凭据。最终套件另加 3 项显式 logout 后晚到旧结果不可复活的边界。

### Recheck2：headers 后 body 超时被吞为 malformed（P2，关闭）

`02-red.log`：本地真实流式 HTTP，headers 立即返回、body 卡住，40ms 后旧实现给 malformed；
headers/body 连接中断后的 invalid_grant 还会被当撤销。新 5 项测试均先复现失败。

refresh 改用既有 `fetchJsonBounded`，20s 同时约束 headers 和流式 body，限制响应大小并清理
reader；body 超时/连接中断不再被 `response.json().catch` 吞掉，所有不能确认交换结果的
传输失败均标记该 session/refresh-token 为 ambiguous。后续无显式撤销的 invalid_grant
保留凭据（若旧 access 有效可返回，否则鉴权失败但文件不清）；shouldLogout/策略拒绝
仍高于 429/5xx 与模糊保护。`02-green.log` 完成 40ms native HTTP、reader cancel、跨调用
invalid_grant 保留、之后明确 shouldLogout/策略撤销清理、headers/body 连接中断矩阵。
错误对象/测试子进程输出不含合成 token 等秘密；无真实后端或凭据。

## 最终完整复测

完整串行验证日志在 `evidence/login-refresh/spec-recheck/`：`final-typecheck.log`、
`final-source.log`、`final-build.log`、`final-compiled.log`。

- typecheck：通过（`tsc6 --noEmit`）。
- 源码：**134 pass / 0 fail，981 assertions，86.92s**（5 文件）。
- production 与 test-host 编译：通过。
- 编译产物：**74 pass / 0 fail，578 assertions，39.02s**。
- `git diff --check`：通过；`src` 已恢复，无 `.compiled-test-src`，无残留本轮测试任务进程。
- 时间、产物 hash 与清理审计见 `final-manifest.json`、`cleanup-audit.json`。
本轮新套件包含 14 个边界（9 项登录/刷新交错、5 项 HTTP 模糊交换），不是旧测试计数。
保留一次测试 adapter 缺少 fetch.preconnect 类型的中途 typecheck 错误，修正签名后重跑；
它不作为功能 red 或最终通过证据。

## 未验收与保持的边界

没有新增真实账号/后端访问，没有读真实 ~/.gbc、官方 sand-secrets 或钥匙串，没有 spawn gbc。
Windows/macOS 原生验收局限不变：Windows DPAPI/GCM 只有 Linux 注入夹具，macOS flock
未实机跑。Linux/Windows 官方桌面 token 仍不 refresh、不回写。通知不因 refresh 重放，
失败不改任务终态。新旧鉴权锁协议不要对同一凭据目录混跑，升级应先停旧 daemon。

---

# t186 独立 Spec 8 项修复与 Standards 补充 — 首次复审记录

2026-11-20，Asia/Shanghai。仍基于 `b52ba5e`，只修改工作树；不 commit / push，不修改 git config。
本节为首次复审历史；当前边界以文首最新章节与 README 为准。下面的初次实现 107 项通过**不代表**这 8 个边界正确；
独立复审后逐项新增失败测试、再修实现，证据保留在 `evidence/login-refresh/spec-fixes/`。

## 逐项 red → green（不是用旧测试替代）

| 项 | 新边界与 red 现象 | 实现 / green 断言 | 日志 |
|---|---|---|---|
| Spec1 Windows | 注入 Windows DPAPI 夹具，原先无条件拒绝 | 同用户 DPAPI + 匹配 secrets 所在目录 Local State 的 DPAPI-wrapped AES-256-GCM；直接与 GCM 两种格式返回 access；损坏/无密钥拒绝；不解密 refresh | `01-red.log` / `01-green.log` |
| Spec2 跨进程 login/logout | 真 Bun 子进程 A 的 poll 被 barrier 挡住，B logout 后释放 A，原先 `completed:true` 复活 | login begin / completion / logout 同 OS 锁；持久 generation + pending uuid/verifier CAS。logout 以及 logout→新 login 均使 A 失败且无凭据复活 | `02-red.log` / `02-green.log` |
| Spec3 撤销优先级 | 模拟 shouldLogout + invalid_grant 的不明超时窗，原先 resolve/fallback | 明确 shouldLogout/策略拒绝先于 429/5xx/invalid_grant 保护；5 HTTP status × 3 撤销 body 均拒绝、清凭证、canFallback=false | `03-red.log` / `03-green.log` |
| Spec4 无 TTY | 真实 CLI testhost stdin=ignore，原先 900ms 上限内不返回（被测试终止） | stderr 仅公开 URL，stdout 一行 pending JSON，立即成功返回；daemon 仍 pending 后台 poll | `04-red.log` / `04-green.log` |
| Spec5 poll 有界 | headers 永不返回，原先 `hung` | 单次 10s/总计20min；注入30/35ms测试 stalled headers、200/403 stalled body、卡住的 sleep；均期限内失败/timeout，reader 被 cancel，不泄露 verifier | `05-red.log` / `05-green.log` |
| Spec6 失败状态 | 原先 terminal failure 仍显示 pending | 同 generation 条件清 pending，持久安全失败状态；策略/xAI/连续错误/次数耗尽均可观测；peer 后续 login 得新 uuid | `06-red.log` / `06-green.log` |
| Spec7 subject 绑定 | opaque 新 access 原先覆盖已绑定账号 | 已绑定 sub 时，新 JWT 必须有相同 sub；opaque/缺失/其他 sub 拒绝且原文件不变；匹配 sub 成功并保留未轮换 refresh | `07-red.log` / `07-green.log` |
| Spec8 caller 取消 | pre-abort 原先 `hung`，Connect 等 auth 直到20s | 预取消不启动 refresh；caller 取消只放弃等待，不中止共享交换；Connect 总3s覆盖鉴权等待；后台成功写回且通知写0次。另测锁等待取消后同一次共享 rotation 完成 | `08-red.log` / `08-green.log`、`boundaries-green.log` |

补充引擎/outbox集成：独立 refresh shouldLogout 使通知保持 pending，或 refresh 成功后
通知返回401使通知 unknown；两种情况下任务仍 succeeded、refresh一次、send分别0/1次，
不重放写。`test_only` 仍只用于测试适配器；没有新增生产 auth mode 环境开关。

## Standards 补充

- 根 README 正式包导语与 `docs/task-core-opencode-map.md` 最新导引/新增 t186 章节已更新；
  t185 的「无官方读取代码/无refresh/无登录」保留为**历史当轮**边界，不再冒充当前状态。
- 实跑 Bun 1.4.4：`new URL('http://[::1]').hostname === '[::1]'`；reviewer 的 IPv6
  不一致推断不成立，不改原正确校验。新增允许 IPv6 numeric loopback、拒绝其他 HTTP host
  的回归，见 `ipv6-runtime.json` / `standards-red.log` / `standards-green.log`。
- `DesktopAccess.backend` 改名 `source`（解密来源）；不再解析 refresh cipher；删除未使用的
  `loadCredentials` 导出与 `MAC_PBKDF2_ITERATIONS`。不做无关重构。

## 最终验证

最终整包 `typecheck → test → build → build:test-host → compiled.test.ts` 串行 **exit 0**：

| 套件 | 结果 | expect calls | 实测时间 |
|---|---:|---:|---:|
| typecheck | PASS | — | — |
| 源码（4文件） | 120 pass / 0 fail | 895 | 86.96s |
| 编译隔离合约 | 74 pass / 0 fail | 578 | 39.33s |

完整日志：`final-typecheck.log` / `final-source.log` / `final-build.log` / `final-compiled.log`。
编译合约复制二进制到隔离目录、暂移源码后恢复；不把 Linux 编译验收当成 macOS/Windows
native 证明。单独新边界套件：
13 pass / 0 fail，133 expects。先前一次完整回归已通过（含编译74项），但该次源码运行
开始后才补入 Standards 与两项集成测试，所以**不拿它替代最终整包复测**。
最终 `git diff --check` 通过，HEAD 保持 b52ba5e，`cleanup-audit.json` 中无本轮存活任务/测试进程，源码已复原。
一次与 compiled 暂移源码重叠的边界重跑在 import 阶段失败，原样保留
`boundaries-overlap-error.log`；待源码复原后重跑通过，不把这个工具编排错误当成产品 red。

## 未解决 / 未实机验收

8 项报告缺陷均已按对应边界测试修复；Windows 实现不是 native 验收：仅 Linux 上注入
DPAPI 系统调用与合成 AES-GCM 密文。未在真实 Windows 跑 PowerShell/DPAPI、NTFS ACL；
未在真实 macOS 跑 flock/login CLI。JWT sub 是协议中未验签的本地连续性约束，并不声称
本地密码学验签。没有真实 Cursor/IdP/发信请求，没有读真实凭据/钥匙串，没有 spawn gbc。
Windows 独立凭证/LockFileEx 不在生产独立鉴权路径，仍无 Windows native 锁验收；
Linux/Windows 只读桌面会话，不 refresh、不回写官方文件。任务日志跨平台硬化等既有门槛不变。

---

# 登录与令牌刷新（平台写死）— 初次实现记录（已由顶部复审修复取代）

2026-11-20，Asia/Shanghai。基线 `b52ba5e`（feat/bun-task-core，本地 ahead 4）。未 push、未改 git config、未 commit。

## 结果

按平台写死鉴权，没有生产 `--auth` / `AGENTWATCH_AUTH_MODE`。macOS 走独立登录与 refresh；Linux / Windows 只读官方 Grok Bot `sand-secrets.json`，绝不 refresh 或回写，以免踢掉桌面登录。三端都保留任务 daemon。`grokbot-control` 只作协议参考，不调用外部 `gbc`，不把官方 App / proto 打进可执行文件。

- 新 `src/auth/`：platform、login URL/poll、独立 store、OS 咨询锁（Linux OFD，macOS flock 已写、此处未在真实 macOS 跑）、refresh 状态机（提前 300s、锁下重读、singleflight、shouldLogout 不回退、网络/5xx/429/超时可回退仍有效的旧 token、不明 timeout 后 invalid_grant 不清凭证、account subject 不匹配拒绝转换）、Linux peanuts / secret-tool 解密与 Windows 路径解析。
- `agentwatch login` / `logout` 仅 macOS 有效：login 确保 daemon、stderr 立即打出 `loginDeepControl?redirectTarget=cli`（无 team 参），daemon 轮询并落盘；logout 只清自有凭据。Linux / Windows 上这两条命令 exit 4。
- 已运行 daemon 的 env 是启动时快照；独立凭证和官方 secrets 文件每次请求重读。health 就绪时仍为 `connect_http`，不证明远端已登录。写 RPC 不因 refresh 自动重放；通知失败不改任务终态。
- Linux 上现有 command-contracts 改为桌面夹具（临时 `sand-secrets` + peanuts，`AGENTWATCH_API_BASE` 指向 loopback mock）。独立凭证安全检查和登录/刷新矩阵在 `test/auth.test.ts` 中通过注入 `darwin` 覆盖。`test_only` 仍只属于 testhost。

## TDD / 回归证据

`bun run typecheck` 通过。全部使用 mock HTTP / 临时 HOME / fixture，未读真实凭证，未访问真实后端。

| 套件 | pass / fail | expect calls | 实测时间 |
|---|---:|---:|---:|
| typecheck | pass | — | ~2.4s |
| 正式源码 | 107 / 0 | 762 | 89.79s |
| 正式编译 | 74 / 0 | 578 | 41.27s（含构建后的 compiled.test.ts） |

生产产物 110,000,304 bytes，test-host 109,684,912 bytes。日志在 `evidence/login-refresh/`。没有 live 验证成功的声称。

## 未做 / 未 live 验证

- 未连接真实 Cursor / 后端登录，未 refresh 真实 token，未读取真实 `~/.gbc`、官方 sand-secrets 或钥匙串，未 spawn `gbc`。
- 未在真实 macOS 上跑 login CLI、钥匙串拒绝路径或 flock 锁。
- 未在真实 Windows 上验证 DPAPI / OSCrypt-GCM 解密、LockFileEx 或 ACL；当前在非 Windows 宿主上失败关闭。
- 未把独立 refresh 对真实 IdP 做 live 验证；mock HTTP 不是协议 live 证据。

---

# t185：内建直接 Connect/HTTP — historical

2026-11-20，Asia/Shanghai。固定基线 `c378e8f`；用户明确纠正 gbc 仅作参考。
本节只记录 t185 当轮边界；当前以文件顶部 t186 复审修复与 README 为准。t183 外部 CLI 章节同为历史证据。

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
  不重放、unknown最多一次先持久登记的只读status、durability恒unverified。默认发给 bot
  的终态通知正文是有界 Markdown（不是整段 JSON），不含日志/argv/cwd/token/request_id/report；
  CLI stdout 仍为 JSON。receipt只有有界白名单。
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
  message send + --text-stdin 当时发送六字段冻结结果 JSON，只读 message status 对账。
  不发日志、argv、cwd、报告文件或 request_id；不总结、不读取 history/transcript。
  该 JSON 正文是历史默认；当前发给 bot 的终态 text 已改为有界 Markdown，CLI 仍为 JSON。
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
