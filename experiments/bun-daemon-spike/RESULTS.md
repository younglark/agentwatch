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

Review follow-up final run: mutation controller **exit 0** after **four intended
assertion failures** (each targeted Bun test exits 1), then frozen install **exit
0**, typecheck **exit 0**, restored source **11 passed / 0 failed** (194 assertions,
**23.57 s**), compile **exit 0** (395 modules; bundle 41 ms, compile 536 ms), standalone
binary **11 passed / 0 failed** (194 assertions, **10.00 s**); full verify **exit 0**.
Assertion totals can vary with polling. Mutation sensitivity was exercised in
source mode; the same restored contracts passed in compiled mode.
Artifact `dist/spike`: **109,918,384 bytes** (about **104.83 MiB**, uncompressed).
See evidence/environment.txt for SHA256. The binary is intentionally gitignored;
no release or publication occurred. No memory/startup benchmark was conducted.
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
| Cancel selected-queued / starting | PASS | PASS | Deterministic claim / launch barrier; cancel returns cancelled/no PID; release and whole-attempt completion; zero parent launches and child receipts |
| Launch/cancel sampled boundary (supplement only) | PASS | PASS | Four bounded samples; confirmed cancelled; at most one child each; NOT the pre-start cancellation proof |
| Running cancel waits for child exit | PASS | PASS | Terminal cancelled and observed child no longer alive |
| Hard crash during starting | PASS | PASS | Unknown, zero child receipts, same ID not replayed |
| Unknown does not block wait/new work | PASS | PASS | Immediate unknown result and next task succeeds |
| Hard crash during running | PASS | PASS | New daemon; original unknown; spawn count unchanged |
| Terminal state and outbox consistency | PASS | PASS | All observed terminal tasks have exactly one matching event |
| Fake outbox retry persistence | PASS | PASS | Post-restart attempts 1 failed, 2 delivered; no source respawn |
| Explicit stop without safety fallback | PASS | PASS | Dedicated active-fake test: stop response, all daemon/fake exits observed before cleanup, zero forced PIDs |
| Private directory removal after strict stop | PASS | PASS | Directory absence asserted after cleanup; no rescue needed in this dedicated test |

## Review correction and red/green proof

The stop PASS at initial commit `52cdfef` was **not justified** by its cleanup
helper: an ignored stop followed by harness SIGKILL still passed. The initial
fixed-delay and “spawn <= 1” checks likewise did not prove absence of a post-cancel
launch. The updated rows above supersede those two evidence claims, not weaken
the original contracts. No existing stop/cancel implementation defect was exposed
by the new assertions; the missing evidence is now explicit and stronger.

- `test-barrier` pauses outside SQL transactions at selected-queued/pre-claim and
  starting/pre-launch. Tests observe arrival, cancel, require cancelled/no PID,
  release and await the **entire worker attempt completed**, then require zero
  parent process-creation receipts and zero child receipts. No fixed sleep proves
  absence. Synchronous parent receipts also catch a spawned child killed before
  it can append its own receipt.
- `strictStop` cannot invoke cleanup. It requires a successful stop response and
  observed exit of the daemon plus its live fake. The existing daemon stop path
  itself SIGKILLs its fake; this is not a graceful-child-signal claim. The test then checks
  safety-cleanup forced PID list is empty and the private directory is absent.
- evidence/review-mutants.log shows ignored-stop and orphan-on-stop both fail the
  strict assertion **before** `SAFETY_CLEANUP_NOT_STOP_SUCCESS` rescues owned PIDs;
  stale-queued-claim and launch-after-cancel both fail the exact zero-launch
  assertion with expected length 0 / received 1. The runner restores source in
  finally and verifies the intended assertion, not just any nonzero exit.
- evidence/verify.log shows restored source and isolated compiled green runs,
  `STRICT_STOP_ACCEPTED_WITHOUT_FALLBACK` and both completed barrier confirmations.
  Intentional hard-crash cases still require cleanup of their orphan fake; their
  explicit safety-rescue messages are **not** counted as successful normal stop.

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
