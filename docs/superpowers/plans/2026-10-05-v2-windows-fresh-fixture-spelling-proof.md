# V2 Windows Fresh Fixture Spelling Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test whether the owned fresh fixture's root spelling explains the recorded valid-route failure, without changing production acceptance or declaring the remaining Windows families fixed.

**Architecture:** Add an opt-in owned test fixture comparing raw and native-canonical root spellings before opening descendants. Use the existing direct backend opening and fixed fresh identity/release/admission data to require generation1. Preserve the raw control, exact errors, independent resource closure and existing hostile controls; do not canonicalize existing callers automatically.

**Tech Stack:** Existing Node24.16.0 builtins, TypeScript, native node:test, SQLite and existing fresh test helpers; no dependencies or new runtime/tool/channel.

**Spec:** [Approved causal-remediation design](../specs/2026-10-04-v2-hosted-ci-remediation-design.md), especially causal proof, owned fixture spelling and preserved route/cleanup contracts. [Installation-policy A](../specs/2026-10-04-v2-build-installation-policy-a-design.md) and [CI-role design](../specs/2026-10-04-v2-fast-pr-full-release-ci-design.md) remain binding outside this narrow follow-up.

**Status:** The human approved this written plan on2026-10-05 in reply to the linked plan at commit `2f3118aa3324cdebfdf75aa30dc691e9b6323c01`. Execute its exactly three named local owners and owned verification with the preserved Subagent-Driven method. This approval does not establish completion or authorize publication, hosted actions or PROD; it does not expand the earlier installation plan silently.

**Local source checkpoint:** Task1 implementation at `f84a69132550db27366710027031dc7aef7f7ceb` passed the independent spec/quality gate after one scoped fix: fresh compiler0,17selected/17pass/0skip. Raw/native spellings are naturally equal locally, so the unequal-spelling causal control remains unverified; no default-producer, hosted, whole-Windows, Task5 or PROD fix is established. Early RED closure limits and41retained synthetic roots remain recorded in the private owned handoff, not removal authority.

## Global Constraints

- Prefer a minimal correction at the proven producer, fixture or existing implementation boundary.
- Canonicalizing an owned fixture is permitted only when evidence proves the fixture spelling was invalid and the real policy still rejects hostile aliases and replacements.
- Derive all downstream fixture paths consistently from the verified root; leave deliberately malformed inputs intact.
- Preserve ownership-aware cleanup of only the created root; canonicalization must not redirect cleanup to an unrelated target.
- Do not waive regular-file/link checks, canonical identity, symlink/junction refusal, durable containment, route binding, mutation detection, provenance or exact build correspondence.
- For each family, establish a reproducing failure on bound synthetic inputs, obtain the actual refusal reason, vary one relevant condition and show that the expected business assertion becomes reachable. Retain the failing control and hostile variants.
- A different exception, timeout or cleanup failure is not proof that the original guard behaved correctly.
- Do not infer an 8.3 alias or manufacture one as evidence of the reported hosted failure. If raw and native spellings are equal locally, report that causal control unverified rather than a passing reproduction.
- Diagnostics are informational, never authority: retain existing fixed schema, one record per boundary/case,16records per probe and2KiB per record. No raw path/identity/env/content/credentials/arbitrary errors in diagnostic records; unknown stays unknown.
- No source/seal/public API, workflow, package/lock, dependency, test-profile, limit/timeout, key/config, liveV1, actualdesktopcapture or PROD change. No push/merge/hosted run/rerun/cancellation from this plan approval.
- Focused affected verification only; no Linux installer repeat, full migration/parity or unchanged known-red full suite. Later final complete nonlegacy/distinct bothOS release qualification remains required.

## Review Focus

- Naturally equal raw/native spellings: canonical acceptance may pass, but the noncanonical causal control must remain explicitly unverified (Task1).
- Canonical lookup redirected to another directory: reject before database open; never use that new target for cleanup (Task1).
- Setup, backend close or connection close failure: retain the primary outcome and incomplete closure; cleanup remains independently attempted only with proved ownership (Task1).
- An unrelated assertion/error could mask route rejection: assert exact STORE_ROUTE_INVALID for a genuinely noncanonical control and generation1 for the canonical variant (Task1).
- Parent-process success could be mislabeled child or whole-family proof: keep direct-backend identity and durable passing counterexample explicit (Task1).

---

## Starting evidence and correspondence

Existing run37203356089/Windowsjob111439373333 tested merge `023c5f37d55a6e7a2955156c4a107159d633ccc4`, published head `11ba91ec1a6840cea6e961b4c3789d32f9623b9d`, base `2836eda4ce3f4808c811d6abea98e196f708cb1a`. The fresh valid representative failed STORE_ROUTE_INVALID; existing closed-schema parent/database snapshots recorded canonicalEqualfalse. These are earlier independent reads, not the actual route guard's same/sameRoot receipt. Durable parent-chain passed despite canonicalEqualfalse: no blanket cause is established.

Root native comparison confirmed all11named relevant fixture/diagnostic/guard blobs equal between published11ba91e and frozen local6adefa19c1002c6ebe42438443b7c5b82db614c1. The tested merge object is unavailable locally (native128); head correspondence is not merge correspondence. Retain this limitation before claiming a historical reproducer. Recheck only affected blob correspondence at the execution freeze; do not fetch or change external state automatically.

## File Responsibilities

| Exact future owner | Responsibility |
| --- | --- |
| Modify `tests/support/fresh-start-fixture.ts` | New opt-in owned spelling fixture with creation-boundary identity/closure; existing freshStore() and freshInitializationFixture() behavior unchanged |
| Modify `tests/fresh-start-admission.test.ts` | New named spelling-proof group and exact direct-backend reachability/hostile/cleanup assertions; original raw representative retained |
| Modify `docs/runbooks/v2-ci-causal-diagnostics.md` | Record exact source/runtime/selected counts/outcomes/closure and unverified causal controls; no other family repaired claim |

Sealed runtime route owner `src/orchestrator/runtime/project-store-worker-backend.ts` remains read-only. If its two equality checks cannot be distinguished sufficiently, return with the exact uncertainty for a private-observation amendment; do not introduce a new channel, production reason, caller-controlled path or acceptance bypass here.

## Task 1: Owned Fresh Root-Spelling Counterfactual

**Interfaces:** Add test-only `freshStoreSpellingFixture(spelling: "raw" | "native"): { connection: SqliteConnection; rawRoot: string; nativeRoot: string; openedRoot: string; rawIsNative: boolean; closeConnection(): void; cleanup(): void }` in the existing support owner. No arbitrary caller root. Capture the created raw directory's precise BigInt dev/ino/birth identity before resolving native spelling or creating/opening descendants; both spellings must refer to that same nonsymlink owner. Return paths only to the trusted test process, never diagnostic JSON. `closeConnection()` independently closes the acquired connection and latches its receipt; `cleanup()` first requires/obtains that receipt, verifies the original bound owner and refuses replacement/junction/redirection. Setup failures throw fixed `CI_FRESH_SPELLING_SETUP_INCOMPLETE`; uncertain close/cleanup throws fixed `CI_FRESH_SPELLING_CLEANUP_INCOMPLETE`, never arbitrary filesystem messages. Caller always attempts fixture connection close even if backend close fails, but calls root-removal cleanup only after both closure receipts; otherwise retain the root. An open failure without a positively acquired connection receipt cannot be relabeled closed or authorize removal. Existing two helpers keep their current signatures/behavior.

Consume the existing `active(installedRelease = release)` initialization sequence, direct ProjectStoreWorkerBackend/decodeWorkerRequest/context calls and literal FRESH_IDENTITY/release/trusted values. Add a private test helper `activeSpelling(spelling: "raw" | "native")` returning the new fixture after that same initialization/admission sequence; preserve `active()` behavior/signature/default release/producer and original callers. Controller review ruling2026-10-05 permits minimal body delegation to one private shared initializer in the same test owner, resolving plan-mandated duplication without changing those semantics. This is a controller implementation ruling, not a new human approval of default/production behavior. Experiments have independently captured roots; all semantic inputs are the same literals and the only intended producer choice is root spelling before deriving/opening events.sqlite. Any additional changed condition must be reported, not assumed equivalent.

- [x] **Step1: Freeze and review scope.** Verify isolated worktree/clean source/native pinned runtime, exact three owners and relevant starting blobs. Read parent design, tracked historical handoff and approved installation procedure. Capture ownership before any new resource. Root owns memory/ledger; one worker owns compiler/test outputs.
- [x] **Step2: Write intended failing controls.** New group name `CI fresh fixture spelling proof`. Require native fixture opening, same-owner raw/native identity and generation1 after direct backend open. Keep a raw experiment; only when its observed requested file/root spelling is genuinely noncanonical require exact STORE_ROUTE_INVALID. If naturally equal, explicitly report the noncanonical control unavailable and do not claim reproduced/fixed. Add same-owner lookup-redirection refusal before open, root replacement/junction sentinel preservation, setup failure and backend-close failure with independent connection/fixture closure and latched incomplete status. Compare booleans/exact fixed codes, not path strings in assertion diagnostics. Reuse existing bounded collector with a fresh collector per experiment, fixed admission-control/path-control roles and caps.
- [x] **Step3: Establish valid RED before helper implementation.** Fresh `npm run test:build`, positive compiler closure, then `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^CI fresh fixture spelling proof" dist-test/tests/fresh-start-admission.test.js`. Absent typed helper may first cause compilation failure; a signature stub must then fail owned-identity/opening/closure assertions. Unrelated error, native setup denial, zero selection or existing business failure is not helper RED. This TDD RED is not the hosted causal reproduction.
- [x] **Step4: Implement only the opt-in fixture and test glue.** Derive/open events.sqlite from the admitted selected spelling. Preserve existing schema/fresh initialization/release/admission data and original fixture behavior. Setup errors must release any acquired connections and retain positively owned root/closure status; no later lookup repairs lost creation identity. Native root validation happens before database open. Restore test-local fault hooks in finally. No production route mutation or forced alias creation.
- [x] **Step5: Verify focused GREEN and classify causal evidence.** Fresh compile/drain then new group. Require nonzero selection, exact intended error/business assertion, no unexpected failure, and closure receipts for every created root/connection/backend. A native-only GREEN with unavailable noncanonical control verifies capability, not cause. Run the existing exact valid representative and existing wrong-context/schema/build/release/stale-generation worker-opening controls under anchored `^worker opening independently checks fresh context:`; retain their actual failures if not yet repaired, never change expected codes. Existing genuine alias/route/replacement hostile controls stay intact. Do not replay full suite.
- [x] **Step6: Write bounded handoff.** Update only the causal runbook with each attempted source/runtime/experiment/selected native outcome, known/unknown predicates, closed resources and retained residues. Distinguish helper TDD, local raw/canonical business reachability, historical head-only correspondence and missing merge/child/hosted proof. No whole-Windows or PROD fix claim. If the raw refusal cannot reproduce locally or remains ambiguous, stop with exact pending hosted/control/private-owner authority, without retrying a product refusal into success.
- [x] **Step7: Commit and independent review.** Stage exactly the three future owners, whitespace/scope/clean-state checks, local commit `test: prove owned fresh fixture spelling reachability`. Fresh reviewer checks spec/quality, valid negative boundaries, default fixture compatibility and cleanup. No wholesale fixture repair from this proof. A later default-producer repair requires its concrete reviewed scope and proportionate verification.

## Self-Review and Execution Handoff

One independently reviewable proof task owns fixture interface, direct-backend assertions and truthful handoff together. Parent causal requirements map to exact raw control/native variation/business reachability/hostile guards/closure; all five Review Focus classes have named Task1 controls. Test helper signatures agree, existing callers remain unchanged, and no sealed owner/channel is added. No further subsystem is implemented by this plan.

The written plan is approved for execution with Subagent-Driven. Plan approval permits named local owned proof/commit/review only; it does not authorize push or a new hosted probe. Checkboxes record actual accepted work only. Complete Task5/final release/whole-system PROD readiness remains open.
