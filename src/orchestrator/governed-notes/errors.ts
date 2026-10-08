import type { GovernedNoteRecoveryIdsV1 } from "./contracts.js";
import { retainedExactRecord } from "../privacy/evidence-contracts.js";
import { parseCanonicalUuid } from "../lifecycle/contracts/identifiers.js";
export const GOVERNED_NOTE_ERROR_CODES = Object.freeze([
  "GOVERNED_NOTE_CONFIG_INVALID", "GOVERNED_NOTE_INPUT_INVALID", "GOVERNED_NOTE_LIMIT_EXCEEDED", "GOVERNED_NOTE_FORMAT_UNSUPPORTED", "GOVERNED_NOTE_POLICY_UNAVAILABLE", "GOVERNED_NOTE_KEY_UNAVAILABLE", "GOVERNED_NOTE_PROVENANCE_INELIGIBLE", "GOVERNED_NOTE_UNAVAILABLE", "GOVERNED_NOTE_OWNER_BUSY", "GOVERNED_NOTE_OWNERSHIP_UNCERTAIN",
  "PROJECT_BINDING_REQUIRED", "PROJECT_ID_MISMATCH", "VAULT_ID_MISMATCH", "STORE_ID_MISMATCH", "SESSION_NOT_FOUND", "SESSION_HANDLE_STALE", "SESSION_OWNERSHIP_MISMATCH", "SESSION_CAPABILITY_INVALID", "SESSION_CAPABILITY_KEY_UNAVAILABLE", "SESSION_CAPABILITY_EXPIRED", "IDEMPOTENCY_CONFLICT", "COMMAND_OUTCOME_UNKNOWN", "INTEGRITY_FAILURE", "SQLITE_BUSY", "MAINTENANCE_QUIESCING", "STORE_QUEUE_FULL", "WORKER_PROTOCOL_ERROR", "WORKER_CLOSED", "WORKER_UNAVAILABLE",
  "FRESH_START_INPUT_INVALID", "FRESH_START_IDENTITY_MISMATCH", "FRESH_START_RELEASE_MISMATCH", "FRESH_START_NOT_INITIALIZED", "FRESH_START_STORAGE_FAILURE", "FRESH_START_CONTEXT_REQUIRED", "FRESH_START_BUILD_MISMATCH", "FRESH_START_SCHEMA_MISMATCH", "FRESH_START_ADMISSION_STALE", "FRESH_START_ADMISSION_DENIED", "FRESH_START_CONTENT_UNVERIFIED", "FRESH_START_RECOVERY_REQUIRED",
] as const);
export type GovernedNoteErrorCode = (typeof GOVERNED_NOTE_ERROR_CODES)[number];
export type RecoveryIdErrorCode = "COMMAND_OUTCOME_UNKNOWN" | "GOVERNED_NOTE_OWNERSHIP_UNCERTAIN" | "GOVERNED_NOTE_KEY_UNAVAILABLE";
export type GovernedNoteErrorV1 = Readonly<{ code: Exclude<GovernedNoteErrorCode, RecoveryIdErrorCode>; message: Exclude<GovernedNoteErrorCode, RecoveryIdErrorCode>; details: Readonly<Record<string, never>> }> | Readonly<{ code: RecoveryIdErrorCode; message: RecoveryIdErrorCode; details: GovernedNoteRecoveryIdsV1 }>;
export function isRecoveryIdErrorCode(code: GovernedNoteErrorCode): code is RecoveryIdErrorCode { return code === "COMMAND_OUTCOME_UNKNOWN" || code === "GOVERNED_NOTE_OWNERSHIP_UNCERTAIN" || code === "GOVERNED_NOTE_KEY_UNAVAILABLE"; }
const SAFE_CODES = new Set<string>(GOVERNED_NOTE_ERROR_CODES);
function safeIds(value: unknown): GovernedNoteRecoveryIdsV1 | null {
  try {
    const r = retainedExactRecord(value, ["commandId", "idempotencyKey"]);
    for (const key of ["commandId", "idempotencyKey"]) if (typeof r[key] !== "string" || (r[key] as string).length !== 36 || (r[key] as string)[14] !== "4") return null;
    return Object.freeze({ commandId: parseCanonicalUuid(r.commandId, "governed-note"), idempotencyKey: parseCanonicalUuid(r.idempotencyKey, "governed-note") });
  } catch { return null; }
}
export class GovernedNoteError extends Error {
  readonly code: GovernedNoteErrorCode;
  readonly details: Readonly<Record<string, never>> | GovernedNoteRecoveryIdsV1;
  constructor(code: GovernedNoteErrorCode, ids: GovernedNoteRecoveryIdsV1 | null = null) {
    let safe: GovernedNoteErrorCode = SAFE_CODES.has(code) ? code : "GOVERNED_NOTE_UNAVAILABLE";
    let details: Readonly<Record<string, never>> | GovernedNoteRecoveryIdsV1 = Object.freeze({});
    if (isRecoveryIdErrorCode(safe)) { const admitted = safeIds(ids); if (admitted === null) safe = "GOVERNED_NOTE_INPUT_INVALID"; else details = admitted; }
    super(safe); this.name = "GovernedNoteError"; this.code = safe; this.details = details;
  }
}
