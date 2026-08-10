import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import {
  BoundSessionEndRepository,
  hydrateSessionEndEffectiveStateV1,
  readPersistedValidationAttemptPlansV1,
  writePersistedValidationAttemptPlansV1,
} from "../src/orchestrator/storage/session-end.repository.js";
import { buildLifecycleIntentWitness } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import {
  EFFECTIVE_STATE_SESSION_ID,
  sessionEndEffectiveStateFixture,
} from "./support/session-end-effective-state-reference.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";

class NativeStatement implements SqliteStatement {
  constructor(private readonly statement: import("node:sqlite").StatementSync) {
    statement.setReadBigInts(true);
  }
  run(params?: SqliteParams): SqliteRunResult {
    const result = params === undefined ? this.statement.run() : this.statement.run(params);
    return { changes: result.changes as bigint, lastInsertRowid: result.lastInsertRowid as bigint };
  }
  get(params?: SqliteParams): SqliteRow | undefined { return (params === undefined ? this.statement.get() : this.statement.get(params)) as SqliteRow | undefined; }
  all(params?: SqliteParams): SqliteRow[] { return (params === undefined ? this.statement.all() : this.statement.all(params)) as SqliteRow[]; }
  iterate(params?: SqliteParams): IterableIterator<SqliteRow> { return (params === undefined ? this.statement.iterate() : this.statement.iterate(params)) as IterableIterator<SqliteRow>; }
}

class NativeConnection implements SqliteConnection {
  readonly database = new DatabaseSync(":memory:");
  exec(sql: string): void { this.database.exec(sql); }
  prepare(sql: string): SqliteStatement { return new NativeStatement(this.database.prepare(sql)); }
  close(): void { this.database.close(); }
}

function planConnection(): NativeConnection {
  const connection = new NativeConnection();
  connection.exec(`CREATE TABLE workflow_instances (
    project_id TEXT NOT NULL, workflow_id TEXT NOT NULL, session_id TEXT NOT NULL,
    generation INTEGER NOT NULL, validation_attempt_plan_generation INTEGER,
    validation_attempt_plans_json TEXT, PRIMARY KEY(project_id, workflow_id)
  ) STRICT;
  INSERT INTO workflow_instances VALUES (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', 1, NULL, NULL
  );`);
  return connection;
}

const moduleUrl = new URL(
  "../src/orchestrator/storage/session-end.repository.js",
  import.meta.url,
).href;

const HYDRATION_PROJECT = "11111111-1111-4111-8111-111111111111";
const HYDRATION_WORKFLOW = "22222222-2222-4222-8222-222222222222";
const HYDRATION_COMMAND = "33333333-3333-4333-8333-333333333333";

function requestIntent(state: ReturnType<typeof sessionEndEffectiveStateFixture>) {
  return buildLifecycleIntentWitness({
    commandType: "request-session-end", commandId: HYDRATION_COMMAND,
    idempotencyKey: "hydration/request", agentId: "agent-primary",
    expectedProjectId: HYDRATION_PROJECT, expectedVaultId: "55555555-5555-4555-8555-555555555555",
    expectedWorkspaceId: "a".repeat(64), expectedBranchRef: null, request: state.request,
  } as never, {
    authorizationKind: "protected", authorizationSessionId: EFFECTIVE_STATE_SESSION_ID,
    targetSessionId: EFFECTIVE_STATE_SESSION_ID, projectId: HYDRATION_PROJECT,
    vaultId: "55555555-5555-4555-8555-555555555555", storeId: "66666666-6666-4666-8666-666666666666",
    workspaceId: "a".repeat(64), clientNamespace: "tests", capabilityKind: "root-session-handle",
    capabilityGeneration: "1", presentingActorRole: "primary", presentingClientInstanceId: "client-primary",
    targetActorRole: "primary", targetClientInstanceId: "client-primary", internalWorkflowId: null,
    internalWorkflowGeneration: null, internalPlannedWorkId: null,
  } as never).source;
}

type EvidenceWindowAction = "unchanged" | "open" | "seal";

function hydrationConnection(options: {
  readonly amend?: boolean;
  readonly cancelled?: boolean;
  readonly mutateIntent?: boolean;
  readonly mutateHash?: boolean;
  readonly malformedSourceEvent?: boolean;
  readonly sourcePosition?: bigint;
  readonly foldSourcePosition?: bigint;
  readonly evidenceWindowAction?: EvidenceWindowAction;
  readonly previousEvidenceWindowState?: "open" | "sealed";
  readonly evidenceWindowState?: "open" | "sealed";
  readonly amendmentMutation?: Readonly<Record<string, unknown>>;
  readonly malformedAmendmentVersion?: boolean;
} = {}): NativeConnection {
  const connection = new NativeConnection();
  const state = sessionEndEffectiveStateFixture({ requestVersion: 2 });
  const eventType = options.amend ? "SessionEndAmended" : "SessionEndRequested";
  const generation = options.amend ? 2 : 1;
  const evidenceWindowAction = options.evidenceWindowAction ?? "unchanged";
  const amendment = {
    amendmentVersion: 2 as const,
    childEndPolicy: null,
    finalCheckpoint: null,
    validationProfileIds: null,
    requestedQualityThreshold: null,
    requireFullEvidence: null,
    requireMaterialization: null,
    evidenceWindowAction,
  };
  const command = options.amend ? {
    commandType: "amend-session-end", commandId: HYDRATION_COMMAND, idempotencyKey: "hydration/amend", agentId: "agent-primary",
    expectedProjectId: HYDRATION_PROJECT, expectedVaultId: "55555555-5555-4555-8555-555555555555", expectedWorkspaceId: "a".repeat(64), expectedBranchRef: null,
    sessionId: EFFECTIVE_STATE_SESSION_ID, workflowId: HYDRATION_WORKFLOW, expectedStreamVersion: "1",
    amendment: { ...amendment, ...options.amendmentMutation },
  } : null;
  const assertions = {
    authorizationKind: "protected", authorizationSessionId: EFFECTIVE_STATE_SESSION_ID, targetSessionId: EFFECTIVE_STATE_SESSION_ID,
    projectId: HYDRATION_PROJECT, vaultId: "55555555-5555-4555-8555-555555555555", storeId: "66666666-6666-4666-8666-666666666666", workspaceId: "a".repeat(64), clientNamespace: "tests", capabilityKind: "root-session-handle", capabilityGeneration: "1", presentingActorRole: "primary", presentingClientInstanceId: "client-primary", targetActorRole: "primary", targetClientInstanceId: "client-primary", internalWorkflowId: null, internalWorkflowGeneration: null, internalPlannedWorkId: null,
  } as never;
  let intentSource = command === null ? requestIntent(state) : buildLifecycleIntentWitness(command as never, assertions).source;
  if (options.malformedAmendmentVersion) {
    const witness = JSON.parse(intentSource) as { intent: { command: { amendment: { amendmentVersion: unknown } } } };
    witness.intent.command.amendment.amendmentVersion = 1;
    intentSource = canonicalJson(witness);
  }
  const position = options.sourcePosition ?? 10n;
  const payload = options.malformedSourceEvent ? { workflowId: HYDRATION_WORKFLOW }
    : eventType === "SessionEndRequested"
    ? { workflowId: HYDRATION_WORKFLOW, workflowGeneration: generation, previousState: "active", effectiveState: state }
    : { workflowId: HYDRATION_WORKFLOW, previousWorkflowGeneration: 1, workflowGeneration: 2, preTransitionCheckpointId: "77777777-7777-4777-8777-777777777777", evidenceWindowAction, effectiveState: state };
  connection.exec(`CREATE TABLE events (global_position INTEGER PRIMARY KEY, project_id TEXT, event_type TEXT, event_schema_version INTEGER, payload_json TEXT, event_hash TEXT, session_id TEXT, command_id TEXT, command_event_index INTEGER, lifecycle_intent_json TEXT) STRICT;
CREATE TABLE lifecycle_workflow_generation_folds (project_id TEXT, workflow_id TEXT, workflow_generation INTEGER, fingerprint_schema_version INTEGER, session_id TEXT, trigger_event_position INTEGER, evidence_window_state TEXT, effective_checkpoint_version INTEGER, effective_draft_source_event_position INTEGER, effective_state_source_event_position INTEGER, effective_state_version INTEGER, effective_state_hash TEXT) STRICT;
CREATE TABLE workflow_instances (project_id TEXT, workflow_id TEXT, generation INTEGER, session_id TEXT, triggering_event_position INTEGER, validation_attempt_plan_generation INTEGER, validation_attempt_plans_json TEXT) STRICT;`);
  connection.prepare(`INSERT INTO events VALUES ($p,$project,$type,3,$payload,$hash,$session,$command,0,$intent)`).run({ $p: position, $project: HYDRATION_PROJECT, $type: eventType, $payload: canonicalJson(payload), $hash: options.mutateHash ? "0".repeat(64) : "b".repeat(64), $session: EFFECTIVE_STATE_SESSION_ID, $command: HYDRATION_COMMAND, $intent: options.mutateIntent ? requestIntent(state) : intentSource });
  if (options.amend) {
    connection.prepare(`INSERT INTO events VALUES (9,$project,'SessionEndRequested',3,$payload,$hash,$session,$command,0,$intent)`).run({
      $project: HYDRATION_PROJECT,
      $payload: canonicalJson({ workflowId: HYDRATION_WORKFLOW, workflowGeneration: 1, previousState: "active", effectiveState: state }),
      $hash: "a".repeat(64), $session: EFFECTIVE_STATE_SESSION_ID, $command: HYDRATION_COMMAND,
      $intent: requestIntent(state),
    });
    connection.prepare(`INSERT INTO lifecycle_workflow_generation_folds VALUES ($project,$workflow,1,2,$session,9,$window,2,9,9,1,$hash)`).run({
      $project: HYDRATION_PROJECT, $workflow: HYDRATION_WORKFLOW, $session: EFFECTIVE_STATE_SESSION_ID,
      $window: options.previousEvidenceWindowState ?? "sealed", $hash: state.effectiveStateHash,
    });
  }
  connection.prepare(`INSERT INTO lifecycle_workflow_generation_folds VALUES ($project,$workflow,$generation,2,$session,$trigger,$window,2,$draft,$source,1,$hash)`).run({ $project: HYDRATION_PROJECT, $workflow: HYDRATION_WORKFLOW, $generation: options.cancelled ? 3n : BigInt(generation), $session: EFFECTIVE_STATE_SESSION_ID, $trigger: options.cancelled ? 11n : position, $window: options.evidenceWindowState ?? "sealed", $draft: position, $source: options.foldSourcePosition ?? position, $hash: options.mutateHash ? "0".repeat(64) : state.effectiveStateHash });
  if (options.cancelled) {
    connection.prepare(`INSERT INTO lifecycle_workflow_generation_folds VALUES ($project,$workflow,2,2,$session,$trigger,$window,2,$draft,$source,1,$hash)`).run({
      $project: HYDRATION_PROJECT, $workflow: HYDRATION_WORKFLOW, $session: EFFECTIVE_STATE_SESSION_ID,
      $trigger: position, $window: options.evidenceWindowState ?? "sealed", $draft: position,
      $source: options.foldSourcePosition ?? position, $hash: options.mutateHash ? "0".repeat(64) : state.effectiveStateHash,
    });
    connection.prepare(`INSERT INTO events VALUES (11,$project,'SessionEndCancelled',3,$payload,$hash,$session,$command,0,$intent)`).run({
      $project: HYDRATION_PROJECT, $payload: canonicalJson({ cancellationVersion: 1, workflowId: HYDRATION_WORKFLOW, previousWorkflowGeneration: 2, workflowGeneration: 3, restoredState: "active", preTransitionCheckpointId: "77777777-7777-4777-8777-777777777777" }), $hash: "c".repeat(64), $session: EFFECTIVE_STATE_SESSION_ID, $command: "88888888-8888-4888-8888-888888888888", $intent: "cancellation-not-a-snapshot-source",
    });
  }
  connection.prepare(`INSERT INTO workflow_instances VALUES ($project,$workflow,3,$session,11,NULL,NULL)`).run({ $project: HYDRATION_PROJECT, $workflow: HYDRATION_WORKFLOW, $session: EFFECTIVE_STATE_SESSION_ID });
  return connection;
}

function validPlans(): readonly Record<string, unknown>[] {
  return Object.freeze([Object.freeze({
    profileId: "alpha",
    profileVersion: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    resultId: "22222222-2222-4222-8222-222222222222",
    commandId: "33333333-3333-4333-8333-333333333333",
    idempotencyKey: "validation/alpha",
  })]);
}

function planAtCanonicalByteLength(length: number): readonly Record<string, unknown>[] {
  const seed = { ...validPlans()[0]!, profileId: "" };
  const fixed = Buffer.byteLength(JSON.stringify([seed]), "utf8");
  return Object.freeze([Object.freeze({ ...seed, profileId: "x".repeat(length - fixed) })]);
}

it("strictly decodes the six-key persisted validation plan and rejects ordering identity cap violations", async () => {
  const repository = await (new Function("url", "return import(url)") as (
    url: string,
  ) => Promise<Record<string, unknown>>)(moduleUrl);
  const decode = repository.decodePersistedValidationPlansV1;
  assert.equal(typeof decode, "function");
  assert.deepEqual(Reflect.apply(decode as Function, undefined, [validPlans()]), validPlans());
  for (const hostile of [
    [],
    [{ ...validPlans()[0]!, profileId: "z" }, { ...validPlans()[0]!, profileId: "a", profileVersion: 2, runId: "44444444-4444-4444-8444-444444444444", resultId: "55555555-5555-4555-8555-555555555555", commandId: "66666666-6666-4666-8666-666666666666", idempotencyKey: "validation/a" }],
    [{ ...validPlans()[0]!, profileConfigurationHash: "must-not-persist" }],
    [validPlans()[0]!, { ...validPlans()[0]!, commandId: "66666666-6666-4666-8666-666666666666", resultId: "55555555-5555-4555-8555-555555555555", runId: "44444444-4444-4444-8444-444444444444", idempotencyKey: "validation/alpha-duplicate" }],
    [validPlans()[0]!, { ...validPlans()[0]!, profileId: "beta", commandId: "66666666-6666-4666-8666-666666666666", resultId: "55555555-5555-4555-8555-555555555555", idempotencyKey: "validation/beta" }],
    planAtCanonicalByteLength(262_145),
    Array.from({ length: 65 }, (_, index) => ({ ...validPlans()[0]!, profileId: `profile-${index.toString().padStart(2, "0")}`, runId: `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`, resultId: `${index.toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`, commandId: `${index.toString(16).padStart(8, "0")}-3333-4333-8333-333333333333`, idempotencyKey: `validation/${index}` })),
  ]) {
    assert.throws(() => Reflect.apply(decode as Function, undefined, [hostile]), (error: unknown) => (
      typeof error === "object" && error !== null && "code" in error
        && (error as { code?: unknown }).code === "INTEGRITY_FAILURE"
    ));
  }
  assert.deepEqual(
    Reflect.apply(decode as Function, undefined, [planAtCanonicalByteLength(262_144)]),
    planAtCanonicalByteLength(262_144),
  );
});

it("stores six-key plans once through connection and bound facades", () => {
  const connection = planConnection();
  const input = {
    projectId: "11111111-1111-4111-8111-111111111111",
    workflowId: "22222222-2222-4222-8222-222222222222",
    workflowGeneration: 1,
    plans: validPlans(),
  };
  writePersistedValidationAttemptPlansV1(connection, input);
  assert.deepEqual(readPersistedValidationAttemptPlansV1(connection, input.projectId, input.workflowId), {
    workflowGeneration: 1,
    plans: validPlans(),
  });
  assert.throws(() => new BoundSessionEndRepository(connection)
    .writePersistedValidationAttemptPlansV1(input));
  connection.close();
});

it("hydrates exact request amendment and cancellation-carried effective-state sources", () => {
  for (const options of [{}, { amend: true }, { amend: true, cancelled: true }]) {
    const connection = hydrationConnection(options);
    const generation = options.cancelled ? 3 : options.amend ? 2 : 1;
    const hydrated = new BoundSessionEndRepository(connection).hydrateSessionEndEffectiveStateV1({
      projectId: HYDRATION_PROJECT, workflowId: HYDRATION_WORKFLOW, workflowGeneration: generation,
      sessionId: EFFECTIVE_STATE_SESSION_ID, eventPosition: 10n,
    });
    assert.equal(hydrated.eventPosition, 10n);
    assert.equal(hydrated.effectiveState.request.sessionId, EFFECTIVE_STATE_SESSION_ID);
    if (options.cancelled) {
      assert.throws(() => new BoundSessionEndRepository(connection).hydrateSessionEndEffectiveStateV1({
        projectId: HYDRATION_PROJECT, workflowId: HYDRATION_WORKFLOW, workflowGeneration: generation,
        sessionId: EFFECTIVE_STATE_SESSION_ID, eventPosition: 11n,
      }), /INTEGRITY_FAILURE/);
    }
    const facade = new BoundSessionEndRepository(connection);
    facade.writePersistedValidationAttemptPlansV1({
      projectId: HYDRATION_PROJECT, workflowId: HYDRATION_WORKFLOW,
      workflowGeneration: 3, plans: validPlans(),
    });
    assert.deepEqual(facade.readPersistedValidationAttemptPlansV1(
      HYDRATION_PROJECT, HYDRATION_WORKFLOW,
    )?.plans, validPlans());
    connection.close();
  }
});

it("correlates every non-null amendment field and evidence-window action to the immutable fold", () => {
  for (const options of [
    { evidenceWindowAction: "unchanged" as const, previousEvidenceWindowState: "sealed" as const, evidenceWindowState: "sealed" as const },
    { evidenceWindowAction: "open" as const, previousEvidenceWindowState: "sealed" as const, evidenceWindowState: "open" as const, amendmentMutation: { finalCheckpoint: sessionEndEffectiveStateFixture({ requestVersion: 2 }).request.finalCheckpoint } },
    { evidenceWindowAction: "seal" as const, previousEvidenceWindowState: "open" as const, evidenceWindowState: "sealed" as const },
  ]) {
    const control = hydrationConnection({ amend: true, ...options });
    assert.equal(hydrateSessionEndEffectiveStateV1(control, {
      projectId: HYDRATION_PROJECT, workflowId: HYDRATION_WORKFLOW, workflowGeneration: 2,
      sessionId: EFFECTIVE_STATE_SESSION_ID, eventPosition: 10n,
    }).eventPosition, 10n);
    control.close();
  }
  const state = sessionEndEffectiveStateFixture({ requestVersion: 2 });
  for (const amendmentMutation of [
    { childEndPolicy: "require-completed" },
    { finalCheckpoint: { ...state.request.finalCheckpoint, taskSummary: "different immutable draft" } },
    { validationProfileIds: [] },
    { requestedQualityThreshold: 8 },
    { requireFullEvidence: false },
    { requireMaterialization: true },
    { evidenceWindowAction: "seal" },
  ]) {
    const validField = "finalCheckpoint" in amendmentMutation
      ? { finalCheckpoint: state.request.finalCheckpoint }
      : "childEndPolicy" in amendmentMutation
        ? { childEndPolicy: state.request.childEndPolicy }
        : "validationProfileIds" in amendmentMutation
          ? { validationProfileIds: state.request.validationProfileIds }
          : "requestedQualityThreshold" in amendmentMutation
            ? { requestedQualityThreshold: state.request.requestedQualityThreshold }
            : "requireFullEvidence" in amendmentMutation
              ? { requireFullEvidence: state.request.requireFullEvidence }
              : "requireMaterialization" in amendmentMutation
                ? { requireMaterialization: state.request.requireMaterialization }
                : {};
    const valid = hydrationConnection({ amend: true, amendmentMutation: validField });
    assert.equal(hydrateSessionEndEffectiveStateV1(valid, {
      projectId: HYDRATION_PROJECT, workflowId: HYDRATION_WORKFLOW, workflowGeneration: 2,
      sessionId: EFFECTIVE_STATE_SESSION_ID, eventPosition: 10n,
    }).eventPosition, 10n);
    valid.close();
    const connection = hydrationConnection({
      amend: true, evidenceWindowAction: "open", previousEvidenceWindowState: "sealed",
      evidenceWindowState: "open", amendmentMutation: "evidenceWindowAction" in amendmentMutation
        ? amendmentMutation
        : { finalCheckpoint: state.request.finalCheckpoint, ...amendmentMutation },
    });
    assert.throws(() => hydrateSessionEndEffectiveStateV1(connection, {
      projectId: HYDRATION_PROJECT, workflowId: HYDRATION_WORKFLOW, workflowGeneration: 2,
      sessionId: EFFECTIVE_STATE_SESSION_ID, eventPosition: 10n,
    }), /INTEGRITY_FAILURE/, canonicalJson(amendmentMutation));
    connection.close();
  }
  const malformedVersion = hydrationConnection({ amend: true, malformedAmendmentVersion: true });
  assert.throws(() => hydrateSessionEndEffectiveStateV1(malformedVersion, {
    projectId: HYDRATION_PROJECT, workflowId: HYDRATION_WORKFLOW, workflowGeneration: 2,
    sessionId: EFFECTIVE_STATE_SESSION_ID, eventPosition: 10n,
  }), /INTEGRITY_FAILURE/, "amendmentVersion");
  malformedVersion.close();
});

it("rejects event-position hydration intent fold hash and immutable-event disagreements", () => {
  const controls = [
    { options: { amend: true, mutateIntent: true }, name: "intent" },
    { options: { amend: true, mutateHash: true }, name: "hash" },
    { options: { amend: true, foldSourcePosition: 9n }, name: "fold-source" },
  ] as const;
  for (const { options, name } of controls) {
    const connection = hydrationConnection(options);
    assert.throws(() => hydrateSessionEndEffectiveStateV1(connection, {
      projectId: HYDRATION_PROJECT, workflowId: HYDRATION_WORKFLOW, workflowGeneration: 2,
      sessionId: EFFECTIVE_STATE_SESSION_ID, eventPosition: 10n,
    }), /INTEGRITY_FAILURE/, name);
    connection.close();
  }
  const missing = hydrationConnection();
  assert.throws(() => hydrateSessionEndEffectiveStateV1(missing, {
    projectId: HYDRATION_PROJECT, workflowId: HYDRATION_WORKFLOW, workflowGeneration: 1,
    sessionId: EFFECTIVE_STATE_SESSION_ID, eventPosition: 9n,
  }), /INTEGRITY_FAILURE/);
  missing.close();
  const malformed = hydrationConnection({ malformedSourceEvent: true });
  assert.throws(() => hydrateSessionEndEffectiveStateV1(malformed, {
    projectId: HYDRATION_PROJECT, workflowId: HYDRATION_WORKFLOW, workflowGeneration: 1,
    sessionId: EFFECTIVE_STATE_SESSION_ID, eventPosition: 10n,
  }), /INTEGRITY_FAILURE/);
  malformed.close();
});
