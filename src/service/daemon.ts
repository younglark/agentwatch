import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync as appendLog, chmodSync as chmodLog } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ensureHomeDir, resolveAgentwatchHome, serviceLockPath, serviceLogPath } from "../auth/home.js";
import { IndependentSession } from "../auth/independent/session.js";
import { isLoopbackHost } from "../auth/independent/login.js";
import { tryAcquirePidLock, type HeldPidLock } from "../auth/lock.js";
import { AgentwatchError, isAgentwatchError } from "../errors.js";
import { EXIT } from "../exit.js";
import { VERSION } from "../help.js";
import { redact } from "../redact.js";
import { readServiceConfig, validateBind, type ServiceBind } from "./config.js";
import { probeRegistered } from "./probe.js";
import { removeServiceStateIfSame, writeServiceState } from "./state.js";
import type { ServiceState } from "./types.js";

export type DaemonOptions = {
  home?: string;
  bind?: ServiceBind;
  env?: NodeJS.ProcessEnv;
  version?: string;
  session?: IndependentSession;
};

export type RunningDaemon = {
  state: ServiceState;
  close: () => Promise<void>;
};

export class LostElection extends AgentwatchError {
  readonly incumbent?: ServiceState;
  constructor(message: string, incumbent?: ServiceState) {
    super("failure", message);
    this.name = "LostElection";
    this.incumbent = incumbent;
  }
}

/**
 * 前台运行本机服务（由 `agentwatch service run` 或测试调用）。
 * 只绑定回环地址；用 service.lock 保证每用户一份。
 */
export async function runDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? resolveAgentwatchHome({ env });
  ensureHomeDir(home);
  const version = opts.version ?? VERSION;
  const bind = validateBind(opts.bind ?? readServiceConfig(home, env));

  const incumbents = await probeRegistered(home, 800);
  if (incumbents.service?.compatible && incumbents.service.health === "ready" && incumbents.service.version === version) {
    // 输掉选举：已有健康同版本实例，安静退出由 ensure 复用它。
    throw new LostElection("已有健康的同版本本机服务在运行。", incumbents.service.state);
  }

  const locked = tryAcquirePidLock(serviceLockPath(home));
  if (!locked.ok) {
    if (locked.alive) {
      const err = new AgentwatchError(
        "failure",
        `本机服务锁由仍在运行的进程 pid=${locked.pid} 持有。`,
        { hint: "不会拆掉该锁。若那不是 agentwatch，请改用其他 AGENTWATCH_HOME，不要结束未知进程。" },
      );
      throw new LostElection(err.message);
    }
    throw new AgentwatchError("failure", "无法取得本机服务锁。");
  }
  const lock: HeldPidLock = locked.lock;

  let state: ServiceState | undefined;
  let server: Server | undefined;
  const session = opts.session ?? new IndependentSession({ home, env });
  // 若上次退出时留下 pending 登录，继续轮询。
  if (session.loginStatus().status === "pending") {
    void session.waitForLogin().catch((err) => log(home, `pending login ended: ${redact(err instanceof Error ? err.message : String(err))}`));
  }

  const shutdown = async () => {
    if (state) removeServiceStateIfSame(home, state);
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    lock.release();
  };

  try {
    const started = await listen({ bind, home, version, session, onUnauthorized });
    server = started.server;
    state = started.state;
    writeServiceState(home, state);
    log(home, `service started pid=${state.pid} version=${state.version} url=${state.url}`);

    const onTerm = () => {
      log(home, "received shutdown signal");
      void shutdown().then(() => process.exit(0));
    };
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onTerm);
    // 终端关闭不应带走服务。
    process.on("SIGHUP", () => {});

    return {
      state,
      close: async () => {
        process.off("SIGTERM", onTerm);
        process.off("SIGINT", onTerm);
        await shutdown();
      },
    };
  } catch (err) {
    lock.release();
    throw err;
  }

  function onUnauthorized() {
    /* counted in request handler */
  }
}

async function listen(opts: {
  bind: ServiceBind;
  home: string;
  version: string;
  session: IndependentSession;
  onUnauthorized: () => void;
}): Promise<{ server: Server; state: ServiceState }> {
  const id = randomUUID();
  const password = randomBytes(24).toString("base64url");
  const startedAtMs = Date.now();
  const started_at = new Date(startedAtMs).toISOString();

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      id,
      version: opts.version,
      password,
      started_at,
      session: opts.session,
      home: opts.home,
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.bind.port, opts.bind.hostname, () => resolve());
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new AgentwatchError(
        "failure",
        `${opts.bind.hostname}:${opts.bind.port || "?"} 已被其他进程占用，不是本 agentwatch 服务。`,
        {
          exitCode: EXIT.FAILURE,
          hint: "请改用空闲端口（AGENTWATCH_SERVICE_PORT 或 config.json），不要强行结束未知进程。",
        },
      );
    }
    throw err;
  }

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new AgentwatchError("failure", "本机服务未能绑定 TCP 地址。");
  }
  if (!isLoopbackHost(addr.address) && addr.address !== "127.0.0.1" && addr.address !== "::1") {
    server.close();
    throw new AgentwatchError("failure", `拒绝在非回环地址上监听：${addr.address}。`);
  }
  const hostname = opts.bind.hostname;
  const port = addr.port;
  const url = `http://${hostname}:${port}`;
  const state: ServiceState = {
    id,
    version: opts.version,
    pid: process.pid,
    url,
    hostname,
    port,
    started_at,
    started_at_ms: startedAtMs,
    password,
  };
  return { server, state };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { id: string; version: string; password: string; started_at: string; session: IndependentSession; home: string },
): Promise<void> {
  try {
    const host = String(req.headers.host ?? "");
    const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (hostname && !isLoopbackHost(hostname) && hostname !== "") {
      // 仍然只应答本机。Host 头异常时直接拒绝。
      if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
        sendJson(res, 403, { error: { code: "failure", message: "只接受本机请求。" } });
        return;
      }
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (!authorized(req, ctx.password)) {
      sendJson(res, 401, { error: { code: "auth", message: "本机服务认证失败。" } });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/info") {
      sendJson(res, 200, {
        ok: true,
        id: ctx.id,
        version: ctx.version,
        pid: process.pid,
        started_at: ctx.started_at,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/auth/login/begin") {
      const began = await ctx.session.beginLogin();
      sendJson(res, 200, { login_url: began.login_url, uuid: began.uuid, reused: began.reused });
      return;
    }
    if (req.method === "GET" && url.pathname === "/auth/login/status") {
      sendJson(res, 200, ctx.session.loginStatus());
      return;
    }
    if (req.method === "POST" && url.pathname === "/auth/login/wait") {
      try {
        await ctx.session.waitForLogin();
        sendJson(res, 200, { status: "completed" });
      } catch (err) {
        const e = isAgentwatchError(err) ? err : new AgentwatchError("auth", err instanceof Error ? err.message : String(err));
        sendJson(res, e.exitCode === EXIT.AUTH ? 401 : 400, {
          status: "failed",
          error: { code: e.code, message: e.message, hint: e.hint },
        });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/auth/logout") {
      await ctx.session.logout();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/auth/token") {
      try {
        const token = await ctx.session.getAccessToken({ forceRefresh: url.searchParams.get("refresh") === "1" });
        sendJson(res, 200, {
          access_token: token.token,
          expires_at_ms: token.expiresAtMs,
          backend: token.backend,
          secrets_path: token.secretsPath,
        });
      } catch (err) {
        const e = isAgentwatchError(err) ? err : new AgentwatchError("auth", err instanceof Error ? err.message : String(err));
        sendJson(res, 401, { error: { code: e.code, message: e.message, hint: e.hint } });
      }
      return;
    }
    sendJson(res, 404, { error: { code: "failure", message: "未知接口。" } });
  } catch (err) {
    const msg = redact(err instanceof Error ? err.message : String(err));
    log(ctx.home, `request error: ${msg}`);
    sendJson(res, 500, { error: { code: "failure", message: msg } });
  }
}

function authorized(req: IncomingMessage, password: string): boolean {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (m && m[1] === password) return true;
  }
  const alt = req.headers["x-agentwatch-secret"];
  return typeof alt === "string" && alt === password;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(json);
}

function log(home: string, line: string): void {
  const file = serviceLogPath(home);
  const text = `${new Date().toISOString()} ${redact(line)}\n`;
  try {
    appendLog(file, text, { encoding: "utf8", mode: 0o600 });
    try {
      chmodLog(file, 0o600);
    } catch {
      /* */
    }
  } catch {
    /* 日志失败不得影响服务 */
  }
}

