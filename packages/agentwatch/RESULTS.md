# Task-core first slice — measured results

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
