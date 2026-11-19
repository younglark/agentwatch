import { DEFAULT_API_BASE, DEFAULT_TAIL_BYTES } from "./args.js";
import { EXIT } from "./exit.js";

export const VERSION = "0.1.0";

export const HELP = `agentwatch ${VERSION}

用已登录的官方 Grok Bot 桌面应用凭据，包装任意非交互命令，并在命令结束、失败或超时后向指定 bot 发送恰好一条通知。

用法:
  agentwatch --bot <agent-id> [--timeout <秒>] [--json] [--dry-run] -- -- <命令...>

选项:
  --bot <agent-id>     必填。要通知的 Grok Bot UUID。
  --timeout <秒>       子进程时限，默认 0（不限时）。到期后杀死子进程并以 timeout 通知。
  --json               机器可读结果写到 stdout；错误 JSON 写到 stderr。
  --dry-run            走完整流程但不调用发送 RPC（仍会校验 bot / 读取凭据）。
  --tail-bytes <n>     通知里 stdout/stderr 尾部的字节上限，默认 ${DEFAULT_TAIL_BYTES}。
  --api-base <url>     Connect API 地址，默认 ${DEFAULT_API_BASE}。也可设 AGENTWATCH_API_BASE。
  --secrets-file <path>
                       覆盖官方 sand-secrets.json 路径（只读）。也可设 AGENTWATCH_SECRETS_FILE。
  --help, -h           显示帮助。
  --version, -v        显示版本。

示例:
  agentwatch --bot 8f6d6b87-e7b6-4bf3-a45d-fbca5bc418e5 -- -- echo poc
  agentwatch --bot <id> --timeout 300 --json -- -- npm test
  agentwatch --bot <id> --dry-run -- -- make build

退出码:
  ${EXIT.OK}  成功（子进程成功且通知已发出，或 --dry-run 预览成功）
  ${EXIT.CHILD}  子进程失败（通知可能已发出）
  ${EXIT.USAGE}  用法错误
  ${EXIT.TIMEOUT}  子进程超时（通知可能已发出）
  ${EXIT.AUTH}  无法读取或解密官方凭据，或 RPC 返回未认证
  ${EXIT.NOT_FOUND}  完整列表中找不到该 bot（不会运行命令）
  ${EXIT.NOTIFY}  服务器拒绝消息，或通知失败
  ${EXIT.RETRYABLE}  可重试的网络/服务错误
  ${EXIT.FAILURE}  其他失败
  ${EXIT.UNKNOWN}  列表被截断，bot 是否存在未知（不会运行命令）

鉴权:
  只读使用官方 Grok Bot 应用的 sand-secrets.json（Electron safeStorage，v10 密文）。
  不刷新 token，不回写凭据文件，不使用 ~/.gbc，也不会启动第二套登录。
  若 token 过期或 RPC 返回 401，会再读一次文件（假定正在运行的官方应用已刷新磁盘上的 token）。
  仍不可用时退出 ${EXIT.AUTH}，并提示先打开并登录 Grok Bot。

协议:
  非官方。校验 bot：ListGrokBotAgents 再按 --bot 过滤（没有 Get RPC）。
  通知：SendGrokBotUserMessage，只发一次，不等待回复。
`;
