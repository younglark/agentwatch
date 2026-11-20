# 外部 gbc npm-v0.7.0 通知契约核验

2026-11-20，Asia/Shanghai。只读 GitHub；未运行真实 gbc、未读取其 store 或发送消息。
原计划 Page 已只读核对：只发冻结的结果/有界报告、终态与通知分离、稳定本地通知 ID，
历史能发不证明远端去重或持久入箱 ACK。本轮遵循后续实现授权，不沿用旧 Page 的搁置状态。

## 命令与输入

[dist/cli/main.js](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/dist/cli/main.js)
279–321 行：message send 支持 --agent-id、--message-id、--text-stdin；--allow-writes 是
显式全局写授权。正文 await readStdin 到 EOF。message status 要 agent-id/message-id；
不传 session-id 时由 gbc 使用默认未报告会话，不是本体猜测一个 session ID。
message history 也存在，但本轮用精确 send status 对账，不读取历史正文或模糊找消息。

## 结果封套与语义

[dist/ops/message.js](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/dist/ops/message.js)
47–122 行：send data 的 agent_id/message_id 为 CLI 关联值，dispatched、delivery/code、
workflow_id、refusal 来自 RPC 映射；note 明示 acceptance only，不是任务/业务成功。
refused 生成 code=refused、ok=false 的失败封套并附 data。
status data 有 status/code、echo_entry_id、rejection_code、accepted_at_ms；同样不是最终
用户可见成功。缺失可选字符串归 null；不假造会话 ID。

[dist/cli/io.js](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/dist/cli/io.js)
成功 stdout、失败 stderr；emitResult 使用 mapExitCode。
[dist/errors.js](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/dist/errors.js)
known_success/ok → 0；refused → 7；retryable → 8；unknown → 10。
[dist/connect/client.js](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/dist/connect/client.js)
保留结构化 GbcError 及 rpc_dispatched:false；不能从普通 retryable 推断写未发生。
[dist/auth/provider.js](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/dist/auth/provider.js)
的刷新网络等错误经拦截器可作为明确未 dispatch 的可重试错误。没有 live 刷新证明。

[冻结枚举](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/vendor/proto-gen/aiserver.v1_pb.js)
只读核值，未复制/导入生成协议代码：delivery 0 unspecified、1 accepted_box、
2 accepted_temporal、3 duplicate、4 refused；send status 0 unspecified、1 not_found、
2 accepted、3 rejected、4 pending、5 unknown_durability。
本体只实现 CLI JSON 契约，不打包 gbc/proto/App，不调用任何 RPC。

## 失败机制差异

沿用 docs/task-core-opencode-map.md 已研究的事务 outbox / 副作用前 claim / 恢复不谎称成功；
不把参考系统 inbox/job 的 ACK 当远端 bot ACK。本地 message_id 稳定仅用于关联查询。
accepted_box/duplicate 只是当前响应的接受分类，不能推出服务端去重承诺或持久性。
对不确定写不重发。只对合法无 data 的 known_failure + rpc_dispatched:false +
retryable:true + exit8 有三次总预算，250ms/500ms；恢复保留预算与下一次时间。
一次自动只读 status 后仍未知就保留 unknown；本轮没有额外手工覆盖本地结论的命令。
