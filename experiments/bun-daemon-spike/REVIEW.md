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
