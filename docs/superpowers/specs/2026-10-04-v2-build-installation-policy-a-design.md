# V2 build installation policy A design

**Status:** The human approved conversational option A, this written specification and its [written implementation plan](../plans/2026-10-04-v2-build-installation-policy-a.md) on 2026-10-04. The plan's separate approval permits named local Subagent-Driven implementation and owned verification; it does not establish completion or authorize publication, hosted execution or PROD activation.

On2026-10-05 the human explicitly approved adding only `tests/ci-release-identity.test.ts` and `tests/ci-workflow-roles.test.ts` for the two Task4 downstream fixture findings. This amendment aligns independent fixtures, installation outcome/binding lists and mutation anchors with the already-approved contract; it does not change production behavior, gates, dependencies, test-profile membership or external-action authority. Task4 is now accepted after fix `86bc30dc209fd426157f7810319bf8affc8a0eef`, complete affected107/107/native0/0skip, typecheck0, root frozen3/3/native0 and scoped re-review closing both findings without new breakage. Effective Task5 installer/cross-platform proof and later full qualification remain pending.

**Outcome:** Prevent esbuild's optional CLI hardlink optimization during locked dependency installation, replace the omitted setup assurance with a reviewed capability check, and retain the existing single-link build contract. This is the next CI remediation slice for fresh empty V2, not whole-system PROD qualification.

## Evidence and limits

The inspected source is head `11ba91ec1a6840cea6e961b4c3789d32f9623b9d`. [Hosted run 37203356089](https://github.com/fastest4u/Awakened-AI-System/actions/runs/37203356089) tested merge `023c5f37d55a6e7a2955156c4a107159d633ccc4`, with base `2836eda4ce3f4808c811d6abea98e196f708cb1a`. The Ubuntu Build observation records the native recipe `node_modules/@esbuild/linux-x64/bin/esbuild`, a regular file and link count 2, refused at `descriptor-before`. Unconsulted predicates remain unknown. This is actual single-link refusal evidence, not proof of the second alias or its producer.

Installed esbuild 0.28.2's `install.js` contains a non-Windows, non-Yarn, non-WASM optimization using `linkSync` followed by `renameSync` to its CLI alias. The JavaScript API resolves and launches the optional platform-package binary. This explains a plausible installation mechanism. No script-disabled Linux installation or successful counterfactual has yet been executed. Local Windows inspection is not Linux qualification.

The lockfile has exactly one `hasInstallScript` entry: `node_modules/esbuild`, version `0.28.2`. The root currently has none of `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare` or `dependencies`. It does have `prebuild` and `pretest`; these must retain their existing behavior. A lockfile boolean is not by itself proof that every omitted setup requirement is harmless.

The supported hosted jobs still require separate results. Windows Build success does not establish its suite result, Ubuntu success, exact-release qualification or actual PROD readiness. The earlier failed-run baseline in the parent remediation design remains historical evidence, not a result superseded by this proposal.

## Scope and authority

This amendment supplies the concrete installation-producer review required by the [hosted CI remediation design](2026-10-04-v2-hosted-ci-remediation-design.md). It narrowly extends the [CI role design](2026-10-04-v2-fast-pr-full-release-ci-design.md) to consistent installation-policy gates in PR, release, legacy and stress roles. Their roles, triggers, check names, matrices, cancellation, baseline/routing guards, test membership, distinct qualifiers and upload permissions remain unchanged.

Written-spec approval permits implementation planning only. Written-plan review and approval precede implementation and local synthetic execution; preserve the already selected Subagent-Driven method. No stage here grants push, merge, hosted dispatch/cancellation, branch-protection changes, dependency upgrades, live V1 access, actual Codex capture, credential/configuration changes, or PROD activation. Later hosted execution requires authorization for its exact candidate/control/purpose.

Do not modify installed vendor files, unlink guessed aliases, reinstall into an existing shared checkout, accept hardlinks, add fallback downloads or caches, set `ESBUILD_BINARY_PATH`, persist npm configuration, expand production-source seals, remove tests, widen exclusions or raise existing limits/timeouts. A new requirement outside the owners below returns for scoped review.

## Installation producer and gate order

Introduce the private checked-in owner `scripts/check-build-installation.js`. It uses Node builtins and the existing builtin-only guarded reader/resolution helper; it must not import installed dependencies. Its command interface accepts exactly one phase, `before` or `after`, and refuses missing, unknown or extra arguments. Resolve the checkout from the script's own location, enforce its existing canonical-root policy, and accept no caller-supplied root, override, repair mode or bypass.

The proposed sequence is not an available operator instruction until implementation is approved and verified:

```text
node scripts/check-build-installation.js before
npm ci --ignore-scripts --include=dev --include=optional
node scripts/check-build-installation.js after
```

The install flags are command-scoped. They suppress install lifecycle execution while retaining development tools and optional platform packages. They must not be written to `.npmrc`, user/global configuration or an environment variable inherited by later commands. Subsequent `npm run build` and tests retain their runtime hooks. Missing optional packages still fail the capability check: an npm success code alone is insufficient. Established flag behavior is documented by [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/); do not substitute newer unpinned `allowScripts` behavior.

For release, retain existing candidate/control verification, exact checkout, Node setup and initial qualification identity before this sequence. For other roles, retain checkout and Node setup first. The policy check precedes npm and dependency imports; the capability check precedes all existing product commands. Preserve the original order after installation, including runtime/typecheck/Build and immutable baseline/routing guards before dependent tests. The unsupported-Node rejection job performs no installation and remains unchanged.

Stress uses the same sequence within its current PowerShell logging owner, preserving immediate native exit-code propagation after each command. Emit only fixed bounded status/refusal text for the new checks. Do not add raw filesystem observations or exception data to its existing authorized uploaded log.

## Setup inventory before installation

Read root package metadata and lockfile through bounded guarded reads. Require `lockfileVersion: 3` and matching root dependency declarations. Compare the complete sorted install-script path/name/version inventory against the reviewed singleton esbuild 0.28.2 entry. Bind its locked integrity identity and the selected optional native package to the reviewed policy; an added entry, version/integrity change, malformed record or root installation hook is a refusal, not a silently skipped requirement. Root implicit native setup is also unapproved.

The reviewed disposition is explicit: do not execute esbuild's `postinstall: node install.js`; do not perform its hardlink optimization, override patching, nested reinstall or direct-download fallback. The after phase replaces its necessary matching-version and usable-native-tool assurance. There is no generic permission to omit setup for future dependencies.

Accept only the reviewed pinned registry-tarball installation shape. Linked, workspace, Git, local/file or other nonregistry sources require their own setup disposition and are refused before installation in this slice. For registry dependencies, the applicable install surface is `preinstall`, `install`, `postinstall`, plus npm's implicit node-gyp setup where applicable. Validate those installed declarations and implicit setup against the singleton disposition after installation. Registry-package `prepare`, `prepublish`, `prepublishOnly`, `prepack` and `postpack` declarations are not this dependency-install surface: they confer no setup authority, are not executed, and do not alone cause refusal. Keep the separate comprehensive root hook rule above. These distinctions follow [npm lifecycle documentation](https://github.com/npm/cli/blob/v11.13.0/docs/lib/content/using-npm/scripts.md) and must be checked against the installed npm implementation rather than new unpinned features.

Inspect only the bounded lock-derived package roots, not arbitrary filesystem searches. Account for legitimate absent optional packages for other platforms; the selected native package and all required locked packages cannot be absent. An applicable unreviewed native setup, such as `binding.gyp` with no overriding install/preinstall disposition, is not harmless because the lock boolean is absent. Newly discovered setup requirements stop the slice for review. Metadata cannot acquire execution authority through this check.

## Capability verification after installation

Recheck policy inputs, then prove the exact normal wrapper and native resolution already admitted by `assertBuildToolResolution`. Keep override, nearer namespace, entry redirection, downloaded binary, cache-copy and missing-package fallbacks inadmissible. Require wrapper/native names and versions, optional-dependency mapping and locked identities to agree. TypeScript metadata and resolution retain their existing lock/tool checks.

Measure the expected native binary with the existing guarded reader: canonical nonsymlink parents and leaf, regular file, `nlink === 1`, existing size/read bounds, full read, descriptor/leaf identity and stable size/timestamps. Compare its digest against an independent reviewed policy pin, not only a value supplied by mutable installed metadata. The installed `esbuild.binaryHashes` table must agree with that pin; changing the binary and table together must still refuse.

The pins below were read from the locked esbuild 0.28.2 release metadata during design review; they are not hosted provenance proof:

| Locked native recipe | Expected SHA-256 |
| --- | --- |
| `@esbuild/aix-ppc64/bin/esbuild` | `6de148b932fc5d3b28a97f9f0bc4de8e2b47db478b8ad679e0eaa6b96e00420d` |
| `@esbuild/android-arm64/bin/esbuild` | `84efbbd2cbf21bbfec2aaf304bee79cb2a4a05fe2ea7b861a87f7b8f213ac27d` |
| `@esbuild/darwin-arm64/bin/esbuild` | `10b6243df618d374bb2d5c9cfbe7052e1405f6aa4e53a6164f11a91b9f2e1384` |
| `@esbuild/darwin-x64/bin/esbuild` | `7fe5c9c905fff0a05d92db98929434ab4d3b6dd92d7a7688922db74380c75df3` |
| `@esbuild/freebsd-arm64/bin/esbuild` | `6aba108a68b93064e491bfb1ecfa28843b4d4e504dff0627f53f68f6bb015c01` |
| `@esbuild/freebsd-x64/bin/esbuild` | `8a237e222bee0e50556e7b00d83ec2ff43721bf72f19811a5f0ee56f1d40177c` |
| `@esbuild/linux-arm/bin/esbuild` | `d88f751b22095b2f3b42c8c2e8a3f36fabc1705438c5d6e78366b681f8b4e7a5` |
| `@esbuild/linux-arm64/bin/esbuild` | `90bd269553d258e80b19e3ccab4f98f0831f87442a2f056510ce24fd1b425fc2` |
| `@esbuild/linux-ia32/bin/esbuild` | `b1e2d87d79f9a2baa0d3043cdf0dc6716f9f2eea66c58f47588641fd6019f36f` |
| `@esbuild/linux-loong64/bin/esbuild` | `55a66f9854d6798f36b2b5471db74f2e552481887ea14d8bda1634a512383a43` |
| `@esbuild/linux-mips64el/bin/esbuild` | `6bf7921a3af4a801051e056d85c360fe24bb446f488ef3da25f0b8e5cf973db1` |
| `@esbuild/linux-ppc64/bin/esbuild` | `c30df60d09bb0ba4853d7b06e244ce966890d61ce60cadd9b22335f6379c316a` |
| `@esbuild/linux-riscv64/bin/esbuild` | `36bdcdc8230eef385838cdfeb0d9a1565cbe4b9ace30097a511d77e894de36a1` |
| `@esbuild/linux-s390x/bin/esbuild` | `bbbc1f92a76a5ca6e2976065222e42b02797363a1f119490dda315f74047741f` |
| `@esbuild/linux-x64/bin/esbuild` | `e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100` |
| `@esbuild/netbsd-arm64/bin/esbuild` | `62548519d7ae875d060aa8c94bfb8ed38ef191671a5173d9f626bdb6b7516970` |
| `@esbuild/netbsd-x64/bin/esbuild` | `f9d0e59d2b404559e3a0c958164d96960ebf0e04583b878b1d64d8f1c3698fcc` |
| `@esbuild/openbsd-arm64/bin/esbuild` | `e10c45a0b62456632da41df058d7626b2e7cfe710780a2dc7f9f84681753f3aa` |
| `@esbuild/openbsd-x64/bin/esbuild` | `720bbe607736716f2ecd37962436c5589d801966e868a2ae4e0e7e62d1e4e887` |
| `@esbuild/sunos-x64/bin/esbuild` | `01a3bd9183631ca749f34d15601ea21ba6834614184c5c859f99d54bd683203d` |
| `@esbuild/win32-arm64/esbuild.exe` | `530fb3933af14eefe85dfd06502f826e6ef60fdf4e75228ea67c696db312ecb1` |
| `@esbuild/win32-ia32/esbuild.exe` | `b2e62af5c17e00939583be0a0762fdc469f352869a617edc91371b00454c76f0` |
| `@esbuild/win32-x64/esbuild.exe` | `c7bee37877d0aa6a046e52783fa0a2cf1a9ce5579d68bb3083bda99d4bff18ef` |

The table is the complete reviewed 23-entry native digest table from the locked 0.28.2 metadata. Embed these exact pins in the checked-in policy owner; only a recipe already admitted by the existing resolver may be selected. Compare the complete table with this written specification and the locked metadata during implementation review. This does not add new platform support or claim qualification beyond the existing Ubuntu/Windows matrix. Missing policy pins refuse; do not derive a new trusted pin from installed bytes during a run.

Only after the byte/resolution checks may the gate invoke the exact native path with fixed `--version`, no shell, no stdin and no custom binary path. Bound this owned invocation to 10 seconds, at most 1 KiB each of stdout/stderr, and hidden windows where applicable. Require native exit zero, no unexpected stderr and exactly the expected version with its conventional terminal newline. Recheck measured identity and bytes after the invocation. Timeout, truncation, disagreement or incomplete closure is failure; preserve the primary refusal and ownership-aware cleanup. This bound is new to this private check, not an increase to an existing deadline.

The check neither repairs dependency state nor proves atomic kernel-level pathname execution or historical alias provenance. Ordinary build still independently enforces current tool resolution and before/finalization measurement. No snapshot or successful version response replaces those checks.

## Build identity and qualification closure

Build must enforce the capability check even when invoked without CI's installation sequence, before importing selected esbuild/TypeScript or another installed dependency. Preserve the existing early incomplete-manifest writes. Export a private assertion from the new script; its CLI main guard must not execute on import. Adapt a failed assertion to the existing build refusal/error contract rather than changing public or existing operational errors.

Add only `scripts/check-build-installation.js` to the exact trusted recipe inputs. Its reviewed constants and logic are thereby source-bound. Keep package/lock, wrapper/native metadata and native bytes measured, and retain committed-input checks, recipe decoding, cached-resolution refusal, dependency mutation and finalization remeasurement. Do not change the manifest schema, source allowlist, runtime policy or artifact eligibility to accommodate the installer.

Release closure must require success of three installation outcomes with exact same-job step IDs `installation_policy`, `installation`, and `installation_capability`, in addition to its existing eight product outcomes and six build-phase recorder outcomes. Omission, duplication, conditional bypass, ignored failure, skipped/cancelled phase or cross-job result must refuse. These are step outcomes bound to the initial candidate/control/OS/run/attempt/lock identity and final tracked-input/build checks, like existing runtime/typecheck outcomes; they are not replacements for measured-build evidence.

No additional receipt, artifact, manifest or upload is introduced. The preflight emits only fixed success/refusal categories, not a caller-supplied passing claim. Preserve all six existing `V2_CI_RECEIPT` records and their schemas, generation distinctions and closure checks. An implementation that instead needs another evidence channel returns for review rather than enlarging this scope.

## Exact implementation owners

The later plan may change only the following owners for this slice:

- New `scripts/check-build-installation.js` and focused `tests/build-installation-policy.test.ts`.
- `scripts/build.js` and `scripts/run-v2-shadow-migration-rehearsal.js` for private assertion wiring, the one new recipe input and unchanged finalization enforcement.
- `.github/workflows/ci.yml`, `.github/workflows/v2-release-qualification.yml`, `.github/workflows/v2-legacy-regression.yml` and `.github/workflows/sqlite-stress.yml`, solely for exact installation gates/commands and the corresponding release outcome checks.
- `tests/support/ci-workflow-contract.ts`, `tests/ci-lifecycle-gates.test.ts`, `tests/ci-fresh-start-foundation.test.ts` and `tests/v2-shadow-migration-rehearsal.test.ts`, solely for installation grammar, identity/finalization and focused controls. Foundation's relative product-gate order remains unchanged.
- `tests/ci-release-identity.test.ts` and `tests/ci-workflow-roles.test.ts`, solely for the authorized Task4 downstream independent fixture/outcome/binding/mutation-anchor alignment. Preserve existing positive acceptance, precise negative refusal boundaries and all six recorder phases.
- `docs/runbooks/v2-ci-qualification.md` and `docs/v2-fresh-start-operations.md` for the verified installation procedure and its qualification limits.
- This design and its two parent specifications, then a separate reviewed implementation plan.

No `src` file, protected production-source inventory, generic append/public V2 API, test-profile selector, immutable V1 baseline or unrelated primary-checkout work is in scope. Do not amend historic plans into broader execution authority.

Within the already named rehearsal test owner, update `cleanBuildFixture` to copy the new policy script and the complete required locked package closure plus the selected native optional package. Its current five build seeds omit root requirements such as `fast-glob`, `yaml` and `@types/node`; the stronger after check must not acquire a test bypass. Include nested required peer/lock entries, classify legitimate other-platform optional absences, and preserve the existing 256 MiB/20,000-file capture bounds, source/destination byte/directory correspondence and original Git/index preservation. If complete capture exceeds those bounds, report it rather than increasing them. Copied-byte fixtures remain synthetic build evidence, never installer or hardlink-topology proof.

## Focused verification and causal proof

The later plan must retain small deterministic checks before complete qualification:

- Policy controls: exact current inventory, absent root setup hooks and inert registry publishing declarations pass; added/changed/malformed setup entries, applicable unexpected install hooks/native setup, unreviewed source shapes, incomplete required-package capture, extra phases/arguments and aliases refuse for their intended reason.
- Capability controls: valid native resolution/version/pinned bytes pass; absent/wrong platform package, wrong metadata/version/digest, binary-plus-table alteration, unusable executable, extra output, timeout and cleanup failure refuse without repair or fallback.
- Existing filesystem controls remain: hardlink, symlink/parent alias, nonregular/oversized/truncated input, descriptor mutation, pathname replacement, nearer namespace, native mutation and finalization handoff. Add the policy owner to relevant changed-input tests without deleting existing native mutation coverage.
- Workflow controls cover all four exact sequences, required install outcomes, phase order, duplicate/missing/conditional/ignored steps, persistent ignore-scripts settings, stress native exit propagation and unchanged uploads/roles/profiles. A forged fixed success marker cannot replace actual native step success and source-bound closure.
- An isolated owned Linux installation comparison records the ordinary-install control and script-disabled candidate against the same source/lock/runtime. Use the real reader's link-count refusal, then verify selected-native single-link usability and the actual guarded Build under A. Do not mutate shared `node_modules`, infer topology from copied bytes, enumerate arbitrary aliases or use Windows as Linux proof.
- Verify the corresponding fresh Windows installation and guarded Build, keeping platform-specific unsupported cases explicit. Serially own shared outputs and processes; preserve errors and incomplete closure rather than retrying into success.

No full migration/parity replay is needed for this focused installer proof. Direct rehearsal-reader controls may still be necessary to protect shared build integrity; they are not live V1 migration. Do not repeat the full repository suite after every change. Final frozen-candidate complete nonlegacy and distinct release qualification on both supported OSes remain required under the parent role contracts and separately authorized hosted execution.

## Completion and subsequent delivery

Accept this installation slice only after reviewed setup disposition, independently pinned native bytes, exact workflow/closure contracts, focused hostile controls and an effective actual Linux/Windows installation/build counterfactual are established for the recorded candidate. Report failures, skips, incomplete evidence and identity changes separately. Relevant later changes invalidate affected proof.

Completing this slice does not make V2 production ready. Operational key storage/rotation/recovery, governed public memory and lifecycle/retrieval workflows, complete-visible Codex capture and all nine actual-host proofs, backup/restore of newly acknowledged V2 data, exact release qualification and separately approved activation remain in the [fresh-start roadmap](../plans/2026-09-29-v2-fresh-start-delivery-roadmap.md).

Next action is execution of the approved written implementation plan with the preserved Subagent-Driven method. Record task review and actual evidence, with effective installer/cross-platform proof still required before accepting the slice. The separately approved bounded default-test scheduling direction does not expand this installation slice's owners or grant hosted-action authority.
