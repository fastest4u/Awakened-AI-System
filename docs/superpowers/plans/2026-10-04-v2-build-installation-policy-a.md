# V2 Build Installation Policy A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unneeded esbuild installation hardlink optimization while proving the locked native tool remains usable under the unchanged guarded Build contract.

**Architecture:** A builtin-only private before/after checker owns setup-policy admission and native capability verification. Build calls the same capability assertion before dependency imports; the four existing CI roles use the same installation sequence, and release closure requires its three actual same-job outcomes. Extend the existing guarded reader for cross-invocation file identity, not a new public trust or repair surface.

**Tech Stack:** Node 24.16.0, existing locked npm/TypeScript/esbuild 0.28.2, Node builtins, node:test, existing YAML contracts and PowerShell qualification programs. No new dependency.

**Spec:** [Approved installation-policy A design](../specs/2026-10-04-v2-build-installation-policy-a-design.md). Read its complete native digest table and authority boundaries. Parent [CI-role design](../specs/2026-10-04-v2-fast-pr-full-release-ci-design.md) and [causal-remediation design](../specs/2026-10-04-v2-hosted-ci-remediation-design.md) remain binding outside the named amendment.

**Status:** The human approved this written plan on 2026-10-04 after approving its specification. Execute with the already selected Subagent-Driven method; task checkboxes record only actual accepted implementation/proof. This approval covers the named local owners and owned checks, not publication, hosted execution or PROD activation.

## Global Constraints

- Fresh empty V2; no live V1 Markdown migration, credentials, real transcript capture, public API, `src` change or PROD activation.
- CLI accepts exactly `before` or `after`, no extra arguments/root/options/override/bypass; root comes from the script's own location and retains canonical nonsymlink checks.
- Exact sequence: `node scripts/check-build-installation.js before` → `npm ci --ignore-scripts --include=dev --include=optional` → `node scripts/check-build-installation.js after`.
- Flags are command-scoped: no persistent `.npmrc`, environment/global setting, newer `allowScripts` feature, dependency upgrade or vendor repair. Later `prebuild`/`pretest` retain behavior.
- `lockfileVersion: 3`; only reviewed registry-tarball shape; setup inventory singleton `node_modules/esbuild` version `0.28.2`; all required locked packages and selected native optional package present.
- Reject root `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare`, `dependencies` and implicit native setup. Registry dependency setup is `preinstall`/`install`/`postinstall` plus applicable implicit node-gyp; inert registry publishing/prepare declarations alone do not refuse.
- Embed all 23 exact native digest pins from the approved spec; select only an existing resolver-admitted recipe. Installed metadata cannot supply a new trusted pin.
- Preserve regular/nonsymlink/canonical/single-link/full-read/descriptor-leaf identity/size/timestamp guards, 32 MiB file and 128 MiB/512-file measurement limits, existing finalization and committed-source checks.
- Native probe: fixed `--version`, no shell/stdin, hidden Windows, 10 seconds, at most 1 KiB each stdout/stderr; expected `0.28.2` plus one conventional terminal newline, exit zero/no signal, stderr empty, positive owned-child closure. Fail without retry/fallback on timeout, excess output or uncertain cleanup.
- Preserve incomplete manifests before imports; add only `scripts/check-build-installation.js` to trusted recipes. No manifest, source inventory, artifact eligibility or recorder-schema expansion.
- Release adds actual same-job `installation_policy`, `installation`, `installation_capability` outcomes; keep eight product outcomes, six recorder outcomes, candidate/control/OS/run/attempt/lock binding and final tracked-input/build checks.
- Four workflow roles, triggers, matrices, check names, Node rejection, baseline/routing order and uploads remain unchanged. The separately approved bounded default-runner scheduling change is not implemented by this plan; preserve its actual reviewed state without widening membership.
- Synthetic copy stays within 256 MiB/20,000 files, with complete source/destination/directory correspondence and original Git/index preservation. Missing or over-limit closure fails, never bypasses.
- Focused affected tests first; no full suite after every small edit, no full V1 migration/parity replay for this proof. Final complete nonlegacy and distinct release qualification on both OSes remain required. No push, merge or hosted dispatch/rerun/cancellation without separate exact authority.

## Review Focus

1. Lock optional/peer classification: an installed optional package still needs setup inspection; a missing required nested peer or current native tool must refuse (Tasks 1–2).
2. Byte-identical native pathname replacement between version invocation boundaries must refuse through identity comparison, not merely digest equality (Task 2).
3. Output overflow or timeout followed by a late clean exit must remain a failure; incomplete child closure must never become success (Task 2).
4. A checker failure before dependency import must leave both incomplete manifests in place even outside CI (Task 3).
5. A forged passing marker or success from another job cannot replace one missing/failed actual installation outcome in release closure (Task 4).

## File Map and Execution Ownership

| Owner | Responsibility |
| --- | --- |
| New `scripts/check-build-installation.js` | Import-safe builtin-only policy, capability and exact CLI phases |
| `scripts/run-v2-shadow-migration-rehearsal.js` | Compatible guarded snapshot extension; one recipe addition |
| `scripts/build.js` | Capability assertion after invalidation, before installed imports |
| New `tests/build-installation-policy.test.ts` | Owned synthetic policy/native controls, including real default native usability |
| `tests/v2-shadow-migration-rehearsal.test.ts` | Existing exact `cleanBuildFixture` closure and Build/finalization controls |
| Four existing workflow files | Before/install/after sequence only; release actual outcomes |
| `tests/support/ci-workflow-contract.ts`, `tests/ci-lifecycle-gates.test.ts`, `tests/ci-fresh-start-foundation.test.ts` | Independent role grammar and executable closure/ordering refusal controls |
| Existing operations/runbook docs | Verified operator sequence and evidence limits |

Only one worker owns compiler/generated outputs or native installation/build processes at a time. Never run a compiler while tests consume its output. Record task base/head and native exit/counts; each implementation task gets scoped spec/quality review before the next. Do not stage another worker's documentation or unrelated primary-checkout edits.

## Task 1: Closed Setup Policy and Before Phase

**Files:** Create `scripts/check-build-installation.js`, `tests/build-installation-policy.test.ts`. Read `package.json`, `package-lock.json`, the existing helper and the installed locked npm implementation; do not change them.

**Interfaces:** Produce `assertBuildInstallationPolicy(): void`. It reads only its script-derived checkout and throws the existing fixed `REHEARSAL_BUILD_INVALID` on refusal. Internally derive required/optional roots from bounded lock records; do not expose caller-supplied policy or paths. The import-safe CLI `before` invokes it and emits only `BUILD_INSTALLATION_POLICY_OK` on native success.

- [x] Write real owned-fixture tests named `installation policy accepts reviewed registry setup`, `installation policy rejects changed setup inventory`, and `installation policy rejects root setup and nonregistry sources`. Copy the current package/lock and builtin scripts into an owned root; mutate one exact input per refusal. A clean before-phase fixture has no installed packages and must pass its reviewed lock/root policy. Independently assert exit/result and untouched fixture sentinels, not the source text.
- [x] Add CLI controls for missing/unknown/extra phase arguments and import without CLI execution. Show expected RED against the absent checker/new behavior, with native exit and intended assertion.
- [x] Implement the exact registry/root classification and complete sorted singleton setup inventory; validate root declarations, package path/name/version and SRI/registry shape. Bind the reviewed esbuild SRI `sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==`; version/integrity changes refuse. Bind each selected native lock entry to the reviewed version and lock identity rather than untrusted installed bytes. Check this against the actual locked npm implementation, not Context7's newer `latest` source.
- [x] Cover added/malformed lock setup entries and applicable root implicit native setup. No unknown setup becomes harmless because `hasInstallScript` is absent. The before phase does not require installed packages; Task 2 owns installed setup disposition. No recursive arbitrary-directory search.
- [x] Run `npm run test:build`, then `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="installation policy|installation CLI" dist-test/tests/build-installation-policy.test.js`. Expected GREEN: every selected new case passes, zero failed/cancelled, native exit 0. Record platform-unavailable controls separately.
- [x] Commit only Task 1 files after self-review; obtain scoped review. Do not install dependencies yet.

**Accepted Task 1 evidence:** Commits `1b7b63e` and `2de2af7`; final native focused run 63/63, zero failed/cancelled/skipped, compile exit 0. Independent spec/quality review found two admission gaps; their actual RED/GREEN and scoped re-review closed both. Root independently reran the two amended controls (2/2, exit 0) and the native real-worktree `before` marker. These are local setup-policy controls, not installer, full-suite or hosted qualification.

## Task 2: Pinned Native Capability and Cross-Invocation Identity

**Files:** Modify `scripts/check-build-installation.js`, `scripts/run-v2-shadow-migration-rehearsal.js`, `tests/build-installation-policy.test.ts`.

**Interfaces:** Consume Task 1 policy. Produce `assertBuildInstallationCapability(): Promise<void>`; this assertion itself begins with `assertBuildInstallationPolicy()` and checker-private `assertInstalledSetupDisposition(): void`, before resolution or native invocation. The latter owns all present lock-derived package declarations and required-package presence. CLI `after` simply awaits the complete capability assertion, so standalone Build receives the same admission. Add private exported `readBuildFileSnapshot(name, maximum = 32 * 1024 * 1024, observation?)` returning `{ bytes: Buffer, identity: { dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint } }`. Keep `readBuildBytes(...): Buffer` compatible; both use one unchanged guarded descriptor algorithm. No root/options/bypass argument.

- [x] Add expected-RED snapshot/native cases for legitimate bytes/resolution/version, byte-identical replacement, changed digest plus changed installed table, nearer namespace/override/cache fallback, missing native package/wrong version, hardlink/symlink, and descriptor/read mutation. Use existing reader fault seams inside test-owned processes; no production-only testing bypass.
- [x] Add after-phase cases `installation policy refuses missing required nested peer` and `installation policy distinguishes inert registry publishing declarations`. Inspect every present lock-derived package, including present optionals; classify legitimate absent other-platform optionals, but no absent required root/nested peer or selected native package. Reject unreviewed installed setup and implicit node-gyp without executing it; preserve inert registry publishing declarations.
- [x] Return identity from the already guarded complete read with descriptor/leaf equivalence preserved. Before/after native invocation compare all identity fields AND guarded bytes/digest. A plain `measureBuildFiles` result lacks cross-invocation inode/timestamp identity and is insufficient.
- [x] Implement capability beginning with both complete policy and installed-setup assertions, then using the existing resolver, its guarded wrapper metadata and the exact selected native recipe. Verify package names/version/optional mapping/lock identity, all 23 literal independent spec pins and installed `binaryHashes` agreement. Refuse a binary/table joint alteration before invoking it; keep TypeScript tool checks intact.
- [x] Only after admission spawn the fixed native path with `['--version']`. Enforce the exact Global Constraints stream/time bounds and actual close/exit result. Latch timeout/overflow/spawn/cleanup failure before interpreting any later output. Emit only `BUILD_INSTALLATION_CAPABILITY_OK` after remeasurement; adapt errors to the existing refusal.
- [x] Add owned controls named `native capability rejects late success after timeout`, `native capability rejects stream overflow and unexpected stderr`, and `native capability rejects incomplete closure`. Assert the consumer's failure/owned cleanup; test-only native-boundary doubles may exercise otherwise unreachable output faults, but copied bytes or doubles cannot be reported as real installer proof.
- [x] Compile once and run the complete new file with `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/build-installation-policy.test.js`; expected all eligible cases pass, native exit 0. Independently compare the embedded 23 pins to the approved spec and locked metadata, never derive the expected digest from the bytes being admitted.
- [x] Commit exact Task 2 files; obtain scoped review including every Review Focus 2–3 control.

Accepted Task 2 evidence: commit `be4537d375ee33eb7360942788e9757c37180be4`; final native compile exit0 and complete owned file108tests/107pass/0fail/1 unsupported Windows native-file-symlink child skip,85.338s. Independent spec/quality review approved with no findings; root frozen CLI before/after native0 and focused admission/identity7/7/native0. All23 embedded pins match the approved spec and installed locked-version metadata. Existing installed-state capability and synthetic controls are not fresh installer/Linux/guarded-Build or whole-system qualification proof; Tasks3–5 were pending at Task2 acceptance, with Task3 acceptance recorded below.

## Task 3: Build Enforcement, Recipe Identity and Complete Copy Fixture

**Files:** Modify `scripts/build.js`, `scripts/run-v2-shadow-migration-rehearsal.js`, `tests/v2-shadow-migration-rehearsal.test.ts` and new `tests/build-installation-policy.test.ts` only as needed for entry controls.

**Interfaces:** Consume `await assertBuildInstallationCapability()` from Task 2. `rehearsalRecipePaths` gains exactly `scripts/check-build-installation.js`; validator/schema and `readBuildBytes` contracts otherwise remain unchanged. Existing `cleanBuildFixture(t): string` stays the same interface.

- [x] Add expected-RED controls `build installation refusal leaves both incomplete manifests`, `standalone build refuses changed root hook and missing required closure`, `build refuses changed installation policy recipe`, and `clean build fixture includes every required locked package`. Test the actual Build entry and finalizer in owned roots; assert dependency code has not executed on admission failure even when CI before/after commands were not invoked.
- [x] Wire the import-safe checker after the existing two incomplete-manifest writes and before esbuild, obfuscator, TypeScript or other installed-module import. Preserve the established fixed refusal and final resolver/recipe/input/artifact/committed-source remeasurement.
- [x] Extend only the existing `cleanBuildFixture` copy owner: copy the checker and all required lock-derived package roots, including root `fast-glob`, `yaml`, `@types/node`, nested required peers and selected native optional package. Inspect present optionals, classify absent other-platform optionals. Retain exactly the existing capture limits, source/destination byte/directory correspondence and original HEAD/status/index checks; over-limit fails rather than raising a cap.
- [x] Retain and run actual shared reader/native mutation/finalization controls. Include mutations of the new recipe and dependency/root resolution metadata; do not remove old native mutation coverage or add a fixture capability bypass. A copied build fixture is synthetic byte correspondence, not proof of installer hardlink topology.
- [x] Compile once and run the named affected Build/reader controls in `dist-test/tests/v2-shadow-migration-rehearsal.test.js` plus the new policy file. Derive the `--test-name-pattern` from the actual existing test names and record it and selected/failed/skipped counts. Do not run the full legacy rehearsal/migration producer for this task.
- [x] Commit only Task 3 files and obtain scoped review. A dirty real worktree cannot certify an eligible clean release build; owned fixture qualification must retain its synthetic label.

Accepted Task 3 evidence (2026-10-05): commit `2de90f9bccc85164a6d71f16c954c914face459f`, exactly four approved owners; final native compile exit0 and affected copy/Build/reader/native/finalizer controls43/43/native0/0skip,363.808s. Independent spec/quality review approved with no findings; root frozen before-import refusal controls4/4/native0/0skip. The unchanged complete policy/entry lineage contains112tests/111pass/0fail/1 unsupported Windows native-file-symlink child skip. The earlier combined180/175/4/1 run remains recorded as failed, not relabeled GREEN; amended controls were covered by the final43/43 run without repeating unchanged passes. Exact commands, intended REDs and excluded attempts remain in the task report. All six late mutations require actual post-bundling Build-info phase and mutation markers; copy correspondence covers9,971files/96,776,270bytes/1,271directories/207present locked roots within unchanged limits. Owned processes closed and native Git scope/clean state verified before handoff. This is synthetic current-byte/standalone Build proof, not fresh installation topology, Linux or release/PROD qualification. Per the latest human instruction, stop after accepted Task3; Tasks4–5 are unstarted.

## Task 4: Four Exact CI Installation Sequences and Bound Release Outcomes

**Files:** Modify `.github/workflows/ci.yml`, `.github/workflows/v2-release-qualification.yml`, `.github/workflows/v2-legacy-regression.yml`, `.github/workflows/sqlite-stress.yml`, `tests/support/ci-workflow-contract.ts`, `tests/ci-lifecycle-gates.test.ts`, `tests/ci-fresh-start-foundation.test.ts`.

**Interfaces:** Use Tasks 1–2 exact CLI commands. Release step IDs are `installation_policy`, `installation`, `installation_capability`. Bind `V2_CI_OUTCOME_INSTALLATION_POLICY`, `V2_CI_OUTCOME_INSTALLATION`, `V2_CI_OUTCOME_INSTALLATION_CAPABILITY` to the respective same-job `steps.<id>.outcome`; missing or non-success refuses `V2_CI_OUTCOME_INCOMPLETE`. Do not add a receipt schema or artifact.

- [ ] Write expected-RED real parser/executable closure controls for all three new outcomes, exact sequence/order, duplicated/missing/conditional/ignored phases, forged fixed markers, crossed-job outcome expressions and persistent ignore-scripts configuration. Independently spelled fixtures must not compute expected workflow bytes with the production policy generator.
- [ ] Insert before/install/after after checkout/Node setup; release retains initial exact candidate/control/OS/run/attempt/lock identity before policy. Runtime/typecheck/Build, immutable baseline/routing and product gate order remain as before. Unsupported Node rejection has no installation.
- [ ] Adapt stress inside its existing logging owner only: capture and propagate each native `$LASTEXITCODE` immediately; bounded fixed text only. Preserve its weekly/serial role and exact authorized log upload. No new uploaded observations or evidence channel.
- [ ] Update the role grammar/env whitelist, `VERIFY_QUALIFICATION_CLOSURE`, `qualificationRecordPolicy` and mirrored release inline closure/bindings together. All three actual outcomes join existing eight product outcomes, with unchanged six recorder outcomes and final source/build checks. The Foundation Typecheck→Build adjacency and later Foundation/recorder/artifact ordering stay intact.
- [ ] Compile once; run `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/ci-lifecycle-gates.test.js dist-test/tests/ci-fresh-start-foundation.test.js` and `npm run typecheck`. Expected selected positive/negative controls pass, exit 0; report any historical unrelated failure by name without weakening its expectation.
- [ ] Commit exact Task 4 files; obtain scoped review, including actual nonzero native-step propagation and a removed-outcome false-acceptance sentinel. No hosted workflow dispatch here.

## Task 5: Actual Isolated Installer Counterfactual and Handoff

**Files:** Update `docs/runbooks/v2-ci-qualification.md`, `docs/v2-fresh-start-operations.md` with verified procedure and explicit evidence limits; update this plan's checkboxes only for actual accepted proof. No extra product/probe script or workflow role.

**Interfaces:** Consume committed Tasks 1–4 candidate and the exact commands above. Produce source/runtime/OS/installation/guarded-Build disposition, not a production-ready declaration. Existing sanitized transport permissions do not expand.

- [ ] Freeze candidate, record lock/runtime and all earlier task proofs/reviews. Prepare only fresh owned temporary source checkouts for installation comparison; verify their resolved paths and ownership before npm can remove `node_modules`. Never reinstall into the shared V2/primary checkout or clean uncertain residues by guessed names.
- [ ] In an authorized Linux environment, compare ordinary `npm ci` control with the candidate's exact before/install/after sequence at the same source/lock/runtime. Record the actual ordinary reader refusal/link predicate and candidate admitted single-link native usability plus actual guarded Build. Unknown/mismatching control is a reported limitation, not a manufactured proof. Do not enumerate aliases or infer topology from copies.
- [ ] Repeat fresh candidate installation/capability/guarded Build on Windows; do not use Windows as Linux proof. No retry into success, dependency repair or broader resource bound. If no authorized local Linux environment exists, leave its proof pending and present the exact candidate/purpose for separate hosted authorization instead of dispatching automatically.
- [ ] Run focused affected proof before requesting final frozen-candidate complete nonlegacy and distinct release qualification on both OSes. Existing Windows shared failures need their own causal repair; this installer slice does not erase them. Do not repeatedly rerun an unchanged known-red full suite or claim PR green equals release approval.
- [ ] Document actual counts/exits/platform skips/ownership closure/source identities and which prerequisites remain pending. State that all nine actual desktop proofs and F2/F3/F4 operational work remain outside this plan. Counterfactual timing is not a guaranteed CI speedup.
- [ ] Commit only verified handoff docs, request whole-increment source review and preserve all unresolved evidence. Report the exact candidate and remaining actions; no push/merge/activation and no completion claim until the installation slice's required proofs actually exist.

## Self-Review and Handoff

- Spec coverage: setup/CLI→Task 1; pinned capability/identity/cleanup→Task 2; before-import Build/recipe/complete copy/finalization→Task 3; all roles/outcomes/closure→Task 4; effective Linux/Windows proof/limits/operator handoff→Task 5.
- Review Focus 1→Tasks 1–2; 2–3→Task 2; 4→Task 3; 5→Task 4. All have named observable controls.
- Interface consistency: policy is synchronous; capability is awaited by CLI and Build; reader compatibility is preserved; workflow IDs and env suffixes agree. Only the named helper gains a private snapshot export.
- Initial drafting produced no runtime proof. The written plan is now approved; use the preserved Subagent-Driven method and record actual task verification/review before checking completion. Missing installer/cross-platform evidence remains pending, not implicit success.
