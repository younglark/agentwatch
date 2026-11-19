import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { AgentwatchError } from "../errors.js";

/**
 * 基于 pid 文件的互斥。活着的 pid 视为锁的所有者，绝不因为“看起来过期”
 * 就删掉锁文件。仅当记录的 pid 已不存在时才接管。
 * 这不是 flock；进程异常退出后，下一任在确认 pid 已死后接管。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM: 进程存在但无权发信号，仍视为活着的所有者。
    if (code === "EPERM") return true;
    return false;
  }
}

export type HeldPidLock = {
  pid: number;
  file: string;
  release: () => void;
};

export function tryAcquirePidLock(file: string): { ok: true; lock: HeldPidLock } | { ok: false; pid?: number; alive: boolean } {
  const self = process.pid;
  if (existsSync(file)) {
    const current = readLockPid(file);
    if (current !== undefined) {
      if (current === self) {
        return { ok: true, lock: hold(file, self) };
      }
      if (isPidAlive(current)) {
        return { ok: false, pid: current, alive: true };
      }
      // pid 已死：只有文件内容仍是这个死 pid 时才覆盖，不盲删后重建。
      const again = readLockPid(file);
      if (again !== undefined && again !== current) {
        return { ok: false, pid: again, alive: isPidAlive(again) };
      }
      if (again !== undefined && isPidAlive(again)) {
        return { ok: false, pid: again, alive: true };
      }
    }
  }
  try {
    writeFileSync(file, `${self}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
  } catch {
    const pid = readLockPid(file);
    return { ok: false, pid, alive: pid !== undefined && isPidAlive(pid) };
  }
  const written = readLockPid(file);
  if (written !== self) {
    return { ok: false, pid: written, alive: written !== undefined && isPidAlive(written) };
  }
  return { ok: true, lock: hold(file, self) };
}

export async function withPidLock<T>(file: string, fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T> {
  const waitMs = opts?.waitMs ?? 30_000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const got = tryAcquirePidLock(file);
    if (got.ok) {
      try {
        return await fn();
      } finally {
        got.lock.release();
      }
    }
    if (Date.now() >= deadline) {
      throw new AgentwatchError("retryable", "等待凭据锁超时；未改写锁文件，现有所有者保持不变。", {
        retryable: true,
        hint: got.alive && got.pid !== undefined ? `锁由仍在运行的进程 pid=${got.pid} 持有。` : undefined,
      });
    }
    await delay(25);
  }
}

function hold(file: string, pid: number): HeldPidLock {
  let released = false;
  return {
    pid,
    file,
    release: () => {
      if (released) return;
      released = true;
      const current = readLockPid(file);
      if (current !== pid) return;
      try {
        unlinkSync(file);
      } catch {
        /* 只有我们仍是记录中的 pid 才删除；失败则留给死 pid 检测 */
      }
    },
  };
}

function readLockPid(file: string): number | undefined {
  try {
    const raw = readFileSync(file, "utf8").trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    return pid;
  } catch {
    return undefined;
  }
}

/** 打开（或创建）一个不会在持有期间被我们截断的 0600 文件。供需要固定路径的调用方使用。 */
export function ensureLockFile(file: string): void {
  try {
    const fd = openSync(file, "a", 0o600);
    closeSync(fd);
  } catch {
    /* */
  }
}
