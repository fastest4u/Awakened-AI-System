import { parseProjectionManifestV2 } from "../projections/manifest-codec.js";
import type { V2ProjectionReaderLease } from "../projections/v2-reader-lease.js";
import { collectEligibleFromProjectionDatabase } from "./database-core.js";
import {
  InternalRetrievalError,
  type InternalRetrievalRequest,
  type RetrievalCandidateCollection,
} from "./contracts.js";

export class V2SqliteRetrievalCandidateRepository {
  collectEligible(
    lease: V2ProjectionReaderLease,
    input: InternalRetrievalRequest,
  ): RetrievalCandidateCollection {
    try {
      const manifest = parseProjectionManifestV2(lease.manifest, input.binding);
      return collectEligibleFromProjectionDatabase(lease.database, manifest, input);
    } catch (error) {
      if (error instanceof InternalRetrievalError) throw error;
      throw new InternalRetrievalError("RETRIEVAL_PROJECTION_INVALID");
    }
  }
}
