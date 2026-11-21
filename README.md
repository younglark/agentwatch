# agentwatch

正式实现位于 [packages/agentwatch](packages/agentwatch/README.md)：Bun 任务核心，
`run / status / logs / wait / cancel`、惰性 daemon、SQLite 任务账本与终态通知。
**尚未达到生产就绪**；当前契约、鉴权配置、退出码和未验收边界以正式包 README 为准。

## 构建与验证

需要 Bun **1.4.4**。从仓库根目录进入正式包；依赖使用该包自己的 `bun.lock`：

```sh
cd packages/agentwatch
bun install --frozen-lockfile
bun run verify
# 仅构建正式二进制：
bun run build
./dist/agentwatch --help
```

已有依赖时不必重复 install。`verify` 顺序执行 typecheck、源码测试、正式二进制和
测试宿主编译、隔离编译产物测试；不运行真实厂商 CLI，不使用真实后端或凭据。
`dist/test-host` 只是测试夹具，不是用户入口。

从仓库根目录也可以执行以下转发脚本（依赖仍须在正式包中安装）：

```sh
bun run typecheck
bun run test
bun run build
bun run verify
./packages/agentwatch/dist/agentwatch --help
```

根 `package.json` 是 **private 的脚本门面，不是 workspace 或可安装的 CLI 包**，没有
bin、prepare、安装 hook 或自己的依赖/锁。请用 `bun run test`，不要用根目录的裸
`bun test` 自动发现测试（编译测试需要先构建且不能与源码测试同时改动 source 目录）。

## 使用入口与兼容性

直接运行上面构建的 `packages/agentwatch/dist/agentwatch`；命令示例与鉴权说明见
[正式包命令契约](packages/agentwatch/README.md#minimal-command-contract)。本次不更改
正式 CLI 名称、状态目录、IPC 协议、API 或任务行为。

旧根层 Node auth/RPC PoC 和最小 Bun daemon spike 已从当前树移除。
旧 `node dist/cli.js`、根 npm/tsc 构建和 GitHub npx 安装入口已停用，**不是自动升级或
命令兼容层**。没有新增 npm 安装/下载脚本，也不表示已发布 npm 包或跨平台安装产物。

## 设计与历史

- [OpenCode 源码实施映射](docs/task-core-opencode-map.md)（按轮次保留的历史研究）
- [原型退役与保留契约索引](docs/historical-prototypes.md)（Git 固定链接，不另存快照）
- [正式包验证记录](packages/agentwatch/RESULTS.md)

正式包的代码、测试、依赖锁、初始 schema 与证据仍独立保留。历史记录中的旧路径和命令仅是
当时的验证依据，不是当前可执行入口。

## 许可证与边界

尚未另选许可证；代码按仓库现状提供，仅供个人与研究使用。不是 Cursor / Grok Bot /
xAI 的官方工具。后端契约来自非官方逆向资料；本仓库的合成凭据/本地 HTTP mock
验收不等同于真实登录、真实通知持久 ACK、远端去重或 macOS/Windows 原生验收。
