import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentwatchError } from "../errors.js";
import {
  LINUX_BASIC_PASSWORD,
  LINUX_PBKDF2_ITERATIONS,
  MAC_PBKDF2_ITERATIONS,
  decryptOscrypt,
  peekOscryptPrefix,
} from "./oscrypt.js";

export type DecryptResult = {
  plaintext: Buffer;
  backend: string;
};

/**
 * 解密 Electron safeStorage 密文（磁盘上通常是以 djEw 开头的 base64，解码后前缀为 v10）。
 * 只在内存中进行；永不打印密钥或明文。
 *
 * 算法与若干非官方工具一致（仅作实现参考，未整文件复制）：
 * - macOS：钥匙串 generic password，service「Grok Bot Safe Storage」，
 *   PBKDF2(password, salt "saltysalt", 1003, SHA-1, 16 字节) + AES-128-CBC，IV 为 16 个空格。
 * - Linux：先尝试 `secret-tool lookup application "Grok Bot"`，再回退 Chromium
 *   basic_text 公开密码 "peanuts"（1 次迭代）。必须先验证明文是否像 JWT/JSON，不能臆造密钥。
 */
export function decryptSafeStorage(cipher: string, opts?: { platform?: NodeJS.Platform }): DecryptResult {
  const platform = opts?.platform ?? process.platform;
  let blob: Buffer;
  try {
    blob = Buffer.from(cipher, "base64");
  } catch {
    throw new AgentwatchError("auth", "凭据密文不是合法的 base64。", {
      hint: "请打开并登录官方 Grok Bot 桌面应用。",
    });
  }
  if (blob.length === 0) {
    throw new AgentwatchError("auth", "凭据密文为空。");
  }

  if (platform === "win32") {
    return decryptWindows(blob, cipher);
  }
  if (platform === "darwin") {
    return decryptMac(blob);
  }
  return decryptLinux(blob);
}

function decryptLinux(blob: Buffer): DecryptResult {
  const prefix = peekOscryptPrefix(blob);
  if (!prefix) {
    throw new AgentwatchError("auth", "Linux 凭据密文缺少 Electron OSCrypt 前缀（v10/v11）。", {
      hint: "请打开并登录官方 Grok Bot 桌面应用。若应用刚升级，解密路径可能需要同步更新。",
    });
  }

  const keyringPasswords = linuxKeyringPasswords();
  for (const [backend, password] of keyringPasswords) {
    const pt = decryptOscrypt(blob, password, LINUX_PBKDF2_ITERATIONS);
    if (pt && isPlausibleSecret(pt)) return { plaintext: pt, backend };
  }

  // 官方应用在 getSelectedStorageBackend()==="basic_text" 时会 setUsePlainTextEncryption(true)，
  // 此时使用 Chromium 公开常量密码 "peanuts"（v10）。仅在钥匙串路径失败后作为回退。
  const peanuts = decryptOscrypt(blob, LINUX_BASIC_PASSWORD, LINUX_PBKDF2_ITERATIONS);
  if (peanuts && isPlausibleSecret(peanuts)) {
    return { plaintext: peanuts, backend: "linux-basic-text" };
  }

  throw new AgentwatchError("auth", "无法解密官方 access token（Linux safeStorage）。", {
    hint:
      "请打开并登录 Grok Bot。若本机使用了 gnome-libsecret / KWallet，请确保会话钥匙串已解锁。解密失败时不要启动第二份 Electron 去占用官方 userData 目录。",
  });
}

function decryptMac(blob: Buffer): DecryptResult {
  const prefix = peekOscryptPrefix(blob);
  if (!prefix) {
    throw new AgentwatchError("auth", "macOS 凭据密文缺少 Electron OSCrypt 前缀（v10/v11）。");
  }
  const passwords = macKeychainPasswords();
  if (passwords.length === 0) {
    throw new AgentwatchError("auth", "无法从钥匙串读取 Grok Bot Safe Storage 密钥。", {
      hint: "请打开并登录官方 Grok Bot 桌面应用，并在系统钥匙串中允许本 CLI 读取（如有提示）。",
    });
  }
  for (const [backend, password] of passwords) {
    const pt = decryptOscrypt(blob, password, MAC_PBKDF2_ITERATIONS);
    if (pt && isPlausibleSecret(pt)) return { plaintext: pt, backend };
  }
  // 极少数自定义构建可能用 1 次迭代。
  for (const [backend, password] of passwords) {
    const pt = decryptOscrypt(blob, password, LINUX_PBKDF2_ITERATIONS);
    if (pt && isPlausibleSecret(pt)) return { plaintext: pt, backend: `${backend}-iter1` };
  }
  throw new AgentwatchError("auth", "已从钥匙串取到密钥，但无法解密官方 access token。", {
    hint: "请打开并登录官方 Grok Bot。应用更新后密钥格式可能变化。",
  });
}

function decryptWindows(blob: Buffer, originalB64: string): DecryptResult {
  const prefix = peekOscryptPrefix(blob);
  if (!prefix) {
    const dpapi = windowsDpapiUnprotect(blob) ?? windowsDpapiUnprotect(Buffer.from(originalB64, "utf8"));
    if (dpapi && isPlausibleSecret(dpapi)) return { plaintext: dpapi, backend: "windows-dpapi" };
    throw new AgentwatchError("auth", "无法用 DPAPI 解密官方凭据。", {
      hint: "请在同一 Windows 用户会话下打开并登录官方 Grok Bot。",
    });
  }
  const localKey = windowsLocalStateKey();
  if (localKey) {
    const gcm = windowsAesGcmDecrypt(blob, localKey);
    if (gcm && isPlausibleSecret(gcm)) return { plaintext: gcm, backend: "windows-os-crypt-gcm" };
  }
  const dpapi = windowsDpapiUnprotect(blob.subarray(3)) ?? windowsDpapiUnprotect(blob);
  if (dpapi && isPlausibleSecret(dpapi)) return { plaintext: dpapi, backend: "windows-dpapi" };
  throw new AgentwatchError("auth", "无法解密 Windows 官方凭据。", {
    hint: "请在同一用户下打开并登录官方 Grok Bot。",
  });
}

/** 明文像 JWT 或 JSON / 可打印文本时才接受，避免错误密钥碰巧通过 padding。 */
export function isPlausibleSecret(pt: Buffer): boolean {
  if (pt.length === 0) return false;
  const s = pt.toString("utf8");
  if (s.includes("\uFFFD") && !pt.every((b) => b === 0xff || b < 0x80)) {
    // 允许少量非 UTF-8？token 应为 UTF-8。
  }
  try {
    const t = s.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      JSON.parse(t);
      return true;
    }
    const parts = t.split(".");
    if (parts.length === 3 && parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p))) {
      return true;
    }
    if (t.length >= 8 && /^[\x09\x0a\x0d\x20-\x7e]+$/.test(t)) return true;
  } catch {
    return false;
  }
  return false;
}

export function decodeJwtExpMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = parts[1]!;
    const pad = "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(payload + pad, "base64url").toString("utf8");
    const data = JSON.parse(json) as { exp?: unknown };
    if (typeof data.exp === "number" && Number.isFinite(data.exp)) return data.exp * 1000;
  } catch {
    return undefined;
  }
  return undefined;
}

function linuxKeyringPasswords(): [string, string][] {
  const out: [string, string][] = [];
  const apps = ["Grok Bot", "Grok Bot Research", "chromium", "chrome", "Electron"];
  for (const app of apps) {
    const pw = secretToolLookup({ application: app }) ?? busctlLookup({ application: app });
    if (pw) out.push([`linux-libsecret:${app}`, pw]);
  }
  const schemaPw =
    secretToolLookup({ "xdg:schema": "chrome_libsecret_os_crypt_password_v2" }) ??
    busctlLookup({ "xdg:schema": "chrome_libsecret_os_crypt_password_v2" });
  if (schemaPw) out.push(["linux-libsecret:chrome-schema", schemaPw]);
  return out;
}

function secretToolLookup(attrs: Record<string, string>): string | undefined {
  const bin = which("secret-tool");
  if (!bin) return undefined;
  const args = ["lookup", ...Object.entries(attrs).flat()];
  try {
    const stdout = execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
    });
    const pw = stdout.replace(/\n$/, "");
    return pw.length > 0 ? pw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 无 secret-tool 时，尽力通过已有的 busctl 查询 Secret Service。
 * 失败则静默回退；绝不把密钥写到日志。
 */
function busctlLookup(attrs: Record<string, string>): string | undefined {
  const bin = which("busctl");
  if (!bin) return undefined;
  // 完整的 Secret Service OpenSession + GetSecret 握手较繁琐，PoC 只做 SearchItems。
  // 若没有配对的解锁会话，这里返回 undefined，由 peanuts / 明确错误接手。
  try {
    const kv: string[] = [];
    for (const [k, v] of Object.entries(attrs)) kv.push(k, v);
    const result = execFileSync(
      bin,
      [
        "--user",
        "call",
        "org.freedesktop.secrets",
        "/org/freedesktop/secrets",
        "org.freedesktop.Secret.Service",
        "SearchItems",
        "a{ss}",
        String(Object.keys(attrs).length),
        ...kv,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000 },
    );
    // 不在找不到条目时继续 GetSecret（需要会话）。有条目也宁可让 libsecret/peanuts 路径处理。
    void result;
  } catch {
    /* service missing */
  }
  return undefined;
}

function macKeychainPasswords(): [string, string][] {
  const services = [
    "Grok Bot Safe Storage",
    "Grok Bot Research Safe Storage",
    "Chromium Safe Storage",
    "Chrome Safe Storage",
    "Electron Safe Storage",
  ];
  const out: [string, string][] = [];
  for (const service of services) {
    try {
      const stdout = execFileSync("/usr/bin/security", ["find-generic-password", "-w", "-s", service], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      });
      const pw = stdout.replace(/\n$/, "");
      if (pw) out.push([`macos-keychain:${service}`, pw]);
    } catch {
      /* not found or not allowed */
    }
  }
  return out;
}

function windowsDpapiUnprotect(blob: Buffer): Buffer | undefined {
  if (process.platform !== "win32") return undefined;
  // 通过 PowerShell 调用 ProtectedData，把明文以 base64 写回 stdout（仅限此子进程管道）。
  const b64 = blob.toString("base64");
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$blob = [Convert]::FromBase64String('${b64}')`,
    "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($plain)",
  ].join("; ");
  try {
    const stdout = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8000, windowsHide: true },
    );
    const line = stdout.trim().split(/\r?\n/).pop() ?? "";
    if (!line) return undefined;
    return Buffer.from(line, "base64");
  } catch {
    return undefined;
  }
}

function windowsLocalStateKey(): Buffer | undefined {
  const appdata = process.env.APPDATA;
  if (!appdata) return undefined;
  for (const name of ["Grok Bot", "Grok Bot Research"]) {
    const p = join(appdata, name, "Local State");
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, "utf8")) as { os_crypt?: { encrypted_key?: string } };
      const enc = data.os_crypt?.encrypted_key;
      if (!enc) continue;
      const raw = Buffer.from(enc, "base64");
      // Chrome 前缀 "DPAPI"。
      const blob = raw.subarray(0, 5).toString("latin1") === "DPAPI" ? raw.subarray(5) : raw;
      const key = windowsDpapiUnprotect(blob);
      if (key) return key;
    } catch {
      continue;
    }
  }
  return undefined;
}

function windowsAesGcmDecrypt(blob: Buffer, key: Buffer): Buffer | undefined {
  // Chrome v10: prefix + 12-byte nonce?  实际 Windows OSCrypt v10 使用 nonce 96-bit + AES-256-GCM。
  // 这里做尽力解密；失败则返回 undefined。
  const { createDecipheriv } = require("node:crypto") as typeof import("node:crypto");
  const prefix = peekOscryptPrefix(blob);
  if (!prefix) return undefined;
  const data = blob.subarray(3);
  if (data.length < 16 + 16) return undefined;
  const nonce = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(12, data.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.subarray(0, 32), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    return undefined;
  }
}

function which(bin: string): string | undefined {
  const path = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const ext = process.platform === "win32" ? [".exe", ""] : [""];
  for (const dir of path.split(sep)) {
    for (const e of ext) {
      const p = join(dir, bin + e);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}
