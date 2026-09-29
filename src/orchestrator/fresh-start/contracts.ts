import type { ProjectId, StoreId, VaultId } from "../identity/contracts.js";
import { PROJECTION_NAMES, projectionCoreChecksum } from "../projections/checksum.js";
import { PROJECTION_SCHEMA_VERSION } from "../projections/schema.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-append-transaction.js";

export type FreshStartMode = "prepared" | "active" | "read-only-recovery" | "disabled";
export type FreshStartIdentity = Readonly<{ projectId: ProjectId; vaultId: VaultId; storeId: StoreId }>;
export type FreshStartRelease = FreshStartIdentity & Readonly<{
  profileVersion: 1; releaseId: string; buildIdentityHash: string;
  schemaIdentityHash: string; configurationHash: string;
  capabilityManifestHash: string; recoveryPolicyHash: string;
  evidenceDigest: string; createdAt: string;
}>;
export type FreshStartGenesis = FreshStartIdentity & Readonly<{
  initializationId: string; releaseId: string; semanticPosition: "0";
  terminalHash: string; projectionChecksums: Readonly<Record<string, string>>;
  preparationIntentDigest: string; actorFingerprint: string; createdAt: string;
}>;
export type FreshStartState = FreshStartIdentity & Readonly<{
  releaseId: string; mode: FreshStartMode; generation: bigint;
  recoveryPosition: bigint | null; recoveryHash: string | null;
  lastTransitionId: string | null; updatedAt: string;
}>;
export type FreshStartAuthorization = Readonly<{
  kind: "operator"; approvalId: string; nonceDigest: string;
  actorFingerprint: string; requestDigest: string;
}> | Readonly<{
  kind: "automatic-stop";
  reasonCode: "integrity-failure" | "privacy-failure" | "binding-failure" | "recovery-failure";
}>;
export type FreshStartStateChange = Readonly<{
  expectedMode: FreshStartMode; expectedGeneration: bigint; expectedReleaseId: string;
  nextMode: FreshStartMode; nextReleaseId: string; transitionId: string;
  authorization: FreshStartAuthorization; evidenceDigest: string;
  recoveryPosition: bigint | null; recoveryHash: string | null; recordedAt: string;
}>;

export type FreshStartErrorCode =
  | "FRESH_START_INPUT_INVALID" | "FRESH_START_IDENTITY_MISMATCH"
  | "FRESH_START_RELEASE_MISMATCH" | "FRESH_START_ALREADY_INITIALIZED"
  | "FRESH_START_NOT_INITIALIZED" | "FRESH_START_STALE_STATE"
  | "FRESH_START_APPROVAL_REUSED" | "FRESH_START_TRANSACTION_CLOSED"
  | "FRESH_START_TRANSACTION_REENTRANT" | "FRESH_START_ASYNC_TRANSACTION"
  | "FRESH_START_STORAGE_FAILURE" | "FRESH_START_PATH_OVERLAP"
  | "FRESH_START_PATH_INVALID" | "FRESH_START_PATH_CHANGED"
  | "FRESH_START_RECOVERY_REQUIRED" | "FRESH_START_DESTINATION_NOT_EMPTY"
  | "FRESH_START_JOURNAL_MISMATCH" | "FRESH_START_INITIALIZATION_BUSY"
  | "FRESH_START_PREPARATION_REQUIRED";

export class FreshStartError extends Error {
  constructor(readonly code: FreshStartErrorCode) {
    super(code);
    this.name = "FreshStartError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export const FRESH_START_MAX_GENERATION = 9_223_372_036_854_775_807n;

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

const RELEASE_KEYS = ["projectId", "vaultId", "storeId", "profileVersion", "releaseId", "buildIdentityHash", "schemaIdentityHash", "configurationHash", "capabilityManifestHash", "recoveryPolicyHash", "evidenceDigest", "createdAt"];
const GENESIS_KEYS = ["projectId", "vaultId", "storeId", "initializationId", "releaseId", "semanticPosition", "terminalHash", "projectionChecksums", "preparationIntentDigest", "actorFingerprint", "createdAt"];

export function decodeFreshStartRelease(value: unknown): FreshStartRelease {
  const source = record(value, RELEASE_KEYS);
  if (source.profileVersion !== 1) invalid();
  return Object.freeze({ ...identity(source), profileVersion: 1, releaseId: uuid(source.releaseId),
    buildIdentityHash: hash(source.buildIdentityHash), schemaIdentityHash: hash(source.schemaIdentityHash),
    configurationHash: hash(source.configurationHash), capabilityManifestHash: hash(source.capabilityManifestHash),
    recoveryPolicyHash: hash(source.recoveryPolicyHash), evidenceDigest: hash(source.evidenceDigest),
    createdAt: timestamp(source.createdAt) });
}

export function decodeFreshStartGenesis(value: unknown): FreshStartGenesis {
  const source = record(value, GENESIS_KEYS);
  const decodedIdentity = identity(source);
  if (source.semanticPosition !== "0" || source.terminalHash !== GENESIS_GLOBAL_HASH) invalid();
  const checksumSource = record(source.projectionChecksums, PROJECTION_NAMES);
  const projectionChecksums: Record<string, string> = {};
  for (const name of PROJECTION_NAMES) {
    const checksum = hash(checksumSource[name]);
    if (checksum !== projectionCoreChecksum(name, PROJECTION_SCHEMA_VERSION, decodedIdentity.projectId, 0n, [])) invalid();
    projectionChecksums[name] = checksum;
  }
  return Object.freeze({ ...decodedIdentity, initializationId: uuid(source.initializationId),
    releaseId: uuid(source.releaseId), semanticPosition: "0", terminalHash: GENESIS_GLOBAL_HASH,
    projectionChecksums: Object.freeze(projectionChecksums),
    preparationIntentDigest: hash(source.preparationIntentDigest), actorFingerprint: hash(source.actorFingerprint),
    createdAt: timestamp(source.createdAt) });
}

export function decodeFreshStartIdentity(value: unknown): FreshStartIdentity {
  return Object.freeze(identity(record(value, ["projectId", "vaultId", "storeId"])));
}

export function decodeFreshStartStateChange(value: unknown): FreshStartStateChange {
  const source = record(value, ["expectedMode", "expectedGeneration", "expectedReleaseId", "nextMode", "nextReleaseId", "transitionId", "authorization", "evidenceDigest", "recoveryPosition", "recoveryHash", "recordedAt"]);
  const modes = ["prepared", "active", "read-only-recovery", "disabled"];
  if (!modes.includes(source.expectedMode as string) || !modes.includes(source.nextMode as string)
    || typeof source.expectedGeneration !== "bigint" || source.expectedGeneration < 0n || source.expectedGeneration >= FRESH_START_MAX_GENERATION) invalid();
  if (source.recoveryPosition !== null && (typeof source.recoveryPosition !== "bigint" || source.recoveryPosition < 0n || source.recoveryPosition > FRESH_START_MAX_GENERATION)) invalid();
  if ((source.recoveryPosition === null) !== (source.recoveryHash === null)) invalid();
  const auth = source.authorization;
  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) invalid();
  let kind: PropertyDescriptor | undefined;
  try { kind = Object.getOwnPropertyDescriptor(auth, "kind"); }
  catch { invalid(); }
  if (!kind || !("value" in kind)) invalid();
  let authorization: FreshStartAuthorization;
  if (kind.value === "operator") {
    const item = record(auth, ["kind", "approvalId", "nonceDigest", "actorFingerprint", "requestDigest"]);
    authorization = Object.freeze({ kind: "operator", approvalId: uuid(item.approvalId), nonceDigest: hash(item.nonceDigest), actorFingerprint: hash(item.actorFingerprint), requestDigest: hash(item.requestDigest) });
  } else if (kind.value === "automatic-stop") {
    const item = record(auth, ["kind", "reasonCode"]);
    if (!["integrity-failure", "privacy-failure", "binding-failure", "recovery-failure"].includes(item.reasonCode as string)) invalid();
    authorization = Object.freeze({ kind: "automatic-stop", reasonCode: item.reasonCode as Extract<FreshStartAuthorization, { kind: "automatic-stop" }>["reasonCode"] });
  } else invalid();
  return Object.freeze({ expectedMode: source.expectedMode as FreshStartMode,
    expectedGeneration: source.expectedGeneration, expectedReleaseId: uuid(source.expectedReleaseId),
    nextMode: source.nextMode as FreshStartMode, nextReleaseId: uuid(source.nextReleaseId),
    transitionId: uuid(source.transitionId), authorization, evidenceDigest: hash(source.evidenceDigest),
    recoveryPosition: source.recoveryPosition as bigint | null,
    recoveryHash: source.recoveryHash === null ? null : hash(source.recoveryHash), recordedAt: timestamp(source.recordedAt) });
}
