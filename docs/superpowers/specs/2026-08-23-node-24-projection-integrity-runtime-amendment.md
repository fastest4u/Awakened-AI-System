# Architecture Decision Amendment: Node 24.16 for Pinned Projection Inspection

Status: Approved
Date: 2026-08-23

This amendment supersedes the Node.js runtime-floor clauses in the existing
orchestrator decisions and designs. It does not change their SQLite, isolation,
or Version 1 routing decisions.

## Context

The former production floor, Node.js 22.22.3, provides unflagged `node:sqlite`
and a WAL-safe SQLite release. It does not provide a portable API that opens a
SQLite database from the exact bytes already captured through a pinned source
descriptor.

The previous projection-integrity inspection wrote verified bytes to a private
scratch pathname and opened that pathname with SQLite. A same-user actor could
replace that name A→B→A between identity checks and SQLite open, substituting B
for inspection while leaving the verified source bytes and final pathname at A.
Path permissions and pre/post identity checks cannot close that pathname race.

Node.js 24.16.0 exposes `DatabaseSync.deserialize()`, which replaces an
in-memory database with a supplied `Uint8Array` image. This permits inspection
without reopening the published generation or a scratch copy by pathname.

## Decision

- Production requires Node.js 24.16.0 or newer within the supported Node.js 24
  LTS line and runtime SQLite 3.51.3 or newer.
- The floor is enforced by package metadata, build targets, startup capability
  probes, authoritative-store bootstrap, CI, and tests. Node.js 22.22.3 must be
  rejected before SQLite is loaded or an authoritative store is opened.
- Runtime probes retain WAL, FTS5, foreign-key, synchronous, busy-timeout,
  trusted-schema, and rollback checks, and add functional
  `DatabaseSync.deserialize()`, defensive-mode, and query-only checks.
- Full projection integrity opens the published generation read-only through a
  pinned source descriptor, reads a bounded exact byte image from that
  descriptor, confirms source identity before and after the read, and verifies
  `manifest.databaseSha256` over those raw on-disk bytes. The original descriptor
  remains pinned through verification; unchanged-byte checks rehash through that
  descriptor rather than reopening the generation pathname.
- After the raw hash is verified, inspection deserializes a private clone into
  an isolated `:memory:` database. Because a standalone in-memory image has no
  sibling WAL file, the clone may normalize only SQLite's two WAL journal-mode
  header bytes. The source bytes and manifest hash domain are never modified.
- The deserialized inspection database uses defensive mode and is switched to
  `PRAGMA query_only=ON` before generation-derived state is read. Expected FTS5
  state is built independently in a separate defensive in-memory reference
  database.
- After byte capture, integrity code does not reopen the generation by pathname,
  create a scratch database pathname, or execute a scratch cleanup path.
- Authoritative generation and event databases remain read-only during full
  integrity. Version 1 production routing and ownership remain unchanged.

## Type contract

Production and development types target Node.js 24. The current `@types/node`
24 declarations include the defensive constructor option and
`enableDefensive()` but do not yet declare `DatabaseSync.deserialize()`. A
narrow `node:sqlite` module augmentation declares only that documented method;
the implementation does not use a broad cast to bypass the native API type.

## Consequences

- Deployments must upgrade from Node.js 22 to Node.js 24.16.0 or newer.
- CI runs the positive runtime and integrity gates on the exact minimum and a
  negative Node.js 22.22.3 gate.
- The manifest hash remains stable and continues to describe the published raw
  SQLite file rather than an inspection-specific image.
- The descriptor-captured A→B→A substitution path is closed because SQLite sees
  only the captured byte image and no attacker-addressable scratch pathname.
- Capability probes remain authoritative: a nominally sufficient Node version
  still fails closed if its SQLite build lacks any required behavior.

## References

- [Node.js 24 SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- [Node.js 24.16.0 release](https://nodejs.org/en/blog/release/v24.16.0)
- [SQLite WAL documentation](https://www.sqlite.org/wal.html)
