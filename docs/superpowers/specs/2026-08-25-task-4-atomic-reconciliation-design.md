# Task 4 Atomic Reconciliation Amendment

## Decision

Replace direct orphan deletion with a lock-scoped **reserve → quarantine →
validate → delete** protocol.  It is used on every V2 coordinator entry,
including an initially empty projection directory, before source access, build,
or fresh-manifest return.

## Durable reservation

`projection-reconciliation-v2.json` is an atomic, fsync-backed reconciliation
journal under the already identity-pinned projection directory.  It contains a
monotonic `highestReservedGeneration`.  Under the publication lock, reconciliation
first writes and verifies `max(current journal, all observed final candidates)`.
It does so before changing a candidate pathname.  The next generation is one more
than the maximum of active manifest generation, manifest high-water, and journal
high-water.  The journal is authoritative even when no active manifest exists;
a crash can leave an extra reservation but can never reuse a final generation.

## Capture-bound candidate disposition

The stable-directory helper reads a candidate once through an opened descriptor
into an immutable byte image and captures its identity/hash.  Complete V2
verification consumes those bytes—not a capture or candidate pathname.  It checks
schema, binding, terminal metadata, every required relation and core checksum,
and SQLite integrity.

After successful verification and durable reservation, the helper atomically
renames the final candidate to a unique same-directory quarantine name.  It then
reopens that quarantine entry and compares its identity/hash to the validated
image.  Only an exact match may be removed.  A mismatch, swap, unreadability, or
verification failure retains all files, retains the publication lock, and fails
closed.  The protocol never deletes a final pathname directly.

## Initial entry and release

The coordinator creates/pins the projection directory and acquires the cooperative
lock before it opens an event snapshot, regardless of whether an active manifest
exists.  It releases the lock only after all reconciliation and manifest work
succeeds; uncertainty deliberately leaves it as recovery evidence.

## Acceptance tests

Tests prove no generation reuse across restart with or without an active manifest;
reservation survives a crash before quarantine/delete; forged V2 files retain lock;
a capture-path or final-path A→B→A swap cannot delete validated A; initial entries
take lock before source access; and V1 builder/coordinator routing remains unchanged.
