import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { capturePathSnapshot, createCiDiagnosticCollector } from "./support/ci-path-diagnostics.js";
import {
  createDirectoryDurably,
  fsyncDirectory,
  type DirectoryFsyncOperations,
} from "../src/orchestrator/identity/directory-durability.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(`directory fsync ${code}`), { code });
}

describe("directory durability", () => {
  it("replays the full parent chain from a known durable base for an existing tree", (t) => {
    const root = mkdtempSync(join(tmpdir(), "directory-durability-contender-"));
    roots.push(root);
    const durableBase = join(root, "base");
    const target = join(durableBase, "nested", "target");
    mkdirSync(target, { recursive: true });
    const barriers: string[] = [];

    const collector = createCiDiagnosticCollector(line => t.diagnostic(line));
    capturePathSnapshot({ family: "durable-directory", caseId: "durability-control", directory: target, durableBase }, collector);
    try { t.diagnostic(`CI path diagnostics incomplete=${collector.incomplete}`); } catch { /* Informational only. */ }
    createDirectoryDurably(target, durableBase, (path) => barriers.push(path));

    assert.deepEqual(barriers, [resolve(durableBase), resolve(durableBase, "nested")]);
  });

  it("rejects a target outside the known durable base before creating it", () => {
    const root = mkdtempSync(join(tmpdir(), "directory-durability-escape-"));
    roots.push(root);
    const durableBase = join(root, "base");
    const escapedTarget = join(root, "outside", "target");
    mkdirSync(durableBase);

    assert.throws(
      () => createDirectoryDurably(escapedTarget, durableBase, () => undefined),
      /DIRECTORY_OUTSIDE_DURABLE_BASE/,
    );
    assert.equal(existsSync(escapedTarget), false);
  });

  it("tolerates portable unsupported fsync errors after closing the directory handle", () => {
    for (const code of ["EINVAL", "EISDIR", "ENOTSUP", "EOPNOTSUPP"]) {
      const calls: string[] = [];
      const operations: DirectoryFsyncOperations = {
        platform: "linux",
        openDirectory(path) {
          calls.push(`open:${path}`);
          return 17;
        },
        fsync(handle) {
          calls.push(`fsync:${handle}`);
          throw codedError(code);
        },
        close(handle) {
          calls.push(`close:${handle}`);
        },
      };

      assert.doesNotThrow(() => fsyncDirectory("/authority", operations), code);
      assert.deepEqual(calls, ["open:/authority", "fsync:17", "close:17"]);
    }
  });

  it("tolerates Windows-only directory errors only on Windows", () => {
    for (const code of ["EACCES", "EBADF", "EPERM"]) {
      const failure = codedError(code);
      const windowsOperations: DirectoryFsyncOperations = {
        platform: "win32",
        openDirectory() {
          throw failure;
        },
        fsync() {
          assert.fail("fsync must not run without a directory handle");
        },
        close() {
          assert.fail("close must not run without a directory handle");
        },
      };
      assert.doesNotThrow(() => fsyncDirectory("C:\\authority", windowsOperations), code);

      const nonWindowsOperations = { ...windowsOperations, platform: "linux" as const };
      assert.throws(
        () => fsyncDirectory("/authority", nonWindowsOperations),
        (error: unknown) => error === failure,
      );
    }
  });

  it("propagates real fsync errors after closing the directory handle", () => {
    const failure = codedError("EIO");
    const calls: string[] = [];
    const operations: DirectoryFsyncOperations = {
      platform: "win32",
      openDirectory(path) {
        calls.push(`open:${path}`);
        return 23;
      },
      fsync(handle) {
        calls.push(`fsync:${handle}`);
        throw failure;
      },
      close(handle) {
        calls.push(`close:${handle}`);
      },
    };

    assert.throws(
      () => fsyncDirectory("C:\\authority", operations),
      (error: unknown) => error === failure,
    );
    assert.deepEqual(calls, ["open:C:\\authority", "fsync:23", "close:23"]);
  });
});
