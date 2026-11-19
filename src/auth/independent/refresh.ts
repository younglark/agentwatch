import { AgentwatchError } from "../../errors.js";
import { stripSlash } from "./login.js";
import type { IndependentCredentials } from "./store.js";
import { credsFromTokens } from "./store.js";

export const REFRESH_EARLY_MS = 300_000;
export const REFRESH_DEADLINE_MS = 20_000;

export function oauthClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTWATCH_OAUTH_CLIENT_ID?.trim() ?? "";
}

export function refreshEndpoint(backend: string): string {
  return new URL("/oauth/token", stripSlash(backend) + "/").toString();
}

export type RefreshDecision = "ok" | "refresh" | "need_client_id";

/**
 * 仍有效的 access token 在没有 client_id 时继续使用。
 * 仅当必须 refresh（已过期）且没有 AGENTWATCH_OAUTH_CLIENT_ID 时失败。
 * 有 client_id 时在 JWT exp 前约 300 秒刷新。
 */
export function refreshDecision(
  creds: IndependentCredentials,
  opts: { nowMs?: number; clientId?: string },
): RefreshDecision {
  const now = opts.nowMs ?? Date.now();
  const hasClient = Boolean(opts.clientId);
  const exp = creds.expires_at_ms;
  if (exp !== undefined && exp > now) {
    if (hasClient && exp - REFRESH_EARLY_MS <= now) return "refresh";
    return "ok";
  }
  if (!hasClient) return "need_client_id";
  return "refresh";
}

export function missingClientIdError(): AgentwatchError {
  return new AgentwatchError(
    "auth",
    "独立鉴权的 access token 已过期，且未配置刷新所需的 AGENTWATCH_OAUTH_CLIENT_ID。",
    {
      hint: "设置环境变量 AGENTWATCH_OAUTH_CLIENT_ID（公开 OAuth client id，本工具不会内置或从应用包提取），或重新运行登录。",
    },
  );
}

export type RefreshHttp = {
  fetch?: typeof fetch;
  deadlineMs?: number;
};

export async function refreshIndependentTokens(
  creds: IndependentCredentials,
  clientId: string,
  http: RefreshHttp = {},
): Promise<IndependentCredentials> {
  if (!clientId) throw missingClientIdError();
  if (!creds.refresh_token) {
    throw new AgentwatchError("auth", "没有 refresh_token，请重新登录。");
  }
  const backend = creds.backend || "https://api2.cursor.sh";
  const url = refreshEndpoint(backend);
  const doFetch = http.fetch ?? fetch;
  const deadline = http.deadlineMs ?? REFRESH_DEADLINE_MS;
  const res = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
    }),
    signal: AbortSignal.timeout(deadline),
    redirect: "error",
  });
  const body = (await res.json().catch(() => undefined)) as
    | {
        access_token?: unknown;
        refresh_token?: unknown;
        shouldLogout?: unknown;
        error?: unknown;
      }
    | undefined;
  if (body?.shouldLogout || body?.error) {
    throw new AgentwatchError(
      "auth",
      `刷新独立 token 失败${body.error ? `：${String(body.error)}` : ""}。`,
      { hint: "请重新登录。agentwatch 不会刷新或写回官方应用的 token。" },
    );
  }
  if (!res.ok || typeof body?.access_token !== "string" || body.access_token.length === 0) {
    throw new AgentwatchError("auth", `刷新独立 token 失败（HTTP ${res.status}）。`, {
      hint: "请稍后重试，或重新登录。",
    });
  }
  const refresh =
    typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? body.refresh_token
      : creds.refresh_token;
  return credsFromTokens(body.access_token, refresh, backend);
}
