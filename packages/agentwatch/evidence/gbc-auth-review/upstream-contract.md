# npm-v0.7.0 结构化鉴权错误核验

2026-11-20，Asia/Shanghai。只通过 GitHub 只读内容接口核对固定 tag，未执行 gbc。

- [dist/connect/client.js](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/dist/connect/client.js)：
  `connectCodeFor` 把 auth_revoked、auth_refresh_unconfigured、
  auth_refresh_client_mismatch、auth_refresh_subject_mismatch 归入 Unauthenticated。
  `createAuthInterceptor` 保留 GbcError 为 cause；`mapConnectError` 恢复 code、
  outcome、retryable，而不是一律改成 unauthenticated。
- [dist/auth/provider.js](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/dist/auth/provider.js)：
  凭据撤销、刷新配置缺失、client 绑定不符、刷新 subject 不符均有对应码的抛出路径。
- [dist/ops/bot.js](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/dist/ops/bot.js)：
  get → fromErr → failResult，保留结构化 code/outcome/retryable，未把 e.exitCode 放进封套。
- [dist/cli/io.js](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/dist/cli/io.js)：
  emitResult 对失败向 stderr 写封套，再用 mapExitCode(code,outcome,retryable)。
- [dist/errors.js](https://github.com/younglark/grokbot-control/blob/npm-v0.7.0/dist/errors.js)：
  四个码不在 auth/unauthenticated 的 exit 4 分支；known_failure + retryable false
  落 default exit 9。不能因此把所有 exit 9 都当鉴权错误。

修复仅将上述四个精确 code + exit 9 + 非模拟 + ok:false + known_failure +
retryable:false 映射为 agentwatch AUTH_NOT_CONFIGURED / 4。其它 exit 9、未知
鉴权前缀、暂时性的 auth_refresh_network 不扩大为身份未配置。
这是静态契约核验及 mock CLI 验收，不是 live 登录或刷新证明。
