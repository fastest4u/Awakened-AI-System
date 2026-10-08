# V2 native list, recent, context and follow-up read workflows

Date: 2026-10-07.
Status: **written specification approved by the human on 2026-10-07** with `อนุมัติ`, for the artifact at c6e653f0da311e990aa7ff7e70a5b51d4c4f15eb (blob d9e00c6d2c612b6b27b1d6f87ffb8e4b3406e8f2), unchanged at d9dbd8d. [Executable plan](../plans/2026-10-07-v2-native-read-workflows.md) is prepared for its required human review; implementation approval remains pending that stage.
Design baseline: `b1646c1c8d9d04345af6d456be4f5724c7f068d2`.
Execution preference: preserve the user's existing Subagent-Driven selection after review of this specification and its subsequent executable plan.

## 1. Intended outcome and inherited decisions

The user wants all of V2 ready for production through the current Codex desktop, starting empty and preserving V1 as a separate read-only archive. The approved [fresh-start specification](2026-09-29-v2-fresh-start-production-design.md), section 5, requires list, recent, context pack and follow-up radar as part of everyday memory.

This increment delivers their private query backend against verified projected data. It extends the accepted [native search/get design](2026-10-02-v2-native-content-query-design.md); it does not reinterpret that design's excluded operations as already implemented. The [roadmap](../plans/2026-09-29-v2-fresh-start-delivery-roadmap.md) permits independent subsystem planning from delivered interfaces, and the [host-boundary design](2026-09-30-v2-codex-host-boundary-feasibility-design.md) permits independently progressing verified V2 reads while actual-host capture remains unverified.

Success is deterministic, scope-correct browsing and bounded task context, using one captured image and one receipt per request. A later public adapter can consume these real operations without inventing Markdown paths, full note bodies or V1 fallback.

## 2. Selected approach

| Approach | Tradeoff |
| --- | --- |
| A: Extend the delivered private verified-read lane (selected proposal) | Reuses admission, same-image validation, deadlines and cleanup; finishes query contracts independently of host/key work |
| B: Implement public reads and governed writes together | Delivers a larger visible workflow, but depends on unfinished authority, privacy, key and host contracts |
| C: Resolve current-host capture first | Resolves an important release prerequisite, but presently lacks a qualified attachment mechanism and would leave independent read work idle |

A is recommended because it uses delivered interfaces and keeps this subsystem independently testable. It does not change the approved final production requirements.

## 3. Architecture and affected boundaries

Keep `createVerifiedReadAdapter(binding).query(request)` as the private entry. Its supervisor captures immutable trusted authority, owns the total response deadline, launches the read child and releases detached content only after successful revalidation, read-child exit/drain, positive cleanup and ownership-record removal.

Inside that existing child, extend `queryNativeContent(database, manifest, context)` to run fixed queries on the already captured and verified schema-2 image. Extend `retrieval/database-core.ts` with database-only browsing and follow-up primitives reusing its row conversion and scope/temporal predicates. Keep candidate eligibility, selection, ranking and packing pure.

Context sections must be assembled inside one read attempt. Multiple parent `query()` calls are not an acceptable context implementation because they can observe different projection generations.

Likely implementation owners are `retrieval/database-core.ts`; `verified-read/content-{contracts,protocol,query,result}.ts`; `verified-read/{contracts,protocol,child,supervisor}.ts`; read-entry wire handling; measured emitted-closure assertions; and focused fixture/tests plus one bounded acceptance runner. The executable plan must enumerate exact owners and all existing consumers affected by the new wire version before code changes.

No projection/schema migration or publisher mutation is required. Public `src/v2/app.ts`, composition and capability registration remain closed during this private increment. No installed dependency or legacy V1 lease change is proposed.

## 4. Request contract and authority

Add exact private operations:

| Operation | Parameters | Meaning |
| --- | --- | --- |
| `list-canonical-records` | Optional `limit`, `cursor`, and existing content filters | Browse eligible canonical records by case-sensitive binary ID |
| `recent-canonical-records` | Optional `limit`, `cursor`, and existing content filters | Latest projected canonical state by descending source-event position |
| `build-context-pack` | Required `query`; optional existing content filters | Ranked projected context plus eligible open/blocked follow-ups |
| `follow-up-radar` | Optional `limit`, `cursor`, and existing content filters | Open/blocked follow-ups in the trusted bound session |

All requests retain exact `operation`, `consistency`, `minimumEventPosition`, `budgetMs`, `parameters`. Existing filters are `visibility`, `validAt`, `knownAt`, with existing validation and semantics. Limit defaults to 5 and accepts integers 1–10. Context uses a fixed total limit of 10 and no caller ranking/budget/callback overrides. Query retains the existing nonempty/NFKC/control-character checks and 1,024 UTF-8 byte limit before and after normalization.

Selection authority comes only from `VerifiedReadBinding.projectionBinding` and its independently bound session. Default visibility is bound-session visibility, otherwise branch visibility. A project-strong receipt does not remove a bound selection session. Requests cannot supply project/workspace/session IDs, roles, paths, SQL, providers, credentials, rankers or process options.

Follow-ups are session-owned in schema 2. Radar selects only the actual trusted session and `status IN ('open','blocked')`. A sessionless request yields a verified empty follow-up collection; it cannot enumerate other sessions. Root/child relationship does not itself grant aggregation authority.

## 5. Deterministic queries and paging

List uses `item_id COLLATE BINARY ASC`. Recent uses `source_event_position DESC, item_id COLLATE BINARY ASC`. Radar uses `source_event_position DESC, follow_up_id COLLATE BINARY ASC`.

Recent reports the ordering as source-event position. It is not wall-clock recency, a historical activity feed or reconstruction of old record versions. The canonical projection contains each record's latest projected state.

SQL applies existing project/session/status/time predicates before bounded selection. Decode rows using actual production row decoders and repeat defensive eligibility before serialization. Corrupt rows, missing tables, schema mismatch and query failures are typed failures, never empty or absent results. Preserve candidate/provisional/verified/conflicted/superseded statuses and conflict/superseding references; exclude retracted/expired/erased-evidence. Never follow a successor or mark a result verified automatically.

Use fixed parameterized keyset queries with at most requested limit plus one eligible row. No OFFSET, dynamic SQL fragments, wildcard search substitute, full-table in-memory load or caller-controlled scan cap. Every returned canonical record's scoped conflict descriptor follows the existing exact-get contract; counts must exclude foreign/ineligible members.

Cursor is a strictly decoded data selector, not authority. Its exact fields are `version:1`, `operation`, `selectionHash`, `schemaVersion:2`, `projectionGeneration`, `projectionEventPosition`, `imageSha256`, `lastId` and `lastEventPosition`. The last position is null for list and a canonical unsigned position for recent/radar. Maximum cursor encoding is 2,048 bytes, subject also to the complete request/bootstrap cap.

The child derives `selectionHash` as SHA-256 of canonical data containing operation/order, trusted selection scope, release/control identities and effective filters. A caller cannot turn the cursor into broader selection authority. Validate the sort key's scalar bounds and position against the captured image. Forging a same-scope start key can only narrow traversal; the token carries no credential and makes no provenance claim.

Each page recaptures/verifies the current image and matches cursor image, generation, terminal position, schema and selection hash. A changed image or semantic binding returns new private `V2_CONTENT_CURSOR_STALE` with no content. Malformed cursors return existing input-invalid failure. Restart paging explicitly; do not hold a cross-request lease, reconstruct an old image or mix pages silently.

Results include whole items, per-item conflict descriptors where applicable, `hasMore`, nullable `nextCursor` and `byteBounded`. Continuation advances after the last returned item. Limit-plus-one proves whether further eligible records exist; items withheld by byte packing also require continuation. If even one whole eligible item plus required metadata/cursor cannot fit, return `V2_CONTENT_RESULT_TOO_LARGE` rather than a non-progressing empty page.

## 6. One-image context and honest budgets

Context reuses the delivered native candidate collection, defensive filtering, fixed fusion/reranking and conflict-aware selection. Its follow-up section uses the query-free session-scoped radar primitive on that same image. De-duplicate `(kind,id)` across sections; a follow-up already selected as ranked context appears only once.

Return `operation`, `selectionScope`, existing ranking-policy identity, a new workflow-bounds policy identity, `items`, `conflicts`, `followUps`, and separate `candidateBounded`, `selectionTruncated`, `byteBounded` flags. Preserve existing item/source-position fields and conflict warnings. The combined item/follow-up count is at most 10. `candidateBounded` is true if either ranked candidate collection or the context's fixed follow-up candidate query stops without proving eligible-source exhaustion (the latter fetches at most 11 rows). `selectionTruncated` includes ranked-policy/conflict suppression and eligible follow-ups omitted by the combined 10-item limit or shared estimated-token allowance. `byteBounded` records whole units omitted by final envelope packing. De-duplication is not omission when the same `(kind,id)` remains represented in the other section. No omitted follow-up may disappear with all three flags false; these flags do not promise an exact global hit count.

Use one shared 2,048 **estimated** token allowance. For each prospective pack, sum the existing `estimateCandidateTokens` for its selected private items/follow-ups (ID, normalized key, summary and anchor), then add `ceil(encoded UTF-8 bytes of prospective content with every returned text field replaced by an empty string / 4)`. This overhead charge includes scope, flags, channels, source references, conflict descriptors and mandatory warnings; intentionally counting some identity fields twice is conservative. It operates only on bounded detached data, without invoking caller serialization. If mandatory empty-content metadata alone exceeds the allowance, return `V2_CONTENT_RESULT_TOO_LARGE`. Apply the shared allowance to ranked selected conflict units first, then follow-ups in their fixed order, recomputing metadata/count charges after each prospective unit. If the ranked section is empty, follow-ups may use the remaining allowance. Never allocate a separate 2,048 allowance per section. This is a deterministic estimate, not an exact model-token guarantee; complete-envelope bytes are measured independently.

Keep complete selected conflict units and scoped warnings when bounds prevent returning members, following existing native selection semantics. Recompute returned-member counts after final selection/packing. Do not clip strings, resolve conflicts, hide a known conflict or invent complete-scan counts. A verified empty projection yields empty context; excluded data remains undisclosed.

Projected summaries/text and event positions are the available content. The canonical schema does not contain full note bodies or insight/mistake/ADR categories. Such fields and Markdown paths must not be fabricated.

## 7. Wire, resource and failure bounds

Move the measured private read/bootstrap/reply/cancel wire to version 3 with matching supervisor/entry artifacts. Retain existing verify/search/get operation semantics under the new measured deployment. Reject wrong versions; no implicit version negotiation. Cleanup wire and persistent ownership-record schema remain version 1.

Retain all existing decoder bounds: maximum depth 8, 128 aggregate containers, 32 fields per record, 64 elements per general array and 2,048 UTF-8 bytes per scalar; reject getters, exotic prototypes, symbols, sparse arrays, extra keys and malformed Unicode. The context/list/radar operation-specific arrays enforce the narrower limits above.

The complete request AND complete bootstrap each remain at most 8,192 encoded UTF-8 bytes. The complete terminal envelope remains at most 16,384 bytes, including IDs, receipt, fence, closure and content. Charge escaped JSON size, cursor/conflict metadata and nesting. No cap increase is implied by adding operations. Oversized mandatory metadata fails rather than dropping authority fields.

Keep default budgets 2,000 ms session-strong / 5,000 ms project-strong, explicit integer 0–30,000 ms, separate cleanup budget 2,000 ms, cancellation grace at most 100 ms and at most eight child messages. Queue, startup, image wait, SQL, context assembly, packing and exit share the original response deadline. Synchronous child work cannot block supervisor expiry. Later commits do not continually move the original required-position fence.

An epoch/admission change, uncertain image/lock closure, late terminal, child-exit failure or ownership-removal failure discards all content. Diagnostics expose existing bounded safe codes/positions, without operational paths, tokens, cursor contents, projected text or arbitrary stacks. Empty, invalid input, stale cursor, consistency timeout, integrity failure and cleanup uncertainty remain distinct outcomes.

## 8. Acceptance evidence

| Area | Required proof |
| --- | --- |
| Browsing | Genuine empty and populated schema-2 fixtures; exact binary order; tie positions; later pages without duplicates/omissions; final cursor null; current-image restart after stale cursor |
| Cursor boundary | Wrong operation/filter/scope/release/control/image; malformed/oversized keys; forged narrowing selector cannot gain scope; changed image yields no content |
| Eligibility | Foreign project/workspace/branch/session; missing session radar; open/blocked versus terminal follow-ups; canonical status/validAt/knownAt predicates; malformed rows fail |
| Content | Real summaries/source positions and exact-get conflict semantics; latest-state recent label; no fabricated body/path/category or successor substitution |
| Context | All sections use one image; duplicate elimination; one shared estimated-token allowance including metadata-only refusal; more than 10 eligible follow-ups with no ranked matches; duplicate-aware supplementation and exhausted shared budget; total item cap; whole selected conflict units and correct warnings/counts |
| Packing | Multibyte and escaped text; full-envelope/cursor/container bounds; indivisible oversized first item refusal; pagination always makes progress |
| Ownership | Actual compiled query/packing deadline and abort; terminal versus exit/drain/revalidation/epoch races; uncertainty withholds content and preserves recovery ownership |
| Isolation | Emitted read/cleanup closure stays free of subprocess/thread/helper facades; V1 sentinel untouched; public status-only/content denial and strict evidence requirement unchanged |
| Regression | Existing metadata/search/get and actual decoder/build inventory consumers updated without deletion, weaker assertions, new skips or lost profile coverage |

Use task-focused RED/GREEN checks and independent task/spec/quality reviews, then one scoped native integration gate for the settled increment. The subsequent plan must name exact existing and new test files, runner bounds and source/build measurements. Do not replay unrelated legacy migration or unchanged full gates for reassurance. Later final-release qualification still applies to the completed production implementation.

Gate-budget amendment approved by the human on **2026-10-08** with `อนุมัติ`: only the native-read-workflows acceptance gate default and maximum increase from **1,500,000 ms (25 minutes)** to **2,100,000 ms (35 minutes)**, retaining one original absolute deadline. The actual 25-minute attempt at `963a1e88f7167edf58791b41c1e146a47b7686ca` expired with native exit **124** at stage 26 (`v2-internal-verified-read-gate`): 25 successful prior stages and 414 settled passes; interrupted-stage counts are unknown and eight later stages were unlaunched. Cleanup was complete with positive Windows Job-active-zero closure; final qualification count was zero. Preserve that failed attempt. The amended gate still requires all exact 29 ordered test files / 34 stages, stable source/build/compiled identities and actual final qualification; acceptance remains pending. Product response/cleanup contracts, the gate's 5,000 ms containment cleanup, other native33/metadata20 profiles, output caps and every existing guard remain unchanged.

Root-led reversible diagnostic amendment **Ruling29, 2026-10-08**: before the existing raw-output discard, a failed test receipt with coherent failed counts and no overflow may include `failureDiagnostics`. Its only data is fixed status `matched`/`partial`/`unavailable`, boolean `truncated`, and at most 16 ordered sites with positive safe numeric declaration/optional assertion positions plus optional fixed `ERR_ASSERTION`/`ERR_TEST_FAILURE` and `testTimeoutFailure` classifications. Exact known compiled-file representations are matched; names, observed paths, messages, stacks, values and content are never emitted. These hints are non-authoritative and optional; passing receipt/qualification schemas, primary native failure, raw discard, caps and every acceptance guard stay unchanged. [Official Node 24 reporter documentation](https://nodejs.org/docs/latest-v24.x/api/test.html#test-reporters) says spec output may change and recommends TestsStream events for programmatic consumption; this correction only recognizes tested current failing-section syntax and reports partial/unavailable hints otherwise. It does not change the reporter or CLI. The two failed 35-minute attempts and their passing compiled replays are retained separately; original failed names and causes remain **UNKNOWN**, and acceptance remains pending.

## 9. Production coverage and handoff

This increment closes private browsing/context/radar semantics only. Public routing, governed writes/lifecycle, operational key custody/rotation/recovery, erasure/restoration fences, actual current-host full visible capture/private finalization, F3 complete backup/restore/release and F4 cutover/live evidence remain required. Preserve `memory_v2Status`-only registration, `productionReady:false`, closed promotion, recovery `FRESH_START_CONTENT_UNVERIFIED`, `requireFullEvidence=true` and `host-capability-unverified`.

After approval of this written design, use Superpowers writing-plans to prepare the exact executable plan for review. Preserve Subagent-Driven; do not request the execution-method choice again. No implementation, host setup, real-content access, merge, release dispatch or production activation is authorized by this specification approval.

Self-review: source seams and inherited bounds checked; list/recent distinction explicit; cursor authority and image drift explicit; one-image context and shared budget explicit; session follow-up ownership explicit; no missing schema fields invented; public/privacy/recovery limitations retained; no placeholder interface or readiness claim.
