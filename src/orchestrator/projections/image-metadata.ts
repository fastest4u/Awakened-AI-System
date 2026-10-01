import type { DatabaseSync } from "node:sqlite";
import type { ProjectionManifestV1, ProjectionManifestV2 } from "./manifest-codec.js";

type Manifest = ProjectionManifestV1 | ProjectionManifestV2;
export type ProjectionImageMetadata = Readonly<Pick<Manifest,
  "schemaVersion" | "projectId" | "vaultId" | "storeId" | "workspaceId" | "branchScopeId" | "branchRef"
  | "sessionId" | "generation" | "terminalEventPosition" | "terminalEventHash">>;

export class ProjectionImageMetadataError extends Error {
  readonly code: "INTEGRITY_FAILURE" | "PROJECTION_SCOPE_MISMATCH";
  constructor(readonly kind: "malformed" | "scope-mismatch") {
    super(kind === "malformed" ? "INTEGRITY_FAILURE" : "PROJECTION_SCOPE_MISMATCH");
    this.name = "ProjectionImageMetadataError";
    this.code = kind === "malformed" ? "INTEGRITY_FAILURE" : "PROJECTION_SCOPE_MISMATCH";
  }
}
function malformed(): never { throw new ProjectionImageMetadataError("malformed"); }
function mismatch(): never { throw new ProjectionImageMetadataError("scope-mismatch"); }
function numberValue(value: unknown): number {
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return malformed();
}
function bigintValue(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return malformed();
}

/** Copies one exact metadata row; scope checks retain the candidate short circuit order. */
export function readProjectionImageMetadata(database: DatabaseSync, manifest: Manifest): ProjectionImageMetadata {
  const statement = database.prepare(`
    SELECT singleton, schema_version, project_id, vault_id, store_id, workspace_id, branch_scope_id, branch_ref,
           session_id, generation, terminal_event_position, terminal_event_hash FROM projection_metadata LIMIT 2
  `);
  statement.setReadBigInts(true);
  const rows = statement.all();
  if (rows.length !== 1) return malformed();
  const source = rows[0]!;
  if (source.singleton !== 1n || source.schema_version !== BigInt(manifest.schemaVersion)) return malformed();
  if (source.project_id !== manifest.projectId || source.vault_id !== manifest.vaultId
    || source.store_id !== manifest.storeId || source.workspace_id !== manifest.workspaceId
    || source.branch_scope_id !== manifest.branchScopeId || source.branch_ref !== manifest.branchRef
    || source.session_id !== null) return mismatch();
  const generation = numberValue(source.generation);
  if (generation !== manifest.generation) return mismatch();
  const terminalEventPosition = bigintValue(source.terminal_event_position);
  if (terminalEventPosition !== BigInt(manifest.terminalEventPosition) || source.terminal_event_hash !== manifest.terminalEventHash) return mismatch();
  return Object.freeze({ schemaVersion: manifest.schemaVersion, projectId: source.project_id as Manifest["projectId"],
    vaultId: source.vault_id as Manifest["vaultId"], storeId: source.store_id as Manifest["storeId"],
    workspaceId: source.workspace_id as Manifest["workspaceId"], branchScopeId: source.branch_scope_id as Manifest["branchScopeId"],
    branchRef: source.branch_ref as string | null, sessionId: null, generation,
    terminalEventPosition: String(terminalEventPosition), terminalEventHash: source.terminal_event_hash as string });
}
