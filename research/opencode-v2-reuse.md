# OpenCode v2：许可、模块边界与可复用事实清单

本文件只陈述可核对的事实，不决定 agentwatch 应该复用到什么程度。

- 调研日期：2026-11-20（Asia/Shanghai，UTC+8）
- 对应票：[OpenCode v2 哪些架构和代码可以合法复用](https://github.com/younglark/agentwatch/issues/10)

## 1. 官方来源与版本

官方网站声明：「opencode.ai is the source of truth for OpenCode… The current version is OpenCode v2。」源代码在 GitHub，许可证为 MIT。出处：

- <https://opencode.ai/llms.txt>
- <https://opencode.ai/legal>

官方源码仓库是 [anomalyco/opencode](https://github.com/anomalyco/opencode)。`https://github.com/sst/opencode` 对该仓库返回 HTTP 301，指向 `https://github.com/anomalyco/opencode`（2026-11-20 用 `curl -sI` 核对）。GitHub 元数据中，该仓库 `homepageUrl` 为 `https://opencode.ai`，默认分支为 `dev`，`licenseInfo.key` 为 `mit`。

本清单对照的已发布版本：

| 项 | 值 |
| --- | --- |
| 仓库 | <https://github.com/anomalyco/opencode> |
| 标签 | [`v2.3.2`](https://github.com/anomalyco/opencode/releases/tag/v2.3.2)（轻量标签，指向提交本身） |
| 提交 | [`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`](https://github.com/anomalyco/opencode/commit/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1)（`release: v2.3.2`） |
| 提交时间 | 2026-11-18 00:28:06 UTC（Asia/Shanghai：2026-11-18 08:28:06） |
| GitHub Release 发布时间 | 2026-11-18 01:35:12 UTC（Asia/Shanghai：2026-11-18 09:35:12） |

说明：仓库默认分支 `dev` 在标签之后仍有推送（GitHub `pushedAt` 曾显示 2026-11-19 19:48:39 UTC）。下文路径与行号均相对于 **v2.3.2 / `c0ad18b`**，后续提交可能漂移。同仓库另有仍在发布的 v1 标签（例如 [`v1.19.6`](https://github.com/anomalyco/opencode/releases/tag/v1.19.6)，2026-11-17 07:21:32 UTC）以及 npm 包 `opencode-ai@1.19.6`；那些不是本清单所称的 OpenCode v2。

## 2. 许可证与使用条件

### 2.1 根许可证（MIT）

仓库根目录 [`LICENSE`](https://github.com/anomalyco/opencode/blob/v2.3.2/LICENSE) 全文为 MIT License，版权行是 `Copyright (c) 2025 opencode`。根 [`package.json`](https://github.com/anomalyco/opencode/blob/v2.3.2/package.json) 的 `"license"` 也是 `"MIT"`。

MIT 授权「use, copy, modify, merge, publish, distribute, sublicense, and/or sell」，条件是：

> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

软件按「AS IS」提供，不含担保。官方法律页将开源许可证链到该文件：<https://opencode.ai/legal> 中的 “Open source license (MIT)”。

官方产品页写明：「The source code is public on GitHub under the MIT License, meaning anyone can use, modify, or contribute to its development。」出处：<https://opencode.ai/product>。

### 2.2 开源软件与托管服务条款是分开的

《Terms of Use》（生效日期 2026-11-08）摘要第一句：

> These Terms cover the website, the inference product and the hosted software. Open source software you run yourself is governed by its own license.

正文进一步写：

> For clarity, our open source software that is not provided to you on a hosted basis is subject to the open source license and terms set forth on the applicable repository where you access such open source software, and such license and terms will exclusively govern your use of such open source software.

出处：<https://opencode.ai/legal/terms-of-service>。

客户协议将 “OpenCode OSS Offering” 定义为在 <https://github.com/anomalyco/opencode> 以 MIT 提供的软件，并写明：MIT「exclusively governs Customer's rights in and use of the OpenCode OSS Offering as software」，且「Customer's rights under the MIT License are perpetual and irrevocable… and are not conditioned on, limited by, or affected by this Agreement」。出处：<https://opencode.ai/console/legal/opencode-customer-agreement.pdf>。该协议同时约束托管服务与推理服务；这些服务本身不是把 OSS 再授权成别的许可证。

### 2.3 子目录中的不同版权声明与例外

多数 `packages/*/package.json` 声明 `"license": "MIT"`，版本为 `2.3.2`。需要单独记录的例外或附加版权：

1. **`packages/process-daemon/LICENSE`**：同样是 MIT，但版权行是 `Copyright (c) 2026 James Long`（不是根 LICENSE 的 `2025 opencode`）。该包是独立的 PTY 守护进程，见第 5.5 节。
2. **`packages/process-daemon/src/ghostty/LICENSE`**：MIT，`Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors`。
3. **`packages/plugins/figma/skills/NOTICE.md`** 明确写：这些 skill 目录从 Figma 的 `mcp-server-guide` 原样复制，「These are third-party materials. OpenCode's MIT license does not relicense them。」使用受 [Figma Developer Terms](https://www.figma.com/legal/developer-terms/) 约束。
4. **桌面/应用第三方声明**：`packages/app/src/settings/about/notices/` 列出随应用分发的第三方软件（例如 BetterOffice、eigenpal docx editor，Apache License 2.0）以及多款 SIL Open Font License 1.1 字体（含保留字体名称，如 Carlito、Liberation）。复制这些组件时需遵守各自许可证，而不是只保留 OpenCode 根 LICENSE。
5. 若干 package.json **未写** `license` 字段（例如 `packages/httpapi-codegen`、`packages/latex`、`packages/merman`、部分 `services/*`）。它们仍位于声明 MIT 的同一仓库中，但包清单本身没有单独的 SPDX 字段。

### 2.4 商标与命名（MIT 不授予商标权）

品牌指南「Trademarks」一节：

> OpenCode and the OpenCode logo are trademarks of Anomaly. Do not use them to suggest that Anomaly endorses or sponsors you, in your product or company name, or on merchandise without permission. For questions, email press@anoma.ly.

出处：<https://opencode.ai/brand>。

同一页对集成项目的命名要求：「Lead with your own name, so it is clear that the project is yours. Write `Linear for OpenCode` or name the package `opencode-linear`. Do not write `OpenCode Linear` or `Linear by OpenCode`.」允许使用官方 badge 表明 “Works with” / “Built with”，但「do not change the colors or the text」。

仓库 [`README.md`](https://github.com/anomalyco/opencode/blob/v2.3.2/README.md) 另有说明：

> If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

新闻稿页也写：可用于撰写关于 OpenCode 的内容，「Do not change them, and do not suggest that OpenCode endorses your work。」出处：<https://opencode.ai/press>。

以上是商标与品牌规则，不是对 MIT 源码复制的额外版权限制。

## 3. 仓库与模块边界

v2.3.2 是 Bun monorepo，根 `package.json` 的 workspaces 为 `packages/*`、`packages/plugins/*`、`services/*`、`packages/data/*`，`packageManager` 为 `bun@1.4.4`。

与本机服务表面直接相关的已发布 npm 包（2026-11-20 查 npm，`latest` 均为 `2.3.2`，许可证 MIT）：

| 包名 | 官方定位（来自文档或 package.json） | 关键依赖 |
| --- | --- | --- |
| `@opencode/client` | HTTP API 的 TypeScript 客户端；Node 下另提供本地服务生命周期 API | `@opencode/schema`、`@opencode/protocol`；peer：`effect`、`solid-js` |
| `@opencode/server` | HTTP 服务器与路由装配 | `@opencode/core`、`@opencode/protocol`、`@opencode/schema`、`@opencode/simulation`、`@opencode/util`、`effect`、`@effect/platform-node` |
| `@opencode/sdk` | 「hosts OpenCode directly inside your application」；在内存中走同一套 HTTP router，不监听端口 | `@opencode/client`、`@opencode/core`、`@opencode/server` 等 |
| `@opencode/protocol` | Effect `HttpApi` 契约（各资源组的路径与 schema） | `@opencode/schema`、`effect` |
| `@opencode/schema` | 共享 schema | — |
| `@opencode/core` | 「Core runtime services for OpenCode.」（会话、工具、插件、数据库等） | 大量运行时依赖，含 `@opencode/ai`、`@opencode/plugin`、`drizzle-orm`、MCP、PTY 等 |
| `@opencode/cli` | `opencode` / `opencode2` 可执行入口；装配服务进程、配置与注册 | `@opencode/client`、`@opencode/server`、`@opencode/tui` 等 |
| `@opencode/util` | 全局路径、进程等工具 | `effect` 等 |
| `@opencode/plugin` | V2 插件编写接口 | `@opencode/client` 等 |
| `@opencode/pty`（npm 版本 0.6.0，与 v2.3.2 仓库中 `packages/process-daemon` 对应） | 「Persistent PTY service for OpenCode」；二进制名 `opencode-pty` | 平台 optionalDependencies |

npm 上 `@opencode/client` 的 `description` 为：「Private generation target for clients derived directly from OpenCode's authoritative Effect `HttpApi`.」尽管措辞含 “Private generation target”，该包 `publishConfig.access` 为 `public`，且官方文档写 `bun add @opencode/client`。出处：<https://opencode.ai/docs/build/client>；包元数据来自 npm `latest`。

官方文档对两条集成表面的划分：

- **网络客户端**（`@opencode/client`）：「Use it when your application connects to an OpenCode server over the network.» 主入口「are browser-compatible and do not include local process management」。本地进程管理在 Node 下从 `@opencode/client/service`（Promise）或 `@opencode/client/effect/service`（Effect）引入。
- **嵌入式 SDK**（`@opencode/sdk`）：「Unlike the network client, it assembles the OpenCode server and routes API calls through its HTTP router in memory. It opens no HTTP listener and adds no network hop.» 出处：<https://opencode.ai/docs/build/sdk/>。

客户端与服务端的职责分割在源码注释里写得很清楚（`packages/client/src/effect/service.ts` 第 14–20 行）：

> The service daemon advertises itself through a registration file in the user's state directory: url, pid, version, and the private password, with 0600 permissions. That file is the complete discovery contract — reading it is all a client needs to connect. The daemon's own configuration (port, persisted password) is CLI-owned and never read here.

也就是说：**发现与生命周期在 `@opencode/client`；端口、密码、CORS、环境变量等持久配置在 CLI（`@opencode/cli` 的 service config）；HTTP 服务实现在 `@opencode/server`，领域运行时在 `@opencode/core`。**

`packages/cli/src/services/service-config.ts` 第 11–13 行把这一绑定写为：CLI 的配置文件，加上指向「which registration file (by channel), which version, and how to spawn opencode」的 `Service.EnsureOptions`。

## 4. 守护进程 / 本机服务进程模型

这里有两套不要混用的本机守护进程：

1. **OpenCode 背景服务（HTTP）**：用户级共享的 `opencode serve --service`，拥有 session、配置、集成、权限和工具执行。这是官方文档所称的 “background service / shared background server”，也是 `Service.ensure()` 管理的对象。
2. **`opencode-pty`（`packages/process-daemon`）**：实验性的线程化 PTY 服务，使用 Unix socket 或 Windows named pipe，不是 localhost HTTP。见第 5.5 节。

### 4.1 官方架构陈述

CLI 文档：

> By default, OpenCode discovers or starts one shared background server for your user account. Every local OpenCode client connects to that server, which owns sessions, configuration, integrations, permissions, and tool execution.

可用 `--standalone` 启动私有服务器，或 `--server` 连接到指定 URL。`opencode service set disabled true` 会停止正在运行的共享服务，并使 CLI 默认不再自动启动它；`--server` 仍可连到显式 URL，`opencode service start` 仍可显式启动共享服务。出处：<https://opencode.ai/docs/cli/>。

排障文档：

> OpenCode uses a client-server architecture. A background server owns sessions, plugins, permissions, and other application state.

健康检查方式是 `opencode service status` 与 `opencode api get /api/info`。文档用语是：「If the service is stuck or unhealthy, restart it」。出处：<https://opencode.ai/docs/troubleshooting/>。

网络文档写明：OpenCode「uses local HTTP connections between the CLI and its background service」，并要求在配置了代理时把 loopback 列入 `NO_PROXY`。出处：<https://opencode.ai/docs/network/>。

### 4.2 注册文件与路径

默认注册文件（客户端 fallback，`packages/client/src/service-probe.ts` 第 38–41 行）：

```text
${XDG_STATE_HOME:-$HOME/.local/state}/opencode/service.json
```

`packages/util/src/global-roots.ts` 对所有带家目录的运行时使用 XDG 路径（`XDG_DATA_HOME` / `XDG_CACHE_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME`，缺省分别为 `~/.local/share`、`~/.cache`、`~/.config`、`~/.local/state`），**没有**再分成 macOS `~/Library/Application Support`。官方排障文档与此一致：

- 注册：`~/.local/state/opencode/service.json`
- 私有服务配置：`~/.config/opencode/service.json`
- 数据库：`~/.local/share/opencode/opencode.db`（可被 `OPENCODE_DB` 覆盖）

出处：<https://opencode.ai/docs/troubleshooting/>。

注册文件 schema（`packages/client/src/service.ts` 的 `Info`）：`id?`、`version?`、`url`、`pid`、`password?`。CLI 写入时权限为 `0600`（`packages/cli/src/services/service-registration.ts`）。服务进程会定期检查自己是否仍拥有该文件；若注册被替换，则关机（同文件中 “managed service registration replaced; shutting down”）。

非 `latest`/`dev`/`beta`/`next` 频道的注册文件名为 `service-<channel>.json`（`service-config.ts` 的 `filename()`）。`processEnv()` 会去掉配置里的 `XDG_STATE_HOME`，因为「A saved value would move the registration away from them」。

### 4.3 `Service.discover` / `ensure` / `stop` / `incumbent`

官方客户端文档（<https://opencode.ai/docs/build/client>）：

- `Service.discover()`「returns a healthy registered endpoint without starting a process.」
- `Service.ensure()`「returns a compatible service, starting one when needed.」
- `Service.stop()`「stops the exact registered service instance.」
- `Service.headers(endpoint)` 生成认证头。

`EnsureOptions` 可传入 `file`、`version`（精确字符串或谓词）、`command`、`env`、`onStart`。省略时使用标准注册路径和命令 `opencode serve --service`。`onStart` 的原因类型是 `"missing" | "version-mismatch"`（`packages/client/src/service.ts`）。

源码中 `ensure` 的注释（`packages/client/src/effect/service.ts` 第 45–47 行）：

> Idempotent ensure-running: reuses a healthy compatible server, replaces a version-mismatched one, and otherwise spawns small contenders until a server becomes discoverable. A contender is never killed merely for slow startup.

`discover` 的注释（同文件第 22–23 行）：只做注册文件 + 健康检查 + 版本门；「Never spawns; escalation to ensure() is the caller's policy.」

`incumbent`：在预期 URL 上识别「已认证且协议兼容」的服务，包括它仍在启动或已经失败的情况（同文件第 33 行）。CLI 的 `serve --service` 若发现 incumbent 已在该 hostname/port 上，会直接返回，不启动第二个进程（`packages/cli/src/server-process.ts` 第 74–78 行）。

### 4.4 探测、决策标签，以及「stale / unhealthy」在源码中的实际含义

健康探测是对注册 URL 发 `GET /api/info`（`packages/client/src/service-probe.ts` 的 `probeResult`）。解码只要求响应 JSON 含字符串 `version` 与非负整数 `pid`。随后：

- 响应 `pid` 必须等于注册文件中的 `pid`，否则视为没有有效服务；
- 若注册文件有 `version`，还必须与响应 `version` 一致，否则同样视为无效；
- HTTP 200 → `state: "ready"`；HTTP 500 → `"failed"`；其他成功解码的状态码（例如 503）→ `"waiting"`；
- HTTP 404 **不是**「旧版本」，而是「协议不兼容」：`compatible: false`。注释写：「A missing health endpoint identifies protocol incompatibility, not an older version. Only an unmet version requirement lets ensure replace this owner.」

`decide()`（同文件第 18–32 行）的决策标签只有四个：

| 标签 | 条件 | `ensure` 的行为 |
| --- | --- | --- |
| `replace` | 版本不满足 `options.version` | 宣布 `version-mismatch`，按 PTY 策略 stop（ready 时 `handoff`，否则 `clear`），再继续招募 |
| `fail` | 协议不兼容，或 `state === "failed"` | 失败返回，不替换不兼容协议的 owner |
| `reuse` | 兼容且 `state === "ready"` | 完成 PTY handoff（若有），返回该 endpoint |
| `wait` | 兼容且仍在启动（非 ready/failed） | 继续轮询，不杀进程 |

**源码和公开客户端 API 里，没有名为 `stale` 或 `unhealthy` 的决策标签或服务状态。** 服务端内部状态机（`packages/server/src/service-status.ts`）是 `"starting" | "ready" | "stopping" | "failed"`。文档散文中使用 “healthy / unhealthy”。与「卡住的注册」对应的实现是：**同一条注册连续 3 次探测超时**，则记录 “Background service is unresponsive; recovery cannot preserve persistent terminals”，清理 PTY，SIGTERM/SIGKILL 该 pid，并立即招募新竞争者（`effect/service.ts` 第 75–88 行；测试名使用 “unresponsive registered service”）。

默认时序（`packages/client/src/service-timing.ts`）：`pollInterval` 25 ms，`requestTimeout` 2 s，`spawnDelay` 5 s（退避上限 `maxSpawnDelay` 30 s），`promiseTimeout` 120 s，停止时每 50 ms 轮询、最多 100 次。竞争者池最多同时保持 2 个启动尝试；「A contender is never killed merely for slow startup。」停止时先 SIGTERM，超时再 SIGKILL。

### 4.5 服务进程如何启动与监听

CLI `ServerProcess` 模式（`packages/cli/src/server-process.ts`）：`"default" | "service" | "stdio"`。

- `service` 模式：读 CLI 服务配置；默认 hostname 为 `127.0.0.1`；默认端口由 `ServiceConfig.defaultPort()` 给出——对 `latest`/`dev`/`beta`/`next` 频道，非 Windows 为 `0xc0de`（十进制 **49374**），Windows 为 `0x70de`（十进制 **28894**），以避免高位端口被 Hyper-V / WinNAT / WSL 预留（`service-config.ts` 第 46–54 行）。密码来自配置，或生成 32 字节 `base64url` 随机值。「Keep the lease credential out of the environment inherited by tools」（stdio 模式会删除 `OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD`）。
- 未指定端口的前台 `serve`（非 service 模式）：从 **4096** 起绑，遇 `EADDRINUSE` 递增（`packages/server/src/process.ts` 的 `listen()`，第 151–157 行）。这与文档示例 `opencode --server http://localhost:4096` 一致，但与共享服务的默认 `0xc0de` 不是同一个数字。

`ServerProcess.start`（`packages/server/src/process.ts`）在缺少 password 时失败（「Missing server password」）。在应用路由 ready 之前，`GET /api/info` 仍可在通过认证后返回身份信息，状态码为：ready → 200，failed → 500，starting/stopping → 503 且带 `retry-after: 1`。其余请求在未 ready 时返回 `service_starting` / `service_stopping` / `service_failed`。boot 失败时进入 `failed` 并保持进程（`Effect.never`），以便探测能看到失败状态。

Basic 认证用户名为 `"opencode"`，密码来自注册文件或 `OPENCODE_PASSWORD`（`service-probe.ts` 的 `headers()`；`process.ts` 的 `ServerAuth.Config`）。

服务在 boot 时恢复「从未释放 execution claim 的 Session」。注释写：「Claims are written when execution starts… recovery covers graceful restarts and unclean deaths alike — no shutdown hook participates.」（`packages/server/src/process.ts` 第 245–252 行）。

## 5. 本机 HTTP API

权威契约在 `@opencode/protocol`（`packages/protocol/src/groups/*.ts`），与官方 API 参考一致：<https://opencode.ai/docs/api>。`@opencode/client`「native types and methods are generated from the same contract」。

健康与身份：`GET /api/info`（operation ID `server.info`），成功类型为 `ServerInfo`：`version`、`pid`、可选 `hostname`、`urls`、`paths.tmp`、可选 `capabilities.persistentPty`（`packages/protocol/src/groups/server.ts`）。另有配对：`POST /api/pair`、`GET /auth/connect/:code`。

工作区不是单独的服务器进程。请求通过查询参数 `location[directory]` 或请求头 `x-opencode-directory` 指定 Location；缺省为 `process.cwd()`（`packages/server/src/location.ts` 第 77–81 行）。

v2.3.2 中 `packages/protocol/src/groups/` 的资源组文件包括：`agent`、`artifact`、`automation`、`blob`、`command`、`config`、`credential`、`debug`、`event`、`experimental`、`form`、`fs`、`generate`、`integration`、`job`、`location`、`mcp`、`media`、`message`、`migration`、`model`、`permission`、`persistent-pty`、`plugin`、`project`、`provider`、`pty`、`reference`、`rpc`、`server`、`session`、`shell`、`skill`、`usage`、`vcs`、`voice`、`websearch`、`worktree`。路径以 `/api/...` 为主（配对是 `/auth/connect/:code`）。事件可通过订阅流式返回。完整字段以 API 参考与 protocol 源码为准，此处不逐条展开。

CLI 可用 `opencode api GET /api/...` 或 operation ID 调用；「Running `opencode api` may start the background service when no compatible healthy service is available。」出处：<https://opencode.ai/docs/troubleshooting/>、<https://opencode.ai/docs/cli/commands/>。

默认监听地址是 loopback（`127.0.0.1`）。`hostname` 可配成 `0.0.0.0` 等；`ServerInfo.connectionURLs` 会为绑定在全部接口上的服务展开 loopback 与外部网卡 URL。CORS 可通过 `opencode service set cors` 或 `serve --cors` 增加来源；「CORS does not change the listening address or bypass server authentication。」

## 5.5 不要把 `opencode-pty` 当成上述 HTTP 背景服务

`packages/process-daemon/README.md` 写明该组件从 [anomalyco/opencode-pty](https://github.com/anomalyco/opencode-pty)（443945a，v0.3.1）迁入 monorepo，是「Experimental threaded PTY service core」。传输是「private authenticated local byte stream (Unix socket or Windows named pipe) and an atomic registration file」，默认运行时目录为 `${XDG_STATE_HOME:-~/.local/state}/opencode/pty`。协议与所有权模型（5 秒内 `own`、`prepare_handoff`、单 owner）与 HTTP `Service.ensure` 不是同一套 API。许可证见第 2.3 节（James Long + 嵌入的 Ghostty MIT 代码）。npm 包名为 `@opencode/pty`，版本 0.6.0。

## 6. 哪些代码在法律上和技术上可以拆出或复用

以下只描述「许可是否允许」和「作为独立单元能否接上」，不评价 agentwatch 应当采用哪一种。

### 6.1 法律上可复制的范围（在遵守各许可证条件的前提下）

- 仓库中声明 MIT 的源代码与文档，包括 `@opencode/client` 的服务生命周期实现、`@opencode/server`、`@opencode/core`、`@opencode/protocol`、`@opencode/sdk`、`@opencode/cli`、`@opencode/util`、以及 `packages/process-daemon`（须保留 **James Long** 版权声明）和其中的 Ghostty 源（须保留 **Mitchell Hashimoto, Ghostty contributors** 声明）。
- 以 npm 依赖方式使用上述已发布包（`latest` 在调研时为 2.3.2 / `@opencode/pty@0.6.0`），同样受 MIT 约束。
- 架构与接口描述可见于官方文档与 `specs/v2/`（例如 `specs/v2/session.md`、`specs/v2/event-stream-architecture.md`）。这些规格位于同一 MIT 仓库中。

复制或再分发实质部分时，必须保留相应版权与许可声明。第三方组件（Apache、OFL、Figma 材料）走各自条款。

### 6.2 技术上已经作为独立表面发布的部分

1. **`@opencode/client` 与 `@opencode/client/service`**：官方为第三方 Node 应用提供的发现/启动/停止本地 OpenCode 背景服务的 API。Promise 实现刻意不加载 Effect 运行时（`service-probe.ts` 第 7–8 行）。它探测的是 OpenCode 的注册文件格式和 `GET /api/info` 健康协议；默认 `command` 是 `opencode serve --service`。若另一套守护进程要被这个 API 当作兼容服务，需要提供相同的注册文件字段，并让 `GET /api/info` 返回可解码的 `version` 与匹配的 `pid`，且 404 会被视为协议不兼容、**不会**被 `ensure` 仅因 404 而替换。
2. **`@opencode/client` 的 HTTP 客户端**：按 OpenCode protocol 调用已运行的服务器（session、event 订阅、权限等）。这是「连接 OpenCode 服务器」的表面，不是通用 CLI 包装器。
3. **`@opencode/sdk`**：把 **OpenCode 服务器本身** 嵌进进程内。它不提供「通用本机守护进程框架」，而是嵌入完整 OpenCode 运行时。
4. **`@opencode/protocol` / `@opencode/schema`**：可单独作为 HTTP 契约与类型来源，但描述的是 OpenCode 的 API，不是中立的任务队列协议。
5. **`@opencode/pty` / `packages/process-daemon`**：可单独作为 PTY 守护进程使用，传输与所有权模型与 HTTP 背景服务分离。

### 6.3 技术上耦合在 OpenCode 产品运行时里、无法单文件抽出的部分

- `@opencode/server` 的 `createRoutes` / `ServerProcess.start` 装配的是核心领域服务（Database、Bus、Session、Instance、PersistentPty、Config、Watcher、Mcp 等），依赖 `@opencode/core`。把它当库引用，引入的是 OpenCode 编码代理运行时，而不是一个与会话/模型无关的通用「确保本机守护进程存活」库。
- CLI 侧的 `service-config.ts`、`service-registration.ts`、`server-process.ts` 绑定 `OPENCODE_CHANNEL`、`OPENCODE_VERSION`、`selfCommand()`、Web UI、远程隧道、数据库路径和 PTY handoff。它们可以在 MIT 下被复制，但不是无 OpenCode 语义的独立包。
- 本机 HTTP API 的主体（session、permission、provider、plugin、pty 等）是该产品的 API。生命周期里可单独理解的部分主要是：注册文件、`/api/info` 健康协议、Basic 认证、以及客户端的 ensure/reuse/replace/wait/fail 循环。

## 7. 不能当作「可按 OpenCode MIT 搬用」或不能当作产品标识使用的部分

1. **商标与标识**：名称 “OpenCode”、Logo、wordmark 是 Anomaly 的商标。品牌指南禁止在产品名或公司名中使用它们来暗示 endorsement，也禁止未经许可用在商品上。MIT 源码许可不构成商标许可。官方还要求名称中带 “opencode” 的相关项目在 README 中声明非官方、无隶属关系。
2. **Figma skill 材料**（`packages/plugins/figma/skills/`）：NOTICE 写明 OpenCode 的 MIT **并不**对其再授权；受 Figma Developer Terms 约束。
3. **托管/推理服务的使用权**：网站、inference product 与 hosted software 受 Terms of Use / Customer Agreement 约束，不是「复制了 OSS 就获得托管服务授权」。
4. **随应用分发的第三方字体与 Apache 组件**：须遵守 OFL（含保留字体名称）或 Apache-2.0 等原许可证，不能只按根 LICENSE 处理。
5. **健康协议不兼容时的替换行为**：`ensure` **不会**因为 `/api/info` 返回 404 就替换已有进程。把另一套不实现该协议的本机服务「直接交给 `@opencode/client` 的 Service.ensure 去托管」，按当前实现会走 `fail`（incompatible health protocol），而不是 `replace`。

「只能参考、不能整段按 OpenCode MIT 搬进产品」的，主要是上述商标/品牌资产、Figma 材料，以及第三方许可证与托管条款覆盖的部分。MIT 覆盖的源码在保留声明的前提下是允许复制和修改的；其中与本机守护进程最接近、已经拆成独立发布表面的，是 `@opencode/client` 的 service API、HTTP 契约包，以及单独的 `@opencode/pty`。`@opencode/server` 与 `@opencode/core` 在法律上同样可复制，但技术上是 OpenCode 产品运行时，而不是通用守护进程内核。

## 8. 未核实或超出本次核对范围的事项

- 未对 `dev` 分支上晚于 `c0ad18b` 的提交做 diff；接口可能已变。
- 未审计全部传递依赖的许可证（只核对了仓库内的 LICENSE/NOTICE 与官方法律页）。
- 未验证将 `@opencode/client@2.3.2` 或 `@opencode/sdk@2.3.2` 安装到空白项目后的运行行为，只核对了源码、官方文档和 npm 元数据。
- 未对品牌资产文件本身的版权声明逐一读完；商标限制以 <https://opencode.ai/brand> 的文字为准。
- 本文件不构成法律意见，也不对 agentwatch 的复用程度作选择。
