# t178 review-fix results — current

2026-11-20, Asia/Shanghai. Fixed base: `cb8fa40330dfdbddbfb028901e46d90a957ef729`.
Scope is only the five reviewed findings; original implementation/experiment
measurements are retained below as historical evidence, not current test counts.

| Finding | Resolution and evidence in `evidence/review-fixes/` |
|---|---|
| Admission/drain commit window | `admission-red.log`: original code launches 1 old task after restart (expected 0), exit 1. `admission-green.log`: 0 late launches. Drain closes admission synchronously, settles admitted commits/current worker, cancels all remaining queued + outbox before returning. Verifier-pending/pre-admission requests leave no row. |
| Unsafe log read/write/ID and directory race | `log-security-red.log` catches original symlink reads/writes; `log-security-green.log` passes. UUID identity validation, descriptor-pinned Linux directory, final no-follow open, same-inode fstat/read/append. IPC suite covers both streams, nonregular files and tampered traversal ID. `directory-pin-mutant-red.log` returns OUTSIDE_SENTINEL after deliberately removing directory-relative opening; restored code passes. All sentinels are synthetic task-owned files. |
| Auth negative tests did not prove no insert | Read-only ledger queries assert no rows for rejected request IDs (unconfigured, forged fake adapter, forbidden bot, rejected program/flag). `auth-order-mutant-red.log`: moving verify after insert makes both relevant tests fail with row count 1 despite correct auth error/zero fixture receipts. Original verify order restored; green log passes. Pre-launch verifier retained during mutation, so no real Agent can execute. |
| Allocation before try leaked read FD | `allocation-red.log` catches one leaked descriptor on injected Buffer.alloc failure; green allocates bounded memory before open. Test restores allocator and closes only its own leaked descriptor on the red run. |
| Duplicate error code list | service reuses domain.exitCodes with Object.hasOwn; protocol tests cover every own code plus constructor/toString/__proto__/unknown. This is a refactor: baseline and changed behavior both green, not a fabricated original red failure. |

## Full final verification

Reproduce unchanged: `bun install --frozen-lockfile && bun run verify` in this package.
`bun run verify` and original experiment `bun run verify` both exit **0**.

| Actual suite | Pass/fail | Assertions | Time |
|---|---|---|---|
| Formal source | 27 / 0 | 165 | 8.69s |
| Formal compiled | 9 / 0 | 86 | 3.75s |
| Original experiment source | 11 / 0 | 193 | 23.09s |
| Original experiment compiled | 11 / 0 | 194 | 9.20s |

Formal and experiment typechecks pass. Production bundle: 400 modules, 36ms;
compile: 314ms. Separate test host: 350 modules, 56ms bundle / 336ms compile.
Production bytes: **109,942,960**; test host: **109,631,664**. Exact tools/pins/hashes
are in `evidence/review-fixes/environment.txt`; dependencies/lock unchanged.
Compiled tests retain empty PATH, isolated HOME/cwd, moved source/migration
resources and same-executable launch. Controller still uses installed Bun; this
is Linux x86_64 + procfs evidence, not a clean VM or another platform claim.

Logs: `evidence/review-fixes/{verify,spike-regression}.log`. Initial failed full
verification `verify-hung-test.log` is retained: a new test evaluated Bun's rejects
matcher before releasing its gate, blocking the test. After 61.562s the exact
owned runner was killed (exit 137), its recorded temporary state cleaned, and the
test reordered to observe a settled outcome after barrier release. This was not
a product pass. The corrected focused test and full suites above pass.

Production run remains AUTH_NOT_CONFIGURED, with no fake flag/env bypass. No
real Agent/model/notification/identity integration or user machine was touched.
No new dependency or generic PoC; no push/PR/merge/release/history rewrite.
Independent review is **pending parent**: this executor has no independent
sub-agent launch tool; self-review is recorded separately, not called independent.
Original remaining production gates below are unchanged. Final owned-process
and temporary-source restoration audit is recorded in `evidence/review-fixes/cleanup-audit.json`.

---

# Baseline implementation measurements (cb8fa40)

2026-11-20, Asia/Shanghai. Base: `879ae27f4f319de6c79d0bb32f6640a1292f75a7`.
This is bounded modular implementation, **not production-ready** and not another
platform PoC. Source/reference mapping: `../../docs/task-core-opencode-map.md`.
Root legacy src/auth/RPC/package/lock and the old experiment were not modified.

## Reproduce

```sh
cd packages/agentwatch && bun install --frozen-lockfile && bun run verify
```

The production binary is `dist/agentwatch`; its `run` is intentionally gated with
`AUTH_NOT_CONFIGURED` / exit 4. Fixture authorization/process execution exists
only in the separately compiled test host, never a production fake flag.

## Commands and measurements

All final commands below exited **0**. Logs are checked in (initial CLI help
output has trailing spaces stripped only); binaries/node_modules
are not. Final verification wall time reported by the command runner: **12.458s**.

| Command | Actual result |
|---|---|
| `bun run typecheck` | TypeScript compiler 6.0.3, no errors |
| `bun test test/core.test.ts test/cli.test.ts` | 19 pass, 0 fail, 115 assertions, 6.86s |
| `bun run build` | 399 modules; bundle 35ms, compile 292ms |
| `bun run build:test-host` | 349 modules; bundle 31ms, compile 351ms |
| `bun test test/compiled.test.ts` | 8 pass, 0 fail, 70 assertions, 3.22s |
| Existing experiment `bun run verify` | Typecheck/build pass; source 11/0, 193 assertions, 22.74s; compiled 11/0, 194 assertions, 9.62s |

Runtime: Bun **1.4.4**, Linux x86_64 / kernel 6.12.113+. Locked packages:
Effect/platform-bun/sql-sqlite-bun 4.1.0; Drizzle 1.0.0-rc.5-169397b.
Full direct versions/overrides and artifact SHA-256: `evidence/environment.txt`.
Production executable: **109,942,960 bytes**; separate test host: **109,627,568 bytes**.

The compiled suite copies only the two executables into a private independent
space/Unicode directory, uses empty PATH and isolated HOME, and temporarily moves
`src/` (including SQL migration resources) away, restoring it after tests. The
executables self-launch their internal entries; fixture children use the same test
executable. The test controller itself still uses Bun and already-loaded helper
modules. Bun/Node remain installed on the host: **not a clean VM/container proof**,
not a no-shared-library claim, and not macOS/Windows/other-architecture evidence.

## Contract matrix

| Contract | Result / exact seam |
|---|---|
| Effect CLI/Schema/Layer/Scope and SQLite/Drizzle real path | PASS: CLI parsing, validated requests, scoped client, same-client ORM, embedded checksum/version migration |
| Five commands; JSON without TTY; stderr-only bounded errors | PASS source + compiled; native flags, empty argv, spaces/Unicode, help-on-error suppression; wizard rejected |
| Defaults/limits and separate stdout/stderr | PASS: 4096-byte default / 65536 max, offsets, byte-preserving base64; raw log retention is NOT implemented |
| Request ID uniqueness/fingerprint conflicts | PASS: exact concurrent requests produce one real fixture receipt; changed argv conflicts |
| Lost submit response simulation | Existing spike PASS; formal slice uses same-ID retry/concurrency coverage, no separate lost-response injection |
| Queued/starting cancellation cannot launch afterward | PASS core: deterministic beforeClaim/beforeLaunch barriers, cancellation acknowledged before release, zero executor launches |
| Running cancel / wait timeout | PASS source + compiled: timeout leaves child running; cancelled terminal only after observed child close |
| Revalidate authorization before actual launch | PASS injected verifier revocation, no child launched |
| Crash → unknown; no replay; drain excludes historical unknown | PASS core + source/compiled actual daemon SIGKILL and fixture receipt checks |
| Terminal + outbox atomic; stable event ID | PASS: migration/ORM path and injected outbox INSERT failure rollback; status visibly pending/not_configured |
| Private discovery / singleton / auth / state isolation | PASS source + compiled: loopback capability, instance/scope, private registration, duplicate ownership and concurrent self-start |
| Graceful shutdown | PASS source + compiled: explicit exit/fixture-close assertions before cleanup; `FORMAL_SHUTDOWN_EXIT_OBSERVED_BEFORE_CLEANUP` |
| Production authorization bypass rejected | PASS source + compiled: real production run returns AUTH_NOT_CONFIGURED; fake CLI flag and forged RPC data do not enable it |
| Spawn ENOENT / incompatible future migration | PASS core: failed without PID; future migration fails closed |
| Actual vendor Agents / bot identity adapter | NOT IMPLEMENTED / NOT TESTED; production run stays closed |
| Real notification transport, retry, remote ACK/dedupe | NOT IMPLEMENTED / NOT TESTED; user suspension retained, outbox is not delivery proof |
| Process-tree cancellation, Windows .cmd/ACL, platform distribution | NOT IMPLEMENTED / NOT TESTED; no additional generic native-platform PoC |

One worker executes at a time in this slice. No throughput, upgrade/replacement,
watchdog/contender-pool, hostile-same-user, output redaction/retention, or production
availability claim is made. SQLite lifetime ownership is explicitly an adaptation
from the reference, not a claim of identical OpenCode flock behavior.

## Evidence and failures retained honestly

- `evidence/verify.log`: final complete formal verification.
- `evidence/spike-regression.log`: unchanged experiment regression. Forced cleanup
  in intentional hard-crash cases is not graceful-stop proof; strict stop cases
  separately assert successful exit before fallback.
- `evidence/{storage,engine,ipc}-red.log`: initial missing-module tracer bullets
  (expected nonzero), not semantic mutation tests.
- `evidence/cli-initial-failure.log`: 6 real CLI integration failures before fixing
  Effect optional booleans, implicit error help on stdout, and wrapped error codes.
- `evidence/install.log`, `evidence/environment.txt`: local dependencies and tools.

No real Agent/model/notification or user machine was used; no app credentials read.
Final audit found no remaining owned daemon/fixture processes. Intentional crash
orphans were cleaned by verified task-owned PID only. No push/PR/release performed.

## Smallest next step

Parent independently reviews this local slice. Then agree the supported production
identity-to-bot verifier seam and its deny-path tests before opening production run.
Do not reopen real notification delivery or add broad platform experiments here.
