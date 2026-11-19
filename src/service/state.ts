import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { ensureHomeDir, serviceStatePath } from "../auth/home.js";
import type { ServiceState } from "./types.js";

export function readServiceState(home: string): ServiceState | undefined {
  const file = serviceStatePath(home);
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<ServiceState>;
    if (
      typeof data.id !== "string" ||
      typeof data.version !== "string" ||
      typeof data.url !== "string" ||
      typeof data.password !== "string" ||
      typeof data.pid !== "number" ||
      !Number.isInteger(data.pid) ||
      data.pid <= 0
    ) {
      return undefined;
    }
    return {
      id: data.id,
      version: data.version,
      pid: data.pid,
      url: data.url,
      hostname: typeof data.hostname === "string" ? data.hostname : "127.0.0.1",
      port: typeof data.port === "number" ? data.port : portFromUrl(data.url) ?? 0,
      started_at: typeof data.started_at === "string" ? data.started_at : "",
      started_at_ms: typeof data.started_at_ms === "number" ? data.started_at_ms : 0,
      password: data.password,
    };
  } catch {
    return undefined;
  }
}

export function writeServiceState(home: string, state: ServiceState): void {
  ensureHomeDir(home);
  const file = serviceStatePath(home);
  const tmp = `${file}.tmp`;
  const body = JSON.stringify(state, null, 2) + "\n";
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* */
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* */
  }
}

/** 仅当磁盘上仍是同一实例时删除 state，避免拆掉后任登记。 */
export function removeServiceStateIfSame(home: string, expected: Pick<ServiceState, "id" | "version" | "url" | "pid">): void {
  const current = readServiceState(home);
  if (!current) return;
  if (current.id !== expected.id || current.pid !== expected.pid || current.url !== expected.url) return;
  try {
    unlinkSync(serviceStatePath(home));
  } catch {
    /* */
  }
}

export function portFromUrl(url: string): number | undefined {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    if (u.protocol === "http:") return 80;
    if (u.protocol === "https:") return 443;
  } catch {
    return undefined;
  }
  return undefined;
}

/** 用于日志/status：去掉 password。 */
export function redactState(state: ServiceState): Omit<ServiceState, "password"> & { password?: never } {
  const { password: _password, ...rest } = state;
  return rest;
}
