import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import type {
  ProjectId,
  StoreId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import type {
  RootSessionState,
  SessionId,
} from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import {
  LifecycleV2DisabledAdapter,
  type CapturedV1LifecycleExchange,
  type LifecycleV1Port,
  type RedactedTrustedBindingSummary,
  type ShadowCandidateSummary,
} from "../src/orchestrator/compatibility/lifecycle-v2-disabled.adapter.js";
import { mapLifecycleShadowComparison } from "../src/orchestrator/compatibility/lifecycle-v2-shadow.mapper.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222" as ProjectId;
const STORE_ID = "33333333-3333-4333-8333-333333333333" as StoreId;
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444" as WorkspaceId;
const OTHER_WORKSPACE_ID = "55555555-5555-4555-8555-555555555555" as WorkspaceId;
const SESSION_ID = "66666666-6666-4666-8666-666666666666" as SessionId;
const OTHER_SESSION_ID = "77777777-7777-4777-8777-777777777777" as SessionId;
const CONTINUITY_HASH = "a".repeat(64);
const OTHER_CONTINUITY_HASH = "b".repeat(64);
const CANARY = "raw-v1-secret-command-payload-canary";

const OPERATIONS: readonly (keyof LifecycleV1Port)[] = [
  "sessionStart",
  "contextPack",
  "awaken",
  "selfCheck",
  "sessionEnd",
  "lifecycleStatus",
  "followUpRadar",
];

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function exchange(
  operation: keyof LifecycleV1Port,
  redactedInput: JsonValue,
  redactedOutcome: CapturedV1LifecycleExchange["redactedOutcome"],
): CapturedV1LifecycleExchange {
  return deepFreeze({ operation, redactedInput, redactedOutcome }) as CapturedV1LifecycleExchange;
}

function successExchange(
  operation: keyof LifecycleV1Port,
  value: JsonValue,
): CapturedV1LifecycleExchange {
  return exchange(operation, { safe: true }, { ok: true, value });
}

function binding(overrides: Partial<RedactedTrustedBindingSummary> = {}): RedactedTrustedBindingSummary {
  return deepFreeze({
    projectId: PROJECT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    continuityKeyHash: CONTINUITY_HASH,
    ...overrides,
  });
}

function candidate(overrides: Partial<ShadowCandidateSummary> = {}): ShadowCandidateSummary {
  return deepFreeze({
    projectId: PROJECT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    state: "active" as RootSessionState,
    continuityKeyHash: CONTINUITY_HASH,
    ownerGeneration: "2",
    eventPosition: "9",
    evidenceMode: "none" as const,
    ...overrides,
  });
}

function expectedHash(domain: string, value: JsonValue): string {
  return createHash("sha256")
    .update(`${domain}\n${canonicalJson(value)}`, "utf8")
    .digest("hex");
}

describe("LifecycleV2DisabledAdapter", () => {
  it("delegates every Version 1 operation with exact input and output identity", () => {
    const seen: unknown[] = [];
    const outputs = OPERATIONS.map((operation) => Object.freeze({
      operation,
      checkpointVersion: 2,
      [CANARY]: true,
    }));
    const port = Object.fromEntries(OPERATIONS.map((operation, index) => [
      operation,
      (input: unknown) => {
        seen.push(input);
        return outputs[index];
      },
    ])) as unknown as LifecycleV1Port;
    const adapter = new LifecycleV2DisabledAdapter(port);
    const input = Object.freeze({ v2Marker: { checkpointVersion: 2, requestVersion: 2 }, [CANARY]: true });

    for (const [index, operation] of OPERATIONS.entries()) {
      const returned = adapter.invoke(operation, input as never);
      assert.strictEqual(returned, outputs[index]);
      assert.strictEqual(seen[index], input);
    }
    assert.deepEqual(Object.keys(adapter), ["v1"]);
  });

  it("preserves the exact Version 1 thrown error identity without opening V2 dependencies", () => {
    const error = new Error("v1 failure");
    let calls = 0;
    const port = Object.fromEntries(OPERATIONS.map((operation) => [
      operation,
      () => {
        calls += 1;
        throw error;
      },
    ])) as unknown as LifecycleV1Port;
    const adapter = new LifecycleV2DisabledAdapter(port);
    const input = Object.freeze({ checkpointVersion: 2 });

    assert.throws(
      () => adapter.invoke("sessionEnd", input as never),
      (observed) => observed === error,
    );
    assert.equal(calls, 1);
  });
});

describe("mapLifecycleShadowComparison", () => {
  it("associates only one exact project/store/workspace candidate and returns redacted frozen output", () => {
    const captured = successExchange("sessionStart", {
      sessionId: SESSION_ID,
      state: "active",
      eventPosition: "9",
      continuityKeyHash: CONTINUITY_HASH,
      superseded: false,
      invariantParity: "match",
      requireFullEvidence: false,
    });
    const extraCandidate = { ...candidate(), rawCommandId: CANARY } as ShadowCandidateSummary & { rawCommandId: string };
    const result = mapLifecycleShadowComparison(captured, binding(), [extraCandidate]);

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.executable, false);
    assert.equal(result.association, "unique");
    assert.deepEqual(result.candidate, candidate());
    assert.deepEqual(result.divergence, []);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.divergence), true);
    assert.equal(Object.isFrozen(result.candidate), true);
    assert.equal(JSON.stringify(result).includes(CANARY), false);
  });

  it("reports none and ambiguous associations without using a matching continuity key from another scope", () => {
    const captured = successExchange("lifecycleStatus", {
      sessionId: SESSION_ID,
      state: "active",
      eventPosition: "9",
      continuityKeyHash: CONTINUITY_HASH,
    });
    const noMatch = mapLifecycleShadowComparison(captured, binding(), [
      candidate({ projectId: OTHER_PROJECT_ID }),
      candidate({ workspaceId: OTHER_WORKSPACE_ID }),
    ]);
    assert.equal(noMatch.association, "none");
    assert.equal(noMatch.candidate, undefined);
    assert.deepEqual(noMatch.divergence.map((item) => item.code), ["V2_SELECTION_DIFFERS"]);

    const ambiguous = mapLifecycleShadowComparison(captured, binding(), [
      candidate(),
      candidate({ sessionId: OTHER_SESSION_ID, continuityKeyHash: OTHER_CONTINUITY_HASH }),
    ]);
    assert.equal(ambiguous.association, "ambiguous");
    assert.equal(ambiguous.candidate, undefined);
    assert.deepEqual(ambiguous.divergence.map((item) => item.code), ["V2_SELECTION_DIFFERS"]);
  });

  it("emits explicit supersession, authority, invariant, identity-position, and evidence-retention divergences", () => {
    const captured = successExchange("sessionEnd", {
      sessionId: OTHER_SESSION_ID,
      state: "ended",
      eventPosition: "10",
      superseded: true,
      invariantParity: "differs",
      requireFullEvidence: true,
    });
    const result = mapLifecycleShadowComparison(
      captured,
      binding({ continuityKeyHash: null }),
      [candidate({ state: "active", eventPosition: "9", evidenceMode: "coverage-only" })],
    );
    assert.equal(result.association, "unique");
    assert.deepEqual(result.divergence.map((item) => item.code), [
      "V1_SUPERSESSION_DIFFERS",
      "V2_AUTHORITY_DIFFERS",
      "INVARIANT_PARITY_DIFFERS",
      "IDENTITY_POSITION_DIFFERS",
      "EVIDENCE_RETENTION_UNSUPPORTED",
    ]);
    for (const divergence of result.divergence) {
      assert.equal(JSON.stringify(divergence).includes(CANARY), false);
    }
  });

  it("hashes the strict redacted intent and outcome deterministically without mutating captures", () => {
    const captured = successExchange("contextPack", {
      taskArea: "redacted-task-area",
      nested: { safe: true },
    });
    const inputBefore = structuredClone(captured.redactedInput);
    const outcomeBefore = structuredClone(captured.redactedOutcome);
    const result = mapLifecycleShadowComparison(captured, binding(), [candidate()]);

    assert.equal(result.v1IntentHash, expectedHash(
      "project-memory/shadow-v1-intent/v1",
      { operation: captured.operation, redactedInput: captured.redactedInput },
    ));
    assert.equal(result.v1OutcomeHash, expectedHash(
      "project-memory/shadow-v1-outcome/v1",
      { operation: captured.operation, redactedOutcome: captured.redactedOutcome },
    ));
    assert.deepEqual(captured.redactedInput, inputBefore);
    assert.deepEqual(captured.redactedOutcome, outcomeBefore);
    assert.equal(JSON.stringify(result).includes("taskArea"), false);
  });

  it("keeps payload-like fields out of bounded frozen summaries", () => {
    const captured = successExchange("contextPack", {
      taskArea: CANARY,
      capability: CANARY,
      commandId: CANARY,
      idempotencyKey: CANARY,
      callback: CANARY,
      executor: CANARY,
    });
    const result = mapLifecycleShadowComparison(
      captured,
      binding(),
      [candidate({
        ownerGeneration: "g".repeat(1_000),
        eventPosition: "9".repeat(1_000),
        rawCommandId: CANARY,
      } as ShadowCandidateSummary & { rawCommandId: string })],
    );

    assert.equal(result.executable, false);
    assert.equal(JSON.stringify(result).includes(CANARY), false);
    assert.equal(result.candidate?.ownerGeneration.length, 64);
    assert.equal(result.candidate?.eventPosition.length, 64);
    assert.equal(Object.isFrozen(result.candidate), true);
  });
});
