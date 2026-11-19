import { EXIT, type ExitCode } from "./exit.js";

export type ErrorCode =
  | "usage"
  | "auth"
  | "not_found"
  | "lookup_incomplete"
  | "timeout"
  | "child_failed"
  | "refused"
  | "notify_failed"
  | "retryable"
  | "failure";

export class AgentwatchError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCode;
  readonly hint?: string;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { exitCode?: ExitCode; hint?: string; retryable?: boolean },
  ) {
    super(message);
    this.name = "AgentwatchError";
    this.code = code;
    this.exitCode = opts?.exitCode ?? defaultExit(code);
    this.hint = opts?.hint;
    this.retryable = opts?.retryable ?? code === "retryable";
  }
}

function defaultExit(code: ErrorCode): ExitCode {
  switch (code) {
    case "usage":
      return EXIT.USAGE;
    case "auth":
      return EXIT.AUTH;
    case "not_found":
      return EXIT.NOT_FOUND;
    case "lookup_incomplete":
      return EXIT.UNKNOWN;
    case "timeout":
      return EXIT.TIMEOUT;
    case "child_failed":
      return EXIT.CHILD;
    case "refused":
    case "notify_failed":
      return EXIT.NOTIFY;
    case "retryable":
      return EXIT.RETRYABLE;
    default:
      return EXIT.FAILURE;
  }
}

export function isAgentwatchError(err: unknown): err is AgentwatchError {
  return err instanceof AgentwatchError;
}
