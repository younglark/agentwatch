# 首批 task-core 切片：OpenCode v2 源码映射与任务

日期：2026-11-20，Asia/Shanghai。依据当前完整实施计划 Page
21811694-d2c2-469b-bd34-9bb2ffc50219；不是增加通用 PoC，也不重开
Bun / 四家普通 CLI / 通知实测搁置等决定。新实现位于 packages/agentwatch，
旧 src/ 是历史 auth/RPC PoC，原实验保留，不视为正式实现。

以下链接的固定 SHA 均是正式 2.3.2（c0ad18b...），本轮实际远程读取过；
历史依赖调研 d643... 是 manifest 2.3.0 开发快照，不能混称正式 tag。

| 实施项 | 真实永久源码 | 采用与必须适配 |
|---|---|---|
| CLI | [commands](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/cli/src/commands/commands.ts) | 采用 effect/cli 子命令；本项目先切开 `--`，逐元素保留外部 argv，不解析原生 flags |
| Schema / Layer / Scope | [database service](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/core/src/database/database.ts) | Schema 校验边界，Layer 提供 scoped 数据库；不引入 Zod 平行体系或旧凭据导入 |
| SQLite / Drizzle / migrations | [Bun adapter](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/core/src/database/sqlite.bun.ts)、[migration](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/core/src/database/migration.ts) | 同客户端事务、WAL、迁移版本。使用锁定 Drizzle 原生 Effect Bun adapter，不复制 OpenCode 自有桥；嵌入本项目 SQL 迁移 |
| 服务发现 / 健康 / 兼容 | [service](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/client/src/effect/service.ts) | 私有登记 + authenticated health + protocol/scope/instance gate；首切片不自动替换版本不符的服务 |
| 单例 / 登记 / IPC 授权 | [registration](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/cli/src/services/service-registration.ts)、[flock helper](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/util/src/effect-flock.ts)、[server auth dispatch](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/server/src/process.ts) | 采用原子 0600 登记、每实例随机能力、loopback 授权、只清自己登记。不延用实验 abstract socket。**适配差异**：首切片用独立 SQLite ownership 文件的生命周期 exclusive transaction 选主（不锁任务账本），崩溃由 OS/SQLite 释放；不自制心跳过期删除他人锁，不声称复制原 flock 实现 |
| 自身 executable 拉起 | [contender](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/client/src/service-contender.ts)、[server-process](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/cli/src/server-process.ts) | detached/unref、源码与编译 self argv 分离；有界健康握手。暂不实现官方复杂 contender pool / 旧版本升级 |
| 日志 / 子进程 / 关闭 | [contender bounded stderr](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/client/src/service-contender.ts)、[scoped server](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/server/src/process.ts) | 独立 stdout/stderr 文件、字节 offset/limit；argv 不经 shell；不搬 PTY/session engine；进程树跨平台实现不在本切片承诺中 |
| unknown / drain | [session restart](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/core/src/session/execution/restart.ts)、[server lifecycle](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/server/src/process.ts) | **不照搬 session 自动恢复**：本项目丢失观察即 unknown、不重放；drain 仅当前受监督集合，不等历史 unknown |
| outbox | [job schema](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/core/src/job/sql.ts) | 稳定事件 ID、终态与 outbox 同事务。真实 transport 未接，不发送、不假报 ACK；不把 session inbox ACK 当远端 bot ACK |

## 本轮 tracer-bullet 任务与验收 seam

用户 go 已确认 seam：CLI JSON/错误 stderr、受鉴权本地协议、正式账本与
注入式 verifier/child 边界；可用真实 fixture 子进程测试，但无真实 Agent。

- [x] 正式 Schema、迁移、请求幂等/指纹冲突、终态+outbox 事务
- [x] 核心执行/排队/启动/取消/wait/unknown 与当前集合 drain
- [x] 五命令 effect/cli + `--` 保真、有界日志、无 TTY 输出与错误码
- [x] 私有登记、鉴权/跨状态隔离、单例、自拉起与生命周期
- [x] 测试专用 DI verifier/child，不提供 production fake bypass
- [x] 源码、编译 CLI、既有 spike 回归与准确证据
- [x] 清楚列出未接通的生产 bot verifier/transport 和非目标能力

## 归属与许可

本轮是依据上述代码行为和契约独立编写，不复制 OpenCode 的 session/PTY
或完整模块实现。参考项目 [MIT 许可](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/LICENSE)
已读取，copyright (c) 2025 opencode；未来直接复制实质代码须保留其完整许可。

## 本切片没有标完成的后续门槛

- [ ] 受支持的生产 bot verifier / 身份到目标 bot 权限适配
- [ ] 通知 transport、真实回执、远端去重与发送重试（继续搁置）
- [ ] 升级替换、登记 ownership watchdog、完整 contender pool、输出保留/脱敏策略
- [ ] 真实四家 CLI / 生产进程树取消 / 平台 ACL 和发行验收

不新增通用平台 PoC。本次实现的准确数量、矩阵和局限见
packages/agentwatch/RESULTS.md；下面的继续工作须经过主线程审查，不能因参考了
OpenCode 就把未实现项或未测平台标成通过。

## t178 有界审查修复：采用依据与差异

- 重新读取固定正式 SHA 的 [service-status.ts](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/server/src/service-status.ts#L19-L28)
  和 [停止 finalizer](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/server/src/process.ts#L91-L97)、
  [ready 准入 dispatch](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/server/src/process.ts#L194-L209)。
  借鉴先进入 stopping 再释放 scope/路由的顺序。适配为 JS 同步准入检查 + 已登记提交 promise 集合；
  正常 drain 等待已准入提交和当前 worker，再把剩余 queued 同事务终结为 cancelled，不能遗留重启晚启。
  不声称 OpenCode 自身有相同任务队列/取消语义，也不搬 session 恢复引擎。
- 日志 guard 是本项目安全适配：UUID/目录边界、Linux pinned-directory + procfs-relative no-follow、
  fstat 同一 inode、读写共用；非 Linux 不提供此保证而失败关闭。不臆称它直接复制自 OpenCode。
- 既有 CLI/Schema/SQLite/Drizzle 版本和身份 gate 不变；授权失败断言改为实际账本 request_id 无行，
  不是仅凭 fixture receipts 判断。错误码复用 domain 自有键，不使用原型链 `in`。
- 本轮只修 5 项已报告发现；取消/等待/unknown/outbox 既有契约保留，未增加产品命令或真实集成。
  独立 Standards/Spec 复审待主线程；本 executor 仅完成自审与机械回归。

## t179 清理

仅处理审查提出的两项资源清理：失败路径文件 fd 用 keep+finally 关闭（关闭失败单独吞掉再映射 IPC_AUTH），以及目录替换测试的路径复原与 close/rm 分层。不改变既有任务/IPC 契约，也不新增平台 PoC。准确证据见 packages/agentwatch/RESULTS.md 与 evidence/review-cleanup/。

## t183：外部 gbc 门闩差异（2026-11-20，Asia/Shanghai）

用户同意采用非官方 grokbot-control，不再要求仅官方公开 API；通知实现已解禁但本轮不做。
沿用既有 verifier/executor 边界与无 shell argv 子进程方式，新增 `src/gbc-verifier.ts`：
PATH 定位外部 gbc，只执行 `--json bot get --agent-id=…`，验证结果封套和精确 agent_id。
入账前/启动前两次核验位置保持不变；无 gbc/auth、拒绝、未知、超时或坏响应均 fail closed。
不重复登录/RPC PoC，不打包 gbc/proto，不读官方凭据；health 的 gbc 仅指可执行文件可定位。
此切片已经 mock gbc 源码/编译契约验证；live 身份、OAuth 刷新与四家 E2E 仍未验收。
通用模块参考不变；当前完整边界与真实测试数见正式包 README / RESULTS。

## t183 后续：通知 worker 差异（仅 mock，2026-11-20，Asia/Shanghai）

沿用终态 + outbox 同事务、claim 在副作用前落盘、故障结果不谎称成功的参考机制，
但不把 OpenCode 的 job/inbox ACK 当成远端 bot ACK。新增 002 迁移表达 pending /
inflight / accepted / rejected / not_dispatched / unknown，原 delivered 列不复用。
单独通知 worker 调外部 gbc message send（stdin 正文）；只有明确未 dispatch 且
可重试才有三次持久预算。inflight 重启变 unknown；未知写不重发，仅一次只读
message status 对账。drain abort 并观察有界子进程退出。通知结果不覆盖任务终态。
这是 agentwatch 的差异，不是新增通用 PoC；没有引入 gbc/proto/App 运行依赖，
没有真实发送或凭据访问。ACK/去重仍未证明；当前细节以正式包 README/RESULTS 为准。
