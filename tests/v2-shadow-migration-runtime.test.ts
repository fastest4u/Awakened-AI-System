import assert from "node:assert/strict";
import test from "node:test";
import { createShadowMigrationInvocationDeadline, shadowMigrationPhaseMetadata } from "../src/orchestrator/migration/v2-shadow-migration-runtime.js";
import { ShadowMigrationError } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";

const exhausted = (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED";

test("deadline duration accepts only the sealed integer domain and never returns a larger budget", () => {
  for (const duration of [0, -0, -1, 1.5, 300001, Number.MAX_SAFE_INTEGER, NaN, Infinity]) {
    assert.throws(() => createShadowMigrationInvocationDeadline(duration, () => 0), exhausted);
  }
  for (const duration of [1, 300000]) {
    const deadline = createShadowMigrationInvocationDeadline(duration, () => 0);
    try { assert.equal(deadline.remainingMs(), duration); assert.equal(Object.isFrozen(deadline), true); }
    finally { deadline.dispose(); }
  }
});

test("one invocation spends its original budget and rejects even a fractional exhausted remainder", () => {
  let now = 900;
  const deadline = createShadowMigrationInvocationDeadline(100, () => now);
  try {
    assert.equal(deadline.remainingMs(), 100);
    now = 940.25;
    assert.equal(deadline.remainingMs(), 59);
    now = 999.5;
    assert.throws(() => deadline.remainingMs(), exhausted);
    assert.equal(deadline.signal.aborted, true);
    now = 900;
    assert.throws(() => deadline.remainingMs(), exhausted);
  } finally { deadline.dispose(); }
});

test("regressing and non-finite clocks cannot mint additional time", () => {
  for (const next of [Number.NaN, Infinity, -Infinity, 4]) {
    let now = 5;
    const deadline = createShadowMigrationInvocationDeadline(100, () => now);
    try { now = next; assert.throws(() => deadline.remainingMs(), exhausted); }
    finally { deadline.dispose(); }
  }
  assert.throws(() => createShadowMigrationInvocationDeadline(100, () => Number.NaN), exhausted);
  let now = 0;
  const deadline = createShadowMigrationInvocationDeadline(100, () => now);
  try {
    now = 10; assert.equal(deadline.remainingMs(), 90);
    now = 9; assert.throws(() => deadline.remainingMs(), exhausted);
  } finally { deadline.dispose(); }
});

test("native abort timer and disposal close the invocation budget", { timeout: 10_000 }, async (t) => {
  const deadline = createShadowMigrationInvocationDeadline(10, () => 0);
  const keepAlive = setInterval(() => {}, 100);
  t.after(() => { clearInterval(keepAlive); deadline.dispose(); });
  await new Promise<void>(resolve => {
    deadline.signal.addEventListener("abort", () => { clearInterval(keepAlive); resolve(); }, { once: true });
  });
  assert.equal(deadline.signal.aborted, true);
  assert.throws(() => deadline.remainingMs(), exhausted);
  deadline.dispose();
  const disposed = createShadowMigrationInvocationDeadline(300000, () => 0);
  disposed.dispose(); disposed.dispose();
  assert.throws(() => disposed.remainingMs(), exhausted);
});

test("phase metadata uses source UTC and ordinal across calendar boundaries", () => {
  const identity = "a".repeat(64);
  const metadata = shadowMigrationPhaseMetadata(identity, "2026-12-31T23:59:59.998Z", 3);
  assert.equal(metadata.recordedAt, "2027-01-01T00:00:00.001Z");
  assert.match(metadata.attemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(Object.isFrozen(metadata), true);
  assert.notEqual(metadata.attemptId, shadowMigrationPhaseMetadata(identity, "2026-12-31T23:59:59.998Z", 4).attemptId);
  assert.deepEqual(metadata, shadowMigrationPhaseMetadata(identity, "2026-12-31T23:59:59.998Z", 3));
});

test("phase metadata reuses the committed attempt domain under different invocation clock origins", () => {
  const identity = "5abc98ea1ca8f04f59946e3832b48cf33cf4ea01066b0a02e5888f92e172ce4d";
  for (const origin of [0, 500, 987654321]) {
    const deadline = createShadowMigrationInvocationDeadline(1000, () => origin);
    try {
      deadline.remainingMs();
      assert.deepEqual(shadowMigrationPhaseMetadata(identity, "2026-09-10T00:00:00.000Z", 0), {
        attemptId: "482a23be-8c10-4f8e-bf4c-5193665d93f2", recordedAt: "2026-09-10T00:00:00.000Z",
      });
    } finally { deadline.dispose(); }
  }
});

test("non-canonical UTC and out-of-range phase arithmetic fail before metadata publication", () => {
  for (const time of ["2026-09-10", "2026-02-30T00:00:00.000Z", "2026-09-10T00:00:00Z", "+010000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"]) {
    assert.throws(() => shadowMigrationPhaseMetadata("a".repeat(64), time, 5),
      (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_SOURCE_INVALID");
  }
  for (const ordinal of [-1, -0, 6, 1.5, NaN, Infinity]) {
    assert.throws(() => shadowMigrationPhaseMetadata("a".repeat(64), "2026-09-10T00:00:00.000Z", ordinal),
      (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_SOURCE_INVALID");
  }
});
