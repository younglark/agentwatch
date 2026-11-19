import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { AgentwatchError } from "../errors.js";
import { authMode, desktopUnsupportedOnMacMessage } from "./platform.js";

export type CursorAccount = {
  id: string;
  accessTokenCipher: string;
  refreshTokenCipher: string;
  profileCipher?: string;
};

export type SandSecrets = {
  path: string;
  version: unknown;
  activeId: string;
  account: CursorAccount;
  variant: "Grok Bot" | "Grok Bot Research" | "override";
};

export type SecretsPaths = {
  platform: NodeJS.Platform;
  home: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * 官方凭据路径。优先已登录的稳定版「Grok Bot」，否则尝试「Grok Bot Research」。
 * 结构只读；token 值仍是密文。
 */
export function listSecretsCandidates(opts: SecretsPaths): { path: string; variant: SandSecrets["variant"] }[] {
  const env = opts.env ?? process.env;
  const join = opts.platform === "win32" ? win32.join : posix.join;
  const override = env.AGENTWATCH_SECRETS_FILE?.trim();
  if (override) return [{ path: override, variant: "override" }];
  const userData = env.AGENTWATCH_USER_DATA?.trim();
  if (userData) return [{ path: join(userData, "sand-secrets.json"), variant: "override" }];

  const dirs: { dir: string; variant: SandSecrets["variant"] }[] = [];
  if (opts.platform === "darwin") {
    const base = join(opts.home, "Library", "Application Support");
    dirs.push({ dir: join(base, "Grok Bot"), variant: "Grok Bot" });
    dirs.push({ dir: join(base, "Grok Bot Research"), variant: "Grok Bot Research" });
  } else if (opts.platform === "win32") {
    const appdata = env.APPDATA || join(opts.home, "AppData", "Roaming");
    dirs.push({ dir: join(appdata, "Grok Bot"), variant: "Grok Bot" });
    dirs.push({ dir: join(appdata, "Grok Bot Research"), variant: "Grok Bot Research" });
  } else {
    const xdg = env.XDG_CONFIG_HOME?.trim() || join(opts.home, ".config");
    dirs.push({ dir: join(xdg, "Grok Bot"), variant: "Grok Bot" });
    dirs.push({ dir: join(xdg, "Grok Bot Research"), variant: "Grok Bot Research" });
  }
  return dirs.map((d) => ({ path: join(d.dir, "sand-secrets.json"), variant: d.variant }));
}

export function parseSandSecrets(raw: string, path: string, variant: SandSecrets["variant"]): SandSecrets {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AgentwatchError("auth", `无法解析 ${displayPath(path)}：不是合法 JSON。`, {
      hint: "请打开并登录官方 Grok Bot 桌面应用。",
    });
  }
  if (!data || typeof data !== "object") {
    throw new AgentwatchError("auth", `${displayPath(path)} 根对象格式不正确。`);
  }
  const rec = data as Record<string, unknown>;
  const accountsRaw = rec["cursor-accounts"];
  let accountsWrap: unknown;
  if (typeof accountsRaw === "string") {
    try {
      accountsWrap = JSON.parse(accountsRaw);
    } catch {
      throw new AgentwatchError("auth", `${displayPath(path)} 中 cursor-accounts 不是合法 JSON。`);
    }
  } else {
    accountsWrap = accountsRaw;
  }
  if (!accountsWrap || typeof accountsWrap !== "object") {
    throw new AgentwatchError("auth", `${displayPath(path)} 缺少 cursor-accounts。`, {
      hint: "请打开并登录官方 Grok Bot 桌面应用。",
    });
  }
  const wrap = accountsWrap as Record<string, unknown>;
  const activeId = typeof wrap.active === "string" ? wrap.active : "";
  const accounts = (wrap.accounts && typeof wrap.accounts === "object" ? wrap.accounts : {}) as Record<
    string,
    unknown
  >;
  const id = activeId && accounts[activeId] ? activeId : Object.keys(accounts)[0];
  if (!id) {
    throw new AgentwatchError("auth", `${displayPath(path)} 中没有可用账号。`, {
      hint: "请打开并登录官方 Grok Bot 桌面应用。",
    });
  }
  const row = accounts[id];
  if (!row || typeof row !== "object") {
    throw new AgentwatchError("auth", `${displayPath(path)} 中活动账号记录无效。`);
  }
  const acct = row as Record<string, unknown>;
  const access = asString(acct["cursor-access-token"]);
  const refresh = asString(acct["cursor-refresh-token"]);
  if (!access) {
    throw new AgentwatchError("auth", `${displayPath(path)} 中活动账号没有 access token。`, {
      hint: "请打开并登录官方 Grok Bot 桌面应用。",
    });
  }
  return {
    path,
    version: rec.version,
    activeId: id,
    variant,
    account: {
      id,
      accessTokenCipher: access,
      refreshTokenCipher: refresh ?? "",
      profileCipher: asString(acct["cursor-account-profile"]),
    },
  };
}

export function loadSandSecrets(opts?: Partial<SecretsPaths> & { path?: string }): SandSecrets {
  const platform = opts?.platform ?? process.platform;
  if (authMode(platform) === "independent") {
    throw new AgentwatchError("auth", desktopUnsupportedOnMacMessage(), {
      hint: "请运行 agentwatch login。macOS 不会读取官方 sand-secrets.json。",
    });
  }
  const home = opts?.home ?? homedir();
  const env = opts?.env ?? process.env;
  const candidates = opts?.path
    ? [{ path: opts.path, variant: "override" as const }]
    : listSecretsCandidates({ platform, home, env });
  const existing = candidates.filter((c) => existsSync(c.path));
  if (existing.length === 0) {
    const shown = candidates.map((c) => displayPath(c.path)).join("、");
    throw new AgentwatchError("auth", `未找到官方凭据文件（尝试了：${shown}）。`, {
      hint: "请打开并登录官方 Grok Bot 桌面应用后再试。",
    });
  }
  // 稳定版优先；若解析失败再试下一个。
  let last: AgentwatchError | undefined;
  for (const c of existing) {
    try {
      const raw = readFileSync(c.path, "utf8");
      return parseSandSecrets(raw, c.path, c.variant);
    } catch (e) {
      if (e instanceof AgentwatchError) last = e;
      else throw e;
    }
  }
  throw last ?? new AgentwatchError("auth", "无法读取官方凭据。");
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function displayPath(p: string): string {
  const home = homedir();
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
