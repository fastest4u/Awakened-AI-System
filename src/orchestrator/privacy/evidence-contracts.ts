import type { JsonValue } from "../contracts/event.js";
import { types } from "node:util";
import { canonicalJson } from "../serialization/canonical-json.js";
import { parseCanonicalTimestamp, parseCanonicalUuid, parseUnsignedDecimal } from "../lifecycle/contracts/identifiers.js";
import { LIFECYCLE_ERROR_CODES, type LifecycleErrorCode } from "../lifecycle/errors.js";

export const RETAINED_EVIDENCE_LIMITS = Object.freeze({ frames: 64, frameBytes: 65_536, batchBytes: 1_048_576, hashes: 32, rules: 256, literalBytes: 2_048, spans: 4_096, identifierScalars: 128, resultBytes: 16_384 });
const ADMISSION_ERROR_CODES = ["FRESH_START_INPUT_INVALID", "FRESH_START_IDENTITY_MISMATCH", "FRESH_START_RELEASE_MISMATCH", "FRESH_START_NOT_INITIALIZED", "FRESH_START_STORAGE_FAILURE", "FRESH_START_CONTEXT_REQUIRED", "FRESH_START_BUILD_MISMATCH", "FRESH_START_SCHEMA_MISMATCH", "FRESH_START_ADMISSION_STALE", "FRESH_START_ADMISSION_DENIED", "FRESH_START_CONTENT_UNVERIFIED", "FRESH_START_RECOVERY_REQUIRED", "SQLITE_BUSY", "MAINTENANCE_QUIESCING"] as const;
const PRIVACY_ERROR_CODES = ["RETAINED_EVIDENCE_INPUT_INVALID", "RETAINED_EVIDENCE_LIMIT_EXCEEDED", "RETAINED_EVIDENCE_FORMAT_UNSUPPORTED", "RETAINED_EVIDENCE_POLICY_UNAVAILABLE", "RETAINED_EVIDENCE_KEY_UNAVAILABLE", "RETAINED_EVIDENCE_FRAME_CONFLICT", "RETAINED_EVIDENCE_ORDER_CONFLICT", "RETAINED_EVIDENCE_UNAVAILABLE"] as const;
export const RETAINED_EVIDENCE_ERROR_CODES = Object.freeze([...LIFECYCLE_ERROR_CODES, ...ADMISSION_ERROR_CODES, ...PRIVACY_ERROR_CODES]);
export type RetainedEvidenceErrorCode = LifecycleErrorCode | (typeof ADMISSION_ERROR_CODES)[number] | (typeof PRIVACY_ERROR_CODES)[number];
export interface RetainedEvidenceRecoveryIds { readonly commandId?: string; readonly idempotencyKey?: string; }
export class RetainedEvidenceError extends Error {
  readonly code: RetainedEvidenceErrorCode;
  readonly details: RetainedEvidenceRecoveryIds;
  constructor(code: RetainedEvidenceErrorCode, recoveryIds: RetainedEvidenceRecoveryIds = {}) {
    const safe = SAFE_CODES.has(code) ? code : "RETAINED_EVIDENCE_UNAVAILABLE";
    super(safe); this.name = "RetainedEvidenceError"; this.code = safe;
    const details: { commandId?: string; idempotencyKey?: string } = {};
    if (typeof recoveryIds === "object" && recoveryIds !== null && !types.isProxy(recoveryIds)) {
      for (const key of ["commandId", "idempotencyKey"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(recoveryIds, key);
        if (descriptor === undefined || !("value" in descriptor)) continue;
        try { details[key] = uuid(descriptor.value); } catch { /* Invalid recovery values are never exposed. */ }
      }
    }
    this.details = Object.freeze(details);
  }
}
const SAFE_CODES = new Set<string>(RETAINED_EVIDENCE_ERROR_CODES);
export type EvidenceRole = "user" | "assistant" | "tool";
export type EvidenceCategory = "user-message" | "assistant-message" | "tool-input" | "tool-output" | "child-report" | "artifact-reference" | "retrieval-feedback" | "user-correction";
interface FrameSelectors {
  readonly frameId: string; readonly ordinal: string; readonly role: EvidenceRole; readonly category: EvidenceCategory;
  readonly occurredAt: string; readonly previousFrameId: string | null; readonly toolCorrelationId: string | null; readonly artifactHashes: readonly string[];
}
export type RetainedEvidenceFrameV1 = FrameSelectors & ({ readonly mediaType: "text/plain; charset=utf-8"; readonly content: string } | { readonly mediaType: "application/json"; readonly content: JsonValue });
export interface RetainEvidenceBatchCommandV1 {
  readonly version: 1; readonly commandType: "retain-evidence-batch"; readonly commandId: string; readonly idempotencyKey: string;
  readonly targetSessionId: string; readonly conversationId: string; readonly frames: readonly RetainedEvidenceFrameV1[];
}
export interface BoundedEvidenceInputV1 { readonly command: RetainEvidenceBatchCommandV1; readonly canonicalOriginalBytes: Buffer; }
export interface RetainedEvidenceReceiptV1 {
  readonly resultVersion: 1; readonly operation: "retain-evidence-batch"; readonly retentionFormat: "redacted-encrypted-v1";
  readonly targetSessionId: string; readonly conversationId: string; readonly commandId: string; readonly idempotencyKey: string;
  readonly evidenceIds: readonly string[]; readonly eventPosition: string; readonly finalStreamVersion: string;
}
const INVALID = "RETAINED_EVIDENCE_INPUT_INVALID";
function refuse(code: RetainedEvidenceErrorCode = INVALID): never { throw new RetainedEvidenceError(code); }
export function assertRetainedByteLimit(actualBytes: number, maximumBytes: number): void {
  if (!Number.isSafeInteger(actualBytes) || actualBytes < 0 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0) refuse();
  if (actualBytes > maximumBytes) refuse("RETAINED_EVIDENCE_LIMIT_EXCEEDED");
}

/** Inspect data descriptors only. Proxy traps and accessors never execute. */
export function retainedDataEntries(value: unknown, maximumEntries: number, code: RetainedEvidenceErrorCode = INVALID): readonly (readonly [string, unknown])[] {
  if (typeof value !== "object" || value === null || types.isProxy(value)) refuse(code);
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) refuse(code);
  let length = 0;
  if (array) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (descriptor === undefined || !("value" in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) refuse(code);
    length = descriptor.value as number;
    assertRetainedByteLimit(length, maximumEntries);
  }
  const keys = Reflect.ownKeys(value);
  assertRetainedByteLimit(keys.length - (array ? 1 : 0), maximumEntries);
  if (array && (keys.length !== length + 1 || keys[keys.length - 1] !== "length")) refuse(code);
  const entries: (readonly [string, unknown])[] = [];
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (typeof key !== "string") refuse(code);
    if (array && key === "length") continue;
    if (array && key !== String(index)) refuse(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) refuse(code);
    entries.push([key, descriptor.value]);
  }
  return array ? entries : entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
export function retainedExactRecord(value: unknown, keys: readonly string[], code: RetainedEvidenceErrorCode = INVALID): Record<string, unknown> {
  const entries = retainedDataEntries(value, RETAINED_EVIDENCE_LIMITS.batchBytes, code);
  if (Array.isArray(value)) refuse(code);
  const expected = [...keys].sort();
  if (entries.length !== expected.length || entries.some(([key], index) => key !== expected[index])) refuse(code);
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of entries) record[key] = item;
  return record;
}

/** UTF-8 and JSON-string accounting without first allocating an escaped copy. */
export function retainedStringMetrics(value: unknown, maximumBytes: number, code: RetainedEvidenceErrorCode = INVALID, quoted = false): { readonly bytes: number; readonly quotedBytes: number; readonly scalars: number } {
  if (typeof value !== "string") refuse(code);
  let bytes = 0; let quotedBytes = 2; let scalars = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index); scalars++;
    let width: number;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) refuse(code);
      width = 4;
    } else {
      if (unit >= 0xdc00 && unit <= 0xdfff) refuse(code);
      width = unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    bytes += width;
    quotedBytes += unit === 0x22 || unit === 0x5c || [8, 9, 10, 12, 13].includes(unit) ? 2 : unit < 0x20 ? 6 : width;
    assertRetainedByteLimit(quoted ? quotedBytes : bytes, maximumBytes);
  }
  assertRetainedByteLimit(quoted ? quotedBytes : bytes, maximumBytes);
  return { bytes, quotedBytes, scalars };
}

type WalkTask = { readonly kind: "value"; readonly value: unknown } | { readonly kind: "leave"; readonly value: object };
function measureJson(value: unknown, maximumBytes: number): number {
  const stack: WalkTask[] = [{ kind: "value", value }]; const ancestors = new Set<object>(); let bytes = 0;
  while (stack.length !== 0) {
    const task = stack.pop()!;
    if (task.kind === "leave") { ancestors.delete(task.value); continue; }
    const item = task.value;
    if (typeof item === "string") bytes += retainedStringMetrics(item, maximumBytes - bytes, INVALID, true).quotedBytes;
    else if (item === null || typeof item === "boolean") bytes += item === null ? 4 : item ? 4 : 5;
    else if (typeof item === "number") { if (!Number.isFinite(item)) refuse(); bytes += canonicalJson(item).length; }
    else {
      if (typeof item !== "object" || ancestors.has(item)) refuse();
      const entries = retainedDataEntries(item, maximumBytes - bytes);
      const array = Array.isArray(item);
      bytes += 2 + Math.max(0, entries.length - 1);
      assertRetainedByteLimit(bytes, maximumBytes);
      if (!array) for (const [key] of entries) {
        bytes += retainedStringMetrics(key, maximumBytes - bytes, INVALID, true).quotedBytes + 1;
        assertRetainedByteLimit(bytes, maximumBytes);
      }
      assertRetainedByteLimit(bytes, maximumBytes);
      ancestors.add(item); stack.push({ kind: "leave", value: item });
      for (let index = entries.length - 1; index >= 0; index--) stack.push({ kind: "value", value: entries[index]![1] });
    }
    assertRetainedByteLimit(bytes, maximumBytes);
  }
  return bytes;
}

/** Same key sorting / -0 / null-prototype semantics as canonicalJson, without recursion. */
export function boundedRetainedJson(value: unknown, maximumBytes: number): { readonly snapshot: JsonValue; readonly canonical: string; readonly bytes: number } {
  const bytes = measureJson(value, maximumBytes);
  const chunks: string[] = [];
  const holder: { value?: JsonValue } = {};
  type CopyTask = { readonly kind: "value"; readonly value: unknown; readonly assign: (value: JsonValue) => void } | { readonly kind: "token"; readonly token: string } | { readonly kind: "close"; readonly container: object; readonly token: string };
  const stack: CopyTask[] = [{ kind: "value", value, assign: snapshot => { holder.value = snapshot; } }];
  while (stack.length !== 0) {
    const task = stack.pop()!;
    if (task.kind === "token") { chunks.push(task.token); continue; }
    if (task.kind === "close") { Object.freeze(task.container); chunks.push(task.token); continue; }
    const item = task.value;
    if (item === null || typeof item !== "object") { task.assign(item as JsonValue); chunks.push(canonicalJson(item)); continue; }
    const entries = retainedDataEntries(item, maximumBytes); const array = Array.isArray(item);
    const copy: JsonValue[] | Record<string, JsonValue> = array ? [] : Object.create(Object.getPrototypeOf(item)) as Record<string, JsonValue>;
    task.assign(copy); chunks.push(array ? "[" : "{"); stack.push({ kind: "close", container: copy, token: array ? "]" : "}" });
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, child] = entries[index]!;
      stack.push({ kind: "value", value: child, assign: snapshot => { Object.defineProperty(copy, key, { value: snapshot, enumerable: true, writable: true, configurable: true }); } });
      if (!array) stack.push({ kind: "token", token: `${canonicalJson(key)}:` });
      if (index > 0) stack.push({ kind: "token", token: "," });
    }
  }
  return { snapshot: holder.value!, canonical: chunks.join(""), bytes };
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 || value[14] !== "4") refuse();
  try { return parseCanonicalUuid(value, "selector"); } catch { return refuse(); }
}
function decimal(value: unknown): bigint { try { return parseUnsignedDecimal(value, "ordinal"); } catch { return refuse(); } }
function timestamp(value: unknown): void { try { parseCanonicalTimestamp(value, "occurredAt"); } catch { refuse(); } }
function strictList(value: unknown, maximum: number): readonly unknown[] {
  if (typeof value === "object" && value !== null && types.isProxy(value)) refuse();
  if (!Array.isArray(value)) refuse();
  return retainedDataEntries(value, maximum).map(([, item]) => item);
}
const COMMAND_FIELDS = ["version", "commandType", "commandId", "idempotencyKey", "targetSessionId", "conversationId", "frames"];
const FRAME_FIELDS = ["frameId", "ordinal", "role", "category", "occurredAt", "mediaType", "content", "previousFrameId", "toolCorrelationId", "artifactHashes"];
const CATEGORIES = ["user-message", "assistant-message", "tool-input", "tool-output", "child-report", "artifact-reference", "retrieval-feedback", "user-correction"];

export function decodeRetainEvidenceBatch(value: unknown): BoundedEvidenceInputV1 {
  const command = retainedExactRecord(value, COMMAND_FIELDS);
  if (command.version !== 1 || command.commandType !== "retain-evidence-batch") refuse("RETAINED_EVIDENCE_FORMAT_UNSUPPORTED");
  for (const key of ["commandId", "idempotencyKey", "targetSessionId", "conversationId"]) uuid(command[key]);
  const frames = strictList(command.frames, RETAINED_EVIDENCE_LIMITS.frames);
  if (frames.length === 0) refuse();
  const ids = new Set<string>(); const inputIndices = new Map<string, number>();
  const records: Record<string, unknown>[] = []; let previousOrdinal: bigint | undefined; let previousId: string | undefined;
  for (let index = 0; index < frames.length; index++) {
    const frame = retainedExactRecord(frames[index], FRAME_FIELDS); const frameId = uuid(frame.frameId); const ordinal = decimal(frame.ordinal);
    if (ids.has(frameId)) refuse(); ids.add(frameId); timestamp(frame.occurredAt);
    if (frame.previousFrameId !== null) uuid(frame.previousFrameId);
    if (index === 0 ? (ordinal === 0n ? frame.previousFrameId !== null : frame.previousFrameId === null) : ordinal !== previousOrdinal! + 1n || frame.previousFrameId !== previousId) refuse();
    if (!["user", "assistant", "tool"].includes(frame.role as string) || !CATEGORIES.includes(frame.category as string)) refuse();
    const tool = frame.category === "tool-input" || frame.category === "tool-output";
    if ((["user-message", "user-correction"].includes(frame.category as string) && frame.role !== "user") || (["assistant-message", "child-report"].includes(frame.category as string) && frame.role !== "assistant") || (tool && frame.role !== "tool")) refuse();
    if (tool) uuid(frame.toolCorrelationId); else if (frame.toolCorrelationId !== null) refuse();
    if (frame.category === "tool-input") { const correlation = frame.toolCorrelationId as string; if (inputIndices.has(correlation)) refuse(); inputIndices.set(correlation, index); }
    if (frame.mediaType === "text/plain; charset=utf-8") retainedStringMetrics(frame.content, RETAINED_EVIDENCE_LIMITS.frameBytes);
    else if (frame.mediaType === "application/json") measureJson(frame.content, RETAINED_EVIDENCE_LIMITS.frameBytes);
    else refuse("RETAINED_EVIDENCE_FORMAT_UNSUPPORTED");
    const hashes = strictList(frame.artifactHashes, RETAINED_EVIDENCE_LIMITS.hashes); const hashSet = new Set<string>();
    for (const hash of hashes) { if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) || hashSet.has(hash)) refuse(); hashSet.add(hash); }
    records.push(frame); previousOrdinal = ordinal; previousId = frameId;
  }
  if (records[0]!.previousFrameId !== null && ids.has(records[0]!.previousFrameId as string)) refuse();
  for (let index = 0; index < records.length; index++) {
    const frame = records[index]!;
    if (frame.category !== "tool-output") continue;
    const inputIndex = inputIndices.get(frame.toolCorrelationId as string);
    if (inputIndex === undefined ? decimal(records[0]!.ordinal) === 0n : inputIndex >= index) refuse();
  }
  const copied = boundedRetainedJson(value, RETAINED_EVIDENCE_LIMITS.batchBytes);
  return Object.freeze({ command: copied.snapshot as unknown as RetainEvidenceBatchCommandV1, canonicalOriginalBytes: Buffer.from(copied.canonical, "utf8") });
}

export function decodeRetainedEvidenceReceipt(value: unknown): RetainedEvidenceReceiptV1 {
  const record = retainedExactRecord(value, ["resultVersion", "operation", "retentionFormat", "targetSessionId", "conversationId", "commandId", "idempotencyKey", "evidenceIds", "eventPosition", "finalStreamVersion"]);
  if (record.resultVersion !== 1 || record.operation !== "retain-evidence-batch" || record.retentionFormat !== "redacted-encrypted-v1") refuse("RETAINED_EVIDENCE_FORMAT_UNSUPPORTED");
  for (const key of ["targetSessionId", "conversationId", "commandId", "idempotencyKey"]) uuid(record[key]);
  decimal(record.eventPosition); decimal(record.finalStreamVersion);
  const evidenceIds = strictList(record.evidenceIds, RETAINED_EVIDENCE_LIMITS.frames); if (evidenceIds.length === 0) refuse();
  const seen = new Set<string>(); for (const evidenceId of evidenceIds) { const parsed = uuid(evidenceId); if (seen.has(parsed)) refuse(); seen.add(parsed); }
  return boundedRetainedJson(value, RETAINED_EVIDENCE_LIMITS.resultBytes).snapshot as unknown as RetainedEvidenceReceiptV1;
}
