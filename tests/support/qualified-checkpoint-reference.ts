import { createHash, createHmac } from "node:crypto";

function invalidReferenceJson(): never {
  throw new TypeError("REFERENCE_CANONICAL_JSON_INVALID");
}

export function referenceCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidReferenceJson();
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(referenceCanonicalJson).join(",")}]`;
  if (typeof value !== "object") return invalidReferenceJson();
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${referenceCanonicalJson(record[key])}`).join(",")}}`;
}

export function canonicalUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(referenceCanonicalJson(value), "utf8");
}

export function compareCanonicalUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function referenceCheckpointFingerprint(
  checkpointVersion: 1 | 2,
  checkpoint: unknown,
): string {
  return createHash("sha256")
    .update(`project-memory/checkpoint/v${checkpointVersion}\n`, "utf8")
    .update(referenceCanonicalJson(checkpoint), "utf8")
    .digest("hex");
}

export function unknownJsonStringUpperBound(maximumScalars: number): number {
  return 2 + (6 * maximumScalars);
}

export function referenceCoverageAccumulatorHmac(
  key: Uint8Array,
  accumulator: unknown,
): string {
  return createHmac("sha256", key)
    .update("pm-evidence-coverage-v1", "utf8")
    .update(Buffer.from([0]))
    .update(referenceCanonicalJson(accumulator), "utf8")
    .digest("hex");
}

interface ReferenceEndingScopeBinding {
  readonly bindingKind: "current-child" | "carry-forward-ticket";
  readonly childSessionId: string;
}

const MAX_POSITION = "9223372036854775807";
const MAX_UUID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const MAX_HASH = "f".repeat(64);
const MAX_TIMESTAMP = "9999-12-31T23:59:59.999Z";

function maximumUnknownString(maximumScalars: number): string {
  return "\0".repeat(maximumScalars);
}

function referenceMaximumLiveBinding(binding: ReferenceEndingScopeBinding): Record<string, unknown> {
  return {
    bindingVersion: 1,
    bindingKind: "current-child",
    childSessionId: binding.childSessionId,
    childState: "completion-proposed",
    lastEventPosition: MAX_POSITION,
    streamVersion: MAX_POSITION,
    checkpointId: MAX_UUID,
    checkpointEventPosition: MAX_POSITION,
    transferTicketId: null,
    transferTicketEventPosition: null,
  };
}

function referenceMaximumCarryBinding(binding: ReferenceEndingScopeBinding): Record<string, unknown> {
  return {
    bindingVersion: 1,
    bindingKind: "carry-forward-ticket",
    childSessionId: binding.childSessionId,
    childState: "transferred",
    lastEventPosition: MAX_POSITION,
    streamVersion: MAX_POSITION,
    checkpointId: MAX_UUID,
    checkpointEventPosition: MAX_POSITION,
    transferTicketId: MAX_UUID,
    transferTicketEventPosition: MAX_POSITION,
  };
}

function referenceMaximumBinding(binding: ReferenceEndingScopeBinding): Record<string, unknown> {
  const live = referenceMaximumLiveBinding(binding);
  const carry = referenceMaximumCarryBinding(binding);
  if (binding.bindingKind === "carry-forward-ticket") return carry;
  return canonicalUtf8Bytes(live) >= canonicalUtf8Bytes(carry) ? live : carry;
}

function referenceMaximumChildSummary(binding: ReferenceEndingScopeBinding): Record<string, unknown> {
  const live = {
    childSessionId: binding.childSessionId,
    state: "completion-proposed",
    lastEventPosition: MAX_POSITION,
    streamVersion: MAX_POSITION,
    latestCheckpointId: MAX_UUID,
  };
  const carried = { ...live, state: "transferred" };
  return canonicalUtf8Bytes(live) >= canonicalUtf8Bytes(carried) ? live : carried;
}

export function referenceMinimumCheckpointUpperBound(
  evidenceCoverage: unknown,
  endingScopeBindings: readonly ReferenceEndingScopeBinding[],
): number {
  const childSummaries = endingScopeBindings.map(referenceMaximumChildSummary);
  const maximumCheckpoint = {
    checkpointVersion: 2,
    checkpointId: MAX_UUID,
    sessionId: MAX_UUID,
    parentSessionId: MAX_UUID,
    baseEventPosition: MAX_POSITION,
    checkpointEventPosition: MAX_POSITION,
    createdAt: MAX_TIMESTAMP,
    creatorAgentId: maximumUnknownString(256),
    creatorClientInstanceId: maximumUnknownString(256),
    taskSummary: maximumUnknownString(1),
    completedItems: [],
    inProgressItems: [],
    blockers: [],
    nextActions: [],
    decisions: [],
    assumptions: [],
    unresolvedConflicts: [],
    filesTouched: [],
    artifactReferences: [],
    sourceReferences: [],
    commandResults: [],
    testResults: [],
    materialClaims: [],
    sourceState: {
      sourceStateScopeVersion: 1,
      workspaceId: MAX_HASH,
      branchRef: maximumUnknownString(1_024),
      headCommit: MAX_HASH,
      dirtyWorktreeFingerprint: MAX_HASH,
    },
    childSummaries,
    evidenceCoverage,
  };
  const futureRepresentationReserve = endingScopeBindings.reduce((total, binding, index) => {
    if (binding.bindingKind !== "current-child") return total;
    return total + Math.max(
      0,
      canonicalUtf8Bytes(referenceMaximumBinding(binding))
        - canonicalUtf8Bytes(childSummaries[index]),
    );
  }, 0);
  return canonicalUtf8Bytes(maximumCheckpoint) + futureRepresentationReserve;
}

export function referenceMinimumFinalEndingScopeBindingsUpperBound(
  endingScopeBindings: readonly ReferenceEndingScopeBinding[],
): number {
  return canonicalUtf8Bytes(endingScopeBindings.map(referenceMaximumBinding));
}
