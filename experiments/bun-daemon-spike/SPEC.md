# Scope — throwaway evidence, 2026-11-20 (Asia/Shanghai)

This is the local technical spike authorized by the user's `go` after the three
PoC questions, not the new agentwatch implementation. Base:
`ec342ba9612d8a2cd1912f529d1d0d8c873fc85f`.

1. Pin Bun 1.4.4, Effect 4.1.0 (`effect/cli`, Schema and scoped lifetimes),
   @effect/sql-sqlite-bun 4.1.0, Drizzle 1.0.0-rc.5-169397b. Compile a native
   executable with an embedded SQL migration and exercise the real database.
2. Same executable internally starts a detached daemon and fake child. Concurrent
   CLI requests elect one daemon. State is private and IPC local; test Linux only.
3. Expose minimal JSON run/status/logs/wait/cancel boundaries. Durable request ID
   plus normalized fingerprint prevents duplicate task execution; response loss
   reuses the original ID. Queued/starting cancellation cannot launch afterward;
   running cancellation only becomes terminal after observed exit. Wait timeout
   does not cancel. Recover lost supervision as terminal unknown without replay.
   Persist terminal state plus fake-notification outbox in one SQL transaction.
   Fake notification retries must not execute the originating task again.

No changes to existing auth/RPC or root package files, credentials, real agents,
models, notification calls, installation of a user service, publishing, pushing
or PR creation. CLI fake inputs are internal test cases, not arbitrary commands.
Tests observe CLI requests/responses, actual child receipts, logs and process exit.
