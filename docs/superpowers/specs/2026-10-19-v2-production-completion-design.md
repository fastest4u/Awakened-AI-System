# V2 Production Completion Design (F2-K, F2-G, F2-P, F3, and F4 Preparation)

**Status:** Approved under user-authorized continuous delivery protocol (`04_Architecture_Decisions/authorize-continuous-v2-delivery-through-f4-with-agent-approved-specs-and-draft.md`), subject to independent subagent spec review before implementation planning.
**Source baseline:** `1ccba2ff7a52aa8a3159b7578fbaf9a7bcdcacad` on `codex/v2-production-completion`.
**Authority:**
- [V2 Fresh-Start Production Design](2026-09-29-v2-fresh-start-production-design.md)
- [Full Event-Sourced Memory Orchestrator Design](2026-07-11-full-event-sourced-memory-orchestrator-design.md)
- [V2 Retained Evidence Privacy Design](2026-10-02-v2-retained-evidence-privacy-design.md)
- [V2 Governed Summary Commands Design](2026-10-08-v2-governed-summary-commands-design.md)
- [V2 Full-Body Notes Design](2026-10-09-v2-full-body-notes-design.md)
- [V2 Fresh-Start Delivery Roadmap](../plans/2026-09-29-v2-fresh-start-delivery-roadmap.md)

---

## 1. Outcome and Scope

Deliver the remaining V2 backend, public MCP service, recovery, release-qualification, and operator-administration increments required to bring Project Memory V2 from its current private full-body notes baseline (`1ccba2f`) to a verified, production-ready Fresh-Start release:

1. **F2-K (`src/orchestrator/keys/operational-key-custody.ts`, `src/orchestrator/privacy/large-frame-chunking.ts`)**:
   - Operational purpose-separated key custody implementing `CapabilityKeyProvider` (all 11 purposes), `EvidenceKeyProvider` (all 3 purposes), and `HistoricalEvidenceIntegrityProviderPort`, backed by external secret environment / disjoint key file or OS DPAPI custody.
   - Envelope key rotation (`rotateEvidenceWrapKey`) that rewraps per-evidence data keys under a new key version without decrypting `retained_evidence_blobs` ciphertext or rewriting historical `events` hashes.
   - Cryptographic privacy erasure & restoration fences (`erasure_fences`) that destroy wrapped per-evidence key envelopes, record an immutable tombstone digest, and prevent decryption or post-restore resurrection.
   - Deterministic compression and multi-chunk sealing/reassembly (`ChunkedEvidenceFrameCodec`) for redacted evidence frames exceeding 64 KiB (up to 1 MiB).
2. **F2-G (`src/orchestrator/governance/contracts.ts`, `src/orchestrator/governance/governance.service.ts`, `src/orchestrator/projections/contracts.ts`, `src/orchestrator/projections/source-event-codec.ts`, `src/orchestrator/projections/folds.ts`, `src/orchestrator/projections/captured-image-v3.ts`)**:
   - Governed lifecycle mutations over canonical records and notes: promotion/verification (`candidate -> provisional -> verified` with verification-method policy enforcement), correction/supersession (`GovernedRecordSuperseded`), conflict set declaration and resolution (`canonical_conflicts`), retraction (`GovernedRecordRetracted`), expiry (`GovernedRecordExpired`), and privacy erasure (`EvidenceErased`).
   - Dedicated `GovernedLifecycleProjectionEventV1` projection folding in `source-event-codec.ts` and `ProjectionFoldAccumulatorCore`/`ProjectionFoldAccumulatorV3` (`folds.ts` and `captured-image-v3.ts`) so lifecycle transitions update existing `canonical_items`, `canonical_conflicts`, `lexical_chunks`, and `governed_notes` rows in-place without triggering initial `create-governed-note` pair-validation or duplicate-key errors, and `erased-evidence` transitions scrub `governed_notes` full-body rows and `lexical_chunks` rows while preserving audit tombstones.
3. **F2-P (`src/v2/capabilities.ts`, `src/v2/config.ts`, `src/v2/public-tools.ts`, `src/v2/composition.ts`, `src/v2/app.ts`)**:
   - Dual release-profile support: preserves the foundation prepared profile (`V2_CAPABILITIES` / `V2_RECOVERY_POLICY`) for existing foundation/smoke gates while adding `V2_PRODUCTION_CAPABILITIES` (complete 32-tool V1 parity manifest + V2-native tools) and `V2_PRODUCTION_RECOVERY_POLICY` (`productionReady: true, promotion: "operator-approved"`).
   - Full public MCP tool router on `dist/v2.js` when a production-profile store is in `active` mode (or `read-only-recovery` for read-only tools), wiring child-process verified reads, session lifecycle, retained evidence, full-body governed note writes, verification tools, and governed lifecycle tools.
4. **F3 (`src/orchestrator/recovery/backup.service.ts`, `src/orchestrator/recovery/restore.service.ts`, `scripts/run-v2-fresh-start-release.js`)**:
   - `V2BackupService`, `V2BackupScheduler`, and `V2BackupHealth` using `MaintenanceFence` exclusive leases and SQLite `VACUUM INTO` to produce verified, self-contained backup bundles and enforce pre-upgrade, hourly-active, and orderly-shutdown backup health policies.
   - `V2RestoreService` and `V2RollbackService` restoring verified backups into isolated target directories, authenticating and replaying post-backup events through the recovery fence, enforcing governed erasure fences before projections publish or reads open, and reporting measured recovery time and any missing event range.
   - `scripts/run-v2-fresh-start-release.js` (`npm run verify:v2-fresh-start-release`) executing all 8 compiled public-service qualification scenarios against `dist/v2.js` and `dist/v2-admin.js` and emitting a signed/hashed release qualification receipt.
5. **F4 Preparation (`src/v2/admin.ts`, `docs/operations/v2-fresh-start-runbook.md`, `docs/evidence/v2-fresh-start-release.md`)**:
   - Real `TrustedOperatorApprovalVerifier` and `TrustedFreshStartEvidenceVerifier` wired into `src/v2/admin.ts` (`sign-approval`, `activate`, `enter-recovery`, `exit-recovery`, `disable`, `backup`, `restore`, `verify-recovery`, `rebuild-projections`, `freeze-v1-archive`, `verify-v1-archive`, `generate-client-configs`).
   - Live workspace V1 writer stop / archive freeze and final PROD activation remain gated on explicit user approval after F3/F4.1 verification.

---

## 2. Hard Invariants and Regression Compatibility

1. **Zero V1 Source Mutation**:
   - `.github/workflows/v2-release-qualification.yml` enforces `git diff --exit-code 0e375d4643d4b630f36f874a3bb192e96739ac46 -- src/app.ts src/index.ts src/controllers src/schemas src/services`.
   - No file in `src/app.ts`, `src/index.ts`, `src/controllers/*`, `src/schemas/*`, or `src/services/*` may be modified.
2. **Five Emitted Fresh-Start Artifacts**:
   - `scripts/fresh-start-build.js` emits exactly 5 bundles in `dist/`: `v2.js`, `v2-admin.js`, `workers/project-store.worker.js`, `internal/v2-internal-verified-read.js`, and `internal/v2-internal-verified-read-cleanup.js`.
   - All new runtime and admin modules must live under `src/orchestrator/` or `src/v2/` and bundle cleanly into those existing entry points with zero non-builtin external runtime imports.
3. **Preservation of `events.sqlite` Schema Version 9 (`f10eb1976f2fd97d899163d930a91e21f66daaccf448a76334d5c9b13ffd6df1`)**:
   - `PROJECT_STORE_MIGRATIONS` (`1..9`) and `CURRENT_PROJECT_STORE_SCHEMA_VERSION = 9` remain unchanged.
   - `retained_evidence_blobs` in `events.sqlite` retains its immutability triggers (`retained_evidence_blobs_no_update`, `retained_evidence_blobs_no_delete`).
   - Operational key-custody envelopes, key-rotation logs, erasure/restoration fences, and backup health receipts are persisted in a dedicated SQLite sidecar database `custody-recovery.sqlite` inside `route.storeRoot`, protected by the store's `MaintenanceFence`.
4. **Preservation of Foundation Prepared Profile Behavior**:
   - When a store is initialized with a release manifest whose `(capabilityManifestHash, recoveryPolicyHash)` matches `(configurationDigest(V2_CAPABILITIES), configurationDigest(V2_RECOVERY_POLICY))`:
     - `foundation.status().productionReady` is `false`.
     - `tools/list` returns `[{ name: "memory_v2Status", ... }]`.
     - `tools/call` on any other tool name returns `FRESH_START_RELEASE_NOT_READY`.
     - `v2-admin.js activate` without production release evidence and operator approval returns `FRESH_START_RELEASE_NOT_READY`.
   - When `dist/workers/project-store.worker.js` is opened without `freshStart` context (as in `scripts/smoke-worker.js`), `lifecycle` requests continue to return `LIFECYCLE_V2_DISABLED`.

---

## 3. Subsystem Designs

### 3.1 F2-K: Operational Key Custody, Rotation, Erasure Fences & Large-Frame Chunking

#### Operational Key Custody (`src/orchestrator/keys/operational-key-custody.ts`)
- **Key Material Source**:
  - `loadOperationalKeyringMaterial(env, paths)` resolves a 32-byte master seed from:
    1. `env.MEMORY_V2_KEYRING_B64` (base64url-encoded 32-byte secret), or
    2. `env.MEMORY_V2_KEYRING_PATH` (absolute path to an external secret file whose `realpathSync.native` is verified via `assertFreshStartDisjoint` to be outside `projectRoot`, `v2VaultRoot`, and `v1ArchiveRoot`), or
    3. A store-scoped local DPAPI/machine-derived fallback key (`deriveLocalHostCustodySeed(storeRoot)`) when running in local single-host mode without explicit env overrides (still never writing any key file inside `projectRoot` or `v1ArchiveRoot`).
  - Any `MEMORY_V2_KEYRING_PATH` inside `projectRoot`, `v2VaultRoot`, or `v1ArchiveRoot` throws `FreshStartError("FRESH_START_PATH_OVERLAP")`.
- **Two-Level Envelope Hierarchy in `custody-recovery.sqlite`**:
  - Tables in `custody-recovery.sqlite`:
    - `key_versions(project_id, store_id, domain_kind, purpose, key_id, version, is_current, status, wrapped_key_material_json, created_at, retired_at)`
    - `evidence_key_envelopes(project_id, store_id, evidence_id, wrap_key_id, wrap_key_version, original_wrap_hash, wrapped_data_key_json, status, updated_at)`
    - `erasure_fences(project_id, store_id, erasure_id, evidence_id, source_event_id, erasure_event_id, tombstone_hash, reason, erased_at)`
    - `fresh_start_backups(project_id, store_id, backup_id, release_id, backup_path, terminal_event_position, terminal_event_hash, manifest_sha256, created_at)`
  - When `EvidenceKeyProvider.wrap(scope, wrapKeyRef, dataKey, aad)` seals an item:
    - It wraps `dataKey` with the versioned KEK `(wrapKeyRef.keyId, wrapKeyRef.version)` using AES-256-GCM bound to `aad`.
    - When `registerEvidenceEnvelope(scope, evidenceId, wrappedKey, aad)` (or first `unwrap` / `wrap`) runs, the custody store records the active envelope in `evidence_key_envelopes`.
  - **Key Rotation (`rotateEvidenceWrapKey(scope, nextVersion, now)`)**:
    - Promotes `(keyId, nextVersion)` to `is_current = 1, status = 'available'`.
    - Iterates all `status = 'active'` rows in `evidence_key_envelopes`, unwraps each 32-byte `dataKey` using its prior `(wrap_key_id, wrap_key_version)`, rewraps it under `(keyId, nextVersion)`, updates `wrapped_data_key_json`, and marks the old key version `retired` (shredding its wrapped key material).
    - Subsequent `unwrap(scope, stored.wrappedKey, aad)` checks `erasure_fences` first, then resolves any rotated envelope matching `original_wrap_hash = wrapHash(stored.wrappedKey)` under the current `nextVersion` KEK, so historical `retained_evidence_blobs` rows and `events` hashes never change.
  - **Erasure & Restoration Fences (`recordErasureFence`, `applyErasureFences`)**:
    - `recordErasureFence` inserts an immutable row into `erasure_fences` and overwrites/deletes the corresponding `evidence_key_envelopes` secret material (`status = 'erased', wrapped_data_key_json = NULL`).
    - Any subsequent `unwrap` for that `evidenceId` or `original_wrap_hash` throws `RetainedEvidenceError("RETAINED_EVIDENCE_ERASED")`.

#### Large-Frame Compression & Chunking (`src/orchestrator/privacy/large-frame-chunking.ts`)
- `prepareLargeEvidenceFrames(input, policy)`:
  - Accepts logical frames with UTF-8 content up to `1_048_576` bytes (1 MiB).
  - Applies `redactEvidence(content, mediaType, policy)` **before** compression or chunking so redaction spans never split across chunk boundaries and raw secrets are never compressed.
  - If the redacted frame fits within `65_536` bytes and `chunkForce !== true`, emits a single standard `RetainedEvidenceFrameV1`.
  - If the redacted frame exceeds `65_536` bytes (or `chunkForce === true`), compresses the canonical `{ content, manifest }` JSON using deterministic `deflateSync(..., { level: 9 })`, splits the compressed payload into ordered base64url chunks that each fit well below the 64 KiB `RetainedEvidenceFrameV1` limit (<= 48 KiB per chunk, max 32 chunks), and wraps each chunk as a `application/json` `RetainedEvidenceFrameV1` carrying `{ __v2ChunkedFrame: 1, groupId, chunkIndex, chunkCount, originalMediaType, compressedSha256, payloadB64 }`.
- `reassembleChunkedEvidenceFrames(frames)`:
  - Validates contiguous `chunkIndex` (`0..chunkCount-1`), verifies `compressedSha256`, inflates via `inflateSync` with bounded `maxOutputLength: 1_048_576`, and restores the exact `RedactedEvidenceFrameV1`.

---

### 3.2 F2-G: Governed Lifecycle Completion (`src/orchestrator/governance/` & `src/orchestrator/projections/`)

- **Dedicated `governed-lifecycle` Transition Stream Pattern**:
  - `isReservedGovernedNoteSource` (`src/orchestrator/governed-notes/pair-validation.ts:30-34`) reserves `MemorySourceRecorded` events on `governed-note/...` exclusively for the initial 2-event `create-governed-note` command (`GovernedNoteCreated` at `streamVersion = 1n`, `MemorySourceRecorded` at `streamVersion = 2n`), and `ProjectionFoldAccumulatorV3.append` (`src/orchestrator/projections/folds.ts:1236`) forbids inserting duplicate `governed_notes` keys.
  - Therefore, each governed lifecycle mutation (`promote-governed-record`, `supersede-governed-record`, `retract-governed-record`, `expire-governed-record`, `erase-governed-evidence`) appends a single self-contained transition event (`GovernedRecordPromoted`, `GovernedRecordSuperseded`, `GovernedRecordRetracted`, `GovernedRecordExpired`, or `EvidenceErased`) on `streamType: "governed-lifecycle"`, `streamId: "governed-lifecycle/<recordId>"` (`command_event_index = 0`, `command_event_count = 1`).
  - `decodeProjectionEvent` and `decodeProjectionSourceV3` (`src/orchestrator/projections/source-event-codec.ts`) decode these 5 event types into `GovernedLifecycleProjectionEventV1` (`kind: "governed-lifecycle-transition"`), and `ProjectionFoldAccumulatorCore` / `ProjectionFoldAccumulatorV3` (`src/orchestrator/projections/folds.ts` and `captured-image-v3.ts`) fold them in-place:
    1. `promote-governed-record` (`GovernedRecordPromoted`): updates `canonical_items.status` (`"provisional"` or `"verified"`), `verification_method`, `verification_anchor`, `valid_from`, and `updated_event_position`, and updates `governed_notes.source_event_position` to the transition event's `globalPosition.toString()`.
    2. `supersede-governed-record` (`GovernedRecordSuperseded`): updates `canonical_items.status = "superseded"` (or `"conflicted"` when `declareConflict === true`), `superseded_by_event_id`, `valid_to`, and `updated_event_position`, updates `governed_notes.source_event_position`, and records/updates any declared conflict row in `canonical_conflicts`.
    3. `retract-governed-record` (`GovernedRecordRetracted`): updates `canonical_items.status = "retracted"`, `retracted_by_event_id`, `valid_to`, and `updated_event_position`, and updates `governed_notes.source_event_position`.
    4. `expire-governed-record` (`GovernedRecordExpired`): updates `canonical_items.status = "expired"`, `valid_to`, and `updated_event_position`, and updates `governed_notes.source_event_position`.
    5. `erase-governed-evidence` (`EvidenceErased`): updates `canonical_items.status = "erased-evidence"`, `verification_method = "governed-note-erased-v1"`, `summary = "[ERASED]"`, `searchable_text = ""`, `updated_event_position`, deletes the `governed_notes` full-body entry for `recordId`, and deletes all `lexical_chunks` for `recordId`.
- **Closed `verificationMethod` Marker Set in `validateGovernedNoteProjectionRows` (`src/orchestrator/projections/contracts.ts`)**:
  - `validateGovernedNoteProjectionRows` (`contracts.ts:496-542`) enforces a closed marker set without importing any non-closure module:
    - V1 summary-only markers (`format === null && body === null && bodyContentHash === null`):
      `governed-note-unverified-v1`, `governed-note-user-confirmed-v1`, `governed-note-test-verified-v1`, `governed-note-source-anchored-v1`, `governed-note-accepted-adr-v1`, `governed-note-cross-session-v1`.
    - V2 full-body markdown markers (`format === "markdown"` + valid `body` & `bodyContentHash`):
      `governed-note-unverified-v2`, `governed-note-user-confirmed-v2`, `governed-note-test-verified-v2`, `governed-note-source-anchored-v2`, `governed-note-accepted-adr-v2`, `governed-note-cross-session-v2`.
    - Erased tombstone marker (no `governed_notes` side row allowed):
      `governed-note-erased-v1`.
  - When `PromoteGovernedRecordInput` promotes a V1 or V2 governed note with `verificationMethod` (`user-confirmed`, `test-verified`, `source-anchored`, `accepted-adr`, `cross-session-observation`), it maps to the corresponding `-v1` or `-v2` marker so `validateGovernedNoteProjectionRows` continues to enforce V1 (`null` body) vs V2 (`"markdown"` body) vs erased (`no side row`) invariants and rejects unknown markers like `"generic"` or `"governed-note-unverified-v9"`.
- **Verification Policy Enforcement (`promote-governed-record`)**:
  - Allowed `verificationMethod` values for `provisional` / `verified`:
    - `user-confirmed`, `test-verified`, `source-anchored`, `accepted-adr`, `cross-session-observation`.
  - High-risk records (`recordKind === "adr"` or tags/metadata touching `security`, `auth`, `secrets`, `deployment`, `schema`, `migration`, `destructive-ops`) reject `cross-session-observation` (repetition alone) when promoting to `verified`, requiring `user-confirmed`, `test-verified`, `source-anchored`, or `accepted-adr` with a non-empty `verificationAnchor`.
- **Verified Read Behavior on `erased-evidence`**:
  - When `get-full-note` is queried for an `erased-evidence` record, it returns `found: false` (since its `governed_notes` side row has been scrubbed), and `search-projected-content` / `build-context-pack` exclude `erased-evidence`, `retracted`, `expired`, and `superseded` records by default.

---

### 3.3 F2-P: Public V2 Capability Manifest & MCP Tool Wiring (`src/v2/`)

- **32-Tool V1 Parity Manifest (`V2_PRODUCTION_CAPABILITIES`)**:
  - **20 `V2-supported` V1 tools**:
    - Read/Retrieval: `memory_search`, `memory_get`, `memory_list`, `memory_recent`, `memory_contextPack`, `memory_followUpRadar`
    - Write: `memory_writeSessionLog`, `memory_writeInsight`, `memory_writeMistake`, `memory_writeADR`
    - Workflow/Session: `memory_sessionStart`, `memory_sessionEnd`, `memory_lifecycleStatus`, `memory_selfCheck`, `memory_awaken`
    - Verification: `memory_verifyVault`, `memory_verifyNote`, `memory_verifySourceTruth`, `memory_findDuplicates`, `memory_checkStaleness`
  - **4 `superseded` operator-only V1 tools** (refused on public MCP with `FRESH_START_OPERATOR_ONLY_TOOL` and `supersededBy` pointer to `v2-admin.js`):
    - `memory_bootstrapProject` (`v2-admin.js initialize-fresh`)
    - `memory_reindex` (`v2-admin.js rebuild-projections`)
    - `memory_indexNote` (`v2-admin.js rebuild-projections`)
    - `memory_diagnoseWorkspace` (`v2-admin.js status` / `memory_v2Status`)
  - **8 `unavailable` V1 tools** (refused on public MCP with `FRESH_START_CAPABILITY_UNAVAILABLE` and typed rationale):
    - `memory_createFromTemplate`, `memory_findBrokenLinks`, `memory_validateFrontmatter`, `memory_fixFrontmatter`, `memory_migrateFrontmatter`, `memory_compactVault`, `memory_export`, `memory_import`.
  - **V2-Native Tools**:
    - `memory_v2Status`, `memory_checkpoint`, `memory_recoverSession`, `memory_sessionFork`, `memory_recordChildResult`, `memory_completeChildSession`, `memory_amendSessionEnd`, `memory_cancelSessionEnd`, `memory_recordEvidenceBatch`, `memory_promote`, `memory_supersede`, `memory_retract`, `memory_expire`, `memory_forgetEvidence`.
- **Closed Provenance & Session Binding for V1-Compatible Write Tools**:
  - `memory_sessionStart` starts or resumes a root session in the V2 store, caches the active session authority in the MCP server's in-memory `V2PublicSessionManager`, and retains an initial session-start evidence frame.
  - When `memory_writeSessionLog`, `memory_writeInsight`, `memory_writeMistake`, or `memory_writeADR` is called:
    - If `sessionId` is omitted and exactly one root session is active in the server instance, it binds to that active root session (if none is active, it auto-starts a default root session for the project workspace; if multiple are active without `sessionId`, it throws `FRESH_START_INPUT_INVALID`).
    - If explicit `provenance` is omitted, it automatically retains a redacted `EvidenceBatchRetained` frame of the command input within the active session and cites that committed `evidenceId`/`eventId` when committing `GovernedNoteCommandV2`, then triggers `V2ProjectionBuildCoordinator.publish()` so read-after-write queries (`memory_get`, `memory_search`, `memory_list`, `memory_recent`, `memory_contextPack`, `memory_followUpRadar`) immediately observe the published Projection Schema 3 view.

---

### 3.4 F3: Recovery (`src/orchestrator/recovery/`) & Release Verifier (`scripts/run-v2-fresh-start-release.js`)

- **`V2BackupService` (`src/orchestrator/recovery/backup.service.ts`)**:
  - Acquires an exclusive `MaintenanceFence` lease on `events.sqlite`.
  - Executes `PRAGMA wal_checkpoint(TRUNCATE)` and `VACUUM INTO` to write a clean, WAL-free SQLite image `events.sqlite` and `custody-recovery.sqlite` into an isolated backup directory (`assertFreshStartDisjoint`).
  - Copies `.memory-mcp/project-identity.json`, `store-manifest.json`, and `projection-manifest.json`, exports `erasure-fences.json`, verifies `PRAGMA integrity_check` and `EventIntegrityService` on the snapshot, writes a canonical `backup-manifest.json` with SHA-256 file digests and terminal event position/hash, and records the backup receipt in `custody-recovery.sqlite` (`fresh_start_backups`).
- **`V2BackupScheduler` & `V2BackupHealth`**:
  - Evaluates whether a verified backup exists for the current terminal event position, whether an active store with uncommitted post-backup events has exceeded the `maxActiveBackupAgeMs` (default 1 hour = `3_600_000` ms), and runs pre-upgrade and orderly-shutdown backups when new events exist.
- **`V2RestoreService` & `V2RollbackService` (`src/orchestrator/recovery/restore.service.ts`)**:
  - Validates `backup-manifest.json` digests before touching the target directory.
  - Restores the backup into a separate empty target directory (`assertFreshStartDisjoint` from source vault and V1 archive).
  - Replays any provided post-backup event/evidence journal up to the requested `recoveryPosition`/`recoveryHash` fence.
  - If the restored + replayed event stream stops short of `recoveryPosition`, returns `status: "incomplete-fence"` with `missingRange: { fromExclusivePosition, toInclusivePosition, expectedHash }` and keeps the restored store in `read-only-recovery` mode (refusing mutations).
  - Applies all `EvidenceErased` events and `erasure-fences.json` tombstones to `custody-recovery.sqlite` and rebuilds Projection Schema 3 via `V2ProjectionBuildCoordinator` **before** opening read access, guaranteeing forgotten evidence cannot be resurrected from an older backup.
- **`scripts/run-v2-fresh-start-release.js`**:
  - Runs all 8 compiled public-service scenarios from `2026-09-29-v2-fresh-start-production-design.md:125-133` against `dist/v2.js` and `dist/v2-admin.js` on isolated temporary directories and writes a canonical signed/hashed release qualification receipt.

---

### 3.5 F4: Operator Approval, V1 Archive Freeze & Client Config Generator (`src/v2/admin.ts`)

- **Operator Approval & Release Evidence Verification**:
  - `createHmacOperatorApprovalVerifier(secretKey)` wraps `TrustedOperatorApprovalVerifier` (`src/orchestrator/fresh-start/operator-approval.ts:46`), verifying an HMAC-SHA256 signature over `canonicalJson({ domain: "fresh-start-operator-approval-v1", identity, approvalId, nonceDigest, actorFingerprint, requestDigest, evidenceDigest, issuedAt, expiresAt })` and checking `issuedAt <= now <= expiresAt`.
  - `createFileFreshStartEvidenceVerifier(evidenceReportPath)` wraps `TrustedFreshStartEvidenceVerifier` (`src/orchestrator/fresh-start/operator-approval.ts:57`), verifying that the release qualification report at `evidenceReportPath` passed all 8 scenarios for the exact `buildIdentityHash`, `schemaIdentityHash`, `capabilityManifestHash`, and `recoveryPolicyHash`.
- **Extended `runV2Admin` Commands (`src/v2/admin.ts`)**:
  - Foundation-compatible commands (unchanged 4-flag signature `--project-root`, `--v2-vault-root`, `--v1-archive-root`, `--release-manifest`):
    - `initialize-fresh`, `resume-initialization`, `status`.
  - Production operator commands:
    - `sign-approval`: mints a signed operator approval JSON file using `MEMORY_V2_OPERATOR_APPROVAL_KEY`.
    - `activate`, `enter-recovery`, `exit-recovery`, `disable`: transitions the store via `FreshStartControlPlane.transition(...)` when `--operator-approval` and `--release-evidence` are supplied for a production-profile release; throws `FRESH_START_RELEASE_NOT_READY` when called without them or on a foundation closed-profile release.
    - `backup`, `restore`, `verify-recovery`, `rebuild-projections`: invokes `V2BackupService`, `V2RestoreService`, and `V2ProjectionBuildCoordinator`.
    - `freeze-v1-archive`, `verify-v1-archive`: enumerates all files in `--v1-archive-root`, computes SHA-256 digests into `<v2-vault-root>/.memory-mcp/v1-archive-manifest.json`, sets read-only file modes on all archive files, and verifies that a write probe into `--v1-archive-root` is denied while all manifest digests match.
    - `generate-client-configs`: generates canonical V2 client config payloads (`.codex/config.toml`, `opencode.json`, `.antigravity/mcp.json`, `.cursor/mcp.json`, `.zed/settings.json`, `.windsurf/mcp.json`, `.mcp.json`, `.claude/settings.local.json`) pointing to `dist/v2.js` with explicit canonical absolute paths.
