import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import type {
  ProjectContext,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import {
  CHILD_BINDING_GRANT_DOMAIN,
  AuthorityMaterialAdapter,
  type ChildBindingGrantV1,
  type PrivateAuthorityChannel,
  type PrivateLifecycleAuthorization,
  type RevalidatedTrustedLifecycleContext,
  type WorkerLifecycleResult,
} from "../src/orchestrator/lifecycle/authority/authority-material-adapter.js";
import { EncryptedPendingAuthorizationStore } from "../src/orchestrator/lifecycle/authority/encrypted-pending-authorization.store.js";
import type {
  PendingAuthorizationStore,
  PendingCommandIdentity,
  PendingSemanticCommandRecordV1,
} from "../src/orchestrator/lifecycle/authority/pending-authorization.store.js";
import {
  createCapabilityProof,
  issueCapability,
  type CapabilityClaimsV1,
} from "../src/orchestrator/lifecycle/authority/capability-codec.js";
import {
  issueRecoveryApproval,
  type RecoveryApprovalClaimsV1,
} from "../src/orchestrator/lifecycle/authority/approval-codec.js";
import { SecretString } from "../src/orchestrator/lifecycle/authority/redacted-secret.js";
import type {
  AuthorityMaterialDescriptorV1,
  LifecycleAuthorityTarget,
  RootOrChildAuthorityMaterial,
} from "../src/orchestrator/lifecycle/capability.service.js";
import {
  CapabilityService,
  type CapabilityNonceSource,
} from "../src/orchestrator/lifecycle/capability.service.js";
import type {
  LifecycleAudience,
  LifecycleSemanticCommandDraft,
  PreparedLifecycleWorkerCommand,
  RedactedChildBindingGrant,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import type { CheckpointId, SessionId } from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import { lifecycleIntentHash } from "../src/orchestrator/lifecycle/lifecycle-intent.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { canonicalMkdtemp } from "./support/canonical-temp.js";
import { DeterministicCapabilityKeyProvider } from "./support/lifecycle-authority-reference.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001" as ProjectId;
const VAULT_ID = "00000000-0000-4000-8000-000000000002" as VaultId;
const STORE_ID = "00000000-0000-4000-8000-000000000003" as StoreId;
const ROOT_SESSION_ID = "00000000-0000-4000-8000-000000000010" as SessionId;
const CHILD_SESSION_ID = "00000000-0000-4000-8000-000000000011" as SessionId;
const COMMAND_ID = "00000000-0000-4000-8000-000000000020";
const WORKSPACE_ID = "1".repeat(64) as WorkspaceId;
const NOW = "2026-07-17T00:00:00.000Z";
const NOW_MS = BigInt(Date.parse(NOW));
const PRIMARY_A: LifecycleAuthorityTarget = Object.freeze({ actorRole: "primary", clientInstanceId: "primary-a" });
const PRIMARY_B: LifecycleAuthorityTarget = Object.freeze({ actorRole: "primary", clientInstanceId: "primary-b" });
const CHILD_A: LifecycleAuthorityTarget = Object.freeze({ actorRole: "untrusted", clientInstanceId: "child-a" });
const CHILD_B: LifecycleAuthorityTarget = Object.freeze({ actorRole: "untrusted", clientInstanceId: "child-b" });
const TARGET_BINDING_FINGERPRINT = "9".repeat(64);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class Nonces implements CapabilityNonceSource {
  #next = 100;

  bytes(length: number): Uint8Array {
    return Buffer.alloc(length, this.#next++ & 0xff);
  }

  uuid(): string {
    return `00000000-0000-4000-8000-${(this.#next++).toString().padStart(12, "0")}`;
  }
}

class RecordingChannel implements PrivateAuthorityChannel {
  readonly deliveries: Array<{ target: LifecycleAuthorityTarget; kind: "root" | "child" }> = [];
  readonly routes: Array<{ target: LifecycleAuthorityTarget; descriptor: AuthorityMaterialDescriptorV1 }> = [];
  readonly attached = new Set<string>();
  local: LifecycleAuthorityTarget | null = null;
  routeHandler: ((target: LifecycleAuthorityTarget, descriptor: AuthorityMaterialDescriptorV1) => Promise<void>) | null = null;

  isAttached(target: LifecycleAuthorityTarget): boolean {
    return this.attached.has(targetKey(target));
  }

  isLocalTarget(target: LifecycleAuthorityTarget): boolean {
    return this.local !== null && sameTarget(this.local, target);
  }

  async deliverLocal(target: LifecycleAuthorityTarget, material: RootOrChildAuthorityMaterial): Promise<void> {
    material.kind === "root"
      ? material.handle.withValue((value) => assert.match(value, /^pmcap1\./))
      : material.handle.withValue((value) => assert.match(value, /^pmcap1\./));
    this.deliveries.push({
      target: { actorRole: target.actorRole, clientInstanceId: target.clientInstanceId },
      kind: material.kind,
    });
  }

  async routeDescriptor(target: LifecycleAuthorityTarget, descriptor: AuthorityMaterialDescriptorV1): Promise<void> {
    this.routes.push({
      target: { actorRole: target.actorRole, clientInstanceId: target.clientInstanceId },
      descriptor,
    });
    await this.routeHandler?.(target, descriptor);
  }
}

interface Harness {
  readonly root: string;
  readonly provider: DeterministicCapabilityKeyProvider;
  readonly pending: EncryptedPendingAuthorizationStore;
  readonly capabilityService: CapabilityService;
  readonly channel: RecordingChannel;
  readonly adapter: AuthorityMaterialAdapter;
  readonly nonces: Nonces;
}

function targetKey(target: LifecycleAuthorityTarget): string {
  return `${target.actorRole}\0${target.clientInstanceId}`;
}

function sameTarget(left: LifecycleAuthorityTarget, right: LifecycleAuthorityTarget): boolean {
  return left.actorRole === right.actorRole && left.clientInstanceId === right.clientInstanceId;
}

function harness(options: {
  root?: string;
  provider?: DeterministicCapabilityKeyProvider;
  channel?: RecordingChannel;
  nonces?: Nonces;
} = {}): Harness {
  const root = options.root ?? canonicalMkdtemp("authority-adapter-");
  if (!roots.includes(root)) roots.push(root);
  const provider = options.provider ?? new DeterministicCapabilityKeyProvider();
  const channel = options.channel ?? new RecordingChannel();
  const nonces = options.nonces ?? new Nonces();
  const pending = new EncryptedPendingAuthorizationStore({
    privateStateRoot: root,
    scope: { projectId: PROJECT_ID, storeId: STORE_ID },
    keyProvider: provider,
  });
  const capabilityService = new CapabilityService({
    keyProvider: provider,
    clock: { nowMs: () => NOW_MS },
    nonceSource: nonces,
  });
  const adapter = new AuthorityMaterialAdapter({
    pendingStore: pending,
    keyProvider: provider,
    capabilityService,
    channel,
    clock: { nowMs: () => NOW_MS },
    nonceSource: nonces,
  });
  return { root, provider, pending, capabilityService, channel, adapter, nonces };
}

function projectContext(overrides: {
  projectId?: ProjectId;
  vaultId?: VaultId;
  storeId?: StoreId;
  workspaceId?: WorkspaceId;
  clientNamespace?: string;
  clientInstanceId?: string;
  actorRole?: "primary" | "maintenance" | "untrusted";
  generation?: number;
  contextFingerprint?: string;
  branchRef?: string | null;
  headCommit?: string;
  dirty?: string;
  checkedAt?: string;
  projectRoot?: string;
  vaultRoot?: string;
  storeRoot?: string;
} = {}): ProjectContext {
  const workspaceId = overrides.workspaceId ?? WORKSPACE_ID;
  const branchRef = overrides.branchRef === undefined ? "refs/heads/task-7" : overrides.branchRef;
  const projectRoot = overrides.projectRoot ?? resolve("test-private-project");
  const vaultRoot = overrides.vaultRoot ?? resolve("test-private-vault");
  const storeRoot = overrides.storeRoot ?? resolve("test-private-store");
  const workspace = {
    kind: "git" as const,
    worktreeRoot: projectRoot,
    gitDir: resolve(projectRoot, ".git"),
    gitCommonDir: resolve(projectRoot, ".git"),
    headCommit: overrides.headCommit ?? "1".repeat(40),
    branchRef,
    detached: branchRef === null,
    workspaceId,
  };
  return {
    binding: {
      projectBindingId: "00000000-0000-4000-8000-000000000090",
      generation: overrides.generation ?? 1,
      contextFingerprint: overrides.contextFingerprint ?? "2".repeat(64),
      source: "trusted-ide-adapter",
      projectId: overrides.projectId ?? PROJECT_ID,
      vaultId: overrides.vaultId ?? VAULT_ID,
      storeId: overrides.storeId ?? STORE_ID,
      workspaceId,
      clientNamespace: overrides.clientNamespace ?? "desktop/authority-tests",
      clientInstanceId: overrides.clientInstanceId ?? "primary-a",
      actorRole: overrides.actorRole ?? "primary",
      projectRoot,
      vaultRoot,
      descriptorPath: resolve(projectRoot, ".project-memory.json"),
      storeRoute: {
        kind: "git-common",
        storeRoot,
        eventsPath: resolve(storeRoot, "events.sqlite"),
        storeManifestPath: resolve(storeRoot, "store-manifest.json"),
        projectionManifestPath: resolve(storeRoot, "projection-manifest.json"),
      },
      workspace: { ...workspace },
      establishedAt: "2026-07-17T00:00:00.000Z",
    },
    workspace: { ...workspace },
    checkedAt: overrides.checkedAt ?? "2026-07-17T00:00:00.000Z",
  };
}

function trustedContext(overrides: Partial<RevalidatedTrustedLifecycleContext> = {}): RevalidatedTrustedLifecycleContext {
  return {
    context: projectContext(),
    authoritySessionId: ROOT_SESSION_ID,
    targetSessionId: ROOT_SESSION_ID,
    capabilityKind: "root-session-handle",
    capabilityGeneration: "7",
    authorityTarget: PRIMARY_A,
    targetBindingFingerprint: null,
    ...overrides,
  };
}

function rootStart(commandId = COMMAND_ID): LifecycleSemanticCommandDraft {
  return {
    commandType: "root-start",
    commandId,
    idempotencyKey: `root-start/${commandId}`,
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: "refs/heads/task-7",
    continuityKey: "task-7-private-retry",
    resumePolicy: "new",
  };
}

function rootResume(commandId = COMMAND_ID): LifecycleSemanticCommandDraft {
  return {
    commandType: "root-resume",
    commandId,
    idempotencyKey: `root-resume/${commandId}`,
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: "refs/heads/task-7",
    sessionId: ROOT_SESSION_ID,
    continuityKey: "task-7-private-retry",
    resumePolicy: "exact",
    expectedOwnerGeneration: "7",
  };
}

function forkChild(commandId = COMMAND_ID): LifecycleSemanticCommandDraft {
  return {
    commandType: "fork-child",
    commandId,
    idempotencyKey: `fork-child/${commandId}`,
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: "refs/heads/task-7",
    parentSessionId: ROOT_SESSION_ID,
    expectedStreamVersion: "7",
    assignment: {
      assignmentId: "00000000-0000-4000-8000-000000000030",
      summary: "Route exact child authority",
      scope: "tests/authority-material-adapter.test.ts",
    },
    directAccessRequested: true,
  };
}

function rootRecovery(commandId = COMMAND_ID): LifecycleSemanticCommandDraft {
  return {
    commandType: "root-recovery",
    commandId,
    idempotencyKey: `root-recovery/${commandId}`,
    agentId: "agent-maintenance",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: "refs/heads/task-7",
    sessionId: ROOT_SESSION_ID,
    expectedOwnerGeneration: "7",
    preTransitionCheckpointId: "00000000-0000-4000-8000-000000000031" as CheckpointId,
    reasonCode: "credential-loss",
  };
}

function capabilityClaims(
  provider: DeterministicCapabilityKeyProvider,
  kind: CapabilityClaimsV1["kind"] = "root-session-handle",
  target: LifecycleAuthorityTarget = PRIMARY_A,
  sessionId = ROOT_SESSION_ID,
  generation = "7",
): CapabilityClaimsV1 {
  return {
    capabilityVersion: 1,
    keyId: provider.currentKey({ projectId: PROJECT_ID, storeId: STORE_ID }, kind).keyId,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "desktop/authority-tests",
    sessionId,
    kind,
    capabilityGeneration: generation,
    issuedAt: NOW,
    policyCode: `${kind}-policy-v1`,
    expiryKind: kind === "child-session-handle" ? "absolute" : "until-revoked",
    expiresAt: kind === "child-session-handle" ? "2026-07-17T01:00:00.000Z" : null,
    issueNonce: "3".repeat(64),
    actorRole: target.actorRole,
    clientInstanceId: kind === "root-resume-token" ? null : target.clientInstanceId,
  };
}

function bearer(provider: DeterministicCapabilityKeyProvider): SecretString {
  return issueCapability(provider, capabilityClaims(provider));
}

function issueGrant(
  provider: DeterministicCapabilityKeyProvider,
  target: LifecycleAuthorityTarget = CHILD_A,
): { secret: SecretString; redacted: RedactedChildBindingGrant } {
  assert.equal(target.actorRole, "untrusted");
  const claims = {
    grantVersion: 1 as const,
    grantId: "00000000-0000-4000-8000-000000000060",
    projectId: PROJECT_ID,
    storeId: STORE_ID,
    parentSessionId: ROOT_SESSION_ID,
    targetActorRole: "untrusted" as const,
    targetClientInstanceId: target.clientInstanceId,
    issuedAt: NOW,
    expiresAt: "2026-07-17T00:10:00.000Z",
    bindingFingerprint: TARGET_BINDING_FINGERPRINT,
  };
  const bytes = Buffer.from(canonicalJson(claims), "utf8");
  const keyId = provider.currentKey(
    { projectId: PROJECT_ID, storeId: STORE_ID },
    "child-binding-grant",
  ).keyId;
  const mac = Buffer.from(provider.mac({
    projectId: PROJECT_ID,
    storeId: STORE_ID,
    purpose: "child-binding-grant",
    keyId,
    domain: CHILD_BINDING_GRANT_DOMAIN,
    bytes,
  }));
  try {
    const grant: ChildBindingGrantV1 = { ...claims, mac: mac.toString("base64url") };
    const fingerprint = createHash("sha256")
      .update("project-memory/child-binding-grant-digest/v1\n", "utf8")
      .update(mac)
      .digest("hex");
    return {
      secret: SecretString.from(canonicalJson(grant)),
      redacted: {
        grantVersion: 1,
        grantId: claims.grantId,
        projectId: claims.projectId,
        storeId: claims.storeId,
        parentSessionId: claims.parentSessionId,
        targetActorRole: "untrusted",
        targetClientInstanceId: target.clientInstanceId,
        issuedAt: claims.issuedAt,
        expiresAt: claims.expiresAt,
        bindingFingerprint: claims.bindingFingerprint,
        grantFingerprint: fingerprint,
      },
    };
  } finally {
    bytes.fill(0);
    mac.fill(0);
  }
}

function recoveryApproval(
  provider: DeterministicCapabilityKeyProvider,
  command: LifecycleSemanticCommandDraft,
  context: RevalidatedTrustedLifecycleContext,
): SecretString {
  assert.equal(command.commandType, "root-recovery");
  const audience: LifecycleAudience = {
    presentingActorRole: context.context.binding.actorRole,
    presentingClientInstanceId: context.context.binding.clientInstanceId,
    targetActorRole: context.authorityTarget.actorRole,
    targetClientInstanceId: context.authorityTarget.clientInstanceId,
  };
  const intentHash = lifecycleIntentHash({
    context: context.context,
    command,
    authorizationKind: "protected",
    authoritySessionId: ROOT_SESSION_ID,
    targetSessionId: ROOT_SESSION_ID,
    capabilityKind: null,
    capabilityGeneration: null,
    audience,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  });
  const claims: RecoveryApprovalClaimsV1 = {
    approvalVersion: 1,
    approvalId: "00000000-0000-4000-8000-000000000070",
    keyId: provider.currentKey(
      { projectId: PROJECT_ID, storeId: STORE_ID },
      "recovery-approval",
    ).keyId,
    action: "recover-root-authority",
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: ROOT_SESSION_ID,
    expectedOwnerGeneration: command.expectedOwnerGeneration,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    intentHash,
    executorActorRole: context.context.binding.actorRole as "primary" | "maintenance",
    executorClientInstanceId: context.context.binding.clientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId: context.authorityTarget.clientInstanceId,
    issuedAt: NOW,
    expiresAt: "2026-07-17T00:10:00.000Z",
    approvalNonce: "4".repeat(64),
    reasonCode: "credential-loss",
    redactedApprovalReference: "approval/task-7",
  };
  return issueRecoveryApproval(provider, claims);
}

function identity(command: LifecycleSemanticCommandDraft): PendingCommandIdentity {
  return {
    projectId: PROJECT_ID,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
  };
}

function success<T extends JsonValue>(
  publicResult: T,
  descriptor: AuthorityMaterialDescriptorV1 | null = null,
  status: "current" | "stale" | "unavailable" | "not-issued" = descriptor === null ? "not-issued" : "current",
  recoveryCode: "SESSION_HANDLE_STALE" | "SESSION_CAPABILITY_KEY_UNAVAILABLE" | null = null,
): WorkerLifecycleResult<T> {
  return {
    kind: "success",
    publicResult,
    authorityMaterial: descriptor === null
      ? {
          status,
          target: null,
          authorityCommitment: null,
          capabilityGeneration: null,
          descriptor: null,
          recoveryCode,
        }
      : {
          status,
          target: descriptor.target,
          authorityCommitment: descriptor.authorityCommitment,
          capabilityGeneration: descriptor.capabilityGeneration,
          descriptor,
          recoveryCode,
        },
  };
}

function descriptor(
  service: CapabilityService,
  provider: DeterministicCapabilityKeyProvider,
  target: LifecycleAuthorityTarget,
  kind: "root-session-handle" | "child-session-handle" = target.actorRole === "primary"
    ? "root-session-handle"
    : "child-session-handle",
  sessionId = target.actorRole === "primary" ? ROOT_SESSION_ID : CHILD_SESSION_ID,
  generation = "7",
  commitment = "5".repeat(64),
): AuthorityMaterialDescriptorV1 {
  const material = service.prepareCapability({
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "desktop/authority-tests",
    sessionId,
    kind,
    capabilityGeneration: generation,
    policyCode: `${kind}-policy-v1`,
    expiryKind: kind === "child-session-handle" ? "absolute" : "until-revoked",
    expiresAt: kind === "child-session-handle" ? "2026-07-17T01:00:00.000Z" : null,
    actorRole: target.actorRole,
    clientInstanceId: target.clientInstanceId,
  });
  const resolution = service.authorityMaterial({
    authorityCommitment: commitment,
    expectedCapabilityGeneration: generation,
    currentCapabilityGeneration: generation,
    target,
    materials: [material],
  });
  assert.equal(resolution.status, "current");
  assert.ok(resolution.descriptor !== undefined);
  assert.equal(
    provider.calls.some((call) => call.operation === "seal" && call.purpose !== "pending-authorization-encryption"),
    false,
  );
  return resolution.descriptor;
}

async function pendingRecord(
  store: PendingAuthorizationStore,
  command: LifecycleSemanticCommandDraft,
): Promise<PendingSemanticCommandRecordV1> {
  const record = await store.get(PROJECT_ID, command.commandId, command.idempotencyKey);
  assert.ok(record !== null);
  return record;
}

function destroyPendingSecrets(record: PendingSemanticCommandRecordV1): void {
  if (record.authorization.kind === "protected") {
    record.authorization.approval?.destroy();
    record.authorization.childBindingGrant?.destroy();
  }
}

function expectCode(code: string, error: unknown): boolean {
  assert.ok(error instanceof LifecycleError);
  assert.equal(error.code, code);
  assert.doesNotMatch(String(error), /pmcap1|pmrap1|proofFingerprint|child-binding|private-provider/i);
  return true;
}

function reconstructionCalls(provider: DeterministicCapabilityKeyProvider, fromIndex: number): number {
  return provider.calls.slice(fromIndex).filter((call) =>
    ["root-session-handle", "root-resume-token", "child-session-handle"].includes(call.purpose)
    && ["currentKey", "status", "mac", "verify", "fingerprint"].includes(call.operation),
  ).length;
}

describe("authority material adapter", () => {
  it("rejects accessor-bearing authorization and worker results without invoking accessors", async () => {
    const current = harness();
    const command = rootStart();
    const context = trustedContext({
      authoritySessionId: null,
      targetSessionId: null,
      capabilityKind: null,
      capabilityGeneration: null,
    });
    let authorizationReads = 0;
    const accessorAuthorization = {};
    Object.defineProperty(accessorAuthorization, "kind", {
      enumerable: true,
      get: () => {
        authorizationReads += 1;
        return "initial-authority";
      },
    });
    await assert.rejects(
      current.adapter.prepare(
        command,
        accessorAuthorization as PrivateLifecycleAuthorization,
        context,
      ),
      (error) => expectCode("SESSION_CAPABILITY_INVALID", error),
    );
    assert.equal(authorizationReads, 0);

    await current.adapter.prepare(command, { kind: "initial-authority" }, context);
    let resultReads = 0;
    const accessorResult = {};
    Object.defineProperty(accessorResult, "kind", {
      enumerable: true,
      get: () => {
        resultReads += 1;
        return "success";
      },
    });
    await assert.rejects(
      current.adapter.complete(
        identity(command),
        accessorResult as WorkerLifecycleResult<{ sessionId: string }>,
      ),
      (error) => expectCode("SESSION_CAPABILITY_INVALID", error),
    );
    assert.equal(resultReads, 0);
    assert.ok(await current.pending.get(PROJECT_ID, command.commandId, command.idempotencyKey));
  });

  it("rejects a private retry root contained by a project, vault, or store root", async () => {
    for (const protectedKind of ["projectRoot", "vaultRoot", "storeRoot"] as const) {
      const protectedRoot = canonicalMkdtemp(`authority-protected-${protectedKind}-`);
      roots.push(protectedRoot);
      const nestedPrivateRoot = join(protectedRoot, "host-private");
      mkdirSync(nestedPrivateRoot);
      const current = harness({ root: nestedPrivateRoot });
      const context = trustedContext({
        context: projectContext({ [protectedKind]: protectedRoot }),
        authoritySessionId: null,
        targetSessionId: null,
        capabilityKind: null,
        capabilityGeneration: null,
      });
      await assert.rejects(
        current.adapter.prepare(rootStart(), { kind: "initial-authority" }, context),
        (error) => expectCode("SESSION_CAPABILITY_INVALID", error),
      );
      assert.equal((await current.pending.list(PROJECT_ID)).length, 0);
    }
  });

  it("persists a complete initial draft before posting and reconstructs it after restart", async () => {
    const first = harness();
    const command = rootStart();
    const context = trustedContext({
      authoritySessionId: null,
      targetSessionId: null,
      capabilityKind: null,
      capabilityGeneration: null,
    });
    const posted: PreparedLifecycleWorkerCommand<LifecycleSemanticCommandDraft>[] = [];

    const prepared = await first.adapter.prepare(command, { kind: "initial-authority" }, context);
    const sealedBeforePost = await pendingRecord(first.pending, command);
    posted.push(prepared);

    assert.equal(posted.length, 1);
    assert.deepEqual(sealedBeforePost.command, command);
    assert.equal(sealedBeforePost.authoritySessionId, null);
    assert.equal(sealedBeforePost.targetSessionId, null);
    assert.deepEqual(sealedBeforePost.authorization, {
      kind: "initial-authority", proof: null, approval: null, childBindingGrant: null,
    });
    assert.deepEqual(prepared.authorization, {
      kind: "initial-authority",
      authoritySessionId: null,
      targetSessionId: null,
      proof: null,
      approval: null,
      childBindingGrant: null,
    });

    const restarted = harness({
      root: first.root,
      provider: first.provider,
      channel: first.channel,
      nonces: first.nonces,
    });
    const resumed = await restarted.adapter.resumePending(identity(command), {
      ...context,
      context: projectContext({
        generation: 99,
        contextFingerprint: "8".repeat(64),
        branchRef: "refs/heads/after-restart",
        headCommit: "7".repeat(40),
        dirty: "6".repeat(64),
        checkedAt: "2026-07-17T00:01:00.000Z",
      }),
    });
    assert.deepEqual(resumed, prepared);
    destroyPendingSecrets(sealedBeforePost);
  });

  it("reuses the exact protected proof, approval, grant, intent, and audience after restart", async () => {
    const primary = harness();
    const command = forkChild();
    const rootBearer = bearer(primary.provider);
    const grant = issueGrant(primary.provider);
    const authorization: PrivateLifecycleAuthorization = {
      kind: "protected",
      bearer: rootBearer,
      approval: null,
      childBindingGrant: grant.secret,
    };
    const context = trustedContext({
      authorityTarget: CHILD_A,
      targetBindingFingerprint: TARGET_BINDING_FINGERPRINT,
    });
    try {
      const prepared = await primary.adapter.prepare(command, authorization, context);
      const stored = await pendingRecord(primary.pending, command);
      assert.deepEqual(stored.command, command);
      assert.equal(stored.candidateIntentHash, prepared.candidateIntentHash);
      assert.deepEqual(stored.stableBinding.audience, {
        presentingActorRole: "primary",
        presentingClientInstanceId: "primary-a",
        targetActorRole: "untrusted",
        targetClientInstanceId: "child-a",
      });
      assert.deepEqual(stored.authorization.kind === "protected" ? stored.authorization.proof : null, prepared.authorization.proof);
      assert.equal(
        stored.authorization.kind === "protected"
          ? stored.authorization.childBindingGrant?.withValue((value: string) => value)
          : null,
        grant.secret.withValue((value) => value),
      );

      const restarted = harness({ root: primary.root, provider: primary.provider, channel: primary.channel, nonces: primary.nonces });
      const resumed = await restarted.adapter.resumePending(identity(command), context);
      assert.deepEqual(resumed, prepared);
      assert.deepEqual(resumed.authorization.childBindingGrant, grant.redacted);
      const grantWitness = resumed.authorization.childBindingGrant as unknown as Record<string, unknown>;
      assert.deepEqual(Object.keys(grantWitness).sort(), [
        "bindingFingerprint",
        "expiresAt",
        "grantFingerprint",
        "grantId",
        "grantVersion",
        "issuedAt",
        "parentSessionId",
        "projectId",
        "storeId",
        "targetActorRole",
        "targetClientInstanceId",
      ]);
      assert.equal("mac" in grantWitness, false);
      const rawGrant = grant.secret.withValue((value) => JSON.parse(value) as { readonly mac: string });
      assert.equal(canonicalJson(grantWitness).includes(rawGrant.mac), false);
      destroyPendingSecrets(stored);
    } finally {
      rootBearer.destroy();
      grant.secret.destroy();
    }

    const maintenance = harness();
    maintenance.channel.attached.add(targetKey(PRIMARY_B));
    const recovery = rootRecovery("00000000-0000-4000-8000-000000000021");
    const recoveryContext = trustedContext({
      context: projectContext({ actorRole: "maintenance", clientInstanceId: "maintenance-a" }),
      capabilityKind: null,
      capabilityGeneration: null,
      authorityTarget: PRIMARY_B,
    });
    const approval = recoveryApproval(maintenance.provider, recovery, recoveryContext);
    try {
      const prepared = await maintenance.adapter.prepare(recovery, {
        kind: "protected", bearer: null, approval, childBindingGrant: null,
      }, recoveryContext);
      const approvalWitness = prepared.authorization.approval as unknown as Record<string, unknown>;
      assert.deepEqual(Object.keys(approvalWitness).sort(), [
        "action",
        "approvalFingerprint",
        "approvalId",
        "approvalVersion",
        "commandId",
        "executorActorRole",
        "executorClientInstanceId",
        "expectedOwnerGeneration",
        "expiresAt",
        "idempotencyKey",
        "intentHash",
        "issuedAt",
        "nonceDigest",
        "projectId",
        "reasonCode",
        "redactedApprovalReference",
        "sessionId",
        "storeId",
        "targetActorRole",
        "targetClientInstanceId",
        "vaultId",
        "workspaceId",
      ]);
      assert.match(String(approvalWitness.nonceDigest), /^[0-9a-f]{64}$/);
      assert.notEqual(approvalWitness.nonceDigest, "4".repeat(64), "raw approval nonce must never enter worker DTO");
      assert.deepEqual(approvalWitness, {
        approvalVersion: 1,
        approvalId: "00000000-0000-4000-8000-000000000070",
        action: "recover-root-authority",
        reasonCode: "credential-loss",
        approvalFingerprint: approvalWitness.approvalFingerprint,
        nonceDigest: approvalWitness.nonceDigest,
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
        workspaceId: WORKSPACE_ID,
        sessionId: ROOT_SESSION_ID,
        expectedOwnerGeneration: "7",
        commandId: recovery.commandId,
        idempotencyKey: recovery.idempotencyKey,
        intentHash: prepared.candidateIntentHash,
        executorActorRole: "maintenance",
        executorClientInstanceId: "maintenance-a",
        targetActorRole: "primary",
        targetClientInstanceId: PRIMARY_B.clientInstanceId,
        issuedAt: NOW,
        expiresAt: "2026-07-17T00:10:00.000Z",
        redactedApprovalReference: "approval/task-7",
      });
      assert.equal("approvalNonce" in approvalWitness, false);
      assert.equal("keyId" in approvalWitness, false);
      const stored = await pendingRecord(maintenance.pending, recovery);
      assert.equal(
        stored.authorization.kind === "protected"
          ? stored.authorization.approval?.withValue((value: string) => value)
          : null,
        approval.withValue((value) => value),
      );
      const restarted = harness({ root: maintenance.root, provider: maintenance.provider, channel: maintenance.channel, nonces: maintenance.nonces });
      assert.deepEqual(await restarted.adapter.resumePending(identity(recovery), recoveryContext), prepared);
      destroyPendingSecrets(stored);
    } finally {
      approval.destroy();
    }
  });

  it("requires an attached recovery target during prepare and resume preflight", async () => {
    const current = harness();
    const command = rootRecovery("00000000-0000-4000-8000-000000000025");
    const context = trustedContext({
      context: projectContext({ actorRole: "maintenance", clientInstanceId: "maintenance-a" }),
      capabilityKind: null,
      capabilityGeneration: null,
      authorityTarget: PRIMARY_B,
    });
    const approval = recoveryApproval(current.provider, command, context);
    try {
      await assert.rejects(
        current.adapter.prepare(command, {
          kind: "protected", bearer: null, approval, childBindingGrant: null,
        }, context),
        (error) => expectCode("SESSION_CAPABILITY_INVALID", error),
      );
      assert.equal(await current.pending.get(PROJECT_ID, command.commandId, command.idempotencyKey), null);

      current.channel.attached.add(targetKey(PRIMARY_B));
      await current.adapter.prepare(command, {
        kind: "protected", bearer: null, approval, childBindingGrant: null,
      }, context);
      current.channel.attached.delete(targetKey(PRIMARY_B));
      await assert.rejects(
        current.adapter.resumePending(identity(command), context),
        (error) => expectCode("SESSION_CAPABILITY_INVALID", error),
      );
      const retained = await current.pending.get(PROJECT_ID, command.commandId, command.idempotencyKey);
      assert.ok(retained !== null);
      destroyPendingSecrets(retained);
    } finally {
      approval.destroy();
    }
  });

  it("rejects only changed stable binding or derived audience and ignores volatile binding/source state", async () => {
    const current = harness();
    const command = rootResume();
    const rootBearer = bearer(current.provider);
    const context = trustedContext();
    try {
      const prepared = await current.adapter.prepare(command, {
        kind: "protected", bearer: rootBearer, approval: null, childBindingGrant: null,
      }, context);
      const restarted = harness({ root: current.root, provider: current.provider, channel: current.channel, nonces: current.nonces });
      const volatile = trustedContext({
        context: projectContext({
          generation: 42,
          contextFingerprint: "e".repeat(64),
          branchRef: "refs/heads/volatile-change",
          headCommit: "f".repeat(40),
          dirty: "d".repeat(64),
          checkedAt: "2026-07-17T00:02:00.000Z",
        }),
      });
      assert.deepEqual(await restarted.adapter.resumePending(identity(command), volatile), prepared);

      const stableChanges: RevalidatedTrustedLifecycleContext[] = [
        trustedContext({ context: projectContext({ projectId: "00000000-0000-4000-8000-000000000099" as ProjectId }) }),
        trustedContext({ context: projectContext({ vaultId: "00000000-0000-4000-8000-000000000098" as VaultId }) }),
        trustedContext({ context: projectContext({ storeId: "00000000-0000-4000-8000-000000000097" as StoreId }) }),
        trustedContext({ context: projectContext({ workspaceId: "6".repeat(64) as WorkspaceId }) }),
        trustedContext({ context: projectContext({ clientNamespace: "desktop/other" }) }),
        trustedContext({ context: projectContext({ clientInstanceId: "primary-b" }), authorityTarget: PRIMARY_B }),
        trustedContext({ authorityTarget: CHILD_A, targetBindingFingerprint: TARGET_BINDING_FINGERPRINT }),
      ];
      for (const changed of stableChanges) {
        await assert.rejects(
          restarted.adapter.resumePending(identity(command), changed),
          (error) => expectCode("IDEMPOTENCY_CONFLICT", error),
        );
      }
      const exact = await restarted.adapter.resumePending(identity(command), context);
      assert.deepEqual(exact.command, command, "resume never accepts a replacement semantic draft");
    } finally {
      rootBearer.destroy();
    }
  });

  it("retains uncertain work but deletes after success and terminal typed rejection", async () => {
    const unknownHarness = harness();
    const unknownCommand = rootResume();
    const unknownBearer = bearer(unknownHarness.provider);
    try {
      await unknownHarness.adapter.prepare(unknownCommand, {
        kind: "protected", bearer: unknownBearer, approval: null, childBindingGrant: null,
      }, trustedContext());
      assert.ok(await unknownHarness.pending.get(PROJECT_ID, unknownCommand.commandId, unknownCommand.idempotencyKey));
      // Timeout and worker death do not call complete; the sealed record remains.
      assert.ok(await unknownHarness.pending.get(PROJECT_ID, unknownCommand.commandId, unknownCommand.idempotencyKey));
      await assert.rejects(
        unknownHarness.adapter.complete(identity(unknownCommand), {
          kind: "unknown", errorCode: "COMMAND_OUTCOME_UNKNOWN",
        }),
        (error) => expectCode("COMMAND_OUTCOME_UNKNOWN", error),
      );
      assert.ok(await unknownHarness.pending.get(PROJECT_ID, unknownCommand.commandId, unknownCommand.idempotencyKey));
    } finally {
      unknownBearer.destroy();
    }

    const successHarness = harness();
    const successCommand = rootStart("00000000-0000-4000-8000-000000000022");
    const initialContext = trustedContext({
      authoritySessionId: null,
      targetSessionId: null,
      capabilityKind: null,
      capabilityGeneration: null,
    });
    await successHarness.adapter.prepare(successCommand, { kind: "initial-authority" }, initialContext);
    assert.deepEqual(
      await successHarness.adapter.complete(identity(successCommand), success({ sessionId: ROOT_SESSION_ID })),
      { publicResult: { sessionId: ROOT_SESSION_ID }, authorityMaterialStatus: "not-issued", recoveryCode: null },
    );
    assert.equal(await successHarness.pending.get(PROJECT_ID, successCommand.commandId, successCommand.idempotencyKey), null);

    const rejectedHarness = harness();
    const rejectedCommand = rootStart("00000000-0000-4000-8000-000000000023");
    await rejectedHarness.adapter.prepare(rejectedCommand, { kind: "initial-authority" }, initialContext);
    await assert.rejects(
      rejectedHarness.adapter.complete(identity(rejectedCommand), {
        kind: "rejected", errorCode: "SESSION_STATE_CONFLICT",
      }),
      (error) => expectCode("SESSION_STATE_CONFLICT", error),
    );
    assert.equal(await rejectedHarness.pending.get(PROJECT_ID, rejectedCommand.commandId, rejectedCommand.idempotencyKey), null);
  });

  it("strict-decodes descriptor wrappers, rejects tampering, and retains retry state on delivery failure", async () => {
    const local = harness();
    local.channel.local = PRIMARY_A;
    local.channel.attached.add(targetKey(PRIMARY_A));
    const command = rootStart();
    const context = trustedContext({
      authoritySessionId: null,
      targetSessionId: null,
      capabilityKind: null,
      capabilityGeneration: null,
    });
    await local.adapter.prepare(command, { kind: "initial-authority" }, context);
    const valid = descriptor(local.capabilityService, local.provider, PRIMARY_A);

    const malformed: unknown[] = [
      { ...valid, extra: "private" },
      { ...valid, target: { ...valid.target, extra: "private" } },
      { ...valid, authorityCommitment: "short" },
      { ...valid, capabilityGeneration: "07" },
      { ...valid, materials: [{ ...valid.materials[0], extra: true }] },
      {
        ...valid,
        materials: [{
          ...valid.materials[0],
          claims: { ...valid.materials[0]!.claims, extra: true },
        }],
      },
    ];
    for (const candidate of malformed) {
      const calls = local.provider.calls.length;
      await assert.rejects(
        local.adapter.complete(identity(command), success(
          { sessionId: ROOT_SESSION_ID },
          candidate as AuthorityMaterialDescriptorV1,
        )),
        (error) => expectCode("SESSION_CAPABILITY_INVALID", error),
      );
      assert.equal(reconstructionCalls(local.provider, calls), 0);
      assert.ok(await local.pending.get(PROJECT_ID, command.commandId, command.idempotencyKey));
    }

    const wrongVerifier: AuthorityMaterialDescriptorV1 = {
      ...valid,
      target: { actorRole: valid.target.actorRole, clientInstanceId: valid.target.clientInstanceId },
      materials: valid.materials.map((material, index) => index === 0
        ? { claims: material.claims, verifier: "f".repeat(64) }
        : material),
    };
    await assert.rejects(
      local.adapter.complete(identity(command), success({ sessionId: ROOT_SESSION_ID }, wrongVerifier)),
      (error) => expectCode("SESSION_CAPABILITY_INVALID", error),
    );
    assert.ok(await local.pending.get(PROJECT_ID, command.commandId, command.idempotencyKey));

    const result = await local.adapter.complete(identity(command), success({ sessionId: ROOT_SESSION_ID }, valid));
    assert.deepEqual(result, {
      publicResult: { sessionId: ROOT_SESSION_ID },
      authorityMaterialStatus: "current",
      recoveryCode: null,
    });
    assert.deepEqual(local.channel.deliveries, [{ target: PRIMARY_A, kind: "root" }]);
    assert.equal(await local.pending.get(PROJECT_ID, command.commandId, command.idempotencyKey), null);
  });

  it("returns only safe status and retains unavailable material until exact replay is acknowledged", async () => {
    const staleHarness = harness();
    const staleCommand = rootStart();
    const initialContext = trustedContext({
      authoritySessionId: null,
      targetSessionId: null,
      capabilityKind: null,
      capabilityGeneration: null,
    });
    await staleHarness.adapter.prepare(staleCommand, { kind: "initial-authority" }, initialContext);
    const stale = await staleHarness.adapter.complete(
      identity(staleCommand),
      success({ sessionId: ROOT_SESSION_ID }, null, "stale", "SESSION_HANDLE_STALE"),
    );
    assert.deepEqual(stale, {
      publicResult: { sessionId: ROOT_SESSION_ID },
      authorityMaterialStatus: "stale",
      recoveryCode: "SESSION_HANDLE_STALE",
    });
    assert.equal("descriptor" in stale, false);

    const detachedHarness = harness();
    const detachedCommand = rootStart("00000000-0000-4000-8000-000000000024");
    const prepared = await detachedHarness.adapter.prepare(
      detachedCommand,
      { kind: "initial-authority" },
      initialContext,
    );
    const current = descriptor(detachedHarness.capabilityService, detachedHarness.provider, PRIMARY_A);
    const detached = await detachedHarness.adapter.complete(
      identity(detachedCommand),
      success({ sessionId: ROOT_SESSION_ID }, current),
    );
    assert.deepEqual(detached, {
      publicResult: { sessionId: ROOT_SESSION_ID },
      authorityMaterialStatus: "unavailable",
      recoveryCode: "AUTHORITY_TARGET_DETACHED",
    });
    assert.equal(detachedHarness.channel.deliveries.length, 0);
    assert.equal(detachedHarness.channel.routes.length, 0);
    assert.ok(await detachedHarness.pending.get(
      PROJECT_ID,
      detachedCommand.commandId,
      detachedCommand.idempotencyKey,
    ));

    detachedHarness.channel.local = PRIMARY_A;
    detachedHarness.channel.attached.add(targetKey(PRIMARY_A));
    assert.deepEqual(
      await detachedHarness.adapter.resumePending(identity(detachedCommand), initialContext),
      prepared,
    );
    assert.deepEqual(
      await detachedHarness.adapter.complete(
        identity(detachedCommand),
        success({ sessionId: ROOT_SESSION_ID }, current),
      ),
      {
        publicResult: { sessionId: ROOT_SESSION_ID },
        authorityMaterialStatus: "current",
        recoveryCode: null,
      },
    );
    assert.deepEqual(detachedHarness.channel.deliveries, [{ target: PRIMARY_A, kind: "root" }]);
    assert.equal(await detachedHarness.pending.get(
      PROJECT_ID,
      detachedCommand.commandId,
      detachedCommand.idempotencyKey,
    ), null);

    const unavailableHarness = harness();
    const unavailableCommand = rootStart("00000000-0000-4000-8000-000000000025");
    await unavailableHarness.adapter.prepare(unavailableCommand, { kind: "initial-authority" }, initialContext);
    assert.deepEqual(
      await unavailableHarness.adapter.complete(
        identity(unavailableCommand),
        success(
          { sessionId: ROOT_SESSION_ID },
          null,
          "unavailable",
          "SESSION_CAPABILITY_KEY_UNAVAILABLE",
        ),
      ),
      {
        publicResult: { sessionId: ROOT_SESSION_ID },
        authorityMaterialStatus: "unavailable",
        recoveryCode: "SESSION_CAPABILITY_KEY_UNAVAILABLE",
      },
    );
    assert.ok(await unavailableHarness.pending.get(
      PROJECT_ID,
      unavailableCommand.commandId,
      unavailableCommand.idempotencyKey,
    ));
  });

  it("routes maintenance recovery only to the approval primary and reconstructs only at that target", async () => {
    const source = harness();
    const target = harness({ provider: new DeterministicCapabilityKeyProvider() });
    source.channel.local = PRIMARY_B;
    target.channel.local = PRIMARY_B;
    target.channel.attached.add(targetKey(PRIMARY_B));
    source.channel.attached.add(targetKey(PRIMARY_B));
    source.channel.routeHandler = (routedTarget, routedDescriptor) =>
      target.adapter.acceptRoutedDescriptor(routedTarget, routedDescriptor);

    const command = rootRecovery();
    const context = trustedContext({
      context: projectContext({ actorRole: "maintenance", clientInstanceId: "maintenance-a" }),
      capabilityKind: null,
      capabilityGeneration: null,
      authorityTarget: PRIMARY_B,
    });
    const approval = recoveryApproval(source.provider, command, context);
    try {
      await source.adapter.prepare(command, {
        kind: "protected", bearer: null, approval, childBindingGrant: null,
      }, context);
      const issued = descriptor(target.capabilityService, target.provider, PRIMARY_B, "root-session-handle", ROOT_SESSION_ID, "8");
      const sourceCallStart = source.provider.calls.length;
      const targetCallStart = target.provider.calls.length;
      const result = await source.adapter.complete(identity(command), success({ recovered: true }, issued));
      assert.deepEqual(result, { publicResult: { recovered: true }, authorityMaterialStatus: "current", recoveryCode: null });
      assert.deepEqual(source.channel.routes.map((route) => route.target), [PRIMARY_B]);
      assert.equal(source.channel.deliveries.length, 0);
      assert.equal(reconstructionCalls(source.provider, sourceCallStart), 0);
      assert.ok(reconstructionCalls(target.provider, targetCallStart) > 0);
      assert.deepEqual(target.channel.deliveries, [{ target: PRIMARY_B, kind: "root" }]);

      await assert.rejects(
        target.adapter.acceptRoutedDescriptor(PRIMARY_A, issued),
        (error) => expectCode("SESSION_CAPABILITY_INVALID", error),
      );
    } finally {
      approval.destroy();
    }
  });

  it("routes fork authority only to its granted child and every non-target source makes zero reconstruction calls", async () => {
    const source = harness();
    const target = harness({ provider: new DeterministicCapabilityKeyProvider() });
    source.channel.local = CHILD_A;
    target.channel.local = CHILD_A;
    target.channel.attached.add(targetKey(CHILD_A));
    source.channel.attached.add(targetKey(CHILD_A));
    source.channel.routeHandler = (routedTarget, routedDescriptor) =>
      target.adapter.acceptRoutedDescriptor(routedTarget, routedDescriptor);

    const command = forkChild();
    const rootBearer = bearer(source.provider);
    const grant = issueGrant(source.provider, CHILD_A);
    const context = trustedContext({ authorityTarget: CHILD_A, targetBindingFingerprint: TARGET_BINDING_FINGERPRINT });
    try {
      await source.adapter.prepare(command, {
        kind: "protected", bearer: rootBearer, approval: null, childBindingGrant: grant.secret,
      }, context);
      const childDescriptor = descriptor(
        target.capabilityService,
        target.provider,
        CHILD_A,
        "child-session-handle",
        CHILD_SESSION_ID,
        "1",
      );
      const sourceCallStart = source.provider.calls.length;
      const targetCallStart = target.provider.calls.length;
      await source.adapter.complete(identity(command), success({ childSessionId: CHILD_SESSION_ID }, childDescriptor));
      assert.deepEqual(source.channel.routes.map((route) => route.target), [CHILD_A]);
      assert.equal(source.channel.deliveries.length, 0);
      assert.equal(reconstructionCalls(source.provider, sourceCallStart), 0);
      assert.ok(reconstructionCalls(target.provider, targetCallStart) > 0);
      assert.deepEqual(target.channel.deliveries, [{ target: CHILD_A, kind: "child" }]);

      const wrongChildDescriptor = {
        ...childDescriptor,
        target: { actorRole: "untrusted" as const, clientInstanceId: CHILD_B.clientInstanceId },
      };
      await assert.rejects(
        target.adapter.acceptRoutedDescriptor(CHILD_A, wrongChildDescriptor),
        (error) => expectCode("SESSION_CAPABILITY_INVALID", error),
      );
    } finally {
      rootBearer.destroy();
      grant.secret.destroy();
    }
  });

  it("rejects extra worker-result fields before deleting or reconstructing", async () => {
    const current = harness();
    const command = rootStart();
    const context = trustedContext({
      authoritySessionId: null,
      targetSessionId: null,
      capabilityKind: null,
      capabilityGeneration: null,
    });
    await current.adapter.prepare(command, { kind: "initial-authority" }, context);
    const calls = current.provider.calls.length;
    await assert.rejects(
      current.adapter.complete(identity(command), {
        ...success({ sessionId: ROOT_SESSION_ID }),
        bearer: `pm${"cap1"}.${randomUUID()}`,
      } as unknown as WorkerLifecycleResult<{ sessionId: string }>),
      (error) => expectCode("SESSION_CAPABILITY_INVALID", error),
    );
    assert.equal(reconstructionCalls(current.provider, calls), 0);
    assert.ok(await current.pending.get(PROJECT_ID, command.commandId, command.idempotencyKey));
  });
});
