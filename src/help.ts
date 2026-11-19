import { DEFAULT_API_BASE, DEFAULT_TAIL_BYTES } from "./args.js";
import { EXIT } from "./exit.js";

export const VERSION = "0.2.0";

export const HELP = `agentwatch ${VERSION}

包装任意非交互命令，并在命令结束、失败或超时后向指定 Grok Bot 发送恰好一条通知。

用法:
  agentwatch --bot <agent-id> [--timeout <秒>] [--json] [--dry-run] -- -- <命令...>
  agentwatch login [--json]
  agentwatch logout
  agentwatch service status|start|stop|restart

选项:
  --bot <agent-id>     必填（运行命令时）。要通知的 Grok Bot UUID。
  --timeout <秒>       子进程时限，默认 0（不限时）。到期后杀死子进程并以 timeout 通知。
  --json               机器可读结果写到 stdout；错误与登录 URL 的 JSON 写到 stderr。
  --dry-run            走完整流程但不调用发送 RPC（仍会校验 bot / 读取凭据）。
  --tail-bytes <n>     通知里 stdout/stderr 尾部的字节上限，默认 ${DEFAULT_TAIL_BYTES}。
  --api-base <url>     Connect API 地址，默认 ${DEFAULT_API_BASE}。也可设 AGENTWATCH_API_BASE。
  --secrets-file <path>
                       仅 Linux / Windows：覆盖官方 sand-secrets.json 路径（只读）。也可设 AGENTWATCH_SECRETS_FILE。
  --help, -h           显示帮助。
  --version, -v        显示版本。

示例:
  agentwatch --bot 8f6d6b87-e7b6-4bf3-a45d-fbca5bc418e5 -- -- echo poc
  agentwatch --bot <id> --timeout 300 --json -- -- npm test
  agentwatch login
  agentwatch service status

退出码:
  ${EXIT.OK}  成功（子进程成功且通知已发出，或 --dry-run / login / logout / service 成功）
  ${EXIT.CHILD}  子进程失败（通知可能已发出）
  ${EXIT.USAGE}  用法错误
  ${EXIT.TIMEOUT}  子进程超时（通知可能已发出）
  ${EXIT.AUTH}  无法取得凭据、登录超时/被拒绝，或 RPC 返回未认证
  ${EXIT.NOT_FOUND}  完整列表中找不到该 bot（不会运行命令）
  ${EXIT.NOTIFY}  服务器拒绝消息，或通知失败
  ${EXIT.RETRYABLE}  可重试的网络/服务错误
  ${EXIT.FAILURE}  其他失败（含本机服务端口被非本服务占用、restart 未能确认停止）
  ${EXIT.UNKNOWN}  列表被截断，bot 是否存在未知（不会运行命令）

鉴权（按平台写死，没有 --auth，也不会自动回退）:
  macOS：只用独立 Cursor 登录。不读取官方 sand-secrets.json，不访问钥匙串。
    首次需要鉴权的命令会 ensure 本机守护进程：复用健康且版本相同的在任实例；
    版本不匹配则先停后启；登记指向死 pid、陈旧套接字或不健康进程时拉起新实例。
    活着的 pid 视为所有者，不会盲删锁文件。服务只绑定 127.0.0.1；
    若端口被非 agentwatch 进程占用，退出 ${EXIT.FAILURE} 并提示，不会强行抢占。
    守护进程在 CLI 退出后继续运行（拥有登录轮询与 token 刷新）；重启机器后不会自动拉起，
    下次命令再 ensure。不安装 launchd。
    未登录或过期且无法刷新时，立即在 stderr 打印一条登录链接（--json 时为包含 login_url 的 JSON），
    无需另输设备码，也没有隧道或 localhost 回调。守护进程轮询 /auth/poll；CLI 断开不会中止轮询。
    协议（非官方）：https://cursor.com/loginDeepControl?challenge=<challenge>&uuid=<uuid>&mode=login&redirectTarget=cli
    轮询 GET {api}/auth/poll?uuid=&verifier= ；404 表示等待中。
  Linux / Windows：只用官方桌面应用共享鉴权（只读 sand-secrets.json，不 refresh、不回写）。
    凭据缺失或过期则退出 ${EXIT.AUTH}，提示先打开并登录官方 Grok Bot。不会改走独立登录，也不会启动守护进程。
    Windows DPAPI 路径已实现，但尚未在本仓库 live 验证。

环境变量:
  AGENTWATCH_HOME              数据目录（凭据、service.json、锁）。默认 macOS 为
                               ~/Library/Application Support/agentwatch。目录 0700，凭据与 state 0600。
  AGENTWATCH_OAUTH_CLIENT_ID   独立鉴权刷新用的公开 OAuth client id。不会内置或从应用包提取。
                               未设置时，仍有效的 access token 继续使用；必须刷新却没有该变量则退出 ${EXIT.AUTH}。
  AGENTWATCH_API_BASE          API，默认 ${DEFAULT_API_BASE}。
  AGENTWATCH_WEBSITE           登录页，默认 https://cursor.com。
  AGENTWATCH_SERVICE_HOST/PORT 本机服务绑定（仅回环；更改绑定会先停止服务，下次 ensure 再按新配置启动）。
  AGENTWATCH_SECRETS_FILE      仅 Linux / Windows，覆盖官方凭据路径。

协议:
  非官方。校验 bot：ListGrokBotAgents 再按 --bot 过滤（没有 Get RPC）。
  通知：SendGrokBotUserMessage，只发一次，不等待回复。
  登录协议同样非官方（loginDeepControl + /auth/poll）。
`;
