# Task 4 implementer report

Status: DONE. Base: `eb82dab7c9446a3127329d6c4d5d033d0d15c189`; branch: `codex/v2-fresh-start`.

## Implementation

Added `FreshStartAdmissionGuard`, the exact admission/recovery result types, and an immutable trusted context held in a module-private connection WeakMap. Installed fresh stores without that context refuse; a declared fresh context without an installation receipt refuses instead of becoming legacy. Admission validates installed identity, release, measured build, registered schema identity, mode, and captured generation. Genuine legacy profile absence retains existing behavior; unexpected profile-detection SQL errors are never interpreted as legacy.

Replaced both Task 3 temporary recovery-field preservation paths. Operator transitions to recovery/disabled and automatic stops now call transaction-scoped `captureRecoveryFence`, obtaining the actual committed `events.global_position/event_hash` under the repository's existing `BEGIN IMMEDIATE`. The repository capability checks its active lifetime and does not expose the connection or nest a transaction. Empty event history alone yields the genesis fence; populated history yields its actual tail.

The executor snapshots the private fresh context before asynchronous work. The strict open request/response codec transports canonical decimal generation/position strings, rejects unknown fields, and correlates fresh identity/release/build/generation to the original request. The backend independently invokes `trustedFreshStartBuildInspector`; no inspector or a mismatched measurement refuses. Existing actual-schema verification remains in `identityFromConnection`; admission also requires the immutable release's schema hash to match the registered schema fingerprint. The shipped worker deliberately supplies no inspector in this task and therefore stays closed for fresh opening. Task 5 owns real compiled deployment measurement and composition.

Existing replay authorization and material-status checks remain. Authorized generic and lifecycle committed commands can recover their original results in recovery, without a second append. Fresh admission errors survive `normalizeEventStoreError`; unknown-commit, protocol-poisoning, retry identity, and pending-authorization handling were not relaxed.

## Integration inventory

| Owned boundary | Admission / permitted behavior |
| --- | --- |
| `EventStore.append` through shared `EventAppendTransaction.assertAppendAllowed` | Checks inside its writer transaction before new append; `appendPlanned` also checks before writing events. No EventStore constructor/public-command bypass field was added. |
| Generic `findReplay` and lifecycle `findLifecycleReplay` | Require the internal command-recovery path in addition to existing replay authorization/integrity checks. |
| `LifecycleCommandStore.execute` | Independently checks before authority callback/facade creation, including when its event port is injected; replay still requires its existing authorization comparison. |
| `LifecycleOperationalStore.execute` | Checks the declared operation in its writer transaction and checks actual invoked facade methods, preventing an operation labeled `renew` from invoking semantic workflow/materialization work. |
| `LifecycleCommandProcessor.renewRootLease` (R17) | Narrow signed lease housekeeping check inside its existing `BEGIN IMMEDIATE`; original proof/owner checks remain. Recovery can renew; disabled/prepared cannot. It does not rotate authority or append semantic events. |
| `LifecycleQueryService.read` (R18) | F1 content-read refusal inside existing `BEGIN DEFERRED`, before authority/content reads. `activeChildDiagnostic` inherits it through `read`. A valid signed read is refused in both recovery and prepared. |
| Backend open / lifecycle query routing | Independent measurement, installation/schema/release checks, registration serialized in its writer transaction; early query refusal supplements the owned read-transaction guard. |
| Control-plane operator transition and automatic stop | Real tail capture and state transition share the repository-owned writer transaction (R15/R16). |

Operational housekeeping declarations: workflow/outbox selection; workflow claim/renew/release; outbox claim/renew/record-failure. Actual method allowlist is only `workflows.claim`, `workflows.claimNext`, `workflows.renew`, `workflows.release`, `outbox.claimNext`, `outbox.renewClaim`, and `outbox.recordFailure`. Other methods require active semantic admission, including workflow advancement/recovery, validation-plan writes, authority sidecars, and materialization. The original maintenance executor registration/heartbeat/closure remains housekeeping. None of these exceptions authorize new semantic commands or materialized content during recovery.

## Tests and evidence

All commands ran on Windows Node 24.16.0, serially against `dist-test`, with native exit codes observed. No overlapping compilation, no aggregate `npm test` (Task 6 owns aggregate verification).

### RED

1. `npm run test:build`: exit 0. `node --test --test-concurrency=1 dist-test/tests/fresh-start-admission.test.js`: exit 1, 0 passed / 2 failed. Installed fresh generic append had **Missing expected exception** for `FRESH_START_CONTEXT_REQUIRED`; automatic stop returned **null !== 0n** instead of an actual empty-tail recovery fence. These were the foundational RED tests before production implementation. The process race tests were added after that foundational RED, not presented as an earlier process-backed RED run.
2. Next compiled admission run: exit 1, 3 passed / 2 failed. A callback declared as lease renewal reached `advanceEventlessPhase` and threw the sentinel **authority callback must not run** rather than `FRESH_START_ADMISSION_STALE`. The private fresh opening request was rejected by the pre-existing exact codec. This preceded the operational method restriction and handshake implementation.
3. `node --test --test-concurrency=1 --test-name-pattern="fresh recovery" dist-test/tests/lifecycle-command-processor.test.js`: exit 1, 0 passed / 2 failed. A valid signed protected read returned content in recovery, and a valid signed root lease renewal succeeded after Disabled; both reported **Missing expected exception**. Guards were then added inside the existing read and renewal transactions.

Fixture-only corrections were not counted as behavioral RED: TypeScript fixture shape errors were corrected before runs; a premature test invocation before its first build finished reported no compiled file. The codec negative assertions use the existing exact `WORKER_PROTOCOL_INVALID` code.

### Intermediate regression findings

- First broad focused run: exit 1, **145 passed / 183 total**, 38 failures all from `TransactionConnection.prepare` intentionally refusing every SQL query. Fixed only the exact new sqlite_schema profile-presence query to return absence in this legacy mock; the operational legacy mock received the same narrow representation. Unexpected SQL still throws, and production detection has no catch/fallback.
- Next broad run: exit 1, **265 passed / 266 total**. The only failure was `a lifecycle request admitted in another process is refused after the recovery fence`: its real intent-witness builder rejected the fixture's noncanonical workspace ID (`LIFECYCLE_INTENT_WITNESS_INVALID`) before reaching admission. Corrected the owned fixture to a canonical 64-hex workspace ID; retained the exact expected `FRESH_START_ADMISSION_STALE` assertion. Production code did not change for that correction.

### Final GREEN (unchanged compiled source snapshot)

`npm run test:build`: native exit **0**.

```text
node --test --test-concurrency=1 dist-test/tests/fresh-start-admission.test.js dist-test/tests/event-store.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-worker-runtime.test.js dist-test/tests/lifecycle-worker-protocol.test.js dist-test/tests/maintenance-fence.test.js dist-test/tests/fresh-start-control-plane.test.js dist-test/tests/fresh-start-repository.test.js dist-test/tests/lifecycle-operational-store.test.js dist-test/tests/lifecycle-command-processor.test.js
```

Native exit **0**; **270 tests, 14 suites, 270 passed, 0 failed, 0 cancelled, 0 skipped**, duration 48.420 seconds. Per-file counts: admission 26; event store 26; lifecycle command store 53; lifecycle worker runtime 8; lifecycle worker protocol 18; maintenance fence 10; control plane 45; repository 10; operational store 31; command processor (including protected queries) 43. Output contained no test warnings/errors.

New coverage includes real child-process stale generic/lifecycle requests; a real writer held after event insertion while a separate recovery process waits for serialization, followed by actual tail capture; production generic/lifecycle dedup; injected event-port pre-authority isolation; missing context/receipt/inspector and wrong build/release/schema/generation opening; real shipped-worker refusal; malformed/unknown/noncanonical and uncorrelated handshake data; populated operator fence; empty automatic fence; legacy append; valid signed read refusal; signed housekeeping versus disabled refusal. Owned children have bounded barriers, error/exit observation, and finally cleanup.

`git -c core.safecrlf=false diff --check`: exit **0**, no whitespace errors. Reviewed the scoped source diff and test fixtures before committing.

## Files

Production:
- `src/orchestrator/fresh-start/fresh-start-admission.ts` (new)
- `src/orchestrator/fresh-start/contracts.ts`
- `src/orchestrator/fresh-start/fresh-start.repository.ts`
- `src/orchestrator/fresh-start/fresh-start-control-plane.ts`
- `src/orchestrator/storage/event-append-transaction.ts`
- `src/orchestrator/lifecycle/lifecycle-command.store.ts`
- `src/orchestrator/lifecycle/lifecycle-operational.store.ts`
- `src/orchestrator/lifecycle/lifecycle-command.processor.ts` (approved R17 narrow method)
- `src/orchestrator/lifecycle/lifecycle-query.service.ts` (approved R18 narrow method)
- `src/orchestrator/runtime/project-store-executor.ts`
- `src/orchestrator/runtime/project-store-worker-backend.ts`
- `src/orchestrator/runtime/worker-protocol.ts`

Tests/support:
- `tests/fresh-start-admission.test.ts` (new)
- `tests/fixtures/fresh-start-admission-child.ts` (new)
- `tests/lifecycle-command-store.test.ts`
- `tests/lifecycle-operational-store.test.ts`
- `tests/lifecycle-command-processor.test.ts`
- `tests/support/fresh-start-fixture.ts`

This report is the remaining task-owned file. Existing worker-runtime/factory/entry files needed no task-4 edits because the private context is bound to their existing shared connection by the backend.

## Self-review / limitations / handoff

- F1 still has no verified public content provider; all fresh content reads are denied. A recovery command probe only recovers an already committed, authorized result.
- Task 5 must supply the independent deployment inspector to worker composition; no hard-coded production hash or wire-echoed measurement was introduced. The actual shipped worker refusal is tested.
- The new guard inspects the durable recorded event tail; it does not introduce a new full-history integrity verifier or claim a public verified snapshot. Existing integrity/schema checks remain in their owners.
- Large pre-existing lifecycle files received narrow checks only; no source restructuring, migrations 1-7 changes, V1 content/config access, production activation, push, or merge.
- Root owns memory session `memory-1790679623380`; no subagent memory tools/vault edits were performed. Durable findings to retain: operation labels alone cannot constrain a broad callback facade; exact method gates are necessary. Negative boundary fixtures must carry valid canonical lifecycle identities/witnesses so upstream validation cannot mask missing admission.
