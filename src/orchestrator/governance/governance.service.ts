import { createHash } from "node:crypto";
import type { AppendCommand, JsonValue } from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import type { ErasureFenceRecordV1, OperationalKeyCustodyProvider } from "../keys/operational-key-custody.js";
import type { CanonicalConflictProjectionRowV1, ProjectBinding, ProjectionItemStatus } from "../projections/contracts.js";
import { BranchScopeRepository } from "../storage/branch-scope.repository.js";
import {
  EventAppendTransaction,
  EventStoreError,
  SqliteEventAppendStatements,
} from "../storage/event-append-transaction.js";
import { MaintenanceFence } from "../storage/maintenance-fence.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import type {
  ExpireGovernedRecordCommandV1,
  ForgetEvidenceCommandV1,
  ForgetEvidenceReceiptV1,
  GovernedLifecycleErrorCode,
  GovernedLifecycleMutationReceiptV1,
  GovernedLifecycleServiceOptions,
  GovernedVerificationPolicyMethodV1,
  PromoteGovernedRecordCommandV1,
  RetractGovernedRecordCommandV1,
  SupersedeGovernedRecordCommandV1,
} from "./contracts.js";

export * from "./contracts.js";

export class GovernedLifecycleError extends Error {
  constructor(
    public readonly code: GovernedLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GovernedLifecycleError";
  }
}

const ALLOWED_STATUS_TRANSITIONS: Readonly<
  Record<ProjectionItemStatus, readonly ProjectionItemStatus[]>
> = Object.freeze({
  candidate: Object.freeze([
    "provisional",
    "verified",
    "conflicted",
    "superseded",
    "retracted",
    "expired",
    "erased-evidence",
  ] as const),
  provisional: Object.freeze([
    "verified",
    "conflicted",
    "superseded",
    "retracted",
    "expired",
    "erased-evidence",
  ] as const),
  verified: Object.freeze([
    "conflicted",
    "superseded",
    "retracted",
    "expired",
    "erased-evidence",
  ] as const),
  conflicted: Object.freeze([
    "verified",
    "superseded",
    "retracted",
    "expired",
    "erased-evidence",
  ] as const),
  superseded: Object.freeze(["erased-evidence"] as const),
  retracted: Object.freeze(["erased-evidence"] as const),
  expired: Object.freeze(["erased-evidence"] as const),
  "erased-evidence": Object.freeze([] as const),
});

interface StoredRecordState {
  readonly recordId: string;
  readonly normalizedKey: string;
  readonly recordKind: string | null;
  readonly summary: string;
  readonly status: ProjectionItemStatus;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly verificationMethod: string;
  readonly conflictGroupId: string | null;
  readonly supersedingItemId: string | null;
  readonly noteVersion: 1 | 2 | null;
  readonly sourceEventId: string;
  readonly sessionId: string | null;
  readonly parentSessionId: string | null;
}

function deterministicUuidV4(namespace: string, value: string): string {
  const hex = createHash("sha256").update(`${namespace}:${value}`, "utf8").digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function normalizePolicyKind(
  method: GovernedVerificationPolicyMethodV1,
): "test-verified" | "source-anchored" | "user-confirmed" | "accepted-adr" | "cross-session-observation" {
  switch (method) {
    case "test-verified":
    case "governed-note-test-verified-v1":
    case "governed-note-test-verified-v2":
      return "test-verified";
    case "source-anchored":
    case "governed-note-source-anchored-v1":
    case "governed-note-source-anchored-v2":
    case "source-verified":
    case "governed-note-source-verified-v1":
    case "governed-note-source-verified-v2":
      return "source-anchored";
    case "user-confirmed":
    case "governed-note-user-confirmed-v1":
    case "governed-note-user-confirmed-v2":
      return "user-confirmed";
    case "accepted-adr":
    case "governed-note-accepted-adr-v1":
    case "governed-note-accepted-adr-v2":
      return "accepted-adr";
    case "cross-session-observation":
    case "governed-note-cross-session-v1":
    case "governed-note-cross-session-v2":
      return "cross-session-observation";
    default:
      throw new GovernedLifecycleError("GOVERNED_LIFECYCLE_INVALID", "Unsupported verificationMethod");
  }
}

function resolveMarkerForRecord(
  policyKind: "test-verified" | "source-anchored" | "user-confirmed" | "accepted-adr" | "cross-session-observation",
  noteVersion: 1 | 2 | null,
): string {
  if (noteVersion === 2) {
    switch (policyKind) {
      case "test-verified":
        return "governed-note-test-verified-v2";
      case "source-anchored":
        return "governed-note-source-anchored-v2";
      case "user-confirmed":
        return "governed-note-user-confirmed-v2";
      case "accepted-adr":
        return "governed-note-accepted-adr-v2";
      case "cross-session-observation":
        return "governed-note-cross-session-v2";
    }
  }
  if (noteVersion === 1) {
    switch (policyKind) {
      case "test-verified":
        return "governed-note-test-verified-v1";
      case "source-anchored":
        return "governed-note-source-anchored-v1";
      case "user-confirmed":
        return "governed-note-user-confirmed-v1";
      case "accepted-adr":
        return "governed-note-accepted-adr-v1";
      case "cross-session-observation":
        return "governed-note-cross-session-v1";
    }
  }
  return policyKind;
}

const HIGH_RISK_PATTERN =
  /\[(?:security|auth|secrets|deployment|schema|migration|destructive-ops)\]|\b(?:security|auth|secrets|deployment|schema|migration|destructive-ops)\b/iu;

function isHighRiskRecord(record: StoredRecordState): boolean {
  if (record.recordKind === "adr" || record.normalizedKey.startsWith("governed-note/adr/")) {
    return true;
  }
  return HIGH_RISK_PATTERN.test(record.summary) || HIGH_RISK_PATTERN.test(record.normalizedKey);
}

export class GovernedLifecycleService {
  readonly #connection: SqliteConnection;
  readonly #context: ProjectContext;
  readonly #custody: OperationalKeyCustodyProvider | undefined;
  readonly #now: () => string;

  constructor(options: GovernedLifecycleServiceOptions) {
    this.#connection = options.connection;
    this.#context = options.context;
    this.#custody = options.custody;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  promote(input: PromoteGovernedRecordCommandV1): GovernedLifecycleMutationReceiptV1 {
    const record = this.#loadRecordState(input.recordId, input.commandId);
    if (
      record.status !== input.targetStatus
      && !ALLOWED_STATUS_TRANSITIONS[record.status].includes(input.targetStatus)
    ) {
      throw new GovernedLifecycleError(
        "GOVERNED_TRANSITION_ILLEGAL",
        `Cannot transition governed record ${input.recordId} from ${record.status} to ${input.targetStatus}`,
      );
    }

    const policyKind = normalizePolicyKind(input.verificationMethod);
    if (input.targetStatus === "verified" && isHighRiskRecord(record)) {
      if (policyKind === "cross-session-observation") {
        throw new GovernedLifecycleError(
          "GOVERNED_VERIFICATION_POLICY_DENIED",
          `High-risk record ${input.recordId} cannot be promoted to verified via cross-session-observation`,
        );
      }
      if (typeof input.verificationAnchor !== "string" || input.verificationAnchor.trim().length === 0) {
        throw new GovernedLifecycleError(
          "GOVERNED_VERIFICATION_POLICY_DENIED",
          "High-risk verified promotion requires a non-empty verificationAnchor",
        );
      }
    }

    const verificationMethod = resolveMarkerForRecord(policyKind, record.noteVersion);
    const occurredAt = input.occurredAt ?? this.#now();
    const eventId = deterministicUuidV4("governed-lifecycle-event/v1", input.commandId);
    const conflictKey = input.conflictKey ?? null;
    const conflictGroupId = input.conflictGroupId
      ?? (conflictKey !== null
        ? deterministicUuidV4("governed-conflict-group/v1", conflictKey)
        : record.conflictGroupId);
    const resolutionState = conflictKey !== null
      ? input.resolutionState ?? (input.targetStatus === "verified" ? "resolved" : "open")
      : null;
    const resolutionEventId = conflictKey !== null && resolutionState === "resolved"
      ? input.resolutionEventId ?? eventId
      : null;
    const reason = input.reason ?? `Promoted to ${input.targetStatus} via ${verificationMethod}`;

    const payload: Record<string, JsonValue> = {
      recordId: input.recordId,
      targetStatus: input.targetStatus,
      verificationMethod,
      verificationAnchor: input.verificationAnchor ?? null,
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
      ...(conflictKey !== null
        ? {
            conflictKey,
            conflictGroupId,
            conflictingRecordIds: [...new Set([input.recordId, ...(input.conflictingRecordIds ?? [])])].sort(),
            resolutionState,
            resolutionEventId,
          }
        : {}),
      reason,
    };

    return this.#appendGovernanceTransition({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      commandType: "promote-governed-record",
      eventType: "GovernedRecordPromoted",
      eventId,
      record,
      sessionId: input.sessionId ?? record.sessionId,
      occurredAt,
      verificationStatus:
        input.targetStatus === "verified"
          ? "verified"
          : input.targetStatus === "conflicted"
            ? "conflicted"
            : "provisional",
      payload,
      receiptFields: {
        recordId: input.recordId,
        targetStatus: input.targetStatus,
        verificationMethod,
        verificationAnchor: input.verificationAnchor ?? null,
        validTo: input.validTo ?? record.validTo,
        conflictKey,
        conflictGroupId,
        resolutionState,
        resolutionEventId,
        supersededByEventId: null,
        supersedingRecordId: null,
        retractedByEventId: null,
      },
    });
  }

  promoteRecord(input: PromoteGovernedRecordCommandV1): GovernedLifecycleMutationReceiptV1 {
    return this.promote(input);
  }

  supersede(input: SupersedeGovernedRecordCommandV1): GovernedLifecycleMutationReceiptV1 {
    const record = this.#loadRecordState(input.recordId, input.commandId);
    const peerRecordId = input.replacementRecordId ?? input.supersedingRecordId ?? null;
    if (peerRecordId !== null && peerRecordId === input.recordId) {
      throw new GovernedLifecycleError("GOVERNED_CONFLICT_INVALID", "A record cannot supersede itself");
    }
    if (peerRecordId !== null) {
      this.#loadRecordState(peerRecordId, input.commandId);
    }

    const occurredAt = input.occurredAt ?? this.#now();
    const eventId = deterministicUuidV4("governed-lifecycle-event/v1", input.commandId);
    const conflictKey = input.conflictKey ?? null;
    const existingConflict = conflictKey !== null ? this.getConflict(conflictKey, input.commandId) : null;
    const conflictGroupId = input.conflictGroupId
      ?? existingConflict?.conflictGroupId
      ?? (conflictKey !== null
        ? deterministicUuidV4("governed-conflict-group/v1", conflictKey)
        : record.conflictGroupId);

    if (input.declareConflict === true) {
      if (
        record.status !== "conflicted"
        && !ALLOWED_STATUS_TRANSITIONS[record.status].includes("conflicted")
      ) {
        throw new GovernedLifecycleError(
          "GOVERNED_TRANSITION_ILLEGAL",
          `Cannot transition governed record ${input.recordId} from ${record.status} to conflicted`,
        );
      }
      const conflictingRecordIds = [
        ...new Set([
          ...(existingConflict?.recordIds ?? []),
          input.recordId,
          ...(peerRecordId !== null ? [peerRecordId] : []),
        ]),
      ].sort();
      const payload: Record<string, JsonValue> = {
        recordId: input.recordId,
        targetStatus: "conflicted",
        verificationAnchor: input.verificationAnchor ?? null,
        conflictKey,
        conflictGroupId,
        conflictingRecordIds,
        resolutionState: "open",
        resolutionEventId: null,
        reason: input.reason,
      };
      return this.#appendGovernanceTransition({
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        commandType: "declare-governed-conflict",
        eventType: "GovernedRecordPromoted",
        eventId,
        record,
        sessionId: input.sessionId ?? record.sessionId,
        occurredAt,
        verificationStatus: "conflicted",
        payload,
        receiptFields: {
          recordId: input.recordId,
          targetStatus: "conflicted",
          verificationMethod: record.verificationMethod,
          verificationAnchor: input.verificationAnchor ?? null,
          validTo: record.validTo,
          conflictKey,
          conflictGroupId,
          resolutionState: "open",
          resolutionEventId: null,
          supersededByEventId: null,
          supersedingRecordId: null,
          retractedByEventId: null,
        },
      });
    }

    if (
      record.status !== "superseded"
      && !ALLOWED_STATUS_TRANSITIONS[record.status].includes("superseded")
    ) {
      throw new GovernedLifecycleError(
        "GOVERNED_TRANSITION_ILLEGAL",
        `Cannot transition governed record ${input.recordId} from ${record.status} to superseded`,
      );
    }

    const validTo = input.validTo !== undefined ? input.validTo : occurredAt;
    const resolutionState = conflictKey !== null ? (input.resolutionState ?? "resolved") : null;
    const resolutionEventId = conflictKey !== null && resolutionState === "resolved" ? eventId : null;
    const conflictingRecordIds = conflictKey !== null
      ? [
          ...new Set([
            ...(existingConflict?.recordIds ?? []),
            input.recordId,
            ...(peerRecordId !== null ? [peerRecordId] : []),
          ]),
        ].sort()
      : undefined;

    const payload: Record<string, JsonValue> = {
      recordId: input.recordId,
      targetStatus: "superseded",
      supersededByEventId: eventId,
      supersedingRecordId: peerRecordId,
      validTo,
      verificationAnchor: input.verificationAnchor ?? null,
      ...(conflictKey !== null
        ? {
            conflictKey,
            conflictGroupId,
            conflictingRecordIds: conflictingRecordIds!,
            resolutionState,
            resolutionEventId,
          }
        : {}),
      reason: input.reason,
    };

    return this.#appendGovernanceTransition({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      commandType: "supersede-governed-record",
      eventType: "GovernedRecordSuperseded",
      eventId,
      record,
      sessionId: input.sessionId ?? record.sessionId,
      occurredAt,
      verificationStatus: "verified",
      payload,
      receiptFields: {
        recordId: input.recordId,
        targetStatus: "superseded",
        verificationMethod: record.verificationMethod,
        verificationAnchor: input.verificationAnchor ?? null,
        validTo,
        conflictKey,
        conflictGroupId,
        resolutionState,
        resolutionEventId,
        supersededByEventId: eventId,
        supersedingRecordId: peerRecordId,
        retractedByEventId: null,
      },
    });
  }

  supersedeRecord(input: SupersedeGovernedRecordCommandV1): GovernedLifecycleMutationReceiptV1 {
    return this.supersede(input);
  }

  retract(input: RetractGovernedRecordCommandV1): GovernedLifecycleMutationReceiptV1 {
    const record = this.#loadRecordState(input.recordId, input.commandId);
    if (
      record.status !== "retracted"
      && !ALLOWED_STATUS_TRANSITIONS[record.status].includes("retracted")
    ) {
      throw new GovernedLifecycleError(
        "GOVERNED_TRANSITION_ILLEGAL",
        `Cannot transition governed record ${input.recordId} from ${record.status} to retracted`,
      );
    }

    const occurredAt = input.occurredAt ?? this.#now();
    const validTo = input.validTo !== undefined ? input.validTo : occurredAt;
    const eventId = deterministicUuidV4("governed-lifecycle-event/v1", input.commandId);
    const payload: Record<string, JsonValue> = {
      recordId: input.recordId,
      targetStatus: "retracted",
      retractedByEventId: eventId,
      validTo,
      verificationAnchor: input.verificationAnchor ?? null,
      reason: input.reason,
    };

    return this.#appendGovernanceTransition({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      commandType: "retract-governed-record",
      eventType: "GovernedRecordRetracted",
      eventId,
      record,
      sessionId: input.sessionId ?? record.sessionId,
      occurredAt,
      verificationStatus: "unverified",
      payload,
      receiptFields: {
        recordId: input.recordId,
        targetStatus: "retracted",
        verificationMethod: record.verificationMethod,
        verificationAnchor: input.verificationAnchor ?? null,
        validTo,
        conflictKey: null,
        conflictGroupId: record.conflictGroupId,
        resolutionState: null,
        resolutionEventId: null,
        supersededByEventId: null,
        supersedingRecordId: record.supersedingItemId,
        retractedByEventId: eventId,
      },
    });
  }

  retractRecord(input: RetractGovernedRecordCommandV1): GovernedLifecycleMutationReceiptV1 {
    return this.retract(input);
  }

  expire(input: ExpireGovernedRecordCommandV1): GovernedLifecycleMutationReceiptV1 {
    const record = this.#loadRecordState(input.recordId, input.commandId);
    if (
      record.status !== "expired"
      && !ALLOWED_STATUS_TRANSITIONS[record.status].includes("expired")
    ) {
      throw new GovernedLifecycleError(
        "GOVERNED_TRANSITION_ILLEGAL",
        `Cannot transition governed record ${input.recordId} from ${record.status} to expired`,
      );
    }

    const occurredAt = input.occurredAt ?? this.#now();
    const eventId = deterministicUuidV4("governed-lifecycle-event/v1", input.commandId);
    const payload: Record<string, JsonValue> = {
      recordId: input.recordId,
      targetStatus: "expired",
      validTo: input.validTo,
      verificationAnchor: input.verificationAnchor ?? null,
      reason: input.reason,
    };

    return this.#appendGovernanceTransition({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      commandType: "expire-governed-record",
      eventType: "GovernedRecordExpired",
      eventId,
      record,
      sessionId: input.sessionId ?? record.sessionId,
      occurredAt,
      verificationStatus: "unverified",
      payload,
      receiptFields: {
        recordId: input.recordId,
        targetStatus: "expired",
        verificationMethod: record.verificationMethod,
        verificationAnchor: input.verificationAnchor ?? null,
        validTo: input.validTo,
        conflictKey: null,
        conflictGroupId: record.conflictGroupId,
        resolutionState: null,
        resolutionEventId: null,
        supersededByEventId: null,
        supersedingRecordId: record.supersedingItemId,
        retractedByEventId: null,
      },
    });
  }

  expireRecord(input: ExpireGovernedRecordCommandV1): GovernedLifecycleMutationReceiptV1 {
    return this.expire(input);
  }

  forgetEvidence(input: ForgetEvidenceCommandV1): ForgetEvidenceReceiptV1 {
    if (input.evidenceIds.length === 0 && (!input.recordIds || input.recordIds.length === 0)) {
      throw new GovernedLifecycleError("GOVERNED_ERASURE_INVALID", "At least one evidenceId or recordId is required");
    }

    const erasedEvidenceIds = [...new Set(input.evidenceIds)].sort();
    const { recordIds: derivedRecordIds, sourceEventIdByEvidenceId } = this.#findRecordsCitingEvidence(
      erasedEvidenceIds,
      input.recordIds ?? [],
    );
    if (derivedRecordIds.length === 0) {
      throw new GovernedLifecycleError(
        "GOVERNED_RECORD_NOT_FOUND",
        "No governed records found matching the specified evidenceIds or recordIds",
      );
    }

    const derivedRecords = derivedRecordIds.map((id) => this.#loadRecordState(id, input.commandId));
    const primaryRecord = derivedRecords[0]!;
    const occurredAt = input.occurredAt ?? this.#now();
    const eventId = deterministicUuidV4("governed-lifecycle-event/v1", input.commandId);

    const erasureFences: ErasureFenceRecordV1[] = [];
    if (this.#custody !== undefined) {
      for (const evidenceId of erasedEvidenceIds) {
        erasureFences.push(
          this.#custody.recordErasureFence({
            erasureId: deterministicUuidV4("governed-erasure-fence/v1", `${input.commandId}:${evidenceId}`),
            projectId: this.#context.binding.projectId,
            storeId: this.#context.binding.storeId,
            evidenceId,
            sourceEventId: sourceEventIdByEvidenceId.get(evidenceId) ?? primaryRecord.sourceEventId,
            erasureEventId: eventId,
            reason: input.reason,
            erasedAt: occurredAt,
          }),
        );
      }
    }

    const payload: Record<string, JsonValue> = {
      recordId: primaryRecord.recordId,
      targetStatus: "erased-evidence",
      erasedEvidenceIds: [...erasedEvidenceIds],
      erasedRecordIds: [...derivedRecordIds],
      verificationAnchor: eventId,
      reason: input.reason,
    };

    const receipt = this.#appendGovernanceTransition({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      commandType: "forget-evidence",
      eventType: "EvidenceErased",
      eventId,
      record: primaryRecord,
      sessionId: input.sessionId ?? primaryRecord.sessionId,
      occurredAt,
      verificationStatus: "unverified",
      payload,
      receiptFields: {
        recordId: primaryRecord.recordId,
        targetStatus: "erased-evidence",
        verificationMethod: primaryRecord.noteVersion !== null ? "governed-note-erased-v1" : "erased-evidence",
        verificationAnchor: eventId,
        validTo: primaryRecord.validTo,
        conflictKey: null,
        conflictGroupId: primaryRecord.conflictGroupId,
        resolutionState: null,
        resolutionEventId: null,
        supersededByEventId: null,
        supersedingRecordId: primaryRecord.supersedingItemId,
        retractedByEventId: null,
      },
    });

    return Object.freeze({
      ...receipt,
      erasedEvidenceIds: Object.freeze(erasedEvidenceIds),
      erasedRecordIds: Object.freeze(derivedRecordIds),
      erasureFences: Object.freeze(erasureFences),
    });
  }

  getConflict(conflictKey: string, ignoreCommandId?: string): CanonicalConflictProjectionRowV1 | null {
    return this.listConflicts(ignoreCommandId).find((c) => c.conflictKey === conflictKey) ?? null;
  }

  listConflicts(ignoreCommandId?: string): readonly CanonicalConflictProjectionRowV1[] {
    const rows = this.#connection
      .prepare(
        `SELECT global_position, event_id, command_id, payload_json
         FROM events
         WHERE project_id = $projectId
           AND stream_type = 'governed-lifecycle'
         ORDER BY global_position ASC`,
      )
      .all({ $projectId: this.#context.binding.projectId });

    const conflicts = new Map<string, CanonicalConflictProjectionRowV1>();
    for (const row of rows) {
      if (ignoreCommandId !== undefined && String(row.command_id) === ignoreCommandId) continue;
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      if (typeof payload.conflictKey !== "string" || payload.conflictKey.length === 0) continue;
      const conflictKey = payload.conflictKey;
      const existing = conflicts.get(conflictKey);
      const conflictGroupId = typeof payload.conflictGroupId === "string"
        ? payload.conflictGroupId
        : existing?.conflictGroupId ?? String(row.event_id);
      const recordIds = [
        ...new Set([
          ...(existing?.recordIds ?? []),
          String(payload.recordId),
          ...(Array.isArray(payload.conflictingRecordIds) ? payload.conflictingRecordIds.map(String) : []),
        ]),
      ].sort();
      const resolutionState = payload.resolutionState === "resolved" ? "resolved" as const : "open" as const;
      const resolutionEventId = typeof payload.resolutionEventId === "string"
        ? payload.resolutionEventId
        : resolutionState === "resolved"
          ? String(row.event_id)
          : null;
      conflicts.set(
        conflictKey,
        Object.freeze({
          projectId: this.#context.binding.projectId,
          conflictKey,
          conflictGroupId,
          recordIds: Object.freeze(recordIds),
          resolutionState,
          resolutionEventId,
          updatedEventPosition: String(row.global_position),
        }),
      );
    }
    return Object.freeze([...conflicts.values()]);
  }

  #findRecordsCitingEvidence(
    evidenceIds: readonly string[],
    explicitRecordIds: readonly string[],
  ): {
    readonly recordIds: readonly string[];
    readonly sourceEventIdByEvidenceId: ReadonlyMap<string, string>;
  } {
    const matched = new Set<string>(explicitRecordIds);
    const sourceEventIdByEvidenceId = new Map<string, string>();
    if (evidenceIds.length === 0) {
      return {
        recordIds: Object.freeze([...matched].sort()),
        sourceEventIdByEvidenceId,
      };
    }

    const evidenceSet = new Set(evidenceIds);
    // 1. Find all retain-evidence-batch events that produced these evidenceIds
    const retainedEvents = this.#connection
      .prepare(
        `SELECT event_id, evidence_refs_json
         FROM events
         WHERE project_id = $projectId
           AND event_type = 'EvidenceBatchRetained'`,
      )
      .all({ $projectId: this.#context.binding.projectId });
    const retainedSourceEventIds = new Set<string>();
    for (const row of retainedEvents) {
      const eventId = String(row.event_id);
      const refs = JSON.parse(String(row.evidence_refs_json)) as string[];
      for (const id of refs) {
        if (evidenceSet.has(id)) {
          retainedSourceEventIds.add(eventId);
          sourceEventIdByEvidenceId.set(id, eventId);
        }
      }
    }

    // 2. Find all GovernedNoteCreated and MemorySourceRecorded events citing those evidenceIds or sourceEventIds
    const candidateRows = this.#connection
      .prepare(
        `SELECT event_type, event_schema_version, source_refs_json, evidence_refs_json, payload_json
         FROM events
         WHERE project_id = $projectId
           AND event_type IN ('GovernedNoteCreated', 'MemorySourceRecorded')
         ORDER BY global_position ASC`,
      )
      .all({ $projectId: this.#context.binding.projectId });

    for (const row of candidateRows) {
      const eventType = String(row.event_type);
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      const sourceRefs = JSON.parse(String(row.source_refs_json)) as string[];
      const evidenceRefs = JSON.parse(String(row.evidence_refs_json)) as string[];
      const citesEvidenceRef = evidenceRefs.some((id) => evidenceSet.has(id))
        || sourceRefs.some((id) => retainedSourceEventIds.has(id));

      if (eventType === "GovernedNoteCreated") {
        const witness = payload.witness as Record<string, unknown> | undefined;
        const provenance = Array.isArray(witness?.provenance)
          ? (witness.provenance as Array<Record<string, unknown>>)
          : [];
        const citesViaProvenance = provenance.some(
          (p) =>
            (p.kind === "retained-evidence" && typeof p.identity === "string" && evidenceSet.has(p.identity))
            || (typeof p.sourceEventId === "string" && retainedSourceEventIds.has(p.sourceEventId)),
        );
        if ((citesEvidenceRef || citesViaProvenance) && typeof witness?.recordId === "string") {
          matched.add(witness.recordId);
        }
      } else if (eventType === "MemorySourceRecorded" && citesEvidenceRef) {
        const item = payload.item as Record<string, unknown> | undefined;
        const itemId = typeof item?.itemId === "string"
          ? item.itemId
          : typeof payload.itemId === "string"
            ? payload.itemId
            : null;
        if (itemId !== null) matched.add(itemId);
      }
    }

    return {
      recordIds: Object.freeze([...matched].sort()),
      sourceEventIdByEvidenceId,
    };
  }

  #loadRecordState(recordId: string, ignoreCommandId?: string): StoredRecordState {
    const rows = this.#connection
      .prepare(
        `SELECT event_id, command_id, event_type, event_schema_version, session_id, parent_session_id, payload_json
         FROM events
         WHERE project_id = $projectId
           AND (
             event_type = 'MemorySourceRecorded'
             OR stream_type = 'governed-lifecycle'
           )
         ORDER BY global_position ASC`,
      )
      .all({ $projectId: this.#context.binding.projectId });

    let state: StoredRecordState | undefined;
    for (const row of rows) {
      if (ignoreCommandId !== undefined && String(row.command_id) === ignoreCommandId) continue;
      const eventType = String(row.event_type);
      const schemaVersion = Number(row.event_schema_version);
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      if (eventType === "MemorySourceRecorded") {
        const item = (schemaVersion >= 3 ? payload.item : payload) as Record<string, unknown> | undefined;
        if (!item || item.itemId !== recordId) continue;
        const normalizedKey = String(item.normalizedKey);
        const recordKind = typeof item.recordKind === "string"
          ? item.recordKind
          : normalizedKey.startsWith("governed-note/")
            ? normalizedKey.split("/")[1] ?? null
            : null;
        state = {
          recordId,
          normalizedKey,
          recordKind,
          summary: String(item.summary),
          status: item.status as ProjectionItemStatus,
          validFrom: String(item.validFrom),
          validTo: item.validTo === null || item.validTo === undefined ? null : String(item.validTo),
          verificationMethod: String(item.verificationMethod),
          conflictGroupId: typeof item.conflictGroupId === "string" ? item.conflictGroupId : null,
          supersedingItemId: typeof item.supersedingItemId === "string" ? item.supersedingItemId : null,
          noteVersion: schemaVersion === 4 ? 2 : schemaVersion === 3 ? 1 : null,
          sourceEventId: String(row.event_id),
          sessionId: row.session_id === null ? null : String(row.session_id),
          parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
        };
      } else if (state !== undefined) {
        const current: StoredRecordState = state;
        const erasedIds = Array.isArray(payload.erasedRecordIds)
          ? payload.erasedRecordIds.map(String)
          : [];
        if (eventType === "EvidenceErased" && (payload.recordId === recordId || erasedIds.includes(recordId))) {
          state = {
            ...current,
            status: "erased-evidence",
            summary: "[ERASED]",
            verificationMethod: current.noteVersion !== null ? "governed-note-erased-v1" : "erased-evidence",
            sourceEventId: String(row.event_id),
          };
        } else if (payload.recordId === recordId) {
          state = {
            ...current,
            status: (payload.targetStatus as ProjectionItemStatus) ?? current.status,
            verificationMethod:
              typeof payload.verificationMethod === "string"
                ? payload.verificationMethod
                : current.verificationMethod,
            validFrom: typeof payload.validFrom === "string" ? payload.validFrom : current.validFrom,
            validTo:
              payload.validTo === null
                ? null
                : typeof payload.validTo === "string"
                  ? payload.validTo
                  : current.validTo,
            conflictGroupId:
              payload.conflictGroupId === null
                ? null
                : typeof payload.conflictGroupId === "string"
                  ? payload.conflictGroupId
                  : current.conflictGroupId,
            supersedingItemId:
              payload.supersedingRecordId === null
                ? null
                : typeof payload.supersedingRecordId === "string"
                  ? payload.supersedingRecordId
                  : current.supersedingItemId,
            sourceEventId: String(row.event_id),
          };
        }
      }
    }

    if (state === undefined) {
      throw new GovernedLifecycleError("GOVERNED_RECORD_NOT_FOUND", `Governed record not found: ${recordId}`);
    }
    return state;
  }

  #appendGovernanceTransition(params: {
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly commandType: string;
    readonly eventType:
      | "GovernedRecordPromoted"
      | "GovernedRecordSuperseded"
      | "GovernedRecordRetracted"
      | "GovernedRecordExpired"
      | "EvidenceErased";
    readonly eventId: string;
    readonly record: StoredRecordState;
    readonly sessionId: string | null;
    readonly occurredAt: string;
    readonly verificationStatus: "unverified" | "provisional" | "verified" | "conflicted";
    readonly payload: Record<string, JsonValue>;
    readonly receiptFields: Omit<
      GovernedLifecycleMutationReceiptV1,
      "commandId" | "idempotencyKey" | "eventId" | "globalPosition" | "streamVersion" | "replayed"
    >;
  }): GovernedLifecycleMutationReceiptV1 {
    const projectId = this.#context.binding.projectId;
    const streamId = `governed-lifecycle/${params.record.recordId}`;
    const streamType = "governed-lifecycle";

    const priorDedup = this.#connection
      .prepare(
        `SELECT command_id, final_stream_version, committed_at
         FROM command_dedup
         WHERE project_id = $projectId AND idempotency_key = $idempotencyKey`,
      )
      .get({ $projectId: projectId, $idempotencyKey: params.idempotencyKey });

    let expectedStreamVersion = 0n;
    let recordedAt = params.occurredAt;
    if (priorDedup !== undefined) {
      expectedStreamVersion = BigInt(priorDedup.final_stream_version as bigint) - 1n;
      recordedAt = String(priorDedup.committed_at);
    } else {
      const streamRow = this.#connection
        .prepare(
          `SELECT current_version FROM streams WHERE project_id = $projectId AND stream_id = $streamId`,
        )
        .get({ $projectId: projectId, $streamId: streamId });
      expectedStreamVersion = streamRow !== undefined ? BigInt(streamRow.current_version as bigint) : 0n;
    }

    const publicResponse = {
      commandId: params.commandId,
      idempotencyKey: params.idempotencyKey,
      eventId: params.eventId,
      ...params.receiptFields,
    };

    const appendCommand: AppendCommand<typeof publicResponse> = {
      context: this.#context,
      commandId: params.commandId,
      idempotencyKey: params.idempotencyKey,
      commandType: params.commandType,
      correlationId: params.commandId,
      agentId: "governed-lifecycle",
      streamId,
      streamType,
      expectedStreamVersion,
      events: [
        {
          eventType: params.eventType,
          eventSchemaVersion: 1,
          occurredAt: params.occurredAt,
          visibilityScope: params.sessionId !== null ? "session" : "project",
          ...(params.sessionId !== null ? { sessionId: params.sessionId } : {}),
          ...(params.record.parentSessionId !== null ? { parentSessionId: params.record.parentSessionId } : {}),
          confidence: "high",
          verificationStatus: params.verificationStatus,
          sourceRefs: [params.record.sourceEventId],
          evidenceRefs: [],
          evidenceDigests: [],
          payload: params.payload,
        },
      ],
      outbox: [],
      publicResponse,
    };

    const tx = new EventAppendTransaction(
      this.#connection,
      new SqliteEventAppendStatements(this.#connection),
      new MaintenanceFence(),
      new BranchScopeRepository(),
      () => params.eventId,
    );

    try {
      const prepared = tx.prepare(appendCommand, recordedAt);
      const replay = tx.findReplay(prepared, null);
      if (replay !== null) {
        return Object.freeze({
          ...replay.response,
          globalPosition: replay.lastGlobalPosition,
          streamVersion: replay.finalStreamVersion,
          replayed: true,
        });
      }

      this.#connection.exec("BEGIN IMMEDIATE");
      try {
        tx.assertAppendAllowed();
        tx.assertCommandIdAvailable(prepared);
        const planned = tx.planPrepared(prepared);
        const batch = tx.appendPlanned(planned);
        tx.insertDedup(prepared, batch, null);
        const committed = tx.result(batch, false);
        this.#connection.exec("COMMIT");
        return Object.freeze({
          ...committed.response,
          globalPosition: committed.lastGlobalPosition,
          streamVersion: committed.finalStreamVersion,
          replayed: false,
        });
      } catch (innerError) {
        try {
          this.#connection.exec("ROLLBACK");
        } catch {
          // ignore rollback error
        }
        throw innerError;
      }
    } catch (error) {
      if (error instanceof EventStoreError && error.code === "IDEMPOTENCY_CONFLICT") {
        throw new GovernedLifecycleError("IDEMPOTENCY_CONFLICT", error.message);
      }
      throw error;
    }
  }
}

export { GovernedLifecycleService as GovernedLifecycleMutationService };
export type { ProjectBinding };
