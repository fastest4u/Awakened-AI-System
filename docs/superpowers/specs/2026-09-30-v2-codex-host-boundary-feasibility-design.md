# V2 Codex desktop host-boundary feasibility design

**Status:** Referenced design authority for the preparation plan explicitly approved by the user on 2026-09-30. The [approved preparation plan](../plans/2026-09-30-v2-codex-host-probe-preparation.md) implements only independent synthetic verification and read-only qualification. This does not approve real-host setup, trust/configuration changes, a new user-owned conversation or production activation; the remaining actual-host requirements still need a reviewed mechanism-specific execution addendum.
**Authority:** Approved fresh-start production design and delivery roadmap; applicable umbrella sections 9, 10, 14, 19 and 21.8.
**Target:** The user's current Codex desktop, with empty project-local V2 and no V1 import, retrieval or fallback.

## 1. Outcome and scope

Establish whether one supported integration on the actual running desktop can deliver complete eligible visible frames and transport-private lifecycle authority. Produce a bounded synthetic proof and an honest capability-gap report before expanding public mutations. This is one host-boundary feasibility slice, not implementation of all F2 privacy/content features.

Success means independently proving complete capture of the declared synthetic conversation, correct root/child attribution, stable retries, private credential isolation and final-response ordering. An installed version, hook declaration, contiguous ordinals assigned only to observed frames, or a passing mock cannot establish that outcome.

No live V1 data, current real conversation transcript, real credential or hidden reasoning is read. The probe uses an explicitly authorized isolated synthetic conversation and an empty, owned temporary store. It cannot activate F1, register public V2 content, replace the chosen client or weaken `requireFullEvidence=true`.

F1 correction/release checks proceed independently. F2 production implementation still requires F1 acceptance and separately reviewed public-write, raw-evidence/privacy and governance work. F3 recovery/release and F4 cutover remain required.

## 2. Verified inputs and what is not established

- `PrivateAuthorityChannel` already separates attachment, local delivery and descriptor routing; `LifecycleExecutionResult` separates public results from private delivery status. These are reusable server seams, not an implemented desktop adapter.
- `SessionEndStatusV2` already exposes a stable workflow identity, phase and evidence-window state. Existing phases distinguish `requested` from `completed`.
- Current public V2 exposes only `memory_v2Status`. No complete public lifecycle wire contract or production raw-evidence store is delivered by this probe.
- Existing coverage accounting reports `contentRetained:false`; fingerprints alone are not encrypted full-conversation retention.
- Earlier read-only package inventory found installed desktop `26.928.1915.0`. Installed package and CLI version do not pin the process actually serving a probe.
- Official documentation describes hooks and custom app-server clients. Excluded hook paths, nullable/unstable transcript schemas and trust requirements mean documented hooks are a candidate, not complete desktop proof. A custom client is not an authorized substitute for the selected desktop.

Discovery must bind the running build, supported mechanism and schema before executing capture. A mechanism with no independently checkable complete visible-frame feed or protected authority boundary is reported as unverified/unsupported; no invented callback or undocumented desktop attachment is allowed.

## 3. Authorization boundaries

Written-spec approval permits writing a concrete executable plan, not executing it. That plan must identify exact setup actions and receive review before implementation.

Before any real-host setup, enumerate its exact configuration/installation/trust changes, host-side storage, synthetic conversation creation and cleanup. Obtain the separately required human authority for those actions. Approval of this direction does not authorize reading current transcripts, scanning secret-bearing configuration, trusting hooks or creating a new user-owned Codex task.

Read-only capability discovery may inspect supported documentation, non-secret running-build metadata and known schema definitions. It must not enumerate process command lines, environment secrets, historical conversations or unrelated client files.

Temporary roots are explicitly owned and isolated from both V1 and production V2. Cleanup affects only validated probe-owned paths and preserves the redacted evidence report; failed cleanup is reported, not hidden. No existing store is emptied or silently reused.

## 4. Public identity and private authority

Public session/workflow identifiers are selectors, never bearer authority. Reuse existing typed session/workflow IDs; do not rename a capability to make it look public. Trusted project/workspace/role binding comes from the host adapter, not model-controlled fields.

All session handles, resume tokens and capability/encryption material remain in the existing transport-private boundary and protected host-side storage. They are absent from model-visible tool arguments/results, child prompts, captured content, logs and reports. Older umbrella wording about returning `sessionHandle` is interpreted as trusted-adapter delivery, not placing a bearer credential in `publicResult`.

The probe uses a disposable authority sentinel generated and inspected only by trusted test code. It reports pass/fail and non-secret attribution, never the sentinel or its storage contents. It tests both actual outbound model-visible surfaces and capture/log boundaries; testing only a server response object is insufficient. If those boundaries cannot be instrumented, privacy proof remains unverified.

Allocate and durably persist command, idempotency, frame and batch send identities before first transmission. A dropped response/reconnection reuses the same identities and recovers one result through existing pending-authority/result seams. A public ID, continuity key, client label or retry is not permission to mint new authority. Protected persistence must actually survive the tested reconnect/restart; a process-local mock is not host persistence proof.

## 5. Visible frame and completeness contract

Eligible categories are visible user/assistant messages, visible MCP tool names/redacted inputs/redacted outputs, structured child reports, artifact/file/test/Git/external-source references, and user corrections/retrieval feedback. Hidden reasoning and private credentials are excluded before capture, not filtered after durable storage.

Use the umbrella frame fields: stable conversation/frame/idempotency IDs, ordinal, bound session and optional child ID, visible role, RFC3339 timestamp, content type/redacted content, tool-call/result correlation, referenced artifact hashes and previous-frame identity. Positions use existing decimal-string wire rules; do not invent caller-selectable role/binding fields. Schema/size bounds are pinned in the executable plan from the actual supported mechanism and existing contracts.

The synthetic expected manifest is created independently of the adapter's observed stream. It names the expected visible-frame identities/categories, root/child ownership, call/result correlation and final assistant frame. Compare both exact membership and ordering. Missing an entire frame class must fail even if observed ordinals are contiguous. Duplicate delivery with the same identity/content has one result; changed content under the same identity, foreign binding, unknown shape and broken predecessor/order fail closed.

The host must distinguish capture completeness from retained-content readiness. A successful host probe is not permission to advertise production `full-adapter` capture. Actual production retention still needs redaction before authenticated encryption, key recovery and governed erasure from the approved raw-evidence design. Synthetic probe reports retain only allowed non-secret metadata, hashes and outcomes; no real-content durable plaintext fallback is introduced.

## 6. End acceptance versus completed closure

The root protocol can request a durable session end before the model's final reply. Expose truthful existing workflow status: `requested`/ending means accepted, not completed. This avoids holding a pre-final tool result waiting for an assistant frame that can only arrive after that result.

After the final visible assistant frame is observed, the trusted host delivers its stable evidence batch and drives the existing phased end workflow through a supported private continuation. It seals the evidence window and final checkpoint only after completeness checks. A failed/lost response resumes the same workflow/command identities; it does not close another session or append a second terminal result.

The closure boundary is the last completed visible turn in the declared ending scope. Host-only finalization is control traffic, not a fabricated assistant/tool conversation frame. If the selected mechanism renders additional eligible visible content, it must account for that content before closure; it cannot silently exclude a visible tool result. Any unexpected late frame prevents the strict completion claim. Later user work requires explicit continuation/new bound work rather than appending uncaptured frames to a closed scope.

Missing final frames, unexplained gaps or an unavailable private continuation leave strict end incomplete with a precise non-secret reason. Ordinary MCP calls alone never satisfy full capture. No assumed hook, filesystem transcript watcher or endless status-poll loop substitutes for a supported host completion signal.

## 7. Bounded proof and negative matrix

Run one baseline synthetic scenario and its necessary deterministic variants, serially with owned bounded resources; do not rerun the repository-wide suite for every scenario.

| Proof | Required observation |
| --- | --- |
| Actual host pin | Running desktop build, documented mechanism/schema and authorization record match the run; installed-package metadata alone refuses host-proven status |
| Complete conversation | Independent manifest matches every eligible visible frame, including user correction, tool arguments/result, structured child report, references and final assistant response |
| Attribution/isolation | Trusted root/child/project/workspace bindings enforced; a child cannot end the root; foreign scope is rejected |
| Private authority | Disposable sentinel absent from every actually instrumented model-visible/capture/log surface; protected retry state remains private |
| Lost response/reconnect | Identity persisted before send, exact retry reuses it, one durable result and correct owner generation after recovery |
| Missing frame/class | Drop an interior ordinal, a whole eligible class and the final frame separately; each blocks strict completion with the correct gap/category |
| Unknown/tampered shape | Unsupported schema, conflicting same-ID payload, wrong predecessor and wrong scope refuse without dumping input |
| End ordering | End request is accepted before final response; completed status occurs only after final-frame batch and seal; duplicate/late delivery cannot manufacture completion |
| Bounded failure | Detached host/private storage/continuation or deadline failure reports unverified/failed status, retains recovery identity and cleans only owned processes/roots |

Bind each row to actual host observations plus production seam behavior where available. A harness-only fake proves a unit contract, not that the desktop supplies the frame or private channel. Lack of observability is `unverified`, not a fabricated negative or positive capability verdict.

The executable plan defines one total probe deadline, bounded frame/batch sizes and exact supported shapes before execution. Timeout/cancellation/launch failure cannot produce a complete native success report. Do not inflate production deadlines or relax privacy to make the probe pass.

## 8. Report and gate disposition

Report version, source/config identities, actual host/mechanism/schema pin, authorized synthetic binding, native outcomes, expected/observed frame counts and hashes, exact missing categories/ordinals, correlation/ownership checks, private-boundary checks, retry/end ordering and cleanup state. Do not include transcripts, raw paths, credential contents, hidden reasoning or plaintext keys.

Closed dispositions:

- **host-boundary-proven-for-declared-fixture:** every row passes on the pinned actual host. This authorizes neither production capture nor activation; separately reviewed F2 implementation and operational proof remain.
- **host-capability-unverified:** a required interface, observation or actual host pin could not be established. Name the exact missing proof and next authorized diagnostic, without claiming the desktop is incapable.
- **host-capability-unsupported:** a pinned documented/observed limitation conclusively excludes a required capability. Ask the user for the resulting scoped client/policy decision; preserve the current policy until explicitly amended.
- **probe-failed-or-incomplete:** native failure, lost evidence, timeout, cancellation or incomplete cleanup. Preserve evidence and diagnose; never mark a requirement passed.

If discovery finds no viable supported candidate, stop before trust/setup and produce the precise gap report. Do not silently switch to a custom app-server client, tool-only capture, a weaker evidence setting or a transcript parser presented as complete capture.

## 9. Handoff and self-review

After written-spec approval, prepare the small host-first executable plan using actual source interfaces and supported mechanism discovery. Preserve the selected Subagent-Driven method. Execute only its approved stages; host setup has its own exact authority boundary.

After a successful probe, design the production adapter and raw-evidence/governance integration from the proven seams. A production verified V2 read-lease/consistency adapter can be planned independently after F1 acceptance; it is not evidence that the host/privacy boundary is solved.

Self-review: no placeholder host API, unproved desktop impossibility, real-transcript access, plaintext fallback, model-visible bearer field, premature completed end, counterfeit full-adapter claim, automatic client switch or deployment. Unknown capability is an explicit discovery outcome, not a missing success prerequisite silently waived. The preparation plan is approved; actual-host execution and the remaining production work are not accepted by that approval.

References: approved `2026-09-29-v2-fresh-start-production-design.md`; delivery roadmap full-visible prerequisite; umbrella sections 9/10/14/19/21.8; `authority-material-adapter.ts`; `contracts/session-end.ts`; existing F2 host-boundary/doc/acceptance reports. Official mechanism background: [Hooks](https://learn.chatgpt.com/docs/hooks), [App server](https://learn.chatgpt.com/docs/app-server). These links describe candidates, not support proof for the current desktop.
