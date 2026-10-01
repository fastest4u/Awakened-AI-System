# V2 fresh-start foundation operations

Status: **foundation complete, production implementation incomplete**. F1 Tasks1-6 and local increment verification are complete. This foundation can prepare an empty V2 store and report redacted diagnostics. It cannot serve production memory, activate a release, import V1, reset a store, or switch clients. Public content calls return `FRESH_START_RELEASE_NOT_READY`, including when environment variables claim activation. The shipped promotion verifier always denies promotion.

## Build and deployment identity

Use Node **24.16.0 or later** and the locked dependencies. From this checkout:

```powershell
npm ci
npm run build
```

The build emits `dist/v2.js`, `dist/v2-admin.js`, `dist/workers/project-store.worker.js`, and their independent `dist/v2-build.json`. Keep these four files together in the same layout. Their JavaScript dependencies are bundled. The build retains the existing V1 bundles and obfuscation and the separate private migration build's eligibility rules.

The fresh-start manifest measures the exact emitted files, the Node executable, Node version, platform, and architecture. A generation identifier embedded in all three entries binds the loaded code to the manifest. Each process independently checks the deployment; the worker does not trust an asserted parent hash. Missing or changed artifacts refuse with `FRESH_START_BUILD_MISMATCH`. Changing Node or rebuilding creates a different identity, so release manifests must refer to the exact deployment being prepared. Do not overwrite a running deployment. This is local deployment integrity, **not** signed source provenance or F3 production release evidence.

## Local preparation

All roots are explicit absolute paths. The V2 destination must be inside the project and separate from the V1 archive; `<project>/memory-v2` is the recommended choice. Existing V1 content is never read or enumerated. Canonical path metadata is inspected only to reject aliases, junctions, or overlapping roots. A populated destination is refused, never emptied.

Preparation requires a reviewed local JSON release manifest with exactly these fields:

```json
{
  "initializationId": "<new UUID v4; retain for resume>",
  "release": {
    "profileVersion": 1,
    "releaseId": "<new UUID v4>",
    "buildIdentityHash": "<buildIdentityHash from dist/v2-build.json>",
    "schemaIdentityHash": "<current migration registry fingerprint>",
    "configurationHash": "<SHA-256 of canonical launch configuration>",
    "capabilityManifestHash": "<SHA-256 of canonical F1 capability policy>",
    "recoveryPolicyHash": "<SHA-256 of canonical F1 recovery policy>",
    "evidenceDigest": "<SHA-256 of retained local preparation evidence>",
    "createdAt": "<UTC ISO timestamp including milliseconds>"
  }
}
```

Hashes are lowercase hexadecimal SHA-256. Canonical JSON sorts object keys and preserves array order, without extra whitespace. Launch configuration is `{projectRoot, v2VaultRoot, v1ArchiveRoot, releaseId}`, using resolved canonical paths. The F1 capability policy is `{"profile":"fresh-start","version":1,"tools":["memory_v2Status"],"content":"unavailable"}`. The F1 recovery policy is `{"profile":"fresh-start","version":1,"productionReady":false,"promotion":"closed"}`. The schema fingerprint comes from `expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS)`; developer tooling can access these exports under `dist-test/src/orchestrator/storage/` after `npm run test:build`. The CLI validates these hashes against the actual runtime before initialization. Preparation evidence is not approval to activate. Do not invent a successful production gate digest.

After the build, these local commands are available:

```powershell
node dist/v2-admin.js initialize-fresh --project-root "C:\project" --v2-vault-root "C:\project\memory-v2" --v1-archive-root "C:\project\memory" --release-manifest "C:\operator\prepared-release.json"
node dist/v2-admin.js resume-initialization --project-root "C:\project" --v2-vault-root "C:\project\memory-v2" --v1-archive-root "C:\project\memory" --release-manifest "C:\operator\prepared-release.json"
node dist/v2-admin.js status --project-root "C:\project" --v2-vault-root "C:\project\memory-v2" --v1-archive-root "C:\project\memory" --release-manifest "C:\operator\prepared-release.json"
```

Keep the release manifest outside V1 as an independent, single-link regular file; hardlinked manifests are refused before content is read. Initialization and resume print the validated V2 destination to local stderr before use; stdout contains only the redacted status JSON. The local OS account and machine identify the preparer through a one-way fingerprint. Resume requires the same initialization identity, release, paths and local actor. There is no `activate` command and no public operator-approval field.

Storage placement retains the existing router: non-Git stores use `<V2 vault>/.memory-mcp/v2`; Git-backed stores use `<gitCommonDir>/project-memory/<projectId>/v2`. The descriptor lives in `<V2 vault>/.memory-mcp/project-identity.json`.

## Prepared-only stdio service

Launch only after explicit preparation with the matching release:

```powershell
$env:MEMORY_PROJECT_ROOT = "C:\project"
$env:MEMORY_V2_VAULT_PATH = "C:\project\memory-v2"
$env:MEMORY_V1_ARCHIVE_PATH = "C:\project\memory"
$env:MEMORY_V2_RELEASE_ID = "<prepared release UUID>"
node dist/v2.js
```

`npm run start:v2` performs the runtime check before launch, for local use. MCP clients should launch `node dist/v2.js` directly: npm's own script banners are not protocol messages. The compiled entry reserves stdout for MCP JSON-RPC. `memory_v2Status` takes an empty object and reports profile/version, opaque IDs, mode, decimal-string generation, schema/build identity and `productionReady: false`. It never returns raw paths, keys, source content or V1 health. Missing bindings, `auto`/`dynamic`/default roots and relative roots fail before creating storage. Ordinary startup only reopens acknowledged state; it cannot initialize or repair it.

## Interrupted initialization and recovery limits

`resume-initialization` validates and continues owned initialization state. Missing previously published or acknowledged SQLite data returns `FRESH_START_RECOVERY_REQUIRED`; do not reinitialize or remove receipts to conceal loss. Identity and journal mismatches are separate errors and require investigation.

Abrupt process death can leave `.memory-mcp/fresh-start-operation.lock`. A subsequent initialize/resume refuses with `FRESH_START_INITIALIZATION_BUSY`. F1 neither steals stale locks nor promises automatic recovery after OS termination. Do not delete a lock while its owner may be alive. A separately verified operator recovery procedure belongs to F3. Retain the store, journal, receipt, original manifest and deployment for that investigation.

Public content adapters, privacy/governance, verified backup/restore/replay, production evidence, approved client cutover and live verification remain later increments. V1 continues through its existing service until a separately approved cutover; these commands do not freeze or modify it.

## Foundation verification

`npm test` compiles all source and tests once, then runs every compiled test serially with the spec reporter except the explicit 12-file legacy V1 data-migration set. Shared V2 fixture semantics, immutable-image coverage, integrity, recovery, storage upgrades and generic migration runner/registry tests remain in the default. New tests are included unless explicitly listed in the selector. The projection-only image regression uses synthetic owned SQLite bytes and the real project-driver identity refusal, without a V1/parity fixture.

`npm run test:migration` aliases the unchanged `test:v2-shadow-migration` producer and its mixed 19-file set; shared coverage intentionally overlaps the default. `npm run test:all` retains the original full-suite command and runtime precheck. CI uses `test:all` for its Run tests step and retains the separate synthetic migration gate. All profiles still compile all tests; this split establishes no measured speedup or current full-suite pass. Historical gate evidence below retains its original meaning.

After `npm run build`, run `npm run test:v2-fresh-start-foundation`. It compiles tests once, then runs the repository, initializer, control-plane, admission, compiled-entry and Foundation CI files in that order, one child at a time. `npm run test:build-artifacts` rebuilds and checks the compiled worker/schema upgrade, private compatibility/rehearsal, and prepared-only V2 entries. The V2 smoke uses isolated temporary roots and verifies status identity, restart, redaction, public content refusal, and absence of archive content access.

The focused runner exclusively creates `.fresh-start-foundation.lock` in this checkout while consuming shared `dist-test` outputs. A second focused invocation refuses. Other build/test commands must also be scheduled serially; they do not acquire this runner's lock. Child failure preserves its native exit code; deadline and cancellation return nonzero. Cleanup targets only that invocation's children and fixture roots. Abrupt process death or unconfirmed cleanup may leave the lock: retain it until the owner and descendants are proven stopped. Automatic stale-lock recovery is not implemented.

CI retains the lifecycle, immutable-base, V1 byte fence, rollout, minimum-runtime rejection, stress, and legacy synthetic migration lanes. The single named Build step precedes the full suite because compiled-entry tests consume actual artifacts. The historical migration upload contains only the fixture producer's classified synthetic JSON, with a 14-day retention period; it is neither live-V1 rehearsal nor production release approval.

See [Foundation evidence](superpowers/evidence/2026-09-29-v2-fresh-start-foundation.md) for the completed native-zero full suite, source/config identities, explicit skips and accepted reviews. F1 deployment measurement is local artifact integrity, not signed F3 provenance. Repository transaction callbacks are trusted synchronous internal code, not a hostile SQL/JavaScript sandbox; rollback-failure recovery remains unverified. The captured committed tail is a conservative recovery fence, not a verified public content snapshot. F2 supplies public content/privacy semantics, F3 supplies recovery and production release evidence, and F4 owns archive protection and approved client cutover.
