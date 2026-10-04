# V2 Hosted CI Causal Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish bounded, sanitized observations for the Ubuntu recipe refusal and representative Windows path failures without changing acceptance policies or declaring unproven repairs.

**Architecture:** Thread an optional private observer through the existing measured recipe reader and keep reporting owned by the trusted build command. Add explicit test-owned path snapshots beside the existing canonical-temp helper and compare owned synthetic controls at the real boundaries. Leave sealed production paths and child protocol streams unchanged; unresolved ambiguity is a reason to request a precise follow-up, not to soften a guard.

**Tech Stack:** Existing Node.js 24.16.0 builtins, TypeScript, native node:test, Git and owned synthetic filesystem/process fixtures; no added dependencies.

**Spec:** [Approved remediation design](../specs/2026-10-04-v2-hosted-ci-remediation-design.md) and [CI-role amendment](../specs/2026-10-04-v2-fast-pr-full-release-ci-design.md), approved at `aac794056c724ef0bf5b1d582794dfd3142b518d`.

## Global Constraints

- Await plan review before implementation or diagnostic execution. Preserve Subagent-Driven and reuse the existing V2 worktree; do not alter the primary checkout's unrelated work.
- Keep original errors, exit status, descriptor closure, process-tree ownership, build invalidation and every regular-file/link/canonical-path/provenance/route guard.
- Diagnostics grant no eligibility: at most one record per encountered boundary per named case, 16 records per probe, 2 KiB per serialized record. Unknown or incomplete evidence is not a passing predicate.
- No raw absolute paths, usernames, path hashes, env values, inode/device numbers, file/database/manifest/transcript bytes, credentials or arbitrary exception messages/stacks in diagnostic records.
- No new dependencies, installations, timeouts/cap increases, environment-controlled bypasses, public diagnostic API, source-seal inventory changes, dependency unlink/rewrite or new artifact transport.
- Only trusted build measurement and explicit owned synthetic tests activate collectors. Rehearsal/worker/mutation protocol stdout/stderr remain unchanged; no actual Codex capture or live V1 data.
- Local named synthetic controls become executable only after this plan is approved. Hosted observation requires separate authority. Do not rerun the whole repository suite per observation or guess an Ubuntu result from Windows.

## Review Focus

- A short-circuited guard has not observed later predicates; preserve `unknown`, not false/pass, in Task 1.
- A reporter failure or cap overflow must retain the primary product failure and descriptor/process closure; pin this in Task 1.
- A successful parent inspection does not prove child-local canonical identity; label snapshots and keep child protocol untouched in Task 2.
- A copied executable loses installation hardlink topology; reproduce owned topology independently and label installed-topology uncertainty in Tasks 1 and 3.
- A renamed or replaced cleanup root must not redirect recursive deletion to a different owner; pin owned-root cleanup in Task 2.

---

## File Responsibilities and Interfaces

| File | Responsibility |
| --- | --- |
| Modify `scripts/run-v2-shadow-migration-rehearsal.js` | Private observer threading around already captured guard observations; bounded collector implementation in this already measured owner |
| Modify `scripts/build.js` | Activate the observer only for initial trusted recipe measurement and write sanitized diagnostics separately from operational stdout |
| Create `tests/ci-build-diagnostics.test.ts` | Collector and reader controls in isolated copies/owned topology; no mutation of the real installation |
| Create `tests/support/ci-path-diagnostics.ts` | Fixed snapshot schema and explicit test collector beside `canonical-temp.ts` |
| Create `tests/ci-path-diagnostics.test.ts` | Owned raw/canonical/hostile path and cleanup controls |
| Modify `tests/projection-coordinator.test.ts`, `tests/projection-manifest.test.ts`, `tests/projection-integrity.test.ts`, `tests/fresh-start-admission.test.ts`, `tests/directory-durability.test.ts` | One explicit representative snapshot per named case immediately before its existing production call; no fixture-wide rewrite |
| Modify `tests/v2-shadow-migration-rehearsal.test.ts` | Extend only owned native-executable mutation/topology controls; preserve operational refusal assertions |
| Create `docs/runbooks/v2-ci-causal-diagnostics.md` | Exact commands, observations, uncertain cases and evidence needed before a repair plan |

Do not edit `src/orchestrator/projections/stable-directory.ts`, `coordinator.ts` or `src/orchestrator/identity/directory-durability.ts`: they are absent from the approved sealed-source inventory. If an actual refusal-site reason remains necessary there, report the exact owner/predicate/channel and obtain separate authority; do not change the inventory as part of this plan.

## Task 1 Exact Build Reader Observations

**Files:** Modify both existing scripts; create `tests/ci-build-diagnostics.test.ts`; add the owned executable controls to `tests/v2-shadow-migration-rehearsal.test.ts`.

**Interfaces:** Preserve default `readBuildBytes(name, maximum)` and `measureBuildFiles(names)` behavior. Add optional `observation: { caseId: DiagnosticCase; observe(record: unknown): boolean }` to each reader/measurement signature, threaded through `checkedPath` and `readAbsoluteBuildBytes`, only from the initial `measureBuildFiles(rehearsalRecipePaths)` call in `scripts/build.js:141`. Later command/artifact/runtime measurements do not silently inherit it. This is an internal argument, never a CLI/env parameter; functions retain their existing return values.

Inside the existing measured reader owner, define `createCiDiagnosticCollector(write: (line: string) => void): { observe(record: unknown): boolean; readonly incomplete: boolean }`. `observe` reports whether a sanitized record was collected, not whether the product was accepted. It catches reporter failure and latches incomplete. Unexpected fields, duplicate boundary/case records, overflow and unrecognized values also latch incomplete without replacing product results.

The collector validates two closed record variants. Build records have exact keys `schemaVersion`, `family`, `caseId`, `platform`, `boundary`, `phase`, `recipeId`, `reason`, `observed`; path records replace `recipeId` with no additional field. Use schema 1; build family `build`, phase `guard-observation` and allowlisted recipe IDs. Build boundary IDs are `recipe-path`, `descriptor-before`, `read`, `descriptor-after`; reasons are `path`, `non-regular`, `link-count`, `size`, `short-read`, `identity-change`, `filesystem`, `unknown`. Task 2 defines the fixed path variant; implement its schema here so the later helper consumes the same collector, not a divergent validator.

`DiagnosticCase` is exactly `recipe-measurement`, `regular-control`, `link-control`, `size-control`, `read-control`, `identity-control`, `path-control`, `coordinator-control`, `manifest-control`, `integrity-control`, `admission-control`, `durability-control`, `cleanup-control`. Build `observed` keys are exactly `regular`, `singleLink`, `withinSizeLimit`, `linkCount`, `size`, `limit`, `descriptorEqual`, `pathEqual`, `sizeEqual`, `mtimeEqual`, `ctimeEqual`, `operation`, `errorCode`. Predicate fields are booleans or `unknown`; counts/size/limit are nonnegative decimal strings or `unknown`; operation/error enums are defined in Task 2. Later unevaluated predicates remain unknown. No absolute pathname or error object enters this record.

- [ ] **Step 1: Write failing `CI build diagnostics` tests.** Copy the actual reader script into a fresh owned module root, import it without invoking its CLI, and create a literal `package.json` recipe there. Test ordinary regular bytes, exact size-bound acceptance and oversized refusal, a real owned extra hardlink, non-regular leaf, native symlink/parent-symlink, truncated reads, descriptor mutation and pathname replacement. Assert the existing `REHEARSAL_BUILD_INVALID` and descriptor closure, not just any thrown error.

```ts
test("CI build diagnostics preserve refusal when the reporter fails", async () => {
  const fixture = await ownedReaderFixture();
  try {
    const collector = fixture.reader.createCiDiagnosticCollector(() => { throw Error("synthetic reporter failure"); });
    fixture.addRecipeHardlink();
    assert.throws(() => fixture.reader.readBuildBytes("package.json", 1024,
      { caseId: "link-control", observe: collector.observe }), /REHEARSAL_BUILD_INVALID/);
    assert.equal(collector.incomplete, true);
    assert.equal(fixture.openDescriptorCount(), 0);
  } finally { fixture.cleanup(); }
});
```

`ownedReaderFixture()` is a local async test helper returning `{ reader, addRecipeHardlink(): void, openDescriptorCount(): number, cleanup(): void }`. Its native descriptor ledger/fault instrumentation is confined to the owned diagnostic test-file process, restored in finally and never installed into production. The copied module's filesystem root is native-canonical and contains only created test inputs. Test unknown/extra fields, 17th record, duplicate boundary/case, over-2-KiB records, writer throws and unavailable values independently. Use one collector per probe so control cases do not exceed the aggregate cap by construction.

- [ ] **Step 2: Establish RED.** Fresh `npm run test:build`, then `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^CI build diagnostics" dist-test/tests/ci-build-diagnostics.test.js`. Missing signatures may initially fail compilation; a signature stub must still fail the observation/error-preservation assertions.
- [ ] **Step 3: Implement only observation.** At each existing rejection branch, use its already captured observations before the unchanged refusal. The first descriptor branch uses exactly its `before` stat; the final branch uses captured `after`/`leaf`, not a reopened pathname. Keep short-circuit semantics and the existing finally-close. A callback failure cannot escape into the product operation. In `build.js`, own a collector writing fixed `CI_DIAGNOSTIC ` JSON lines to stderr, not protocol/operational stdout. If collection is incomplete, report fixed `CI_DIAGNOSTIC_INCOMPLETE` separately without changing the original operation result. Do not activate this collector in the operational rehearsal CLI.
- [ ] **Step 4: Verify GREEN and the hostile matrix.** Repeat fresh compile and the named diagnostic group. Retain namespace/entry redirect, stale identity, dependency/finalization mutation, exact input/output and manifest invalidation controls from existing rehearsal tests. Add explicit native executable mutation to the owned changed-file/finalization matrix using the platform-native recipe path. Run only the affected named controls, not the full expensive rehearsal suite during each edit. Copies establish mutation controls, not installed hardlink provenance.
- [ ] **Step 5: Commit exact task paths.** Message: `test: observe bounded build recipe refusals`. No installed dependency is unlinked, rewritten or accepted with extra hardlinks; no production cause is claimed from synthetic success.

## Task 2 Owned Windows Path Snapshots

**Files:** Create the path support/test files and modify the five named representative test owners only.

**Interfaces:** In `tests/support/ci-path-diagnostics.ts`, define `capturePathSnapshot(input: { family: PathFamily; caseId: DiagnosticCase; directory: string; durableBase?: string }, collector: DiagnosticCollector): void`. `PathFamily` is exactly `coordinator`, `manifest`, `integrity`, `fresh-admission` or `durable-directory`; case IDs use Task 1's exact union. `DiagnosticCollector` has the same `observe(record): boolean`/`incomplete` interface as Task 1 and uses that collector implementation, imported from the measured script with no CLI execution.

Path records use boundary `path-snapshot`, phase `pre-boundary-snapshot` and reason `snapshot` or `filesystem`. Their `observed` keys are exactly `absolute`, `normalized`, `resolved`, `statSuccess`, `nativeRealpathSuccess`, `directory`, `symlink`, `canonicalEqual`, `relativeAbsolute`, `parentEscape`, `walkReachedBase`, `operation`, `errorCode`, with unknown for unavailable values. `walkReachedBase` is unknown in a pre-boundary snapshot unless independently observed from the actual callback; never infer the real walk from lexical containment. Recognized operation enums are `lstat`, `realpath`, `open`, `fstat`, `read`, `close`, `none`, `unknown`; error enums are `ENOENT`, `EACCES`, `EPERM`, `EINVAL`, `EIO`, `none`, `unknown`. Measurements happen only in owned synthetic tests; never serialize the input path or identity numbers.

- [ ] **Step 1: Write failing `CI path diagnostics` tests.** Create raw and native-canonical spellings of an owned root and invoke real `captureProjectionDirectoryIdentity` with each; record snapshots separately from actual outcomes. Test lexical invalid paths, real junction/symlink refusal when available, replacement after authorization, durable descendant acceptance and sibling escape refusal. A fixture's injected symlink metadata is not a native control. If native links cannot be created, report the capability as unverified, not a silently passing control.
- [ ] **Step 2: Establish RED.** Fresh compile; `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^CI path diagnostics" dist-test/tests/ci-path-diagnostics.test.js`. Expected failures concern absent snapshot support/sanitization, not altered path acceptance.
- [ ] **Step 3: Implement fixed snapshots and representative calls.** Keep production guards unchanged. Insert explicit collectors immediately before the existing production call in coordinator `adopts a staged V2 generation before publishing its manifest authority`, manifest `serializes canonical bytes and publishes only through a safe projection directory`, integrity `returns a frozen pass report only for an exact authoritative replay`, fresh admission `worker opening independently checks fresh context: valid`, and durability `replays the full parent chain from a known durable base for an existing tree`. Capture fresh worker root/database-returned spelling as separate roles; do not infer child-local truth from a parent snapshot. Keep independent families and existing hostile inputs.

Do not automatically canonicalize fixture roots in this observation task. Any later fixture repair must derive all descendants from one proved root and preserve deliberate invalid controls. Cleanup tests capture the created root's ownership, refuse recursive traversal into a replacement/junction/unrelated root and preserve connection closure; never use a later canonical lookup to redirect deletion. Do not add diagnostic text to the stable mutation child's stdout/stderr protocol.

- [ ] **Step 4: Verify GREEN and bounded representatives.** Run the new diagnostic group and these literal commands after fresh compilation:

```powershell
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="adopts a staged V2 generation before publishing its manifest authority" dist-test/tests/projection-coordinator.test.js
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="serializes canonical bytes and publishes only through a safe projection directory" dist-test/tests/projection-manifest.test.js
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="returns a frozen pass report only for an exact authoritative replay" dist-test/tests/projection-integrity.test.js
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="worker opening independently checks fresh context: valid" dist-test/tests/fresh-start-admission.test.js
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="replays the full parent chain from a known durable base for an existing tree" dist-test/tests/directory-durability.test.js
```

Confirm selected counts are nonzero and all owned processes/connections close. Each collector stays within one record per boundary/case, 16 records and 2 KiB; preserve reporter-failure/unknown behavior. A successful snapshot helper is not proof of the production rejecting predicate.

- [ ] **Step 5: Commit exact task paths.** Message: `test: add bounded owned path diagnostics`. Retain raw/canonical comparisons as controls without asserting the hosted 8.3-alias hypothesis is proven.

## Task 3 Evidence Disposition and Repair Handoff

**Files:** Create `docs/runbooks/v2-ci-causal-diagnostics.md`; modify `tests/support/ci-path-diagnostics.ts` and the two new diagnostic test files to pin report classification. No speculative production/fixture repair belongs here.

**Interfaces:** Consume Task 1 exact refusal observations and Task 2 explicitly labeled snapshots. Export `classifyEvidence(value: { record: unknown; collectorIncomplete: boolean; operationCode: string; expectedCode: string; cleanupComplete: boolean; location: "guard" | "snapshot" | "later-read" }): "exact-refusal" | "snapshot-only" | "incomplete"` from the path test-support module for both test owners; it cannot grant production qualification. Expected error codes come from the named owned controls, never user input. A shared failure is a V2 blocker regardless of legacy workflow scheduling.

- [ ] **Step 1: Write failing classification tests.** Require `incomplete` for cap overflow, unavailable required observations or uncertain process closure. Require `snapshot-only` for parent-only or later re-read measurements. Only actual guard-bound evidence with preserved primary refusal may be `exact-refusal`; an unrelated timeout/cleanup error or a different exception cannot stand in for it.
- [ ] **Step 2: Run RED using the two named diagnostic groups.** Check fresh compilation and native exits. Do not run `npm test`, build all artifacts, install dependencies or dispatch hosted CI as a shortcut to finding the cause.
- [ ] **Step 3: Implement the local classification assertions and write the runbook.** Record the original merge/head/base identities from the spec, current candidate identity and source correspondence before treating an old source line as a reproducer. Enumerate failure families separately, observed reason, one-condition control and whether the intended business assertion became reachable. Windows findings do not qualify Ubuntu; byte-copy fixtures do not prove installed executable topology. If the installed Ubuntu shape cannot be reproduced locally, ask for precise hosted probe authority rather than changing acceptance.

Record the exact refusal-site/channel needed for any unresolved Windows boundary, including child-local uncertainty. Because relevant owners are sealed and child streams are protocol, return for a concrete exact-path/private-channel amendment if needed. Keep legacy-only unresolved regressions separate from nonlegacy V2 failures under the CI amendment. Define the smallest next repair plan from established evidence; this observation plan does not authorize arbitrary red-test fixes.

- [ ] **Step 4: Verify GREEN and documentation evidence.** Fresh compile and the two diagnostic groups; exact relevant hostile tests only. Verify all process/descriptor/connection cleanup and record platform-unavailable cases. Review diagnostic records against the whitelist and caps. Verify the runbook distinguishes actual observations, hypotheses, incomplete probes, pending hosted authority and production qualification. Do not turn absence of a reproduced failure into a fixed claim.
- [ ] **Step 5: Commit exact task paths.** Message: `docs: record bounded CI causal evidence and repair handoff`. The result is a locally verified diagnostic capability plus dispositions, not green hosted CI or whole-system PROD readiness. Subsequent covered repairs receive a reviewed scoped plan; acceptance-policy/source-seal changes receive a concrete amendment first.

## Execution Handoff

Review this diagnostic plan separately from the [CI-role implementation plan](2026-10-04-v2-fast-pr-full-release-ci.md), using the preserved Subagent-Driven method. The plans may progress independently where they do not share files or output locks; tests/builds sharing compiled outputs remain serialized. Actual candidate-bound full V2 qualification waits for causal repair and separately authorized hosted execution.
