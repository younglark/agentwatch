# Self-review (not independent review)

Fixed point: `ec342ba9612d8a2cd1912f529d1d0d8c873fc85f`.
Spec: SPEC.md plus the delegated three-question brief. No AGENTS.md,
CONTRIBUTING.md, CODING_STANDARDS.md, GLOSSARY.md or ADRs were present in this
checkout. Existing root files are intentionally unchanged. No independent
reviewer/sub-agent tool was available in this executor; these two axes were
checked locally and must not be reported as independent approval.

## Standards

- Isolated package, pinned lock, no new root dependencies. No credentials/auth/RPC
  imports. Tests reuse one externally observable contract suite for source/binary.
- Judgement calls: terse engine/request dispatcher and `any` JSON response types
  suit a throwaway spike, not a recommended production domain model. Do not copy
  the internal actions or minimal schema migration runner into a product API.

## Spec

Corrected before final verification:
- Compiled detection must not rely on `Bun.embeddedFiles`: text imports can be
  inlined. Explicit build-time `SPIKE_COMPILED` switches self-launch argv instead.
- Recovering a `cancelling` task must produce `unknown`, not claim confirmed
  cancellation after daemon death. Recovery explicitly overrides cancellation.
- Health now reads the actual migration version rather than returning a literal.
- Canonicalize the state path so filesystem aliases do not elect two daemons for
  one database; reject non-private / foreign-owned directories.
- Client/daemon IPC timeouts exceed the bounded 10-second wait contract.
- Cleanup waits for observed exit, verifies state-specific argv before killing an
  exact leftover fake PID, and never kills unrelated services.

- Audited the lockfile: platform-bun allowed node-shared 4.1.4 with an incompatible
  Effect peer. Pin node-shared to 4.1.0 through an override. Also align inherited
  Node types to the reference 24.12.2. The TS 6 alias delegates to locked 6.0.3;
  use the explicit local wrapper and report its actual version.
- Compiled CLI and descendants now run with cwd in the standalone binary directory,
  not the source checkout; PATH is empty and HOME is temporary.

- The pinned Drizzle package actually includes `effect-sqlite-bun`; switched from
  an initial query-builder-only bridge to that native adapter, keeping task CRUD
  inside the same Effect SQL transaction context. Re-ran the full matrix.
- Explicit stop now also prevents a delayed starting worker from launching a new
  fake after shutdown has begun.

Known limitations are tracked in RESULTS.md, not hidden as passing behavior.

## Follow-up: two externally reported Spec findings

Follow-up fixed point: `52cdfef07da6a92a129095431a5b2e28ccb8e72d`.
The parent reported independent Standards review with no findings and Spec review
with two acceptance-evidence findings. That is context, not independent approval
of this follow-up. Scope stays limited to those two findings.

1. **Accepted:** previous cleanup could SIGKILL an unresponsive daemon/child and
   still return successfully. The original RESULTS stop PASS was unsupported by
   that helper. Add strictStop, which asserts stop response and observed exit of
   all owned daemon/fake PIDs before any cleanup call. The dedicated test checks
   zero fallback PIDs and directory deletion; failures are logged and rethrown
   before finally performs safety rescue. Cleanup now reports forced PIDs and is
   explicitly separate from acceptance (hard-crash tests may need rescue).
2. **Accepted:** fixed start delays and “spawn <= 1” did not prove that an
   acknowledged pre-start cancellation forbids a later launch. Add bounded claim
   and launch barriers outside the SQLite transactions, with reached/released /
   whole-attempt-completed acknowledgements. After cancel returns cancelled/no PID,
   release, await completion, and assert zero parent process-creation receipts and
   zero child receipts. Keep the previous sampled launch/cancel test only as
   supplementary coverage, not as the proof of this stronger contract.

No defect in the existing stop/cancel state logic was exposed by the stronger
assertions; the changes are evidence/harness improvements and internal test
instrumentation. The four temporary mutations test sensitivity; none are kept in
application source. Mutation runner validates the intended assertion failure, not
merely a nonzero process exit, and restores each original file in finally.

Local follow-up review checks: barriers hold no SQL transaction lock, shutdown
releases test barriers to permit safe cleanup, parent launch receipts are written
synchronously after actual Bun.spawn (covering a child killed before its own
receipt), and mutations touch only the isolated experiment. No root dependencies,
auth/RPC, real agents/notifications, publishing or history changes.
