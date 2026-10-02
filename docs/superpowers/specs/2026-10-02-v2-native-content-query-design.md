# V2 native search and canonical-record get design

Status: Approach A conversationally approved with `อนุมัติแนวทาง A`; the written specification at `bedee3d71b93a49a4e23854185247887b7f43f60` was approved with `อนุมัติสเปก V2 native content written`. The [executable plan](../plans/2026-10-02-v2-native-content-query.md) at `eb63704f79579d0c5e30e93041839c0e1db432ee` was approved with `อนุมัติแผน` on 2026-10-02; scoped implementation is authorized. The execution method remains the already selected Subagent-Driven method. Production activation is separately gated.

Design source: `018953d3c0385f8dac27e27056fae1ba2010f064` on `codex/v2-fresh-start`. Private metadata-only verified-read Tasks 1–6 remain accepted through implementation source `b948ed7c21354dca61ab6cfd2b3c519ea7a1f6cd`; see [their acceptance evidence](../evidence/2026-10-01-v2-internal-verified-read.md). This design extends that boundary; it neither reopens those tasks nor claims fresh execution of their tests on the documentation HEAD.

## 1. Agreed outcome and scope

Advance fresh-start V2 from a verification receipt to real content retrieval: bounded search and exact canonical-record get, executed in the existing owned read child against the same captured and verified V2 projection image. The user wants V2 as primary memory through the current Codex desktop, starting empty with no V1 import, search or fallback. Preserve that outcome and [the approved fresh-start profile](2026-09-29-v2-fresh-start-production-design.md).

This increment delivers a private production-code query backend exercised against owned isolated synthetic V2 stores. Search returns actual projected summaries/text and truthful statuses. Get returns one canonical projected record by its stable ID, including its summary and source-position reference; the schema does not contain a full note body. No Markdown path, decrypted raw evidence or nonexistent full body is fabricated.

Not in this increment: public tool registration/content access, actual production-user ingestion, governed writes, full-evidence privacy/key handling, list/recent pagination, context pack/follow-up-radar adapters, alias implementation, optional vector/global/provider access, desktop installation/configuration/capture, authenticated recovery, backup/restore or deployment. These remain required where applicable before declaring the everyday V2 replacement ready. See [the delivery roadmap](../plans/2026-09-29-v2-fresh-start-delivery-roadmap.md).

Preserve `memory_v2Status`-only registration, public content/promotion denial, `productionReady:false` and `requireFullEvidence:true`. Recovery reads remain `FRESH_START_CONTENT_UNVERIFIED`. Full capture cannot be replaced by tool-only evidence. The current desktop remains `host-capability-unverified`, not proven incapable.

Written-spec approval permits preparing a concrete executable plan for review. It does not authorize implementation before plan review, user-content reads, new runtime state, host trust/configuration, credentials/transcript access, push/merge, hosted CI or activation.

## 2. Selected architecture and source seams

Approach A separates a database-only query/ranking core and invokes it inside the accepted child. Approach B would generalize `InternalRetrievalService` around native V2 leases; that service currently pins a V1-shaped lease, parses a V1 manifest and imports coordinator/migration/optional-provider orchestration. The user selected A. The parity bridge's schema-1 facade is evaluation glue and must not become the production query route.

Use the already opened detached SQLite image and actual schema-2 manifest. `collectEligibleFromProjectionDatabase` is an existing algorithmic seam, not a child-safe module today: `retrieval/candidates.ts` imports runtime `projections/manifest.ts`, which imports helper-backed stable-directory operations. Directly importing that graph into the child is forbidden.

Separate these responsibilities, without changing legacy behavior:

- Database-only row conversion, fixed parameterized channel queries, conflict closure/counts and source-version-aware feedback. Runtime manifest decoding uses the pure `manifest-codec.ts`; shared image metadata checks use `image-metadata.ts`.
- Pure defensive eligibility and full service ranking conversion, fixed fusion/reranking/selection and result conversion. Preserve `service.ts`'s high-impact flag, source/entity diversity keys, token estimates and repository conflict totals/cursor in internal ranking candidates; passing raw collection channels directly to fusion loses that information. These helpers must not import V1 lease pinning, migration invocation deadlines, providers or custom-ranker orchestration.
- New exact canonical-ID query on the same database. It shares scope/temporal/status predicates and row conversion but does not run search or ranking to choose the requested record.
- Child orchestration and exact content wire contracts. The supervisor remains the sole response-deadline, composition-epoch and ownership settlement authority.

Legacy pathname/V1/V2 lease wrappers continue delegating to the extracted algorithms with their existing contracts. This narrow extraction is necessary isolation work, not a general retrieval rewrite. No schema migration, publisher mutation or fixture-only replacement of production query code is introduced.

Prove the actual emitted read/cleanup entry-point dependency graphs remain free of subprocess/thread creation and helper facades. Source-level intent or assumed tree shaking is not closure evidence.

## 3. Private requests, authority and protocol version

The exact private operation allowlist becomes:

- `verify-published-view`: existing metadata operation, unchanged semantic result.
- `search-projected-content`: bounded native V2 search.
- `get-canonical-record`: ID-only canonical projected-record lookup.

Introduce version 2 of the private read bootstrap/reply/cancel wire, deployed only with matching measured supervisor/read entry points. Version 1 is not negotiated or silently accepted by the new read lane. The separately fixed cleanup wire may remain version 1: it has no content operation and its build identity is still verified. Persisted ownership-record version/fields and conservative restart semantics are unchanged.

All read requests have exactly `operation`, `consistency`, `minimumEventPosition`, `budgetMs`; the two content variants additionally have exactly `parameters`. Metadata requests cannot carry content parameters. Consistency, positions and trusted budget resolution retain the [accepted verified-read contract](2026-10-01-v2-internal-verified-read-design.md).

Content parameters are exact data-only records:

| Operation | Required fields | Optional fields and defaults |
| --- | --- | --- |
| Search | `query` | `limit` defaults to 5, integer 1..10; `visibility`, `validAt`, `knownAt` omitted by default |
| Get | `id` | `visibility`, `validAt`, `knownAt` omitted by default |

Search normalizes NFKC and trims using the existing retrieval convention, requires nonempty text, rejects control characters and checks UTF-8 length both before and after normalization; maximum 1024 bytes. This is not arbitrary SQL/FTS syntax: fixed channel query construction escapes lexical terms. Get preserves the case-sensitive ID exactly, with no normalized-key matching, trim, case folding or fuzzy fallback; nonempty, no control characters, maximum 512 UTF-8 bytes.

`visibility` is one of the existing project/workspace/branch/session selectors and can narrow selection, never create authority. Default selection retains current rules: session visibility when a trusted session is bound, otherwise branch visibility. Session visibility without a trusted session is invalid. A session-bound project-strong request may select that bound session's records; consistency mode does not grant or replace session authority. The receipt retains the accepted consistency-mode scope encoding; the query result explicitly records the trusted selection session as described below.

`validAt` is the existing canonical ISO timestamp, maximum 24 bytes; `knownAt` is a canonical unsigned decimal position no greater than SQLite INT64_MAX. Both filter the captured projection. They do not rewind the store, reconstruct old versions or loosen required-position consistency. Omission preserves the existing predicate behavior, not an implicit wall-clock-expiry guarantee.

Construct internal query requests inside the child from the trusted projection binding (image session is null) and separately bound session. Callers cannot supply a session ID, binding, role, path, release/build, process executable, ranking policy, SQL, callback, candidate/token budget, vector/global flag or explanation callback. Fixed search candidate limit is 64 unique items and fixed estimated token budget is 2048; global/vector/explain are disabled. All channels remain bounded by existing repository behavior.

Version-2 decoding is descriptor-first and rejects getters, `toJSON`, exotic prototypes, symbols, extra keys, unsupported discriminants, invalid scalars and malformed positions before using them. Add explicitly bounded ordinary-array decoding, which the current metadata-only codec lacks: no sparse arrays, accessors, extra array properties or caller iteration callbacks. Maximum depth 8, 128 aggregate record/array containers, 32 fields per record and 2048 UTF-8 bytes per scalar string remain fixed. Operation-specific arrays additionally enforce items <=10, conflicts <=64 and channels <=7. Charge escaped JSON bytes during copying, not raw string lengths alone.

The full request/bootstrap remains <=8192 encoded bytes, including trusted bootstrap data. A query fitting its own limit can still be refused if the complete bootstrap does not fit; no automatic envelope increase. Unknown/wrong version is a protocol refusal, not a compatibility fallback.

## 4. Same-image execution and eligibility

Retain admission, lock/capture, manifest continuity, file SHA, singleton image metadata and authoritative-position validation from the accepted boundary. After validating image metadata, execute the selected fixed query against that exact image before closing it. Do not verify metadata first and then reopen a pathname in the parent or construct another lease/publisher.

Derive the required position once: maximum of admission's captured committed project tail, trusted session minimum and request minimum. Ordinary later commits do not continually move this fence. Selection does not bypass any binding/release/build/schema/control-generation checks. Missing storage remains an error; only a well-formed verified empty image can yield empty search or absent get.

Apply existing SQL predicates before candidate selection and repeat each item's defensive eligibility before fusion/reranking/serialization. Preserve project, actual workspace, branch-scope/ref and bound-session filtering. A conflict member cannot inherit another member's eligibility. Source-position freshness means the source position is not ahead of this image, not measured real-world age.

Preserve current statuses and their semantics. Candidate, provisional, verified, conflicted and superseded canonical records remain selectable where other predicates permit; retracted, expired and erased-evidence are unreadable. Never promote a returned record to verified or quietly add a new verified-only policy. Checkpoints/artifacts/follow-ups retain their existing native kind/status conversion; follow-up selection remains open/blocked and trusted-session scoped.

Search reuses the actual native exact-ID/key, lexical, symbol/path, session-checkpoint, open-follow-up and conflict-closure channels with SQL eligibility, defensive filtering, source-version-aware feedback and fixed fusion/reranking/diversity/conflict selection. V2 alias currently returns no candidates; do not advertise implemented alias support. Report the real fixed ranking policy identity `retrieval-ranking-v2-shadow-fixed-units` unchanged. Private backend acceptance does not make that shadow-named policy production-certified or waive applicable release retrieval thresholds.

Get uses `project_id` plus exact `item_id` under fixed predicates, never ID OR normalized key and never `search(id).items[0]`. It returns one eligible canonical row or null. Foreign, missing and ineligible records have the same absent result; no denied-record details/counts are disclosed. Eligible conflicted/superseded records retain their status and references. If the eligible row belongs to a conflict group, query only that group's eligible count under the same scope/temporal predicates and return the conflict descriptor below; do not return other members or pretend exact get resolves the conflict.

Get shares query-context/eligibility primitives that do not require a search string; no fabricated search term is introduced to satisfy a legacy validator. Malformed projection rows or schema/query failures are failures, never truthful absence.

## 5. Detached result and citation contract

A content terminal success retains exact `version`, message IDs, `kind`, receipt, fence and image/reader/lock closure attestations, and adds exactly `content`. Metadata terminal success has no `content`. Receipt fields/verification stay unchanged except `operation` must match the exact requested variant. No verification literal may claim semantic replay, privacy/recovery certification or production readiness.

Common content context is `selectionScope` with exactly `projectId`, `workspaceId`, `branchScopeId`, `branchRef`, `sessionId` (the bound selection session or null) and resolved `visibility`. The supervisor compares every field to the immutable binding and request; it cannot trust a child's claimed scope. Vault/store identity remains in the receipt. This avoids falsely implying that a project-strong receipt's null session means sessionless selection.

Each item has exactly these copied scalar fields:

- `id`, `kind`, `projectId`, `workspaceId`, `branchScopeId`, `branchRef`, `sessionId`, `visibility`.
- `status`, `confidence`, `verificationMethod`, `validFrom`, `validTo`.
- `knownFromEventPosition`, `sourceEventPosition`, `textKind`, `text`.
- `conflictGroupId`, `supersedingItemId`.

Kinds/statuses/confidence use the actual existing finite contracts; nullable fields stay explicitly null. `textKind` is `canonical-summary` for canonical rows and `projection-text` for other kinds. `text` is the full existing row conversion's `summary` (lexical standalone items already map their projected text there), not decrypted source evidence or a promise of a complete historical document. Get items must be canonical and match the requested ID; get never follows a superseding ID or substitutes a sibling. Valid empty projected text is preserved rather than replaced with invented prose.

The supervisor validates every item's project/workspace/branch scope, bound-session visibility and requested temporal filters again; `knownFromEventPosition <= sourceEventPosition <= receipt.projectionEventPosition` must hold. Search rejects duplicate `(kind,id)` items, more than the requested result limit, duplicate/unsupported channels, or a `selectionReason` absent from that item's channels. Conflict IDs are unique; counts are nonnegative safe integers, returned counts match actual returned group membership and do not exceed eligible counts, and truncation agrees with those counts. Get conflict IDs match the exact item and its count is at least one. These checks establish wire consistency, not independent semantic reconstruction of the projection.

Canonical source references are stable item ID plus `sourceEventPosition`, `knownFromEventPosition`, selection scope and receipt's image/generation/hash/position. All positions are canonical decimal strings, never floating-point numbers. Source event IDs, content hashes and canonical anchors are not exposed in this increment: current row conversion does not supply them. No fictional source ID or Markdown path is inferred. A future richer citation/body contract requires explicit query/DTO work.

Do not copy a database object, statement, lease, image bytes, full manifest, normalized key, callback, cursor, ownership token, runtime path or credential into this DTO. A projected text's content is intentional content, not operational diagnostics; this private synthetic increment does not certify redaction of actual user data. Decode/copy/freeze every result, including arrays and nested objects, in the supervisor before release.

Search `content` has exactly `operation`, `selectionScope`, `rankingPolicyVersion`, `contentBoundsVersion`, `items`, `conflicts`, `candidateBounded`, `selectionTruncated`, `byteBounded`. Each item additionally has exactly `channels` and `selectionReason`, from the fixed selection. The booleans separately disclose repository candidate truncation, ranking/private conflict-barrier truncation and added wire-size bounding; they cannot mean a complete scan of all eligible memory. No exact global hit count is promised.

Search conflict descriptors have exactly `conflictGroupId`, `eligibleMemberCount`, `returnedMemberCount`, `highImpact`, `truncated`. Use defensive collection/ranking's scoped counts and high-impact semantics; recompute returned count after byte bounding. Keep a descriptor even when bounding returns zero members of that considered group. `truncated` is true whenever returned members are fewer than the known eligible count. `highImpact` means an observed eligible member was classified high-impact by the existing conversion, not proof about omitted siblings. No continuation cursor or usable pagination is advertised in this increment.

Get `content` has exactly `operation`, `selectionScope`, `item`, `conflict`. A null item requires null conflict. A non-null item's conflict is null when ungrouped, otherwise exactly `conflictGroupId`, `eligibleMemberCount`, `returnedMemberCount:1`, `truncated` (eligible count >1). It describes the scope-filtered group, not full-group retrieval or conflict resolution. The record's own `conflicted` status remains explicit; no claim about unseen members' high-impact status is invented.

## 6. Byte bounding, deadlines and resource ownership

Retain 16384 encoded bytes for the COMPLETE terminal IPC envelope, including IDs, receipt, fence, closure and content, not merely its text portion. Retain the 2048-byte per-scalar bound. The private content codec's bounded arrays do not authorize an unbounded message. Position/count/enum/relationship validation is performed on both child and supervisor sides.

Search adds an explicit private result-bounding policy, `v2-native-content-bounds-1`, reported in `contentBoundsVersion`. It does not alter or relabel the legacy ranking policy/weights/selector. The existing selector halts on collected high-impact members failing result/token admission, but does not halt merely because the repository reports omitted group members. The count query also does not prove omitted siblings' high-impact status. This new private policy conservatively treats ANY considered conflict group known incomplete as a barrier to later result units, regardless of the observed high-impact flag; it must not claim the unchanged selector already implements this safeguard.

Pack only after eligibility and fixed ranking. Treat each selected conflict group as an indivisible unit (members in their selected order), and each selected ungrouped item as one unit. Walk units in first-appearance order from the fixed reranked candidates, including a zero-selected-member group as a zero-member barrier unit at its first appearance. Never split selected group members to make a byte fit. If a group's selected membership is fewer than its known eligible membership, emit any fitting selected members and its truthful warning, then stop: no later unit may be emitted. Set `selectionTruncated:true` for this conservative suppression. Do not infer omitted sibling status or fetch foreign members to make a group complete.

Reserve the complete envelope and all considered conflict descriptors before adding item units. Recompute counts/flags and measure the complete prospective envelope at every unit admission, then check the final envelope before terminal emission. Charge actual escaped encoded bytes; token estimates exclude wire overhead and cannot substitute for this measurement. Stop at the first unit whose complete fields violate scalar/container/message bounds; omit it and all following units, set `byteBounded:true`, and recompute all returned-member/truncation descriptors. Do not trim text, drop required metadata, reorder lower-ranked items around it or refill after any conflict barrier. An empty bounded search with `byteBounded:true` is an explicit capacity-truncated result, not a claim of no matches. If the mandatory envelope/conflict metadata itself cannot fit, refuse with the new private failure `V2_CONTENT_RESULT_TOO_LARGE`.

Get is all-or-nothing: return the exact projected record plus its mandatory context/conflict metadata, or `V2_CONTENT_RESULT_TOO_LARGE`. It never clips text, substitutes a different record, silently becomes absent or returns a partial-success record. This failure is private, added to the exact read failure allowlist; it does not expand the public tool/error registry. Invalid caller content parameters use `FRESH_START_INPUT_INVALID`; query/image integrity failures use `INTEGRITY_FAILURE` or existing scope/projection failures. Unknown exceptions are reduced to the existing bounded failure family, never raw SQL/errors/content.

The accepted total-response limits are unchanged: 2000 ms session-strong, 5000 ms project-strong, trusted integer override 0..30000 ms, from supervisor arrival with no reset. Queue <=8 unsettled requests, one read OR cleanup child, image <=64 MiB, manifest <=64 KiB, output <=4 KiB per discarded stream and at most eight bounded stage/terminal messages remain. Add at most one `query` phase in existing order between validate and revalidate; stage messages contain no query/ID/text. Metadata operations omit this phase. Query/selection/packing time counts in the original budget.

Synchronous SQL, native allocation or ranking may block only the owned disposable child. The supervisor still settles timeout/cancellation exactly once and ignores late content. No process-RSS cap, preemptible SQLite promise or hard real-time deadline is claimed from byte limits. No writer is killed, no provider is called, and no query initiates refresh/rebuild/reconciliation/repair.

Content is only a candidate until the accepted cleanup/revalidation sequence succeeds: close image, release exact lock, revalidate original authority/anchors in the final short authoritative snapshot, close reader, normal child exit, actual ownership-record closure, unchanged supervisor epoch and unexpired response budget. No partial content is streamed before this settlement. A transition before the final authoritative observation fences the result; a transition after that linearization point is not retroactively invalidation up to network delivery.

Preserve the separate fixed 2000 ms cleanup observation window (including at most 100 ms grace), one exact cleanup child only after confirmed read-child exit, primary failure plus distinct cleanup state, quarantine on uncertain closure, and conservative restart. Every existing ownership record, including `complete`, blocks a new owner until creating-owner removal is positively complete. No automatic record/lock clearing, stale-PID kill, descendant launch or deadline inflation is introduced. Unresolved synthetic evidence from earlier attempts is not deleted by this design.

## 7. Verification to require in the executable plan

These are proof obligations for future implementation, not tests already run for this specification:

| Area | Required focused evidence |
| --- | --- |
| Native content | Genuine isolated nonempty schema-2 images for canonical/exact, lexical, artifact/path, checkpoint and trusted-session follow-up search; stable projected text/status/source-position references; empty verified genesis and later committed-position reads |
| Exact get | ID-only lookup with another record's normalized-key equal to the requested ID; missing/ineligible/foreign indistinguishable absence; canonical summary rather than fabricated body; conflict count/truncation and supersession/status fidelity |
| Eligibility | SQL and defensive predicates before ranking: project/workspace/branch/session denial, retracted/expired/erased, explicit valid/known bounds, ahead-of-image source position, independently ineligible conflict members; current default/session-bound project-strong semantics |
| Ranking/packing | Full service ranking conversion and fixed policy identity/order/feedback/diversity preserved; <=64 unique candidates, fixed 2048 token budget, <=10 results; distinct content-bounds policy; whole selected conflict units, zero-member barriers/warnings, repository-incomplete groups with unknown omitted high-impact sibling, selection and byte truncation suppression, multibyte/escaped-text bytes, oversized item and metadata, exact-get refusal, deterministic truncation without text clipping |
| Wire | Version-2 exact variants and metadata compatibility semantics; no version fallback; bounded arrays, holes/accessors/extra fields, scalar/depth/container limits, decimal positions, operation/ID/kind/scope/count mismatches, total envelope limits, no leaked runtime paths/tokens/credentials/query diagnostics |
| Same image/fence | Query runs on the captured verified image, not reopened path or evaluator facade; actual manifest continuity and image metadata/SHA checked; later ordinary commits allowed; authority/epoch changes before acceptance discard pending content; wrong source/terminal anchors refuse |
| Ownership/deadline | Real blocked query/selection cannot block supervisor expiry; queue/startup/query/packing/exit keep one original budget; no early/late result; image/lock/reader/exit/record-removal failure discards content and preserves primary failure/cleanup quarantine |
| Dependency/public isolation | Actual emitted read and cleanup graphs contain no subprocess/thread/helper imports; compiled content operations use genuine synthetic V2 stores; instrumented V1 sentinel untouched; no public content/tool/promotion or weakened full-evidence setting |
| Extraction regression | Directly affected existing candidate/ranking/V1/V2-wrapper behavior unchanged by pure extraction; no migration or default/full-suite profile deletion |

Use deterministic barriers/clocks for logical races and owned compiled processes for actual blocking/exit proof. Keep process-tree closure and measured build/deployment identity reporting from the accepted private gate. Only refresh tests invalidated by actual edits and one targeted content increment integration gate after review; do not rerun unchanged F1/full migration gates for reassurance. Preserve applicable final frozen-release integrity/isolation/retrieval checks when their inputs change. Test-only timeout bounds never replace production response/cleanup bounds.

Report actual native outcomes, skips, incomplete cleanup, source/build identities and limitations. A synthetic query backend pass cannot certify public operation, host capture, encrypted evidence, recovery, backup or whole-system readiness.

## 8. Handoff and inline self-review

After human approval of this written specification, prepare a reviewed executable plan with exact files/interfaces, pure extraction and unchanged-wrapper tests, private operation/codec DTO work, same-image child integration, supervisor operation/scope/result validation, bounded packing and compiled acceptance evidence. Retain Subagent-Driven without requesting the execution-method choice again. Implementation starts only after plan review.

No new ready/active marker is written by this increment. F2 public workflows/governance/privacy and current-desktop full visible capture/private closure, F3 newly acknowledged V2 data/evidence/key recovery and exact release proof, and F4 explicitly approved cutover/live verification remain. List/recent/context-pack/radar are later consumers of this backend with their own concrete contracts, not completed features.

Inline self-review: conversational/written/plan/activation stages distinct; exactly one new content subsystem; canonical-summary semantics truthful; exact ID separated from search key; session selection authority explicit; SQL plus defensive eligibility and full ranking conversion; fixed real ranking identity separated from newly specified conservative content-bounds policy; status fidelity and same captured schema-2 image; byte/container caps and zero-member conflict barriers concrete; no text clipping or success after uncertain cleanup; conservative ownership/restart preserved; no V1/provider/helper graph, fake citation/body, host capability claim or whole-PROD claim. The focused read-only source audit informed these corrections. Document checks do not substitute for executable verification.

Source references: `src/v2/app.ts`, `src/v2/composition.ts`, `src/v2/config.ts`; `src/orchestrator/verified-read/{contracts,protocol,child,supervisor,admission}.ts`; `src/orchestrator/retrieval/{contracts,candidates,v2-candidates,eligibility,ranking,service}.ts`; `src/orchestrator/projections/{schema,manifest,manifest-codec,image-metadata,stable-directory}.ts`; `src/orchestrator/parity/v2-snapshot-parity.ts`. The read-only discovery report is working evidence, not an approval artifact.
