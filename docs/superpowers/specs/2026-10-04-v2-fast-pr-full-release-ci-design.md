# V2 fast PR feedback and full release qualification design

**Status:** Written amendment approved by the human on 2026-10-04 at commit `aac794056c724ef0bf5b1d582794dfd3142b518d`, together with the reconciled remediation specification. The implementation plan remains subject to review; no implementation or hosted execution is approved by this status.

**Outcome:** Stop requiring legacy V1 data-migration replay on every PR or before a fresh-start V2 release, while retaining complete nonlegacy regression coverage and the distinct qualification guarantees required before release. V2 starts empty and does not import, retrieve or fall back to live V1 Markdown data.

This amendment governs CI roles and scheduling in the [hosted CI remediation design](2026-10-04-v2-hosted-ci-remediation-design.md). It replaces that document's requirement to keep workflow structure unchanged, not its refusal policies, diagnostic limits or causal-proof obligations. Faster feedback is an objective, not a measured result or a promise about minutes saved. Scheduling changes do not fix the observed Ubuntu build refusal or Windows nonlegacy failures.

**Installation amendment written specification approved:** The human approved the [written installation-policy A specification](2026-10-04-v2-build-installation-policy-a-design.md) on 2026-10-04. It defines a before/install/after sequence for all four workflow installation owners and three bound release installation outcomes. The [written implementation plan](../plans/2026-10-04-v2-build-installation-policy-a.md) now awaits human review. Only those named installation changes extend this design; roles, triggers, test membership, source seals, baseline/routing guards and all upload permissions stay unchanged. Its implementation still requires written-plan approval; the separate bounded scheduling amendment below does not supply that authority.

## Authority and unchanged boundaries

After human approval of both written documents, prepare an implementation plan for this bounded CI split. Plan review and execution-method selection precede implementation. Preserve the user's Subagent-Driven preference. A causal-diagnostic implementation plan remains a separate slice under the remediation design.

No current approval authorizes workflow/code changes, dependency installation, product builds/tests, hosted dispatch, push, merge, branch-protection changes, new artifact uploads, actual Codex capture, live V1 access, credential/configuration changes or PROD activation. New dispatch workflows require separately authorized publication before hosted use; their presence in a local branch is not publication authority.

Do not delete tests, widen exclusion filters, change the immutable V1 baseline, weaken source/file allowlists or routing/provenance/ownership guards, raise resource limits/timeouts, change the Node support policy or consolidate compiler/build invocations in this first split. Exact CI-role parser ownership may change as specified below; that is not permission to expand protected production-source seals.

## Workflow roles

| Role | Exact owner | Triggers | Required work |
| --- | --- | --- | --- |
| PR feedback | `.github/workflows/ci.yml` | All pull requests, pushes only to verified default branch `main`, manual feedback | Supported-runtime matrix, runtime/typecheck/measured build, immutable baseline/routing guards, existing `npm test`, minimum-runtime rejection |
| V2 release qualification | `.github/workflows/v2-release-qualification.yml` | Manual qualification of an explicit candidate | Complete nonlegacy `npm test` on both supported OSes, runtime/typecheck/measured build, immutable baseline/routing guards, distinct lifecycle/rollout/Foundation/artifact gates |
| Legacy migration regression | `.github/workflows/v2-legacy-regression.yml` | Manual regression only | Existing `test:migration` producer on the supported OS/runtime matrix and the already authorized single synthetic evidence artifact per matrix job |

The release workflow qualifies a candidate; it does not deploy, create tags/branches or activate production. All three roles retain `contents: read` without adding token permissions. Legacy migration results remain regression results, not a prerequisite for fresh-start V2 PROD. No nightly legacy schedule is introduced. Existing `.github/workflows/sqlite-stress.yml`, its weekly schedule, serial matrix and non-cancelling concurrency remain unchanged under this CI-role split. The separately reviewed installation amendment is the sole proposed exception for its dependency-installation commands and gates; stress tests, logging/exit propagation and upload permissions are preserved.

## Complete nonlegacy test profile

PR feedback and release qualification both use the existing `npm test` command and `scripts/run-test-profile.js`. This is the complete default profile, not a newly selected small unit-test list. A separate human-approved bounded scheduling amendment on 2026-10-04 permits only the exact top-level compiled files `qualified-checkpoint-migration.test.js`, `session-end-effective-state-migration.test.js` and `qualified-checkpoint-quick-integrity.test.js` to run first in one native harness with `--test-concurrency=2`. Drain that harness fully before every other selected file runs in a second harness with `--test-concurrency=1`; future files and nested lookalikes remain serial. Omit empty cohorts safely. Keep test compilation, argument refusal, reporter, environment/cwd/spawn controls and exit/signal propagation. A normal failure in either cohort fails the aggregate, with the serial remainder still executed after a normally completed first cohort; signals or spawn errors stop continuation with failure. This scheduling amendment is separate from installation-policy A and does not authorize its implementation. Full-suite and actual workload timing qualification remain pending.

Only these exact root-relative compiled test filenames are excluded:

1. `v1-source-copy.test.js`
2. `v2-migration-package.test.js`
3. `v2-shadow-migration-contracts.test.js`
4. `v2-shadow-migration-runtime.test.js`
5. `v2-shadow-migration-repository.test.js`
6. `v2-shadow-importer.test.js`
7. `v2-imported-event-reader.test.js`
8. `v2-shadow-projection.test.js`
9. `v2-snapshot-parity.test.js`
10. `v2-shadow-compatibility.test.js`
11. `v2-shadow-migration-runner.test.js`
12. `v2-shadow-migration-rehearsal.test.js`

All other discovered tests remain selected, including new nonexcluded tests and shared schema, recovery, lifecycle, integrity and routing tests. Missing excluded files or an empty selection remain errors. A nested file with a similar basename is not excluded. Do not replace exact paths with migration/parity/rehearsal substring filters.

Keep `test:all` unchanged as the available full-repository command. It is not the fresh-start V2 release prerequisite. Keep `test:migration` as the alias of `test:v2-shadow-migration`, with its existing exact 19-file producer list and evidence-integrity checks. Shared files in that producer also remain in the default profile.

Direct exclusions are not zero-dependency isolation: retained tests use common fixtures and the common build still creates private artifacts. Preserve schema upgrades, worker/fresh-start smoke checks, inert-import/refusal checks and source/output integrity even when an owner has a legacy-oriented filename. Such coverage does not require importing live V1 data.

## PR checks and cancellation

Preserve Node `24.16.0` on `ubuntu-latest` and `windows-latest`, matrix `fail-fast: false`, and the Ubuntu Node `22.22.3` rejection. Preserve these exact public check names:

- `Node 24.16.0 on ubuntu-latest`
- `Node 24.16.0 on windows-latest`
- `Reject Node 22.22.3`

Keep checkout history sufficient for the immutable baseline commit and retain the exact existing baseline/routing guard commands. Avoid adding separate PR invocations of lifecycle, rollout, Foundation or artifact qualification stages already represented by default tests; their distinct qualification invocations move to the release role instead of being deleted.

Only superseded runs for the same PR may be cancelled automatically. Concurrency identity must include workflow, event kind and PR number; a different PR, push, manual feedback, release or stress attempt must not be cancelled by that rule. A cancelled attempt is not a passing check.

Actual required-check/branch-protection configuration has not been verified. Preserving names is necessary but does not prove compatibility. Before authorized publication, inspect the required checks and test event/concurrency behavior; do not change branch protection or add path filters that leave required checks pending. If compatibility needs a policy change, obtain its explicit authority rather than treating this amendment as permission.

## Release identity and qualification

Require a full 40-hex `candidate_sha`, validate it without shell interpolation and check out that exact commit. Verify actual checkout HEAD before dependency installation or product execution. A branch name, abbreviated SHA or an input merely echoed into a log is not candidate proof.

Track the approved workflow control revision separately from the checked-out candidate. Workflow dispatch metadata alone does not establish which source was built. Bind qualification to the workflow control revision/bytes, actual candidate HEAD, supported OS/runtime, lock/dependency identity, compiled outputs and gate completion evidence. Reject a mismatched candidate, unapproved workflow control identity, crossed-OS receipt, stale output or incomplete identity. Qualification of an earlier PR head or synthetic merge does not qualify a different release.

Use distinct release check names prefixed `V2 release qualification`; do not reuse PR feedback names or relabel a green PR run as release approval. Both supported OS jobs must finish successfully with `fail-fast: false`. Do not automatically supersede independent release attempts. Failed, skipped, cancelled, incomplete or stale gates cannot qualify a candidate. Existing documented platform-unavailable test cases remain explicit; an entire required gate may not be skipped.

The complete nonlegacy regression command is `npm test`. In addition, retain these existing qualification commands and their unique guarantees:

- `npm run test:subproject-2`
- `npm run test:rollout-control-plane`
- `npm run test:v2-fresh-start-foundation`
- `npm run test:build-artifacts`

Filename overlap with the default suite is not evidence that these invocations are redundant. Keep fresh compilation, measured build/source/output correspondence, Foundation lock ownership, process-tree cleanup, bounded execution and successful closure receipts. Preserve the existing artifact command, including shared/inert/refusal smoke checks; do not classify the whole command as removable V1 data replay.

Use trusted run metadata and existing bounded gate receipts/build checks for identity. Do not add an uploaded identity manifest, raw logs, database bytes, transcripts, credentials or another artifact payload. The implementation plan must specify the exact local evidence locations and verification steps without enlarging external-upload permissions. Any later relevant source/workflow/build change invalidates affected evidence and requires proportionate requalification.

## Legacy regression evidence

Move the existing shadow-migration producer/evidence ownership to the manual legacy workflow. Preserve the literal producer environment variable `V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT` and path `${{ runner.temp }}/v2-shadow-migration-functional/evidence.json`. Do not accept a pre-existing copied receipt or a forged echo in place of the actual producer's validated output.

The only upload remains that single sanitized synthetic `evidence.json`, with name `v2-shadow-migration-functional-synthetic-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}`, `if-no-files-found: error` and `retention-days: 14`. Preserve synthetic classification, producer/consumer correspondence, data sanitization and missing/stale/forged receipt refusal. This is the existing bounded artifact authorization transferred to its exact new owner, not new upload authority.

No real V1 database, Markdown vault, credential or client transcript is an input. Legacy failure is reported and tracked separately; a shared failure also observed in nonlegacy V2 coverage remains a V2 blocker. Do not report legacy failure as fixed because its workflow is no longer a PR/release prerequisite.

## Contract changes and failure handling

Update contracts to recognize these three exact owners and their distinct roles, including explicit grammar for approved dispatch inputs and exact checkout `ref`. `tests/ci-lifecycle-gates.test.ts` currently requires the old unconditional sequence, `test:all` and shadow producer in `ci.yml`; `tests/ci-fresh-start-foundation.test.ts` assumes the shadow gate precedes Foundation there. Rebind Foundation to the release qualification role and complete nonlegacy `npm test`, removing the legacy adjacency requirement. Replace those assumptions with exact role-specific command/step and producer checks, not broad acceptance of arbitrary workflows.

PR contracts must require the complete default profile and all core guards. Release contracts must require the exact candidate/control identity checks and every distinct qualifier. Legacy contracts must require the unchanged producer and bounded synthetic upload; PR/release must not inherit that upload or legacy prerequisite. Missing, duplicate, conditionally bypassed or ignored required steps must fail validation.

Keep strict evidence and protected-source checks. Evidence-owner rebinding replaces the existing migration upload slot; it does not add an upload slot or change the stress upload. Role-specific parser and negative-test changes cover only approved scheduling, candidate identity, gate ownership and evidence-owner rebinding. They do not authorize changing immutable baselines, production isolation, prepared composition edges or sealed production-source/file allowlists. Any such change requires separate approval naming exact affected paths and the reason. Adding a CI-role owner to a parser does not implicitly change those inventories, baseline hashes or public V2 routing.

After its own written-spec and plan approval, the installation amendment additionally permits exact parser/test ownership for the before/install/after grammar and bound installation outcomes. It adds no uploaded evidence or source-seal exception. Existing candidate/control and initial-identity checks must remain before installation, with all original product/recorder checks retained at release closure.

All refusals retain their original result, error and exit status. Reporting/cancellation must not conceal failure or claim completion. Existing diagnostic caps and sanitization from the remediation design are unchanged. If role separation exposes an unanticipated trust, acceptance or upload requirement, stop for a concrete amendment rather than weakening a guard to make CI green.

## Verification and completion criteria

The future implementation plan must cover positive fixtures for all three roles and negative fixtures for omitted/duplicated/conditional/ignored gates, exclusion widening, newly discovered test omission, malformed or wrong candidate SHA, unapproved control identity, crossed/stale receipts, forged artifact production, extra/glob uploads and missing artifact errors. Test PR-only cancellation and non-cancellation of other roles/events without starting unauthorized hosted runs.

Use focused contract/profile verification first, then the reviewed local synthetic checks. Hosted execution requires its own authority. Measure the PR profile after implementation under a recorded candidate/runtime/OS and comparable environment; report observed duration, failures and skips rather than projecting old full-suite totals into a guaranteed speedup.

This split is accepted only when exact role ownership, preserved profile coverage, guard/evidence negative controls, stable-check compatibility and candidate-bound full V2 qualification are established. No incomplete release gate becomes optional. Track causal dispositions for legacy-only failures separately without blocking an otherwise qualified fresh-start V2 release; shared build or nonlegacy failures still block it.

Green CI is not whole-system PROD readiness. Operational key handling, public V2 workflows, actual Codex-host qualification, backup/restore of new V2 data and separately authorized cutover remain governed by the [delivery roadmap](../plans/2026-09-29-v2-fresh-start-delivery-roadmap.md).

## References

- [Hosted CI remediation design](2026-10-04-v2-hosted-ci-remediation-design.md).
- [Fresh-start production design](2026-09-29-v2-fresh-start-production-design.md).
- Source contract owners: `scripts/run-test-profile.js`, `tests/test-profiles.test.ts`, `tests/ci-lifecycle-gates.test.ts`, `tests/ci-fresh-start-foundation.test.ts`, `scripts/run-v2-fresh-start-foundation.js` and `package.json`.
- GitHub documents [manual dispatch and default-branch availability](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow), [workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) and [skipped required checks](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs).

Next action is implementation planning from this approved amendment and the reconciled remediation specification. Plan review and execution-method confirmation precede code changes; publication and production activation require separate authority.
