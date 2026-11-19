import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSecretsCandidates, parseSandSecrets, loadSandSecrets } from "../src/auth/secrets.js";
import { loadAccessToken } from "../src/auth/token.js";
import { decryptSafeStorage } from "../src/auth/decrypt.js";
import { AgentwatchError } from "../src/errors.js";
import { EXIT } from "../src/exit.js";
import { authMode } from "../src/auth/platform.js";

test("cursor-accounts 可以是 JSON 字符串，并选用 active 账号", () => {
  const raw = JSON.stringify({
    version: 1,
    "cursor-machine-id": "m",
    "local-exec-file-key": "k",
    "cursor-accounts": JSON.stringify({
      active: "acct-b",
      accounts: {
        "acct-a": { "cursor-access-token": "aaa" },
        "acct-b": {
          "cursor-access-token": "djEwAAAA",
          "cursor-refresh-token": "djEwBBBB",
          "cursor-account-profile": "djEwCCCC",
        },
      },
    }),
  });
  const parsed = parseSandSecrets(raw, "/tmp/sand-secrets.json", "Grok Bot");
  assert.equal(parsed.activeId, "acct-b");
  assert.equal(parsed.account.accessTokenCipher, "djEwAAAA");
  assert.equal(parsed.account.refreshTokenCipher, "djEwBBBB");
});

test("cursor-accounts 也可以是嵌套对象", () => {
  const raw = JSON.stringify({
    version: 1,
    "cursor-accounts": {
      active: "x",
      accounts: { x: { "cursor-access-token": "tok" } },
    },
  });
  const parsed = parseSandSecrets(raw, "/tmp/x.json", "override");
  assert.equal(parsed.account.accessTokenCipher, "tok");
});

test("默认 Linux 路径优先稳定版 Grok Bot", () => {
  const c = listSecretsCandidates({ platform: "linux", home: "/home/me", env: {} });
  assert.equal(c[0]?.path, "/home/me/.config/Grok Bot/sand-secrets.json");
  assert.equal(c[1]?.path, "/home/me/.config/Grok Bot Research/sand-secrets.json");
});

test("macOS 与 Windows 路径", () => {
  const mac = listSecretsCandidates({ platform: "darwin", home: "/Users/me", env: {} });
  assert.equal(mac[0]?.path, "/Users/me/Library/Application Support/Grok Bot/sand-secrets.json");
  const win = listSecretsCandidates({
    platform: "win32",
    home: "C:\\Users\\me",
    env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
  });
  assert.equal(win[0]?.path, "C:\\Users\\me\\AppData\\Roaming\\Grok Bot\\sand-secrets.json");
});

test("缺少文件时是 auth 退出码", () => {
  assert.throws(
    () => loadSandSecrets({ path: "/tmp/agentwatch-no-such-sand-secrets.json" }),
    (e: unknown) => {
      assert(e instanceof AgentwatchError);
      assert.equal(e.code, "auth");
      assert.equal(e.exitCode, EXIT.AUTH);
      assert.equal(e.message.includes("token") && /eyJ/.test(e.message), false);
      return true;
    },
  );
});

test("无账号记录是 auth 错误", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentwatch-"));
  const file = join(dir, "sand-secrets.json");
  writeFileSync(file, JSON.stringify({ version: 1, "cursor-accounts": JSON.stringify({ active: "", accounts: {} }) }));
  assert.throws(
    () => loadSandSecrets({ path: file }),
    (e: unknown) => {
      assert(e instanceof AgentwatchError);
      assert.equal(e.code, "auth");
      return true;
    },
  );
});

test("AGENTWATCH_SECRETS_FILE 覆盖默认路径", () => {
  const c = listSecretsCandidates({
    platform: "linux",
    home: "/home/me",
    env: { AGENTWATCH_SECRETS_FILE: "/custom/sand-secrets.json" },
  });
  assert.deepEqual(c.map((x) => x.path), ["/custom/sand-secrets.json"]);
});

test("loadSandSecrets 能从临时目录读到稳定版文件", () => {
  const home = mkdtempSync(join(tmpdir(), "agentwatch-home-"));
  const dir = join(home, ".config", "Grok Bot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sand-secrets.json"),
    JSON.stringify({
      version: 1,
      "cursor-accounts": { active: "a", accounts: { a: { "cursor-access-token": "djEwZZ" } } },
    }),
  );
  const loaded = loadSandSecrets({ platform: "linux", home, env: {} });
  assert.equal(loaded.variant, "Grok Bot");
  assert.equal(loaded.account.accessTokenCipher, "djEwZZ");
});

test("平台路由：darwin 为独立鉴权，linux/win32 为桌面共享鉴权", () => {
  assert.equal(authMode("darwin"), "independent");
  assert.equal(authMode("linux"), "desktop");
  assert.equal(authMode("win32"), "desktop");
});

test("macOS 不会走共享桌面凭据或钥匙串", () => {
  assert.throws(
    () => loadSandSecrets({ platform: "darwin", home: "/Users/me", env: {} }),
    (e: unknown) => {
      assert(e instanceof AgentwatchError);
      assert.equal(e.code, "auth");
      assert.equal(e.exitCode, EXIT.AUTH);
      assert.match(e.message, /独立鉴权|不会读取官方/);
      return true;
    },
  );
  assert.throws(
    () => loadAccessToken({ platform: "darwin", home: "/Users/me", env: {} }),
    (e: unknown) => {
      assert(e instanceof AgentwatchError);
      assert.equal(e.code, "auth");
      return true;
    },
  );
  assert.throws(
    () => decryptSafeStorage("djEwAAAA", { platform: "darwin" }),
    (e: unknown) => {
      assert(e instanceof AgentwatchError);
      assert.equal(e.code, "auth");
      assert.doesNotMatch(e.message, /钥匙串读取|Safe Storage 密钥/);
      return true;
    },
  );
});
