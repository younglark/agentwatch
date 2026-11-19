import { AgentwatchError } from "../errors.js";
import { displayPath, loadSandSecrets, type SandSecrets } from "./secrets.js";
import { decodeJwtExpMs, decryptSafeStorage } from "./decrypt.js";
import { authMode, desktopUnsupportedOnMacMessage } from "./platform.js";

export type AccessToken = {
  token: string;
  backend: string;
  secretsPath: string;
  variant: SandSecrets["variant"] | "independent";
  /** JWT exp，毫秒；非 JWT 时为 undefined。 */
  expiresAtMs?: number;
};

export type LoadTokenOptions = {
  secretsFile?: string;
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
};

/**
 * 只读解密当前活动账号的 access token。不刷新、不回写。
 * 若 JWT 看起来已过期，调用方应再读一次文件（官方应用可能已刷新磁盘上的值）。
 */
export function loadAccessToken(opts: LoadTokenOptions = {}): AccessToken {
  const platform = opts.platform ?? process.platform;
  if (authMode(platform) === "independent") {
    throw new AgentwatchError("auth", desktopUnsupportedOnMacMessage(), {
      hint: "请运行 agentwatch login，或再次执行命令并在浏览器打开 stderr 上的登录链接。",
    });
  }
  const secrets = loadSandSecrets({
    path: opts.secretsFile,
    platform: opts.platform,
    home: opts.home,
    env: opts.env,
  });
  const { plaintext, backend } = decryptSafeStorage(secrets.account.accessTokenCipher, {
    platform: opts.platform,
  });
  const token = plaintext.toString("utf8").trim();
  if (!token) {
    throw new AgentwatchError("auth", "解密后的 access token 为空。", {
      hint: "请打开并登录官方 Grok Bot 桌面应用。",
    });
  }
  const expiresAtMs = decodeJwtExpMs(token);
  return {
    token,
    backend,
    secretsPath: secrets.path,
    variant: secrets.variant,
    expiresAtMs,
  };
}

/**
 * 读取 access token。若看起来已过期，再读一次文件；仍过期或不可用则失败。
 * 不做网络 refresh，也不写回 sand-secrets.json。
 */
export function loadAccessTokenWithReread(opts: LoadTokenOptions = {}): AccessToken {
  const first = loadAccessToken(opts);
  if (!isExpired(first, opts.nowMs)) return first;
  const second = loadAccessToken(opts);
  if (!isExpired(second, opts.nowMs) && second.token !== first.token) return second;
  throw expiredError(second);
}

export function isExpired(tok: AccessToken, nowMs?: number): boolean {
  if (tok.expiresAtMs == null) return false;
  return tok.expiresAtMs <= (nowMs ?? Date.now());
}

export function expiredError(tok: AccessToken): AgentwatchError {
  if (tok.variant === "independent") {
    return new AgentwatchError("auth", "独立鉴权的 access token 已过期。", {
      hint: "请重新登录（stderr 会打印登录链接）。若只需刷新，请设置 AGENTWATCH_OAUTH_CLIENT_ID。",
    });
  }
  return new AgentwatchError(
    "auth",
    `官方 access token 已过期（来源 ${displayPath(tok.secretsPath)}）。`,
    {
      hint: "请打开并登录官方 Grok Bot 桌面应用，等待它刷新磁盘上的凭据后再试。agentwatch 不会自行 refresh，也不会写回凭据。",
    },
  );
}
