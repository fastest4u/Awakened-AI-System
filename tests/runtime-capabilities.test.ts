import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  MINIMUM_NODE_VERSION,
  probeRuntimeCapabilities,
} from "../src/orchestrator/runtime/runtime-capabilities.js";

const root = process.cwd();

describe("event-store runtime contract", () => {
  it("declares and builds for the Node 24.16 integrity floor", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    const build = readFileSync(join(root, "scripts", "build.js"), "utf8");

    assert.equal(pkg.engines.node, ">=24.16.0");
    assert.match(pkg.devDependencies["@types/node"], /^\^24\./);
    assert.equal(lock.packages[""].engines.node, ">=24.16.0");
    assert.match(lock.packages[""].devDependencies["@types/node"], /^\^24\./);
    assert.equal(readFileSync(join(root, ".node-version"), "utf8").trim(), "24.16.0");
    assert.doesNotMatch(build, /target:\s*['"]node22/);
    assert.equal(build.match(/target:\s*['"]node24\.16['"]/g)?.length, 9);
    assert.deepEqual([...build.matchAll(/entryPoints:\s*\['([^']+)'\]/g)].map(match => match[1]).sort(), [
      "src/index.ts", "src/cli.ts", "src/workers/project-store.worker.ts", "src/workers/project-store-upgrade-phase.worker.ts",
      "src/orchestrator/materialization/stable-compatibility-directory.worker.ts", "src/orchestrator/migration/v2-shadow-migration-rehearsal.ts",
      "src/v2.ts", "src/v2-admin.ts",
    ].sort());
    assert.equal(MINIMUM_NODE_VERSION, "24.16.0");
  });

  it("rejects Node 22.22.3 before opening even the disposable capability database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-floor-rejection-"));
    const probePath = join(directory, "must-not-open.sqlite");
    const original = Object.getOwnPropertyDescriptor(process.versions, "node");
    assert.ok(original);
    let report;
    try {
      Object.defineProperty(process.versions, "node", {
        ...original,
        value: "22.22.3",
      });
      report = await probeRuntimeCapabilities(probePath);
    } finally {
      Object.defineProperty(process.versions, "node", original);
    }
    try {
      assert.equal(report.ok, false);
      if (report.ok) assert.fail("Node 22.22.3 unexpectedly passed the runtime gate");
      assert.equal(report.nodeVersion, "22.22.3");
      assert.equal(report.checks.nodeVersionAtLeastMinimum, false);
      assert.equal(report.checks.nodeSqlite, false);
      assert.equal(existsSync(probePath), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts the exact Node 24.16 minimum only when deserialize and query-only probes pass", () => {
    const result = spawnSync(process.execPath, [join(root, "scripts", "check-runtime.js"), "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.wal, true);
    assert.equal(report.fts5, true);
    assert.equal(report.sqliteDeserialize, true);
    assert.equal(report.queryOnly, true);
    assert.match(report.sqliteVersion, /^\d+\.\d+\.\d+$/);
  });

  it("runs release gates only at Node 24.16 and rejects the former Node 22.22.3 floor", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    assert.match(workflow, /node-version:\s*\r?\n\s*- "24\.16\.0"/);
    assert.doesNotMatch(workflow, /\s+- "22\.22\.3"/);
    assert.match(workflow, /name: Reject Node 22\.22\.3/);
    assert.match(workflow, /node-version: "22\.22\.3"/);
    assert.match(
      workflow,
      /Node 22\.22\.3 is below 24\.16\.0/,
    );
  });
});
