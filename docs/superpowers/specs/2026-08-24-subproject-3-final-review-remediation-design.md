# Subproject 3 Final-Review Remediation Design

**Status:** Draft for user review — architecture approved 2026-08-24
**Amends:** [Subproject 3: Deterministic Projections and Explainable Retrieval Design](2026-08-23-subproject-3-projections-and-explainable-retrieval-design.md)
**Program:** Full Event-Sourced Project Memory Orchestrator
**Depends on:** Subprojects 1 and 2, the Version 2-disabled release gate, and Node.js >= 24.16.0
**Unblocks:** a reviewed completion of Subproject 3; it does not unblock Version 2 routing

## 1. Purpose

The independent whole-branch review rejected Subproject 3 because its focused
tests did not prove the full projection and retrieval contract. This amendment
closes the three critical and four important findings without changing Version
1 behavior or making Version 2 reachable from production.

The resulting Version 2 read model must be an authenticated, bounded,
replayable derivative of the authoritative event store. Its release evaluation
must exercise the same build, immutable generation, reader, candidate
repository, and retrieval service used by the internal runtime.

## 2. Scope and fixed boundaries

This remediation delivers all of the following as one internally compatible
projection schema version 2:

1. Authenticate the complete authoritative source-event prefix before any
   event is decoded or folded.
2. Bound live source snapshots by native event-count and aggregate-byte
   preflight, then stream authenticated rows in canonical global-position order.
3. Materialize the complete session, entity, artifact, follow-up, and
   provenance contracts required by the original design.
4. Pin verified projection bytes inside a reader lease; retrieval may not reopen
   the projected database by pathname.
5. Make result, token, diversity, and explanation limits unavoidable even for a
   custom internal ranker.
6. Keep a generation staged until coordinator adoption and reconcile every
   non-manifest final-named generation under the existing cooperative publish
   lock.
7. Replace the answer-driven evaluation test with a sealed, real build-to-query
   corpus and a frozen Version 1 baseline comparison.

The following remain non-goals and are explicitly forbidden in this amendment:

- changing `src/app.ts`, `src/index.ts`, `src/controllers`, `src/schemas`, or
  `src/services` to route a production request through Version 2;
- registering a Version 2 tool, enabling primary mode, adding an external
  provider, changing the Version 1 retrieval contract, or changing an
  authoritative event while building a projection;
- raw-evidence encryption, global promotion, retention, legacy import,
  backup/restore, compatibility materialization, user-visible shadow mode, or
  production cutover. Those remain Subprojects 4 and 5.

## 3. Versioning and compatibility

Projection schema version 2 is a new derived-data format. A V1 manifest and a
V2 manifest never share a database filename, checksum domain, reader lease, or
candidate repository. The coordinator rebuilds V2 from authoritative events;
it never migrates V1 rows in place. A reader rejects an unsupported schema
version before opening any projection bytes.

The public event store and all Version 1 paths remain byte-compatible. New
projection-only event payload variants are strict decoders for future governed
source producers; this subproject does not add a public mutation route for
them. Existing supported V1 source variants retain their documented projection
semantics, while V2 variants carry the additional fields below.

## 4. Authenticated, bounded source snapshots

### 4.1 One authoritative verification primitive

Projection code must use a shared pure verifier extracted from the existing
authoritative event-integrity implementation. It must not implement a second,
similar hash calculation. Given canonical stored-event fields, the verifier
must:

1. parse the canonical payload bytes and reject noncanonical or over-bound
   payload JSON;
2. recompute and compare `payloadHash` from those canonical bytes;
3. recompute and compare `eventHash` from every authoritative header and
   canonical payload field in the established event-hash domain;
4. require `previousGlobalHash` to equal the immediately preceding verified
   hash, beginning at `GENESIS_GLOBAL_HASH`;
5. require strictly consecutive global positions and a terminal hash equal to
   the captured snapshot terminal hash.

The snapshot verifier authenticates every event in the captured authoritative
prefix, including event types the projection decoder intentionally marks
unprojected. A malformed header, payload, payload hash, event hash, predecessor
hash, position, binding, or terminal hash fails with `INTEGRITY_FAILURE` before
the first fold and produces no generation.

### 4.2 Bounded read contract

`SqliteProjectionEventReader` opens one read transaction and first executes
native SQL preflight over exactly the captured source prefix. The preflight
returns both `COUNT(*)` and the sum of the canonical stored-row byte expression.
It rejects a prefix over 100,000 events or 64 MiB before materializing a row.
It then iterates rows in ascending `global_position`, feeds each row through the
shared verifier, and provides a one-pass immutable authenticated event stream to
the builder. The builder may not call an unbounded `.all()` snapshot or retain a
second full decoded copy.

The coordinator applies its absolute consistency deadline to preflight,
iteration, build, validation, and publication. If that deadline expires, it
closes the source transaction, retains no generation authority, and reports the
existing typed lag/deadline error. Tests must cover event-count overflow,
aggregate-byte overflow, a corrupted event that is intentionally unprojected,
metadata tampering with an unchanged payload, a predecessor-chain gap, and a
terminal-hash mismatch.

## 5. Complete schema-V2 projection contract

All rows below are derived only from authenticated events and include their
`source_event_id`, `source_event_position`, and a redacted canonical anchor
when one exists. No row contains raw evidence, handles, authorization values,
or provider input.

### 5.1 Session topology and continuity

`session_tree` stores one row per session with `root_session_id`, nullable
`parent_session_id`, lifecycle state, owner generation, opening and closing
event positions, and latest verified checkpoint reference. A separate
`session_checkpoints` relation retains each checkpoint in position order rather
than overwriting it. The fold rejects a cycle, an unknown parent, a root/child
binding mismatch, an impossible terminal state, or a checkpoint whose base
position is outside its authenticated ancestor history.

The internal continuity channel traverses only this authenticated root/parent
tree, from the request session to its permitted ancestors and children, and
returns a source-event citation for every returned checkpoint or follow-up.

### 5.2 Governed items, follow-ups, artifacts, and entities

The strict, versioned governed-source decoder accepts a V2 payload only when it
contains exact bounded fields for its canonical item, follow-ups, artifacts,
entities, aliases, and typed entity edges. V1 variants remain explicitly
decoded as V1; omitted V2 fields are never inferred from free text.

- `tasks_followups.status` is exactly one of `open`, `blocked`, `completed`,
  `carried-forward`, or `abandoned`; each row carries its source event and
  canonical anchor.
- `artifacts_files` stores path, nullable symbol, nullable commit hash,
  nullable heading, content hash, freshness metadata, source event, and anchor.
  Symbol and heading lookup use structured columns, never a substring fallback.
- `entity_nodes`, `entity_aliases`, and `entity_edges` store normalized entity
  identity, aliases, typed directed edges, validity, and source provenance.
  The logical `entity_graph` checksum covers the canonical union of all three
  relations in a fixed primary-key order.
- `canonical_items`, `lexical_chunks`, feedback-derived explanations, and every
  retrieval item preserve source-event IDs and anchors. A result whose source
  has no allowed canonical anchor reports `anchor: null`; it may not invent one.

Each V2 relation is included in the schema-V2 checksum domain and full
integrity replay. Event-to-build-to-repository tests, rather than hand-inserted
derived rows, must prove entity/alias traversal, root-child continuity,
structured symbol/commit/heading lookup, all five follow-up states, and
provenance citations.

## 6. Verified reader lease

`ProjectionReaderLease` owns a private read-only `DatabaseSync` image created
from the exact verified generation bytes. Lease acquisition captures bytes with
the existing stable-directory descriptor/identity guard, verifies their manifest
SHA-256 and V2 metadata, deserializes a private image, enables defensive and
query-only mode, and only then returns the lease.

The lease exposes the prepared read-only database resource, manifest, and close
operation; it no longer authorizes retrieval through `databasePath`.
`SqliteRetrievalCandidateRepository` receives that pinned resource and must not
construct `DatabaseSync` or reopen a path. Closing the lease closes the private
image and releases the logical generation reference exactly once. Replacing,
renaming, truncating, or mutating the generation pathname after lease
acquisition cannot change query bytes. Regression tests must perform each of
those actions between acquisition and query and prove the result remains the
verified image or fails closed before querying.

## 7. Ranking and response hard limits

Default and custom rankers share a mandatory post-ranking selector. A custom
ranker may only reorder eligible, uniquely identified candidates supplied by
the service; it may not inject an item, alter its channels/reasons/metadata,
duplicate an item, or return an unbounded array. The selector then applies the
same stable diversity, `limit`, token budget, conflict accounting, explanation
byte budget, and defensive-drop rules as the default path.

The internal runtime either receives a ranker satisfying this contract or uses
the default ranker. Hostile-ranker tests must show that excessive candidates,
duplicate IDs, forged items, oversized explanations, and an order that exceeds
the token budget cannot escape the selected result.

## 8. Generation staging, adoption, and orphan reconciliation

The builder returns a validated `StagedProjectionGeneration` whose database has
a unique temporary name. It never promotes that file to a final generation name.
While holding the existing cooperative manifest-publication lock, the
coordinator alone adopts the staged file with an identity-bound no-clobber
install, validates its manifest payload and checksums, publishes the manifest,
and records verified ownership.

Because a process can stop between no-clobber install and manifest publication,
startup and every coordinator entry reconcile final-named generations not
referenced by the active manifest. Under the same lock, reconciliation validates
directory and file identity, preserves active or leased generations, and removes
only a positively identified unpublished V2 generation. Missing, unreadable,
or validation-uncertain observations poison the publication transaction and
retain recovery evidence; they never authorize deletion or unlock as a false
supersession. Temporary files are also reclaimed only by the identity-bound
stable-directory helper.

Fault and deadline tests must assert: no orphan after a builder failure,
deadline, pre-install fault, post-install/pre-manifest fault, failed manifest
publish, coordinator restart, and Windows deletion retry. Tests must also prove
an active or leased generation is never selected for reconciliation.

## 9. Sealed real evaluation harness

The release corpus becomes `retrieval-evaluation-v2` and is a content-addressed
fixture bundle containing:

- canonical authoritative source events for the evaluated project and
  cross-project adversarial near-duplicates;
- 500+ bilingual judged queries, scope/temporal assertions, citations, and
  relevance grades, with at least 50 examples in every required critical class;
- a canonical manifest of every bundle file SHA-256;
- a frozen Version 1 shadow-baseline report, its corpus hash, producing V1
  version identifier, and the command provenance used to generate it.

The release gate seeds an isolated authoritative event store from those
canonical source events, builds and publishes a schema-V2 generation through
the real coordinator, acquires a real verified lease, and invokes the real
candidate repository and internal retrieval service. It disables vectors for
every request. It may not map query IDs/text to result IDs, construct results
from answer keys, replace the repository, or bypass the builder. Unit tests may
keep small fake services only to test corpus parsing and metric arithmetic; they
are not release evidence.

The evaluator verifies the bundle manifest and frozen-baseline provenance before
any query. It calculates contamination from every returned item before any
ranking-metric deduplication, rejects any cross-project item, and compares each
V2 release metric to the frozen V1 baseline as well as the original absolute
thresholds. A changed corpus, changed baseline, altered query answer key, or
attempt to enable vectors fails the gate.

## 10. Required verification and release rule

The remediation is acceptable only when all of these pass on Node.js 24.16.0
or newer on Windows and Linux:

1. targeted red/green tests for each invariant in Sections 4–9;
2. schema-V2 build → manifest → verified lease → real repository integration
   tests for every core projection relation;
3. the sealed black-box 500-query evaluation with zero contamination, all
   original absolute thresholds, and no metric below its frozen V1 baseline;
4. integrity replay against valid data and against payload, metadata, chain,
   projection-row, and byte-image tampering;
5. lifecycle isolation, build-artifact, runtime, typecheck, and V1 protected
   path gates;
6. a completely green full release suite, including deterministic retry or
   root-cause resolution for coordinator deadline instability.

Passing this amendment permits only a new independent Subproject 3 final review
and merge decision. It does not permit deployment or Version 2 routing. PROD
readiness still additionally requires Subproject 4 and Subproject 5, measured
shadow parity, backup/restore/replay, rollback fencing, and explicit production
cutover approval.
