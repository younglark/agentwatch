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
