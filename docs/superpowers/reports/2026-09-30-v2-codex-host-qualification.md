# V2 Codex host qualification — 2026-09-30

Report version: 2; read-only discovery updated 2026-10-01. Disposition: **host-capability-unverified**. This completes the preparation report, not the actual-host probe or F2. No supported, release-pinned complete feed, private authority boundary or private finalization path has been established for the calling desktop conversation. This is not a finding that the desktop is incapable.

## Source and observation identities

Task 2 source BASE is `a49b955f840f204f59c1e77d5c410c1cb1861cc5`; approved plan publication is `3073692b5157ca62d05f2b11f0b6b3fc6b9ed714`. Requirements are [spec sections 4–8](../specs/2026-09-30-v2-codex-host-boundary-feasibility-design.md) and [Task 2](../plans/2026-09-30-v2-codex-host-probe-preparation.md).

| Identity/observation | Evidence and limit |
| --- | --- |
| Installed desktop package | Earlier root-owned non-secret inventory: `26.928.1915.0`; not re-inventoried or bound to this conversation |
| Process file | Earlier `ChatGPT` file version `154.0.8037.57`; no demonstrated link to the calling conversation; Codex process metadata did not establish serving host |
| CLI | Earlier `0.154`; separate from installed desktop and serving host |
| Displayed About metadata (user-reported, 2026-10-01) | `ChatGPT`, `Powered by Codex & OWL`, version `26.928.21956`, released 2026-09-30; supplied directly by the user from the current app. This establishes the reported UI version, not an independently bound serving process, supported capture mechanism or actual-host run |
| Actual serving host/build | `unverified` |
| Actual mechanism/release/schema | `unverified`; current documentation is candidate background, not installed-release attestation |
| Synthetic host authorization/binding | `unverified`; no new conversation, owned store or actual-host setup authorized/executed in this slice |

Focused Git comparison from accepted F1 source `1d41c5186a022e83774b7f3e9f941b137947be0c` to Task 2 BASE found no differences in `src`, the five configuration inputs below, or `tests/session-end-policy.test.ts` (native 0). Fresh working-file hashes also match the frozen inputs:

| Input | SHA-256 |
| --- | --- |
| `package.json` | `81108d6a08b9fb01d060b919306e54b23378649356a62468b22e5885bc625b59` |
| `package-lock.json` | `307e5857f8803f7bdc9ba4bacc1f3a11840291d23852d49e4d3bc14fb8d08006` |
| `tsconfig.json` | `378b844a67cb3ce6606a93fc21980c9b7ef441b5fac129988920984d3ece95e7` |
| `tsconfig.test.json` | `ba64c0e92b67ce747d4e348b3281600a0e9cab489637649e6c82e188bef409ad` |
| `.github/workflows/ci.yml` | `cd46e2d12358e093649fc8d464520a0a04efac61071997a5f0900d144f18e498` |

## Supported candidate and limits

Official OpenAI [Hooks](https://learn.chatgpt.com/docs/hooks) was fetched on 2026-09-30. Candidate fields: common `session_id`, nullable `transcript_path`, `cwd`, `hook_event_name`, `model`; turn-scoped `turn_id`; tool `tool_name`, `tool_input`, `tool_response`; subagent `agent_id`, `agent_type`, nullable `agent_transcript_path`; Stop's nullable `last_assistant_message`. Subagent common session IDs identify the parent. Hosted tools and some specialized paths escape tool hooks; transcript format is unstable. Hook context can be model-visible; `systemMessage` surfaces in UI/events and `suppressOutput` is unimplemented. Stop supplies latest text, not a complete intermediate feed. SessionEnd is main-thread-only, advisory, synchronous, triggered by archive/delete, normal close or 30-minute detached idle; switching conversations is insufficient. Sources: fetched page lines 1230–1298, 1373–1410, 1426–1433, 1519–1528, 1612–1659.

Inference for this probe: those documented limitations do not qualify hooks alone as the required complete/private/durable boundary. They do not exclude every possible desktop mechanism. Context7 `/openai/codex` GitHub-main snippets and app-server/custom-client background do not pin installed support. No undocumented attachment, transcript watcher, custom-client replacement or field merely labeled private qualifies.

### Read-only discovery update — 2026-10-01

Official [Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay) describes recording a demonstrated computer workflow on macOS to create a skill. It is not documentation of the complete conversation-evidence feed required here. The current [App server](https://learn.chatgpt.com/docs/app-server) documents client-owned connections and turn/item events; it does not establish a third-party attachment to this existing Windows desktop conversation. These are scoped documentation findings, not a conclusion that every desktop integration is unsupported.

An official-domain search for the exact reported `26.928.21956` version found no matching release-specific interface documentation. Search absence is not proof of impossibility. No actual-host capture, private-boundary instrumentation, persistence/retry or completion experiment ran. All nine matrix rows and the strict retention disposition remain unchanged; accepted synthetic preparation evidence is not rerun or upgraded into actual-host proof.

## Section 7 proof matrix

Statuses concern actual-host proof. Unit observations are explicitly separate; no row is established on the host.

| Proof | Status | Available evidence; exact missing observation |
| --- | --- | --- |
| Actual host pin | `unverified` | Inventory above is separate; missing serving-build binding, matching supported mechanism/schema and run authorization |
| Complete conversation | `unverified` | Task 1 independently fixes eleven metadata frames/eight categories; missing actual eligible user/assistant/tool input/result/child/reference/correction/final feed and exact membership/hash comparison |
| Attribution/isolation | `unverified` | Unit scope negatives and server authority seams exist; missing trusted actual root/child/project/workspace binding, child-root end refusal and foreign-scope rejection |
| Private authority | `unverified` | Server public/private result separation exists; missing disposable-sentinel checks on every actual outbound model-visible, capture and log surface, and protected host retry storage |
| Lost response/reconnect | `unverified` | Pending-authority seam is reusable; missing actual pre-send durable identity, lost-response/reconnect or restart, exact retry, single result and owner-generation observation |
| Missing frame/class | `unverified` | Unit tests drop interior, whole class and final; missing actual host variants that block strict completion with precise gap/category |
| Unknown/tampered shape | `unverified` | Unit malformed shape/conflicting duplicate/predecessor/scope refusals exist; missing actual schema tamper/refusal and non-disclosing host diagnostics |
| End ordering | `unverified` | Existing status distinguishes phases; missing accepted request before final, final batch/seal before completed, private continuation and duplicate/late delivery behavior on actual host |
| Bounded failure | `unverified` | Unit metadata budgets exist; missing one total host deadline, detach/storage/continuation failure, retained recovery identity and owned-process/root cleanup observations |

No actual host scenario ran: native probe outcome, observed count/hash, missing actual ordinals/categories, private-boundary/retry/end/cleanup results are `unverified`, not zero-success values. No probe-owned store or process was created, so cleanup was not exercised. Fixture expectations are eleven frames, ordinals `0`–`10`, and eight categories; they are not observations.

## Native retention disposition and reusable seams

Source-established **coverage-only retention remains incomplete**. [RecordEvidenceBatchCommandV2](../../../src/orchestrator/lifecycle/contracts/commands.ts#L283) carries IDs, ordinal interval, fingerprint schema/key/domain, `content-not-retained` and coverage frames. Its validator at lines 1115–1147 limits batches to 1–2,000 frames with contiguous canonical ordinals and unique IDs; key ID is bounded to 128 Unicode scalars. [Identifier parsers](../../../src/orchestrator/lifecycle/contracts/identifiers.ts#L8) enforce canonical decimal strings within signed SQLite int64 and valid UTC millisecond timestamps. [Lifecycle wire](../../../src/orchestrator/runtime/lifecycle-worker-protocol.ts#L63) bounds canonical UTF-8 transport to 4 MiB, enforced at lines 227–239. These are coverage/transport bounds, not a full-content envelope or host schema/size attestation.

[Evidence coverage service](../../../src/orchestrator/lifecycle/evidence-coverage.service.ts#L60) declares `captureMode:"coverage-only"` and `contentRetained:false`, validates these values at lines 214–215 and returns them at lines 676–677. [Strict policy](../../../src/orchestrator/lifecycle/session-end-policy.ts#L249) rejects passing verification when `requireFullEvidence=true`; normalization at lines 269–283 rewrites an otherwise passing terminal plan to durable `record-verification-failed` with `EVIDENCE_CAPTURE_INCOMPLETE`. [Coordinator normalization](../../../src/orchestrator/lifecycle/session-end.coordinator.ts#L149) regenerates command/idempotency/planned-work identity together before storage. Strict completed closure cannot be manufactured from this coverage-only path.

Existing [policy tests](../../../tests/session-end-policy.test.ts#L71) explicitly cover rejection, durable-failure rewriting (line 83), and all-pass validation remaining failed (line 100). They were inspected, not rerun. Accepted [F1 evidence](../evidence/2026-09-29-v2-fresh-start-foundation.md), published at `9035a6fc281eee84695ccd2ad050fc83a21e683e`, records `full-suite-1790771147267-22720` on `1d41c51`: native 0, 3,187 tests/3,171 pass, zero fail/cancel, 16 skips. Unchanged source/config correspondence permits reuse for these existing contracts; it does not provide immutable-deployment or desktop proof.

[PrivateAuthorityChannel](../../../src/orchestrator/lifecycle/authority/authority-material-adapter.ts#L85) separates attachment/local delivery/descriptor routing; [LifecycleExecutionResult](../../../src/orchestrator/lifecycle/authority/authority-material-adapter.ts#L132) exposes public result, delivery status and safe recovery code. Adapter options at lines 147–153 use trusted pending store/key services. These server seams and protected pending authorization are not a desktop adapter or full evidence-retention store. [SessionEndStatusV2](../../../src/orchestrator/lifecycle/contracts/session-end.ts#L136) carries workflow identity/generation, phase, evidence window and safe failure. Internal coordinator functions are not documented desktop callbacks; requested acceptance is not completed closure.

Task 1 commit `a49b955` adds only the fixed manifest/pure verifier/tests. Preserved GREEN log records 95/95 pass with zero fail/cancel/skip/todo and 478.3478 ms; preserved typecheck is native 0. Independent spec and quality reviews accepted it. These establish synthetic unit behavior only, including exact membership, duplicate equality, attribution, correlation, ordering, hostile input and metadata budgets (64 observations, 65,536 frame bytes, 262,144 total bytes). They establish no host feed, private boundary or retention.

Final whole-preparation review identified scalar allocation before rejection. Local verifier/test repair `a05d7f8` adds cheap primitive/code-unit bounds before the required existing canonical parsers; production validators are unchanged. Actual focused RED proves allocation on 54 safely bounded parse paths; final whole-file GREEN is 96/96, native 0, zero fail/cancel/skip, with typecheck native 0 and accepted independent scoped fix re-review. The earlier 95-test result remains historical at `a49b955`, not relabeled for changed source. This additional unit proof changes none of the nine actual-host statuses or the strict retention disposition.

Production redaction before authenticated full-content encryption, key recovery, governance and erasure remain separate undelivered obligations. Host ordering proof, an encrypted authority pending store, or a weaker-policy unit pass cannot satisfy them. Preserve `requireFullEvidence=true`, `contentRetained:false`, `EVIDENCE_CAPTURE_INCOMPLETE`, empty V2 and no V1 import/retrieval/fallback.

## Stop and next permitted diagnostic

Stop before driver/setup: no hook installation/trust/configuration, host capture, new user-owned conversation, replacement client, production mutation or activation was performed. No setup request is issued for an unqualified mechanism.

The user has supplied the displayed About/version metadata; do not request it again. Next permitted read-only diagnostic: obtain release-specific official interface/schema documentation, or developer clarification, for a supported attachment to the existing desktop conversation and its complete visible-frame/private authority/finalization boundaries. Any support contact requires separate user authorization; none was sent. Independently bind the serving host before an eventual authorized probe. Do not read command lines, environments, client configuration or transcripts; absent direct evidence, retain `host-capability-unverified`.

A viable qualified mechanism would require a separately reviewed execution addendum naming exact files/config/trust actions, protected storage, pinned schema/full-content bounds, independently observable surfaces, one total deadline, authorized synthetic conversation/owned store, lost-response/reconnect case, all nine matrix rows, process ownership and recoverable cleanup. Preparation approval supplies no authority for those host actions. F2 production work, F3 recovery/release and F4 separately approved activation remain outstanding.
