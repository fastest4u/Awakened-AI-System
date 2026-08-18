import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createTrustedValidationProfileRegistry,
  type TrustedValidationProfileEntry,
} from "../src/orchestrator/lifecycle/validation-profile.registry.js";
import {
  createValidationAttemptPlans,
  expandValidationAttemptPlan,
  type ExpandValidationAttemptPlanInput,
  type ValidationAttemptExpansionContext,
} from "../src/orchestrator/lifecycle/validation-profile.registry.js";
import {
  ValidationProfileRunner,
  type ValidationProcessInvocation,
} from "../src/orchestrator/lifecycle/validation-profile.runner.js";
import type { SourceStateFingerprintV1 } from "../src/orchestrator/lifecycle/contracts/checkpoint.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const WORKFLOW_ID = "55555555-5555-4555-8555-555555555555";
const CHECKPOINT_ID = "66666666-6666-4666-8666-666666666666";
const WORKSPACE_ID = "a".repeat(64);
const CHECKPOINT_FINGERPRINT = "b".repeat(64);
const SOURCE_STATE: SourceStateFingerprintV1 = Object.freeze({
  sourceStateScopeVersion: 1 as const,
  workspaceId: WORKSPACE_ID as SourceStateFingerprintV1["workspaceId"],
  branchRef: "refs/heads/main",
  headCommit: "c".repeat(40),
  dirtyWorktreeFingerprint: "d".repeat(64),
});

function profile(overrides: Partial<TrustedValidationProfileEntry> = {}): TrustedValidationProfileEntry {
  return {
    profileId: "lint",
    profileVersion: 1,
    executable: "C:\\trusted\\validator.exe",
    args: ["--strict", "--format", "json"],
    cwd: "C:\\trusted\\workspace",
    env: { VALIDATOR_MODE: "strict" },
    timeoutMs: 1_000,
    maxOutputBytes: 2_048,
    runnerId: "77777777-7777-4777-8777-777777777777",
    ...overrides,
  };
}

function context(): ValidationAttemptExpansionContext {
  return {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    workflowId: WORKFLOW_ID,
    workflowGeneration: 3,
    plannedWorkId: "e".repeat(64),
    finalCheckpointId: CHECKPOINT_ID,
    finalCheckpointFingerprint: CHECKPOINT_FINGERPRINT,
  };
}

function fakeKeyProvider() {
  return {
    currentKey: () => ({ keyId: "validation-key-1" }),
    fingerprint: ({ bytes }: { readonly bytes: Uint8Array }) =>
      Buffer.from(bytes).toString("hex").slice(0, 64).padEnd(64, "0"),
  };
}

describe("trusted validation profile registry", () => {
  it("resolves only frozen trusted entries and hashes their fixed configuration", () => {
    const registry = createTrustedValidationProfileRegistry([profile()]);
    const resolved = registry.resolve("lint", 1);

    assert.equal(Object.isFrozen(registry), true);
    assert.equal(Object.isFrozen(resolved), true);
    assert.equal(Object.isFrozen(resolved.args), true);
    assert.equal(Object.isFrozen(resolved.env), true);
    assert.match(resolved.configurationHash, /^[0-9a-f]{64}$/);
    assert.throws(() => registry.resolve("caller-selected", 1), /SESSION_VALIDATION_RESULT_INVALID/);
    assert.throws(() => (resolved.args as string[]).push("--caller"), TypeError);
    assert.throws(
      () => createTrustedValidationProfileRegistry([profile({ executable: "validator.exe" })]),
      /SESSION_VALIDATION_RESULT_INVALID/,
    );
    assert.throws(
      () => createTrustedValidationProfileRegistry([profile({ runnerId: "not-a-uuid" })]),
      /SESSION_VALIDATION_RESULT_INVALID/,
    );
    assert.throws(
      () => createTrustedValidationProfileRegistry([profile({ env: { BAD: 42 } as unknown as Record<string, string> })]),
      /SESSION_VALIDATION_RESULT_INVALID/,
    );
  });

  it("expands each persisted six-key plan deterministically and rejects configuration drift or ID tampering", () => {
    const registry = createTrustedValidationProfileRegistry([
      profile(),
      profile({ profileId: "tests", profileVersion: 2, args: ["--tests"] }),
    ]);
    const plans = createValidationAttemptPlans({
      ...context(),
      profiles: [
        { profileId: "tests", profileVersion: 2 },
        { profileId: "lint", profileVersion: 1 },
      ],
    }, registry);
    assert.deepEqual(plans.map((plan) => plan.profileId), ["lint", "tests"]);

    const expectedHash = registry.resolve("lint", 1).configurationHash;
    const first = expandValidationAttemptPlan({
      plan: plans[0]!,
      context: context(),
      expectedProfileConfigurationHash: expectedHash,
    }, registry);
    const second = expandValidationAttemptPlan({
      plan: plans[0]!,
      context: context(),
      expectedProfileConfigurationHash: expectedHash,
    }, registry);
    assert.deepEqual(first, second);
    assert.equal(first.profileId, "lint");
    assert.equal(first.profileVersion, 1);
    assert.equal(Object.isFrozen(first), true);
    assert.throws(
      () => expandValidationAttemptPlan({ plan: plans[0]!, context: context() } as unknown as ExpandValidationAttemptPlanInput, registry),
      /SESSION_VALIDATION_RESULT_INVALID/,
    );

    const alteredPlan = { ...plans[0]!, resultId: "77777777-7777-4777-8777-777777777777" };
    assert.throws(
      () => expandValidationAttemptPlan({ plan: alteredPlan, context: context() } as unknown as ExpandValidationAttemptPlanInput, registry),
      /SESSION_VALIDATION_RESULT_INVALID/,
    );

    const driftedRegistry = createTrustedValidationProfileRegistry([
      profile({ args: ["--unsafe-drift"] }),
      profile({ profileId: "tests", profileVersion: 2, args: ["--tests"] }),
    ]);
    assert.throws(
      () => expandValidationAttemptPlan({
        plan: plans[0]!,
        context: context(),
        expectedProfileConfigurationHash: expectedHash,
      }, driftedRegistry),
      /SESSION_VALIDATION_RESULT_INVALID/,
    );
    assert.throws(
      () => expandValidationAttemptPlan({
        plan: { ...plans[0]!, unexpected: true } as unknown as typeof plans[number],
        context: context(),
        expectedProfileConfigurationHash: expectedHash,
      }, registry),
      /SESSION_VALIDATION_RESULT_INVALID/,
    );
  });
});

describe("trusted validation profile runner", () => {
  it("executes only the resolved fixed invocation and returns a bounded immutable redacted result", async () => {
    const registry = createTrustedValidationProfileRegistry([profile()]);
    const plan = expandValidationAttemptPlan({
      plan: createValidationAttemptPlans({ ...context(), profiles: [{ profileId: "lint", profileVersion: 1 }] }, registry)[0]!,
      context: context(),
      expectedProfileConfigurationHash: registry.resolve("lint", 1).configurationHash,
    }, registry);
    const invocations: ValidationProcessInvocation[] = [];
    const stdout = Buffer.from("passed TOKEN=super-secret\n");
    const stderr = Buffer.from("C:\\private\\secret.txt\n");
    const runner = new ValidationProfileRunner({
      registry,
      keyProvider: fakeKeyProvider(),
      processRunner: {
        async run(invocation) {
          invocations.push(invocation);
          return {
            status: 0,
            stdout,
            stderr,
          };
        },
      },
    });

    const result = await runner.run({
      attemptPlan: plan,
      sourceStateAtStart: SOURCE_STATE,
      sourceStateAtCompletion: SOURCE_STATE,
      startedAt: "2026-08-16T00:00:00.000Z",
      completedAt: "2026-08-16T00:00:01.000Z",
    });

    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0], {
      executable: "C:\\trusted\\validator.exe",
      args: ["--strict", "--format", "json"],
      cwd: "C:\\trusted\\workspace",
      env: { VALIDATOR_MODE: "strict" },
      shell: false,
      timeoutMs: 1_000,
      maxOutputBytes: 2_048,
    });
    assert.equal(result.status, "pass");
    assert.equal(result.exitClassification, "passed");
    assert.equal(result.summary.includes("super-secret"), false);
    assert.equal(result.summary.includes("C:\\private"), false);
    assert.ok(result.summary.length <= 4_000);
    assert.match(result.outputFingerprint.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.outputFingerprint), true);
    assert.equal(Object.isFrozen(result.artifactReferences), true);
    assert.deepEqual([...stdout], new Array(stdout.length).fill(0));
    assert.deepEqual([...stderr], new Array(stderr.length).fill(0));
  });

  it("recomputes run and result identities before starting the trusted process", async () => {
    const registry = createTrustedValidationProfileRegistry([profile()]);
    const plan = expandValidationAttemptPlan({
      plan: createValidationAttemptPlans({ ...context(), profiles: [{ profileId: "lint", profileVersion: 1 }] }, registry)[0]!,
      context: context(),
      expectedProfileConfigurationHash: registry.resolve("lint", 1).configurationHash,
    }, registry);
    let processCalls = 0;
    const runner = new ValidationProfileRunner({
      registry,
      keyProvider: fakeKeyProvider(),
      processRunner: {
        async run(_invocation) {
          processCalls += 1;
          return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
      },
    });

    await assert.rejects(() => runner.run({
      attemptPlan: { ...plan, runId: "88888888-8888-4888-8888-888888888888" },
      sourceStateAtStart: SOURCE_STATE,
      sourceStateAtCompletion: SOURCE_STATE,
      startedAt: "2026-08-16T00:00:00.000Z",
      completedAt: "2026-08-16T00:00:01.000Z",
    }), /SESSION_VALIDATION_RESULT_INVALID/);
    assert.equal(processCalls, 0);
  });

  it("classifies timeout as unavailable without exposing process output", async () => {
    const registry = createTrustedValidationProfileRegistry([profile()]);
    const plan = expandValidationAttemptPlan({
      plan: createValidationAttemptPlans({ ...context(), profiles: [{ profileId: "lint", profileVersion: 1 }] }, registry)[0]!,
      context: context(),
      expectedProfileConfigurationHash: registry.resolve("lint", 1).configurationHash,
    }, registry);
    const runner = new ValidationProfileRunner({
      registry,
      keyProvider: fakeKeyProvider(),
      processRunner: {
        async run(_invocation) {
          return {
            status: null,
            timedOut: true,
            stdout: Buffer.from("TIMEOUT_SECRET=do-not-store"),
            stderr: Buffer.from("still running"),
          };
        },
      },
    });

    const result = await runner.run({
      attemptPlan: plan,
      sourceStateAtStart: SOURCE_STATE,
      sourceStateAtCompletion: SOURCE_STATE,
      startedAt: "2026-08-16T00:00:00.000Z",
      completedAt: "2026-08-16T00:00:02.000Z",
    });

    assert.equal(result.status, "unavailable");
    assert.equal(result.exitClassification, "unavailable");
    assert.equal(result.summary.includes("TIMEOUT_SECRET"), false);
    assert.equal(result.summary.includes("do-not-store"), false);
  });

  it("treats process output beyond the trusted profile bound as unavailable", async () => {
    const registry = createTrustedValidationProfileRegistry([profile()]);
    const plan = expandValidationAttemptPlan({
      plan: createValidationAttemptPlans({ ...context(), profiles: [{ profileId: "lint", profileVersion: 1 }] }, registry)[0]!,
      context: context(),
      expectedProfileConfigurationHash: registry.resolve("lint", 1).configurationHash,
    }, registry);
    const runner = new ValidationProfileRunner({
      registry,
      keyProvider: fakeKeyProvider(),
      processRunner: {
        async run(_invocation) {
          return {
            status: 0,
            stdout: Buffer.alloc(4_096, "x"),
            stderr: Buffer.alloc(0),
          };
        },
      },
    });

    const result = await runner.run({
      attemptPlan: plan,
      sourceStateAtStart: SOURCE_STATE,
      sourceStateAtCompletion: SOURCE_STATE,
      startedAt: "2026-08-16T00:00:00.000Z",
      completedAt: "2026-08-16T00:00:01.000Z",
    });

    assert.equal(result.status, "unavailable");
    assert.equal(result.exitClassification, "unavailable");
    assert.ok(result.summary.length <= 4_000);
  });

  it("contains malformed or oversized adapter output inside the cleanup boundary", async () => {
    const registry = createTrustedValidationProfileRegistry([profile()]);
    const plan = expandValidationAttemptPlan({
      plan: createValidationAttemptPlans({ ...context(), profiles: [{ profileId: "lint", profileVersion: 1 }] }, registry)[0]!,
      context: context(),
      expectedProfileConfigurationHash: registry.resolve("lint", 1).configurationHash,
    }, registry);
    const runner = new ValidationProfileRunner({
      registry,
      keyProvider: fakeKeyProvider(),
      processRunner: {
        async run(_invocation) {
          return {
            status: 0,
            stdout: "x".repeat(10_000_000),
            stderr: {} as unknown as Uint8Array,
          };
        },
      },
    });
    const result = await runner.run({
      attemptPlan: plan,
      sourceStateAtStart: SOURCE_STATE,
      sourceStateAtCompletion: SOURCE_STATE,
      startedAt: "2026-08-16T00:00:00.000Z",
      completedAt: "2026-08-16T00:00:01.000Z",
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.exitClassification, "unavailable");
  });

  it("zeroizes the temporary output buffer when fingerprinting fails", async () => {
    const registry = createTrustedValidationProfileRegistry([profile()]);
    const plan = expandValidationAttemptPlan({
      plan: createValidationAttemptPlans({ ...context(), profiles: [{ profileId: "lint", profileVersion: 1 }] }, registry)[0]!,
      context: context(),
      expectedProfileConfigurationHash: registry.resolve("lint", 1).configurationHash,
    }, registry);
    let observedBytes: Uint8Array | undefined;
    const runner = new ValidationProfileRunner({
      registry,
      keyProvider: {
        currentKey: () => ({ keyId: "validation-key-1" }),
        fingerprint: ({ bytes }: { readonly bytes: Uint8Array }) => {
          observedBytes = bytes;
          throw new Error("fingerprint failure");
        },
      },
      processRunner: {
        async run(_invocation) {
          return { status: 0, stdout: Buffer.from("temporary output"), stderr: Buffer.alloc(0) };
        },
      },
    });

    await assert.rejects(() => runner.run({
      attemptPlan: plan,
      sourceStateAtStart: SOURCE_STATE,
      sourceStateAtCompletion: SOURCE_STATE,
      startedAt: "2026-08-16T00:00:00.000Z",
      completedAt: "2026-08-16T00:00:01.000Z",
    }), /fingerprint failure/);
    assert.ok(observedBytes);
    assert.deepEqual([...observedBytes!], new Array(observedBytes!.length).fill(0));
  });

  it("redacts quoted JSON-like secrets before summary and fingerprinting", async () => {
    const registry = createTrustedValidationProfileRegistry([profile()]);
    const plan = expandValidationAttemptPlan({
      plan: createValidationAttemptPlans({ ...context(), profiles: [{ profileId: "lint", profileVersion: 1 }] }, registry)[0]!,
      context: context(),
      expectedProfileConfigurationHash: registry.resolve("lint", 1).configurationHash,
    }, registry);
    let fingerprintInput = "";
    const runner = new ValidationProfileRunner({
      registry,
      keyProvider: {
        currentKey: () => ({ keyId: "validation-key-1" }),
        fingerprint: ({ bytes }: { readonly bytes: Uint8Array }) => {
          fingerprintInput = Buffer.from(bytes).toString("utf8");
          return "a".repeat(64);
        },
      },
      processRunner: {
        async run(_invocation) {
          return {
            status: 0,
            stdout: Buffer.from('{"token":"quoted-token","password":"quoted-password","secret":"quoted-secret","key":"quoted-key","auth":"quoted-auth"}'),
            stderr: Buffer.alloc(0),
          };
        },
      },
    });

    const result = await runner.run({
      attemptPlan: plan,
      sourceStateAtStart: SOURCE_STATE,
      sourceStateAtCompletion: SOURCE_STATE,
      startedAt: "2026-08-16T00:00:00.000Z",
      completedAt: "2026-08-16T00:00:01.000Z",
    });
    for (const secret of ["quoted-token", "quoted-password", "quoted-secret", "quoted-key", "quoted-auth"]) {
      assert.equal(result.summary.includes(secret), false);
      assert.equal(fingerprintInput.includes(secret), false);
    }
  });

  it("redacts quoted values even when a tool chooses an unknown field name", async () => {
    const registry = createTrustedValidationProfileRegistry([profile()]);
    const plan = expandValidationAttemptPlan({
      plan: createValidationAttemptPlans({ ...context(), profiles: [{ profileId: "lint", profileVersion: 1 }] }, registry)[0]!,
      context: context(),
      expectedProfileConfigurationHash: registry.resolve("lint", 1).configurationHash,
    }, registry);
    let fingerprintInput = "";
    const runner = new ValidationProfileRunner({
      registry,
      keyProvider: {
        currentKey: () => ({ keyId: "validation-key-1" }),
        fingerprint: ({ bytes }: { readonly bytes: Uint8Array }) => {
          fingerprintInput = Buffer.from(bytes).toString("utf8");
          return "a".repeat(64);
        },
      },
      processRunner: {
        async run(_invocation) {
          return {
            status: 0,
            stdout: Buffer.from('{"diagnostic":"unknown-secret-value"}'),
            stderr: Buffer.alloc(0),
          };
        },
      },
    });
    const result = await runner.run({
      attemptPlan: plan,
      sourceStateAtStart: SOURCE_STATE,
      sourceStateAtCompletion: SOURCE_STATE,
      startedAt: "2026-08-16T00:00:00.000Z",
      completedAt: "2026-08-16T00:00:01.000Z",
    });
    assert.equal(result.summary.includes("unknown-secret-value"), false);
    assert.equal(fingerprintInput.includes("unknown-secret-value"), false);
  });
});
