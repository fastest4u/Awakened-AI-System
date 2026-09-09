import assert from "node:assert/strict";
import test from "node:test";
import {
  SHADOW_MIGRATION_PHASES,
  ShadowMigrationError,
  decodeShadowMigrationConfigurationV1,
  decodeShadowMigrationPolicyV1,
  deterministicMigrationUuid,
  shadowMigrationConfigurationChecksum,
  shadowMigrationIdentity,
  shadowMigrationPolicyChecksum,
} from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";

const POLICY = Object.freeze({
  schemaVersion: 1,
  maxEvents: 100_000,
  maxAggregateBytes: 67_108_864,
  maxEventBytes: 1_048_576,
  maxBatchEvents: 1_000,
  maxBatchBytes: 8_388_608,
  deadlineMs: 300_000,
  maxRetries: 3,
  initialBackoffMs: 500,
  maxBackoffMs: 2_000,
  expectedDifferencePolicyVersion: 1,
  maxExpectedDifferenceRuleAgeMs: 604_800_000,
});

const MINIMUM_POLICY = Object.freeze({
  schemaVersion: 1,
  maxEvents: 1,
  maxAggregateBytes: 1,
  maxEventBytes: 1,
  maxBatchEvents: 1,
  maxBatchBytes: 1,
  deadlineMs: 1,
  maxRetries: 0,
  initialBackoffMs: 10,
  maxBackoffMs: 10,
  expectedDifferencePolicyVersion: 1,
  maxExpectedDifferenceRuleAgeMs: 1,
});

const POLICY_CHECKSUM = "0c892f9f422b6ded69cc9bab33d07cf5dc8bef68bd45bd2c195e4aab1d1c1f15";
const CONFIGURATION = Object.freeze({
  schemaVersion: 1,
  policyChecksum: POLICY_CHECKSUM,
  packageFormatVersion: 1,
  migrationAlgorithmVersion: 1,
  expectedDifferencePolicyVersion: 1,
});
const CONFIGURATION_CHECKSUM = "788d4327313b1c431dbf119037152b5fd5dab17893824123bbcd9c087cab213b";
const IDENTITY_INPUT = Object.freeze({
  projectId: "11111111-1111-4111-8111-111111111111",
  storeId: "33333333-3333-4333-8333-333333333333",
  sourceManifestChecksum: "3".repeat(64),
  terminalEventHash: "4".repeat(64),
  packageChecksum: "5".repeat(64),
  migrationAlgorithmVersion: 1,
  buildIdentityHash: "6".repeat(64),
  configurationChecksum: "7".repeat(64),
});
const MIGRATION_IDENTITY = "5abc98ea1ca8f04f59946e3832b48cf33cf4ea01066b0a02e5888f92e172ce4d";

function assertMigrationError(
  code: ShadowMigrationError["code"],
  action: () => unknown,
): void {
  assert.throws(action, (error: unknown) => error instanceof ShadowMigrationError && error.code === code);
}

test("migration policy accepts every exact minimum and maximum and pins its domain-separated checksum", () => {
  const maximum = decodeShadowMigrationPolicyV1(POLICY);
  const minimum = decodeShadowMigrationPolicyV1(MINIMUM_POLICY);

  assert.deepEqual(maximum, POLICY);
  assert.deepEqual(minimum, MINIMUM_POLICY);
  assert.equal(Object.isFrozen(maximum), true);
  assert.equal(Object.isFrozen(minimum), true);
  assert.equal(shadowMigrationPolicyChecksum(maximum), POLICY_CHECKSUM);
});

test("migration policy rejects one value beyond every exact bound", () => {
  const cases = [
    ["maxEvents", 0, 100_001],
    ["maxAggregateBytes", 0, 67_108_865],
    ["maxEventBytes", 0, 1_048_577],
    ["maxBatchEvents", 0, 1_001],
    ["maxBatchBytes", 0, 8_388_609],
    ["deadlineMs", 0, 300_001],
    ["maxRetries", -1, 4],
    ["initialBackoffMs", 9, 501],
    ["maxBackoffMs", 9, 2_001],
    ["maxExpectedDifferenceRuleAgeMs", 0, 604_800_001],
  ] as const;

  for (const [field, below, above] of cases) {
    assertMigrationError(
      "MIGRATION_POLICY_INVALID",
      () => decodeShadowMigrationPolicyV1({ ...POLICY, [field]: below }),
    );
    assertMigrationError(
      "MIGRATION_POLICY_INVALID",
      () => decodeShadowMigrationPolicyV1({ ...POLICY, [field]: above }),
    );
  }

  assertMigrationError(
    "MIGRATION_POLICY_INVALID",
    () => decodeShadowMigrationPolicyV1({ ...POLICY, initialBackoffMs: 500, maxBackoffMs: 499 }),
  );
  for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertMigrationError(
      "MIGRATION_POLICY_INVALID",
      () => decodeShadowMigrationPolicyV1({ ...POLICY, maxEvents: value }),
    );
  }
  assertMigrationError(
    "MIGRATION_POLICY_INVALID",
    () => decodeShadowMigrationPolicyV1({ ...POLICY, maxRetries: -0 }),
  );
});

test("migration policy decoder accepts null-prototype data and rejects hostile property shapes before value access", () => {
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, POLICY);
  assert.deepEqual(decodeShadowMigrationPolicyV1(nullPrototype), POLICY);

  assertMigrationError("MIGRATION_POLICY_INVALID", () => decodeShadowMigrationPolicyV1(Object.create(POLICY)));
  assertMigrationError("MIGRATION_POLICY_INVALID", () => decodeShadowMigrationPolicyV1({ ...POLICY, extra: true }));
  assertMigrationError(
    "MIGRATION_POLICY_INVALID",
    () => decodeShadowMigrationPolicyV1({ ...POLICY, [Symbol("hostile")]: true }),
  );

  const hidden = { ...POLICY };
  Object.defineProperty(hidden, "maxEvents", { enumerable: false, value: POLICY.maxEvents });
  assertMigrationError("MIGRATION_POLICY_INVALID", () => decodeShadowMigrationPolicyV1(hidden));

  let accessorReads = 0;
  const accessor = { ...POLICY };
  Object.defineProperty(accessor, "maxEvents", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return POLICY.maxEvents;
    },
  });
  assertMigrationError("MIGRATION_POLICY_INVALID", () => decodeShadowMigrationPolicyV1(accessor));
  assert.equal(accessorReads, 0);
});

test("migration configuration is exact, frozen, versioned, and canonically bound to the policy checksum", () => {
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, CONFIGURATION);
  const decoded = decodeShadowMigrationConfigurationV1(nullPrototype);

  assert.deepEqual(decoded, CONFIGURATION);
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(shadowMigrationConfigurationChecksum(decoded), CONFIGURATION_CHECKSUM);

  for (const overrides of [
    { schemaVersion: 2 },
    { packageFormatVersion: 2 },
    { migrationAlgorithmVersion: 2 },
    { policyChecksum: "A".repeat(64) },
    { expectedDifferencePolicyVersion: 0 },
    { expectedDifferencePolicyVersion: 1.5 },
    { expectedDifferencePolicyVersion: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assertMigrationError(
      "MIGRATION_POLICY_INVALID",
      () => decodeShadowMigrationConfigurationV1({ ...CONFIGURATION, ...overrides }),
    );
  }
});

test("migration configuration rejects accessors, symbols, non-enumerables, inherited data, and unknown keys", () => {
  assertMigrationError(
    "MIGRATION_POLICY_INVALID",
    () => decodeShadowMigrationConfigurationV1(Object.create(CONFIGURATION)),
  );
  assertMigrationError(
    "MIGRATION_POLICY_INVALID",
    () => decodeShadowMigrationConfigurationV1({ ...CONFIGURATION, extra: true }),
  );
  assertMigrationError(
    "MIGRATION_POLICY_INVALID",
    () => decodeShadowMigrationConfigurationV1({ ...CONFIGURATION, [Symbol("hostile")]: true }),
  );

  const hidden = { ...CONFIGURATION };
  Object.defineProperty(hidden, "policyChecksum", { enumerable: false, value: CONFIGURATION.policyChecksum });
  assertMigrationError("MIGRATION_POLICY_INVALID", () => decodeShadowMigrationConfigurationV1(hidden));

  let accessorReads = 0;
  const accessor = { ...CONFIGURATION };
  Object.defineProperty(accessor, "policyChecksum", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return CONFIGURATION.policyChecksum;
    },
  });
  assertMigrationError("MIGRATION_POLICY_INVALID", () => decodeShadowMigrationConfigurationV1(accessor));
  assert.equal(accessorReads, 0);
});

test("phase order and deterministic migration identities are frozen and domain separated", () => {
  assert.deepEqual(SHADOW_MIGRATION_PHASES, [
    "snapshot-verified",
    "package-sealed",
    "import-committed",
    "projection-verified",
    "parity-complete",
    "compatibility-complete",
  ]);
  assert.equal(Object.isFrozen(SHADOW_MIGRATION_PHASES), true);
  assert.equal(shadowMigrationIdentity(IDENTITY_INPUT), MIGRATION_IDENTITY);
  assert.equal(shadowMigrationIdentity({ ...IDENTITY_INPUT }), MIGRATION_IDENTITY);
  assert.equal(
    deterministicMigrationUuid("attempt", MIGRATION_IDENTITY, 0),
    "482a23be-8c10-4f8e-bf4c-5193665d93f2",
  );
  assert.match(
    deterministicMigrationUuid("claim", MIGRATION_IDENTITY, Number.MAX_SAFE_INTEGER),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("migration identity and deterministic UUID inputs fail closed", () => {
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, IDENTITY_INPUT);
  assert.equal(shadowMigrationIdentity(nullPrototype as typeof IDENTITY_INPUT), MIGRATION_IDENTITY);

  const invalidIdentities: unknown[] = [
    Object.create(IDENTITY_INPUT),
    { ...IDENTITY_INPUT, extra: true },
    { ...IDENTITY_INPUT, [Symbol("hostile")]: true },
    { ...IDENTITY_INPUT, projectId: "not-a-uuid" },
    { ...IDENTITY_INPUT, storeId: "33333333-3333-3333-8333-333333333333" },
    { ...IDENTITY_INPUT, packageChecksum: "A".repeat(64) },
    { ...IDENTITY_INPUT, migrationAlgorithmVersion: 2 },
  ];
  for (const input of invalidIdentities) {
    assertMigrationError(
      "MIGRATION_SOURCE_INVALID",
      () => shadowMigrationIdentity(input as typeof IDENTITY_INPUT),
    );
  }

  let accessorReads = 0;
  const accessor = { ...IDENTITY_INPUT };
  Object.defineProperty(accessor, "packageChecksum", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return IDENTITY_INPUT.packageChecksum;
    },
  });
  assertMigrationError(
    "MIGRATION_SOURCE_INVALID",
    () => shadowMigrationIdentity(accessor as typeof IDENTITY_INPUT),
  );
  assert.equal(accessorReads, 0);

  for (const args of [
    ["other", MIGRATION_IDENTITY, 0],
    ["attempt", "A".repeat(64), 0],
    ["attempt", MIGRATION_IDENTITY, -1],
    ["attempt", MIGRATION_IDENTITY, -0],
    ["attempt", MIGRATION_IDENTITY, 1.5],
    ["attempt", MIGRATION_IDENTITY, Number.MAX_SAFE_INTEGER + 1],
  ] as const) {
    assertMigrationError(
      "MIGRATION_SOURCE_INVALID",
      () => deterministicMigrationUuid(
        args[0] as "attempt",
        args[1],
        args[2],
      ),
    );
  }
});
