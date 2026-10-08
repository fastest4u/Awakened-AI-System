import type { AppendResult, Confidence, StoredCommandResponse } from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import type { BoundedOperationAuthorization, SemanticCommandAuthorization } from "../lifecycle/contracts/commands.js";
import type { EvidenceKeyRefV1 } from "../privacy/evidence-key-provider.js";
import type { RetainedEvidenceAuthoritySnapshotV1 } from "../privacy/retained-evidence-intent.js";
import type { RetainedEvidenceRuntimeCreateInput } from "../privacy/retained-evidence-runtime.factory.js";
import type { ProjectBinding } from "../projections/contracts.js";

export const GOVERNED_NOTE_LIMITS = Object.freeze({ summaryBytes: 2048, provenance: 64, inputBytes: 8192, resultBytes: 16384, authorizationBytes: 16384, depth: 8, containers: 128, fields: 32, arrayElements: 64, scalarBytes: 2048, transportBytes: 4194304, sourceEventBytes: 262144, rules: 256, literalBytes: 2048, spans: 4096 });
export type CommandId = string;
export type IdempotencyKey = string;
export type OperationId = string;
export type RequestId = string;
export type RecordId = string;
export type GovernedNoteClockV1 = { now(): string; nowMs(): bigint };
export type GovernedNoteRecoveryIdsV1 = Readonly<{ commandId: string; idempotencyKey: string }>;
export type TrustedGovernedNoteTimingV1 = Readonly<{ requestTimeoutMs: number; closeTimeoutMs: number; recoveryProofLifetimeMs: number; maxPending: 128; executorLeaseMs: 15000; heartbeatIntervalMs: 5000; appendRetryDeadlineMs: number; sqliteBusyTimeoutMs: 5000 }>;
export type GovernedNoteCommandV1 = Readonly<{
  version: 1; operation: "create-governed-note"; commandId: string; idempotencyKey: string;
  recordKind: "session-log" | "insight" | "mistake" | "adr"; summary: string; confidence: Confidence;
  provenance: readonly Readonly<{ kind: "source-event" | "retained-evidence"; identity: string }>[];
}>;
export type GovernedNoteRecoveryV1 = Readonly<{ version: 1; operation: "recover-governed-note-result"; operationId: string; requestId: string; commandId: string; idempotencyKey: string; expiresAt: string }>;
export type GovernedNoteProtectedAuthorizationV1 = Extract<SemanticCommandAuthorization, { kind: "protected" }>;
export type PreparedGovernedNoteCreateV1 = Readonly<{ command: GovernedNoteCommandV1; authorization: GovernedNoteProtectedAuthorizationV1 }>;
export type PreparedGovernedNoteRecoveryV1 = Readonly<{ request: GovernedNoteRecoveryV1; authorization: BoundedOperationAuthorization }>;
export type PreparedGovernedNoteCreateWireV1 = Readonly<{ command: string; authorization: GovernedNoteProtectedAuthorizationV1 }>;
export type PreparedGovernedNoteRecoveryWireV1 = Readonly<{ request: string; authorization: BoundedOperationAuthorization }>;
/** A nonsecret recorded snapshot, never a capability handle. */
export type GovernedNoteAuthoritySnapshotV1 = Omit<RetainedEvidenceAuthoritySnapshotV1, "capabilityKind"> & Readonly<{ capabilityKind: "root-session-handle" | "child-session-handle" }>;
export type GovernedNoteProvenanceDescriptorV1 = Readonly<{ kind: GovernedNoteCommandV1["provenance"][number]["kind"]; identity: string; sourceEventId: string; sourceEventPosition: string; sourceEventHash: string; sourceCommandId: string; sourceIdempotencyKey: string }>;
export type GovernedNoteWitnessV1 = Readonly<{
  witnessVersion: 1; commandType: "create-governed-note"; commandId: string; idempotencyKey: string; recordId: string;
  recordKind: GovernedNoteCommandV1["recordKind"]; confidence: Confidence; authority: GovernedNoteAuthoritySnapshotV1;
  binding: ProjectBinding; provenance: readonly GovernedNoteProvenanceDescriptorV1[]; policyId: string; policyVersion: string;
  originalCommitmentKeyRef: EvidenceKeyRefV1; originalInputCommitment: string; summaryContentHash: string;
  noteEventId: string; sourceEventId: string; recordedAt: string;
}>;
export type GovernedNoteCreatedPayloadV1 = Readonly<{ formatVersion: 1; witness: GovernedNoteWitnessV1 }>;
/** JSON-compatible durable receipt: replay belongs only to the facade. */
export type GovernedNoteStoredReceiptV1 = {
  resultVersion: 1; operation: "create-governed-note"; commandId: string; idempotencyKey: string; recordId: string;
  recordKind: GovernedNoteCommandV1["recordKind"]; status: "candidate"; verificationStatus: "unverified";
  scope: { [K in keyof ProjectBinding]: ProjectBinding[K] }; sourceEventIds: [string, string]; terminalPosition: string;
};
export type GovernedNoteStoredResultV1 = StoredCommandResponse<GovernedNoteStoredReceiptV1>;
export type GovernedNoteReceiptV1 = GovernedNoteStoredReceiptV1 & { readonly replay: boolean };
export type GovernedNoteRecoveryResultV1 = Readonly<{ resultVersion: 1; operation: "recover-governed-note-result"; outcome: "committed"; receipt: GovernedNoteReceiptV1 }> | Readonly<{ resultVersion: 1; operation: "recover-governed-note-result"; outcome: "not-found"; commandId: string; idempotencyKey: string }>;
export type GovernedNoteCloseObservationV1 = Readonly<{ disposition: "graceful-confirmed" | "ownership-uncertain"; ownerId: string }>;
export interface GovernedNoteRuntime {
  create(prepared: PreparedGovernedNoteCreateV1, context: ProjectContext): AppendResult<GovernedNoteStoredReceiptV1>;
  recover(prepared: PreparedGovernedNoteRecoveryV1, context: ProjectContext): GovernedNoteRecoveryResultV1;
}
export interface GovernedNoteRuntimeFactoryPort { create(input: RetainedEvidenceRuntimeCreateInput): GovernedNoteRuntime }
export interface FreshGovernedNoteFixtureV1 { readonly __freshFixture: unique symbol }
export interface GovernedNoteOwnerPermitV1 { readonly __noteOwnerPermit: unique symbol }
export interface GovernedNoteRunV1 {
  open(fixture: FreshGovernedNoteFixtureV1): Promise<GovernedNoteOwnerPermitV1>;
  create(permit: GovernedNoteOwnerPermitV1, input: PreparedGovernedNoteCreateV1): Promise<GovernedNoteReceiptV1>;
  recover(permit: GovernedNoteOwnerPermitV1, input: PreparedGovernedNoteRecoveryV1): Promise<GovernedNoteRecoveryResultV1>;
  close(permit: GovernedNoteOwnerPermitV1): Promise<void>;
  reopen(permit: GovernedNoteOwnerPermitV1): Promise<GovernedNoteOwnerPermitV1>;
}
