# V2 internal verified-read acceptance evidence

Status: **Accepted private increment, Tasks1–6 complete**, on 2026-10-01. Accepted implementation source is `b948ed7c21354dca61ab6cfd2b3c519ea7a1f6cd` on `codex/v2-fresh-start`. This document records controller acceptance after independent task review, whole-increment review and its clean scoped re-review; it is not deployment, release certification or whole-system PROD readiness.

Authority: [approved design](../specs/2026-10-01-v2-internal-verified-read-design.md) at `37d31d1`, [six-task plan](../plans/2026-10-01-v2-internal-verified-read.md) approved at `1d215cb`, and [written restart amendment](../specs/2026-10-01-v2-verified-read-restart-amendment.md) at `e6e1f67`, with amended Task5 steps approved by `go` at `9a705ab`. Existing Subagent-Driven execution was retained; no renewed method approval or live activation was inferred.

## Delivered scope and unchanged boundaries

The private `verify-published-view` operation returns a bounded detached metadata receipt. It verifies actual locked image bytes, metadata and required committed position between authoritative snapshots; fences recovery/epoch changes; and releases success only after positive image/reader/lock/child/ownership-record closure. It does not return memory content or implement public search/get/list/context-pack, governed writes or an arbitrary evaluator.

Public registration remains `memory_v2Status` only, with content/promotion denial, `productionReady:false` and `requireFullEvidence:true`. V2 starts empty without importing, consulting or falling back to V1 Markdown. No live transcript, credential, host config/trust/install, existing-store reset, push/merge, hosted CI, artifact upload, deployment or activation occurred. Accepted test-profile separation at `eb94a32` remains unchanged; default, full and migration lanes were not replayed for reassurance.

Production bounds remain session-strong2000ms/project-strong5000ms, trusted integer override0..30000ms; one arrival-based monotonic response budget; eight unsettled requests; one read or cleanup child; manifest64KiB/image64MiB; bootstrap/ownership8KiB; receipt16KiB. One fixed2000ms cleanup window starts when the response lane closes **or normal exit is requested**, includes at most100ms grace, and never resets. Any existing ownership record, including complete, refuses replacement until the creating owner actually removes it. Unknown disposition retains quarantine; late positive closure permits only a fresh adapter, never revival of the old outcome.

## Accepted task and review chain

| Task | Accepted source / verification scope |
| --- | --- |
| 1: Contracts and bounded protocol | `caeb0de`;9/9 focused, independent review clean. |
| 2: Direct image/metadata primitives | `2165223`;66/66 focused. Historical affected coverage92passes/1unchanged native skip includes original run plus serialized39/39 integrity repair, not a new combined run. |
| 3: Authoritative admission | `7534b81`;32/32 new and52/52 prescribed regressions. Carried fixture-cleanup observation closed by Task4. |
| 4: Fixed read/cleanup children | `4ec0470`;130/130 final grouped, compiler/typecheck0, independent review clean. Pure genesis constant value/export compatibility preserved. |
| 5: Durable supervisor/ownership | `5921627` plus `428ae46`;candidate49/49, then final covering supervisor38/38/typecheck0 and clean scoped re-review. Ownership15/15 is retained from the candidate run, not invented final53-case coverage. |
| 6: Measured deployment and focused gate | `f69b82a` wiring, `d491e62` test corrections, `2a247c2` native gate closure/independent-refusal correction, and `b948ed7` final whole-increment corrections. Source-qualified execution details below. |

Initial Task6 independent review identified two Important findings: direct child exit did not prove stage-tree closure, and wrong-deployment/runtime negatives could fail through stale digest/authority rather than their intended guards. `2a247c2` corrected both; its fresh scoped re-review addressed both with zero new findings. Recorded failed fixture premises and partial runs remain disclosed, not relabeled GREEN.

Whole-increment review covered approved `1d215cb..2a247c2`, including accepted profile interactions, and found three Important plus one Minor issue. One bounded correction wave `2a247c2..b948ed7` and one fresh scoped re-review closed all four:

| Final finding | Accepted correction |
| --- | --- |
| I1: Locked manifest continuity after image capture | Compare actual locked manifest bytes/device/inode/size/SHA/private ctime after generation capture under the same token; changed, replaced, rewritten or missing manifest refuses. Legacy raw helper/512MiB behavior unchanged. |
| I2: Fixed normal-success cleanup window | Start the single2000ms clock before exit/removal, including real delayed unlink; later expiry/cancel cannot reset it. Timely success remains required within the original response budget. |
| I3/O1: Unsafe positive fixture finalizers | Await pending disposition and require positive native stage closure plus actual output-lock release before owned-root disposal; uncertainty/assertion failure retains evidence. |
| M1: Known projection-wait expiry | Timer and monotonic fallback return `PROJECTION_LAG` only in known wait. Emit capture before actual synchronous generation read. Unknown authoritative required positions remain null, not fabricated from request lower bounds. |

Final scoped verdict: **4 addressed,0 open;0 new Critical/Important/Minor findings;0 out-of-scope observations**. Controller accepts this cumulative implementation and closes this increment. No further whole-review loop was run. The review does not waive remaining F2/F3/F4 requirements.

## Native execution evidence — identities kept separate

Commands were serial; no compiler overwrote `dist-test` while these final checks consumed it. The original Task2 overlap limitation is preserved historically; later serialized evidence is not retroactive attestation of that earlier output.

| Execution | Native result / monotonic duration | Qualification |
| --- | --- | --- |
| Original Task6 genuine RED |27tests/0pass/27fail,exit1,51221.8251ms | Before wiring; earlier declaration/compiler failures are not feature RED. |
| Original committed increment gate on `f69b82a` |423tests/422pass/1existing Windows skip/0fail/0cancel,exit0;gate679813.7735ms | One build, one compile, fixed20serial files and smoke. Historical output; initial native-tree assurance was superseded by subsequent correction, not silently accepted. |
| Test-only correction at `d491e62` |27/27,exit0,89265.6176ms command | Only two affected files; no production/artifact change. Not a new full gate. |
| Native gate correction through `2a247c2` |Final6controls6/6,exit0,22363.2484ms;typecheck0 | Repaired exact-old-runner RED uses post-parent descendant acknowledgment. Earlier17entry and13-case gate runs retain their own qualified identities, not a fabricated final aggregate. |
| Final-wave genuine RED |15tests/4pass/11fail,exit1,13386.3907ms | Real manifest/native ownership boundaries and deterministic supervisor clock paths reproduced all four findings. |
| Five complete affected files |156tests/155pass/1intentional non-Windows skip/0fail/0cancel,exit0,264287.0068ms | Core41/child37/cleanup14/supervisor48/gate16. **Before final capture-stage reorder**; final core/cleanup/gate bytes, earlier child/test bytes. Not a final156-case run. |
| Supporting actual capture-phase RED |7tests/6pass/1fail,exit1,4293.9410ms | Actual generation-open observer proved phase was still wait; fixed within the same wave. |
| Final entire child + supervisor |89/89,exit0,97781.5218ms | Final child39 and supervisor50; current changed source/test bytes. |
| Final typecheck |exit0,16109.4899ms | Final source bytes immediately before commit. Test-only TS2683 during an earlier compile was corrected and retained in history. |
| One clean committed measured rebuild |exit0,36165.4957ms | Existing `node scripts/build.js`, clean `b948ed7`, no manual artifact/stamp patch. |
| Measured entry + Foundation entry |26/26,exit0,126291.492ms | Final source/new deployment; private entry17, Foundation9. Actual publication/reopen/fencing, independent refusals, copied deployment and public/V1 isolation. |
| Existing fresh-start smoke |exit0,12163.7684ms | Same new deployment: prepared identity, restart, redaction, content denial and archive isolation. |

Final covering commands:

```text
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-internal-verified-read-child.test.js dist-test/tests/v2-internal-verified-read-supervisor.test.js
npm run typecheck
node scripts/build.js
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-internal-verified-read-entry.test.js dist-test/tests/v2-foundation-entry.test.js
node scripts/smoke-v2-fresh-start.js
```

The fixed gate remains `npm run test:v2-internal-verified-read`: TEST ceiling900000ms plus one at-most5000ms owned-process cleanup window, not production settings or a duration promise. No final20-file/default/full/migration/rehearsal replay was performed after the final wave. Directly invalidated checks and the new measured rebuild were run instead, as the approved plan requires. Isolated scripted gate fixtures did not recursively run the repository gate.

## Final measured deployment

Source: `b948ed7c21354dca61ab6cfd2b3c519ea7a1f6cd`.

Build identity: `10a99c3b3778e8f96db1d79fe48c5b9905dc471f09cc3bbb2cc9b8d7608f04a5`.

Deployment: `8592e19c-c203-4f39-b328-217940c44338`; manifest SHA256: `db683e7c933275c4bbf9307f1499b575bbbd09ed950718b96ca2449731e502af`.

| Artifact | Bytes | SHA256 — manifest/current/snapshot agree |
| --- | ---: | --- |
| v2.js |1131408|a3605d5d358935cb0e39934d3f2b509dc9a546b340605bc61c17e2f9d5f3d074|
| v2-admin.js |904438|4c3df94edb0b7aeee515a9ec06dfe44bd3385719d44c0dfaaa1ed638959219de|
| workers/project-store.worker.js |1307051|40edbe92266b12e5d22246afaa46b40c6a022bc17b87c8bf2ee307920f7a1657|
| internal/v2-internal-verified-read.js |620468|e4c2614185b47af6d5b9a7553530f99dba9642135ef0eccc0ab81e3453080b9c|
| internal/v2-internal-verified-read-cleanup.js |45075|f30e9508becc7d84d1283efb2a9382ec44e1b1aee23f57e67a2f6cb38bbecdc6|

Read closure42captured inputs, cleanup13; all current input hashes agree. Full metafiles/source/emitted checks are retained, with no subprocess/thread runtime imports in either production child. Closure-file SHA256: read `53c7ccb90958b98434a4d5f59714519f430bdffa4d6992aeb50f958405e45a71`; cleanup `8fb92e6a1897038d240ce7a3a1231449ae70063911c029f7d362826a37b2d0f4`. Controller and independent scoped reviewer separately rehashed the artifacts; reviewer also rehashed all55inputs and the seven corrected source files. Historical eight-file deployment snapshot remains unchanged.

Measured runtime: Node24.16.0,win32,x64; Node executable SHA256 `b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3`; esbuild0.28.2/TypeScript5.9.3 already installed. Config/recipe hashes: package.json `c85a83eda8754af1ccb2bdd8a7a7625395d96b1ca20b081064434dad64545223`; package-lock.json `307e5857f8803f7bdc9ba4bacc1f3a11840291d23852d49e4d3bc14fb8d08006`; scripts/build.js `160c2ada12db1893d969f9fc697f5896342af79d128afa2cb9e4975fd7c20bbd`; scripts/fresh-start-build.js `57d8a375df6b84d5ebff440a1fe799b584646230281403a962d6e4a5b27d4c62`. Full tool/config/input identities are in retained provenance.

Separate shadow-rehearsal metadata became `eligible:true` after the clean direct build; its previous retained gate snapshot was `eligible:false` because the held output lock appeared untracked. No collection/policy bypass or rehearsal execution/acceptance occurred. Build eligibility is not privacy/recovery/release proof.

## Retained evidence and limitations

Owned ignored workspace: `.superpowers/sdd/2026-10-01-v2-internal-verified-read/`. Complete briefs, task reports/reviews, immutable diff packages, `whole-increment-review.md`, `whole-increment-fix-report.md`, `whole-increment-rereview.md`, and `progress.md` retain the causal history. `whole-fix-native/` contains exact commands, before/result records, full stdout/stderr, `final-audit.json`, `final-provenance.json` and the new `deployment/` snapshot. Earlier `task6-native/gate-deployment/` is historical, never relabeled. This tracked document is redacted summary, not raw evidence upload.

The small direct-core fixture was omitted from the original per-run hash recorder (`recorded:null`); its final SHA is verified and source was unchanged after its affected run, but no missing historical hash is fabricated. Interim failed runs, the test-only compiler error, insufficient earlier descendant premises, baseline finalizer-removal wording and the whole-review harness-only failed probe remain disclosed in the reports.

TEST native stage-tree proof uses a fixed OS-bundled private PowerShell/.NET Windows Job bridge: atomic Job assignment, no breakaway/inherited proof handle, positive original process exit, Job-active-zero, drained outputs and helper closure. Windows10/Server2016+ with those capabilities is prerequisite; unsupported platforms fail closed. This is not privileged/service-broker containment. Non-Windows refusal was not executed on this Windows host. Native Windows file-symlink EPERM and unmeasured native replacement branches remain limits; real junction/narrow stat coverage is not relabeled native file-link success. Cooperative pathname checks are not hostile atomic compare-delete/ABA protection.

Unknown/lost/delayed-helper/startup/changed-lock fixtures retain their owned roots and uncertainty records. The whole-review failed-probe root and all earlier retained roots were not deleted or reconciled. Their presence is a filesystem observation, not liveness, successful closure, PID kill or time-based reclamation permission; separately trusted reconciliation remains outside this increment.

## Remaining production work

Follow the [fresh-start roadmap](../plans/2026-09-29-v2-fresh-start-delivery-roadmap.md): remaining F2 public native retrieval/lifecycle/governed writes/privacy plus actual current-desktop visible-evidence capture and private closure; F3 preservation/recovery of **new V2 data**, privacy/erasure/key restoration and exact-release verification; F4 explicitly approved client cutover/live workflow proof. No old V1 data migration is reintroduced. This completed private subsystem cannot certify these unfinished capabilities or authorize activation.
