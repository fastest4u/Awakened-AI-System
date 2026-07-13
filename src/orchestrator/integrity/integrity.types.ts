export const INTEGRITY_ISSUE_CODES = [
  "PROJECT_ID_MISMATCH",
  "VAULT_ID_MISMATCH",
  "STORE_ID_MISMATCH",
  "STORE_APPLICATION_ID_MISMATCH",
  "SQLITE_QUICK_CHECK_FAILED",
  "SQLITE_INTEGRITY_CHECK_FAILED",
  "SQLITE_FOREIGN_KEY_CHECK_FAILED",
  "MIGRATION_CHECKSUM_MISMATCH",
  "SCHEMA_FINGERPRINT_MISMATCH",
  "STREAM_HEAD_VERSION_MISMATCH",
  "STREAM_TYPE_MISMATCH",
  "COMMAND_RANGE_FOREIGN_EVENT",
  "COMMAND_RANGE_MISSING_EVENT",
  "COMMAND_EVENT_INDEX_MISMATCH",
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

export type IntegrityIssueCode = (typeof INTEGRITY_ISSUE_CODES)[number];
export type IntegrityMode = "quick" | "full" | "range";

export interface IntegrityIssue {
  code: IntegrityIssueCode;
  message: string;
  globalPosition?: string;
  streamId?: string;
  commandId?: string;
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
