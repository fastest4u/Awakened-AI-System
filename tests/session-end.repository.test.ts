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
  referenceSessionEndEffectiveStateHashV1,
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
  const requestSessionId = state.request.sessionId;
  return buildLifecycleIntentWitness({
    commandType: "request-session-end", commandId: HYDRATION_COMMAND,
    idempotencyKey: "hydration/request", agentId: "agent-primary",
    expectedProjectId: HYDRATION_PROJECT, expectedVaultId: "55555555-5555-4555-8555-555555555555",
    expectedWorkspaceId: "a".repeat(64), expectedBranchRef: null, request: state.request,
  } as never, {
    authorizationKind: "protected", authorizationSessionId: requestSessionId,
    targetSessionId: requestSessionId, projectId: HYDRATION_PROJECT,
    vaultId: "55555555-5555-4555-8555-555555555555", storeId: "66666666-6666-4666-8666-666666666666",
    workspaceId: "a".repeat(64), clientNamespace: "tests", capabilityKind: "root-session-handle",
    capabilityGeneration: "1", presentingActorRole: "primary", presentingClientInstanceId: "client-primary",
    targetActorRole: "primary", targetClientInstanceId: "client-primary", internalWorkflowId: null,
    internalWorkflowGeneration: null, internalPlannedWorkId: null,
  } as never).source;
}

type EvidenceWindowAction = "unchanged" | "open" | "seal";
type EffectiveStateFixture = ReturnType<typeof sessionEndEffectiveStateFixture>;

function effectiveStateWithRequest(
  state: EffectiveStateFixture,
  requestMutation: Readonly<Record<string, unknown>>,
  policyMutation: Readonly<Record<string, unknown>> = {},
): EffectiveStateFixture {
  const request = { ...state.request, ...requestMutation } as EffectiveStateFixture["request"];
  const effectiveFinalCheckpoint = "finalCheckpoint" in requestMutation
    ? request.finalCheckpoint
    : state.effectiveFinalCheckpoint;
  const withoutHash = {
    effectiveStateVersion: state.effectiveStateVersion,
    effectiveStateDomain: state.effectiveStateDomain,
    request,
    effectivePolicy: { ...state.effectivePolicy, ...policyMutation },
    effectiveFinalCheckpoint,
  } as Omit<EffectiveStateFixture, "effectiveStateHash">;
  return {
    ...withoutHash,
    effectiveStateHash: referenceSessionEndEffectiveStateHashV1(withoutHash),
  };
}

function hydrationConnection(options: {
  readonly amend?: boolean;
  readonly cancelled?: boolean;
  readonly mutateIntent?: boolean;
  readonly malformedSourceEvent?: boolean;
  readonly sourcePosition?: bigint;
  readonly foldSourcePosition?: bigint;
  readonly evidenceWindowAction?: EvidenceWindowAction;
  readonly previousEvidenceWindowState?: "open" | "sealed";
  readonly evidenceWindowState?: "open" | "sealed";
  readonly amendmentVersion?: 1 | 2;
  readonly amendmentMutation?: Readonly<Record<string, unknown>>;
  readonly malformedAmendmentVersion?: boolean;
  readonly effectiveState?: EffectiveStateFixture;
  readonly predecessorEffectiveState?: EffectiveStateFixture;
} = {}): NativeConnection {
  const connection = new NativeConnection();
  const state = options.effectiveState ?? sessionEndEffectiveStateFixture({ requestVersion: 2 });
  const predecessorState = options.predecessorEffectiveState
    ?? sessionEndEffectiveStateFixture({ requestVersion: 2 });
  const eventType = options.amend ? "SessionEndAmended" : "SessionEndRequested";
  const generation = options.amend ? 2 : 1;
  const evidenceWindowAction = options.evidenceWindowAction ?? "unchanged";
  const amendmentFields = {
    childEndPolicy: null,
    finalCheckpoint: null,
    validationProfileIds: null,
    requestedQualityThreshold: null,
    requireFullEvidence: null,
    requireMaterialization: null,
  };
  const amendment = options.amendmentVersion === 1
    ? { amendmentVersion: 1 as const, ...amendmentFields }
    : { amendmentVersion: 2 as const, ...amendmentFields, evidenceWindowAction };
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
  const predecessorCheckpointVersion = predecessorState.request.requestVersion;
  const replacementCheckpoint = options.amendmentMutation?.["finalCheckpoint"];
  const replacementCheckpointVersion = typeof replacementCheckpoint === "object"
    && replacementCheckpoint !== null
    && "checkpointVersion" in replacementCheckpoint
    && (replacementCheckpoint.checkpointVersion === 1
      || replacementCheckpoint.checkpointVersion === 2)
    ? replacementCheckpoint.checkpointVersion
    : null;
  const sourceCheckpointVersion = options.amend
    ? replacementCheckpointVersion ?? predecessorCheckpointVersion
    : state.request.requestVersion;
  const predecessorWindow = options.previousEvidenceWindowState
    ?? (predecessorCheckpointVersion === 2 ? "open" : "sealed");
  const sourceWindow = options.evidenceWindowState ?? (
    options.amend
      ? evidenceWindowAction === "open"
        ? "open"
        : evidenceWindowAction === "seal"
          ? "sealed"
          : predecessorWindow
      : sourceCheckpointVersion === 2 ? "open" : "sealed"
  );
  const sourceDraftPosition = options.amend && replacementCheckpointVersion === null
    ? 9n
    : position;
  const payload = options.malformedSourceEvent ? { workflowId: HYDRATION_WORKFLOW }
    : eventType === "SessionEndRequested"
    ? { workflowId: HYDRATION_WORKFLOW, workflowGeneration: generation, previousState: "active", effectiveState: state }
    : { workflowId: HYDRATION_WORKFLOW, previousWorkflowGeneration: 1, workflowGeneration: 2, preTransitionCheckpointId: "77777777-7777-4777-8777-777777777777", evidenceWindowAction, effectiveState: state };
  connection.exec(`CREATE TABLE events (global_position INTEGER PRIMARY KEY, project_id TEXT, event_type TEXT, event_schema_version INTEGER, payload_json TEXT, event_hash TEXT, session_id TEXT, command_id TEXT, command_event_index INTEGER, lifecycle_intent_json TEXT) STRICT;
CREATE TABLE lifecycle_workflow_generation_folds (project_id TEXT, workflow_id TEXT, workflow_generation INTEGER, fingerprint_schema_version INTEGER, session_id TEXT, trigger_event_position INTEGER, evidence_window_state TEXT, effective_checkpoint_version INTEGER, effective_draft_source_event_position INTEGER, effective_state_source_event_position INTEGER, effective_state_version INTEGER, effective_state_hash TEXT) STRICT;
CREATE TABLE workflow_instances (project_id TEXT, workflow_id TEXT, generation INTEGER, session_id TEXT, triggering_event_position INTEGER, validation_attempt_plan_generation INTEGER, validation_attempt_plans_json TEXT) STRICT;`);
  connection.prepare(`INSERT INTO events VALUES ($p,$project,$type,3,$payload,$hash,$session,$command,0,$intent)`).run({ $p: position, $project: HYDRATION_PROJECT, $type: eventType, $payload: canonicalJson(payload), $hash: "b".repeat(64), $session: EFFECTIVE_STATE_SESSION_ID, $command: HYDRATION_COMMAND, $intent: options.mutateIntent ? requestIntent(state) : intentSource });
  if (options.amend) {
    connection.prepare(`INSERT INTO events VALUES (9,$project,'SessionEndRequested',3,$payload,$hash,$session,$command,0,$intent)`).run({
      $project: HYDRATION_PROJECT,
      $payload: canonicalJson({ workflowId: HYDRATION_WORKFLOW, workflowGeneration: 1, previousState: "active", effectiveState: predecessorState }),
      $hash: "a".repeat(64), $session: EFFECTIVE_STATE_SESSION_ID, $command: HYDRATION_COMMAND,
      $intent: requestIntent(predecessorState),
    });
    connection.prepare(`INSERT INTO lifecycle_workflow_generation_folds VALUES ($project,$workflow,1,2,$session,9,$window,$checkpoint,9,9,1,$hash)`).run({
      $project: HYDRATION_PROJECT, $workflow: HYDRATION_WORKFLOW, $session: EFFECTIVE_STATE_SESSION_ID,
      $window: predecessorWindow, $checkpoint: predecessorCheckpointVersion,
      $hash: predecessorState.effectiveStateHash,
    });
  }
  connection.prepare(`INSERT INTO lifecycle_workflow_generation_folds VALUES ($project,$workflow,$generation,2,$session,$trigger,$window,$checkpoint,$draft,$source,1,$hash)`).run({ $project: HYDRATION_PROJECT, $workflow: HYDRATION_WORKFLOW, $generation: options.cancelled ? 3n : BigInt(generation), $session: EFFECTIVE_STATE_SESSION_ID, $trigger: options.cancelled ? 11n : position, $window: options.cancelled ? "sealed" : sourceWindow, $checkpoint: sourceCheckpointVersion, $draft: sourceDraftPosition, $source: options.foldSourcePosition ?? position, $hash: state.effectiveStateHash });
  if (options.cancelled) {
    connection.prepare(`INSERT INTO lifecycle_workflow_generation_folds VALUES ($project,$workflow,2,2,$session,$trigger,$window,$checkpoint,$draft,$source,1,$hash)`).run({
      $project: HYDRATION_PROJECT, $workflow: HYDRATION_WORKFLOW, $session: EFFECTIVE_STATE_SESSION_ID,
      $trigger: position, $window: sourceWindow, $checkpoint: sourceCheckpointVersion,
      $draft: sourceDraftPosition,
      $source: options.foldSourcePosition ?? position, $hash: state.effectiveStateHash,
    });
    connection.prepare(`INSERT INTO events VALUES (11,$project,'SessionEndCancelled',3,$payload,$hash,$session,$command,0,$intent)`).run({
      $project: HYDRATION_PROJECT, $payload: canonicalJson({ cancellationVersion: 1, workflowId: HYDRATION_WORKFLOW, previousWorkflowGeneration: 2, workflowGeneration: 3, restoredState: "active", preTransitionCheckpointId: "77777777-7777-4777-8777-777777777777" }), $hash: "c".repeat(64), $session: EFFECTIVE_STATE_SESSION_ID, $command: "88888888-8888-4888-8888-888888888888", $intent: "cancellation-not-a-snapshot-source",
    });
  }
  connection.prepare(`INSERT INTO workflow_instances VALUES ($project,$workflow,3,$session,11,NULL,NULL)`).run({ $project: HYDRATION_PROJECT, $workflow: HYDRATION_WORKFLOW, $session: EFFECTIVE_STATE_SESSION_ID });
  return connection;
}

type HydrationOptions = NonNullable<Parameters<typeof hydrationConnection>[0]>;

function hydrationInput(workflowGeneration: number, eventPosition: bigint) {
  return {
    projectId: HYDRATION_PROJECT,
    workflowId: HYDRATION_WORKFLOW,
    workflowGeneration,
    sessionId: EFFECTIVE_STATE_SESSION_ID,
    eventPosition,
  };
}

function assertValidControlThenRejects(
  options: HydrationOptions,
  workflowGeneration: number,
  eventPosition: bigint,
  mutate: (connection: NativeConnection) => void,
  label: string,
): void {
  const control = hydrationConnection(options);
  assert.equal(
    hydrateSessionEndEffectiveStateV1(
      control,
      hydrationInput(workflowGeneration, eventPosition),
    ).eventPosition,
    eventPosition,
    `${label}: valid control`,
  );
  control.close();

  const hostile = hydrationConnection(options);
  mutate(hostile);
  assert.throws(
    () => hydrateSessionEndEffectiveStateV1(
      hostile,
      hydrationInput(workflowGeneration, eventPosition),
    ),
    /INTEGRITY_FAILURE/,
    label,
  );
  hostile.close();
}

function updateEventPayload(
  connection: NativeConnection,
  eventPosition: bigint,
  update: (payload: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
): void {
  const row = connection.prepare(`
    SELECT payload_json FROM events WHERE global_position = $eventPosition
  `).get({ $eventPosition: eventPosition });
  assert.ok(row !== undefined);
  const source = row["payload_json"];
  if (typeof source !== "string") assert.fail("payload_json fixture must be text");
  const payload = JSON.parse(source) as Readonly<Record<string, unknown>>;
  connection.prepare(`
    UPDATE events SET payload_json = $payloadJson WHERE global_position = $eventPosition
  `).run({ $eventPosition: eventPosition, $payloadJson: canonicalJson(update(payload)) });
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

it("rejects descriptor-hostile validation plan containers without invoking accessors", async () => {
  const repository = await (new Function("url", "return import(url)") as (
    url: string,
  ) => Promise<Record<string, unknown>>)(moduleUrl);
  const decode = repository.decodePersistedValidationPlansV1;
  assert.equal(typeof decode, "function");
  const valid = { ...validPlans()[0]! };

  const customPrototype = Object.assign(
    Object.create({ inheritedMarker: true }) as Record<string, unknown>,
    valid,
  );
  const inheritedKey = Object.assign(
    Object.create({ profileId: valid.profileId }) as Record<string, unknown>,
    Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== "profileId"),
    ),
  );
  let planAccessorCalls = 0;
  const accessorPlan = { ...valid };
  Object.defineProperty(accessorPlan, "profileId", {
    configurable: true,
    enumerable: true,
    get() {
      planAccessorCalls += 1;
      return valid.profileId;
    },
  });
  const symbolPlan = { ...valid };
  Object.defineProperty(symbolPlan, Symbol("hostile"), {
    enumerable: true,
    value: "unexpected",
  });
  const nonEnumerablePlan = { ...valid };
  Object.defineProperty(nonEnumerablePlan, "hidden", {
    enumerable: false,
    value: "unexpected",
  });
  class HostilePlanArray extends Array<unknown> {
    static get [Symbol.species](): ArrayConstructor { return Array; }
  }
  const subclass = new HostilePlanArray(customPrototype);
  const overriddenIteration = [{ ...valid }];
  Object.defineProperty(overriddenIteration, Symbol.iterator, {
    enumerable: false,
    value: function* hostileIterator(): IterableIterator<never> {
      throw new Error("must not iterate");
    },
  });
  let arrayAccessorCalls = 0;
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    configurable: true,
    enumerable: true,
    get() {
      arrayAccessorCalls += 1;
      return { ...valid };
    },
  });
  Object.defineProperty(accessorArray, "length", { value: 1 });

  for (const hostile of [
    [customPrototype],
    [inheritedKey],
    [accessorPlan],
    [symbolPlan],
    [nonEnumerablePlan],
    subclass,
    overriddenIteration,
    accessorArray,
  ]) {
    assert.throws(() => Reflect.apply(decode as Function, undefined, [hostile]),
      (error: unknown) => (
        typeof error === "object" && error !== null && "code" in error
          && (error as { code?: unknown }).code === "INTEGRITY_FAILURE"
      ));
  }
  assert.equal(planAccessorCalls, 0);
  assert.equal(arrayAccessorCalls, 0);
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
    { evidenceWindowAction: "unchanged" as const, previousEvidenceWindowState: "open" as const, evidenceWindowState: "open" as const },
    { evidenceWindowAction: "open" as const, previousEvidenceWindowState: "sealed" as const, evidenceWindowState: "open" as const, predecessorEffectiveState: sessionEndEffectiveStateFixture({ requestVersion: 1 }), amendmentMutation: { finalCheckpoint: sessionEndEffectiveStateFixture({ requestVersion: 2 }).request.finalCheckpoint } },
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
      evidenceWindowState: "open",
      predecessorEffectiveState: sessionEndEffectiveStateFixture({ requestVersion: 1 }),
      amendmentMutation: "evidenceWindowAction" in amendmentMutation
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

it("accepts a Version-1 null-draft amendment as implicit unchanged over a Version-2 snapshot", () => {
  const connection = hydrationConnection({
    amend: true,
    amendmentVersion: 1,
    amendmentMutation: { requireMaterialization: false },
  });
  const hydrated = hydrateSessionEndEffectiveStateV1(
    connection,
    hydrationInput(2, 10n),
  );
  assert.equal(hydrated.eventPosition, 10n);
  assert.equal(hydrated.effectiveState.request.requestVersion, 2);
  connection.close();
});

it("preserves every null amendment field and binds predecessor/current evidence folds", () => {
  const predecessor = sessionEndEffectiveStateFixture({ requestVersion: 2 });
  const changedCheckpoint = {
    ...predecessor.request.finalCheckpoint,
    taskSummary: "independently amended checkpoint",
  };
  const cases = [
    {
      label: "childEndPolicy",
      state: effectiveStateWithRequest(predecessor, { childEndPolicy: "require-completed" }),
      amendment: { childEndPolicy: "require-completed" },
    },
    {
      label: "finalCheckpoint",
      state: effectiveStateWithRequest(predecessor, { finalCheckpoint: changedCheckpoint }),
      amendment: { finalCheckpoint: changedCheckpoint },
    },
    {
      label: "validationProfileIds",
      state: effectiveStateWithRequest(predecessor, {
        validationProfileIds: [predecessor.request.validationProfileIds[0]],
      }),
      amendment: { validationProfileIds: [predecessor.request.validationProfileIds[0]] },
    },
    {
      label: "requestedQualityThreshold",
      state: effectiveStateWithRequest(predecessor, { requestedQualityThreshold: 6 }),
      amendment: { requestedQualityThreshold: 6 },
    },
    {
      label: "requireFullEvidence",
      state: effectiveStateWithRequest(predecessor, { requireFullEvidence: false }),
      amendment: { requireFullEvidence: false },
    },
    {
      label: "requireMaterialization",
      state: effectiveStateWithRequest(
        predecessor,
        { requireMaterialization: true },
        { requireMaterialization: true },
      ),
      amendment: { requireMaterialization: true },
    },
  ] as const;
  for (const { label, state, amendment } of cases) {
    const valid = hydrationConnection({
      amend: true,
      effectiveState: state,
      predecessorEffectiveState: predecessor,
      amendmentMutation: amendment,
    });
    assert.equal(hydrateSessionEndEffectiveStateV1(
      valid,
      hydrationInput(2, 10n),
    ).eventPosition, 10n, `${label}: non-null control`);
    valid.close();

    const hostile = hydrationConnection({
      amend: true,
      effectiveState: state,
      predecessorEffectiveState: predecessor,
    });
    assert.throws(
      () => hydrateSessionEndEffectiveStateV1(hostile, hydrationInput(2, 10n)),
      /INTEGRITY_FAILURE/,
      `${label}: null must preserve predecessor`,
    );
    hostile.close();
  }

  for (const mismatch of [
    {
      label: "predecessor fold",
      valid: { previousEvidenceWindowState: "sealed" as const, evidenceWindowState: "open" as const },
      hostile: { previousEvidenceWindowState: "open" as const, evidenceWindowState: "open" as const },
    },
    {
      label: "current fold",
      valid: { previousEvidenceWindowState: "sealed" as const, evidenceWindowState: "open" as const },
      hostile: { previousEvidenceWindowState: "sealed" as const, evidenceWindowState: "sealed" as const },
    },
  ]) {
    const amendmentMutation = { finalCheckpoint: predecessor.request.finalCheckpoint };
    const control = hydrationConnection({
      amend: true,
      evidenceWindowAction: "open",
      predecessorEffectiveState: sessionEndEffectiveStateFixture({ requestVersion: 1 }),
      amendmentMutation,
      ...mismatch.valid,
    });
    assert.equal(hydrateSessionEndEffectiveStateV1(
      control,
      hydrationInput(2, 10n),
    ).eventPosition, 10n, `${mismatch.label}: valid control`);
    control.close();

    const hostile = hydrationConnection({
      amend: true,
      evidenceWindowAction: "open",
      predecessorEffectiveState: sessionEndEffectiveStateFixture({ requestVersion: 1 }),
      amendmentMutation,
      ...mismatch.hostile,
    });
    assert.throws(
      () => hydrateSessionEndEffectiveStateV1(hostile, hydrationInput(2, 10n)),
      /INTEGRITY_FAILURE/,
      mismatch.label,
    );
    hostile.close();
  }
});

it("rejects malformed predecessor snapshot provenance independently", () => {
  const otherSession = "99999999-9999-4999-8999-999999999999";
  const cases: readonly {
    readonly label: string;
    readonly mutate: (connection: NativeConnection) => void;
  }[] = [
    {
      label: "predecessor event type",
      mutate: (connection) => connection.prepare(`
        UPDATE events SET event_type = 'SessionEndCancelled' WHERE global_position = 9
      `).run(),
    },
    {
      label: "predecessor workflow generation identity",
      mutate: (connection) => updateEventPayload(connection, 9n, (payload) => ({
        ...payload,
        workflowGeneration: 2,
      })),
    },
    {
      label: "predecessor workflow identity",
      mutate: (connection) => updateEventPayload(connection, 9n, (payload) => ({
        ...payload,
        workflowId: "88888888-8888-4888-8888-888888888888",
      })),
    },
    {
      label: "predecessor event schema",
      mutate: (connection) => connection.prepare(`
        UPDATE events SET event_schema_version = 2 WHERE global_position = 9
      `).run(),
    },
    {
      label: "predecessor event session",
      mutate: (connection) => connection.prepare(`
        UPDATE events SET session_id = $sessionId WHERE global_position = 9
      `).run({ $sessionId: otherSession }),
    },
    {
      label: "predecessor command event identity",
      mutate: (connection) => connection.prepare(`
        UPDATE events SET command_event_index = 1 WHERE global_position = 9
      `).run(),
    },
    {
      label: "predecessor event effective-state version",
      mutate: (connection) => updateEventPayload(connection, 9n, (payload) => ({
        ...payload,
        effectiveState: {
          ...(payload.effectiveState as Readonly<Record<string, unknown>>),
          effectiveStateVersion: 2,
        },
      })),
    },
    {
      label: "predecessor event effective-state hash",
      mutate: (connection) => updateEventPayload(connection, 9n, (payload) => ({
        ...payload,
        effectiveState: {
          ...(payload.effectiveState as Readonly<Record<string, unknown>>),
          effectiveStateHash: "0".repeat(64),
        },
      })),
    },
    {
      label: "predecessor fold effective-state version disagreement",
      mutate: (connection) => connection.prepare(`
        UPDATE lifecycle_workflow_generation_folds
        SET effective_state_version = 2 WHERE workflow_generation = 1
      `).run(),
    },
    {
      label: "predecessor fold effective-state hash disagreement",
      mutate: (connection) => connection.prepare(`
        UPDATE lifecycle_workflow_generation_folds
        SET effective_state_hash = $hash WHERE workflow_generation = 1
      `).run({ $hash: "0".repeat(64) }),
    },
    {
      label: "predecessor immutable event hash",
      mutate: (connection) => connection.prepare(`
        UPDATE events SET event_hash = $hash WHERE global_position = 9
      `).run({ $hash: "not-a-lowercase-sha256" }),
    },
    {
      label: "predecessor trigger/source position identity",
      mutate: (connection) => connection.prepare(`
        UPDATE lifecycle_workflow_generation_folds
        SET trigger_event_position = 8 WHERE workflow_generation = 1
      `).run(),
    },
  ];
  for (const { label, mutate } of cases) {
    assertValidControlThenRejects({ amend: true }, 2, 10n, mutate, label);
  }
});

it("rejects absent and independently inconsistent immutable sources", () => {
  const otherSession = "99999999-9999-4999-8999-999999999999";
  const alternateState = effectiveStateWithRequest(
    sessionEndEffectiveStateFixture({ requestVersion: 2 }),
    { requestedQualityThreshold: 6 },
  );
  const alternateSessionState = effectiveStateWithRequest(
    sessionEndEffectiveStateFixture({ requestVersion: 2 }),
    { sessionId: otherSession },
  );
  const cases: readonly {
    readonly label: string;
    readonly mutate: (connection: NativeConnection) => void;
  }[] = [
    {
      label: "source workflow generation identity",
      mutate: (connection) => updateEventPayload(connection, 10n, (payload) => ({
        ...payload,
        workflowGeneration: 2,
      })),
    },
    {
      label: "source event type",
      mutate: (connection) => connection.prepare(`
        UPDATE events SET event_type = 'SessionEndCancelled' WHERE global_position = 10
      `).run(),
    },
    {
      label: "source event schema",
      mutate: (connection) => connection.prepare(`
        UPDATE events SET event_schema_version = 2 WHERE global_position = 10
      `).run(),
    },
    {
      label: "source event session",
      mutate: (connection) => connection.prepare(`
        UPDATE events SET session_id = $sessionId WHERE global_position = 10
      `).run({ $sessionId: otherSession }),
    },
    {
      label: "source snapshot session",
      mutate: (connection) => {
        updateEventPayload(connection, 10n, (payload) => ({
          ...payload,
          effectiveState: alternateSessionState,
        }));
        connection.prepare(`
          UPDATE events SET lifecycle_intent_json = $intent WHERE global_position = 10
        `).run({ $intent: requestIntent(alternateSessionState) });
        connection.prepare(`
          UPDATE lifecycle_workflow_generation_folds SET effective_state_hash = $hash
        `).run({ $hash: alternateSessionState.effectiveStateHash });
      },
    },
    {
      label: "source event effective-state version",
      mutate: (connection) => updateEventPayload(connection, 10n, (payload) => ({
        ...payload,
        effectiveState: {
          ...(payload.effectiveState as Readonly<Record<string, unknown>>),
          effectiveStateVersion: 2,
        },
      })),
    },
    {
      label: "source event effective-state hash",
      mutate: (connection) => updateEventPayload(connection, 10n, (payload) => ({
        ...payload,
        effectiveState: {
          ...(payload.effectiveState as Readonly<Record<string, unknown>>),
          effectiveStateHash: "0".repeat(64),
        },
      })),
    },
    {
      label: "source fold effective-state version disagreement",
      mutate: (connection) => connection.prepare(`
        UPDATE lifecycle_workflow_generation_folds SET effective_state_version = 2
      `).run(),
    },
    {
      label: "source immutable event hash",
      mutate: (connection) => connection.prepare(`
        UPDATE events SET event_hash = $hash WHERE global_position = 10
      `).run({ $hash: "not-a-lowercase-sha256" }),
    },
    {
      label: "source payload/hash differs from fold hash",
      mutate: (connection) => {
        updateEventPayload(connection, 10n, (payload) => ({
          ...payload,
          effectiveState: alternateState,
        }));
        connection.prepare(`
          UPDATE events SET lifecycle_intent_json = $intent WHERE global_position = 10
        `).run({ $intent: requestIntent(alternateState) });
      },
    },
    {
      label: "fold hash differs from source payload/hash",
      mutate: (connection) => connection.prepare(`
        UPDATE lifecycle_workflow_generation_folds SET effective_state_hash = $hash
      `).run({ $hash: "0".repeat(64) }),
    },
    {
      label: "fold references absent immutable source event",
      mutate: (connection) => connection.prepare(`
        DELETE FROM events WHERE global_position = 10
      `).run(),
    },
  ];
  for (const { label, mutate } of cases) {
    assertValidControlThenRejects({}, 1, 10n, mutate, label);
  }
  assertValidControlThenRejects(
    { amend: true },
    2,
    10n,
    (connection) => updateEventPayload(connection, 10n, (payload) => ({
      ...payload,
      previousWorkflowGeneration: 2,
    })),
    "amendment source previous-generation identity",
  );
  assertValidControlThenRejects(
    { amend: true, cancelled: true },
    3,
    10n,
    (connection) => connection.prepare(`
      UPDATE lifecycle_workflow_generation_folds
      SET effective_state_hash = $hash WHERE workflow_generation = 3
    `).run({ $hash: "0".repeat(64) }),
    "cancellation-carried target fold hash",
  );
});

it("rejects event-position hydration intent fold hash and immutable-event disagreements", () => {
  const controls = [
    { options: { amend: true, mutateIntent: true }, name: "intent" },
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
