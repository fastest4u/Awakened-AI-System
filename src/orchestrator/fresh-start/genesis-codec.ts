import type { ProjectId, StoreId, VaultId } from "../identity/contracts.js";
import type { FreshStartGenesis, FreshStartIdentity, FreshStartGenesisV1, FreshStartGenesisV2, StoredGenesisChecksumsV2 } from "./contracts.js";
import { PROJECTION_NAMES_V2, PROJECTION_NAMES_V3, projectionCoreChecksum, type ProjectionNameV2, type ProjectionNameV3 } from "../projections/checksum.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-chain-constants.js";

export type FreshStartErrorCode =
  | "FRESH_START_CONFIG_INVALID"
  | "FRESH_START_INPUT_INVALID" | "FRESH_START_IDENTITY_MISMATCH"
  | "FRESH_START_RELEASE_MISMATCH" | "FRESH_START_ALREADY_INITIALIZED"
  | "FRESH_START_NOT_INITIALIZED" | "FRESH_START_STALE_STATE"
  | "FRESH_START_APPROVAL_REUSED" | "FRESH_START_TRANSACTION_CLOSED"
  | "FRESH_START_TRANSACTION_REENTRANT" | "FRESH_START_ASYNC_TRANSACTION"
  | "FRESH_START_STORAGE_FAILURE" | "FRESH_START_PATH_OVERLAP"
  | "FRESH_START_PATH_INVALID" | "FRESH_START_PATH_CHANGED"
  | "FRESH_START_RECOVERY_REQUIRED" | "FRESH_START_DESTINATION_NOT_EMPTY"
  | "FRESH_START_JOURNAL_MISMATCH" | "FRESH_START_INITIALIZATION_BUSY"
  | "FRESH_START_PREPARATION_REQUIRED" | "FRESH_START_RELEASE_NOT_READY"
  | "FRESH_START_EDGE_FORBIDDEN" | "FRESH_START_APPROVAL_INVALID"
  | "FRESH_START_APPROVAL_BINDING_MISMATCH" | "FRESH_START_EVIDENCE_INVALID"
  | "FRESH_START_EVIDENCE_BINDING_MISMATCH"
  | "FRESH_START_CONTEXT_REQUIRED" | "FRESH_START_BUILD_MISMATCH" | "FRESH_START_SCHEMA_MISMATCH"
  | "FRESH_START_ADMISSION_STALE" | "FRESH_START_ADMISSION_DENIED" | "FRESH_START_CONTENT_UNVERIFIED"
  | "FRESH_START_CAPABILITY_UNAVAILABLE" | "FRESH_START_OPERATOR_ONLY_TOOL" | "FRESH_START_RECOVERY_CORRUPT";

export class FreshStartError extends Error {
  constructor(readonly code: FreshStartErrorCode) {
    super(code);
    this.name = "FreshStartError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function invalid(): never { throw new FreshStartError("FRESH_START_INPUT_INVALID"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) invalid();
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return invalid();
  }
}
function uuid(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) invalid(); return value; }
function hash(value: unknown): string { if (typeof value !== "string" || !HASH.test(value)) invalid(); return value; }
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function identity(value: Record<string, unknown>): FreshStartIdentity {
  return { projectId: uuid(value.projectId) as ProjectId, vaultId: uuid(value.vaultId) as VaultId, storeId: uuid(value.storeId) as StoreId };
}

/** Internal shared fresh-start validation policy; contracts consumes these without a runtime back-reference. */
export {
  invalid as invalidFreshStartInput, record as exactFreshStartRecord,
  uuid as freshStartUuid, hash as freshStartHash,
  timestamp as freshStartTimestamp, identity as freshStartIdentity,
};

const GENESIS_KEYS = ["projectId", "vaultId", "storeId", "initializationId", "releaseId", "semanticPosition", "terminalHash", "projectionChecksums", "preparationIntentDigest", "actorFingerprint", "createdAt"];
const GENESIS_V2_KEYS = [...GENESIS_KEYS, "genesisVersion", "projectionSchemaVersion"];
const ENVELOPE_KEYS = ["genesisVersion", "projectionSchemaVersion", "projectionChecksums"];

/** Select only an owned data discriminator; absence of both alone means legacy. */
function profile(value: unknown): 1 | 2 {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
    const version = Object.getOwnPropertyDescriptor(value, "genesisVersion");
    const schema = Object.getOwnPropertyDescriptor(value, "projectionSchemaVersion");
    if (version === undefined && schema === undefined) return 1;
    if (!version || !schema || !version.enumerable || !schema.enumerable
      || !("value" in version) || !("value" in schema) || version.value !== 2 || schema.value !== 3) invalid();
    return 2;
  } catch { return invalid(); }
}
function checksums<T extends ProjectionNameV3>(value: unknown, names: readonly T[]): Readonly<Record<T, string>> {
  const source = record(value, names), owned = {} as Record<T, string>;
  for (const name of names) owned[name] = hash(source[name]);
  return Object.freeze(owned);
}
export function decodeFreshStartGenesis(value: unknown): FreshStartGenesis {
  const version = profile(value);
  const source = record(value, version === 1 ? GENESIS_KEYS : GENESIS_V2_KEYS);
  // Validate the captured discriminator too: proxy descriptors cannot switch the selected profile.
  if (version === 2 && (source.genesisVersion !== 2 || source.projectionSchemaVersion !== 3)) invalid();
  const decodedIdentity = identity(source);
  if (source.semanticPosition !== "0" || source.terminalHash !== GENESIS_GLOBAL_HASH) invalid();
  const names = version === 1 ? PROJECTION_NAMES_V2 : PROJECTION_NAMES_V3;
  const projectionChecksums = checksums(source.projectionChecksums, names);
  for (const name of names) {
    if (projectionChecksums[name] !== projectionCoreChecksum(name, version === 1 ? 2 : 3, decodedIdentity.projectId, 0n, [])) invalid();
  }
  const common = { ...decodedIdentity, initializationId: uuid(source.initializationId),
    releaseId: uuid(source.releaseId), semanticPosition: "0" as const, terminalHash: GENESIS_GLOBAL_HASH,
    projectionChecksums, preparationIntentDigest: hash(source.preparationIntentDigest),
    actorFingerprint: hash(source.actorFingerprint), createdAt: timestamp(source.createdAt) };
  return version === 1 ? Object.freeze(common) as FreshStartGenesisV1
    : Object.freeze({ ...common, genesisVersion: 2, projectionSchemaVersion: 3 }) as FreshStartGenesisV2;
}

export function decodeStoredGenesisChecksums(text: string): Readonly<{
  genesisVersion: 1; projectionSchemaVersion: 2; projectionChecksums: Readonly<Record<ProjectionNameV2, string>>;
}> | StoredGenesisChecksumsV2 {
  try {
    if (typeof text !== "string") invalid();
    const value: unknown = JSON.parse(text);
    if (profile(value) === 1) return Object.freeze({ genesisVersion: 1, projectionSchemaVersion: 2,
      projectionChecksums: checksums(value, PROJECTION_NAMES_V2) });
    const source = record(value, ENVELOPE_KEYS);
    return Object.freeze({ genesisVersion: 2, projectionSchemaVersion: 3,
      projectionChecksums: checksums(source.projectionChecksums, PROJECTION_NAMES_V3) });
  } catch { return invalid(); }
}

export function encodeStoredGenesisChecksums(value: FreshStartGenesis): string {
  const genesis = decodeFreshStartGenesis(value);
  return JSON.stringify("genesisVersion" in genesis ? { genesisVersion: 2, projectionSchemaVersion: 3,
    projectionChecksums: genesis.projectionChecksums } : genesis.projectionChecksums);
}
