# Task 5 V2 Internal Verified Lease Amendment

**Status:** Draft for written user review — architecture direction approved 2026-08-25

**Amends:** [Subproject 3 Final-Review Remediation Design](2026-08-24-subproject-3-final-review-remediation-design.md), Section 6

## Purpose

Task 5 must pin the bytes of a verified schema-V2 generation for the internal
evaluation path without changing the production Version 1 reader API or making
Version 2 reachable through the internal production runtime.  The existing
`ProjectionReaderLease` and `ProjectionBuildCoordinator` remain Version 1
interfaces.  Their pathname and routing behavior are not a migration target in
this task.

## Explicit boundary

The implementation introduces separate, V2-named internal types only:

```ts
export interface VerifiedV2ProjectionImage {
  readonly database: DatabaseSync;
  readonly sha256: string;
  close(): void;
}

export interface V2ProjectionReaderLease {
  readonly manifest: ProjectionManifestV2;
  readonly database: DatabaseSync;
  close(): void;
}
```

`ProjectionReaderLease`, `ProjectionBuildCoordinator`,
`InternalProjectionRuntime`, and the Version 1 `SqliteRetrievalCandidateRepository`
remain unchanged.  The V2 lease is consumed only by a V2-named internal
candidate/evaluation adapter; it is never returned from a public runtime route,
tool, or production lease provider.

## Verified byte image

While the V2 coordinator holds the existing manifest-publication lock and its
pinned directory identity, it loads the active V2 manifest and calls the stable
directory operation `readGenerationImage(directory, identity, lockToken,
manifest.databaseFile)`.  The returned image contains descriptor-captured bytes
and a five-field identity; no later operation may reopen the generation pathname.

`openVerifiedV2ProjectionImage(image, manifest)` must:

1. require `image.identity.sha256 === manifest.databaseSha256` and compute the
   SHA-256 of `image.bytes` to the same value before SQLite is opened;
2. create an in-memory `DatabaseSync`, deserialize a private normalized copy of
   exactly those captured bytes, enable defensive mode, disable trusted schema,
   enable foreign keys, set the configured busy timeout, and set and verify
   `PRAGMA query_only = ON`;
3. close the database on every partial-creation failure and surface a
   fail-closed V2 lease/integrity error; and
4. expose only the private database and the verified hash.  It exposes no
   source pathname and performs no filesystem access after capture.

Node.js `DatabaseSync.deserialize` produces a writable in-memory database, so
the defensive and query-only checks are mandatory rather than implied by the
constructor.

## V2 logical lease and reconciliation interaction

`V2ProjectionReaderLeaseRegistry` is separate from the Version 1 registry.  It
records active V2 final filenames and creates the verified private image before
incrementing its logical reference.  If image creation fails, it leaves no
reference behind.  `close()` is idempotent: it closes the private image once,
then releases the logical reference once, even if callers close repeatedly.

`V2ProjectionBuildCoordinator.leasePublishedForEvaluation(binding)` is an
internal-only method.  It acquires the cooperative publication lock, captures
the active V2 image, creates the registry-backed lease before releasing that
lock, and merges registry filenames with the existing test-only
`leasedFilenames` input for reconciliation exclusions.  Thus Task 4 retains a
leased V2 final file, while a pathname replacement, rename, truncation, or
mutation after acquisition cannot affect the lease's query bytes.

The method is deliberately absent from `ProjectionBuildCoordinator` and is not
wired into `InternalProjectionRuntime`.  It is callable only by the later
sealed evaluation harness and direct internal tests.

## V2 candidate boundary

The V2-only candidate adapter accepts `V2ProjectionReaderLease` and executes
prepared statements only through `lease.database`.  It neither imports nor
constructs `DatabaseSync`, accepts a database path, revalidates pathname
sidecars, or closes the lease.  Where V1 and V2 query projection relations are
identical, extraction logic may be factored into a private database-taking
helper; the V1 repository's public type and observable behavior must remain
unchanged.

Task 7 will use this V2 adapter directly in the sealed evaluation harness.  It
does not make the adapter a runtime dependency or expose a production route.

## Required tests

Tests must prove all of the following against a published V2 generation:

1. checksum mismatch, malformed bytes, sidecar/path uncertainty, or a changed
   directory identity fails before a lease is issued;
2. replacing, renaming, truncating, and mutating the original generation after
   lease acquisition leaves V2 candidate results sourced from the original
   verified image, never from the pathname;
3. a V2 candidate query has no second `DatabaseSync`/pathname open and does not
   close the lease-owned database;
4. double-close closes the private image and releases its logical filename once;
5. an active V2 evaluation lease prevents Task 4 reconciliation from retiring
   that final filename; and
6. Version 1 `ProjectionReaderLease`, `ProjectionBuildCoordinator`, runtime
   wiring, and their protected tests retain their existing types and behavior.

## Non-goals and release rule

This amendment does not enable Version 2 production routing, deploy anything,
or change Version 1 behavior.  It only creates the internal V2 byte-pinning
surface required for the later sealed evaluator.  Production V2 routing,
shadow parity, backup/restore/replay, rollback fencing, and explicit cutover
remain Subprojects 4 and 5 with their own design and approval gates.
