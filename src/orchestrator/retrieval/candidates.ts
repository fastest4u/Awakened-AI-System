import { DatabaseSync } from "node:sqlite";

import { assertProjectionSidecarsAbsent } from "../projections/manifest.js";
import { parseProjectionManifest, type ProjectionManifestV1 } from "../projections/manifest-codec.js";
import type { ProjectionReaderLease } from "../projections/reader-lease.js";
import { InternalRetrievalError, validateInternalRetrievalRequest,
  type InternalRetrievalRequest, type RetrievalCandidateCollection } from "./contracts.js";
import { collectEligibleFromProjectionDatabase } from "./database-core.js";

export { collectEligibleFromProjectionDatabase } from "./database-core.js";

function projectionInvalid(): never {
  throw new InternalRetrievalError("RETRIEVAL_PROJECTION_INVALID");
}

function openProjection(path: string, deadlineMs: number): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      open: true,
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      timeout: deadlineMs,
    });
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    if (
      Number(database.prepare("PRAGMA query_only").get()?.query_only) !== 1
      || Number(database.prepare("PRAGMA trusted_schema").get()?.trusted_schema) !== 0
    ) return projectionInvalid();
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the projection-open failure.
    }
    if (error instanceof InternalRetrievalError) throw error;
    return projectionInvalid();
  }
}

export class SqliteRetrievalCandidateRepository {
  collectEligible(
    lease: ProjectionReaderLease,
    input: InternalRetrievalRequest,
  ): RetrievalCandidateCollection {
    const request = validateInternalRetrievalRequest(input);
    let manifest: ProjectionManifestV1;
    try {
      manifest = parseProjectionManifest(lease.manifest, request.binding);
    } catch {
      throw new InternalRetrievalError("PROJECTION_SCOPE_MISMATCH");
    }
    assertProjectionSidecarsAbsent(lease.databasePath);
    const database = openProjection(lease.databasePath, request.consistency.deadlineMs);
    try {
      return collectEligibleFromProjectionDatabase(database, manifest, input);
    } catch (error) {
      if (error instanceof InternalRetrievalError) throw error;
      return projectionInvalid();
    } finally {
      database.close();
      assertProjectionSidecarsAbsent(lease.databasePath);
    }
  }
}
