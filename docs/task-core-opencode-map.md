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
