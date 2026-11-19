import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HomeOptions = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * agentwatch 自己的数据目录，与官方应用 userData、~/.gbc 分开。
 * 可用 AGENTWATCH_HOME 覆盖（测试必用）。
 */
export function resolveAgentwatchHome(opts: HomeOptions = {}): string {
  const env = opts.env ?? process.env;
  const override = env.AGENTWATCH_HOME?.trim();
  if (override) return override.replace(/[\\/]+$/, "");
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "agentwatch");
  }
  if (platform === "win32") {
    const appdata = env.APPDATA || join(home, "AppData", "Roaming");
    return join(appdata, "agentwatch");
  }
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(xdg, "agentwatch");
}

/** 确保目录存在且权限为 0700（在支持 chmod 的系统上）。 */
export function ensureHomeDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* win32 或非本地文件系统可能不支持 */
  }
}

export function credentialsPath(home: string): string {
  return join(home, "credentials.json");
}

export function credentialsLockPath(home: string): string {
  return join(home, "credentials.lock");
}

export function pendingLoginPath(home: string): string {
  return join(home, "pending-login.json");
}

export function serviceStatePath(home: string): string {
  return join(home, "service.json");
}

export function serviceConfigPath(home: string): string {
  return join(home, "config.json");
}

export function serviceLockPath(home: string): string {
  return join(home, "service.lock");
}

export function serviceLogPath(home: string): string {
  return join(home, "service.log");
}
