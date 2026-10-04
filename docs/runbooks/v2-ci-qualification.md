# V2 CI qualification operator runbook

V2 release qualification proves one authorized candidate/control pair on Ubuntu and Windows. It does not deploy or activate PROD. Local contract success and green PR feedback do not qualify a release.

## Authorization and publication

Record the operator's authorization for the exact full `candidate_sha` / `approved_workflow_sha` pair, the reviewed four workflow blobs, and the release purpose before dispatch. An input pin records that decision; entering a SHA does not prove approval. Distinct candidate and control commits are supported when their committed workflow blobs match.

GitHub requires the workflow on the default branch before manual dispatch, even when a dispatch selects another ref: [manual workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow). Publishing the reviewed workflow requires separate authority. This runbook does not authorize push, merge, hosted dispatch, branch-protection changes, keys/configuration, live V1 access or PROD activation.

Before separately authorized publication, inspect actual required-check rules. Preserve `Node 24.16.0 on ubuntu-latest`, `Node 24.16.0 on windows-latest`, and `Reject Node 22.22.3`. Verify event/concurrency compatibility against those rules; preserved names alone are insufficient. Any policy change needs its own authority.

## Dispatch identity

The manual owner is `.github/workflows/v2-release-qualification.yml`, with exactly two required string inputs:

| Input | Meaning |
| --- | --- |
| `candidate_sha` | Full 40-hex commit to check out and qualify |
| `approved_workflow_sha` | Full 40-hex separately reviewed workflow control commit |

Select the reviewed control ref for dispatch. Actual control is `github.workflow_sha`, the commit containing the workflow file, while `github.sha` depends on the triggering event: [GitHub context reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts). Fixed environment bindings carry these identities as data.

Before checkout, malformed/whitespace-bearing SHAs or an unapproved actual control refuse. After exact full-history candidate checkout, native Git proves HEAD equals the candidate, the control commit exists, and committed blobs match for `ci.yml`, `v2-release-qualification.yml`, `v2-legacy-regression.yml`, and `sqlite-stress.yml` under `.github/workflows/`. Missing objects or changed policy refuse before setup/install/product execution. There is no automatic fetch or event-SHA fallback.

After Node setup at 24.16.0 and before installation or candidate commands, `Record qualification identity` captures candidate, actual control, matrix OS, run ID, attempt, and the candidate's `package-lock.json` Git blob. Keep the run URL and recorded authorization together.

## Evidence and completion

Both checks, `V2 release qualification on ubuntu-latest` and `V2 release qualification on windows-latest`, must succeed for the same pair. Matrix fail-fast is false; independent release attempts are not automatically superseded.

| Product ID | Existing command | Evidence in that job |
| --- | --- | --- |
| `runtime` | `npm run check:runtime` | Native runtime result, no emitted compilation |
| `typecheck` | `npm run typecheck` | Native noEmit result, no emitted compilation |
| `build` | `npm run build` | Existing measured-build validation, then `Record build identity` |
| `tests` | `npm test` | Complete nonlegacy default profile/native result, then `Record tests identity` |
| `lifecycle` | `npm run test:subproject-2` | Compilation/native gate result, then `Record lifecycle identity` |
| `rollout` | `npm run test:rollout-control-plane` | Compilation/native gate result, then `Record rollout identity` |
| `foundation` | `npm run test:v2-fresh-start-foundation` | Six serial children, lock/process cleanup and closure receipt, then `Record foundation identity` |
| `artifacts` | `npm run test:build-artifacts` | New measured build/all three smokes, then `Record artifacts identity` |

Each recorder emits a bounded `V2_CI_RECEIPT` JSON line in its existing step log and runner-managed step output. It binds the initial identity and fixed phase to deterministic SHA-256 digests of the existing `dist-test` tree, existing `dist/v2-build.json`, deployment generation, and the five fixed measured artifact files. It emits no contents or path inventories. No identity manifest or upload is added.

The fresh-checkout first build may have no `dist-test`; its receipt then records `compiled: null`. Subsequent compiling phases require compiled output. Runtime/typecheck are bound outcomes, not emitting phases. Build success does not imply private migration rehearsal eligibility or introduce a legacy prerequisite.

The artifact qualifier rebuild creates a new deployment generation. Its final receipt must differ from the earlier build and Foundation generations. Do not reuse those earlier receipts as final artifact identity. Digest evidence supplements existing measured-build validators and all existing smokes; hash equality cannot replace them.

`Verify qualification closure` rechecks native HEAD and quiet tracked-input correspondence, binds all six receipts to the same candidate/control/OS/run/attempt/lock identity, compares current outputs against the final artifact receipt, and requires all eight product outcomes and six recorder outcomes to equal `success`. Missing, crossed or stale metadata refuses.

GitHub's step outcome is before continue-on-error and conclusion is after it; missing values are empty and outcomes can be failure/skipped/cancelled: [context reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts). A failed, skipped, cancelled, incomplete or stale required gate does not qualify. A skipped final step after prior failure is not success. Existing explicitly unavailable individual test cases remain visible; an entire required gate may not be skipped. A final marker alone is insufficient: inspect metadata, all required step results, native gate receipts and both successful matrix jobs.

## Pending qualification

Local native synthetic controls establish only the bounded workflow contract. Hosted required-check compatibility, real Ubuntu and Windows results, complete nonlegacy regression, every distinct release qualifier, comparable PR timing and candidate-bound release evidence remain pending until shared causal failures are repaired and execution is separately authorized. Do not repeat the known-red suite to claim this scheduling change fixes it.

Legacy-only regressions stay with the separate manual owner and existing sanitized synthetic artifact. Shared build/nonlegacy failures still block fresh V2. Subsequent relevant changes invalidate affected evidence and require proportionate requalification. Operational keys, actual Codex-host qualification, backup/restore and cutover remain separate readiness work.
