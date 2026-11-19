import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.js";
import { AgentwatchError } from "../src/errors.js";
import { EXIT } from "../src/exit.js";

function parse(argv: string[]) {
  return parseArgs(["node", "agentwatch", ...argv]);
}

test("缺少 --bot 是用法错误", () => {
  assert.throws(() => parse(["--", "echo", "hi"]), (e: unknown) => {
    assert(e instanceof AgentwatchError);
    assert.equal(e.code, "usage");
    assert.equal(e.exitCode, EXIT.USAGE);
    return true;
  });
});

test("缺少命令是用法错误", () => {
  assert.throws(() => parse(["--bot", "abc"]), (e: unknown) => {
    assert(e instanceof AgentwatchError);
    assert.match(e.message, /命令/);
    return true;
  });
});

test("支持 -- -- command 这种双破折号写法", () => {
  const a = parse(["--bot", "8f6d6b87-e7b6-4bf3-a45d-fbca5bc418e5", "--", "--", "echo", "poc"]);
  assert.equal(a.kind, "run");
  if (a.kind !== "run") return;
  assert.deepEqual(a.command, ["echo", "poc"]);
  assert.equal(a.bot, "8f6d6b87-e7b6-4bf3-a45d-fbca5bc418e5");
  assert.equal(a.timeoutSeconds, 0);
  assert.equal(a.dryRun, false);
});

test("解析 timeout、json、dry-run 与 --bot=", () => {
  const a = parse(["--bot=my-bot", "--timeout", "15", "--json", "--dry-run", "--", "true"]);
  assert.equal(a.kind, "run");
  if (a.kind !== "run") return;
  assert.equal(a.timeoutSeconds, 15);
  assert.equal(a.json, true);
  assert.equal(a.dryRun, true);
  assert.deepEqual(a.command, ["true"]);
});

test("非法 timeout 是用法错误", () => {
  assert.throws(() => parse(["--bot", "x", "--timeout", "-1", "--", "true"]), (e: unknown) => {
    assert(e instanceof AgentwatchError);
    assert.equal(e.code, "usage");
    return true;
  });
});

test("--help 与 --version 不要求 --bot", () => {
  assert.deepEqual(parse(["--help"]), { kind: "help" });
  assert.deepEqual(parse(["-v"]), { kind: "version" });
});
