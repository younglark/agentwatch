import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { credentialsLockPath, credentialsPath, ensureHomeDir, pendingLoginPath } from "../home.js";
import { withPidLock } from "../lock.js";
import { decodeJwtExpMs } from "../decrypt.js";
import type { LoginChallenge } from "./login.js";

export type IndependentCredentials = {
  access_token: string;
  refresh_token: string;
  expires_at_ms?: number;
  backend: string;
  updated_at_ms: number;
};

export type PendingLogin = LoginChallenge & {
  login_url: string;
  api_base: string;
  website: string;
  started_at_ms: number;
};

export function readCredentials(home: string): IndependentCredentials | undefined {
  const file = credentialsPath(home);
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<IndependentCredentials>;
    if (typeof data.access_token !== "string" || data.access_token.length === 0) return undefined;
    return {
      access_token: data.access_token,
      refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : "",
      expires_at_ms: typeof data.expires_at_ms === "number" ? data.expires_at_ms : decodeJwtExpMs(data.access_token),
      backend: typeof data.backend === "string" && data.backend ? data.backend : "",
      updated_at_ms: typeof data.updated_at_ms === "number" ? data.updated_at_ms : 0,
    };
  } catch {
    return undefined;
  }
}

export async function writeCredentials(home: string, creds: IndependentCredentials): Promise<void> {
  ensureHomeDir(home);
  await withPidLock(credentialsLockPath(home), async () => {
    atomicWrite(credentialsPath(home), JSON.stringify(creds, null, 2) + "\n");
  });
}

export async function clearCredentials(home: string): Promise<void> {
  await withPidLock(credentialsLockPath(home), async () => {
    const file = credentialsPath(home);
    if (existsSync(file)) {
      try {
        unlinkSync(file);
      } catch {
        /* */
      }
    }
  });
}

export function readPendingLogin(home: string): PendingLogin | undefined {
  const file = pendingLoginPath(home);
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<PendingLogin>;
    if (
      typeof data.verifier !== "string" ||
      typeof data.challenge !== "string" ||
      typeof data.uuid !== "string" ||
      typeof data.login_url !== "string"
    ) {
      return undefined;
    }
    return {
      verifier: data.verifier,
      challenge: data.challenge,
      uuid: data.uuid,
      login_url: data.login_url,
      api_base: typeof data.api_base === "string" ? data.api_base : "",
      website: typeof data.website === "string" ? data.website : "",
      started_at_ms: typeof data.started_at_ms === "number" ? data.started_at_ms : 0,
    };
  } catch {
    return undefined;
  }
}

export async function writePendingLogin(home: string, pending: PendingLogin): Promise<void> {
  ensureHomeDir(home);
  await withPidLock(credentialsLockPath(home), async () => {
    atomicWrite(pendingLoginPath(home), JSON.stringify(pending, null, 2) + "\n");
  });
}

export async function clearPendingLogin(home: string): Promise<void> {
  await withPidLock(credentialsLockPath(home), async () => {
    const file = pendingLoginPath(home);
    if (existsSync(file)) {
      try {
        unlinkSync(file);
      } catch {
        /* */
      }
    }
  });
}

export function credsFromTokens(accessToken: string, refreshToken: string, backend: string, nowMs = Date.now()): IndependentCredentials {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at_ms: decodeJwtExpMs(accessToken),
    backend,
    updated_at_ms: nowMs,
  };
}

function atomicWrite(file: string, body: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* */
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* */
  }
}
