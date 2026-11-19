/**
 * 从面向用户的文本中抹去凭据与密文。绝不把 token / 密钥 / v10 密文写进
 * stdout、stderr、通知或日志。
 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const V10_B64_RE = /\bdjEw[A-Za-z0-9+/=]{20,}\b/g;
const BEARER_RE = /\bBearer\s+\S+/gi;
const KEY_VALUE_RE =
  /\b((?:access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|passwd|authorization|credential|private[_-]?key))\s*[:=]\s*\S+/gi;
const WELL_KNOWN_PREFIX_RE =
  /\b(ghp_|gho_|ghu_|ghs_|github_pat_|sk-live-|sk-test-|sk-|xox[baprs]-|AKIA[0-9A-Z]{12,})\S*/g;

export const REDACTED = "[redacted]";

export function redact(text: string): string {
  return text
    .replace(JWT_RE, REDACTED)
    .replace(V10_B64_RE, REDACTED)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(KEY_VALUE_RE, (_, key: string) => `${key}=${REDACTED}`)
    .replace(WELL_KNOWN_PREFIX_RE, REDACTED);
}

export function looksLikeSecret(text: string): boolean {
  return redact(text) !== text;
}
