import type { AppendCommand, AppendResult, JsonValue } from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import { EventStoreError, governedNotePlannedIds, isPrimarySqliteBusy, type EventAppendTransaction, type PreparedEventAppend } from "../storage/event-append-transaction.js";
import type { EvidenceKeyProvider } from "../privacy/evidence-key-provider.js";
import { redactGovernedNoteSummaryV1, type TrustedRedactionPolicyV1 } from "../privacy/redaction.js";
import type { GovernedNoteAuthorityVerifier, VerifiedGovernedNoteRecoveryAuthority } from "./authority.js";
import type { GovernedNotePriorV1, GovernedNoteRepository } from "./repository.js";
import { GovernedNoteProvenanceKeyUnavailable, type GovernedNoteProvenanceRepository } from "./provenance.repository.js";
import type { GovernedNoteClockV1, GovernedNoteStoredReceiptV1, PreparedGovernedNoteCreateV1, PreparedGovernedNoteRecoveryV1, GovernedNoteRecoveryResultV1 } from "./contracts.js";
import { GOVERNED_NOTE_ERROR_CODES, GovernedNoteError, isRecoveryIdErrorCode, type GovernedNoteErrorCode } from "./errors.js";
import { decodePreparedGovernedNoteCreateV1, encodePreparedGovernedNoteCreateV1, decodeGovernedNoteCreatedPayloadV1, decodePreparedGovernedNoteRecoveryV1, encodePreparedGovernedNoteRecoveryV1, decodeGovernedNoteRecoveryResultV1 } from "./codec.js";
import { assertGovernedNoteOriginalEquality, buildGovernedNoteOriginalCommitment, governedNoteSummaryHash } from "./intent.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { assertFreshStartConnectionAllowed } from "../fresh-start/fresh-start-admission.js";

export type GovernedNoteFaultPointV1 = "before-begin" | "after-note-event" | "after-source-event" | "after-dedup" | "before-commit" | "after-commit-before-response" | "recovery-before-final-verify" | "recovery-after-detach" | "recovery-before-commit";
export interface GovernedNoteFaultInjectorV1 { inject(point: GovernedNoteFaultPointV1): void; }
export interface GovernedNoteServiceOptions {
  readonly connection: SqliteConnection; readonly events: EventAppendTransaction;
  readonly repository: GovernedNoteRepository; readonly provenance: GovernedNoteProvenanceRepository;
  readonly authority: GovernedNoteAuthorityVerifier; readonly provider: EvidenceKeyProvider;
  readonly policy: () => TrustedRedactionPolicyV1; readonly clock: GovernedNoteClockV1;
  readonly faults?: GovernedNoteFaultInjectorV1;
}
// Cleanup uncertainty belongs to the actual connection, including a new service
// composed over it. Resource cleanup cannot erase this observation.
const uncertainRecoveryConnections = new WeakSet<SqliteConnection>();
export function hasUncertainGovernedRecoveryCleanup(connection: SqliteConnection): boolean {
  return uncertainRecoveryConnections.has(connection);
}
export class GovernedNoteService {
  constructor(private readonly options: GovernedNoteServiceOptions) {}
  recover(input: PreparedGovernedNoteRecoveryV1, context: ProjectContext): GovernedNoteRecoveryResultV1 {
    const owned = decodePreparedGovernedNoteRecoveryV1(encodePreparedGovernedNoteRecoveryV1(input));
    const { connection, authority, repository, faults } = this.options;
    if (hasUncertainGovernedRecoveryCleanup(connection)) throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");
    let handle: VerifiedGovernedNoteRecoveryAuthority | undefined;
    let candidate: GovernedNoteRecoveryResultV1 | undefined;
    let failure: GovernedNoteError | undefined;
    let transactionOpen = false, commitAttempted = false, rollbackFailed = false;
    const admit = () => assertFreshStartConnectionAllowed(connection, "command-recovery");
    const unavailable = () => new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");
    try {
      admit();
      handle = authority.verifyRecovery(owned, context);
      connection.exec("BEGIN DEFERRED"); transactionOpen = true;
      admit();
      authority.revalidateRecovery(handle);
      const prior = repository.findGovernedNotePrior(owned.request.commandId, owned.request.idempotencyKey);
      // Own and validate all nested data before the final clock observation. The
      // final success envelope is detached only after current authority passes.
      const result = decodeGovernedNoteRecoveryResultV1(prior
        ? { resultVersion: 1, operation: "recover-governed-note-result", outcome: "committed", receipt: { ...prior.result.response, replay: true } }
        : { resultVersion: 1, operation: "recover-governed-note-result", outcome: "not-found", commandId: owned.request.commandId, idempotencyKey: owned.request.idempotencyKey });
      faults?.inject("recovery-before-final-verify");
      admit();
      const current = authority.revalidateRecovery(handle), binding = authority.bindingForRecovery(handle);
      if (prior && (canonicalJson(current) !== canonicalJson(prior.witness.authority)
        || canonicalJson(binding) !== canonicalJson(prior.witness.binding))) throw new GovernedNoteError("SESSION_OWNERSHIP_MISMATCH");
      authority.assertRecoveryUnexpired(handle);
      candidate = Object.freeze({ ...result });
      faults?.inject("recovery-after-detach");
      faults?.inject("recovery-before-commit");
      // Admission remains held through disposition. Expiry alone after detach
      // does not revoke the authorization point or renew the bounded proof.
      admit();
      commitAttempted = true;
      connection.exec("COMMIT"); transactionOpen = false;
    } catch (error) {
      candidate = undefined;
      if (transactionOpen) {
        try { connection.exec("ROLLBACK"); transactionOpen = false; }
        catch { rollbackFailed = true; uncertainRecoveryConnections.add(connection); }
      }
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "GOVERNED_NOTE_UNAVAILABLE";
      // Read uncertainty never certifies a retry or another uncertain mutation.
      failure = commitAttempted || rollbackFailed || code === "SQLITE_BUSY" || isRecoveryIdErrorCode(code as GovernedNoteErrorCode)
        || !(GOVERNED_NOTE_ERROR_CODES as readonly string[]).includes(code)
        ? unavailable() : new GovernedNoteError(code as GovernedNoteErrorCode);
    } finally {
      if (handle) try { authority.discardRecovery(handle); }
      catch { candidate = undefined; failure = unavailable(); }
      handle = undefined;
    }
    if (failure) throw failure;
    if (!candidate) throw unavailable();
    return candidate;
  }
  create(input: PreparedGovernedNoteCreateV1, context: ProjectContext): AppendResult<GovernedNoteStoredReceiptV1> {
    const owned = decodePreparedGovernedNoteCreateV1(encodePreparedGovernedNoteCreateV1(input));
    const command = owned.command, ids = { commandId: command.commandId, idempotencyKey: command.idempotencyKey };
    const { connection, events, authority, repository, provenance, provider } = this.options;
    if (hasUncertainGovernedRecoveryCleanup(connection)) throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");
    let transactionOpen = false, commitAttempted = false, commitSucceeded = false, beginBusy = false, rollbackFailed = false;
    let prepared: PreparedEventAppend<GovernedNoteStoredReceiptV1> | undefined;
    let result: AppendResult<GovernedNoteStoredReceiptV1> | undefined, failure: Error | undefined;
    const unknown = () => new GovernedNoteError("COMMAND_OUTCOME_UNKNOWN", ids);
    // Only this directly observed SQL boundary can establish native busy origin.
    // An append/provider/fault exception with an errcode is not such evidence.
    const begin = () => {
      try { connection.exec("BEGIN IMMEDIATE"); transactionOpen = true; }
      catch (error) { beginBusy = isPrimarySqliteBusy(error); throw error; }
    };
    const rollback = () => {
      try { connection.exec("ROLLBACK"); transactionOpen = false; }
      catch (error) { rollbackFailed = true; throw error; }
    };
    const hit = (point: GovernedNoteFaultPointV1) => this.options.faults?.inject(point);
    try {
      const handle = authority.verifyCreate(owned, context);
      events.assertAppendAllowed();
      const replay = (prior: GovernedNotePriorV1) => {
        const current = authority.revalidateCreate(handle), binding = authority.bindingForCreate(handle);
        assertGovernedNoteOriginalEquality(command, current, binding, prior.witness, provider);
        return events.result({ events: prior.events, storedResponse: prior.result, responseHash: prior.responseHash }, true);
      };
      const prior = repository.findGovernedNotePrior(command.commandId, command.idempotencyKey);
      if (prior) {
        replay(prior);
        hit("before-begin"); begin(); events.assertAppendAllowed();
        const currentPrior = repository.findGovernedNotePrior(command.commandId, command.idempotencyKey);
        if (!currentPrior) throw new GovernedNoteError("INTEGRITY_FAILURE");
        result = replay(currentPrior);
        rollback();
      } else {
        const admitted = authority.revalidateCreate(handle), binding = authority.bindingForCreate(handle);
        const descriptors = provenance.validate(connection, command.provenance, admitted, binding, provider);
        let policy: TrustedRedactionPolicyV1;
        try { policy = this.options.policy(); } catch { throw new GovernedNoteError("GOVERNED_NOTE_POLICY_UNAVAILABLE"); }
        const redacted = redactGovernedNoteSummaryV1(command.summary, policy);
        let keyRef;
        try { keyRef = provider.currentKey({ projectId: admitted.projectId, storeId: admitted.storeId }, "original-input-commitment"); }
        catch { throw new GovernedNoteError("GOVERNED_NOTE_KEY_UNAVAILABLE", ids); }
        const originalInputCommitment = buildGovernedNoteOriginalCommitment(command, admitted, binding, keyRef, provider);
        // The owning transaction allocates all three IDs once. Never-prepared plans
        // have no discard API; scoped references are released on exit instead.
        const plan = events.planGovernedNoteIdentity(handle, command), plannedIds = governedNotePlannedIds(plan);
        const recordedAt = this.options.clock.now();
        const payload = decodeGovernedNoteCreatedPayloadV1({ formatVersion: 1, witness: {
          witnessVersion: 1, commandType: "create-governed-note", ...ids, ...plannedIds,
          recordKind: command.recordKind, confidence: command.confidence, authority: admitted, binding, provenance: descriptors,
          policyId: redacted.policyId, policyVersion: redacted.policyVersion, originalCommitmentKeyRef: keyRef,
          originalInputCommitment, summaryContentHash: governedNoteSummaryHash(redacted.summary), recordedAt,
        } });
        const witness = payload.witness;
        const source = { sourceVersion: 2, binding: { ...binding }, item: {
          itemId: plannedIds.recordId, normalizedKey: `governed-note/${command.recordKind}/${plannedIds.recordId}`,
          status: "candidate", confidence: command.confidence, verificationMethod: "governed-note-unverified-v1",
          validFrom: recordedAt, validTo: null, summary: redacted.summary, contentHash: witness.summaryContentHash,
          conflictGroupId: null, supersedingItemId: null, anchor: null,
        }, followUps: [], artifacts: [], entities: [], aliases: [], edges: [] };
        const headers = { occurredAt: recordedAt, visibilityScope: "session" as const, sessionId: admitted.targetSessionId,
          ...(admitted.parentSessionId === null ? {} : { parentSessionId: admitted.parentSessionId }),
          confidence: command.confidence, verificationStatus: "unverified" as const,
          sourceRefs: [...new Set(descriptors.map(p => p.sourceEventId))].sort(), evidenceRefs: [], evidenceDigests: [] };
        const append: AppendCommand<GovernedNoteStoredReceiptV1> = {
          context, ...ids, commandType: "create-governed-note", correlationId: command.commandId, agentId: "governed-note",
          streamId: `governed-note/${admitted.targetSessionId}/${plannedIds.recordId}`, streamType: "governed-note", expectedStreamVersion: 0n,
          events: [{ ...headers, eventType: "GovernedNoteCreated", eventSchemaVersion: 1, payload: payload as unknown as JsonValue },
            { ...headers, eventType: "MemorySourceRecorded", eventSchemaVersion: 3, payload: source }], outbox: [],
          publicResponse: { resultVersion: 1, operation: "create-governed-note", ...ids, recordId: plannedIds.recordId,
            recordKind: command.recordKind, status: "candidate", verificationStatus: "unverified", scope: { ...binding },
            sourceEventIds: [plannedIds.noteEventId, plannedIds.sourceEventId], terminalPosition: "1" },
        };
        prepared = events.prepareGovernedNote(plan, append, payload);
        hit("before-begin"); begin(); events.assertAppendAllowed();
        const current = authority.revalidateCreate(handle), currentBinding = authority.bindingForCreate(handle);
        const winner = repository.findGovernedNotePrior(command.commandId, command.idempotencyKey);
        if (winner) {
          result = replay(winner);
          rollback();
        } else {
          events.assertCommandIdAvailable(prepared);
          const currentDescriptors = provenance.validate(connection, command.provenance, current, currentBinding, provider);
          if (canonicalJson(currentDescriptors) !== canonicalJson(descriptors)) throw new GovernedNoteError("GOVERNED_NOTE_PROVENANCE_INELIGIBLE");
          const planned = events.planPrepared(prepared);
          // after-note-event is composed into this supplied transaction's actual
          // after-first-insert-before-commit injector, before the second event.
          const batch = events.appendPlanned(planned); hit("after-source-event");
          events.insertDedup(prepared, batch, null); hit("after-dedup");
          result = events.result(batch);
          hit("before-commit"); commitAttempted = true;
          connection.exec("COMMIT"); commitSucceeded = true; transactionOpen = false;
          hit("after-commit-before-response");
        }
      }
    } catch (error) {
      if (transactionOpen && !rollbackFailed) try { rollback(); } catch { /* Sticky uncertainty takes precedence below. */ }
      if (commitAttempted || commitSucceeded || rollbackFailed) failure = unknown();
      else if (beginBusy) failure = new EventStoreError("SQLITE_BUSY", { retryable: true });
      else if (error instanceof GovernedNoteProvenanceKeyUnavailable) failure = new GovernedNoteError("GOVERNED_NOTE_KEY_UNAVAILABLE", ids);
      else if (error instanceof GovernedNoteError && error.code !== "SQLITE_BUSY") failure = new GovernedNoteError(error.code, isRecoveryIdErrorCode(error.code) ? ids : null);
      else {
        const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "GOVERNED_NOTE_UNAVAILABLE";
        const safe = code !== "SQLITE_BUSY" && (GOVERNED_NOTE_ERROR_CODES as readonly string[]).includes(code) ? code as GovernedNoteErrorCode : "GOVERNED_NOTE_UNAVAILABLE";
        failure = new GovernedNoteError(safe, isRecoveryIdErrorCode(safe) ? ids : null);
      }
    } finally {
      // Intent helpers clear their owned original/MAC buffers in their own finally.
      // Discard revokes actual preparation; it does not erase managed strings.
      if (prepared) try { events.discardGovernedNote(prepared); }
      catch { if (!failure) failure = commitAttempted ? unknown() : new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE"); }
      prepared = undefined;
    }
    if (failure) throw failure;
    if (!result) throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");
    return result;
  }
}
