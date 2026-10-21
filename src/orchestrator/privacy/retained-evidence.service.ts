import type { AppendCommand, AppendResult, JsonValue } from "../contracts/event.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import { isPrimarySqliteBusy, type EventAppendTransaction, type PreparedEventAppend } from "../storage/event-append-transaction.js";
import type { EvidenceKeyProvider } from "./evidence-key-provider.js";
import { redactEvidence, type TrustedRedactionPolicyV1 } from "./redaction.js";
import { assertRetainedEvidenceCommitBundle, type RetainedEvidenceRepository, type RetainedEvidencePriorV1 } from "./retained-evidence.repository.js";
import type { RetainedEvidenceAuthorityVerifier, RetainedEvidenceInvocationV1 } from "./retained-evidence-authority.js";
import { RETAINED_EVIDENCE_ERROR_CODES, RetainedEvidenceError, decodeRetainedEvidenceReceipt, decodeRetainEvidenceBatch, type RetainedEvidenceReceiptV1, type RetainedEvidenceErrorCode } from "./evidence-contracts.js";
import { buildRetainedEvidenceIntent, RETAINED_EVIDENCE_ORIGINAL_DOMAIN, type RetainedEvidenceAuthoritySnapshotV1 } from "./retained-evidence-intent.js";
import { evidenceProviderCall, evidenceMacInput, evidenceMac, requireEvidenceKey } from "./evidence-key-provider.js";
import { sealEvidenceItem } from "./evidence-envelope.js";
import { decodeEvidenceBatchRetainedPayload, decodeRetainedEvidenceStoredResult } from "./retained-evidence-codec.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../serialization/canonical-json.js";
export type RetainedEvidenceFaultBoundary = "before-begin" | "after-event" | "after-blobs" | "after-head" | "after-auth" | "after-dedup" | "before-commit" | "after-commit-before-response";
export interface RetainedEvidenceFaultInjector { hit(boundary: RetainedEvidenceFaultBoundary, commandId: string, idempotencyKey: string): void; }
export interface RetainedEvidenceServiceOptions { readonly connection: SqliteConnection; readonly events: EventAppendTransaction; readonly repository: RetainedEvidenceRepository; readonly authority: RetainedEvidenceAuthorityVerifier; readonly provider: EvidenceKeyProvider; readonly policy: () => TrustedRedactionPolicyV1; readonly now: () => string; readonly faults?: RetainedEvidenceFaultInjector; }
export class RetainedEvidenceService {
  constructor(private readonly options: RetainedEvidenceServiceOptions) {}
  retain(invocation: RetainedEvidenceInvocationV1): AppendResult<RetainedEvidenceReceiptV1> {
    const { connection, authority, events, repository, provider } = this.options;
    const input = decodeRetainEvidenceBatch(invocation.input.command), command = input.command;
    const recovery = { commandId: command.commandId, idempotencyKey: command.idempotencyKey };
    const hit = (boundary: RetainedEvidenceFaultBoundary) => this.options.faults?.hit(boundary, command.commandId, command.idempotencyKey);
    let began = false, commitAttempted = false, commitSucceeded = false;
    let prepared: PreparedEventAppend<RetainedEvidenceReceiptV1> | undefined;
    const replay = (prior: RetainedEvidencePriorV1, current: RetainedEvidenceAuthoritySnapshotV1): AppendResult<RetainedEvidenceReceiptV1> => {
      // The authenticated prior fixes policy identity and all generation/scope fences.
      // Only its historical original-input MAC is needed; no policy, wrap or fingerprint work.
      if (canonicalJson(current) !== canonicalJson(prior.authorization)) throw new RetainedEvidenceError("SESSION_HANDLE_STALE");
      const scope = { projectId: current.projectId, storeId: current.storeId };
      let bytes: Buffer | undefined;
      try {
        const ref = requireEvidenceKey(provider, scope, "original-input-commitment", prior.witness.originalCommitmentKeyRef);
        bytes = evidenceMacInput(scope, ref, input.canonicalOriginalBytes.toString("utf8"));
        const commitment = evidenceMac(provider, scope, "original-input-commitment", ref, RETAINED_EVIDENCE_ORIGINAL_DOMAIN, bytes);
        if (!timingSafeEqual(Buffer.from(commitment, "hex"), Buffer.from(prior.witness.originalInputCommitment, "hex"))) throw new RetainedEvidenceError("IDEMPOTENCY_CONFLICT");
      } catch (error) {
        if (error instanceof RetainedEvidenceError && error.code === "RETAINED_EVIDENCE_KEY_UNAVAILABLE") throw new RetainedEvidenceError(error.code, recovery);
        throw error;
      } finally { bytes?.fill(0); }
      return events.result({ events: [prior.event], storedResponse: prior.result, responseHash: prior.responseHash }, true);
    };
    try {
      if (!input.canonicalOriginalBytes.equals(invocation.input.canonicalOriginalBytes)) throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
      const verified = authority.verify({ ...invocation, input });
      const admitted = authority.revalidate(verified);
      const prior = repository.findPrior(command.commandId, command.idempotencyKey);
      if (prior) {
        replay(prior, admitted);
        connection.exec("BEGIN IMMEDIATE"); began = true;
        events.assertAppendAllowed();
        const authoritativePrior = repository.findPrior(command.commandId, command.idempotencyKey);
        if (!authoritativePrior) throw new RetainedEvidenceError("INTEGRITY_FAILURE");
        const result = replay(authoritativePrior, authority.revalidate(verified));
        connection.exec("ROLLBACK"); began = false;
        return result;
      }
      events.assertAppendAllowed();
      const expectedHead = repository.readHead(command.targetSessionId, command.conversationId);
      repository.assertCanContinue(input, expectedHead);
      let policy: TrustedRedactionPolicyV1;
      try { policy = this.options.policy(); } catch { throw new RetainedEvidenceError("RETAINED_EVIDENCE_POLICY_UNAVAILABLE"); }
      const redacted = redactEvidence(input, policy);
      const scope = { projectId: admitted.projectId, storeId: admitted.storeId };
      const originalCommitmentKeyRef = evidenceProviderCall(() => provider.currentKey(scope, "original-input-commitment"));
      const fingerprintKeyRef = evidenceProviderCall(() => provider.currentKey(scope, "redacted-content-fingerprint"));
      const wrapKeyRef = evidenceProviderCall(() => provider.currentKey(scope, "data-key-wrap"));
      const witness = buildRetainedEvidenceIntent(input, admitted, policy, { originalCommitmentKeyRef, fingerprintKeyRef }, provider);
      const plan = events.planRetainedEvidenceIdentity(verified, command);
      const items = redacted.frames.map(frame => sealEvidenceItem({ formatVersion: 1, projectId: admitted.projectId,
        vaultId: admitted.vaultId, storeId: admitted.storeId, evidenceId: randomUUID(), eventId: plan.eventId,
        targetSessionId: command.targetSessionId, conversationId: command.conversationId, frameId: frame.frameId,
        mediaType: frame.mediaType, policyId: policy.policyId, policyVersion: policy.policyVersion }, frame, provider, { wrapKeyRef, fingerprintKeyRef }));
      const metadata = items.map(({ formatVersion: _v, algorithm: _a, nonce: _n, tag: _t, ciphertext: _c, wrappedKey: _k, ...item }) => item);
      const payload = decodeEvidenceBatchRetainedPayload({ formatVersion: 1, witness, items: metadata });
      const recordedAt = this.options.now();
      const receipt = decodeRetainedEvidenceReceipt({ resultVersion: 1, operation: "retain-evidence-batch", retentionFormat: "redacted-encrypted-v1",
        targetSessionId: command.targetSessionId, conversationId: command.conversationId, commandId: command.commandId,
        idempotencyKey: command.idempotencyKey, evidenceIds: items.map(item => item.binding.evidenceId), eventPosition: "1", finalStreamVersion: String(expectedHead === null ? 1n : BigInt(expectedHead.version) + 1n) });
      const append: AppendCommand<RetainedEvidenceReceiptV1> = { context: invocation.context, commandId: command.commandId,
        idempotencyKey: command.idempotencyKey, commandType: "retain-evidence-batch", correlationId: command.conversationId, agentId: "retained-evidence",
        expectedStreamVersion: expectedHead === null ? 0n : BigInt(expectedHead.version), streamId: `retained-evidence/${command.targetSessionId}/${command.conversationId}`,
        streamType: "retained-evidence", events: [{ eventType: "EvidenceBatchRetained", eventSchemaVersion: 1, occurredAt: recordedAt,
          visibilityScope: "session", sessionId: command.targetSessionId, ...(admitted.parentSessionId === null ? {} : { parentSessionId: admitted.parentSessionId }),
          confidence: "high", verificationStatus: "unverified", sourceRefs: [], evidenceRefs: receipt.evidenceIds,
          evidenceDigests: items.map(item => ({ ciphertextHash: item.ciphertextHash, keyedFingerprint: item.keyedFingerprint })), payload: payload as unknown as JsonValue }], outbox: [], publicResponse: receipt };
      prepared = events.prepareRetainedEvidence(plan, append, payload, items);
      hit("before-begin"); connection.exec("BEGIN IMMEDIATE"); began = true;
      const winner = repository.findPrior(command.commandId, command.idempotencyKey);
      if (winner) {
        events.assertAppendAllowed();
        const result = replay(winner, authority.revalidate(verified));
        connection.exec("ROLLBACK"); began = false;
        return result;
      }
      events.assertCommandIdAvailable(prepared); events.assertAppendAllowed();
      const currentAuthority = authority.revalidate(verified);
      const currentHead = repository.readHead(command.targetSessionId, command.conversationId);
      repository.assertCanContinue(input, currentHead);
      if (JSON.stringify(currentHead) !== JSON.stringify(expectedHead)) throw new RetainedEvidenceError("RETAINED_EVIDENCE_ORDER_CONFLICT");
      const planned = events.planPrepared(prepared), event = planned.events[0]!;
      const last = command.frames.at(-1)!;
      const bundle = { event, items, authorization: currentAuthority, expectedHead: currentHead,
        nextHead: { targetSessionId: command.targetSessionId, conversationId: command.conversationId, lastFrameId: last.frameId,
          lastOrdinal: last.ordinal, version: String(currentHead === null ? 1n : BigInt(currentHead.version) + 1n) } };
      // Retained planning is read-only; both complete guards run before even a stream row is inserted.
      assertRetainedEvidenceCommitBundle(bundle); decodeRetainedEvidenceStoredResult(planned.storedResponse);
      const committed = events.appendPlanned(planned); hit("after-event");
      repository.insertCommitted(bundle);
      events.insertDedup(prepared, committed, null); hit("after-dedup");
      const result = events.result(committed);
      decodeRetainedEvidenceStoredResult(committed.storedResponse);
      hit("before-commit"); commitAttempted = true; connection.exec("COMMIT"); commitSucceeded = true; began = false;
      hit("after-commit-before-response"); return result;
    } catch (error) {
      let rollbackFailed = false;
      if (began) try { connection.exec("ROLLBACK"); began = false; } catch { rollbackFailed = true; }
      if (commitSucceeded || rollbackFailed || (commitAttempted && !isPrimarySqliteBusy(error))) throw new RetainedEvidenceError("COMMAND_OUTCOME_UNKNOWN", recovery);
      if (error instanceof RetainedEvidenceError) throw error;
      if (isPrimarySqliteBusy(error)) throw new RetainedEvidenceError("SQLITE_BUSY");
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "RETAINED_EVIDENCE_UNAVAILABLE";
      throw new RetainedEvidenceError(RETAINED_EVIDENCE_ERROR_CODES.includes(code as RetainedEvidenceErrorCode) ? code as RetainedEvidenceErrorCode : "RETAINED_EVIDENCE_UNAVAILABLE");
    } finally {
      if (prepared) events.discardRetainedEvidence(prepared);
      input.canonicalOriginalBytes.fill(0); invocation.input.canonicalOriginalBytes.fill(0);
    }
  }
}
