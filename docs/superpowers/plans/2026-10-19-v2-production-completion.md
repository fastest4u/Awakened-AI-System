# V2 Production Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver operational purpose-key custody and large-frame chunking (F2-K), governed lifecycle mutations and privacy erasure scrubbing (F2-G), public V2 MCP tool surface and 32-tool capability manifest (F2-P), verified backup/restore/replay/erasure-after-restore and 8-scenario compiled release qualification (F3), and real operator approval, V1 archive freeze, and client config cutover tooling (F4 preparation).

**Architecture:** Preserve `events.sqlite` at Schema 9 (`f10eb1976f2fd97d899163d930a91e21f66daaccf448a76334d5c9b13ffd6df1`) and preserve the foundation prepared release profile (`V2_CAPABILITIES` / `V2_RECOVERY_POLICY`) so all existing foundation, retained-evidence, and full-body-notes gates remain green. Persist operational key-envelope rotation state, erasure/restoration fences, and backup health receipts in a fenced `custody-recovery.sqlite` sidecar inside `route.storeRoot`, append self-contained governance transition events on `streamType: "governed-lifecycle"` decoded as `GovernedLifecycleProjectionEventV1` for in-place projection folding, and expose the 32-tool V1 parity manifest + V2-native tools when a store is initialized with `V2_PRODUCTION_CAPABILITIES` + `V2_PRODUCTION_RECOVERY_POLICY` and promoted to `active`.

**Tech Stack:** TypeScript (ESM, Node 24.16+, built-in `node:sqlite` `DatabaseSync`, `node:crypto`, `node:zlib`), `@modelcontextprotocol/sdk`, `esbuild`.

**Spec:** `docs/superpowers/specs/2026-10-19-v2-production-completion-design.md`

## Global Constraints

- Never modify V1 source paths (`src/app.ts`, `src/index.ts`, `src/controllers/*`, `src/schemas/*`, `src/services/*`), which are locked by `.github/workflows/v2-release-qualification.yml` (`git diff --exit-code 0e375d4643d4b630f36f874a3bb192e96739ac46 -- src/app.ts src/index.ts src/controllers src/schemas src/services`).
- Keep `PROJECT_STORE_MIGRATIONS` at Schema 9 (`CURRENT_PROJECT_STORE_SCHEMA_VERSION = 9`, `schemaIdentityHash = "f10eb1976f2fd97d899163d930a91e21f66daaccf448a76334d5c9b13ffd6df1"`).
- Keep the 5 emitted Fresh-Start build artifacts in `scripts/fresh-start-build.js` (`v2.js`, `v2-admin.js`, `workers/project-store.worker.js`, `internal/v2-internal-verified-read.js`, `internal/v2-internal-verified-read-cleanup.js`) with zero external non-builtin runtime imports.
- Do not import `child_process`, `worker_threads`, `require`, `createRequire`, `eval`, `Function`, or `getBuiltinModule` into any module reachable by `internal/v2-internal-verified-read.js` or `internal/v2-internal-verified-read-cleanup.js`.
- Preserve `V2_CAPABILITIES` and `V2_RECOVERY_POLICY` in `src/v2/config.ts` as the foundation prepared profile so `scripts/smoke-v2-fresh-start.js`, `tests/v2-foundation-entry.test.ts`, and `tests/v2-native-content-entry.test.ts` pass unchanged.
- Never call `project-memory` MCP tools or edit `memory/` from subagents.

## Review Focus

- Keyring path overlap with `projectRoot`, `v2VaultRoot`, or `v1ArchiveRoot` (including symlinks/hardlinks or Windows case-insensitive path prefixes) must fail closed with `FRESH_START_PATH_OVERLAP` before reading any bytes.
- High-risk records (`adr` or records tagged `security`, `auth`, `secrets`, `deployment`, `schema`, `migration`, `destructive-ops`) must refuse promotion to `verified` when `verificationMethod === "cross-session-observation"` (repetition alone).
- Privacy erasure (`forgetEvidence` / `EvidenceErased`) must both shred the wrapped key envelope in `custody-recovery.sqlite` (`RETAINED_EVIDENCE_ERASED` on `openEvidenceItem`) and scrub `governed_notes` full-body rows and `lexical_chunks` from newly published Projection Schema 3 images.
- Restoring an older backup created *before* an `EvidenceErased` fence and replaying the erasure fence via `V2RestoreService` must scrub the erased evidence and rebuild projections *before* reads resume so forgotten content cannot be resurrected.
- Calling `v2-admin.js activate` on a foundation prepared release (or without valid `--operator-approval` and `--release-evidence`) must continue to fail with `FRESH_START_RELEASE_NOT_READY` with zero secret leakage on `stdout`/`stderr`.

---

### Task 1: Operational Key Custody, Envelope Rotation, Erasure Fences & Large-Frame Chunking (F2-K)

**Files:**
- Create: `src/orchestrator/keys/operational-key-custody.ts`
- Create: `src/orchestrator/privacy/large-frame-chunking.ts`
- Test: `tests/v2-operational-key-custody.test.ts`

**Interfaces:**
- Consumes:
  - `CapabilityKeyProvider`, `CapabilityKeyPurpose`, `KeyScope` from `src/orchestrator/lifecycle/authority/capability-key-provider.ts`
  - `EvidenceKeyProvider`, `EvidenceKeyPurpose`, `EvidenceKeyRefV1`, `EvidenceKeyScope`, `WrappedEvidenceKeyV1` from `src/orchestrator/privacy/evidence-key-provider.js`
  - `HistoricalEvidenceIntegrityProviderPort` from `src/orchestrator/integrity/integrity.types.js`
  - `sealEvidenceItem`, `openEvidenceItem` from `src/orchestrator/privacy/evidence-envelope.js`
  - `redactEvidence`, `TrustedRedactionPolicyV1`, `RedactedEvidenceFrameV1` from `src/orchestrator/privacy/redaction.js`
- Produces:
  - `export interface OperationalKeyCustodyOptions { readonly storeRoot: string; readonly projectId: string; readonly storeId: string; readonly paths?: FreshStartPaths; readonly env?: Readonly<Record<string, string | undefined>>; readonly masterSeed?: Uint8Array; }`
  - `export interface ErasureFenceRecordV1 { readonly erasureId: string; readonly projectId: string; readonly storeId: string; readonly evidenceId: string; readonly sourceEventId: string; readonly erasureEventId: string; readonly tombstoneHash: string; readonly reason: string; readonly erasedAt: string; }`
  - `export interface BackupReceiptRecordV1 { readonly backupId: string; readonly projectId: string; readonly storeId: string; readonly releaseId: string; readonly backupPath: string; readonly terminalEventPosition: string; readonly terminalEventHash: string; readonly manifestSha256: string; readonly createdAt: string; }`
  - `export class OperationalKeyCustodyProvider implements HistoricalEvidenceIntegrityProviderPort` exposing `.capability: CapabilityKeyProvider`, `.evidence: EvidenceKeyProvider`, `.rotateEvidenceWrapKey(nextVersion: string, now: string): { rotatedEnvelopes: number; activeKeyRef: EvidenceKeyRefV1 }`, `.recordErasureFence(input: Omit<ErasureFenceRecordV1, "tombstoneHash">): ErasureFenceRecordV1`, `.listErasureFences(): readonly ErasureFenceRecordV1[]`, `.isEvidenceErased(evidenceId: string): boolean`, `.recordBackupReceipt(receipt: BackupReceiptRecordV1): void`, `.latestBackupReceipt(): BackupReceiptRecordV1 | null`, `.close(): void`
  - `export function prepareLargeEvidenceFrames(input: { readonly frameId: string; readonly startOrdinal: bigint; readonly previousFrameId: string | null; readonly role: "user" | "assistant" | "tool"; readonly category: EvidenceFrameMetadataV1["category"]; readonly occurredAt: string; readonly mediaType: "text/plain; charset=utf-8" | "application/json"; readonly content: unknown; readonly toolCorrelationId: string | null; readonly artifactHashes: readonly string[]; readonly policy: TrustedRedactionPolicyV1; readonly maxChunkContentBytes?: number }): readonly RetainedEvidenceFrameV1[]`
  - `export function reassembleChunkedEvidenceFrames(frames: readonly RedactedEvidenceFrameV1[]): RedactedEvidenceFrameV1`

- [ ] **Step 1: Write the failing test in `tests/v2-operational-key-custody.test.ts`**

Cover:
1. `OperationalKeyCustodyProvider` initializes `custody-recovery.sqlite` inside `storeRoot`, provides all 11 `CapabilityKeyPurpose`s and 3 `EvidenceKeyPurpose`s across restarts, and rejects `MEMORY_V2_KEYRING_PATH` overlapping `projectRoot`, `v2VaultRoot`, or `v1ArchiveRoot` with `FRESH_START_PATH_OVERLAP`.
2. Sealing an evidence item with `sealEvidenceItem` under version `"1"`, rotating `data-key-wrap` to version `"2"` via `rotateEvidenceWrapKey("2", now)` (which retires version `"1"` and rewraps the stored data-key envelope without mutating `EncryptedEvidenceItemV1`), and calling `openEvidenceItem` succeeds using version `"2"`.
3. Calling `recordErasureFence` computes a deterministic `tombstoneHash`, shreds the envelope in `custody-recovery.sqlite`, and causes `openEvidenceItem` to throw `RetainedEvidenceError` with `code: "RETAINED_EVIDENCE_ERASED"`.
4. `prepareLargeEvidenceFrames` redacts a >64 KiB payload (e.g. 180 KiB containing a synthetic secret token) *before* compression/chunking into multiple `<= 65536` byte `RetainedEvidenceFrameV1` items with zero secret bytes in any chunk, and `reassembleChunkedEvidenceFrames` after `sealEvidenceItem`/`openEvidenceItem` restores the exact redacted plaintext and manifest while rejecting missing/reordered/tampered chunks with `INTEGRITY_FAILURE`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -p tsconfig.test.json && node --test dist-test/tests/v2-operational-key-custody.test.js`
Expected: FAIL with module not found (`operational-key-custody.js` / `large-frame-chunking.js`).

- [ ] **Step 3: Implement `src/orchestrator/keys/operational-key-custody.ts` and `src/orchestrator/privacy/large-frame-chunking.ts`**

- In `operational-key-custody.ts`, open `join(storeRoot, "custody-recovery.sqlite")` with WAL mode, create `key_versions`, `evidence_key_envelopes`, `erasure_fences`, and `fresh_start_backups` tables, derive per-purpose/per-version KEKs using HMAC-SHA256 from the validated master seed, track wrapped data-key envelopes by `original_wrap_hash = retainedEvidenceWrapHash(wrappedKey)` and `evidence_id` (extracted from `aad` JSON `$.evidenceId`), rewrap active envelopes on `rotateEvidenceWrapKey`, and destroy envelope material on `recordErasureFence`.
- In `large-frame-chunking.ts`, run `redactEvidence` on the full logical input (up to `1_048_576` UTF-8 bytes), compress canonical JSON `{ content, manifest }` with `deflateSync` when UTF-8 byte length exceeds `maxChunkContentBytes` (default `49_152`), split into ordered chunks with consecutive ordinals and `previousFrameId` chain, and reassemble/verify in `reassembleChunkedEvidenceFrames`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsc -p tsconfig.test.json && node --test dist-test/tests/v2-operational-key-custody.test.js`
Expected: PASS (all tests in `v2-operational-key-custody.test.ts` pass).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/keys/operational-key-custody.ts src/orchestrator/privacy/large-frame-chunking.ts tests/v2-operational-key-custody.test.ts
git commit -m "feat(v2): add operational key custody, rotation, erasure fences, and large-frame chunking"
```

---

### Task 2: Governed Lifecycle Completion — Promotion, Supersession, Conflict, Retraction, Expiry & Privacy Erasure (F2-G)

**Files:**
- Create: `src/orchestrator/governance/contracts.ts`
- Create: `src/orchestrator/governance/governance.service.ts`
- Modify: `src/orchestrator/projections/contracts.ts`
- Modify: `src/orchestrator/projections/source-event-codec.ts`
- Modify: `src/orchestrator/projections/folds.ts`
- Modify: `src/orchestrator/projections/captured-image-v3.ts`
- Modify: `src/orchestrator/integrity/event-integrity.service.ts`
- Test: `tests/v2-governed-lifecycle-mutations.test.ts`

**Interfaces:**
- Consumes:
  - `OperationalKeyCustodyProvider`, `ErasureFenceRecordV1` from `src/orchestrator/keys/operational-key-custody.ts`
  - `GovernedCanonicalItem`, `ProjectionItemStatus` from `src/orchestrator/projections/contracts.ts`
  - `V2ProjectionBuildCoordinator` from `src/orchestrator/projections/coordinator.ts`
- Produces:
  - `export type GovernedVerificationMethodV1 = "user-confirmed" | "test-verified" | "source-anchored" | "accepted-adr" | "cross-session-observation"`
  - `export interface PromoteGovernedRecordInput { readonly commandId: string; readonly idempotencyKey: string; readonly sessionId: string; readonly recordId: string; readonly targetStatus: "provisional" | "verified"; readonly verificationMethod: GovernedVerificationMethodV1; readonly verificationAnchor: string; readonly occurredAt: string; }`
  - `export interface SupersedeGovernedRecordInput { readonly commandId: string; readonly idempotencyKey: string; readonly sessionId: string; readonly recordId: string; readonly replacementRecordId?: string; readonly replacementTitle?: string; readonly replacementSummary?: string; readonly replacementBodyMarkdown?: string; readonly reason: string; readonly conflictKey?: string | null; readonly declareConflict?: boolean; readonly occurredAt: string; }`
  - `export interface RetractGovernedRecordInput { readonly commandId: string; readonly idempotencyKey: string; readonly sessionId: string; readonly recordId: string; readonly reason: string; readonly occurredAt: string; }`
  - `export interface ExpireGovernedRecordInput { readonly commandId: string; readonly idempotencyKey: string; readonly sessionId: string; readonly recordId: string; readonly validTo: string; readonly reason: string; readonly occurredAt: string; }`
  - `export interface ForgetGovernedEvidenceInput { readonly commandId: string; readonly idempotencyKey: string; readonly sessionId: string; readonly evidenceIds: readonly string[]; readonly recordIds?: readonly string[]; readonly reason: string; readonly occurredAt: string; }`
  - `export class GovernedLifecycleService` with `.promote(input)`, `.supersede(input)`, `.retract(input)`, `.expire(input)`, `.forgetEvidence(input)`

- [ ] **Step 1: Write the failing test in `tests/v2-governed-lifecycle-mutations.test.ts`**

Cover:
1. Promoting a `candidate` governed note (`insight`, `adr`) to `provisional` and `verified` with a valid `verificationMethod` (`test-verified` / `accepted-adr`), while rejecting `cross-session-observation` on an `adr` or `security`-tagged insight with `GOVERNED_VERIFICATION_POLICY_DENIED`.
2. Superseding a governed note (`status: "superseded"`, `supersededByEventId` populated) and declaring/resolving a conflict (`status: "conflicted"` in `canonical_conflicts`).
3. Retracting (`status: "retracted"`, `retractedByEventId` populated) and expiring (`status: "expired"`, `validTo` populated) governed records so default `search-projected-content` and `build-context-pack` exclude them while `get-canonical-record` / `get-full-note` reflects their updated status.
4. Executing `forgetEvidence` appends `EvidenceErased` on `streamType: "governed-lifecycle"` (`status: "erased-evidence"`), records the tombstone in `OperationalKeyCustodyProvider`, scrubs the full-body row from `governed_notes` and `lexical_chunks` upon `V2ProjectionBuildCoordinator.publish()`, and passes `EventIntegrityService`, `ProjectionIntegrityService`, and child-process `get-full-note` (`found: false`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -p tsconfig.test.json && node --test dist-test/tests/v2-governed-lifecycle-mutations.test.js`
Expected: FAIL with module not found (`src/orchestrator/governance/governance.service.js`).

- [ ] **Step 3: Implement `src/orchestrator/governance/contracts.ts`, `src/orchestrator/governance/governance.service.ts`, and in-place projection folding on `GovernedLifecycleProjectionEventV1`**

- In `governance.service.ts`, validate commands and idempotency in `command_dedup`, look up the current projected/event state of `recordId`, enforce verification rules (`cross-session-observation` forbidden for `adr` or `security`/`auth`/`secrets`/`deployment`/`schema`/`migration`/`destructive-ops` tags/kinds), and append a single self-contained transition event (`GovernedRecordPromoted`, `GovernedRecordSuperseded`, `GovernedRecordRetracted`, `GovernedRecordExpired`, `EvidenceErased`) on `streamType: "governed-lifecycle"`, `streamId: "governed-lifecycle/<recordId>"` (`command_event_index = 0`, `command_event_count = 1`) inside an atomic SQLite transaction. (Do NOT emit a second `MemorySourceRecorded` event on `governed-note/...`, which is reserved for initial `create-governed-note` pair validation.)
- In `src/orchestrator/projections/contracts.ts` (keep closure-clean with zero imports from `src/orchestrator/governance/*`):
  - Define closed marker sets:
    - `GOVERNED_NOTE_V1_MARKERS = new Set(["governed-note-unverified-v1", "governed-note-user-confirmed-v1", "governed-note-test-verified-v1", "governed-note-source-anchored-v1", "governed-note-accepted-adr-v1", "governed-note-cross-session-v1"])`
    - `GOVERNED_NOTE_V2_MARKERS = new Set(["governed-note-unverified-v2", "governed-note-user-confirmed-v2", "governed-note-test-verified-v2", "governed-note-source-anchored-v2", "governed-note-accepted-adr-v2", "governed-note-cross-session-v2"])`
    - `GOVERNED_NOTE_ERASED_MARKER = "governed-note-erased-v1"`
  - Update `validateGovernedNoteProjectionRows` (`contracts.ts:496-542`) so `GOVERNED_NOTE_V1_MARKERS` require `null` body tuples, `GOVERNED_NOTE_V2_MARKERS` require `"markdown"` body tuples, and `GOVERNED_NOTE_ERASED_MARKER` is forbidden from having a `governed_notes` side row (`!seen.has(key)` allowed only when `item.verificationMethod === GOVERNED_NOTE_ERASED_MARKER`), preserving 100% of `tests/v2-full-body-note-projection.test.ts`.
- In `src/orchestrator/projections/source-event-codec.ts`, `src/orchestrator/projections/folds.ts`, and `src/orchestrator/projections/captured-image-v3.ts`, decode the 5 governance transition event types into `GovernedLifecycleProjectionEventV1` (`kind: "governed-lifecycle-transition"`) and fold them in-place into `canonicalItems`, `canonicalConflicts`, `lexicalChunks`, and `this.#governedNotes` (updating `governed_notes.sourceEventPosition` to `event.globalPosition.toString()`, or deleting `this.#governedNotes.delete(key)` and removing `lexicalChunks` when `transitionKind === "erase-evidence"`).
- Ensure `EventIntegrityService` reconstructs deterministic command hashes for the 5 governance command types.

- [ ] **Step 4: Run the test and existing projection/integrity tests to verify they pass**

Run: `npx tsc -p tsconfig.test.json && node --test dist-test/tests/v2-governed-lifecycle-mutations.test.js dist-test/tests/v2-full-body-note-projection.test.js dist-test/tests/projection-schema.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-integrity.test.js dist-test/tests/event-integrity.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/governance/contracts.ts src/orchestrator/governance/governance.service.ts src/orchestrator/projections/contracts.ts src/orchestrator/projections/source-event-codec.ts src/orchestrator/projections/folds.ts src/orchestrator/projections/captured-image-v3.ts src/orchestrator/integrity/event-integrity.service.ts tests/v2-governed-lifecycle-mutations.test.ts
git commit -m "feat(v2): add governed lifecycle promotion, supersession, retraction, expiry, and erasure scrubbing"
```

---

### Task 3: Public V2 Capability Manifest, Composition & MCP Tool Wiring (F2-P)

**Files:**
- Create: `src/v2/capabilities.ts`
- Create: `src/v2/public-tools.ts`
- Modify: `src/v2/config.ts`
- Modify: `src/v2/composition.ts`
- Modify: `src/v2/app.ts`
- Modify: `src/workers/project-store.worker.ts`
- Modify: `src/orchestrator/runtime/project-store-worker-backend.ts`
- Test: `tests/v2-public-mcp-tools.test.ts`

**Interfaces:**
- Consumes:
  - `OperationalKeyCustodyProvider` from `src/orchestrator/keys/operational-key-custody.ts`
  - `GovernedLifecycleService` from `src/orchestrator/governance/governance.service.ts`
  - `createVerifiedReadAdapter` from `src/orchestrator/verified-read/supervisor.ts`
  - `V2ProjectionBuildCoordinator` from `src/orchestrator/projections/coordinator.ts`
- Produces:
  - `export const V2_PRODUCTION_CAPABILITIES` and `export const V2_PRODUCTION_RECOVERY_POLICY` in `src/v2/config.ts` / `src/v2/capabilities.ts`
  - `export function isProductionReleaseManifest(release: Omit<FreshStartRelease, keyof FreshStartIdentity>): boolean`
  - `export interface FreshStartStatus { readonly mode: FreshStartMode; readonly productionReady: boolean; readonly buildIdentityHash: string; ... }` in `src/v2/composition.ts`
  - `export interface V2ContentAdapters { listTools(): Promise<readonly McpToolDefinition[]>; invoke(name: string, argumentsValue: unknown): Promise<unknown>; }` in `src/v2/composition.ts`

- [ ] **Step 1: Write the failing test in `tests/v2-public-mcp-tools.test.ts`**

Cover:
1. `V2_PRODUCTION_CAPABILITIES` classifies all 32 V1 tool names (`20` `V2-supported`, `4` `superseded`, `8` `unavailable`) + 14 V2-native tools, while `V2_CAPABILITIES` and `V2_RECOVERY_POLICY` remain unchanged for foundation prepared stores.
2. On a production-profile store transitioned to `mode: "active"`, `foundation.status().productionReady` is `true`, `tools/list` exposes all supported V2 tools, calling `unavailable` V1 tools (`memory_createFromTemplate`, `memory_findBrokenLinks`, `memory_validateFrontmatter`, `memory_fixFrontmatter`, `memory_migrateFrontmatter`, `memory_compactVault`, `memory_export`, `memory_import`) returns `FRESH_START_CAPABILITY_UNAVAILABLE`, and calling `superseded` operator tools (`memory_bootstrapProject`, `memory_reindex`, `memory_indexNote`, `memory_diagnoseWorkspace`) returns `FRESH_START_OPERATOR_ONLY_TOOL`.
3. Over real MCP stdio against compiled `dist/v2.js` on an active store:
   - `memory_sessionStart` starts a root session; `memory_lifecycleStatus`, `memory_selfCheck`, and `memory_awaken` return V2 state.
   - `memory_writeSessionLog`, `memory_writeInsight`, `memory_writeMistake`, and `memory_writeADR` auto-retain redacted command evidence when `provenance` is omitted, commit full-body governed notes, publish Projection Schema 3, and return receipts.
   - `memory_get`, `memory_search`, `memory_list`, `memory_recent`, `memory_contextPack`, and `memory_followUpRadar` execute child-process verified reads and return the full-body notes and summaries.
   - `memory_verifyVault`, `memory_verifyNote`, `memory_verifySourceTruth`, `memory_findDuplicates`, and `memory_checkStaleness` report V2 projection/integrity truth.
   - `memory_promote`, `memory_supersede`, `memory_retract`, `memory_expire`, `memory_forgetEvidence`, `memory_checkpoint`, and `memory_sessionEnd` execute end-to-end and persist across server restarts.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -p tsconfig.test.json && node --test dist-test/tests/v2-public-mcp-tools.test.js`
Expected: FAIL with missing `V2_PRODUCTION_CAPABILITIES` / `src/v2/capabilities.js`.

- [ ] **Step 3: Implement `src/v2/capabilities.ts`, `src/v2/public-tools.ts`, and update `src/v2/config.ts`, `src/v2/composition.ts`, `src/v2/app.ts`**

- Keep `V2_CAPABILITIES` and `V2_RECOVERY_POLICY` unchanged in `src/v2/config.ts` so foundation prepared releases behave identically to baseline.
- In `assertPreparedRelease(release, config, build)`, accept either the foundation pair `(V2_CAPABILITIES, V2_RECOVERY_POLICY)` or the production pair `(V2_PRODUCTION_CAPABILITIES, V2_PRODUCTION_RECOVERY_POLICY)`.
- In `src/v2/composition.ts`:
  - Widen `FreshStartStatus.productionReady` from `false` to `boolean`.
  - When the release uses the foundation pair or `state.mode === "prepared"`, `status().productionReady` is `false`, `listTools()` returns only `memory_v2Status`, and `content.invoke(...)` throws `FRESH_START_RELEASE_NOT_READY`.
  - When the release uses the production pair and `state.mode === "active"` (or `"read-only-recovery"` for read-only tools), `status().productionReady` is `state.mode === "active"`, `listTools()` returns the V2 tool definitions, and `content.invoke(name, args)` dispatches through `V2PublicToolRouter` (`src/v2/public-tools.ts`).
- In `src/orchestrator/runtime/project-store-worker-backend.ts`, keep `active.lifecycleRuntime = null` when `requestedFresh === undefined` (so `scripts/smoke-worker.js` continues to receive `LIFECYCLE_V2_DISABLED`), and instantiate the operational key custody and default V2 runtimes only when `requestedFresh !== undefined` (or when explicit factory options are provided).

- [ ] **Step 4: Rebuild `dist/` and verify both `v2-public-mcp-tools.test.ts` and `v2-foundation-entry.test.ts` pass**

Run: `npm run build && npx tsc -p tsconfig.test.json && node --test dist-test/tests/v2-public-mcp-tools.test.js dist-test/tests/v2-foundation-entry.test.js && node scripts/smoke-v2-fresh-start.js && node scripts/smoke-worker.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/v2/capabilities.ts src/v2/public-tools.ts src/v2/config.ts src/v2/composition.ts src/v2/app.ts src/workers/project-store.worker.ts src/orchestrator/runtime/project-store-worker-backend.ts tests/v2-public-mcp-tools.test.ts
git commit -m "feat(v2): wire public V2 MCP tool surface and 32-tool capability manifest"
```

---

### Task 4: Verified Backup, Scheduler, Health, Isolated Restore, Replay, Erasure-After-Restore & Rollback (`src/orchestrator/recovery/`, F3.1 & F3.2)

**Files:**
- Create: `src/orchestrator/recovery/contracts.ts`
- Create: `src/orchestrator/recovery/backup.service.ts`
- Create: `src/orchestrator/recovery/restore.service.ts`
- Test: `tests/v2-recovery-backup-restore.test.ts`

**Interfaces:**
- Consumes:
  - `MaintenanceFence` from `src/orchestrator/storage/maintenance-fence.ts`
  - `OperationalKeyCustodyProvider` from `src/orchestrator/keys/operational-key-custody.ts`
  - `EventIntegrityService` from `src/orchestrator/integrity/event-integrity.service.ts`
  - `V2ProjectionBuildCoordinator` from `src/orchestrator/projections/coordinator.ts`
  - `ProjectionIntegrityService` from `src/orchestrator/projections/integrity.ts`
- Produces:
  - `export class V2BackupService` with `.createBackup(input: { readonly projectRoot: string; readonly v2VaultRoot: string; readonly v1ArchiveRoot: string; readonly backupRoot: string; readonly reason: "manual" | "pre-upgrade" | "hourly-active" | "orderly-shutdown"; readonly now?: string }): Promise<V2BackupManifestV1>` and `.inspectHealth(input: { readonly v2VaultRoot: string; readonly now?: string; readonly maxActiveBackupAgeMs?: number }): V2BackupHealthReportV1`
  - `export class V2BackupScheduler` with `.runIfDue(input)` and `.onOrderlyShutdown(input)`
  - `export class V2RestoreService` with `.restoreToIsolatedVault(input: { readonly backupRoot: string; readonly targetProjectRoot: string; readonly targetV2VaultRoot: string; readonly v1ArchiveRoot: string; readonly postBackupSourceVaultRoot?: string; readonly requiredRecoveryFence?: { readonly eventPosition: bigint; readonly eventHash: string }; readonly extraErasureFences?: readonly ErasureFenceRecordV1[]; readonly now?: string }): Promise<V2RestoreReceiptV1>`
  - `export class V2RollbackService` with `.verifyRollbackCompatibility(input: { readonly v2VaultRoot: string; readonly targetBuildIdentityHash: string }): Promise<V2RollbackReportV1>`

- [ ] **Step 1: Write the failing test in `tests/v2-recovery-backup-restore.test.ts`**

Cover:
1. `V2BackupService.createBackup` acquires a `MaintenanceFence` exclusive lease, creates a WAL-free SQLite snapshot via `VACUUM INTO`, verifies `PRAGMA integrity_check`, writes `backup-manifest.json` with SHA-256 digests, records the receipt in `custody-recovery.sqlite`, and rejects backup paths overlapping `projectRoot`, `v2VaultRoot`, or `v1ArchiveRoot`.
2. `V2BackupService.inspectHealth` and `V2BackupScheduler` report healthy immediately after backup, report `backupOverdue: true` (`healthy: false`) when new events are committed and `now` exceeds `maxActiveBackupAgeMs` (1 hour), and trigger a backup on `onOrderlyShutdown` when new events exist.
3. `V2RestoreService.restoreToIsolatedVault`:
   - Restores a verified backup into an isolated empty directory, replays post-backup events + retained evidence up to `requiredRecoveryFence`, and verifies `EventIntegrityService` + `ProjectionIntegrityService`.
   - Applies post-backup `EvidenceErased` events and `extraErasureFences` **before** rebuilding Projection Schema 3 so an erased note/evidence item present in the older backup is scrubbed and undecryptable before reads resume (`erasedEvidenceIdsApplied` non-empty, `get-full-note` returns `found: false`, `openEvidenceItem` throws `RETAINED_EVIDENCE_ERASED`).
   - When `requiredRecoveryFence` exceeds the available replayed events, returns `status: "incomplete-fence"` with exact `missingRange` (`fromExclusivePosition`, `toInclusivePosition`, `expectedHash`) and leaves the restored store in `read-only-recovery` mode (mutations denied).
   - Rejects a tampered backup file digest with `FRESH_START_RECOVERY_CORRUPT`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -p tsconfig.test.json && node --test dist-test/tests/v2-recovery-backup-restore.test.js`
Expected: FAIL with module not found (`src/orchestrator/recovery/backup.service.js`).

- [ ] **Step 3: Implement `src/orchestrator/recovery/contracts.ts`, `src/orchestrator/recovery/backup.service.ts`, and `src/orchestrator/recovery/restore.service.ts`**

- Implement fenced `VACUUM INTO` backup creation, SHA-256 manifest signing, backup health evaluation, isolated restore with post-backup event/evidence replay, pre-read erasure fence enforcement + Projection Schema 3 rebuild, missing-range reporting, and software rollback verification.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsc -p tsconfig.test.json && node --test dist-test/tests/v2-recovery-backup-restore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/recovery/contracts.ts src/orchestrator/recovery/backup.service.ts src/orchestrator/recovery/restore.service.ts tests/v2-recovery-backup-restore.test.ts
git commit -m "feat(v2): implement fenced backup, isolated restore, replay, and erasure-after-restore"
```

---

### Task 5: Operator Approval & Evidence Verifiers in `src/v2/admin.ts`, V1 Archive Freeze, Client Config Generator & 8-Scenario Compiled Release Verifier (`scripts/run-v2-fresh-start-release.js`, F3.3 & F4.1)

**Files:**
- Modify: `src/orchestrator/fresh-start/operator-approval.ts`
- Modify: `src/v2/admin.ts`
- Create: `scripts/run-v2-fresh-start-release.js`
- Create: `docs/operations/v2-fresh-start-runbook.md`
- Modify: `package.json`
- Test: `tests/v2-admin-cutover-and-release-gate.test.ts`

**Interfaces:**
- Consumes:
  - `TrustedOperatorApprovalVerifier`, `TrustedFreshStartEvidenceVerifier`, `freshStartRequestDigest` from `src/orchestrator/fresh-start/operator-approval.ts`
  - `V2BackupService`, `V2RestoreService` from `src/orchestrator/recovery/`
  - `V2_PRODUCTION_CAPABILITIES`, `V2_PRODUCTION_RECOVERY_POLICY` from `src/v2/config.ts`
- Produces:
  - `export function createSignedOperatorApprovalEnvelope(input)` and `export function createHmacOperatorApprovalVerifier(secret: string | Uint8Array): OperatorApprovalVerifier` in `src/orchestrator/fresh-start/operator-approval.ts`
  - `export function createReleaseEvidenceReportVerifier(expectedReport: unknown): FreshStartEvidenceVerifier` in `src/orchestrator/fresh-start/operator-approval.ts`
  - Extended `runV2Admin(argv)` in `src/v2/admin.ts` supporting `initialize-fresh`, `resume-initialization`, `status`, `sign-approval`, `activate`, `enter-recovery`, `exit-recovery`, `disable`, `backup`, `restore`, `verify-recovery`, `rebuild-projections`, `freeze-v1-archive`, `verify-v1-archive`, `generate-client-configs`
  - `scripts/run-v2-fresh-start-release.js` (`npm run verify:v2-fresh-start-release`) executing all 8 compiled public-service scenarios against `dist/v2.js` and `dist/v2-admin.js`

- [ ] **Step 1: Write the failing test in `tests/v2-admin-cutover-and-release-gate.test.ts`**

Cover:
1. `createSignedOperatorApprovalEnvelope` and `createHmacOperatorApprovalVerifier` verify valid HMAC-SHA256 operator approvals and reject wrong secrets, expired TTLs, tampered `requestDigest`s, and replayed `approvalId`/`nonceDigest` values in `FreshStartControlPlane`.
2. `v2-admin.js` subcommands `freeze-v1-archive` and `verify-v1-archive` write a cryptographic archive manifest, mark archive files read-only, verify the denied-write probe, and detect any tampered archive file.
3. `v2-admin.js generate-client-configs` outputs valid V2 client configurations for Codex, OpenCode, Antigravity, Cursor, Zed, Windsurf, and Claude Code pointing to `dist/v2.js` with explicit canonical absolute paths (`loadV2LaunchConfig` accepts every generated env block).
4. `node scripts/run-v2-fresh-start-release.js` runs all 8 compiled public-service scenarios against `dist/v2.js` and `dist/v2-admin.js` on isolated temporary directories, exits `0`, and emits a verified release evidence JSON receipt with `productionReady: true` and all 8 scenarios passing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -p tsconfig.test.json && node --test dist-test/tests/v2-admin-cutover-and-release-gate.test.js`
Expected: FAIL with missing exports/commands.

- [ ] **Step 3: Implement `operator-approval.ts` helpers, `src/v2/admin.ts` operator commands, `scripts/run-v2-fresh-start-release.js`, and `docs/operations/v2-fresh-start-runbook.md`**

- Preserve `v2-admin.js` foundation behavior when invoked without `--operator-approval` / `--release-evidence` or with the foundation manifest (`activate` still fails with `FRESH_START_RELEASE_NOT_READY`).
- Implement `scripts/run-v2-fresh-start-release.js` running all 8 scenarios against compiled `dist/v2.js` and `dist/v2-admin.js` and add `"verify:v2-fresh-start-release": "node scripts/run-v2-fresh-start-release.js"` to `package.json` (keeping `"test:build-artifacts"` and `"test:v2-fresh-start-foundation"` unchanged).
- Author `docs/operations/v2-fresh-start-runbook.md` documenting preparation, backup/restore, recovery, rollback, V1 archive protection, and client cutover commands.

- [ ] **Step 4: Build `dist/`, run `v2-admin-cutover-and-release-gate.test.ts`, `verify:v2-fresh-start-release`, `test:v2-fresh-start-foundation`, and `test:build-artifacts`**

Run: `npm run build && npx tsc -p tsconfig.test.json && node --test dist-test/tests/v2-admin-cutover-and-release-gate.test.js && npm run verify:v2-fresh-start-release && npm run test:v2-fresh-start-foundation && npm run test:build-artifacts`
Expected: PASS on all commands.

- [ ] **Step 5: Publish release qualification evidence (`docs/evidence/v2-fresh-start-release.md`) and commit**

```bash
git add src/orchestrator/fresh-start/operator-approval.ts src/v2/admin.ts scripts/run-v2-fresh-start-release.js docs/operations/v2-fresh-start-runbook.md docs/evidence/v2-fresh-start-release.md package.json tests/v2-admin-cutover-and-release-gate.test.ts
git commit -m "feat(v2): complete operator admin cutover, release verifier, and operations runbook"
```
