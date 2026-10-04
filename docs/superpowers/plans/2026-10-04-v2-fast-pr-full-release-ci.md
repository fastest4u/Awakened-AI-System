# V2 Fast PR and Full Release CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement separate PR feedback, exact-candidate V2 release qualification and manual legacy regression without losing nonlegacy coverage or weakening guards.

**Architecture:** Extract only the closed workflow-contract parser into pure test support, then transfer qualification/evidence ownership atomically to three explicit workflow roles. Validate qualification identity in trusted inline workflow steps before executing candidate code. Leave production source, build recipes and test-profile commands unchanged.

**Tech Stack:** Existing TypeScript, Node.js 24.16.0, native node:test, Git, PowerShell and GitHub Actions; no added dependencies.

**Spec:** [Approved CI amendment](../specs/2026-10-04-v2-fast-pr-full-release-ci-design.md), with [remediation constraints](../specs/2026-10-04-v2-hosted-ci-remediation-design.md), approved at `aac794056c724ef0bf5b1d582794dfd3142b518d`.

## Global Constraints

- This plan awaits human review. Preserve Subagent-Driven; no implementation during planning.
- Reuse `C:\Users\Server\.codex\worktrees\v2-fresh-start\Awakened-AI-System`, branch `codex/v2-fresh-start`; preserve unrelated primary-checkout edits.
- Node `24.16.0`, `ubuntu-latest` and `windows-latest`, `fail-fast: false`; retain Ubuntu rejection of Node `22.22.3`.
- PR check names remain `Node 24.16.0 on ubuntu-latest`, `Node 24.16.0 on windows-latest`, and `Reject Node 22.22.3`.
- PR and release use unchanged `npm test`; exclude only the spec's exact 12 paths. Keep `test:all`, `test:migration`, the 19-file legacy producer and schema/recovery/integrity coverage unchanged.
- Keep `contents: read`, existing action versions, immutable baseline `0e375d4643d4b630f36f874a3bb192e96739ac46`, exact protected-routing commands and sealed source inventories.
- No test deletion, new dependencies, runtime-policy changes, raised limits, compiler/build deduplication, nightly legacy schedule, extra uploads or stress-workflow changes.
- Local synthetic tests named here become executable only after plan approval. Do not install missing dependencies automatically. Publication, hosted runs, branch-protection changes, keys/config, live data and PROD activation need separate authority.

## Review Focus

- A newly discovered shared or nested legacy-looking test must still enter the default profile; pin this in Task 2.
- A pending non-PR run must not be replaced merely because cancellation is false; use unique non-PR groups and test them in Task 2.
- A valid candidate SHA is not the workflow control SHA; a distinct, approved control revision must remain independently bound in Task 3.
- A verifier loaded from the candidate cannot establish pre-execution trust; reject helper substitution and early installs in Tasks 1 and 3.
- A successful marker with skipped, cancelled, stale or crossed-OS gates is not qualification; bind trusted step outcomes and phase identities in Task 3.

---

## File Responsibilities and Interfaces

| File | Responsibility |
| --- | --- |
| Create `tests/support/ci-workflow-contract.ts` | Pure closed grammar, exact role/step policies and aggregate upload manifest; no filesystem reads, child processes or test registration |
| Create `tests/ci-workflow-roles.test.ts` | Owned string fixtures and role/trigger/parser/evidence negative tests |
| Create `tests/ci-release-identity.test.ts` | Execute the actual inline identity steps only in owned local Git fixtures with synthetic environment values |
| Modify `tests/ci-lifecycle-gates.test.ts` | Delegate workflow parsing; retain every source-isolation/evaluator/negative assertion |
| Modify `tests/ci-fresh-start-foundation.test.ts` | Bind Foundation workflow assertion to the new qualification owner, retaining runtime/ownership tests |
| Modify `.github/workflows/ci.yml` | PR feedback plus main-only push and same-PR cancellation |
| Create `.github/workflows/v2-release-qualification.yml` | Manual exact-candidate nonlegacy qualification and distinct existing qualifiers |
| Create `.github/workflows/v2-legacy-regression.yml` | Manual unchanged migration producer and existing sanitized evidence upload |
| Modify `tests/test-profiles.test.ts` | Pin new CI contract tests and future/nested shared coverage without changing the selector |
| Create `docs/runbooks/v2-ci-qualification.md` | Operator identity inputs, evidence interpretation, publication authority and measurement instructions |

The test-support API is `type CiWorkflowSet = Readonly<{ pr: string; release: string; legacy: string; stress: string }>` and `assertCiWorkflowSet(workflows: CiWorkflowSet): void`. Export `WorkflowStep` with existing `name: string | null`, `body: string`, `ownerJob: string`, plus `requiredStep(yaml: string, jobId: string, stepName: string): WorkflowStep` for fixture verification. Assertion failures throw; there is no permissive result or runtime CLI.

## Task 1 Closed Role Contracts

**Files:** Create `tests/support/ci-workflow-contract.ts` and `tests/ci-workflow-roles.test.ts`; modify only parser plumbing in `tests/ci-lifecycle-gates.test.ts`.

**Interfaces:** Consume the existing grammar/scalar/job/step/action helpers at lines 505–705 and exact policy at 706–813. Produce the pure API above. Until Task 2, retain an exact compatibility wrapper for the existing two-workflow layout; do not accept both old and new layouts through one loose validator.

- [ ] **Step 1: Write failing tests with local `roleFixtures(): CiWorkflowSet` string fixtures.** Name the group `CI roles`. Each fixture uses exact final owner/job IDs: PR `ci.yml/release-gates` plus `minimum-runtime-rejection`; release `v2-release-qualification.yml/qualification`; legacy `v2-legacy-regression.yml/legacy-regression`; stress `sqlite-stress.yml/stress`.

```ts
test("CI roles accept only the complete reviewed owner set", () => {
  assert.doesNotThrow(() => assertCiWorkflowSet(roleFixtures()));
  const missing = { ...roleFixtures(), release: "" };
  assert.throws(() => assertCiWorkflowSet(missing));
});
```

Add named cases asserting refusal of duplicate jobs/mappings/steps, anchors/aliases/merges/tags, flow or quoted keys, directives/tabs/exotic blocks, job/step bypasses, unknown owners, arbitrary environment keys and broadened action inputs. Every existing parser mutation remains exercised. Reject candidate-owned verifier calls and install/build before identity checks.

- [ ] **Step 2: Establish RED.** Run `npm run test:build`, then `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^CI roles" dist-test/tests/ci-workflow-roles.test.js`. Initially compilation may fail on the absent support module; after a signature-only stub, assertions must fail on missing role enforcement, not an unrelated fixture error.
- [ ] **Step 3: Implement the pure API.** Extract the existing closed grammar without weakening its hostile syntax checks. Extend only exact dispatch-input/push-branch paths, the fixed identity environment bindings, checkout `ref`, and named step `id` fields needed by Tasks 2–3. Use explicit hierarchy/indentation for input/permission scalars rather than the old step-only `yamlScalar` indentation shortcut. Keep action-specific `with` policies and unconditional required steps.
- [ ] **Step 4: Verify GREEN and unchanged existing parser behavior.** Run the new group and `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^workflow " dist-test/tests/ci-lifecycle-gates.test.js` after fresh test compilation. Selected assertions must pass; an empty selection is not success. Do not run the product-backed evaluator case during parser iteration.
- [ ] **Step 5: Commit only this task's three paths.** Message: `test: define closed CI role contracts`. Review the staged path set and `git diff --cached --check` first. The temporary old-layout wrapper remains exact until the next atomic task.

## Task 2 Atomic Workflow and Evidence Ownership Transfer

**Files:** Modify/create the three role workflows, modify `tests/ci-lifecycle-gates.test.ts`, `tests/ci-fresh-start-foundation.test.ts`, `tests/ci-workflow-roles.test.ts`, `tests/test-profiles.test.ts` and support policy as required. Do not modify `sqlite-stress.yml`, `package.json`, selector/build scripts or `src`.

**Interfaces:** Consume `assertCiWorkflowSet` and exact fixtures from Task 1. Production-backed tests load the four actual workflow files in their test bodies, not at support-module import time. Remove the temporary old-layout wrapper only when all owners and callers are transferred together.

- [ ] **Step 1: Write RED assertions against actual saved workflow files.** The aggregate owner check must fail while new files are absent. Mutate each required qualifier to missing, duplicate, conditional, ignored or `echo passed` and assert rejection. Keep Foundation's late-build/forged-gate controls; replace only its obsolete `npm test` refusal with a genuinely incomplete test-command substitution. Add `CI roles preserve immutable routing and sealed source inventory` in the lifecycle file. Extract its existing lines 1394–1409 into private `assertCurrentSourceInventories(): void`, retain the original case's call to it and all exact constants, and call it from the new focused case so checking seals does not launch the evaluator.
- [ ] **Step 2: Run focused RED.** Fresh compile, then the `CI roles` group, lifecycle `^workflow ` group and Foundation `^CI executes Foundation and builds before the full suite without bypasses$` case. Expected failure is the old owner/sequence mismatch; do not disguise a build/runtime failure as RED.
- [ ] **Step 3: Transfer the exact policies atomically.** PR order is full-history checkout, setup Node, install, runtime, typecheck, build, immutable baseline, routing guard, `npm test`. Keep the minimum-runtime job unchanged. PR triggers are unfiltered `pull_request`, `push.branches: [main]` written as a canonical YAML list, and manual feedback. Use the exact concurrency expressions below; do not share a group for non-PR runs.

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Release is manual only, job `qualification`, name `V2 release qualification on ${{ matrix.os }}`, Node 24.16.0 on both OSes, `fail-fast: false`, no concurrency cancellation. Its order is input validation, exact candidate checkout, HEAD/control verification, Node setup/install/runtime/typecheck/build, baseline/routing guards, `npm test`, lifecycle, rollout, Foundation and artifact qualifiers, with identity records as specified in Task 3. Use the existing qualifier commands verbatim; retain fresh builds/compiles and closure checks.

Legacy is manual only, same supported matrix/runtime, job `legacy-regression`; full-history checkout/setup/install/runtime, `npm run test:migration`, then the existing `actions/upload-artifact@v7` synthetic upload. Preserve `V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT`, literal `${{ runner.temp }}/v2-shadow-migration-functional/evidence.json`, exact synthetic name pattern and 14-day/missing-file policy. Aggregate contracts classify exactly this upload and the unchanged stress upload; PR/release have no upload slot. Retain current checkout/setup action versions and all `contents: read` policies.

- [ ] **Step 4: Verify GREEN and coverage preservation.** Fresh compile and the focused commands above; also run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/test-profiles.test.js`. Assert default selection includes the new contract tests, `future-migration.test.js` and nested legacy lookalikes, and still excludes exactly the existing 12 root filenames. Keep shared schema/recovery tests. Test same-PR collision, different-PR isolation and unique push/manual groups as fixture inputs; reject legacy schedules and release cancellation. Native outcomes are not inferred from these string tests.
- [ ] **Step 5: Commit the exact task paths.** Message: `ci: separate PR feedback V2 qualification and legacy regression`. No push/dispatch follows. A green role contract is not a green hosted release.

## Task 3 Executable Identity Controls and Operator Handoff

**Files:** Create `tests/ci-release-identity.test.ts` and `docs/runbooks/v2-ci-qualification.md`; modify the release workflow and strict test-support policy only for its exact inline identity steps/records.

**Interfaces:** Consume `requiredStep` to extract actual inline workflow bodies. Local test helper `qualificationFixture(): { root: string; candidate: string; control: string; cleanup(): void }` creates two owned Git commits with distinct SHAs and identical reviewed workflow blobs. `runInline(step: WorkflowStep, fixture, env: Record<string, string>): { status: number | null; stdout: string; stderr: string }` uses native noninteractive PowerShell with data-only environment inputs, no shell-built paths, network or product invocation.

- [ ] **Step 1: Write failing identity tests named `CI qualification`.** Assert success for distinct valid candidate/control identities. Reject empty/39/41-character SHAs, whitespace/newlines, branch names, shell metacharacters, wrong HEAD, wrong approved control revision, missing/changed workflow blob, ignored Git exits and swapped identities. Use a synthetic install sentinel: every invalid input must fail before its sentinel can run. Test skipped/cancelled/failed gate outcomes, stale manifest/compiled identity, missing phase identity and crossed OS/run identity. Assertions must inspect native status, not a marker alone.
- [ ] **Step 2: Establish the native baseline before completing the identity controls.** Fresh compile; `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^CI qualification" dist-test/tests/ci-release-identity.test.js`. Missing phase/outcome binding must fail before implementing it in Step 3. If a pre-checkout behavior was already implemented in Task 2, report its actual initial result and prove an owned fault variant fails the same assertion; do not manufacture a product failure to call the baseline RED. The identity fixtures have no dependencies, capture no user data and remove only their owned roots. Test children use `windowsHide: true`, a 20-second fixture timeout and 1-MiB captured-output cap; do not kill unrelated processes.
- [ ] **Step 3: Implement trusted inline validation.** Add exactly two required string dispatch inputs: `candidate_sha` and `approved_workflow_sha`. The latter pins the separately reviewed control revision; user input is not itself proof of approval, so the runbook requires the operator's recorded authorization for the candidate/control pair before dispatch. Pass these through fixed `V2_CI_CANDIDATE_SHA` and `V2_CI_APPROVED_WORKFLOW_SHA` environment bindings; bind `V2_CI_CONTROL_SHA` to `github.workflow_sha`. Before checkout, require exactly 40 hexadecimal characters with no whitespace and compare the normalized control SHA to its approved pin. No candidate-owned script executes here.

Checkout uses `actions/checkout@v6`, `fetch-depth: 0`, `ref: ${{ inputs.candidate_sha }}`. The next inline step checks native `git rev-parse HEAD` against the candidate; verify the control commit exists and compare committed workflow blobs for all four exact owner paths between candidate and control. Missing objects or changed policy refuse qualification; do not fetch another ref automatically or fall back to the event SHA. Only then may setup/install/product steps proceed. Fixed inline bodies and data bindings are independently pinned by contracts, not a candidate helper.

Give the required product steps exact IDs `runtime`, `typecheck`, `build`, `tests`, `lifecycle`, `rollout`, `foundation`, `artifacts`. Record candidate/control/OS/run ID/attempt and lockfile Git blob before execution. After each compiling/building phase, emit only fixed phase IDs and digests of existing local `dist-test` outputs and, when available, `dist/v2-build.json`/its measured artifacts. Use existing manifest/smoke validation, not hash equality as a replacement for it. Do not reuse a prior phase's artifact identity after the artifact qualifier rebuilds. The final trusted inline step verifies unchanged HEAD/tracked inputs and requires every bound `steps.<id>.outcome` to be `success`. GitHub run metadata plus these bounded log records and existing gate closure output are the evidence locations; no new identity-manifest file/upload is created. A final marker alone never establishes approval.

- [ ] **Step 4: Verify GREEN and document limitations.** Fresh compile; run both new CI test files, the focused existing parser/Foundation assertions and profile tests. Write the runbook with exact inputs, distinct control/candidate revisions, required-check inspection, each phase's evidence location and failed/skipped/cancelled interpretation. GitHub's [workflow SHA context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts) and [manual default-branch requirement](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) support the identity/publication distinction; they do not authorize publication.
- [ ] **Step 5: Commit the exact task paths.** Message: `test: bind V2 qualification to candidate and workflow identity`. Before handoff, run `npm run typecheck`, fresh focused CI/profile checks and `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^CI roles preserve immutable routing and sealed source inventory$" dist-test/tests/ci-lifecycle-gates.test.js`. Review the whole scoped branch. Full `npm test` timing and candidate qualification occur once the known shared failures are causally repaired; record that pending evidence rather than repeating a known-red long suite to finish this scheduling task. Hosted required-check behavior, both OS results and release evidence remain pending until separately authorized execution. No speedup or PROD-ready claim follows from local parser success.

## Acceptance and Execution Handoff

Local implementation acceptance requires all three task deliverables and their focused native tests, preserved profile/seals/upload manifest, a clean scoped commit set and reviewer approval. The CI split's full qualification criteria additionally require actual candidate-bound release results and verified required-check compatibility; those cannot be simulated or silently waived.

The separate [causal-diagnostic plan](2026-10-04-v2-hosted-ci-causal-diagnostics.md) addresses observation, not speculative policy repair. Review this plan before implementation and confirm the preserved Subagent-Driven method. Do not run product commands while this plan is still awaiting review.
