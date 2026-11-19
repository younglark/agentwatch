import { hostname } from "node:os";
import { runChild, type ChildResult } from "./child.js";
import { AgentwatchError, isAgentwatchError } from "./errors.js";
import { EXIT } from "./exit.js";
import { renderNotification, type RunStatus } from "./notify.js";
import { createProtocol, DELIVERY_REFUSED, findBot, type Protocol, type SendResult, type TokenHolder } from "./protocol.js";
import type { CliArgs } from "./args.js";
import { authMode } from "./auth/platform.js";
import { resolveAgentwatchHome } from "./auth/home.js";
import { daemonTokenHolder } from "./service/access.js";

export type RunDeps = {
  protocol?: Protocol;
  runChild?: typeof runChild;
  hostname?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  tokenHolder?: TokenHolder;
  home?: string;
};

export type RunResult = {
  ok: boolean;
  status: RunStatus | "not_run";
  exit_code: number | null;
  duration_ms: number;
  hostname: string;
  command: string[];
  bot: string;
  notified: boolean;
  dry_run: boolean;
  message_id?: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  delivery?: number;
};

export async function runWatch(
  args: Extract<CliArgs, { kind: "run" }>,
  deps: RunDeps = {},
): Promise<{ result: RunResult; processExit: number }> {
  const host = deps.hostname ?? hostname();
  const platform = deps.platform ?? process.platform;
  const protocol =
    deps.protocol ??
    createProtocol({
      baseUrl: args.apiBase,
      tokenOpts: { secretsFile: args.secretsFile, platform },
      access:
        deps.tokenHolder ??
        (authMode(platform) === "independent"
          ? daemonTokenHolder({
              home: deps.home ?? resolveAgentwatchHome({ platform }),
              json: args.json,
            })
          : undefined),
    });
  const spawn = deps.runChild ?? runChild;

  const list = await protocol.listBots();
  const found = findBot(list, args.bot);
  if ("error" in found) throw found.error;

  const child = await spawn({
    command: args.command,
    timeoutSeconds: args.timeoutSeconds,
    tailBytes: args.tailBytes,
  });

  const status: RunStatus = child.status;
  const text = renderNotification({
    status,
    command: args.command,
    exitCode: child.exitCode,
    durationMs: child.durationMs,
    hostname: host,
    stdoutTail: child.stdoutTail,
    stderrTail: child.stderrTail,
    stdoutTruncated: child.stdoutTruncated,
    stderrTruncated: child.stderrTruncated,
    dryRun: args.dryRun,
  });

  let notified = false;
  let messageId: string | undefined;
  let delivery: number | undefined;

  if (args.dryRun) {
    notified = false;
  } else {
    const sent = await sendOnce(protocol, args.bot, text);
    notified = true;
    messageId = sent.messageId;
    delivery = sent.delivery;
    if (sent.delivery === DELIVERY_REFUSED) {
      const reason = sent.refusal?.message || sent.refusal?.failureCode;
      throw new AgentwatchError(
        "refused",
        `服务器拒绝了通知（delivery=refused${reason ? `：${reason}` : ""}）。`,
        {
          hint: "消息未被接受。查看 refusal 后再决定是否重发，不要盲目重试。",
        },
      );
    }
  }

  const result: RunResult = {
    ok: status === "completed" && (args.dryRun || notified),
    status,
    exit_code: child.exitCode,
    duration_ms: child.durationMs,
    hostname: host,
    command: args.command,
    bot: args.bot,
    notified,
    dry_run: args.dryRun,
    message_id: messageId,
    stdout_truncated: child.stdoutTruncated,
    stderr_truncated: child.stderrTruncated,
    delivery,
  };

  return { result, processExit: exitForChild(child) };
}

async function sendOnce(protocol: Protocol, agentId: string, text: string): Promise<SendResult> {
  try {
    return await protocol.sendMessage({ agentId, text });
  } catch (e) {
    if (isAgentwatchError(e)) throw e;
    throw new AgentwatchError("notify_failed", e instanceof Error ? e.message : String(e));
  }
}

function exitForChild(child: ChildResult): number {
  if (child.status === "timeout") return EXIT.TIMEOUT;
  if (child.status === "failed") return EXIT.CHILD;
  return EXIT.OK;
}

export function formatHumanResult(result: RunResult): string {
  const status =
    result.status === "completed" ? "完成" : result.status === "timeout" ? "超时" : result.status === "failed" ? "失败" : "未运行";
  const notify = result.dry_run ? "dry-run（未发送）" : result.notified ? "已发送" : "未发送";
  return `agentwatch：${status}；通知：${notify}；退出码：${result.exit_code ?? "无"}；耗时：${(result.duration_ms / 1000).toFixed(2)}s`;
}
