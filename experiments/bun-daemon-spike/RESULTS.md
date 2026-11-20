# Technical spike results — throwaway evidence

Recorded 2026-11-20 (Asia/Shanghai). This is an isolated experiment, not delivery
of the agentwatch product or validation of its notification/auth protocols.

## Environment and dependency provenance

- Linux x86_64; Debian 13.7 (trixie), kernel 6.12.113+, glibc 2.41.
- Existing Bun **1.4.4** (`38afee6c8`), no runtime installation required.
- effect, @effect/platform-bun, @effect/sql-sqlite-bun: **4.1.0**.
- @effect/platform-node-shared is overridden to **4.1.0**: unconstrained transitive
  resolution initially selected 4.1.4, whose Effect peer requires ^4.1.4. Corrected.
- drizzle-orm **1.0.0-rc.5-169397b**. Uses the shipped **native Effect Bun adapter**,
  not manifest-only usage, a separate Bun SQLite connection, or a handwritten
  proxy driver. This is not a claim to copy OpenCode's custom local bridge.
- @types/bun **1.4.4**, inherited @types/node pinned **24.12.2**.
- TypeScript package uses the reference alias `npm:@typescript/typescript6@6.0.2`;
  its wrapper delegates to locked `@typescript/old` / `typescript@6.0.3` and reports
  **Version 6.0.3**. Typecheck calls the explicit local wrapper via Bun.
- Exact integrity hashes and all transitive versions are in bun.lock. Reference
  research was read from `/workspace/agentwatch-research/opencode-v2-dependencies.md`
  and `opencode-v2-runtime-verification.md` (the brief's shorter filename did not
  exist). No OpenCode build was performed.

## Reproducible command and observed outcomes

From experiments/bun-daemon-spike:

```sh
bun install --frozen-lockfile && bun run verify
```

`verify` runs explicit local typecheck, source contract tests, compile, and the same
contract suite against a copied standalone binary. See evidence/verify.log for
actual counts/times. Compile uses `--define SPIKE_COMPILED=true`: source mode must
launch `bun main.ts`, while binary mode must launch only its own executable.
Text migration imports can be inlined, so embeddedFiles.length is not a reliable
compiled-mode detector.

Final run: frozen install **exit 0**, typecheck **exit 0**, source **9 passed / 0
failed** (152 assertions, **20.26 s**), compile **exit 0** (395 modules; bundle
43 ms, compile 330 ms), standalone binary **9 passed / 0 failed** (153 assertions,
**9.30 s**); full verify **exit 0**. Assertion totals can vary with polling.
Artifact `dist/spike`: **109,918,384 bytes** (about **104.83 MiB**, uncompressed).
See evidence/environment.txt for SHA256. The binary is intentionally gitignored;
no release or publication occurred. This size is useful feasibility evidence for
the Bun single-executable decision; no memory/startup benchmark was conducted.
Evidence logs have trailing line whitespace normalized only.

## Executed acceptance matrix

Each row ran in both source and compiled mode. PASS means the bounded assertions
passed on this host, not an exhaustive concurrency/cross-platform proof.

| Case | Source | Compiled | Evidence / bound |
|---|---|---|---|
| Effect CLI + Schema + scoped SQLite; Drizzle actual task CRUD | PASS | PASS | CLI parse/invalid mode, actual SQL rows and lifecycle |
| Embedded migration with source moved out of its path | n/a | PASS | Fresh private DB reads schema version 1; no source/migration dir |
| Eight concurrent CLI starts elect one daemon | PASS | PASS | Same responding PID; exactly one winner receipt |
| Child continues after submitting CLI has exited | PASS | PASS | Fake PID alive; status running |
| Concurrent identical IDs and response loss | PASS | PASS | Five retries get same ID; one child-owned spawn receipt |
| Same ID / changed normalized request | PASS | PASS | Conflict exits nonzero; no new task |
| Fake failure and separate stdout/stderr flood | PASS | PASS | Exit 7; each stream exactly 2,097,152 bytes |
| Wait timeout is not execution timeout | PASS | PASS | Wait timed out; task/child still running |
| Cancel queued and starting | PASS | PASS | Both cancelled, zero child receipts after start delay expires |
| Launch/cancel boundary | PASS | PASS | Four bounded samples; confirmed cancelled; at most one child each |
| Running cancel waits for child exit | PASS | PASS | Terminal cancelled and observed child no longer alive |
| Hard crash during starting | PASS | PASS | Unknown, zero child receipts, same ID not replayed |
| Unknown does not block wait/new work | PASS | PASS | Immediate unknown result and next task succeeds |
| Hard crash during running | PASS | PASS | New daemon; original unknown; spawn count unchanged |
| Terminal state and outbox consistency | PASS | PASS | All observed terminal tasks have exactly one matching event |
| Fake outbox retry persistence | PASS | PASS | Post-restart attempts 1 failed, 2 delivered; no source respawn |
| Explicit stop and temporary resource cleanup | PASS | PASS | Only exact owned PIDs; exit observed before state deletion |

## What remains unproven / intentionally omitted

- **Not tested**: macOS, Windows, Windows .cmd launch, process-tree cancellation,
  other architectures, baseline CPU targets, cross compilation, signing/upgrades.
- **Not tested**: real runtime-free container/VM. No docker executable was present.
  Compiled tests use an empty PATH, temporary HOME, binary-only working directory,
  and rename the source/migration directory away. Bun/Node remain installed on
  the host; system dynamic libraries remain available. This is not a static binary
  claim, nor a claim to work on every Linux/glibc release.
- **Not tested**: real agents, model/pi calls, notifications, auth, receipts or
  remote deduplication. Outbox delivery is explicitly fake and local.
- **Not tested**: crash specifically during cancelling, kill at every instruction of a terminal transaction, storage
  corruption/disk full, spawn syscall failure injection, reboot/power loss, or
  automatic daemon upgrade/drain. Atomic terminal/outbox code uses one Effect SQL
  transaction, and bounded recovery/invariant tests pass; exhaustive fault
  injection is still a production gate.
- Linux abstract sockets deliberately avoid stale filesystem socket cleanup; this
  is **not** a portable IPC or production authentication solution. Private random
  test directories and CLI current-UID ownership checks do not authenticate raw
  IPC connections. Abstract sockets do not inherit directory ACLs: another local
  process/UID discovering the name can connect. These are short-lived, fake-only
  tests, not an approved multi-user security boundary. Do not ship IPC unchanged.
- A single worker, bounded fake inputs, fixed one-step SQL migration, and in-memory
  process handles keep the spike short. Logs are fully loaded by the debug API,
  not paged/streamed. No summary snapshots, four-vendor session readers, outbox
  backoff scheduler, upgrade service or formal product CLI were implemented.
- After SIGKILL, a child can still run. Unknown does not mean killed, and restart
  never kills or restarts an unconfirmed PID. Tests verify state-scoped argv and
  clean up their own surviving fake explicitly.
- Self-review only (REVIEW.md); no independent reviewer approval was obtained.

## Design impact and smallest next step

The selected Bun/Effect/SQLite/Drizzle combination and same-executable lazy daemon
have a working Linux feasibility path; this spike does not require changing the
approved runtime choice. Keep the current plan, use this as evidence rather than
production code. Next obtain independent review and run a small native macOS /
Windows packaging + self-launch + child-cancellation smoke test. Resolve portable
IPC/process-tree semantics before production task-management implementation.
