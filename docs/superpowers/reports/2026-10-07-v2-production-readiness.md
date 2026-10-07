# V2 production readiness review — 2026-10-07

Status: **production implementation incomplete**.
This report records inspection and planning evidence; it does not qualify a release or authorize activation.

## Source and observations

- Published V2 candidate: `b1646c1c8d9d04345af6d456be4f5724c7f068d2`.
- [PR #12](https://github.com/fastest4u/Awakened-AI-System/pull/12) was open, Draft and unmerged when checked through the connected GitHub API on 2026-10-07. Its base remains `codex/subproject-3-projections` at `2836eda4ce3f4808c811d6abea98e196f708cb1a`.
- [CI run 37581455661](https://github.com/fastest4u/Awakened-AI-System/actions/runs/37581455661): the API returned completed/success for Ubuntu Node 24.16.0, Windows Node 24.16.0 and Node 22.22.3 rejection. Both supported-OS jobs passed installation policy, installation, capability, runtime, typecheck, Build, immutable lifecycle baseline, V1 routing protection and default tests.
- These are PR-job observations. They do not supply the distinct candidate/control-bound release receipts or operational backup/restore evidence.
- Earlier accepted F1/private verified-read/native-content/private retained-evidence results retain their original source, synthetic scope, failures and skips. This audit did not rerun or recertify them.
- The inspected V2 candidate worktree resolved the expected HEAD, but sandbox Git status/diff could not establish tracked-input cleanliness. No clean-release claim follows from that worktree.
- The primary checkout was on `feat/per-call-project-root`, outside the V2 branch. Its existing config and memory changes were preserved.
- The older `v2-fresh-start` worktree remains at `0b836ce` with four modified and three untracked capture-observer test owners. Those observe projection-directory capture, not desktop messages. They were preserved without stash/reset/fast-forward.

## Readiness matrix

| Area | Delivered evidence | Remaining acceptance |
| --- | --- | --- |
| F1 foundation | Accepted independent empty-store identity, schema, initialization, state/admission and measured dormant entries | Does not provide public content or activation |
| F2 private read foundation | Accepted owned same-image metadata verification and bounded search/exact canonical get | List/recent/context/radar implementation and later public wiring |
| F2 private retained evidence | Accepted redaction/encrypted-envelope/private authority/replay foundation | Operational purpose-key custody, rotation and historical key recovery; erasure/restoration fences; large-frame contract |
| F2 everyday memory | Internal lifecycle/projection components exist | Governed note-style commands, promotion/correction/conflict/supersession/retraction/expiry/erasure, public root/child/checkpoint/end adapters, all-tool capability inventory |
| F2 current Codex integration | Synthetic host verifier/preparation accepted | All nine actual-host rows remain unverified: complete visible capture, schema/attribution/order, protected pre-send persistence, reconnect/lost-response, gaps/tamper, finalization and bounded failure |
| F3 new V2 recovery | Existing SQLite capability and maintenance/admission primitives | Complete verified backup, scheduling/health, isolated restore, authenticated replay to acknowledged position, key recovery and erasure after restore |
| F3 release | PR CI now green on both OSes | Frozen final source/build/config/capability/recovery identities; distinct Ubuntu/Windows qualification closure; compiled public-service release verifier |
| F4 cutover | Approved fresh-empty profile and separate read-only V1 archive direction | Exact release/target approval; stop V1 writers and verify archive protection; register V2; prove real durable workflow and backup/status after activation |

Source anchors:

- `src/v2/app.ts`: registers only `memory_v2Status`.
- `src/v2/composition.ts`: `productionReady:false` and denied content invocation.
- `src/v2/admin.ts`: initialization/resume/status, without production activation or backup/restore commands.
- `src/orchestrator/fresh-start/operator-approval.ts`: injected authentication seam and shipped denial; real providers are not operationally delivered.
- `src/orchestrator/recovery/` and `scripts/run-v2-fresh-start-release.js` are absent at the inspected candidate.
- [Approved fresh-start specification](../specs/2026-09-29-v2-fresh-start-production-design.md), sections 5–10.
- [Delivery roadmap](../plans/2026-09-29-v2-fresh-start-delivery-roadmap.md).
- [Retained-evidence qualification and exclusions](2026-10-02-v2-retained-evidence-acceptance.md).
- [Actual-host qualification report](2026-09-30-v2-codex-host-qualification.md).
- [Existing release qualification procedure](../../runbooks/v2-ci-qualification.md).

## Delivery order and next concrete review

1. Complete the independently permitted private read workflows against the delivered verified-read lane. The [new written design](../specs/2026-10-07-v2-native-read-workflows-design.md) makes ordering, cursor scope, shared context budgets and same-image execution concrete.
2. Define and deliver governed memory-command and public lifecycle/read composition contracts. Missing production features must remain visible in the capability manifest.
3. Resolve operational evidence keys, erasure/restoration fences and supported actual Codex capture. Host proof may proceed alongside independent backend work; its unknown status must not be labelled incapability or waived.
4. Build F3 backup/restore/replay and the fresh-start public-service release verifier from the actual F2 interfaces. Verify acknowledged-position preservation; report unrecoverable ranges instead of recreating empty memory.
5. Freeze the implementation candidate and run the distinct release qualification once with the reviewed exact candidate/control pair. Preserve current green PR evidence and rerun affected checks only when changed inputs or findings justify it.
6. Prepare exact release/config/target and archive/cutover instructions. Obtain actual activation approval against the completed evidence, then verify deployed workflows and backup/status.

The outstanding projection-observer amendment remains a separately approved local CI-diagnostic task. Its old incomplete evidence is not silently marked accepted; current green hosted CI also means it should not be replayed as a prerequisite to independent F2 development.

## Verification for this review

Two independent read-only audits examined F2 and F3/F4. Root read the approved specifications, delivered interfaces, pending plans and current public entrypoints, and verified PR/job metadata through the connected GitHub API. This report and next design receive document consistency/link/scope review; no product source, dependencies, runtime configuration, live data or activation state is changed.

A separate attached planning worktree was created from the exact published candidate. Native read-only Git verification confirmed baseline HEAD `b1646c1c8d9d04345af6d456be4f5724c7f068d2` and only these two new document paths; its detached HEAD is intentional. Document reference and placeholder scans passed. Independent draft review identified two context-accounting issues; the written design now defines combined follow-up truncation and conservative metadata charging with explicit metadata-only refusal. These are document checks, not product tests or a production implementation result.
