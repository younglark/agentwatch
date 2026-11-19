import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptOscrypt, encryptOscryptV10, LINUX_BASIC_PASSWORD, LINUX_PBKDF2_ITERATIONS } from "../src/auth/oscrypt.js";
import { decryptSafeStorage, isPlausibleSecret, decodeJwtExpMs } from "../src/auth/decrypt.js";

test("peanuts / v10 往返加密可解开，且结果不出现在抛错信息里", () => {
  const plain = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.sig";
  const blob = encryptOscryptV10(plain, LINUX_BASIC_PASSWORD, LINUX_PBKDF2_ITERATIONS);
  assert.equal(blob.subarray(0, 3).toString("latin1"), "v10");
  const out = decryptOscrypt(blob, LINUX_BASIC_PASSWORD, LINUX_PBKDF2_ITERATIONS);
  assert.ok(out);
  assert.equal(out!.toString("utf8"), plain);
  const b64 = blob.toString("base64");
  assert.match(b64, /^djEw/);
  const dec = decryptSafeStorage(b64, { platform: "linux" });
  assert.equal(dec.plaintext.toString("utf8"), plain);
  assert.equal(dec.backend, "linux-basic-text");
});

test("错误密码不能得到明文", () => {
  const blob = encryptOscryptV10("secret-plain-value", LINUX_BASIC_PASSWORD, LINUX_PBKDF2_ITERATIONS);
  const out = decryptOscrypt(blob, "wrong-password", LINUX_PBKDF2_ITERATIONS);
  assert.equal(out, undefined);
});

test("isPlausibleSecret 接受 JWT 和 JSON，拒绝二进制垃圾", () => {
  assert.equal(isPlausibleSecret(Buffer.from("eyJhbGciOiJub25lIn0.eyJhIjoxfQ.x")), true);
  assert.equal(isPlausibleSecret(Buffer.from('{"email":"x"}')), true);
  assert.equal(isPlausibleSecret(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])), false);
});

test("decodeJwtExpMs 只读取 exp，不需要完整校验", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString("base64url");
  const token = `eyJhbGciOiJub25lIn0.${payload}.x`;
  assert.equal(decodeJwtExpMs(token), 1_900_000_000 * 1000);
  assert.equal(decodeJwtExpMs("not-a-jwt"), undefined);
});
