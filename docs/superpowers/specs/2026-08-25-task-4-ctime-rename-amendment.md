# Task 4 ctime rename identity amendment

**Status:** approved by the user on 2026-08-25 (`อนุมัติแก้สเปก ctime rename`)

## Context

Task 4 retains a verified unmanifested V2 generation by atomically renaming it
from a final filename to an opaque retired filename.  The original retained
reconciliation design required the exact five-field identity
`{ device, inode, size, ctimeNs, sha256 }` captured before the rename to be
identical after the rename.

That condition is not portable.  Two independent probes on this Windows/NTFS
host showed that a same-directory `renameSync` preserves the device, inode,
size, and SHA-256, but advances `ctimeNs`.  Keeping exact equality across that
intentional rename therefore makes every valid retirement fail closed with
`PROJECTION_PATH_INVALID`.

## Decision

Task 4 uses two deliberately separate identity comparisons:

1. **Exact image identity** compares all five fields.  It authorizes the final
   candidate immediately before the rename and verifies any subsequently
   recorded retired image.
2. **Rename continuity identity** compares only `device`, `inode`, `size`, and
   `sha256`.  It is permitted only across the one coordinator-owned,
   same-directory final-to-retired rename.  It proves that the renamed entry is
   the just-authorized file while allowing the filesystem's expected metadata
   timestamp update.

The final pre-rename check remains exact.  The stable helper then performs its
atomic rename, fsyncs the pinned directory, captures the retired entry, and
requires rename continuity with the pre-rename identity.  It returns that
observed post-rename identity, including its new `ctimeNs`.

The coordinator records the observed post-rename five-field identity in the
`retired` journal record.  It must not copy the pre-rename `ctimeNs` into that
record.  Later checks of a completed retired record use exact five-field
identity again.

## Durable state and recovery consequences

- An `intent` always stores the exact pre-rename image and continues to require
  an exact final-path match before it may perform its rename.
- `completeRetirement` may replace an intent with a retired record only after
  rename continuity between the intent image and the returned observation.
  The retired record stores the observation verbatim.
- Task 4.3 recovery of an intent whose final name is absent but retired name is
  present uses rename continuity once, then durably writes the observed exact
  retired identity.  It fails closed and poisons the publication lock on any
  continuity failure, sidecar, symlink, directory swap, malformed record, or
  unknown retained name.
- Recovery of an existing `retired` record requires exact five-field identity;
  it must not apply the continuity exception a second time.

The exception is thus neither a general weakening of path validation nor a
replacement for content hashing.  It exists solely to accommodate the
metadata transition caused by the verified rename itself.

## Safety invariants unchanged

- Task 4 never invokes `unlink` for a V2 final or retired candidate.
- Full immutable-byte V2 validation occurs before intent persistence and
  rename.
- The publication lock, pinned directory identity, manifest exclusion, lease
  exclusion, sidecar rejection, and high-water reservation remain mandatory.
- A random 128-bit opaque retired name remains non-routable and retained as
  evidence.  Garbage collection remains a separately approved future design.

## Required verification additions

Task 4.2 must prove a valid retirement survives a filesystem `ctimeNs` change
across rename while device, inode, size, and SHA-256 remain continuous.  It
must also prove that a pre-rename identity mismatch, a post-rename continuity
mismatch, and any later exact-retired-identity mismatch fail closed and retain
evidence.  Existing no-unlink, durable-journal, restart/high-water, and
hostile-swap tests remain required.

## Alternatives rejected

- Requiring five-field equality across rename was rejected because it cannot
  retire a valid file on Windows/NTFS.
- Dropping `ctimeNs` from all identity validation was rejected because it would
  weaken final-path authorization and later retained-evidence verification.
