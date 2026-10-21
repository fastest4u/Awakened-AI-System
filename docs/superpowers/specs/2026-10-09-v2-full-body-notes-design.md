# V2 private full-body Markdown notes — design

Date: 2026-10-09 (Asia/Bangkok).

**Status: written specification for human review. The conversational direction is approved; this document and its implementation plan are not yet approved.**

Source baseline: `cbf1fb477addb3ea464064f410e61468eafa3c66`, branch `codex/v2-governed-summary-commands`, existing managed V2 worktree. The human requested work1: full note bodies, Markdown and different note kinds, clarified that the target is V2, then replied “อนุมัติ”. This advances the previously presented direct-Markdown direction to this written specification. The previously selected Subagent-Driven execution method remains in force.

## 1. Outcome and boundaries

An authorized private V2 command creates one provenance-linked candidate/unverified note with a separate summary, an inert Markdown body and one of `session-log`, `insight`, `mistake`, `adr`. A private exact-ID read returns the redacted body and its kind from a verified immutable projection image. SQLite canonical events remain authoritative; Markdown is the body's text format. This increment does not create a Markdown vault, import V1 notes, parse/render Markdown, enforce kind-specific templates, or execute links, HTML or code contained in the body.

The summary remains the text used by existing search, get, list, recent, context-pack and radar operations. Kind identifies the note's purpose; it does not establish factual verification or require particular headings. Session-log creation does not end a session. New notes remain candidate/unverified.

One delivery includes versioned creation/recovery, compatible projection rebuild/publication and a dedicated full-note read. Those components depend on each other and belong to one executable plan. Public MCP routing, promotion/correction/conflict/supersession/retraction/expiry/erasure commands, operational key custody, wider crash-parent reconciliation, actual-host capture, F3/F4 and production activation remain later deliveries. Preserve `productionReady=false`, status-only public registration and V1 archive isolation.

Inherit the accepted governed-note implementation's authority, provenance, transaction, timing, ownership and cleanup rules. The earlier [summary-command specification](2026-10-08-v2-governed-summary-commands-design.md) explains them, but source at the baseline controls historical shapes, including the corrected imported-identity domains. This specification changes only the explicit version, body, projection and read contracts below.

## 2. Historical contracts and exact version selection

Never reinterpret old payloads by adding optional body fields to their exact decoders. Select a version from owned data before decoding that version's complete shape; unsupported or mixed versions refuse.

| Contract | Existing summary family | New full-body family |
| --- | --- | --- |
| Semantic create | `GovernedNoteCommandV1`, `version:1` | `GovernedNoteCommandV2`, `version:2` |
| Operation / durable command type | `create-governed-note` | Same operation and type |
| Created event | `GovernedNoteCreated`, schema1, `formatVersion:1`, witness1 | Same event type, schema2, `formatVersion:2`, witness2 |
| Source event | `MemorySourceRecorded`, schema3, `sourceVersion:2` | Same event type, schema4, `sourceVersion:3` |
| Verification method | `governed-note-unverified-v1` | `governed-note-unverified-v2` |
| Stored receipt | `resultVersion:1`, body-free | `resultVersion:2`, body-free content descriptor |
| Recovery request / envelope | `version:1` / `resultVersion:1` | `version:2` / `resultVersion:2` |
| Projection image | Historical schema1/2 | New schema3 |
| Ordinary private read transport | Bootstrap/reply/cancel3 | Remains3, including reads of schema3 |
| Dedicated full-note transport | Absent | Bootstrap/reply/cancel4, only `get-full-note` |

Event schema versions, payload discriminants, witness versions and stored-result discriminants must agree. The new source version is reserved for the full-body governed family; it is not a generic caller-supplied body channel. An unknown reserved version cannot become an ignored/unprojected event or fall into generic append.

All new command/idempotency/operation/request/record/event/provenance identities retain the existing UUIDv4 rule. Imported project/vault/store identities use their existing projection identity validators, workspace identity uses its existing validator, and existing session/branch IDs retain their current canonical UUID domains. Do not generalize the new-ID rule to those imported fields. Positions remain bounded unsigned decimal strings; compare as bigint, never Number.

## 3. Input, literal body processing and resource bounds

The following are proposed exact shapes. `Omit` denotes the existing fields and validators; it does not allow arbitrary keys.

```ts
type GovernedNoteKind = GovernedNoteCommandV1['recordKind'];
type MarkdownNoteContentV1 = Readonly<{ format: 'markdown'; body: string }>;

type GovernedNoteCommandV2 = Readonly<
  Omit<GovernedNoteCommandV1, 'version'> & {
    version: 2;
    content: MarkdownNoteContentV1;
  }
>;

type PreparedGovernedNoteCreateV2 = Readonly<{
  command: GovernedNoteCommandV2;
  authorization: GovernedNoteProtectedAuthorizationV1;
}>;
type PreparedGovernedNoteCreateWireV2 = Readonly<{
  command: string;
  authorization: GovernedNoteProtectedAuthorizationV1;
}>;

type GovernedNoteRecoveryV2 = Readonly<
  Omit<GovernedNoteRecoveryV1, 'version'> & { version: 2 }
>;
type PreparedGovernedNoteRecoveryV2 = Readonly<{
  request: GovernedNoteRecoveryV2;
  authorization: BoundedOperationAuthorization;
}>;
type PreparedGovernedNoteRecoveryWireV2 = Readonly<{
  request: string;
  authorization: BoundedOperationAuthorization;
}>;
```

V2 create has exactly the eight V1 fields plus `content`; `content` has exactly `format` and `body`. The caller cannot supply a body hash, policy, session target, kind outside the enum, or alternative storage location. Proof construction and verification bind the admitted V2 input through purpose `create-governed-note/v2`; V2 recovery uses `recover-governed-note-result/v2`. V1 proof purposes remain byte-for-byte unchanged.

Summary processing remains raw limit -> NFC/trim -> trusted redaction -> final limit, as implemented for V1. Body processing is separate:

1. Validate well-formed Unicode and exact UTF-8 size. Reject NUL, DEL and C0 characters except TAB, CR and LF. Reject a body when `body.trim().length === 0` under the existing runtime's ECMAScript whitespace classifier. Use that exact emptiness test for raw, final, source and read validation; never replace the stored body with the trimmed value.
2. Freeze the trusted policy once for the command and use the same policy identity/version and rules for summary and body.
3. Apply its existing plain-text secret scanning/redaction to the literal body. Do not call the summary normalizer and do not fabricate retained-evidence frames or host coverage.
4. Reapply the body validity and byte gates to the redacted result. Preserve all unaffected indentation, trailing whitespace, line endings, code fences and Unicode normalization variants. Only redaction substitutions may change admitted text.

The span manifest remains transient. V2 summary plus body share an aggregate maximum of4,096 redaction spans. Invalid/unavailable trusted policy, required process-secret rules, malformed input or expansion overflow refuse before commit. This reuses the current policy's protection; it does not claim complete operational erasure of managed-runtime strings or encryption of canonical note bodies.

| Lane or structure | Exact maximum / rule |
| --- | --- |
| V1 command, result and every existing private content lane | Existing limits unchanged |
| Raw original body and redacted final body | Each65,536 UTF-8 bytes |
| Summary, metadata scalar strings | Existing2,048 bytes and field-specific smaller bounds |
| V2 create metadata with `content.body` replaced by `''` |8,192 canonical encoded bytes |
| Complete V2 semantic create |196,608 canonical encoded bytes (192KiB) |
| V2 recovery input |8,192 encoded bytes; no body |
| Protected authorization |16,384 encoded bytes, separately bounded |
| Create/recovery worker result including correlation |16,384 encoded bytes; body-free |
| Each complete source/created payload |262,144 encoded bytes; source metadata with body replaced by `''` <=65,536 |
| Complete dedicated full-note success |262,144 encoded bytes, including IDs, receipt, fence and closure |
| Dedicated success metadata with body replaced by `''` |65,536 encoded bytes |
| Dedicated request, stage and failure | Existing8KiB input /16KiB reply limits |
| Worker request and atomic append | Existing4MiB limits; exactly two events and zero outbox jobs |
| Depth / aggregate containers / fields / array elements | Existing8 /128 /32 /64 |
| Provenance / trusted rules / literal rule size | Existing64 references /256 rules /2,048 bytes |
| Projection checksum canonical representation / owned image capture | Existing32MiB /64MiB; no capacity increase |

Only the explicitly selected body path gets the65,536-byte scalar allowance: semantic `content.body`, new source `item.content.body`, or dedicated reply `content.item.content.body`. Every surrounding record must have exact admitted keys and discriminants. Do not relax the global2KiB scalar limit or16KiB ordinary reply limit, and do not validate the entire body-bearing object through an old scalar-limited copier first. Reuse descriptor-based owned copying, proxy/accessor/exotic rejection, Unicode metrics and independent canonical encoding charges. Both endpoints validate; canonical command text is a bounded transport string, not a semantic metadata scalar.

Allowed body characters JSON-quote to at most `2 * 65,536 + 2 = 131,074` bytes; the six-byte control escapes are excluded by the raw/final gates. Combined with the64KiB metadata reserve, this fits the256KiB dedicated success/source ceiling. Still measure actual envelopes, including escaped strings nested in append/transport; do not infer returnability from raw body length alone. Overflow refuses without truncation, field dropping, automatic retry, or raising old caps.

## 4. Durable body, witness, receipt and historical equality

```ts
type GovernedNoteWitnessV2 = Readonly<
  Omit<GovernedNoteWitnessV1, 'witnessVersion'> & {
    witnessVersion: 2;
    contentFormat: 'markdown';
    bodyContentHash: string;
  }
>;
type GovernedNoteCreatedPayloadV2 = Readonly<{
  formatVersion: 2;
  witness: GovernedNoteWitnessV2;
}>;
type GovernedNoteStoredReceiptV2 =
  Omit<GovernedNoteStoredReceiptV1, 'resultVersion'> & {
    resultVersion: 2;
    content: { format: 'markdown'; contentHash: string };
  };
type GovernedNoteReceiptV2 = GovernedNoteStoredReceiptV2 & {
  readonly replay: boolean;
};
type GovernedNoteRecoveryResultV2 =
  | Readonly<{ resultVersion: 2; operation: 'recover-governed-note-result';
      outcome: 'committed'; receipt: GovernedNoteReceiptV1 | GovernedNoteReceiptV2 }>
  | Readonly<{ resultVersion: 2; operation: 'recover-governed-note-result';
      outcome: 'not-found'; commandId: string; idempotencyKey: string }>;
```

The source event carries authoritative redacted text inline. Start from the exact V1 source payload and change only: event schema4, `sourceVersion:3`, item verification method to the V2 marker, and add exact item fields `recordKind` plus `content:{format:'markdown',body:redactedBody,contentHash:bodyContentHash}`. Binding, canonical item identifiers/key, candidate status, confidence, times, summary, source arrays, empty arrays and anchor remain governed by the accepted pair rules. Keep `item.contentHash` as the summary hash. The nested `item.content.contentHash` is the distinct body hash.

Use these exact hash/MAC domains:

- Summary hash: existing `project-memory/governed-note-summary/v1\n` plus `canonicalJson(redactedSummary)`; unchanged for both families.
- Body hash: `project-memory/governed-note-body/v1\n` plus `canonicalJson({format:'markdown',body:redactedBody})`.
- V2 command hash: `project-memory/governed-note-command/v2\n` plus `canonicalJson(witnessV2)`.
- V2 original-input MAC: existing scoped historical-key envelope and purpose `original-input-commitment`, with domain `governed-note-original-input/v2` over `canonicalJson({authority,binding,command:decodedV2})`.

Original summary and body remain literal in the transient admitted command used for equality. Provenance selectors keep their existing sorted-set semantics. Different original bodies, whitespace, EOLs, normalization variants, kind, confidence or provenance conflict even if redaction produces identical persisted text. Keep V1 canonicalization and all V1 domains exactly unchanged. Creation replay uses the witness's historical note key, never a current-key substitute. Receipt recovery authenticates stored truth without requiring original-input equality or reopening provenance evidence.

Reuse the existing project-global command/idempotency uniqueness and reserved command type. A valid create collision across V1/V2 is `IDEMPOTENCY_CONFLICT`, not a separate namespace, new identity or synthesized result. Version-aware authentication must happen before treating an existing pair as compatible, conflicting or corrupt.

## 5. Atomic authority and recovery

Retain the accepted single owning worker connection, FIFO, guarded WeakMap-backed planning, current same-session authorization, direct-access child restrictions, transaction/retry classification and original-ID unknown outcome rules. Add strict V1/V2 dispatch to the private run, executor, runtime factory, worker protocol/backend, service, repository and append ownership seams. Existing private request type names may remain; the semantic version and prepared wire decoder select their exact contract. Do not add a generic append API or second writer.

V2 produces exactly the adjacent Created/source pair, stream versions1/2, the same trusted headers, session visibility and source attribution, and one committed dedup response in a single transaction. New pair validation binds witness, source, receipt, dedup, event hashes, original identity, scope, authority, kind, both content hashes and literal redacted body. Receipt `content` has only format/hash; receipts never carry the body. Stored receipts do not contain `replay`; the detached facade adds it under the existing rule.

Before insertion, validate encoded command/prepared append, both payloads, full pair, receipt/result correlation envelope and full-note returnability. Check body and source metadata reserves sufficient for the eventual dedicated reply's bounded receipt/fence/closure. A successful commit must not contain an admitted body that the specified full-note lane can never return for size reasons. Projection capacity, lag and admission can still refuse a read; a write receipt is not a publication or current-authorization-at-delivery guarantee.

Keep source eligibility unchanged: `source-event` and `retained-evidence` selectors must resolve to eligible authenticated `EvidenceBatchRetained` schema1 records under the existing authority/binding rules. A new governed note does not automatically become eligible provenance. No recursive note graph or new evidence blob is created.

V2 recovery can return authenticated receipt1 or2 within a resultVersion2 envelope, selected by the receipt's exact discriminator. V1 recovery of a valid V2 commit first performs ordinary admission/current-authority and version-aware pair/dedup authentication, then returns the existing safe `GOVERNED_NOTE_FORMAT_UNSUPPORTED`, message equal to code and details `{}`. Do not describe valid V2 truth as corruption, not-found, or a made-up V1 receipt. An actual missing pair follows the existing serialized not-found rules; damaged/orphaned truth remains integrity failure.

Keep all reservation checks at generic preparation, planning, append, replay and dedup. Recognize the V2 marker independently of a malformed/missing normalized key; both old markers and `governed-note/` identity prefixes remain reserved. A malformed reserved source cannot escape through an ordinary MemorySourceRecorded path.

Preserve the absorbing OWNERSHIP_UNCERTAIN state and existing mandatory R/C/L timing configuration. Only confirmed normal close permits same-run reopen. Failed rollback, possible late commit, lost worker response, forced close or uncertain cleanup cannot revive an owner. No automatic resubmission, proof renewal, replacement IDs, cross-parent adoption or fixture reset is introduced.

## 6. Schema3 projection and immutable historical genesis

Create schema3 as a new projection profile; retain schema1/2 SQL, source decoders, row serializers and checksum inputs as frozen historical profiles. Add `PROJECTION_SCHEMA_SQL_V3`, `PROJECTION_NAMES_V3`, `ProjectionManifestV3` and the `projections-3-${generation}.sqlite` filename family. New builders publish schema3. Old images are verified under their own profile, never relabeled3 or rewritten in place. Stage, validate, publish, recover/reconcile and retire generations using their exact schema-specific manifest/filename profile and existing ownership/lease rules; a schema3 bump alone is insufficient.

Schema3 adds one projection, `governedNotes`, stored in `governed_notes` inside the same immutable SQLite image. Its exact canonical checksum row fields are:

`{projectId,itemId,recordKind,format,body,bodyContentHash,sourceEventPosition}`. Represent `sourceEventPosition` as its canonical unsigned decimal string, never bigint or Number. Preserve explicit null fields. Sort rows by binary lexical `projectId`, then binary lexical `itemId`, ascending; builders, replay and captured-table checksum serialization must use that same order.

The table uses `(project_id,item_id)` as primary key, references the matching canonical item, accepts only the four note kinds, and stores a positive source position bound to that canonical item. `format`, `body`, `body_content_hash` are either all null or all present. Present content requires `format='markdown'`, the body validity/byte rules and a64-lowercase-hex hash verified against the literal text. Canonical items carrying either reserved governed verification marker must have the corresponding side row: the V1 marker requires all-null body fields, the V2 marker requires present body fields, and kind must agree with the authenticated pair and normalized key. A missing V1/V2 side row is not a generic item's unknown kind. A generic item with no reserved marker must have no side row; reserved-prefix/marker disagreement is integrity failure. Validate these cross-table rules before the generic unknown-kind/body-absent branch. Schema construction, row capture and full integrity validate these invariants, including orphan/duplicate/source-position mismatch; SQL JSON validity alone is insufficient.

- Authenticated V1 governed pairs project known kind and all-null body fields.
- Authenticated V2 governed pairs project known kind and the inline source's redacted body/hash/format.
- Generic historical canonical items have no governedNotes row; their kind is unknown and their body is absent.

Derive V1 kind from the authenticated pair/witness, not guessed normalized-key text. Both pair validators produce the dedicated projection metadata alongside the existing body-free canonical source disposition. Created remains an explicitly validated non-projection event. Do not change canonical summary rows, lexical chunks, FTS input, vectors, context results or ranking text to use body content.

Schema3's exact checksum-name list is `sessionTree`, `sessionCheckpoints`, `canonicalItems`, `tasksFollowups`, `artifactsFiles`, `entityGraph`, `lexicalChunks`, `retrievalFeedback`, `governedNotes`. The frozen schema2 list omits only `governedNotes`; the frozen schema1 list additionally omits `sessionCheckpoints`. Preserve the checksum domain and include schema3, the complete sorted new rows and terminal position using the existing canonical checksum algorithm. Capture the new table in owned image validation, manifests, deterministic folds, rebuild, quick/full integrity and exact-ID reads. Validate body hash independently as well as image/checksum truth. No external unchecked body file, separate database or post-image body fetch is permitted. Preserve event replay's100,000-event/64MiB aggregate/1MiB stored-row limits and the checksum/image bounds in section3; capacity overflow refuses rather than widening a historical limit.

Historical fresh-start genesis is an exact11-field object with a bare eight-name checksum map. It has no persisted version/schema field; freeze that legacy decoder as GenesisV1 tied permanently to the schema2 empty profile. Schema1 image support is not evidence of a schema1 fresh-start genesis; do not invent one.

New GenesisV2 keeps the11 fields and adds exact `genesisVersion:2` and `projectionSchemaVersion:3`. Its `projectionChecksums` is the exact nine-name schema3 empty map. Validate semanticPosition0, the existing genesis hash and schema-selected empty checksums. Persist its discriminants in the existing immutable `projection_checksums_json` column as:

```ts
type StoredGenesisChecksumsV2 = Readonly<{
  genesisVersion: 2;
  projectionSchemaVersion: 3;
  projectionChecksums: Readonly<Record<ProjectionNameV3, string>>;
}>;
```

The map contains the eight existing names plus `governedNotes`, each bound to schema3/project/zero-position/empty rows. The envelope is exact; legacy rows stay bare maps byte-for-byte. A shared codec handles initializer, repository, journal/recovery and independent read admission so they do not reconstruct inconsistent shapes. No event-store SQL migration or old installation-row rewrite is selected; the existing JSON column already stores the envelope. Reject mixed/unknown discriminants and tampered maps.

A store with legacy schema2 genesis may publish a schema3 image after deterministic rebuild. Genesis attests its immutable initialization profile; image attests the selected current projection profile. Compatibility does not waive build/release/configuration identity, trusted operator gates, active-mode/control-generation checks, maintenance fences or recovery anchors.

| Format being consumed | Required behavior |
| --- | --- |
| Historical source/event families | Their exact historical codec/hash; new builders can fold them |
| Schema1 image | Existing legacy consumers and integrity support remain; no newly fabricated rich-content/full-note support |
| Schema2 image + legacy genesis | Ordinary eligible private reads continue under schema2; full-note requires a schema3 publication |
| Schema3 image + legacy or V2 genesis | Ordinary eligible private reads use rich schema3 queries; dedicated full-note is allowed |
| Unknown image/genesis/source version | Fixed refusal; no fallback to a different profile |

Extend schema-dependent manifest, builder, coordinator, reader-lease, image reader, integrity, database-core and content-query code by explicit profile selection. The publisher's already-sufficient-position fast path must also require the requested target profile. When a schema2 image already meets the minimum position but schema3 is requested, build and publish a new schema3 generation at the same authenticated terminal position/hash, even with no new events. Never reinterpret or mutate the schema2 image. The read-only child waits or refuses; it does not perform the upgrade. Preserve deadline checks, publication ownership and lease protection through this path. In particular, schema3 must use rich schema2-compatible query columns; it must not fall through current `===2` branches into legacy SQL. Preserve ordinary ranking/bounds strings and result shapes.

Workflow cursors retain opaque version1 and existing fields, with `schemaVersion:2|3` equal to the actual image. A schema2 cursor remains valid only on its bound schema2 generation/hash/selection; cross-schema or cross-image use is stale. Never label a schema3 cursor as2 to satisfy an old check.

## 7. Dedicated exact-ID read and whole-envelope validation

```ts
type GetFullNoteRequest = ContentReadBase & Readonly<{
  operation: 'get-full-note';
  parameters: NativeContentFilters & Readonly<{ id: string }>;
}>;
type NativeFullNoteItem = NativeContentItem & (
  | Readonly<{ recordKind: GovernedNoteKind; bodyAvailability: 'present';
      content: { format: 'markdown'; body: string; contentHash: string } }>
  | Readonly<{ recordKind: GovernedNoteKind | null; bodyAvailability: 'absent';
      content: null }>
);
type NativeFullNoteResultV1 = Readonly<{
  operation: 'get-full-note';
  noteBoundsVersion: 'v2-full-note-bounds-1';
  selectionScope: NativeSelectionScope;
  item: NativeFullNoteItem | null;
  conflict: NativeGetConflict | null;
}>;
```

Reuse existing get request ID/filter domains, eligibility, scope and temporal rules. Accept no body-return option on an old operation. The dedicated lookup selects one eligible canonical item and matching governedNotes row from the same captured schema3 image. Its inherited `text`/`textKind` remain the summary. A V1 note returns its known kind, `bodyAvailability:'absent'`, `content:null`; a generic item returns unknown kind (`null`) and absent body. No fabricated Markdown or summary-to-body conversion occurs. A missing/ineligible item yields `item:null,conflict:null` under existing get semantics. A full-body pair with missing/invalid projection content is integrity failure, not body absence.

Use a dedicated version4 bootstrap/reply/cancel family with the existing IDs/binding/request/lock/remaining-time, stage phases, fence, cleanup and terminal closure structure. Only `get-full-note` is permitted in this family. Its success receipt has the existing verified-read receipt fields, operation `get-full-note`, plus exact `projectionSchemaVersion:3`; success `content` is NativeFullNoteResultV1. Stages and failures retain existing safe fields and16KiB bounds. Existing operations continue version3 with16KiB complete replies on schema2 and3. Cleanup ownership/bootstrap protocol remains its existing version1.

Extend operation dispatch throughout owned child and supervisor, not just the inner result decoder. At ingress, correlate to an already admitted full-note request, verify exact version/kind/keys, then apply its path-specific owned body allowance and256KiB complete-success ceiling. Reject a large body hidden in IDs, diagnostics, receipt, conflict, metadata, stage/failure or an old operation. Revalidate operation, selected scope, requested ID, actual schema, image hash/generation/position, content hash, fence, closure and enum/discriminator correspondence after copy. The parent returns only a frozen owned result.

The child captures one locked named image within the existing64MiB cap, verifies bytes/provenance/checksums/scope/position, queries it, revalidates admission and closes image/reader/lock before emitting success. It does not fetch body from the event store or another snapshot after releasing the image. Session-strong/project-strong positions, deadline enforcement, same-scope isolation, cancellation and uncertain cleanup retain existing behavior. If no schema3 view satisfying the requested position becomes available within budget, refuse using existing schema/lag/timeout errors; do not return an older summary as a successful full-body read.

## 8. Closed errors and privacy

Use the current closed governed-note errors for input/limits/policy/key/provenance, conflict, authority, integrity, availability and unknown outcomes. Existing `GOVERNED_NOTE_FORMAT_UNSUPPORTED` covers valid version refusal. Dedicated read uses the existing closed verified-read errors, including `V2_CONTENT_RESULT_TOO_LARGE`, `FRESH_START_SCHEMA_MISMATCH` and integrity/lag/admission/cleanup failures. Do not add caller-controlled messages, paths, SQL details, body excerpts, raw policy values or raw-input digests.

Canonical persisted body is redacted plaintext, like the existing persisted summary. Raw input and transient spans are excluded from events, dedup results, receipts, diagnostics, errors, logs and metrics. The keyed historical original-input commitment is the equality authority; clear owned buffers where possible without claiming complete erasure of runtime strings. Existing retained encrypted-evidence and key custody contracts remain separate.

## 9. Required adversarial acceptance and verification scope

The executable plan must name causal focused test cohorts and required integration gates. Do not run broad reassurance sweeps after those pass, reuse failed fixtures, reset stores, or describe historical qualification as proof of these new interfaces.

1. **Literal creation and kinds:** each of four kinds, separate summary/body; LF/CRLF/tabs/indentation/trailing spaces/code fences/Thai/non-BMP/NFC variants; policy redaction changes only intended spans. Old V1 inputs/receipts remain exact.
2. **Limits and ownership-safe codecs:** raw/final65,536 and65,537-byte boundaries, redaction expansion, six-byte control-escape rejection, malformed surrogates, empty/whitespace-only content, escaping-heavy valid bodies, metadata reserve/full-envelope caps, aggregate span limits, depth/arrays/containers, getters/proxies/exotic inputs; no getter invocation or unintended scalar exceptions. Measure actual encoded replies, not only body length.
3. **Equality and hashes:** same identities/exact raw input replay same pair; changed raw bodies with identical redacted display conflict; historical key rotation/missing historical key; independent summary/body/format/kind/hash/version mismatches and cross-version identity conflicts. RecoveryV2 returns receipt1/2; recoveryV1 refuses a valid V2 result without claiming corruption or absence.
4. **Atomic authority and privacy:** direct same-session/root/child positives and sibling/ended/revoked/transferred/scope-mismatch negatives; provenance retains current eligibility; generic reserved-family forgery fails; precommit packing failure leaves no pair/dedup; transaction and post-commit faults preserve original IDs, unknown outcomes and absorbing owner uncertainty. Errors/logs/receipts carry no raw body.
5. **Schema and genesis:** frozen schema1/2 checksum vectors and legacy11-field genesis/bare-map round trip; V2 genesis strict envelope; legacy genesis with schema3 rebuild, including an already-sufficient schema2 image with no new events; unknown/mixed/tampered versions refuse. Deterministic fresh rebuild and published checksums include governedNotes with the specified position representation, nulls and row order; missing/orphan/duplicate/mismatched body rows, altered bytes/hashes/kinds/positions and recognized reserved malformed source fail integrity.
6. **Reads and regression:** full-note returns literal redacted body after write at least at receipt terminalPosition; V1 note kind/body absence and generic unknown kind; wrong scope/ID/temporal filters and stale admission refuse or follow existing absence semantics. Old summary search/get/list/recent/context/radar text, ranking, caps and result shapes remain unchanged; actual cursor schema/hash binds correctly. Actual query-plan/visited-row checks cover the indexed exact-ID side-table lookup.
7. **Transport and cleanup:** real worker request/receipt and real compiled private read child cross-process round trip,256KiB success vs16KiB old-route boundary, overflow/malformed/cross-operation/correlation errors, frozen detached result, whole-image checksum, deadline/cancel/fault paths, closure before success and unavailable owner after uncertain rollback/cleanup. Do not count in-process mocks as native proof.

Final qualification uses a fresh disposable private fixture and retained original recovery IDs, records source/build/dependency/provider/policy/timing identities and measured scope/positions, and obtains spec/quality/security review appropriate to this increment. It demonstrates private read-after-write, not public routing or production readiness. Historical945-pass summary qualification is preserved as historical evidence only; this documentation session runs no product tests or qualification.

## 10. Source map and handoff

The plan must cover the following existing responsibility groups with targeted versioned units; no unrelated restructuring is selected:

- `src/orchestrator/governed-notes/{contracts,codec,intent,authority,service,repository,pair-validation,worker-protocol,run}.ts`, runtime/fixture composition, `privacy/redaction.ts`, and reserved `storage/event-append-transaction.ts` seams.
- `src/orchestrator/projections/{schema,checksum,contracts,source-event-codec}.ts`, builder/folds/manifest/coordinator/image/integrity/lease consumers, `retrieval/database-core.ts`, and `fresh-start/{contracts,fresh-start.repository,fresh-start-initializer}.ts` plus independent `verified-read/admission.ts`.
- Dedicated full-note contracts/query/result/protocol alongside `src/orchestrator/verified-read`, with explicit changes to `wire-data`, protocol/child/supervisor dispatch and workflow cursor schema discrimination. Existing generic limits and result fields stay scoped.
- Focused governed-note, projection/genesis, private-read and native integration fixtures/tests, plus the required bounded profile entries and final evidence publication.

This document is ready for written-spec review. After that approval, write and review the executable implementation plan using the existing Subagent-Driven choice. Product implementation starts only after the plan review gate; this document does not represent that approval.
