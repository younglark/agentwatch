# agentwatch

包装一条非交互命令，并在它结束、失败或超时后，向指定的 Grok Bot 发送恰好一条通知。

这不是官方产品。协议与凭据格式都来自对官方 Grok Bot 桌面应用（基线约 0.79.4）的观察，应用更新后可能需要跟进。

## 它做什么

- 在 `--` 之后运行任意命令（不分配 TTY，避免交互挂起）。
- 开始前用 `ListGrokBotAgents` 校验 `--bot`；找不到或列表被截断时**不运行命令**。
- 子进程成功、失败或超时后，用 `SendGrokBotUserMessage` 发一次通知，不等待 bot 回复。
- 只读使用官方桌面应用的 `sand-secrets.json`（Electron safeStorage）。不维护 `~/.gbc`，不刷新 token，不回写凭据。

它**不**做：webhook、Stop Hook、第二套登录、等待 bot 回复、发布 npm 包。

## 安装

需要 Node.js 20+。本机已登录官方 Grok Bot 桌面应用。

```bash
git clone https://github.com/younglark/agentwatch.git
cd agentwatch
npm install
npm run build
node dist/cli.js --help
```

也可以在克隆后用 `npx --yes github:younglark/agentwatch --help`（不发布到 npmjs）。

## 用法

```bash
agentwatch --bot <agent-id> [--timeout <秒>] [--json] [--dry-run] -- -- <命令...>
```

`--timeout` 默认 `0`，表示不限时。`--dry-run` 仍会读取凭据、校验 bot 并运行命令，只是不调用发送 RPC。

示例：

```bash
agentwatch --bot 8f6d6b87-e7b6-4bf3-a45d-fbca5bc418e5 -- -- echo poc
agentwatch --bot <id> --timeout 300 --json -- -- npm test
agentwatch --bot <id> --dry-run -- -- make build
```

stdout 只放数据（`--json` 时为结果对象）。进度、错误和子进程的实时输出写在 stderr。`--json` 的错误对象也写在 stderr。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功（子进程成功且通知已发出，或 `--dry-run` 预览成功） |
| 1 | 子进程失败（通知可能已发出） |
| 2 | 用法错误 |
| 3 | 子进程超时（通知可能已发出） |
| 4 | 无法读取/解密官方凭据，或 RPC 返回未认证 |
| 5 | 完整列表中找不到该 bot（不会运行命令） |
| 7 | 服务器拒绝消息，或通知失败 |
| 8 | 可重试的网络/服务错误 |
| 9 | 其他失败 |
| 10 | 列表被截断，bot 是否存在未知（不会运行命令） |

## 鉴权

读取官方应用用户目录下的 `sand-secrets.json`：

- Linux：`~/.config/Grok Bot/sand-secrets.json`（若稳定版未登录，再试 `Grok Bot Research`）
- macOS：`~/Library/Application Support/Grok Bot/sand-secrets.json`
- Windows：`%APPDATA%\Grok Bot\sand-secrets.json`

`cursor-accounts` 可能是 JSON 字符串，先解析再取 `accounts[active]`。token 值是 Electron safeStorage 密文（磁盘上常为以 `djEw` 开头的 base64，解码后前缀 `v10`）。

解密方式（只读，不打印密钥）：

- macOS：钥匙串 generic password，service 为 `Grok Bot Safe Storage`；PBKDF2(password, salt `saltysalt`, 1003 次, SHA-1, 16 字节密钥)，AES-128-CBC，IV 为 16 个空格。
- Linux：先尝试 `secret-tool lookup application "Grok Bot"`（或等价的 Secret Service 查询），失败后再回退 Chromium `basic_text` 的公开密码 `peanuts`（1 次迭代）。只有解密结果看起来像 JWT/JSON 时才接受，不会臆造密钥。
- Windows：DPAPI / Local State 中的 OSCrypt 密钥（PoC 路径已实现，尚未在本仓库的 CI 中 live 验证）。

若 token 看起来过期或 RPC 返回 401，会再读一次文件（假定正在运行的官方应用已经刷新了磁盘上的值）。仍然不可用就退出 4，并提示先打开并登录 Grok Bot。可用 `AGENTWATCH_SECRETS_FILE` 覆盖路径，仅供测试或非标准安装。

## 协议

非官方 Connect RPC，默认 `https://api2.cursor.sh`：

- 校验：`ListGrokBotAgents`，再按 `--bot` 过滤（没有 Get RPC）。
- 通知：`SendGrokBotUserMessage`，`sessionId=""` 表示默认会话，`messageId` 为新 UUID。只发一次。

字段来自 grokbot-control 冻结的 0.79.4 schema 子集。读 RPC 在上游项目中已有 live 验证；写 RPC（发送）需要在你的环境里自行确认。

## 开发

```bash
npm install
npm test
npm run build
```

通知正文和 `--json` 输出都会尽量脱敏：JWT、Bearer、`djEw` 密文和常见密钥前缀不会被回显。

## 许可证

尚未另选许可证。代码按仓库现状提供，仅供个人与研究使用。不是 Cursor / Grok Bot / xAI 的官方工具。
