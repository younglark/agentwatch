import { AgentwatchError, isAgentwatchError } from "../errors.js";
import type { AccessToken } from "../auth/token.js";
import { VERSION } from "../help.js";
import { ServiceClient, endpointFromState } from "./client.js";
import { ensure } from "./ensure.js";
import type { EnsureOptions, ServiceState } from "./types.js";

export type LoginHintWriter = (loginUrl: string) => void;

/** 立即把登录 URL 写到 stderr。--json 时写包含 login_url 的 JSON 对象。绝不写 verifier。 */
export function printLoginUrl(
  loginUrl: string,
  opts: { json: boolean; stderr?: NodeJS.WritableStream } = { json: false },
): void {
  const stream = opts.stderr ?? process.stderr;
  if (opts.json) {
    stream.write(
      `${JSON.stringify({
        ok: false,
        login_url: loginUrl,
        error: { code: "auth", message: "需要登录。请在浏览器打开 login_url 完成授权，无需输入设备码。" },
      })}\n`,
    );
    return;
  }
  stream.write(`需要登录。请在浏览器打开以下链接完成授权（无需输入设备码，也无需隧道）：\n${loginUrl}\n`);
}

export type IndependentAccessOptions = {
  home: string;
  json?: boolean;
  stderr?: NodeJS.WritableStream;
  ensure?: EnsureOptions;
  onLoginUrl?: LoginHintWriter;
  /** 测试注入已连接的客户端，跳过 ensure。 */
  client?: ServiceClient;
};

export async function ensureIndependentService(
  opts: IndependentAccessOptions,
): Promise<{ state: ServiceState; client: ServiceClient }> {
  if (opts.client) {
    return { state: { url: "injected", password: "", id: "", version: VERSION, pid: 0, hostname: "127.0.0.1", port: 0, started_at: "", started_at_ms: 0 }, client: opts.client };
  }
  const state = await ensure({
    home: opts.home,
    version: VERSION,
    env: process.env,
    ...(opts.ensure ?? {}),
  });
  return { state, client: new ServiceClient(endpointFromState(state)) };
}

/**
 * 取独立 access token。若尚未登录或已过期且无法 refresh，由守护进程开始登录，
 * 立即在 stderr 打印 URL，并等待守护进程完成轮询（CLI 退出不会中止轮询）。
 */
export async function obtainIndependentToken(opts: IndependentAccessOptions): Promise<AccessToken> {
  const { client } = await ensureIndependentService(opts);
  return tokenFromClient(client, opts);
}

export async function tokenFromClient(client: ServiceClient, opts: IndependentAccessOptions): Promise<AccessToken> {
  try {
    return await client.getToken();
  } catch (err) {
    if (!isAuthMissing(err)) throw err;
  }
  return loginViaDaemon(client, opts);
}

export async function loginViaDaemon(client: ServiceClient, opts: IndependentAccessOptions): Promise<AccessToken> {
  const began = await client.beginLogin();
  const write = opts.onLoginUrl ?? ((url) => printLoginUrl(url, { json: Boolean(opts.json), stderr: opts.stderr }));
  write(began.login_url);
  const waited = await client.waitLogin();
  if (waited.status === "failed") {
    throw new AgentwatchError("auth", waited.error || "登录失败。");
  }
  if (waited.status !== "completed") {
    throw new AgentwatchError("auth", "等待登录超时。", {
      hint: "请重新运行并再次打开 stderr 上的登录链接。守护进程会在本机继续轮询直到协议次数用尽。",
    });
  }
  return client.getToken();
}

export function daemonTokenHolder(opts: IndependentAccessOptions): {
  current(): Promise<AccessToken>;
  reread(): Promise<AccessToken>;
} {
  let cached: ServiceClient | undefined;
  const getClient = async () => {
    if (opts.client) return opts.client;
    if (cached) return cached;
    const { client } = await ensureIndependentService(opts);
    cached = client;
    return client;
  };
  return {
    async current() {
      return tokenFromClient(await getClient(), opts);
    },
    async reread() {
      const client = await getClient();
      try {
        return await client.getToken({ forceRefresh: true });
      } catch (err) {
        if (!isAuthMissing(err)) throw err;
        return loginViaDaemon(client, opts);
      }
    },
  };
}

function isAuthMissing(err: unknown): boolean {
  if (!isAgentwatchError(err) || err.code !== "auth") return false;
  return /尚未登录|已过期|未返回 access token|没有 refresh_token|需要登录|未配置刷新/.test(err.message);
}
