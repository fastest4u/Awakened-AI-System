# V2 CI causal evidence and repair handoff

This handoff records a locally verified diagnostic capability and unresolved causal dispositions. It does not establish a hosted repair, Ubuntu equivalence, whole-system qualification, or PROD readiness. The approved observation plan permits owned synthetic controls and local commits; it does not authorize arbitrary red-test fixes, installation changes, push, merge, hosted dispatch, keys, live V1 input, or cutover.

## Identity and source correspondence

The historical failure is [run 37142753116](https://github.com/fastest4u/Awakened-AI-System/actions/runs/37142753116), testing merge `091860f5731602e1a552027006dbe21c1701f00f` from head `b69b4d2be4e424ca37bcb8f8b75a3a8cfc88d377` and base `2836eda4ce3f4808c811d6abea98e196f708cb1a`. Ubuntu Node 24.16.0 failed build with `REHEARSAL_BUILD_INVALID`; Windows Node 24.16.0 built successfully but reported 3,798 tests, 3,621 passes, 164 failures and 13 skips. Ubuntu Node 22.22.3 passed minimum-runtime rejection. Both supported-runtime jobs skipped downstream gates; skipped gates supply no qualification evidence.

Local preparation HEAD for this task is `31610954ff41d8a628544837e5def049989581cf` on `codex/v2-fresh-start`. It is the starting candidate identity, not a self-referential final qualification identity or a claim of review approval. Human approved local execution of both written plans at `0f6baa493cca94b6f393e23ef3b5ceec51b379da`. Source correspondence at that approval HEAD proved the ten scoped blobs equal to the original head:

- `scripts/build.js`, `scripts/run-v2-shadow-migration-rehearsal.js`, and `tests/v2-shadow-migration-rehearsal.test.ts`;
- coordinator, manifest, integrity, fresh-admission and directory-durability test owners;
- `tests/support/fresh-start-fixture.ts` and `tests/support/canonical-temp.ts`.

The historical merge object is unavailable locally. Head correspondence does not prove merge correspondence. Subsequent Task 1 commits `7ff5b4f9d4eb8d1bcbb83cd6257f1c583e0595e9` and `bddafb8788afb119b0b844bf17a6bf11be6af0ff` added bounded reader observations and isolated diagnostic metadata coercion. Task 2 commit `14d62d9b8cac35c59624ba2639c128d7f9bb526c` added explicit owned snapshots, named-owner placement and bounded cleanup controls. These modifications preserve the observed guards; they do not make the old source line a proven reproducer of the missing merge. The full source-correspondence and task reports remain the execution evidence, rather than a claim that later candidate bytes are identical to the original ten blobs.

## Record disposition contract

`classifyEvidence` is exported only from `tests/support/ci-path-diagnostics.ts`, consumed by the two diagnostic test owners:

```ts
classifyEvidence({
  record: unknown,
  collectorIncomplete: boolean,
  operationCode: string,
  expectedCode: string,
  cleanupComplete: boolean,
  location: "guard" | "snapshot" | "later-read",
}): "exact-refusal" | "snapshot-only" | "incomplete"
```

The trusted named test caller supplies location, the fixed expected code, the preserved primary operation code and verified cleanup receipt. None comes from user input, the diagnostic record, or a later filesystem lookup. The classifier cannot independently certify that those caller observations are true. It returns a disposition, never eligibility or a production passing predicate.

The actual Task 1 collector validates the unknown record and supplies a sanitized serialized copy before the classifier accesses fields. There is no second field whitelist, cap implementation or accessor exposure. Closed data descriptors, fixed enums, exact keys, allowlisted recipe IDs, boundary+case uniqueness, 16 records per probe and 2 KiB per record remain authoritative. A caller must pass the original collector's incomplete latch, since one record cannot reveal a prior overflow, duplicate, writer failure or missing record. Raw paths, usernames, path hashes, environment values, identity numbers, contents, credentials and arbitrary exception messages/stacks never enter diagnostic JSON.

`exact-refusal` requires an actual guard-bound build observation, matching primary refusal, complete required branch evidence and complete cleanup. `snapshot-only` preserves a complete snapshot or later-read label; it never upgrades to the earlier guard. A path record is structurally a parent snapshot even if the caller supplies location `guard`. Invalid/absent/capped evidence, unavailable required fields, unknown filesystem codes, mismatched primary errors and uncertain closure are `incomplete`. A descriptor-close error cannot substitute for the original refusal.

Unknown values are interpreted against the actual emission branch, not as true:

| Actual build boundary and reason | Sufficient branch facts; deliberately unconsulted fields |
| --- | --- |
| recipe-path / path | Fixed actual refusal branch; all predicates/counts unknown. This does not distinguish syntax, symlink or unequal canonical spelling. That subcondition still requires observation before choosing a repair. |
| descriptor-before / non-regular | regular=false; singleLink and withinSizeLimit unknown; captured counts present. |
| descriptor-before / link-count | regular=true, singleLink=false; withinSizeLimit unknown; captured counts present. |
| descriptor-before / size | regular=true, singleLink=true, withinSizeLimit=false; captured counts present. |
| read / short-read | Three before predicates true and captured counts present; the actual zero-read branch is the refusal observation. Identity/time fields remain unknown. |
| descriptor-after / non-regular or link-count | Selected stat fails the type/link branch; selected comparisons stay unknown. A completed descriptor may supply descriptorEqual=true for the later leaf branch. withinSizeLimit remains unknown because it is not rechecked. |
| descriptor-after / identity-change | Selected identity, size, mtime, ctime have a true prefix, first false, then unknown suffix. A leaf observation requires completed descriptor equality. A descriptor timestamp refusal can leave pathEqual unknown. |
| filesystem | All predicates/counts unknown; actual boundary/operation and recognized primary error required. The permitted operations are lstat/realpath at recipe-path, open/fstat before, read at read, and fstat/lstat after. Close remains a cleanup substitute. |

An unavailable required predicate is different from a deliberately unconsulted one. Metadata construction failure can preserve the refusal while emitting no record; that absence is incomplete. No healthy recipe-prefix telemetry is inferred: reader records occur only at existing refusals, so preceding successful recipes do not exhaust the collector.

Native Windows directory open preserved its original `EISDIR` outcome in default and observed reads; serialization is `unknown` because that code is outside the fixed enum. Its causal record therefore remains incomplete despite native error preservation. The owned captured-before nonregular fault is a separate synthetic guard control. Native file-symlink creation returned EPERM and remains unavailable. Native parent junction and extra-hardlink controls ran. Byte-copy fixtures lose installed hardlink topology and cannot establish the Ubuntu executable installation shape or the original rejecting recipe.

## Ten historical failure-family dispositions

Counts are failure records, not ten established root causes or 164 independent defects. Each row stays separate until evidence connects it. Current local business reachability does not prove the old hosted refusal was fixed.

| Failure family / records | Actual local reason or evidence disposition | One-condition control and intended business reachability | Handoff |
| --- | --- | --- | --- |
| Projection paths / 104 | Coordinator precreation lstat/ENOENT snapshot: directory/native/canonical facts unavailable downstream of the failed stat. Integrity setup has the same precreation observation. Neither is the actual product refusal. | Raw and native spellings both reach real capture with spelling equality=true. Lexical-invalid inputs and native junctions refuse `PROJECTION_PATH_INVALID`; replacement after authorization also refuses. Coordinator staged adoption and integrity frozen replay assertions passed. | Hosted rejecting condition remains unknown; no 8.3 cause established. Actual coordinator, capture and child-local branches require the private amendment below. |
| Manifest / 28 | Pre-publication parent snapshot has lexical/stat/native/directory/canonical=true, symlink=false; snapshot-only. | Canonical publication business assertion passed. Native hostile alias and replacement controls ran and retained refusal; canonicalEqual=true after replacement does not grant authorization. | Actual hosted publication/child refusal remains unobserved; no fixture rewrite justified. |
| Fresh admission / 9 | dirname(PRAGMA file) is a parent-derived directory snapshot; PRAGMA file is a database-file snapshot with directory=false. Both derive from one returned spelling. | Named valid parent backend dispatch reached generation 1. No changed raw-root spelling control established a causal defect; original raw root is unexposed. | These are not original-root or child receipts. Early setup failure and child-local cause remain unavailable; preserve route/identity guards and trace the exact owner before an amendment. |
| Durable directory / 2 | Canonical parent snapshot and lexical descendant containment observed; walkReachedBase remains unknown. | Actual owned descendant creation reached its parent callback; sibling escape refused `DIRECTORY_OUTSIDE_DURABLE_BASE` before creation. Named full-parent-chain assertion passed. | No actual hosted parent-walk refusal or native fsync closure proof from the callback representative; obtain actual branch evidence. |
| Source state / 5 | No exact family refusal observation collected; incomplete. | No family-bound one-condition replay performed; original hosted business assertion reachability remains unknown. | Prepare a separate narrow source-state observation plan; do not infer the projection cause. |
| Foundation entry / 5 | No exact entry refusal observation collected; incomplete. | No family-bound one-condition replay performed; reachability unknown. | Trace exact entry boundary and ownership in its own scoped plan; do not infer a canonical fixture repair. |
| Rehearsal / 5 | Hosted family cause unresolved. The local exact late Zod mutation expected `REHEARSAL_BUILD_INVALID` but actually refused with `FRESH_START_BUILD_MISMATCH`; original-owner baseline confirms the same RED. | Native changed-file, executable finalization and late native-load manifest controls passed. Exact Zod baseline mutation refused and left eligibility=false, but its intended error matcher remained unreachable. | Preserve the unresolved legacy expectation; this observation task does not change the expected error. Shared build/provenance failures still block V2. |
| Migration/integrity registry / 4 | No exact registry refusal record collected; incomplete. | No family-bound one-condition replay performed; reachability unknown. | Map exact failing filenames and owners, then separately observe; schema/recovery/shared registry failures remain V2 blockers. |
| Retrieval-evaluation wrapper / 1 | Wrapper failure is observed historically; exact inner cause and primary preservation unobserved. | No wrapper-specific one-condition replay performed; reachability unknown. | Preserve wrapper/inner error distinction and required closure; do not mark it fixed by neighboring diagnostics. |
| Shadow runner / 1 | No exact runner-local refusal observation collected; incomplete. | No runner-specific one-condition replay performed; reachability unknown. | Map its exact legacy owner and process-tree receipt before observation; scheduling does not fix its cause. |

The exact locally baseline-confirmed unresolved test is `late byte change to node_modules/zod/v3/types.js refuses manifest publication` in `tests/v2-shadow-migration-rehearsal.test.ts`. The replay restored original owners from Task 1 BASE `4e097ec359b804c20c6e0e55834232a75687becb`, selected one case, exited 1 and confirmed the mismatch. Its runnable failing harness was removed; source remains in the ignored Task 1 report directory. The broader affected matrix was 44 tests, 42 passes and two failures (that child and its parent), rather than a green result.

The manual legacy profile exclusion is by exact compiled filename, not a failure-family exemption: `v1-source-copy.test.js`, `v2-migration-package.test.js`, `v2-shadow-migration-contracts.test.js`, `v2-shadow-migration-runtime.test.js`, `v2-shadow-migration-repository.test.js`, `v2-shadow-importer.test.js`, `v2-imported-event-reader.test.js`, `v2-shadow-projection.test.js`, `v2-snapshot-parity.test.js`, `v2-shadow-compatibility.test.js`, `v2-shadow-migration-runner.test.js`, and `v2-shadow-migration-rehearsal.test.js`. In particular, the Zod expectation has that exact legacy owner. Unmapped historical records cannot be declared legacy merely from their family label. Shared and nonlegacy failures remain V2 qualification blockers despite manual legacy scheduling.

## Cleanup and private residue handoff

Current corrected diagnostic controls verified their owned root identity, link type, exact unlink targets, descriptor/SQLite closure and restoration of hooks. Native junction and replacement sentinels survived refusal; final roots were removed. This is evidence for those sequential controls, not universal concurrent cleanup safety. Test/compile processes exited; it is not a receipt for every original fixture or a child process tree.

The coordinator named owner has after-acquisition closure evidence. Integrity closes its setup connection before publication, but original afterEach closes are attempts with swallowed errors. Fresh admission's successful run closed the parent backend and ran fixture cleanup; an early acquisition failure can lack receipts, and a rejected backend close can prevent later cleanup. Original recursive root hooks are not replacement-safe proof. Any failed probe lacking required closure stays incomplete.

Two initial uncorrected Task 2 RED residues remain intentionally retained because their original captured ownership identities are lost. Root performed only native, nonrecursive read-only inspection: `C:/Users/Server/AppData/Local/Temp/ci-path-owned-1CUnQc/sentinel` and `C:/Users/Server/AppData/Local/Temp/ci-path-owned-Bc6gaE/alias`, a junction targeting the former root. These private local handoff paths are prose only and never diagnostic JSON. No guessed prefix deletion, later canonical redirection or junction traversal is authorized. No material residue was deleted. The earlier sandbox attempt's empty-root cleanup remains unverified; corrected controls add captured-identity cleanup for future setup failures without retroactively proving that attempt.

## Smallest next plan and required amendment

There is no established hosted producer defect from these observations, so the next step is bounded evidence collection, not speculative repair. Preserve the local failing/hostile controls and request precise hosted probe authority for the missing Ubuntu installed recipe topology and actual Windows candidate refusal. Bind any authorized probe to the actual head/base/merge, workflow bytes, supported runtime, lock/dependency identity, OS and resulting records/cleanup. Do not install, unlink or rewrite dependencies to simulate acceptance. If legitimate topology conflicts with the existing single-link policy, return for the concrete provenance/alias/finalization acceptance amendment required by the approved spec.

Windows parent snapshots cannot choose a fixture canonicalization repair. A concrete private-observation amendment must identify exact sealed paths and channels before editing:

1. `src/orchestrator/projections/stable-directory.ts`: observe the captured lexical checks, type/link/native-canonical checks in `captureProjectionDirectoryIdentity`, and the embedded `MUTATION_SCRIPT`'s `assertDirectory` type/canonical/identity branches. Child-local facts must come from that actual child branch. Keep `PROJECTION_PATH_INVALID`, every predicate and the child stdout/stderr protocol unchanged.
2. `src/orchestrator/projections/coordinator.ts`: observe the actual `#assertProjectionDirectorySafe`/`#ensureProjectionDirectory` inspection and parent/type/canonical/identity branches before the unchanged rejection, including the independent V2 paths. An injected parent inspection cannot substitute for stable mutation or route admission.
3. `src/orchestrator/identity/directory-durability.ts`: observe the actual relative-absolute/parent-escape refusal and parent-walk root refusal, and a reached-base receipt only from the completed actual walk. Keep native descriptor/close behavior and callback semantics unchanged.

These are sealed owners; this task grants no edits to them and no source-seal inventory expansion. The amendment must name a dedicated trusted synthetic private channel, activation boundary, exact fixed reason schema, resource ownership and closure receipt. It must explicitly resolve child delivery without placing diagnostics in existing protocol streams or inventing artifact transport. No channel or protocol change is currently authorized. Fresh route admission first requires a narrow read-only trace to the actual existing guard owner; do not invent an owner from the PRAGMA-derived parent role. Unprobed source-state, foundation, registry and wrapper/runner families likewise require distinct scoped observation plans.

Once actual refusal plus a one-condition variation demonstrates the business assertion becoming reachable, propose the smallest reviewed repair at the proven producer/fixture/implementation boundary, retaining the failure and hostile controls. A changed acceptance policy, new trusted producer, private source/channel change or newly scoped repair requires its concrete amendment/plan before implementation.

## Focused verification and qualification boundary

Compile the complete test tsconfig with native exit 0 and fully drain the compiler before each named group. The approved groups are `^CI build diagnostics` in `dist-test/tests/ci-build-diagnostics.test.js` and `^CI path diagnostics` in `dist-test/tests/ci-path-diagnostics.test.js`, native Node `--test --test-concurrency=1 --test-reporter=spec`. Their existing hardlink, nonregular, symlink/junction, truncation, mutation, replacement, durable escape, closed-schema, cap, reporter and cleanup controls provide the relevant hostile coverage. They do not justify rerunning the complete known-red suite, building all artifacts or expanding package/profile guard scope during this observation task.

Before later full qualification, freeze the final candidate and bind exact head, base, merge, workflow, lock/dependency, compiled output and gate identities. Both supported Ubuntu and Windows must receive separately authorized complete nonlegacy/release qualification. Minimum-runtime rejection, skipped gates, local head-only controls, legacy scheduling and successful diagnostic collection do not substitute for that proof. Operational keys, selected-host qualification, backup/restore, release proof and cutover remain separately governed; PROD is still unverified.

References: [approved remediation design](../superpowers/specs/2026-10-04-v2-hosted-ci-remediation-design.md), [CI role amendment](../superpowers/specs/2026-10-04-v2-fast-pr-full-release-ci-design.md), and [approved causal observation plan](../superpowers/plans/2026-10-04-v2-hosted-ci-causal-diagnostics.md).
