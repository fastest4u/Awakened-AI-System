# Private V2 native-content acceptance evidence

Accepted runtime source: `bb9bee4ccfe097ebe1e1929955d2bea296f1a0a4` on `codex/v2-fresh-start`, 2026-10-02. All six Native content Tasks received independent specification/quality approval. Whole-increment review found one Important forged-child item-session/visibility gap; one fix wave and one scoped re-review closed I1 with zero residual Critical/Important/new Minor findings. This accepts the private backend, not public memory, complete F2, a clean release, host qualification or PROD. The later documentation commit changes documentation only and is not source newly built/tested.

Binding [design](../specs/2026-10-02-v2-native-content-query-design.md) and [plan](../plans/2026-10-02-v2-native-content-query.md) are unchanged. [Old private metadata evidence](2026-10-01-v2-internal-verified-read.md) is an accepted unchanged baseline, not a rerun. [Roadmap](../plans/2026-09-29-v2-fresh-start-delivery-roadmap.md) preserves unfinished F2–F4.

## Source-qualified execution

| Measurement | Actual result and attribution |
| --- | --- |
| Original Task6 implementation | `c1f77c06041a383bf0f00a9498b188694ee5b985`; first gate exit1 at the new entry cleanup oracle. Corrected whole entry6/6 passed; necessary same-profile retry exit124 at900090.0041ms under the then900000ms TEST total:29/33 files,447tests445pass2skip0fail, remaining work unqualified. Both failures remain failed history. |
| Revised fixed33 gate | `npm run typecheck` exit0, then `npm run test:v2-native-content` session20491 exit0. Measured c1 plus exact binary patch SHA256 `f75c3f29c36e49f29e2c684e74675cca8d06d4cd8e68f8a4cdef5673e2dcc6a4`, subsequently identical `37bc85416d0761a8b3edeec0cb068b253dddf4c4`. One build/compile,33 serial files and smoke;36/36 outer stages code0/cleanupcomplete/Windows Job active-zero,516tests514pass2skip0fail/cancel/todo,1386458.2867ms, shared output lock absent. This is NOT later bb9bee4 gate proof. |
| Final I1 RED | Successful compiler then exact `item_session` contract/supervisor cases:56tests32pass24intendedfail. The24 contradictory broader-visibility cases fail at both operation/boundary combinations; controls passed. |
| Current amended proof | Measured37bc plus exact three-path patch SHA256 `a43ac206768ab683449efdca6905ed35b05bb4d823188d81a153726dd1955280`, subsequently identical bb9bee4. `npm run typecheck`, `npm run build`, `npm run test:build` each exit0. Initial eight-target run session60385 exit1:179tests177pass2fail0skip/cancel/todo,273092.1571ms; all56 new regressions pass. Exact unchanged existing-compiled two-case refresh36183 exit0:2/2,13706.4542ms. Fresh smoke20670 exit0. NOT a single179/179 invocation, new33-file gate or new outer Job proof. |

Current covering command was:

```powershell
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-native-content-contracts.test.js dist-test/tests/v2-native-content-child.test.js dist-test/tests/v2-native-content-supervisor.test.js dist-test/tests/v2-native-content-entry.test.js dist-test/tests/v2-internal-verified-read-contracts.test.js dist-test/tests/v2-internal-verified-read-supervisor.test.js dist-test/tests/v2-internal-verified-read-entry.test.js dist-test/tests/v2-foundation-entry.test.js
```

Only failed metadata cases were refreshed, without source/build/compiled/deadline changes:

```powershell
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='^(measured children enforce prepared fencing|cleanup entry independently measures the deployment and refuses a parent-only hash echo and unbundled entry)$' dist-test/tests/v2-internal-verified-read-entry.test.js
node scripts/smoke-v2-fresh-start.js
```

Initial fencing observed `WORKER_TIMEOUT` instead of `FRESH_START_ADMISSION_DENIED`; positive cleanup observed incomplete instead of complete before its negative controls. Neither reproduced. Original output does not establish which cleanup premise failed or a host cause; no repair/flakiness claim, budget increase or blanket reassurance rerun follows. Original cap RED's two startup-ready failures are separate non-intended setup failures with unknown cause; unchanged waits passed covering checks. Default Windows exec CryptUnprotectData2148073483 required exact-worktree escalated access, not a security bypass.

## Current measured build and closure

Current manifest `dist/v2-build.json` SHA256 `ba0e4ec2540a969ebbf6e8594682fffb19d1fdc74dbdf21a67fc957a4ff99805`; buildIdentityHash `d63020bab71b63209c4f8ccfaad4a293d1990f830044c3dd0763e09c2e902e34`; deployment `6f981858-6ec9-4bf0-880f-dc696d158b89`. Runtime Node24.16.0/win32/x64, executable SHA256 `b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3`. No clean-commit build launch is claimed: measured working bytes were correlated to the identical committed patch.

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| v2.js |1131408|7525887391815939a58c19411acf6b7ea1060b6dbeec076f1da1b0cfbebc23a9|
| v2-admin.js |904438|eebea8acde358f76697299ad47861f60add9cacfa16608f461176de3fb58cce3|
| workers/project-store.worker.js |1307051|9e4fcb37ed4ca8826faec2b6cf07262ab5ee45a176f3f7e40b306126c9feadf9|
| internal/v2-internal-verified-read.js |671427|f78cf095bbb9537d0f329dd9f0162ebffc5f8604900228fb52e724e260bd1b54|
| internal/v2-internal-verified-read-cleanup.js |45682|aea4741811a78609779a09729111cc83a45a3cae7a574c8b56d93302e9603169|

Read closure JSON SHA256 `5048eadf6b1cc2c45971aef53935ca5907f1025e1bcc7240c45d31525ab27a51`; cleanup closure `5d809082d56c23d73374e0ff9f1c653efd8f7b689843cdc1debcb16977ea418e`. Both sourceChecked/emittedChecked=true. Read includes exactly five pure retrieval inputs (contracts/database-core/eligibility/ranking/selection-core), content query/result and protocol. Cleanup remains retrieval/query/result-free with no SQLite/process/thread runtime import; shared protocol decoding is not query capability. Source/emitted graph checks exclude subprocess/thread/helper facades.

Final I1 guard is parent-only `assertNativeContentMatchesRequest`: non-null item session requires session visibility, which then requires equality with trusted binding.session. Both search/get reject forged broader-visibility relationships; genuine SQL and legacy eligibility are unchanged. The new guard is in current compiled parent validator at181–182 and consumed by compiled supervisor at294, tree-shaken from the read child, not falsely asserted present in its bundle. Both closure files capture content-protocol source SHA `f6b2a78dac01b3a91acb785f2abe9f9a754f826cbeb4c34eb0708e601e164cd6`.

## Delivered private semantics and ownership

Actual measured private search/get/metadata use genuine owned schema8 authority/schema2 projection and the same captured image, not a source echo/evaluator facade. Empty genesis, later committed minimums and reopen are exercised. Current schema2 image SHA256 `af90cdfd558385e37d7ac71f2e1f1f2efaeca8ebb89b708014f0494679068aec`, terminal12,sameImage=true. Independent wrong-deployment/source-echo/unbundled controls refuse; owned synthetic V1 sentinel records zero reads/writes, never a live vault.

Fixed canonical/exact, lexical, artifact/path, checkpoint and trusted-session follow-up channels use at most64 unique candidates and2048 estimated tokens; default limit5, integer1..10. Search is bounded to1024 UTF-8 bytes before/after NFKC+trim; exact case-sensitive ID512 bytes has no trim/normalization/key/fuzzy/successor lookup. Trusted session selection survives a project-strong receipt's null session. Eligibility/filtering precede ranking; full service fixed-unit policy and truthful status/supersession/known/valid/source-position references remain. No fake Markdown paths, event IDs or nonexistent full source body are emitted.

Detached19-scalar item DTO returns full projected canonical-summary, not full document/source evidence. Depth8/containers128/fields32/scalar2048, items10/conflicts64/channels7; complete bootstrap8192/reply16384 bytes include escaping/metadata. Packing uses whole units, conservative all-considered repository-incomplete and zero-group barriers, deterministic warnings/truncation, no clipping/refill across a barrier; exactget is all-or-nothing. Private `v2-native-content-bounds-1` complements unchanged ranking policy, not a production certification label.

One original supervisor-arrival response budget spans queue/startup/query/packing/exit: session2000/project5000ms, trusted override0..30000, queue8, one read OR cleanup child. Separate productioncleanup2000/grace<=100ms and ownershipschema1/cleanupwire1 stay unchanged; readwire2 only. No early/late success: normal success requires child image/lock closure, final original-authority revalidation and reader closure, then normal read exit and awaited ownership-record removal; the validated fence/admission and unchanged epoch must still permit acceptance within the original response budget. Failure/expiry cleanup instead requires observed read exit before a separate exact cleanup child, whose complete reply and normal exit precede ownership-record removal; uncertain closure is quarantined. Any existing record, even complete, blocks restart; uncertainty is quarantined. Native TEST total1500000, metadata900000 and separate TESTcleanup5000 are only harness limits, not inflated production bounds.

Actual blocked-query test executable uses production query/child/cleanup against genuine projection separately from the measured private entry; it is not production fault argv or a measured-entry hang injection. Current success records read null/SIGKILL, cleanup0/null, unrelated writer0/null after survival, max1,ownershipAbsent=true. Uncertain case records read null/SIGKILL, cleanup null/SIGKILL, writer0/null after survival,max1,ownershipAbsent=false and preserves original root/lock/record. Deterministic forged-child ports prove correlation/settlement, not native tree closure. Prior fixed-gate stage advancement has positive Windows Job active-zero evidence, never direct exit alone.

## Retained qualifications, rulings and unfinished work

Actual prior-gate skips are existing non-Windows containment case on win32 and manifest file-symlink EPERM. These are not freshly exercised by the current eight-target proof. M2-1: conditional Windows rename-denial branch remains unexercised, not a Node skip. M5-1: query expiry advances before SQL and packing expiry at postpacking revalidation; this proves stage boundaries, not independent synchronous packing-overrun control. Real blocked-query proof does not erase that distinction. Native containment qualification is Windows-specific.

All earlier Task5/Task6 and current15 uncertain roots remain untouched. Canonical full names are retained in local task-5-report.md, task-6-report.md and whole-fix-report.md final ownership section under `.superpowers/sdd/2026-10-02-v2-native-content-query/`. Current roots include v2-active-read-ZDnv1a/LlVbCg and13 listed v2-read-core roots. Enclosing-stage closure, helper exit, PID absence or elapsed time never authorize deletion; logs/artifacts/locks/temp roots are not staged.

Eight attributed controller rulings remain binding, not invented human approval:

1. Normalize brief-extractor Task headings only; numbering/contracts unchanged.
2. Use approved focused verification, not installs/full npmtest/migration reassurance; later release obligations remain.
3. Pin independent hand-derived fixture outcomes as well as wrapper equivalence.
4. Make test-only appendCorpus async/await genuine authorized lifecycle; empty genesis stays empty.
5. Assert real derived effectiveEvidencePolicy using synthetic trusted=true/requested=false plus `EVIDENCE_CAPTURE_INCOMPLETE`; no nonexistent launch field or live capture proof.
6. Correct actual entry oracle, then one necessary identical full gate retry; no invented owned-tail/resume selector, retain first failure.
7. Correct evidenced native-only TEST cap defect to1500000, metadata900000/cleanup5000/all production limits unchanged; retain900000 timeout.
8. Refresh only invalidated affected checks after final I1, with current measured artifacts; keep old33 gate prior-source-only and later exact-release obligations.

Public registration remains `memory_v2Status` only, `productionReady:false`, content/promotion denied, recovery `FRESH_START_CONTENT_UNVERIFIED`, current desktop `host-capability-unverified`. Policy-helper fixture proves the actual resolver/classifier, NOT live requireFullEvidence=true wiring or full capture. F2 public workflows/list/recent/context/radar/governed writes/privacy/current-desktop full visible-evidence capture and live enforcement, F3 new-V2 recovery/exact release, F4 approved activation/live verification remain incomplete. No V1 migration is required; no actual deployment/promotion/push/merge/CI run occurred.

## Preserved raw evidence pointers

Local reports/ledger are preserved, not duplicated here: task-6-report.md, whole-fix-report.md (corrected1001lines), whole-fix-review.md (33lines), progress.md (eight rulings), all under the local `.superpowers/sdd/2026-10-02-v2-native-content-query/` directory. They contain full commands, failures, stage counts, source/build identities, retained roots and serialized memory closure.

Raw log SHA256s: original revised fixed gate `77c4da6f34981b513f9eff8e82289719a3e9d4b343427559362ffabf0bd3d7b7`; current whole-fix-green.log `b3200ee77ea3dfdce63e93d8024caeb3ac9701748f3c10f92e36c78e92fc5966`; unchanged exact refresh `29d29a6c0490efa8a0df01245b44b71dac41a9b97b4cc8c6cdfefb7956a76623`; smoke `a93e2d70ed71a0ac79d6f7ef20ff5fb9cef3537c26766ee61af017a15fcbb33e`; current identity check `6d86aeb21ccbcac2ba83ae743c8a154a37aeec15f92f507fa6123550f33b944d`. Both earlier failed gate logs stay preserved with their hashes in task-6-report.md. No old full-suite/migration evidence is rewritten or promoted to current proof.
