import type { ProjectContext } from "../identity/contracts.js";
import type { JsonValue } from "../contracts/event.js";
import { parseCanonicalTimestamp } from "./contracts/identifiers.js";
import {
  LifecycleOperationalStore,
  type WorkflowRecoveryOperationalWorkIdentity,
} from "./lifecycle-operational.store.js";
import { LifecycleError } from "./errors.js";
import type { SessionEndWorkflowRecoveryResultV1 } from "../storage/session-end.repository.js";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface LifecycleRecoveryScanInput {
  readonly context: ProjectContext;
  readonly workId: string;
  readonly ownerId: string;
  readonly fencingToken: bigint;
  readonly dueBefore: string;
  readonly limit: number;
}

export interface LifecycleRecoveryCoordinatorOptions {
  readonly operationalStore: LifecycleOperationalStore;
}

function invalid(): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
}

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function scanResult(value: unknown): SessionEndWorkflowRecoveryResultV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) integrity();
  const record = value as Record<string, unknown>;
  const expected = [
    "resultVersion",
    "integrityOk",
    "readOnly",
    "workflowCandidateCount",
    "outboxCandidateCount",
    "endingSessionCount",
    "expiredRootLeaseCount",
    "invariantFailureCodes",
  ];
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
    || record.resultVersion !== 1
    || typeof record.integrityOk !== "boolean"
    || record.readOnly !== true
    || !Array.isArray(record.invariantFailureCodes)
  ) integrity();
  const counts = [
    record.workflowCandidateCount,
    record.outboxCandidateCount,
    record.endingSessionCount,
    record.expiredRootLeaseCount,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || (count as number) < 0)) integrity();
  const invariantFailureCodes = record.invariantFailureCodes.map((code) => {
    if (typeof code !== "string" || code.length === 0 || Array.from(code).length > 128) integrity();
    return code;
  });
  return Object.freeze({
    resultVersion: 1,
    integrityOk: record.integrityOk,
    readOnly: true,
    workflowCandidateCount: counts[0] as number,
    outboxCandidateCount: counts[1] as number,
    endingSessionCount: counts[2] as number,
    expiredRootLeaseCount: counts[3] as number,
    invariantFailureCodes: Object.freeze(invariantFailureCodes),
  });
}

/**
 * Owns the fenced recovery scan.  The coordinator intentionally has no
 * repair methods: an integrity failure is information for an operator, never
 * permission to infer a semantic transition or claim mutable work.
 */
export class LifecycleRecoveryCoordinator {
  readonly #operationalStore: LifecycleOperationalStore;

  constructor(options: LifecycleRecoveryCoordinatorOptions) {
    if (options === null || typeof options !== "object"
      || typeof options.operationalStore?.execute !== "function") {
      integrity();
    }
    this.#operationalStore = options.operationalStore;
    Object.freeze(this);
  }

  execute(input: LifecycleRecoveryScanInput): SessionEndWorkflowRecoveryResultV1 {
    if (input === null || typeof input !== "object"
      || input.context?.binding === undefined
      || typeof input.context.binding.projectId !== "string"
      || !LOWER_UUID.test(input.context.binding.projectId)
      || typeof input.workId !== "string"
      || input.workId.length === 0
      || typeof input.ownerId !== "string"
      || input.ownerId.length === 0
      || typeof input.fencingToken !== "bigint"
      || input.fencingToken < 1n
      || !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > 1_000) invalid();
    const dueBefore = parseCanonicalTimestamp(input.dueBefore, "dueBefore");
    const work: WorkflowRecoveryOperationalWorkIdentity = Object.freeze({
      kind: "workflow-recovery",
      projectId: input.context.binding.projectId,
      workId: input.workId,
      operation: "recovery",
      ownerId: input.ownerId,
      claimToken: input.fencingToken,
    });
    const result = this.#operationalStore.execute(work, (transaction) => {
      const recover = transaction.workflows.recover;
      if (typeof recover !== "function") throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
      return recover({
        projectId: input.context.binding.projectId,
        dueBefore,
        limit: input.limit,
      }) as unknown as JsonValue;
    });
    return scanResult(result.publicResult);
  }

  scan(input: LifecycleRecoveryScanInput): SessionEndWorkflowRecoveryResultV1 {
    return this.execute(input);
  }
}
