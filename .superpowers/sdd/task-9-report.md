# Task 9 Implementer Report

Status: DONE

Base: `2c1a529b1581f7e50b76ef150e2e3f4cf0b491a0`
Required commit subject: `feat: enforce root lifecycle ownership`

## TDD evidence

The root lifecycle processor and query service were introduced behind failing contract and processor tests, then implemented until the focused suites and repository regressions passed. Additional red/green regressions covered:

- deterministic resume filter order and keyset paging beyond an incompatible first page;
- ambiguity before target/proof verification, with bounded redacted summaries;
- stale-generation versus invalid-proof error precedence;
- transactional rollback at append boundaries;
- active, suspended, and ending recovery state preservation;
- lease-owner mirror disagreement on both resume and recovery;
- byte-for-byte preservation of an existing child authority row during root recovery;
- strict checkpoint fingerprint verification and scalar error transport through worker/executor sanitizers.

## Implementation

- Added atomic root start with generation-one authority, private handle/resume material, continuity collision protection, a 120-second owner lease, and one lifecycle event.
- Added exact and latest-safe root resume. Selection uses the frozen filter order, deterministic `session_id` keyset pages, branch/checkpoint/source-state compatibility, bounded ambiguity output, proof-before-generation handling, exact-expiry transfer, generation fencing, and all-or-nothing event persistence.
- Added root heartbeat renewal with bounded proof verification, clamped monotonic lease time, generation fencing, and no lifecycle event.
- Added protected status, tree, and association reads with exact proof targets and a 200-child bound.
- Added root suspension with a source-state checkpoint, child summaries, state/commitment rotation, lease renewal, and rollback-safe persistence.
- Added maintenance recovery with quick-integrity preflight, signed approval validation, checkpoint/fold guards, state preservation for active/suspended/ending roots, authority rotation, ordered lease release/CAS/new lease/event/approval consumption, and child isolation.
- Hardened lifecycle command-store facades and fresh capability-generation resolution without weakening replay behavior.
- Added strict ambiguity serialization/decoding with frozen non-enumerable details and 16-candidate/16-KiB limits.
- Extended authority repository queries for ending continuity owners, keyset resume paging, and cryptographically verified latest checkpoints.

## Frozen behavioral decisions

- `RootResumeCommandV2.continuityKey` is nullable; exact selection requires a session ID or continuity key, while latest-safe may omit both.
- A fresh same-owner resume is rejected with `SESSION_ALREADY_OWNED`; only exact command replay is deterministic reissue.
- Structurally valid proof verification occurs before generation staleness mapping: an invalid proof at the current generation remains invalid, while a generation race maps to `SESSION_HANDLE_STALE`.
- Latest-safe ambiguity is decided before candidate targeting and proof verification; candidates are never tie-broken.
- Resume/recovery require the current lease owner client to match the root authority handle client before transfer.

## Verification

```text
npm run test:build
  PASS

node --test --test-concurrency=1 --test-reporter=spec \
  dist-test/tests/lifecycle-command-processor.test.js \
  dist-test/tests/lifecycle-command-store.test.js \
  dist-test/tests/session-authority.repository.test.js \
  dist-test/tests/session-lease.repository.test.js \
  dist-test/tests/lifecycle-approval.test.js \
  dist-test/tests/event-integrity.test.js
  PASS — 166 tests, 166 pass, 0 fail

npm run typecheck
  PASS

npm test
  PASS — 1203 tests, 1193 pass, 0 fail, 10 skipped

git diff --check
  PASS
```

## Follow-on boundary

- The processor is intentionally comprehensive and now large; future child-lifecycle work should not broaden Task 9 while adding its own focused modules/tests.
- The child-preservation recovery regression uses an opaque, schema-valid sentinel row. Task 10 should replace that boundary-only sentinel with real child-processor integration coverage when child creation is implemented.
- No Task 10 implementation was started.
