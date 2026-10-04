# V2 hosted CI remediation design

**Status:** Written specification approved by the human on 2026-10-04 at commit `aac794056c724ef0bf5b1d582794dfd3142b518d`, together with the [fast PR and full V2 release CI amendment](2026-10-04-v2-fast-pr-full-release-ci-design.md). Implementation plans remain subject to review; this status does not approve their execution.

**Outcome:** Close the hosted CI failures before continuing operational key handling and public V2 workflows. Establish the rejecting conditions, repair their proven causes without weakening existing contracts, and qualify the final candidate on Ubuntu and Windows.

This is a CI remediation slice, not a declaration that the whole system is production ready. V2 still starts empty, without importing, retrieving or falling back to live V1 Markdown data.

**Installation amendment:** The human approved the [written installation-policy A specification](2026-10-04-v2-build-installation-policy-a-design.md) on 2026-10-04. Its [implementation plan](../plans/2026-10-04-v2-build-installation-policy-a.md) awaits review. The named script-disabled installation producer, capability proof and exact workflow/recipe owners preserve every single-link/refusal rule and do not admit aliases or vendor-file repair. Written-spec approval permits planning only; prior diagnostic authority does not authorize executing the new producer.

## Authority and exclusions

Conversational approval permits writing, reviewing and locally committing this specification. Approval of the written specification will permit preparing an executable implementation plan, not running it. Plan review and execution-method selection must precede product changes or diagnostic execution. Preserve the user's Subagent-Driven preference for that later execution.

No current approval authorizes dependency installation, product builds or tests, hosted CI dispatch, push, merge, live data access, actual Codex capture, credential/configuration changes or PROD activation. The execution plan must distinguish local synthetic work from separately authorized hosted actions. A failed diagnostic does not authorize a broader retry or workaround.

Do not delete tests, waive required coverage, increase existing limits/timeouts, change the immutable V1 baseline, expand protected source/file allowlists, alter the Node support policy, or introduce new public V2 features. Workflow roles, triggers and qualification ownership are governed by the linked CI amendment; diagnostic-artifact permissions remain unchanged. Existing synthetic migration regressions remain regressions under their separate manual owner, not a fresh-start V2 release prerequisite. Shared and nonlegacy failures still block V2 qualification.

## Observed failures and source identity

The failure baseline is [CI run 37142753116](https://github.com/fastest4u/Awakened-AI-System/actions/runs/37142753116). Its matrix checked synthetic merge `091860f5731602e1a552027006dbe21c1701f00f`, combining head `b69b4d2be4e424ca37bcb8f8b75a3a8cfc88d377` and base `2836eda4ce3f4808c811d6abea98e196f708cb1a`.

| Job | Observed result | Boundary still needing proof |
| --- | --- | --- |
| Ubuntu, Node 24.16.0 | Build failed with `REHEARSAL_BUILD_INVALID` | Exact recipe file and rejecting predicate |
| Windows, Node 24.16.0 | Build passed; tests failed | Actual rejecting conditions by test family |
| Ubuntu, Node 22.22.3 | Minimum-runtime rejection passed | No failure observed in this job |

Both supported-runtime jobs skipped downstream gates. Their skipped gates are not successful qualifications. Earlier local private F2-A acceptance applies to its recorded identity, not automatically to this synthetic merge or a later release.

The Windows footer contains 3,798 tests: 3,621 passed, 164 failed, 13 skipped and zero cancelled. The 164 failure records group into 104 projection-path refusals, 28 manifest failures, nine fresh-admission failures, two durable-directory failures, five source-state failures, five foundation-entry failures, five rehearsal failures, four migration/integrity registry failures, one retrieval-evaluation wrapper failure and one shadow-runner failure. These are failure records, not 164 established independent defects.

Local source inspection is bound to head `b69b4d2be4e424ca37bcb8f8b75a3a8cfc88d377`. Before using a source line or fixture as a CI reproducer, establish its correspondence to the recorded merge. Do not infer a regression from a changed file, an environment cause from an unchanged file, or a previously green baseline without inspecting its evidence.

## Components and observation boundaries

### Ubuntu recipe measurement

`scripts/build.js` measures the trusted recipe list before bundling. The reader in `scripts/run-v2-shadow-migration-rehearsal.js` rejects a non-regular file, a link count other than one, or an oversized file at its first descriptor check. It later checks descriptor and pathname identity, size and timestamps. The existing stack reaches the first check but identifies neither the file nor the failed predicate.

Add bounded observation at this existing measurement boundary, with build-specific reporting owned by `scripts/build.js`. Keep the normal refusal and operational-command error unchanged. Use the descriptor/leaf observations already captured by the check; do not reopen a path, reread source bytes, reorder guards or retry a refusal to collect diagnostics. Report the existing allowlisted recipe identifier, failing phase and predicate outcomes; never accept a file because its diagnostic observation looks legitimate.

The installed esbuild source contains a non-Windows optimization that links the native executable and renames its CLI alias. This supports a hardlink hypothesis, not proof of the failed runner's topology. The existing `tests/v2-shadow-migration-rehearsal.test.ts` fixture copies file bytes and loses link relationships. A later owned synthetic reproducer must retain the relevant topology rather than treating that copy as installation proof.

Later evidence is recorded separately in the installation-policy amendment: run `37203356089` at the published `11ba91ec1a6840cea6e961b4c3789d32f9623b9d` head observed the Ubuntu native recipe refused for actual link count 2. That observation does not identify the other alias or prove a successful installation repair. The historical run/source identities above retain their original meaning.

This specification does not authorize accepting executable hardlinks or changing `nlink` checks. If proof identifies a legitimate producer topology that cannot be repaired while preserving the current contract, stop for a concrete design amendment. Such an amendment must address trusted installation provenance, every admitted alias, hostile additional aliases, and the identity of the executable actually launched through finalization. Preserve the native resolved location, exact bytes, executable usability, dependency metadata and ownership. Unlinking or rewriting an installed/shared dependency is not implicitly authorized. Equal bytes or a familiar pathname are insufficient.

### Windows paths and synthetic fixtures

`captureProjectionDirectoryIdentity` in `src/orchestrator/projections/stable-directory.ts` combines lexical absolute/normalized/resolved checks with directory type, symlink rejection and native canonical-path equality. Coordinator inspection, the stable mutation child, store-route admission and durable-directory containment also have independent boundaries. One successful injected inspection cannot replace the others.

Use a shared synthetic diagnostic helper beside `tests/support/canonical-temp.ts`. Observe one representative case per failing family immediately before the actual production boundary. Start with projection coordinator, manifest and integrity tests; investigate fresh admission through `tests/support/fresh-start-fixture.ts` and `tests/fresh-start-admission.test.ts`, and durable containment through `tests/directory-durability.test.ts`. Keep source-state, foundation-entry, rehearsal, registry and wrapper failures separate until evidence connects them.

The existing canonical temporary-directory helper returns `resolve(realpathSync.native(rawDirectory))`; several failing-family fixtures use raw temporary paths. Some foundation/rehearsal fixtures use non-native realpath while others use native realpath. These are candidate comparisons only. Do not assume an 8.3 alias, manufacture one as evidence of the reported failure, or rewrite every fixture before proving the rejecting condition.

A pre-boundary snapshot identifies candidate conditions, not necessarily the exact production rejection. If ambiguity remains, attach a private fixed reason at the actual rejection site in the smallest relevant owner. Keep the public error code, acceptance predicates and refusal result identical. Observe child-local refusal where applicable; parent-only measurements cannot prove the child's boundary.

## Diagnostic data and error handling

Diagnostics are informational, never authority. They are restricted to trusted build measurement or explicitly owned synthetic fixtures and are absent from model-visible V2 tool results and actual client-content capture. Use a dedicated bounded diagnostic channel, separate from operational/protocol stdout; never serialize an error object or its causes. The execution plan must identify that channel and its trusted activation boundary.

| Record | Allowed information |
| --- | --- |
| Common | Fixed schema version, boundary/phase/family identifiers, platform, fixed outcome or reason enum |
| Build | Allowlisted recipe identifier; regular-file/single-link/size-limit booleans; decimal strings for link count, size and existing limit; descriptor/path identity and timestamp equality booleans |
| Projection or route | Absolute/normalized/resolved booleans; stat and native-realpath success; directory/symlink/canonical-equality booleans; fixed route/layout/authority check outcomes |
| Durable directory | Relative-path absolute/parent-escape booleans and whether the parent walk reached the bound base |
| Filesystem failure | Recognized operation and error-code enums, with a fixed unknown category |

Do not emit raw absolute paths, usernames, path hashes, environment values, raw inode/device numbers, file or database contents, manifests, transcripts, credentials, arbitrary exception messages or stacks. Known alias comparisons report equality outcomes for fixed roles, not arbitrary directory searches or alias enumeration.

Allow at most one diagnostic record for each encountered boundary in each named representative case, at most 16 records per probe and at most 2 KiB per serialized record. Unexpected fields are rejected before serialization. Unavailable values have an explicit unknown/not-observed state; unknown is not a passing predicate. An attempted record beyond a limit makes the diagnostic evidence incomplete. The probe harness must stop collecting and report incomplete evidence, without changing the product operation's original result/error/exit status or accepting uncertain state. An unchanged successful product result cannot substitute for missing causal evidence.

Reporter failure must not replace the primary refusal, bypass cleanup, change exit status or grant eligibility. Close owned descriptors and processes even when observation fails. The implementation plan must bind each observation to the actual synchronous check or mark it as a snapshot; do not log a later re-read as the original rejection. Do not introduce a caller-controlled public diagnostic API, environment-driven guard bypass or plaintext evidence fallback.

## Causal proof and permitted repairs

For each family, establish a reproducing failure on bound synthetic inputs, obtain the actual refusal reason, vary one relevant condition and show that the expected business assertion becomes reachable. Retain the failing control and hostile variants. A different exception, timeout or cleanup failure is not proof that the original guard behaved correctly.

Prefer a minimal correction at the proven producer, fixture or existing implementation boundary. Canonicalizing an owned fixture is permitted only when evidence proves the fixture spelling was invalid and the real policy still rejects hostile aliases and replacements. Derive all downstream fixture paths consistently from the verified root; leave deliberately malformed inputs intact. Preserve ownership-aware cleanup of only the created root; canonicalization must not redirect cleanup to an unrelated target.

Do not waive regular-file/link checks, canonical identity, symlink/junction refusal, durable containment, route binding, mutation detection, provenance or exact build correspondence. An implementation correction may restore an existing documented contract, but a changed acceptance policy, new interface, dependency change or newly trusted producer requires a concrete amendment before implementation. Only the CI-role changes specified in the linked amendment are covered by that amendment; other workflow changes require their own concrete review.

The first execution plan must enumerate exact owned observation files, representative cases, commands, bounded resource/process cleanup and diagnostic data. If diagnostics establish a repair not concretely covered by that plan, return with the evidence and prepare the scoped repair plan; do not turn this design into open-ended authority to patch any red test.

## Verification and completion criteria

Use focused verification during diagnosis and remediation. Do not run the full repository suite after each observation or small fixture change. The later plan selects deterministic representative cases and preserves process-tree ownership, closure receipts and primary failure evidence.

Required build controls include an ordinary regular file, size-bound acceptance/refusal, the observed installed-tool topology, a hostile additional hardlink, non-regular and symlink/parent-symlink paths, truncated reads, descriptor mutation and pathname replacement. Preserve namespace/entry redirects, stale identity, dependency mutation, finalization mutation, exact input/output correspondence and manifest invalidation controls. Add native-executable mutation coverage where the current changed-file loop omits it.

The subsequent causal-diagnostic implementation includes native mutation controls in the changed-file loop and finalization handoff. Retain that coverage when adding installation-policy controls; the earlier conditional instruction is not a claim that those controls are still absent.

Required path controls include a canonical owned directory reaching the real boundary, comparison with the actual failing fixture spelling, lexical invalid paths, native junction/symlink refusal, directory replacement after authorization, durable descendant acceptance and sibling escape rejection. Fresh admission must reach its intended business assertion while forged routes/identities remain refused. Keep platform-unavailable cases explicitly reported; do not silently convert failures into skips.

Diagnostic controls must prove field allowlisting, caps, unknown-value behavior, sanitization and reporter-failure preservation of errors, cleanup and exit status. Hostile tests must observe their intended refusal reason, not merely any final failure. If local inputs cannot reproduce hosted conditions, report that limit and obtain the necessary hosted-action authority rather than guessing the cause.

Freeze the final candidate before complete qualification. Bind head, base, tested merge, workflow bytes, OS/runtime, lock/dependency identities, compiled outputs and gate results. The qualification target is the actual merge/release candidate; focused head-only success does not qualify a different merge. A subsequent relevant change invalidates the affected evidence and requires proportionate requalification.

Close this slice only when all of the following are established:

- Each observed failure family has a causal disposition; V2-required failures have corresponding focused regression/hostile evidence. Legacy-only unresolved regressions are tracked separately rather than required for fresh-start V2 release. No family is reported fixed by scheduling changes or a neighboring repair.
- Existing refusal, route, provenance and ownership contracts remain intact, with no removed tests, weakened limits or hidden skips.
- PR feedback retains the core checks and minimum-runtime rejection. The final candidate passes the complete nonlegacy suite and every distinct V2 release qualifier on supported Ubuntu and Windows under the reviewed role contracts; legacy evidence stays with its separate owner. Hosted execution must first receive its required authority.
- Reports distinguish failed attempts, successful results, skipped checks and incomplete evidence, and bind every result to its exact tested identity.

Green CI closes this remediation slice only. Operational keys, public V2 workflows, actual selected-host qualification, backup/restore of new V2 data, release proof and separately authorized cutover remain governed by the fresh-start delivery roadmap.

## References

- [Fresh-start production design](2026-09-29-v2-fresh-start-production-design.md).
- [Fast PR and full V2 release CI amendment](2026-10-04-v2-fast-pr-full-release-ci-design.md).
- [Fresh-start delivery roadmap](../plans/2026-09-29-v2-fresh-start-delivery-roadmap.md).
- [Failed hosted CI run](https://github.com/fastest4u/Awakened-AI-System/actions/runs/37142753116).
- Source owners at the recorded head: `scripts/build.js`, `scripts/run-v2-shadow-migration-rehearsal.js`, `src/orchestrator/projections/stable-directory.ts`, `tests/support/canonical-temp.ts`, `tests/support/fresh-start-fixture.ts`, and the representative tests named above.

Next action is separate bounded implementation plans for CI-role contracts and causal diagnosis, with plan review and execution-method confirmation before implementation. This document neither claims the root causes are known nor approves implementation or production deployment.
