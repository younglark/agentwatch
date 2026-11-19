#!/usr/bin/env node
import { parseArgs, type CliArgs } from "./args.js";
import { resolveAgentwatchHome } from "./auth/home.js";
import { authMode, independentUnsupportedHint, independentUnsupportedOnDesktopMessage } from "./auth/platform.js";
import { AgentwatchError, isAgentwatchError } from "./errors.js";
import { EXIT } from "./exit.js";
import { HELP, VERSION } from "./help.js";
import { redact } from "./redact.js";
import { formatHumanResult, runWatch } from "./run.js";
import { loginViaDaemon, ensureIndependentService } from "./service/access.js";
import { ServiceClient, endpointFromState } from "./service/client.js";
import { LostElection, runDaemon } from "./service/daemon.js";
import { discover, ensure, restart, serviceStatus, stop } from "./service/ensure.js";

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    return fail(e, /*json*/ flagPresent(argv, "--json"));
  }

  if (args.kind === "help") {
    process.stderr.write(HELP);
    return EXIT.OK;
  }
  if (args.kind === "version") {
    process.stderr.write(`agentwatch ${VERSION}\n`);
    return EXIT.OK;
  }

  try {
    if (args.kind === "login") return await cmdLogin(args);
    if (args.kind === "logout") return await cmdLogout(args);
    if (args.kind === "service") return await cmdService(args);
    const { result, processExit } = await runWatch(args);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stderr.write(`${formatHumanResult(result)}\n`);
    }
    return processExit;
  } catch (e) {
    return fail(e, args.kind === "run" ? args.json : "json" in args && args.json);
  }
}

async function cmdLogin(args: Extract<CliArgs, { kind: "login" }>): Promise<number> {
  if (authMode() !== "independent") {
    throw new AgentwatchError("auth", independentUnsupportedOnDesktopMessage(), {
      hint: independentUnsupportedHint(),
    });
  }
  const home = resolveAgentwatchHome();
  const { client } = await ensureIndependentService({ home, json: args.json });
  const token = await loginViaDaemon(client, { home, json: args.json });
  void token;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, status: "logged_in" })}\n`);
  } else {
    process.stderr.write("登录成功。\n");
  }
  return EXIT.OK;
}

async function cmdLogout(args: Extract<CliArgs, { kind: "logout" }>): Promise<number> {
  if (authMode() !== "independent") {
    const msg = "当前平台的共享鉴权由官方 Grok Bot 桌面应用管理，logout 不会改写官方凭据。";
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, status: "noop", message: msg })}\n`);
    else process.stderr.write(`${msg}\n`);
    return EXIT.OK;
  }
  const home = resolveAgentwatchHome();
  const found = await discover({ home, version: VERSION });
  if (found) {
    const client = new ServiceClient(endpointFromState(found));
    await client.logout();
    await stop({ home });
  } else {
    const { clearCredentials, clearPendingLogin } = await import("./auth/independent/store.js");
    await clearPendingLogin(home);
    await clearCredentials(home);
  }
  if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, status: "logged_out" })}\n`);
  else process.stderr.write("已清除独立鉴权凭据。\n");
  return EXIT.OK;
}

async function cmdService(args: Extract<CliArgs, { kind: "service" }>): Promise<number> {
  if (args.action === "run") {
    // 内部入口：即使在 Linux 测试里也可以拉起。CLI 的 start/status 在非 macOS 会被拒绝。
    try {
      const running = await runDaemon();
      process.stderr.write(`agentwatch 服务已在 ${running.state.url} 监听（pid ${running.state.pid}）\n`);
      await new Promise(() => {
        /* 一直运行直到信号 */
      });
      return EXIT.OK;
    } catch (err) {
      if (err instanceof LostElection) return EXIT.OK;
      throw err;
    }
  }

  if (authMode() !== "independent") {
    throw new AgentwatchError("usage", independentUnsupportedOnDesktopMessage(), {
      hint: independentUnsupportedHint(),
    });
  }

  const home = resolveAgentwatchHome();
  if (args.action === "status") {
    const status = await serviceStatus({ home });
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, service: status })}\n`);
    else process.stderr.write(`${formatServiceStatus(status)}\n`);
    return EXIT.OK;
  }
  if (args.action === "start") {
    const state = await ensure({ home, version: VERSION });
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, pid: state.pid, version: state.version, url: state.url })}\n`);
    else process.stderr.write(`服务已运行：pid ${state.pid}，${state.url}\n`);
    return EXIT.OK;
  }
  if (args.action === "stop") {
    const result = await stop({ home });
    if (!result.stopped) {
      throw new AgentwatchError("failure", `无法停止服务（${result.reason}${result.message ? `：${result.message}` : ""}）。`);
    }
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, status: "stopped", reason: result.reason })}\n`);
    else process.stderr.write("服务已停止。\n");
    return EXIT.OK;
  }
  const state = await restart({ home, version: VERSION });
  if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, pid: state.pid, version: state.version, url: state.url })}\n`);
  else process.stderr.write(`服务已重启：pid ${state.pid}，${state.url}\n`);
  return EXIT.OK;
}

function formatServiceStatus(status: { running: boolean; healthy?: boolean; pid?: number; version?: string; url?: string; started_at?: string; reason?: string }): string {
  if (!status.running) return `agentwatch 服务：未运行${status.reason ? `（${status.reason}）` : ""}`;
  const bits = [
    `agentwatch 服务：${status.healthy ? "运行中" : "已登记但未健康"}`,
    status.pid !== undefined ? `pid: ${status.pid}` : "",
    status.version ? `version: ${status.version}` : "",
    status.url ? `url: ${status.url}` : "",
    status.started_at ? `started_at: ${status.started_at}` : "",
    status.reason && !status.healthy ? `reason: ${status.reason}` : "",
  ].filter(Boolean);
  return bits.join("\n");
}

function flagPresent(argv: string[], flag: string): boolean {
  const end = argv.indexOf("--", 2);
  const slice = end === -1 ? argv.slice(2) : argv.slice(2, end);
  return slice.includes(flag);
}

function fail(err: unknown, json: boolean): number {
  const e = isAgentwatchError(err)
    ? err
    : new AgentwatchError("failure", err instanceof Error ? err.message : String(err));
  const message = redact(e.message);
  const hint = e.hint ? redact(e.hint) : undefined;
  if (json) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { code: e.code, message, hint, retryable: e.retryable } })}\n`,
    );
  } else {
    process.stderr.write(`error: ${message}\n`);
    if (hint) process.stderr.write(`hint: ${hint}\n`);
  }
  if (process.env.AGENTWATCH_DEBUG === "1" && err instanceof Error && err.stack) {
    process.stderr.write(`${redact(err.stack)}\n`);
  }
  return e.exitCode;
}

const runningAsCli = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return /(?:^|[\\/])cli\.(?:ts|js)$/.test(entry) || entry.endsWith("agentwatch");
})();

if (runningAsCli) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`error: ${redact(err instanceof Error ? err.message : String(err))}\n`);
      process.exit(EXIT.FAILURE);
    });
}

export { main };
