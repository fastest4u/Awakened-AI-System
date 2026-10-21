import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { arch, hostname, platform, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FreshStartError } from "../fresh-start/contracts.js";
import {
  canonicalFreshStartPath,
  freshStartPathContains,
  type FreshStartPaths,
} from "../fresh-start/fresh-start-paths.js";
import {
  HistoricalEvidenceKeyUnavailableError,
  type HistoricalEvidenceIntegrityProviderPort,
} from "../integrity/integrity.types.js";
import {
  PENDING_AUTHORIZATION_ENCRYPTION_PURPOSE,
  type CapabilityKeyProvider,
  type CapabilityKeyPurpose,
  type CapabilityKeyRef,
  type KeyScope,
  type KeyedFingerprintInput,
  type KeyedMacInput,
  type KeyedOpenInput,
  type KeyedSealInput,
  type KeyedVerifyInput,
  type SealedValueV1,
} from "../lifecycle/authority/capability-key-provider.js";
import { RetainedEvidenceError } from "../privacy/evidence-contracts.js";
import type {
  EvidenceKeyProvider,
  EvidenceKeyPurpose,
  EvidenceKeyRefV1,
  EvidenceKeyScope,
  WrappedEvidenceKeyV1,
} from "../privacy/evidence-key-provider.js";
import {
  decodeWrappedEvidenceKey,
  retainedEvidenceWrapHash,
} from "../privacy/retained-evidence-codec.js";
import { canonicalJson } from "../serialization/canonical-json.js";

export const ALL_CAPABILITY_KEY_PURPOSES: readonly CapabilityKeyPurpose[] = Object.freeze([
  "root-session-handle",
  "root-resume-token",
  "child-session-handle",
  "child-binding-grant",
  "continuity-index",
  "evidence-fingerprint",
  "validation-output-fingerprint",
  "materialization-fingerprint",
  "recovery-approval",
  "abandonment-approval",
  PENDING_AUTHORIZATION_ENCRYPTION_PURPOSE,
]);

export const ALL_EVIDENCE_KEY_PURPOSES: readonly EvidenceKeyPurpose[] = Object.freeze([
  "data-key-wrap",
  "original-input-commitment",
  "redacted-content-fingerprint",
]);

export interface OperationalKeyCustodyOptions {
  readonly storeRoot: string;
  readonly projectId: string;
  readonly storeId: string;
  readonly paths?: FreshStartPaths;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly masterSeed?: Uint8Array;
}

export interface ErasureFenceRecordV1 {
  readonly erasureId: string;
  readonly projectId: string;
  readonly storeId: string;
  readonly evidenceId: string;
  readonly sourceEventId: string;
  readonly erasureEventId: string;
  readonly tombstoneHash: string;
  readonly reason: string;
  readonly erasedAt: string;
}

export interface BackupReceiptRecordV1 {
  readonly backupId: string;
  readonly projectId: string;
  readonly storeId: string;
  readonly releaseId: string;
  readonly backupPath: string;
  readonly terminalEventPosition: string;
  readonly terminalEventHash: string;
  readonly manifestSha256: string;
  readonly createdAt: string;
}

export interface KeyVersionInspectionRecordV1 {
  readonly family: "capability" | "evidence";
  readonly purpose: string;
  readonly keyId: string;
  readonly version: string;
  readonly isCurrent: boolean;
  readonly status: "available" | "revoked" | "unavailable";
  readonly createdAt: string;
  readonly retiredAt: string | null;
}

interface WrappedKekRecordV1 {
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

const KEYRING_B64_DOMAIN = "project-memory/v2-operational-keyring-b64/v1\n";
const KEYRING_FILE_DOMAIN = "project-memory/v2-operational-keyring-file/v1\n";
const LOCAL_CUSTODY_DOMAIN = "project-memory/v2-operational-local-custody/v1\n";
const PURPOSE_KEK_DOMAIN = "project-memory/v2-operational-purpose-kek/v1\0";
const HISTORICAL_COVERAGE_DOMAIN = "pm-evidence-coverage-v1";

function resolveCanonicalTargetPath(
  inputPath: string,
  depth = 0,
): {
  readonly lexical: string;
  readonly canonicalAncestorResolved: string;
  readonly realTarget: string | null;
  readonly symlinkTargets: readonly string[];
} {
  if (depth > 8) {
    throw new FreshStartError("FRESH_START_PATH_INVALID");
  }
  if (
    typeof inputPath !== "string"
    || inputPath.trim() !== inputPath
    || inputPath.length === 0
    || !isAbsolute(inputPath)
    || /[\0\r\n]/u.test(inputPath)
  ) {
    throw new FreshStartError("FRESH_START_PATH_INVALID");
  }
  const lexical = resolve(inputPath);
  let cursor = lexical;
  let canonicalAncestorResolved = lexical;
  while (true) {
    try {
      const realCursor = resolve(realpathSync.native(cursor));
      canonicalAncestorResolved = resolve(realCursor, relative(cursor, lexical));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new FreshStartError("FRESH_START_PATH_INVALID");
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new FreshStartError("FRESH_START_PATH_INVALID");
      }
      cursor = parent;
    }
  }
  let realTarget: string | null = null;
  if (existsSync(lexical)) {
    try {
      realTarget = resolve(realpathSync.native(lexical));
    } catch {
      throw new FreshStartError("FRESH_START_PATH_INVALID");
    }
  }
  const symlinkTargets: string[] = [];
  try {
    const stat = lstatSync(lexical);
    if (stat.isSymbolicLink()) {
      const linkDest = resolve(dirname(lexical), readlinkSync(lexical));
      symlinkTargets.push(linkDest);
      const resolvedLinkDest = resolveCanonicalTargetPath(linkDest, depth + 1);
      symlinkTargets.push(
        resolvedLinkDest.lexical,
        resolvedLinkDest.canonicalAncestorResolved,
        ...(resolvedLinkDest.realTarget !== null ? [resolvedLinkDest.realTarget] : []),
        ...resolvedLinkDest.symlinkTargets,
      );
    }
  } catch (error) {
    if (error instanceof FreshStartError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new FreshStartError("FRESH_START_PATH_INVALID");
    }
  }
  return { lexical, canonicalAncestorResolved, realTarget, symlinkTargets };
}

function assertKeyringPathDisjoint(
  keyringPath: string,
  storeRoot: string,
  paths?: FreshStartPaths,
  env?: NodeJS.ProcessEnv,
): string {
  const resolvedKeyring = resolveCanonicalTargetPath(keyringPath);
  const candidateTargets = [
    resolvedKeyring.lexical,
    resolvedKeyring.canonicalAncestorResolved,
    ...(resolvedKeyring.realTarget !== null ? [resolvedKeyring.realTarget] : []),
    ...resolvedKeyring.symlinkTargets,
  ];

  const envCandidateRoots = [
    env?.MEMORY_PROJECT_ROOT,
    env?.MEMORY_V2_PROJECT_ROOT,
    env?.MEMORY_V2_VAULT_PATH,
    env?.MEMORY_V2_VAULT_ROOT,
    env?.MEMORY_V1_ARCHIVE_PATH,
    env?.MEMORY_V2_V1_ARCHIVE_ROOT,
    env?.MEMORY_V2_DATA_ROOT,
    env?.MEMORY_V2_RECOVERY_ROOT,
    env?.MEMORY_V2_STAGING_ROOT,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const rawRoots = [
    storeRoot,
    ...(paths !== undefined
      ? [paths.projectRoot, paths.v2VaultRoot, paths.v1ArchiveRoot]
      : []),
    ...envCandidateRoots,
  ];

  const forbiddenRoots = new Set<string>();
  for (const root of rawRoots) {
    forbiddenRoots.add(resolve(root));
    try {
      forbiddenRoots.add(canonicalFreshStartPath(root));
    } catch {
      // Keep lexical root check when ancestor resolution fails
    }
    if (existsSync(root)) {
      try {
        forbiddenRoots.add(resolve(realpathSync.native(root)));
      } catch {
        // Ignore if not resolvable
      }
    }
  }

  for (const target of candidateTargets) {
    for (const root of forbiddenRoots) {
      if (freshStartPathContains(root, target) || freshStartPathContains(target, root)) {
        throw new FreshStartError("FRESH_START_PATH_OVERLAP");
      }
    }
  }

  if (resolvedKeyring.realTarget !== null) {
    return resolvedKeyring.realTarget;
  }
  return resolvedKeyring.canonicalAncestorResolved;
}

export function loadOperationalKeyringSeed(options: OperationalKeyCustodyOptions): Buffer {
  if (options.masterSeed !== undefined) {
    if (!(options.masterSeed instanceof Uint8Array) || options.masterSeed.byteLength !== 32) {
      throw new FreshStartError("FRESH_START_CONFIG_INVALID");
    }
    return Buffer.from(options.masterSeed);
  }

  const env = options.env ?? process.env;
  const rawPath = env.MEMORY_V2_KEYRING_PATH;
  if (rawPath !== undefined) {
    const safePath = assertKeyringPathDisjoint(rawPath, options.storeRoot, options.paths, env);
    let fileBytes: Buffer | undefined;
    try {
      if (!existsSync(safePath) || lstatSync(safePath).isDirectory()) {
        throw new FreshStartError("FRESH_START_CONFIG_INVALID");
      }
      fileBytes = readFileSync(safePath);
      if (fileBytes.byteLength < 32) {
        throw new FreshStartError("FRESH_START_CONFIG_INVALID");
      }
      return createHash("sha256")
        .update(KEYRING_FILE_DOMAIN, "utf8")
        .update(fileBytes)
        .digest();
    } catch (error) {
      if (error instanceof FreshStartError) throw error;
      throw new FreshStartError("FRESH_START_CONFIG_INVALID");
    } finally {
      fileBytes?.fill(0);
    }
  }

  const rawB64 = env.MEMORY_V2_KEYRING_B64;
  if (rawB64 !== undefined) {
    if (typeof rawB64 !== "string" || rawB64.trim().length === 0) {
      throw new FreshStartError("FRESH_START_CONFIG_INVALID");
    }
    let decoded: Buffer | undefined;
    try {
      decoded = Buffer.from(rawB64.trim(), "base64url");
      if (decoded.byteLength < 32) {
        throw new FreshStartError("FRESH_START_CONFIG_INVALID");
      }
      return createHash("sha256")
        .update(KEYRING_B64_DOMAIN, "utf8")
        .update(decoded)
        .digest();
    } finally {
      decoded?.fill(0);
    }
  }

  let username = "local-operator";
  try {
    username = userInfo().username || username;
  } catch {
    // Fallback when OS user lookup is restricted
  }
  const canonicalStoreRoot = (() => {
    try {
      return canonicalFreshStartPath(options.storeRoot);
    } catch {
      return resolve(options.storeRoot);
    }
  })();

  return createHash("sha256")
    .update(LOCAL_CUSTODY_DOMAIN, "utf8")
    .update(`${platform()}\0${arch()}\0${hostname()}\0${username}\0`, "utf8")
    .update(`${canonicalStoreRoot}\0${options.projectId}\0${options.storeId}`, "utf8")
    .digest();
}

function extractEvidenceIdFromAad(aad: Uint8Array): string {
  try {
    const parsed = JSON.parse(Buffer.from(aad).toString("utf8")) as unknown;
    if (
      typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      && typeof (parsed as { evidenceId?: unknown }).evidenceId === "string"
      && (parsed as { evidenceId: string }).evidenceId.length > 0
    ) {
      return (parsed as { evidenceId: string }).evidenceId;
    }
  } catch {
    // Fallback to SHA-256 of AAD bytes when AAD is not a JSON binding record
  }
  return createHash("sha256").update(aad).digest("hex");
}

function assertPositiveDecimalVersion(version: string): void {
  if (typeof version !== "string" || !/^[1-9][0-9]{0,18}$/u.test(version)) {
    throw new Error("INVALID_KEY_VERSION");
  }
}

export class OperationalKeyCustodyProvider implements HistoricalEvidenceIntegrityProviderPort {
  readonly #db: DatabaseSync;
  readonly #projectId: string;
  readonly #storeId: string;
  readonly #masterKey: Buffer;
  #closed = false;

  readonly capability: CapabilityKeyProvider;
  readonly evidence: EvidenceKeyProvider;

  constructor(options: OperationalKeyCustodyOptions) {
    if (
      typeof options.projectId !== "string"
      || options.projectId.length === 0
      || typeof options.storeId !== "string"
      || options.storeId.length === 0
      || typeof options.storeRoot !== "string"
      || options.storeRoot.length === 0
    ) {
      throw new FreshStartError("FRESH_START_CONFIG_INVALID");
    }
    this.#projectId = options.projectId;
    this.#storeId = options.storeId;
    this.#masterKey = loadOperationalKeyringSeed(options);

    mkdirSync(options.storeRoot, { recursive: true });
    const dbPath = join(options.storeRoot, "custody-recovery.sqlite");
    this.#db = new DatabaseSync(dbPath);
    try {
      this.#initializeSchema();
      this.#provisionDefaultKeys(new Date().toISOString());
    } catch (error) {
      this.#masterKey.fill(0);
      this.#db.close();
      throw error;
    }

    this.capability = Object.freeze({
      currentKey: (scope: KeyScope, purpose: CapabilityKeyPurpose): CapabilityKeyRef =>
        this.#capabilityCurrentKey(scope, purpose),
      status: (
        scope: KeyScope,
        purpose: CapabilityKeyPurpose,
        keyId: string,
      ): "available" | "revoked" | "unavailable" =>
        this.#capabilityStatus(scope, purpose, keyId),
      mac: (input: KeyedMacInput): Uint8Array => this.#capabilityMac(input),
      verify: (input: KeyedVerifyInput): boolean => this.#capabilityVerify(input),
      fingerprint: (input: KeyedFingerprintInput): string => this.#capabilityFingerprint(input),
      seal: (input: KeyedSealInput): SealedValueV1 => this.#capabilitySeal(input),
      open: (input: KeyedOpenInput): Uint8Array => this.#capabilityOpen(input),
    });

    this.evidence = Object.freeze({
      currentKey: (scope: EvidenceKeyScope, purpose: EvidenceKeyPurpose): EvidenceKeyRefV1 =>
        this.#evidenceCurrentKey(scope, purpose),
      status: (
        scope: EvidenceKeyScope,
        purpose: EvidenceKeyPurpose,
        ref: EvidenceKeyRefV1,
      ): "available" | "revoked" | "unavailable" =>
        this.#evidenceStatus(scope, purpose, ref),
      wrap: (
        scope: EvidenceKeyScope,
        ref: EvidenceKeyRefV1,
        dataKey: Uint8Array,
        aad: Uint8Array,
      ): WrappedEvidenceKeyV1 => this.#evidenceWrap(scope, ref, dataKey, aad),
      unwrap: (
        scope: EvidenceKeyScope,
        wrapped: WrappedEvidenceKeyV1,
        aad: Uint8Array,
      ): Uint8Array => this.#evidenceUnwrap(scope, wrapped, aad),
      mac: (
        scope: EvidenceKeyScope,
        purpose: "original-input-commitment" | "redacted-content-fingerprint",
        ref: EvidenceKeyRefV1,
        domain: string,
        bytes: Uint8Array,
      ): Uint8Array => this.#evidenceMac(scope, purpose, ref, domain, bytes),
    });
  }

  async status(keyId: string): Promise<"available" | "revoked" | "unavailable"> {
    this.#assertOpen();
    return this.#capabilityStatus(
      { projectId: this.#projectId, storeId: this.#storeId },
      "evidence-fingerprint",
      keyId,
    );
  }

  async fingerprint(keyId: string, bytes: Uint8Array): Promise<string> {
    this.#assertOpen();
    const keyStatus = this.#capabilityStatus(
      { projectId: this.#projectId, storeId: this.#storeId },
      "evidence-fingerprint",
      keyId,
    );
    if (keyStatus !== "available") {
      throw new HistoricalEvidenceKeyUnavailableError();
    }
    return this.#capabilityFingerprint({
      projectId: this.#projectId,
      storeId: this.#storeId,
      purpose: "evidence-fingerprint",
      keyId,
      domain: HISTORICAL_COVERAGE_DOMAIN,
      bytes,
    });
  }

  rotateEvidenceWrapKey(
    nextVersion: string,
    now = new Date().toISOString(),
  ): { readonly rotatedEnvelopes: number; readonly activeKeyRef: EvidenceKeyRefV1 } {
    this.#assertOpen();
    try {
      assertPositiveDecimalVersion(nextVersion);
    } catch {
      throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
    }
    const keyId = "op-ev-data-key-wrap";
    const activeKeyRef: EvidenceKeyRefV1 = Object.freeze({ keyId, version: nextVersion });

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const currentRow = this.#db
        .prepare(
          `SELECT version
           FROM key_versions
           WHERE project_id = ? AND store_id = ? AND family = 'evidence' AND purpose = 'data-key-wrap' AND is_current = 1`,
        )
        .get(this.#projectId, this.#storeId) as { version: string } | undefined;
      if (currentRow === undefined || BigInt(nextVersion) <= BigInt(currentRow.version)) {
        throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
      }

      const existingTargetRow = this.#db
        .prepare(
          `SELECT retired_at, secret_material_b64
           FROM key_versions
           WHERE project_id = ? AND store_id = ? AND family = 'evidence' AND purpose = 'data-key-wrap' AND version = ?`,
        )
        .get(this.#projectId, this.#storeId, nextVersion) as
        | { retired_at: string | null; secret_material_b64: string | null }
        | undefined;
      if (
        existingTargetRow !== undefined
        && (existingTargetRow.retired_at !== null || existingTargetRow.secret_material_b64 === null)
      ) {
        throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
      }

      this.#ensureKeyVersionRow("evidence", "data-key-wrap", keyId, nextVersion, 1, now);
      this.#db
        .prepare(
          `UPDATE key_versions
           SET is_current = CASE WHEN version = ? THEN 1 ELSE 0 END,
               status = 'available'
           WHERE project_id = ? AND store_id = ? AND family = 'evidence' AND purpose = 'data-key-wrap' AND version = ?`,
        )
        .run(nextVersion, this.#projectId, this.#storeId, nextVersion);

      const nextKek = this.#loadKek("evidence", "data-key-wrap", keyId, nextVersion);
      let rotatedEnvelopes = 0;
      try {
        const activeRows = this.#db
          .prepare(
            `SELECT original_wrap_hash, active_wrap_version, aad_b64, wrapped_data_key_json
             FROM evidence_key_envelopes
             WHERE project_id = ? AND store_id = ? AND status = 'active'`,
          )
          .all(this.#projectId, this.#storeId) as Array<{
          original_wrap_hash: string;
          active_wrap_version: string;
          aad_b64: string;
          wrapped_data_key_json: string | null;
        }>;

        const updateEnvelope = this.#db.prepare(
          `UPDATE evidence_key_envelopes
           SET active_wrap_version = ?, wrapped_data_key_json = ?, updated_at = ?
           WHERE project_id = ? AND store_id = ? AND original_wrap_hash = ?`,
        );

        for (const row of activeRows) {
          if (typeof row.wrapped_data_key_json !== "string") {
            throw new RetainedEvidenceError("INTEGRITY_FAILURE");
          }
          const currentWrapped = decodeWrappedEvidenceKey(
            JSON.parse(row.wrapped_data_key_json) as unknown,
          );
          const aad = Buffer.from(row.aad_b64, "base64url");
          let oldKek: Buffer | undefined;
          let dataKey: Buffer | undefined;
          try {
            oldKek = this.#loadKek(
              "evidence",
              "data-key-wrap",
              currentWrapped.keyRef.keyId,
              row.active_wrap_version,
            );
            dataKey = this.#decryptDataKeyWithKek(oldKek, currentWrapped, aad);
            const rewrapped = this.#encryptDataKeyWithKek(nextKek, activeKeyRef, dataKey, aad);
            updateEnvelope.run(
              nextVersion,
              canonicalJson(rewrapped),
              now,
              this.#projectId,
              this.#storeId,
              row.original_wrap_hash,
            );
            rotatedEnvelopes += 1;
          } finally {
            oldKek?.fill(0);
            dataKey?.fill(0);
          }
        }

        // Retire and shred prior data-key-wrap KEK material while keeping status 'available' for historical envelope resolution
        this.#db
          .prepare(
            `UPDATE key_versions
             SET is_current = 0,
                 secret_material_b64 = NULL,
                 retired_at = COALESCE(retired_at, ?)
             WHERE project_id = ? AND store_id = ? AND family = 'evidence' AND purpose = 'data-key-wrap' AND version != ?`,
          )
          .run(now, this.#projectId, this.#storeId, nextVersion);
      } finally {
        nextKek.fill(0);
      }

      this.#db.exec("COMMIT");
      return Object.freeze({ rotatedEnvelopes, activeKeyRef });
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Ignore rollback error
      }
      throw error;
    }
  }

  recordErasureFence(input: Omit<ErasureFenceRecordV1, "tombstoneHash">): ErasureFenceRecordV1 {
    this.#assertOpen();
    if (input.projectId !== this.#projectId || input.storeId !== this.#storeId) {
      throw new Error("ERASURE_FENCE_SCOPE_MISMATCH");
    }
    const tombstoneHash = createHash("sha256")
      .update(
        canonicalJson({
          domain: "v2-erasure-fence-v1",
          projectId: input.projectId,
          storeId: input.storeId,
          erasureId: input.erasureId,
          evidenceId: input.evidenceId,
          sourceEventId: input.sourceEventId,
          erasureEventId: input.erasureEventId,
          reason: input.reason,
          erasedAt: input.erasedAt,
        }),
        "utf8",
      )
      .digest("hex");

    const record: ErasureFenceRecordV1 = Object.freeze({
      erasureId: input.erasureId,
      projectId: input.projectId,
      storeId: input.storeId,
      evidenceId: input.evidenceId,
      sourceEventId: input.sourceEventId,
      erasureEventId: input.erasureEventId,
      tombstoneHash,
      reason: input.reason,
      erasedAt: input.erasedAt,
    });

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `INSERT INTO erasure_fences (
             project_id, store_id, evidence_id, erasure_id, source_event_id,
             erasure_event_id, tombstone_hash, reason, erased_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, store_id, evidence_id) DO UPDATE SET
             erasure_id = excluded.erasure_id,
             source_event_id = excluded.source_event_id,
             erasure_event_id = excluded.erasure_event_id,
             tombstone_hash = excluded.tombstone_hash,
             reason = excluded.reason,
             erased_at = excluded.erased_at`,
        )
        .run(
          record.projectId,
          record.storeId,
          record.evidenceId,
          record.erasureId,
          record.sourceEventId,
          record.erasureEventId,
          record.tombstoneHash,
          record.reason,
          record.erasedAt,
        );

      this.#db
        .prepare(
          `UPDATE evidence_key_envelopes
           SET wrapped_data_key_json = NULL,
               status = 'erased',
               updated_at = ?
           WHERE project_id = ? AND store_id = ? AND evidence_id = ?`,
        )
        .run(record.erasedAt, record.projectId, record.storeId, record.evidenceId);

      this.#db.exec("COMMIT");
      return record;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure
      }
      throw error;
    }
  }

  isEvidenceErased(evidenceId: string): boolean {
    this.#assertOpen();
    const row = this.#db
      .prepare(
        `SELECT 1 AS present
         FROM erasure_fences
         WHERE project_id = ? AND store_id = ? AND evidence_id = ?
         LIMIT 1`,
      )
      .get(this.#projectId, this.#storeId, evidenceId);
    return row !== undefined;
  }

  listErasureFences(): readonly ErasureFenceRecordV1[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare(
        `SELECT erasure_id, project_id, store_id, evidence_id, source_event_id,
                erasure_event_id, tombstone_hash, reason, erased_at
         FROM erasure_fences
         WHERE project_id = ? AND store_id = ?
         ORDER BY erased_at ASC, evidence_id ASC`,
      )
      .all(this.#projectId, this.#storeId) as Array<{
      erasure_id: string;
      project_id: string;
      store_id: string;
      evidence_id: string;
      source_event_id: string;
      erasure_event_id: string;
      tombstone_hash: string;
      reason: string;
      erased_at: string;
    }>;

    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          erasureId: row.erasure_id,
          projectId: row.project_id,
          storeId: row.store_id,
          evidenceId: row.evidence_id,
          sourceEventId: row.source_event_id,
          erasureEventId: row.erasure_event_id,
          tombstoneHash: row.tombstone_hash,
          reason: row.reason,
          erasedAt: row.erased_at,
        }),
      ),
    );
  }

  recordBackupReceipt(receipt: BackupReceiptRecordV1): void {
    this.#assertOpen();
    if (receipt.projectId !== this.#projectId || receipt.storeId !== this.#storeId) {
      throw new Error("BACKUP_RECEIPT_SCOPE_MISMATCH");
    }
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO fresh_start_backups (
           project_id, store_id, backup_id, release_id, backup_path,
           terminal_event_position, terminal_event_hash, manifest_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.projectId,
        receipt.storeId,
        receipt.backupId,
        receipt.releaseId,
        receipt.backupPath,
        receipt.terminalEventPosition,
        receipt.terminalEventHash,
        receipt.manifestSha256,
        receipt.createdAt,
      );
  }

  latestBackupReceipt(): BackupReceiptRecordV1 | null {
    this.#assertOpen();
    const row = this.#db
      .prepare(
        `SELECT backup_id, project_id, store_id, release_id, backup_path,
                terminal_event_position, terminal_event_hash, manifest_sha256, created_at
         FROM fresh_start_backups
         WHERE project_id = ? AND store_id = ?
         ORDER BY created_at DESC, backup_id DESC
         LIMIT 1`,
      )
      .get(this.#projectId, this.#storeId) as
      | {
          backup_id: string;
          project_id: string;
          store_id: string;
          release_id: string;
          backup_path: string;
          terminal_event_position: string;
          terminal_event_hash: string;
          manifest_sha256: string;
          created_at: string;
        }
      | undefined;

    if (row === undefined) return null;
    return Object.freeze({
      backupId: row.backup_id,
      projectId: row.project_id,
      storeId: row.store_id,
      releaseId: row.release_id,
      backupPath: row.backup_path,
      terminalEventPosition: row.terminal_event_position,
      terminalEventHash: row.terminal_event_hash,
      manifestSha256: row.manifest_sha256,
      createdAt: row.created_at,
    });
  }

  inspectKeyVersions(): readonly KeyVersionInspectionRecordV1[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare(
        `SELECT family, purpose, key_id, version, is_current, status, created_at, retired_at
         FROM key_versions
         WHERE project_id = ? AND store_id = ?
         ORDER BY family ASC, purpose ASC, CAST(version AS INTEGER) ASC`,
      )
      .all(this.#projectId, this.#storeId) as Array<{
      family: "capability" | "evidence";
      purpose: string;
      key_id: string;
      version: string;
      is_current: number | bigint;
      status: "available" | "revoked" | "unavailable";
      created_at: string;
      retired_at: string | null;
    }>;

    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          family: row.family,
          purpose: row.purpose,
          keyId: row.key_id,
          version: row.version,
          isCurrent: Number(row.is_current) === 1,
          status: row.status,
          createdAt: row.created_at,
          retiredAt: row.retired_at,
        }),
      ),
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#masterKey.fill(0);
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("OPERATIONAL_KEY_CUSTODY_CLOSED");
    }
  }

  #assertScope(scope: { readonly projectId: string; readonly storeId: string }): void {
    if (
      typeof scope !== "object"
      || scope === null
      || scope.projectId !== this.#projectId
      || scope.storeId !== this.#storeId
    ) {
      throw new Error("OPERATIONAL_KEY_SCOPE_MISMATCH");
    }
  }

  #initializeSchema(): void {
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS key_versions (
        project_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        family TEXT NOT NULL,
        purpose TEXT NOT NULL,
        key_id TEXT NOT NULL,
        version TEXT NOT NULL,
        is_current INTEGER NOT NULL,
        status TEXT NOT NULL,
        secret_material_b64 TEXT,
        created_at TEXT NOT NULL,
        retired_at TEXT,
        PRIMARY KEY (project_id, store_id, family, purpose, version)
      );

      CREATE TABLE IF NOT EXISTS evidence_key_envelopes (
        project_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        original_wrap_hash TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        aad_sha256 TEXT NOT NULL,
        aad_b64 TEXT NOT NULL,
        active_wrap_version TEXT NOT NULL,
        wrapped_data_key_json TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, store_id, original_wrap_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_key_envelopes_evidence_id
        ON evidence_key_envelopes(project_id, store_id, evidence_id);

      CREATE TABLE IF NOT EXISTS erasure_fences (
        project_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        erasure_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        erasure_event_id TEXT NOT NULL,
        tombstone_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        erased_at TEXT NOT NULL,
        PRIMARY KEY (project_id, store_id, evidence_id)
      );

      CREATE TABLE IF NOT EXISTS fresh_start_backups (
        project_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        backup_id TEXT NOT NULL,
        release_id TEXT NOT NULL,
        backup_path TEXT NOT NULL,
        terminal_event_position TEXT NOT NULL,
        terminal_event_hash TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, store_id, backup_id)
      );
    `);
  }

  #provisionDefaultKeys(now: string): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const purpose of ALL_CAPABILITY_KEY_PURPOSES) {
        const hasCurrent = this.#db
          .prepare(
            `SELECT 1 FROM key_versions
             WHERE project_id = ? AND store_id = ? AND family = 'capability' AND purpose = ? AND is_current = 1`,
          )
          .get(this.#projectId, this.#storeId, purpose);
        if (hasCurrent === undefined) {
          this.#ensureKeyVersionRow(
            "capability",
            purpose,
            `op-cap-${purpose}-v1`,
            "1",
            1,
            now,
          );
        }
      }
      for (const purpose of ALL_EVIDENCE_KEY_PURPOSES) {
        const hasCurrent = this.#db
          .prepare(
            `SELECT 1 FROM key_versions
             WHERE project_id = ? AND store_id = ? AND family = 'evidence' AND purpose = ? AND is_current = 1`,
          )
          .get(this.#projectId, this.#storeId, purpose);
        if (hasCurrent === undefined) {
          this.#ensureKeyVersionRow(
            "evidence",
            purpose,
            `op-ev-${purpose}`,
            "1",
            1,
            now,
          );
        }
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure
      }
      throw error;
    }
  }

  #derivePurposeKek(
    family: "capability" | "evidence",
    purpose: string,
    keyId: string,
    version: string,
  ): Buffer {
    return createHmac("sha256", this.#masterKey)
      .update(PURPOSE_KEK_DOMAIN, "utf8")
      .update(`${this.#projectId}\0${this.#storeId}\0${family}\0${purpose}\0${keyId}\0${version}`, "utf8")
      .digest();
  }

  #wrapKekForStorage(
    family: "capability" | "evidence",
    purpose: string,
    keyId: string,
    version: string,
    rawKek: Buffer,
  ): string {
    const aad = Buffer.from(
      `${this.#projectId}\0${this.#storeId}\0${family}\0${purpose}\0${keyId}\0${version}`,
      "utf8",
    );
    const nonce = createHmac("sha256", this.#masterKey)
      .update("kek-nonce\0", "utf8")
      .update(aad)
      .digest()
      .subarray(0, 12);
    const cipher = createCipheriv("aes-256-gcm", this.#masterKey, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(rawKek), cipher.final()]);
    const tag = cipher.getAuthTag();
    const record: WrappedKekRecordV1 = {
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: tag.toString("base64url"),
    };
    return Buffer.from(canonicalJson(record), "utf8").toString("base64url");
  }

  #unwrapKekFromStorage(
    family: "capability" | "evidence",
    purpose: string,
    keyId: string,
    version: string,
    secretMaterialB64: string,
  ): Buffer {
    const parsed = JSON.parse(
      Buffer.from(secretMaterialB64, "base64url").toString("utf8"),
    ) as WrappedKekRecordV1;
    const aad = Buffer.from(
      `${this.#projectId}\0${this.#storeId}\0${family}\0${purpose}\0${keyId}\0${version}`,
      "utf8",
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#masterKey,
      Buffer.from(parsed.nonce, "base64url"),
      { authTagLength: 16 },
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
      decipher.final(),
    ]);
  }

  #ensureKeyVersionRow(
    family: "capability" | "evidence",
    purpose: string,
    keyId: string,
    version: string,
    isCurrent: 0 | 1,
    now: string,
  ): void {
    const existing = this.#db
      .prepare(
        `SELECT secret_material_b64, retired_at FROM key_versions
         WHERE project_id = ? AND store_id = ? AND family = ? AND purpose = ? AND version = ?`,
      )
      .get(this.#projectId, this.#storeId, family, purpose, version) as
      | { secret_material_b64: string | null; retired_at: string | null }
      | undefined;

    if (
      existing !== undefined
      && (existing.retired_at !== null || existing.secret_material_b64 === null || existing.secret_material_b64 !== null)
    ) {
      return;
    }

    const rawKek = this.#derivePurposeKek(family, purpose, keyId, version);
    try {
      const secretMaterialB64 = this.#wrapKekForStorage(family, purpose, keyId, version, rawKek);
      this.#db
        .prepare(
          `INSERT INTO key_versions (
             project_id, store_id, family, purpose, key_id, version,
             is_current, status, secret_material_b64, created_at, retired_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, NULL)
           ON CONFLICT(project_id, store_id, family, purpose, version) DO NOTHING`,
        )
        .run(this.#projectId, this.#storeId, family, purpose, keyId, version, isCurrent, secretMaterialB64, now);
    } finally {
      rawKek.fill(0);
    }
  }

  #loadKek(
    family: "capability" | "evidence",
    purpose: string,
    keyId: string,
    version: string,
  ): Buffer {
    const row = this.#db
      .prepare(
        `SELECT key_id, status, secret_material_b64
         FROM key_versions
         WHERE project_id = ? AND store_id = ? AND family = ? AND purpose = ? AND version = ?`,
      )
      .get(this.#projectId, this.#storeId, family, purpose, version) as
      | { key_id: string; status: string; secret_material_b64: string | null }
      | undefined;

    if (
      row === undefined
      || row.key_id !== keyId
      || row.status !== "available"
      || typeof row.secret_material_b64 !== "string"
    ) {
      throw new RetainedEvidenceError("RETAINED_EVIDENCE_KEY_UNAVAILABLE");
    }
    return this.#unwrapKekFromStorage(family, purpose, keyId, version, row.secret_material_b64);
  }

  #loadCapabilityKeyById(purpose: CapabilityKeyPurpose, keyId: string): Buffer {
    const row = this.#db
      .prepare(
        `SELECT version, status, secret_material_b64
         FROM key_versions
         WHERE project_id = ? AND store_id = ? AND family = 'capability' AND purpose = ? AND key_id = ?`,
      )
      .get(this.#projectId, this.#storeId, purpose, keyId) as
      | { version: string; status: string; secret_material_b64: string | null }
      | undefined;

    if (
      row === undefined
      || row.status !== "available"
      || typeof row.secret_material_b64 !== "string"
    ) {
      throw new Error(`CAPABILITY_KEY_UNAVAILABLE:${purpose}:${keyId}`);
    }
    return this.#unwrapKekFromStorage("capability", purpose, keyId, row.version, row.secret_material_b64);
  }

  #capabilityCurrentKey(scope: KeyScope, purpose: CapabilityKeyPurpose): CapabilityKeyRef {
    this.#assertOpen();
    this.#assertScope(scope);
    const row = this.#db
      .prepare(
        `SELECT key_id, status
         FROM key_versions
         WHERE project_id = ? AND store_id = ? AND family = 'capability' AND purpose = ? AND is_current = 1`,
      )
      .get(this.#projectId, this.#storeId, purpose) as
      | { key_id: string; status: string }
      | undefined;

    if (row === undefined || row.status !== "available") {
      throw new Error(`CAPABILITY_CURRENT_KEY_UNAVAILABLE:${purpose}`);
    }
    return Object.freeze({ keyId: row.key_id });
  }

  #capabilityStatus(
    scope: KeyScope,
    purpose: CapabilityKeyPurpose,
    keyId: string,
  ): "available" | "revoked" | "unavailable" {
    this.#assertOpen();
    if (
      typeof scope !== "object"
      || scope === null
      || scope.projectId !== this.#projectId
      || scope.storeId !== this.#storeId
    ) {
      return "unavailable";
    }
    const row = this.#db
      .prepare(
        `SELECT status, secret_material_b64
         FROM key_versions
         WHERE project_id = ? AND store_id = ? AND family = 'capability' AND purpose = ? AND key_id = ?`,
      )
      .get(this.#projectId, this.#storeId, purpose, keyId) as
      | { status: "available" | "revoked" | "unavailable"; secret_material_b64: string | null }
      | undefined;

    if (row === undefined) return "unavailable";
    if (row.status === "available" && row.secret_material_b64 === null) return "unavailable";
    return row.status;
  }

  #capabilityMac(input: KeyedMacInput): Uint8Array {
    this.#assertOpen();
    this.#assertScope(input);
    if (!(input.bytes instanceof Uint8Array)) {
      throw new TypeError("capability mac input bytes must be Uint8Array");
    }
    const key = this.#loadCapabilityKeyById(input.purpose, input.keyId);
    try {
      return createHmac("sha256", key)
        .update(input.domain, "utf8")
        .update(Buffer.from([0]))
        .update(input.bytes)
        .digest();
    } finally {
      key.fill(0);
    }
  }

  #capabilityVerify(input: KeyedVerifyInput): boolean {
    this.#assertOpen();
    const expected = Buffer.from(this.#capabilityMac(input));
    const supplied = Buffer.from(input.mac);
    try {
      return expected.byteLength === supplied.byteLength && timingSafeEqual(expected, supplied);
    } finally {
      expected.fill(0);
      supplied.fill(0);
    }
  }

  #capabilityFingerprint(input: KeyedFingerprintInput): string {
    const mac = Buffer.from(this.#capabilityMac(input));
    try {
      return mac.toString("hex");
    } finally {
      mac.fill(0);
    }
  }

  #capabilitySeal(input: KeyedSealInput): SealedValueV1 {
    this.#assertOpen();
    this.#assertScope(input);
    if (!(input.bytes instanceof Uint8Array)) {
      throw new TypeError("capability seal input bytes must be Uint8Array");
    }
    const key = this.#loadCapabilityKeyById(input.purpose, input.keyId);
    let nonce: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    let tag: Buffer | undefined;
    try {
      nonce = createHmac("sha256", key)
        .update("nonce\0", "utf8")
        .update(input.domain, "utf8")
        .update(input.bytes)
        .digest()
        .subarray(0, 12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      ciphertext = Buffer.concat([cipher.update(input.bytes), cipher.final()]);
      tag = cipher.getAuthTag();
      return Object.freeze({
        version: 1,
        keyId: input.keyId,
        algorithm: "aes-256-gcm",
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: tag.toString("base64url"),
      });
    } finally {
      key.fill(0);
      nonce?.fill(0);
      ciphertext?.fill(0);
      tag?.fill(0);
    }
  }

  #capabilityOpen(input: KeyedOpenInput): Uint8Array {
    this.#assertOpen();
    this.#assertScope(input);
    const key = this.#loadCapabilityKeyById(input.purpose, input.keyId);
    const nonce = Buffer.from(input.sealed.nonce, "base64url");
    const ciphertext = Buffer.from(input.sealed.ciphertext, "base64url");
    const tag = Buffer.from(input.sealed.tag, "base64url");
    try {
      if (
        input.sealed.version !== 1
        || input.sealed.keyId !== input.keyId
        || input.sealed.algorithm !== "aes-256-gcm"
        || nonce.byteLength !== 12
        || tag.byteLength !== 16
      ) {
        throw new Error("CAPABILITY_SEALED_VALUE_INVALID");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } finally {
      key.fill(0);
      nonce.fill(0);
      ciphertext.fill(0);
      tag.fill(0);
    }
  }

  #evidenceCurrentKey(scope: EvidenceKeyScope, purpose: EvidenceKeyPurpose): EvidenceKeyRefV1 {
    this.#assertOpen();
    this.#assertScope(scope);
    const row = this.#db
      .prepare(
        `SELECT key_id, version, status
         FROM key_versions
         WHERE project_id = ? AND store_id = ? AND family = 'evidence' AND purpose = ? AND is_current = 1`,
      )
      .get(this.#projectId, this.#storeId, purpose) as
      | { key_id: string; version: string; status: string }
      | undefined;

    if (row === undefined || row.status !== "available") {
      throw new RetainedEvidenceError("RETAINED_EVIDENCE_KEY_UNAVAILABLE");
    }
    return Object.freeze({ keyId: row.key_id, version: row.version });
  }

  #evidenceStatus(
    scope: EvidenceKeyScope,
    purpose: EvidenceKeyPurpose,
    ref: EvidenceKeyRefV1,
  ): "available" | "revoked" | "unavailable" {
    this.#assertOpen();
    if (
      typeof scope !== "object"
      || scope === null
      || scope.projectId !== this.#projectId
      || scope.storeId !== this.#storeId
    ) {
      return "unavailable";
    }
    const row = this.#db
      .prepare(
        `SELECT status
         FROM key_versions
         WHERE project_id = ? AND store_id = ? AND family = 'evidence' AND purpose = ? AND key_id = ? AND version = ?`,
      )
      .get(this.#projectId, this.#storeId, purpose, ref.keyId, ref.version) as
      | { status: "available" | "revoked" | "unavailable" }
      | undefined;

    return row?.status ?? "unavailable";
  }

  #encryptDataKeyWithKek(
    kek: Buffer,
    ref: EvidenceKeyRefV1,
    dataKey: Uint8Array,
    aad: Uint8Array,
  ): WrappedEvidenceKeyV1 {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", kek, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Object.freeze({
      formatVersion: 1 as const,
      keyRef: Object.freeze({ keyId: ref.keyId, version: ref.version }),
      algorithm: "AES-256-GCM" as const,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: tag.toString("base64url"),
    });
  }

  #decryptDataKeyWithKek(
    kek: Buffer,
    wrapped: WrappedEvidenceKeyV1,
    aad: Uint8Array,
  ): Buffer {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      kek,
      Buffer.from(wrapped.nonce, "base64url"),
      { authTagLength: 16 },
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(wrapped.tag, "base64url"));
    const first = decipher.update(Buffer.from(wrapped.ciphertext, "base64url"));
    try {
      return Buffer.concat([first, decipher.final()]);
    } finally {
      first.fill(0);
    }
  }

  #evidenceWrap(
    scope: EvidenceKeyScope,
    ref: EvidenceKeyRefV1,
    dataKey: Uint8Array,
    aad: Uint8Array,
  ): WrappedEvidenceKeyV1 {
    this.#assertOpen();
    this.#assertScope(scope);
    if (!(dataKey instanceof Uint8Array) || dataKey.byteLength !== 32 || !(aad instanceof Uint8Array)) {
      throw new RetainedEvidenceError("RETAINED_EVIDENCE_KEY_UNAVAILABLE");
    }
    const evidenceId = extractEvidenceIdFromAad(aad);
    if (this.isEvidenceErased(evidenceId)) {
      throw new RetainedEvidenceError("RETAINED_EVIDENCE_KEY_UNAVAILABLE");
    }

    const kek = this.#loadKek("evidence", "data-key-wrap", ref.keyId, ref.version);
    try {
      const wrapped = this.#encryptDataKeyWithKek(kek, ref, dataKey, aad);
      const originalWrapHash = retainedEvidenceWrapHash(wrapped);
      const aadSha256 = createHash("sha256").update(aad).digest("hex");
      const aadB64 = Buffer.from(aad).toString("base64url");
      const now = new Date().toISOString();

      this.#db
        .prepare(
          `INSERT OR REPLACE INTO evidence_key_envelopes (
             project_id, store_id, original_wrap_hash, evidence_id,
             aad_sha256, aad_b64, active_wrap_version, wrapped_data_key_json, status, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          this.#projectId,
          this.#storeId,
          originalWrapHash,
          evidenceId,
          aadSha256,
          aadB64,
          ref.version,
          canonicalJson(wrapped),
          now,
        );

      return wrapped;
    } finally {
      kek.fill(0);
    }
  }

  #evidenceUnwrap(
    scope: EvidenceKeyScope,
    wrapped: WrappedEvidenceKeyV1,
    aad: Uint8Array,
  ): Uint8Array {
    this.#assertOpen();
    this.#assertScope(scope);
    const evidenceId = extractEvidenceIdFromAad(aad);
    if (this.isEvidenceErased(evidenceId)) {
      throw new RetainedEvidenceError("RETAINED_EVIDENCE_KEY_UNAVAILABLE");
    }

    const originalWrapHash = retainedEvidenceWrapHash(wrapped);
    const aadSha256 = createHash("sha256").update(aad).digest("hex");

    const row = this.#db
      .prepare(
        `SELECT evidence_id, aad_sha256, active_wrap_version, wrapped_data_key_json, status
         FROM evidence_key_envelopes
         WHERE project_id = ? AND store_id = ? AND original_wrap_hash = ?`,
      )
      .get(this.#projectId, this.#storeId, originalWrapHash) as
      | {
          evidence_id: string;
          aad_sha256: string;
          active_wrap_version: string;
          wrapped_data_key_json: string | null;
          status: string;
        }
      | undefined;

    if (row !== undefined) {
      if (
        row.status === "erased"
        || row.wrapped_data_key_json === null
        || this.isEvidenceErased(row.evidence_id)
      ) {
        throw new RetainedEvidenceError("RETAINED_EVIDENCE_KEY_UNAVAILABLE");
      }
      if (row.aad_sha256 !== aadSha256) {
        throw new RetainedEvidenceError("INTEGRITY_FAILURE");
      }
      const activeWrapped = decodeWrappedEvidenceKey(
        JSON.parse(row.wrapped_data_key_json) as unknown,
      );
      const kek = this.#loadKek(
        "evidence",
        "data-key-wrap",
        activeWrapped.keyRef.keyId,
        row.active_wrap_version,
      );
      try {
        return new Uint8Array(this.#decryptDataKeyWithKek(kek, activeWrapped, aad));
      } finally {
        kek.fill(0);
      }
    }

    const kek = this.#loadKek(
      "evidence",
      "data-key-wrap",
      wrapped.keyRef.keyId,
      wrapped.keyRef.version,
    );
    try {
      return new Uint8Array(this.#decryptDataKeyWithKek(kek, wrapped, aad));
    } finally {
      kek.fill(0);
    }
  }

  #evidenceMac(
    scope: EvidenceKeyScope,
    purpose: "original-input-commitment" | "redacted-content-fingerprint",
    ref: EvidenceKeyRefV1,
    domain: string,
    bytes: Uint8Array,
  ): Uint8Array {
    this.#assertOpen();
    this.#assertScope(scope);
    const kek = this.#loadKek("evidence", purpose, ref.keyId, ref.version);
    try {
      return createHmac("sha256", kek)
        .update(domain, "utf8")
        .update("\n", "utf8")
        .update(bytes)
        .digest();
    } finally {
      kek.fill(0);
    }
  }
}
