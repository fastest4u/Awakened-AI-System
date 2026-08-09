import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import type { ProjectId } from "../src/orchestrator/identity/contracts.js";
import type {
  SessionId,
  WorkflowId,
} from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import {
  SESSION_END_PHASE_COMMAND_NAMESPACE,
  SESSION_END_TRANSFER_TICKET_NAMESPACE,
  SESSION_END_WORKFLOW_NAMESPACE,
  sessionEndAutomaticTransferTicketId,
  sessionEndPhaseIdentityV1,
  sessionEndWorkflowId,
} from "../src/orchestrator/lifecycle/session-end-identifiers.js";
import { uuidV5 } from "../src/orchestrator/crypto/uuid-v5.js";

const SESSION_ID = "44444444-4444-4444-8444-444444444444" as SessionId;
const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const WORKFLOW_ID = "b6c2d359-82a6-567e-86c7-bf9e780cf20b" as WorkflowId;
const CHILD_SESSION_ID = "22222222-2222-4222-8222-222222222222" as SessionId;

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof LifecycleError && error.code === code;
}

function referenceUuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const nameBytes = Buffer.from(name, "utf8");
  const digest = createHash("sha1").update(namespaceBytes).update(nameBytes).digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalTuple(value: readonly JsonValue[]): string {
  return JSON.stringify(value);
}

describe("session end deterministic identities", () => {
  it("derives RFC and session-end UUIDv5 golden vectors", () => {
    assert.equal(
      uuidV5(
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        Buffer.from("www.widgets.com", "utf8"),
      ),
      "21f7f8de-8051-5b89-8680-0195ef798b6a",
    );
    assert.equal(
      SESSION_END_WORKFLOW_NAMESPACE,
      referenceUuidV5(
        "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
        "https://awakened-ai.system/memory-event-core/workflows",
      ),
    );
    assert.equal(
      sessionEndWorkflowId(SESSION_ID),
      "b6c2d359-82a6-567e-86c7-bf9e780cf20b",
    );
    assert.equal(
      sessionEndWorkflowId(SESSION_ID),
      referenceUuidV5(SESSION_END_WORKFLOW_NAMESPACE, `session-end/${SESSION_ID}`),
    );
    assert.throws(
      () => sessionEndWorkflowId(
        "44444444-4444-4444-8444-44444444444A" as SessionId,
      ),
      hasCode("LIFECYCLE_INPUT_INVALID"),
    );
  });

  it("derives stable internal phase command identities from canonical action bytes", () => {
    const action = Object.freeze({
      action: "carry-forward-child",
      childSessionId: CHILD_SESSION_ID,
    }) satisfies JsonValue;
    const tuple = canonicalTuple([PROJECT_ID, WORKFLOW_ID, 7, "requested", action]);
    const commandId = referenceUuidV5(SESSION_END_PHASE_COMMAND_NAMESPACE, tuple);
    const idempotencyKey = `lifecycle-phase-v1/${createHash("sha256").update(tuple, "utf8").digest("hex")}`;
    const plannedWorkId = createHash("sha256")
      .update("pm-lifecycle-phase-planned-work-v1\n", "utf8")
      .update(tuple, "utf8")
      .update(commandId, "utf8")
      .update(idempotencyKey, "utf8")
      .digest("hex");

    assert.deepEqual(sessionEndPhaseIdentityV1({
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 7,
      sourcePhase: "requested",
      action,
    }), { commandId, idempotencyKey, plannedWorkId });
  });

  it("derives automatic transfer tickets from the canonical child tuple", () => {
    assert.equal(
      SESSION_END_TRANSFER_TICKET_NAMESPACE,
      referenceUuidV5(
        "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
        "https://awakened-ai.system/memory-event-core/session-end-transfer-tickets",
      ),
    );
    const tuple = canonicalTuple([PROJECT_ID, WORKFLOW_ID, 7, CHILD_SESSION_ID]);
    const expected = referenceUuidV5(SESSION_END_TRANSFER_TICKET_NAMESPACE, tuple);
    assert.equal(
      sessionEndAutomaticTransferTicketId(PROJECT_ID, WORKFLOW_ID, 7, CHILD_SESSION_ID),
      expected,
    );
    assert.match(expected, /^[0-9a-f-]+$/u);
  });
});
