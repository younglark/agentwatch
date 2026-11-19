/** 按平台写死鉴权：不做 auto，也没有 --auth 切换。 */
export type AuthMode = "independent" | "desktop";

export function authMode(platform: NodeJS.Platform = process.platform): AuthMode {
  return platform === "darwin" ? "independent" : "desktop";
}

export function isIndependentPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return authMode(platform) === "independent";
}

export function desktopUnsupportedOnMacMessage(): string {
  return "macOS 使用独立鉴权，不会读取官方 sand-secrets.json，也不会访问钥匙串。";
}

export function independentUnsupportedOnDesktopMessage(): string {
  return "当前平台使用官方 Grok Bot 桌面应用的共享鉴权，不支持独立登录或本机守护进程。";
}

export function independentUnsupportedHint(): string {
  return "请打开并登录官方 Grok Bot 桌面应用。独立登录与 agentwatch 守护进程只在 macOS 上使用。";
}
