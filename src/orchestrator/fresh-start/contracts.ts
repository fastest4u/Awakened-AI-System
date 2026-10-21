import type { ProjectId, StoreId, VaultId } from "../identity/contracts.js";
import type { ProjectionNameV2, ProjectionNameV3 } from "../projections/checksum.js";
import {
  invalidFreshStartInput as invalid, exactFreshStartRecord as record,
  freshStartUuid as uuid, freshStartHash as hash,
  freshStartTimestamp as timestamp, freshStartIdentity as identity,
} from "./genesis-codec.js";
export { FreshStartError, decodeFreshStartGenesis, type FreshStartErrorCode } from "./genesis-codec.js";

export type FreshStartMode = "prepared" | "active" | "read-only-recovery" | "disabled";
export type FreshStartIdentity = Readonly<{ projectId: ProjectId; vaultId: VaultId; storeId: StoreId }>;
export type FreshStartRelease = FreshStartIdentity & Readonly<{
  profileVersion: 1; releaseId: string; buildIdentityHash: string;
  schemaIdentityHash: string; configurationHash: string;
  capabilityManifestHash: string; recoveryPolicyHash: string;
  evidenceDigest: string; createdAt: string;
}>;
export type FreshStartGenesisV1 = FreshStartIdentity & Readonly<{
  initializationId: string; releaseId: string; semanticPosition: "0";
  terminalHash: string; projectionChecksums: Readonly<Record<ProjectionNameV2, string>>;
  preparationIntentDigest: string; actorFingerprint: string; createdAt: string;
}>;
export type FreshStartGenesisV2 = Omit<FreshStartGenesisV1, "projectionChecksums"> & Readonly<{
  genesisVersion: 2; projectionSchemaVersion: 3;
  projectionChecksums: Readonly<Record<ProjectionNameV3, string>>;
}>;
export type StoredGenesisChecksumsV2 = Readonly<{
  genesisVersion: 2; projectionSchemaVersion: 3;
  projectionChecksums: Readonly<Record<ProjectionNameV3, string>>;
}>;
export type FreshStartGenesis = FreshStartGenesisV1 | FreshStartGenesisV2;
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

/** Internal server API only: operator envelopes are never public MCP arguments. */
export type FreshStartTransitionRequest = Readonly<{
  identity: FreshStartIdentity; expectedGeneration: bigint; expectedMode: FreshStartMode;
  expectedReleaseId: string; nextMode: FreshStartMode; nextRelease: FreshStartRelease;
  approvalEnvelope: Uint8Array;
}>;
export type FreshStartAutomaticStop = Readonly<{
  identity: FreshStartIdentity; expectedGeneration: bigint; target: "read-only-recovery" | "disabled";
  reasonCode: Extract<FreshStartAuthorization, { kind: "automatic-stop" }>["reasonCode"];
}>;

export const FRESH_START_MAX_GENERATION = 9_223_372_036_854_775_807n;

const RELEASE_KEYS = ["projectId", "vaultId", "storeId", "profileVersion", "releaseId", "buildIdentityHash", "schemaIdentityHash", "configurationHash", "capabilityManifestHash", "recoveryPolicyHash", "evidenceDigest", "createdAt"];

export function decodeFreshStartRelease(value: unknown): FreshStartRelease {
  const source = record(value, RELEASE_KEYS);
  if (source.profileVersion !== 1) invalid();
  return Object.freeze({ ...identity(source), profileVersion: 1, releaseId: uuid(source.releaseId),
    buildIdentityHash: hash(source.buildIdentityHash), schemaIdentityHash: hash(source.schemaIdentityHash),
    configurationHash: hash(source.configurationHash), capabilityManifestHash: hash(source.capabilityManifestHash),
    recoveryPolicyHash: hash(source.recoveryPolicyHash), evidenceDigest: hash(source.evidenceDigest),
    createdAt: timestamp(source.createdAt) });
}

export function decodeFreshStartIdentity(value: unknown): FreshStartIdentity {
  return Object.freeze(identity(record(value, ["projectId", "vaultId", "storeId"])));
}

function generation(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= FRESH_START_MAX_GENERATION) invalid();
  return value;
}
function mode(value: unknown): FreshStartMode {
  if (!["prepared", "active", "read-only-recovery", "disabled"].includes(value as string)) invalid();
  return value as FreshStartMode;
}
export function decodeFreshStartTransitionRequest(value: unknown): FreshStartTransitionRequest {
  const source = record(value, ["identity", "expectedGeneration", "expectedMode", "expectedReleaseId", "nextMode", "nextRelease", "approvalEnvelope"]);
  const bytes = source.approvalEnvelope;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 65_536
    || bytes.buffer instanceof SharedArrayBuffer) invalid();
  return Object.freeze({ identity: decodeFreshStartIdentity(source.identity),
    expectedGeneration: generation(source.expectedGeneration), expectedMode: mode(source.expectedMode),
    expectedReleaseId: uuid(source.expectedReleaseId), nextMode: mode(source.nextMode),
    nextRelease: decodeFreshStartRelease(source.nextRelease), approvalEnvelope: new Uint8Array(bytes) });
}
export function decodeFreshStartAutomaticStop(value: unknown): FreshStartAutomaticStop {
  const source = record(value, ["identity", "expectedGeneration", "target", "reasonCode"]);
  if (source.target !== "disabled" && source.target !== "read-only-recovery") invalid();
  if (!["integrity-failure", "privacy-failure", "binding-failure", "recovery-failure"].includes(source.reasonCode as string)) invalid();
  return Object.freeze({ identity: decodeFreshStartIdentity(source.identity), expectedGeneration: generation(source.expectedGeneration),
    target: source.target, reasonCode: source.reasonCode as FreshStartAutomaticStop["reasonCode"] });
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
