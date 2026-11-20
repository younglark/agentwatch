# agentwatch

> **新架构首批实现：** 见 [packages/agentwatch](packages/agentwatch/README.md) 和
> [OpenCode v2 源码实施映射](docs/task-core-opencode-map.md)。Bun 任务核心与五命令
> 已独立实现；身份查询与终态通知现由内建 Connect/HTTP 客户端直接请求，`grokbot-control` 仅协议参考，无 `gbc` 运行依赖。正式包已补 macOS 独立登录与令牌刷新；Linux/Windows 只读官方桌面 access token，绝不刷新或回写官方会话。三端保留任务 daemon，仅做合成凭据/本地 mock 验收，未 live 验证、未证明持久 ACK 或远端去重。本文件下面
> 是旧 auth/RPC PoC 的历史说明；不是新架构的生产入口。


包装一条非交互命令，并在它结束、失败或超时后，向指定的 Grok Bot 发送恰好一条通知。

这不是官方产品。协议与凭据格式都来自对官方 Grok Bot 桌面应用（基线约 0.79.4）和 Cursor 登录流程的观察，应用更新后可能需要跟进。

## 它做什么

- 在 `--` 之后运行任意命令（不分配 TTY，避免交互挂起）。
- 开始前用 `ListGrokBotAgents` 校验 `--bot`；找不到或列表被截断时**不运行命令**。
- 子进程成功、失败或超时后，用 `SendGrokBotUserMessage` 发一次通知，不等待 bot 回复。
- 鉴权按平台写死（没有 `--auth`，也不会自动回退）：
  - **macOS**：独立 Cursor 登录，由本机守护进程保管凭据、登录轮询和 token 刷新。不读官方 `sand-secrets.json`，不访问钥匙串，也不使用 `~/.gbc`。
  - **Linux / Windows**：只读官方桌面应用的 `sand-secrets.json`。不刷新、不回写。缺失或过期则退出 4，提示先打开并登录官方 Grok Bot。不会改走独立登录，也不会启动守护进程。

它**不**做：webhook、Stop Hook、等待 bot 回复、发布 npm 包、OpenCode 式的远程配对/隧道/局域网暴露。

## 安装

需要 Node.js 20+。

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
agentwatch login [--json]
agentwatch logout
agentwatch service status|start|stop|restart
```

`--timeout` 默认 `0`，表示不限时。`--dry-run` 仍会读取凭据、校验 bot 并运行命令，只是不调用发送 RPC。

示例：

```bash
agentwatch --bot 8f6d6b87-e7b6-4bf3-a45d-fbca5bc418e5 -- -- echo poc
agentwatch --bot <id> --timeout 300 --json -- -- npm test
agentwatch --bot <id> --dry-run -- -- make build
agentwatch login
```

stdout 只放数据（`--json` 时为结果对象）。进度、错误、登录链接和子进程的实时输出写在 stderr。`--json` 的错误对象以及包含 `login_url` 的登录提示也写在 stderr。

`login` / `logout` / `service` 只在 macOS 用于独立鉴权（`logout` 在 Linux / Windows 上是空操作并提示共享鉴权由官方应用管理）。`service run` 是内部入口，用于拉起守护进程。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功（子进程成功且通知已发出，或 `--dry-run` / login / logout / service 成功） |
| 1 | 子进程失败（通知可能已发出） |
| 2 | 用法错误 |
| 3 | 子进程超时（通知可能已发出） |
| 4 | 无法取得凭据、登录超时或被拒绝，或 RPC 返回未认证 |
| 5 | 完整列表中找不到该 bot（不会运行命令） |
| 7 | 服务器拒绝消息，或通知失败 |
| 8 | 可重试的网络/服务错误 |
| 9 | 其他失败（含本机端口被非本服务占用、restart 未能确认停止） |
| 10 | 列表被截断，bot 是否存在未知（不会运行命令） |

退出 4 的常见情况：Linux / Windows 上找不到或无法解密官方凭据、官方 token 已过期；macOS 上独立登录超时、被组织策略拒绝（`sign_in_policy_violation`）、必须刷新却未设置 `AGENTWATCH_OAUTH_CLIENT_ID`、或尚未登录且轮询未完成。

## 鉴权

### macOS：独立登录 + 本机守护进程

数据目录由 `AGENTWATCH_HOME` 覆盖，默认是 `~/Library/Application Support/agentwatch/`。目录权限 0700；`credentials.json` 与 `service.json` 为 0600。不要把目录设到官方应用 userData 或 `~/.gbc`。

第一次需要鉴权或发通知的命令会 `ensure` 本机服务：

- 复用健康且**版本相同**的在任实例，不会再起一份。
- 版本不匹配：先停止旧服务，再启动当前版本。版本写在 `service.json`。
- `service.json` 记录 pid、version、绑定地址、started_at 以及仅供本机客户端使用的密钥。配置在 `config.json`，凭据在 `credentials.json`。status 与日志不会打印 token、verifier 或该密钥。
- 登记指向死 pid、陈旧套接字或不健康进程时，拉起新实例。活着的 pid 视为所有者，不会盲删锁文件。
- 只绑定 `127.0.0.1`（或其它回环地址）。若端口被**非** agentwatch 进程占用，退出 9 并给出提示，不会抢占。
- 服务在 CLI 退出或崩溃后继续运行，继续拥有登录轮询和 token 刷新。机器重启后不会自动拉起（本 PoC 不安装 launchd），直到下次命令再 `ensure`。
- 更改绑定配置会先停止服务，下次 `ensure` 按新配置启动。
- `agentwatch service status|start|stop|restart`：status 只输出非机密元数据。显式 `restart` 必须先确认旧进程已停止，否则不会启动新实例。

登录协议是非官方的（`loginDeepControl` + `/auth/poll`），用户只需要一条链接，无需输入设备码，也没有隧道或 localhost 回调：

```
https://cursor.com/loginDeepControl?challenge=<challenge>&uuid=<uuid>&mode=login&redirectTarget=cli
```

（`cli` 预设，不加 `supportsSelectedTeamLogin`。网站默认 `https://cursor.com`，API 默认 `https://api2.cursor.sh`。）

CLI 向守护进程请求开始登录后，**立即**把该 URL 打到 stderr（`--json` 时为包含 `login_url` 的 JSON 对象）。守护进程轮询：

```
GET {api}/auth/poll?uuid=&verifier=
```

404 表示仍在等待。退避 `1s × 1.2^i`，上限 10s，最多 150 次；连续 3 次非 404 失败则停止。`403 {error:"sign_in_policy_violation"}` 为硬失败。成功体含 `{accessToken, refreshToken}`，写入 agentwatch 自己的目录。verifier 不会出现在 stdout / stderr / 日志里。主命令若发现尚未登录或已过期，会在同一次调用里打印链接并等待轮询（无 TTY 提示）；超时退出 4。CLI 断开不会中止守护进程上的轮询。

独立 token 允许刷新（与官方桌面 token 不同，绝不会 refresh 或写回官方凭据）：`POST {backend}/oauth/token`，JSON 为 `{client_id, grant_type:"refresh_token", refresh_token}`。`client_id` 只来自 `AGENTWATCH_OAUTH_CLIENT_ID`，不会内置或从应用包提取。未设置时，仍有效的 access token 继续使用；已过期且必须刷新则退出 4，并提示设置该环境变量或重新登录。有 client id 时，大约在 JWT `exp` 前 300 秒刷新。

### Linux / Windows：共享官方桌面凭据

读取官方应用用户目录下的 `sand-secrets.json`：

- Linux：`~/.config/Grok Bot/sand-secrets.json`（若稳定版未登录，再试 `Grok Bot Research`）
- Windows：`%APPDATA%\Grok Bot\sand-secrets.json`

`cursor-accounts` 可能是 JSON 字符串，先解析再取 `accounts[active]`。token 值是 Electron safeStorage 密文（磁盘上常为以 `djEw` 开头的 base64，解码后前缀 `v10`）。

解密方式（只读，不打印密钥）：

- Linux：先尝试 `secret-tool lookup application "Grok Bot"`（或等价的 Secret Service 查询），失败后再回退 Chromium `basic_text` 的公开密码 `peanuts`（1 次迭代）。只有解密结果看起来像 JWT/JSON 时才接受，不会臆造密钥。
- Windows：DPAPI / Local State 中的 OSCrypt 密钥（PoC 路径已实现，尚未在本仓库 live 验证）。

若 token 看起来过期或 RPC 返回 401，会再读一次文件（假定正在运行的官方应用已经刷新了磁盘上的值）。仍然不可用就退出 4，并提示先打开并登录 Grok Bot。可用 `AGENTWATCH_SECRETS_FILE` 覆盖路径，仅供测试或非标准安装。

## 协议

非官方 Connect RPC，默认 `https://api2.cursor.sh`：

- 校验：`ListGrokBotAgents`，再按 `--bot` 过滤（没有 Get RPC）。
- 通知：`SendGrokBotUserMessage`，`sessionId=""` 表示默认会话，`messageId` 为新 UUID。只发一次。

字段来自 grokbot-control 冻结的 0.79.4 schema 子集。读 RPC 在上游项目中已有 live 验证；写 RPC（发送）需要在你的环境里自行确认。独立登录协议同样未在本仓库对真实 `cursor.com` 做交互式 live 验证。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run build
```

通知正文和 `--json` 输出都会尽量脱敏：JWT、Bearer、`djEw` 密文和常见密钥前缀不会被回显。

## 许可证

尚未另选许可证。代码按仓库现状提供，仅供个人与研究使用。不是 Cursor / Grok Bot / xAI 的官方工具。
