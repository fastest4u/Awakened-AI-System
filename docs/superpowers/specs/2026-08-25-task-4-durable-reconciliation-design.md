# Task 4 Durable Reconciliation Amendment

## Decision

The V2 coordinator owns one identity-pinned reconciliation transaction on **every**
entry to `ensurePublished`.  It runs under the cooperative manifest lock before
fresh-return, source access, build, or adoption.

## Durable generation registry

The active V2 manifest records a monotonic `highestObservedGeneration` watermark.
Reconciliation raises it for every positively identified final-named V2 generation,
including a generation it subsequently deletes as an unpublished orphan.  Publishing
the next generation uses `max(activeGeneration, highestObservedGeneration) + 1` and
updates the watermark atomically with manifest publication.  This survives process
restart and prevents final-name reuse.

## Identity-pinned candidate disposition

The stable-directory helper captures a candidate's identity and bytes once.  The
coordinator verifies that exact image against the complete V2 projection contract:
schema version, manifest binding and terminal metadata, every required relation,
and all core checksums.  It may delete only the same captured identity after this
verification succeeds.  A pathname reopen or recapture is never authority to delete.

An unreadable, swapped, malformed, checksum-invalid, or otherwise uncertain
candidate poisons the publication transaction: retain the candidate and recovery
evidence, keep the cooperative publication lock, and fail closed.  Active and leased
generations are retained even when fully verified.

## Tests and acceptance

Tests must prove: every fresh and non-fresh entry reconciles before source/build;
watermark survives restart after orphan deletion; forged metadata-only SQLite files
are retained with the lock; A-to-B-to-A pathname swaps cannot cause deletion of an
unvalidated A; valid inactive V2 orphans are removed; and V1 builder/coordinator
routing remains unchanged.
