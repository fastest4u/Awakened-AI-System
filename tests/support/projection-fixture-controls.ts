import assert from "node:assert/strict";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it as nativeIt, type TestContext } from "node:test";
import type { ProjectionPathInspection } from "../../src/orchestrator/projections/manifest.js";
import { createOwnedProjectionFixture } from "./owned-projection-fixture.js";

type FixtureOwner = ReturnType<typeof createOwnedProjectionFixture>;
export interface SpellingEvidence {
  spelling: "raw" | "native";
  nonNative: boolean;
  phase: string;
  inspectionChecks: boolean[];
  captureAttempts: number;
  captureOutcome: "unobserved" | "returned" | "PROJECTION_PATH_INVALID" | "different-error";
}

export function samePathSpelling(left: string, right: string, platform = process.platform): boolean {
  const a = resolve(left), b = resolve(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function createProjectionFixtureControls() {
  const roots: FixtureOwner[] = [];
  const primaryFailures = new WeakSet<TestContext>();
  const resourceClosers = new WeakMap<object, () => void>();

  async function withPrimaryFailure<T>(t: TestContext, body: () => T | Promise<T>): Promise<T> {
    try { return await body(); }
    catch (primary) { primaryFailures.add(t); throw primary; }
  }
  const it = ((name: string, body: (t: TestContext) => unknown) =>
    nativeIt(name, async t => { await withPrimaryFailure(t, () => body(t)); })) as typeof nativeIt;

  function fixtureRoot(prefix: string, spelling: "raw" | "native"): string {
    const owner = createOwnedProjectionFixture(prefix, spelling);
    roots.push(owner);
    return owner.root;
  }
  function ownerForPath(path: string): FixtureOwner {
    const owner = roots.find(candidate => [candidate.rawRoot, candidate.nativeRoot].some(root => {
      const descendant = relative(root, path);
      return descendant === "" || (!isAbsolute(descendant) && descendant !== ".." && !descendant.startsWith(`..${sep}`));
    }));
    if (owner === undefined) throw new Error("CI_PROJECTION_FIXTURE_ROOT_INVALID");
    return owner;
  }
  function trackResource<T extends { close(): void }>(resource: T, path: string): T {
    const owner = ownerForPath(path);
    resourceClosers.set(resource, owner.closeWith(() => resource.close()));
    return resource;
  }
  function closeOwned(resource: { close(): void }): void {
    const close = resourceClosers.get(resource);
    if (close === undefined) throw new Error("CI_PROJECTION_FIXTURE_UNREGISTERED_RESOURCE");
    close();
  }
  function fixtureDatabase(path: string, options?: ConstructorParameters<typeof DatabaseSync>[1]): DatabaseSync {
    const owner = ownerForPath(path);
    try { return trackResource(options === undefined ? new DatabaseSync(path) : new DatabaseSync(path, options), path); }
    catch (primary) { owner.retain(); throw primary; }
  }
  function cleanupFixtures(t: TestContext): void {
    let incomplete = false;
    for (const owner of roots.splice(0)) {
      try { owner.cleanup(); } catch { incomplete = true; }
    }
    if (incomplete) {
      t.diagnostic("CI_PROJECTION_FIXTURE_CLEANUP_INCOMPLETE");
      if (!primaryFailures.has(t)) throw new Error("CI_PROJECTION_FIXTURE_CLEANUP_INCOMPLETE");
    }
  }
  return { roots, it, fixtureRoot, ownerForPath, trackResource, closeOwned, fixtureDatabase, cleanupFixtures, withPrimaryFailure };
}

export function rootEvidence(owner: FixtureOwner, root: string, spelling: "raw" | "native"): SpellingEvidence {
  assert.equal(isAbsolute(root), true);
  assert.equal(normalize(root), root);
  assert.equal(resolve(root), root);
  const stat = lstatSync(root, { bigint: true });
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  const evidence: SpellingEvidence = { spelling, nonNative: !samePathSpelling(owner.rawRoot, owner.nativeRoot),
    phase: "fixture-setup", inspectionChecks: [], captureAttempts: 0, captureOutcome: "unobserved" };
  assert.equal(samePathSpelling(realpathSync.native(root), owner.nativeRoot), true);
  return evidence;
}

export function forwardingInspection(evidence: SpellingEvidence, directory: string): ProjectionPathInspection {
  return {
    lstat(path) {
      const stat = lstatSync(path);
      if (path === directory || path === resolve(directory, "..")) evidence.inspectionChecks.push(stat.isDirectory() && !stat.isSymbolicLink());
      return stat;
    },
    realpath(path) {
      const actual = realpathSync(path);
      if (path === directory || path === resolve(directory, "..")) evidence.inspectionChecks.push(samePathSpelling(actual, path));
      return actual;
    },
  };
}

export function assertRawProjectionRefusal(failure: unknown, evidence: SpellingEvidence): void {
  assert.ok(failure instanceof Error, "a non-native raw root must retain its real refusal");
  assert.equal(failure.message, "PROJECTION_PATH_INVALID");
  assert.equal(evidence.phase, "ensure-published");
  assert.ok(evidence.inspectionChecks.length > 0, "raw refusal requires actual inspection observations");
  assert.ok(evidence.inspectionChecks.every(Boolean));
  assert.equal(evidence.captureOutcome, "unobserved", "inspection observations do not claim a private stable capture");
}
