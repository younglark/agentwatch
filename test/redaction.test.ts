import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeSecret, redact, REDACTED } from "../src/redact.js";

test("脱敏 JWT、Bearer、djEw 密文和常见密钥前缀", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.abcdefghijklmnopqrstuvwxyz012345";
  const cipher = "djEw" + "A".repeat(40);
  const samples = [
    jwt,
    `Bearer ${jwt}`,
    cipher,
    "access_token=super-secret-value",
    "ghp_abcdefghijklmnopqrstuvwxyz0123",
  ];
  for (const s of samples) {
    assert.equal(looksLikeSecret(s), true, s);
    const out = redact(s);
    assert.notEqual(out, s);
    assert.equal(out.includes(REDACTED), true);
    assert.equal(out.includes("super-secret-value"), false);
    assert.equal(out.includes("abcdefghijklmnopqrstuvwxyz012345"), false);
  }
});

test("普通命令输出不被改写", () => {
  assert.equal(redact("echo poc\nhello world"), "echo poc\nhello world");
  assert.equal(looksLikeSecret("echo poc"), false);
});
