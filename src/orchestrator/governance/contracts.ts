import type { ProjectContext } from "../identity/contracts.js";
import type { ErasureFenceRecordV1, OperationalKeyCustodyProvider } from "../keys/operational-key-custody.js";
import type { CanonicalConflictProjectionRowV1, ProjectionItemStatus } from "../projections/contracts.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";

export type EvidenceErasureFenceV1 = ErasureFenceRecordV1;

export type GovernedVerificationPolicyMethodV1 =
  | "test-verified"
  | "source-anchored"
  | "source-verified"
  | "user-confirmed"
  | "accepted-adr"
  | "cross-session-observation"
  | "governed-note-test-verified-v1"
  | "governed-note-source-anchored-v1"
  | "governed-note-source-verified-v1"
  | "governed-note-user-confirmed-v1"
  | "governed-note-accepted-adr-v1"
  | "governed-note-cross-session-v1"
  | "governed-note-test-verified-v2"
  | "governed-note-source-anchored-v2"
  | "governed-note-source-verified-v2"
  | "governed-note-user-confirmed-v2"
  | "governed-note-accepted-adr-v2"
  | "governed-note-cross-session-v2";

export type GovernedLifecycleErrorCode =
  | "GOVERNED_LIFECYCLE_INVALID"
  | "GOVERNED_RECORD_NOT_FOUND"
  | "GOVERNED_TRANSITION_ILLEGAL"
  | "GOVERNED_VERIFICATION_POLICY_DENIED"
  | "GOVERNED_CONFLICT_INVALID"
  | "GOVERNED_ERASURE_INVALID"
  | "IDEMPOTENCY_CONFLICT";

export interface GovernedLifecycleServiceOptions {
  readonly connection: SqliteConnection;
  readonly context: ProjectContext;
  readonly custody?: OperationalKeyCustodyProvider;
  readonly now?: () => string;
}

export interface PromoteGovernedRecordCommandV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly sessionId?: string | null;
  readonly recordId: string;
  readonly targetStatus: "provisional" | "verified" | "conflicted";
  readonly verificationMethod: GovernedVerificationPolicyMethodV1;
  readonly verificationAnchor?: string | null;
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly conflictKey?: string | null;
  readonly conflictGroupId?: string | null;
  readonly conflictingRecordIds?: readonly string[];
  readonly resolutionState?: "open" | "resolved";
  readonly resolutionEventId?: string | null;
  readonly reason?: string;
  readonly occurredAt?: string;
}

export interface SupersedeGovernedRecordCommandV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly sessionId?: string | null;
  readonly recordId: string;
  readonly replacementRecordId?: string | null;
  readonly supersedingRecordId?: string | null;
  readonly reason: string;
  readonly validTo?: string | null;
  readonly verificationAnchor?: string | null;
  readonly conflictKey?: string | null;
  readonly conflictGroupId?: string | null;
  readonly declareConflict?: boolean;
  readonly resolutionState?: "open" | "resolved";
  readonly occurredAt?: string;
}

export interface RetractGovernedRecordCommandV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly sessionId?: string | null;
  readonly recordId: string;
  readonly reason: string;
  readonly validTo?: string | null;
  readonly verificationAnchor?: string | null;
  readonly occurredAt?: string;
}

export interface ExpireGovernedRecordCommandV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly sessionId?: string | null;
  readonly recordId: string;
  readonly validTo: string;
  readonly reason: string;
  readonly verificationAnchor?: string | null;
  readonly occurredAt?: string;
}

export interface ForgetEvidenceCommandV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly sessionId?: string | null;
  readonly evidenceIds: readonly string[];
  readonly recordIds?: readonly string[];
  readonly reason: string;
  readonly occurredAt?: string;
}

export interface GovernedLifecycleMutationReceiptV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly globalPosition: bigint;
  readonly streamVersion: bigint;
  readonly recordId: string;
  readonly targetStatus: ProjectionItemStatus;
  readonly verificationMethod: string | null;
  readonly verificationAnchor: string | null;
  readonly validTo: string | null;
  readonly conflictKey: string | null;
  readonly conflictGroupId: string | null;
  readonly resolutionState: "open" | "resolved" | null;
  readonly resolutionEventId: string | null;
  readonly supersededByEventId: string | null;
  readonly supersedingRecordId: string | null;
  readonly retractedByEventId: string | null;
  readonly replayed: boolean;
}

export interface ForgetEvidenceReceiptV1 extends GovernedLifecycleMutationReceiptV1 {
  readonly erasedEvidenceIds: readonly string[];
  readonly erasedRecordIds: readonly string[];
  readonly erasureFences: readonly EvidenceErasureFenceV1[];
}

export type { CanonicalConflictProjectionRowV1 };
