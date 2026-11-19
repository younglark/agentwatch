import { AgentwatchError } from "../errors.js";
import type { AccessToken } from "../auth/token.js";
import { credentialsPath } from "../auth/home.js";
import { authHeaders } from "./probe.js";
import type { ServiceState } from "./types.js";

export type ServiceEndpoint = {
  url: string;
  password: string;
};

export function endpointFromState(state: ServiceState): ServiceEndpoint {
  return { url: state.url, password: state.password };
}

export type BeginLoginResponse = {
  login_url: string;
  uuid: string;
  reused: boolean;
};

export type LoginStatusResponse = {
  status: "idle" | "pending" | "completed" | "failed";
  uuid?: string;
  error?: string;
};

export class ServiceClient {
  constructor(private readonly endpoint: ServiceEndpoint) {}

  async info(): Promise<{ id: string; version: string; pid: number; started_at: string }> {
    const res = await this.request("GET", "/api/info");
    return (await res.json()) as { id: string; version: string; pid: number; started_at: string };
  }

  async beginLogin(): Promise<BeginLoginResponse> {
    const res = await this.request("POST", "/auth/login/begin");
    return (await res.json()) as BeginLoginResponse;
  }

  async loginStatus(): Promise<LoginStatusResponse> {
    const res = await this.request("GET", "/auth/login/status");
    return (await res.json()) as LoginStatusResponse;
  }

  async waitLogin(): Promise<LoginStatusResponse> {
    const res = await this.request("POST", "/auth/login/wait");
    return (await res.json()) as LoginStatusResponse;
  }

  async logout(): Promise<void> {
    await this.request("POST", "/auth/logout");
  }

  async getToken(opts?: { forceRefresh?: boolean }): Promise<AccessToken> {
    const q = opts?.forceRefresh ? "?refresh=1" : "";
    const res = await this.request("GET", `/auth/token${q}`);
    const body = (await res.json()) as {
      access_token: string;
      expires_at_ms?: number;
      backend?: string;
      secrets_path?: string;
    };
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new AgentwatchError("auth", "本机服务未返回 access token。");
    }
    return {
      token: body.access_token,
      backend: body.backend || "independent",
      secretsPath: body.secrets_path || credentialsPath(""),
      variant: "independent",
      expiresAtMs: body.expires_at_ms,
    };
  }

  private async request(method: string, path: string): Promise<Response> {
    const url = new URL(path, this.endpoint.url.endsWith("/") ? this.endpoint.url : this.endpoint.url + "/");
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { ...authHeaders(this.endpoint.password), Accept: "application/json" },
      });
    } catch (err) {
      throw new AgentwatchError("retryable", `无法连接本机服务：${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
      });
    }
    if (!res.ok) throw await parseError(res);
    return res;
  }
}

async function parseError(res: Response): Promise<AgentwatchError> {
  const body = (await res.json().catch(() => undefined)) as
    | { error?: { code?: string; message?: string; hint?: string } }
    | undefined;
  const message = body?.error?.message || `本机服务返回 HTTP ${res.status}。`;
  const code = body?.error?.code === "auth" || res.status === 401 ? "auth" : "failure";
  return new AgentwatchError(code === "auth" ? "auth" : "failure", message, { hint: body?.error?.hint });
}
