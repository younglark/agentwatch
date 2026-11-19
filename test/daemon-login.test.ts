import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHomeDir, pendingLoginPath, serviceLogPath } from "../src/auth/home.js";
import { IndependentSession } from "../src/auth/independent/session.js";
import { generateLoginChallenge } from "../src/auth/independent/login.js";
import { refreshDecision } from "../src/auth/independent/refresh.js";
import { ServiceClient, endpointFromState } from "../src/service/client.js";
import { runDaemon } from "../src/service/daemon.js";
import type { IndependentCredentials } from "../src/auth/independent/store.js";

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentwatch-daemon-"));
  ensureHomeDir(dir);
  chmodSync(dir, 0o700);
  return dir;
}

test("守护进程：begin 只返回 URL，轮询在进程内完成，verifier 不出现在响应或日志", async () => {
  const home = tmpHome();
  let hits = 0;
  let seenVerifier: string | undefined;
  const { server, base } = await listen((req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    assert.equal(u.pathname, "/auth/poll");
    seenVerifier = u.searchParams.get("verifier") ?? undefined;
    hits += 1;
    if (hits === 1) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ accessToken: "atok-login", refreshToken: "rtok-login" }));
  });
  const session = new IndependentSession({
    home,
    apiBase: base,
    website: "https://cursor.com",
    poll: { sleep: async () => {}, maxTries: 8 },
  });
  const daemon = await runDaemon({
    home,
    session,
    version: "0.2.0",
    bind: { hostname: "127.0.0.1", port: 0 },
  });
  try {
    const client = new ServiceClient(endpointFromState(daemon.state));
    const info = await client.info();
    assert.equal(info.version, "0.2.0");
    assert.equal(info.pid, process.pid);
    assert.equal(JSON.stringify(info).includes(daemon.state.password), false);

    const began = await client.beginLogin();
    assert.match(began.login_url, /^https:\/\/cursor\.com\/loginDeepControl\?/);
    const u = new URL(began.login_url);
    assert.equal(u.searchParams.get("redirectTarget"), "cli");
    assert.equal(u.searchParams.has("supportsSelectedTeamLogin"), false);
    assert.equal(Object.hasOwn(began, "verifier"), false);
    const again = await client.beginLogin();
    assert.equal(again.reused, true);
    assert.equal(again.login_url, began.login_url);
    assert.equal(again.uuid, began.uuid);

    const waited = await client.waitLogin();
    assert.equal(waited.status, "completed");
    assert.equal(JSON.stringify(waited).includes("atok-login"), false);

    const tok = await client.getToken();
    assert.equal(tok.token, "atok-login");
    assert.equal(tok.variant, "independent");

    const credFile = join(home, "credentials.json");
    assert.equal(existsSync(credFile), true);
    assert.equal(statSync(credFile).mode & 0o777, 0o600);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, "service.json")).mode & 0o777, 0o600);
    assert.equal(existsSync(pendingLoginPath(home)), false);

    const log = existsSync(serviceLogPath(home)) ? readFileSync(serviceLogPath(home), "utf8") : "";
    const publicDump = JSON.stringify({ began, again, waited, info, url: daemon.state.url });
    assert.ok(seenVerifier && seenVerifier.length > 10);
    assert.equal(publicDump.includes(seenVerifier), false);
    assert.equal(began.login_url.includes(seenVerifier), false);
    assert.equal(log.includes(seenVerifier), false);
    assert.equal(log.includes(daemon.state.password), false);
    assert.equal(log.includes("atok-login"), false);
    assert.equal(publicDump.includes(daemon.state.password), false);
    assert.ok(hits >= 2);
  } finally {
    await daemon.close();
    await close(server);
  }
});

test("refreshDecision：未过期且无 client_id 时继续用；过期且无 client_id 才需要配置", () => {
  const now = 1_000_000;
  const valid: IndependentCredentials = {
    access_token: "a",
    refresh_token: "r",
    expires_at_ms: now + 60_000,
    backend: "https://api2.cursor.sh",
    updated_at_ms: now,
  };
  assert.equal(refreshDecision(valid, { nowMs: now, clientId: "" }), "ok");
  assert.equal(refreshDecision({ ...valid, expires_at_ms: now + 200_000 }, { nowMs: now, clientId: "cid" }), "refresh");
  assert.equal(refreshDecision({ ...valid, expires_at_ms: now - 1 }, { nowMs: now, clientId: "" }), "need_client_id");
  assert.equal(refreshDecision({ ...valid, expires_at_ms: now - 1 }, { nowMs: now, clientId: "cid" }), "refresh");
  void generateLoginChallenge;
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
