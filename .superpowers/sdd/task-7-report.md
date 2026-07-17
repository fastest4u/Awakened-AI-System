# Task 7 Report — Persist Exact Private Retry Inputs and Route Authority Material

## Status

Complete and independently re-reviewed with no remaining Critical, Important, or Minor findings.

- Base commit: `96b329e`
- Branch: `codex/subproject-2-lifecycle-spec`
- Worktree: `C:\Users\Server\.codex\worktrees\memory-event-core`
- Required commit message: `feat: persist private lifecycle retries`

## Outcome

Task 7 now provides a host-private encrypted retry store and an authority-material adapter that can survive uncertain worker outcomes without asking callers to recreate omitted private authorization.

The implementation:

- seals the complete canonical pending command record beneath one explicit host-private root;
- derives scope and record paths from domain-separated hashes rather than caller path strings;
- uses an exclusive mode-`0600` temp, file fsync, atomic same-directory claim publication, replace, and directory fsync;
- reconciles interrupted publication and concurrent writers across separate processes;
- retains exact pending input after unknown outcome, unavailable authority material, detachment, nonlocal delivery, and route/delivery failure;
- deletes pending input only after terminal rejection, terminal stale/not-issued material, or acknowledged current delivery;
- reconstructs authority only inside the authenticated local target adapter;
- routes maintenance recovery and fork-to-child descriptors without reconstructing material at the source;
- performs recovery target-attachment preflight during both `prepare` and `resumePending`, and repeats the check during delivery;
- sends only complete, exact, nonsecret approval and child-binding-grant witnesses to workers.

## Files Changed

Production:

- `src/orchestrator/lifecycle/authority/pending-authorization.store.ts`
- `src/orchestrator/lifecycle/authority/encrypted-pending-authorization.store.ts`
- `src/orchestrator/lifecycle/authority/authority-material-adapter.ts`
- `src/orchestrator/lifecycle/authority/capability-key-provider.ts`
- `src/orchestrator/lifecycle/authority/approval-codec.ts`
- `src/orchestrator/lifecycle/contracts/commands.ts`

Tests:

- `tests/private-retry-store.test.ts`
- `tests/authority-material-adapter.test.ts`
- `tests/lifecycle-approval.test.ts`
- `tests/lifecycle-contracts.test.ts`

Report:

- `.superpowers/sdd/task-7-report.md`

## TDD Evidence

### Initial RED

The first `npm run test:build` failed only because the three Task 7 modules did not exist. The initial focused Node test run likewise failed with module-not-found errors. This established a clean feature RED before implementation.

### Store and adapter hardening RED/GREEN

Focused failures were added and observed before each hardening change for:

- strict outer and nested field exactness, including accessor-bearing inputs;
- host-private-root exclusion from project, vault, and store roots;
- crash windows before and after replace and between claim publication and temp unlink;
- refsync of an already-existing scope entry after restart;
- presenter/target route separation and zero source reconstruction;
- nested descriptor-claim tampering;
- canonical authenticated ciphertext tampering;
- POSIX mode `0600`.

### Real cross-process writer RED/GREEN

Deterministic Node child processes and explicit filesystem barriers reproduced:

- identical writers racing claim publication;
- conflicting writers racing claim publication;
- `list()` observing a live pre-claim temp;
- cleanup after the pre-claim writer process is killed.

The original failures included raw `ENOENT`, no fulfilled conflicting writer, and deletion of a live writer temp. The final implementation atomically chooses the claim winner, compares exact plaintext against the winning final, preserves live-PID temps, removes dead-PID orphans, and normalizes interrupted hard-link state.

### Approval, grant, and delivery-boundary RED/GREEN

Focused adapter/approval tests failed for the intended missing behavior before the final boundary work:

- the verified approval DTO lacked the complete safe signed witness;
- the verified child-binding-grant DTO lacked the complete safe signed witness;
- recovery prepare/resume did not preflight target attachment;
- detached/unavailable completion deleted pending state.

The final safe approval witness contains version/id/action/reason, approval and nonce digests, full project/vault/store/workspace/session/command/intent bindings, generation, executor and fixed primary target audience, issuance/expiry, and bounded redacted reference. It excludes the raw approval, nonce, MAC, key identifier, and wire.

The final safe grant witness contains version/id, project/store/parent-session binding, fixed untrusted target, issuance/expiry, binding fingerprint, and grant fingerprint. It excludes the raw grant, MAC, and wire.

Detach-after-commit is covered end to end: the first completion returns only `unavailable` plus `AUTHORITY_TARGET_DETACHED`, retains the sealed retry, reconnect resumes the exact prepared command, one delivery is acknowledged, and only then is the record deleted.

### Read/delete race RED/GREEN

Final review identified a real cross-process delete race after `get()`/`list()` discovery but before open. Two separate child processes with explicit `after-get-final-observed` and `after-list-final-observed` barriers reproduced `SESSION_CAPABILITY_INVALID` where a linearizable null/omission result was required.

The fix emits a private sentinel only for an actual `ENOENT` during the explicitly allowed final-file validation/read path, then re-observes claim/final state. Replacement type/link errors, malformed envelopes, permission errors, authentication failures, and unavailable/revoked keys remain fail-closed. The deterministic store gate is now 14/14.

## Privacy, Crash, and Routing Review

- The only retained record is the strict provider-produced envelope `{ version, keyId, algorithm, nonce, ciphertext, tag }`.
- Plaintext command records, provider-open output, and temporary comparison buffers are zeroized after use.
- Tests scan retained files and error strings for bearer, proof MAC, approval, grant, provider-key, semantic-input, command-ID, and idempotency canaries.
- Raw approval/grant wires and secret fields never enter worker DTOs.
- All reconstructed root/child material is destroyed after local delivery attempts.
- Every non-target source path has zero reconstruction/verifier calls.
- Maintenance recovery routes only to the verified attached primary; fork material routes only to the granted child.
- Route promise resolution is the host-channel delivery acknowledgment boundary. Throws and detach/nonlocal results retain retry state.

## Verification

Final prescribed gate:

```text
npm run test:build
  PASS

node --test --test-reporter=spec \
  dist-test/tests/private-retry-store.test.js \
  dist-test/tests/authority-material-adapter.test.js \
  dist-test/tests/capability-service.test.js \
  dist-test/tests/directory-durability.test.js
  PASS — 47 passed, 0 failed

npm run typecheck
  PASS
```

The one reserved full-suite run was executed exactly once, late:

```text
npm test
  Runtime OK: Node 24.16.0, SQLite 3.53.0, WAL, FTS5
  1137 total; 1127 passed; 0 failed; 10 skipped
```

Independent final re-review after the read/delete fix:

```text
Critical: 0
Important: 0
Minor: 0
Reviewer verification: test build PASS; encrypted-store 14/14 PASS
```

## Post-commit Fix Wave

The original Task 7 implementation was committed as `9bb4ec46950eb82931fdcf361599a5f9c53c411b`. A post-commit review then confirmed two additional Important retry-safety findings, both resolved in a separate fix commit with message `fix: make pending authorization deletion idempotent`.

### Concurrent delete idempotency

`delete()` could observe the final and then map another process's intervening unlink to `SESSION_CAPABILITY_INVALID` during identity validation. A deterministic test launches two separate child deleters, pauses both after final discovery, lets one delete, and then releases the other.

- RED: encrypted-store 14/15; one deleter fulfilled and the other rejected with `SESSION_CAPABILITY_INVALID` although the final was absent.
- GREEN: both deleters fulfill, the final remains absent, and no raw or typed corruption error escapes.
- Scope: `delete()` opts into the existing private ENOENT sentinel only while opening the observed final, then re-runs claim/final observation. Replacement/type/link/malformed/permission/authentication/key failures remain fail-closed; an unlink after successful open remains idempotent through ENOENT-tolerant unlink.
- Read-only reviewer result: approved with no finding.

### Retryable operation outcome classification

The worker `rejected` variant originally excluded only `COMMAND_OUTCOME_UNKNOWN`; it could therefore accept retryable `OPERATION_OUTCOME_UNKNOWN` and delete pending state as if the result were terminal.

- RED: authority adapter 12/13; completion surfaced `OPERATION_OUTCOME_UNKNOWN` through the terminal rejection branch instead of rejecting the invalid worker shape safely.
- GREEN: both `COMMAND_OUTCOME_UNKNOWN` and `OPERATION_OUTCOME_UNKNOWN` are excluded from the terminal rejection type and strict decoder. A rejected operation-unknown result now fails with `SESSION_CAPABILITY_INVALID`, and the exact encrypted pending record remains available for retry.
- The semantic `unknown` worker variant remains restricted to `COMMAND_OUTCOME_UNKNOWN`.

Post-commit verification:

```text
npm run test:build
  PASS

node --test --test-reporter=spec \
  dist-test/tests/private-retry-store.test.js \
  dist-test/tests/authority-material-adapter.test.js
  PASS — 28 passed, 0 failed

npm run typecheck
  PASS
```

## Deliberate Trust-Boundary Notes and Follow-ups

1. Descriptor commitment authenticity assumes the configured authenticated trusted-host channel. If routed transport later becomes adversarial, Tasks 13/18 should bind the expected commitment into authenticated transport metadata or a provider-verified descriptor without exposing bearer material.
2. The private state root assumes exclusive trusted-host ownership against same-user hostile pathname mutation. The implementation rejects symlinks/noncanonical roots, contains hashed paths, validates regular single-link finals, and handles legitimate process races; handle-pinned reads remain a possible defense-in-depth follow-up if that threat boundary expands.
3. Task 9 maps Task 7's internal `current`/`not-issued` status vocabulary to external `reissued`/`not-applicable`; Task 7 intentionally retains its existing internal vocabulary.
4. Task 9 and Task 10 perform fresh `expiresAt` validation after a dedup miss. Task 7 may verify a resumed sealed approval/grant at its original creation time so exact uncertain-outcome replay remains possible.

No unresolved Task 7 correctness issue remains.
