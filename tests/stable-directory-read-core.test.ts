import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { ownedReadDirectory } from "./support/v2-verified-read-fixture.js";

const scenarios = ["valid", "foreign", "caps", "symlink", "lock-after", "release-race", "inputs",
  ...["dev", "ino", "symlink", "file"].map(field => `directory-after:${field}`),
  ...["canonicalPath", "device", "inode"].map(field => `directory:${field}`),
  ...["manifest", "generation", "lock"].map(target => `type:${target}`),
  ...["-wal", "-shm"].map(suffix => `sidecar:${suffix}`),
  ...["previous", "attempted", "displaced", "failed"].map(prefix => `retained:.projection-manifest.${prefix}-`),
  ...["manifest", "generation"].flatMap(target => [
    `path-after:${target}`,
    ...["opened", "after"].flatMap(phase => ["dev", "ino", "size", "ctimeNs"].map(field => `continuity:${target}:${phase}:${field}`)),
  ]),
];
for (const scenario of scenarios) {
  it(`fixed cwd capture and lock safeguards: ${scenario}`, context => {
    const directory = ownedReadDirectory();
    try {
      const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/v2-read-core-fixture.js", import.meta.url)),
        JSON.stringify(directory), scenario], { cwd: directory.canonicalPath, encoding: "utf8", windowsHide: true, timeout: 20000 });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
      if (child.stdout.trim()) context.diagnostic(child.stdout.trim());
    } finally { rmSync(directory.canonicalPath, { recursive: true, force: true }); }
  });
}
