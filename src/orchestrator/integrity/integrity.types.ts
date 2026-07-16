import type { ProjectContext } from "../identity/contracts.js";

export const CORE_INTEGRITY_ISSUE_CODES = [
  "PROJECT_ID_MISMATCH",
  "VAULT_ID_MISMATCH",
  "STORE_ID_MISMATCH",
  "STORE_APPLICATION_ID_MISMATCH",
  "SQLITE_QUICK_CHECK_FAILED",
  "SQLITE_INTEGRITY_CHECK_FAILED",
  "SQLITE_FOREIGN_KEY_CHECK_FAILED",
  "MIGRATION_CHECKSUM_MISMATCH",
  "PROJECT_SCHEMA_VERSION_MISMATCH",
  "SCHEMA_FINGERPRINT_MISMATCH",
  "STREAM_HEAD_VERSION_MISMATCH",
  "STREAM_TYPE_MISMATCH",
  "COMMAND_RANGE_FOREIGN_EVENT",
  "COMMAND_RANGE_MISSING_EVENT",
  "COMMAND_EVENT_INDEX_MISMATCH",
  "COMMAND_HASH_MISMATCH",
  "COMMAND_METADATA_MISMATCH",
  "COMMAND_RESPONSE_HASH_MISMATCH",
  "GLOBAL_POSITION_NONCONTIGUOUS",
  "STREAM_VERSION_NONCONTIGUOUS",
  "EVENT_PAYLOAD_HASH_MISMATCH",
  "EVENT_PREVIOUS_HASH_MISMATCH",
  "EVENT_HASH_MISMATCH",
  "EVENT_TIMESTAMP_INVALID",
  "ORPHAN_COMMAND",
  "ORPHAN_EVENT",
  "RANGE_INVALID",
  "RANGE_OUT_OF_BOUNDS",
  "TAIL_LIMIT_INVALID",
] as const;

export const LIFECYCLE_INTEGRITY_ISSUE_CODES = [
  "COMMAND_AUTHORIZATION_METADATA_MISMATCH",
  "SESSION_AUTHORITY_FOLD_MISMATCH",
  "SESSION_LEASE_INVARIANT_MISMATCH",
  "SESSION_EVIDENCE_COVERAGE_MISMATCH",
  "LIFECYCLE_APPROVAL_CONSUMPTION_MISMATCH",
  "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
  "LIFECYCLE_VALIDATION_RESULT_MISMATCH",
  "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH",
] as const;

export const INTEGRITY_ISSUE_CODES = [
  ...CORE_INTEGRITY_ISSUE_CODES,
  ...LIFECYCLE_INTEGRITY_ISSUE_CODES,
] as const;

export type IntegrityIssueCode = (typeof INTEGRITY_ISSUE_CODES)[number];
export type IntegrityMode = "quick" | "full" | "range";

export interface IntegrityIssue {
  code: IntegrityIssueCode;
  message: string;
  globalPosition?: string;
  streamId?: string;
  commandId?: string;
}

export interface IntegrityIssueSink {
  add(
    code: IntegrityIssueCode,
    location?: Omit<IntegrityIssue, "code" | "message">,
  ): void;
}

export interface IntegrityExtension {
  quickCheck(context: ProjectContext, sink: IntegrityIssueSink): void;
  fullCheck(context: ProjectContext, sink: IntegrityIssueSink): void;
}

export interface IntegrityReport {
  ok: boolean;
  mode: IntegrityMode;
  projectId: string;
  storeId: string;
  firstGlobalPosition: string;
  lastGlobalPosition: string;
  eventsVerified: number;
  streamsVerified: number;
  commandsVerified: number;
  schemaFingerprint: string;
  terminalEventHash: string;
  issues: IntegrityIssue[];
}

export type IntegrityInputErrorCode = Extract<
  IntegrityIssueCode,
  "RANGE_INVALID" | "RANGE_OUT_OF_BOUNDS" | "TAIL_LIMIT_INVALID"
>;

export class IntegrityInputError extends Error {
  constructor(readonly code: IntegrityInputErrorCode) {
    super(code);
    this.name = "IntegrityInputError";
  }
}
