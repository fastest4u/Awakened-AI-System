import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  fsyncDirectory,
  type DirectoryFsyncOperations,
} from "../src/orchestrator/identity/directory-durability.js";

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(`directory fsync ${code}`), { code });
}

describe("directory durability", () => {
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
