import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { AgentwatchError } from "../errors.js";
import { EXIT } from "../exit.js";
import { isPidAlive } from "../auth/lock.js";
import { VERSION } from "../help.js";
import { bindMatches, readServiceConfig, type ServiceBind } from "./config.js";
import { probeRegistered } from "./probe.js";
import { readServiceState, removeServiceStateIfSame } from "./state.js";
import {
  sameState,
  resolveTiming,
  type EnsureOptions,
  type EnsureReason,
  type EnsureTiming,
  type ProbeService,
  type PublicServiceStatus,
  type ServiceState,
  type StopResult,
} from "./types.js";
import { publicStatus } from "./types.js";

export type ProcessSignals = {
  kill: (pid: number, signal: NodeJS.Signals) => void;
  alive: (pid: number) => boolean;
};

const defaultSignals: ProcessSignals = {
  kill: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone or not permitted */
    }
  },
  alive: isPidAlive,
};

export type StopOptions = {
  home: string;
  timing?: Partial<EnsureTiming>;
  signals?: ProcessSignals;
};

export function defaultServiceCommand(): string[] {
  const entry = process.argv[1];
  if (!entry) return [process.execPath, "agentwatch", "service", "run"];
  return [process.execPath, entry, "service", "run"];
}

/** 只发现，不启动。 */
export async function discover(opts: { home: string; version?: string; timing?: Partial<EnsureTiming> }): Promise<ServiceState | undefined> {
  const probed = await probeRegistered(opts.home, opts.timing);
  const svc = probed.service;
  if (!svc || svc.health !== "ready" || !svc.compatible) return undefined;
  if (opts.version && svc.version !== opts.version) return undefined;
  return svc.state;
}

export async function serviceStatus(opts: { home: string; timing?: Partial<EnsureTiming> }): Promise<PublicServiceStatus> {
  const probed = await probeRegistered(opts.home, opts.timing);
  if (!probed.info) return { running: false, reason: "missing-registration" };
  if (probed.rejected) {
    return { ...publicStatus(probed.info, { running: true, healthy: false }), reason: "auth-rejected" };
  }
  if (probed.service?.compatible && probed.service.health === "ready") {
    return publicStatus(probed.service.state, { healthy: true });
  }
  if (!probed.pidAlive) {
    return { ...publicStatus(probed.info, { running: false, healthy: false }), reason: "stale-registration" };
  }
  if (probed.timedOut) {
    return { ...publicStatus(probed.info, { running: true, healthy: false }), reason: "unresponsive" };
  }
  if (probed.service && !probed.service.compatible) {
    return { ...publicStatus(probed.info, { running: true, healthy: false }), reason: "incompatible" };
  }
  return { ...publicStatus(probed.info, { running: true, healthy: false }), reason: "unhealthy" };
}

/**
 * 保证本用户有一个健康、版本匹配的本机服务。
 * 复用健康的同版本在任实例；版本或绑定配置不匹配则先停再启；
 * 死 pid / 无响应（连续 3 次）/ 不健康则拉起新的。
 */
export async function ensure(opts: EnsureOptions): Promise<ServiceState> {
  const timing = resolveTiming(opts.timing);
  const version = opts.version ?? VERSION;
  const deadline = Date.now() + timing.promiseTimeout;
  const desired = readServiceConfig(opts.home, opts.env ?? process.env);
  let timeouts: { state: ServiceState; count: number } | undefined;
  let announced = false;
  let spawned: Spawned | undefined;

  const announce = (reason: EnsureReason, previousVersion?: string) => {
    if (announced) return;
    announced = true;
    opts.onStart?.(reason, previousVersion);
  };

  try {
    while (true) {
      if (Date.now() >= deadline) {
        throw new AgentwatchError("failure", spawned?.error()?.message ?? "等待本机 agentwatch 服务启动超时。", {
          hint: "查看 AGENTWATCH_HOME/service.log。不要手动结束占用端口的未知进程。",
        });
      }

      const probed = await probeRegistered(opts.home, timing.requestTimeout);

      if (probed.rejected && probed.info) {
        throw new AgentwatchError(
          "failure",
          "本机服务拒绝了客户端密钥，可能不是当前用户的 agentwatch 服务。",
          {
            hint: "请检查 AGENTWATCH_HOME/service.json 是否被改写。不要强行结束占用该地址的未知进程。",
          },
        );
      }

      if (probed.timedOut && probed.info) {
        timeouts = {
          state: probed.info,
          count: timeouts && sameState(timeouts.state, probed.info) ? timeouts.count + 1 : 1,
        };
        if (timeouts.count >= 3) {
          announce("unhealthy", probed.info.version);
          await terminate(probed.info, { home: opts.home, timing, signals: defaultSignals });
          spawned?.release();
          spawned = undefined;
          timeouts = undefined;
        }
      } else {
        timeouts = undefined;
      }

      if (probed.service) {
        const decision = decide(probed.service, { version, bind: desired });
        if (decision._tag === "fail") throw decision.error;
        if (decision._tag === "reuse") {
          return probed.service.state;
        }
        if (decision._tag === "wait") {
          await delay(timing.pollInterval);
          continue;
        }
        if (decision._tag === "replace") {
          announce(decision.reason, probed.service.version);
          await stop({ home: opts.home, timing });
        }
      } else if (probed.info && !probed.pidAlive) {
        announce("missing", probed.info.version);
        removeServiceStateIfSame(opts.home, probed.info);
      } else if (probed.info && probed.pidAlive && !probed.timedOut && !probed.service) {
        // 活着的 pid 但健康检查对不上：可能刚启动，继续等；不要拆锁或杀进程。
      }

      if (desired.port !== 0) {
        await assertBindFreeOrOurs(opts.home, desired, timing);
      }

      const failed = spawned?.error();
      if (failed) throw failed;
      if (!spawned || spawned.closed()) {
        announce("missing");
        spawned?.release();
        spawned = spawnDaemon(opts.command ?? defaultServiceCommand(), opts.env ?? process.env, opts.home);
        await delay(timing.spawnDelay);
        continue;
      }
      await delay(timing.pollInterval);
    }
  } finally {
    spawned?.release();
  }
}

export function decide(
  service: ProbeService,
  opts: { version: string; bind: ServiceBind },
):
  | { _tag: "reuse" }
  | { _tag: "wait" }
  | { _tag: "replace"; reason: EnsureReason }
  | { _tag: "fail"; error: AgentwatchError } {
  if (!service.compatible) {
    return {
      _tag: "fail",
      error: new AgentwatchError(
        "failure",
        "本机服务的健康协议不兼容。请显式执行 agentwatch service restart。",
      ),
    };
  }
  if (service.version !== opts.version) {
    return { _tag: "replace", reason: "version-mismatch" };
  }
  if (!bindMatches(service.state, opts.bind)) {
    return { _tag: "replace", reason: "bind-change" };
  }
  if (service.health === "ready") return { _tag: "reuse" };
  if (service.health === "failed") return { _tag: "replace", reason: "unhealthy" };
  return { _tag: "wait" };
}

/**
 * 停止以登记文件为准，而不是只看健康探测。
 * 健康检查超时不能当成“没有服务”，否则 restart 会误复用恢复过来的在任实例。
 */
export async function stop(opts: StopOptions): Promise<StopResult> {
  const info = readServiceState(opts.home);
  if (!info) return { stopped: true, reason: "missing-registration" };
  const signals = opts.signals ?? defaultSignals;
  if (!signals.alive(info.pid)) {
    removeServiceStateIfSame(opts.home, info);
    return { stopped: true, reason: "stale-registration" };
  }
  try {
    await terminate(info, opts);
    if (signals.alive(info.pid)) {
      return { stopped: false, reason: "timeout", message: `服务进程 ${info.pid} 仍在运行。` };
    }
    return { stopped: true, reason: "stopped" };
  } catch (err) {
    if (signals.alive(info.pid)) {
      return {
        stopped: false,
        reason: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return { stopped: true, reason: "stopped" };
  }
}

/**
 * 显式 restart：必须先确认在任实例已停，才能 ensure。
 * 未确认停止时不得进入 ensure，以免复用刚恢复的旧进程。
 */
export async function restart(opts: EnsureOptions & { signals?: ProcessSignals }): Promise<ServiceState> {
  const previous = readServiceState(opts.home);
  const result = await stop({ home: opts.home, timing: opts.timing, signals: opts.signals });
  if (!result.stopped) {
    throw new AgentwatchError(
      "failure",
      `无法停止在任服务（${result.reason}${result.message ? `：${result.message}` : ""}）。显式 restart 在未确认停止前不会启动新实例。`,
    );
  }
  const next = await ensure(opts);
  if (previous && next.pid === previous.pid && next.id === previous.id) {
    throw new AgentwatchError("failure", "restart 后仍是原来的服务进程，未完成替换。");
  }
  return next;
}

async function terminate(info: ServiceState, opts: StopOptions): Promise<void> {
  const timing = resolveTiming(opts.timing);
  const signals = opts.signals ?? defaultSignals;
  const current = readServiceState(opts.home);
  if (!current || !sameState(current, info)) return;
  signals.kill(info.pid, "SIGTERM");
  if (!(await waitUntilStopped(info.pid, timing, signals))) {
    signals.kill(info.pid, "SIGKILL");
    if (!(await waitUntilStopped(info.pid, timing, signals))) {
      throw new AgentwatchError("failure", `服务进程 ${info.pid} 仍在运行。`);
    }
  }
  const latest = readServiceState(opts.home);
  if (latest && sameState(latest, info)) {
    removeServiceStateIfSame(opts.home, info);
  }
}

async function waitUntilStopped(pid: number, timing: EnsureTiming, signals: ProcessSignals): Promise<boolean> {
  for (let attempt = 0; attempt <= timing.stopPollAttempts; attempt++) {
    if (!signals.alive(pid)) return true;
    if (attempt < timing.stopPollAttempts) await delay(timing.stopPollInterval);
  }
  return false;
}

async function assertBindFreeOrOurs(home: string, bind: ServiceBind, timing: EnsureTiming): Promise<void> {
  const taken = await isTcpOpen(bind.hostname, bind.port, Math.min(500, timing.requestTimeout));
  if (!taken) return;
  const probed = await probeRegistered(home, timing.requestTimeout);
  if (probed.service?.compatible) return;
  if (probed.rejected) {
    throw new AgentwatchError(
      "failure",
      `${bind.hostname}:${bind.port} 上的进程拒绝了 agentwatch 客户端密钥，不会占用或结束它。`,
      { hint: "请改 AGENTWATCH_SERVICE_PORT，或确认该端口上是否已有其他程序。" },
    );
  }
  throw new AgentwatchError(
    "failure",
    `${bind.hostname}:${bind.port} 已被其他进程占用，不是 agentwatch 服务。`,
    {
      exitCode: EXIT.FAILURE,
      hint: "请改用空闲端口（AGENTWATCH_SERVICE_PORT 或 config.json），不要强行结束未知进程。",
    },
  );
}

async function isTcpOpen(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const sock = net.connect({ host: hostname, port, timeout: timeoutMs });
    const done = (up: boolean) => {
      sock.removeAllListeners();
      try {
        sock.destroy();
      } catch {
        /* */
      }
      resolve(up);
    };
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

type Spawned = {
  child: ChildProcess;
  error: () => AgentwatchError | undefined;
  closed: () => boolean;
  release: () => void;
};

function spawnDaemon(command: string[], env: NodeJS.ProcessEnv, home: string): Spawned {
  const [file, ...args] = command;
  if (!file) throw new AgentwatchError("failure", "缺少守护进程启动命令。");
  const child = spawn(file, args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...env, AGENTWATCH_HOME: env.AGENTWATCH_HOME ?? home },
  });
  let err: AgentwatchError | undefined;
  let closed = false;
  let stderr = "";
  const onStderr = (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-8000);
  };
  child.stderr?.on("data", onStderr);
  const errStream = child.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null;
  errStream?.unref?.();
  child.once("error", (cause) => {
    err = new AgentwatchError("failure", `无法启动本机服务：${cause instanceof Error ? cause.message : String(cause)}`);
  });
  child.once("close", (code, signal) => {
    closed = true;
    if (code && code !== 0) {
      err = new AgentwatchError("failure", `本机服务启动失败（退出码 ${code}${signal ? `，信号 ${signal}` : ""}）。`, {
        hint: redactHint(stderr) || "查看 AGENTWATCH_HOME/service.log。",
      });
    }
  });
  child.unref();
  return {
    child,
    error: () => err,
    closed: () => closed,
    release: () => {
      child.stderr?.off("data", onStderr);
      child.stderr?.resume();
    },
  };
}

function redactHint(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bpassword["']?\s*[:=]\s*\S+/gi, "password=[redacted]")
    .replace(/\bverifier["']?\s*[:=]\s*\S+/gi, "verifier=[redacted]")
    .trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 供测试或文档：当前这个模块的 URL（用于拼命令）。 */
export function thisModuleUrl(): string {
  return pathToFileURL(new URL(import.meta.url).pathname).toString();
}
