# Task 8 clean final six-file gate

Reviewed runtime commit: `375aa6fa780f1870ca0f9c470f153e46cebd08df`.
Node: `v24.16.0`. Worktree: `C:/Users/Server/.codex/worktrees/subproject-3-projections`.
Only controller plan documentation was dirty. No runtime/test edits or concurrent builds during this gate.

Commands (serial; stop on any nonzero exit):

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-projection.test.js dist-test/tests/projection-schema.test.js dist-test/tests/projection-builder.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-integrity.test.js dist-test/tests/v2-reader-lease.test.js
npm run typecheck
```

Result: exit 0; 143 tests, 143 pass, 0 fail/cancelled/skipped/todo, 7 suites, 570551.4757 ms. Build and typecheck exited 0 with no diagnostics. The first broad 128/133 failure remains preserved in the implementation report; this is the clean final reviewed-code gate, not a relabeling of the earlier run.

Complete captured output:

```text

> awakened-ai-memory-mcp@0.1.0 test:build
> tsc -p tsconfig.test.json

▶ projection generation builder
  ✔ reads one committed source snapshot and builds an independent immutable generation (107.0324ms)
  ✔ keeps the production V1 build on its historical standalone latest-checkpoint fold (80.7106ms)
  ✔ keeps governed schema-3 material out of the production V1 build (30.6019ms)
  ✔ builds a production-decodable root/child/checkpoint and every governed V2 relation (96.3254ms)
  ✔ rejects an over-limit prefix before reading a full event row (1.2098ms)
  ✔ rejects aggregate full-row byte overflow before reading a full event row (0.596ms)
  ✔ streams authenticated events in ascending order exactly once (27.5028ms)
  ✔ rejects metadata tamper before a projection event is folded (29.311ms)
  ✔ rejects a final authentication cursor that differs from the captured terminal (25.7658ms)
  ✔ rejects a generation whose persisted rows no longer match its intended core checksums (53.9417ms)
  ✔ runs the FTS external-content integrity check before publishing a generation (62.4541ms)
  ✔ refuses a post-close WAL sidecar before the durable generation rename (58.5616ms)
  ✔ keeps a V2 build staged until the coordinator adopts its verified bytes (62.6764ms)
✔ projection generation builder (639.1378ms)
▶ projection build coordinator
  ✔ adopts a staged V2 generation before publishing its manifest authority (3494.3079ms)
  ✔ reconciles a positively identified V2 orphan after an install-before-manifest fault (5337.0294ms)
  ✔ reconciles an identified V2 orphan even when its active generation already meets the request (12388.168ms)
  ✔ persists a retired V2 generation high-water across reconciliation and coordinator restart (14504.4736ms)
  ✔ recovers a retirement intent after its rename before journal completion (7188.2994ms)
  ✔ recovers a retirement intent before its rename in a fresh process (7217.4345ms)
  ✔ rejects ctime-changed retired evidence after its journal record is complete (13610.6063ms)
  ✔ rejects missing retired evidence after recovery before the final scan (8433.8769ms)
  ✔ retains swapped retired evidence after recovery before the final scan (7319.2991ms)
  ✔ migrates a prior canonical retired V2 generation high-water journal during reconciliation (10164.0177ms)
  ✔ rejects a zero retired V2 generation high-water record without rewriting evidence (4765.8343ms)
  ✔ rejects unjournaled retired evidence before source access (4530.7701ms)
  ✔ rejects legacy quarantine evidence before source access (6808.9829ms)
  ✔ does not reuse a reserved V2 final generation after restart without an active manifest (11547.5308ms)
  ✔ durably reserves an orphan before quarantine disposition (3829.299ms)
  ✔ takes the V2 publication lock before initial source access (1126.5983ms)
  ✔ retains a V2 orphan when its terminal metadata no longer matches its persisted core checksums (2476.5357ms)
  ✔ retains a final V2 orphan after an A-to-B-to-A swap following image capture (2730.868ms)
  ✔ retains retired evidence when it differs from the validated V2 image (3509.7879ms)
  ✔ fails closed if the V2 projection directory swaps after authorization (207.2469ms)
  ✔ takes the V2 publication lock before a directory-swap journal snapshot (744.6536ms)
  ✔ retains an unreadable final-named V2 candidate rather than deleting on uncertain observation (1650.9102ms)
  ✔ poisons and retains the publication lock when fresh reconciliation cannot verify a final V2 candidate (4627.8894ms)
  ✔ reconciles before opening a source snapshot for a non-fresh V2 request (4286.0805ms)
  ✔ removes a verified V2 orphan before a non-fresh source failure (10195.5844ms)
  ✔ does not reconcile a final V2 generation named by the lease registry (6710.1554ms)
  ✔ acquires a published V2 evaluator lease from a stable private image (4609.8154ms)
  ✔ fails closed without an evaluator lease when the V2 directory swaps during acquisition (3439.2332ms)
  ✔ retains swapped V2 evaluator acquisition lock evidence when the lock sees another directory identity (3623.5144ms)
  ✔ rejects final V2 WAL and SHM sidecars before acquiring evaluator leases (6922.8381ms)
  ✔ retains V2 evaluator acquisition lock evidence when the published final checksum no longer matches (3618.0563ms)
  ✔ closes an unreturned V2 evaluator lease when publication release fails after acquisition (4365.7965ms)
  ✔ keeps a V2 evaluator lease usable after its original final file is renamed away (4143.4153ms)
  ✔ keeps a V2 evaluator lease on its original image after another valid final replaces its filename (7825.4555ms)
  ✔ keeps a V2 evaluator lease usable after its original final file is truncated (3976.8466ms)
  ✔ keeps a V2 evaluator lease on its original image after the final SQLite content changes (4130.4486ms)
  ✔ retains a V2 evaluator-leased generation until its lease closes, then retires it (11768.5158ms)
  ✔ publishes atomically, preserves crash-window authority, serializes builds, and pins leases (6883.8522ms)
  ✔ rejects a forged chain hash outside the requested projection binding (35.7371ms)
  ✔ reselects the manifest when publication retires a generation between load and acquire (3903.9027ms)
  ✔ refuses publication when a generation sidecar appears before manifest replacement (270.7601ms)
  ✔ maps a sidecar added to the published generation to integrity failure on manifest load (1872.4022ms)
  ✔ maps a non-ENOENT sidecar lstat failure on manifest load to integrity failure (2458.3632ms)
  ✔ fails closed while a manifest publication lock is present (2014.6811ms)
  ✔ retains the publication lock and prior hold when installed-manifest observation is ambiguous (4618.6467ms)
  ✔ preserves a lease-boundary sidecar lstat integrity failure (1786.2517ms)
  ✔ never reclaims a published generation main file while a sidecar entry exists (1750.1545ms)
  ✔ preserves main and sidecar when a sidecar appears after the reclamation precheck (1829.9557ms)
  ✔ returns projection lag at a zero deadline without starting source or build work (2.8614ms)
  ✔ returns projection lag at a zero deadline even when a sufficient generation exists (1643.6544ms)
  ✔ maps a synchronously blocking source rejection observed after expiry to projection lag (28.4221ms)
  ✔ bounds a slow source snapshot and closes its late result without invoking the builder (14.8266ms)
  ✔ closes an active source snapshot as soon as the build deadline expires (7.0545ms)
  ✔ does not publish a build that completes after its caller deadline (112.7594ms)
  ✔ returns V2 projection lag at a zero deadline when a sufficient generation exists (4308.6953ms)
  ✔ releases the V2 publication lock after an expired sufficient-generation request (6138.1361ms)
  ✔ returns V2 projection lag when a positive deadline elapses before its current-generation return (6780.7301ms)
  ✔ rejects a symlink-shaped projection directory before cleanup traversal (3.9767ms)
  ✔ does not follow a projection directory replaced after cleanup authorization (13.4965ms)
  ✔ never reclaims through a replaced parent and retries against the pinned directory (2042.2608ms)
  ✔ keeps publication successful while retaining retired files for audited reclamation (3923.2369ms)
  ✔ has no stable V2 orphan deletion operation (1.6769ms)
✔ projection build coordinator (270282.548ms)
▶ committed snapshot integrity
  ✔ verifies exact historical V1 and V2 schema images with authenticated legacy hash bindings (9471.596ms)
  ✔ authenticates original events and checks the pinned published image without source-path replay (4749.0677ms)
✔ committed snapshot integrity (14222.1517ms)
▶ full projection integrity replay
  ✔ opens a committed snapshot for production UUID project-store identities (1.7192ms)
  ✔ accepts a production UUID project identity in the projection checksum domain (1.5314ms)
  ✔ returns a frozen pass report only for an exact authoritative replay (3774.5841ms)
  ✔ rejects a re-signed WAL-only mutation that a pathname reader observes (5087.5322ms)
  ✔ maps a published generation sidecar to manifest-path integrity failure (4346.488ms)
  ✔ maps a non-ENOENT exact sidecar lstat failure through integrity verification (4236.3869ms)
  ✔ rejects a sidecar introduced at either pinned-image inspection boundary (9319.4039ms)
  ✔ replays a scale generation through the bounded linear core (4483.1473ms)
  ✔ does not sort the full expected projection while comparing a scale generation (3886.6391ms)
  ✔ fails closed when authoritative replay exceeds its configured event bound (5354.5603ms)
  ✔ fails closed when authoritative replay exceeds its configured byte bound (4469.1222ms)
  ✔ reuses stored-event authentication to reject authoritative metadata tamper (3548.537ms)
  ✔ rejects an oversized stored payload before a full event row reaches JavaScript (3925.8552ms)
  ✔ rejects a same-byte generation replacement race before opening SQLite (5338.8174ms)
  ✔ keeps descriptor-captured A bytes across an A-to-B-to-A generation pathname swap (3345.9911ms)
  ✔ does not create or clean any scratch inspection pathname (3437.7298ms)
  ✔ opens the pinned byte image only through in-memory deserialization (1.3533ms)
  ✔ detects a missing derived row after outer hashes are recomputed (3347.1805ms)
  ✔ detects an extra derived row after outer hashes are recomputed (4286.5569ms)
  ✔ detects provenance-tampered V2 rows after database and logical hashes are recomputed (4985.1177ms)
  ✔ detects canonical row reordering even though logical core rows are unchanged (10627.1647ms)
  ✔ detects cross-project rows after outer hashes are recomputed (7139.6468ms)
  ✔ detects noncanonical derived values after outer hashes are recomputed (5024.5433ms)
  ✔ detects a checksum-mismatched manifest without touching either database (4630.3373ms)
  ✔ maps manifest scope identity mismatch to the safe integrity contract (3520.4059ms)
  ✔ rejects a valid V1 manifest before any V2 source or projection byte path is opened (3380.2868ms)
  ✔ detects projection metadata and terminal identity tampering (6757.6985ms)
  ✔ accepts a valid unpublished V2 image through the shared semantic validator (3509.428ms)
  ✔ detects invalid derived references after outer hashes are recomputed (4097.5384ms)
  ✔ rejects a re-signed unpublished V2 image with a corrupt cross-table reference (4143.0643ms)
  ✔ detects FTS index tampering even when core rows and checksums are unchanged (3177.7767ms)
  ✔ rejects a re-signed unpublished V2 image with FTS semantic tampering (3176.8689ms)
  ✔ detects a dropped required retrieval index after the database hash is re-signed (3257.4467ms)
  ✔ detects persistent FTS rank configuration tampering after the database hash is re-signed (3069.4117ms)
  ✔ detects rank-sensitive FTS docsize tampering after the database hash is re-signed (3413.6578ms)
  ✔ rejects database bytes that no longer match the published manifest (3116.6101ms)
✔ full projection integrity replay (149223.6665ms)
▶ projection metadata production identity domain
  ✔ schema 1 accepts UUIDv4 and legacy hashes and rejects malformed identities (5.1149ms)
  ✔ schema 2 accepts UUIDv4 and legacy hashes and rejects malformed identities (2.9771ms)
✔ projection metadata production identity domain (9.6304ms)
▶ independent projection schema
  ✔ creates the typed core tables, bounded-query indexes, and one metadata row (20.8923ms)
  ✔ computes domain-separated canonical checksums without depending on object key order (2.9324ms)
✔ independent projection schema (24.2256ms)
▶ V2 projection reader leases
  ✔ opens a verified published V2 image as a guarded in-memory reader lease (3341.3958ms)
  ✔ rejects mismatched stable images and malformed captured bytes before retaining a filename (3509.7088ms)
  ✔ hashes and opens one copied captured image when its bytes getter changes (5700.4129ms)
  ✔ uses a generation manifest snapshot before retaining its filename (5604.9334ms)
  ✔ fails closed without retaining a filename when generation accessors throw (4476.6552ms)
  ✔ retains one filename until every private V2 image lease closes exactly once (3597.0015ms)
✔ V2 projection reader leases (26232.681ms)
✔ publishes both projection generations at the exact source position (10824.4326ms)
✔ adopts a prepared V1 baseline without rewriting its published bytes (3718.1713ms)
✔ recovers after generation installation before baseline manifest without rewriting the image (7984.8457ms)
✔ refuses orphan adoption after UPDATE corruption (3745.6446ms)
✔ refuses orphan adoption after CREATE corruption (5270.9656ms)
✔ refuses orphan adoption after UPDATE corruption (3985.6758ms)
✔ rejects an immutable revision with a different baseline (3681.7631ms)
✔ does not record projection-verified after V1 generation tamper (3642.4177ms)
✔ does not record projection-verified after V2 generation tamper (6650.9693ms)
✔ rejects committed wrapper tamper before projection verification (4557.5375ms)
✔ rejects unrelated revision build identity (3756.2792ms)
✔ rejects unrelated revision migration identity (4077.8646ms)
✔ rejects unrelated revision configuration identity (3731.3661ms)
✔ never transacts through an injected unrelated repository (7174.9777ms)
✔ never transacts through an injected protected repository (9711.023ms)
✔ redacts private-database cleanup failure and releases remaining resources (4070.3179ms)
✔ redacts pinned-image cleanup failure and releases remaining resources (4415.4555ms)
✔ redacts v1-lease cleanup failure and releases remaining resources (4330.7751ms)
✔ redacts committed-snapshot cleanup failure and releases remaining resources (8930.4157ms)
✔ rejects a protected source destination before consulting the target connection (3999.1073ms)
ℹ tests 143
ℹ suites 7
ℹ pass 143
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 570551.4757

> awakened-ai-memory-mcp@0.1.0 typecheck
> tsc --noEmit


```
