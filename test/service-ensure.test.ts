import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHomeDir } from "../src/auth/home.js";
import { writeServiceConfig } from "../src/service/config.js";
import { decide, discover, ensure, restart, stop } from "../src/service/ensure.js";
import { writeServiceState } from "../src/service/state.js";
import { probeRegistered } from "../src/service/probe.js";
import type { ProbeService, ServiceState } from "../src/service/types.js";
import { AgentwatchError } from "../src/errors.js";
import { EXIT } from "../src/exit.js";

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentwatch-svc-"));
  ensureHomeDir(dir);
  chmodSync(dir, 0o700);
  return dir;
}

function state(over: Partial<ServiceState> & Pick<ServiceState, "url" | "pid" | "password">): ServiceState {
  return {
    id: over.id ?? randomUUID(),
    version: over.version ?? "0.2.0",
    pid: over.pid,
    url: over.url,
    hostname: over.hostname ?? "127.0.0.1",
    port: over.port ?? Number(new URL(over.url).port),
    started_at: over.started_at ?? new Date().toISOString(),
    started_at_ms: over.started_at_ms ?? Date.now(),
    password: over.password,
  };
}

async function fakeService(opts: {
  version?: string;
  password?: string;
  hang?: boolean;
  pid?: number;
  incompatible?: boolean;
  rejectAuth?: boolean;
}): Promise<{ server: Server; registration: ServiceState; close: () => Promise<void> }> {
  const password = opts.password ?? randomBytes(12).toString("base64url");
  const version = opts.version ?? "0.2.0";
  const pid = opts.pid ?? process.pid;
  const server = createServer((req, res) => {
    if (opts.hang) return;
    if (opts.rejectAuth) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "nope" }));
      return;
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${password}`) {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (opts.incompatible) {
      res.statusCode = 404;
      res.end("missing");
      return;
    }
    if (req.url?.startsWith("/api/info")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, version, pid, id: "fake", started_at: "t" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const registration = state({
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    pid,
    password,
    version,
  });
  return {
    server,
    registration,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const shortTiming = {
  pollInterval: 20,
  requestTimeout: 200,
  spawnDelay: 20,
  promiseTimeout: 800,
  stopPollInterval: 10,
  stopPollAttempts: 3,
};

test("ensure 复用健康的同版本在任实例，不启动第二份", async () => {
  const home = tmpHome();
  const fake = await fakeService({ version: "0.2.0" });
  try {
    writeServiceState(home, fake.registration);
    let spawned = 0;
    const got = await ensure({
      home,
      version: "0.2.0",
      timing: shortTiming,
      command: ["false"],
      onStart: () => {
        spawned += 1;
      },
    });
    assert.equal(got.pid, fake.registration.pid);
    assert.equal(got.url, fake.registration.url);
    assert.equal(spawned, 0);
    const found = await discover({ home, version: "0.2.0", timing: shortTiming });
    assert.equal(found?.pid, fake.registration.pid);
  } finally {
    await fake.close();
  }
});

test("版本不匹配时 decide 为 replace", () => {
  const svc: ProbeService = {
    state: state({ url: "http://127.0.0.1:9", pid: 1, password: "x", version: "0.1.0" }),
    version: "0.1.0",
    health: "ready",
    compatible: true,
    rejected: false,
  };
  const d = decide(svc, { version: "0.2.0", bind: { hostname: "127.0.0.1", port: 0 } });
  assert.equal(d._tag, "replace");
  if (d._tag === "replace") assert.equal(d.reason, "version-mismatch");
});

test("死 pid 的陈旧登记会被视为可替换，不会把活进程当死", async () => {
  const home = tmpHome();
  writeServiceState(
    home,
    state({
      url: "http://127.0.0.1:1",
      pid: 999_999_991,
      password: "dead",
      version: "0.2.0",
    }),
  );
  const probed = await probeRegistered(home, 100);
  assert.equal(probed.pidAlive, false);
  const result = await stop({ home, timing: shortTiming });
  assert.equal(result.stopped, true);
  assert.equal(result.reason, "stale-registration");
});

test("活着的 pid 是锁/登记的所有者：stop 以登记为准，健康超时不能当成没有服务", async () => {
  const home = tmpHome();
  // 挂起的健康检查 + 当前测试进程的 pid（我们注入 signals，避免真的给自己发 SIGTERM）
  const fake = await fakeService({ hang: true, pid: process.pid });
  writeServiceState(home, fake.registration);
  try {
    const kills: string[] = [];
    const result = await stop({
      home,
      timing: { ...shortTiming, stopPollAttempts: 2, stopPollInterval: 10 },
      signals: {
        kill(pid, signal) {
          assert.equal(pid, process.pid);
          kills.push(signal);
        },
        alive: () => true,
      },
    });
    assert.equal(result.stopped, false);
    assert.ok(result.reason === "timeout" || result.reason === "error");
    assert.ok(kills.includes("SIGTERM"));
  } finally {
    await fake.close();
  }
});

test("显式 restart 在未能确认停止时不会进入 ensure", async () => {
  const home = tmpHome();
  writeServiceState(home, state({ url: "http://127.0.0.1:1", pid: 4242, password: "x" }));
  let spawned = false;
  await assert.rejects(
    () =>
      restart({
        home,
        version: "0.2.0",
        timing: { ...shortTiming, stopPollAttempts: 1, stopPollInterval: 5, promiseTimeout: 200 },
        command: ["sh", "-c", "echo should-not-spawn"],
        signals: {
          kill() {},
          alive: () => true,
        },
        onStart: () => {
          spawned = true;
        },
      }),
    (e: unknown) => {
      assert(e instanceof AgentwatchError);
      assert.match(e.message, /未确认停止|无法停止/);
      return true;
    },
  );
  assert.equal(spawned, false);
});

test("端口被非 agentwatch 进程占用时失败，不抢占", async () => {
  const home = tmpHome();
  const squatter = createServer((_req, res) => {
    res.end("hello");
  });
  await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", () => resolve()));
  const addr = squatter.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  writeServiceConfig(home, { hostname: "127.0.0.1", port: addr.port });
  try {
    await assert.rejects(
      () =>
        ensure({
          home,
          version: "0.2.0",
          timing: shortTiming,
          command: ["false"],
          env: { AGENTWATCH_HOME: home, AGENTWATCH_SERVICE_PORT: String(addr.port) },
        }),
      (e: unknown) => {
        assert(e instanceof AgentwatchError);
        assert.equal(e.exitCode, EXIT.FAILURE);
        assert.match(e.message, /已被其他进程占用|不是 agentwatch/);
        return true;
      },
    );
    // squatter still accepts connections
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect({ host: "127.0.0.1", port: addr.port }, () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    assert.equal(ok, true);
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test("不兼容的健康协议不会被当成旧版本自动替换", () => {
  const svc: ProbeService = {
    state: state({ url: "http://127.0.0.1:9", pid: 1, password: "x", version: "0.2.0" }),
    version: "0.2.0",
    health: "ready",
    compatible: false,
    rejected: false,
  };
  const d = decide(svc, { version: "0.2.0", bind: { hostname: "127.0.0.1", port: 0 } });
  assert.equal(d._tag, "fail");
});

test("service.json 为 0600，status 序列化不含 password", async () => {
  const home = tmpHome();
  const fake = await fakeService({});
  try {
    writeServiceState(home, fake.registration);
    const { statSync, readFileSync } = await import("node:fs");
    const mode = statSync(join(home, "service.json")).mode & 0o777;
    assert.equal(mode, 0o600);
    const raw = readFileSync(join(home, "service.json"), "utf8");
    assert.match(raw, /password/);
    const { publicStatus } = await import("../src/service/types.js");
    const pub = JSON.stringify(publicStatus(fake.registration, { healthy: true }));
    assert.equal(pub.includes(fake.registration.password), false);
    assert.doesNotMatch(pub, /password/);
  } finally {
    await fake.close();
  }
});
