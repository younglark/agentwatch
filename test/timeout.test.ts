import assert from "node:assert/strict";
import { test } from "node:test";
import { runChild } from "../src/child.js";

test("timeout 到期后杀死子进程并报告 timeout", { timeout: 15_000 }, async () => {
  const started = Date.now();
  const result = await runChild({
    command: ["sleep", "30"],
    timeoutSeconds: 1,
    tailBytes: 1024,
    relay: null,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, "timeout");
  assert.ok(elapsed < 8000, `killed too slowly: ${elapsed}ms`);
  assert.ok(result.durationMs >= 900);
});

test("成功的短命令不触发 timeout", async () => {
  const result = await runChild({
    command: ["echo", "poc"],
    timeoutSeconds: 5,
    tailBytes: 1024,
    relay: null,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdoutTail, /poc/);
});

test("失败命令报告 failed 与退出码", async () => {
  const result = await runChild({
    command: ["sh", "-c", "exit 17"],
    timeoutSeconds: 5,
    tailBytes: 1024,
    relay: null,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 17);
});
