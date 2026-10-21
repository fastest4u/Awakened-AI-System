# Task 12C3 branch-bound source binding implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the private Task 12C3 rehearsal authenticate and replay a genuinely branch-bound sealed V1 source through three clean runs and a fourth no-op, without changing the non-Git target or relaxing source verification.

**Architecture:** Add an explicit, required seven-field source binding to the internal Task 11F runner input. Validate and snapshot it before any target write, compare its shared identity/scope to the target context, then pass it unchanged to `verifyV1SourceCopy`. The Task 12C3 command forwards the already C1-verified binding on all four invocations; a disposable Git-backed lifecycle fixture supplies the real branch-bound source proof.

**Tech Stack:** Node.js >=24.16.0, TypeScript, native `node:sqlite`, Node test runner, PowerShell/Git on the Windows worktree.

**Spec:** [Approved Task 12C3 branch-bound source binding design](../specs/2026-09-25-task12c3-branch-bound-source-binding-design.md)

## Global Constraints

- Stay on `codex/subproject-3-projections` in the existing isolated linked worktree. Preserve the dirty parent Task 12 plan and the already reviewed, uncommitted C3 retry-delta correction in rehearsal source/test.
- Product/test scope is exactly five files: `src/orchestrator/migration/v2-shadow-migration-runner.ts`, `src/orchestrator/migration/v2-shadow-migration-rehearsal.ts`, `tests/support/v2-shadow-migration-fixture.ts`, `tests/v2-shadow-migration-runner.test.ts`, `tests/v2-shadow-migration-rehearsal.test.ts`. Stop for a revised design ruling if the genuine Git source cannot be built inside this scope.
- No EventStore, importer, V1 source verifier, public API, evidence schema, registry, CI, dependency, or PROD state changes. Never rewrite source rows/manifest to manufacture branch support.
- `expectedSourceBinding` is a required internal `ProjectBinding` with exactly `projectId`, `vaultId`, `storeId`, `workspaceId`, `branchScopeId`, `branchRef`, `sessionId`. Project/vault/store accept lowercase UUIDv4 or legacy SHA-256; workspace accepts SHA-256; branch scope accepts null or source-verifier UUID; branch ref accepts null or nonempty NUL-free string; session must be null.
- Invalid own-data shape is redacted `MIGRATION_SOURCE_INVALID`; a valid but conflicting identity is redacted `MIGRATION_IDENTITY_CONFLICT`. Both precede target writes. Non-Git target branch ref is not forced to null in the source binding; real Git target branch ref must match.
- The sealed source proves its own binding, not current live HEAD or operator approval. Keep the isolated target non-Git and preserve authenticated source branch inside imported payload.
- Use a new absent test-only retention destination for final evidence. Preserve prior genuine success evidence and the 33-byte failed reservation. The full suite's existing Task 13 contract failures are not a Task 12C3 pass.

## File map

| File | Sole responsibility in this change |
| --- | --- |
| `src/orchestrator/migration/v2-shadow-migration-runner.ts` | Strictly capture and validate explicit source binding; cross-check target identity; forward to source verifier. |
| `src/orchestrator/migration/v2-shadow-migration-rehearsal.ts` | Forward C1-authenticated binding to every operational invocation, preserving retry-delta correction. |
| `tests/support/v2-shadow-migration-fixture.ts` | Construct an optional genuine Git/lifecycle-written source and pass explicit binding in direct-runner fixtures. |
| `tests/v2-shadow-migration-runner.test.ts` | Pin input shape, early refusals, unbranched success, and Git-target agreement. |
| `tests/v2-shadow-migration-rehearsal.test.ts` | Pin real branch-bound compiled-command success, source/corpus immutability, no-op, and negative CLI pre-write refusal. |

## Review Focus

1. Missing, extra, accessor, proxy or nonenumerable keys under `expectedSourceBinding` must refuse before a target open/write (Task 2).
2. Mutating caller-owned binding after runner capture must not change the binding seen by source verification (Task 2).
3. A syntactically valid branch-scope mismatch with the target must return `MIGRATION_IDENTITY_CONFLICT`, even if branch text matches (Task 2).
4. A real Git target whose current branch disagrees with the supplied source branch must refuse before target mutation (Task 2).
5. A config-only branch string or altered sealed manifest must not count as branch support and must leave evidence, package and target roots untouched (Task 3).

---

### Task 1: Produce a truthful disposable branch-bound V1 source

**Files:**
- Modify: `tests/support/v2-shadow-migration-fixture.ts:81-280,320-325,449-480`
- Test: `tests/v2-shadow-migration-rehearsal.test.ts`

**Interfaces:**
- Consumes: `createV2ShadowMigrationFixture(t, options)` and `createSnapshotParityFixture(t, options)`.
- Produces: optional `branchBoundSource?: boolean` on those fixture options; when true, `f.projectionBinding.branchRef` and `f.projectionBinding.branchScopeId` come from committed production-written source events, and `f.verificationInput.expectedBinding` matches the sealed manifest. Default stays unbranched.

- [ ] **Step 1: Add a fixture-authenticity test before changing the fixture.** In `tests/v2-shadow-migration-rehearsal.test.ts` import `verifyV1SourceCopy` and add:

```ts
test("branch-bound source fixture is sealed from production Git/lifecycle events", async t => {
  const f = await createSnapshotParityFixture(t, { branchBoundSource: true, rankingPair: true });
  assert.match(f.projectionBinding.branchRef!, /^refs\/heads\//);
  assert.ok(f.projectionBinding.branchScopeId);
  assert.equal(f.manifest.branchRef, f.projectionBinding.branchRef);
  assert.equal(f.manifest.branchScopeId, f.projectionBinding.branchScopeId);
  assert.ok(f.sourceEvents.every(event => event.branchRef === f.projectionBinding.branchRef
    && event.branchScopeId === f.projectionBinding.branchScopeId));
  const verified = await verifyV1SourceCopy(f.verificationInput);
  verified.close();
});
```

- [ ] **Step 2: Compile/run RED.** Run `npm run test:build` and then `node --test --test-concurrency=1 --test-name-pattern="branch-bound source fixture" dist-test/tests/v2-shadow-migration-rehearsal.test.js`. Expected RED: TypeScript rejects the absent option (do not force RED by changing a production guard).
- [ ] **Step 3: Add the optional branch source in the fixture.** Before `lifecycle.start`, create a disposable Git repository at `liveStoreRoot`, configure local fixture author, add one fixture README and commit it; use `execFileSync("git", ["init", "--initial-branch=task12c3", liveStoreRoot], { stdio: "ignore", windowsHide: true })` and `git -C liveStoreRoot` commands, as in `tests/lifecycle.concurrent.test.ts:311-316`. Keep the existing lifecycle `start` and `root-start` operations: they must write the first source events. Obtain the authoritative Git `ProjectContext` from the same `ProjectBindingService.establish` + `WorkerProjectStoreIdentityProbe` path used by `tests/fixtures/project-store-lifecycle-child.ts:396-447`, with the same project/vault roots and a dedicated fixture client ID; use that context (not a hand-crafted Git snapshot) for subsequent `EventStore.append` calls. Read `project_id,vault_id,store_id,workspace_id,branch_scope_id,branch_ref` from the first stored event to set `projectionBinding`, and assert Git kind, non-null branch scope and ref. Replace the manifest's hard-coded null scope/ref with `projectionBinding.branchScopeId` / `projectionBinding.branchRef`. Propagate the option through `createSnapshotParityFixture` and `createShadowMigrationRunnerFixture`. In its direct runner input set `expectedSourceBinding: f.projectionBinding`. Keep default fixture behavior unchanged.
- [ ] **Step 4: Compile/run GREEN and prove immutable sealed identity.** Run `npm run test:build`, then the focused fixture test. It passes only with a verifier-accepted branch-bound copy. Read raw event rows and manifest again; assert the branch fields equal the production-written events, source event hashes and copied file descriptors still verify. If the lifecycle writer cannot produce this source inside the five-file scope, stop and request a design ruling.
- [ ] **Step 5: Commit this self-contained test-fixture deliverable.** Stage `tests/support/v2-shadow-migration-fixture.ts` and only the new fixture-authenticity hunk in `tests/v2-shadow-migration-rehearsal.test.ts` (select hunks with `git add -p`; the test file already contains an unrelated reviewed retry correction). Inspect `git diff --cached --name-status` and `git diff --cached --check`, then commit `test: add genuine branch-bound migration source fixture`. Leave the dirty parent plan and the pre-existing retry correction unstaged for their own final scoped review.

### Task 2: Bind the runner to explicit authenticated source identity

**Files:**
- Modify: `src/orchestrator/migration/v2-shadow-migration-runner.ts:5-100,127-170,400-408`
- Modify: `src/orchestrator/migration/v2-shadow-migration-rehearsal.ts:465-480`
- Test: `tests/v2-shadow-migration-runner.test.ts`
- Test: `tests/v2-shadow-migration-rehearsal.test.ts`

**Interfaces:**
- Consumes: `f.projectionBinding: ProjectBinding` from Task 1; existing `verifyV1SourceCopy({ expectedBinding, ... })`.
- Produces: required `V2ShadowMigrationRunInput.expectedSourceBinding: ProjectBinding`; C3 passes `preflightInput.expectedBinding` unchanged on each of the three clean target inputs and the reused fourth input.

- [ ] **Step 1: Write runner and command RED tests.** Use `createShadowMigrationRunnerFixture(t)` and its existing empty package/projection directories. Add a table for absent key, extra key, nested accessor, proxy, nonenumerable key, bad UUID/hash, non-null session and NUL/empty ref; call `run` with `as unknown as V2ShadowMigrationRunInput` only for malformed cases, assert `MIGRATION_SOURCE_INVALID`, no sensitive input in error text, empty package/projection roots, and no new target migration rows. Add another table mutating each of project/vault/store/workspace/branch scope to a different valid value and assert `MIGRATION_IDENTITY_CONFLICT` before writes. Add the minimal `branch-bound compiled rehearsal` positive test using the Task 1 fixture and the existing full-corpus command setup in `tests/v2-shadow-migration-rehearsal.test.ts:168-310`; its old-runner failure is the required behavioral RED before implementation. Concrete runner assertion pattern:

```ts
await assert.rejects(runner.run(changed as typeof f.runnerInput),
  error => error instanceof ShadowMigrationError && error.code === "MIGRATION_IDENTITY_CONFLICT");
assert.deepEqual(readdirSync(f.runnerInput.packageRoot), []);
assert.deepEqual(readdirSync(f.runnerInput.v1ProjectionRoot), []);
```

For a real Git target disagreement, put a disposable direct-runner target database under the Task 1 Git worktree but outside its live vault and source copy; use the authoritative Git `ProjectContext` from the production binding service with only the target database route changed, then supply a different valid source branch ref and assert early conflict. For post-capture mutation, use the existing `after-source-verified` fault seam to mutate the original caller-owned binding and assert the verifier/result remains bound to the captured value. Preserve the existing unbranched runner success test.
- [ ] **Step 2: Run both RED tests.** Compile with `npm run test:build` and run `node --test --test-concurrency=1 --test-name-pattern="source binding" dist-test/tests/v2-shadow-migration-runner.test.js` plus `node --test --test-concurrency=1 --test-name-pattern="branch-bound compiled rehearsal" dist-test/tests/v2-shadow-migration-rehearsal.test.js`. Expected behavioral RED: a genuine source passes C1 then the old runner derives null from non-Git target; malformed inputs either pass shape capture or fail too late. Do not manufacture RED by removing an existing guard.
- [ ] **Step 3: Add required input and strict validation.** Import `ProjectBinding` from `../projections/contracts.js` under a distinct name from identity contracts, plus `isProjectionProjectStoreIdentity` and `isProjectionWorkspaceIdentity`. Add `readonly expectedSourceBinding: ProjectBinding` to `V2ShadowMigrationRunInput` and its name to `INPUT_KEYS`. After `capture` and before `driver.open`, inspect exactly seven own enumerable data keys; reject symbols, extra/missing keys, wrong domain, non-null session and malformed ref as `MIGRATION_SOURCE_INVALID`. Compare the four IDs and branch scope to `input.targetContext`; additionally compare branch refs only for `targetContext.workspace.kind === "git"`. Conflict is `MIGRATION_IDENTITY_CONFLICT`. The core comparison is:

```ts
const sourceBinding = input.expectedSourceBinding;
const targetBinding = input.targetContext.binding;
if (sourceBinding.projectId !== targetBinding.projectId
  || sourceBinding.vaultId !== targetBinding.vaultId
  || sourceBinding.storeId !== targetBinding.storeId
  || sourceBinding.workspaceId !== targetBinding.workspaceId
  || sourceBinding.branchScopeId !== (input.targetContext.branchScopeId ?? null)
  || (input.targetContext.workspace.kind === "git"
    && sourceBinding.branchRef !== input.targetContext.workspace.branchRef)) {
  fail("MIGRATION_IDENTITY_CONFLICT");
}
```

Replace the current target-derived `expectedBinding` object at `verifyV1SourceCopy` with `sourceBinding`. Keep the existing verifier's rechecks and deadlines.
- [ ] **Step 4: Forward C1 binding from the rehearsal and complete GREEN.** In `lastInput` construction add `expectedSourceBinding: preflightInput.expectedBinding`; the fourth call reuses the same captured source binding. Run `npm run test:build`, then the focused runner tests and an existing unbranched runner success test. Assert the existing retry-delta changes remain present in rehearsal source/test.
- [ ] **Step 5: Review and commit the contract change.** Stage runner source and runner tests; select only the new `expectedSourceBinding` handoff hunk in rehearsal source and the branch-command RED/GREEN test hunk in rehearsal tests with `git add -p`. Inspect the staged diff and `git diff --cached --check`, then commit `feat: bind migration runner to authenticated source identity`. Keep the previously reviewed retry-delta hunks unstaged for Task 4; never discard them.

### Task 3: Prove the real compiled rehearsal and pre-write refusals

**Files:**
- Modify: `tests/v2-shadow-migration-rehearsal.test.ts:168-310,600-700`
- Read only: `scripts/run-v2-shadow-migration-rehearsal.js`, `src/orchestrator/migration/v2-shadow-migration-evidence.ts`

**Interfaces:**
- Consumes: Task 1's `branchBoundSource` fixture and Task 2's runner input contract.
- Produces: compiled-command proof of three independent clean runs and a fourth semantic no-op, with source branch preserved inside imported payload; no public CLI or evidence schema change.

- [ ] **Step 1: Extend the branch-positive command test whose RED was recorded in Task 2.** Factor the existing `retains synthetic functional evidence from the fresh compiled rehearsal command` setup into a test-local parameterized body; invoke it once with the existing unbranched source and once with `createSnapshotParityFixture(t, { branchBoundSource: true, rankingPair: true, legacyArtifacts: true })`. Do not replace the existing full corpus with a two-event toy copy. Before execution record `treeIdentity` for source root, corpus root and live vault; after execution assert identical identities, published checksum, three non-deduplicated runs, fourth deduplicated no-op, equal determinism vectors and unchanged semantic/artifact digests. Read imported source payloads and assert their original branch scope/ref equal `f.projectionBinding` while target migration wrappers remain non-Git-scoped.
- [ ] **Step 2: Run the branch-positive command test after assertions expand.** Use the fresh compiled build and `node --test --test-concurrency=1 --test-name-pattern="branch-bound compiled rehearsal" dist-test/tests/v2-shadow-migration-rehearsal.test.js`. Task 2 records the authentic old-runner RED; this run must now pass all four invocations and the added provenance/immutability assertions.
- [ ] **Step 3: Add strict negative CLI cases.** In the existing `refused(name, changedArgs, changedConfig)` matrix, supply a valid-looking but wrong branch ref, a wrong branch scope UUID, a config-only branch string against unbranched source, and a mismatched sealed manifest copy. Assert each has exit 1, exactly `REHEARSAL_REFUSED\n` on stderr, no stdout, and identical work/package/evidence and protected-root `treeIdentity` before/after. Keep the branch-positive source untouched.
- [ ] **Step 4: Compile and run GREEN.** Run `npm run test:build` and the focused rehearsal test. The branch-bound test must finish all four actual runner invocations; source/corpus identities must remain unchanged. Run the unbranched compiled-command test as regression, preserving its genuine SQLite retry ledger assertion and published retry count.
- [ ] **Step 5: Commit only the test deliverable.** Select only new Task 3 test hunks with `git add -p tests/v2-shadow-migration-rehearsal.test.ts`; inspect `git diff --cached --name-status` and `git diff --cached --check`, then commit `test: prove branch-bound migration rehearsal and early refusals`. The pre-existing retry test hunk remains for Task 4.

### Task 4: Final Task 12C3 gate, evidence and independent review

**Files:**
- Verify: the five scoped product/test files above
- Read only: `docs/superpowers/specs/2026-09-25-task12c3-branch-bound-source-binding-design.md`, `docs/superpowers/plans/2026-09-09-v2-shadow-migration-and-compatibility-parity.md`

**Interfaces:**
- Consumes: Tasks 1-3 plus the reviewed retry-delta correction.
- Produces: a scoped final commit, fresh test evidence and an independent spec/quality/security review. This does not approve PROD rollout.

- [ ] **Step 1: Run fresh compilation, then the exact serial gate, awaiting completion.** Run `npm run test:build` to exit 0; only after it finishes, run:

```powershell
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-migration-rehearsal.test.js dist-test/tests/v2-shadow-migration-runner.test.js dist-test/tests/v2-shadow-importer.test.js
```

Require all tests to pass; record the new total rather than repeating historical 236/236. The command is long-running. Do not substitute `npm test` or parallelize the three files.
- [ ] **Step 2: Run build/smoke and source-integrity checks.** Run `npm run typecheck`, `npm run build` and `node scripts/smoke-worker.js`; require exit 0. Run `git diff --check`, `git status --short` and `git diff --name-status`. Hash the retained evidence and compare it to its published checksum; use a newly absent test-only parent/leaf, never overwrite a prior finalized output or failed reservation. Confirm prior genuine evidence is unchanged.
- [ ] **Step 3: Commit only final scoped residue.** Stage the previously reviewed retry-delta correction in `src/orchestrator/migration/v2-shadow-migration-rehearsal.ts` and `tests/v2-shadow-migration-rehearsal.test.ts`, plus any remaining Task 12C3-only hunks. Inspect `git diff --cached --name-status` and `git diff --cached --check`, then commit `fix: account for fourth-pass migration retries`. The dirty parent plan remains unstaged; do not stage ignored SDD artifacts or live memory files.
- [ ] **Step 4: Obtain independent reviews.** Have a fresh reviewer compare the approved spec and each exact scoped commit against the code, tests, evidence, and retained retry-delta fix; separately check redacted errors, pre-write refusal, source immutability, target/source identity separation and Git provenance. Address actionable findings with focused RED/GREEN and rerun the affected gate, then a final whole-branch review.
- [ ] **Step 5: Report the bounded outcome.** State the commit IDs, fresh serial gate count, build/smoke result, evidence checksum, reviewer disposition and remaining Task 12/13/14/PROD gates. Do not claim Task 12C3 or V2 production-ready if any required verification/review remains open.
