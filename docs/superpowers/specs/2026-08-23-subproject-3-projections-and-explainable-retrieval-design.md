# Subproject 3: Deterministic Projections and Explainable Retrieval Design

**Status:** Approved 2026-08-23; asynchronous publish boundary approved 2026-08-23
**Program:** Full Event-Sourced Project Memory Orchestrator
**Depends on:** Subprojects 1 and 2, including the Version 2-disabled release gate
**Unblocks:** Subproject 4 privacy and governed memory, then Subproject 5 migration, parity, backup, and cutover

## 1. Goal

Build a replayable, isolated Version 2 read model that can answer a retrieval
request with an explicit explanation of what was eligible, what was excluded,
and why each returned item was selected. The read model must be derived only
from the immutable event store. It must never become a second source of truth.

The production-visible Version 1 search and context-pack behavior remains
unchanged in this subproject. Version 2 retrieval is an internal, read-only
capability for deterministic replay, test evaluation, and the later shadow
comparison in Subproject 5.

## 2. Scope and non-goals

This subproject delivers:

- a versioned, per-project projection database and atomic manifest;
- pure event-to-projection folds for identity, lifecycle continuity, source
  anchors, current work, canonical-item state, conflicts, and lexical chunks;
- deterministic rebuild, checksum, reader lease, and consistency-barrier
  behavior;
- exact, lexical, graph, continuity, and optional vector candidate channels;
- strict filtering, versioned rank fusion, diversity, citations, and a bounded
  retrieval explanation;
- an offline Thai, English, and mixed-language evaluation harness.

This subproject does not deliver:

- raw-evidence encryption, promotion, global sharing, retention, or erasure;
  those remain Subproject 4;
- legacy Markdown import, user-visible shadow comparisons, compatibility
  materialization, backup/restore, rollback, or route activation; those remain
  Subproject 5;
- a change to Version 1 routes, public controllers, or tool registration;
- a provider credential, raw-evidence upload, or automatic external-provider
  opt-in.

## 3. Fixed safety constraints

1. A retrieval call receives a transport-private ProjectBinding. Model-visible
   input can narrow that bound scope but can never select another project,
   workspace, branch, store, or global audience.
2. Every eligibility filter runs before candidate ranking. A score, graph edge,
   vector, alias, or conflict relationship can never reintroduce an ineligible
   item.
3. Projection files are derived state. A failure, corruption, or stale
   generation can be repaired by rebuilding from events; it must never repair,
   rewrite, or infer authoritative events.
4. Version 2 read results are unavailable from the production composition root
   until Subproject 5 completes the off-to-shadow-to-primary release process.
5. The implementation must preserve the Task 19 V1 isolation gate. In
   particular, no Subproject 3 commit changes src/app.ts, src/index.ts,
   src/controllers, src/schemas, or src/services to route a production request
   through Version 2.
6. Projection content contains no raw evidence, session handles, provider keys,
   authorization values, or unredacted diagnostic command fields.
7. All projection and retrieval requests have explicit work, result, and
   response-size limits. No input may turn an explain or search request into an
   unbounded event scan.

## 4. Architecture

### 4.1 Per-project derived database

The existing per-project event store remains authoritative. A projection
generation is a separate SQLite database located beside that project store and
named by projection schema version and monotonically increasing generation.
The active manifest is a small canonical JSON file containing:

- project, vault, store, workspace, and branch binding assertions;
- projection schema version and generation;
- terminal event position and event hash;
- immutable database filename and file hash;
- core logical checksums by projection;
- vector-cache manifest hash, when a cache exists;
- creation timestamp and builder version.

A builder writes a new generation to a unique temporary path. It validates
identity, terminal position, foreign references, row counts, and core
checksums before atomically replacing the manifest. It never replaces an open
generation in place.

Readers first pin the manifest generation, then acquire a reader lease for that
generation. A generation is eligible for deletion only after a later manifest
has been published and all leases on the old generation have expired. On
Windows, deletion failure is retried by maintenance; it is not treated as a
reason to rename or overwrite an open SQLite file.

### 4.2 Event decoding and source boundaries

Projection input is a strict, versioned union. The projector decodes each
committed event with the same authoritative event codec used by event integrity
and lifecycle folds. Unsupported event types are recorded in the build report
as intentionally unprojected; they are not guessed, partially parsed, or
silently converted into memory.

The first projection schema recognizes three source families:

- existing Version 2 lifecycle and checkpoint events, which produce session
  continuity, open-work, and checkpoint anchors;
- governed source events, defined as immutable source records or state changes
  emitted by their owning future subproject, which produce canonical-item and
  artifact projections;
- retrieval-feedback events, which are append-only measurements and never
  change an item's eligibility or truth state.

Subproject 3 defines pure decoders and folds for governed source events but
does not expose a public mutation path for them. Subproject 4 owns governed
promotion and state-change producers. Subproject 5 owns legacy import
producers. This keeps projection logic usable and testable without letting an
indexer invent authoritative content.

### 4.3 Asynchronous projection publish and rebuilds

The existing lifecycle projection writer continues to maintain only its
authoritative, same-store lifecycle folds inside the event transaction. It must
not attach, write, or coordinate a transaction with a derived projection file.
The Version 2 projection database is an asynchronous derived read model.

After an authoritative event commit, a ProjectionBuildCoordinator observes the
committed event store from the position after the last published manifest. It
opens a bounded read snapshot, records that snapshot's terminal event position
and hash, writes one new projection generation, validates identity, row counts,
references, and core checksums, and atomically publishes the generation
manifest. A process crash can leave an unpublished temporary generation but
cannot change the authoritative event store; startup discards that temporary
file and resumes from the last verified manifest.

The live builder may copy an already verified generation as an input
optimization, but every published generation is independently validated and
fully replayable. A full rebuild always begins at event position zero or a
verified immutable projection snapshot, applies the same pure folds, and
produces the same logical rows and core checksums. Replay never calls an
embedding or reranking provider.

When a request requires a projection event position that has not been
published, the reader signals the coordinator and waits only until its bounded
consistency deadline. It then returns PROJECTION_LAG with the current and
required positions. It must not return an older generation while claiming a
stronger consistency level.

### 4.4 Core projections

The first schema has the following bounded, versioned projections:

| Projection | Derived purpose |
| --- | --- |
| project_identity | Bound project, vault, store, workspace, and branch identity required to reject cross-store reads |
| session_tree | Root and child state, owner generation, checkpoints, open work, and continuity anchors |
| canonical_items | Scoped candidate, provisional, verified, conflicted, superseded, retracted, expired, and erased-evidence metadata |
| tasks_followups | Open, blocked, completed, carried-forward, and abandoned work with source anchors |
| artifacts_files | Paths, symbols, commits, hashes, headings, and source freshness metadata |
| entity_graph | Normalized entities, aliases, typed edges, and source provenance |
| lexical_chunks | Versioned section-aware text chunks, exact identifiers, and FTS5 terms |
| retrieval_feedback | Accepted, dismissed, corrected, and usefulness measurements |

Each canonical row stores a canonical identifier, normalized key, scope,
valid-from, optional valid-to, known-from event position, status, confidence,
verification method, source event identifiers, source anchors, staleness
reason, and projection version.

All temporal reads use inclusive valid-from and exclusive valid-to. A missing
valid-to means the claim remains valid. A requested known-at position may never
read a row learned after that position. An occurred-at value outside the
configured clock-skew window is retained with a clock-skew marker and cannot
promote a claim by itself.

### 4.5 Checksums and integrity

Each core projection has a logical checksum over rows ordered by a strict
primary-key order and serialized with existing canonical JSON rules. The
checksum domain includes the projection name, projection schema version,
project identifier, terminal event position, and each canonical row. It
excludes provider-generated vector bytes.

The build report records a checksum for every core projection, a total source
event count, projected-event count, intentionally-unprojected count, and the
terminal event position/hash. Full integrity replay recomputes all of them and
rejects missing, extra, cross-project, noncanonical, or out-of-order rows.

Vector cache rows are separate from core checksums and are keyed by source hash,
provider, model, chunker version, dimensions, and output hash. A cache manifest
validates stored bytes without claiming that a regenerated external vector must
be byte-identical.

## 5. Retrieval contract

### 5.1 Request

The internal Version 2 retrieval request contains:

- the private ProjectBinding;
- nonempty query text subject to a documented byte limit;
- bounded result count, token budget, and consistency deadline;
- optional session, visibility, valid-at, known-at, and include-global
  assertions;
- explicit explain flag, default false.

Global memory is always false in this subproject because Subproject 4 has not
implemented governed global promotion. A request that asks for it fails closed
with GLOBAL_SCOPE_DENIED rather than opening another store.

### 5.2 Eligibility filter

Before any ranking, the resolver confirms:

1. the projection manifest identity matches the private binding;
2. project, workspace, branch, and session visibility are eligible;
3. status is readable and evidence is not erased;
4. valid-at and known-at bounds are satisfied;
5. no source freshness or corruption rule excludes the item.

Conflict expansion happens only after filtering the conflicting members
independently. A conflict set cannot widen a result across scope boundaries.

### 5.3 Candidate channels and ranking

Eligible candidates may come from exact identifiers and aliases, FTS5 lexical
search, symbols and headings, entity graph traversal, session continuity,
latest checkpoints, open work, and a local vector-cache port. Each channel
returns its rank and a stable candidate identifier.

The resolver uses a versioned weighted reciprocal-rank fusion configuration.
It then reranks with verification state, provenance quality, temporal validity,
query intent, scope distance, conflict state, source freshness, and recorded
feedback. It returns conflict alternatives together rather than hiding
contradictions. A final diversity step bounds repeated sources and entities
before enforcing the token budget.

Version 1 remains the production result. Subproject 5 will run this resolver
against the same captured source snapshot and event position in shadow mode.

### 5.4 Provider boundary

Lexical, exact, graph, and continuity retrieval are always local. The vector
port defaults to disabled unless a local provider is installed and explicitly
enabled by project configuration. A future external provider requires a
per-project opt-in and may receive only redacted canonical chunks and the
minimum query text. Sending raw evidence is outside this subproject.

Provider failure returns a typed PROVIDER_UNAVAILABLE diagnostic and retries
the same request without the vector channel. It never changes scope, falls
back to another project, or makes an unmeasured ranking configuration primary.

### 5.5 Result and explanation

Every selected item contains its canonical or evidence identifier, source
event IDs, file or note anchor when present, status, confidence, verification
method, freshness, valid-at, known-at/event position, scope, contributing
channels, selection reason, and conflict/supersession reference.

The internal explain response additionally returns aggregate eligible and
dropped candidate counts, channel ranks, fusion contributions, rerank feature
names, drop reasons, pinned projection generation, and consistency positions.
It never returns encryption keys, raw evidence, handles, authorization data,
or provider input text.

## 6. Verification and exit criteria

Implementation must add deterministic tests for:

- three independent rebuilds of the same event store producing identical core
  checksums, terminal positions, and logical rows;
- atomic manifest publishing, reader pinning, expired lease cleanup, and a
  Windows reader that holds an old generation during a rebuild;
- malformed, unsupported, missing, extra, cross-project, and reordered
  projection rows failing full integrity without an automatic repair;
- every hard filter, including identical content in two projects and conflicting
  items across workspaces and branch scopes;
- exact identifier/path/symbol lookup, Thai/English/mixed lexical queries,
  session continuity, open-work retrieval, conflicts, valid-at, and known-at;
- provider failure falling back locally while preserving the same scope and
  explanation shape;
- result and explain payload bounds plus secret-bearing input redaction.

The evaluation harness stores an immutable, versioned corpus with at least 500
judged Thai, English, and mixed-language queries and at least 50 queries in
each critical class: identifiers, code artifacts, session continuity,
follow-ups, stale/superseded facts, conflicts, cross-project near duplicates,
semantic paraphrases, and temporal boundaries.

Subproject 3 exits only when the following are true:

- cross-project contamination is zero in automated and evaluation corpora;
- exact eligible identifier/path recall is 1.00;
- current-session checkpoint, open-follow-up, and next-action Recall at 10 is
  1.00;
- citation precision and recall are at least 0.95;
- stale active-memory rate is at most 0.01;
- Recall at 10 is at least 0.95, MRR at least 0.90, and nDCG at 10 at least
  0.90, without regression from the frozen Version 1 shadow baseline;
- bitemporal answer accuracy is at least 0.95;
- all existing typecheck, full-test, build-artifact, lifecycle isolation, and
  security gates pass;
- no Version 2 retrieval tool or lifecycle route is registered for production.

## 7. Handoff to later subprojects

Subproject 4 may add redacted evidence, governed promotion, retention,
retraction, cryptographic erasure, provider-consent, and global-audience event
producers. It must preserve this subproject's filters, replay determinism, and
non-secret projection contract.

Subproject 5 will add the idempotent legacy importer, compatibility
materializer, snapshot-aligned parity reports, backup/restore/replay, rollback
fence, operational runbooks, and the only permitted off-to-shadow-to-primary
routing transition. It may not enable primary mode until every exit criterion
in this document, Subproject 4, and the program cutover gates has passed and
the user approves the measured parity report.
