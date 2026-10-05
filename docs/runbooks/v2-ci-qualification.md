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

## Installation policy A

All four workflow roles use this exact ordered installation sequence from their checked-out candidate:

```text
node scripts/check-build-installation.js before
npm ci --ignore-scripts --include=dev --include=optional
node scripts/check-build-installation.js after
```

The flags apply to that install command only. The policy checks the committed registry lock and setup inventory before npm; capability checks required installed packages, the admitted pinned native esbuild executable, bounded version invocation and positive child closure afterward. Build repeats capability before importing third-party tools and preserves incomplete manifests on refusal. Normal later `prebuild`/`pretest` runtime checks remain active. Do not change persistent npm settings, repair vendor bytes, upgrade the lock, widen limits or retry a refused capability/Build into success.

For an isolated installer comparison, create a new positively owned canonical nonsymlink temporary checkout of the exact candidate with independent source objects (`git clone --no-hardlinks`, no alternates). Capture directory identities with `lstat` and `bigint: true` at creation, verify containment before npm can remove `node_modules`, and require complete clean tracked correspondence before installation. Check native exits immediately and inspect checkout errors/status: Git exit zero alone did not guarantee complete source in the Windows checkpoint below. Leave uncertain roots intact. Never reinstall shared checkout dependencies to establish this proof.

Bind cross-platform source to the exact committed lock Git blob and each platform's actual raw checkout bytes. Windows CRLF and Linux LF checkouts can have different raw SHA-256 values while retaining the same committed lock; prove any claimed relation from actual bytes in memory, without rewriting files or weakening product guards. A raw Windows checkout hash is not a universal Linux source precondition.

## Evidence and completion

Both checks, `V2 release qualification on ubuntu-latest` and `V2 release qualification on windows-latest`, must succeed for the same pair. Matrix fail-fast is false; independent release attempts are not automatically superseded.

| Product ID | Existing command | Evidence in that job |
| --- | --- | --- |
| `installation_policy` | `node scripts/check-build-installation.js before` | Actual same-job policy result before install, bound to the recorded candidate/lock |
| `installation` | `npm ci --ignore-scripts --include=dev --include=optional` | Actual same-job fresh installation result with command-scoped flags |
| `installation_capability` | `node scripts/check-build-installation.js after` | Actual same-job pinned native usability and positive owned-child closure |
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

`Verify qualification closure` rechecks native HEAD and quiet tracked-input correspondence, binds all six receipts to the same candidate/control/OS/run/attempt/lock identity, compares current outputs against the final artifact receipt, and requires all eleven outcomes (three installation and eight existing product outcomes) and six recorder outcomes to equal `success`. Installation results are required actual outcomes, not inferred from synthetic recorder controls or earlier jobs. Missing, crossed or stale metadata refuses.

GitHub's step outcome is before continue-on-error and conclusion is after it; missing values are empty and outcomes can be failure/skipped/cancelled: [context reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts). A failed, skipped, cancelled, incomplete or stale required gate does not qualify. A skipped final step after prior failure is not success. Existing explicitly unavailable individual test cases remain visible; an entire required gate may not be skipped. A final marker alone is insufficient: inspect metadata, all required step results, native gate receipts and both successful matrix jobs.

## Local installation checkpoint

The 2026-10-05 local Windows checkpoint used frozen source `6adefa19c1002c6ebe42438443b7c5b82db614c1`, lock SHA-256 `307e5857f8803f7bdc9ba4bacc1f3a11840291d23852d49e4d3bc14fb8d08006`, Node 24.16.0 and npm 11.13.0 on Windows 11 Pro x64. The first actual before/install/after/guarded Build each exited zero in a fresh independent owned candidate checkout; the original admitted native executable retained its independently pinned digest and single-link identity. Fresh focused controls reported 16 tests, 15 pass, zero fail and one explicit unavailable native-file-symlink skip. Those copied fixtures establish refusal controls, not the original installation's topology.

The first longer temporary checkout had four tracked path-length failures despite Git exit zero and was retained. One bounded new short checkout completed all 815 tracked paths cleanly before install. Its candidate directory identity was captured exactly; its parent's initial numeric inode exceeded safe-integer precision, so precise original parent closure remains unproven and both roots remain intact. A reporting-only BigInt serialization failure and the failed precise-parent comparison are excluded diagnostic failures, not installer passes. npm reported nine untriaged dependency vulnerabilities (three moderate, six high); no audit repair or dependency change was performed.

After separate local Docker/image authorization, the actual Linux comparison used the same frozen source and lock Git blob `e438dd0d9b251ec5d6a4f9b4b59b529b1811eaea`, Node 24.16.0/npm 11.13.0, and official Linux/amd64 image `docker.io/library/node@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7`. One original read-only self-contained Git bundle fed two independent Linux-owned checkouts, each with all 815 tracked files and exact BigInt directory ownership captured before installation. Only the bundle file was mounted; the container ran as uid1000 without privilege, host network or daemon/source/dependency mounts.

Ordinary `npm ci` exited zero, but its original selected `node_modules/@esbuild/linux-x64/bin/esbuild` had `nlink=2`; the existing guarded reader exited one with `REHEARSAL_BUILD_INVALID`, reason `link-count` at `descriptor-before`. The candidate's first actual before/install/after/guarded Build each exited zero; its original native file had `nlink=1`, 11427952 bytes and independent pinned SHA-256 `e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100`. No alias enumeration, vendor repair or product retry established these observations. Linux focused controls had 16 tests, 16 pass, zero fail and zero skip; the earlier Windows symlink skip remains visible.

Linux raw lock SHA-256 was `282930978cb1112f0289c6461665222ef43baad36ae1a15ae926dc6a33a273c9` (106059 bytes, LF), exactly the frozen Git blob's bytes. Windows raw lock was 109144 bytes with CRLF; in-memory CRLF-to-LF conversion exactly matched the actual Linux/Git bytes. The first Linux container stopped before any product command because the setup assertion incorrectly used the Windows raw hash. It remains retained with exit one. A separately authorized new source setup bound the proven Linux bytes to the immutable Git blob; no files/configuration/product guards changed.

Actual Linux Build emitted five fresh-start artifacts with deployment `151652e1-89c3-4347-86fe-b4e1f69b0e52` and build identity `a99007a8c44c6936794ad27e01d0fe3d565155a99448bcaa5da1b4b2c164f0ae`; the private manifest was eligible at the frozen source with three artifacts, 124 inputs and 13 recipes. Original native/owned directory identities, both Git indices/clean HEADs, lock and manifests remained unchanged through focused proof. The retained proof container `04f7b49c65c4d8fab4b73502d3d9a24833075c9b288d81651335b61d3fc800d0` closed with exit zero, Running false and PID zero; its roots are `/tmp/t5a-1TYYCm/c` and `/tmp/t5a-1TYYCm/a`. All 38 owned child phases positively closed, including the observed ordinary-reader exit one; that refusal is not relabelled success.

The detailed `.superpowers/sdd/2026-10-04-v2-build-installation-policy-a/task-5-report.md` is an ignored **local-only checkpoint**, not a published repository or CI artifact. Use project-memory MCP-managed ADRs, mistakes and session logs for durable high-level handoff; no new evidence upload is authorized. The same-container Linux candidate reused the ordinary install's npm cache, so npm's reported 21-second/10-second install times establish no guaranteed CI speedup. npm's nine warnings remain untriaged; the displayed newer-npm notice did not authorize an upgrade.

## Pending qualification

Task 5 remains incomplete despite the verified local Windows and Linux installation/capability/guarded-Build checkpoints. Final complete nonlegacy and every distinct release qualification on both OSes remain missing; exact frozen proof source is `6adefa19c1002c6ebe42438443b7c5b82db614c1`, separate from later documentation commits. No hosted dispatch, push, merge or PROD activation occurred.

Hosted required-check compatibility, real Ubuntu and Windows workflow results, complete nonlegacy regression, every distinct release qualifier, comparable PR timing and candidate-bound release evidence remain pending until shared causal failures are repaired and execution is separately authorized. Existing Windows hosted 159 failures are not resolved by this installer slice. Focused affected proof precedes final qualification; do not repeat the unchanged known-red full suite to claim this scheduling or installation change fixes it.

Legacy-only regressions stay with the separate manual owner and existing sanitized synthetic artifact. Shared build/nonlegacy failures still block fresh V2. Subsequent relevant changes invalidate affected evidence and require proportionate requalification. All nine actual desktop host proofs, F2 public content/privacy, F3 operational keys/recovery/backup/restore/production evidence and F4 archive/cutover work remain separate readiness work.
