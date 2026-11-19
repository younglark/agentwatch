#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { AgentwatchError, isAgentwatchError } from "./errors.js";
import { EXIT } from "./exit.js";
import { HELP, VERSION } from "./help.js";
import { redact } from "./redact.js";
import { formatHumanResult, runWatch } from "./run.js";

async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    return fail(e, /*json*/ flagPresent(argv, "--json"));
  }

  if (args.kind === "help") {
    process.stderr.write(HELP);
    return EXIT.OK;
  }
  if (args.kind === "version") {
    process.stderr.write(`agentwatch ${VERSION}\n`);
    return EXIT.OK;
  }

  try {
    const { result, processExit } = await runWatch(args);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stderr.write(`${formatHumanResult(result)}\n`);
    }
    return processExit;
  } catch (e) {
    return fail(e, args.json);
  }
}

function flagPresent(argv: string[], flag: string): boolean {
  const end = argv.indexOf("--", 2);
  const slice = end === -1 ? argv.slice(2) : argv.slice(2, end);
  return slice.includes(flag);
}

function fail(err: unknown, json: boolean): number {
  const e = isAgentwatchError(err)
    ? err
    : new AgentwatchError("failure", err instanceof Error ? err.message : String(err));
  const message = redact(e.message);
  const hint = e.hint ? redact(e.hint) : undefined;
  if (json) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { code: e.code, message, hint, retryable: e.retryable } })}\n`,
    );
  } else {
    process.stderr.write(`error: ${message}\n`);
    if (hint) process.stderr.write(`hint: ${hint}\n`);
  }
  if (process.env.AGENTWATCH_DEBUG === "1" && err instanceof Error && err.stack) {
    process.stderr.write(`${redact(err.stack)}\n`);
  }
  return e.exitCode;
}

const runningAsCli = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return /(?:^|[\\/])cli\.(?:ts|js)$/.test(entry) || entry.endsWith("agentwatch");
})();

if (runningAsCli) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`error: ${redact(err instanceof Error ? err.message : String(err))}\n`);
      process.exit(EXIT.FAILURE);
    });
}

export { main };
