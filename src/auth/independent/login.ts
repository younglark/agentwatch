import { createHash, randomBytes, randomUUID } from "node:crypto";

export const DEFAULT_WEBSITE = "https://cursor.com";
export const DEFAULT_API_BASE = "https://api2.cursor.sh";

export type LoginChallenge = {
  verifier: string;
  challenge: string;
  uuid: string;
};

/** verifier = base64url(32 random bytes); challenge = base64url(sha256(verifier 字符串))。 */
export function generateLoginChallenge(): LoginChallenge {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
  return { verifier, challenge, uuid: randomUUID() };
}

/**
 * 用户只需打开这一条链接，无需另输设备码，也没有 localhost 回调或隧道。
 * cli 预设：redirectTarget=cli，且不要加 supportsSelectedTeamLogin。
 */
export function buildLoginUrl(
  website: string,
  params: { challenge: string; uuid: string },
): string {
  const u = new URL("/loginDeepControl", stripSlash(website) + "/");
  u.searchParams.set("challenge", params.challenge);
  u.searchParams.set("uuid", params.uuid);
  u.searchParams.set("mode", "login");
  u.searchParams.set("redirectTarget", "cli");
  return u.toString();
}

export function resolveWebsite(env: NodeJS.ProcessEnv = process.env): string {
  return stripSlash(env.AGENTWATCH_WEBSITE?.trim() || DEFAULT_WEBSITE);
}

export function resolveApiBase(env: NodeJS.ProcessEnv = process.env, fallback = DEFAULT_API_BASE): string {
  return stripSlash(env.AGENTWATCH_API_BASE?.trim() || fallback);
}

export function stripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1";
}
