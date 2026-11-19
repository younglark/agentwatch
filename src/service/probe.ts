import { isPidAlive } from "../auth/lock.js";
import { readServiceState } from "./state.js";
import type { ProbeService, ServiceState } from "./types.js";
import { resolveTiming, type EnsureTiming } from "./types.js";

export type ProbeResult = {
  info?: ServiceState;
  service?: ProbeService;
  timedOut: boolean;
  rejected: boolean;
  pidAlive: boolean;
};

export function authHeaders(password: string): Record<string, string> {
  return { Authorization: `Bearer ${password}` };
}

export async function probeState(info: ServiceState, timeoutMs: number): Promise<Omit<ProbeResult, "info" | "pidAlive">> {
  const signal = AbortSignal.timeout(timeoutMs);
  const result = await fetch(new URL("/api/info", info.url.endsWith("/") ? info.url : info.url + "/"), {
    method: "GET",
    headers: { ...authHeaders(info.password), Accept: "application/json" },
    signal,
  })
    .then(async (response) => ({
      response,
      body: response.status === 404 || response.status === 401 ? undefined : ((await response.json().catch(() => undefined)) as unknown),
    }))
    .catch(() => undefined);

  if (result === undefined) {
    return { service: undefined, timedOut: signal.aborted, rejected: false };
  }
  if (result.response.status === 401) {
    return { service: undefined, timedOut: false, rejected: true };
  }
  // 没有健康接口视为协议不兼容，不能当成“旧版本”就自动替换。
  if (result.response.status === 404) {
    return {
      service: {
        state: info,
        version: info.version,
        health: "ready",
        compatible: false,
        rejected: false,
      },
      timedOut: false,
      rejected: false,
    };
  }
  const body = decodeInfo(result.body);
  if (!body) return { service: undefined, timedOut: false, rejected: false };
  if (body.pid !== info.pid) return { service: undefined, timedOut: false, rejected: false };
  if (info.version && body.version !== info.version) return { service: undefined, timedOut: false, rejected: false };
  const health = result.response.ok ? "ready" : result.response.status === 500 ? "failed" : "waiting";
  return {
    service: {
      state: info,
      version: body.version,
      health,
      compatible: true,
      rejected: false,
    },
    timedOut: false,
    rejected: false,
  };
}

export async function probeRegistered(home: string, timing?: Partial<EnsureTiming> | number): Promise<ProbeResult> {
  const timeoutMs = typeof timing === "number" ? timing : resolveTiming(timing).requestTimeout;
  const info = readServiceState(home);
  if (!info) return { info: undefined, service: undefined, timedOut: false, rejected: false, pidAlive: false };
  const pidAlive = isPidAlive(info.pid);
  const probed = await probeState(info, timeoutMs);
  return { info, pidAlive, ...probed };
}

function decodeInfo(input: unknown): { version: string; pid: number } | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  if (typeof rec.version !== "string" || !rec.version) return undefined;
  if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid < 0) return undefined;
  return { version: rec.version, pid: rec.pid };
}
