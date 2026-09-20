# V2 Shadow Migration and Compatibility Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, restart-safe internal pipeline that verifies an immutable V1 source copy, imports it as committed V2 shadow events, publishes V2 projections, proves snapshot-aligned parity, and materializes compatibility artifacts into an isolated target without changing caller-facing V1 routing.

**Architecture:** A strict migration contract binds one rollout revision to one verified source manifest, canonical migration package, append-only schema-7 ledger, deterministic import stream, verified V2 projection generation, typed parity report, and isolated compatibility target. Every durable phase is hash-chained and idempotent; unknown outcomes reconcile from committed events, ledger rows, projection manifests, parity checksums, and target bytes before retry. The existing production composition remains V1-only, and this slice runs only against an explicitly configured production-shaped copy.

**Tech Stack:** TypeScript, Node.js 24.16 or newer, `node:crypto`, `node:fs`, `node:path`, `node:sqlite` through the existing `SqliteDriver`/`SqliteConnection` abstractions, SQLite STRICT tables and triggers, canonical JSON, the current event-store and projection implementations, `node:test`, PowerShell release commands, and the existing Windows/Linux GitHub Actions matrix.

**Spec:** `docs/superpowers/specs/2026-09-09-v2-shadow-migration-and-compatibility-parity-design.md`

## Global Constraints

- Version 1 remains the sole caller-facing authority. Do not modify `src/app.ts`, `src/index.ts`, `src/controllers/**`, `src/schemas/**`, `src/services/**`, or register a V2 MCP tool.
- Do not activate a rollout revision on a user store, enable live shadow/canary/primary traffic, dual-write caller commands, or point any mutation-capable component at the live V1 store or live vault.
- Node.js runtime floor remains `>=24.16.0`; add no production dependency.
- Source-copy paths, package paths, projection paths, and compatibility targets must be absolute, normalized, existing where required, non-symbolic, and verified by file identity rather than path text alone.
- The source is opened with `mode: "read-only-existing"`; pre-run and post-run identities and SHA-256 hashes must match exactly.
- Migration policy bounds are exact: `maxEvents` 1..100,000; `maxAggregateBytes` 1..67,108,864; `maxEventBytes` 1..1,048,576; `maxBatchEvents` 1..1,000; `maxBatchBytes` 1..8,388,608; `deadlineMs` 1..300,000; `maxRetries` 0..3; `initialBackoffMs` 10..500; `maxBackoffMs` from `initialBackoffMs` through 2,000; `maxExpectedDifferenceRuleAgeMs` 1..604,800,000.
- The rollout revision `configurationChecksum` must bind the canonical migration configuration, which includes the sealed policy checksum, and `migrationIdentityHash` must equal the domain-separated identity calculated from the verified source and sealed package.
- Durable phases are exactly `snapshot-verified`, `package-sealed`, `import-committed`, `projection-verified`, `parity-complete`, and `compatibility-complete`, in that order.
- Import commits only V2 shadow wrapper events through the current `EventStore`; V2 projection input is reconstructed exclusively from those authenticated committed wrapper events.
- No expected-difference rule may cover identity, authority, project/workspace/session/visibility scope, event-chain integrity, privacy, erasure, duplicate/lost events, ordering, terminal position/hash, plaintext leakage, or projection core-checksum divergence.
- Migration packages and source copies are sensitive. Diagnostics and evidence expose only typed categories, opaque IDs, schema/algorithm versions, positions, hashes, counts, timings, and resource measurements.
- Compatibility bytes are written only below a separately configured isolated root. The live V1 vault root is always rejected, even if a relative artifact path is valid.
- Tests use production decoders, event hashes, source authentication, real SQLite/WAL behavior, real projection publication, and atomic replacement. Hand-built tests may generate data only through current production writers/helpers.
- Passing Slice 2 authorizes only planning for Slice 3 privacy/retention/global-scope work. It does not make V2 production-primary or authorize deployment.

---

## Execution Status

Execution resumed (2026-09-12, reconfirmed2026-09-20): the user's explicit "Subagent-Driven ทำต่อ" supersedes the historical Task9 stop below. Tasks1–10 and sequentially reviewed units11A–11D are complete; parent11 base is `0c302ab5117d31720982046da3cfdd05fea91a27`. Current accepted runtime code is `7159fcbdcfed6c92ffa734ffec963e63d95c8c03`. Unit11D's initial five Important findings are all addressed after two scoped fix rounds, with independent specification compliance and code-quality approval and no new Critical/Important issue. Latest exact fix2 qualification: fresh build0, parity-only23/23/0fail/0skip/native0 and separate typecheck0; complete primary output/completion and identical tested-to-commit fingerprint verified by controller. The initial128/128 and fix1's58/58 remain evidence only on their respective earlier commits; historical capture/platform/cooperative-deadline limitations remain explicit. Unit11E is next;11E–11F and parent11/Tasks12–14 remain open. Actual Windows/Linux authority and capacity qualification, real source-input prerequisites below, and complete release reviews remain outstanding. No live V2 activation, production-primary claim or deployment is authorized.

Selected rehearsal source (2026-09-12): the user authorized read-only extraction from live PROD and selected the main `C:\Users\Server\Desktop\Awakened-AI-System\memory` vault. Its configured entry point is the existing file-backed V1 application. Read-only checks found no `memory/.memory-mcp/project-identity.json` and no main `.git/project-memory` directory; no authenticated SQLite source has been identified. This source selection is not a source manifest, migration configuration, or full source-bound approved retrieval corpus. Task14's real rehearsal remains pending those inputs and a resolved source-format contract. Do not bootstrap the live vault, synthesize historical events from Markdown, or label a Markdown backup as verified SQLite input. No source copy or rollout has been performed; ordinary authorized project-memory logging is separate from extraction/migration.

- [x] Task 1: strict migration contracts, policy/configuration checksums, and identity binding.
- [x] Task 2: production-compatible projection identity codecs.
- [x] Task 3: immutable production-shaped V1 source verification.
- [x] Task 4: canonical content-addressed migration package.
- [x] Task 5: schema-7 append-only ledger, attempts, parity, and compatibility evidence.
- [x] Task 6: deterministic committed V2 shadow import.
- [x] Task 7: projection input reconstructed only from committed imports.
- [x] Task 8: verified V1-reference and V2-shadow projection publication.
- [x] Task 9: expected-difference governance, row parity, and sealed retrieval parity.
- [x] Task 10: isolated compatibility materialization.
- [ ] Task 11: durable orchestration, retry, and reconciliation.
  - [x] 11A: shared deadline/source integration; implementation `e506998`, reviewed cleanup correction `318e6a1`. Final scoped gate:95 passed,0 failed,1 existing Windows symlink skip; build/typecheck and scoped re-review passed. Cross-platform qualification remains open.
  - [x] 11B: package/importer read-only reconciliation; initial `78d5c04`, reviewed fixes `2ec35b9` and `b18c321`. All seven review findings are addressed with no new breakage. Fix1 fresh six-file gate:216 tests,215 passed,0 failed,1 existing Windows file-symlink skip. Fix2's approved narrow final gate:64/64 importer tests,0 failures/skips; fresh build/typecheck and scoped re-review passed. Complete current output/exit/commit mapping was verified. The216-test gate predates fix2; historical output gaps and platform qualification limits remain explicit.
  - [x] 11C: projection deadline/deterministic phase/read-only proofs; implementation `5cbbc65` independently specification-compliant and quality-approved, no Critical/Important code finding. Exactly publisher/test plus one existing V1 verifier timeout-forwarding call changed. Authorized unchanged replacement qualification2026-09-19: fresh build0, exact six-file253tests253pass0fail0skip exit0 (976086.4895ms), separate typecheck0; full raw outputs/actual native completion and unchanged scoped fingerprint verified by controller. Original253/250/3 setup failures, isolated3/3 non-reproduction and interrupted39-leaf/no-exit attempt remain historical qualifications, not causal fixes. Windows OS-prevented replacements are not executed stale-handle proof; release qualification remains open. Unit accepted; proceed to11D.
  - [x] 11D: retrieval/parity deadline/corpus/adoption; initial `6779298` from plan-only base `06276ec`, reviewed fixes `d8e20ea` and `7159fcbdcfed6c92ffa734ffec963e63d95c8c03`. All five Important findings addressed; independent specification compliance and quality approved, no new Critical/Important issue. Initial fresh six-file128/128 and fix1 three-file58/58 gates remain historical evidence on those commits. Final fix2 changes only parity source/test, fingerprint `75b431465d44cc67eb27b682cf8448dba7df6244` identical before/after fresh build0/parity-only23tests23pass0fail0skip/native0 (963195.4441ms)/typecheck0 and at staging/commit. Controller read complete current primary streams/completions and captured command responses. Direct descriptor-progress RED/GREEN proves mid-traversal expiry without getter/retrieval/semantic writes. Historical early TDD/fingerprint/non-primary inspection gaps and Windows prevented-replacement/cooperative-deadline limitations remain explicit; parent aggregate/cross-platform/capacity qualification remains open.
  - [ ] 11E: compatibility deadline/read-only reconciliation.
  - [ ] 11F: runner/retry/preflight carrier and aggregate integration gate.
- [ ] Task 12: three-run rehearsal plus fourth-run no-op evidence.
- [ ] Task 13: schema registry, focused gate, CI, and bundled smoke sealing.
- [ ] Task 14: production-shaped rehearsal and independent specification, quality, and security reviews.

Task 7 closure (2026-09-11): implementation `f314c58e86040c332846e65fd7b094896ea0f69f`, reviewed correction `b6c9dab575bbe18e18b6463072adcbb31cb0220c`; focused gate 148/148, build/typecheck passed, independent specification/quality review approved.

Task 8 closure (2026-09-11): implementation `36c5f9d015ddd94e99d95c49072286a4bdf926b2`, reviewed correction `375aa6fa780f1870ca0f9c470f153e46cebd08df`; independent specification/quality review approved all three findings. Final clean six-file gate 143/143, zero failures/skips, build/typecheck passed on the reviewed code. Earlier 128/133 gate failure remains recorded, not relabeled. Tasks 9–14 remain open; V1 remains sole caller authority and V2 is not activated.

Task 9 closure (2026-09-12): implementation `9c7481a112799ae59cc122ebaaf0ced7a61ce556`; clean nine-file gate 122/122, zero failures/skips, build/typecheck passed. Additional Git-helper/resolver/protocol/lifecycle gate 63/63 and unchanged coordinator deadline controls 8/8 passed. Independent review identified one missing wrong-connection ownership regression; test-only fix `f3d966503a56007fdf8c594ed92ca21276c2351c` passed focused 1/1, complete parity 14/14, fresh build/typecheck and diff checks. Scoped re-review accepted specification and quality with no remaining findings. The 122/122 gate precedes the test-only fix; it is not described as a rerun. Earlier failed gates remain recorded, not relabeled. Task9 and its seven steps are complete; Tasks10–14 remain open. STOP HERE at the user's request: do not begin Task10 without a new request. Existing later-task preflight notes are preparation only. V1 remains the sole caller authority; no V2 activation, production-primary claim or deployment.

Task 10 closure (2026-09-12): initial implementation `41bf882415caeab5815fc8892a01c3e40025d572`; fixes `2ef8f5ff710de2492410fc75eb1063048a1f35e7` and `d23cc57bd471e48b1fd02126f6451c8d54c6dff2`. Independent review and both scoped re-reviews resolved stale-connection identity, cubic membership comparisons and constructor registration forgery; no findings remain. Initial nine-file gate: 280 passed, 0 failed, 1 baseline skip; later test-only three-file gate: 56 passed, 0 failed, 3 skips. Fix1 fresh ten-file gate: 314 tests, 311 passed, 0 failed, 3 documented capability skips. Fix2's authorized two-file driver/compatibility gate: 44/44, zero failures/skips, with observed constructor-forgery RED2/2 and GREEN2/2. Final test build/typecheck/production build/built-worker smoke passed. The ten-file gate precedes the narrow fix2 and is not described as rerun. Six Windows replacement attempts were actually OS-prevented and do not prove stale-handle guard execution; the two V2 symlink capability skips and actual Windows/Linux authority/capacity gates remain Tasks13/14 obligations. All six Task10 steps are complete; this closes implementation, not Slice2 release qualification or V2 production readiness.

Task 11A closure (2026-09-12): shared cooperative invocation deadline, strict deterministic phase metadata and immutable-source integration in `e506998bed3cb7cd929560b61ef28ddfd06d93b7`; cleanup correction `318e6a1e385b3057eedeb0944e5e9cf632a8b18e`. Independent review found one Important primary-error/partial-cleanup issue; its focused RED3/3 and GREEN3/3 plus fresh four-file96tests/95pass/0fail/1existingWindowsfile-symlinkskip, test build and typecheck were verified, and scoped re-review accepted the fix with no new breakage. Historical initial93tests/92pass gate precedes the fix and is not the final count. Persistent or identity-uncertain scratch cleanup refuses success and may retain safely unremovable bytes; no hard-cancellation or universal cleanup guarantee is claimed. The Windows capability skip remains an explicit Task13/14 qualification obligation. Unit11A alone is closed;11B–11F, the parent aggregate gate, and Tasks12–14 are not complete.

Task 11B closure (2026-09-12): package/importer shared-budget integration and read-only reconciliation in `78d5c04e02328db3093026c93de007e16be9ce90`, reviewed corrections `2ec35b93d024ef17e3cc3456b84573cc3d60dc6d` and `b18c321954475a380345fab4fc1c05c31508b464`. The seven findings covered transaction deadline checks, whole-import possible-commit classification, complete deterministic event ownership, partial/uncertain package reads, stable-parent absence proof, retained iterator/deadline ownership, and consistent native target-authority refusal. Fix1 scoped review accepted six; fix2 closed the remaining same-stream foreign-command ownership gap with a production-writer behavioral RED and focused GREEN. Final fix2 build, full serial importer64/64 gate and typecheck all exited0, and exact pre/postcommit diff mapping was checked. The broader fix1 gate had216tests/215pass/0fail/1Windowsfile-symlinkskip and is not represented as rerun on fix2. Independent re-review found no new breakage or out-of-scope observations. Original unavailable raw output/exit metadata, the unreproduced directory-stat failure and six Windows OS-prevented replacement setups remain documented limitations, not invented history or executed platform proof. Unit11B is closed;11C–11F, the parent aggregate gate and Tasks12–14 remain open. V1 caller routing and live authority were not changed.

## File Structure

| Path | Responsibility |
| --- | --- |
| `src/orchestrator/migration/v2-shadow-migration.contracts.ts` | Exact migration policy, phases, error taxonomy, canonical checksums, deterministic IDs, and rollout-revision binding. |
| `src/orchestrator/migration/v1-source-copy.ts` | Stable source manifest decoding, path/file-identity verification, read-only event-chain authentication, legacy-artifact inventory, and post-run mutation detection. |
| `src/orchestrator/migration/v2-migration-package.ts` | Streaming canonical package writer/reader, same-directory atomic publication, record descriptors, and package/migration identity verification. |
| `src/orchestrator/storage/migrations/0007-v2-shadow-migration.ts` | Immutable schema-7 run, transition, imported-record, parity, rule, compatibility-outbox, and acknowledgement tables with guards. |
| `src/orchestrator/storage/v2-shadow-migration.repository.ts` | One-connection `BEGIN IMMEDIATE` repository, strict row decoders, ledger-chain verification, exact claims, and reconciliation reads. |
| `src/orchestrator/migration/v2-shadow-importer.ts` | Bounded package reader, deterministic V2 wrapper-event append, batch checkpointing, deduplication, and unknown-outcome reconciliation. |
| `src/orchestrator/migration/v2-imported-event-reader.ts` | Reads authenticated committed wrapper events, verifies ledger mappings, reconstructs the original stored-event chain, and exposes a `ProjectionEventReader`. |
| `src/orchestrator/migration/v2-shadow-projection.ts` | Builds/publishes schema-V2 projections from committed imports and verifies terminal identity and core checksums. |
| `src/orchestrator/parity/v2-expected-difference.ts` | Exact immutable rule decoder, forbidden-category guard, time/revision/migration binding, and unique-match resolution. |
| `src/orchestrator/parity/v2-snapshot-parity.ts` | Snapshot-aligned row/field comparison, typed classifications, redacted report construction, and checksum calculation. |
| `src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts` | Exact compatibility-outbox claim, isolated path enforcement, atomic byte publication, durable acknowledgement, and reconciliation. |
| `src/orchestrator/materialization/stable-compatibility-directory.ts` | Internal pinned-directory preparation, publication and durable verification client; no repository authority. |
| `src/orchestrator/materialization/stable-compatibility-directory.worker.ts` | Hidden bounded child using relative operations and the unchanged atomic replacer under a verified directory identity. |
| `src/orchestrator/storage/node-sqlite-driver.ts` / `sqlite-driver.ts` | Opt-in existing-file open-time identity binding for genuine isolated connections; ordinary V1 open defaults remain unchanged. |
| `src/orchestrator/migration/v2-shadow-migration-runtime.ts` | One cooperative monotonic invocation budget and source-derived committed phase metadata, separate from actual UTC rule authority. |
| `src/orchestrator/migration/v2-shadow-migration-runner.ts` | Phase orchestration, bounded retry/backoff, durable resume, fail-closed reconciliation, source re-verification, and final result. |
| `src/orchestrator/migration/v2-shadow-migration-evidence.ts` | Canonical redacted release-evidence document and checksum. |
| `src/orchestrator/migration/v2-shadow-migration-rehearsal.ts` | Internal compiled rehearsal composition; not imported by any public production entry point. |
| `scripts/run-v2-shadow-migration-rehearsal.js` | Explicit command-line entry for three clean runs plus a fourth no-op against configured isolated roots. |
| `scripts/smoke-v2-shadow-compatibility.js` | Built-only internal worker smoke, later extended with rehearsal entry refusal checks. |
| `scripts/build.js` | Adds separate internal worker/rehearsal artifacts without changing public V1 composition. |
| `tests/support/v2-shadow-migration-fixture.ts` | Generates production-shaped SQLite/WAL sources, manifests, rollout revisions, isolated targets, and deterministic fault seams using production writers. |
| `tests/v2-shadow-migration-contracts.test.ts` | Policy, identity, phase, error, and revision-binding contract tests. |
| `tests/v1-source-copy.test.ts` | Source alias/symlink/replacement/schema/scope/limit/chain and mutation tests. |
| `tests/v2-migration-package.test.ts` | Canonical package, bounded streaming, publication, tamper, and determinism tests. |
| `tests/v2-shadow-migration-repository.test.ts` | Schema-7 immutability, chain order, row decoding, claim, acknowledgement, and rollback tests. |
| `tests/v2-shadow-importer.test.ts` | Deterministic wrapper-event import, batch bounds, no-op replay, conflict, and unknown-outcome tests. |
| `tests/v2-imported-event-reader.test.ts` | Committed-wrapper receipt, reconstruction, source-chain authentication, and close-semantics tests. |
| `tests/v2-shadow-projection.test.ts` | Committed-import reader, real schema-V2 publication, terminal identity, and projection integrity tests. |
| `tests/v2-snapshot-parity.test.ts` | Equal, governed expected, blocking, forbidden, multiple-rule, and report-redaction tests. |
| `tests/v2-shadow-compatibility.test.ts` | Isolated exact-claim publication, live-root rejection, lag, crash, and acknowledgement reconciliation tests. |
| `tests/sqlite-driver.test.ts` | Existing native SQLite hardening plus opt-in genuine/open/closed/stale/forged connection identity regressions. |
| `tests/v2-shadow-migration-runtime.test.ts` | Deterministic phase metadata and shared-clock budget boundary/disposal tests. |
| `tests/v2-shadow-migration-runner.test.ts` | End-to-end phases, retry classes, restart points, source re-verification, and V1 isolation tests. |
| `tests/v2-shadow-migration-rehearsal.test.ts` | Three-run determinism, fourth-run no-op, evidence, performance bounds, and source byte-identity tests. |
| `src/orchestrator/storage/migrations/registry.ts` | Registers schema 7 and advances the current version. |
| `tests/migration-registry.test.ts` | Pins migration 0007 and preserves all frozen prior checksums. |
| `tests/project-store-bootstrap.test.ts` | Verifies a new store records migrations 1 through 7 and installs guarded Slice-2 tables. |
| `tests/project-store-upgrade.test.ts` | Verifies atomic upgrade through schema 7 and restart behavior. |
| `tests/project-store-upgrade-phase-runner.test.ts` | Verifies worker upgrade reports version 7. |
| `tests/ci-lifecycle-gates.test.ts` | Seals new internal-only source paths, exact focused gate, V1 routing protection, and artifact retention policy. |
| `scripts/smoke-worker.js` | Verifies bundled bootstrap/upgrade through schema 7 and keeps lifecycle V2 disabled. |
| `package.json` | Adds the exact focused Slice-2 and rehearsal commands. |
| `.github/workflows/ci.yml` | Runs the focused Slice-2 gate on Windows/Linux before artifact tests without changing V1 protection. |

`tests/support/v2-shadow-migration-fixture.ts` owns the shared test vocabulary used below. It exports `createV2ShadowMigrationFixture`, `sealedPackageFixture`, `importedPackageFixture`, `repositoryFixture`, `committedRepositoryFixture`, `parityFixture`, `sealedRetrievalParityFixture`, `compatibilityFixture`, `runnerFixture`, and `rehearsalFixture`, plus bounded read/tamper helpers. Each factory returns a typed object with only the properties used by its task tests, registers cleanup with `TestContext.after`, and creates data through current production migrations/EventStore/projection writers rather than direct semantic row inserts. Task-local helpers such as `approvedRule`, `transition`, and `transitionHash` remain in their named test file and must construct values through the production decoder/hash exported by the task under test.

### Task 1: Define strict migration contracts, policy checksum, and identity binding

**Files:**
- Create: `src/orchestrator/migration/v2-shadow-migration.contracts.ts`
- Create: `tests/v2-shadow-migration-contracts.test.ts`
- Modify: `src/orchestrator/rollout/rollout-control-plane.ts:1-180`
- Test: `tests/rollout-control-plane.test.ts:680-760`

**Interfaces:**
- Consumes: `canonicalJson(value: unknown): string`, `RolloutRevision`, and `RolloutControlPlaneError`.
- Produces: `ShadowMigrationPhase`, `ShadowMigrationPolicyV1`, `ShadowMigrationConfigurationV1`, `ShadowMigrationError`, `decodeShadowMigrationPolicyV1`, `decodeShadowMigrationConfigurationV1`, `shadowMigrationPolicyChecksum`, `shadowMigrationConfigurationChecksum`, `shadowMigrationIdentity`, `deterministicMigrationUuid`, and `RolloutControlPlane.revision(projectId, revisionId)`.

- [x] **Step 1: Write failing exact-input and boundary tests.**

Create tests that use null-prototype records, accessors, symbols, unknown fields, every minimum/maximum, and one value beyond every bound. Pin canonical output and domain strings:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  SHADOW_MIGRATION_PHASES,
  ShadowMigrationError,
  decodeShadowMigrationConfigurationV1,
  decodeShadowMigrationPolicyV1,
  deterministicMigrationUuid,
  shadowMigrationConfigurationChecksum,
  shadowMigrationIdentity,
  shadowMigrationPolicyChecksum,
} from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";

const POLICY = Object.freeze({
  schemaVersion: 1,
  maxEvents: 100_000,
  maxAggregateBytes: 67_108_864,
  maxEventBytes: 1_048_576,
  maxBatchEvents: 1_000,
  maxBatchBytes: 8_388_608,
  deadlineMs: 300_000,
  maxRetries: 3,
  initialBackoffMs: 500,
  maxBackoffMs: 2_000,
  expectedDifferencePolicyVersion: 1,
  maxExpectedDifferenceRuleAgeMs: 604_800_000,
});

test("migration policy is exact, canonical, and bounded", () => {
  const decoded = decodeShadowMigrationPolicyV1(POLICY);
  assert.deepEqual(decoded, POLICY);
  assert.equal(Object.isFrozen(decoded), true);
  assert.match(shadowMigrationPolicyChecksum(decoded), /^[0-9a-f]{64}$/);
  const configuration = decodeShadowMigrationConfigurationV1({
    schemaVersion: 1,
    policyChecksum: shadowMigrationPolicyChecksum(decoded),
    packageFormatVersion: 1,
    migrationAlgorithmVersion: 1,
    expectedDifferencePolicyVersion: 1,
  });
  assert.match(shadowMigrationConfigurationChecksum(configuration), /^[0-9a-f]{64}$/);
  assert.throws(
    () => decodeShadowMigrationPolicyV1({ ...POLICY, maxEvents: 100_001 }),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "MIGRATION_POLICY_INVALID",
  );
  assert.throws(() => decodeShadowMigrationPolicyV1({ ...POLICY, extra: true }));
});

test("phase order and deterministic identities are frozen", () => {
  assert.deepEqual(SHADOW_MIGRATION_PHASES, [
    "snapshot-verified", "package-sealed", "import-committed",
    "projection-verified", "parity-complete", "compatibility-complete",
  ]);
  const identity = shadowMigrationIdentity({
    projectId: "11111111-1111-4111-8111-111111111111",
    storeId: "33333333-3333-4333-8333-333333333333",
    sourceManifestChecksum: "3".repeat(64), terminalEventHash: "4".repeat(64),
    packageChecksum: "5".repeat(64), migrationAlgorithmVersion: 1,
    buildIdentityHash: "6".repeat(64), configurationChecksum: "7".repeat(64),
  });
  assert.equal(identity, shadowMigrationIdentity({
    projectId: "11111111-1111-4111-8111-111111111111",
    storeId: "33333333-3333-4333-8333-333333333333",
    sourceManifestChecksum: "3".repeat(64), terminalEventHash: "4".repeat(64),
    packageChecksum: "5".repeat(64), migrationAlgorithmVersion: 1,
    buildIdentityHash: "6".repeat(64), configurationChecksum: "7".repeat(64),
  }));
  assert.match(deterministicMigrationUuid("attempt", identity, 0), /^[0-9a-f-]{36}$/);
});
```

- [x] **Step 2: Run the focused tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-contracts.test.js dist-test/tests/rollout-control-plane.test.js
```

Expected: compilation fails because the migration contract module and `RolloutControlPlane.revision` do not exist.

- [x] **Step 3: Add the exact contract and hash implementation.**

Use these public shapes and domains; the decoder must inspect own enumerable data descriptors before value access and deep-freeze its result:

```ts
export const SHADOW_MIGRATION_PHASES = Object.freeze([
  "snapshot-verified", "package-sealed", "import-committed",
  "projection-verified", "parity-complete", "compatibility-complete",
] as const);
export type ShadowMigrationPhase = (typeof SHADOW_MIGRATION_PHASES)[number];

export type ShadowMigrationErrorCode =
  | "MIGRATION_POLICY_INVALID" | "MIGRATION_SOURCE_INVALID"
  | "MIGRATION_SOURCE_MUTATED" | "MIGRATION_LIMIT_EXCEEDED"
  | "MIGRATION_IDENTITY_CONFLICT" | "MIGRATION_LEDGER_INTEGRITY_FAILURE"
  | "MIGRATION_OUTCOME_UNKNOWN" | "MIGRATION_RETRY_EXHAUSTED"
  | "PROJECTION_INTEGRITY_FAILURE" | "PARITY_RULE_INVALID"
  | "PARITY_BLOCKING_DIVERGENCE" | "COMPATIBILITY_INTEGRITY_FAILURE";

export class ShadowMigrationError extends Error {
  constructor(
    readonly code: ShadowMigrationErrorCode,
    readonly safeDetails: Readonly<Record<string, string | number>> = Object.freeze({}),
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ShadowMigrationError";
  }
}

export interface ShadowMigrationPolicyV1 {
  readonly schemaVersion: 1;
  readonly maxEvents: number;
  readonly maxAggregateBytes: number;
  readonly maxEventBytes: number;
  readonly maxBatchEvents: number;
  readonly maxBatchBytes: number;
  readonly deadlineMs: number;
  readonly maxRetries: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly expectedDifferencePolicyVersion: number;
  readonly maxExpectedDifferenceRuleAgeMs: number;
}

export interface ShadowMigrationConfigurationV1 {
  readonly schemaVersion: 1;
  readonly policyChecksum: string;
  readonly packageFormatVersion: 1;
  readonly migrationAlgorithmVersion: 1;
  readonly expectedDifferencePolicyVersion: number;
}

export interface ShadowMigrationIdentityInput {
  readonly projectId: string;
  readonly storeId: string;
  readonly sourceManifestChecksum: string;
  readonly terminalEventHash: string;
  readonly packageChecksum: string;
  readonly migrationAlgorithmVersion: 1;
  readonly buildIdentityHash: string;
  readonly configurationChecksum: string;
}

const POLICY_DOMAIN = "project-memory/v2-shadow-migration-policy/v1";
const CONFIGURATION_DOMAIN = "project-memory/v2-shadow-migration-configuration/v1";
const IDENTITY_DOMAIN = "project-memory/v2-shadow-migration-identity/v1";
const UUID_DOMAIN = "project-memory/v2-shadow-migration-uuid/v1";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function shadowMigrationPolicyChecksum(policy: ShadowMigrationPolicyV1): string {
  return sha256(`${POLICY_DOMAIN}\n${canonicalJson(policy)}`);
}

export function shadowMigrationConfigurationChecksum(
  configuration: ShadowMigrationConfigurationV1,
): string {
  return sha256(`${CONFIGURATION_DOMAIN}\n${canonicalJson(configuration)}`);
}

export function shadowMigrationIdentity(input: ShadowMigrationIdentityInput): string {
  return sha256(`${IDENTITY_DOMAIN}\n${canonicalJson(input)}`);
}

export function deterministicMigrationUuid(
  purpose: "attempt" | "command" | "event" | "claim",
  migrationIdentity: string,
  ordinal: number,
): string {
  const bytes = Buffer.from(sha256(`${UUID_DOMAIN}\n${canonicalJson({ purpose, migrationIdentity, ordinal })}`), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
```

Add `revision(projectId, revisionId)` as a read-only service method that uses the repository transaction, validates both UUIDs, returns the immutable decoded revision, and fails `ROLLOUT_TRANSITION_DENIED` when absent. Do not expose this method through a controller or worker protocol.

`decodeShadowMigrationConfigurationV1` must require `policyChecksum === shadowMigrationPolicyChecksum(policy)` at the runner boundary and require `expectedDifferencePolicyVersion` to equal the policy field. The rollout revision binds the result of `shadowMigrationConfigurationChecksum`, not the policy checksum alone.

- [x] **Step 4: Run contract and rollout tests.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-contracts.test.js dist-test/tests/rollout-control-plane.test.js
npm run typecheck
```

Expected: all tests pass; malformed objects fail before accessor execution; policy hashes and deterministic UUIDs are stable.

- [x] **Step 5: Commit the migration contract.**

```powershell
git add src/orchestrator/migration/v2-shadow-migration.contracts.ts src/orchestrator/rollout/rollout-control-plane.ts tests/v2-shadow-migration-contracts.test.ts tests/rollout-control-plane.test.ts
git commit -m "feat: define V2 shadow migration contracts"
```

### Task 2: Align projection identity codecs with production project-store identities

**Files:**
- Modify: `src/orchestrator/projections/contracts.ts:1-45`
- Modify: `src/orchestrator/projections/event-reader.ts:20-142`
- Modify: `src/orchestrator/projections/source-event-codec.ts:1-170,420-640`
- Modify: `src/orchestrator/projections/folds.ts:120-160`
- Modify: `src/orchestrator/projections/manifest.ts:210-370`
- Modify: `src/orchestrator/projections/checksum.ts:70-110`
- Modify: `tests/projection-source-event-codec.test.ts`
- Modify: `tests/projection-folds.test.ts`
- Modify: `tests/projection-manifest.test.ts`
- Modify: `tests/projection-integrity.test.ts`

**Interfaces:**
- Consumes: production `ProjectId`/`VaultId`/`StoreId` UUIDv4 values, SHA-256 `WorkspaceId`, optional UUID branch scope, and the existing sealed evaluator's SHA-256 synthetic identity fixtures.
- Produces: one shared `decodeProjectionIdentityToken(value, kind)` rule used by reader, source codec, folds, manifest, and checksums without relaxing any arbitrary-string boundary.

- [x] **Step 1: Add production-identity RED cases before changing decoders.**

Copy one existing valid projection source/manifest/fold fixture and replace only project, vault, and store identities with canonical UUIDv4 values while keeping the workspace identity as lowercase SHA-256. Pin the compatibility boundary:

```ts
const PRODUCTION_BINDING: ProjectBinding = Object.freeze({
  projectId: "11111111-1111-4111-8111-111111111111" as ProjectId,
  vaultId: "22222222-2222-4222-8222-222222222222" as VaultId,
  storeId: "33333333-3333-4333-8333-333333333333" as StoreId,
  workspaceId: "a".repeat(64) as WorkspaceId,
  branchScopeId: null,
  branchRef: null,
  sessionId: null,
});

test("projection authority accepts production UUID store identities", () => {
  const decoded = decodeProjectionEvent(storedMemorySourceEvent({ binding: PRODUCTION_BINDING }));
  assert.equal(decoded.kind, "memory-source");
  if (decoded.kind === "memory-source") assert.deepEqual(decoded.binding, PRODUCTION_BINDING);
});

test("projection authority retains sealed SHA-256 evaluator identities", () => {
  assert.doesNotThrow(() => decodeProjectionEvent(storedMemorySourceEvent({ binding: HASH_BINDING })));
});

test("projection authority rejects noncanonical and mixed-case identity tokens", () => {
  for (const projectId of ["project", "11111111-1111-1111-1111-111111111111", "A".repeat(64)]) {
    assert.throws(() => decodeProjectionEvent(storedMemorySourceEvent({
      binding: { ...PRODUCTION_BINDING, projectId: projectId as ProjectId },
    })), /INTEGRITY_FAILURE/);
  }
});
```

Add equivalent UUID cases to manifest parsing, fold restoration, projection checksum, and event-reader snapshot tests.

- [x] **Step 2: Run projection identity tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/projection-source-event-codec.test.js dist-test/tests/projection-folds.test.js dist-test/tests/projection-manifest.test.js dist-test/tests/projection-integrity.test.js
```

Expected: the new production UUID cases fail with `INTEGRITY_FAILURE` or `PROJECTION_CHECKSUM_INVALID`; existing hash fixtures remain green.

- [x] **Step 3: Centralize the transitional strict identity rule.**

Export from `contracts.ts` and reuse everywhere:

```ts
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export function isProjectionProjectStoreIdentity(value: unknown): value is string {
  return typeof value === "string" && (UUID_V4.test(value) || SHA256.test(value));
}

export function isProjectionWorkspaceIdentity(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
```

Project, vault, and store accept only UUIDv4 (production) or lowercase SHA-256 (sealed evaluator compatibility). Workspace remains lowercase SHA-256. Branch scope remains UUID and branch refs retain the current NUL/non-empty checks. Replace local all-fields-are-hash checks in event reader, source codec, folds, manifest, and checksum with the shared predicates. Do not change event payload decoding, fold semantics, checksum domains, manifest schema versions, or public routing.

- [x] **Step 4: Run the complete projection gate.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/projection-source-event-codec.test.js dist-test/tests/projection-folds.test.js dist-test/tests/projection-manifest.test.js dist-test/tests/projection-builder.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-integrity.test.js
npm run typecheck
```

Expected: production UUID and sealed hash identities both pass; malformed strings, wrong UUID versions, uppercase hashes, and scope mismatches fail closed.

- [x] **Step 5: Commit production identity compatibility.**

```powershell
git add src/orchestrator/projections/contracts.ts src/orchestrator/projections/event-reader.ts src/orchestrator/projections/source-event-codec.ts src/orchestrator/projections/folds.ts src/orchestrator/projections/manifest.ts src/orchestrator/projections/checksum.ts tests/projection-source-event-codec.test.ts tests/projection-folds.test.ts tests/projection-manifest.test.ts tests/projection-integrity.test.ts
git commit -m "fix: accept production projection identities"
```

### Task 3: Verify an immutable production-shaped V1 source copy

**Files:**
- Create: `src/orchestrator/migration/v1-source-copy.ts`
- Create: `tests/support/v2-shadow-migration-fixture.ts`
- Create: `tests/v1-source-copy.test.ts`
- Reuse: `src/orchestrator/projections/event-reader.ts:43-497`
- Reuse: `src/orchestrator/integrity/stored-event-authenticator.ts`

**Interfaces:**
- Consumes: `ShadowMigrationPolicyV1`, `ProjectBinding`, `SqliteDriver`, `replayCommittedProjectionEvents`, and canonical path helpers.
- Produces: `V1SourceCopyManifestV1`, `VerifiedV1SourceCopy`, `decodeV1SourceCopyManifestV1`, and `verifyV1SourceCopy(input)`.

- [x] **Step 1: Generate a real source fixture and write failing verification tests.**

The support helper must bootstrap the current store, append events through `EventStore`, checkpoint WAL consistently, write two UTF-8 legacy artifacts, calculate a canonical manifest, and return cleanup paths. Test success plus alias, symlink, hostile relative path, bad sidecar hash, wrong binding, unsupported schema, event-chain tamper, source limit, and post-run mutation:

```ts
test("verifies the complete read-only source and detects later mutation", async (t) => {
  const fixture = await createV2ShadowMigrationFixture(t);
  const verified = await verifyV1SourceCopy({
    driver: fixture.driver,
    sourceRoot: fixture.sourceRoot,
    manifestPath: fixture.manifestPath,
    liveEventStorePath: fixture.liveEventStorePath,
    liveLegacyArtifactRoot: fixture.liveVaultRoot,
    expectedBinding: fixture.projectionBinding,
    policy: fixture.policy,
  });
  assert.equal(verified.manifest.eventCount, fixture.sourceEvents.length);
  assert.equal(verified.manifest.terminalEventHash, fixture.sourceEvents.at(-1)!.eventHash);
  assert.equal([...verified.events()].length, fixture.sourceEvents.length);
  verified.assertUnchanged();
  appendFileSync(fixture.sourceDatabasePath, Buffer.from([0]));
  assert.throws(
    () => verified.assertUnchanged(),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "MIGRATION_SOURCE_MUTATED",
  );
  verified.close();
});

test("rejects a source whose file identity aliases live authority", async (t) => {
  const fixture = await createV2ShadowMigrationFixture(t, { aliasLiveStore: true });
  await assert.rejects(
    verifyV1SourceCopy({ ...fixture.verificationInput }),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "MIGRATION_SOURCE_INVALID",
  );
});
```

- [x] **Step 2: Run the source-copy tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v1-source-copy.test.js
```

Expected: compilation fails because the verifier and fixture helper do not exist.

- [x] **Step 3: Implement stable manifest and file-identity verification.**

Use exact manifest keys and return only a frozen handle. The handle owns the read-only snapshot and closes it exactly once:

```ts
export interface SourceFileDescriptorV1 {
  readonly relativePath: string;
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly ctimeNs: string;
  readonly sha256: string;
}

export interface LegacyArtifactDescriptorV1 extends SourceFileDescriptorV1 {
  readonly mediaType: "text/markdown; charset=utf-8";
}

export interface VerifiedLegacyArtifact {
  readonly descriptor: LegacyArtifactDescriptorV1;
  readChunks(): Iterable<Uint8Array>;
  assertUnchanged(): void;
}

export interface V1SourceCopyManifestV1 {
  readonly schemaVersion: 1;
  readonly copyFormatVersion: 1;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly branchScopeId: string | null;
  readonly branchRef: string | null;
  readonly sourceSchemaVersion: number;
  readonly database: SourceFileDescriptorV1;
  readonly sqliteSidecars: readonly SourceFileDescriptorV1[];
  readonly legacyArtifacts: readonly LegacyArtifactDescriptorV1[];
  readonly eventCount: number;
  readonly aggregateSourceBytes: number;
  readonly terminalEventPosition: string;
  readonly terminalEventHash: string;
  readonly createdAt: string;
  readonly authorizedActorFingerprint: string;
  readonly manifestChecksum: string;
}

export interface VerifiedV1SourceCopy {
  readonly sourceRoot: string;
  readonly manifest: V1SourceCopyManifestV1;
  readonly projectionSnapshot: ProjectionEventSnapshot;
  events(): Iterable<StoredEvent>;
  legacyArtifacts(): Iterable<VerifiedLegacyArtifact>;
  assertUnchanged(): void;
  close(): void;
}
```

Verification order is fixed:

1. Canonicalize the declared roots and reject equality/containment with either live root.
2. `lstat` every component and reject symbolic links, reparse substitutions, non-regular files, duplicate identities, `..`, absolute artifact paths, NULs, and case-folded path collisions.
3. Read the manifest once, validate exact own data fields, recompute `manifestChecksum` over the manifest without that field, and validate policy limits before opening SQLite.
4. Capture `{device,inode,size,ctimeNs,sha256}` for database, sidecars, artifacts, and manifest; compare database identity to the live database identity and artifact-root identity to the live root.
5. Open the database with `read-only-existing`, call `replayCommittedProjectionEvents` through the declared terminal position, and require exact count/bytes/terminal hash and binding.
6. Re-stat and re-hash every captured file before returning. `assertUnchanged()` repeats step 6 and throws `MIGRATION_SOURCE_MUTATED` on any difference.

`aggregateSourceBytes` is the sum of authenticated canonical source-event bytes plus declared legacy-artifact bytes. Database file size and SQLite sidecars are recorded and hashed independently but do not consume the logical 64 MiB import ceiling. Every individual source-event or legacy-artifact record must also fit `maxEventBytes`.

Always close the projection snapshot on a failed verification path. Error `safeDetails` may contain only a category and ordinal, never a source path or artifact name.

- [x] **Step 4: Run verifier, projection-reader, and integrity tests.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v1-source-copy.test.js dist-test/tests/projection-source-event-codec.test.js dist-test/tests/stored-event-authenticator.test.js
npm run typecheck
```

Expected: all tests pass; source files remain byte-identical; all negative cases return only typed redacted errors.

- [x] **Step 5: Commit immutable source verification.**

```powershell
git add src/orchestrator/migration/v1-source-copy.ts tests/support/v2-shadow-migration-fixture.ts tests/v1-source-copy.test.ts
git commit -m "feat: verify immutable V1 migration sources"
```

### Task 4: Seal a canonical content-addressed migration package

**Files:**
- Create: `src/orchestrator/migration/v2-migration-package.ts`
- Create: `tests/v2-migration-package.test.ts`
- Reuse: `src/orchestrator/materialization/atomic-artifact-replacer.ts:21-180`
- Reuse: `src/orchestrator/identity/directory-durability.ts:1-80`

**Interfaces:**
- Consumes: `VerifiedV1SourceCopy`, `ShadowMigrationPolicyV1`, `shadowMigrationIdentity`, build/configuration hashes, and canonical JSON.
- Produces: `V2MigrationPackageManifestV1`, `SealedV2MigrationPackage`, `sealV2MigrationPackage(input)`, and `openSealedV2MigrationPackage(input)`.

- [x] **Step 1: Write failing deterministic-package and tamper tests.**

Pin record order as source events by `globalPosition`, followed by legacy artifacts by normalized relative path. Verify same input in two different absolute staging roots produces the same logical checksums and migration identity:

```ts
test("seals identical logical packages independent of absolute path", async (t) => {
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const left = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const right = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootB });
  assert.equal(left.manifest.packageChecksum, right.manifest.packageChecksum);
  assert.equal(left.migrationIdentity, right.migrationIdentity);
  assert.deepEqual([...left.records()].map((record) => record.descriptor), [...right.records()].map((record) => record.descriptor));
  source.assertUnchanged();
  source.close();
});

test("rejects package replacement and descriptor/value tamper", async (t) => {
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source });
  replaceOnePackageRecord(sealed.rootPath);
  assert.throws(
    () => openSealedV2MigrationPackage({ rootPath: sealed.rootPath, expectedMigrationIdentity: sealed.migrationIdentity }),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "MIGRATION_IDENTITY_CONFLICT",
  );
});
```

- [x] **Step 2: Run package tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-migration-package.test.js
```

Expected: compilation fails because the package writer/reader are absent.

- [x] **Step 3: Implement canonical streaming package publication.**

The package layout is exact and contains no absolute source path:

```text
<packageRoot>/<migrationIdentity>/
  package-manifest.json
  events.ndjson
  artifacts/
    <normalized legacy relative paths>
```

Use these public shapes:

```ts
export type V2MigrationRecordDescriptorV1 = Readonly<{
  schemaVersion: 1;
  ordinal: number;
  kind: "source-event" | "legacy-artifact";
  sourceIdentity: string;
  relativePath: string | null;
  byteLength: number;
  contentSha256: string;
}>;

export interface V2MigrationPackageManifestV1 {
  readonly schemaVersion: 1;
  readonly packageFormatVersion: 1;
  readonly migrationAlgorithmVersion: 1;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly sourceManifestChecksum: string;
  readonly eventCount: number;
  readonly legacyArtifactCount: number;
  readonly aggregateSourceBytes: number;
  readonly terminalEventPosition: string;
  readonly terminalEventHash: string;
  readonly recordDescriptors: readonly V2MigrationRecordDescriptorV1[];
  readonly recordsChecksum: string;
  readonly buildIdentityHash: string;
  readonly configurationChecksum: string;
  readonly creationReasonCode: "production-shaped-rehearsal";
  readonly packageChecksum: string;
}

export interface V2MigrationPackageRecordV1 {
  readonly descriptor: V2MigrationRecordDescriptorV1;
  readChunks(): Iterable<Uint8Array>;
}

export interface SealedV2MigrationPackage {
  readonly rootPath: string;
  readonly migrationIdentity: string;
  readonly manifest: V2MigrationPackageManifestV1;
  records(): Iterable<V2MigrationPackageRecordV1>;
  assertUnchanged(): void;
  close(): void;
}
```

Write every source event as one canonical JSON line containing the exact stored-event envelope including `payloadJson`, `payloadHash`, and event-chain hashes. Copy legacy bytes under `artifacts/` only after verifying their pre-read and post-read identities. Feed record descriptors incrementally into SHA-256 and stop before writing when an event, aggregate, batch, or deadline limit would be exceeded.

Create a sibling temporary directory, fsync every file and directory, verify the complete package through `openSealedV2MigrationPackage`, then rename it to `<migrationIdentity>`. If the target exists, verify and adopt only an exact package; otherwise quarantine the temporary directory. The final directory and every descendant must reject symbolic links and path replacement.

Before publication calculate:

```ts
const packageChecksum = sha256(
  `project-memory/v2-shadow-migration-package/v1\n${canonicalJson(manifestWithoutChecksum)}`,
);
const migrationIdentity = shadowMigrationIdentity({
  projectId, storeId, sourceManifestChecksum, terminalEventHash,
  packageChecksum, migrationAlgorithmVersion: 1,
  buildIdentityHash, configurationChecksum,
});
```

Package sealing does not require a rollout revision because the revision cannot know `migrationIdentityHash` until this checksum exists. Return the verified `migrationIdentity`, `packageChecksum`, and `configurationChecksum`; Task 8 prepares the V1 baseline, and Task 11 requires the immutable rollout revision to match all three values before the first import append.

- [x] **Step 4: Run deterministic package tests.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-migration-package.test.js dist-test/tests/v1-source-copy.test.js
npm run typecheck
```

Expected: all tests pass; two paths yield identical logical checksums; all tamper and replacement cases fail closed; source re-verification remains green.

- [x] **Step 5: Commit package sealing.**

```powershell
git add src/orchestrator/migration/v2-migration-package.ts tests/v2-migration-package.test.ts
git commit -m "feat: seal V2 migration packages"
```

### Task 5: Add schema 7 append-only migration, parity, and compatibility evidence

**Files:**
- Create: `src/orchestrator/storage/migrations/0007-v2-shadow-migration.ts`
- Create: `src/orchestrator/storage/v2-shadow-migration.repository.ts`
- Create: `tests/v2-shadow-migration-repository.test.ts`

**Interfaces:**
- Consumes: migration phases and errors from Task 1, `RolloutRevision`, `SqliteConnection`, and canonical JSON/hash helpers.
- Produces: `V2ShadowMigrationRun`, `V2ShadowMigrationTransition`, `ImportedRecordReceipt`, `StoredParityReport`, `CompatibilityOutboxRecord`, `CompatibilityAcknowledgement`, `V2ShadowMigrationTransaction`, and `SqliteV2ShadowMigrationRepository`.

- [x] **Step 1: Write migration/repository RED tests against real SQLite.**

Cover clean schema creation, exact columns/indexes/triggers, strict types, cross-project foreign keys, duplicate identities, out-of-order phases, transition-hash tamper, imported-record conflicts, immutable rules/reports/outbox/acknowledgements, nested transactions, synchronous callback enforcement, rollback, and connection poison after rollback failure:

```ts
test("schema 7 accepts only the exact hash-chained phase sequence", () => {
  const fixture = repositoryFixture();
  fixture.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => {
    tx.insertRun(RUN);
    tx.appendTransition(transition(0, "snapshot-verified", GENESIS_TRANSITION_HASH));
    assert.throws(
      () => tx.appendTransition(transition(2, "import-committed", "f".repeat(64))),
      (error: unknown) => error instanceof ShadowMigrationError
        && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE",
    );
    tx.appendTransition(transition(1, "package-sealed", transitionHash(0)));
  });
  assert.deepEqual(
    fixture.repository.readVerifiedTransitions(PROJECT_ID, MIGRATION_IDENTITY).map((row) => row.phase),
    ["snapshot-verified", "package-sealed"],
  );
});

test("all semantic evidence rows are immutable", () => {
  const fixture = committedRepositoryFixture();
  for (const table of [
    "v2_shadow_migration_runs", "v2_shadow_migration_transitions", "v2_shadow_migration_attempts",
    "v2_shadow_imported_records", "v2_shadow_expected_difference_rules",
    "v2_shadow_parity_reports", "v2_shadow_compatibility_outbox",
    "v2_shadow_compatibility_claims", "v2_shadow_compatibility_acknowledgements",
  ]) {
    assert.throws(() => fixture.connection.exec(`UPDATE ${table} SET project_id = project_id`));
    assert.throws(() => fixture.connection.exec(`DELETE FROM ${table}`));
  }
});
```

- [x] **Step 2: Run repository tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-repository.test.js
```

Expected: compilation fails because migration 0007 and its repository do not exist.

- [x] **Step 3: Create the guarded schema.**

Migration `version: 7`, name `v2-shadow-migration`, must create these STRICT, WITHOUT ROWID tables:

```sql
CREATE TABLE v2_shadow_migration_runs (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL CHECK (length(migration_identity) = 64 AND migration_identity NOT GLOB '*[^0-9a-f]*'),
  rollout_revision_id TEXT NOT NULL,
  package_checksum TEXT NOT NULL CHECK (length(package_checksum) = 64 AND package_checksum NOT GLOB '*[^0-9a-f]*'),
  source_manifest_checksum TEXT NOT NULL CHECK (length(source_manifest_checksum) = 64 AND source_manifest_checksum NOT GLOB '*[^0-9a-f]*'),
  source_terminal_position INTEGER NOT NULL CHECK (source_terminal_position >= 0),
  source_terminal_hash TEXT NOT NULL CHECK (length(source_terminal_hash) = 64 AND source_terminal_hash NOT GLOB '*[^0-9a-f]*'),
  configuration_checksum TEXT NOT NULL CHECK (length(configuration_checksum) = 64 AND configuration_checksum NOT GLOB '*[^0-9a-f]*'),
  policy_checksum TEXT NOT NULL CHECK (length(policy_checksum) = 64 AND policy_checksum NOT GLOB '*[^0-9a-f]*'),
  build_identity_hash TEXT NOT NULL CHECK (length(build_identity_hash) = 64 AND build_identity_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity),
  FOREIGN KEY (project_id, rollout_revision_id) REFERENCES rollout_revisions(project_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_migration_transitions (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  attempt_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('snapshot-verified','package-sealed','import-committed','projection-verified','parity-complete','compatibility-complete')),
  prior_transition_hash TEXT NOT NULL CHECK (length(prior_transition_hash) = 64 AND prior_transition_hash NOT GLOB '*[^0-9a-f]*'),
  transition_hash TEXT NOT NULL CHECK (length(transition_hash) = 64 AND transition_hash NOT GLOB '*[^0-9a-f]*'),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, ordinal),
  UNIQUE (project_id, migration_identity, phase),
  UNIQUE (project_id, migration_identity, transition_hash),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_migration_attempts (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 0),
  attempt_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('snapshot-verified','package-sealed','import-committed','projection-verified','parity-complete','compatibility-complete')),
  operation TEXT NOT NULL CHECK (length(trim(operation)) BETWEEN 1 AND 64),
  operation_attempt_index INTEGER NOT NULL CHECK (operation_attempt_index >= 0),
  outcome_category TEXT NOT NULL CHECK (outcome_category IN ('retryable-failure','unknown-outcome','retry-exhausted','terminal-failure')),
  safe_error_code TEXT NOT NULL CHECK (length(trim(safe_error_code)) BETWEEN 1 AND 64),
  prior_committed_phase TEXT,
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, attempt_ordinal),
  UNIQUE (project_id, migration_identity, attempt_id),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_imported_records (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('source-event','legacy-artifact')),
  source_record_hash TEXT NOT NULL CHECK (length(source_record_hash) = 64 AND source_record_hash NOT GLOB '*[^0-9a-f]*'),
  imported_event_id TEXT NOT NULL,
  imported_global_position INTEGER NOT NULL CHECK (imported_global_position > 0),
  imported_event_hash TEXT NOT NULL CHECK (length(imported_event_hash) = 64 AND imported_event_hash NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, source_ordinal),
  UNIQUE (project_id, imported_event_id),
  UNIQUE (project_id, imported_global_position),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity)
) STRICT, WITHOUT ROWID;
```

Create the remaining immutable tables with these exact logical columns and constraints; apply the same lowercase-hash byte-length checks used above to every `*_hash`, `*_checksum`, `*_digest`, and `*_fingerprint` column:

```sql
CREATE TABLE v2_shadow_expected_difference_rules (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  category TEXT NOT NULL CHECK (category IN ('semantic-value','representation')),
  projection_name TEXT NOT NULL CHECK (projection_name IN ('sessionTree','sessionCheckpoints','canonicalItems','tasksFollowups','artifactsFiles','entityGraph','lexicalChunks','retrievalFeedback','sealedRetrieval')),
  selector_json TEXT NOT NULL,
  predicate_json TEXT NOT NULL,
  rationale_digest TEXT NOT NULL,
  approver_fingerprint TEXT NOT NULL,
  approval_reference_digest TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  rollout_revision_id TEXT NOT NULL,
  rule_checksum TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, rule_id),
  UNIQUE (project_id, migration_identity, rule_checksum),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity),
  FOREIGN KEY (project_id, rollout_revision_id) REFERENCES rollout_revisions(project_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_parity_reports (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  report_id TEXT NOT NULL,
  package_checksum TEXT NOT NULL,
  compared_event_position INTEGER NOT NULL CHECK (compared_event_position >= 0),
  compared_event_hash TEXT NOT NULL,
  v1_manifest_checksum TEXT NOT NULL,
  v2_manifest_checksum TEXT NOT NULL,
  v1_core_checksums_digest TEXT NOT NULL,
  v2_core_checksums_digest TEXT NOT NULL,
  retrieval_vector_checksum TEXT NOT NULL,
  equal_count INTEGER NOT NULL CHECK (equal_count >= 0),
  expected_difference_count INTEGER NOT NULL CHECK (expected_difference_count >= 0),
  blocking_divergence_count INTEGER NOT NULL CHECK (blocking_divergence_count >= 0),
  report_json TEXT NOT NULL,
  report_checksum TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, report_id),
  UNIQUE (project_id, migration_identity, report_checksum),
  FOREIGN KEY (project_id, migration_identity) REFERENCES v2_shadow_migration_runs(project_id, migration_identity)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_compatibility_outbox (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
  imported_event_id TEXT NOT NULL,
  imported_global_position INTEGER NOT NULL CHECK (imported_global_position > 0),
  imported_event_hash TEXT NOT NULL,
  triggering_payload_hash TEXT NOT NULL,
  relative_path TEXT NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 1024),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  content_sha256 TEXT NOT NULL,
  materialization_revision INTEGER NOT NULL CHECK (materialization_revision > 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, outbox_id),
  UNIQUE (project_id, migration_identity, source_ordinal),
  FOREIGN KEY (project_id, migration_identity, source_ordinal)
    REFERENCES v2_shadow_imported_records(project_id, migration_identity, source_ordinal)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_compatibility_claims (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  claim_owner_fingerprint TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, outbox_id),
  UNIQUE (project_id, migration_identity, claim_id),
  FOREIGN KEY (project_id, migration_identity, outbox_id)
    REFERENCES v2_shadow_compatibility_outbox(project_id, migration_identity, outbox_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE v2_shadow_compatibility_acknowledgements (
  project_id TEXT NOT NULL,
  migration_identity TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  acknowledgement_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  acknowledged_imported_position INTEGER NOT NULL CHECK (acknowledged_imported_position > 0),
  materialization_revision INTEGER NOT NULL CHECK (materialization_revision > 0),
  target_content_sha256 TEXT NOT NULL,
  acknowledgement_checksum TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (project_id, migration_identity, outbox_id),
  UNIQUE (project_id, migration_identity, acknowledgement_id),
  FOREIGN KEY (project_id, migration_identity, outbox_id)
    REFERENCES v2_shadow_compatibility_claims(project_id, migration_identity, outbox_id)
) STRICT, WITHOUT ROWID;
```

Strict row decoders must canonical-parse `selector_json`, `predicate_json`, and `report_json` and verify their stored checksums. No table stores an absolute root. Compatibility claims and acknowledgements are append-only and unique per outbox record.

Add `BEFORE UPDATE` and `BEFORE DELETE` abort triggers named `<table>_no_update` and `<table>_no_delete` for every table. Add `BEFORE INSERT` guards that reject replacement conflicts with `V2_SHADOW_IMMUTABLE`; a transition guard requires `ordinal = prior ordinal + 1`, exact next phase, and prior hash equality. Attempt rows have their own monotonically increasing `attempt_ordinal` and never consume or unblock a committed phase.

- [x] **Step 4: Implement strict transaction and reconciliation reads.**

Use a synchronous callback transaction like the rollout repository. Public operations are exact:

```ts
export interface V2ShadowMigrationRun {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly rolloutRevisionId: string;
  readonly packageChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly sourceTerminalPosition: bigint;
  readonly sourceTerminalHash: string;
  readonly configurationChecksum: string;
  readonly policyChecksum: string;
  readonly buildIdentityHash: string;
  readonly createdAt: string;
}

export interface V2ShadowMigrationTransition {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly ordinal: number;
  readonly attemptId: string;
  readonly phase: ShadowMigrationPhase;
  readonly priorTransitionHash: string;
  readonly transitionHash: string;
  readonly evidenceDigest: string;
  readonly recordedAt: string;
}

export interface V2ShadowMigrationAttemptEvidence {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly attemptOrdinal: number;
  readonly attemptId: string;
  readonly phase: ShadowMigrationPhase;
  readonly operation: string;
  readonly operationAttemptIndex: number;
  readonly outcomeCategory: "retryable-failure" | "unknown-outcome" | "retry-exhausted" | "terminal-failure";
  readonly safeErrorCode: string;
  readonly priorCommittedPhase: ShadowMigrationPhase | null;
  readonly evidenceDigest: string;
  readonly recordedAt: string;
}

export interface ImportedRecordReceipt {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly sourceOrdinal: number;
  readonly sourceKind: "source-event" | "legacy-artifact";
  readonly sourceRecordHash: string;
  readonly importedEventId: string;
  readonly importedGlobalPosition: bigint;
  readonly importedEventHash: string;
  readonly recordedAt: string;
}

export interface StoredExpectedDifferenceRule {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly ruleId: string;
  readonly policyVersion: number;
  readonly category: "semantic-value" | "representation";
  readonly projectionName: ProjectionName;
  readonly selector: Readonly<{ rowIdentityHash: string; fieldPath: string }>;
  readonly predicate: Readonly<{
    operator: "exact-value-hashes";
    v1ValueHash: string;
    v2ValueHash: string;
  }>;
  readonly rationaleDigest: string;
  readonly approverFingerprint: string;
  readonly approvalReferenceDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly rolloutRevisionId: string;
  readonly ruleChecksum: string;
}

export interface StoredParityReport {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly reportId: string;
  readonly packageChecksum: string;
  readonly comparedEventPosition: bigint;
  readonly comparedEventHash: string;
  readonly v1ManifestChecksum: string;
  readonly v2ManifestChecksum: string;
  readonly v1CoreChecksumsDigest: string;
  readonly v2CoreChecksumsDigest: string;
  readonly retrievalVectorChecksum: string;
  readonly equalCount: number;
  readonly expectedDifferenceCount: number;
  readonly blockingDivergenceCount: number;
  readonly report: Readonly<Record<string, unknown>>;
  readonly reportChecksum: string;
  readonly recordedAt: string;
}

export interface CompatibilityClaim {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly outboxId: string;
  readonly claimId: string;
  readonly claimOwnerFingerprint: string;
  readonly claimedAt: string;
}

export interface CompatibilityAcknowledgement {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly outboxId: string;
  readonly acknowledgementId: string;
  readonly claimId: string;
  readonly acknowledgedImportedPosition: bigint;
  readonly materializationRevision: bigint;
  readonly targetContentSha256: string;
  readonly acknowledgementChecksum: string;
  readonly acknowledgedAt: string;
}

export interface V2ShadowMigrationTransaction {
  readRun(): V2ShadowMigrationRun | null;
  insertRun(run: V2ShadowMigrationRun): void;
  readTransitions(): readonly V2ShadowMigrationTransition[];
  appendTransition(transition: V2ShadowMigrationTransition): void;
  readAttemptEvidence(): readonly V2ShadowMigrationAttemptEvidence[];
  appendAttemptEvidence(attempt: V2ShadowMigrationAttemptEvidence): void;
  readImportedRecords(): readonly ImportedRecordReceipt[];
  insertImportedRecords(records: readonly ImportedRecordReceipt[]): void;
  insertExpectedDifferenceRules(rules: readonly StoredExpectedDifferenceRule[]): void;
  readExpectedDifferenceRules(): readonly StoredExpectedDifferenceRule[];
  insertParityReport(report: StoredParityReport): void;
  readParityReport(): StoredParityReport | null;
  enqueueCompatibility(records: readonly CompatibilityOutboxRecord[]): void;
  readPendingCompatibility(): readonly CompatibilityOutboxRecord[];
  claimCompatibility(claim: CompatibilityClaim): CompatibilityClaim;
  acknowledgeCompatibility(ack: CompatibilityAcknowledgement): void;
  readCompatibilityAcknowledgements(): readonly CompatibilityAcknowledgement[];
}

export class SqliteV2ShadowMigrationRepository {
  transact<T>(projectId: string, migrationIdentity: string, callback: (tx: V2ShadowMigrationTransaction) => T): T;
  readVerifiedTransitions(projectId: string, migrationIdentity: string): readonly V2ShadowMigrationTransition[];
}
```

Decode every SQLite row with exact keys, bigint int64 checks, canonical timestamps, UUID/hash checks, and canonical JSON round-trip. Recompute transition hashes using domain `project-memory/v2-shadow-migration-transition/v1` on every read. SQLite busy errors remain available to the runner for retry classification; immutability, decoding, order, or hash errors become `MIGRATION_LEDGER_INTEGRITY_FAILURE`.

- [x] **Step 5: Run schema/repository verification.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-repository.test.js dist-test/tests/rollout-control-plane.test.js
npm run typecheck
```

Expected: all tests pass; the repository is transaction-bound, append-only, fail-closed, and returns frozen decoded data.

- [x] **Step 6: Commit schema 7 repository work.**

```powershell
git add src/orchestrator/storage/migrations/0007-v2-shadow-migration.ts src/orchestrator/storage/v2-shadow-migration.repository.ts tests/v2-shadow-migration-repository.test.ts
git commit -m "feat: persist V2 shadow migration evidence"
```

### Task 6: Import package records as deterministic committed V2 shadow events

**Files:**
- Create: `src/orchestrator/migration/v2-shadow-importer.ts`
- Create: `tests/v2-shadow-importer.test.ts`
- Correct upstream dependency: `src/orchestrator/migration/v2-migration-package.ts`
- Test upstream dependency: `tests/v2-migration-package.test.ts`
- Reuse: `src/orchestrator/storage/event-store.ts:40-110`
- Reuse: `src/orchestrator/storage/event-append-transaction.ts:48-49,1480-1833`

**Interfaces:**
- Consumes: `SealedV2MigrationPackage`, `EventStore`, `SqliteEventAppendStatements`, `MaintenanceFence`, `BranchScopeRepository`, migration repository transactions, and policy batch limits.
- Produces: `V2ShadowImportResult`, `V2ShadowImporter.import(input)`, exact wrapper payloads, and deterministic replay receipts.

**Implementation correction (2026-09-11):** Task 4 omitted the `createdAt` field consumed by Step 4 below. Add the required canonical timestamp to the exact package manifest, copying only the verified `source.manifest.createdAt`; include it in the existing package checksum and migration identity. Reject missing or invalid timestamps without a fallback. This corrects the local producer/consumer contract; it does not change the approved rollout boundary. Task 6 is complete at `8f2c3d6` after independent specification and quality approval; round 2 package-inclusive gate passed 98/98 and round 3 importer/EventStore gate passed 76/76, with build and typecheck passing.

- [x] **Step 1: Write import RED tests with production EventStore.**

Prove wrapper events are committed/authenticated, batch limits use the stricter of migration policy and event-store bounds, three isolated imports produce identical event IDs/hashes, replay is a no-op, package identity reuse with changed bytes conflicts, and a crash after commit is reconciled by the same deterministic command:

```ts
test("imports every package record exactly once as authenticated V2 events", async (t) => {
  const fixture = await sealedPackageFixture(t);
  const first = await fixture.importer.import(fixture.importInput);
  const second = await fixture.importer.import(fixture.importInput);
  assert.equal(first.recordCount, fixture.package.manifest.recordDescriptors.length);
  assert.deepEqual(second, { ...first, deduplicated: true });
  const stored = readAllStoredEvents(fixture.targetConnection);
  assert.equal(stored.length, first.recordCount);
  let cursor = { expectedPosition: 1n, previousEventHash: GENESIS_GLOBAL_HASH };
  for (const event of stored) cursor = authenticateStoredEvent(event, cursor).nextCursor;
});

test("reconciles after commit-before-ledger-receipt without a second semantic append", async (t) => {
  const fixture = await sealedPackageFixture(t, { failAfterBatchCommit: 1 });
  await assert.rejects(fixture.importer.import(fixture.importInput), isUnknownOutcome);
  fixture.disableFaults();
  const recovered = await fixture.importer.import(fixture.importInput);
  assert.equal(recovered.recordCount, fixture.package.manifest.recordDescriptors.length);
  assert.equal(countImportedEvents(fixture.targetConnection), recovered.recordCount);
  assert.equal(new Set(recovered.eventIds).size, recovered.eventIds.length);
});
```

- [x] **Step 2: Run importer tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-importer.test.js
```

Expected: compilation fails because the importer and wrapper contracts do not exist.

- [x] **Step 3: Define exact wrapper events and deterministic batch planning.**

Use two event types in one migration stream `v2-shadow-import/<migrationIdentity>`:

```ts
export interface V1ProjectionSourceImportedV1 {
  readonly schemaVersion: 1;
  readonly migrationIdentity: string;
  readonly sourceOrdinal: number;
  readonly sourceRecordHash: string;
  readonly sourceEvent: Readonly<{
    globalPosition: string;
    eventId: string;
    projectId: string;
    vaultId: string;
    storeId: string;
    workspaceId: string;
    branchScopeId: string | null;
    branchRef: string | null;
    streamId: string;
    streamType: string;
    streamVersion: string;
    eventType: string;
    eventSchemaVersion: number;
    sessionId: string | null;
    parentSessionId: string | null;
    actorRole: string;
    agentId: string;
    clientInstanceId: string;
    correlationId: string;
    causationId: string | null;
    commandId: string;
    idempotencyKey: string;
    commandEventIndex: number;
    occurredAt: string;
    recordedAt: string;
    visibilityScope: string;
    confidence: string;
    verificationStatus: string;
    sourceRefs: readonly string[];
    evidenceRefs: readonly [];
    evidenceDigests: readonly [];
    payloadJson: string;
    payloadHash: string;
    previousGlobalHash: string;
    eventHash: string;
    lifecycleIntentJson: string | null;
  }>;
}

export interface V1LegacyArtifactImportedV1 {
  readonly schemaVersion: 1;
  readonly migrationIdentity: string;
  readonly sourceOrdinal: number;
  readonly sourceRecordHash: string;
  readonly relativePath: string;
  readonly contentSha256: string;
  readonly contentUtf8: string;
}

export interface V2ShadowImportResult {
  readonly schemaVersion: 1;
  readonly migrationIdentity: string;
  readonly packageChecksum: string;
  readonly recordCount: number;
  readonly eventIds: readonly string[];
  readonly firstImportedPosition: bigint | null;
  readonly terminalImportedPosition: bigint | null;
  readonly terminalImportedEventHash: string;
  readonly importedEventsChecksum: string;
  readonly deduplicated: boolean;
}
```

The package reader validates values before the importer constructs these payloads. Artifact bytes must round-trip through `TextDecoder("utf-8", { fatal: true })` and `Buffer.from(contentUtf8, "utf8")` to the declared byte length/hash.

Batch planning must satisfy all four limits simultaneously:

```ts
const maxEvents = Math.min(policy.maxBatchEvents, MAX_EVENTS_PER_COMMAND);
const maxBytes = Math.min(policy.maxBatchBytes, MAX_CANONICAL_COMMAND_BYTES);
```

Start a new batch before either next event would exceed `maxEvents` or the canonical command would exceed `maxBytes`; a single event beyond `maxEventBytes` fails `MIGRATION_LIMIT_EXCEEDED`.

- [x] **Step 4: Append deterministic commands and reconcile receipts.**

For batch ordinal `b`, derive command ID, idempotency key, correlation ID, event IDs, recorded time, and public response exclusively from migration identity/package contents. Instantiate an `EventStore` per batch with a deterministic UUID closure seeded by the source ordinals in that batch and a deterministic clock derived from `manifest.createdAt + b milliseconds`.

Wrapper principal metadata is internal migration metadata: use the existing least-authority `untrusted` role and a domain-prefixed client instance identity derived from `migrationIdentity`. Presenting caller role/client identity and checkout branch metadata must not change wrapper hashes. Preserve the original principal and scope provenance exactly inside authenticated `sourceEvent`; do not mutate the caller context or add lifecycle authority. Verify determinism across genuinely distinct input contexts as well as isolated stores.

Each pending event uses `visibilityScope: "project"`, empty evidence arrays, `confidence: "high"`, `verificationStatus: "verified"`, and a source reference `migration:<migrationIdentity>:<sourceOrdinal>`. Use `eventType: "V1ProjectionSourceImported"` for source events and `eventType: "V1LegacyArtifactImported"` for artifacts.

After `EventStore.append`, read the exact committed stored events by returned positions, match payload migration identity/ordinal/hash, and insert `ImportedRecordReceipt` rows in the ledger transaction. If append returns `COMMAND_OUTCOME_UNKNOWN`, repeat the same deterministic append: a committed batch returns the deduplicated stored response; an absent batch commits once; a conflicting response fails `MIGRATION_IDENTITY_CONFLICT`. Never issue a new command ID for the same batch.

- [x] **Step 5: Run importer and event-store regression tests.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-importer.test.js dist-test/tests/event-store.test.js dist-test/tests/event-append-transaction.test.js
npm run typecheck
```

Expected: all tests pass; imported event IDs/hashes are deterministic across isolated stores; replay adds no events; unknown outcome cannot duplicate data.

- [x] **Step 6: Commit deterministic import.**

```powershell
git add src/orchestrator/migration/v2-shadow-importer.ts tests/v2-shadow-importer.test.ts
git commit -m "feat: import deterministic V2 shadow events"
```

### Task 7: Reconstruct authenticated projection input only from committed imports

**Files:**
- Create: `src/orchestrator/migration/v2-imported-event-reader.ts`
- Create: `tests/v2-imported-event-reader.test.ts`
- Reuse: `src/orchestrator/projections/event-reader.ts:43-79`
- Reuse: `src/orchestrator/integrity/stored-event-authenticator.ts`

**Interfaces:**
- Consumes: `ProjectionEventReader`, committed wrapper events, package manifest, import receipts, and production stored-event authentication.
- Produces: `V2ImportedProjectionEventReader` and a `ProjectionEventSnapshot` whose binding/terminal position/hash are the verified original V1 snapshot values.

- [x] **Step 1: Write committed-authority RED tests.**

```ts
test("reconstructs source events only when wrapper and ledger receipts agree", async (t) => {
  const fixture = await importedPackageFixture(t);
  const snapshot = await fixture.reader.openCommittedSnapshot(fixture.sourceBinding);
  assert.deepEqual([...snapshot.events()], fixture.sourceEvents);
  assert.equal(snapshot.terminalEventPosition, BigInt(fixture.package.manifest.terminalEventPosition));
  assert.equal(snapshot.terminalEventHash, fixture.package.manifest.terminalEventHash);
  snapshot.close();
});

test("rejects package bytes that were never committed as wrapper events", async (t) => {
  const fixture = await importedPackageFixture(t, { omitImportedReceiptOrdinal: 1 });
  await assert.rejects(
    fixture.reader.openCommittedSnapshot(fixture.sourceBinding),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE",
  );
});
```

Also cover duplicate/missing/reordered ordinals, wrapper payload tamper, receipt event-ID/position/hash mismatch, artifact wrapper appearing as a projection source, nested import wrapper, wrong migration identity, wrong source binding, broken original event chain, and close idempotence.

- [x] **Step 2: Run imported-reader tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-imported-event-reader.test.js
```

Expected: compilation fails because the committed-import reader does not exist.

- [x] **Step 3: Implement the authenticated reconstruction boundary.**

The public reader surface is exact:

```ts
export class V2ImportedProjectionEventReader implements ProjectionEventReader {
  constructor(options: V2ImportedProjectionEventReaderOptions);
  openSnapshot(binding: ProjectBinding): Promise<ProjectionEventSnapshot>;
  openCommittedSnapshot(binding: ProjectBinding): Promise<ProjectionEventSnapshot>;
}
```

`openCommittedSnapshot(binding)` must:

1. Read and authenticate the target store's complete wrapper-event chain through the last import receipt.
2. Require one ledger receipt for every package record and exact equality of wrapper event ID, global position, event hash, source ordinal, and source record hash.
3. Ignore `V1LegacyArtifactImported` only after verifying its receipt; reject every unknown event in the migration stream.
4. Decode each `V1ProjectionSourceImported.sourceEvent` with exact fields, canonical `payloadJson`, `payloadHash`, UUID/hash/timestamp/int64 checks, and reject a nested import event type.
5. Re-run `authenticateStoredEvent` sequentially over reconstructed source events, beginning at `GENESIS_GLOBAL_HASH`, and require count, aggregate bytes, terminal position, and terminal hash from the sealed package.
6. Return a frozen snapshot whose `events()` can be iterated once per call without exposing mutable payload objects and whose `close()` closes all SQLite snapshots exactly once.

Use the package's source binding as snapshot authority; do not substitute the target wrapper-event binding or wrapper terminal position.

- [x] **Step 4: Run reader and source-codec tests.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-imported-event-reader.test.js dist-test/tests/projection-source-event-codec.test.js dist-test/tests/stored-event-authenticator.test.js
npm run typecheck
```

Expected: all tests pass; only committed/authenticated wrappers can become projection input; original event identity and chain remain exact.

- [x] **Step 5: Commit the committed-import reader.**

```powershell
git add src/orchestrator/migration/v2-imported-event-reader.ts tests/v2-imported-event-reader.test.ts
git commit -m "feat: read projections from committed imports"
```

### Task 8: Publish and verify V1-reference and V2-shadow projections at one source position

**Files:**
- Create: `src/orchestrator/migration/v2-shadow-projection.ts`
- Create: `tests/v2-shadow-projection.test.ts`
- Modify: `src/orchestrator/projections/integrity.ts` (narrow committed-snapshot verification seam; preserve existing `verify()` behavior)
- Test: `tests/projection-integrity.test.ts`
- Modify: `src/orchestrator/projections/builder.ts` (narrow legacy private-image connection verification helper; preserve existing build behavior)
- Test: `tests/projection-builder.test.ts` (only covering helper regressions if needed)
- Modify: `src/orchestrator/projections/schema.ts` (align only V1/V2 project/vault/store metadata predicates with the approved identity codec)
- Test: `tests/projection-schema.test.ts`
- Reuse: `src/orchestrator/projections/builder.ts:829-1018`
- Reuse: `src/orchestrator/projections/coordinator.ts:544-705`
- Reuse: `src/orchestrator/projections/integrity.ts:1183-1240`

**Interfaces:**
- Consumes: the verified V1 source snapshot, `V2ImportedProjectionEventReader`, `ImmutableProjectionBuilder`, `V2ProjectionBuildCoordinator`, `ProjectionIntegrityService`, package/ledger identities, and rollout `v1BaselineChecksum`.
- Produces: `PreparedV1ProjectionBaseline`, `ShadowProjectionResult`, `v1ProjectionBaselineChecksum`, `V2ShadowProjectionPublisher.prepareV1Baseline(input)`, and `V2ShadowProjectionPublisher.publishV2(input)`.

**Producer/consumer correction (2026-09-11):** The current integrity service can replay only an event-store path; it cannot consume the Task 7 reader. Add a separate committed-snapshot verification method that authenticates original events and enforces binding, terminal, count, and byte limits while reusing the existing row/image checks. Keep the existing SQLite `verify()` entry unchanged. The publisher must obtain this snapshot from Task 7 and close it reliably. Use `preparedV1.generation.manifest`, as declared by the interface below. Fixture setup must prepare the baseline before target import, then bind the rollout revision and import; the original shorthand example below is not permission to import before baseline preparation.

For the V1 image recheck, expose a narrow `verifyLegacyProjectionConnection` helper from the builder to reuse its legacy structure, canonical row/core-checksum, and FTS checks. Its connection must be a private deserialized in-memory image owned and closed by the integrity service; the helper's FTS integrity command must never write the published image or source. Keep dependencies one-way from integrity to builder and preserve the normal builder behavior. Test published-image tamper, unchanged original/published bytes, and cleanup failures. This does not implement Task 9's canonical snapshot export early.

Task 2's production identity codec also applies at the SQLite projection metadata boundary: align the six V1/V2 project/vault/store CHECK predicates with exact UUIDv4 or legacy lowercase SHA256. Keep workspace SHA256-only, preserve identity values, schema versions, row layouts, and frozen event-store migrations. The integrity schema checker must retain support for genuine legacy-hash images using the exact historical CHECK shape as well as the current strict shape; no arbitrary schema relaxation is allowed. Add production-writer UUID and direct SQL acceptance/rejection regressions, including the historical image case.

- [x] **Step 1: Write real publication RED tests.**

Use separate absolute directories for the V1 reference and V2 shadow generations. Prove both manifests bind to the original source terminal position/hash, V2 integrity replays from committed imports, rollout baseline checksum is exact, and a target wrapper event or published database tamper fails before the phase transition:

```ts
test("publishes both projection generations at the exact source position", async (t) => {
  const fixture = await importedPackageFixture(t);
  const preparedV1 = await fixture.projectionPublisher.prepareV1Baseline(fixture.v1BaselineInput);
  fixture.assertRevisionBinding(preparedV1);
  const result = await fixture.projectionPublisher.publishV2({
    ...fixture.projectionInput,
    preparedV1,
  });
  assert.equal(result.v1.generation.manifest.terminalEventPosition, fixture.package.manifest.terminalEventPosition);
  assert.equal(result.v2.manifest.terminalEventPosition, fixture.package.manifest.terminalEventPosition);
  assert.equal(result.v1.generation.manifest.terminalEventHash, fixture.package.manifest.terminalEventHash);
  assert.equal(result.v2.manifest.terminalEventHash, fixture.package.manifest.terminalEventHash);
  assert.equal(result.v1BaselineChecksum, fixture.rolloutRevision.v1BaselineChecksum);
  assert.deepEqual(fixture.repository.phases(), [
    "snapshot-verified", "package-sealed", "import-committed", "projection-verified",
  ]);
});

test("does not record projection-verified after generation tamper", async (t) => {
  const fixture = await importedPackageFixture(t, { corruptV2BeforeIntegrityCheck: true });
  await assert.rejects(
    fixture.projectionPublisher.publishV2(fixture.projectionInput),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "PROJECTION_INTEGRITY_FAILURE",
  );
  assert.equal(fixture.repository.phases().includes("projection-verified"), false);
});
```

- [x] **Step 2: Run projection publication tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-projection.test.js
```

Expected: compilation fails because the Slice-2 projection publisher and baseline checksum do not exist.

- [x] **Step 3: Build deterministic reference and shadow generations.**

Before import, open a snapshot directly from the verified read-only V1 source. Instantiate the V1 builder with `now: () => package.manifest.createdAt`, call `ImmutableProjectionBuilder.build(snapshot, 1)` in the isolated V1-reference directory, reopen/verify its immutable bytes, and return `PreparedV1ProjectionBaseline`. This value supplies `v1BaselineChecksum` when the rollout revision is created or checked.

Persist the verified V1 manifest with the existing atomic manifest publisher under the isolated V1 publication lease. Repeated `prepareV1Baseline` calls must capture, parse, and fully verify the existing manifest/image against the same source/package and return the identical baseline without rewriting it. Cover the unknown-outcome gap after generation publication but before manifest publication; reconcile only with authenticated expected source/package identity, never by trusting orphan metadata or deleting/rebuilding the existing image.

For this bounded orphan case only, the integrity service may recover the fixed baseline generation by pinning its raw image, verifying exact V1 schema against the existing canonical schema source, replay-derived rows/core checksums, and all expected metadata including the package clock. Derive the candidate manifest solely from verified source/package binding and terminal identity, fixed generation/name, replay checksums, and the verified pinned image SHA. The builder helper may return frozen replay checksums and compare optional expected checksums when a manifest already exists. Revalidate source/package/directory/image before atomic manifest adoption; reject malformed or tampered orphans without modifying them. Reuse existing schema-checking machinery and preserve its V2 default behavior.

After import, open only the committed-import reader from Task 7, instantiate the V2 builder with the same deterministic `now`, and call `V2ProjectionBuildCoordinator.ensurePublished(binding, terminalPosition, remainingDeadlineMs)` in the isolated V2 directory. The publisher must re-read and verify the already prepared V1 generation before comparison; it never rebuilds V1 from package bytes or target wrapper events.

Calculate the baseline only from canonical logical fields:

```ts
export function v1ProjectionBaselineChecksum(manifest: ProjectionManifestV1): string {
  return sha256(
    `project-memory/v1-shadow-baseline/v1\n${canonicalJson({
      projectId: manifest.projectId,
      vaultId: manifest.vaultId,
      storeId: manifest.storeId,
      workspaceId: manifest.workspaceId,
      branchScopeId: manifest.branchScopeId,
      branchRef: manifest.branchRef,
      terminalEventPosition: manifest.terminalEventPosition,
      terminalEventHash: manifest.terminalEventHash,
      coreChecksums: manifest.coreChecksums,
    })}`,
  );
}

export interface ShadowProjectionResult {
  readonly v1: PreparedV1ProjectionBaseline;
  readonly v2: PublishedProjectionGenerationV2;
  readonly v1BaselineChecksum: string;
  readonly v2ManifestChecksum: string;
}
```

```ts
export interface PreparedV1ProjectionBaseline {
  readonly generation: BuiltProjectionGeneration;
  readonly baselineChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly terminalEventPosition: string;
  readonly terminalEventHash: string;
}
```

Require V1 and V2 binding fields, terminal position, and terminal hash to equal the sealed package; require the calculated V1 baseline to equal the rollout revision. Run the separate `ProjectionIntegrityService` committed-snapshot verification method for V2 with a snapshot from the committed-import reader, and verify the V1 database SHA/core checksums by reopening its immutable image. Only then append `projection-verified` with evidence digest over both manifests and baseline hashes.

- [x] **Step 4: Run full projection regression.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-projection.test.js dist-test/tests/projection-schema.test.js dist-test/tests/projection-builder.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-integrity.test.js dist-test/tests/v2-reader-lease.test.js
npm run typecheck
```

Expected: all tests pass; both generations are position-aligned; no path-based trust or uncommitted package read can enter the V2 projection.

- [x] **Step 5: Commit verified projection publication.**

```powershell
git add src/orchestrator/migration/v2-shadow-projection.ts tests/v2-shadow-projection.test.ts
git commit -m "feat: verify V2 shadow projections"
```

### Task 9: Govern expected differences and emit typed snapshot-aligned parity

**Files:**
- Create: `src/orchestrator/parity/v2-expected-difference.ts`
- Create: `src/orchestrator/parity/v2-snapshot-parity.ts`
- Create: `tests/v2-snapshot-parity.test.ts`
- Modify: `tests/support/v2-shadow-migration-fixture.ts` (production-backed parity/retrieval factories; preserve existing fixture defaults)
- Modify: `src/orchestrator/projections/integrity.ts:400-470,1183-1240`
- Test: `tests/projection-integrity.test.ts`
- Modify: `src/orchestrator/storage/v2-shadow-migration.repository.ts` (narrow governed-rule checksum mapping; preserve schema and unrelated ledger behavior)
- Test: `tests/v2-shadow-migration-repository.test.ts`
- Modify: `src/orchestrator/projections/builder.ts` (expose verified schema-V1 logical rows through the existing private-image helper without duplicating table definitions or changing normal builds)
- Test: `tests/projection-builder.test.ts` (only if the helper change needs additional coverage beyond the new integrity/parity tests)
- Modify: `src/orchestrator/retrieval/evaluation.ts` (six production-or-legacy identity decoders and narrowly scoped source-event lifecycle witness parsing; preserve generic secret guards and evaluation semantics)
- Test: `tests/retrieval-evaluation.test.ts` (production UUID/witness round trip, malformed identities/witnesses, secret rejection, and legacy corpus preservation)
- Modify: `src/orchestrator/retrieval/contracts.ts` (only internal request binding project/vault/store identity validation through the existing shared predicate)
- Test: `tests/retrieval-service.test.ts` (production/legacy request identity acceptance and hostile identity rejection; existing service behavior unchanged)
- Modify: `tests/fixtures/project-store-lifecycle-runtime-worker.ts` (optional validated root-checkpoint fixture overrides only; private authority/defaults unchanged)
- Create: `tests/v2-parity-lifecycle-fixture.test.ts` (default operation, valid repeated checkpoint/artifact history, malformed/authority override rejection)
- Create: `tests/support/recording-git-command-runner.ts` (bounded fixture diagnostic decorator around the unchanged production Git runner)
- Create: `tests/recording-git-command-runner.test.ts` (production delegation, bounded retry and diagnostic regression)
- Modify: `tests/fixtures/project-store-lifecycle-child.ts` (extract only the existing recording Git runner into the test helper; no lifecycle/context/protocol changes)

**Interfaces:**
- Consumes: verified V1/V2 projection generations, rollout revision/migration identity, migration policy rule version/age, repository rule/report operations, existing canonical projection row readers, `SealedRetrievalEvaluationCorpusV2`, and two internal retrieval services bound to the pinned V1/V2 generations.
- Produces: `ExpectedDifferenceRuleV1`, `decodeExpectedDifferenceRuleV1`, `expectedDifferenceRuleChecksum`, `ParityClassification`, `RedactedParityFindingV1`, `SealedRetrievalParityV1`, `SnapshotParityReportV1`, `SnapshotParityReportJsonV1`, `serializeSnapshotParityReport`, `snapshotParityReportChecksum`, `readVerifiedCanonicalProjectionSnapshot`, and `compareV1V2Snapshots(input)`.

**Producer/consumer corrections (2026-09-11):** The repository currently hashes only `{ selector, predicate }` for an expected-difference rule. Replace that provisional mapping with one shared pure checksum over the complete public `ExpectedDifferenceRuleV1` envelope excluding only `ruleChecksum`, prefixed by `project-memory/v2-expected-difference-rule/v1\n`. The stored shape maps `projectionName` to `projection`, flattens `selector`, and supplies fixed `schemaVersion: 1`; all remaining governance, approval, time, revision, and migration fields must be preserved and authenticated. Keep project scoping enforced by the repository/run binding. No schema-7 DDL or frozen migration change is needed; reject the obsolete narrow checksum rather than accepting two meanings. Cover public-to-storage round trips and altered governance fields under an unchanged checksum in real SQLite tests.

`compareV1V2Snapshots` is asynchronous because sealed retrieval evaluation is asynchronous. Use the declared `sealedRetrieval` field consistently. Keep `comparedEventPosition` as bigint in memory, but expose an explicit JSON-safe report serializer that encodes it as exact canonical decimal text, with no lossy Number conversion or global bigint patch. Calculate `reportChecksum` as SHA-256 of canonical JSON of that redacted body excluding its own checksum; store that body in `StoredParityReport.report` and the identical checksum in the checksum column. On adoption, decode the body and verify all duplicated identity/count/hash columns agree before using its evidence. Test values beyond Number.MAX_SAFE_INTEGER at the serialization boundary, stored-body consistency, and deterministic no-plaintext output.

The pure rule module exports `expectedDifferenceRuleChecksum(rule: Omit<ExpectedDifferenceRuleV1, "ruleChecksum">): string`; it must not import the repository that consumes it. The parity module exports `SnapshotParityReportJsonV1 = Readonly<Omit<SnapshotParityReportV1, "comparedEventPosition"> & { comparedEventPosition: string }>`, `serializeSnapshotParityReport(report: SnapshotParityReportV1): SnapshotParityReportJsonV1`, and `snapshotParityReportChecksum(report: Omit<SnapshotParityReportV1, "reportChecksum">): string` with the exact body mapping above. Validate own-data inputs before canonicalizing; do not invoke caller accessors or silently discard extra keys.

Before any rule/report/phase transaction, enforce the same target connection ownership restored by Task 8: the repository used for writes must be constructed from the file-identity-verified isolated target connection, not independently injected from an unchecked store. Verify the run/revision/package/terminal bindings before accepting evidence; test wrong/protected target refusal. Preserve the protected-root and error-redaction contracts, and raise a concrete narrow shared-helper need before widening runtime file scope.

The Task 8 target guard is private. Keep the equivalent narrow path/connection identity and protected source/package/live/projection-root checks private in the new parity module, revalidating before write transactions; do not widen Task 8's runtime scope just to extract a helper. These checks never authorize reopening a supplied independent repository.

The governed integration fixture must use a real, source-authenticated schema difference: V1 omits artifact `symbol`, whereas V2 persists present null for V1-compatible checkpoint artifacts. Non-null symbol comes from governed schema-3 memory sources, which the V1 decoder/fold rejects; do not widen that boundary to manufacture the fixture. Absence remains distinct from present null/value. Use a separate exact representation rule for each eligible metadata-only difference, including `commit_hash` and `heading` if the comparison view exposes their corresponding absent/null distinction; never silently omit extra fields to force a single finding. The fixture must pass ordinary image/source integrity; do not mutate a summary or inject unverified rows to manufacture an approved difference. A changed summary belongs in the blocking integrity matrix because both authentic writers preserve it. Follow-up active/terminal status is protected authority and is never exception-eligible. Independent retrieval/citation drift remains blocking even when a metadata representation rule matches. Cover unsupported source rejection separately.

For retrieval, retain the existing V1 candidate repository for the V1 lease. The V2 side must use `V2SqliteRetrievalCandidateRepository` with the original verified V2 evaluation lease/private image. A narrowly scoped V1 metadata facade for `InternalRetrievalService` may follow the existing bridge in `tests/retrieval-evaluation.test.ts`; map each request facade to its retained original V2 lease, reject V1 pathname access, and close per-query facades and retained leases at their correct ownership boundaries. Do not widen the shared V1 manifest decoder, candidate repository, or production composition. Test the original lease identity, prohibited pathname access, and cleanup on success and failure.

The sealed evaluator's `eligibleScope()` and `parseProjectBinding()` still require legacy 64-hex project/vault/store IDs. Align only these six field decoders with `isProjectionProjectStoreIdentity` from `projections/contracts.ts`: exact lowercase UUIDv4 or legacy lowercase 64-hex, without coercion. Keep workspace hash-only, existing event/session/branch UUID rules, source authentication, bundle hashing, corpus minimums, thresholds and evaluator behavior unchanged. Parse the production UUID fixture through the actual sealed bundle parser and evaluate the migrated pinned generations; never cast an unsealed corpus or substitute unrelated legacy-hash stores. Test both accepted identity domains and wrong UUID version/case/length/NUL/malformed input.

**Request-boundary correction (2026-09-11):** The unchanged `validateInternalRetrievalRequest` calls a private binding decoder that still requires all project/vault/store/workspace fields to be 64-hex, before any lease is pinned. Align only project/vault/store with `isProjectionProjectStoreIdentity`; workspace stays hash-only. Preserve exact own-data decoding, null binding sessionId, existing request session/branch/visibility/global-scope rules, bounds, normalization of query text, lease checks and service behavior. Cover both valid identity domains and wrong UUID version/case/length/NUL/non-string identities for each field, workspace UUID refusal, and getter non-invocation. Real UUID-backed V1/V2 service execution remains covered by the parity integration; do not introduce a facade that changes project identity or bypasses request validation. No candidate/eligibility/service behavior changes or public route edits are authorized. Add the existing retrieval-service test file to the final gate and propagate this internal source path to Task13's allowance.

**Production witness correction (2026-09-11):** `plainRecord(event)` currently applies a generic secret-text regexp to the whole serialized `lifecycleIntentJson`; valid canonical production witnesses necessarily contain schema keys `authorization`, `authorizationKind` and `authorizationSessionId`. At the direct source-event property only, add a private strict witness-string path using the unchanged `decodeLifecycleIntentWitness`. Preserve the original string byte-for-byte and its property order in the sealed source hash. Require the existing primitive/UTF-8 size/NFKC/control/depth/descriptor rules, exact canonical production witness decoding and its secret/proof/bearer rejection. Apply the evaluator's existing secret-text checks to actual witness string values and all non-schema structural keys; only the exact authorization structural keys at their decoder-defined locations are exempt from that text scan. The same names in user text, nested arbitrary JSON or other event/query fields remain forbidden. No generic `safeText`/regexp relaxation, substring replacement of authoritative bytes, nullification/omission of witnesses, unsealed corpus cast or production witness/authenticator change is allowed. Null/absent legacy witness behavior stays unchanged. Add production-writer witness round-trip/source-hash preservation, malformed/noncanonical/extra-key/secret/bearer/NFKC/oversize rejection, accessor-with-zero-invocation and wrong-location tests. Full source/event-chain authentication and all evaluator thresholds remain mandatory downstream; this parsing seam does not itself grant event authority.

For the production-backed Task 9 test fixture, existing synthetic corpus payloads may be replayed through the appropriate production writers under fresh UUID bindings before source-copy verification/sealing: use the current authorized LifecycleCommandStore/start/checkpoint path for the lifecycle prefix and EventStore for ordinary memory records. Generic memory commands cannot substitute for lifecycle authorization. This test-data construction does not authorize identity normalization of an already sealed/runtime source. Preserve source event types/versions, payload semantics, and every scoped distinction needed by the queries; use actual writer hashes/witnesses. Map any newly assigned synthetic IDs consistently to fixture identity/citation references before sealing, and use actual emitted counts/positions rather than forcing historical counts. A fixed representative subset covering all nine existing critical classes may be sealed for the focused integration fixture, with unchanged query texts/judgments and absolute thresholds, explicit identity and insertion-position reference mapping as bounded below, and genuinely measured V1 baseline metrics for that subset. Evaluate every query in that newly sealed subset and record its selected IDs/source counts and writer helper/mapping in the report. Preserve shipped fixture JSON and the full 500-query evaluator regression in the final gate; the subset is not whole-rehearsal evidence. Do not relax authorization/trigger/citation/decoder rules, synthesize candidates from answers, or invent baseline metrics.

**Fixture stream/order correction (2026-09-11):** Original corpus memory records carry session visibility and a non-null session binding. Preserve their original session stream semantics; the unchanged V2 fold advances that session's latestStreamVersion for each such material event. A separate memory stream starting at version1 is invalid and must not be compensated by nulling scope or changing the fold. For the optional additional history/artifact checkpoint, emit it through the authorized lifecycle writer immediately after the initial checkpoint, before replaying the original memory records. Preserve the relative order and contents of all original records. Derive stream versions/counts from the resulting writer sequence and translate only fixture event-position references by the insertion: original memory positions3..504 become4..505, and the selected queries' knownAt/required terminal504 becomes505. Apply the same exact translation to any actual position/citation references before sealing; do not rewrite IDs/text/judgments or arbitrarily scale numeric fields. No extra checkpoint means no insertion/position translation. Record the mapping and genuinely remeasure the V1 subset baseline. This test-only preparation is not mutation of a sealed/runtime corpus, and no Task7/8 producer or source/fold decoder change is authorized.

**Focused query coverage correction (2026-09-11):** Cover every expectation subgroup consumed by the unchanged absolute metric gate, not only the nine critical-class labels. Use the fixed original query IDs `0001/0057/0113/0169/0170/0225/0281/0337/0393/0449` (all with the existing `eval-v2-` prefix): adding `0170` supplies the missing next-action denominator without removing another query. Preserve texts, judgments, scopes, thresholds and the exact fixture identity/position translation; genuinely remeasure the ten-query baseline. Keep the full shipped 500-query final regression unchanged. Fixture rollout revisions must be created through the existing production `RolloutControlPlane.createRevision` after V1 baseline preparation and remain off, as required by the global production-writer constraint.

**Pure ordering negative fixture correction (2026-09-11):** The fixed ten queries each return one item, so reversing those results does not test ordering. Keep that standard fixture unchanged. In a separate optional ranking-only fixture mode, append exactly two new schema-2 memory records through the existing production EventStore after the original sequence and before source-copy verification/sealing. Use two distinct valid fixture-owned item identities, the same eligible session/project scope, and a unique common lexical token absent from the original source; construct source content and two-item relevance/citation judgments independently before querying. Preserve every original event/query and its temporal semantics; derive actual counts/positions from the writer (506 events without the optional history checkpoint), and bind the new query's knownAt/required position to the new terminal. Add exactly one dedicated query for that pair to the otherwise unchanged ten-query corpus, genuinely measure/seal its V1 baseline, and prove both unmodified V1/V2 services return the same two real items/citations with passing absolute thresholds. The negative fault may then only swap those two actual V2 result objects; membership, fields, citations, scope and source positions remain identical. Assert the swap was nontrivial, per-query ordered evidence differs and parity blocks without phase advancement. Do not substitute a membership-changing fault for pure-order coverage, infer candidate rows from judgments, modify production retrieval behavior, or export a runtime seam only for this test. No shipped corpus or standard fixture changes.

**Functional integrity fixture clock correction (2026-09-12):** Inventory confirms exactly two V2 setup coordinators in `tests/projection-integrity.test.ts`: common `createFixture` publication and the historical V2 image publication. These construct semantic integrity fixtures, not caller-deadline tests. Configure only those two instances with the existing injected coordinator clock `now: () => 0`, matching the established `publishedV2CoordinatorFixture` in coordinator tests. Retain both `10_000` caller arguments, builder timestamps, real SQLite/source authentication/publication and every integrity assertion. This is a new Task9 test-only scope ruling, not a claim that the older Task5R amendment already authorized this file. Do not change production coordinator clocks/checks, stable-directory `MUTATION_TIMEOUT_MS = 5_000`, runtime timeout values, shared helpers, or release configuration; these functional fixtures no longer constitute wall-clock performance evidence. After build, run the complete integrity file and the unchanged compiled coordinator cases selected by `--test-name-pattern='deadline|expir'` serially, preserving explicit V1/V2 zero/elapsed/no-late-publication/lock-release assertions. Then require a clean complete eight-file Task9 gate and typecheck on the amended code. Keep both failed complete runs and the unchanged four-case diagnostic distinct. A recurring native-child timeout remains a blocker requiring its own diagnosis, never an automatic timeout increase or retry loop.

**Production-faithful Git fixture correction (2026-09-12):** The private child's recording Git runner duplicates production spawning but omits the current production runner's one `ETIMEDOUT` retry. This observed contract drift is independently actionable; it does not establish the cause of full-gate37908's unclassified `GIT_PROBE_FAILED`, which did not recur in focused56912. Extract only the existing recording runner, diagnostic types and bounds into `tests/support/recording-git-command-runner.ts`. Delegate execution to the unchanged `SpawnSyncGitCommandRunner` using its existing injected spawn boundary, recording each actual attempt; do not copy the retry selector. Preserve the existing caps (16 probes, 8 arguments, 8 KiB text), NUL rejection and frozen diagnostic snapshots. Return the production runner's result without diagnostic truncation changing command semantics. The child imports this helper; lifecycle authorization, context, messages and client forwarding remain unchanged. Preserve scoped parity diagnostics as typed phase/reason/status/error-code only, with no paths, arguments or raw output. Add deterministic boundary tests for timeout-then-success, repeated timeout stopping at two attempts, non-timeout and failed-exit no retry, exact options/arguments, production return semantics, and bounded immutable diagnostics. The existing real Git resolver and Gitless-PATH protocol tests remain unchanged. Build, then serially run the new helper, existing git-workspace resolver, lifecycle protocol and parity lifecycle fixture tests; follow with a clean complete nine-file Task9 gate and typecheck. No production source edits, new retry policy, timeout/buffer/shell/env changes or broad fixture extraction. This supersedes the older no-child-edit restriction only for this extraction/delegation. Add the helper regression to the future Task13 focused gate; do not implement Task13 now.

The existing private lifecycle fixture's `record-root-checkpoint` currently hardcodes version/base position 1 and an empty draft. Extend only that test worker operation with optional strictly validated expected stream version, expected base event position and checkpoint draft data. Preserve existing defaults exactly. Use production command/checkpoint decoders; retain root/session/project/binding/agent and capability material internally, with no authority/context/arbitrary command override. Existing generic child/client forwarding should remain unchanged. The dedicated fixture test must prove the default call still works, a second valid checkpoint with artifact metadata is produced through the real authorized path, and malformed/extra/authority override fields fail before semantic writes. Reuse this fixture from the scoped V2 test helper rather than extracting or duplicating the broad runtime factory setup.

- [x] **Step 1: Write parity/rule RED tests.**

Cover exact equality, one exact governed difference, blocking semantic difference, every never-excludable category, expired/future/revision-mismatched/migration-mismatched/checksum-mismatched rule, wildcard selector, multiple matching rules, projection-position mismatch, an internally invalid declared/recomputed core checksum, sealed retrieval result/citation/ranking drift, plaintext absence, and deterministic report checksum:

```ts
test("classifies exact approved metadata differences without exposing values", async (t) => {
  const fixture = await parityFixture(t, { difference: "artifact-symbol-representation" });
  const rules = fixture.metadataDifferences.map((difference) => approvedRule({
    ...difference, category: "representation", projection: "artifactsFiles",
  }));
  const report = await compareV1V2Snapshots({ ...fixture.input, rules });
  assert.equal(report.equalCount > 0, true);
  assert.equal(report.expectedDifferenceCount, rules.length);
  assert.equal(rules.length > 0, true);
  assert.equal(report.blockingDivergenceCount, 0);
  assert.equal(JSON.stringify(serializeSnapshotParityReport(report)).includes(fixture.plaintextSummary), false);
});

test("never permits a rule to normalize authority or core checksum", () => {
  for (const category of [
    "identity", "authority", "scope", "event-chain-integrity", "privacy",
    "erasure", "duplicate-event", "lost-event", "ordering",
    "terminal-position", "terminal-hash", "core-checksum", "plaintext-leakage",
  ] as const) {
    assert.throws(
      () => decodeExpectedDifferenceRuleV1(approvedRule({ category })),
      (error: unknown) => error instanceof ShadowMigrationError
        && error.code === "PARITY_RULE_INVALID",
    );
  }
});

test("compares the sealed retrieval corpus through both pinned generations", async (t) => {
  const fixture = await sealedRetrievalParityFixture(t);
  const report = await compareV1V2Snapshots(fixture.input);
  assert.equal(report.sealedRetrieval.queryCount, fixture.corpus.queries.length);
  assert.equal(report.sealedRetrieval.blockingDivergenceCount, 0);
  assert.equal(report.sealedRetrieval.v1ThresholdsPassed, true);
  assert.equal(report.sealedRetrieval.v2ThresholdsPassed, true);
  assert.equal(JSON.stringify(serializeSnapshotParityReport(report)).includes(fixture.queryPlaintextSentinel), false);
});
```

- [x] **Step 2: Run parity tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-snapshot-parity.test.js dist-test/tests/projection-integrity.test.js
```

Expected: compilation fails because the rule decoder, verified canonical snapshot reader, and parity engine do not exist.

- [x] **Step 3: Expose canonical rows only after projection verification.**

Refactor the existing integrity reader without duplicating table definitions. Preserve schema-native rows and checksums first, then construct the schema-aware comparison views required by spec 3.7. V1 has only the seven `ProjectionNameV1` domains; never invent a persisted V1 `sessionCheckpoints` checksum. Use the existing V1 manifest names and this discriminated shape:

```ts
interface VerifiedCanonicalProjectionSnapshotBase {
  readonly binding: ProjectBinding;
  readonly terminalEventPosition: bigint;
  readonly terminalEventHash: string;
}

export type VerifiedCanonicalProjectionSnapshot = VerifiedCanonicalProjectionSnapshotBase & (
  | Readonly<{
      schemaVersion: 1;
      coreChecksums: Readonly<Record<ProjectionNameV1, string>>;
      rows: Readonly<Record<ProjectionNameV1, readonly CanonicalProjectionRow[]>>;
    }>
  | Readonly<{
      schemaVersion: 2;
      coreChecksums: Readonly<Record<ProjectionName, string>>;
      rows: Readonly<Record<ProjectionName, readonly CanonicalProjectionRow[]>>;
    }>
);

export function readVerifiedCanonicalProjectionSnapshot(
  binding: ProjectBinding,
  manifestValue: unknown,
  options: ProjectionIntegrityServiceOptions & Readonly<{
    sourceSnapshot: ProjectionEventSnapshot;
  }>,
): VerifiedCanonicalProjectionSnapshot;
```

This function must use the existing manifest parser, stable file identity, immutable image, schema/table/index checks, canonical row conversion, and core-checksum verification. It returns deep-frozen logical rows only after all checks pass and never returns the database handle or path. V1 schema-1 and V2 schema-2 core checksum strings are not required to equal one another; each side's declared checksum must equal its own recomputed canonical rows. A declared/recomputed mismatch on either side is the never-excludable `core-checksum` integrity category.

The explicit caller-owned source snapshot is required: V1 receives the verified source-copy snapshot; V2 receives only a snapshot opened through Task 7's committed-import reader. Reuse Task 8's authentication/image machinery and retain existing `verify()` behavior. Extract rows from the same pinned private image that passed verification, not a later pathname reopen. A narrow builder helper may return the verified V1 rows together with their checksums; preserve Task 8's existing checksum-only helper contract by delegation if needed. Caller closes each supplied snapshot reliably, and no source/package bytes may substitute for committed V2 input.

The comparison view must explicitly distinguish native storage from logical equivalence. V1 `sessionTree` is the latest checkpoint per session, so its checkpoint fields compare with the latest authenticated V2 `sessionCheckpoints` row for that session, not with V2's lifecycle-shaped `sessionTree`. Check full V2 checkpoint history and lifecycle authority against the authenticated original source sequence, including exact counts/order/IDs; those fields are never exception-eligible. Likewise, V2 `source_event_id`/anchor and scope/provenance must be verified against their exact authenticated original events, never dropped merely because V1 does not persist the same column. Preserve native core checksums separately from these views. For other schema-only representation fields, use explicit deterministic field mappings or report a governed/blocking difference; distinguish an absent field from a present null. No unknown row/field or unmappable authority state may silently become equal. Cover a real nonempty checkpoint history, metadata/provenance tamper, missing versus null, and both native schema domains in tests.

- [x] **Step 4: Implement immutable rule decoding and unique matching.**

Use exact fields:

```ts
export interface ExpectedDifferenceRuleV1 {
  readonly schemaVersion: 1;
  readonly ruleId: string;
  readonly policyVersion: number;
  readonly category: "semantic-value" | "representation";
  readonly projection: ProjectionName;
  readonly rowIdentityHash: string;
  readonly fieldPath: string;
  readonly predicate: Readonly<{
    operator: "exact-value-hashes";
    v1ValueHash: string;
    v2ValueHash: string;
  }>;
  readonly rationaleDigest: string;
  readonly approverFingerprint: string;
  readonly approvalReferenceDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly rolloutRevisionId: string;
  readonly migrationIdentity: string;
  readonly ruleChecksum: string;
}
```

Reject `*`, empty path segments, array wildcards, prototype keys, executable strings, fields outside the canonical comparison value, noncanonical timestamps, issued time after run start, expiry at/before run start, age beyond `maxExpectedDifferenceRuleAgeMs`, or any binding/checksum mismatch. A finding must match zero or one rule; two matches are `PARITY_RULE_INVALID`.

- [x] **Step 5: Compare aligned snapshots and persist a redacted report.**

Before row comparison require exact equality of binding and terminal position/hash. Compare projections in `PROJECTION_NAMES` order; rows by canonical identity key; fields by sorted name. Classify each comparison as:

```ts
export type ParityClassification =
  | "PARITY_EQUAL"
  | "PARITY_EXPECTED_DIFFERENCE"
  | "PARITY_BLOCKING_DIVERGENCE";

export interface RedactedParityFindingV1 {
  readonly schemaVersion: 1;
  readonly classification: ParityClassification;
  readonly category: string;
  readonly projection: ProjectionName;
  readonly rowIdentityHash: string;
  readonly fieldPathHash: string;
  readonly v1ValueHash: string;
  readonly v2ValueHash: string;
  readonly ruleId: string | null;
}
```

Hash canonical scalar values with domain `project-memory/v2-parity-value/v1`; hash field paths before report output. The report contains only terminal identities, manifest/core-checksum digests, counts, findings, matched rule IDs, sealed retrieval parity, and `reportChecksum` over canonical redacted JSON.

**Bounded sample correction (2026-09-11):** Cap `findings` at 128 deterministic redacted samples. Select blocking findings first, then expected differences, then equal findings; preserve canonical comparison order within each class. All counts, matched rule IDs, full source/row validation and retrieval result-vector checksums cover every comparison, including findings beyond the sample cap. Accumulate bounded samples while counting, rather than retaining an unbounded all-field findings array and truncating only at serialization. The report decoder permits total counts larger than sampled counts, enforces the cap and count/class consistency, and never derives completeness from the sample. Persist/adopt the exact capped body using the existing checksum contract. Cover more than 128 comparisons, blocking/expected results beyond the early equal range, deterministic ordering/hash and serializer cap rejection. This is an internal report-format bound, not a migration-policy/configuration change or a source/query coverage reduction.

For sealed retrieval parity, pin reader leases for both generations, build two `InternalRetrievalService` instances with the V1 repository and lease-preserving V2 adapter described above, call `evaluateSealedRetrieval` for absolute threshold evidence, and also run every sealed query through both services. Canonicalize each result to item IDs, statuses, visibility, source-event positions, citation identities, ranks, conflict closure, and temporal eligibility; hash the canonical result and citation vector per query. Vector/provider channels remain disabled as required by `assertSealedEvaluationVectorDisabled`. Classify mismatched result/citation/order hashes through the same exact-rule engine; identity/scope/temporal/conflict/citation-integrity drift is never excludable.

```ts
export interface SealedRetrievalParityV1 {
  readonly corpusVersion: string;
  readonly queryCount: number;
  readonly v1ThresholdsPassed: boolean;
  readonly v2ThresholdsPassed: boolean;
  readonly equalCount: number;
  readonly expectedDifferenceCount: number;
  readonly blockingDivergenceCount: number;
  readonly resultVectorChecksum: string;
}

export interface SnapshotParityReportV1 {
  readonly schemaVersion: 1;
  readonly rolloutRevisionId: string;
  readonly migrationIdentity: string;
  readonly packageChecksum: string;
  readonly comparedEventPosition: bigint;
  readonly comparedEventHash: string;
  readonly v1ManifestChecksum: string;
  readonly v2ManifestChecksum: string;
  readonly v1CoreChecksumsDigest: string;
  readonly v2CoreChecksumsDigest: string;
  readonly comparisonPolicyVersion: number;
  readonly equalCount: number;
  readonly expectedDifferenceCount: number;
  readonly blockingDivergenceCount: number;
  readonly findings: readonly RedactedParityFindingV1[];
  readonly matchedRuleIds: readonly string[];
  readonly sealedRetrieval: SealedRetrievalParityV1;
  readonly reportChecksum: string;
}
```

Persist rules first, then the report. If any row or retrieval blocking count is nonzero, persist the red report and throw `PARITY_BLOCKING_DIVERGENCE` without appending `parity-complete`; otherwise append the phase with the report checksum as evidence.

- [x] **Step 6: Run parity, integrity, and redaction verification.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-snapshot-parity.test.js dist-test/tests/projection-integrity.test.js dist-test/tests/projection-schema.test.js dist-test/tests/retrieval-evaluation.test.js dist-test/tests/v2-shadow-migration-repository.test.js dist-test/tests/projection-builder.test.js dist-test/tests/v2-parity-lifecycle-fixture.test.js dist-test/tests/retrieval-service.test.js dist-test/tests/recording-git-command-runner.test.js
npm run typecheck
```

Expected: all tests pass; blocking reports are durably visible but cannot advance the ledger; no raw row value appears in stored reports or thrown errors.

- [x] **Step 7: Commit parity governance.**

```powershell
git add src/orchestrator/parity/v2-expected-difference.ts src/orchestrator/parity/v2-snapshot-parity.ts src/orchestrator/projections/builder.ts src/orchestrator/projections/integrity.ts src/orchestrator/retrieval/evaluation.ts src/orchestrator/retrieval/contracts.ts src/orchestrator/storage/v2-shadow-migration.repository.ts tests/v2-snapshot-parity.test.ts tests/projection-integrity.test.ts tests/projection-builder.test.ts tests/retrieval-evaluation.test.ts tests/retrieval-service.test.ts tests/v2-shadow-migration-repository.test.ts tests/support/v2-shadow-migration-fixture.ts tests/fixtures/project-store-lifecycle-runtime-worker.ts tests/v2-parity-lifecycle-fixture.test.ts tests/support/recording-git-command-runner.ts tests/recording-git-command-runner.test.ts tests/fixtures/project-store-lifecycle-child.ts
git commit -m "feat: prove V1 V2 snapshot parity"
```

### Task 10: Materialize committed compatibility artifacts only into an isolated target

**Files:**
- Create: `src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts`
- Create: `src/orchestrator/materialization/stable-compatibility-directory.ts`
- Create: `src/orchestrator/materialization/stable-compatibility-directory.worker.ts`
- Create: `tests/v2-shadow-compatibility.test.ts`
- Create: `tests/stable-compatibility-directory.test.ts`
- Create: `scripts/smoke-v2-shadow-compatibility.js`
- Modify: `scripts/build.js` (separate internal worker artifact only)
- Modify: `src/orchestrator/migration/v2-shadow-importer.ts`
- Test: `tests/v2-shadow-importer.test.ts`
- Modify: `src/orchestrator/storage/v2-shadow-migration.repository.ts` (scoped all-outbox/claim reads using existing strict decoders; no DDL change)
- Test: `tests/v2-shadow-migration-repository.test.ts`
- Modify: `tests/support/v2-shadow-migration-fixture.ts` (production-backed compatibility fixture and importer constructor alignment only)
- Modify: `tests/v2-imported-event-reader.test.ts` (importer constructor alignment and the precise missing-receipt corruption-fixture correction below only) and `tests/v2-shadow-projection.test.ts` (importer constructor alignment only if required; retain their existing behavior tests)
- Reuse: `src/orchestrator/materialization/atomic-artifact-replacer.ts:21-180`

**Interfaces:**
- Consumes: committed `V1LegacyArtifactImported` wrapper events, import receipts, compatibility outbox/claim/acknowledgement repository operations, isolated root, live V1 vault root, and atomic replacement.
- Produces: `V2ShadowCompatibilityMaterializer.materializePending(input)` and `CompatibilityMaterializationResult`.

**Independent review fix-round1 allowance (2026-09-12):** Also modify `src/orchestrator/storage/sqlite-driver.ts`, `src/orchestrator/storage/node-sqlite-driver.ts`, and `tests/sqlite-driver.test.ts` for opt-in existing-file connection binding only. Extend the compatibility fixture allowance only to bootstrap/close/reopen its real isolated target with that binding and inject acknowledgement failure beneath the driver using a real `DatabaseSync` subclass. No runtime/test edit outside these three added paths and the existing Task10 scope.

The materializer must not equate `PRAGMA database_list.file` (or `DatabaseSync.location`) with open-file identity. Add optional `bindFileIdentity?: true` to existing open options; absent preserves ordinary V1 behavior. Opt-in is allowed only for `existing` and `read-only-existing`, never create; reject invalid opt-in before opening. For opt-in require absolute normalized native-canonical nonsymbolic ancestors and an existing regular single-link file. Capture its device/inode before the first native open, check the same identity immediately after each actual native constructor before writable hardening, and again after hardening before returning. Both read-only preflight and writable second open bind to that original identity. Keep every existing identity/WAL/FULL/FK/trusted-schema/busy control and cleanup behavior.

Retain the successful immutable open-time observation in a module-private WeakMap keyed by the genuine `NodeSqliteConnection`. Export only an assertion taking that exact connection and expected canonical path/identity; no registration API, transferable token or mockable proof method. Closed, unbound, forged, copied and plain forwarding wrapper connections fail closed. Invalidate proof on close. Materializer requires this binding before repository transactions and at every current connection check; do not mint it at materializer entry. Test acknowledgement interruption with a real native subclass passed through the production driver so the genuine wrapper remains bound; ordinary wrappers must not inherit proof merely by forwarding another connection's checker.

Threat boundary: this proves provenance of a stable open-time identity observation and rejects observable stale-path replacement; it does not expose/attest SQLite's private fd or prevent A-to-B-to-A replacement entirely within a native open or a last-check/syscall gap. The isolated database path must remain migration-owner-controlled during synchronous opening and each transaction, consistent with the existing bounded isolated-directory model. Do not claim arbitrary concurrent same-user host-compromise protection, invent fd proof, add a native dependency/VFS, or accept any observed protected mutation. A separate witness fd alone would not attest SQLite's fd.

Required real regressions: valid bound existing opens and unchanged unbound defaults; opt-in create/missing/alias/hardlink refusal; closed/unbound/forged/copied-wrapper refusal; real persistent path substitution after native constructor rejected before hardening; already-open A renamed/replaced by independently production-created B with PRAGMA still naming the original pathname rejected before first claim/ack; replacement at later connection-check boundaries refused; same logical identities do not substitute for physical binding; all affected stores' evidence and protected entries/identity/link counts/bytes remain unchanged by the materializer. Attempt supported disposable file/ancestor rename routes on Windows without privileges/config changes; an OS rename denial is separately reported prevention, not a simulated stale-handle pass. Linux must execute the actual stale-handle case for release qualification. Preserve exact no-rewrite acknowledgement recovery through the native fault seam.

Address the review's Minor membership cost with Sets/Maps for initial claim/ack membership and each complete proof's claim membership only. Preserve current full evidence checks and immutable-event validation; no targeted-row repository API or cache-trust expansion in this fix. This removes cubic membership comparisons but leaves repeated full scans; do not claim linear complexity or measured capacity. Retain capacity qualification as a Task13/14 gate and cover multi-artifact/replay/corruption semantics.

Fix-round verification: fresh test build; focused new connection/materializer RED-to-GREEN cases; complete `sqlite-driver.test.js` plus the exact nine-file Task10 gate below in one serial invocation; typecheck, production build and built-only smoke. This is a runtime/shared-driver amendment, so the earlier test-only proportional-gate exception does not apply. Preserve pre-fix gate totals as historical evidence and provide a separate scoped fix report/commit for independent re-review.

**Scoped constructor-forgery correction (2026-09-12):** A returned object's inherited `constructor` remains reachable even when its class is not exported. A constructor accepting caller-supplied binding metadata must never register provenance in the private WeakMap. Keep registration confined to an unexposed module-owned path after the genuine driver's successful validated opening; do not replace the flaw with an exported/reachable registration method or bearer token. Preserve native hardening, both existing modes, close invalidation and ordinary unbound V1 behavior. Add a production-backed regression obtaining the constructor from a returned instance/prototype and attempting to bind a different actual SQLite store using fabricated expected-file metadata. It must fail the exported binding assertion without target/protected mutation and close all test-owned handles. Limit the correction to `node-sqlite-driver.ts` and `sqlite-driver.test.ts`. After observed RED and GREEN, run both complete `sqlite-driver.test.js` and `v2-shadow-compatibility.test.js` serially on a fresh test build, plus typecheck, production build and built-worker smoke. The preceding ten-file gate remains historical evidence for the earlier commit, not a rerun on this fix; Task13/14 retain their complete integration/release gates. If this correction needs any wider runtime change, reassess the covering gate before implementation.

**Producer/consumer corrections (2026-09-11):** Add `readCompatibilityOutbox(): readonly CompatibilityOutboxRecord[]` and `readCompatibilityClaims(): readonly CompatibilityClaim[]` to `V2ShadowMigrationTransaction`, scoped by its existing project/migration and guarded by the same active transaction lifetime. Use existing strict row decoders, frozen rows/arrays, and deterministic source-ordinal/outbox-ID ordering respectively. Preserve pending-only reads. Cover acknowledged rows remaining visible, cross-scope exclusion, immutable returned values and escaped-transaction refusal with real SQLite tests. Full outbox/claim evidence is necessary for an authenticated completed no-op; a pending-only list is not proof of completeness.

The importer must construct its receipt/outbox repository from the same `dependencies.connection` used for committed EventStore readback; an independent injected repository must not control these transactions. Remove that obsolete constructor dependency and align only its scoped test/fixture call sites, with a wrong-store repository regression proving it cannot receive writes. Preserve the existing EventStore fault/replay tests and other dependency behavior. The materializer likewise owns a repository constructed from its file-identity-verified isolated target connection and validates protected roots plus run/package bindings before any claim/acknowledgement transaction.

Receipt/outbox insertion is atomic in the repository transaction after exact EventStore commit readback. If receipt insertion exists on replay, require its exact outbox row, including after acknowledgement; missing, conflicting, extra or source-event-kind outboxes fail closed rather than being silently backfilled. A normal unknown EventStore commit with neither receipt nor outbox may reconcile the exact deterministic EventStore replay and insert both together. Cover receipt-transaction rollback, acknowledgement followed by importer replay, and conflicting outbox rejection without new events/revisions. Constructor alignment must not change wrapper identities, clocks or source semantics.

**Existing negative-fixture correction (2026-09-12):** In `tests/v2-imported-event-reader.test.ts`, retain all four ordinals and the exact reader rejection in `rejects missing source and artifact receipts`. The real importer now creates artifact outboxes whose foreign key correctly prevents deleting their receipt in that test's corruption setup. Only in this fresh disposable fixture, drop the outbox no-delete trigger as well as its existing receipt no-delete trigger; remove only the corresponding `(projectId, migrationIdentity, sourceOrdinal)` outbox before deleting that exact receipt. Assert the expected affected counts (zero outboxes for source ordinals, one for each artifact ordinal, exactly one receipt), preserve other evidence and verify the reader still emits its original typed integrity rejection. Keep SQLite foreign keys enabled; do not change runtime code, DDL, constraints, reader assertions or unrelated fixtures to accommodate this negative setup. Preserve the original failed gate output and cover the amended setup with the focused reader test and final Task10 gate.

**Stable publication correction (2026-09-11):** The unchanged `AtomicArtifactReplacer` validates absolute paths before later mutations; post-hoc root checks cannot prevent a redirected write. Add the narrowly scoped V2 client/worker above. The client exposes asynchronous parent preparation, publish-or-reconcile, and verify-only operations, bound to captured root/parent identities, forbidden authority identities, validated relative components, an attempt token, exact byte length/SHA-256, and the remaining migration deadline. Repository claims and acknowledgements remain outside this filesystem helper. Verify-only must not create a missing directory or rewrite bytes.

The hidden child verifies its `.` identity on entry and executes the existing replacer with a complete operations adapter: map only its verified final parent to `.` and the exact approved target/temp tokens to validated single basenames. Open/write/rename/unlink/mkdir must never fall back to absolute mutation paths. Nested parents are prepared one component at a time from an existing verified parent using nonrecursive relative mkdir, strict entry-parent flush, and verified child entry. Reject symbolic/junction/noncanonical aliases and hardlinked files. Preserve V1 replacer, materializer, projection stable-directory and directory-durability defaults unchanged.

Keep descriptors inside the child; verify lstat/fstat device/inode, regular-file type, link count one, exact descriptor-read bytes/hash and target/temp identity continuity. Use exclusive unpredictable attempt temps, never write, append or truncate an existing target, and invoke the unchanged replacer rather than duplicating its publication sequence. The sole non-truncating Windows flush-handle exception is specified below; it does not grant permission to mutate existing target bytes. Cleanup may remove only this attempt's proven-owned temp; EEXIST does not confer ownership. Ambiguous cleanup retains the isolated entry; never delete a target as rollback or perform pathname/glob cleanup. Ancestor redirection remains anchored to the verified original directory or rejects before mutation. Tests must inject at the underlying operation boundary, not only before a final check. This model assumes the isolated directory is controlled by the migration owner; it does not claim atomic leaf compare-and-swap or protection from arbitrary same-user host compromise. Evidence must state this limit, and any observed violation of protected-root isolation blocks the task rather than being reclassified as an expected difference.

Open and retain the verified directory descriptor with `r+` on Windows and `r` on Linux, then fsync that exact descriptor after entry changes. Propagate every open, identity, flush, unsupported-capability and close failure; no portable silent fallback. Reconciliation reopens/verifies exact installed bytes and re-establishes file and parent durability before acknowledgement. A replacement followed by lost worker response, timeout, flush failure or acknowledgement uncertainty remains unknown until exact claim/outbox/import/target reconciliation; installed matching bytes must not be replaced again. Use bounded exact stdin/stdout messages, correlated request identity and redacted typed failures; no payloads in arguments/logs or raw child errors. Child process windows stay hidden, and no main-process cwd change is allowed.

**Windows existing-file durability correction (2026-09-12):** Inside the verified pinned child only, open an already-existing isolated target using `r+` on Windows solely for descriptor reads, identity checks and `fsync`; use `r` on Linux. The Windows flag must not include create, truncate or append semantics. Require the same pre-open lstat and post-open fstat regular-file, device/inode and single-link proof before reading/flushing, then exact bytes/hash and identity continuity through close. No existing-target descriptor may reach a write/writeFile/append/truncate operation; those operations remain restricted to a proven-owned exclusive attempt temp. Missing targets stay missing in verify-only, and any handle/identity/flush/close failure still fails closed without acknowledgement or fallback. This narrow exception replaces the previous blanket prohibition on write-capable opens, not the prohibition on existing-byte mutation. Cover actual open flags and zero existing-target data-write calls, unchanged bytes/device/inode/link count on matching reconciliation/no-op, missing-target refusal, and injected flush/close errors. Node24.16 maps fsync to Windows FlushFileBuffers, whose handle requires write access; `r+` opens an existing file without creation/truncation ([Node24.16 flags](https://nodejs.org/download/release/v24.16.0/docs/api/fs.html#file-system-flags), [Node24.16 Windows implementation](https://github.com/nodejs/node/blob/v24.16.0/deps/uv/src/win/fs.c), [FlushFileBuffers contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)). Local owned-file probes establish this runtime capability only, not Linux or power-loss qualification.

Build `src/orchestrator/materialization/stable-compatibility-directory.worker.ts` separately as `dist/internal/stable-compatibility-directory.worker.js`, using the existing Node target/build conventions. Resolve the worker as a sibling of the internal bundled rehearsal module (Task12) and of the emitted materialization helper under `dist-test`; do not rely on source TypeScript or `dist-test` at production runtime. The built-only smoke script exercises the real compiled worker against disposable isolated/protected fixtures, exact-byte publication plus verified no-op, malformed request rejection, and no protected mutations. No public entry import or automatic worker execution is introduced.

- [x] **Step 1: Add importer-outbox and materializer RED tests.**

Extend importer tests to require one immutable outbox record per legacy artifact after the corresponding wrapper event/receipt commits. Add materializer tests for exact bytes/path/hash, live-root alias rejection, symlink and replacement attacks, stale/wrong claims, crash after replace before acknowledgement, acknowledgement after durable observation, target lag, rerun no-op, and plaintext-free diagnostics:

```ts
test("publishes exact committed artifact bytes below only the isolated root", async (t) => {
  const fixture = await compatibilityFixture(t);
  const result = await fixture.materializer.materializePending(fixture.input);
  assert.equal(result.acknowledgedCount, fixture.package.manifest.legacyArtifactCount);
  for (const expected of fixture.expectedArtifacts) {
    assert.deepEqual(readFileSync(join(fixture.isolatedRoot, expected.relativePath)), expected.bytes);
  }
  assert.deepEqual(fixture.repository.pendingCompatibility(), []);
});

test("rejects a compatibility target that aliases live V1 authority", async (t) => {
  const fixture = await compatibilityFixture(t, { compatibilityRoot: "live-vault" });
  await assert.rejects(
    fixture.materializer.materializePending(fixture.input),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "COMPATIBILITY_INTEGRITY_FAILURE",
  );
});
```

- [x] **Step 2: Run compatibility tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-importer.test.js dist-test/tests/v2-shadow-compatibility.test.js
```

Expected: importer tests fail because no outbox rows are enqueued; materializer module is absent.

- [x] **Step 3: Enqueue compatibility records in the import transaction.**

After each artifact wrapper event is durably read back and its import receipt is inserted, enqueue this exact immutable record in the same migration-repository transaction:

```ts
export interface CompatibilityOutboxRecord {
  readonly projectId: string;
  readonly migrationIdentity: string;
  readonly outboxId: string;
  readonly sourceOrdinal: number;
  readonly importedEventId: string;
  readonly importedGlobalPosition: bigint;
  readonly importedEventHash: string;
  readonly triggeringPayloadHash: string;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly materializationRevision: bigint;
  readonly recordedAt: string;
}

export interface CompatibilityMaterializationResult {
  readonly schemaVersion: 1;
  readonly migrationIdentity: string;
  readonly acknowledgedCount: number;
  readonly highestAcknowledgedSourceOrdinal: number | null;
  readonly acknowledgedImportedPosition: bigint | null;
  readonly materializationRevision: bigint | null;
  readonly aggregateBytes: number;
  readonly artifactSetChecksum: string;
  readonly deduplicated: boolean;
}
```

Derive `outboxId` with deterministic migration UUID purpose `claim` plus source ordinal. `materializationRevision` equals the source ordinal plus one. Replaying the batch must find the exact existing outbox row; any field difference is `MIGRATION_IDENTITY_CONFLICT`.

Use that same deterministic `claim` UUID for the claim and acknowledgement IDs in their distinct table namespaces; do not invent a new UUID purpose or change the frozen identity algorithm. Bind `claimOwnerFingerprint` to SHA-256 of `project-memory/v2-shadow-compatibility-owner/v1\n` followed by the migration identity, never a process ID or absolute path. Outbox `recordedAt` equals its exact receipt time. Claim and acknowledgement times use the source/package creation instant plus source ordinal milliseconds. The acknowledgement checksum remains the repository's existing canonical complete acknowledgement body excluding its own checksum, with bigint fields encoded as exact decimal strings.

- [x] **Step 4: Implement exact claim, committed-event read, and atomic publication.**

`materializePending` must canonicalize isolated/live roots, reject identity equality or containment, capture the isolated root identity, and process outbox rows by source ordinal. For each row:

1. Insert or read the deterministic claim and require exact outbox/import identities.
2. Read the wrapper event from the target event store by exact global position; authenticate it and decode `V1LegacyArtifactImportedV1`.
3. Require payload migration identity, source ordinal, record hash, relative path, UTF-8 byte length, triggering payload hash, and content SHA-256 to match both receipt and outbox.
4. Resolve the lexical path with `resolveContainedProjectPath`, then use the pinned V2 directory client to reject aliases and call `AtomicArtifactReplacer.replace` inside its verified child with exact bytes and relative-only operations.
5. Require verified descriptor bytes/root/target identity plus strict file/parent durability from that client, revalidate run/claim/connection identity, then append the acknowledgement.
6. On a replace/acknowledgement interruption, verify target bytes plus claim/outbox/import rows; append the same acknowledgement only if all identities match. Otherwise throw `MIGRATION_OUTCOME_UNKNOWN` or `COMPATIBILITY_INTEGRITY_FAILURE` without replacing again.

Use an injected deterministic acknowledgement clock derived from `sourceManifest.createdAt + sourceOrdinal milliseconds`; performance timing uses a separate monotonic observer. Return only counts, highest acknowledged source ordinal, target position, aggregate bytes, and an artifact-set checksum over `(relativePathHash, byteLength, contentSha256, materializationRevision)`.

On every call, including a completed no-op, verify all expected artifact descriptors against exact committed receipts/outboxes/claims/acknowledgements and durable target bytes; reject extras or omissions. Reconstruct the result over the full acknowledged set, not merely rows processed in this invocation. Preserve distinct position domains: highest acknowledged imported position is a wrapper-event position, not the original source terminal event position. An authenticated zero-artifact package succeeds with zero count/bytes, null maxima/revision and a deterministic empty-set checksum; all expected source records must still be committed. Task11 completion uses this complete-set proof, never numerical equality between unrelated position domains.

The stable-worker fault matrix covers replaced root/ancestors before child entry, nested mkdir, immediately before exclusive open and rename, replaced target/temp regular inode/symlink/hardlink, occupied temp, cleanup after write/fsync/close/rename failure, actual rename before lost response, strict directory flush failure, and timeout. Assert protected directory entries, identities/link counts and contents as well as actual mutating-operation targets; unchanged final bytes alone are insufficient. A retained owned temp is an explicit isolated outcome, not silently deleted. Platform-specific authority cases must actually run on the Windows/Linux release matrix; skipped privilege cases are not proof. Unit/fault tests and a local successful fsync call do not claim power-loss durability or universal filesystem support.

**Authority capability test clarification (2026-09-12):** Add dedicated real V2-worker file-symlink target and temporary-entry substitution cases on both Windows and Linux; retain the separate case-alias, directory-junction and hardlink cases, including temporary-entry hardlink substitution. Never substitute a case-alias or unchanged V1 replacer test for V2 file-symlink execution. A local Windows file-symlink creation refusal with exact `EPERM`/`EACCES` may be recorded as an explicit capability skip, not passing authority evidence; other creation errors fail. On `CI=true` or `GITHUB_ACTIONS=true`, the same refusal must fail the test rather than skip. Those are test-only CI signals, not V2 activation/configuration options. No host privilege, Developer Mode, ACL or permission change is authorized. Preserve the running pre-amendment gate. If that exact nine-file gate passes and the subsequent addition changes only tests, verify the additions with a fresh build, the complete stable-directory/materializer/atomic-replacer three-file gate, typecheck, build and built-only smoke; preserve the earlier nine-file result and later amended-test result separately, not as a claimed rerun. If runtime changes or another gate failure is needed, rerun the exact final Task10 gate after the fix. Task13/14 must enforce actual Windows/Linux execution before release qualification; local capability skips cannot satisfy that gate.

- [x] **Step 5: Run compatibility and existing materializer regression.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-importer.test.js dist-test/tests/v2-shadow-compatibility.test.js dist-test/tests/stable-compatibility-directory.test.js dist-test/tests/v2-shadow-migration-repository.test.js dist-test/tests/v2-imported-event-reader.test.js dist-test/tests/v2-shadow-projection.test.js dist-test/tests/atomic-artifact-replacer.test.js dist-test/tests/compatibility-log-materializer.test.js dist-test/tests/lifecycle-materialization-queue.test.js
npm run typecheck
npm run build
node scripts/smoke-v2-shadow-compatibility.js
```

Expected: all tests pass; live V1 bytes are untouched; committed wrapper events are the only compatibility payload source; rerun is a verified no-op.

- [x] **Step 6: Commit isolated compatibility materialization.**

```powershell
git add src/orchestrator/migration/v2-shadow-importer.ts src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts src/orchestrator/materialization/stable-compatibility-directory.ts src/orchestrator/materialization/stable-compatibility-directory.worker.ts src/orchestrator/storage/v2-shadow-migration.repository.ts tests/v2-shadow-importer.test.ts tests/v2-shadow-compatibility.test.ts tests/stable-compatibility-directory.test.ts tests/v2-shadow-migration-repository.test.ts tests/v2-imported-event-reader.test.ts tests/v2-shadow-projection.test.ts tests/support/v2-shadow-migration-fixture.ts scripts/build.js scripts/smoke-v2-shadow-compatibility.js
git commit -m "feat: materialize isolated V2 compatibility artifacts"
```

### Task 11: Orchestrate durable phases, bounded retries, and unknown-outcome reconciliation

**Files:**
- Create: `src/orchestrator/migration/v2-shadow-migration-runner.ts`
- Create: `src/orchestrator/migration/v2-shadow-migration-runtime.ts` (internal shared invocation deadline and deterministic phase metadata only)
- Create: `tests/v2-shadow-migration-runner.test.ts`
- Create: `tests/v2-shadow-migration-runtime.test.ts`
- Modify: `tests/support/v2-shadow-migration-fixture.ts`
- Modify: `src/orchestrator/migration/v1-source-copy.ts` and `tests/v1-source-copy.test.ts` (optional runtime deadline, cleanup and typed errors only)
- Modify: `src/orchestrator/migration/v2-migration-package.ts` and `tests/v2-migration-package.test.ts` (shared runtime deadline instead of a fresh sealed duration when supplied)
- Modify: `src/orchestrator/migration/v2-shadow-importer.ts` and `tests/v2-shadow-importer.test.ts` (shared deadline and possible-commit timeout classification only; preserve Task10 receipt/outbox guarantees)
- Modify: `src/orchestrator/migration/v2-shadow-projection.ts` and `tests/v2-shadow-projection.test.ts` (shared deadline plus deterministic phase metadata/adoption)
- Modify: `src/orchestrator/parity/v2-snapshot-parity.ts` and `tests/v2-snapshot-parity.test.ts` (pure sealed-source validation export, current UTC/deterministic metadata separation, shared deadline and phase adoption)
- Modify: `src/orchestrator/retrieval/evaluation.ts` and `tests/retrieval-evaluation.test.ts` (optional invocation deadline, request-only timeout narrowing and timeout propagation; no corpus/baseline mutation)
- Modify: `src/orchestrator/retrieval/service.ts` and `tests/retrieval-service.test.ts` (optional internal runtime deadline checks and lease cleanup; preserve callers without it)
- Modify: `src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts` and `tests/v2-shadow-compatibility.test.ts` (optional shared invocation deadline instead of its current local operation clock when supplied; preserve Task10 authority/publication proofs)

**Interfaces:**
- Consumes: rollout revision/state, verified source, sealed package, repository, importer, projection publisher, parity engine, compatibility materializer, policy, exact rules, and injected clock/sleep/fault boundaries.
- Produces: `V2ShadowMigrationRunInput`, `V2ShadowMigrationRunResult`, `ShadowMigrationFaultInjector`, an immutable typed preflight-attempt failure carrier, internal invocation-deadline/phase-metadata helpers, and `V2ShadowMigrationRunner.run(input)`.

**Bounded integration correction (2026-09-12):** The original runner outline omits producers for the real sealed retrieval corpus, decoded policy, deterministic component-owned phase metadata, and overall runtime budget. These seams complete the approved orchestration contract; they do not change schema7, sealed policy/configuration, existing UUID/hash algorithms, public V1 behavior, or authorize hard-cancellation/deployment work. Finish Task10 independent review before Task11 implementation starts.

1. Add `policy: ShadowMigrationPolicyV1` and `sealedRetrieval: Readonly<{ corpus: SealedRetrievalEvaluationCorpusV2; expectedBundle: RetrievalEvaluationBundleV2 }>` to run input. Strictly decode policy and configuration separately and require their checksum/version binding. Runtime clocks belong to injected runner dependencies, not JSON policy/configuration. Extract parity's existing pure source/corpus authentication into an exported helper taking parsed corpus and verified source; parity must use the same helper. Reparse all four logical artifacts with `parseSealedRetrievalEvaluationBundle`, compare the exact full manifest with `expectedBundle`, authenticate every original copied event and every query binding/terminal position, and reject alteration before package publication or projection preparation. No query slicing, resealing, rebaselining, test-loader imports or new fields in the five-field frozen configuration.
2. Read the named immutable revision and existing run/chain read-only before preparation writes. After source/corpus authentication compute `corpusPin = SHA256("project-memory/v2-shadow-migration-corpus-pin/v1\n" + canonicalJson(parsedCorpus.bundle))`; ordinal0 evidence is `SHA256("project-memory/v2-shadow-migration-snapshot-evidence/v1\n" + canonicalJson({ sourceManifestChecksum, corpusPin }))`. The escape denotes one actual newline in each preimage. This uses existing `snapshot-verified.evidenceDigest`, not a schema/migration-identity change. Authenticate a resumed chain and require that exact pin before preparation writes; afterward recheck all prepared revision build/configuration/migration/baseline bindings. A matching run without a transition has not durably selected a corpus: require no imported wrapper events/receipts/outboxes/claims/acks/rules/report before its first pin. Later effects without the pin are an integrity failure, never repaired. The externally approved full bundle remains an operational prerequisite; this digest binds integrity, not approval provenance.
3. Separate three clocks. Inject `utcNow()` for canonical actual UTC at invocation entry and again for parity authorization/no-op acceptance. Revalidate original rules' issue/expiry/maximum-age/checksum/scope without renewing them. Parity's `runStartedAt` stays current authority UTC and must not become deterministic metadata. Derive committed phase `recordedAt` from verified source creation plus phase ordinal milliseconds; validate canonical four-digit-year UTC and arithmetic range before writes. All committed phase IDs use existing `deterministicMigrationUuid("attempt", migrationIdentity, phaseOrdinal)`. Runner owns ordinals0/1/2/5, projection owns3, parity owns4. Preserve the full transition hash preimage. Projection manifests keep package creation time; parity report metadata uses ordinal4. Adoption matches expected deterministic ID/time/evidence, not just phase name; never rewrite old immutable rows. Operational retry attempt IDs stay separate and outside Task12's deterministic vector.
4. Create one runtime-only `ShadowMigrationInvocationDeadline` per `run()` with `remainingMs(): number` and `signal: AbortSignal`. Use the sealed duration and one finite non-regressing monotonic clock. Return a positive safe integer at most the original duration; exhausted, non-finite or regressed time throws `MIGRATION_RETRY_EXHAUSTED`. Pass the same object through source verification, sealing, import, baseline/publication, parity/evaluation/retrieval, reconciliation, sleep and no-op verification. Add the optional object to Task10's materializer input (the implemented materializer currently has only its own `operationNow` budget), and derive each unchanged stable-worker numeric timeout from the shared remainder. Existing components retain standalone defaults when the optional object is absent; runner always supplies it. A supplied object replaces fresh component budgets without policy cloning. Narrow child numeric timeouts immediately before calls; narrow sealed query timeouts only in requests, never in the corpus. Runner target connections use Task10's opt-in open-time binding; component check sites on the runner path must reuse the genuine bound-connection checker after awaits and before target mutations, not rely on PRAGMA path equality.
5. Check around descriptor/event loops, synchronous boundaries, awaits, later work, report/phase writes and successful/no-op returns. Preserve deadline errors through broad catches rather than classifying them as source/parity failures. Timeout/lost response after possible durable mutation remains `MIGRATION_OUTCOME_UNKNOWN`, never proof of absence. Reconcile once within the same remainder, or preserve unknown and exit if exhausted; a new invocation gets a new budget and authenticates prior effects first. Cap sealed exponential sleep by the remainder and honor the same signal. Dispose timers and close owned leases/resources on all exits.
6. This is a cooperative end-to-end budget with native child limits where available. Blocking filesystem/SQLite/hash/ranking or an existing non-cancellable lease/build await may settle after expiry; no late success or new subsequent work is allowed. Do not claim hard wall-clock termination, abandon active mutation/leases using `Promise.race`, or broaden into driver/coordinator cancellation. Include an explicit pending-lease limitation test plus deterministic expiry/cleanup tests. Task10 retains real child process deadline/termination behavior. Never grant fresh reconciliation time or accept an unchecked completed result after expiry.

Additional required integration RED cases: invalid/altered/wrong-source/wrong-pin corpus rejected with zero preparation/semantic writes; full supplied query set preserved; corpus change on resume/no-op refused before writes; later effects without ordinal0 refused; current UTC restart/no-op with original valid versus expired/future/too-old rules; identical committed phase IDs/times/hashes with differing actual UTC/monotonic origins; corrupted component phase metadata rejected; budget never resets across phases/retries/sleep; expiry during source replay/sealing/import batches/parity query/lease cleanup; append possibly committed before expiry remains unknown and next invocation produces no duplicate event; parity expiry prevents rule/report/phase writes; sealed query limits/corpus unchanged; no-op refuses late success. Use real storage/projection/import/compatibility implementations and transparent fault boundaries, never fake successful durability.

For these early-refusal assertions, preparation writes mean package/projection publication, isolated target/revision/run creation and semantic evidence writes. The source verifier's already approved owned bounded scratch replay is still permitted and must be closed/cleaned on refusal; it is not authority mutation or permission to publish before corpus validation.

**Read-only reconciliation correction (2026-09-12):** Existing resumable component methods can mutate and must not be used to discover absence. Add `ShadowMigrationReconciliation<T>` in the allowed runtime helper with exact frozen variants `{ status: "committed", result: T }`, `{ status: "absent" }`, or `{ status: "unknown", safeErrorCode }`; the code is an allowlisted typed category, never raw text. A committed result requires every component-owned durable artifact and phase to be authenticated. A partial state or failed/ambiguous read is unknown; a contradictory present value is a terminal integrity error. Reconciliation never publishes, repairs, appends a phase, claims, acknowledges, quarantines or adopts. Existing repository transactions with read-only callbacks may obtain SQLite locks but perform no semantic write. The runner invokes the appropriate reconciler exactly once per unknown retry cycle within the same remaining budget. Committed advances using its verified result; absent permits the same deterministic operation within policy; unknown exits after at most its redacted attempt evidence, with no component/phase write. A later invocation may perform the existing authenticated normal adoption; do not disguise same-cycle repair as a read-only proof.

| Component-owned API (in already allowed source/test files) | Exact proof boundary |
| --- | --- |
| `reconcileSealedV2MigrationPackage(input)` in `v2-migration-package.ts` | Locate using the named immutable revision's already available `migrationIdentityHash`; open/verify the exact package and source/build/configuration/policy bindings for committed. Stable final-target `ENOENT` with unchanged verified parent proves absent; access/identity uncertainty is unknown. No speculative identity preview or provisional run is needed. |
| `V2ShadowImporter.reconcile(input)` | Reuse the actual deterministic planner and authenticators; one bound atomic read must cover all expected command/dedup/event identities, receipts and outboxes. All exact is committed; all absent is absent; any subset, including events committed before receipts/outboxes, is unknown. Never call `EventStore.append` during this proof. An aggregate reconciler suffices for the runner's whole-import operation; no extra public batch API is required. |
| `V2ShadowProjectionPublisher.reconcileV1Baseline(input)` / `.reconcileV2(input)` | Lease/open and verify only; never recover/build/ensurePublished. V1 needs its exact manifest/image; V2 additionally needs exact deterministic component phase3. No manifest/image/phase is absent; partial/orphan durable state is unknown; contradictory complete state fails integrity. |
| `reconcileV1V2Snapshots(input)` in `v2-snapshot-parity.ts` | Reuse strict stored-report decoding and current rule/corpus/source/projection validation. Exact rules/report/metadata/checksum and phase4 reconstruct committed result; all absent is absent; partial is unknown. No retrieval recomputation, rule/report insert or missing-phase repair. |
| `V2ShadowCompatibilityMaterializer.reconcile(input)` | Reuse full authenticated input/claim/ack/target proof and `verifyOnly`, never preparation/publication. All expected exact claims/acks/targets is committed; a fully authenticated zero-artifact input is also committed. Nonzero input with atomically no claims or acks proves it has not crossed its mandatory claim-before-publish boundary; otherwise incomplete state is unknown. Contradictory evidence/target bytes fails integrity. |

Source verification has no durable mutation to reconcile; repeat its read-only authentication safely without inventing a committed/absent result. Runner-owned phases0/1/2/5 use existing verified repository reads. Keep phase3/4 with their existing component owners, so installed generation/report without its phase is unknown in the current cycle, not permission to append that component's phase from the runner. No new DDL, repository API, coordinator or driver allowance is needed for these read-only seams. Reuse private authentication logic rather than duplicate its algorithm.

Add precise RED tests for committed/absent/unknown and exactly-once call counts, including package rename-before-response, source close-before-response, partial import before receipt/outbox, V1 image before manifest, V2 manifest before phase3, parity report before phase4, compatibility replacement before ack, and reconciliation read failure. Assert zero component writes during reconciliation, no repeat after unknown, and no duplicate semantic effects on a subsequent invocation. Inject faults at the actual named durable boundary, not after the entire method returns: narrow optional internal hooks in the already allowed publisher/parity/materializer files may bridge the runner's approved fault injector. In particular `after-compatibility-replace` fires after successful replacement/verification and before ack, while `after-compatibility-ack` fires only after the ack transaction. Native worker/replacer APIs stay unchanged.

- [ ] **Step 1: Write end-to-end phase and recovery RED tests.**

Cover a clean run, completed-run no-op, restart before and after every durable boundary, retryable SQLite busy, transient I/O, interrupted worker, retry exhaustion, commit-unknown proved committed, commit-unknown proved absent, unresolved unknown, source mutation between phases, blocking parity, compatibility lag, rollout revision mismatch, active non-off rollout state, and unchanged V1 caller result:

```ts
test("commits all phases in order and returns a verified result", async (t) => {
  const fixture = await runnerFixture(t);
  const result = await fixture.runner.run(fixture.input);
  assert.equal(result.status, "compatibility-complete");
  assert.deepEqual(fixture.repository.phases(), [
    "snapshot-verified", "package-sealed", "import-committed",
    "projection-verified", "parity-complete", "compatibility-complete",
  ]);
  assert.equal(result.parity.blockingDivergenceCount, 0);
  assert.equal(result.compatibility.acknowledgedCount, fixture.expectedArtifacts.length);
  assert.deepEqual(await fixture.invokeV1Probe(), fixture.v1ProbeBefore);
});

test("resumes after every acknowledged durable boundary", async (t) => {
  for (const boundary of SHADOW_MIGRATION_FAULT_BOUNDARIES) {
    const fixture = await runnerFixture(t, { failOnceAt: boundary });
    await assert.rejects(fixture.runner.run(fixture.input));
    fixture.disableFaults();
    const recovered = await fixture.runner.run(fixture.input);
    assert.equal(recovered.status, "compatibility-complete", boundary);
    assert.deepEqual(fixture.repository.phases(), [...SHADOW_MIGRATION_PHASES], boundary);
    assert.equal(new Set(recovered.import.eventIds).size, recovered.import.eventIds.length, boundary);
  }
});
```

- [ ] **Step 2: Run runner tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-runner.test.js
```

Expected: compilation fails because the orchestrator and fault boundaries do not exist.

- [ ] **Step 3: Define exact run input/result and phase gates.**

```ts
export const SHADOW_MIGRATION_FAULT_BOUNDARIES = Object.freeze([
  "after-source-verified", "after-package-published", "after-run-created",
  "after-import-commit", "after-projection-publish", "after-parity-report",
  "after-compatibility-replace", "after-compatibility-ack",
] as const);

export type ShadowMigrationFaultBoundary = (typeof SHADOW_MIGRATION_FAULT_BOUNDARIES)[number];

export interface ShadowMigrationFaultInjector {
  hit(boundary: ShadowMigrationFaultBoundary): void | Promise<void>;
}

export interface V2ShadowMigrationRunInput {
  readonly projectId: string;
  readonly rolloutRevisionId: string;
  readonly targetContext: ProjectContext;
  readonly sourceRoot: string;
  readonly sourceManifestPath: string;
  readonly liveEventStorePath: string;
  readonly liveLegacyArtifactRoot: string;
  readonly packageRoot: string;
  readonly v1ProjectionRoot: string;
  readonly v2ProjectionRoot: string;
  readonly compatibilityRoot: string;
  readonly buildIdentityHash: string;
  readonly configuration: ShadowMigrationConfigurationV1;
  readonly policy: ShadowMigrationPolicyV1;
  readonly sealedRetrieval: Readonly<{
    corpus: SealedRetrievalEvaluationCorpusV2;
    expectedBundle: RetrievalEvaluationBundleV2;
  }>;
  readonly expectedDifferenceRules: readonly ExpectedDifferenceRuleV1[];
  readonly creationReasonCode: "production-shaped-rehearsal";
}

export interface V2ShadowMigrationRunResult {
  readonly schemaVersion: 1;
  readonly status: "compatibility-complete";
  readonly migrationIdentity: string;
  readonly rolloutRevisionId: string;
  readonly sourceManifestChecksum: string;
  readonly packageChecksum: string;
  readonly import: V2ShadowImportResult;
  readonly projection: ShadowProjectionResult;
  readonly parity: SnapshotParityReportV1;
  readonly compatibility: CompatibilityMaterializationResult;
  readonly deduplicated: boolean;
}
```

At entry use the actual `RolloutControlPlane.state()` shape and require `mode === "off"`, `revisionId === null` (the stored `active_revision_id`), and no caller-facing activation. `RolloutControlPlane.revision(projectId, rolloutRevisionId)` already provides the expected `migrationIdentityHash` read-only for early run lookup; do not wait for package mutation to discover that locator. Verify actual isolated connection ownership, policy/configuration, source, sealed corpus and the early revision/existing-run pin above. Then seal the package and call `prepareV1Baseline`. Require the revision's project, build, configuration, migration identity, and V1 baseline checksum to match prepared values. Insert the run and append `snapshot-verified` and `package-sealed` in separate committed transactions before import. Never create/change a rollout revision. Recheck off-state, immutable revision, source/package identities, full chain and bound corpus before each phase and completed return.

Before every phase call `source.assertUnchanged()`, re-read/verify the ledger chain, and verify all prior artifact checksums. Derive committed transition `recordedAt` values from `sourceManifest.createdAt + phase ordinal milliseconds`; measure real elapsed time through a separate monotonic clock that never enters a transition hash. Append a committed phase only after its component has been durably re-read and verified. A completed chain returns the reconstructed verified result with `deduplicated: true` and adds no semantic row/event/artifact.

- [ ] **Step 4: Add bounded retry and attempt evidence.**

Classify only primary SQLite busy, explicitly injected transient filesystem codes (`EBUSY`, `EAGAIN`, `EINTR`), and interrupted-worker errors as retryable. Use the exact sealed backoff:

```ts
const delay = Math.min(
  policy.maxBackoffMs,
  policy.initialBackoffMs * (2 ** attemptIndex),
);
```

Before sleeping or retrying, append a redacted attempt-evidence row containing operation, phase, attempt index, category, safe error code, prior durable phase, and evidence digest. Do not persist `error.message`, stack, paths, payloads, or command text. Re-verify source and durable phase after every delay. Stop when the shared monotonic budget reaches zero or attempt index exceeds `maxRetries`; append `retry-exhausted` attempt evidence and throw `MIGRATION_RETRY_EXHAUSTED` unless a possible durable outcome must remain explicitly unknown. Do not spend a new phase/retry budget after expiry.

Pre-run source/package/baseline work can fail before a run row exists, including baseline failure after package identity is known. Buffer exact redacted attempts until the run exists, then insert them immediately after its row. Otherwise throw the genuine internal `V2ShadowMigrationPreflightFailure` with a deep-frozen own-data evidence copy: schemaVersion1, rolloutRevisionId, sourceManifestChecksum or null, verified migrationIdentity or null, and ordered attempts. Each attempt contains attemptId, operation (`source-verify`, `package-seal` or `baseline-prepare`), operationAttemptIndex, the existing four-category outcome union, allowlisted safeErrorCode, evidenceDigest and canonical observed UTC recordedAt. Operational attempt time is outside the committed phase determinism vector. Map phase/prior-phase/ordinal to exact repository rows when flushing the buffer; do not invent a provisional run/identity or use a merely expected revision hash as a verified package result. Task11 produces this carrier only; Task12 owns its strict serializer and explicit failure output authority. Test baseline exhaustion with known identity/no run, deep immutability, exact redaction and rejection of generic/crafted error lookalikes.

For `MIGRATION_OUTCOME_UNKNOWN`, call a component-specific reconciler exactly once per retry cycle. It returns `committed`, `absent`, or `unknown`; committed advances only after verification, absent may repeat the same deterministic operation, and unknown records evidence then exits without another write.

- [ ] **Step 5: Run end-to-end, crash, and V1-isolation verification.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-runtime.test.js dist-test/tests/v2-shadow-migration-runner.test.js dist-test/tests/v1-source-copy.test.js dist-test/tests/v2-migration-package.test.js dist-test/tests/v2-shadow-importer.test.js dist-test/tests/v2-shadow-projection.test.js dist-test/tests/v2-snapshot-parity.test.js dist-test/tests/v2-shadow-compatibility.test.js dist-test/tests/retrieval-evaluation.test.js dist-test/tests/retrieval-service.test.js dist-test/tests/lifecycle-compatibility.test.js
npm run typecheck
```

Expected: all tests pass; every restart converges or blocks safely; no V1 result or live source/target byte changes.

- [ ] **Step 6: Commit durable orchestration.**

```powershell
git add src/orchestrator/migration/v2-shadow-migration-runner.ts src/orchestrator/migration/v2-shadow-migration-runtime.ts src/orchestrator/migration/v1-source-copy.ts src/orchestrator/migration/v2-migration-package.ts src/orchestrator/migration/v2-shadow-importer.ts src/orchestrator/migration/v2-shadow-projection.ts src/orchestrator/parity/v2-snapshot-parity.ts src/orchestrator/retrieval/evaluation.ts src/orchestrator/retrieval/service.ts src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts tests/support/v2-shadow-migration-fixture.ts tests/v2-shadow-migration-runner.test.ts tests/v2-shadow-migration-runtime.test.ts tests/v1-source-copy.test.ts tests/v2-migration-package.test.ts tests/v2-shadow-importer.test.ts tests/v2-shadow-projection.test.ts tests/v2-snapshot-parity.test.ts tests/retrieval-evaluation.test.ts tests/retrieval-service.test.ts tests/v2-shadow-compatibility.test.ts
git commit -m "feat: orchestrate V2 shadow migration"
```

#### Task 11A: Shared deadline and immutable-source integration

**Execution decomposition (2026-09-12):** Task11's original requirements above remain authoritative and unchanged. The implementer identified that shared deadlines, six component reconcilers, deterministic adoption and the full runner are too large for one coherent implementation/review unit. Execute units11A–11F sequentially with one implementer at a time and independent scoped review after each. These units do not add top-level rollout tasks or remove requirements. Task11 stays unchecked until11F, the aggregate eleven-file gate above and all unit reviews pass. Preserve the current observed RED and partial work; do not restart the task.

**Files:**
- Create: `src/orchestrator/migration/v2-shadow-migration-runtime.ts`
- Modify: `src/orchestrator/migration/v1-source-copy.ts`
- Create: `tests/v2-shadow-migration-runtime.test.ts`
- Modify: `tests/v1-source-copy.test.ts`

**Requirements:**
- Implement `ShadowMigrationInvocationDeadline` with exactly `remainingMs(): number` and `signal: AbortSignal`, plus factory `createShadowMigrationInvocationDeadline(durationMs, now?)` returning the frozen deadline with idempotent `dispose()`. Enforce the original policy duration domain1..300000, finite non-regressing monotonic time, a positive safe-integer remainder at most the original duration, and `MIGRATION_RETRY_EXHAUSTED` on expiry/non-finite/regressed time. The same supplied object must be retained, not copied into a new budget. Dispose owned timers reliably; test signal/disposal behavior and the documented cooperative, not hard-cancellation, semantics.
- Export strict `canonicalShadowMigrationUtc(value)` and `shadowMigrationPhaseMetadata(identity, sourceCreatedAt, ordinal)` producing frozen deterministic `attemptId`/`recordedAt`. Reuse existing deterministicMigrationUuid with purpose `attempt`; phase ordinal is0..5 and time is source creation plus that many milliseconds. Validate canonical four-digit-year UTC and arithmetic range; no wall-clock timestamp or random ID in committed metadata. Actual-rule UTC remains distinct and is integrated later.
- Declare the readonly exact `ShadowMigrationReconciliation<T>` committed/absent/unknown union and allowlisted `ShadowMigrationErrorCode` from the parent task. This unit does not implement component reconciliation or pretend readonly TypeScript types prove runtime freezing; the later component owners must return strictly frozen validated variants.
- Add only the optional shared-deadline seam to existing source-copy verification, descriptor/event/read/write/replay and identity checks, owned scratch opening, `assertUnchanged()` and successful return. Preserve standalone behavior when absent, readonly source authority, all pre/post identities/hashes, limits, cleanup and redaction. Deadline failure must retain its typed code and cleanup owned scratch/resources rather than becoming a generic source failure. No abandonment of synchronous work or leases.
- Cover duration/remainder bounds, clock non-finiteness/regression/expiry, signal/disposal, identical phase metadata under different actual clocks, UTC/ordinal/arithmetic refusal, source-loop expiry, late-success refusal, unchanged source/owned-scratch cleanup and unchanged standalone source behavior. Preserve production writer/decoder authentication. Existing foundational RED already observed remains valid evidence.

**Verification and handoff:** Run focused RED/GREEN while iterating, then fresh `npm run test:build`, one serial `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-runtime.test.js dist-test/tests/v1-source-copy.test.js dist-test/tests/projection-source-event-codec.test.js dist-test/tests/stored-event-authenticator.test.js`, and `npm run typecheck`. Retain complete commands/output and all partial failures. Commit only these four files. Report to ignored `task-11A-report.md`, explicitly listing unimplemented remainder; controller supplies exact-range unit review. Parent Task11 and its six original steps remain open.

#### Task 11B: Package and importer reconciliation

**Scope:** Complete only package/importer shared-budget and read-only reconciliation integration. Consume the independently reviewed11A runtime/source helpers. Parent Task11, units11C–11F and release tasks remain open; no runner, phase append, telemetry, corpus loader, source acquisition, new schema/repository/driver API or public V1 change belongs here.

**Files:**
- Modify: `src/orchestrator/migration/v2-migration-package.ts`
- Modify: `src/orchestrator/migration/v2-shadow-importer.ts`
- Modify: `tests/v2-migration-package.test.ts`
- Modify: `tests/v2-shadow-importer.test.ts`
- Modify only as needed for production-backed bound connection/fault fixtures: `tests/support/v2-shadow-migration-fixture.ts`

**Interfaces and existing authority:**
- Add optional `invocationDeadline: ShadowMigrationInvocationDeadline` to package seal/open inputs and `V2ShadowImportInput`. Preserve callers without it. Retain the same object in returned package handles/iterators; no component-created replacement budget when supplied. Importer consumes the same object explicitly, even if a package handle was obtained earlier.
- Add optional `eventStorePath: string` to `V2ShadowImporterDependencies`. When supplied, assert the existing genuine open-time connection binding against that exact isolated target before transaction entry, after synchronous/await boundaries as applicable, before semantic mutations and before success. `reconcile` requires this bound path; the future runner supplies both path and invocation deadline. Use the Task10 checker, never PRAGMA-only path equality or a caller-constructed binding token. The original caller context may route to the V1 authority and the synthetic deterministic import context intentionally uses a non-filesystem route; neither substitutes for this explicitly supplied isolated target path. Preserve ordinary import callers without the optional path.
- Export `reconcileSealedV2MigrationPackage(input)` with source, packageRoot, policy, buildIdentityHash, configurationChecksum, expectedMigrationIdentity and optional invocationDeadline. `expectedMigrationIdentity` is the named immutable revision's already available migrationIdentityHash, not a guessed/provisional identity. Return `ShadowMigrationReconciliation<SealedV2MigrationPackage>`; committed transfers the verified read-only handle to the caller, all other exits close anything opened.
- Add `V2ShadowImporter.reconcile(input): ShadowMigrationReconciliation<V2ShadowImportResult>` using the same import input. Return exactly frozen committed/result, absent, or unknown/safeErrorCode variants. Result data is frozen with existing bigint/null semantics; safe codes come only from `ShadowMigrationErrorCode`. Contradictory authenticated present evidence throws the existing typed integrity/conflict error, not absent or a retryable success.

**Single-budget checks and mutation classification:**
- Source, package descriptor/event/artifact/chunk loops, full package opening/content/identity validation, retained record/chunk iterators, planning/batch loops, SQL boundaries and final revalidation/success all spend the supplied remainder. Do not clone or reseal policy, grant fresh time for reopening/reconciliation, raise a bound, abandon mutation with Promise.race or claim hard wall-clock termination. Preserve default local behavior when the optional object is absent.
- Preserve `MIGRATION_RETRY_EXHAUSTED` through broad catches when no durable target publication/append may have occurred. Once final package rename or an EventStore append may have committed, lost response or expiry remains `MIGRATION_OUTCOME_UNKNOWN`; do not return late success or continue receipts/outbox/another batch after expiry. Owned temporary/handle cleanup remains required. A pre-existing committed state verified without new mutation is not itself a newly attempted write.
- Compatibility ruling (approved design section 4.3): post-publication expiry is unknown even when a standalone caller uses the existing local clock instead of `invocationDeadline`. Preserve the standalone duration, clock and pre-publication error behavior; specifically retain `MIGRATION_LIMIT_EXCEEDED` for local expiry while only verifying an already-existing target. The legacy fresh-target final-completion assertion changes from limit-exceeded to outcome-unknown because this invocation already renamed the final target, not because its time bound changed. Keep the original failing output and exact before/after-publication regressions.
- Reconciliation uses the same object and rechecks before return. Exhaustion or ambiguous read cannot prove absent or committed; return unknown with an allowlisted safe code, or preserve a typed expiry for the runner to retain its prior unknown classification. Never grant a new reconciliation budget. Invalid/mismatched known authority remains terminal, not transient IO.

**Package proof:**
- Validate canonical isolated source/package-root relationships and policy/build/configuration fields without creating directories or files. Locate only the exact expected-identity final target. Reuse current manifest, identity, content and source authenticators; committed requires the exact source-manifest, full policy, build and configuration bindings plus unchanged source and package identities/hashes.
- Absent requires stable final-target ENOENT under an unchanged verified existing parent, including canonical non-symbolic ancestor checks. Parent replacement, denied access, uncertain IO or partial final target is unknown. Authenticated contradictory manifest/content/identity is terminal. Preserve enough internal failure classification to distinguish IO uncertainty from proven corruption; do not interpret the existing broad conflict wrapper as proof that every read failed due to corruption.
- Reconciliation never calls seal, mkdtemp/mkdir, write, fsync, rename, quarantine, adoption or phase/repository writers. A temporary/orphan sibling is not permission to clean or publish it. A committed package handle must still reject mutation and later consumption after expiry.

**Importer proof:**
- Construct the reconciler's production command/dedup statements from the genuinely checked connection. The independently injectable `dependencies.statements` object has no provenance proof and cannot supply evidence from another native store. Reuse current SqliteEventAppendStatements/EventAppendTransaction without a new API. A distinct real foreign statement set must not influence proof or be consulted; exact committed/absent results still depend only on the checked target's actual state.
- Within one genuinely bound atomic read transaction, cover the complete expected deterministic command/idempotency/dedup/event set and all owned receipts/outboxes. Reuse `streamBatches`, `planCommand`, production EventAppendTransaction preparation/replay verification or equivalent existing authenticators, `readCommitted`/receipt/outbox checks; do not duplicate canonical command hashing/encoding. Only read-only transaction callbacks are allowed. No EventStore.append, insert/backfill, phase append or compatibility claim/ack.
- All exact is committed, with the same deterministic result as normal import and deduplicated=true. All expected command/dedup/event/receipt/outbox evidence absent is absent. Any subset, including events and dedup committed before receipt/outbox insertion or one completed batch of a multi-batch import, is unknown. A valid empty package has no effects to perform and is committed after complete input/run authentication. Reject contradictory present values and extra owned receipts/outboxes rather than repairing or ignoring them. Authenticate the existing run/package/source bindings in every case.
- Preserve Task10 atomic receipt/outbox insertion and no-duplicate normal retry behavior. Reconciliation itself must leave evidence rows and target/source/package bytes unchanged; later ordinary import in a fresh invocation may perform its existing authenticated receipt/outbox completion. This is whole-import reconciliation, not a new public per-batch API.

**Required RED/GREEN coverage:**
- Package: all-absent, exact-committed, partial final target, contradictory content/binding, parent identity uncertainty and access/read failure; actual after-final-rename-before-response fault; expiry before publication versus after possible publication; opening, iterator and late-return exhaustion; no reconciliation publication/quarantine/cleanup or source changes.
- Importer: all-absent, exact complete, empty input, partially committed batches, real EventStore after-commit-before-response with missing receipts/outbox, inconsistent dedup/command/response/event/receipt/outbox evidence and read failure. Verify reconciliation performs zero semantic writes and a subsequent ordinary fresh invocation produces no duplicate event/outbox.
- Bound target: genuine native existing connection succeeds; missing/unbound/closed/forged wrapper and wrong target refuse before reconciliation reads/mutations. Reuse real Task10 driver provenance, never mocks that fabricate an authenticated connection. Any OS-prevented rename is reported as prevention, not an executed stale-handle proof.
- Shared deadline: no reset across open/seal/import/reconcile, source/package preservation and owned-resource cleanup, actual append-then-expiry remains unknown without receipts/next-batch writes, standalone defaults remain covered. Fault hooks are narrow internal options at the named real boundary, not a throw after the complete component has already returned. Transparent failing read/clock seams may wrap production behavior but may not fake successful durable evidence.

**Verification and handoff:** Observe focused RED before implementation and focused GREEN while iterating. Then run fresh `npm run test:build`, one serial `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-runtime.test.js dist-test/tests/v1-source-copy.test.js dist-test/tests/v2-migration-package.test.js dist-test/tests/v2-shadow-importer.test.js dist-test/tests/sqlite-driver.test.js dist-test/tests/v2-shadow-compatibility.test.js`, and `npm run typecheck`. Record complete commands/output including failures/skips/platform limitations. No concurrent suites. Commit only the allowed changed code/test files; preserve controller-owned plan/ledger. Report to ignored `task-11B-report.md`, with exact exports, tests, scope, remaining parent requirements and memory closure. Controller supplies independent exact-range spec/quality review before11C.

#### Task 11C: Projection deadline, deterministic phase and read-only proofs

**Scope:** After11B independent acceptance, finish only the existing publisher's shared deadline, deterministic phase3/adoption and component-owned read-only proofs. Consume reviewed11A/B exports and existing imported reader/integrity/manifest/lease APIs; do not add a new coordinator, change storage/worker APIs or implement the runner, parity or compatibility units here.

**Files:**
- Modify: `src/orchestrator/migration/v2-shadow-projection.ts`
- Modify: `tests/v2-shadow-projection.test.ts`
- Modify only the existing V1 private-image busyTimeoutMs forwarding call: `src/orchestrator/projections/integrity.ts`
- Modify only when needed for real native bound target/phase/fault fixtures: `tests/support/v2-shadow-migration-fixture.ts`

**Interfaces and deadline:**
- Add optional `invocationDeadline: ShadowMigrationInvocationDeadline` to `V1ProjectionBaselineInput`, inherited by `ShadowProjectionInput`. Normal prepare/publish callers without it preserve standalone defaults; the future runner always supplies it. All paths retain and spend the same object, including repeated V1-baseline checks, native snapshot opening, publication, integrity replay, phase adoption/append and successful return.
- Use the existing explicit isolated `eventStorePath` in publisher options with Task10's genuine bound-connection checker on the runner path. New reconcilers require genuine binding even when no shared deadline is supplied. Check before transaction entry, after awaits and before writes/return; do not substitute PRAGMA path equality or the source/synthetic context for connection provenance. Preserve the existing path/identity/overlap/source/live-vault checks as well.
- Narrow existing imported-reader and ProjectionIntegrityService `busyTimeoutMs` options from the current remainder immediately before their native work. Narrow `ensurePublished`'s existing numeric duration from that remainder. Do not invent per-call timeout parameters for stable-directory operations, clone policy, reset time or widen into coordinator/driver cancellation. Check around exposed synchronous/await boundaries; genuine snapshot iteration may be transparently guarded without changing authenticated event contents or ownership.
- Controller scope correction (2026-09-12): `#inspectV1Generation` omits the existing `busyTimeoutMs` argument when calling `openImmutableProjectionImage`, silently restoring5000ms even when the publisher supplied a narrowed timeout. Permit only forwarding that existing service option in `src/orchestrator/projections/integrity.ts`, preserving its existing default and error behavior; observe an actual native-timeout RED before fixing. Include the existing projection-integrity test file in the final gate. The stable directory read-generation-image operation only accepts V2 generation names; V1 pre/post byte observation may use a private descriptor-bound streaming hash helper in the publisher under the verified lease, with bounded buffers, deadline boundaries and pre/post descriptor/entry/directory identity, size, ctime and single-link checks. No new export, parser/replay duplication, worker API or other integrity behavior is authorized.
- Preserve typed exhaustion before possible durable publication. Expiry/lost response after a generation/manifest/phase may have been written remains `MIGRATION_OUTCOME_UNKNOWN`; refuse later writes and late success. Preserve primary failures through secondary lease/snapshot cleanup, still attempt all safe owned cleanup, and do not report uncertain cleanup as successful. Non-cancellable native/build/snapshot awaits are allowed to settle and must then be closed/refused on expiry, not abandoned with Promise.race.

**Deterministic phase3 and adoption:**
- Replace random phase3 attempt ID/time with `shadowMigrationPhaseMetadata(migrationIdentity, verifiedSource.createdAt, 3)`. Both V1/V2 manifests retain the package/source creation timestamp. Keep the full existing transition hash preimage/domain and all repository ordering constraints. This does not grant the publisher authority over phases0/1/2/4/5.
- Existing phase3 adoption requires its exact expected attemptId, recordedAt, evidenceDigest, predecessor, ordinal and phase in the authenticated chain; mismatch is terminal integrity failure. Never rewrite immutable prior rows or accept only matching phase/evidence. Current actual UTC/rule authorization remains unit11D/11F work.

**Read-only proofs:**
- Add async `reconcileV1Baseline(input): Promise<ShadowMigrationReconciliation<PreparedV1ProjectionBaseline>>` and `reconcileV2(input): Promise<ShadowMigrationReconciliation<ShadowProjectionResult>>`. Return exactly frozen committed/result, absent or unknown/safeErrorCode variants. Preserve all existing result fields, including V2 directoryIdentity captured from the verified directory. Known contradictory present content/identity is terminal; partial or uncertain reads are unknown.
- Lease/open/verify existing files only. Never call prepareV1Baseline, publishV2, recoverV1Generation, build, ensurePublished, semantic manifest/image publication, quarantine, phase insertion or missing-phase adoption during proof. Do not create a missing projection root to test its absence. Owned lock/lease housekeeping is permitted only through the current verified lease API and must be released; no recovery/retirement side effects are authorized.
- V1 committed requires the exact existing manifest and image authenticated against the full verified source/package, deterministic generation/time and baseline checksum, with pre/post directory/file/content checks. No manifest/image is absent; an orphan image, manifest without image or ambiguous read is unknown. A temporary/partial state is not permission to recover it during this cycle.
- V2 committed additionally authenticates the original V1 baseline read-only, all current run/revision/source/package/policy bindings, the imported committed snapshot, exact V2 binding/terminal/core/image/manifest checksums and deterministic phase3. No V2 image/manifest/phase3 is absent after valid input/run authentication; any subset, including published V2 manifest without phase3, is unknown. Do not reconstruct success from unverified filenames or append the missing component phase. Present contradictory evidence is terminal. Recheck bound connection, source/package and shared budget before return; close every acquired snapshot/lease on all exits.
- Unknown reconciliation is itself read-only and receives no new budget. A subsequent invocation may use existing normal authenticated adoption. Preserve allowlisted typed errors/redaction rather than converting uncertainty to proof of absence.
- Controller ruling (2026-09-12): at the existing integrity-verifier call boundary only, an opaque `LifecycleError(INTEGRITY_FAILURE)` cannot distinguish native read/cleanup uncertainty from corruption, so reconciliation returns unknown after budget/authority checks. Explicit publisher manifest/image/binding/phase contradictions and allowlisted typed source/package/target-authority/deadline errors retain their classifications; normal prepare/publish verification is unchanged. Do not duplicate the integrity implementation or infer a stripped cause. Existing repository `transact` is allowed for a synchronous reads-only proof callback, with genuine connection/budget guards before entry, after reads, before callback return and after completion. BEGIN IMMEDIATE/COMMIT/ROLLBACK are transaction/lock housekeeping, not a promise of zero filesystem I/O; no semantic mutations, recovery or adoption are allowed. Cover opaque verifier read uncertainty and independently known contradictions separately.

**Required RED/GREEN coverage:**
- Real V1 image-before-manifest and V2 manifest-before-phase3 faults, exact committed/absent/partial/contradictory/read-failure variants, and zero semantic writes during each proof. Use actual publisher/SQLite/authenticators; fault at the named durable boundary. Existing before-v1-manifest and before-v2-integrity hooks have real boundary semantics; preserve old hook behavior or add a narrowly named alias without changing coordinator/native APIs.
- Same source under different actual monotonic origins produces identical phase3 ID/time/hash; malformed/mismatched prior phase3 metadata refuses adoption without rewriting rows. Published manifest/image bytes remain unchanged on valid normal adoption and reconciliation; immutable phase rows remain unchanged on adoption/refusal. Existing normal ensurePublished may advance its reconciliation journal. Read-only reconciliation must preserve the entire observed directory: capture immediately before each proof, after any earlier normal adoption, and compare afterward. This clarification does not authorize coordinator changes or any journal/recovery/publication work inside proof.
- Genuine bound connection success and unbound/closed/forged/wrong-target refusal before protected reads/writes. Test files may bootstrap a disposable target then reopen with reviewed opt-in binding; never fabricate a trusted handle. Keep real platform limitations distinct from executed authority checks.
- Deadline never resets across repeated baseline, snapshot, publication, integrity and phase work. Cover pre-write expiry, possible-publication unknown, request-time native narrowing, no phase write/late success after expiry, unchanged source/package and complete safe cleanup. Include a pending non-cancellable snapshot/lease await that settles after expiry: wait for it, close it exactly once and reject without subsequent writes. The test must not claim preemption or abandon a real resource.
- Retain current projection cleanup-failure, source tamper, orphan recovery, revision binding and protected/unrelated target controls. Do not replace real fixture setup with fake successful persistence.

**Verification and handoff:** Focused observed RED/GREEN while iterating; then fresh `npm run test:build`, one serial `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-runtime.test.js dist-test/tests/v2-shadow-projection.test.js dist-test/tests/v2-imported-event-reader.test.js dist-test/tests/v2-snapshot-parity.test.js dist-test/tests/v2-shadow-compatibility.test.js dist-test/tests/projection-integrity.test.js`, and `npm run typecheck`. Record complete commands/output, all failures/skips and cooperative/platform limits. Commit only authorized code/test files; preserve root plan/ledger. Write ignored `task-11C-report.md` and obtain independent exact-range review before11D. Parent Task11 stays open.

**Task11C qualified review checkpoint (2026-09-12):** At unchanged scoped diff44f822d01e8493c5a7c5ac9b7b0b234dbba55d47, the fresh six-file run completed253tests/250pass/3fail/0skip, including51 passing publisher leaves. Three failures occurred in unchanged V2 fixture setup before the integrity assertions: one explicit worker ETIMEDOUT and two opaque lease-release conflicts. A single unchanged-code exact-three-leaf follow-up passed3/3; fresh build/typecheck passed. The permitted DONE_WITH_CONCERNS commit/handoff received independent specification-compliant and task-quality-approved verdicts with no Critical/Important code finding. This is not unit acceptance or a clean aggregate claim. Preserve both outcomes, unresolved causes and platform limits; no test/bound/worker changes or final qualification waiver. A completed bounded read-only audit established no concrete preceding mock/fault/handle leak, but cannot prove the absence of native cleanup failures or recover discarded release causes. Controller authorizes exactly one fresh build, unchanged six-file serial aggregate and separate typecheck on5cbbc65, with no observer/test/runtime/bound changes. Any repeated failure ends reruns and requires a focused cause-capture decision; a later pass is current qualification, never a causal fix for the historical failures. Task11C remains open and11D has not started. Historical fingerprint warning noise is a deferred Minor; future captures retain parsed hashes separately from raw warnings without rewriting history.

**Task11C acceptance (2026-09-19):** The previously authorized qualification was interrupted after39 leaves without a recoverable aggregate/exit. After bounded recovery and OS-only reboot evidence, the controller authorized one replacement with independently durable raw/native completion capture; source, tests, assertions and bounds stayed unchanged. That replacement completed fresh build0, the exact six-file serial gate253tests/253pass/0fail/0skip/976086.4895ms/native exit0, and separate typecheck0. Controller read complete raw stdout/stderr, all command responses and native completion records, the final appended report and unchanged code mapping `44f822d01e8493c5a7c5ac9b7b0b234dbba55d47` at `5cbbc65417f1d25d6f6b89b7435685f5e1e3cc9e`. Together with the existing clean independent spec/quality review, this closes11C only and authorizes11D. No historical result or unknown cause is relabeled; historical metadata-noise Minor and Windows/cooperative-deadline/security qualifications stay recorded. Parent11,11D–11F,12–14 and final release/production gates remain open.

#### Task 11D: Retrieval and parity deadline, corpus and adoption

**Scope:** After11C review, integrate the already approved runtime budget and deterministic metadata with existing retrieval/parity, expose shared source/corpus authentication for11F, and add read-only parity reconciliation. No new corpus format, threshold, expected-difference exception, ranking policy, vector algorithm, registry, repository API or caller-facing V2 registration.

**Files:** Modify only `src/orchestrator/retrieval/evaluation.ts`, `src/orchestrator/retrieval/service.ts`, `src/orchestrator/parity/v2-snapshot-parity.ts`, their corresponding `tests/retrieval-evaluation.test.ts`, `tests/retrieval-service.test.ts`, `tests/v2-snapshot-parity.test.ts`, and shared `tests/support/v2-shadow-migration-fixture.ts` only when required for genuine native fixtures.

**Reusable source/corpus authentication:**
- Extract current private `verifiedCorpus` logic into exported `authenticateSealedRetrievalSource(corpus, source, invocationDeadline?)`, returning the fully parsed `SealedRetrievalEvaluationCorpusV2`. Reuse it from parity; the runner will consume it without duplicating source comparison. Preserve strict own-data/proxy/accessor/array validation, reparse all four logical artifacts using existing parseSealedRetrievalEvaluationBundle, authenticate exact original stored event envelopes against the verified source, and validate every query's complete binding and terminal position. Check the shared remainder through exposed validation/source/query loops and before return.
- Preserve the existing standalone parity `sealedRetrieval: { corpus }` input shape. Parent11F separately compares the exact full parsed bundle against externally approved expectedBundle and pins it before preparation; this helper authenticates integrity, not external approval. No query slicing, resealing, rebaselining, source-envelope approximation, disk loader or source acquisition. Frozen corpus and baseline remain byte/structure unchanged.

**One runtime budget through retrieval:**
- Consume inherited optional invocationDeadline in SnapshotParityInput from reviewed11C. Add optional runtime deadline parameters to InternalRetrievalService.retrieve and the evaluation call chain (evaluateOne/evaluateRetrievalQueries/evaluateRetrieval/evaluateSealedRetrieval as needed), preserving existing calls without them. Pass the same object into each service invocation; do not put runtime state into InternalRetrievalRequest JSON or sealed policy/corpus.
- Narrow only freshly built retrieval request consistency.deadlineMs to the smaller original query limit/current positive remainder. Recheck immediately before numeric-timeout work and after awaits. Never change the sealed query, grant a new budget, increase limits or alter ranker/vector behavior. Keep sealed evaluation's vector-disabled requirement.
- Preserve MIGRATION_RETRY_EXHAUSTED through evaluation's failed-outcome catch, parity threshold catches and direct query-result catches. Check source/corpus/row/query loops, synchronous candidate/ranking boundaries, lease acquisition and cleanup, comparison/report/phase boundaries and final/no-op return. Existing non-timeout evaluation failures still follow their established safe-vector/threshold behavior.
- Await a non-cancellable pin/lease operation to settlement, then own/close the real lease even when already expired. Place deadline checks inside the resource-owning try/finally, preserve a primary timeout through secondary cleanup errors, attempt all safe closes, and refuse post-cleanup late success. No Promise.race abandonment or new cancellation API. Keep the V1/V2 parity bridge's original private-image ownership; per-query facades do not transfer or close the retained original early.
- Narrow currently exposed native imported-reader/canonical-inspection busyTimeoutMs options from the shared remainder. Synchronous work with no lower-level deadline seam remains cooperative, checked at exposed boundaries, not falsely claimed preemptible.

**Authority, metadata and normal adoption:**
- Retain all current target/source/live/projection overlap checks and use genuine bound connection assertions on the runner path after awaits and before evidence transactions/writes. Read-only reconciliation always requires the genuine target. Construct/read repository evidence only on that checked connection, not a foreign injected authority.
- `runStartedAt` remains strict canonical actual UTC used to validate each original rule's exact checksum, policy/revision/migration/scope, issue/expiry and maximum age. It is never renewed or replaced with deterministic metadata. A fresh invocation/no-op with expired, future-issued or too-old original rules refuses acceptance without changing them.
- Use `shadowMigrationPhaseMetadata(identity, verifiedSource.createdAt, 4)` for StoredParityReport.recordedAt and committed phase4 attemptId/recordedAt. Preserve report body/checksum, manifest times, full transition hash preimage and component ownership. Adoption requires all immutable stored fields plus exact expected phase ID/time/evidence/predecessor; no repair/rewrite of contradictory prior records.
- Shared expiry before evidence writes must leave no newly inserted rules/report/phase. Once a rule/report/phase transaction may have committed, a lost response or expiry remains MIGRATION_OUTCOME_UNKNOWN, not an ordinary failed retrieval result. No later writes after expiry. Add a narrow internal fault hook after the actual report transaction and before phase4, preserving existing APIs otherwise.

**Read-only reconciliation:**
- Export async `reconcileV1V2Snapshots(input): Promise<ShadowMigrationReconciliation<SnapshotParityReportV1>>`. Reuse factored current target/run/revision/phase3/rule/corpus/projection validation and strict stored-report decoder/checksum logic, not compareV1V2Snapshots or duplicated algorithms. Validate current original-rule authorization, verified source/corpus, exact manifest/core/source/terminal/package bindings, all stored rule/report metadata/checksum and deterministic phase4 before committed success. Reconstruct a deeply frozen result with existing bigint semantics.
- No retrieval recomputation, evaluation, rule/report insertion, phase append, publication or adoption inside reconciliation. Owned read-only snapshots/leases may be opened for authentication and must close safely; no coordinator preparation/recovery. Rules/report/phase4 all absent is absent; any partial subset, including report without phase4, is unknown. Contradictory present data is terminal. A stored blocking report cannot be returned as successful parity. Ambiguous reads/expiry remain unknown or typed expiry for the runner to preserve its prior unknown status, never absence.
- A later normal invocation may perform existing authenticated adoption after revalidating original rules. The runner never writes component phase4 itself. Final evidence/source/package/connection/budget checks precede a successful return; cleanup must not mask a primary failure.

**Required RED/GREEN coverage:** Full corpus/query preservation and wrong-source/event/query binding refusal; shared helper used by parity; unchanged sealed request limits; evaluation/service/parity timeout propagation; native/request timeout narrowing; expiry before rule/report/phase writes; actual report-before-phase4 unknown/read-only proof/fresh-invocation adoption; complete absent/committed/partial/contradictory/read-failure matrix with zero semantic writes and zero retrieval calls during reconciliation; deterministic report/phase metadata under differing actual clocks; corrupt metadata refusal; current valid versus expired/future/too-old original rules on resume/no-op; genuine/foreign/unbound target refusal; real pending pin settlement/close-once and secondary-close failure; existing V1 retrieval/ranking/vector defaults, cleanup, redaction and forbidden-difference controls. Generate data only through production writers/helpers; no fake durable success or performance claim from functional clocks.

**Verification and handoff:** Observe focused RED/GREEN, then fresh `npm run test:build`, one serial `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-runtime.test.js dist-test/tests/retrieval-evaluation.test.js dist-test/tests/retrieval-service.test.js dist-test/tests/v2-shadow-projection.test.js dist-test/tests/v2-snapshot-parity.test.js dist-test/tests/v2-shadow-compatibility.test.js`, and `npm run typecheck`. Keep complete outputs/failures/skips and limitations. Commit only authorized code/test files, report exact exports and evidence in ignored `task-11D-report.md`, preserve root plan/ledger and obtain independent scoped review before11E. Parent11/11F owns the remaining full-run/early-pin/aggregate obligations.

**Task11D acceptance (2026-09-20):** Independent fix1 review closed I1 report-body cross-field authentication, I2 fresh vector allowance and I3 transaction write-boundary classification; its expanded reconciliation matrix was accepted. Independent fix2 review closed the residual I4 eager own-data traversal and I5 actual mid-traversal test coverage at `7159fcb`, with specification PASS and quality APPROVED and no new Critical/Important finding. The complete fresh fix2 build/parity23of23/typecheck capture and exact two-file tested-to-commit mapping were verified before acceptance. Unchanged dependency proofs and external full-bundle/early-pin/full-run obligations retain the documented split:11F owns orchestration and parent aggregate, while actual release/capacity/platform/source approval is still pending. Original metadata/platform Minor and historical review/capture qualifications remain recorded, not erased by this acceptance. This closes11D only and authorizes11E.

#### Task 11E: Compatibility shared deadline and read-only reconciliation

**Scope:** After11D independent review, add the parent task's same-object deadline, read-only compatibility proof and exact fault boundaries to the reviewed Task10 materializer. Preserve all source/import/artifact/claim/ack authentication, genuine target connection and existing stable native-worker publication/verification guarantees. No worker/replacer/driver/repository/schema change, no phase5 append (runner-owned), no source acquisition or live-vault write.

**Files:** Modify only `src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts`, `tests/v2-shadow-compatibility.test.ts`, and `tests/support/v2-shadow-migration-fixture.ts` only when required for production-backed fault/evidence fixtures.

**Runtime seam and normal materialization:**
- Add optional `invocationDeadline: ShadowMigrationInvocationDeadline` to CompatibilityMaterializationInput. Supplied object replaces the local operationNow budget and is retained through input/source/package/descriptor/event/evidence checks, every transaction, await, native child call and final/no-op return; absent callers keep existing local defaults.
- Pass the current positive remainder immediately before each unchanged verifyOnly/prepareParent/publishOrReconcile call. Do not reuse artifact.remainingMs sampled before a claim transaction or another await. Narrow exposed imported-reader/replay native timeout options when available; check synchronous loops/boundaries cooperatively where no timeout seam exists. No policy cloning, larger bound, new worker API or Promise.race abandonment.
- Reuse the existing genuine bound connection checker and full checkConnection/transact authorization, including after awaits and before claim/ack writes and return. Own all repository/event reads on that checked connection; no foreign injected authority. Preserve pre/post source/package identity/hash and target/protected-root checks.
- Before possible new claim/publication/ack, exhaustion remains MIGRATION_RETRY_EXHAUSTED. Once any durable component mutation may have occurred in this invocation, expiry/lost response remains MIGRATION_OUTCOME_UNKNOWN, even after a local acknowledgement flag has been reset. A pure verification/no-op of old evidence is not a new mutation. Do not let a broad typed-error catch erase this distinction, continue another artifact, write an ack/phase, or return unchecked late success.
- Preserve primary errors across snapshot/worker cleanup and attempt all safe owned close operations. Zero temporary payload bytes in finally as today. If non-cancellable work settles after expiry, await and close it, then refuse subsequent work; do not claim a hard wall-clock guarantee or silently abandon native work.
- Add narrow internal hooks at actual boundaries: after successful compatibility replacement/verification and before acknowledgement; after the acknowledgement transaction has committed. These bridge the future runner's after-compatibility-replace/after-compatibility-ack faults, not throws after the whole method returned. Native worker/replacer APIs remain unchanged.

**Read-only reconciliation:**
- Add async `reconcile(input): Promise<ShadowMigrationReconciliation<CompatibilityMaterializationResult>>`. Extract/reuse current complete validation and expected receipt/outbox/event/payload/claim/ack calculations, not materializePending and not duplicated hash/authority algorithms. Return exact frozen committed/result, absent or unknown/safeErrorCode variants using allowlisted codes; preserve existing bigint/null result fields, counts, aggregateBytes and artifactSetChecksum.
- Full source/package/committed-wrapper/run/revision/import-receipt/outbox/claim/ack authentication is required before any status. Keep all Task10 complete input, no-extra-evidence, event-envelope, deterministic ID/time, source payload checksum and same-store checks. A zero-artifact input is committed only after this complete proof; nullable positions/revision remain null.
- For a nonzero authenticated input, atomically no claims and no acknowledgements proves absent because its mandatory claim-before-publish boundary has not been crossed. A subset of authenticated claims/acks is unknown before target proof. Exact complete claims/acks plus verifyOnly of every actual target is committed with deduplicated=true. For complete acknowledgements, preserve verifyOnly's existing COMPATIBILITY_INTEGRITY_FAILURE for missing or contradictory target bytes: these violate the acknowledged durable-target contract and are terminal, never repaired or ignored. Actual unobservable/transient IO or worker outcomes remain unknown. The existing API has no separate missing-file status; do not infer one, soften typed integrity errors, or add a new worker API.
- Use the existing StableCompatibilityDirectory constructor's validation and verifyOnly only; never prepareParent, publishOrReconcile, claim, acknowledge, rewrite bytes, create a directory or append phase5 inside proof. A prior claim cannot be used as authority to resume publication during this cycle. Preserve unchanged durable rows/source/package/target bytes and release all resources.
- Recheck actual target connection, source/package, evidence and the same deadline before returning. Read failures or budget exhaustion cannot prove absence or success: return unknown or preserve typed expiry for the runner to retain its prior unknown classification. No fresh reconciliation budget. A subsequent normal invocation may use existing authenticated continuation; the runner calls the reconciler once per unknown cycle in11F.

**Required RED/GREEN coverage:** Real zero/nonzero committed/absent/partial/contradictory/read-failure states; verified exact targets and retained existing Task10 tamper/forgery/closed/unbound/alias/claim/ack/no-rewrite tests; zero semantic writes or directory preparation during proof; actual replacement-before-ack and post-ack-transaction faults; next normal invocation completes without duplicate ack or target rewrite; shared deadline does not reset, child timeouts reflect time spent in prior transaction/await, exhaustion before writes versus after possible mutation, final/no-op late-success refusal, snapshot/payload cleanup and unchanged protected bytes. Use real SQLite/production writers/native worker behavior; OS-prevented replacement and unavailable symlink capabilities remain explicit limitations, not executed guard proof.

**Verification and handoff:** Focused observed RED/GREEN first; then fresh `npm run test:build`, one serial `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-runtime.test.js dist-test/tests/v2-shadow-importer.test.js dist-test/tests/v2-shadow-projection.test.js dist-test/tests/v2-snapshot-parity.test.js dist-test/tests/v2-shadow-compatibility.test.js dist-test/tests/sqlite-driver.test.js`, and `npm run typecheck`. Preserve full commands/output/failures/skips, scope and limitations in ignored `task-11E-report.md`; commit only authorized code/test files and obtain independent exact-range review before11F. ParentTask11 closes only after runner integration and its aggregate gate.

#### Task 11F: Runner, retry evidence and aggregate integration

**Scope:** Compose the independently accepted11A–11E components into the complete parent Task11 orchestrator. Read their final exports and accepted reports before dispatch. No repeated implementation of their authenticators, no new schema/repository/driver/coordinator API, no public V1 registration, no rollout creation/activation and no Task12 serializer or resource telemetry. A missing component seam must be surfaced before widening this file allowance.

**Files:**
- Create: `src/orchestrator/migration/v2-shadow-migration-runner.ts`
- Create: `tests/v2-shadow-migration-runner.test.ts`
- Modify only for the genuine immutable preflight-failure carrier and its tests: `src/orchestrator/migration/v2-shadow-migration-runtime.ts`, `tests/v2-shadow-migration-runtime.test.ts`
- Modify only for production runner composition and real fault fixtures: `tests/support/v2-shadow-migration-fixture.ts`

**Exact input/result and authority:**
- Export `V2ShadowMigrationRunInput`, `V2ShadowMigrationRunResult`, `ShadowMigrationFaultInjector`, `ShadowMigrationFaultBoundary`, `SHADOW_MIGRATION_FAULT_BOUNDARIES`, and `V2ShadowMigrationRunner.run(input)`. Input contains projectId, rolloutRevisionId, targetContext, sourceRoot, sourceManifestPath, liveEventStorePath, liveLegacyArtifactRoot, packageRoot, v1ProjectionRoot, v2ProjectionRoot, compatibilityRoot, buildIdentityHash, configuration, policy, sealedRetrieval, expectedDifferenceRules, and creationReasonCode exactly `"production-shaped-rehearsal"`. Configuration remains the existing five-field `ShadowMigrationConfigurationV1`; policy is separately decoded `ShadowMigrationPolicyV1`; sealedRetrieval is `Readonly<{ corpus: SealedRetrievalEvaluationCorpusV2; expectedBundle: RetrievalEvaluationBundleV2 }>`.
- Result is immutable schemaVersion1, status `"compatibility-complete"`, migrationIdentity, rolloutRevisionId, sourceManifestChecksum, packageChecksum, import (`V2ShadowImportResult`), projection (`ShadowProjectionResult`), parity (`SnapshotParityReportV1`), compatibility (`CompatibilityMaterializationResult`), and deduplicated. Preserve actual nullable/bigint component fields; no serialization in this unit.
- Use genuinely open-time-bound isolated connections and repositories built from those connections. The target path must be explicitly routed to the isolated target, never substituted with original V1 or synthetic import-context paths. Reuse existing binding assertions around awaits/synchronous boundaries, before reads/writes and before return. Never create a target or mutate an immutable rollout revision inside the runner.
- `RolloutControlPlane.state(projectId)` must have `mode === "off"` and `revisionId === null`, not a guessed activeRevisionId field. Read the named immutable revision with `.revision(projectId, rolloutRevisionId)` before preparation; its migrationIdentityHash is the existing-run/package locator, not a verified package result. Validate its project/build/configuration/migration identity and ultimately prepared V1 baseline checksum. Recheck off-state, immutable revision, source/package identities, complete chain and bound corpus before each phase and completed return.

**Early full-corpus pin and preparation order:**
- Decode policy/configuration separately, require exact checksum/version binding, then verify the immutable source using the shared invocation deadline. Call the accepted11D pure source/corpus authenticator, which reparses all four logical artifacts and verifies every original source event and query binding/terminal position. Compare the returned full parsed manifest exactly with the externally supplied expectedBundle before any package/projection/target/revision/run preparation or semantic evidence write. No slicing, resealing, rebaselining, new config fields or test-loader imports. The verifier's existing owned bounded scratch replay is permitted and must close on refusal.
- Calculate `corpusPin = SHA256("project-memory/v2-shadow-migration-corpus-pin/v1\n" + canonicalJson(parsedCorpus.bundle))` and ordinal0 evidence `SHA256("project-memory/v2-shadow-migration-snapshot-evidence/v1\n" + canonicalJson({ sourceManifestChecksum, corpusPin }))`. Each `\n` denotes one actual newline in the hash preimage. Use the existing evidenceDigest; do not change migration identity or schema. Exact manifest integrity binding is not approval provenance.
- Read the existing run and chain by the revision's expected identity before preparation. Authenticate any resumed ordinal0 against the exact pin first. A matching run with no transition has not selected a corpus; require atomically no owned imported wrapper events, receipts, outboxes, claims, acknowledgements, rules or report before first pin. Later effects without ordinal0 are terminal integrity failure, not repaired. Use existing production event decoding/readers and repository reads on the checked connection; no new repository API.
- Only after early authentication may normal package seal and V1 baseline preparation run. Recheck all prepared revision bindings, then insert the exact run and append snapshot-verified and package-sealed in separate committed transactions before import. Source creation time and verified package identity are real inputs, not expected/provisional substitutes. Never change an old run or transition to make adoption match.

**Three clocks, deterministic phases and no-op:**
- Inject actual `utcNow()` for strict canonical UTC at invocation entry and again at parity authorization/no-op acceptance. Revalidate the original rules' issue/expiry/max-age/checksum/scope without renewing them. Pass current UTC as parity runStartedAt; it must not be deterministic phase metadata.
- Use accepted `shadowMigrationPhaseMetadata` for source-createdAt plus ordinal milliseconds and existing deterministicMigrationUuid("attempt", identity, ordinal). Validate all six canonical/range-safe times before writes. Runner owns ordinals0/1/2/5, publisher3 and parity4. Retain the existing complete domain-separated transition hash preimage, ordinal/predecessor/evidence and exact deterministic adoption match. Package/projection creation timestamps remain package/source metadata; stored parity report time is ordinal4.
- Before any committed phase append, re-read and authenticate its completed component and prior artifacts/chain. A complete chain reconstructs and verifies all component results, current rules and unchanged full corpus, returns deduplicated=true, and adds no semantic row/event/artifact. No late no-op success after expiry or stale rule acceptance. Preserve exact zero-artifact component semantics.

**One invocation budget, retries and unknown outcomes:**
- Create exactly one accepted runtime deadline per run from sealed deadlineMs and injected finite non-regressing monotonic clock. Pass the same object through source/package/import/projection/parity/evaluation/retrieval/materialization, reconciliation, sleep and no-op validation. No component budget reset, policy cloning, raised limits, unchecked post-await work or Promise.race abandonment. Narrow existing child numeric limits from the remainder immediately before calls. Dispose the timer and close owned resources on every exit, preserving a primary typed failure through secondary cleanup failure.
- Blocking synchronous work and existing non-cancellable lease/build awaits may settle after expiry; cooperative checks forbid late success or subsequent work. Keep the real pending-lease limitation test and cleanup assertions; do not claim hard wall-clock cancellation. Retain genuine native child deadline behavior already implemented by components.
- Retry only primary SQLite busy, explicitly injected transient filesystem EBUSY/EAGAIN/EINTR, and interrupted-worker errors. Apply `min(policy.maxBackoffMs, policy.initialBackoffMs * (2 ** attemptIndex))`, cap by remaining time, use the same signal, and reverify source/chain after delay. Preserve the sealed maxRetries; exhaustion yields MIGRATION_RETRY_EXHAUSTED unless a possible durable outcome must remain MIGRATION_OUTCOME_UNKNOWN. After expiry there is no semantic/phase/attempt write using fresh time.
- On possible durable mutation/lost response/expiry, invoke the appropriate accepted component reconciler exactly once per unknown retry cycle, only within the original remaining budget. Committed advances from authenticated result; absent permits the same deterministic operation within policy; unknown exits after at most allowed redacted attempt evidence, with zero component/phase repair. If no time remains, retain unknown without reconciliation work. A later invocation may perform normal authenticated adoption. Source verification is read-only and needs no invented committed/absent result; runner-owned phase proofs use verified repository reads. Missing component-owned phase3/4 remains unknown in that cycle, never appended by the runner.

**Durable redacted attempts and genuine preflight failure:**
- Record operation, phase, attempt index, outcome category, allowlisted safe code, prior committed phase, evidence digest and actual canonical observed UTC. No raw error message, stack, cause, path, payload or command. Keep operational attempt IDs/time outside deterministic committed phase vectors. Existing repository outcomeCategory is exactly retryable-failure / unknown-outcome / retry-exhausted / terminal-failure.
- Buffer pre-run source/package/baseline attempts and flush them immediately after the run row using exact existing attemptOrdinal/phase/priorCommittedPhase relationships. Never create a provisional run or use a merely expected revision hash as verified identity. Otherwise throw genuine internal `V2ShadowMigrationPreflightFailure` carrying deep-frozen own-data schemaVersion1, rolloutRevisionId, sourceManifestChecksum or null, verified migrationIdentity or null, and ordered attempts. Each buffered attempt has attemptId, operation exactly source-verify / package-seal / baseline-prepare, operationAttemptIndex, outcomeCategory, safeErrorCode, evidenceDigest and canonical recordedAt.
- Provenance must not be mintable through a publicly reachable constructor, copied brand/property, prototype forgery, generic Error or proxy/getter trap. Keep genuine-instance registration and the factory that invokes it lexical to the runner's authenticated failure path; there must be no exported arbitrary-data registration/minting function. A reachable constructor may create an ordinary untrusted lookalike but cannot register it. Carrier/registry may live beside the runner to keep that boundary private; the allowed runtime file may hold only the needed safe contract/helpers. Export a read-only genuine-evidence accessor for Task12, with exact redaction/immutability and crafted-lookalike refusal tests; runtime TypeScript privacy alone is insufficient. Task12 owns serialization and explicit output authority, not this carrier.

**Real fault and integration matrix:**
- Initial fault boundary list is frozen: after-source-verified, after-package-published, after-run-created, after-import-commit, after-projection-publish, after-parity-report, after-compatibility-replace, after-compatibility-ack. Injector `.hit(boundary)` may return void or Promise<void>. Wire accepted narrow component hooks to the actual corresponding durable point, not a throw after its complete method returned. Preserve package rename-before-response, source-close-before-response, partial import before receipts/outbox, V1 image-before-manifest, V2 manifest-before-phase3, parity report-before-phase4 and compatibility replacement-before-ack coverage; additional internally named read-failure probes may observe but not fake successful durability.
- Cover clean all-six-phases order, completed-run no-op, restart before/after each boundary, exact once-only committed/absent/unknown reconciliation counts, unresolved unknown without repeat writes, interrupted worker, retryable busy/transient IO and exhaustion. Subsequent real invocations must avoid duplicate events/outboxes/artifacts. Compare V1 caller result and live source/target identities/hashes before/after disposable fixtures.
- Cover invalid/altered/wrong-source/wrong-pin corpus and resumed changed corpus before preparation writes; full supplied query set retained; later effects without ordinal0 refused; current UTC valid versus expired/future/too-old original rules; identical committed IDs/times/hashes under different UTC/monotonic origins; forged component phase metadata; wrong revision/active non-off state; source mutation; blocking parity and compatibility lag. Assert budget continuity through retries/sleep/reconcile and expiry in source replay, seal, import, query and lease cleanup; no subsequent phase/receipt/report work and no corpus/query mutation.

**Verification and closure:** Use production decoders/writers, real bound SQLite/WAL, projections and atomic compatibility replacement. Observe focused RED then GREEN. Run fresh `npm run test:build`, one serial `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-runtime.test.js dist-test/tests/v2-shadow-migration-runner.test.js dist-test/tests/v1-source-copy.test.js dist-test/tests/v2-migration-package.test.js dist-test/tests/v2-shadow-importer.test.js dist-test/tests/v2-shadow-projection.test.js dist-test/tests/v2-snapshot-parity.test.js dist-test/tests/v2-shadow-compatibility.test.js dist-test/tests/retrieval-evaluation.test.js dist-test/tests/retrieval-service.test.js dist-test/tests/lifecycle-compatibility.test.js`, then `npm run typecheck`. Record complete command/output, failed attempts/skips/platform limitations and scoped commits in ignored task-11F-report.md. Controller supplies independent spec/quality review and resolves every parent cross-unit requirement against accepted11A–11E evidence before checking parent Task11. Tasks12–14 and production activation remain separate and open.

### Task 12: Generate immutable redacted rehearsal evidence across three clean runs and one no-op

**Files:**
- Create: `src/orchestrator/migration/v2-shadow-migration-evidence.ts`
- Create: `src/orchestrator/migration/v2-shadow-migration-rehearsal.ts`
- Create: `scripts/run-v2-shadow-migration-rehearsal.js`
- Create: `tests/v2-shadow-migration-rehearsal.test.ts`
- Modify: `scripts/build.js` (separate internal rehearsal artifact only)
- Modify: `scripts/smoke-v2-shadow-compatibility.js` (compiled rehearsal entry refusal checks; retain worker smoke)
- Modify only for private finalized-batch observations and their read-only internal accessor: `src/orchestrator/migration/v2-shadow-importer.ts`
- Modify only for those observation/provenance regressions and retained import/reconciliation controls: `tests/v2-shadow-importer.test.ts`

**Interfaces:**
- Consumes: four verified runner results, source pre/post identities, process/runtime versions, performance/resource observations, test summaries, and review dispositions.
- Produces: `V2ShadowMigrationEvidenceV1`, `buildV2ShadowMigrationEvidence(input)`, `writeV2ShadowMigrationEvidence(input)`, and a command-line rehearsal exit status.

**Compiled composition correction (2026-09-11):** Put internal preparation/runner composition in `v2-shadow-migration-rehearsal.ts` and bundle it separately to `dist/internal/v2-shadow-migration-rehearsal.js`. The explicit JavaScript command imports only that built internal entry; it must not import source TypeScript or `dist-test`, or route through `src/index.ts`, `src/cli.ts`, a public worker, or a public service. Resolve the Task10 compatibility worker as sibling `stable-compatibility-directory.worker.js` within `dist/internal`. Preserve existing public build entries unchanged. The internal module's import performs no filesystem mutation or automatic run. Extend built smoke to load this exact artifact and reject missing/invalid configuration without mutation; the full rehearsal tests cover valid execution through the explicit command. Do not create package/CI command aliases until Task13.

**Corpus/clock producer correction (2026-09-12):** The strict internal operational envelope supplies separate exact `configuration`, `policy`, `expectedDifferenceRules` and `sealedRetrieval: { bundleRoot, expectedBundle }` fields, plus the already required authority/revision/build settings. `bundleRoot` is an explicit canonical absolute read-only input; `expectedBundle` is the complete approved `RetrievalEvaluationBundleV2`, not an inferred fixture subset. Load the actual `manifest.json`, `source-events.json`, `judgments.json` and `v1-shadow-baseline.json` using bounded reads and verified non-symbolic single-link file identities. The combined raw input bytes must not exceed the supplied policy's `maxAggregateBytes`; never truncate to fit. Parse with the real four-artifact parser, require exact intended-manifest equality and authenticate against the copied source using Task11's shared pure helper before creating a target/revision or publishing packages/projections. Preserve every supplied query/event/baseline field and revalidate identity before handoff; no automatic source acquisition, corpus resealing, baseline regeneration or test-code import. The operational envelope and durable ordinal0 pin do not prove approval provenance: actual authorized production-shaped source/config/full corpus remain Task14 prerequisites. Each runner invocation gets fresh actual UTC/monotonic clocks; deterministic phase metadata remains source-derived. Add loader invalid/missing/changed artifact and wrong source/pin zero-write tests, full-corpus propagation, differing-clock three-run vectors, original-rule expiry on no-op, and built-only invalid-input refusal.

**Review sequencing correction (2026-09-12):** Task14 necessarily generates rehearsal evidence before requesting its three independent reviews. A document may therefore contain the actual supplied subset of review dispositions, including an empty reviews array; never invent pending approvals or another disposition outside the exact existing union. Its gates and exit0 at that stage attest only the completed functional rehearsal checks, not Slice2 completion. A supplied changes-required disposition makes the relevant gate red and exit nonzero. Reject duplicate review kinds. Final Slice2 acceptance separately requires all three unique kinds (specification, implementation-quality, security), each approved with its real evidence digest, plus every functional/release gate; missing kinds cannot satisfy that predicate even when all currently recorded functional gates passed. Later dispositions go into newly generated immutable documents for the exact reviewed code/revision, never overwrite a prior document. Test empty/partial review evidence as explicitly incomplete for final acceptance, duplicate/changes-required refusal or red gates, and full authentic disposition propagation. This resolves the preparation/review dependency without changing evidence schema or weakening the approved final gate.

- [ ] **Step 1: Write evidence and rehearsal RED tests.**

**Functional-only CI producer correction (2026-09-19):** In this task's already planned `tests/v2-shadow-migration-rehearsal.test.ts`, one named test `retains synthetic functional evidence from the fresh compiled rehearsal command` owns the future Task13 artifact. Reuse the valid fresh compiled-CLI four-pass test path rather than running another rehearsal solely for upload. Generate an isolated synthetic source through production writers/helpers and supply its entire intended externally pinned fixture corpus; never label it the authorized production corpus or source. Preserve the exact production clean-tree, build/configuration, deadline, no-clobber and redaction checks; do not add a production test mode or bypass. Retain only the actual successfully finalized `V2ShadowMigrationEvidenceV1` bytes from that CLI, with actual observed test summaries and `reviews: []`; never fabricate unfinished suite results, reviews, source approval or resource-capacity certification.

The test alone may consume optional `V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT`. Without it, run the same assertions using normal owned disposable output; absence must not skip the behavioral test. When provided, validate its canonical absolute absent destination outside checkout/source/package/work/protected roots and use the existing evidence publisher's exact path/identity/reservation/no-overwrite contract. The test owns creation of a fresh valid evidence parent and passes that explicit output to the real CLI; do not copy/reconstruct/overwrite evidence after publication. Missing/invalid/occupied output, failed CLI, uncertain publication, changed bytes/identity/checksum or missing retained evidence fails the test. On success, verify canonical schema/redaction/checksum and matching immutable output identity, close all resources and clean only other proven-owned fixture data while retaining the document. Test both unset disposable behavior and set output survival/refusal/unchanged bytes; preserve failure artifacts rather than broad cleanup. This setting is test-only and must not be read by production modules or the command. It neither supplies live data nor changes V1 routing. Before13 dispatch, bind CI to this accepted test/export/CLI behavior and exact finalized-file guarantees; a missing seam is not silently waived.

**Clean functional fixture correction (2026-09-19):** To exercise the genuine compiled command during uncommitted TDD, the new test may create an independent owned temporary Git repository from an explicit bounded snapshot of current required code/build inputs, including intended new/modified files and deletions. Verify capture correspondence and reject changing inputs; never substitute old HEAD or stale dist. Commit only inside that disposable repository using isolated synthetic Git settings, with no shared original Git administration, original index/HEAD/worktree mutation, credential/config copy or production clean-status bypass. Build the exact copied script from that repository's cwd and qualify dependency/input closure; existing placeholder fixture build hashes are not acceptable command provenance. Its actual clean fixture commit is the evidence commit and remains synthetic functional-only, not the original reviewed branch commit. Final Task14 must separately build and rehearse the exact reviewed original commit with authorized inputs. Retained or uncertain evidence stays outside disposable roots and their automatic teardown. Before Task12 dispatch, resolve the actual internal build-identity producer against accepted11F composition: current `build-info.json` contains only time/version and cannot satisfy commit/artifact binding. A proposed generated private manifest and its external-input/load-consistency limits require an explicit controller ruling; do not silently select a self-authenticating hash or expand public build/dependency/worker contracts.

Generate three empty isolated target stores/projection roots/compatibility roots for clean runs, then rerun the third target for the no-op. Assert identical migration/package/import/projection/parity/compatibility checksums across clean runs, no-op deduplication, byte-identical source identity, bounded metrics, no plaintext/absolute paths, canonical evidence checksum, and nonzero exit for every red gate:

```ts
test("three clean runs are identical and the fourth run is a verified no-op", async (t) => {
  const fixture = await rehearsalFixture(t);
  const rehearsal = await fixture.runFourPasses();
  assert.deepEqual(
    rehearsal.cleanRuns.map((run) => run.determinismVector),
    [rehearsal.cleanRuns[0]!.determinismVector, rehearsal.cleanRuns[0]!.determinismVector, rehearsal.cleanRuns[0]!.determinismVector],
  );
  assert.equal(rehearsal.noOp.deduplicated, true);
  assert.deepEqual(rehearsal.sourceBefore, rehearsal.sourceAfter);
  assert.equal(rehearsal.evidence.gates.every((gate) => gate.status === "passed"), true);
  assert.match(rehearsal.evidence.evidenceChecksum, /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run rehearsal tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-rehearsal.test.js
```

Expected: compilation fails because evidence builder and rehearsal script are absent.

- [ ] **Step 3: Build a canonical redacted evidence document.**

Use this top-level shape and reject unknown fields:

```ts
export interface DeterministicRunEvidenceV1 {
  readonly runOrdinal: 1 | 2 | 3 | 4;
  readonly deduplicated: boolean;
  readonly determinismVector: Readonly<{
    migrationIdentity: string;
    packageChecksum: string;
    importedEventsChecksum: string;
    transitionChainChecksum: string;
    v2ProjectionManifestChecksum: string;
    parityReportChecksum: string;
    compatibilityArtifactSetChecksum: string;
    sourceRecordCount: number;
    importedEventCount: number;
    compatibilityAcknowledgementCount: number;
  }>;
}

export interface V2ShadowMigrationEvidenceV1 {
  readonly schemaVersion: 1;
  readonly commit: string;
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  readonly operatingSystem: string;
  readonly projectStoreSchemaVersion: number;
  readonly buildIdentityHash: string;
  readonly rolloutRevisionId: string;
  readonly migrationIdentity: string;
  readonly configurationChecksum: string;
  readonly policyChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly sourceBeforeChecksum: string;
  readonly sourceAfterChecksum: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly deterministicRuns: readonly DeterministicRunEvidenceV1[];
  readonly noOpRun: DeterministicRunEvidenceV1;
  readonly parity: Readonly<{ equal: number; expected: number; blocking: number; ruleIds: readonly string[] }>;
  readonly compatibility: Readonly<{ acknowledged: number; terminalPosition: string | null; artifactSetChecksum: string }>;
  readonly performance: Readonly<{ elapsedMs: number; throughputPerSecond: number; peakRssBytes: number; maxBatchEvents: number; maxBatchBytes: number; retries: number; projectionLag: number; materializationLag: number }>;
  readonly tests: readonly Readonly<{ name: string; passed: number; failed: number; skipped: number }>[];
  readonly reviews: readonly Readonly<{ kind: "specification" | "implementation-quality" | "security"; disposition: "approved" | "changes-required"; evidenceDigest: string }>[];
  readonly gates: readonly Readonly<{ name: string; status: "passed" | "failed"; evidenceDigest: string }>[];
  readonly createdAt: string;
  readonly evidenceChecksum: string;
}
```

`DeterministicRunEvidenceV1.determinismVector` includes migration/package/imported-event/ledger-transition/projection/parity/compatibility identities, counts, and hashes. It excludes observed elapsed/RSS metrics and the aggregate evidence document's `createdAt`; those observations remain reported separately and bounded by gates.

**Resource observation correction (2026-09-12, future Task12 only):** Preserve every existing evidence/result/policy schema and original policy scope. The original six evidence/CLI/build files gain only the two importer/test allowances above; this does not reopen11B, authorize telemetry in11C/11F or change EventStore, repository, worker or caller-facing APIs.

- `performance.maxBatchEvents` and `performance.maxBatchBytes` are the maxima over actual finalized importer batches consumed by the four accepted import/committed-reconciliation results. Measure event count and the existing canonical `commandBytes` of the exact finalized `PlannedCommand` shared with append/replay; use existing production planning/encoding, not a second telemetry replay pass, copied policy ceilings, source byte lengths or speculative candidates. Keep only constant-space counters/maxima and a private finalized-batch count, with the existing deadlines and source/receipt/outbox/return checks unchanged.
- Add the internal read-only accessor `readV2ShadowImportBatchObservation(result)` returning a frozen own-data `{ maxBatchEvents, maxBatchBytes }` observation or `undefined` for an unregistered object. Register only the genuine frozen successful import or committed-reconciliation result through lexical importer-owned WeakMap state after complete acceptance. No public constructor/registration helper, copied brand, observer callback or payload/command/path retention. Missing/cloned/forged observations cause evidence refusal, never zero or recomputation; an authentic empty stream alone permits0/0. This metadata proves measurement origin only, not source approval or broader authority.
- Verified no-op/replay batches count as real processed batch geometry, not newly written bytes. Aggregate with `max`, not sum/average. Absent, unknown and failed operations do not publish successful observations; failed/speculative attempt peaks are explicitly excluded. These values do not establish peak heap allocation or retained-buffer bounds. Compare accepted maxima against the exact sealed ceilings and lower existing EventStore limits; preserve all other policy checks at their original per-invocation/per-operation scope rather than comparing four-pass totals to a single-run deadline/retry cap.
- Before Task12 dispatch, inspect accepted11F and the built internal composition to confirm `result.import` retains the genuine component object in the same process/module instance. Do not assume this survives cloning, IPC or duplicate bundles. If actual propagation breaks this contract, rule on the narrow consumer gap before expanding runner scope. No runner telemetry fields or new input/dependency API are authorized by this correction.
- `performance.peakRssBytes` is `process.resourceUsage().maxRSS * 1024`, sampled in the explicit fresh rehearsal-command process after four accepted passes and owned runner cleanup, before evidence serialization/publication. Validate the raw reading and conversion as finite nonnegative safe integers; unavailable/invalid/error readings refuse evidence, with no point-sample/zero fallback. Its scope is that process's lifetime high-water through this cutoff, including startup/config/preparation/four passes but excluding later evidence work, spawned helpers and other processes. Do not subtract startup maxima, sum lifetime peaks, or claim a long-lived unit-test process is an equivalent fresh rehearsal measurement. Node24.16+/Windows/Linux availability and cutoff behavior still require actual qualification; no runtime-floor change.
- Finite RSS is measurement integrity, not an invented RSS-policy pass. No numeric RSS ceiling exists in the sealed policy. Spec gate7 still separately requires reviewed bounded streaming/retained-buffer/queue behavior and qualified scale/repeated-run evidence, including relevant helper processes; a parent-only RSS field cannot satisfy whole-system growth/capacity qualification. Missing mandatory qualification prevents final Slice2 acceptance even if functional rehearsal gates pass. Do not fabricate an all-green resource gate from finite observations.
- Tests must cover actual event/byte splits, last partial and exact-limit batches, multibyte payload plus command/response overhead, excluded oversized speculative candidates, genuine empty/no-op/mixed-resume/committed-reconcile observations, absent/unknown/post-append-failure non-observations, frozen/copied/forged provenance, same genuine runner object and one built module instance, four-result maxima and effective limits, unavailable/invalid RSS rejection and fresh compiled CLI unit conversion/cutoff. Preserve semantic results/writes and no-extra-replay behavior. Add `dist-test/tests/v2-shadow-importer.test.js` to Task12's final serial rehearsal/runner gate; fresh test build/typecheck/production build/built smoke remain required. Functional clock tests and diagnostic observations are not capacity benchmarks.

Root paths, artifact relative paths, payload values, rule rationale, approver identity, error text, and environment secrets are forbidden. The builder recursively scans key names and string values for drive/UNC/POSIX paths, PEM/API-key patterns, source plaintext sentinels, and unauthorized fields before calculating `evidenceChecksum` with domain `project-memory/v2-shadow-migration-evidence/v1`.

- [ ] **Step 4: Add the explicit rehearsal command.**

The script accepts only named flags and refuses defaults for safety:

```text
node scripts/run-v2-shadow-migration-rehearsal.js \
  --config <absolute canonical config.json> \
  --source-root <verified copy root> \
  --package-root <isolated package root> \
  --work-root <empty isolated run root> \
  --evidence-output <new evidence.json>
```

It requires `NODE_ENV=production-rehearsal`, a clean Git worktree, exact commit/build identity, an output path outside source/live roots, three newly created empty run directories, and an explicit configuration containing the live authority paths used only for alias rejection. It never acquires a live copy, changes rollout mode, opens a public server, or deploys.

Before the four passes, the script performs a preparation-only source/package/V1-baseline calculation and verifies that the supplied rollout revision template's build/configuration fields match. For each isolated target it creates the same immutable revision through the internal `RolloutControlPlane.createRevision` using the prepared `migrationIdentityHash` and `v1BaselineChecksum`, then confirms state remains `off`. This revision creation occurs only inside each empty rehearsal target; the script never writes a live/user rollout store.

Write evidence through an exclusive same-directory temporary file; write completely, fsync, close, reopen, validate canonical bytes/redaction/schema and checksum, and prove the temporary's descriptor identity. Install the verified temporary at the absent final name with `linkSync`, treating EEXIST as refusal without replacement. Strictly flush the pinned parent, reopen and validate the final against the sealed temporary identity and checksum, remove only the proven-owned temporary link, then strictly flush the parent and verify the final single-link identity before reporting success. Retain the reservation and surviving artifacts on failed or unknown publication; never retry installation by replacing an existing final. A second command requires a new output path. Print only the evidence checksum, migration identity, gate summary, and output path hash.

**Evidence publication correction (2026-09-12):** The approved spec requires append-only immutable retained evidence, not a final rename. Node's replacing rename cannot implement absent-only installation across an independently created destination; the plan-only recipe above now uses the existing same-filesystem hard-link primitive. This changes only evidence publication, not package or compatibility publication or evidence schema; publication stays in the original six files, distinct from the two narrowly authorized resource-observation files above.

- Reserve the success leaf and exact `preflight-failure-evidence.json` sibling together using one exclusive constant sibling control file `.v2-shadow-migration-evidence.reservation`, not a lock specific to the success filename and not empty evidence placeholders. Invalid/missing entry configuration remains nonmutating. After read-only entry validation and before rehearsal-owned publication/target mutation, verify the canonical existing parent outside protected roots, reject occupied entries of every type, acquire the exclusive reservation, seal/fsync/reopen/verify its token and identity, strictly flush its parent, and recheck both exact leaves absent. Reject failure-name/control-name collisions, symbolic/reparse/alias components and Windows stream/trailing-dot/space leaf aliases.
- Keep reservation capability creation lexical to the actual exclusive-acquisition path in the evidence module; no public constructor, copied brand, object prototype or generic registration helper may forge it. The private record contains only token, parent identity and permitted leaves, no source payload or absolute path. Every internal publication entry consumes a genuine capability and rechecks token/file/parent identity. Existing reservation means occupied; no PID/mtime-based takeover, stale-lock recovery or cross-invocation adoption.
- Anchor private evidence child operations to identity-checked cwd and validated relative single-component leaves, using a bounded hidden child within the already planned internal bundle. Do not change or route through existing projection/compatibility workers or APIs. Pin the parent descriptor (Windows `r+`, Linux `r`) and propagate every required file/directory fsync failure; no shared helper's unsupported-flush suppression. Existing-file handles used for Windows flush never reach data-write/truncate/append operations. Check parent path/identity before and after operations; relocation or lost response prevents success.
- No data writes occur through the sealed file after installation. Prove link count1 before link, exactly the two expected names and link count2 during installation, then final link count1 after owned temporary cleanup, with descriptor/leaf identity, bounded bytes and checksum continuity. Do not require ctime equality across link/unlink. Absent-only installation prevents this operation from overwriting a destination inserted after its last check; source-temp swaps, hostile subsequent edits or path-based cleanup interference are not an atomic leaf-CAS guarantee. Use an operator-controlled local namespace; reject detected interference and preserve ambiguous entries instead of deleting them.
- Release only the proven-owned reservation after fully verified successful-evidence publication and parent flush, then strictly flush release. Published failure evidence retains its reservation and requires a fresh directory. A possible link side effect, flush/reopen/cleanup failure, timeout or lost response is redacted nonzero; preserve all surviving artifacts and never publish a second document to disguise uncertain publication. If release itself is uncertain, leave the final intact and report nonzero. No replacing rename/copy fallback or broad cleanup.
- Qualify actual supported Windows/Linux filesystem behavior: strict flush success or typed refusal, no-clobber concurrent destination creation, shared-reservation races across different success names, crash/fault boundaries, link counts and immutable bytes, alias/identity/token substitution, bounded child termination/unknown outcome and cleanup ownership. Unsupported hard links or flush barriers fail closed; a prior local directory-flush probe is feasibility evidence only, not this task's qualification or a universal power-loss guarantee. Built import/invalid-input no-mutation and redaction tests remain mandatory.

Task12 also owns `preflight-failure-evidence.json`, written only for Task11's genuine typed pre-run carrier. Reserve this exact new sibling of the explicit `--evidence-output` path during initial output validation; reject any existing sibling before starting, so retrying after failure needs a fresh output directory. It obeys the same outside-source/live canonical-parent, no-overwrite, durable atomic-write and redaction/checksum rules as successful evidence. The evidence module strictly serializes the carrier's exact schema, bounds and allowlisted codes, with checksum domain `project-memory/v2-shadow-migration-preflight-failure-evidence/v1` (one newline before canonical JSON). The CLI never serializes a generic Error, cause, message, stack or source pathname. Failed output publication is itself a typed redacted nonzero exit and is never repaired by overwriting evidence. No runner/source component receives an output path or writes this file. Built-command tests cover a real baseline/pre-run failure, valid frozen carrier persistence and crafted-error refusal.

- [ ] **Step 5: Run deterministic rehearsal tests.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-rehearsal.test.js dist-test/tests/v2-shadow-migration-runner.test.js dist-test/tests/v2-shadow-importer.test.js
npm run typecheck
npm run build
node scripts/smoke-v2-shadow-compatibility.js
```

Expected: all tests pass; the three-run vector is byte-identical; the fourth run adds no semantic row/event/artifact; every red fixture exits nonzero without leaking plaintext.

- [ ] **Step 6: Commit rehearsal evidence tooling.**

```powershell
git add src/orchestrator/migration/v2-shadow-migration-evidence.ts src/orchestrator/migration/v2-shadow-migration-rehearsal.ts scripts/run-v2-shadow-migration-rehearsal.js tests/v2-shadow-migration-rehearsal.test.ts scripts/build.js scripts/smoke-v2-shadow-compatibility.js src/orchestrator/migration/v2-shadow-importer.ts tests/v2-shadow-importer.test.ts
git commit -m "test: add V2 shadow migration rehearsal"
```

### Task 13: Register schema 7 and seal the focused CI/release contract

**Files:**
- Modify: `src/orchestrator/storage/migrations/registry.ts:1-20`
- Modify: `tests/migration-registry.test.ts:100-190`
- Modify: `tests/project-store-bootstrap.test.ts:230-270,800-930`
- Modify: `tests/project-store-upgrade.test.ts:1140-1210,2400-2730`
- Modify: `tests/project-store-upgrade-phase-runner.test.ts:270-305`
- Modify: `scripts/smoke-worker.js:520-650`
- Modify: `tests/ci-lifecycle-gates.test.ts:1-150,420-460,730-840`
- Modify: `package.json:24-34`
- Modify: `.github/workflows/ci.yml:45-65`
- Modify only redundant manual migration7 setup and the resulting unused import: `tests/support/v2-shadow-migration-fixture.ts`, `tests/v2-shadow-migration-repository.test.ts`, `tests/v2-shadow-importer.test.ts`, `tests/v2-imported-event-reader.test.ts`, `tests/v2-shadow-projection.test.ts`, `tests/v2-snapshot-parity.test.ts`, `tests/v2-shadow-compatibility.test.ts`

**Interfaces:**
- Consumes: every focused test and source path from Tasks 1 through 12.
- Produces: current project-store schema 7, `npm run test:v2-shadow-migration`, `npm run rehearse:v2-shadow-migration`, and a CI step that preserves V1-only routing.

- [ ] **Step 1: Update registry/upgrade/CI contract tests first.**

Change expectations to migration names `[event-core, session-lifecycle, qualified-checkpoint-coverage, session-end-effective-state, session-end-final-checkpoint-transition, v2-rollout-control-plane, v2-shadow-migration]`, current schema `7`, and upgrade results ending in `7`. Preserve all frozen migration 1..6 names/checksums and append only migration 7.

**Registry/fixture integration correction (2026-09-19):** The existing `applyCurrentProjectStoreSchema` helper already executes the complete production registry. Before Task13, shadow fixtures additionally execute migration7 SQL directly because the registry stops at6. Once7 is registered, those calls execute the same non-idempotent CREATE TABLE/TRIGGER statements twice. Remove only these redundant direct calls and imports after registering7; do not make migration SQL idempotent, catch duplicate-table errors, bypass MigrationRunner, skip tests or change source-schema acceptance. The inspected06276ec baseline has nine calls across the seven narrowly allowed test files above: shared compatibility/parity setup(2), importer primary/sibling setup(2), repository(1), imported reader(1), projection(1), parity foreign-connection setup(1), compatibility replacement setup(1). Recheck exact occurrences after accepted11D–12 because those tasks may extend fixtures. Each affected store must obtain migration7 once via the production registry and preserve its real table/trigger/identity setup, including foreign/replacement targets. Existing migration-registry/upgrade assertions must prove the exact1..7 ledger/checksums; observe the duplicate-setup failure on the newly registered code before cleanup, then verify these original semantic/authority regressions in the required focused gate. No production helper/migration changes beyond the planned registry append are authorized by this correction.

In `ci-lifecycle-gates.test.ts`, require exact scripts:

```json
"test:v2-shadow-migration": "npm run test:build && node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/sqlite-driver.test.js dist-test/tests/v2-shadow-migration-contracts.test.js dist-test/tests/v2-shadow-migration-runtime.test.js dist-test/tests/v1-source-copy.test.js dist-test/tests/v2-migration-package.test.js dist-test/tests/v2-shadow-migration-repository.test.js dist-test/tests/v2-shadow-importer.test.js dist-test/tests/v2-imported-event-reader.test.js dist-test/tests/v2-shadow-projection.test.js dist-test/tests/v2-parity-lifecycle-fixture.test.js dist-test/tests/recording-git-command-runner.test.js dist-test/tests/v2-snapshot-parity.test.js dist-test/tests/retrieval-evaluation.test.js dist-test/tests/retrieval-service.test.js dist-test/tests/stable-compatibility-directory.test.js dist-test/tests/v2-shadow-compatibility.test.js dist-test/tests/v2-shadow-migration-runner.test.js dist-test/tests/v2-shadow-migration-rehearsal.test.js dist-test/tests/ci-lifecycle-gates.test.js",
"rehearse:v2-shadow-migration": "npm run build && node scripts/run-v2-shadow-migration-rehearsal.js"
```

Require a release-gates step named `Run V2 shadow migration gate` with command `npm run test:v2-shadow-migration`, immediately after the rollout-control-plane gate and before build-artifact tests. Keep `Protect Version 1 production routing` byte-for-byte unchanged.

Extend `test:build-artifacts` exactly to `npm run build && node scripts/smoke-worker.js && node scripts/smoke-v2-shadow-compatibility.js`. Seal both internal artifact paths/build entries and ensure the public bundles/entry imports remain V1-only. The Task9 lifecycle fixture and Task10 stable-directory tests above are part of the focused Windows/Linux gate, not optional local-only tests.

Task10 authority qualification must execute real file-symlink target/temp cases on capable Windows/Linux runners; local EPERM/EACCES skips are not proof and the V2 CI cases must not silently capability-skip. Include the opt-in SQLite stale-connection cases and distinguish actual stale-handle execution from genuine OS rename prevention with unchanged state. Retain the existing native-driver hardening, Task11 shared-budget controls and retrieval default regressions in the exact focused command above. Task14 capacity gates must measure the actual supplied source/artifact set; Task10's Sets improvement alone proves neither linear work nor maximum-capacity performance.

- [ ] **Step 2: Run CI-contract and migration tests and verify RED.**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/migration-registry.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/project-store-upgrade-phase-runner.test.js dist-test/tests/ci-lifecycle-gates.test.js
```

Expected: tests fail because registry, smoke, package scripts, CI, and sealed source list still represent schema 6/Slice 1.

- [ ] **Step 3: Register migration 0007 without editing frozen migrations.**

Import `v2ShadowMigration` after 0006, append it to `PROJECT_STORE_MIGRATIONS`, and set `CURRENT_PROJECT_STORE_SCHEMA_VERSION = 7`. Update shared bootstrap/upgrade expected arrays from `[1,2,3,4,5,6]` to `[1,2,3,4,5,6,7]` or from `[2,3,4,5,6]` to `[2,3,4,5,6,7]` as applicable. Update bundled smoke to require schema 7 and its exact migration name/checksum while keeping the disabled lifecycle probe and V1 routing assertions.

- [ ] **Step 4: Update the exact internal-only source allowance and focused gate.**

Extend the sorted sealed source list with only these new/modified internal paths plus the pre-existing seven Slice-1 paths:

```ts
const APPROVED_SEALED_AND_ROLLOUT_SOURCE_DIFF = Object.freeze([
  "src/orchestrator/identity/git-workspace.resolver.ts",
  "src/orchestrator/materialization/stable-compatibility-directory.ts",
  "src/orchestrator/materialization/stable-compatibility-directory.worker.ts",
  "src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts",
  "src/orchestrator/migration/v1-source-copy.ts",
  "src/orchestrator/migration/v2-imported-event-reader.ts",
  "src/orchestrator/migration/v2-migration-package.ts",
  "src/orchestrator/migration/v2-shadow-importer.ts",
  "src/orchestrator/migration/v2-shadow-migration-evidence.ts",
  "src/orchestrator/migration/v2-shadow-migration-rehearsal.ts",
  "src/orchestrator/migration/v2-shadow-migration-runner.ts",
  "src/orchestrator/migration/v2-shadow-migration-runtime.ts",
  "src/orchestrator/migration/v2-shadow-migration.contracts.ts",
  "src/orchestrator/migration/v2-shadow-projection.ts",
  "src/orchestrator/parity/v2-expected-difference.ts",
  "src/orchestrator/parity/v2-snapshot-parity.ts",
  "src/orchestrator/projections/builder.ts",
  "src/orchestrator/projections/checksum.ts",
  "src/orchestrator/projections/contracts.ts",
  "src/orchestrator/projections/event-reader.ts",
  "src/orchestrator/projections/folds.ts",
  "src/orchestrator/projections/integrity.ts",
  "src/orchestrator/projections/manifest.ts",
  "src/orchestrator/projections/schema.ts",
  "src/orchestrator/projections/source-event-codec.ts",
  "src/orchestrator/retrieval/contracts.ts",
  "src/orchestrator/retrieval/evaluation.ts",
  "src/orchestrator/retrieval/service.ts",
  "src/orchestrator/rollout/rollout-cohort.ts",
  "src/orchestrator/rollout/rollout-control-plane.ts",
  "src/orchestrator/storage/migrations/0006-v2-rollout-control-plane.ts",
  "src/orchestrator/storage/migrations/0007-v2-shadow-migration.ts",
  "src/orchestrator/storage/migrations/registry.ts",
  "src/orchestrator/storage/node-sqlite-driver.ts",
  "src/orchestrator/storage/rollout-control-plane.repository.ts",
  "src/orchestrator/storage/session-end.repository.ts",
  "src/orchestrator/storage/sqlite-driver.ts",
  "src/orchestrator/storage/v2-shadow-migration.repository.ts",
]);
```

The test must still scan every production entry surface and reject imports of migration/parity/materialization modules, public `memory_(retrieval|projection|migration|parity)` tools, environment-activated V2 routing, and changes to protected V1 paths. Add checks that CI uploads redacted evidence JSON only, with `retention-days: 14`, and excludes source copies, packages, SQLite files/sidecars, compatibility bytes, secrets, and Markdown payloads.

**CI evidence-class correction (2026-09-19):** The new migration upload is synthetic functional evidence from Task12's named fresh compiled-CLI fixture test, not Task14's source-authorized production-shaped rehearsal or final review acceptance. Keep the existing stress-log uploader as its separate exact historical class; no stress-workflow changes. Do not create a dormant real-rehearsal job, source download, credential setting, remote input channel or new workflow. The dedicated output setting belongs only to the existing `Run V2 shadow migration gate` step:

```yaml
      - name: Run V2 shadow migration gate
        env:
          V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT: ${{ runner.temp }}/v2-shadow-migration-functional/evidence.json
        run: npm run test:v2-shadow-migration
```

After successful required release/build-artifact gates in the same `ci.yml/release-gates` job, add this exact second classified upload slot using the already observed repository action version, with no `if`, existence skip, `always()`, alternate path, wildcard or failure suppression:

```yaml
      - name: Upload V2 shadow migration functional synthetic evidence
        uses: actions/upload-artifact@v7
        with:
          name: v2-shadow-migration-functional-synthetic-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}
          path: ${{ runner.temp }}/v2-shadow-migration-functional/evidence.json
          if-no-files-found: error
          retention-days: 14
```

Replace the global single-uploader assertion with an exact two-slot manifest including workflow identity, owner job, step, action, artifact class/name, literal path, exact scalar retention/missing-file policy and order. Preserve all current stress owner/path/`always()`/serial-gate controls, unconditional release/minimum-runtime/stress jobs, V1 guard and checkout manifest. Require the accepted Task12 producer case in the exact migration gate; a missing output or failed upload makes CI red. Add negative tests for extra/moved/renamed/version-substituted uploaders, duplicate/nested protected keys/jobs/steps, conditional/continue-on-error bypass, output setting moved to production or another step, directories/globs/extra paths/traversal/user-selected expressions, stale or preflight-failure-only output, and forged evidence. Keep restricted YAML parsing closed; content provenance/redaction is verified by the production-backed producer tests, not by a JSON extension or static YAML alone. No temporary/reservation/source/package/SQLite/Markdown/plaintext logs or uncertain output are uploaded. Fourteen-day transport retention does not replace the immutable operator record. Preserve the synthetic artifact class in handoffs; schema validity/checksum/exit0 never proves real-source authorization or the complete three-review/final-resource gates. Task14 must still produce separately authorized real rehearsal evidence.

- [ ] **Step 5: Implement package/CI/smoke updates and run focused release verification.**

Run:

```powershell
npm run check:runtime
npm run test:v2-shadow-migration
npm run test:rollout-control-plane
npm run test:subproject-3
npm run typecheck
npm run build
npm run test:build-artifacts
git diff --check
```

Expected: every command exits 0; schema 7 is recognized; CI order is exact; public/production entry paths remain V1-only; built worker upgrades through 7 and keeps lifecycle V2 disabled.

- [ ] **Step 6: Commit the sealed release contract.**

```powershell
git add src/orchestrator/storage/migrations/registry.ts tests/migration-registry.test.ts tests/project-store-bootstrap.test.ts tests/project-store-upgrade.test.ts tests/project-store-upgrade-phase-runner.test.ts scripts/smoke-worker.js tests/ci-lifecycle-gates.test.ts package.json .github/workflows/ci.yml tests/support/v2-shadow-migration-fixture.ts tests/v2-shadow-migration-repository.test.ts tests/v2-shadow-importer.test.ts tests/v2-imported-event-reader.test.ts tests/v2-shadow-projection.test.ts tests/v2-snapshot-parity.test.ts tests/v2-shadow-compatibility.test.ts
git commit -m "test: seal V2 shadow migration release gate"
```

### Task 14: Run the production-shaped rehearsal and complete independent release reviews

**Files:**
- Verify: every file in Tasks 1 through 13
- Verify: `docs/superpowers/specs/2026-09-09-v2-shadow-migration-and-compatibility-parity-design.md`
- Generate outside Git: one source-authorized `v2-shadow-migration-evidence.json`

**Interfaces:**
- Consumes: exact committed branch, authorized production-shaped copy/config, all focused/full gates, and three independent reviewers.
- Produces: a green immutable Slice-2 evidence checksum and review dispositions; no runtime activation or deployment.

- [ ] **Step 1: Run all deterministic code gates from a clean worktree.**

Run from `C:\Users\Server\.codex\worktrees\subproject-3-projections`:

```powershell
npm run check:runtime
npm run typecheck
npm run test:build
npm run test:v2-shadow-migration
npm run test:rollout-control-plane
npm run test:subproject-3
npm test
npm run build
npm run test:build-artifacts
git diff --check
git status --short --branch
```

Expected: every command exits 0; full suite reports zero failures; only documented expected platform skips remain; worktree is clean after task commits.

- [ ] **Step 2: Audit V1 isolation and sensitive-artifact boundaries.**

Run:

```powershell
rg -n "orchestrator/(migration|parity)|v2-shadow-compatibility|registerTool\(|memory_(retrieval|projection|migration|parity)" src/app.ts src/index.ts src/controllers src/schemas src/services src/workers src/orchestrator/runtime
git diff --name-only 0e375d4643d4b630f36f874a3bb192e96739ac46 -- src/app.ts src/index.ts src/controllers src/schemas src/services
git diff --name-only 68e77fa10165c99243ded1e8c1c80d1e0f7da92f -- src
rg -n "sourceRoot|packageRoot|contentUtf8|payloadJson|BEGIN (RSA|OPENSSH)|api[_-]?key|secret" src/orchestrator/migration src/orchestrator/parity src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts
```

Expected: production entry search has no import/registration; protected V1 diff is empty; source diff equals the sealed list; diagnostics/report serializers do not emit sensitive values.

- [ ] **Step 3: Run the authorized production-shaped rehearsal.**

Set `NODE_ENV=production-rehearsal` and run the command from Task 12 with explicit canonical paths supplied through the approved config. Expected exit is 0 and printed functional rehearsal gates all pass. At the first pre-review run this is rehearsal-only evidence, not Slice2 completion: include only actually available review dispositions and require all three approved kinds separately at Step7. Independently hash the source manifest/database/sidecars/artifacts before and after and compare them to evidence. Confirm:

- three clean determinism vectors are identical;
- fourth run is `deduplicated: true` with no new semantic event/ledger/artifact;
- blocking parity count is zero;
- every expected rule is exact, current, revision/migration-bound, and reviewed;
- compatibility acknowledged count equals declared artifact count and terminal position/hash is exact;
- elapsed time, RSS, batch use, retries, projection lag, and materialization lag stay inside the sealed policy; and
- evidence contains no plaintext, secret, absolute path, SQLite/package bytes, or compatibility content.

- [ ] **Step 4: Request specification review.**

Use a fresh reviewer to compare every safety invariant, architecture subsection, error class, security constraint, test requirement, and release gate in the approved spec to implementation plus evidence. Resolve every Critical or Important finding with a new failing regression test before changing code. Rerun Steps 1 through 3 after every fix. Record the final approved disposition digest in a newly generated evidence file; never rewrite the prior evidence file.

- [ ] **Step 5: Request implementation-quality review.**

After specification review is approved, use a fresh reviewer to inspect strict own-data decoding, canonical hashes, UUID/identity compatibility, bounded streaming, descriptor-before-value access, transaction/rollback behavior, immutable triggers, deterministic IDs/timestamps, unknown-outcome reconciliation, path/file identity, source re-verification, projection authority, report redaction, and no-op idempotence. Resolve every Critical or Important finding through TDD, rerun Steps 1 through 3, and record the approved digest in another new evidence file.

- [ ] **Step 6: Request security review.**

After quality review is approved, use a fresh security reviewer to attempt source/live aliasing, symlink/junction/reparse replacement, package/manifest/ledger/event/projection/report/artifact tamper, path traversal/case collision, expected-rule bypass, plaintext/secret leakage, resource exhaustion, replay/duplicate/lost-event attacks, and public routing activation. No unresolved Critical or Important finding is allowed. Fix through TDD and rerun all gates/rehearsal when needed.

- [ ] **Step 7: Record Slice-2 completion without activating V2.**

Update this plan's execution-status section with task commit hashes, focused/full totals, evidence checksum, exact source-copy authorization reference digest, and three review disposition digests. Commit only the documentation update. Keep rollout state `off`, do not create live shadow/canary transitions, do not deploy, and state explicitly that the next authorized work is Slice 3 privacy, retention, and global scope.

```powershell
git add docs/superpowers/plans/2026-09-09-v2-shadow-migration-and-compatibility-parity.md
git commit -m "docs: record V2 shadow migration evidence"
```
