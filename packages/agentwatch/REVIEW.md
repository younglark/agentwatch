# t178 local self-review — independent parent review pending

Fixed base cb8fa40330dfdbddbfb028901e46d90a957ef729. Spec is the five findings
explicitly authorized by t178 go. Re-read current implementations and pinned
OpenCode 2.3.2 lifecycle source; all five findings were valid, none dismissed.
No repository-specific AGENTS/CONTRIBUTING/CODING_STANDARDS were added/found.

## Standards

Read/write guards are centralized in log-files.ts, not duplicated ad-hoc path
checks. Descriptor ownership is explicit on failure paths; buffer allocation
occurs before acquiring the read FD. Code classification uses the single domain
exitCodes object and own-property membership, never prototype-chain membership.
No speculative adapter/production feature or new dependency was added. Linux
procfs/no-follow reliance is explicit; unsupported log access fails closed.
Existing permissive RPC response types remain outside these five fixes.

## Spec

Confirmed drain tracks the commit window and removes remaining queued work before
success: deterministic restart marker proves no late process launch. A separate
pre-admission verifier gate proves DRAINING rejects without a row. Current worker
is still drained and historical unknown still does not block it. Queued tasks
surviving abrupt crashes are not claimed to have undergone a successful drain.
Logs validate ledger IDs before path construction, anchor directory descriptors,
reject symbolic/nonregular/multiply-linked inodes and use same-inode metadata /
read. A deterministic directory-swap fault proves pinning, not just final-name
O_NOFOLLOW. IPC regression covers source and compiled binaries. Auth-denial tests
query the real isolated ledger; submit-before-verify mutation fails both tests.
Production remains gated; no real native Agent/model/notification was executed.

No additional unresolved blocker identified in self-review of these five changes;
this is NOT an independent two-axis verdict. Tool discovery exposed no subagent
launcher, so parent must perform independent Standards and Spec reviews before
acceptance. Full measured counts/failure evidence are in RESULTS.md. The hung
new test and exact-owned-runner cleanup are retained honestly, not called pass.

---

# Initial implementation self-review (historical)

Fixed base: 879ae27f4f319de6c79d0bb32f6640a1292f75a7. Spec: parent t175 go,
current plan Page 21811694-d2c2-469b-bd34-9bb2ffc50219, bounded checklist in
../../docs/task-core-opencode-map.md. Reviewed new uncommitted package/docs and
root README, then reran complete formal verification. This is a self-review;
no independent reviewer was available in this executor. Parent review is required.

## Standards

No repository AGENTS/CONTRIBUTING/CODING_STANDARDS file was found. Checked module
seams, resource ownership, no shell argv construction, dependency pins, stdout /
stderr separation, and private files. Fixed potential stdout descriptor leakage
if opening stderr fails, and ensured daemon resources close even if drain fails.
The core remains intentionally small; RPC response typings are still permissive
(`any`) at the local transport boundary, an improvement candidate, not a claim of
fully typed or hostile-same-user hardened IPC. No parallel independent standards
axis was run; typecheck and diff whitespace checks are mechanical evidence only.

## Spec

Verified production adapters always deny unconfigured identity; test verifier and
fixed child are isolated in test-only host, not an argv/env bypass. Verified the
launch transaction guard, deterministic cancellation barriers, observed close,
unknown/no-replay and current-set drain, outbox atomicity, and singleton auth.
Fixed snapshot presentation so a nonterminal task snapshot cannot acquire later
terminal notification metadata. Disabled interactive wizard; missing command is a
usage error. Added compiled test source/resource removal rather than merely cwd
isolation. All final source/compiled tests passed after these changes.

Partial work is explicitly unchecked in the mapping and RESULTS: real identity /
transport, platform/process-tree/retention/upgrades. No session/PTY/SDK/ACP engine,
real notification experiment or additional platform PoC was added. Root legacy
bin remains unchanged and is labeled historical, not silently migrated.

Review does not establish production readiness, real bot permission success,
remote ACK behavior, or platform support. No history rewrite or remote write.
