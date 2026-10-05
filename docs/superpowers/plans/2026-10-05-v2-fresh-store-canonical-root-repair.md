# V2 Fresh Store Canonical Root Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the default owned fresh-store fixture's noncanonical Windows path producer without relaxing production route admission.

**Architecture:** Resolve the native spelling immediately after creating and identifying the fixture root, before opening SQLite or deriving descendants. Bind both spellings to the original directory owner and keep cleanup attached to that owner. Preserve the separate opt-in raw spelling experiment as the negative control.

**Tech Stack:** Existing Node 24.16.0, TypeScript, node:test and SQLite; no new dependencies.

**Spec:** [Approved causal-remediation design](../specs/2026-10-04-v2-hosted-ci-remediation-design.md), especially causal proof and owned-fixture repair. [Installation Task 5](2026-10-04-v2-build-installation-policy-a.md) remains open for final both-OS qualification.

**Status:** The human approved this written three-owner repair plan on 2026-10-05 in reply to the linked plan and approval request. Execute the named local repair and verification using the preserved Subagent-Driven method. This is one prerequisite repair for Task 5, not a new product feature, hosted-action authority or permission to mark Task 5 complete.

## Evidence and scope

The starting source is `2486d57bef0430507f73f4871ab414cb796764e5`. Existing direct-backend tests compare independently owned raw/native fixture roots with identical initialization inputs. A process-local selection of the OS-reported existing short spelling of its temporary directory supplies an unequal-spelling local control; it creates no alias and changes no persistent configuration. The actual preflight proved both spellings identify the same precise BigInt directory owner. Fresh compilation exited 0; the two-case test exited 0 with 2 passes, no failures/skips/cancellations, in 2033.1483 ms: raw refused exactly `STORE_ROUTE_INVALID`, native reached generation `"1"`, and both passed independent closure/root-removal assertions. The check used `--test-isolation=none`; it is a local synthetic mechanism check, not a hosted-run or test-child equivalence claim. The original default helper itself has not yet been run under this condition; Step 1 requires that RED before repair.

Historical hosted `STORE_ROUTE_INVALID` and noncanonical snapshots remain head-only evidence. The tested historical merge is unavailable locally, and this repair cannot establish other Windows families' causes. Keep those limitations even if the focused tests pass.

## Global Constraints

- Modify only the three owners named below, plus this plan's status after accepted work.
- No production `src` edits, source-seal changes, public API, configuration, dependency, workflow, profile, timeout, V1, credential or PROD changes.
- Preserve `freshStore(): { connection: SqliteConnection; cleanup(): void }`, schema/identity/time/busy-timeout values, and all callers. `freshInitializationFixture()` and the opt-in raw/native proof retain their behavior.
- Native spelling is selected before database creation. A later PRAGMA filename must not repair already-derived identities or serve as a connection-identity attestation.
- Capture original BigInt device/inode/birth identity before resolving native spelling. Both spellings must identify the same nonsymlink directory; never adopt a redirected lookup or remove an unrelated target.
- Cleanup closes the fixture connection and verifies the captured original owner before recursive removal of that owned fixture. Existing callers may create their own marker leaves; do not reuse the opt-in proof's SQLite-only leaf whitelist for the default fixture.
- On failed ownership/closure, retain the root and preserve the primary error. No guessed residue cleanup. Test fault hooks must be restored.
- Keep exact production refusal codes and hostile controls. No new skip, arbitrary caller root, forced alias, weakened guard or fabricated historical reproduction.
- Compile once per changed source, then focused verification. Do not replay unchanged installers, full migration/parity or the known-red full suite per edit.
- Final complete nonlegacy and distinct release qualification on Ubuntu and Windows remain required; this repair alone cannot close Task 5.

## Review Focus

1. Existing short TEMP spelling: default valid backend opening must reach generation `"1"`; the opt-in raw route must still refuse exactly `STORE_ROUTE_INVALID`.
2. Canonical lookup redirected to another owned directory: refuse before SQLite open; preserve the outside sentinel.
3. Directory or junction replacement after creation: cleanup must not traverse/remove the replacement or its target.
4. Setup or connection-close failure: preserve the original error and retain uncertain resources instead of claiming complete cleanup.
5. Other freshStore callers create marker leaves: normal cleanup must remain compatible with repository, admission and retained-evidence tests.

## Task 1: Repair and verify the default fresh-store producer

**Files:**
- Modify `tests/support/fresh-start-fixture.ts`: only default `freshStore` root preparation/owned cleanup and minimal private ownership support needed by it.
- Modify `tests/fresh-start-admission.test.ts`: focused default-producer ownership regression controls; do not change existing expectations.
- Modify `docs/runbooks/v2-ci-causal-diagnostics.md`: exact observed proof, repair and remaining limits.

**Interfaces:** Keep the existing `freshStore` signature above. Consume unchanged `active()` initialization and `ProjectStoreWorkerBackend`. Keep `freshStoreSpellingFixture("raw" | "native")` as a separate unchanged control, with raw rejection and native generation 1 assertions.

New default-fixture ownership refusals have fixed matching `code` and `message`: `CI_FRESH_STORE_ROOT_INVALID` before opening SQLite; `CI_FRESH_STORE_CLEANUP_INCOMPLETE` when cleanup cannot establish ownership. A separately thrown setup or connection-close error remains that same primary error object; a cleanup attempt must not replace it. These are private test-helper errors, not production protocol additions.

- [x] **Step 1: Freeze and establish original RED.** Verify clean reviewed source and compile. Under the same process-local, same-owner existing short TEMP/TMP spelling, run only `^worker opening independently checks fresh context: valid$` with native Node `--test --test-isolation=none --test-concurrency=1 --test-reporter=spec` against `dist-test/tests/fresh-start-admission.test.js`. Require the actual `STORE_ROUTE_INVALID` failure; an unrelated error is not valid RED. Restore TEMP/TMP. Preserve positive/unknown cleanup disposition and any uncertain root without deletion.
- [x] **Step 2: Add default-owner regression controls.** Use the test-name prefix `CI fresh default fixture`. Assert native database spelling; redirected lookup refuses before open; directory/junction replacements preserve sentinels; setup and connection-close failures preserve their primary outcome and do not remove uncertain roots; normal cleanup removes an owned marker leaf. Use owned synthetic resources and precise creation identities, not arbitrary caller paths. Run these controls before the implementation to record intended failures. Report unsupported native symlink capability separately; do not skip the entire group.
- [x] **Step 3: Repair only the default producer.** Capture the created raw root, validate native lookup against its original BigInt owner, derive/open `events.sqlite` from the native root, and retain original-owner closure/cleanup checks. Preserve original schema and return shape. Do not canonicalize forged route inputs or alter `freshInitializationFixture` or production guards.
- [x] **Step 4: Run focused GREEN.** After one fresh successful compile, run `^(?:CI fresh default fixture|CI fresh fixture spelling proof: (?:native|raw) direct opening$|worker opening independently checks fresh context:)` under the existing short TEMP/TMP spelling. Require default valid generation 1, exact unchanged eight worker-context outcomes, native generation 1, raw `STORE_ROUTE_INVALID`, all new ownership controls and positive closure. Preserve exact counts and process exit; restore environment in finally.
- [x] **Step 5: Cover unchanged callers.** Under the ordinary environment and normal test isolation, run serially `dist-test/tests/fresh-start-repository.test.js`, `dist-test/tests/fresh-start-admission.test.js` and `dist-test/tests/v2-retained-evidence-migration.test.js`. These are the currently inspected default-helper consumers; do not run the complete V1 migration profile. Record actual failures/skips and run `npm run typecheck`. No guard/expectation weakening to obtain a green result.
- [x] **Step 6: Review and hand off.** Update the causal runbook with source, commands, runner/environment differences, outcomes and resource closure. Commit exact scoped owners and obtain independent spec/quality review. Check this task only after acceptance; leave installation Task 5 unchecked until its separate final qualification prerequisites are met. Preserve all earlier failed evidence and retained resources.

## Self-review and handoff

The plan covers one demonstrated local producer mechanism, keeps the production policy unchanged, and maps all five review classes to direct assertions. The default fixture needs cleanup compatible with marker leaves, so delegating it wholesale to the stricter opt-in proof is explicitly excluded. A normally isolated run covers the execution-only runner difference; hosted source/OS qualification remains pending. No timing improvement or whole-Windows repair is promised.

Local repair implemented at `fb0f990e680bfc1387a6f5e01fb484d9ae70ae46`. Independent task review accepted spec compliance and quality with zero Critical/Important issues; two nonblocking test-quality minors are recorded for final increment review. Final increment review is pending. Installation Task 5 remains open.

Step 4 is completed under a recorded execution ruling: sandbox rename permissions prevented the two replacement cases under the short TEMP spelling, and the captured sandbox parent no longer existed in a later elevated call. No elevated-short test or replacement parent was substituted. The same-call short-path GREEN selected the six other new controls, eight unchanged worker contexts and two direct raw/native controls: 16/16 passed, no skips, native exit 0. Ordinary native, normally isolated coverage included both replacement cases and every test in all three caller files: 64/64 passed, no skips, native exit 0. Combined short-spelling plus replacement behavior remains unverified and is not a hosted-equivalence claim.

Original default RED reported the exact `STORE_ROUTE_INVALID`; valid replacement RED reported two missing ownership refusals. Four source-state compiles and final typecheck reported native exit 0. Compiler/typecheck/preflight/original-RED exits are implementer execution-report evidence; they are not independently preserved in the saved GREEN runner-output logs. The first original-RED observer could not save its resource ledger, so its closure remains unknown. Later resource receipts are separate evidence, not reconstruction. Retained resources and failed attempts are preserved. See the causal runbook for commands, closure accounting and remaining qualification limits.
