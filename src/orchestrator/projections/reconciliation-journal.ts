import {
  filesystemStableProjectionDirectoryOperations,
  type ProjectionDirectoryIdentity,
} from "./stable-directory.js";

const MAX_GENERATION = 2_147_483_647;

/**
 * Lock-scoped durable reservation for V2 final generation names. The stable
 * directory operation writes and verifies its fsync-backed journal before any
 * candidate pathname may be renamed into quarantine.
 */
export class V2ReconciliationJournal {
  reserveAtLeast(
    projectionDirectory: string,
    directoryIdentity: ProjectionDirectoryIdentity,
    lockToken: string,
    minimumGeneration: number,
  ): number {
    if (
      !Number.isSafeInteger(minimumGeneration)
      || minimumGeneration < 0
      || minimumGeneration > MAX_GENERATION
    ) throw new Error("PROJECTION_GENERATION_EXHAUSTED");
    return filesystemStableProjectionDirectoryOperations.reserveReconciliationJournal(
      projectionDirectory,
      directoryIdentity,
      lockToken,
      minimumGeneration,
    );
  }
}
