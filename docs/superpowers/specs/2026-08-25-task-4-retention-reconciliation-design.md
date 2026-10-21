# Task 4 Retention-Based V2 Reconciliation Amendment

## Status and scope

This is the approved replacement for the orphan-disposition portions of:

- `2026-08-25-task-4-durable-reconciliation-design.md`
- `2026-08-25-task-4-atomic-reconciliation-design.md`

It keeps their durable generation reservation, lock-before-source, and
identity-pinned directory requirements.  It replaces **quarantine then delete**
with **intent then retire**.  It applies only to unmanifested V2 final
generation files.  V1 routing, active manifest files, and leased generations
remain outside this change.

## Decision

Task 4 must never automatically delete an orphan through a mutable pathname.
After full verification, it atomically renames the candidate to a unique,
same-directory, non-routable retained name and keeps that file as recovery
evidence.  The portable Node implementation has no identity-bound unlink
primitive, so automatic reclamation is prohibited.  A future garbage collector
is a separate design and authority boundary; it must not be added to Task 4.

This deliberately trades bounded retained disk usage for the stronger safety
property: reconciliation cannot delete a file that was not the exact image it
validated.  Operators monitor retained evidence and use an explicitly approved
recovery/GC workflow if storage needs reclaiming.

## Durable journal state machine

`projection-reconciliation-v2.json` remains an atomic-write-plus-file-and-
directory-fsync journal beneath the identity-pinned projection directory.  It
has a monotonic `highestReservedGeneration` plus exact records for every
retirement transition:

```ts
type RetirementRecord =
  | {
      state: "intent";
      generation: number;
      finalFilename: `projections-2-${number}.sqlite`;
      retiredFilename: `.projections-2-retired-${string}.sqlite`;
      image: { device: string; inode: string; size: string; ctimeNs: string; sha256: string };
    }
  | {
      state: "retired";
      generation: number;
      retiredFilename: `.projections-2-retired-${string}.sqlite`;
      image: { device: string; inode: string; size: string; ctimeNs: string; sha256: string };
    };
```

The decoder is exact and bounds every collection, filename, number, and string.
It accepts the previous journal shape containing only
`highestReservedGeneration` as an empty retirement set, then rewrites the
canonical expanded shape under the lock.  A journal record is never removed by
Task 4.

`highestReservedGeneration` is authoritative even without an active manifest.
The next final generation is greater than the maximum of active manifest
generation, manifest high-water, journal high-water, and every observed final
candidate.  A crash may reserve an unused number; it may never reuse one.

## Reconciliation protocol

On **every V2 coordinator entry**, create and pin the directory, acquire the
publication lock, and reconcile before opening a source snapshot, accepting a
fresh manifest, building, or publishing.

For each V2 final filename that is neither the active manifest database nor a
leased reader generation:

1. Enumerate final generation names and atomically reserve their maximum in the
   journal before changing any candidate pathname.
2. Capture the candidate once through an opened descriptor into immutable bytes
   and an identity `{ device, inode, size, ctimeNs, sha256 }`.  The stable helper
   rejects symlinks, sidecars, directory swaps, over-size input, and changed
   path/descriptor identity.
3. Validate those captured bytes with the shared full V2 image validator.
4. Persist a journal `intent` containing the generation, random 128-bit retired
   filename, and exact captured identity.  Fsync it before any rename.
5. The stable helper rechecks that exact final identity, atomically renames it
   within the same pinned directory to the `retiredFilename`, captures the
   renamed entry, and returns its identity.  It does **not** unlink anything.
6. The coordinator compares the returned identity to the journal intent.  Only
   an exact match may transition the journal record to `retired`, again using an
   atomic fsync-backed write.

The retired filename is not a final generation filename and is not manifest- or
reader-routable.  It must be ignored for publication selection but retained on
disk.  A normally completed, journal-recorded retirement is safe to release the
publication lock after the rest of the coordinator entry succeeds.

## Crash and hostile-path recovery

- Before durable intent: the final file is unchanged; a later entry observes and
  reserves it again.
- After intent before rename: the exact final image is revalidated and the same
  intent is resumed.  A mismatch is recovery-required.
- After rename before `retired`: recovery captures the named retired file and
  completes the transition only when it exactly matches the intent identity.
- A final-path swap before rename, a retired-path swap after rename, an unknown
  retired file, a legacy quarantine file, unreadability, malformed journal, or
  any validation failure is `PROJECTION_PUBLICATION_RECOVERY_REQUIRED`.  No
  candidate is deleted, the evidence remains, and the publication lock remains
  poisoned for explicit recovery.

No code path that disposes a final or retired V2 candidate may call `unlink`,
directly or through a helper.  Removing `removeQuarantinedGeneration` and its
stable mutation operation is a required implementation consequence, not an
optional cleanup.  Existing cleanup of uniquely named, non-generation temporary
publication files is unchanged and is not orphan disposition.

## Full V2 image validation

The coordinator must not retain a second, weaker V2 validator.  `integrity.ts`
exports one image-only validator used by orphan reconciliation.  It operates on
the immutable captured bytes, opens them immutably, and applies the same
self-consistency checks available without a manifest or event snapshot:

- V2 canonical schema and SQLite integrity/foreign-key checks;
- exactly one metadata row; filename generation; full project binding; terminal
  position/hash and metadata domain checks;
- every canonical recovery row and every persisted core checksum recomputed with
  the production checksum function;
- `assertReferences` across canonical items, feedback, lexical chunks, session
  follow-ups, artifacts, entity aliases, and entity edges; and
- `assertFtsSemantics` against the captured canonical lexical rows.

It maps every invalid image and decoder/open failure to
`PROJECTION_PUBLICATION_RECOVERY_REQUIRED`.  It has no live candidate pathname
parameter and does not inspect a mutable file after the descriptor capture.

## Deadline behavior

Production `PROJECTION_LAG` deadlines remain fail-closed and unchanged.  The
high-water durability test measures restart safety rather than a two-second
latency SLO; its four coordinator calls use a 10-second test budget, matching
the existing durable-fault tests.  Dedicated zero/slow deadline tests remain at
their current strict budgets.  Any future two-second production SLO is a
separate profiling and performance task, not a reason to weaken this protocol.

## Acceptance matrix

Implementation is accepted only when tests prove all of the following:

1. Every V2 entry locks before source access and reconciles before fresh return,
   including no-active-manifest restart and source failure paths.
2. Generation high-water survives each crash boundary and no final generation is
   reused, with or without an active manifest.
3. A valid orphan becomes a durable `retired` record and a retained,
   non-routable file; reconciliation never unlinks it.
4. Crash recovery completes a matching intent or fails closed on a mismatch;
   final and retired A-to-B swaps preserve all evidence and the lock.
5. Forged cross-table references and forged FTS state whose core checksums are
   recomputed by production helpers are rejected and retain the final candidate
   and lock.
6. Malformed, unknown, unreadable, legacy-quarantine, or sidecar-bearing files
   never become published or retired-successfully.
7. V1 coordinator/builder routing remains unchanged.
8. `npm run test:subproject-3` and `npm run typecheck` pass, followed by an
   independent Task 4 review that explicitly checks for any reconciliation-path
   unlink and for use of the shared full-image validator.

Task 5 and Task 6 remain blocked until this implementation has passed that
review.
