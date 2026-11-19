import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { test } from "node:test";
import { buildLoginUrl, generateLoginChallenge } from "../src/auth/independent/login.js";
import { pollForLogin, pollUrl, POLICY_VIOLATION } from "../src/auth/independent/poll.js";
import { printLoginUrl } from "../src/service/access.js";
import { main } from "../src/cli.js";
import { EXIT } from "../src/exit.js";
import { authMode } from "../src/auth/platform.js";

function collect(): { stream: Writable; text: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

test("登录 URL 为 cli 预设，不含设备码或 supportsSelectedTeamLogin", () => {
  const c = generateLoginChallenge();
  assert.equal(c.verifier.length > 20, true);
  assert.equal(createHash("sha256").update(c.verifier).digest().toString("base64url"), c.challenge);
  const url = buildLoginUrl("https://cursor.com", c);
  const u = new URL(url);
  assert.equal(u.origin, "https://cursor.com");
  assert.equal(u.pathname, "/loginDeepControl");
  assert.equal(u.searchParams.get("challenge"), c.challenge);
  assert.equal(u.searchParams.get("uuid"), c.uuid);
  assert.equal(u.searchParams.get("mode"), "login");
  assert.equal(u.searchParams.get("redirectTarget"), "cli");
  assert.equal(u.searchParams.has("supportsSelectedTeamLogin"), false);
  assert.equal(url.includes(c.verifier), false);
});

test("轮询：404 等待后成功；verifier 只出现在请求 URL，不进入 printLoginUrl", async () => {
  const c = generateLoginChallenge();
  let hits = 0;
  const { server, base } = await listen((req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    assert.equal(u.pathname, "/auth/poll");
    assert.equal(u.searchParams.get("uuid"), c.uuid);
    assert.equal(u.searchParams.get("verifier"), c.verifier);
    hits += 1;
    if (hits === 1) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ accessToken: "access-from-poll", refreshToken: "refresh-from-poll" }));
  });
  try {
    const out = collect();
    const url = buildLoginUrl("https://cursor.com", c);
    printLoginUrl(url, { json: false, stderr: out.stream });
    printLoginUrl(url, { json: true, stderr: out.stream });
    const printed = out.text();
    assert.match(printed, /loginDeepControl/);
    assert.match(printed, /login_url/);
    assert.equal(printed.includes(c.verifier), false);
    assert.equal(printed.includes("access-from-poll"), false);

    const outcome = await pollForLogin({
      apiBase: base,
      uuid: c.uuid,
      verifier: c.verifier,
      maxTries: 5,
      sleep: async () => {},
    });
    assert.equal(outcome.status, "success");
    if (outcome.status === "success") {
      assert.equal(outcome.tokens.accessToken, "access-from-poll");
    }
    assert.equal(hits, 2);
    assert.equal(pollUrl(base, c.uuid, c.verifier).includes("/auth/poll?"), true);
  } finally {
    await close(server);
  }
});

test("轮询：403 sign_in_policy_violation 为硬失败", async () => {
  const c = generateLoginChallenge();
  const { server, base } = await listen((_req, res) => {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: POLICY_VIOLATION }));
  });
  try {
    const outcome = await pollForLogin({
      apiBase: base,
      uuid: c.uuid,
      verifier: c.verifier,
      maxTries: 3,
      sleep: async () => {},
    });
    assert.equal(outcome.status, "policy");
  } finally {
    await close(server);
  }
});

test("轮询：连续三次非 404 失败则停止", async () => {
  const c = generateLoginChallenge();
  let hits = 0;
  const { server, base } = await listen((_req, res) => {
    hits += 1;
    res.statusCode = 500;
    res.end("nope");
  });
  try {
    const outcome = await pollForLogin({
      apiBase: base,
      uuid: c.uuid,
      verifier: c.verifier,
      maxTries: 10,
      maxConsecutiveErrors: 3,
      sleep: async () => {},
    });
    assert.equal(outcome.status, "failed");
    assert.equal(hits, 3);
  } finally {
    await close(server);
  }
});

test("在 Linux / Windows 上 login 子命令被拒绝", async () => {
  if (authMode(process.platform) === "independent") return;
  const stderr = collect();
  const stdout = collect();
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    stderr.stream.write(Buffer.from(String(chunk)));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    stdout.stream.write(Buffer.from(String(chunk)));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await main(["node", "agentwatch", "login"]);
    assert.equal(code, EXIT.AUTH);
    const text = stderr.text() + stdout.text();
    assert.match(text, /共享鉴权|官方 Grok Bot|不支持独立登录/);
    assert.doesNotMatch(text, /verifier=/);
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }
});

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no addr"));
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
