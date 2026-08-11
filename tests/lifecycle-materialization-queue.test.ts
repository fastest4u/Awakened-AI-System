import assert from "node:assert/strict";
import test from "node:test";

import { decodeGenericPendingOutbox } from "../src/orchestrator/contracts/event.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";
import {
  decodeMaterializationProjectionInputV1,
  decodePendingLifecycleOutboxV1,
  type LifecycleMaterializationTriggerType,
} from "../src/orchestrator/lifecycle/materialization-queue.port.js";

const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const WORKFLOW_ID = "55555555-5555-4555-8555-555555555555";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "a".repeat(64);
const HASH_A = "b".repeat(64);
const HASH_B = "c".repeat(64);

const WORKFLOW_TRIGGERS = [
  "SessionCheckpointRecorded",
  "SessionEndAmended",
  "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated",
  "SessionEndCancelled",
  "SessionAbandoned",
  "SessionEnded",
] as const satisfies readonly LifecycleMaterializationTriggerType[];

function bindingOf(context: Record<string, unknown>): Record<string, unknown> {
  return context.binding as Record<string, unknown>;
}

function refreshProjectContextFingerprint(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const binding = bindingOf(context);
  binding.contextFingerprint = computeProjectContextFingerprint({
    generation: binding.generation,
    source: binding.source,
    projectId: binding.projectId,
    vaultId: binding.vaultId,
    storeId: binding.storeId,
    workspaceId: binding.workspaceId,
    clientNamespace: binding.clientNamespace,
    clientInstanceId: binding.clientInstanceId,
    actorRole: binding.actorRole,
    projectRoot: binding.projectRoot,
    vaultRoot: binding.vaultRoot,
    descriptorPath: binding.descriptorPath,
    storeRoute: binding.storeRoute,
    workspace: binding.workspace,
  } as Parameters<typeof computeProjectContextFingerprint>[0]);
  return context;
}

function projectContext(): Record<string, unknown> {
  const workspace = {
    kind: "non-git",
    workspaceRoot: "C:\\project",
    workspaceId: WORKSPACE_ID,
  };
  return refreshProjectContextFingerprint({
    binding: {
      projectBindingId: "77777777-7777-4777-8777-777777777777",
      generation: 1,
      contextFingerprint: HASH_A,
      source: "explicit-cli",
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "tests",
      clientInstanceId: "client-primary",
      actorRole: "primary",
      projectRoot: "C:\\project",
      vaultRoot: "C:\\project\\memory",
      descriptorPath: "C:\\project\\memory\\.project-memory.json",
      storeRoute: {
        kind: "vault-local",
        storeRoot: "C:\\project\\memory\\.project-memory",
        eventsPath: "C:\\project\\memory\\.project-memory\\events.sqlite",
        storeManifestPath: "C:\\project\\memory\\.project-memory\\store.json",
        projectionManifestPath: "C:\\project\\memory\\.project-memory\\projection.json",
      },
      workspace: structuredClone(workspace),
      establishedAt: "2026-08-09T00:00:00.000Z",
    },
    workspace,
    checkedAt: "2026-08-09T00:01:00.000Z",
  });
}

function gitProjectContext(headCommitLength: 40 | 64 = 64): Record<string, unknown> {
  const context = projectContext();
  const workspace = {
    kind: "git",
    worktreeRoot: "C:\\project",
    gitDir: "C:\\project\\.git\\worktrees\\main",
    gitCommonDir: "C:\\project\\.git",
    headCommit: "d".repeat(headCommitLength),
    branchRef: "refs/heads/main",
    detached: false,
    workspaceId: WORKSPACE_ID,
  };
  const binding = context.binding as Record<string, unknown>;
  binding.storeRoute = {
    ...(binding.storeRoute as Record<string, unknown>),
    kind: "git-common",
  };
  binding.workspace = structuredClone(workspace);
  context.workspace = workspace;
  context.branchScopeId = "66666666-6666-4666-8666-666666666666";
  return refreshProjectContextFingerprint(context);
}

function workflowOrigin(): Record<string, unknown> {
  return {
    kind: "workflow",
    workflowId: WORKFLOW_ID,
    workflowGeneration: 2,
  };
}

function terminalOrigin(): Record<string, unknown> {
  return {
    kind: "terminal-event",
    workflowId: null,
    workflowGeneration: null,
  };
}

function fingerprint(): Record<string, unknown> {
  return {
    algorithm: "hmac-sha256",
    schemaVersion: 1,
    keyId: "materialization-key-1",
    domain: "pm-materialization-fingerprint-v1",
    value: HASH_B,
  };
}

function pending(
  triggeringEventType: string = "SessionEndAmended",
  origin: Record<string, unknown> = workflowOrigin(),
): Record<string, unknown> {
  const materializationRevision = "7";
  const targetKey = `lifecycle-log/${SESSION_ID}/${materializationRevision}`;
  return {
    targetKey,
    kind: "materialize-lifecycle-log",
    eventIndex: 0,
    payload: {
      payloadVersion: 1,
      targetKey,
      sessionId: SESSION_ID,
      artifactKind: "compatibility-session-log",
      artifactPath: `05_Agent_Session_Logs/2026-08-09-session-${SESSION_ID}.md`,
      materializationRevision,
      triggeringPayloadHash: HASH_A,
      nextFingerprint: fingerprint(),
      origin,
      triggeringEventType,
    },
  };
}

function projection(
  triggeringEventType: string = "SessionEndAmended",
  origin: Record<string, unknown> = workflowOrigin(),
): Record<string, unknown> {
  return {
    context: projectContext(),
    sessionId: SESSION_ID,
    artifactKind: "compatibility-session-log",
    triggeringEventIndex: 0,
    expectedTriggerPosition: 7n,
    triggeringEventSchemaVersion: 3,
    triggeringOccurredAt: "2026-08-09T00:02:00.000Z",
    triggeringEventPayload: {
      nested: [{ accepted: true }],
      qualityScore: 0.75,
    },
    origin,
    triggeringEventType,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) assertDeepFrozen(descriptor.value, seen);
  }
}

function assertRejected(value: unknown): void {
  assert.throws(() => decodePendingLifecycleOutboxV1(value));
}

test("strict-decodes every lifecycle materialization trigger and origin pair", () => {
  for (const trigger of WORKFLOW_TRIGGERS) {
    const decoded = decodePendingLifecycleOutboxV1(pending(trigger));
    assert.equal(decoded.payload.triggeringEventType, trigger);
    assert.equal(decoded.payload.origin.kind, "workflow");
  }

  const direct = decodePendingLifecycleOutboxV1(
    pending("SessionAbandoned", terminalOrigin()),
  );
  assert.equal(direct.payload.origin.kind, "terminal-event");

  for (const trigger of WORKFLOW_TRIGGERS.filter((value) => value !== "SessionAbandoned")) {
    assertRejected(pending(trigger, terminalOrigin()));
  }

  assertRejected(pending("SessionEndInvented"));
  assertRejected(pending("SessionEndAmended", {
    kind: "unknown",
    workflowId: WORKFLOW_ID,
    workflowGeneration: 2,
  }));
  assertRejected(pending("SessionEndAmended", {
    kind: "workflow",
    workflowId: "NOT-A-UUID",
    workflowGeneration: 2,
  }));
  assertRejected(pending("SessionEndAmended", {
    kind: "workflow",
    workflowId: WORKFLOW_ID,
    workflowGeneration: 0,
  }));
  assertRejected(pending("SessionAbandoned", {
    kind: "terminal-event",
    workflowId: WORKFLOW_ID,
    workflowGeneration: null,
  }));
});

test("rejects lifecycle outbox event indexes other than zero", () => {
  for (const eventIndex of [-1, 1, 2, "0", 0n]) {
    const candidate = pending();
    candidate.eventIndex = eventIndex;
    assertRejected(candidate);
  }

  for (const triggeringEventIndex of [-1, 1, 2, "0", 0n]) {
    const candidate = projection();
    candidate.triggeringEventIndex = triggeringEventIndex;
    assert.throws(() => decodeMaterializationProjectionInputV1(candidate));
  }
});

test("rejects the lifecycle kind through the generic pending outbox branch", () => {
  const source = {
    targetKey: "generic/target",
    kind: "notify-observer",
    eventIndex: 2,
    payload: { nested: [true, 1, null] },
  };
  const decoded = decodeGenericPendingOutbox(source);
  assert.deepEqual(decoded, source);
  assert.notEqual(decoded, source);
  assertDeepFrozen(decoded);

  assert.throws(() => decodeGenericPendingOutbox({
    ...source,
    kind: "materialize-lifecycle-log",
  }));
});

test("deep-freezes the canonical lifecycle pending descriptor", () => {
  const source = pending();
  const decoded = decodePendingLifecycleOutboxV1(source);
  assert.notEqual(decoded, source);
  assert.notEqual(decoded.payload, source.payload);
  assertDeepFrozen(decoded);

  const sourcePayload = source.payload as Record<string, unknown>;
  const sourceOrigin = sourcePayload.origin as Record<string, unknown>;
  source.targetKey = "tampered";
  sourcePayload.artifactPath = "tampered.md";
  sourceOrigin.workflowGeneration = 99;
  assert.equal(
    decoded.targetKey,
    `lifecycle-log/${SESSION_ID}/7`,
  );
  assert.equal(
    decoded.payload.artifactPath,
    `05_Agent_Session_Logs/2026-08-09-session-${SESSION_ID}.md`,
  );
  assert.equal(decoded.payload.origin.workflowGeneration, 2);

  const projectionSource = projection();
  const projectionDecoded = decodeMaterializationProjectionInputV1(projectionSource);
  assert.notEqual(projectionDecoded.context, projectionSource.context);
  assert.notEqual(
    projectionDecoded.triggeringEventPayload,
    projectionSource.triggeringEventPayload,
  );
  assertDeepFrozen(projectionDecoded);
  const triggerPayload = projectionSource.triggeringEventPayload as {
    nested: Array<{ accepted: boolean }>;
  };
  triggerPayload.nested[0]!.accepted = false;
  assert.deepEqual(projectionDecoded.triggeringEventPayload, {
    nested: [{ accepted: true }],
    qualityScore: 0.75,
  });

  for (const headCommitLength of [40, 64] as const) {
    const gitProjection = projection();
    gitProjection.context = gitProjectContext(headCommitLength);
    const decodedGitProjection = decodeMaterializationProjectionInputV1(gitProjection);
    assert.equal(
      decodedGitProjection.context.branchScopeId,
      "66666666-6666-4666-8666-666666666666",
    );
    assert.equal(
      decodedGitProjection.context.workspace.kind === "git"
        ? decodedGitProjection.context.workspace.headCommit.length
        : 0,
      headCommitLength,
    );
    assertDeepFrozen(decodedGitProjection.context);
  }

  const malformedBindingIdentity = projection();
  const malformedBinding = (
    malformedBindingIdentity.context as Record<string, unknown>
  ).binding as Record<string, unknown>;
  malformedBinding.projectBindingId = "not-a-uuid";
  assert.throws(() => decodeMaterializationProjectionInputV1(malformedBindingIdentity));

  for (const revision of [
    "0", "00", "+1", "01", "1.0", 1, "9223372036854775808",
  ]) {
    const candidate = pending();
    (candidate.payload as Record<string, unknown>).materializationRevision = revision;
    assertRejected(candidate);
  }

  for (const key of ["triggeringEventIndex", "expectedPriorFingerprint"] as const) {
    const candidate = pending();
    (candidate.payload as Record<string, unknown>)[key] = key === "triggeringEventIndex" ? 0 : null;
    assertRejected(candidate);
  }
  const projectedPriorFingerprint = projection();
  projectedPriorFingerprint.expectedPriorFingerprint = null;
  assert.throws(() => decodeMaterializationProjectionInputV1(projectedPriorFingerprint));

  const targetMismatch = pending();
  targetMismatch.targetKey = "lifecycle-log/other/7";
  assertRejected(targetMismatch);
  const payloadTargetMismatch = pending();
  (payloadTargetMismatch.payload as Record<string, unknown>).targetKey = "other";
  assertRejected(payloadTargetMismatch);

  const malformedFingerprintCases: Array<Record<string, unknown>> = [
    { ...fingerprint(), algorithm: "sha256" },
    { ...fingerprint(), schemaVersion: 2 },
    { ...fingerprint(), keyId: "" },
    { ...fingerprint(), keyId: "k".repeat(129) },
    { ...fingerprint(), domain: "other" },
    { ...fingerprint(), value: "A".repeat(64) },
    { ...fingerprint(), extra: true },
  ];
  for (const nextFingerprint of malformedFingerprintCases) {
    const candidate = pending();
    (candidate.payload as Record<string, unknown>).nextFingerprint = nextFingerprint;
    assertRejected(candidate);
  }

  const unknownKeyCases: Array<{ value: Record<string, unknown>; decode: (value: unknown) => unknown }> = [];
  const pendingExtra = pending();
  pendingExtra.extra = true;
  unknownKeyCases.push({ value: pendingExtra, decode: decodePendingLifecycleOutboxV1 });
  const payloadExtra = pending();
  (payloadExtra.payload as Record<string, unknown>).extra = true;
  unknownKeyCases.push({ value: payloadExtra, decode: decodePendingLifecycleOutboxV1 });
  const originExtra = pending();
  ((originExtra.payload as Record<string, unknown>).origin as Record<string, unknown>).extra = true;
  unknownKeyCases.push({ value: originExtra, decode: decodePendingLifecycleOutboxV1 });
  const projectionExtra = projection();
  projectionExtra.extra = true;
  unknownKeyCases.push({ value: projectionExtra, decode: decodeMaterializationProjectionInputV1 });
  const contextExtra = projection();
  (contextExtra.context as Record<string, unknown>).extra = true;
  unknownKeyCases.push({ value: contextExtra, decode: decodeMaterializationProjectionInputV1 });
  const bindingExtra = projection();
  ((bindingExtra.context as Record<string, unknown>).binding as Record<string, unknown>).extra = true;
  unknownKeyCases.push({ value: bindingExtra, decode: decodeMaterializationProjectionInputV1 });
  const workspaceExtra = projection();
  ((workspaceExtra.context as Record<string, unknown>).workspace as Record<string, unknown>).extra = true;
  unknownKeyCases.push({ value: workspaceExtra, decode: decodeMaterializationProjectionInputV1 });
  const routeExtra = projection();
  const binding = (routeExtra.context as Record<string, unknown>).binding as Record<string, unknown>;
  (binding.storeRoute as Record<string, unknown>).extra = true;
  unknownKeyCases.push({ value: routeExtra, decode: decodeMaterializationProjectionInputV1 });
  for (const entry of unknownKeyCases) assert.throws(() => entry.decode(entry.value));

  assertRejected(Object.assign(Object.create({ inherited: true }), pending()));
  class PendingSubclass {}
  assertRejected(Object.assign(new PendingSubclass(), pending()));
  assertRejected([]);

  const symbolExtra = pending();
  Object.defineProperty(symbolExtra, Symbol("extra"), { value: true, enumerable: true });
  assertRejected(symbolExtra);
  const hiddenExtra = pending();
  Object.defineProperty(hiddenExtra, "hidden", { value: true, enumerable: false });
  assertRejected(hiddenExtra);
  const ownProto = pending();
  Object.defineProperty(ownProto, "__proto__", { value: null, enumerable: true });
  assertRejected(ownProto);

  for (const locate of [
    (candidate: Record<string, unknown>) => candidate,
    (candidate: Record<string, unknown>) => candidate.payload as Record<string, unknown>,
    (candidate: Record<string, unknown>) => (
      (candidate.payload as Record<string, unknown>).origin as Record<string, unknown>
    ),
    (candidate: Record<string, unknown>) => (
      (candidate.payload as Record<string, unknown>).nextFingerprint as Record<string, unknown>
    ),
  ]) {
    let reads = 0;
    const candidate = pending();
    const target = locate(candidate);
    const key = Object.keys(target)[0]!;
    const prior = target[key];
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return prior;
      },
    });
    assertRejected(candidate);
    assert.equal(reads, 0);
  }

  const sparsePayload = projection();
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = true;
  sparsePayload.triggeringEventPayload = sparse;
  assert.throws(() => decodeMaterializationProjectionInputV1(sparsePayload));

  class HostileArray extends Array<unknown> {}
  const subclassPayload = projection();
  subclassPayload.triggeringEventPayload = new HostileArray(true);
  assert.throws(() => decodeMaterializationProjectionInputV1(subclassPayload));

  const iteratorPayload = projection();
  const iteratorOverride = [true];
  Object.defineProperty(iteratorOverride, Symbol.iterator, {
    value: Array.prototype[Symbol.iterator],
    enumerable: false,
  });
  iteratorPayload.triggeringEventPayload = iteratorOverride;
  assert.throws(() => decodeMaterializationProjectionInputV1(iteratorPayload));

  const nestedProto = projection();
  const dangerous: Record<string, unknown> = { accepted: true };
  Object.defineProperty(dangerous, "__proto__", { value: null, enumerable: true });
  nestedProto.triggeringEventPayload = dangerous;
  assert.throws(() => decodeMaterializationProjectionInputV1(nestedProto));

  const cycle = projection();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  cycle.triggeringEventPayload = cyclic;
  assert.throws(() => decodeMaterializationProjectionInputV1(cycle));

  for (const invalidJson of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const candidate = projection();
    candidate.triggeringEventPayload = invalidJson;
    assert.throws(() => decodeMaterializationProjectionInputV1(candidate));
  }

  for (const invalidPosition of [0n, -1n, 9_223_372_036_854_775_808n, 7, "7"]) {
    const candidate = projection();
    candidate.expectedTriggerPosition = invalidPosition;
    assert.throws(() => decodeMaterializationProjectionInputV1(candidate));
  }
  for (const invalidVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"]) {
    const candidate = projection();
    candidate.triggeringEventSchemaVersion = invalidVersion;
    assert.throws(() => decodeMaterializationProjectionInputV1(candidate));
  }
});

test("authenticates the canonical project context fingerprint", () => {
  const canonical = projection();
  const decoded = decodeMaterializationProjectionInputV1(canonical);
  assert.equal(
    decoded.context.binding.contextFingerprint,
    bindingOf(canonical.context as Record<string, unknown>).contextFingerprint,
  );

  const staleAfterBindingTamper = projection();
  bindingOf(staleAfterBindingTamper.context as Record<string, unknown>).clientNamespace =
    "tampered-after-fingerprint";
  assert.throws(() => decodeMaterializationProjectionInputV1(staleAfterBindingTamper));

  const forgedFingerprint = projection();
  bindingOf(forgedFingerprint.context as Record<string, unknown>).contextFingerprint =
    "f".repeat(64);
  assert.throws(() => decodeMaterializationProjectionInputV1(forgedFingerprint));
});

test("rejects incoherent project context variants", () => {
  const detachedWithBranch = gitProjectContext();
  for (const workspace of [
    bindingOf(detachedWithBranch).workspace,
    detachedWithBranch.workspace,
  ] as Array<Record<string, unknown>>) {
    workspace.detached = true;
    workspace.branchRef = "refs/heads/main";
  }
  refreshProjectContextFingerprint(detachedWithBranch);

  const attachedWithoutBranch = gitProjectContext();
  for (const workspace of [
    bindingOf(attachedWithoutBranch).workspace,
    attachedWithoutBranch.workspace,
  ] as Array<Record<string, unknown>>) {
    workspace.detached = false;
    workspace.branchRef = null;
  }
  refreshProjectContextFingerprint(attachedWithoutBranch);

  const gitWithVaultRoute = gitProjectContext();
  (bindingOf(gitWithVaultRoute).storeRoute as Record<string, unknown>).kind = "vault-local";
  refreshProjectContextFingerprint(gitWithVaultRoute);

  const nonGitWithGitRoute = projectContext();
  (bindingOf(nonGitWithGitRoute).storeRoute as Record<string, unknown>).kind = "git-common";
  refreshProjectContextFingerprint(nonGitWithGitRoute);

  const nonGitWithBranchScope = projectContext();
  nonGitWithBranchScope.branchScopeId = "66666666-6666-4666-8666-666666666666";

  for (const context of [
    detachedWithBranch,
    attachedWithoutBranch,
    gitWithVaultRoute,
    nonGitWithGitRoute,
    nonGitWithBranchScope,
  ]) {
    const candidate = projection();
    candidate.context = context;
    assert.throws(() => decodeMaterializationProjectionInputV1(candidate));
  }

  const gitWithoutBranchScope = gitProjectContext();
  delete gitWithoutBranchScope.branchScopeId;
  const accepted = projection();
  accepted.context = gitWithoutBranchScope;
  const decoded = decodeMaterializationProjectionInputV1(accepted);
  assert.equal(Object.hasOwn(decoded.context, "branchScopeId"), false);
});

test("accepts upstream-valid unbounded project context strings", () => {
  const longRoot = `C:\\${"p".repeat(4_100)}`;
  const longContext = projectContext();
  const binding = bindingOf(longContext);
  binding.clientNamespace = "n".repeat(1_025);
  binding.clientInstanceId = "i".repeat(1_025);
  binding.projectRoot = longRoot;
  binding.vaultRoot = `${longRoot}\\memory`;
  binding.descriptorPath = `${longRoot}\\memory\\.project-memory.json`;
  binding.storeRoute = {
    kind: "vault-local",
    storeRoot: `${longRoot}\\store`,
    eventsPath: `${longRoot}\\events.sqlite`,
    storeManifestPath: `${longRoot}\\store.json`,
    projectionManifestPath: `${longRoot}\\projection.json`,
  };
  const workspace = {
    kind: "non-git",
    workspaceRoot: longRoot,
    workspaceId: WORKSPACE_ID,
  };
  binding.workspace = structuredClone(workspace);
  longContext.workspace = workspace;
  refreshProjectContextFingerprint(longContext);
  const candidate = projection();
  candidate.context = longContext;
  const decoded = decodeMaterializationProjectionInputV1(candidate);
  assert.equal(decoded.context.binding.clientNamespace.length, 1_025);
  assert.equal(decoded.context.binding.projectRoot.length > 4_096, true);
  assert.equal(decoded.context.binding.storeRoute.eventsPath.length > 4_096, true);

  const longArtifact = pending();
  (longArtifact.payload as Record<string, unknown>).artifactPath =
    `05_Agent_Session_Logs/${"a".repeat(4_097)}.md`;
  assert.equal(
    decodePendingLifecycleOutboxV1(longArtifact).payload.artifactPath.length > 4_096,
    true,
  );

  for (const mutate of [
    (context: Record<string, unknown>) => {
      bindingOf(context).clientNamespace = "   ";
    },
    (context: Record<string, unknown>) => {
      (bindingOf(context).storeRoute as Record<string, unknown>).eventsPath = "   ";
    },
    (context: Record<string, unknown>) => {
      const blankWorkspace = {
        kind: "non-git",
        workspaceRoot: "   ",
        workspaceId: WORKSPACE_ID,
      };
      bindingOf(context).workspace = structuredClone(blankWorkspace);
      context.workspace = blankWorkspace;
    },
  ]) {
    const blank = projectContext();
    mutate(blank);
    refreshProjectContextFingerprint(blank);
    const blankCandidate = projection();
    blankCandidate.context = blank;
    assert.throws(() => decodeMaterializationProjectionInputV1(blankCandidate));
  }

  const blankArtifact = pending();
  (blankArtifact.payload as Record<string, unknown>).artifactPath = "   ";
  assertRejected(blankArtifact);
});

test("preserves the generic pending outbox string domain", () => {
  const generic = {
    targetKey: "generic/target",
    kind: "notify-observer",
    eventIndex: 0,
    payload: { accepted: true },
  };
  for (const field of ["targetKey", "kind"] as const) {
    for (const value of ["", " ", "\t\r\n"]) {
      assert.throws(() => decodeGenericPendingOutbox({
        ...generic,
        [field]: value,
      }));
    }
  }

  const longTarget = "t".repeat(4_097);
  const decodedLongTarget = decodeGenericPendingOutbox({
    ...generic,
    targetKey: longTarget,
  });
  assert.equal(decodedLongTarget.targetKey, longTarget);

  const longKind = "k".repeat(129);
  const decodedLongKind = decodeGenericPendingOutbox({
    ...generic,
    kind: longKind,
  });
  assert.equal(decodedLongKind.kind, longKind);
});
