import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT } from "../src/exit.js";
import { AgentwatchError } from "../src/errors.js";
import { runWatch } from "../src/run.js";
import type { Protocol } from "../src/protocol.js";

const bot = "8f6d6b87-e7b6-4bf3-a45d-fbca5bc418e5";

function runArgs(overrides: Partial<{ dryRun: boolean }> = {}) {
  return {
    kind: "run" as const,
    bot,
    command: ["echo", "should-not-run"],
    timeoutSeconds: 0,
    json: false,
    dryRun: overrides.dryRun ?? false,
    tailBytes: 1024,
    apiBase: "https://example.invalid",
  };
}

test("完整列表中找不到 bot 时不运行命令", async () => {
  let ran = false;
  const protocol: Protocol = {
    async listBots() {
      return { bots: [{ agentId: "other", id: "1", name: "x", title: "" }], truncated: false };
    },
    async sendMessage() {
      throw new Error("should not send");
    },
  };
  await assert.rejects(
    () =>
      runWatch(runArgs(), {
        protocol,
        async runChild() {
          ran = true;
          throw new Error("child started");
        },
      }),
    (e: unknown) => {
      assert(e instanceof AgentwatchError);
      assert.equal(e.code, "not_found");
      assert.equal(e.exitCode, EXIT.NOT_FOUND);
      return true;
    },
  );
  assert.equal(ran, false);
});

test("列表被截断且找不到 id 时视为存在性未知，不运行命令", async () => {
  let ran = false;
  const protocol: Protocol = {
    async listBots() {
      return { bots: [], truncated: true };
    },
    async sendMessage() {
      throw new Error("should not send");
    },
  };
  await assert.rejects(
    () =>
      runWatch(runArgs(), {
        protocol,
        async runChild() {
          ran = true;
          throw new Error("child started");
        },
      }),
    (e: unknown) => {
      assert(e instanceof AgentwatchError);
      assert.equal(e.code, "lookup_incomplete");
      assert.equal(e.exitCode, EXIT.UNKNOWN);
      return true;
    },
  );
  assert.equal(ran, false);
});

test("dry-run 在 bot 存在时运行命令但不发送", async () => {
  let sent = 0;
  const protocol: Protocol = {
    async listBots() {
      return { bots: [{ agentId: bot, id: "1", name: "agentwatch", title: "" }], truncated: false };
    },
    async sendMessage() {
      sent += 1;
      return { messageId: "m", dispatched: true, delivery: 1 };
    },
  };
  const { result, processExit } = await runWatch(runArgs({ dryRun: true }), {
    protocol,
    hostname: "testhost",
    async runChild() {
      return {
        status: "completed",
        exitCode: 0,
        signal: null,
        durationMs: 12,
        stdoutTail: "poc",
        stderrTail: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
  });
  assert.equal(sent, 0);
  assert.equal(result.dry_run, true);
  assert.equal(result.notified, false);
  assert.equal(result.status, "completed");
  assert.equal(processExit, EXIT.OK);
  assert.equal(result.hostname, "testhost");
});
