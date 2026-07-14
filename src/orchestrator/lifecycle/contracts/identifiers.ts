import { LifecycleError, type LifecycleErrorCode } from "../errors.js";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;
const MILLISECOND_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const SQLITE_INT64_MAX_DECIMAL = "9223372036854775807";

export type SessionId = string & { readonly __sessionId: unique symbol };
export type CheckpointId = string & { readonly __checkpointId: unique symbol };
export type ReportId = string & { readonly __reportId: unique symbol };
export type ReportItemId = string & { readonly __reportItemId: unique symbol };
export type WorkflowId = string & { readonly __workflowId: unique symbol };
export type ApprovalId = string & { readonly __approvalId: unique symbol };
export type AdapterSessionId = string & { readonly __adapterSessionId: unique symbol };
export type EvidenceBatchId = string & { readonly __evidenceBatchId: unique symbol };
export type EvidenceFrameId = string & { readonly __evidenceFrameId: unique symbol };
export type TransferTicketId = string & { readonly __transferTicketId: unique symbol };
export type ValidationResultId = string & { readonly __validationResultId: unique symbol };

export type RootSessionState = "active" | "suspended" | "ending" | "ended" | "abandoned";
export type ChildSessionState = "active" | "completion-proposed" | "completed" | "suspended" | "transferred";
export type ResumePolicy = "new" | "exact" | "latest-safe";
export type ChildEndPolicy = "require-completed" | "suspend-and-carry-forward";
export type MaterialConfidence = "high" | "medium" | "low" | "guess";

export function parseCanonicalUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !LOWER_UUID.test(value)) {
    throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
  }
  return value;
}

export function parseUnsignedDecimal(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL.test(value)) {
    throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
  }
  if (
    value.length > SQLITE_INT64_MAX_DECIMAL.length
    || (value.length === SQLITE_INT64_MAX_DECIMAL.length && value > SQLITE_INT64_MAX_DECIMAL)
  ) {
    throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
  }
  const decoded = BigInt(value);
  if (decoded > SQLITE_INT64_MAX) {
    throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
  }
  return decoded;
}

export function parseCanonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !MILLISECOND_UTC_TIMESTAMP.test(value)) {
    throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
  }
  return value;
}

export function parseLifecycleId<T extends string>(value: unknown, field: string): T {
  return parseCanonicalUuid(value, field) as T;
}

export function strictRecord(
  value: unknown,
  field: string,
  code: LifecycleErrorCode = "LIFECYCLE_INPUT_INVALID",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LifecycleError(code, { field });
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LifecycleError(code, { field });
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new LifecycleError(code, { field });
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new LifecycleError(code, { field });
    }
  }
  return value as Record<string, unknown>;
}

export function strictArray(
  value: unknown,
  field: string,
  code: LifecycleErrorCode = "LIFECYCLE_INPUT_INVALID",
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new LifecycleError(code, { field });
  }
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys: PropertyKey[] = [
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    "length",
  ];
  if (
    ownKeys.length !== expectedKeys.length
    || ownKeys.some((key, index) => key !== expectedKeys[index])
  ) throw new LifecycleError(code, { field });
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new LifecycleError(code, { field });
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new LifecycleError(code, { field });
    }
  }
  return value;
}

export function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
  code: LifecycleErrorCode = "LIFECYCLE_INPUT_INVALID",
): Record<string, unknown> {
  const record = strictRecord(value, field, code);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new LifecycleError(code, { field });
  }
  return record;
}

export function parseBoundedString(
  value: unknown,
  field: string,
  maximumScalars: number,
  options: { readonly allowEmpty?: boolean; readonly code?: LifecycleErrorCode } = {},
): string {
  const code = options.code ?? "LIFECYCLE_INPUT_INVALID";
  if (
    typeof value !== "string"
    || (!options.allowEmpty && value.length === 0)
    || Array.from(value).length > maximumScalars
  ) {
    throw new LifecycleError(code, { field });
  }
  return value;
}

export function parseBoolean(
  value: unknown,
  field: string,
  code: LifecycleErrorCode = "LIFECYCLE_INPUT_INVALID",
): boolean {
  if (typeof value !== "boolean") throw new LifecycleError(code, { field });
  return value;
}

export function parseInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  code: LifecycleErrorCode = "LIFECYCLE_INPUT_INVALID",
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new LifecycleError(code, { field });
  }
  return Number(value);
}

export function parseEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  code: LifecycleErrorCode = "LIFECYCLE_INPUT_INVALID",
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new LifecycleError(code, { field });
  }
  return value as T[number];
}

export function parseNullableBoundedString(
  value: unknown,
  field: string,
  maximumScalars: number,
  code: LifecycleErrorCode = "LIFECYCLE_INPUT_INVALID",
): string | null {
  return value === null ? null : parseBoundedString(value, field, maximumScalars, { code });
}

export function parseNullableUuid<T extends string>(
  value: unknown,
  field: string,
  code: LifecycleErrorCode = "LIFECYCLE_INPUT_INVALID",
): T | null {
  if (value === null) return null;
  try {
    return parseCanonicalUuid(value, field) as T;
  } catch {
    throw new LifecycleError(code, { field });
  }
}

export function parseDecimalString(
  value: unknown,
  field: string,
  code: LifecycleErrorCode = "LIFECYCLE_INPUT_INVALID",
): string {
  try {
    parseUnsignedDecimal(value, field);
  } catch {
    throw new LifecycleError(code, { field });
  }
  return value as string;
}
