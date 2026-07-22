import type { CheckpointEvidenceCoverageV2 } from "./contracts/checkpoint.js";
import type { FinalEndingScopeBindingV1 } from "./contracts/session-end.js";
import { canonicalJson } from "../serialization/canonical-json.js";

export interface MinimumCheckpointCapacityInput {
  readonly evidenceCoverage: CheckpointEvidenceCoverageV2;
  readonly endingScopeBindings: readonly FinalEndingScopeBindingV1[];
}

export interface MinimumEndingScopeCapacityInput {
  readonly endingScopeBindings: readonly FinalEndingScopeBindingV1[];
}

const MAX_POSITION = "9223372036854775807";
const MAX_UUID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const MAX_HASH = "f".repeat(64);
const MAX_GIT_OBJECT = "f".repeat(64);
const MAX_TIMESTAMP = "9999-12-31T23:59:59.999Z";

function maximumUnknownString(maximumScalars: number): string {
  return "\u0000".repeat(maximumScalars);
}

function bytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function maximumLiveBinding(binding: FinalEndingScopeBindingV1): Readonly<Record<string, unknown>> {
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

function maximumCarryBinding(binding: FinalEndingScopeBindingV1): Readonly<Record<string, unknown>> {
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

function maximumBindingBytes(binding: FinalEndingScopeBindingV1): number {
  const carry = bytes(maximumCarryBinding(binding));
  if (binding.bindingKind === "carry-forward-ticket") return carry;
  return Math.max(bytes(maximumLiveBinding(binding)), carry);
}

function arrayUpperBound(lengths: readonly number[]): number {
  return 2 + Math.max(0, lengths.length - 1) + lengths.reduce((total, length) => total + length, 0);
}

function maximumChildSummary(binding: FinalEndingScopeBindingV1): Readonly<Record<string, unknown>> {
  const live = {
    childSessionId: binding.childSessionId,
    state: "completion-proposed",
    lastEventPosition: MAX_POSITION,
    streamVersion: MAX_POSITION,
    latestCheckpointId: MAX_UUID,
  };
  const carried = {
    childSessionId: binding.childSessionId,
    state: "transferred",
    lastEventPosition: MAX_POSITION,
    streamVersion: MAX_POSITION,
    latestCheckpointId: MAX_UUID,
  };
  return bytes(live) >= bytes(carried) ? live : carried;
}

export function minimumCheckpointUpperBound(input: MinimumCheckpointCapacityInput): number {
  const childSummaries = input.endingScopeBindings.map(maximumChildSummary);
  const checkpoint = {
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
      headCommit: MAX_GIT_OBJECT,
      dirtyWorktreeFingerprint: MAX_HASH,
    },
    childSummaries,
    evidenceCoverage: input.evidenceCoverage,
  };
  const futureRepresentationReserve = input.endingScopeBindings.reduce((total, binding, index) => {
    if (binding.bindingKind !== "current-child") return total;
    const summary = childSummaries[index];
    return total + Math.max(0, maximumBindingBytes(binding) - bytes(summary));
  }, 0);
  return bytes(checkpoint) + futureRepresentationReserve;
}

export function minimumFinalEndingScopeBindingsUpperBound(
  input: MinimumEndingScopeCapacityInput,
): number {
  return arrayUpperBound(input.endingScopeBindings.map(maximumBindingBytes));
}
