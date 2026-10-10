import { createHash } from "node:crypto";
import { FreshStartError } from "../fresh-start/contracts.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { ProjectionPageKey } from "../retrieval/database-core.js";
import type { VerifiedReadBinding } from "./contracts.js";
import type { NativeContentFilters, NativeSelectionScope } from "./content-contracts.js";
import type { NativePagedOperation, NativeWorkflowCursor, WorkflowCursorBinding } from "./workflow-contracts.js";
import { copyBoundedProtocolData } from "./wire-data.js";

const MAX_POSITION = 9223372036854775807n;
const KEYS = ["version", "operation", "selectionHash", "schemaVersion", "projectionGeneration", "projectionEventPosition", "imageSha256", "lastId", "lastEventPosition"] as const;
function invalid(): never { throw new FreshStartError("FRESH_START_INPUT_INVALID"); }
function position(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) || value.length > 19 || BigInt(value) > MAX_POSITION) invalid();
  return value;
}
function cursorData(value: unknown): NativeWorkflowCursor {
  const data = copyBoundedProtocolData(value, 8192);
  if (!data || typeof data !== "object" || Array.isArray(data)) invalid();
  if (Buffer.byteLength(canonicalJson(data), "utf8") > 2048) invalid();
  const source = data as Record<string, unknown>;
  if (Object.keys(source).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(source, key))) invalid();
  if (source.version !== 1 || (source.schemaVersion !== 2 && source.schemaVersion !== 3)
    || !["list-canonical-records", "recent-canonical-records", "follow-up-radar"].includes(source.operation as string)
    || typeof source.selectionHash !== "string" || !/^[0-9a-f]{64}$/u.test(source.selectionHash)
    || typeof source.imageSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(source.imageSha256)
    || typeof source.projectionGeneration !== "number" || !Number.isInteger(source.projectionGeneration)
    || source.projectionGeneration < 1 || source.projectionGeneration > 2147483647
    || typeof source.lastId !== "string" || !source.lastId.length || Buffer.byteLength(source.lastId,"utf8") > 2048
    || /[\u0000-\u001f\u007f]/u.test(source.lastId)) invalid();
  const tail = position(source.projectionEventPosition);
  if (source.operation === "list-canonical-records") { if (source.lastEventPosition !== null) invalid(); }
  else if (BigInt(position(source.lastEventPosition)) > BigInt(tail)) invalid();
  return Object.freeze({ ...source }) as NativeWorkflowCursor;
}
/** A data selector, not a signature or claim that a prior page was visited. */
export function encodeWorkflowCursor(cursor: NativeWorkflowCursor): string {
  const encoded = Buffer.from(canonicalJson(cursorData(cursor)), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > 2048) invalid();
  return encoded;
}
export function decodeWorkflowCursor(value: unknown): NativeWorkflowCursor {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value,"utf8") > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) invalid();
  const bytes = Buffer.from(value,"base64url");
  if (bytes.length > 2048 || bytes.toString("base64url") !== value) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { invalid(); }
  const cursor = cursorData(parsed);
  if (encodeWorkflowCursor(cursor) !== value) invalid();
  return cursor;
}
export function createWorkflowSelectionHash(operation: NativePagedOperation, binding: VerifiedReadBinding, scope: NativeSelectionScope, filters: NativeContentFilters): string {
  return createHash("sha256").update(canonicalJson({ operation,
    order: operation === "list-canonical-records" ? "item-id-binary-asc" : "source-event-position-desc-id-binary-asc",
    projectionBinding: binding.projectionBinding, selectionScope: scope, expectedRelease: binding.expectedRelease,
    controlGeneration: binding.controlGeneration, compositionEpoch: binding.compositionEpoch,
    filters: { visibility: filters.visibility ?? scope.visibility, validAt: filters.validAt ?? null, knownAt: filters.knownAt ?? null },
  }), "utf8").digest("hex");
}
export function assertWorkflowCursorMatches(cursor: NativeWorkflowCursor, binding: WorkflowCursorBinding): void {
  const checked = cursorData(cursor);
  for (const key of ["version", "operation", "selectionHash", "schemaVersion", "projectionGeneration", "projectionEventPosition", "imageSha256"] as const) {
    if (checked[key] !== binding[key]) throw Object.assign(new Error("V2_CONTENT_CURSOR_STALE"), { code: "V2_CONTENT_CURSOR_STALE" });
  }
}
export function nextWorkflowCursor(binding: WorkflowCursorBinding, last: ProjectionPageKey): string {
  return encodeWorkflowCursor({ ...binding, lastId: last.id, lastEventPosition: last.eventPosition?.toString() ?? null });
}
