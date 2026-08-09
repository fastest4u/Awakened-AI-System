import { createHash } from "node:crypto";
import { uuidV5 } from "../crypto/uuid-v5.js";
import type { JsonValue } from "../contracts/event.js";
import type { ProjectId } from "../identity/contracts.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type {
  SessionId,
  TransferTicketId,
  WorkflowId,
} from "./contracts/identifiers.js";
import {
  parseBoundedString,
  parseCanonicalUuid,
  parseInteger,
} from "./contracts/identifiers.js";
import { LifecycleError } from "./errors.js";

export const SESSION_END_WORKFLOW_NAMESPACE =
  "4af569cd-c120-5fc1-874a-d4640afc5977";
export const SESSION_END_PHASE_COMMAND_NAMESPACE =
  "a7b47792-6ad9-5b32-9f20-6f53f5dc2f31";
export const SESSION_END_TRANSFER_TICKET_NAMESPACE =
  "89378abd-6226-5669-ad6d-f24d4297935e";

export interface SessionEndPhaseIdentityInputV1 {
  readonly projectId: ProjectId;
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly sourcePhase: string;
  readonly action: JsonValue;
}

export interface SessionEndPhaseIdentityV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly plannedWorkId: string;
}

function invalid(field: string): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
}

function canonicalTupleBytes(value: readonly JsonValue[]): Buffer {
  try {
    return Buffer.from(canonicalJson(value), "utf8");
  } catch {
    return invalid("sessionEndIdentity");
  }
}

export function sessionEndWorkflowId(sessionId: SessionId): WorkflowId {
  const canonicalSessionId = parseCanonicalUuid(sessionId, "sessionId") as SessionId;
  const name = Buffer.from(`session-end/${canonicalSessionId}`, "utf8");
  try {
    return uuidV5(SESSION_END_WORKFLOW_NAMESPACE, name) as WorkflowId;
  } finally {
    name.fill(0);
  }
}

export function sessionEndPhaseIdentityV1(
  input: SessionEndPhaseIdentityInputV1,
): SessionEndPhaseIdentityV1 {
  const projectId = parseCanonicalUuid(input.projectId, "projectId") as ProjectId;
  const workflowId = parseCanonicalUuid(input.workflowId, "workflowId") as WorkflowId;
  const workflowGeneration = parseInteger(
    input.workflowGeneration,
    "workflowGeneration",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const sourcePhase = parseBoundedString(input.sourcePhase, "sourcePhase", 128);
  const actionBytes = canonicalTupleBytes([
    projectId,
    workflowId,
    workflowGeneration,
    sourcePhase,
    input.action,
  ]);
  let identityDigest: Buffer | undefined;
  let plannedDigest: Buffer | undefined;
  try {
    const commandId = uuidV5(SESSION_END_PHASE_COMMAND_NAMESPACE, actionBytes);
    identityDigest = createHash("sha256").update(actionBytes).digest();
    const idempotencyKey = `lifecycle-phase-v1/${identityDigest.toString("hex")}`;
    plannedDigest = createHash("sha256")
      .update("pm-lifecycle-phase-planned-work-v1\n", "utf8")
      .update(actionBytes)
      .update(commandId, "utf8")
      .update(idempotencyKey, "utf8")
      .digest();
    return Object.freeze({
      commandId,
      idempotencyKey,
      plannedWorkId: plannedDigest.toString("hex"),
    });
  } finally {
    actionBytes.fill(0);
    identityDigest?.fill(0);
    plannedDigest?.fill(0);
  }
}

export function sessionEndAutomaticTransferTicketId(
  projectId: ProjectId,
  workflowId: WorkflowId,
  workflowGeneration: number,
  childSessionId: SessionId,
): TransferTicketId {
  const tupleBytes = canonicalTupleBytes([
    parseCanonicalUuid(projectId, "projectId"),
    parseCanonicalUuid(workflowId, "workflowId"),
    parseInteger(
      workflowGeneration,
      "workflowGeneration",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    parseCanonicalUuid(childSessionId, "childSessionId"),
  ]);
  try {
    return uuidV5(SESSION_END_TRANSFER_TICKET_NAMESPACE, tupleBytes) as TransferTicketId;
  } finally {
    tupleBytes.fill(0);
  }
}
