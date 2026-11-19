import { AgentwatchError } from "../../errors.js";
import { stripSlash } from "./login.js";

export const POLICY_VIOLATION = "sign_in_policy_violation";
export const POLL_BASE_MS = 1000;
export const POLL_FACTOR = 1.2;
export const POLL_CAP_MS = 10_000;
export const POLL_MAX_TRIES = 150;
export const POLL_MAX_CONSECUTIVE_ERRORS = 3;

export type PollTokens = {
  accessToken: string;
  refreshToken: string;
};

export type PollOutcome =
  | { status: "success"; tokens: PollTokens }
  | { status: "pending" }
  | { status: "timeout" }
  | { status: "policy" }
  | { status: "unsupported"; message: string }
  | { status: "failed"; message: string };

export type PollHooks = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxTries?: number;
  maxConsecutiveErrors?: number;
  signal?: AbortSignal;
};

export function pollDelayMs(attemptIndex: number): number {
  return Math.min(POLL_CAP_MS, POLL_BASE_MS * POLL_FACTOR ** attemptIndex);
}

export function pollUrl(apiBase: string, uuid: string, verifier: string): string {
  const u = new URL("/auth/poll", stripSlash(apiBase) + "/");
  u.searchParams.set("uuid", uuid);
  u.searchParams.set("verifier", verifier);
  return u.toString();
}

export async function pollForLogin(
  opts: { apiBase: string; uuid: string; verifier: string } & PollHooks,
): Promise<PollOutcome> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxTries = opts.maxTries ?? POLL_MAX_TRIES;
  const maxErrors = opts.maxConsecutiveErrors ?? POLL_MAX_CONSECUTIVE_ERRORS;
  let consecutiveErrors = 0;

  for (let i = 0; i < maxTries; i++) {
    if (opts.signal?.aborted) {
      return { status: "failed", message: "登录轮询已取消。" };
    }
    const step = await pollOnce({
      apiBase: opts.apiBase,
      uuid: opts.uuid,
      verifier: opts.verifier,
      fetch: doFetch,
      signal: opts.signal,
    });
    if (step.status === "success" || step.status === "policy" || step.status === "unsupported") {
      return step;
    }
    if (step.status === "pending") {
      consecutiveErrors = 0;
    } else {
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxErrors) {
        return { status: "failed", message: step.message || "登录轮询连续失败。" };
      }
    }
    if (i + 1 < maxTries) {
      await sleep(pollDelayMs(i));
    }
  }
  return { status: "timeout" };
}

export type PollOnce = Exclude<PollOutcome, { status: "timeout" }>;

export async function pollOnce(opts: {
  apiBase: string;
  uuid: string;
  verifier: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<PollOnce> {
  const doFetch = opts.fetch ?? fetch;
  const url = pollUrl(opts.apiBase, opts.uuid, opts.verifier);
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) return { status: "failed", message: "登录轮询已取消。" };
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "failed", message: `登录轮询网络错误：${msg}` };
  }
  if (res.status === 404) return { status: "pending" };
  if (res.status === 403) {
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    if (body?.error === POLICY_VIOLATION) return { status: "policy" };
    return { status: "failed", message: "登录轮询返回 403。" };
  }
  if (!res.ok) {
    return { status: "failed", message: `登录轮询返回 HTTP ${res.status}。` };
  }
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (body && typeof body.xaiAccessToken === "string") {
    return { status: "unsupported", message: "登录返回了 xAI identity，本工具只支持 Cursor token。" };
  }
  const access = body?.accessToken;
  const refresh = body?.refreshToken;
  if (typeof access !== "string" || access.length === 0) {
    return { status: "failed", message: "登录轮询响应缺少 accessToken。" };
  }
  if (refresh !== undefined && (typeof refresh !== "string" || refresh.length === 0)) {
    return { status: "failed", message: "登录轮询响应的 refreshToken 无效。" };
  }
  return {
    status: "success",
    tokens: { accessToken: access, refreshToken: typeof refresh === "string" ? refresh : "" },
  };
}

export function pollOutcomeError(outcome: PollOutcome): AgentwatchError {
  switch (outcome.status) {
    case "policy":
      return new AgentwatchError("auth", "登录被组织策略拒绝（sign_in_policy_violation）。");
    case "timeout":
      return new AgentwatchError("auth", "等待登录超时。", {
        hint: "请重新运行 agentwatch login，或再次执行命令，在浏览器打开 stderr 上的新链接。",
      });
    case "unsupported":
      return new AgentwatchError("auth", outcome.message);
    case "failed":
      return new AgentwatchError("auth", outcome.message);
    case "pending":
      return new AgentwatchError("auth", "登录仍在等待中。");
    default:
      return new AgentwatchError("auth", "登录未完成。");
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
