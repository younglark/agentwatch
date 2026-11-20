# Throwaway Bun daemon evidence (not product implementation)

Isolated experiment; does not import or change the old auth/RPC PoC. No credentials,
models, external agents or notification network are used. Internal fake inputs do
not define a product arbitrary-command API.

Approved test seams: CLI/daemon JSON requests, task/log outputs, and child-owned
spawn receipts; filesystem isolation and process exit are observed externally.
The matrix in RESULTS.md distinguishes evidence from assumptions.

Reproduce from this directory on Linux x64 with Bun 1.4.4:

```sh
bun install --frozen-lockfile && bun run verify
```

The CLI takes an action and a JSON payload, e.g.
`bun src/main.ts health --state /tmp/your-private-spike-dir`.
The test suite owns temporary private directories and cleans up exact daemon and
fake PIDs. The compiled suite copies only the executable into a separate directory,
runs with an empty PATH, and temporarily renames source/migration directories.
This is **PATH/source isolation**, not an OS/container without installed runtimes.

## Deliberately minimal contract

`aw-spike <action> '<JSON>' --state <0700-owned-directory>` is a testing interface.
All successful responses are one JSON line; errors exit 1 on stderr. `wait` returns
`wait_timed_out: true` rather than killing a task (and keeps exit code 0). Terminal
states are succeeded/failed/cancelled/unknown; waiting on unknown returns promptly.

- `run`: required request_id, fake mode success/failure/long/flood, optional bounded
  durationMs/queueMs/startMs. No arbitrary command, shell, SDK, ACP or model input.
- `status`, `logs`, `wait`, `cancel`: take task id; wait accepts timeoutMs.
- `health`, `stop`: lazy service probe and stop (stop never starts a new daemon).
- `serve`, `fake`, `drop-run`, `evidence`, `retry-outbox` are internal test hooks.
  drop-run commits a task and disconnects before replying; retry-outbox performs
  only local fake bookkeeping, never an HTTP request.

SQLite is opened by scoped @effect/sql-sqlite-bun; actual task CRUD runs through
`drizzle-orm/effect-sqlite-bun` on that client. The fixed SQL migration is imported
as text and applied transactionally; no runtime filesystem migration directory or
Drizzle Kit invocation is needed. This is not a reusable migration framework.

Linux-specific abstract Unix socket bind is the atomic election primitive. Losing
contenders exit; kernel socket release permits restart after SIGKILL. Contenders
may briefly start multiple **candidate processes**; only one binds and becomes the
daemon. Scope finalizers stop the worker/owned fake and close server/SQLite on the
explicit stop path. SIGKILL cannot run finalizers: an old fake may remain alive,
which is exactly why restart records unknown, never a false confirmed exit.

## Review regression checks

`strict stop` is a dedicated acceptance test: no cleanup rescue may establish its
success. The general harness still rescues exact owned PIDs on failures and after
intentional crashes; it prints `SAFETY_CLEANUP_NOT_STOP_SUCCESS` when it does so.

`test-barrier` is another internal-only hook. Tests arm claim/launch barriers,
observe arrival, acknowledge cancellation, release, then await completion of the
whole worker attempt. Parent `launches.jsonl` receipts are synchronous process-
creation evidence, complementary to child-owned `spawns.jsonl`; no timing sleep is
used to prove “did not launch”.

To rerun the bounded red/green sensitivity checks **alone** from this directory:

```sh
bun scripts/check-review-mutants.ts && bun run verify
```

The mutation runner temporarily edits only this experiment's main/engine source,
runs each targeted assertion expecting failure, validates the intended failure,
and restores source in finally. Do not run it concurrently with verify or other
work in this checkout. Expected red failures are not successful product tests;
the subsequent restored full suite supplies the green evidence.
