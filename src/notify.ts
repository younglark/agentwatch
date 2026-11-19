import { hostname } from "node:os";
import { redact } from "./redact.js";

export type RunStatus = "completed" | "failed" | "timeout";

export type NotifyInput = {
  status: RunStatus;
  command: string[];
  exitCode: number | null;
  durationMs: number;
  hostname?: string;
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  dryRun?: boolean;
};

export function formatCommand(command: string[]): string {
  return command.map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  if (arg === "") return `""`;
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(arg)) return arg;
  return `"${arg.replace(/["\\]/g, "\\$&")}"`;
}

export function renderNotification(input: NotifyInput): string {
  const host = input.hostname ?? hostname();
  const statusLabel =
    input.status === "completed" ? "完成" : input.status === "timeout" ? "超时" : "失败";
  const exit =
    input.exitCode === null ? "无（超时，未拿到退出码）" : String(input.exitCode);
  const seconds = (input.durationMs / 1000).toFixed(2);
  const lines = [
    `agentwatch 状态：${statusLabel}`,
    `命令：${redact(formatCommand(input.command))}`,
    `退出码：${exit}`,
    `耗时：${seconds}s`,
    `主机：${host}`,
  ];
  if (input.dryRun) lines.push("模式：dry-run（未发送）");
  lines.push(formatStream("stdout", input.stdoutTail, input.stdoutTruncated));
  lines.push(formatStream("stderr", input.stderrTail, input.stderrTruncated));
  return lines.join("\n");
}

function formatStream(name: string, tail: string, truncated: boolean): string {
  const body = redact(tail);
  if (!body) return `${name}：（空）`;
  const tag = truncated ? `${name}（尾部，已截断）` : name;
  return `${tag}：\n${body}`;
}

/** 保留末尾最多 maxBytes 字节，按 UTF-8 码点边界切开。 */
export function tailBytes(buf: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes < 1) return { text: "", truncated: buf.length > 0 };
  if (buf.length <= maxBytes) return { text: buf.toString("utf8"), truncated: false };
  let slice = buf.subarray(buf.length - maxBytes);
  // 丢掉开头可能残缺的 UTF-8 序列。
  let i = 0;
  while (i < slice.length && (slice[i]! & 0xc0) === 0x80) i++;
  slice = slice.subarray(i);
  return { text: slice.toString("utf8"), truncated: true };
}
