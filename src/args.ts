import { AgentwatchError } from "./errors.js";

export type CliArgs =
  | { kind: "help" }
  | { kind: "version" }
  | {
      kind: "run";
      bot: string;
      command: string[];
      timeoutSeconds: number;
      json: boolean;
      dryRun: boolean;
      tailBytes: number;
      apiBase: string;
      secretsFile?: string;
    };

export const DEFAULT_TAIL_BYTES = 4096;
export const DEFAULT_API_BASE = "https://api2.cursor.sh";

/**
 * 解析 argv。`--` 结束 flag；若命令以额外的 `--` 开头（例如 `-- -- echo`），会去掉这一层。
 */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.length === 0) throw usage("缺少参数。需要 --bot <id> 以及 -- 之后的命令。");

  let bot: string | undefined;
  let timeoutSeconds = 0;
  let json = false;
  let dryRun = false;
  let tailBytes = DEFAULT_TAIL_BYTES;
  let apiBase = process.env.AGENTWATCH_API_BASE?.trim() || DEFAULT_API_BASE;
  let secretsFile = process.env.AGENTWATCH_SECRETS_FILE?.trim() || undefined;
  const command: string[] = [];
  let seenEnd = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (seenEnd) {
      command.push(a);
      continue;
    }
    if (a === "--") {
      seenEnd = true;
      continue;
    }
    if (a === "--help" || a === "-h") return { kind: "help" };
    if (a === "--version" || a === "-v") return { kind: "version" };
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    const kv = splitFlag(a);
    const flag = kv?.[0] ?? a;
    const inline = kv?.[1];
    if (flag === "--bot") {
      bot = needValue(flag, inline, args, i);
      if (inline === undefined) i++;
      continue;
    }
    if (flag === "--timeout") {
      const raw = needValue(flag, inline, args, i);
      if (inline === undefined) i++;
      timeoutSeconds = parseTimeout(raw);
      continue;
    }
    if (flag === "--tail-bytes") {
      const raw = needValue(flag, inline, args, i);
      if (inline === undefined) i++;
      tailBytes = parseTailBytes(raw);
      continue;
    }
    if (flag === "--api-base") {
      apiBase = needValue(flag, inline, args, i);
      if (inline === undefined) i++;
      continue;
    }
    if (flag === "--secrets-file") {
      secretsFile = needValue(flag, inline, args, i);
      if (inline === undefined) i++;
      continue;
    }
    throw usage(`未知参数：${a}。使用 --help 查看用法。`);
  }

  if (command[0] === "--") command.shift();
  if (!bot) throw usage("必须提供 --bot <agent-id>（bot 的 UUID）。");
  if (!bot.trim()) throw usage("--bot 不能为空。");
  if (command.length === 0) {
    throw usage("必须在 -- 之后提供要运行的命令。示例：agentwatch --bot <id> -- -- echo poc");
  }

  return {
    kind: "run",
    bot: bot.trim(),
    command,
    timeoutSeconds,
    json,
    dryRun,
    tailBytes,
    apiBase: apiBase.replace(/\/$/, ""),
    secretsFile,
  };
}

function splitFlag(a: string): [string, string] | undefined {
  if (!a.startsWith("--")) return undefined;
  const eq = a.indexOf("=");
  if (eq <= 2) return undefined;
  return [a.slice(0, eq), a.slice(eq + 1)];
}

function needValue(flag: string, inline: string | undefined, args: string[], i: number): string {
  if (inline !== undefined) {
    if (inline === "") throw usage(`${flag} 需要一个值。`);
    return inline;
  }
  const next = args[i + 1];
  if (next === undefined || next.startsWith("--")) throw usage(`${flag} 需要一个值。`);
  return next;
}

function parseTimeout(raw: string): number {
  if (!/^\d+$/.test(raw)) throw usage(`--timeout 必须是非负整数秒（0 表示不限时），收到：${raw}`);
  return Number(raw);
}

function parseTailBytes(raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw usage(`--tail-bytes 必须是正整数，收到：${raw}`);
  }
  return Number(raw);
}

function usage(message: string): AgentwatchError {
  return new AgentwatchError("usage", message, {
    hint: "agentwatch --bot <agent-id> [--timeout <秒>] [--json] [--dry-run] -- -- <命令...>",
  });
}
