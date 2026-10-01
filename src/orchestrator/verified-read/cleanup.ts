import { createCwdProjectionReadCore } from "../projections/stable-directory-read-core.js";
import type { CleanupBootstrap, CleanupReply } from "./contracts.js";
import { decodeCleanupBootstrap } from "./protocol.js";

/** Narrow token release only; no admission, SQL, image access, generation deletion or repair. */
export function releaseOwnedReadLock(input: CleanupBootstrap, independentlyMeasuredBuildHash: string): CleanupReply {
  const bootstrap = decodeCleanupBootstrap(input);
  let outcome: CleanupReply["outcome"] = "failed";
  try {
    if (bootstrap.remainingMs <= 0 || !/^[0-9a-f]{64}$/u.test(independentlyMeasuredBuildHash)
      || independentlyMeasuredBuildHash !== bootstrap.expectedBuildHash) throw new Error("FRESH_START_BUILD_MISMATCH");
    outcome = createCwdProjectionReadCore(bootstrap.directory).releaseOwnedLock(bootstrap.lockToken, true);
  } catch { /* Preserve all uncertain/foreign/partial evidence; bounded outcome only. */ }
  return Object.freeze({ version: 1, ids: bootstrap.ids, kind: "cleanup", outcome,
    cleanup: outcome === "released" || outcome === "absent" ? "complete" : "incomplete" });
}
