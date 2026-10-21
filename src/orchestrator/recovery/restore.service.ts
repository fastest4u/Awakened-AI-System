import { createCipheriv, createDecipheriv, createHash, createHmac, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, hostname, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FreshStartError, decodeFreshStartRelease } from "../fresh-start/contracts.js";
import { bindFreshStartAdmissionContext } from "../fresh-start/fresh-start-admission.js";
import {
  assertFreshStartDisjoint,
  assertFreshStartOwnedDirectory,
  assertFreshStartPaths,
  canonicalFreshStartPath,
} from "../fresh-start/fresh-start-paths.js";
import { SqliteFreshStartRepository } from "../fresh-start/fresh-start.repository.js";
import {
  GovernedLifecycleError,
  GovernedLifecycleService,
} from "../governance/governance.service.js";
import type { BranchScopeId, ProjectContext } from "../identity/contracts.js";
import { computeProjectContextFingerprint } from "../identity/project-binding.service.js";
import {
  GitWorkspaceResolver,
  SpawnSyncGitCommandRunner,
} from "../identity/git-workspace.resolver.js";
import { ProjectDescriptorRepository } from "../identity/project-descriptor.repository.js";
import { ProjectStoreRouter } from "../identity/project-store.router.js";
import { StoreManifestRepository } from "../identity/store-manifest.repository.js";
import { EventIntegrityService } from "../integrity/event-integrity.service.js";
import {
  OperationalKeyCustodyProvider,
  type ErasureFenceRecordV1,
} from "../keys/operational-key-custody.js";
import { ImmutableProjectionBuilder } from "../projections/builder.js";
import type { ProjectBinding } from "../projections/contracts.js";
import { V2ProjectionBuildCoordinator } from "../projections/coordinator.js";
import { SqliteProjectionEventReader } from "../projections/event-reader.js";
import { ProjectionIntegrityService } from "../projections/integrity.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-chain-constants.js";
import { PROJECT_STORE_MIGRATIONS } from "../storage/migrations/registry.js";
import { NodeSqliteDriver } from "../storage/node-sqlite-driver.js";
import {
  expectedSchemaFingerprint,
  schemaFingerprint,
} from "../storage/schema-fingerprint.js";
import {
  computeBackupManifestDigest,
  resolveVaultStoreInfo,
} from "./backup.service.js";
import type {
  RestoreVerificationReceipt,
  RollbackCompatibilityReceipt,
  V2BackupManifestV1,
} from "./contracts.js";

const LOCAL_CUSTODY_DOMAIN = "project-memory/v2-operational-local-custody/v1\n";

function sha256File(filePath: string): string {
  const bytes = readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function deriveLocalCustodyMasterKey(
  storeRoot: string,
  projectId: string,
  storeId: string,
): Buffer {
  let username = "local-operator";
  try {
    username = userInfo().username || username;
  } catch {
    // Fallback when OS user lookup is restricted
  }
  const canonicalStoreRoot = (() => {
    try {
      return canonicalFreshStartPath(storeRoot);
    } catch {
      return resolve(storeRoot);
    }
  })();

  return createHash("sha256")
    .update(LOCAL_CUSTODY_DOMAIN, "utf8")
    .update(`${platform()}\0${arch()}\0${hostname()}\0${username}\0`, "utf8")
    .update(`${canonicalStoreRoot}\0${projectId}\0${storeId}`, "utf8")
    .digest();
}

function tryUnwrapKek(
  masterKey: Buffer,
  projectId: string,
  storeId: string,
  family: string,
  purpose: string,
  keyId: string,
  version: string,
  secretMaterialB64: string,
): Buffer | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(secretMaterialB64, "base64url").toString("utf8"),
    ) as { nonce: string; ciphertext: string; tag: string };
    const aad = Buffer.from(
      `${projectId}\0${storeId}\0${family}\0${purpose}\0${keyId}\0${version}`,
      "utf8",
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      masterKey,
      Buffer.from(parsed.nonce, "base64url"),
      { authTagLength: 16 },
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
}

function wrapKek(
  masterKey: Buffer,
  projectId: string,
  storeId: string,
  family: string,
  purpose: string,
  keyId: string,
  version: string,
  rawKek: Buffer,
): string {
  const aad = Buffer.from(
    `${projectId}\0${storeId}\0${family}\0${purpose}\0${keyId}\0${version}`,
    "utf8",
  );
  const nonce = createHmac("sha256", masterKey)
    .update("kek-nonce\0", "utf8")
    .update(aad)
    .digest()
    .subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(rawKek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(
    canonicalJson({
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: tag.toString("base64url"),
    }),
    "utf8",
  ).toString("base64url");
}

function migrateCustodyDatabaseToTargetStore(params: {
  readonly sourceCustodyDbPath: string;
  readonly sourceStoreRoot: string;
  readonly targetCustodyDbPath: string;
  readonly targetStoreRoot: string;
  readonly projectId: string;
  readonly storeId: string;
}): void {
  if (!existsSync(params.sourceCustodyDbPath)) {
    return;
  }
  const sourceMasterKey = deriveLocalCustodyMasterKey(
    params.sourceStoreRoot,
    params.projectId,
    params.storeId,
  );
  const targetMasterKey = deriveLocalCustodyMasterKey(
    params.targetStoreRoot,
    params.projectId,
    params.storeId,
  );

  const srcDb = new DatabaseSync(params.sourceCustodyDbPath, { open: true });
  const dstDb = new DatabaseSync(params.targetCustodyDbPath, { open: true });
  try {
    const keyRows = srcDb
      .prepare(
        `SELECT project_id, store_id, family, purpose, key_id, version,
                is_current, status, secret_material_b64, created_at, retired_at
         FROM key_versions
         WHERE project_id = ? AND store_id = ?`,
      )
      .all(params.projectId, params.storeId) as Array<{
      project_id: string;
      store_id: string;
      family: string;
      purpose: string;
      key_id: string;
      version: string;
      is_current: number | bigint;
      status: string;
      secret_material_b64: string | null;
      created_at: string;
      retired_at: string | null;
    }>;

    dstDb.exec("BEGIN IMMEDIATE");
    try {
      for (const row of keyRows) {
        let rewrappedSecret = row.secret_material_b64;
        if (typeof row.secret_material_b64 === "string") {
          const alreadyValidForTarget = tryUnwrapKek(
            targetMasterKey,
            row.project_id,
            row.store_id,
            row.family,
            row.purpose,
            row.key_id,
            row.version,
            row.secret_material_b64,
          );
          if (alreadyValidForTarget) {
            alreadyValidForTarget.fill(0);
          } else {
            const rawKek = tryUnwrapKek(
              sourceMasterKey,
              row.project_id,
              row.store_id,
              row.family,
              row.purpose,
              row.key_id,
              row.version,
              row.secret_material_b64,
            );
            if (rawKek) {
              try {
                rewrappedSecret = wrapKek(
                  targetMasterKey,
                  row.project_id,
                  row.store_id,
                  row.family,
                  row.purpose,
                  row.key_id,
                  row.version,
                  rawKek,
                );
              } finally {
                rawKek.fill(0);
              }
            }
          }
        }

        if (Number(row.is_current) === 1) {
          dstDb
            .prepare(
              `UPDATE key_versions
               SET is_current = 0
               WHERE project_id = ? AND store_id = ? AND family = ? AND purpose = ? AND version <> ?`,
            )
            .run(row.project_id, row.store_id, row.family, row.purpose, row.version);
        }

        dstDb
          .prepare(
            `INSERT INTO key_versions (
               project_id, store_id, family, purpose, key_id, version,
               is_current, status, secret_material_b64, created_at, retired_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id, store_id, family, purpose, version) DO UPDATE SET
               key_id = excluded.key_id,
               is_current = excluded.is_current,
               status = excluded.status,
               secret_material_b64 = excluded.secret_material_b64,
               created_at = excluded.created_at,
               retired_at = excluded.retired_at`,
          )
          .run(
            row.project_id,
            row.store_id,
            row.family,
            row.purpose,
            row.key_id,
            row.version,
            Number(row.is_current),
            row.status,
            rewrappedSecret,
            row.created_at,
            row.retired_at,
          );
      }

      const envelopeRows = srcDb
        .prepare(
          `SELECT project_id, store_id, original_wrap_hash, evidence_id,
                  aad_sha256, aad_b64, active_wrap_version, wrapped_data_key_json, status, updated_at
           FROM evidence_key_envelopes
           WHERE project_id = ? AND store_id = ?`,
        )
        .all(params.projectId, params.storeId) as Array<{
        project_id: string;
        store_id: string;
        original_wrap_hash: string;
        evidence_id: string;
        aad_sha256: string;
        aad_b64: string;
        active_wrap_version: string;
        wrapped_data_key_json: string | null;
        status: string;
        updated_at: string;
      }>;

      for (const envRow of envelopeRows) {
        dstDb
          .prepare(
            `INSERT INTO evidence_key_envelopes (
               project_id, store_id, original_wrap_hash, evidence_id,
               aad_sha256, aad_b64, active_wrap_version, wrapped_data_key_json, status, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id, store_id, original_wrap_hash) DO UPDATE SET
               active_wrap_version = excluded.active_wrap_version,
               wrapped_data_key_json = CASE
                 WHEN evidence_key_envelopes.status = 'erased' OR excluded.status = 'erased' THEN NULL
                 ELSE excluded.wrapped_data_key_json
               END,
               status = CASE
                 WHEN evidence_key_envelopes.status = 'erased' OR excluded.status = 'erased' THEN 'erased'
                 ELSE excluded.status
               END,
               updated_at = excluded.updated_at`,
          )
          .run(
            envRow.project_id,
            envRow.store_id,
            envRow.original_wrap_hash,
            envRow.evidence_id,
            envRow.aad_sha256,
            envRow.aad_b64,
            envRow.active_wrap_version,
            envRow.wrapped_data_key_json,
            envRow.status,
            envRow.updated_at,
          );
      }

      dstDb.exec("COMMIT");
    } catch (error) {
      try {
        dstDb.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure
      }
      throw error;
    }
  } finally {
    sourceMasterKey.fill(0);
    targetMasterKey.fill(0);
    srcDb.close();
    dstDb.close();
  }
}

function replayPostBackupEvents(params: {
  readonly targetEventsPath: string;
  readonly sourceEventsPath: string;
  readonly projectId: string;
  readonly backupTerminalPosition: bigint;
  readonly backupTerminalHash: string;
  readonly maxReplayPosition: bigint | null;
}): number {
  const srcDb = new DatabaseSync(params.sourceEventsPath, { open: true });
  try {
    if (params.backupTerminalPosition > 0n) {
      const anchor = srcDb
        .prepare(
          `SELECT event_hash FROM events
           WHERE project_id = ? AND global_position = ?`,
        )
        .get(params.projectId, params.backupTerminalPosition) as
        | { event_hash?: string }
        | undefined;
      if (!anchor || anchor.event_hash !== params.backupTerminalHash) {
        throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
      }
    }

    const tailRow = srcDb
      .prepare(
        `SELECT COALESCE(MAX(global_position), 0) AS max_pos
         FROM events
         WHERE project_id = ?`,
      )
      .get(params.projectId) as { max_pos?: bigint | number } | undefined;
    const srcTailPos = BigInt(tailRow?.max_pos ?? 0);
    const effectiveMaxPos =
      params.maxReplayPosition !== null && params.maxReplayPosition < srcTailPos
        ? params.maxReplayPosition
        : srcTailPos;

    if (effectiveMaxPos <= params.backupTerminalPosition) {
      return 0;
    }

    const countRow = srcDb
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM events
         WHERE project_id = ? AND global_position > ? AND global_position <= ?`,
      )
      .get(params.projectId, params.backupTerminalPosition, effectiveMaxPos) as
      | { cnt?: bigint | number }
      | undefined;
    const replayedEventsCount = Number(countRow?.cnt ?? 0);
    if (replayedEventsCount === 0) {
      return 0;
    }

    const dstDb = new DatabaseSync(params.targetEventsPath, { open: true });
    try {
      const escapedSrc = params.sourceEventsPath.replace(/'/g, "''");
      dstDb.exec(`ATTACH DATABASE '${escapedSrc}' AS src`);
      dstDb.exec("BEGIN IMMEDIATE");
      try {
        // 1. Copy missing branch_scopes
        dstDb
          .prepare(
            `INSERT OR IGNORE INTO main.branch_scopes
             SELECT * FROM src.branch_scopes WHERE project_id = ?`,
          )
          .run(params.projectId);

        // 2. Upsert streams up to effectiveMaxPos
        const streamRows = dstDb
          .prepare(
            `SELECT s.project_id, s.stream_id, s.stream_type,
                    MAX(e.stream_version) AS max_version,
                    MIN(s.created_at) AS created_at,
                    MAX(e.recorded_at) AS updated_at
             FROM src.streams s
             JOIN src.events e
               ON e.project_id = s.project_id AND e.stream_id = s.stream_id
             WHERE s.project_id = ? AND e.global_position <= ?
             GROUP BY s.project_id, s.stream_id, s.stream_type`,
          )
          .all(params.projectId, effectiveMaxPos) as Array<{
          project_id: string;
          stream_id: string;
          stream_type: string;
          max_version: bigint | number;
          created_at: string;
          updated_at: string;
        }>;

        for (const st of streamRows) {
          dstDb
            .prepare(
              `INSERT INTO main.streams (
                 project_id, stream_id, stream_type, current_version, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(project_id, stream_id) DO UPDATE SET
                 current_version = excluded.current_version,
                 updated_at = excluded.updated_at`,
            )
            .run(
              st.project_id,
              st.stream_id,
              st.stream_type,
              BigInt(st.max_version),
              st.created_at,
              st.updated_at,
            );
        }

        // 3. Replay events, command_dedup, and retained_evidence tables in global_position order
        const postEvents = dstDb
          .prepare(
            `SELECT global_position, event_id, event_type, command_id
             FROM src.events
             WHERE project_id = ? AND global_position > ? AND global_position <= ?
             ORDER BY global_position ASC`,
          )
          .all(params.projectId, params.backupTerminalPosition, effectiveMaxPos) as Array<{
          global_position: bigint | number;
          event_id: string;
          event_type: string;
          command_id: string;
        }>;

        for (const ev of postEvents) {
          const pos = BigInt(ev.global_position);
          dstDb
            .prepare(
              `INSERT INTO main.events
               SELECT * FROM src.events WHERE project_id = ? AND global_position = ?`,
            )
            .run(params.projectId, pos);

          dstDb
            .prepare(
              `INSERT OR IGNORE INTO main.command_dedup
               SELECT * FROM src.command_dedup
               WHERE project_id = ?
                 AND last_global_position = ?
                 AND first_global_position > ?
                 AND last_global_position <= ?`,
            )
            .run(params.projectId, pos, params.backupTerminalPosition, effectiveMaxPos);

          if (ev.event_type === "EvidenceBatchRetained") {
            dstDb
              .prepare(
                `INSERT INTO main.retained_evidence_command_authorizations
                 SELECT * FROM src.retained_evidence_command_authorizations
                 WHERE project_id = ? AND event_id = ?`,
              )
              .run(params.projectId, ev.event_id);

            dstDb
              .prepare(
                `INSERT INTO main.retained_evidence_blobs
                 SELECT * FROM src.retained_evidence_blobs
                 WHERE project_id = ? AND event_id = ?
                 ORDER BY item_index ASC`,
              )
              .run(params.projectId, ev.event_id);

            const lastBlob = dstDb
              .prepare(
                `SELECT target_session_id, conversation_id, frame_id, ordinal
                 FROM main.retained_evidence_blobs
                 WHERE project_id = ? AND event_id = ?
                 ORDER BY item_index DESC
                 LIMIT 1`,
              )
              .get(params.projectId, ev.event_id) as
              | {
                  target_session_id: string;
                  conversation_id: string;
                  frame_id: string;
                  ordinal: bigint | number;
                }
              | undefined;

            if (lastBlob) {
              const existingHead = dstDb
                .prepare(
                  `SELECT version FROM main.retained_evidence_stream_heads
                   WHERE project_id = ? AND target_session_id = ? AND conversation_id = ?`,
                )
                .get(
                  params.projectId,
                  lastBlob.target_session_id,
                  lastBlob.conversation_id,
                ) as { version?: bigint | number } | undefined;

              if (!existingHead) {
                dstDb
                  .prepare(
                    `INSERT INTO main.retained_evidence_stream_heads (
                       project_id, target_session_id, conversation_id,
                       last_frame_id, last_ordinal, version
                     ) VALUES (?, ?, ?, ?, ?, 1)`,
                  )
                  .run(
                    params.projectId,
                    lastBlob.target_session_id,
                    lastBlob.conversation_id,
                    lastBlob.frame_id,
                    BigInt(lastBlob.ordinal),
                  );
              } else {
                dstDb
                  .prepare(
                    `UPDATE main.retained_evidence_stream_heads
                     SET last_frame_id = ?,
                         last_ordinal = ?,
                         version = ?
                     WHERE project_id = ? AND target_session_id = ? AND conversation_id = ?`,
                  )
                  .run(
                    lastBlob.frame_id,
                    BigInt(lastBlob.ordinal),
                    BigInt(existingHead.version ?? 1) + 1n,
                    params.projectId,
                    lastBlob.target_session_id,
                    lastBlob.conversation_id,
                  );
              }
            }
          }
        }

        // 4. Copy post-backup outbox rows up to effectiveMaxPos
        dstDb
          .prepare(
            `INSERT OR IGNORE INTO main.outbox
             SELECT * FROM src.outbox
             WHERE project_id = ? AND event_position > ? AND event_position <= ?`,
          )
          .run(params.projectId, params.backupTerminalPosition, effectiveMaxPos);

        // 5. Sync session lifecycle state when replaying up to tail
        if (effectiveMaxPos >= srcTailPos) {
          dstDb
            .prepare(
              `INSERT OR REPLACE INTO main.session_authority
               SELECT * FROM src.session_authority WHERE project_id = ?`,
            )
            .run(params.projectId);
          dstDb
            .prepare(
              `INSERT OR REPLACE INTO main.session_leases
               SELECT * FROM src.session_leases WHERE project_id = ?`,
            )
            .run(params.projectId);
          dstDb
            .prepare(
              `INSERT OR REPLACE INTO main.session_evidence_coverage
               SELECT * FROM src.session_evidence_coverage WHERE project_id = ?`,
            )
            .run(params.projectId);
          dstDb
            .prepare(
              `INSERT OR REPLACE INTO main.session_evidence_fingerprints
               SELECT * FROM src.session_evidence_fingerprints WHERE project_id = ?`,
            )
            .run(params.projectId);
        }

        dstDb.exec("COMMIT");
      } catch (error) {
        try {
          dstDb.exec("ROLLBACK");
        } catch {
          // Ignore rollback failure
        }
        throw error;
      } finally {
        try {
          dstDb.exec("DETACH DATABASE src");
        } catch {
          // Ignore detach failure
        }
      }
    } finally {
      dstDb.close();
    }

    return replayedEventsCount;
  } finally {
    srcDb.close();
  }
}

function readVerifiedBackupManifest(backupDir: string): {
  readonly manifest: V2BackupManifestV1;
  readonly backupEventsPath: string;
  readonly backupReleasePath: string;
  readonly backupDescriptorPath: string;
  readonly backupStoreManifestPath: string;
  readonly backupErasureFencesPath: string;
  readonly backupErasureFences: readonly ErasureFenceRecordV1[];
} {
  const manifestPath = join(backupDir, "backup-manifest.json");
  const backupEventsPath = join(backupDir, "events.sqlite");
  const backupReleasePath = join(backupDir, "fresh-start-release.json");
  const backupDescriptorPath = join(backupDir, "project-identity.json");
  const backupStoreManifestPath = join(backupDir, "store-manifest.json");
  const backupErasureFencesPath = join(backupDir, "erasure-fences.json");

  if (
    !existsSync(manifestPath)
    || !existsSync(backupEventsPath)
    || !existsSync(backupReleasePath)
    || !existsSync(backupDescriptorPath)
    || !existsSync(backupStoreManifestPath)
    || !existsSync(backupErasureFencesPath)
  ) {
    throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
  }

  let parsed: V2BackupManifestV1;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as V2BackupManifestV1;
  } catch {
    throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
  }

  if (
    typeof parsed !== "object"
    || parsed === null
    || parsed.manifestVersion !== 1
    || typeof parsed.backupManifestDigest !== "string"
    || typeof parsed.files !== "object"
    || parsed.files === null
  ) {
    throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
  }

  const { backupManifestDigest, ...unsigned } = parsed;
  const expectedDigest = computeBackupManifestDigest(unsigned);
  if (expectedDigest !== backupManifestDigest) {
    throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
  }

  if (
    sha256File(backupEventsPath) !== parsed.files.eventsSqliteSha256
    || sha256File(backupReleasePath) !== parsed.files.freshStartReleaseSha256
    || sha256File(backupDescriptorPath) !== parsed.files.projectIdentitySha256
    || sha256File(backupStoreManifestPath) !== parsed.files.storeManifestSha256
    || sha256File(backupErasureFencesPath) !== parsed.files.erasureFencesSha256
  ) {
    throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
  }

  let backupErasureFences: readonly ErasureFenceRecordV1[] = [];
  try {
    const rawFences = JSON.parse(readFileSync(backupErasureFencesPath, "utf8")) as unknown;
    if (!Array.isArray(rawFences)) {
      throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
    }
    backupErasureFences = rawFences as ErasureFenceRecordV1[];
  } catch {
    throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
  }

  return {
    manifest: parsed,
    backupEventsPath,
    backupReleasePath,
    backupDescriptorPath,
    backupStoreManifestPath,
    backupErasureFencesPath,
    backupErasureFences,
  };
}

export class V2RestoreService {
  async restoreToIsolatedVault(input: {
    readonly backupDirectory: string;
    readonly targetProjectRoot: string;
    readonly targetV2VaultRoot: string;
    readonly v1ArchiveRoot: string;
    readonly postBackupSourceVaultRoot?: string;
    readonly extraErasureFences?: readonly ErasureFenceRecordV1[];
    readonly requiredRecoveryFence?: Readonly<{
      readonly position: string;
      readonly hash: string;
    }>;
    readonly now?: string;
  }): Promise<RestoreVerificationReceipt> {
    const backupDir = canonicalFreshStartPath(resolve(input.backupDirectory));

    // Verify backup manifest and file digests BEFORE creating or mutating target directories
    const verifiedBackup = readVerifiedBackupManifest(backupDir);
    const { manifest } = verifiedBackup;

    const targetProjectRootCreated = !existsSync(input.targetProjectRoot);
    if (targetProjectRootCreated) {
      mkdirSync(input.targetProjectRoot, { recursive: true });
    }

    const targetPaths = await assertFreshStartPaths({
      projectRoot: input.targetProjectRoot,
      v2VaultRoot: input.targetV2VaultRoot,
      v1ArchiveRoot: input.v1ArchiveRoot,
    });

    assertFreshStartDisjoint(backupDir, targetPaths.projectRoot);
    assertFreshStartDisjoint(backupDir, targetPaths.v2VaultRoot);
    assertFreshStartDisjoint(backupDir, targetPaths.v1ArchiveRoot);

    if (input.postBackupSourceVaultRoot) {
      const canonicalPostBackupVault = canonicalFreshStartPath(
        resolve(input.postBackupSourceVaultRoot),
      );
      assertFreshStartDisjoint(canonicalPostBackupVault, targetPaths.v2VaultRoot);
    }

    if (
      existsSync(targetPaths.v2VaultRoot)
      && readdirSync(targetPaths.v2VaultRoot).length > 0
    ) {
      throw new FreshStartError("FRESH_START_DESTINATION_NOT_EMPTY");
    }

    const nowIso = input.now ?? new Date().toISOString();
    const adminDir = join(targetPaths.v2VaultRoot, ".memory-mcp");
    mkdirSync(adminDir, { recursive: true });

    try {
      const targetDescriptorPath = join(adminDir, "project-identity.json");
      copyFileSync(verifiedBackup.backupDescriptorPath, targetDescriptorPath);

      const inspectedDescriptor = new ProjectDescriptorRepository().inspect(
        targetPaths.v2VaultRoot,
      );
      if (inspectedDescriptor.status !== "valid") {
        throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
      }

      const workspace = new GitWorkspaceResolver(new SpawnSyncGitCommandRunner()).inspect(
        targetPaths.projectRoot,
        inspectedDescriptor.descriptor,
      );
      const targetRoute = new ProjectStoreRouter().route(
        inspectedDescriptor.descriptor,
        targetPaths.v2VaultRoot,
        workspace,
      );
      assertFreshStartOwnedDirectory(targetRoute.storeRoot, targetPaths.v1ArchiveRoot);

      if (existsSync(targetRoute.storeRoot) && readdirSync(targetRoute.storeRoot).length > 0) {
        throw new FreshStartError("FRESH_START_DESTINATION_NOT_EMPTY");
      }
      mkdirSync(targetRoute.storeRoot, { recursive: true });

      copyFileSync(verifiedBackup.backupStoreManifestPath, targetRoute.storeManifestPath);
      copyFileSync(verifiedBackup.backupEventsPath, targetRoute.eventsPath);

      const inspectedManifest = new StoreManifestRepository().inspect(targetRoute, {
        projectId: inspectedDescriptor.descriptor.projectId,
        vaultId: inspectedDescriptor.descriptor.vaultId,
      });
      if (inspectedManifest.status !== "valid") {
        throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
      }

      const identity = {
        projectId: manifest.projectId as typeof inspectedDescriptor.descriptor.projectId,
        vaultId: manifest.vaultId as typeof inspectedDescriptor.descriptor.vaultId,
        storeId: manifest.storeId as typeof inspectedManifest.manifest.storeId,
      };

      // Restore genesis projection and fresh-start-init.json updated for isolated target paths
      const backupGenesisProjPath = join(
        backupDir,
        "fresh-start-projection",
        "projections-3-1.sqlite",
      );
      if (existsSync(backupGenesisProjPath)) {
        const targetGenesisProjDir = join(targetRoute.storeRoot, "fresh-start-projection");
        mkdirSync(targetGenesisProjDir, { recursive: true });
        copyFileSync(
          backupGenesisProjPath,
          join(targetGenesisProjDir, "projections-3-1.sqlite"),
        );
      }

      const newConfigurationHash = sha256CanonicalJson({
        projectRoot: targetPaths.projectRoot,
        v2VaultRoot: targetPaths.v2VaultRoot,
        v1ArchiveRoot: targetPaths.v1ArchiveRoot,
        releaseId: manifest.releaseId,
      });

      let sourceStoreRootFromJournal = backupDir;
      const backupInitJournalPath = join(backupDir, "fresh-start-init.json");
      if (existsSync(backupInitJournalPath)) {
        const journal = JSON.parse(readFileSync(backupInitJournalPath, "utf8")) as Record<
          string,
          unknown
        >;
        if (typeof journal.storeRoot === "string" && journal.storeRoot.length > 0) {
          sourceStoreRootFromJournal = journal.storeRoot;
        }
        const updatedRelease = {
          ...(journal.release as Record<string, unknown>),
          configurationHash: newConfigurationHash,
        };
        const updatedJournal = {
          ...journal,
          paths: targetPaths,
          storeRoot: targetRoute.storeRoot,
          release: updatedRelease,
        };
        writeFileSync(
          join(adminDir, "fresh-start-init.json"),
          `${JSON.stringify(updatedJournal)}\n`,
          "utf8",
        );
      } else {
        const backedUpRelease = decodeFreshStartRelease(
          JSON.parse(readFileSync(verifiedBackup.backupReleasePath, "utf8")),
        );
        writeFileSync(
          join(adminDir, "fresh-start-init.json"),
          `${JSON.stringify({
            version: 2,
            projectionSchemaVersion: 3,
            phase: "receipt-published",
            paths: targetPaths,
            storeRoot: targetRoute.storeRoot,
            identity,
            release: {
              ...backedUpRelease,
              configurationHash: newConfigurationHash,
            },
          })}\n`,
          "utf8",
        );
      }

      // Update configuration_hash in fresh_start_releases for isolated target launch config
      const rawEventsDb = new DatabaseSync(targetRoute.eventsPath, { open: true });
      try {
        rawEventsDb.exec("BEGIN IMMEDIATE");
        rawEventsDb.exec("DROP TRIGGER IF EXISTS fresh_start_releases_no_update");
        rawEventsDb
          .prepare(
            `UPDATE fresh_start_releases
             SET configuration_hash = ?
             WHERE project_id = ? AND release_id = ?`,
          )
          .run(newConfigurationHash, identity.projectId, manifest.releaseId);
        rawEventsDb.exec(
          `CREATE TRIGGER fresh_start_releases_no_update BEFORE UPDATE ON fresh_start_releases BEGIN SELECT RAISE(ABORT, 'FRESH_START_IMMUTABLE'); END;`,
        );
        rawEventsDb.exec("COMMIT");
      } finally {
        rawEventsDb.close();
      }

      // Initialize target custody DB and migrate key_versions + envelopes from backup and post-backup source
      const initCustody = new OperationalKeyCustodyProvider({
        storeRoot: targetRoute.storeRoot,
        projectId: identity.projectId,
        storeId: identity.storeId,
        paths: targetPaths,
      });
      initCustody.close();

      const targetCustodyDbPath = join(targetRoute.storeRoot, "custody-recovery.sqlite");
      const backupCustodyDbPath = join(backupDir, "custody-recovery.sqlite");
      migrateCustodyDatabaseToTargetStore({
        sourceCustodyDbPath: backupCustodyDbPath,
        sourceStoreRoot: sourceStoreRootFromJournal,
        targetCustodyDbPath,
        targetStoreRoot: targetRoute.storeRoot,
        projectId: identity.projectId,
        storeId: identity.storeId,
      });

      // Replay post-backup events if postBackupSourceVaultRoot is provided
      let replayedEventsCount = 0;
      let postBackupFences: readonly ErasureFenceRecordV1[] = [];
      if (input.postBackupSourceVaultRoot) {
        const postBackupInfo = resolveVaultStoreInfo(input.postBackupSourceVaultRoot);
        if (
          postBackupInfo.projectId !== identity.projectId
          || postBackupInfo.storeId !== identity.storeId
        ) {
          throw new FreshStartError("FRESH_START_IDENTITY_MISMATCH");
        }

        migrateCustodyDatabaseToTargetStore({
          sourceCustodyDbPath: join(postBackupInfo.storeRoot, "custody-recovery.sqlite"),
          sourceStoreRoot: postBackupInfo.storeRoot,
          targetCustodyDbPath,
          targetStoreRoot: targetRoute.storeRoot,
          projectId: identity.projectId,
          storeId: identity.storeId,
        });

        const postCustody = new OperationalKeyCustodyProvider({
          storeRoot: postBackupInfo.storeRoot,
          projectId: postBackupInfo.projectId,
          storeId: postBackupInfo.storeId,
        });
        try {
          postBackupFences = postCustody.listErasureFences();
        } finally {
          postCustody.close();
        }

        const maxReplayPosition = input.requiredRecoveryFence
          ? BigInt(input.requiredRecoveryFence.position)
          : null;
        replayedEventsCount = replayPostBackupEvents({
          targetEventsPath: targetRoute.eventsPath,
          sourceEventsPath: postBackupInfo.eventsPath,
          projectId: identity.projectId,
          backupTerminalPosition: BigInt(manifest.terminalGlobalPosition),
          backupTerminalHash: manifest.terminalGlobalHash,
          maxReplayPosition,
        });
      }

      // Open restored events.sqlite and OperationalKeyCustodyProvider to enforce erasure fences BEFORE projection build
      const driver = new NodeSqliteDriver({ DatabaseSync });
      const connection = driver.open(targetRoute.eventsPath, {
        mode: "existing",
        busyTimeoutMs: 5_000,
      });

      const custody = new OperationalKeyCustodyProvider({
        storeRoot: targetRoute.storeRoot,
        projectId: identity.projectId,
        storeId: identity.storeId,
        paths: targetPaths,
      });

      const erasedEvidenceSet = new Set<string>();
      let restoredGlobalPosition = "0";
      let restoredGlobalHash = GENESIS_GLOBAL_HASH;
      let eventIntegrityVerified = false;
      let projectionIntegrityVerified = false;
      let status: "active" | "incomplete-fence" = "active";
      let missingRange:
        | Readonly<{
            readonly fromExclusivePosition: string;
            readonly toInclusivePosition: string;
            readonly expectedHash: string;
          }>
        | undefined;

      try {
        const baseBinding = {
          projectBindingId: randomUUID(),
          generation: 1,
          source: "stdio-explicit-root" as const,
          projectId: identity.projectId,
          vaultId: identity.vaultId,
          storeId: identity.storeId,
          workspaceId: workspace.workspaceId,
          descriptorPath: targetDescriptorPath,
          vaultRoot: targetPaths.v2VaultRoot,
          projectRoot: targetPaths.projectRoot,
          workspace,
          storeRoute: targetRoute,
          clientNamespace: "restore-verifier",
          clientInstanceId: "restore-verifier-instance",
          actorRole: "primary" as const,
          establishedAt: nowIso,
          contextFingerprint: "",
        };
        const restoredProjectContext: ProjectContext = {
          workspace,
          checkedAt: nowIso,
          binding: {
            ...baseBinding,
            contextFingerprint: computeProjectContextFingerprint(baseBinding),
          },
        };

        // 1. Collect all EvidenceErased events already present in events.sqlite (from backup or post-backup replay)
        const erasedEventRows = connection
          .prepare(
            `SELECT event_id, occurred_at, payload_json
             FROM events
             WHERE project_id = $projectId AND event_type = 'EvidenceErased'
             ORDER BY global_position ASC`,
          )
          .all({ $projectId: identity.projectId }) as Array<{
          event_id: string;
          occurred_at: string;
          payload_json: string;
        }>;
        const erasedInEventLog = new Set<string>();
        for (const row of erasedEventRows) {
          const payload = JSON.parse(row.payload_json) as {
            erasedEvidenceIds?: string[];
            reason?: string;
          };
          const ids = Array.isArray(payload.erasedEvidenceIds) ? payload.erasedEvidenceIds : [];
          for (const evId of ids) {
            erasedInEventLog.add(evId);
            erasedEvidenceSet.add(evId);
            custody.recordErasureFence({
              erasureId: `${row.event_id}:${evId}`,
              projectId: identity.projectId,
              storeId: identity.storeId,
              evidenceId: evId,
              sourceEventId: row.event_id,
              erasureEventId: row.event_id,
              reason: typeof payload.reason === "string" ? payload.reason : "Restored erasure event",
              erasedAt: row.occurred_at,
            });
          }
        }

        // 2. Apply backup erasure fences, post-backup custody fences, and extraErasureFences BEFORE building Projection Schema 3
        const freshStartRepoForAdmission = new SqliteFreshStartRepository(connection);
        const { stateForAdmission, releaseForAdmission } = freshStartRepoForAdmission.transact(
          identity,
          (tx) => {
            const s = tx.state();
            if (!s) {
              throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
            }
            const r = tx.release(s.releaseId);
            if (!r) {
              throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
            }
            return { stateForAdmission: s, releaseForAdmission: r };
          },
        );
        bindFreshStartAdmissionContext(connection, {
          identity,
          releaseId: stateForAdmission.releaseId,
          measuredBuildHash: releaseForAdmission.buildIdentityHash,
          generation: stateForAdmission.generation,
        });

        const allFences: ErasureFenceRecordV1[] = [
          ...verifiedBackup.backupErasureFences,
          ...postBackupFences,
          ...(input.extraErasureFences ?? []),
        ];
        const governanceService = new GovernedLifecycleService({
          connection,
          context: restoredProjectContext,
          custody,
          now: () => nowIso,
        });

        for (const fence of allFences) {
          if (fence.projectId !== identity.projectId || fence.storeId !== identity.storeId) {
            throw new FreshStartError("FRESH_START_IDENTITY_MISMATCH");
          }
          custody.recordErasureFence({
            erasureId: fence.erasureId,
            projectId: fence.projectId,
            storeId: fence.storeId,
            evidenceId: fence.evidenceId,
            sourceEventId: fence.sourceEventId,
            erasureEventId: fence.erasureEventId,
            reason: fence.reason,
            erasedAt: fence.erasedAt,
          });
          erasedEvidenceSet.add(fence.evidenceId);

          if (!erasedInEventLog.has(fence.evidenceId)) {
            try {
              const receipt = governanceService.forgetEvidence({
                commandId: randomUUID(),
                idempotencyKey: `restore-pre-read-fence:${fence.evidenceId}`,
                evidenceIds: [fence.evidenceId],
                reason: fence.reason,
              });
              for (const id of receipt.erasedEvidenceIds) {
                erasedInEventLog.add(id);
                erasedEvidenceSet.add(id);
              }
            } catch (error) {
              if (
                !(
                  error instanceof GovernedLifecycleError
                  && error.code === "GOVERNED_RECORD_NOT_FOUND"
                )
              ) {
                throw error;
              }
            }
          }
        }

        // 3. Determine restored terminal position and hash
        const tailRow = connection
          .prepare(
            `SELECT global_position, event_hash
             FROM events
             WHERE project_id = $projectId
             ORDER BY global_position DESC
             LIMIT 1`,
          )
          .get({ $projectId: identity.projectId }) as
          | { global_position?: bigint; event_hash?: string }
          | undefined;
        if (
          tailRow
          && typeof tailRow.global_position === "bigint"
          && typeof tailRow.event_hash === "string"
        ) {
          restoredGlobalPosition = tailRow.global_position.toString();
          restoredGlobalHash = tailRow.event_hash;
        }

        // 4. Verify EventIntegrityService on the restored event store
        const integrityReport = new EventIntegrityService(
          connection,
          PROJECT_STORE_MIGRATIONS,
        ).fullCheck(restoredProjectContext);
        if (!integrityReport.ok) {
          throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
        }
        eventIntegrityVerified = true;

        // 5. Build and verify Projection Schema 3 (with all erasures folded!)
        const branchScopeRow = connection
          .prepare(
            `SELECT branch_scope_id FROM events
             WHERE project_id = $projectId AND branch_scope_id IS NOT NULL
             ORDER BY global_position DESC LIMIT 1`,
          )
          .get({ $projectId: identity.projectId }) as { branch_scope_id?: string } | undefined;

        const projectionBinding: ProjectBinding = Object.freeze({
          projectId: identity.projectId,
          vaultId: identity.vaultId,
          storeId: identity.storeId,
          workspaceId: workspace.workspaceId,
          branchScopeId: (branchScopeRow?.branch_scope_id ?? null) as BranchScopeId | null,
          branchRef: workspace.kind === "git" ? workspace.branchRef : null,
          sessionId: null,
        });

        const projectionDirectory = join(targetRoute.storeRoot, "projections");
        mkdirSync(projectionDirectory, { recursive: true });
        mkdirSync(join(targetRoute.storeRoot, "verified-read-executor"), { recursive: true });

        const eventReader = new SqliteProjectionEventReader({
          driver,
          eventStorePath: targetRoute.eventsPath,
          busyTimeoutMs: 5_000,
        });
        const builder = new ImmutableProjectionBuilder({
          driver,
          projectionDirectory,
          now: () => nowIso,
        });
        const coordinator = new V2ProjectionBuildCoordinator({
          eventReader,
          builder,
          projectionDirectory,
          schema3: {
            eventReader,
            builder,
          },
        });
        const published = await coordinator.ensurePublishedV3(
          projectionBinding,
          BigInt(restoredGlobalPosition),
          30_000,
        );
        const projIntegrity = new ProjectionIntegrityService({
          driver,
          projectionDirectory,
          eventStorePath: targetRoute.eventsPath,
        });
        const projReport = projIntegrity.verify(projectionBinding, published.manifest);
        if (projReport.status !== "passed") {
          throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
        }
        projectionIntegrityVerified = true;

        // 6. Check requiredRecoveryFence and set fresh_start_control_state mode accordingly
        const freshStartRepo = new SqliteFreshStartRepository(connection);
        const currentState = freshStartRepo.transact(identity, (tx) => {
          const s = tx.state();
          if (!s) {
            throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
          }
          return s;
        });

        if (input.requiredRecoveryFence) {
          const requiredPos = BigInt(input.requiredRecoveryFence.position);
          const actualPos = BigInt(restoredGlobalPosition);
          if (actualPos < requiredPos) {
            status = "incomplete-fence";
            missingRange = Object.freeze({
              fromExclusivePosition: restoredGlobalPosition,
              toInclusivePosition: input.requiredRecoveryFence.position,
              expectedHash: input.requiredRecoveryFence.hash,
            });
          } else if (
            actualPos === requiredPos
            && restoredGlobalHash !== input.requiredRecoveryFence.hash
          ) {
            throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
          }
        }

        if (status === "incomplete-fence") {
          if (currentState.mode !== "read-only-recovery") {
            freshStartRepo.transact(identity, (tx) =>
              tx.transition({
                expectedMode: currentState.mode,
                expectedGeneration: currentState.generation,
                expectedReleaseId: currentState.releaseId,
                nextMode: "read-only-recovery",
                nextReleaseId: currentState.releaseId,
                transitionId: randomUUID(),
                authorization: {
                  kind: "automatic-stop",
                  reasonCode: "recovery-failure",
                },
                evidenceDigest: sha256CanonicalJson({
                  reason: "incomplete-recovery-fence",
                  restoredGlobalPosition,
                  requiredRecoveryFence: input.requiredRecoveryFence,
                }),
                recoveryPosition: BigInt(restoredGlobalPosition),
                recoveryHash: restoredGlobalHash,
                recordedAt: nowIso,
              }),
            );
          }
        } else if (currentState.mode !== "active") {
          freshStartRepo.transact(identity, (tx) =>
            tx.transition({
              expectedMode: currentState.mode,
              expectedGeneration: currentState.generation,
              expectedReleaseId: currentState.releaseId,
              nextMode: "active",
              nextReleaseId: currentState.releaseId,
              transitionId: randomUUID(),
              authorization: {
                kind: "operator",
                approvalId: randomUUID(),
                nonceDigest: sha256CanonicalJson({ nonce: randomUUID() }),
                actorFingerprint: sha256CanonicalJson({ actor: "v2-restore-service" }),
                requestDigest: sha256CanonicalJson({
                  action: "restore-to-active",
                  restoredGlobalPosition,
                }),
              },
              evidenceDigest: sha256CanonicalJson({
                reason: "verified-restore-active",
                restoredGlobalPosition,
                restoredGlobalHash,
              }),
              recoveryPosition: null,
              recoveryHash: null,
              recordedAt: nowIso,
            }),
          );
        }
      } finally {
        custody.close();
        connection.close();
      }

      return Object.freeze({
        status,
        projectId: identity.projectId,
        vaultId: identity.vaultId,
        storeId: identity.storeId,
        restoredGlobalPosition,
        restoredGlobalHash,
        replayedEventsCount,
        erasedEvidenceIdsApplied: Object.freeze([...erasedEvidenceSet].sort()),
        ...(missingRange ? { missingRange } : {}),
        projectionIntegrityVerified,
        eventIntegrityVerified,
      });
    } catch (error) {
      rmSync(targetPaths.v2VaultRoot, { recursive: true, force: true });
      if (targetProjectRootCreated) {
        rmSync(targetPaths.projectRoot, { recursive: true, force: true });
      }
      throw error;
    }
  }
}

export class V2RollbackService {
  async verifyRollbackCompatibility(input: {
    readonly v2VaultRoot: string;
    readonly projectRoot?: string;
    readonly targetEventStoreSchemaVersion: number;
    readonly targetProjectionSchemaVersion: 2 | 3;
    readonly targetMigrationFingerprint?: string;
  }): Promise<RollbackCompatibilityReceipt> {
    const info = resolveVaultStoreInfo(input.v2VaultRoot, input.projectRoot);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const connection = driver.open(info.eventsPath, {
      mode: "read-only-existing",
      busyTimeoutMs: 5_000,
    });

    let currentEventStoreSchemaVersion = 0;
    let currentMigrationFingerprint = "";
    try {
      const row = connection
        .prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations`)
        .get() as { version?: bigint | number } | undefined;
      currentEventStoreSchemaVersion = Number(row?.version ?? 0);
      currentMigrationFingerprint = schemaFingerprint(connection);
    } finally {
      connection.close();
    }

    let currentProjectionSchemaVersion: 2 | 3 = 3;
    const initJournalPath = join(info.canonicalVaultRoot, ".memory-mcp", "fresh-start-init.json");
    if (existsSync(initJournalPath)) {
      try {
        const parsed = JSON.parse(readFileSync(initJournalPath, "utf8")) as {
          projectionSchemaVersion?: number;
          version?: number;
        };
        if (parsed.projectionSchemaVersion === 2 || parsed.version === 1) {
          currentProjectionSchemaVersion = 2;
        }
      } catch {
        // Default to 3
      }
    }

    const targetMigrationFingerprint =
      input.targetMigrationFingerprint ?? expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS);

    const compatible =
      currentEventStoreSchemaVersion === input.targetEventStoreSchemaVersion
      && currentProjectionSchemaVersion === input.targetProjectionSchemaVersion
      && currentMigrationFingerprint === targetMigrationFingerprint;

    return Object.freeze({
      compatible,
      currentEventStoreSchemaVersion,
      targetEventStoreSchemaVersion: input.targetEventStoreSchemaVersion,
      currentProjectionSchemaVersion,
      targetProjectionSchemaVersion: input.targetProjectionSchemaVersion,
      currentMigrationFingerprint,
      targetMigrationFingerprint,
      requiresRestoreFromPreUpgradeBackup: !compatible,
    });
  }
}
