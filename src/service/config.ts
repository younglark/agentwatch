import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isLoopbackHost } from "../auth/independent/login.js";
import { ensureHomeDir, serviceConfigPath } from "../auth/home.js";
import { AgentwatchError } from "../errors.js";
import type { ServiceBind } from "./types.js";
export type { ServiceBind } from "./types.js";

export type ServiceConfigFile = {
  hostname?: string;
  port?: number;
};

export function defaultBind(env: NodeJS.ProcessEnv = process.env): ServiceBind {
  const hostname = env.AGENTWATCH_SERVICE_HOST?.trim() || "127.0.0.1";
  const raw = env.AGENTWATCH_SERVICE_PORT?.trim();
  const port = raw ? Number(raw) : 0;
  return validateBind({ hostname, port });
}

export function readServiceConfig(home: string, env: NodeJS.ProcessEnv = process.env): ServiceBind {
  const file = serviceConfigPath(home);
  let fromFile: ServiceConfigFile = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, "utf8")) as ServiceConfigFile;
    } catch {
      fromFile = {};
    }
  }
  const envHost = env.AGENTWATCH_SERVICE_HOST?.trim();
  const envPort = env.AGENTWATCH_SERVICE_PORT?.trim();
  const hostname = envHost || fromFile.hostname || "127.0.0.1";
  const port = envPort ? Number(envPort) : typeof fromFile.port === "number" ? fromFile.port : 0;
  return validateBind({ hostname, port });
}

export function writeServiceConfig(home: string, bind: ServiceBind): void {
  ensureHomeDir(home);
  const checked = validateBind(bind);
  const file = serviceConfigPath(home);
  writeFileSync(file, JSON.stringify({ hostname: checked.hostname, port: checked.port }, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* */
  }
}

export function validateBind(bind: ServiceBind): ServiceBind {
  const hostname = bind.hostname.trim() || "127.0.0.1";
  if (!isLoopbackHost(hostname)) {
    throw new AgentwatchError(
      "usage",
      `服务只允许绑定本机回环地址，收到：${hostname}。`,
      { hint: "请使用 127.0.0.1、localhost 或 ::1，不要在局域网网卡上监听。" },
    );
  }
  const port = bind.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AgentwatchError("usage", `无效的服务端口：${bind.port}。`);
  }
  return { hostname: hostname === "localhost" ? "127.0.0.1" : hostname === "::1" ? "127.0.0.1" : hostname, port };
}

export function bindMatches(running: { hostname: string; port: number; url: string }, desired: ServiceBind): boolean {
  if (desired.port === 0) {
    // 未固定端口：只要仍在本机回环上即可复用。
    return isLoopbackHost(running.hostname);
  }
  return isLoopbackHost(running.hostname) && running.port === desired.port;
}
