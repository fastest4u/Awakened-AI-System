# V2 fresh-start Foundation evidence — 2026-09-30

Status: **Foundation complete, production implementation incomplete.** Task 6 specification/quality review, whole-F1 review with its scoped fix re-review, the five-fixture correction review and the required complete increment regression are accepted. The frozen `npm test` on `1d41c51` ended native 0 on 2026-09-30: 3,187 tests, 3,171 passed, zero failures/cancellations and 16 explicit skips. This accepts F1 only, not activation. The shipped promotion verifier still denies activation; public content remains unavailable.

The earlier run records below preserve their original inputs and intermediate failures. Statements that a review/full suite was pending describe those historical checkpoints; the final reconciliation section supplies the current disposition. They are not relabeled as one combined rerun or immutable binary release.

## Candidate and scope

Production source: `e109f03c9e7c5519deb62ce9d76353424714d6ca` on `codex/v2-fresh-start`; Task 6 changes only its scoped scripts, tests, package/CI configuration and documentation. The Task 6 commit is the commit introducing this evidence. Accepted implementation predecessors include Task 5 `084ac1a` and archive-manifest fix `03c4829`, independently reviewed before this task.

Local platform actually exercised: Windows x64, Node 24.16.0, npm 11.13, SQLite 3.53.0. CI retains Ubuntu and Windows jobs and Node 22.22.3 rejection. Those hosted jobs and Linux behavior were **not executed in this session**.

No live V1 content was read, imported, searched, displayed, modified, or used as fallback. Archive tests used owned synthetic sentinels and instrumented actual compiled filesystem calls. Required V1 canonical metadata inspection is distinct from prohibited content access. No reset, client change, deployment, push, merge or external upload occurred.

## Actual verification

| Command/check | Native outcome | Actual coverage |
| --- | --- | --- |
| `npm run test:build`, initial RED | 0 | New test file compiled before implementation |
| `node --test --test-concurrency=1 dist-test/tests/ci-fresh-start-foundation.test.js`, initial RED | 1 | 8 cases: 1 pass, 7 fail; first assertion was missing focused Foundation alias; runner/smoke absent |
| `npm run typecheck` | 0 | Production TypeScript |
| `npm run build` | 0 | Eight reviewed entries, including V2 server/admin and measured worker |
| `npm run test:v2-fresh-start-foundation` | 0 | One compile; repository 10/10, initializer 23/23, control plane 45/45, admission 26/26, compiled entry 9/9, Foundation CI 9/9; total 122/122, zero skips |
| `npm run test:build-artifacts` | 0 | Actual compiled worker and schema-8 upgrade; compatibility worker; private rehearsal refusal; fresh-start prepared identity/restart/redaction/content denial/archive isolation |
| `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/ci-lifecycle-gates.test.js dist-test/tests/runtime-capabilities.test.js` | 0 | 30/30, zero skips, 202.922 seconds; includes actual sealed retrieval evaluator |
| Final runner-only refinement: `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/ci-fresh-start-foundation.test.js` | 0 | 9/9, zero skips, 19.951 seconds; after bounded-exit refinement described below |
| V1 byte fence versus `0e375d4643d4b630f36f874a3bb192e96739ac46` | 0 | `src/app.ts`, `src/index.ts`, controllers, schemas, services |
| All actual tracked migrations `000[1-7]*` versus `2836eda4ce3f4808c811d6abea98e196f708cb1a` | 0 | Seven files unchanged; migration 8 remains additive |
| Task 6 `src` diff versus its source base | 0 | No production-source edits in Task 6 |
| Complete `npm test`, corrected frozen candidate `1d41c51` | 0 | 3,187 tests / 238 suites; 3,171 pass, 0 fail/cancel/todo, 16 skips; reporter duration 10,028,765.353 ms |

Raw logs, native outcomes, source/config byte hashes and per-build identities are retained under the ignored plan workspace `.superpowers/sdd/2026-09-29-v2-fresh-start-foundation/` in `task-6-*.log`, `task-6-foundation-inputs.md`, `task-6-report.md` and the final run manifest. Source text goldens normalize line endings; deployed artifacts are hashed as actual native bytes.

The Foundation run measured build identity `d7e9a1964d51edef808ef6e62a78ce0516956dfca600a108ae3db479342a93ec`. The artifact gate subsequently rebuilt the same production sources, yielding a new per-build generation. These are separate actual runs, not one fabricated combined deployment.

After those gates, a runner-only self-review refinement unreferenced owned process handles when OS termination cannot be confirmed, retaining the output lock while allowing bounded failure exit. The final nine-case runner/CI check passed against runner SHA256 `e879b90ee2d228077039732718635fea302d260c89566daeaf92ef5945f83a20`. The earlier 122/122 run is retained with its original input hash and is not relabeled as testing these later runner bytes. Production artifacts, compiled tests and package/CI inputs were unchanged; the root-owned full suite remains pending.

Two intermediate checks deliberately remained failures until corrected: the first runner check was native 1 (6/8), revealing Node's inherited `NODE_TEST_CONTEXT` could suppress child tests yet return zero; the second was native 1 (7/8), revealing Node's alphabetical discovery reordered multiple arguments. The final runner removes that inherited test-runner context only in its own orchestration children and launches each explicit target serially. Controlled compiler exit 23, real test failure, timeout 124, cancellation 130, tree termination and competing-output refusal now have observed passing assertions. No V2 production environment bypass was introduced. A patch-generation replacement-string escaping error caused one intermediate test compilation failure; it was corrected before the final gate.

## Preserved historical CI lane

Independent Task 6 review found that the original prepared-import test guard missed worker imports of the executable V2 entries and same-directory composition imports. Fix round 1 normalizes literal targets relative to their caller and validates explicit caller/target pairs, including the existing intra-V2 edges. No unauthorized production import was found, and no source allowance/baseline or production behavior changed. Three new mutations failed before repair (native 1, 0/3); the final eight selected import/isolation tests passed (native 0, 8/8, zero skips, 319.8473ms) after test compilation native 0. Logs are `task-6-fix1-*.log`; that round's test-source SHA256 is `303aaeb5f72d87660de9c4d1aff9e8802d44bf14e60c4e08b6adc2baa25028eb`. Earlier 122/30-test and build results retain their original inputs; neither slow evaluation nor the full suite was repeated for this guard-only repair.

Scoped re-review kept that finding open because raw JavaScript escape spellings could evade target normalization. Fix round 2 follows R25: reject backslashes in matched module literals before normalization or bare-package filtering, without evaluating source or speculatively decoding it. Three new escaped-literal tests genuinely failed (native 1, 0/3, 245.0712ms), covering Unicode executable entry, hexadecimal executable admin entry, and escaped same-directory composition prefix. Each covers side-effect/named imports, dynamic import, require, and re-export. Intermediate covering tests passed (native 0, 11/11, 387.6027ms). A controller check identified unsupported template module arguments in the same boundary; a new test genuinely failed on the worker backtick import (native 1, 0/1, 186.062ms). The guard now explicitly refuses backtick import/require arguments, including interpolated templates. Final compilation was native 0 and twelve selected import/isolation tests passed (native 0, 12/12, zero skips, 395.6815ms), including real shipped imports and normalized approved aliases. Logs are `task-6-fix2-*.log`; final test-source SHA256 is `a568a9971e9aa1be6778f6bedacc1deb714bf009ecbbf48e0610b603705e4665`. No production artifacts, source allowance, baseline, or runtime behavior changed. Earlier broader results are not relabeled as executing these new test bytes; scoped re-review and root-owned full verification remain pending.

The preserved Task 13B checkout was inspected read-only. Its previous dirty work is not declared passed or copied wholesale. Reconciliation retains the exact nineteen-file synthetic migration alias and private rehearsal alias, strict closed workflow grammar, unique steps, full-history checkout, immutable base and V1 fences, rollout gate, stress lane, minimum-runtime rejection, and classified upload policy. The single named Build step now follows Typecheck and precedes full tests; Foundation and artifact checks follow rollout and synthetic migration.

The future CI upload selects exactly `${{ runner.temp }}/v2-shadow-migration-functional/evidence.json`, named `v2-shadow-migration-functional-synthetic-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}`, with missing-file error and retention 14 days. The existing real fixture producer emits constrained, redacted functional evidence; this is not authorized live-V1 rehearsal or production proof. It also executes in ordinary `npm test`; no duplicate local nineteen-file run was added. The root's complete suite is still required.

Automatic approval review initially rejected the upload configuration and source-allowlist update. The human then explicitly approved the exact synthetic destination/content/name/retention and the exact 63 reviewed source paths at the source base (26 Foundation paths), with no wildcard or baseline change. Scoped retries succeeded. This did not authorize a push, hosted run or current upload. The V1 byte fence, denied public migration/test-fixture/generic append exposure, and exact prepared-composition import edges remain executable checks.

## Remaining limitations and dependencies

- F1 callbacks are trusted synchronous internal code, not an arbitrary hostile JavaScript/SQL sandbox. Native Promise misuse and escaped callback capabilities are covered; rollback-failure recovery remains unverified.
- Initialization interruption tests inject exceptions at publication boundaries and resume with a new instance. Abrupt OS death can leave `fresh-start-operation.lock`; F1 fails closed. Never remove a lock while a competing writer may be alive. A verified operator recovery procedure remains F3.
- Recovery captures the real committed tail in the same writer transaction. The Task 4 race evidence observes native `SQLITE_BUSY` before releasing a held writer and retries only inside the fixture after confirmed commit. This conservative fence is not a verified public readable snapshot.
- F1 measures actual compiled deployment artifacts and runtime, with an independent worker check. This is local artifact integrity, not signed/clean-source F3 release evidence.
- F2 must deliver public memory operations, content schemas, privacy/governance and verified readable-view semantics through the delivered admission boundary.
- F3 must deliver production evidence/verifier implementation, backup/restore/replay and verified recovery procedures, release provenance and the actual promotion gate.
- F4 owns operational archive protection, separately approved client cutover and live verification. F1's path-safety metadata checks do not freeze an archive or switch a client.

## Controller rulings carried forward

The following reproduces every R1–R25 ruling from the controller ledger, including the stated costs if wrong. Ledger order is retained.

- Ruling R1: Add `FreshStartTransaction.insertRelease(release): void` for Task 3's Disabled -> Prepared replacement. It checks installation identity, adds an immutable release only, and does not activate or overwrite anything. Cost if wrong: narrow API adjustment before Task 3; no external state impact.

- Ruling R2: Initialization must distinguish its exclusive owned journal from foreign pre-existing content. Never waive emptiness for unowned files. Cost if wrong: fresh initialization refuses safely; tests must expose recovery gaps.

- Ruling R3: Required canonical-path metadata inspection of V1 is allowed; reading/enumerating historical content is forbidden. Tests instrument content access, not required path stat/realpath. Cost if wrong: privacy boundary misunderstood; review must retain explicit content prohibition.

- Ruling R4: Approved plan test budget prevails: focused tests each task, applicable aggregate gate once at increment boundary, no per-task full suite. Cost if wrong: cross-component issue found at final boundary rather than earlier.

- Ruling R5: Normalize headings from Foundation Task N to Task N for provided task-brief helper, with no scope change. Cost if wrong: documentation heading references only.

- Ruling R6: Root alone performs memory lifecycle start/context/selfcheck/end for this delegated session to avoid known singleton supersession. Agents return durable evidence to root; no direct vault edits. Cost if wrong: individual agent activity logged in root session rather than separate sessions.

- Ruling R7: Enable repository-local Git core.longpaths for Windows checkout, after native worktree creation failed on existing long test filenames. No global setting changed. Cost if wrong: local Git configuration can be unset; filenames themselves unchanged.

- Ruling R8: Task 2's preparation binding to completed foundation checks means the actual local preparation preflight (canonical paths, runtime/schema/build inspection, empty event state and verified empty projection), not a fabricated claim that the entire six-task release gate has already finished. Persist a digest of those actual checks and operator intent. F3's production release evidence remains separate and the shipped F1 promotion verifier denies activation. This resolves a self-test/initialization dependency without claiming missing verification. Cost if wrong: preparation evidence format needs revision before F3; no content availability is enabled.

- Ruling R9: Later task owners may narrowly extend contracts.ts's closed FreshStartErrorCode union for the path/initialization/approval/admission/entry errors their briefs require. Task1 correctly avoided speculative later codes; adding required typed errors is not permission to weaken existing decoders/state-change contracts. Cost if wrong: error contract versioning adjustment before public F2 composition.

- Ruling R10: Task2 may require an internal constructor build-inspection port because actual compiled fresh-start deployment artifacts are delivered in Task5. Missing/unverified inspector fails closed; tests hash their owned fixture artifacts. Task5 must supply real consistent measured deployment identity across admin/server/worker. Existing private migration rehearsal build evidence is not substituted. Cost if wrong: internal constructor/measurement adapter changes before F1 completion; production promotion stays closed.

- Task2 Ruling R12: narrow optional bootstrap constructor hooks reserveStoreId(descriptor,route) and beforeStorePublish path recheck are within Task2's allowed publication/resume seam. Default behavior for existing callers stays unchanged. Journal durably reserves canonical IDs before publication; initialize-local cannot recreate acknowledged/published missing data. Sync/await semantics must enforce completion at the real boundary. Cost if wrong: internal bootstrap seam adjustment; no external activation or source content access.

- Task 1: fix round 1/5 (2 addressed,0 open; async rejection and escaped getter/proxy; commits baf03f2..9f13206). Ruling R11: trusted synchronous internal callbacks, not an arbitrary hostile-JavaScript sandbox; ordinary accidental native Promise rejection remains covered. Reviewer withdrew adversarial Symbol.species variant after finding no production use and confirming no general standard observation without mutating caller/global state. Cost if wrong: future hostile/custom Promise integration needs explicit contract. Final reviewer must see task-1-rereview-1.md and rollback-failure limitation.

- Task2 Ruling R13: The approved interruption contract is fault injection at each publication boundary followed by resume in a new instance. Abrupt OS death may leave the exclusive operation.lock and must fail closed; do not add unsafe stale-lock stealing or claim complete killed-process recovery. Carry the stale-lock/manual recovery procedure limitation to the Task2 report, final review, operations documentation and F3. Cost if wrong: an operator must perform a separately verified recovery procedure after an abrupt death before initialization can resume; availability is reduced, not data silently recreated.

- Ruling R14: Task3 uses trusted server-provider boundary classes that strictly decode/copy/freeze provider results and privately mint runtime-provenance values. No exported raw mint helper, test registration, env bypass or MCP-supplied provider. Constructors are server DI, not proof of authenticated operator consent; F3 supplies real verifiers and F1's shipped verifier stays closed. Tests use fake providers inside that trusted boundary and must reject structural forged results outside it. Cost if wrong: F3 adapter contract needs revision; production activation stays unavailable.

- Ruling R15: Task3's internal policy-only recovery transitions may preserve existing fence values, null until Task4 wires capture, without fabricating zero or claiming writes drained. Task4 must capture actual committed position/hash in the same writer transaction for both operator and automatic recovery. Task3 is not exposed as a standalone production entry. Cost if wrong: incomplete admission boundary until Task4; final F1 gate must not accept it unresolved.

- Ruling R16: Task4 may add FreshStartTransaction.captureRecoveryFence() as a transaction-lifetime-checked delegate using the repository-owned connection and guard, with no raw connection exposure or nested BEGIN. Backend may have a trustedFreshStartBuildInspector internal option; missing measurement refuses fresh opening, worker measurement is independent of requested/echoed hash, and Task5 wires real compiled artifacts. Validate actual release schema identity too. Cost if wrong: narrow internal API needs adaptation before Task5; final F1 cannot pass without real measurement wiring and both recovery paths captured.

- Ruling R17: Add narrow lifecycle-command.processor.ts guard integration plus affected focused tests to Task4 scope, because renewRootLease owns a separate BEGIN IMMEDIATE near1220. Root inspected the actual transaction. Classify that lease operation against explicit housekeeping policy; do not treat every bounded operation as safe. A module-private WeakMap of immutable connection context registered by trusted composition is acceptable, with no command bypass or fresh-missing fallback. Cost if wrong: additional bounded-operation regression; verify actual side effects and preserve legacy behavior.

- Ruling R18: Add a narrow lifecycle-query.service.ts read() admission check inside its existing BEGIN DEFERRED before authority/content reads, because factory-returned runtimes can bypass the outer backend check. Root inspected read() near418 and activeChildDiagnostic's delegation near513. The guard and returned data share one snapshot; no wrapper-only check or nested transaction. Valid authorized direct-runtime negative test plus legacy query regression required. Cost if wrong: protected read behavior regression; keep implementation to this owned boundary and preserve legacy semantics.

- Ruling R19: Task5 may add src/v2/build-identity.ts and, if separation materially helps, scripts/fresh-start-build.js. Independent F1 deployment measurement binds the three actual compiled V2/admin/worker entries and execution dependencies using bundled dependencies, embedded per-build generation nonce, exact emitted artifact hashes and runtime identity. Missing/mismatch refuses with redacted typed errors. Preserve legacy worker behavior, private migration sealing and installed dependency versions. A rebuild may change the identity; release manifests bind the exact build. This is not signed or clean-source F3 release evidence and does not enable promotion. Cost if wrong: internal measurement/release-manifest format must be adjusted before F3; production availability remains closed.

- Ruling R20: Task5 may narrowly update tests/v2-shadow-migration-rehearsal.test.ts's current-byte build fixture to capture scripts/fresh-start-build.js and actual dependencies required by newly bundled V2 entries. Existing fixture copies only old build scripts and esbuild/obfuscator/TypeScript/zod; build.js now unconditionally imports the new helper and builds MCP SDK entries. Preserve capture correspondence, source/index immutability, clean fixture and private migration sealing assertions. Verify the affected real fixture build; do not alter migration business logic or label the old migration release gate complete. Cost if wrong: fixture dependency snapshot adjustment; production behavior unchanged, legacy regression evidence must remain truthful.

- Ruling R21: Task6 may move the single CI Build after Typecheck and before npm test; compiled entry cases require the actual built V2/admin/measurement artifacts in a clean checkout. Reconcile exact-step assertions while preserving lifecycle/immutable-base/V1 byte fence/rollout and classified synthetic migration coverage, plus Foundation and artifact checks. Audit task-6-ci-reconciliation-audit.md is read-only and establishes no old migration gate pass. Cost if wrong: CI execution ordering correction; verify executable workflow contract without weakening legacy or minimum-runtime/stress checks.

- Ruling R22: Add scripts/fresh-start-build.js to rehearsalRecipePaths in scripts/run-v2-shadow-migration-rehearsal.js and the existing stale/corrupted recipe test loop. The new helper executes during build and must be included in direct recipe byte measurement while preserving old clean-source/tool/input/artifact/sealing checks. This is a dependency/provenance integration, not a demonstrated prior bypass; ordinary dirty edits are already rejected by cleanBuildHead. One relevant stale-helper rejection check suffices if entry/worker inputs remain unchanged. Cost if wrong: recipe snapshot adjustment/rebuild of sealed private artifacts; no promotion enabled. Necessary narrow integration under R19's preservation requirement, not an expansion of migration scope.

- Ruling R23: Reject multi-link release manifests before any content read, retain canonical/archive/regular-file guards and redacted typed errors; test actual compiled hardlink alias and actual reader boundary, not only pathname-under-archive instrumentation. File-handle-bound metadata may be used for reader consistency; no unrelated filesystem redesign. Cost if wrong: deliberately hardlinked local manifest must be supplied as independent ordinary file; archive content privacy retained and no promotion enabled. Scoped defect correction is authorized; fresh re-review must inspect084ac1a..fixHEAD only.

- Ruling R24 / direct human scope: exact reviewed current source allowance is63 paths at e109f03 versus sealed68e77fa,26Foundation paths since2836eda. No wildcard/baseline replacement and V1 byte fence plus public migration/generic-append denial unchanged. Root measured protectedV1 native0/no differences. Human explicitly approved this exact reconciliation and historical functional-synthetic/OS/run/attempt artifact naming within one redacted syntheticJSON/retention14, excluding push/launch/uploadnow/liveV1/credentials. Accepted ADR and exact authorization file persisted; original implementer resumes blocked scoped changes. A transient owned CI-parser edit contains duplicated text; root flagged its actual location for mechanical repair before verification, no new runtime scope.

R24 cost if wrong: correct the exact source allowance or synthetic transport classification and repeat affected CI review; no current external upload or production activation is authorized.

- Ruling R25: An import-fence module literal that cannot be safely interpreted must fail closed, never be treated as an unrelated unprotected target. Safe refusal of escaped/unsupported spellings is acceptable instead of speculative decoding; ordinary shipped imports and existing normalized approved targets remain valid. This enforces the approved exact boundary without source/runtime widening or executing source to decode it. Cost if wrong: a future escaped source import must use canonical spelling or a separately reviewed safe decoder; no current production behavior changes.

- Ruling R26: Require a complete canonical single quoted-string argument for executable import/require calls on guarded production entry sources. Unsupported/computed/parenthesized/template/extra argument shapes fail closed before target normalization; syntax-aware extraction using an existing development dependency is allowed in this CI test only, without executing source or adding a package. Preserve static imports/exports and approved normalized caller/target edges. This closes the demonstrated argument-expression hole rather than adding spelling-specific regex exclusions. Cost if wrong: future legitimate computed or noncanonical module calls must be rewritten to canonical literals or separately reviewed; no current production behavior/source allowance/baseline changes.

## Final whole-F1 fix wave — local verification only

The whole-F1 review found one Important remaining guard gap: matching only a quoted prefix accepted concatenated, parenthesized, and variable import/require arguments. The test-only guard now extracts complete syntax nodes using the existing TypeScript development dependency. It requires exactly one unwrapped quoted-string argument, rejects unsupported call forms before normalization, and retains raw-escape refusal and exact approved caller/target pairs. Static imports/exports remain inspected; no source is executed or speculative string decoding performed. The exact63 source allowance, baselines, V1/public denials and production artifacts are unchanged.

Genuine RED: compilation native 0, ten selected new tests native 1 (one canonical/trivia control passed, nine failed). Eight failures were missing refusals; the type-assertion case was refused only later by the target check, not at the required shape boundary. Intermediate compilation then exited native 2 because the inferred callee variable type was too narrow; an explicit `ts.Expression` annotation corrected it. No tests ran after that failed compilation. Final compilation native 0; selected covering tests native 0, 22/22 passed, zero skips, 1406.6926ms. Coverage includes concatenation, parentheses, variables, conditionals, comma expressions, spread/missing/extra arguments, type assertions, templates, raw escapes, whitespace/block/line-comment trivia, static imports/exports, approved aliases, and real shipped sources. Logs: `task-6-final-wave-*.log`. Final test-source native-byte SHA256: `feaaa0dd6f7762bb6697d168f3c3a6b0ae0a3fe8715a2cc27fa1387c91dfd3da`.

This appends R26 to the carried R1–R25 record. The one final scoped re-review and root-owned frozen complete suite remain pending. No production build, artifact gate, slow evaluator, whole Foundation gate, hosted CI or full suite was rerun in this wave; earlier results retain their original input correspondence. Production implementation remains incomplete and activation remains unavailable.

## Final F1 reconciliation — 2026-09-30

Reviewed code/guard fixes are accepted through `5a17c68238ffda6cc87e14bf79742386129849b9`. The final scoped review addressed the whole-F1 review's one remaining Important finding, with no new Critical/Important or Minor findings. That review was not repeated. The initial full regression on that source genuinely ended native 1: 3,187 tests, 3,166 pass, five failures, 16 skips and zero cancellations. Its original raw output is retained; the failures are not hidden or reclassified as success.

The five failures were strictly test-fixture drift in three files. Correction `bd3592998685baff6749d8c7c44106c45d4c0ece` adds only the exact installation-absence query to two strict legacy connection doubles and updates current-registry expectations to schema 8 in MigrationRunner and provider-keyed qualified-integrity fixtures. Historical migration/rollback assertions and all production/configuration bytes remain unchanged. One compilation and the three entire files passed 71/71, native 0, zero skip/cancel; independent spec and quality review accepted the exact batch. Later fingerprint-lineage assertions were actually reached. The final aggregate below, not the 71-test scope alone, closes the increment.

Before the corrected aggregate, fresh `npm run typecheck` and combined `npm run test:build-artifacts` (including its real build and compiled smokes) ended native 0 on clean `1d41c5186a022e83774b7f3e9f941b137947be0c`. Earlier 122/122 Foundation and other scoped results keep their original input identities; the current full suite covers the reviewed later test corrections. No unnecessary per-fixture repository run or repeated broad review was added.

### Complete corrected aggregate

- Run: `full-suite-1790771147267-22720`; command `npm test`; source `1d41c5186a022e83774b7f3e9f941b137947be0c`.
- Capture start/end: `2026-09-30T12:25:47.268Z` / `2026-09-30T15:13:40.057Z`; native test exit and capture-wrapper exit both 0, signal null, launchFailure false, captureErrors empty.
- Actual summary: 3,187 tests, 238 suites, 3,171 passed, 0 failed/cancelled/todo, 16 skipped; reporter duration `10028765.353 ms`. Skips remain skips; hosted CI/Linux/stress capabilities not exercised here are not claimed passed.
- No indented or top-level failure markers in the complete stdout. Stderr is empty. stdout SHA-256 `ca678d77ffe63e3e5fa60e7ed6e43f5f7c7011a74581acfd854023a0918018cc`; stderr SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Capture reports `sourceUnchanged:true`, `configurationUnchanged:true`. Post-compilation and native-end snapshots contain the same 794 files / 145 compiled test files, with zero changed/removed/added files and the same source commit. This is endpoint correspondence, not continuous binary attestation.

Configuration SHA-256 values are identical before/after:

| Input | SHA-256 |
| --- | --- |
| `package.json` | `81108d6a08b9fb01d060b919306e54b23378649356a62468b22e5885bc625b59` |
| `package-lock.json` | `307e5857f8803f7bdc9ba4bacc1f3a11840291d23852d49e4d3bc14fb8d08006` |
| `tsconfig.json` | `378b844a67cb3ce6606a93fc21980c9b7ef441b5fac129988920984d3ece95e7` |
| `tsconfig.test.json` | `ba64c0e92b67ce747d4e348b3281600a0e9cab489637649e6c82e188bef409ad` |
| `.github/workflows/ci.yml` | `cd46e2d12358e093649fc8d464520a0a04efac61071997a5f0900d144f18e498` |

The suite owns a root deployment rebuild. Initial build identity was `bb9ae1015c3a733ef67619616e56be5e5675a0314d47b89e928173a92570102d`; final identity is `917a8696bb87fb67c2b1ebd8ef5cf5a4e287365a28eedc73267b397af0331f83`. The four deployment outputs changed (generation nonce); `deploymentArtifactsUnchanged:false` is retained, not silently rewritten. This accepts a source/config regression run, **not** a single immutable F3 release. Both sets of raw artifact hashes remain in the capture result.

Final deployment-output SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| `dist/v2-build.json` | `a344a0cce28433be9ef01479df7a5e5609c6474d283e9a3fce2cac87d4e396ff` |
| `dist/v2.js` | `826bcf3a0177eac6cb018c7a0b3deed40330fbd61b45f1dc032d4ad2ebd6bd9b` |
| `dist/v2-admin.js` | `9ee1f084a72b5030828a01c8aac4afdb117121c879e5fd43848384416e64b0f3` |
| `dist/workers/project-store.worker.js` | `b4ee164593fcf3f2ac4c295fc1a3f3e6f464a863d53d756469578233c9e1e6da` |

Preserved ignored evidence includes the original and corrected `full-suite-*.stdout.log/.stderr.log/.result.json`, `compiled-inputs-1790771441729-21012.json`, `compiled-inputs-1790781276434-6892.json`, `f1-final-wave-rereview.md`, `f1-fixture-alignment-review.md` and the exact fixture batch report/diff. No live V1 migration, client configuration, deployment, hosted CI, push/merge or external upload occurred. F2 public memory/privacy/actual Codex host proof, F3 recovery/exact release and F4 authorized cutover/live checks remain mandatory.

### Remaining controller rulings (R27–R30)

- Ruling R27: One exact three-child existing-compiled checkpoint diagnostic could obtain missing runtime stacks while the original full run continued, using owned fixture roots and no compiler/build/source write. This was failure-driven diagnosis, not a green reassurance rerun. Cost if wrong: shared-output/resource interference would invalidate affected evidence and require serial verification; partial/diagnostic results never imply success.
- Ruling R28: One exact existing-compiled failed fingerprint-lineage diagnostic could obtain the unavailable assertion stack; no compile/build/source edit or root-artifact change. It confirmed stale current-schema expectations, not a provider defect. Cost if wrong: discovered interference would invalidate affected evidence; original failures and timing remain distinct from the diagnosis.
- Ruling R29: Correct all five confirmed fixture failures in one three-file batch, permitting only exact installation-absence lookup and current schema-8 target literals; preserve historical assertions and production enforcement, compile once, run whole affected files and obtain one scoped review. Cost if wrong: a newly reached failure or changed historical assertion blocks acceptance; the original native-1 aggregate remains intact.
- Ruling R30: Separate the actual native test outcome from mutable deployment-output equality in the ignored capture helper. Preserve both initial/final identities and hashes, unchanged-source/config requirements and native/signal/launch/capture failures. This does not waive the aggregate or establish F3 immutable release proof. Cost if wrong: an unattributed artifact change cannot support a binary-release claim and requires attribution; this evidence remains source regression only.
