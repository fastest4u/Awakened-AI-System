# Task 7 Sealed Real V2 Retrieval Evaluation Design

**Status:** Design approved by user 2026-08-28; pending written-spec review

**Amends:**

- [Subproject 3 Final-Review Remediation Design](2026-08-24-subproject-3-final-review-remediation-design.md)
- [Subproject 3 Final-Review Remediation Plan](../plans/2026-08-24-subproject-3-final-review-remediation.md), Task 7

## Purpose

Task 7 replaces the current answer-driven evaluation fixture with a sealed,
reproducible black-box evaluation of the real Version 2 retrieval path. The
evaluation must build an authenticated synthetic source, publish a Version 2
projection, acquire a verified evaluator lease, query through the V2 candidate
adapter and `InternalRetrievalService`, then score only those returned results.

The harness produces release evidence for the later shadow stage. It does not
enable a production route, tool, configuration option, deployment, canary, or
primary traffic. Version 1 remains the production authority.

## Problem

The current `retrieval-evaluation-v1` corpus gives an in-memory repository a
query-to-answer mapping. Its metric arithmetic is useful, but it does not
prove that an authoritative event can be projected, leased, queried, scoped,
and ranked by the V2 production-shaped implementation. It can therefore mask
projection, indexing, candidate-adapter, or isolation regressions.

## Decision

Use a sealed `retrieval-evaluation-v2` bundle with four separate artifacts:

1. `source-events.json` contains only deterministic synthetic source events
   accepted by the real authenticated event and projection builders.
2. `judgments.json` contains query text, eligible scope, independent relevance
   grades, citations, critical-class labels, and expectations. It contains no
   answer-to-candidate lookup and no raw evidence, credentials, or private
   data.
3. `v1-shadow-baseline.json` is a reviewed, immutable metric floor for the
   same judged corpus. It names its V1 corpus/version, records the canonical
   judgments hash, every metric, and its provenance command. The V2 harness
   may compare against it but must never rewrite it.
4. `manifest.json` declares the bundle schema/version and the SHA-256 of each
   non-manifest artifact's strict canonical JSON representation.

The evaluator strictly parses every artifact, rejects unknown keys, accessors,
duplicate logical identities, non-normalized strings, unsafe text, invalid
hashes, and any mismatch between the manifest, judgments, and V1 baseline.
The hash preimage is compact `JSON.stringify` output from the validated
plain-data object, not raw checkout bytes; this keeps integrity verification
independent of Git line-ending conversion.

## Interfaces

`src/orchestrator/retrieval/evaluation.ts` owns the sealed bundle contract:

```ts
export interface RetrievalEvaluationBundleV2 {
  readonly schemaVersion: 2;
  readonly corpusVersion: "retrieval-evaluation-v2";
  readonly files: Readonly<Record<
    "source-events.json" | "judgments.json" | "v1-shadow-baseline.json",
    string
  >>;
}

export interface FrozenV1ShadowBaseline {
  readonly schemaVersion: 1;
  readonly v1Version: string;
  readonly judgmentsSha256: string;
  readonly metrics: RetrievalEvaluationReport;
  readonly provenanceCommand: string;
}
```

`RetrievalEvaluationReport` gains the V2 corpus version without exposing
query text, judgment data, bindings, source-event data, database paths, or
lease details. A malformed or tampered bundle fails with
`RetrievalEvaluationCorpusError("RETRIEVAL_EVALUATION_CORPUS_INVALID")`.

## Real harness data flow

```text
sealed bundle -> strict parser + canonical hashes
              -> authenticated synthetic source events
              -> V2 coordinator -> published V2 projection
              -> verified V2 evaluator lease -> V2 candidate adapter
              -> InternalRetrievalService -> evaluation metrics + V1 comparison
```

The harness must seed at least 500 judged queries and at least 50 cases in
each existing critical class. Every critical class must include English, Thai,
and mixed-language queries. The source events must materialize all relations
queried by the judgments, including a cross-project near-duplicate. Every
request sets `vector.enabled` to `false`; any enabled-vector request is an
evaluation contract failure before retrieval begins.

The test harness may call the existing evaluator-only V2 lease and V2
candidate adapter directly. Those seams remain evaluator-only. It must not
import the V2 adapter into `InternalProjectionRuntime`, modify V1 reader
contracts, or add a path-based V2 reader.

## Scoring and acceptance rules

The harness counts cross-project contamination from every returned item before
deduplicating identifiers or result kinds. It computes the existing macro
ranking, citation, temporal, conflict, and high-impact metrics against the
sealed judgments. A successful evaluation requires all of the following:

1. zero cross-project contamination and zero failed queries;
2. the current absolute retrieval thresholds pass;
3. every V2 metric is greater than or equal to the same frozen V1 baseline
   metric, except that a lower stale-active-memory rate and a lower unsupported
   high-impact-verified-claim count are improvements; and
4. the report is frozen and aggregate-only.

A V2 result below the baseline, a source/projection/lease failure, a missing
expected relation, or any fixture-integrity failure blocks Task 7. The
baseline is evidence, not an automatic approval mechanism: advancing it is a
separate reviewed artifact change.

## Required test evidence

Tests must first show that the answer-driven V1 fixture is insufficient for
the new real-harness contract. They must then prove:

1. source events build a real V2 projection and every evaluated result comes
   from a verified V2 evaluator lease;
2. a changed source event, judgment, V1 baseline, manifest entry, unknown
   field, accessor, or non-canonical value is rejected before evaluation;
3. a cross-project near duplicate is actually present in the source but never
   enters an eligible result; an injected cross-project output is counted
   before metric deduplication;
4. vectors are disabled on every request and an attempted enabled vector fails
   the harness;
5. the corpus has the stated class/language coverage, independent judgments,
   and no answer-driven query-to-candidate map;
6. V2 meets every absolute threshold and the immutable V1 shadow baseline; and
7. the runner accepts only the compiled sealed evaluation target, reports only
   aggregate metrics, and CI rejects answer-derived evaluation behavior or
   V2 production wiring.

The focused evaluation command, TypeScript compilation, typecheck, and the
complete Subproject 3 gate must pass. Independent specification and
code-quality reviews are required. The established Windows `EPERM` symlink
capability skip is the only permitted executable-test skip.

## Authorized scope

This design authorizes changes only to:

- `src/orchestrator/retrieval/evaluation.ts`
- `tests/retrieval-evaluation.test.ts`
- `tests/fixtures/retrieval-evaluation/v2/source-events.json`
- `tests/fixtures/retrieval-evaluation/v2/judgments.json`
- `tests/fixtures/retrieval-evaluation/v2/v1-shadow-baseline.json`
- `tests/fixtures/retrieval-evaluation/v2/manifest.json`
- `scripts/run-retrieval-evaluation.js`
- `tests/ci-lifecycle-gates.test.ts`
- the Task 7 section of `docs/superpowers/plans/2026-08-24-subproject-3-final-review-remediation.md`

Task 7 does not authorize V2 runtime routing, a public API or tool, a V1
behavior change, a production configuration key, deployment, migration,
privacy/retention work, backup/restore, rollback activation, shadow traffic,
or a V2-primary production claim. Those remain later Subprojects 4 and 5 and
their explicit approval gates.

## Completion boundary

Task 7 completes only after the sealed fixture implementation, focused and
full gates, independent reviews, and a clean worktree are complete. It
provides required evidence for later shadow operation but does not itself make
V2 ready for production traffic.
