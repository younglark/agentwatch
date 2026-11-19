import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";

/** Chromium / Electron OSCrypt：v10/v11 + AES-128-CBC，IV 为 16 个空格。 */
export const OSCRYPT_SALT = Buffer.from("saltysalt");
export const OSCRYPT_IV = Buffer.from(" ".repeat(16));
export const LINUX_BASIC_PASSWORD = "peanuts";
export const LINUX_PBKDF2_ITERATIONS = 1;
export const MAC_PBKDF2_ITERATIONS = 1003;

export type OscryptVersion = "v10" | "v11";

export function peekOscryptPrefix(blob: Buffer): OscryptVersion | undefined {
  if (blob.length >= 3) {
    const p = blob.subarray(0, 3).toString("latin1");
    if (p === "v10" || p === "v11") return p;
  }
  return undefined;
}

export function deriveOscryptKey(password: string | Buffer, iterations: number): Buffer {
  const pw = typeof password === "string" ? Buffer.from(password, "utf8") : password;
  return pbkdf2Sync(pw, OSCRYPT_SALT, iterations, 16, "sha1");
}

/**
 * 解密 OSCrypt 密文。padding 无效时返回 undefined（密钥不对），不抛出以免误判。
 */
export function decryptOscrypt(blob: Buffer, password: string | Buffer, iterations: number): Buffer | undefined {
  const ver = peekOscryptPrefix(blob);
  if (!ver) return undefined;
  const ct = blob.subarray(3);
  if (ct.length === 0 || ct.length % 16 !== 0) return undefined;
  try {
    const key = deriveOscryptKey(password, iterations);
    const decipher = createDecipheriv("aes-128-cbc", key, OSCRYPT_IV);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt;
  } catch {
    return undefined;
  }
}

/** 仅作测试与 Linux basic_text 回退：用公开常量 "peanuts" 加密。 */
export function encryptOscryptV10(plain: Buffer | string, password: string, iterations: number): Buffer {
  const key = deriveOscryptKey(password, iterations);
  const cipher = createCipheriv("aes-128-cbc", key, OSCRYPT_IV);
  const data = typeof plain === "string" ? Buffer.from(plain, "utf8") : plain;
  return Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(data), cipher.final()]);
}
