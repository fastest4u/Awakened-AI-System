import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertRawProjectionRefusal,
  createProjectionFixtureControls,
  forwardingInspection,
  rootEvidence,
  samePathSpelling,
  type SpellingEvidence,
} from "./support/projection-fixture-controls.js";

test("projection fixture controls reject wrong-phase and empty refusal evidence", () => {
  const evidence: SpellingEvidence = { spelling: "raw", nonNative: true, phase: "ensure-published",
    inspectionChecks: [true, true], captureAttempts: 0, captureOutcome: "unobserved" };
  const failure = new Error("PROJECTION_PATH_INVALID");
  assert.doesNotThrow(() => assertRawProjectionRefusal(failure, evidence));
  const unrejected: string[] = [];
  const invalidCases: [string, SpellingEvidence][] = [
    ["wrong-phase", { ...evidence, phase: "coordinator-constructor" }],
    ["empty-inspection", { ...evidence, inspectionChecks: [] }],
  ];
  for (const [name, invalid] of invalidCases) {
    try { assertRawProjectionRefusal(failure, invalid); unrejected.push(name); }
    catch (actual) { assert.ok(actual instanceof assert.AssertionError); }
  }
  assert.deepEqual(unrejected, [], "wrong-phase and empty actual evidence must both be refused");
  assert.throws(() => assertRawProjectionRefusal(new Error("different-error"), evidence), assert.AssertionError);
  assert.throws(() => assertRawProjectionRefusal(failure, { ...evidence, inspectionChecks: [true, false] }), assert.AssertionError);
  assert.throws(() => assertRawProjectionRefusal(failure, { ...evidence, captureOutcome: "returned" }), assert.AssertionError);
});

test("projection fixture controls preserve platform-specific path equality", () => {
  assert.equal(samePathSpelling("fixture/Case", "fixture/case", "win32"), true);
  assert.equal(samePathSpelling("fixture/Case", "fixture/case", "linux"), false);
  assert.equal(samePathSpelling("fixture/Case", "fixture/case", "darwin"), false);
  assert.equal(samePathSpelling("fixture/Case", "fixture/Case", "linux"), true);
});

test("projection fixture controls isolate ownership and preserve primary cleanup failure", async t => {
  const first = createProjectionFixtureControls();
  const second = createProjectionFixtureControls();
  const uncertainRoot = first.fixtureRoot("projection-controls-uncertain-", "raw");
  const healthyRoot = first.fixtureRoot("projection-controls-healthy-", "raw");
  const secondRoot = second.fixtureRoot("projection-controls-independent-", "raw");
  const uncertainOwner = first.ownerForPath(uncertainRoot);
  const uncertain = first.fixtureDatabase(join(uncertainRoot, "source.sqlite"));
  const healthy = first.fixtureDatabase(join(healthyRoot, "source.sqlite"));
  const independent = second.fixtureDatabase(join(secondRoot, "source.sqlite"));
  const nativeClose = uncertain.close;
  const primary = new Error("controlled primary test failure");
  const closeFailure = new Error("controlled uncertainty after native close returned");
  let closeAttempts = 0;
  let nativeClosed = false;
  try {
    assert.throws(() => first.ownerForPath(secondRoot), /CI_PROJECTION_FIXTURE_ROOT_INVALID/u);
    assert.throws(() => second.ownerForPath(healthyRoot), /CI_PROJECTION_FIXTURE_ROOT_INVALID/u);
    assert.throws(() => second.closeOwned(healthy), /CI_PROJECTION_FIXTURE_UNREGISTERED_RESOURCE/u);
    const evidence = rootEvidence(second.ownerForPath(secondRoot), secondRoot, "raw");
    const inspection = forwardingInspection(evidence, secondRoot);
    assert.equal(inspection.lstat(secondRoot).isDirectory(), true);
    inspection.realpath(secondRoot);
    assert.deepEqual(evidence.inspectionChecks, [true, true]);
    assert.equal(evidence.captureOutcome, "unobserved");
    uncertain.close = function () {
      closeAttempts += 1;
      nativeClose.call(this);
      nativeClosed = true;
      throw closeFailure;
    };
    await assert.rejects(() => first.withPrimaryFailure(t, () => { throw primary; }), actual => actual === primary);
    assert.doesNotThrow(() => first.cleanupFixtures(t));
    assert.equal(closeAttempts, 1);
    assert.equal(nativeClosed, true, "uncertainty is injected only after actual native close returns");
    assert.equal(existsSync(uncertainRoot), true);
    assert.throws(() => uncertainOwner.cleanup(), /CI_PROJECTION_FIXTURE_CLEANUP_INCOMPLETE/u);
    assert.throws(() => first.closeOwned(uncertain), /CI_PROJECTION_FIXTURE_CLEANUP_INCOMPLETE/u);
    assert.equal(closeAttempts, 1, "uncertain original resource is never retried");
    assert.equal(existsSync(healthyRoot), false, "later owner cleanup is attempted after earlier uncertainty");
    assert.throws(() => healthy.prepare("SELECT 1"));
    assert.equal(existsSync(secondRoot), true);
    assert.equal(independent.prepare("SELECT 1 AS value").get()?.value, 1);
    second.cleanupFixtures(t);
    assert.equal(existsSync(secondRoot), false);
    assert.throws(() => independent.prepare("SELECT 1"));
  } finally {
    uncertain.close = nativeClose;
    if (!nativeClosed) first.closeOwned(uncertain);
    first.cleanupFixtures(t);
    second.cleanupFixtures(t);
  }
});
