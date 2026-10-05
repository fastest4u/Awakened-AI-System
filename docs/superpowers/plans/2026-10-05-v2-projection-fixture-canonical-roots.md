# V2 Projection Fixture Canonical Roots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair proven Windows spelling failures in the coordinator, manifest and integrity test fixtures while preserving production path guards and positively owned cleanup.

**Architecture:** Introduce one test-only root owner, separate from the widely consumed `canonical-temp.ts`. First make the three fixture owners safe to exercise, then compare their real operations with raw/native spellings and correct only producers supported by that evidence. Existing hostile inputs, native operations and assertions remain; no production acceptance policy changes.

**Tech Stack:** Existing Node 24.16.0, TypeScript, node:test, Node filesystem/SQLite builtins and existing projection implementations; no new dependency.

**Spec:** [Approved CI remediation design](../specs/2026-10-04-v2-hosted-ci-remediation-design.md), especially Windows fixtures, causal proof, cleanup and completion. The [causal diagnostic plan](2026-10-04-v2-hosted-ci-causal-diagnostics.md) requires a reviewed scoped plan for subsequent repairs. This is a prerequisite of [installation-policy Task 5](2026-10-04-v2-build-installation-policy-a.md), not its final qualification.

**Status:** Approved by the human on 2026-10-05 in reply to the linked-plan handoff. Execute with the already selected Subagent-Driven method. Approval authorizes the named local changes, owned tests and scoped commits only; it does not authorize publication, hosted actions or PROD. Checkboxes record accepted proof, not approval alone.

## Global Constraints

- Fresh empty V2; no live V1 Markdown, actual transcript, credentials, configuration or PROD changes.
- Keep every lexical/canonical identity, nonsymlink, containment, replacement, publication, source binding and child-protocol guard unchanged. No `src/`, scripts, workflows, dependencies, source allowlists, test-profile membership or timeout changes.
- Do not delete tests, weaken assertions, turn failures into skips or replay legacy migration/parity. Preserve deliberate invalid paths exactly as invalid inputs.
- Use only fresh owned synthetic roots. Capture raw creation identity with BigInt before native lookup; derive normal descendants consistently from the chosen proved root. Never canonicalize a cleanup target afresh to choose another directory.
- Retain roots on unknown ownership or uncertain resource closure. A passing operation or an expected refusal does not excuse cleanup failure. Never recursively clean old retained evidence or guessed temporary paths.
- Diagnostics retain their existing allowlist, at most 16 records per probe and 2 KiB per record. No raw paths, identity numbers, database contents, arbitrary errors/stacks or new child stdout/stderr channel.
- One owner of compiler/test outputs at a time; compile once per changed source state and drain it before tests. Focused controls precede the complete affected files. No unchanged known-red full-suite replay per edit.
- Supported Ubuntu and Windows qualification remains separate. Local short-path proof is not historical hosted causation, child-local proof or release qualification.

## Review Focus

1. Native lookup redirects to another root: no database work or removal there; outside sentinel unchanged (Task 1).
2. Created root is renamed/replaced or becomes a junction: cleanup refuses without following the new target (Task 1).
3. Setup or close throws: all positively acquired resources get their owned close attempt, deletion is withheld on uncertainty and the original operation error survives (Tasks 1–2).
4. A fixture passes an early snapshot but fails another actual boundary: retain that distinct refusal; do not describe it as a spelling repair (Task 2).
5. Canonical producer repair accidentally normalizes hostile descendants or relies on mocked success: real publication/integrity and existing hostile assertions must still execute (Task 3).

## Evidence and exact owners

Starting source is `0af1a8d4b0710e9cc68ab1b15329902bf4bd93f1`, branch `codex/v2-fresh-start`, managed V2 worktree. The three test owners are unchanged from published `11ba91ec1a6840cea6e961b4c3789d32f9623b9d`. Remote comparison of that head to historical merge `023c5f37d55a6e7a2955156c4a107159d633ccc4` returned no changed files; this is remote comparison metadata, not a local merge execution proof.

One fresh compiler passed. The unchanged owned stable-capture control passed twice, one test each, zero failures/skips: ordinary TEMP accepted raw/native with spelling equality; verified same-parent short TEMP refused raw with exact `PROJECTION_PATH_INVALID` while accepting native. All nine parent identity/spelling preflight booleans passed, cleanup assertions passed and TEMP/TMP were restored. The test did not emit an actual guard predicate trace. These results justify the next comparison, not automatic repair of all three families.

Historical Windows job `111439373333`, run `37203356089`, associates the manifest representative's failure-detail window with `MATERIALIZATION_CONFLICT`; that code can wrap stable capture refusal and is not a unique refusal-site receipt.

| File | Responsibility |
| --- | --- |
| Create `tests/support/owned-projection-fixture.ts` | Original-root ownership, chosen spelling and owned close/cleanup state only |
| Create `tests/owned-projection-fixture.test.ts` | Real root/SQLite and isolated fault controls for the helper |
| Modify `tests/projection-coordinator.test.ts` | Root producers, owned fixture resources and actual coordinator counterfactual |
| Modify `tests/projection-manifest.test.ts` | Root producers and actual publication counterfactual; preserve existing mutation children |
| Modify `tests/projection-integrity.test.ts` | Root producer, setup/close handling and actual replay counterfactual |
| Modify `docs/runbooks/v2-ci-causal-diagnostics.md` | Durable evidence/disposition and exact verification limits |
| Update this plan | Accepted checkpoints only; do not close parent Task 5 |

Do not edit `tests/support/canonical-temp.ts`, `fresh-start-fixture.ts`, other family owners or sealed production sources. Existing accepted fresh-store and installer proofs are not repeated. An unrelated failure stays a separate disposition.

## Task 1: Test-only owned root and close lifecycle

**Files:** Create the two helper/control files above.

**Interfaces:** Export `createOwnedProjectionFixture(prefix: string, spelling: "raw" | "native" = "native"): OwnedProjectionFixture` and this private test-support type:

```ts
interface OwnedProjectionFixture {
  readonly rawRoot: string;
  readonly nativeRoot: string;
  readonly root: string;
  closeWith(close: () => void): () => void;
  retain(): void;
  cleanup(): void;
}
```

`closeWith` is registered immediately after acquiring an actual fixture resource, before schema/setup. It returns the sole idempotent closer used by that fixture. It calls the original close once, records success only after return, and latches uncertainty on a throw; it does not mutate/proxy resource objects or forge provenance. Cleanup attempts all still-unattempted registered closes, then removes only the captured original root if all closes and ownership checks succeed. With no acquired resources, ownership alone permits removal of an otherwise valid empty/file-only fixture. `retain()` irrevocably forbids removal but does not prevent remaining owned close attempts.

- [x] Add tests named `owned projection fixture binds both spellings before use`, `owned projection fixture refuses redirected native lookup`, `owned projection fixture retains replaced roots and outside content`, `owned projection fixture does not traverse a junction target`, `owned projection fixture closes resources before removal`, and `owned projection fixture latches close uncertainty`. Assert original BigInt dev/ino/birthtimeNs correspondence, native root selection, real SQLite closure, outside sentinel preservation, no repeated close after failure and no deletion after uncertainty. Keep stable birth identity distinct from mutable ctime.
- [x] Establish intended RED using a compiling minimal helper skeleton; capture exact failing assertion/native exit, not a missing-module or compiler error. Fault controls must restore hooks in `finally`; independent control-owned cleanup must validate its own original roots. A genuinely unavailable native junction is reported explicitly, never substituted by injected metadata.
- [x] Implement the interface using raw `mkdtempSync`, immediate BigInt `lstatSync`, native realpath and same-owner checks of both spellings before returning. Revalidate both spellings against creation identity before removal; never traverse a junction/symlink target. Retain on partial setup/identity uncertainty. Fixed helper errors are `CI_PROJECTION_FIXTURE_ROOT_INVALID` and `CI_PROJECTION_FIXTURE_CLEANUP_INCOMPLETE`; original resource errors remain available to their direct caller without diagnostic serialization. Successful cleanup is idempotent; uncertain cleanup never retries into success.
- [x] Add `owned projection fixture preserves primary setup failure` using a real acquired database plus controlled schema/close faults. Assert original setup error identity, positive close attempt and retained root when close fails. A test double proves only its injected fault branch, not actual native closure.
- [x] Run `npm run test:build`, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/owned-projection-fixture.test.js`. Require zero failures/cancellations, report all actual passes/skips, native exit 0 and settled processes. Commit only these owners and obtain scoped review before consumers change.

Accepted Task 1 (2026-10-05): commit `2226d2124209fa45cbeae8e87ede56eca4a491f7`, exactly the two named owners. Intended runtime RED was 0/7 pass with seven assertion failures/native1 after successful compilation; earlier compiler permission/type errors and two sandbox rename refusals are excluded attempts, not behavioral RED. Final fresh compiler0 and complete helper controls7/7/native0/0fail/0skip/0cancel exercised real Windows junction and SQLite closure. Independent spec/quality review approved with no Critical/Important/Minor findings. All owned processes settled and exact scope/clean Git state verified. This is local helper evidence, not consumer integration, Ubuntu or Task5 release qualification.

## Task 2: Safe consumers and three independent business counterfactuals

**Files:** Modify the three named projection test files; helper changes only if needed to meet its reviewed interface, with covering helper tests.

**Interfaces:** Consume Task 1. Keep existing test-local fixture return shapes compatible. Integrity `FixtureOptions` may gain only optional `rootSpelling: "raw" | "native"`; its existing `createFixture(options: FixtureOptions = {}): Promise<Fixture>` remains the entry. Extract coordinator `assertV2Adoption(t: TestContext, rootSpelling: "raw" | "native"): Promise<void>` and manifest `assertManifestPublication(t: TestContext, rootSpelling: "raw" | "native"): void` from their existing representative bodies, including the original business assertions and protected cleanup. Ordinary producer calls remain explicitly `"raw"` until their family has the evidence in this task. The explicit spelling option is test-only, not an environment-driven production switch.

Partial implementation checkpoint (2026-10-05), **not accepted Task 2**: `a1d7aaeee35d53fdfd8a6d7df2cdae710b08b4cc` changes exactly the three assigned consumers, preserving raw defaults and production code. Intended lifecycle RED was two close-attempt assertions failing after compiler0; the unmatched manifest wrapper makes that initial Node summary3tests/1pass/2fail/native1. Final compiler0 and amended lifecycle controls2/2/native0 in ordinary context plus2/2/native0 in an independently proved short-parent context passed. The unchanged business-control source passed ordinary5/5/native0, where raw/native spellings were equal. Earlier compiler permission/type failures, constructor-wrapper failure and the later lifecycle textual-spelling assertion failure remain excluded/failed attempts, not causal evidence.

The native execution context's COM parent had valid ownership but equal short/native spelling, so its conditional matrix was not launched. The controller recorded a bounded execution-context ruling: one same-call COM preflight and the named controls in default sandbox, the context of the earlier accepted short control; no alias creation/discovery or parent transfer. That preflight passed, but the matrix remained5tests/0pass/5fail/native1. Coordinator/integrity native operations reached real reconciliation mutation and refused with underlying rename EPERM; their raw exact public refusal and forwarding inspection results do not observe private stable capture. Manifest raw capture actually refused, native capture returned, and later real publication refused; its later cause is not inferred from neighbors. A subsequent lifecycle assertion correction received only changed-code lifecycle coverage in both contexts, not another business-matrix replay. TEMP/TMP were restored and all owned processes drained. Deliberate close-uncertainty roots remain retained; no old evidence was removed.

Full Task2 remains blocked on per-family actual-boundary attribution and native short-spelling business success. Independent partial scoped review of `011d5db..a1d7aae` returned **Needs fixes**: no Critical, two Important (raw coordinator/integrity controls omit expected phase and nonempty inspection assertions; shared safety/evidence blocks are duplicated), and two Minor (manifest's unused inspection assertion is vacuous; lifecycle path assertions lowercase on non-Windows too). None is silently waived; no checkbox below is accepted yet. The shared-support extraction requires resolving the current exact-file/interface restriction explicitly. Complete affected-file verification, Task3 producer changes and final review have not run. A different test-parent/execution arrangement or private observation amendment needs concrete authority; these results do not authorize broader retries, production-source changes, hosted actions or a Task5 completion claim.

- [ ] Add integration controls `coordinator fixture retains root when source setup cannot close` and `integrity fixture retains root when source setup cannot close`. Inject faults only in the isolated test owner, restore in `finally`, assert the original setup error, actual acquired close attempt, withheld removal and no database open against a redirected root. Record intended RED before the corresponding lifecycle correction; helper-only fake closures are insufficient. For pre-repair RED, have the controlled close throw only after the test independently observed native close returning: the fixture must treat the throw as uncertainty, without exercising unsafe old deletion against a genuinely open database. Label this injected branch accurately.
- [ ] Replace raw string root registries with original owner objects in these files, preserving existing prefixes. Register all fixture-acquired database/snapshot closes immediately. Use file-local closers keyed by the original resource when existing return shapes require it; never proxy a provenance-bound connection. Protect coordinator `sourceDatabase` setup before its first `exec`; protect integrity setup before schema application. A failed acquisition without a returned handle must retain the root if closure cannot be proved. Replace swallowed close failures with retained-owner failure. After-each cleanup must attempt remaining owners even if one fails and report failure without replacing the primary test error. Preserve existing child ownership/closure behavior.
- [ ] Extract each representative's setup/business assertions without relaxing them. Keep the original names: `adopts a staged V2 generation before publishing its manifest authority`; `serializes canonical bytes and publishes only through a safe projection directory`; `returns a frozen pass report only for an exact authoritative replay`. Add separate `projection spelling control: coordinator`, `projection spelling control: manifest`, and `projection spelling control: integrity` tests that choose raw/native at root production, with otherwise identical synthetic inputs and fresh owned fixtures.
- [ ] Run the controls first with ordinary TEMP, then with an existing OS-provided short spelling whose parent is proved same-owner in the same execution context. Use COM `Scripting.FileSystemObject.GetSpecialFolder(2).ShortPath`, BigInt lstat before native lookup and dev/ino/birthtimeNs equality; require unequal lowercase-resolved spellings. Do not manufacture an alias, discover unrelated aliases, reuse a sandbox parent across calls or persist environment changes. Restore TEMP/TMP in `finally`; failure of that preflight stops the short matrix, not a broader retry.
- [ ] Record actual operation phase/error separately for each raw failure and native success. Assert the owned root's raw spelling is genuinely non-native and all other root predicates pass. At the real stable capture, compare the existing actual boundary outcome with the fixed expected refusal; do not relabel snapshots as actual predicate observations. Manifest may use its existing `directoryOperations` seam only as a forwarding observer around the real capture, preserving exact result/error. Do not replace native implementation with a successful fake. If coordinator/integrity rejection remains ambiguous, report the exact boundary and stop that family's producer repair for a separate private-observation amendment; no sealed-source or protocol edits in this plan.
- [ ] Native variants must reach the full original business assertions: coordinator published V2 file/hash/staging cleanup; manifest canonical bytes plus lock/private-entry cleanup; integrity frozen exact report plus unchanged source/generation hashes. Preserve the failing raw control and real hostile alias/replacement controls. A raw pass, different failure, timeout or uncertain cleanup is an unresolved result, not a reason to normalize that family.
- [ ] Compile once after each necessary source change. Focused command: `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="projection spelling control:|fixture retains root when source setup cannot close" dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-manifest.test.js dist-test/tests/projection-integrity.test.js`. Record selected counts, native exits, unsupported capabilities and positive closure per run. Short-path expected refusals must be exact asserted controls, not unexpected suite failures. Commit scoped changes and obtain per-family evidence review before Task 3.

## Task 3: Correct proved producers and verify the affected increment

**Files:** Same three test owners; `docs/runbooks/v2-ci-causal-diagnostics.md`; this plan.

**Interfaces:** For each independently proved family from Task 2, change only its ordinary root producer selection from `"raw"` to `"native"`. All normal descendants use `owner.root`. Keep `"raw"` explicit in the counterfactual, and leave relative/parent-escape/junction/replacement/forged inputs untouched.

- [ ] Record expected RED for that family's original representative under the verified short parent before changing its ordinary producer; safe lifecycle from Task 2 must already be active. Change the producer only after the raw refusal and real native business success are both established. Do not infer all manifest/integrity/coordinator branches or other test files from one representative.
- [ ] Compile once, then run the original representative and its retained spelling/hostile controls under both verified parent spellings. Require intended positive/negative assertions and resource cleanup to finish, zero unexpected failures/cancellations and native exit 0. Native mutation child success/refusal is established only by the real operation, not the parent snapshot. Do not replay unchanged accepted helper controls unless their code/integration changed.
- [ ] With source frozen, run `npm run typecheck` and the complete affected files once: `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/owned-projection-fixture.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-manifest.test.js dist-test/tests/projection-integrity.test.js`. On Windows use the same verified short TEMP context to cover every adopted default producer; retain all skips with their exact capability reason. Keep the normal-temp focused evidence separate. If another branch fails, diagnose its actual assertion; no unreviewed owner expansion or repeated unchanged full run.
- [ ] Update the causal runbook with tested HEAD/diff, Node/OS, commands/counts/exits, failed attempts, actual family dispositions and closure limits. Distinguish directly observed refusal from static inference and historical metadata. Record other Windows failure families and final both-OS gates as pending, not repaired by this increment.
- [ ] Commit exact changed owners, obtain scoped reviews and final whole-increment review using the preserved Subagent-Driven process. Check this plan only for accepted proof. Do not close installation-policy Task 5: final frozen-candidate complete nonlegacy and distinct release qualifiers on Ubuntu/Windows still require their existing evidence and separately authorized hosted action.

## Self-Review and Handoff

- Spec mapping: owned/consistent roots and resource closure → Task 1 and Task 2; independent actual causal comparisons → Task 2; minimal proved producer correction and hostile preservation → Task 3; unchanged contracts and both-OS completion limits → Global Constraints and Task 3.
- All five Review Focus cases have named tests or explicit actual-boundary checks. The helper interface is identical in its consumers; no new production interface, trust input or recorder schema is introduced.
- Scope is six implementation/documentation owners plus this plan. No implementation or new diagnostic matrix was executed while drafting it. Human review is complete; proceed with Subagent-Driven and record actual verification/review before checking completion.
