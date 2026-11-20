# agentwatch task core — first implementation slice

This is modular implementation code, not another generic PoC. It is **not yet a
production runner**. The production entry always uses an unconfigured bot verifier:
`run` returns `AUTH_NOT_CONFIGURED` (exit 4), without inserting/starting a new task.
There is no fake-verifier CLI flag or environment switch. No old app credentials,
internal RPC, model, SDK, ACP, webhook or Stop Hook is imported.

The original root src/ and experiments/bun-daemon-spike remain historical code.
This package is built independently; it does not replace the legacy root bin yet.

## Build and verify (Bun 1.4.4)

```sh
cd packages/agentwatch
bun install --frozen-lockfile && bun run verify
```

Production artifact: dist/agentwatch, same executable for CLI/internal-serve.
The separately built dist/test-host is only a test fixture and excluded from the
package files list. test/host.ts injects a fixed fixture executor and test verifier;
production main.ts never imports it. No actual four-vendor CLI is run by tests.

## Minimal command contract

```
agentwatch run --bot BOT --request-id ID [--cwd DIR] [--state DIR] [--json] -- claude ...
agentwatch status TASK_ID [--state DIR] [--json]
agentwatch logs TASK_ID [--stream stdout|stderr] [--offset BYTES] [--limit BYTES] [--state DIR] [--json]
agentwatch wait TASK_ID [--timeout SECONDS] [--state DIR] [--json]
agentwatch cancel TASK_ID [--state DIR] [--json]
```

- `--` splits bot-native argv from our flags; no joining, shell parsing or resume /
  permission semantics. Program basename allowlist: claude, opencode, codex, grok.
  This allowlist is not a sandbox. Absolute paths with these basenames are allowed.
- request-id is required in this slice. Its scope is the state directory; it never
  expires here. Fingerprint covers canonical cwd, bot and every argv element.
  Same ID/request returns the original task; a changed request conflicts.
- Operational stdout is one `{version:1,command,data}` JSON line, including without
  a TTY; --json is accepted explicitly. Errors are one `{version:1,error:{code,
  message}}` JSON line on stderr, with no raw args, stack, IPC token or app secrets.
  Explicit --help / --version remain human help output. Interactive --wizard and
  unrelated built-in flags are disabled, rather than waiting for bot input.
- Status/returned tasks show notification state and `transport:not_configured`;
  a terminal outbox row is only pending, not a delivery receipt. Wait success only
  describes process termination, never vendor business/permission success.
- logs defaults to 4096 bytes, max 65536, using byte offset/next_offset. data_base64
  preserves bytes across UTF-8 boundaries; text is a preview and may split a code
  point. Raw private files are not retained/truncated by a disk-quota policy yet.
- wait defaults to 30 seconds, max 300; timeout exits 9 without killing anything;
  unknown exits 10 immediately. Observed child failure exits 1. Running cancel
  becomes cancelled only after observed close; pre-start cancel cannot spawn.
- Other codes: 2 usage; 3 not found; 4 auth unavailable; 5 bot forbidden; 6 request
  conflict; 7 IPC auth; 8 local transport unavailable; 11 draining; 12 version /
  migration incompatibility. Unknown transport interruptions are not called success.

## Service and storage boundaries

Default state: ~/.local/state/agentwatch-core (not legacy auth home). Tests always
use isolated directories. POSIX state must be owned and 0700; database, registration
and generated per-instance IPC capability are 0600. Local HTTP binds 127.0.0.1 only,
requires capability + instance + canonical-state scope, and validates protocol /
version on health. The registration is atomically replaced; shutdown removes only
its own instance. A separate SQLite lifetime exclusive transaction elects one
owner; it does not lock the task database. Crash releases ownership without stale
PID killing. See the explicit adaptation in ../../docs/task-core-opencode-map.md.

Effect Layer/Scope owns the SQLite client; Drizzle uses that same Effect client.
Embedded migration has a checksum/version gate. Task terminal state and stable
outbox event commit together. Lost starting/running/cancelling tasks become unknown,
never replayed. Queued records remain safe to dispatch after a restart, with a new
pre-spawn verifier check. Drain stops admission and waits only current preparing /
worker activity; historical unknown is listed but does not block it or outbox I/O.

Only internal authenticated protocol supports health/drain/shutdown; these are not
new user-facing business commands. Automatic version replacement, ownership-file
watchdog and a full contender retry pool are not in this slice.

## Explicit remaining gates

Real identity-to-bot verifier, notification transport/ACK/retries, four-vendor E2E,
production process-tree cancellation (.cmd / Windows included), redaction policy
for potentially sensitive native output, disk retention, upgrades/distribution,
and full multi-user/Windows ACL hardening remain unfinished. No production
ready/supported-platform claim follows from Linux-only tests or OpenCode's usage.
