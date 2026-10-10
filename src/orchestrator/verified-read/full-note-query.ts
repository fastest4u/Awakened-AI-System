import type { DatabaseSync } from "node:sqlite";
import type { ProjectionManifestV3 } from "../projections/manifest-codec.js";
import { validateGovernedNoteProjectionRows } from "../projections/contracts.js";
import { InternalRetrievalError } from "../retrieval/contracts.js";
import { getGovernedNoteFromProjectionDatabase } from "../retrieval/database-core.js";
import { queryNativeContent, type NativeQueryContext } from "./content-query.js";
import { detachNativeContentItem } from "./content-items.js";
import type { FullNoteVerifiedReadReceiptV1, GetFullNoteRequest, NativeFullNoteItem, NativeFullNoteResultV1 } from "./full-note-contracts.js";
import { decodeFullNoteVerifiedReadReceipt, decodeGetFullNoteRequest, decodeNativeFullNoteResult } from "./full-note-protocol.js";

export type FullNoteQueryContext = Omit<NativeQueryContext, "request" | "receipt"> & {
  request: GetFullNoteRequest; receipt: FullNoteVerifiedReadReceiptV1;
};
function fail(code: "INTEGRITY_FAILURE" | "PROJECTION_SCOPE_MISMATCH" | "WORKER_TIMEOUT"): never {
  throw Object.assign(new Error(code), { code });
}
/** Private candidate only: image capture, current admission and closure remain the owning child's responsibility. */
export function queryNativeFullNote(database: DatabaseSync, manifest: ProjectionManifestV3, context: FullNoteQueryContext): NativeFullNoteResultV1 {
  const started = performance.now();
  const request = decodeGetFullNoteRequest(context.request, context.binding.session);
  try {
    if (manifest.schemaVersion !== 3) return fail("INTEGRITY_FAILURE");
    const receipt = decodeFullNoteVerifiedReadReceipt(context.receipt);
    const { projectionSchemaVersion: _schema, ...inheritedReceipt } = receipt;
    // Reuse the unchanged canonical selector, including binding, positions, deadline, temporal,
    // session selection (distinct from receipt consistency), eligibility and conflict counting.
    const selected = queryNativeContent(database, manifest, { ...context,
      request: { ...request, operation: "get-canonical-record" }, receipt: { ...inheritedReceipt, operation: "get-canonical-record" } });
    if (selected.operation !== "get-canonical-record") return fail("INTEGRITY_FAILURE");
    const canonical = selected.lookup.item;
    let item: NativeFullNoteItem | null = null;
    if (canonical !== null) {
      const row = getGovernedNoteFromProjectionDatabase(database, manifest, canonical.projectId, canonical.id);
      // Keep the private normalized key/marker until the pure projection guard has established
      // required presence, V1/V2 tuple, kind, identity and position correspondence.
      validateGovernedNoteProjectionRows([{ projectId: canonical.projectId, itemId: canonical.id,
        normalizedKey: canonical.normalizedKey, verificationMethod: canonical.verificationMethod,
        sourceEventPosition: canonical.sourceEventPosition }], row === null ? [] : [row], BigInt(manifest.terminalEventPosition));
      const inherited = detachNativeContentItem(canonical);
      item = row?.format === "markdown"
        ? Object.freeze({ ...inherited, recordKind: row.recordKind, bodyAvailability: "present",
            content: Object.freeze({ format: "markdown", body: row.body!, contentHash: row.bodyContentHash! }) })
        : Object.freeze({ ...inherited, recordKind: row?.recordKind ?? null, bodyAvailability: "absent", content: null });
    }
    const result = decodeNativeFullNoteResult({ operation: "get-full-note", noteBoundsVersion: "v2-full-note-bounds-1",
      selectionScope: selected.selectionScope, item, conflict: canonical === null || canonical.conflictGroupId === null ? null : {
        conflictGroupId: canonical.conflictGroupId, eligibleMemberCount: selected.lookup.eligibleConflictMemberCount!,
        returnedMemberCount: 1, truncated: selected.lookup.eligibleConflictMemberCount! > 1,
      } });
    if (performance.now() >= started + context.remainingMs) return fail("WORKER_TIMEOUT");
    return result;
  } catch (error) {
    if (error instanceof InternalRetrievalError && error.code === "PROJECTION_SCOPE_MISMATCH") return fail("PROJECTION_SCOPE_MISMATCH");
    if (error instanceof Error && (error.message === "WORKER_TIMEOUT" || error.message === "PROJECTION_SCOPE_MISMATCH")) throw error;
    return fail("INTEGRITY_FAILURE");
  }
}
