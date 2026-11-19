import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCommand, renderNotification, tailBytes } from "../src/notify.js";
import { REDACTED, redact } from "../src/redact.js";

test("格式化命令并引用特殊字符", () => {
  assert.equal(formatCommand(["echo", "poc"]), "echo poc");
  assert.equal(formatCommand(["sh", "-c", "echo hi"]), 'sh -c "echo hi"');
});

test("通知包含状态、命令、退出码、耗时、主机和输出尾部", () => {
  const text = renderNotification({
    status: "completed",
    command: ["echo", "poc"],
    exitCode: 0,
    durationMs: 1234,
    hostname: "box",
    stdoutTail: "hello",
    stderrTail: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  assert.match(text, /状态：完成/);
  assert.match(text, /命令：echo poc/);
  assert.match(text, /退出码：0/);
  assert.match(text, /耗时：1\.23s/);
  assert.match(text, /主机：box/);
  assert.match(text, /stdout：\nhello/);
  assert.match(text, /stderr：（空）/);
});

test("超时退出码为无，截断标记出现在输出标题", () => {
  const text = renderNotification({
    status: "timeout",
    command: ["sleep", "10"],
    exitCode: null,
    durationMs: 1000,
    hostname: "box",
    stdoutTail: "aaaa",
    stderrTail: "bbbb",
    stdoutTruncated: true,
    stderrTruncated: true,
    dryRun: true,
  });
  assert.match(text, /状态：超时/);
  assert.match(text, /退出码：无/);
  assert.match(text, /dry-run/);
  assert.match(text, /stdout（尾部，已截断）/);
});

test("通知中的 JWT 与 Bearer 会被脱敏", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnopqrstuvwxyz012345";
  const text = renderNotification({
    status: "failed",
    command: ["echo", jwt],
    exitCode: 1,
    durationMs: 10,
    hostname: "box",
    stdoutTail: `Authorization: Bearer ${jwt}`,
    stderrTail: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  assert.equal(text.includes(jwt), false);
  assert.match(text, new RegExp(REDACTED));
  assert.equal(redact(text).includes(jwt), false);
});

test("tailBytes 保留末尾并标记截断", () => {
  const buf = Buffer.from("abcdefghij");
  const full = tailBytes(buf, 100);
  assert.equal(full.truncated, false);
  assert.equal(full.text, "abcdefghij");
  const part = tailBytes(buf, 4);
  assert.equal(part.truncated, true);
  assert.equal(part.text, "ghij");
});
