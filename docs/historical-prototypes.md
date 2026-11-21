# 原型退役与保留契约索引

2026-11-21，Asia/Shanghai。本次清理只移除已被正式包替代的原型与旧根安装入口。
正式实现仍在 `packages/agentwatch/`，不搬迁代码，不更改任务或鉴权业务。

## 已退役（historical，不是当前入口）

删除根 `src/`、`test/`、专属 Node 依赖锁/tsconfig，以及
`experiments/bun-daemon-spike/` 的跟踪实现、配置、脚本、测试和实验专属证据。
原型的完整档案由 Git 历史保存，不另复制代码或大体积证据快照。
根包只转发正式包 Bun 脚本；旧 Node bin、prepare、npm/npx 使用说明不再生效。

删除前的固定点：`ece162fe42e8a73b1987e84fb32d24ecc6bb39c3`。

- [旧根 auth/RPC PoC 代码、测试和当时 README](https://github.com/younglark/agentwatch/tree/ece162fe42e8a73b1987e84fb32d24ecc6bb39c3)
- [最小 Bun daemon spike（含 SPEC / REVIEW / RESULTS / evidence）](https://github.com/younglark/agentwatch/tree/ece162fe42e8a73b1987e84fb32d24ecc6bb39c3/experiments/bun-daemon-spike)
- [原型 SPEC 的接受条件](https://github.com/younglark/agentwatch/blob/ece162fe42e8a73b1987e84fb32d24ecc6bb39c3/experiments/bun-daemon-spike/SPEC.md)

## 值得保留的接受条件（以正式包现行契约为准）

| 原型验证的问题 | 正式包中的对应依据 |
|---|---|
| 同一 request ID + 规范化输入不重复执行，改变输入冲突 | `test/command-contracts.ts`、`test/core.test.ts` |
| queued/starting 取消后不能再启动；用 barrier 与真实 spawn 收据证明 | `test/core.test.ts`、`test/command-contracts.ts` |
| 运行取消只在观察到 close 后终态；wait 超时不杀任务 | `test/process-tree.test.ts`、`test/command-contracts.ts` |
| task 终态与 outbox 原子提交；失去监督为 unknown，不自动重放 | `src/storage.ts`、`test/core.test.ts`、`test/command-contracts.ts` |
| 明确 shutdown 后先证明退出，再允许 finally 安全收割 | `test/command-contracts.ts` 的 authenticated shutdown 契约 |
| 编译测试隔离源码/迁移和 PATH，而非只改变 cwd | `test/compiled.test.ts` |

表中路径均相对于 `packages/agentwatch/`。这些条件在正式包已有对应测试，不迁移
原型的 fake 子命令或 test-barrier hook 到生产入口。

## 不能沿用的原型假设

最小 spike 的 Linux abstract socket、fake 通知重试、JSON payload 命令和退出码
只是内部实验设计，不是正式协议。旧根 PoC 的任意命令、`--timeout`、`--dry-run`、
service 子命令、退出码和鉴权目录也不是正式包兼容承诺。

[OpenCode 实施映射](task-core-opencode-map.md)、正式包历史 RESULTS / REVIEW / evidence
保留研究与验收价值；其中对旧根/实验路径的提及按其记录时的固定点理解，不要求这些
历史文件仍在当前工作树。当前行为优先看 [正式包 README](../packages/agentwatch/README.md)
和最新 RESULTS 章节。

本次不删除既有 ignored 依赖或编译输出（例如本地实验 node_modules/dist），也不会将
它们当作可运行入口；重新获取当前树不会包含这些旧本地产物。
