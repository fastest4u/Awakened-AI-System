import { createHash } from "node:crypto";
import { canonicalJson } from "../serialization/canonical-json.js";

function hashDomain(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\n${canonicalJson(value)}`, "utf8").digest("hex");
}

export const payloadHash = (value: unknown): string => hashDomain("project-memory/payload/v1", value);
export const commandHash = (value: unknown): string => hashDomain("project-memory/command/v1", value);
export const responseHash = (value: unknown): string => hashDomain("project-memory/response/v1", value);
export const eventHash = (value: unknown): string => hashDomain("project-memory/event/v1", value);
export const outboxHash = (value: unknown): string => hashDomain("project-memory/outbox/v1", value);

export interface InternalValidationPlannedWorkIdentity {
  readonly workflowId: string;
  readonly workflowGeneration: bigint;
  readonly resultId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
}

export interface InternalPhasePlannedWorkIdentity {
  readonly workflowId: string;
  readonly workflowGeneration: bigint;
  readonly sourcePhase: string;
  readonly action: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
}

function plannedGeneration(value: bigint): string {
  if (value < 1n || value > 9_223_372_036_854_775_807n) {
    throw new TypeError("workflowGeneration must fit positive SQLite int64");
  }
  return value.toString();
}

export function internalValidationPlannedWorkId(
  identity: InternalValidationPlannedWorkIdentity,
): string {
  return hashDomain("pm-lifecycle-internal-validation-work-v1", {
    workflowId: identity.workflowId,
    workflowGeneration: plannedGeneration(identity.workflowGeneration),
    resultId: identity.resultId,
    commandId: identity.commandId,
    idempotencyKey: identity.idempotencyKey,
  });
}

export function internalPhasePlannedWorkId(
  identity: InternalPhasePlannedWorkIdentity,
): string {
  return hashDomain("pm-lifecycle-internal-phase-work-v1", {
    workflowId: identity.workflowId,
    workflowGeneration: plannedGeneration(identity.workflowGeneration),
    sourcePhase: identity.sourcePhase,
    action: identity.action,
    commandId: identity.commandId,
    idempotencyKey: identity.idempotencyKey,
  });
}
