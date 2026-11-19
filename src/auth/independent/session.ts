import { AgentwatchError } from "../../errors.js";
import { credentialsPath, ensureHomeDir } from "../home.js";
import type { AccessToken } from "../token.js";
import { buildLoginUrl, generateLoginChallenge, resolveApiBase, resolveWebsite } from "./login.js";
import { pollForLogin, pollOutcomeError, type PollHooks } from "./poll.js";
import { missingClientIdError, oauthClientId, refreshDecision, refreshIndependentTokens } from "./refresh.js";
import {
  clearCredentials,
  clearPendingLogin,
  credsFromTokens,
  readCredentials,
  readPendingLogin,
  writeCredentials,
  writePendingLogin,
  type IndependentCredentials,
  type PendingLogin,
} from "./store.js";

export type SessionOptions = {
  home: string;
  apiBase?: string;
  website?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  poll?: PollHooks;
  fetch?: typeof fetch;
};

export type BeginLoginResult = {
  login_url: string;
  uuid: string;
  reused: boolean;
};

type LoginWaiter = {
  promise: Promise<IndependentCredentials>;
};

/**
 * 守护进程内的独立会话：登录轮询、刷新、凭据读写的单一所有者。
 * 进程内 singleflight，落盘时再加 pid 文件锁。
 */
export class IndependentSession {
  private readonly opts: SessionOptions;
  private login: LoginWaiter | undefined;
  private refreshInflight: Promise<AccessToken> | undefined;
  private pollAbort: AbortController | undefined;
  private lastLoginError: AgentwatchError | undefined;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    ensureHomeDir(opts.home);
  }

  private env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  private apiBase(): string {
    return this.opts.apiBase ?? resolveApiBase(this.env());
  }

  private website(): string {
    return this.opts.website ?? resolveWebsite(this.env());
  }

  /** 若已有未完成的 pending，复用同一条登录 URL，不新生成 verifier。 */
  async beginLogin(): Promise<BeginLoginResult> {
    const existing = readPendingLogin(this.opts.home);
    if (existing) {
      this.ensurePolling(existing);
      return { login_url: existing.login_url, uuid: existing.uuid, reused: true };
    }
    const challenge = generateLoginChallenge();
    const login_url = buildLoginUrl(this.website(), challenge);
    const pending: PendingLogin = {
      ...challenge,
      login_url,
      api_base: this.apiBase(),
      website: this.website(),
      started_at_ms: (this.opts.now ?? Date.now)(),
    };
    await writePendingLogin(this.opts.home, pending);
    this.ensurePolling(pending);
    return { login_url, uuid: pending.uuid, reused: false };
  }

  loginStatus(): { status: "idle" | "pending" | "completed" | "failed"; uuid?: string; error?: string } {
    if (this.login) {
      const pending = readPendingLogin(this.opts.home);
      return { status: "pending", uuid: pending?.uuid };
    }
    if (readPendingLogin(this.opts.home)) {
      return { status: "pending", uuid: readPendingLogin(this.opts.home)?.uuid };
    }
    if (readCredentials(this.opts.home)) return { status: "completed" };
    return { status: "idle" };
  }

  /** 等待当前（或刚开始的）登录轮询结束。轮询本身在本对象内继续，不因调用方断开而中止。 */
  async waitForLogin(): Promise<IndependentCredentials> {
    const pending = readPendingLogin(this.opts.home);
    if (pending) this.ensurePolling(pending);
    if (this.login) return this.login.promise;
    const creds = readCredentials(this.opts.home);
    if (creds) return creds;
    if (this.lastLoginError) throw this.lastLoginError;
    throw new AgentwatchError("auth", "没有进行中的登录。");
  }

  async logout(): Promise<void> {
    this.pollAbort?.abort();
    this.pollAbort = undefined;
    this.login = undefined;
    this.lastLoginError = undefined;
    await clearPendingLogin(this.opts.home);
    await clearCredentials(this.opts.home);
  }

  /**
   * 返回可用的独立 access token。必要时 refresh；若必须登录则抛出带 login_url 的错误前，
   * 调用方应先 beginLogin。
   */
  async getAccessToken(opts?: { forceRefresh?: boolean; allowLogin?: boolean }): Promise<AccessToken> {
    if (this.refreshInflight) return this.refreshInflight;
    this.refreshInflight = this.loadOrRefresh(opts).finally(() => {
      this.refreshInflight = undefined;
    });
    return this.refreshInflight;
  }

  private async loadOrRefresh(opts?: { forceRefresh?: boolean; allowLogin?: boolean }): Promise<AccessToken> {
    const pending = readPendingLogin(this.opts.home);
    if (pending || this.login) {
      if (opts?.allowLogin) {
        if (pending) this.ensurePolling(pending);
        const creds = await this.waitForLogin();
        return toAccess(creds, this.opts.home);
      }
    }
    let creds = readCredentials(this.opts.home);
    if (!creds) {
      throw new AgentwatchError("auth", "尚未登录独立鉴权。", {
        hint: "请运行 agentwatch login，或重新执行命令并在浏览器打开 stderr 上的登录链接。",
      });
    }
    const clientId = oauthClientId(this.env());
    const decision = opts?.forceRefresh
      ? clientId
        ? "refresh"
        : refreshDecision(creds, { nowMs: (this.opts.now ?? Date.now)(), clientId }) === "ok"
          ? "ok"
          : "need_client_id"
      : refreshDecision(creds, { nowMs: (this.opts.now ?? Date.now)(), clientId });
    if (decision === "ok") return toAccess(creds, this.opts.home);
    if (decision === "need_client_id") {
      const exp = creds.expires_at_ms;
      const now = (this.opts.now ?? Date.now)();
      if (exp === undefined || exp > now) return toAccess(creds, this.opts.home);
      throw missingClientIdError();
    }
    try {
      const next = await refreshIndependentTokens(creds, clientId, { fetch: this.opts.fetch });
      await writeCredentials(this.opts.home, next);
      return toAccess(next, this.opts.home);
    } catch (err) {
      if (err instanceof AgentwatchError) throw err;
      throw new AgentwatchError("auth", err instanceof Error ? err.message : String(err));
    }
  }

  private ensurePolling(pending: PendingLogin): void {
    if (this.login) return;
    this.pollAbort = new AbortController();
    const hooks: PollHooks = {
      ...this.opts.poll,
      fetch: this.opts.poll?.fetch ?? this.opts.fetch,
      signal: this.pollAbort.signal,
    };
    const promise = pollForLogin({
      apiBase: pending.api_base || this.apiBase(),
      uuid: pending.uuid,
      verifier: pending.verifier,
      ...hooks,
    }).then(async (outcome) => {
      if (outcome.status !== "success") {
        if (outcome.status === "pending" || this.pollAbort?.signal.aborted) {
          throw new AgentwatchError("auth", "登录轮询已取消。");
        }
        throw pollOutcomeError(outcome);
      }
      const creds = credsFromTokens(
        outcome.tokens.accessToken,
        outcome.tokens.refreshToken,
        pending.api_base || this.apiBase(),
        (this.opts.now ?? Date.now)(),
      );
      await writeCredentials(this.opts.home, creds);
      await clearPendingLogin(this.opts.home);
      this.lastLoginError = undefined;
      return creds;
    });
    this.login = { promise };
    this.lastLoginError = undefined;
    promise
      .catch((err) => {
        this.lastLoginError = err instanceof AgentwatchError ? err : new AgentwatchError("auth", err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (this.login?.promise === promise) this.login = undefined;
      });
  }
}

export function toAccess(creds: IndependentCredentials, home: string): AccessToken {
  return {
    token: creds.access_token,
    backend: creds.backend || "independent",
    secretsPath: credentialsPath(home),
    variant: "independent",
    expiresAtMs: creds.expires_at_ms,
  };
}

export function needsLogin(err: unknown): boolean {
  return err instanceof AgentwatchError && err.code === "auth" && /尚未登录|已过期|没有 refresh_token/.test(err.message);
}
