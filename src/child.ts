import { spawn } from "node:child_process";
import { tailBytes } from "./notify.js";

export type ChildResult = {
  status: "completed" | "failed" | "timeout";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type RunChildOptions = {
  command: string[];
  timeoutSeconds: number;
  tailBytes: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 子进程的实时输出会写到这里（默认 process.stderr），避免污染 CLI stdout。 */
  relay?: NodeJS.WritableStream | null;
};

/**
 * 非交互运行命令：不分配 TTY，stdin 关闭，捕获输出。
 * timeoutSeconds > 0 时到期先 SIGTERM，短暂等待后再 SIGKILL。
 */
export async function runChild(opts: RunChildOptions): Promise<ChildResult> {
  const [file, ...args] = opts.command;
  if (!file) throw new Error("command is empty");

  const started = Date.now();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_progress: "false",
  };
  if (!env.NO_COLOR && !process.stderr.isTTY) env.NO_COLOR = "1";

  const child = spawn(file, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    cwd: opts.cwd,
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  const cap = new OutputCap(opts.tailBytes);
  const relay = opts.relay === undefined ? process.stderr : opts.relay;
  child.stdout?.on("data", (chunk: Buffer) => {
    cap.pushStdout(chunk);
    relay?.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    cap.pushStderr(chunk);
    relay?.write(chunk);
  });

  let timedOut = false;
  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const clearTimers = () => {
    if (termTimer) clearTimeout(termTimer);
    if (killTimer) clearTimeout(killTimer);
  };

  if (opts.timeoutSeconds > 0) {
    termTimer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGTERM");
      killTimer = setTimeout(() => killChild(child, "SIGKILL"), 2000);
    }, opts.timeoutSeconds * 1000);
    termTimer.unref?.();
  }

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  ).finally(clearTimers);

  const durationMs = Date.now() - started;
  const out = cap.finish();
  if (timedOut) {
    return {
      status: "timeout",
      exitCode: result.code,
      signal: result.signal,
      durationMs,
      ...out,
    };
  }
  const exitCode = result.code ?? (result.signal ? 1 : 0);
  return {
    status: exitCode === 0 ? "completed" : "failed",
    exitCode: result.code,
    signal: result.signal,
    durationMs,
    ...out,
  };
}

function killChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid == null) return;
  try {
    if (process.platform === "win32") {
      child.kill(signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

class OutputCap {
  private stdout: Buffer[] = [];
  private stderr: Buffer[] = [];
  private stdoutSize = 0;
  private stderrSize = 0;
  constructor(private readonly max: number) {}

  pushStdout(chunk: Buffer) {
    this.stdoutSize += chunk.length;
    this.stdout.push(chunk);
    this.trim(this.stdout);
  }
  pushStderr(chunk: Buffer) {
    this.stderrSize += chunk.length;
    this.stderr.push(chunk);
    this.trim(this.stderr);
  }
  private trim(chunks: Buffer[]) {
    // 只保留末尾 max 字节，避免把整段输出留在内存里。
    let total = chunks.reduce((n, b) => n + b.length, 0);
    while (chunks.length > 1 && total - chunks[0]!.length >= this.max) {
      total -= chunks.shift()!.length;
    }
  }
  finish() {
    const stdoutBuf = Buffer.concat(this.stdout);
    const stderrBuf = Buffer.concat(this.stderr);
    const out = tailBytes(stdoutBuf, this.max);
    const err = tailBytes(stderrBuf, this.max);
    return {
      stdoutTail: out.text,
      stderrTail: err.text,
      stdoutTruncated: out.truncated || this.stdoutSize > this.max,
      stderrTruncated: err.truncated || this.stderrSize > this.max,
    };
  }
}
