import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AtomicArtifactReplacer } from "../src/orchestrator/materialization/atomic-artifact-replacer.js";
import type { LifecycleFaultContext } from "../src/orchestrator/lifecycle/lifecycle-faults.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AtomicArtifactReplacer", () => {
  it("exposes the temporary-stage and post-replace fault boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-artifact-replacer-faults-"));
    roots.push(root);
    const targetPath = join(root, "session.md");
    const tempPath = join(root, ".session.md.pm-materialize.tmp");
    const context: LifecycleFaultContext = {
      projectId: "00000000-0000-4000-8000-000000000001" as never,
      sessionId: null,
      workflowId: null,
      commandId: null,
      idempotencyKeyHash: null,
      workId: "materialize-1",
      eventPosition: null,
      materializationRevision: "1",
    };
    let point: string | undefined;
    const replacer = new AtomicArtifactReplacer({
      durableBase: root,
      faultInjector: {
        hit(_boundary, observedPoint): void {
          point = observedPoint;
          if (observedPoint === "after-temp-fsync-before-replace") throw new Error("fixture crash");
        },
      },
    });

    assert.throws(() => replacer.replace({ targetPath, tempPath, bytes: Buffer.from("payload"), faultContext: context }), /fixture crash/);
    assert.equal(point, "after-temp-fsync-before-replace");
    assert.equal(existsSync(targetPath), false);
    assert.equal(existsSync(tempPath), false);
  });

  it("writes exact bytes through a same-directory temporary file", () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-artifact-replacer-"));
    roots.push(root);
    const targetPath = join(root, "session.md");
    const tempPath = join(root, ".session.md.pm-materialize.tmp");
    const bytes = Buffer.from("line one\r\nline two\u00e9\n", "utf8");

    new AtomicArtifactReplacer({ durableBase: root }).replace({
      targetPath,
      tempPath,
      bytes,
    });

    assert.deepEqual(readFileSync(targetPath), bytes);
  });

  it("replaces an existing regular target through the same atomic path", () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-artifact-replacer-existing-"));
    roots.push(root);
    const targetPath = join(root, "session.md");
    const tempPath = join(root, ".session.md.pm-materialize.tmp");
    writeFileSync(targetPath, "old", "utf8");

    new AtomicArtifactReplacer({ durableBase: root }).replace({
      targetPath,
      tempPath,
      bytes: Buffer.from("new", "utf8"),
    });

    assert.equal(readFileSync(targetPath, "utf8"), "new");
  });

  it("removes only the known temporary file when file fsync fails", () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-artifact-replacer-fsync-"));
    roots.push(root);
    const targetPath = join(root, "session.md");
    const tempPath = join(root, ".session.md.pm-materialize.tmp");
    const closed: number[] = [];
    const failure = Object.assign(new Error("fsync failed"), { code: "EIO" });

    assert.throws(
      () => new AtomicArtifactReplacer({
        durableBase: root,
        operations: {
          fsync: () => { throw failure; },
          close: (handle) => { closed.push(handle); },
        },
      }).replace({ targetPath, tempPath, bytes: Buffer.from("payload") }),
      (error: unknown) => error === failure,
    );
    assert.equal(closed.length, 1);
    assert.equal(existsSync(tempPath), false);
    assert.equal(existsSync(targetPath), false);
  });

  it("rejects a target outside the durable base without creating it", () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-artifact-replacer-containment-"));
    roots.push(root);
    const outside = join(root, "..", "outside-session.md");
    const tempPath = join(root, ".session.md.pm-materialize.tmp");

    assert.throws(
      () => new AtomicArtifactReplacer({ durableBase: root }).replace({
        targetPath: outside,
        tempPath,
        bytes: Buffer.from("payload"),
      }),
      (error: unknown) => (error as { code?: string }).code === "MATERIALIZATION_CONFLICT",
    );
    assert.equal(existsSync(outside), false);
  });

  it("rejects relative target and temporary paths", () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-artifact-replacer-relative-"));
    roots.push(root);

    assert.throws(
      () => new AtomicArtifactReplacer({ durableBase: root }).replace({
        targetPath: "session.md",
        tempPath: ".session.md.pm-materialize.tmp",
        bytes: Buffer.from("payload"),
      }),
      (error: unknown) => (error as { code?: string }).code === "MATERIALIZATION_CONFLICT",
    );
  });

  it("rejects an existing temporary path and cleans only that known path", () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-artifact-replacer-temp-"));
    roots.push(root);
    const targetPath = join(root, "session.md");
    const tempPath = join(root, ".session.md.pm-materialize.tmp");
    writeFileSync(tempPath, "old", "utf8");

    assert.throws(
      () => new AtomicArtifactReplacer({ durableBase: root }).replace({
        targetPath,
        tempPath,
        bytes: Buffer.from("new"),
      }),
      /EEXIST|MATERIALIZATION_CONFLICT/u,
    );
    assert.equal(existsSync(tempPath), false);
    assert.equal(existsSync(targetPath), false);
  });

  it("rejects a symlinked target path", (t) => {
    const root = mkdtempSync(join(tmpdir(), "atomic-artifact-replacer-symlink-"));
    roots.push(root);
    const outside = mkdtempSync(join(tmpdir(), "atomic-artifact-replacer-outside-"));
    roots.push(outside);
    const targetPath = join(root, "session.md");
    const tempPath = join(root, ".session.md.pm-materialize.tmp");
    const outsideTarget = join(outside, "outside.md");
    writeFileSync(outsideTarget, "outside", "utf8");
    try {
      symlinkSync(outsideTarget, targetPath);
    } catch (error) {
      t.skip(`symlink creation unavailable: ${String(error)}`);
      return;
    }

    assert.throws(
      () => new AtomicArtifactReplacer({ durableBase: root }).replace({
        targetPath,
        tempPath,
        bytes: Buffer.from("payload"),
      }),
      (error: unknown) => (error as { code?: string }).code === "MATERIALIZATION_CONFLICT",
    );
    assert.equal(readFileSync(outsideTarget, "utf8"), "outside");
  });
});
