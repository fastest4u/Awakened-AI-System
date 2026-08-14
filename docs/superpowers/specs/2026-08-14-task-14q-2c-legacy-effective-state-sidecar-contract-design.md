# Task 14Q.2c: Legacy Effective-State Sidecar Contract

Date: 2026-08-14

Status: Design approved by the user; implementation may proceed.

Parent contract:
`docs/superpowers/specs/2026-08-11-task-14q-2-compatibility-log-renderer-contract-addendum-design.md`

## Decision

Amend the unreleased schema-4 migration 0004 with an additive immutable
sidecar table for historical outer Version 1 and Version 2
`SessionEndRequested` and `SessionEndAmended` events. Migrations 0002 and
0003 remain byte-for-byte unchanged. The sidecar is an explicit backfill
authority; migration 0004 never invents rows from mutable workflow state and
never silently makes an unbackfilled legacy history renderable.

The renderer continues to fail with `INTEGRITY_FAILURE` when a legacy event
has no valid sidecar row. A backfill is accepted only when its row is bound to
the immutable source event, the committed command hash, the workflow identity,
the canonical complete effective state, and (for amendments) the immediately
preceding sidecar source.

## Immutable row contract

The table is named `lifecycle_legacy_effective_state_sources` and contains one
row per legacy effective-state event. Its key and binding columns are:

- `project_id`, `source_event_position`, `source_event_hash`;
- `command_id`, `command_hash`;
- `session_id`, `workflow_id`, `workflow_generation`;
- canonical `effective_state_json` and its `effective_state_hash`;
- `evidence_window_state` and `effective_checkpoint_version`;
- nullable `predecessor_event_position` and `predecessor_event_hash`; and
- `source_contract_version = 1`.

The schema admits only a root session-end request/amendment event with outer
schema 1 or 2, command event index zero, an exact committed `command_dedup`
row, and matching event/workflow identity. The JSON/hash/size checks are
null-total. Update and delete triggers make the table append-only. Indexes
support exact lookup by `(project_id, source_event_position)` and command
binding without a history-sized scan.

Generation 1 request sources have no predecessor. A later source must point to
an earlier sidecar row for the same project/session/workflow, with generation
exactly one lower and the stored predecessor event hash unchanged. The
backfill writer decodes both states and validates the amendment delta and
evidence-window transition before inserting the row. It does not consult
`workflow_instances`, validation plans, or any mutable projection as semantic
authority.

## Runtime data flow

`SqliteLifecycleRenderClosureReader` authenticates the command and then loads
the sidecar row for a legacy event. It verifies the row against the event,
`command_dedup`, the decoded witness, the canonical effective-state decoder,
and the predecessor sidecar row. It passes only the decoded effective state
into `AuthenticatedLifecycleCommandV1`; `lifecycle-render-event.ts` continues
to strip the witness and exposes only the existing legacy semantic DTO.

Version 3 events keep their current event-carried path. Candidate inputs do
not gain a mutable or guessed legacy state. Missing, duplicate, malformed,
hash-divergent, predecessor-divergent, or witness-divergent sidecar data is
an integrity failure.

## Verification contract

Tests must prove a valid production-decodable legacy request and amendment can
be backfilled and normalized, while independent mutations reject at the
earliest boundary: missing source, event position/hash, command hash,
workflow/session/generation, state JSON/hash, evidence transition, predecessor
position/hash, non-canonical JSON, explicit JSON nulls, update, and delete.
Migration tests must preserve the existing 0002 and 0003 source hashes and
the existing V3 behavior. Focused Q2b tests must retain the current 79-case
green baseline before the final branch gate.
