import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const root = process.cwd();

describe("event-store runtime contract", () => {
  it("declares the WAL-safe Node floor", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(pkg.engines.node, ">=22.22.3");
    assert.match(pkg.devDependencies["@types/node"], /^\^22\./);
  });

  it("passes the functional runtime probe on a supported runtime", () => {
    const result = spawnSync(process.execPath, [join(root, "scripts", "check-runtime.js"), "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.wal, true);
    assert.equal(report.fts5, true);
    assert.match(report.sqliteVersion, /^\d+\.\d+\.\d+$/);
  });
});
