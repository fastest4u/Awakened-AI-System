import type { AppendResultWire, WorkerRequest, WorkerResponse } from "../runtime/worker-protocol.js";
import { RetainedEvidenceError, boundedRetainedJson, retainedExactRecord } from "../privacy/evidence-contracts.js";
import { decodeGovernedNoteStoredReceiptV1, decodeGovernedNoteStoredResultV1, decodeGovernedNoteRecoveryResultV1, decodeGovernedNoteErrorV1, decodePreparedGovernedNoteCreateV1, decodePreparedGovernedNoteRecoveryV1 } from "./codec.js";
import { GOVERNED_NOTE_LIMITS, type GovernedNoteRecoveryIdsV1, type GovernedNoteRecoveryResultV1, type GovernedNoteStoredReceiptV1 } from "./contracts.js";
import { GOVERNED_NOTE_ERROR_CODES, GovernedNoteError, isRecoveryIdErrorCode, type GovernedNoteErrorCode } from "./errors.js";

export type GovernedNoteWorkerRequest = Extract<WorkerRequest, { type: "governed-note-create" | "governed-note-recover" }>;
export type GovernedNoteCreateSuccessWireV1 = Omit<AppendResultWire, "response"> & { response: GovernedNoteStoredReceiptV1 };
export function isGovernedNoteRequest(request: WorkerRequest): request is GovernedNoteWorkerRequest {
  return request.type === "governed-note-create" || request.type === "governed-note-recover";
}
export function governedNoteRequestIds(request: GovernedNoteWorkerRequest): GovernedNoteRecoveryIdsV1 {
  const input = request.type === "governed-note-create" ? decodePreparedGovernedNoteCreateV1(request.prepared).command : decodePreparedGovernedNoteRecoveryV1(request.prepared).request;
  return Object.freeze({ commandId: input.commandId, idempotencyKey: input.idempotencyKey });
}
function integrity(): never { throw new GovernedNoteError("WORKER_PROTOCOL_ERROR"); }
export function assertGovernedNoteEnvelopeSize(value: unknown, maximum: number = GOVERNED_NOTE_LIMITS.resultBytes): void {
  try { boundedRetainedJson(value, maximum); } catch (error) { throw new GovernedNoteError(error instanceof RetainedEvidenceError && error.code === "RETAINED_EVIDENCE_LIMIT_EXCEEDED" ? "GOVERNED_NOTE_LIMIT_EXCEEDED" : "GOVERNED_NOTE_INPUT_INVALID"); }
}
function sameIds(actual: GovernedNoteRecoveryIdsV1, ids: GovernedNoteRecoveryIdsV1): void {
  if (actual.commandId !== ids.commandId || actual.idempotencyKey !== ids.idempotencyKey) integrity();
}
export function decodeGovernedNoteCreateSuccessV1(value: unknown, ids: GovernedNoteRecoveryIdsV1): GovernedNoteCreateSuccessWireV1 {
  assertGovernedNoteEnvelopeSize(value);
  const r = retainedExactRecord(value, ["deduplicated", "firstGlobalPosition", "lastGlobalPosition", "finalStreamVersion", "eventIds", "response", "responseHash"]);
  if (typeof r.deduplicated !== "boolean" || typeof r.responseHash !== "string" || !/^[0-9a-f]{64}$/.test(r.responseHash)) integrity();
  const stored = decodeGovernedNoteStoredResultV1({ eventIds: r.eventIds, firstGlobalPosition: r.firstGlobalPosition, lastGlobalPosition: r.lastGlobalPosition, finalStreamVersion: r.finalStreamVersion, response: r.response });
  sameIds(stored.response, ids);
  if (stored.eventIds.some((id, i) => id !== stored.response.sourceEventIds[i]) || stored.lastGlobalPosition !== stored.response.terminalPosition
    || BigInt(stored.lastGlobalPosition) !== BigInt(stored.firstGlobalPosition) + 1n || stored.finalStreamVersion !== "2") integrity();
  return Object.freeze({ ...stored, response: decodeGovernedNoteStoredReceiptV1(stored.response), eventIds: [...stored.eventIds], deduplicated: r.deduplicated, responseHash: r.responseHash });
}
export function decodeGovernedNoteRecoverySuccessV1(value: unknown, ids: GovernedNoteRecoveryIdsV1): GovernedNoteRecoveryResultV1 {
  const result = decodeGovernedNoteRecoveryResultV1(value);
  sameIds(result.outcome === "committed" ? result.receipt : result, ids);
  return result;
}
/** Fixed closed failures only: never copy provider messages or arbitrary scalar details. */
export function sanitizeGovernedNoteError(error: unknown, ids: GovernedNoteRecoveryIdsV1 | null = null): GovernedNoteError {
  let code: GovernedNoteErrorCode = "GOVERNED_NOTE_UNAVAILABLE";
  try {
    const observed = typeof error === "object" && error !== null ? Reflect.get(error, "code") as unknown : undefined;
    if (observed === "WORKER_TIMEOUT" || observed === "STORE_UNAVAILABLE" || observed === "OPERATION_OUTCOME_UNKNOWN") code = "WORKER_UNAVAILABLE";
    else if (observed === "WORKER_PROTOCOL_INVALID") code = "WORKER_PROTOCOL_ERROR";
    else if (typeof observed === "string" && (GOVERNED_NOTE_ERROR_CODES as readonly string[]).includes(observed)) code = observed as GovernedNoteErrorCode;
  } catch { /* Hostile exceptions are unavailable, without observing their text. */ }
  return new GovernedNoteError(code, isRecoveryIdErrorCode(code) ? ids : null);
}
export function decodeGovernedNoteWorkerResponse(value: unknown, request: GovernedNoteWorkerRequest): WorkerResponse {
  // Charge original correlation and encoded overhead before any generic normalization.
  assertGovernedNoteEnvelopeSize(value);
  const base = retainedExactRecord(value, ["id", "ok", ...(typeof value === "object" && value !== null && Reflect.get(value, "ok") === true ? ["data"] : ["error"])]);
  if (base.id !== request.id) integrity();
  const ids = governedNoteRequestIds(request);
  if (base.ok === false) return { id: request.id, ok: false, error: decodeGovernedNoteErrorV1(base.error, ids) };
  if (base.ok !== true) integrity();
  const data = request.type === "governed-note-create" ? decodeGovernedNoteCreateSuccessV1(base.data, ids) : decodeGovernedNoteRecoverySuccessV1(base.data, ids);
  const receipt = "response" in data ? data.response : data.outcome === "committed" ? data.receipt : null;
  if (receipt !== null) {
    for (const field of ["projectId", "vaultId", "storeId"] as const) if (receipt.scope[field] !== request.binding[field]) integrity();
    if (receipt.scope.sessionId !== request.prepared.authorization.targetSessionId) integrity();
  }
  return { id: request.id, ok: true, data };
}
