import { lstatSync, mkdtempSync, realpathSync, rmSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface OwnedProjectionFixture {
  readonly rawRoot: string;
  readonly nativeRoot: string;
  readonly root: string;
  closeWith(close: () => void): () => void;
  retain(): void;
  cleanup(): void;
}

export function createOwnedProjectionFixture(prefix: string, spelling: "raw" | "native" = "native"): OwnedProjectionFixture {
  const rootCode = "CI_PROJECTION_FIXTURE_ROOT_INVALID", cleanupCode = "CI_PROJECTION_FIXTURE_CLEANUP_INCOMPLETE";
  const fixedError = (code: string) => Object.assign(new Error(code), { code });
  const equalSpelling = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  let rawRoot: string, nativeRoot: string, created: BigIntStats;
  function sameOwner(current: BigIntStats): boolean {
    // ctime changes when descendants change; birth identity belongs to the created directory.
    return created.isDirectory() && !created.isSymbolicLink() && current.isDirectory() && !current.isSymbolicLink()
      && current.dev === created.dev && current.ino === created.ino && current.birthtimeNs === created.birthtimeNs;
  }
  function assertOwner(code: string): void {
    try {
      if (!sameOwner(lstatSync(rawRoot, { bigint: true })) || !sameOwner(lstatSync(nativeRoot, { bigint: true }))
        || !equalSpelling(resolve(realpathSync.native(rawRoot)), nativeRoot)
        || !equalSpelling(resolve(realpathSync.native(nativeRoot)), nativeRoot)) throw fixedError(code);
    } catch { throw fixedError(code); }
  }
  try {
    if (spelling !== "raw" && spelling !== "native") throw fixedError(rootCode);
    rawRoot = mkdtempSync(join(tmpdir(), prefix));
    // Raw creation authority must exist before native lookup or any descendant use.
    created = lstatSync(rawRoot, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink()) throw fixedError(rootCode);
    nativeRoot = resolve(realpathSync.native(rawRoot));
    assertOwner(rootCode);
  } catch {
    // Partial setup has no proved cleanup authority. Retain any created root.
    throw fixedError(rootCode);
  }

  const resources: { attempted: boolean; succeeded: boolean; close(): void }[] = [];
  let retained = false, incomplete = false, removed = false;
  function closeWith(close: () => void): () => void {
    if (removed) throw fixedError(cleanupCode);
    const resource = { attempted: false, succeeded: false, close: () => {} };
    resource.close = () => {
      if (resource.attempted) {
        if (!resource.succeeded) throw fixedError(cleanupCode);
        return;
      }
      resource.attempted = true;
      try { close(); resource.succeeded = true; }
      catch (primary) { incomplete = true; throw primary; }
    };
    resources.push(resource);
    return resource.close;
  }
  function cleanup(): void {
    if (removed) return;
    // Even retained/uncertain fixtures still attempt every previously unattempted owned close.
    for (const resource of resources) {
      if (!resource.attempted) { try { resource.close(); } catch { incomplete = true; } }
    }
    if (retained || incomplete || resources.some(resource => !resource.succeeded)) throw fixedError(cleanupCode);
    try {
      assertOwner(cleanupCode);
      // Removal uses the captured raw root, never a newly selected realpath target.
      rmSync(rawRoot, { recursive: true });
      removed = true;
    } catch { incomplete = true; throw fixedError(cleanupCode); }
  }
  return { rawRoot, nativeRoot, root: spelling === "raw" ? rawRoot : nativeRoot,
    closeWith, retain: () => { retained = true; }, cleanup };
}
