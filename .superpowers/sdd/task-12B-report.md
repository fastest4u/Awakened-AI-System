# Task 12B Implementation Report

## Status

DONE

Base: `2568a0d78d302ed24ee2bf4a8881c49f184f48e5`

Required commit subject: `feat: add qualified checkpoint migration`

Production routing remains disabled. This task does not activate or add a production route.

## Implementation

- Added frozen schema migration 0003 and registered schema version 3 without changing migration 0002.
- Added the mandatory qualified-checkpoint preflight and immutable TEMP handoff. The hook runs after the complete uncommitted schema-2 prefix and before migration-3 SQL for both schema-1 and schema-2 sources.
- Made the migration runner require a callable pre-migration hook, preserve atomic rollback across the hook/DDL/history/project-version transaction, and recognize only the exact migration-3 precondition failure tuple.
- Backfilled sealed workflow evidence-window state from strictly decoded Version 1 lifecycle history. Final checkpoint and child/ticket bindings are recomputed from canonical event payloads and cross-bound to workflow, session, generation, phase, event position, checkpoint, and transfer-ticket identity.
- Added immutable qualified checkpoint coverage aggregates and transition history, project-scoped adapter uniqueness, monotonic interval/ordinal rules, exact aggregate-to-latest-transition projection coherence, and the 200-interval prospective-row bound.
- Added strict workflow lifecycle shapes, narrow phase transitions, frozen final groups, canonical sorted ending-scope bindings, and UTF-8 byte limits.
- Kept generic positive-version events compatible while rejecting unsupported or malformed known lifecycle history. Version 1 checkpoint/request/amend rows are rechecked in target SQL so a forged preflight cannot smuggle coverage state.
- Updated bootstrap, explicit upgrade, schema compatibility, and schema fingerprinting to use the concrete migration-3 preflight while retaining an explicit test override seam.
- Added a shared current-schema test helper and pinned legacy lifecycle fixtures to the schema-2 migration prefix where their contract intentionally tests migration 0002.

## RED/GREEN Evidence

1. Initial RED: the three exact anchor tests were written first. Compilation failed because the migration and preflight modules did not exist. After adding throwing typed scaffolds, the prescribed anchor run had 5 tests total: 2 passed and exactly 3 failed with `NOT_IMPLEMENTED` for mandatory preflight invocation, staged consumption, and source-version rollback.
2. Adversarial RED: expanded migration coverage ran 17 tests and produced exactly 7 intended failures covering generic Version 2 handling, missing nested lifecycle tags, aggregate/transition drift, permissive workflow result parsing, forged frozen workflow groups, forged-hook checkpoint coverage smuggling, and missing TEMP trigger normalization.
3. GREEN: hardened preflight decoding, SQL invariants, immutable handoff, exact error normalization, workflow/result cross-binding, and coverage projection checks made every focused regression pass.
4. Final audit added an explicit strict-looking null-final workflow result with the wrong workflow identity; the focused migration suite remained green at 23/23 after the common result identity/window checks were moved before the null-final return.

## Final Verification

- Exact seven-file Task 12B gate from the brief — PASS: 203 tests, 203 passed, 0 failed, 0 skipped.
- Focused qualified-checkpoint migration suite after the final audit — PASS: 23/23 tests, 0 failures.
- `npm run typecheck` — PASS, exit 0.
- Full repository suite — PASS: 1,296 tests total; 1,286 passed; 10 skipped; 0 failed.
- Directly affected legacy-fixture regression run — PASS: 73/73 tests, 0 failures.
- `git diff --check` — PASS, exit 0 (line-ending conversion warnings only).
- Frozen migration 0002 SHA-256 — PASS: `68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06`.

## Self-Review

- Migration 0002 remains byte-identical and old readers remain fenced from schema 3.
- The stage marker binds the exact project/vault/store/source/target identity, is sealed last, requires exactly one source identity row, and is protected with all six TEMP immutability triggers.
- Preflight uses decimal int64 positions rather than JavaScript safe-number coercion for event-position equality.
- Final workflow status is strict and exact-key decoded even when no final checkpoint exists; triggering position and workflow/session/generation/phase identity are always checked.
- Transferred child summaries cannot be downgraded to checkpoint-only evidence: each requires its exact retained transfer ticket and `ChildWorkTransferCreated` event/body linkage.
- Successful migration consumes and drops the handoff, while any missing/extra/mutated handoff state rolls the complete migration transaction back to the exact source prefix.
- Production routing is still disabled; this commit contains schema/preflight/store integration and tests only.

## Concerns

None blocking.
