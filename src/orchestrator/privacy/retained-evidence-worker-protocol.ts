import type { SemanticCommandAuthorization } from "../lifecycle/contracts/commands.js";
import { RETAINED_EVIDENCE_ERROR_CODES, RETAINED_EVIDENCE_LIMITS, RetainedEvidenceError, boundedRetainedJson,
  decodeRetainEvidenceBatch, retainedExactRecord, retainedStringMetrics, type RetainEvidenceBatchCommandV1 } from "./evidence-contracts.js";
import { decodeRetainedEvidenceStoredResult, type RetainedEvidenceStoredResultV1 } from "./retained-evidence-codec.js";
import { parseCanonicalUuid } from "../lifecycle/contracts/identifiers.js";

export type RetainedEvidenceProtectedAuthorizationV1 = Extract<SemanticCommandAuthorization, { kind: "protected" }>;
export interface PreparedRetainedEvidenceCommandV1 {
  readonly command: RetainEvidenceBatchCommandV1;
  readonly authorization: RetainedEvidenceProtectedAuthorizationV1;
}
/** Physical private transport; the original command is canonical JSON text. */
export interface PreparedRetainedEvidenceCommandWireV1 {
  readonly command: string;
  readonly authorization: RetainedEvidenceProtectedAuthorizationV1;
}
export const MAX_RETAINED_EVIDENCE_WIRE_BYTES = 4 * 1024 * 1024;
export type RetainedEvidenceWorkerSuccessV1 = RetainedEvidenceStoredResultV1 & { readonly deduplicated: boolean; readonly responseHash: string };
function authorization(value: unknown, targetSessionId: string): RetainedEvidenceProtectedAuthorizationV1 {
  const code = "SESSION_CAPABILITY_INVALID";
  const record = retainedExactRecord(value, ["kind", "authoritySessionId", "targetSessionId", "proof", "approval", "childBindingGrant"], code);
  if (record.kind !== "protected" || record.targetSessionId !== targetSessionId || record.approval !== null || record.childBindingGrant !== null) throw new RetainedEvidenceError(code);
  try {
    if (typeof record.authoritySessionId !== "string" || record.authoritySessionId[14] !== "4") throw new Error();
    parseCanonicalUuid(record.authoritySessionId, "authoritySessionId");
    const proof = retainedExactRecord(record.proof, ["proofVersion", "target", "proofNonce", "proofFingerprint"], code);
    if (proof.proofVersion !== 1 || proof.target !== "semantic-command" || typeof proof.proofNonce !== "string" || proof.proofNonce[14] !== "4"
      || typeof proof.proofFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(proof.proofFingerprint)) throw new Error();
    parseCanonicalUuid(proof.proofNonce, "proofNonce");
  } catch { throw new RetainedEvidenceError(code); }
  return boundedRetainedJson(value, RETAINED_EVIDENCE_LIMITS.resultBytes).snapshot as unknown as RetainedEvidenceProtectedAuthorizationV1;
}
export function encodePreparedRetainedEvidenceCommand(value: unknown): PreparedRetainedEvidenceCommandWireV1 {
  const prepared = retainedExactRecord(value, ["command", "authorization"]);
  const input = decodeRetainEvidenceBatch(prepared.command);
  try {
    return Object.freeze({ command: input.canonicalOriginalBytes.toString("utf8"), authorization: authorization(prepared.authorization, input.command.targetSessionId) });
  } finally { input.canonicalOriginalBytes.fill(0); }
}
export function decodePreparedRetainedEvidenceCommand(value: unknown): PreparedRetainedEvidenceCommandV1 {
  const prepared = retainedExactRecord(value, ["command", "authorization"]);
  retainedStringMetrics(prepared.command, RETAINED_EVIDENCE_LIMITS.batchBytes);
  let original: unknown;
  try { original = JSON.parse(prepared.command as string); } catch { throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID"); }
  const input = decodeRetainEvidenceBatch(original);
  try {
    if (input.canonicalOriginalBytes.toString("utf8") !== prepared.command) throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
    return Object.freeze({ command: input.command, authorization: authorization(prepared.authorization, input.command.targetSessionId) });
  } finally { input.canonicalOriginalBytes.fill(0); }
}
export function assertRetainedEvidenceWireSize(value: unknown): void {
  boundedRetainedJson(value, MAX_RETAINED_EVIDENCE_WIRE_BYTES);
}
export function decodeRetainedEvidenceWorkerSuccess(value: unknown, prepared?: PreparedRetainedEvidenceCommandV1): RetainedEvidenceWorkerSuccessV1 {
  const result = retainedExactRecord(value, ["deduplicated", "firstGlobalPosition", "lastGlobalPosition", "finalStreamVersion", "eventIds", "response", "responseHash"]);
  if (typeof result.deduplicated !== "boolean" || typeof result.responseHash !== "string" || !/^[0-9a-f]{64}$/.test(result.responseHash)) throw new RetainedEvidenceError("INTEGRITY_FAILURE");
  const stored = decodeRetainedEvidenceStoredResult({ eventIds: result.eventIds, firstGlobalPosition: result.firstGlobalPosition,
    lastGlobalPosition: result.lastGlobalPosition, finalStreamVersion: result.finalStreamVersion, response: result.response });
  if (prepared !== undefined) {
    const command = prepared.command, receipt = stored.response;
    if (receipt.commandId !== command.commandId || receipt.idempotencyKey !== command.idempotencyKey || receipt.targetSessionId !== command.targetSessionId
      || receipt.conversationId !== command.conversationId || receipt.evidenceIds.length !== command.frames.length) throw new RetainedEvidenceError("INTEGRITY_FAILURE");
  }
  return boundedRetainedJson({ ...stored, deduplicated: result.deduplicated, responseHash: result.responseHash }, RETAINED_EVIDENCE_LIMITS.resultBytes).snapshot as RetainedEvidenceWorkerSuccessV1;
}
/** The cap includes response correlation and all failure/success fields. */
export function decodeRetainedEvidenceWorkerResponse(value: unknown, id: string, prepared: PreparedRetainedEvidenceCommandV1):
  { id: string; ok: true; data: RetainedEvidenceWorkerSuccessV1 } | { id: string; ok: false; error: { code: string; message: string; details: Record<string, string> } } {
  const snapshot = boundedRetainedJson(value, RETAINED_EVIDENCE_LIMITS.resultBytes).snapshot;
  const response = retainedExactRecord(snapshot, ["id", "ok", ...(typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) && snapshot.ok === true ? ["data"] : ["error"])]);
  if (response.id !== id) throw new RetainedEvidenceError("INTEGRITY_FAILURE");
  if (response.ok === true) return { id, ok: true, data: decodeRetainedEvidenceWorkerSuccess(response.data, prepared) };
  if (response.ok !== false) throw new RetainedEvidenceError("INTEGRITY_FAILURE");
  const error = retainedExactRecord(response.error, ["code", "message", "details"]);
  const safeCodes = new Set<string>([...RETAINED_EVIDENCE_ERROR_CODES, "WORKER_PROTOCOL_ERROR", "WORKER_CLOSED", "PROJECT_ID_MISMATCH", "VAULT_ID_MISMATCH", "STORE_ID_MISMATCH", "PROJECT_BINDING_REQUIRED"]);
  if (typeof error.code !== "string" || !safeCodes.has(error.code) || error.message !== error.code) throw new RetainedEvidenceError("INTEGRITY_FAILURE");
  const detailsSnapshot = boundedRetainedJson(error.details, RETAINED_EVIDENCE_LIMITS.resultBytes).snapshot;
  if (detailsSnapshot === null || typeof detailsSnapshot !== "object" || Array.isArray(detailsSnapshot)) throw new RetainedEvidenceError("INTEGRITY_FAILURE");
  const details: Record<string, string> = {};
  for (const [key, item] of Object.entries(detailsSnapshot)) {
    if (!["commandId", "idempotencyKey"].includes(key) || typeof item !== "string" || item[14] !== "4") throw new RetainedEvidenceError("INTEGRITY_FAILURE");
    try { details[key] = parseCanonicalUuid(item, key); } catch { throw new RetainedEvidenceError("INTEGRITY_FAILURE"); }
  }
  return { id, ok: false, error: { code: error.code, message: error.code, details } };
}
