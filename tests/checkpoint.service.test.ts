import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import type { PersistedLifecycleAuthorizationRecord } from "../src/orchestrator/contracts/event.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import {
  decodeCheckpointDraftV1,
  decodeCheckpointV1,
} from "../src/orchestrator/lifecycle/contracts/checkpoint.js";
import type { RecordCheckpointCommandV2 } from "../src/orchestrator/lifecycle/contracts/commands.js";
import {
  LifecycleCommandStore,
  type LifecycleCommandEnvelope,
  type LifecycleEventAppendPort,
  type PreparedLifecycleCommit,
} from "../src/orchestrator/lifecycle/lifecycle-command.store.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import { buildLifecycleIntentWitness } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import type { SqliteConnection, SqliteStatement } from "../src/orchestrator/storage/sqlite-driver.js";
import { checkpointFixture } from "./support/lifecycle-fixtures.js";

const EXPECTED_RISKY_TRANSITIONS = Object.freeze([
  "ownership-transfer",
  "ownership-recovery",
  "suspension",
  "carry-forward-claim",
  "end-amendment",
  "end-cancellation",
  "abandonment",
] as const);

interface CheckpointServiceLike {
  record(transaction: unknown, command: unknown): {
    readonly append: {
      readonly events: readonly Readonly<Record<string, unknown>>[];
      readonly publicResponse: Readonly<Record<string, unknown>>;
    };
    readonly afterAppend: (committed: unknown, transaction: unknown) => void;
  };
}

type CheckpointServiceModule = Readonly<Record<string, unknown>> & {
  readonly CheckpointService?: new (options: unknown) => CheckpointServiceLike;
  readonly checkpointAgeDiagnosticV1?: (input: unknown) => Readonly<Record<string, unknown>>;
  readonly requireRiskyTransitionCheckpointV1?: (input: unknown) => unknown;
};

async function optionalCheckpointServiceModule(): Promise<CheckpointServiceModule> {
  const moduleSpecifier = "../src/orchestrator/lifecycle/checkpoint.service.js";
  try {
    return await import(moduleSpecifier) as CheckpointServiceModule;
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { readonly code?: unknown }).code === "ERR_MODULE_NOT_FOUND"
    ) {
      class MissingCheckpointService implements CheckpointServiceLike {
        record(): ReturnType<CheckpointServiceLike["record"]> {
          return {
            append: { events: Object.freeze([]), publicResponse: Object.freeze({}) },
            afterAppend: () => undefined,
          };
        }
      }
      return Object.freeze({ CheckpointService: MissingCheckpointService });
    }
    throw error;
  }
}

function childSessionId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE_ID = "a".repeat(64);
const ROOT_ID = "33333333-3333-4333-8333-333333333333";
const CHILD_ID = "44444444-4444-4444-8444-444444444444";
const COMMAND_ID = "55555555-5555-4555-8555-555555555555";
const IDEMPOTENCY_KEY = "checkpoint-test/v1";
const CHECKPOINT_ID = "66666666-6666-4666-8666-666666666666";
const CREATED_AT = "2026-07-18T01:02:03.004Z";

function draft(): Readonly<Record<string, unknown>> {
  const fixture = checkpointFixture();
  const {
    checkpointId: _checkpointId,
    sessionId: _sessionId,
    parentSessionId: _parentSessionId,
    baseEventPosition: _baseEventPosition,
    checkpointEventPosition: _checkpointEventPosition,
    createdAt: _createdAt,
    creatorAgentId: _creatorAgentId,
    creatorClientInstanceId: _creatorClientInstanceId,
    sourceState: _sourceState,
    childSummaries: _childSummaries,
    evidenceCoverage: _evidenceCoverage,
    ...content
  } = fixture;
  return content;
}

function checkpointCommand(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    commandType: "record-checkpoint",
    commandId: COMMAND_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    agentId: "agent-checkpoint",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: "refs/heads/current",
    sessionId: ROOT_ID,
    expectedStreamVersion: "3",
    expectedBaseEventPosition: "50",
    draft: draft(),
    ...overrides,
  });
}

function contextAndScope(projectRoot: string): {
  readonly context: ProjectContext;
  readonly scope: Readonly<Record<string, unknown>>;
} {
  const vaultRoot = join(projectRoot, "memory");
  const descriptorPath = join(vaultRoot, ".project", "descriptor.json");
  const storeRoot = join(projectRoot, ".store", "v2");
  const privateStateRoot = join(projectRoot, ".private");
  mkdirSync(join(vaultRoot, ".project"), { recursive: true });
  mkdirSync(storeRoot, { recursive: true });
  mkdirSync(privateStateRoot, { recursive: true });
  const workspace = {
    kind: "git" as const,
    worktreeRoot: projectRoot,
    gitDir: join(projectRoot, ".git"),
    gitCommonDir: join(projectRoot, ".git"),
    headCommit: "1".repeat(40),
    branchRef: "refs/heads/current",
    detached: false,
    workspaceId: WORKSPACE_ID as ProjectContext["workspace"]["workspaceId"],
  };
  const context: ProjectContext = {
    binding: {
      projectBindingId: "checkpoint-binding",
      generation: 1,
      contextFingerprint: "c".repeat(64),
      source: "explicit-cli",
      projectId: PROJECT_ID as ProjectContext["binding"]["projectId"],
      vaultId: VAULT_ID as ProjectContext["binding"]["vaultId"],
      storeId: STORE_ID as ProjectContext["binding"]["storeId"],
      workspaceId: WORKSPACE_ID as ProjectContext["binding"]["workspaceId"],
      clientNamespace: "tests",
      clientInstanceId: "primary-client",
      actorRole: "primary",
      projectRoot,
      vaultRoot,
      descriptorPath,
      storeRoute: {
        kind: "git-common",
        storeRoot,
        eventsPath: join(storeRoot, "events.sqlite"),
        storeManifestPath: join(storeRoot, "store-manifest.json"),
        projectionManifestPath: join(storeRoot, "projection-manifest.json"),
      },
      workspace,
      establishedAt: CREATED_AT,
    },
    workspace,
    checkedAt: CREATED_AT,
  };
  return {
    context,
    scope: Object.freeze({
      scopeVersion: 1,
      descriptorPath,
      storeRoot,
      privateStateRoot,
      exactMaterializationTargets: Object.freeze([]),
      exactCommittedTempPaths: Object.freeze([]),
    }),
  };
}

interface AuthorityHarness {
  readonly transaction: Readonly<Record<string, unknown>>;
  readonly calls: {
    checkpointUpdates: unknown[];
    clears: unknown[];
    sourceCaptures: unknown[];
    latestCheckpointReads: unknown[];
  };
}

function authorityHarness(options: {
  readonly basePosition?: bigint;
  readonly markerPosition?: bigint | null;
  readonly faultPoint?: string;
  readonly corruptLatestCheckpointFingerprint?: boolean;
  readonly corruptChildLatestCheckpointFingerprint?: boolean;
} = {}): AuthorityHarness {
  const calls = {
    checkpointUpdates: [] as unknown[],
    clears: [] as unknown[],
    sourceCaptures: [] as unknown[],
    latestCheckpointReads: [] as unknown[],
  };
  const priorCheckpointId = options.corruptLatestCheckpointFingerprint === true
    ? "77777777-7777-4777-8777-777777777777"
    : null;
  const childCheckpointId = options.corruptChildLatestCheckpointFingerprint === true
    ? "88888888-8888-4888-8888-888888888888"
    : null;
  const root = Object.freeze({
    projectId: PROJECT_ID,
    sessionId: ROOT_ID,
    streamId: `session/${ROOT_ID}`,
    sessionKind: "root",
    parentSessionId: null,
    workspaceId: WORKSPACE_ID,
    semanticState: "active",
    latestCheckpointId: priorCheckpointId,
    latestCheckpointEventPosition: priorCheckpointId === null ? null : 49n,
    latestCheckpointFingerprint: priorCheckpointId === null ? null : "f".repeat(64),
    checkpointRequiredReason: options.markerPosition == null ? null : "accepted-child-report",
    checkpointRequiredEventPosition: options.markerPosition ?? null,
  });
  const child = Object.freeze({
    projectId: PROJECT_ID,
    sessionId: CHILD_ID,
    streamId: `session/${CHILD_ID}`,
    sessionKind: "child",
    parentSessionId: ROOT_ID,
    workspaceId: WORKSPACE_ID,
    semanticState: "active",
    latestCheckpointId: childCheckpointId,
    latestCheckpointEventPosition: childCheckpointId === null ? null : 39n,
    latestCheckpointFingerprint: childCheckpointId === null ? null : "e".repeat(64),
  });
  const rootAggregate = Object.freeze({
    kind: "root",
    state: "active",
    projectId: PROJECT_ID,
    sessionId: ROOT_ID,
    parentSessionId: null,
    streamId: `session/${ROOT_ID}`,
    workspaceId: WORKSPACE_ID,
    streamVersion: 3n,
    eventPosition: 30n,
    terminalEventPosition: null,
    correlationId: "77777777-7777-4777-8777-777777777777",
    latestCheckpointId: priorCheckpointId,
    latestCheckpointEventPosition: priorCheckpointId === null ? null : 49n,
    latestCheckpointBaseEventPosition: priorCheckpointId === null ? null : 48n,
  });
  const childAggregate = Object.freeze({
    kind: "child",
    state: "active",
    projectId: PROJECT_ID,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    streamId: `session/${CHILD_ID}`,
    workspaceId: WORKSPACE_ID,
    streamVersion: 2n,
    eventPosition: 40n,
    terminalEventPosition: null,
    latestCheckpointId: childCheckpointId,
    latestCheckpointEventPosition: childCheckpointId === null ? null : 39n,
    latestCheckpointBaseEventPosition: childCheckpointId === null ? null : 38n,
  });
  const authority = Object.freeze({
    get: (projectId: string, sessionId: string) => projectId === PROJECT_ID && sessionId === ROOT_ID ? root : null,
    requireFoldMatch: (record: { readonly sessionId: string }) => record.sessionId === ROOT_ID ? rootAggregate : childAggregate,
    latestCheckpoint: (record: { readonly sessionId: string }) => {
      calls.latestCheckpointReads.push(record);
      if (options.corruptLatestCheckpointFingerprint === true && record.sessionId === ROOT_ID) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      if (options.corruptChildLatestCheckpointFingerprint === true && record.sessionId === CHILD_ID) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      return null;
    },
    listNonterminalChildren: (projectId: string, rootSessionId: string) =>
      projectId === PROJECT_ID && rootSessionId === ROOT_ID ? Object.freeze([child]) : Object.freeze([]),
    nextGlobalPosition: () => (options.basePosition ?? 50n) + 1n,
    updateCheckpointIndex: (input: unknown) => {
      if (options.faultPoint === "before-checkpoint-index-cas") throw new Error("INJECTED_CHECKPOINT_CRASH");
      calls.checkpointUpdates.push(input);
      return true;
    },
    clearCheckpointRequired: (input: unknown) => {
      calls.clears.push(input);
      return options.markerPosition !== null && options.markerPosition !== undefined;
    },
  });
  return {
    calls,
    transaction: Object.freeze({ authority }),
  };
}

async function checkpointServiceFixture(options: {
  readonly basePosition?: bigint;
  readonly markerPosition?: bigint | null;
  readonly faultPoint?: string;
  readonly corruptLatestCheckpointFingerprint?: boolean;
  readonly corruptChildLatestCheckpointFingerprint?: boolean;
} = {}): Promise<{
  readonly service: CheckpointServiceLike;
  readonly harness: AuthorityHarness;
  readonly context: ProjectContext;
  readonly cleanup: () => void;
}> {
  const module = await optionalCheckpointServiceModule();
  assert.equal(typeof module.CheckpointService, "function");
  const projectRoot = mkdtempSync(join(tmpdir(), "checkpoint-v1-"));
  const { context, scope } = contextAndScope(projectRoot);
  const harness = authorityHarness(options);
  const invocation = Object.freeze({
    context,
    sourceStateScope: scope,
    authorizationRecord: Object.freeze({ kind: "protected" }),
    freshCapabilityGeneration: "1",
  });
  const sourceStateProvider = Object.freeze({
    captureForCheckpoint: (observedContext: ProjectContext, observedScope: unknown) => {
      harness.calls.sourceCaptures.push({ observedContext, observedScope });
      return Object.freeze({
        sourceStateScopeVersion: 1,
        workspaceId: WORKSPACE_ID,
        branchRef: "refs/heads/current",
        headCommit: "2".repeat(40),
        dirtyWorktreeFingerprint: "d".repeat(64),
      });
    },
    captureForFinalization: (observedContext: ProjectContext, observedScope: unknown) => {
      harness.calls.sourceCaptures.push({ observedContext, observedScope, final: true });
      return Object.freeze({
        sourceStateScopeVersion: 1,
        workspaceId: WORKSPACE_ID,
        branchRef: "refs/heads/current",
        headCommit: "2".repeat(40),
        dirtyWorktreeFingerprint: "d".repeat(64),
      });
    },
  });
  const Service = module.CheckpointService!;
  return {
    service: new Service({
      invocationScope: { current: () => invocation },
      sourceStateProvider,
      identitySource: { uuid: () => CHECKPOINT_ID },
      clock: { now: () => CREATED_AT },
      coverageSnapshot: {
        capture: () => Object.freeze({
          captureMode: "coverage-only",
          contentRetained: false,
          highestContiguousOrdinal: "4",
          missingIntervals: Object.freeze([{ firstOrdinal: "5", lastOrdinal: "6" }]),
        }),
      },
      faultInjector: options.faultPoint === undefined ? undefined : (point: string) => {
        if (point === options.faultPoint) throw new Error("INJECTED_CHECKPOINT_CRASH");
      },
    }),
    harness,
    context,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function committedCheckpointBatch(position = 51n): Readonly<Record<string, unknown>> {
  return Object.freeze({
    events: Object.freeze([Object.freeze({
      globalPosition: position,
      streamVersion: 4n,
      eventType: "SessionCheckpointRecorded",
    })]),
    storedResponse: Object.freeze({}) as JsonValue,
    responseHash: "e".repeat(64),
  });
}

describe("Checkpoint Version 1 contract corrections", () => {
  it("records explicit non-retention in coverage-only checkpoint evidence", () => {
    const checkpoint = decodeCheckpointV1(checkpointFixture());
    assert.equal(
      (checkpoint.evidenceCoverage as unknown as { readonly contentRetained?: unknown }).contentRetained,
      false,
    );
  });

  it("does not apply the unrelated 200 material-entry cap to child summaries", () => {
    const checkpoint = checkpointFixture();
    const childSummaries = Array.from({ length: 201 }, (_, index) => ({
      childSessionId: childSessionId(index + 1),
      state: "active",
      lastEventPosition: (index + 1).toString(),
      streamVersion: "1",
      latestCheckpointId: null,
    }));

    const decoded = decodeCheckpointV1({ ...checkpoint, childSummaries });
    assert.equal(decoded.childSummaries.length, 201);
  });

  it("requires allowlisted confidence and rejects secret-bearing execution fields", () => {
    assert.throws(() => decodeCheckpointDraftV1({
      ...draft(),
      materialClaims: [{
        claimId: CHILD_ID,
        summary: "A material claim",
        evidenceReferences: ["coverage:1"],
        confidence: "certain",
      }],
    }), /LIFECYCLE_INPUT_INVALID/u);

    const execution = {
      label: "focused test",
      result: "passed",
      exitClassification: "passed",
      outputFingerprint: null,
      artifactReference: null,
      confidence: "high",
    };
    assert.equal(decodeCheckpointDraftV1({
      ...draft(),
      commandResults: [execution],
    }).commandResults.length, 1);
    for (const forbidden of ["rawOutput", "rawCommand", "environment", "secret"] as const) {
      assert.throws(() => decodeCheckpointDraftV1({
        ...draft(),
        commandResults: [{ ...execution, [forbidden]: "private" }],
      }), /LIFECYCLE_INPUT_INVALID/u, forbidden);
    }
  });
});

describe("Checkpoint age diagnostics", () => {
  it("reports the fixed time trigger and never fabricates a lifecycle event", async () => {
    const module = await optionalCheckpointServiceModule();
    assert.equal(typeof module.checkpointAgeDiagnosticV1, "function");
    const checkpoint = decodeCheckpointV1({
      ...checkpointFixture(),
      createdAt: "2026-07-18T01:00:00.000Z",
    });
    const authority = {
      projectId: PROJECT_ID,
      sessionId: checkpoint.sessionId,
      createdAt: "2026-07-18T00:00:00.000Z",
      latestCheckpointId: checkpoint.checkpointId,
      latestCheckpointEventPosition: BigInt(checkpoint.checkpointEventPosition),
      latestCheckpointFingerprint: createHash("sha256")
        .update("project-memory/checkpoint/v1\n", "utf8")
        .update(canonicalJson(checkpoint), "utf8")
        .digest("hex"),
      checkpointRequiredReason: null,
      checkpointRequiredEventPosition: null,
    };

    const fresh = module.checkpointAgeDiagnosticV1!({
      authority,
      checkpoint,
      observedAt: "2026-07-18T01:14:59.999Z",
    });
    const due = module.checkpointAgeDiagnosticV1!({
      authority,
      checkpoint,
      observedAt: "2026-07-18T01:15:00.000Z",
    });

    assert.equal(fresh.ageMilliseconds, "899999");
    assert.equal(fresh.checkpointDue, false);
    assert.equal(due.ageMilliseconds, "900000");
    assert.equal(due.checkpointDue, true);
    assert.equal(due.ageLimitMilliseconds, "900000");
    assert.equal(Object.hasOwn(due, "eventType"), false);
    assert.equal(Object.hasOwn(due, "events"), false);
    assert.equal(Object.hasOwn(due, "payload"), false);
  });
});

describe("RiskyTransitionPolicy Version 1", () => {
  it("exposes the complete fixed server transition enumeration", async () => {
    const checkpointService = await optionalCheckpointServiceModule();
    assert.deepEqual(checkpointService.RISKY_TRANSITIONS_V1, EXPECTED_RISKY_TRANSITIONS);
  });

  it("requires an unmarked latest checkpoint at the target stream tip", async () => {
    const module = await optionalCheckpointServiceModule();
    assert.equal(typeof module.requireRiskyTransitionCheckpointV1, "function");
    const checkpoint = decodeCheckpointV1(checkpointFixture());
    const authority = Object.freeze({
      projectId: checkpointFixture().sourceState.workspaceId,
      sessionId: checkpoint.sessionId,
      streamId: `session/${checkpoint.sessionId}`,
      sessionKind: "root",
      parentSessionId: null,
      workspaceId: checkpoint.sourceState.workspaceId,
      latestCheckpointId: checkpoint.checkpointId,
      latestCheckpointEventPosition: BigInt(checkpoint.checkpointEventPosition),
      latestCheckpointFingerprint: createHash("sha256")
        .update("project-memory/checkpoint/v1\n", "utf8")
        .update(canonicalJson(checkpoint), "utf8")
        .digest("hex"),
      checkpointRequiredReason: null,
      checkpointRequiredEventPosition: null,
    });
    const aggregate = Object.freeze({
      kind: "root",
      state: "active",
      projectId: authority.projectId,
      sessionId: authority.sessionId,
      streamId: authority.streamId,
      parentSessionId: null,
      workspaceId: authority.workspaceId,
      streamVersion: 2n,
      eventPosition: BigInt(checkpoint.checkpointEventPosition),
      latestCheckpointId: checkpoint.checkpointId,
      latestCheckpointBaseEventPosition: BigInt(checkpoint.baseEventPosition),
      latestCheckpointEventPosition: BigInt(checkpoint.checkpointEventPosition),
      terminalEventPosition: null,
    });

    assert.doesNotThrow(() => module.requireRiskyTransitionCheckpointV1!({
      authority,
      aggregate,
      checkpoint,
      relevantChildren: [],
    }));
    assert.throws(() => module.requireRiskyTransitionCheckpointV1!({
      authority,
      aggregate: { ...aggregate, eventPosition: aggregate.eventPosition + 1n },
      checkpoint,
      relevantChildren: [],
    }), /CHECKPOINT_BASE_INVALID/u);
    assert.throws(() => module.requireRiskyTransitionCheckpointV1!({
      authority: {
        ...authority,
        checkpointRequiredReason: "ownership-transfer",
        checkpointRequiredEventPosition: aggregate.eventPosition,
      },
      aggregate,
      checkpoint,
      relevantChildren: [],
    }), /CHECKPOINT_BASE_INVALID/u);
  });

  it("rejects a root checkpoint whose relevant child summary is stale", async () => {
    const module = await optionalCheckpointServiceModule();
    const childSession = childSessionId(900);
    const checkpoint = decodeCheckpointV1({
      ...checkpointFixture({ baseEventPosition: 10, checkpointEventPosition: 11 }),
      childSummaries: [{
        childSessionId: childSession,
        state: "active",
        lastEventPosition: "9",
        streamVersion: "3",
        latestCheckpointId: null,
      }],
    });
    const authority = {
      projectId: PROJECT_ID,
      sessionId: checkpoint.sessionId,
      streamId: `session/${checkpoint.sessionId}`,
      sessionKind: "root",
      parentSessionId: null,
      workspaceId: checkpoint.sourceState.workspaceId,
      latestCheckpointId: checkpoint.checkpointId,
      latestCheckpointEventPosition: 11n,
      latestCheckpointFingerprint: createHash("sha256")
        .update("project-memory/checkpoint/v1\n", "utf8")
        .update(canonicalJson(checkpoint), "utf8")
        .digest("hex"),
      checkpointRequiredReason: null,
      checkpointRequiredEventPosition: null,
    };
    const aggregate = {
      kind: "root",
      state: "active",
      projectId: PROJECT_ID,
      sessionId: checkpoint.sessionId,
      streamId: authority.streamId,
      parentSessionId: null,
      workspaceId: authority.workspaceId,
      streamVersion: 4n,
      eventPosition: 11n,
      latestCheckpointId: checkpoint.checkpointId,
      latestCheckpointBaseEventPosition: 10n,
      latestCheckpointEventPosition: 11n,
      terminalEventPosition: null,
    };
    const childAuthority = {
      projectId: PROJECT_ID,
      sessionId: childSession,
      streamId: `session/${childSession}`,
      sessionKind: "child",
      parentSessionId: checkpoint.sessionId,
      workspaceId: authority.workspaceId,
      terminalEventPosition: null,
    };
    const childAggregate = {
      kind: "child",
      state: "active",
      projectId: PROJECT_ID,
      sessionId: childSession,
      streamId: childAuthority.streamId,
      parentSessionId: checkpoint.sessionId,
      workspaceId: authority.workspaceId,
      streamVersion: 3n,
      eventPosition: 9n,
      latestCheckpointId: null,
      terminalEventPosition: null,
    };

    assert.doesNotThrow(() => module.requireRiskyTransitionCheckpointV1!({
      authority,
      aggregate,
      checkpoint,
      relevantChildren: [{ authority: childAuthority, aggregate: childAggregate }],
    }));
    assert.throws(() => module.requireRiskyTransitionCheckpointV1!({
      authority,
      aggregate,
      checkpoint,
      relevantChildren: [{
        authority: childAuthority,
        aggregate: { ...childAggregate, eventPosition: 10n },
      }],
    }), /CHECKPOINT_BASE_INVALID/u);
  });
});

describe("CheckpointService transactional enrichment", () => {
  it("derives the base, event position, source witness, coverage, and root child summaries", async () => {
    const fixture = await checkpointServiceFixture();
    try {
      const effect = fixture.service.record(fixture.harness.transaction, checkpointCommand());
      assert.equal(effect.append.events.length, 1);
      const event = effect.append.events[0] as {
        readonly eventType: unknown;
        readonly payload: {
          readonly baseEventPosition: unknown;
          readonly checkpointEventPosition: unknown;
          readonly checkpoint: Readonly<Record<string, unknown>>;
        };
      };
      assert.equal(event.eventType, "SessionCheckpointRecorded");
      assert.equal(event.payload.baseEventPosition, "50");
      assert.equal(event.payload.checkpointEventPosition, "51");
      assert.equal(event.payload.checkpoint.checkpointId, CHECKPOINT_ID);
      assert.equal(event.payload.checkpoint.createdAt, CREATED_AT);
      assert.equal(event.payload.checkpoint.creatorAgentId, "agent-checkpoint");
      assert.equal(event.payload.checkpoint.creatorClientInstanceId, "primary-client");
      assert.deepEqual(event.payload.checkpoint.childSummaries, [{
        childSessionId: CHILD_ID,
        state: "active",
        lastEventPosition: "40",
        streamVersion: "2",
        latestCheckpointId: null,
      }]);
      assert.deepEqual(event.payload.checkpoint.evidenceCoverage, {
        captureMode: "coverage-only",
        contentRetained: false,
        highestContiguousOrdinal: "4",
        missingIntervals: [{ firstOrdinal: "5", lastOrdinal: "6" }],
      });
      assert.equal(fixture.harness.calls.sourceCaptures.length, 1);
      assert.equal(effect.append.publicResponse.baseEventPosition, "50");
      assert.equal(effect.append.publicResponse.checkpointEventPosition, "51");
      assert.equal(effect.append.publicResponse.finalStreamVersion, "4");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects stale stream and base assertions before source-state capture", async () => {
    const fixture = await checkpointServiceFixture();
    try {
      assert.throws(
        () => fixture.service.record(fixture.harness.transaction, checkpointCommand({ expectedStreamVersion: "2" })),
        /EVENT_CONFLICT/u,
      );
      assert.throws(
        () => fixture.service.record(fixture.harness.transaction, checkpointCommand({ expectedBaseEventPosition: "49" })),
        /EVENT_CONFLICT/u,
      );
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a corrupt existing checkpoint fingerprint before enrichment or mutation", async () => {
    const fixture = await checkpointServiceFixture({ corruptLatestCheckpointFingerprint: true });
    try {
      assert.throws(
        () => fixture.service.record(fixture.harness.transaction, checkpointCommand()),
        /INTEGRITY_FAILURE/u,
      );
      assert.equal(fixture.harness.calls.latestCheckpointReads.length, 1);
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
      assert.equal(fixture.harness.calls.clears.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a corrupt nonterminal child checkpoint fingerprint before root enrichment", async () => {
    const fixture = await checkpointServiceFixture({ corruptChildLatestCheckpointFingerprint: true });
    try {
      assert.throws(
        () => fixture.service.record(fixture.harness.transaction, checkpointCommand()),
        (error: unknown) => (error as { readonly code?: unknown }).code === "INTEGRITY_FAILURE",
      );
      assert.equal(fixture.harness.calls.latestCheckpointReads.length, 2);
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
      assert.equal(fixture.harness.calls.clears.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a file assertion whose branch differs from the trusted source witness", async () => {
    const fixture = await checkpointServiceFixture();
    try {
      const maliciousDraft = {
        ...draft(),
        filesTouched: [{
          path: "src/observed.ts",
          action: "observed",
          contentHash: null,
          branchRef: "refs/heads/caller-selected",
          confidence: "high",
        }],
      };
      assert.throws(
        () => fixture.service.record(
          fixture.harness.transaction,
          checkpointCommand({ draft: maliciousDraft }),
        ),
        /LIFECYCLE_INPUT_INVALID/u,
      );
      assert.equal(fixture.harness.calls.sourceCaptures.length, 1);
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("updates the specialized checkpoint index and clears only a covered marker after append", async () => {
    const fixture = await checkpointServiceFixture({ markerPosition: 41n });
    try {
      const effect = fixture.service.record(fixture.harness.transaction, checkpointCommand());
      assert.equal(effect.append.publicResponse.checkpointRequiredCleared, true);
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
      assert.equal(fixture.harness.calls.clears.length, 0);

      effect.afterAppend(committedCheckpointBatch(), fixture.harness.transaction);

      assert.deepEqual(fixture.harness.calls.checkpointUpdates, [{
        projectId: PROJECT_ID,
        sessionId: ROOT_ID,
        expectedLatestCheckpointId: null,
        expectedLatestCheckpointEventPosition: null,
        expectedLatestCheckpointFingerprint: null,
        checkpointId: CHECKPOINT_ID,
        checkpointEventPosition: 51n,
        checkpointFingerprint: fixture.harness.calls.checkpointUpdates.length === 0
          ? undefined
          : (fixture.harness.calls.checkpointUpdates[0] as Record<string, unknown>).checkpointFingerprint,
        updatedAt: CREATED_AT,
      }]);
      assert.match(
        (fixture.harness.calls.checkpointUpdates[0] as { readonly checkpointFingerprint: string }).checkpointFingerprint,
        /^[0-9a-f]{64}$/u,
      );
      assert.deepEqual(fixture.harness.calls.clears, [{
        projectId: PROJECT_ID,
        sessionId: ROOT_ID,
        checkpointBaseEventPosition: 50n,
        updatedAt: CREATED_AT,
      }]);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not record or clear a checkpoint based before the triggering marker", async () => {
    const fixture = await checkpointServiceFixture({ basePosition: 40n, markerPosition: 41n });
    try {
      assert.throws(
        () => fixture.service.record(
          fixture.harness.transaction,
          checkpointCommand({ expectedBaseEventPosition: "40" }),
        ),
        /CHECKPOINT_BASE_INVALID/u,
      );
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
      assert.equal(fixture.harness.calls.clears.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("leaves the existing marker untouched when a crash occurs before checkpoint-index CAS", async () => {
    const fixture = await checkpointServiceFixture({ markerPosition: 41n, faultPoint: "before-checkpoint-index-cas" });
    try {
      const effect = fixture.service.record(fixture.harness.transaction, checkpointCommand());
      assert.throws(
        () => effect.afterAppend(committedCheckpointBatch(), fixture.harness.transaction),
        /INJECTED_CHECKPOINT_CRASH/u,
      );
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
      assert.equal(fixture.harness.calls.clears.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("surfaces a crash between checkpoint-index CAS and marker clearing", async () => {
    const fixture = await checkpointServiceFixture({
      markerPosition: 41n,
      faultPoint: "after-checkpoint-index-before-marker-clear",
    });
    try {
      const effect = fixture.service.record(fixture.harness.transaction, checkpointCommand());
      assert.throws(
        () => effect.afterAppend(committedCheckpointBatch(), fixture.harness.transaction),
        /INJECTED_CHECKPOINT_CRASH/u,
      );
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 1);
      assert.equal(fixture.harness.calls.clears.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("returns an exact stored checkpoint retry before invoking enrichment", async () => {
    const fixture = await checkpointServiceFixture();
    try {
      const command = checkpointCommand() as unknown as RecordCheckpointCommandV2;
      const principal = Object.freeze({ actorRole: "primary" as const, clientInstanceId: "primary-client" });
      const replayExpectation = Object.freeze({
        kind: "protected" as const,
        proof: Object.freeze({ version: 1 as const, nonce: "88888888-8888-4888-8888-888888888888", digest: "8".repeat(64) }),
        approval: null,
        authorizationSessionId: ROOT_ID,
        targetSessionId: ROOT_ID,
        presenting: principal,
        target: principal,
      });
      const authorization = replayExpectation as PersistedLifecycleAuthorizationRecord;
      const witness = buildLifecycleIntentWitness(command, {
        authorizationKind: "protected",
        authorizationSessionId: ROOT_ID,
        targetSessionId: ROOT_ID,
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
        workspaceId: WORKSPACE_ID,
        clientNamespace: "tests",
        capabilityKind: "root-session-handle",
        capabilityGeneration: "1",
        presentingActorRole: "primary",
        presentingClientInstanceId: "primary-client",
        targetActorRole: "primary",
        targetClientInstanceId: "primary-client",
        internalWorkflowId: null,
        internalWorkflowGeneration: null,
        internalPlannedWorkId: null,
      });
      const response = Object.freeze({
        checkpointVersion: 1,
        checkpointId: CHECKPOINT_ID,
        sessionId: ROOT_ID,
        baseEventPosition: "50",
        checkpointEventPosition: "51",
        finalStreamVersion: "4",
        checkpointRequiredCleared: false,
      });
      const statements: string[] = [];
      const connection = {
        exec(sql: string) { statements.push(sql.trim().toUpperCase()); },
        prepare(): SqliteStatement { throw new Error("replay must not prepare SQL through the connection facade"); },
        close() {},
      } as SqliteConnection;
      const events = {
        findLifecycleReplay: () => ({
          deduplicated: true,
          firstGlobalPosition: 51n,
          lastGlobalPosition: 51n,
          finalStreamVersion: 4n,
          eventIds: ["99999999-9999-4999-8999-999999999999"],
          response,
          responseHash: "9".repeat(64),
          authorizationRecord: authorization,
        }),
      } as unknown as LifecycleEventAppendPort;
      const store = new LifecycleCommandStore({
        connection,
        events,
        transaction: () => { throw new Error("exact replay must not construct transaction facades"); },
      });
      const envelope: LifecycleCommandEnvelope = {
        context: fixture.context,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.commandType,
        candidateIntentHash: witness.intentHash,
        authoritativeIntentHash: witness.intentHash,
        semanticCommand: command,
        capabilityKind: "root-session-handle",
        capabilityGeneration: "1",
        replayExpectation,
      };
      let freshCallbacks = 0;

      const replay = store.execute(envelope, (transaction) => {
        freshCallbacks += 1;
        return fixture.service.record(transaction, command) as unknown as PreparedLifecycleCommit<JsonValue>;
      });

      assert.equal(replay.deduplicated, true);
      assert.deepEqual(replay.publicResult, response);
      assert.equal(freshCallbacks, 0);
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
      assert.deepEqual(statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a project-relative path whose existing symlink component escapes the project", async () => {
    const fixture = await checkpointServiceFixture();
    const outside = mkdtempSync(join(tmpdir(), "checkpoint-outside-"));
    try {
      symlinkSync(outside, join(fixture.context.binding.projectRoot, "linked-outside"), "junction");
      const unsafeDraft = {
        ...draft(),
        filesTouched: [{
          path: "linked-outside/secret.txt",
          action: "observed",
          contentHash: null,
          branchRef: null,
          confidence: "high",
        }],
      };
      assert.throws(
        () => fixture.service.record(
          fixture.harness.transaction,
          checkpointCommand({ draft: unsafeDraft }),
        ),
        /LIFECYCLE_INPUT_INVALID|PATH_OUTSIDE_ROOT/u,
      );
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
    } finally {
      fixture.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
