import {
  createHash,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";
import { canonicalJson } from "../../serialization/canonical-json.js";
import type {
  CapabilityProofV1,
  LifecycleAudience,
} from "../contracts/commands.js";
import { LifecycleError } from "../errors.js";
import type {
  CapabilityKeyProvider,
  CapabilityKind,
} from "./capability-key-provider.js";
import { SecretString } from "./redacted-secret.js";

export const CAPABILITY_MAC_DOMAIN = "pm-lifecycle-capability-v1";
export const CAPABILITY_VERIFIER_DOMAIN = "pm-lifecycle-capability-verifier-v1";
export const PROOF_DOMAIN_TEXT = "pm-lifecycle-command-proof-v1";
export const PROOF_DIGEST_DOMAIN = "project-memory/proof-digest/v1\n";

const PROOF_DOMAIN = Buffer.from(PROOF_DOMAIN_TEXT, "utf8");
const ZERO_SALT = Buffer.alloc(32, 0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_CLAIMS_BYTES = 32_768;
const MAX_CAPABILITY_WIRE_CHARS = 7
  + Math.ceil(256 * 4 / 3)
  + Math.ceil(MAX_CLAIMS_BYTES * 4 / 3)
  + Math.ceil(32 * 4 / 3);
const CLAIM_KEYS = [
  "capabilityVersion",
  "keyId",
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "clientNamespace",
  "sessionId",
  "kind",
  "capabilityGeneration",
  "issuedAt",
  "policyCode",
  "expiryKind",
  "expiresAt",
  "issueNonce",
  "actorRole",
  "clientInstanceId",
] as const;
const SEMANTIC_TARGET_KEYS = [
  "proofVersion",
  "target",
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "clientNamespace",
  "authoritySessionId",
  "targetSessionId",
  "presentingActorRole",
  "presentingClientInstanceId",
  "targetActorRole",
  "targetClientInstanceId",
  "capabilityKind",
  "capabilityGeneration",
  "commandId",
  "idempotencyKey",
  "intentHash",
  "proofNonce",
] as const;
const BOUNDED_TARGET_KEYS = [
  "proofVersion",
  "target",
  "operationType",
  "operationId",
  "requestId",
  "operationHash",
  "authoritySessionId",
  "targetSessionId",
  "presentingActorRole",
  "presentingClientInstanceId",
  "targetActorRole",
  "targetClientInstanceId",
  "capabilityGeneration",
  "proofNonce",
  "expiresAt",
] as const;

export interface CapabilityClaimsV1 {
  readonly capabilityVersion: 1;
  readonly keyId: string;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly clientNamespace: string;
  readonly sessionId: string;
  readonly kind: CapabilityKind;
  readonly capabilityGeneration: string;
  readonly issuedAt: string;
  readonly policyCode: string;
  readonly expiryKind: "until-revoked" | "absolute";
  readonly expiresAt: string | null;
  readonly issueNonce: string;
  readonly actorRole: "primary" | "untrusted";
  readonly clientInstanceId: string | null;
}

export interface CapabilityUseExpectationV1 {
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly clientNamespace: string;
  readonly sessionId: string;
  readonly kind: CapabilityKind;
  readonly capabilityGeneration: string;
  readonly audience: LifecycleAudience;
}

export interface SemanticCommandProofTargetV1 {
  readonly proofVersion: 1;
  readonly target: "semantic-command";
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly clientNamespace: string;
  readonly authoritySessionId: string;
  readonly targetSessionId: string;
  readonly presentingActorRole: "primary" | "maintenance" | "untrusted";
  readonly presentingClientInstanceId: string;
  readonly targetActorRole: "primary" | "maintenance" | "untrusted";
  readonly targetClientInstanceId: string;
  readonly capabilityKind: CapabilityKind;
  readonly capabilityGeneration: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly intentHash: string;
  readonly proofNonce: string;
}

export interface BoundedOperationProofTargetV1 {
  readonly proofVersion: 1;
  readonly target: "bounded-operation";
  readonly operationType: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly operationHash: string;
  readonly authoritySessionId: string;
  readonly targetSessionId: string;
  readonly presentingActorRole: "primary" | "maintenance" | "untrusted";
  readonly presentingClientInstanceId: string;
  readonly targetActorRole: "primary" | "maintenance" | "untrusted";
  readonly targetClientInstanceId: string;
  readonly capabilityGeneration: string;
  readonly proofNonce: string;
  readonly expiresAt: string;
}

export type CapabilityProofTargetV1 =
  | SemanticCommandProofTargetV1
  | BoundedOperationProofTargetV1;

export interface VerifiedCapabilityProofV1 {
  readonly version: 1;
  readonly nonce: string;
  readonly digest: string;
}

interface ParsedCapability {
  readonly claims: CapabilityClaimsV1;
  readonly claimsBytes: Buffer;
  readonly mac: Buffer;
}

function invalid(): never {
  throw new LifecycleError("SESSION_CAPABILITY_INVALID");
}

function keyUnavailable(): never {
  throw new LifecycleError("SESSION_CAPABILITY_KEY_UNAVAILABLE");
}

function expired(): never {
  throw new LifecycleError("SESSION_CAPABILITY_EXPIRED");
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
  }
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = plainRecord(value);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
  return record;
}

function bounded(value: unknown, maximum = 1_024): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= maximum;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string"
    && TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function positiveGeneration(value: unknown): value is string {
  if (typeof value !== "string" || !DECIMAL.test(value)) return false;
  const decoded = BigInt(value);
  return decoded > 0n && decoded <= MAX_INT64;
}

function decodeBase64url(segment: string, maximumBytes: number): Buffer {
  if (segment.length > Math.ceil(maximumBytes * 4 / 3) || !BASE64URL.test(segment)) invalid();
  const decoded = Buffer.from(segment, "base64url");
  if (
    decoded.length === 0
    || decoded.length > maximumBytes
    || decoded.toString("base64url") !== segment
  ) {
    decoded.fill(0);
    invalid();
  }
  return decoded;
}

function utf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid();
  }
}

export function decodeCapabilityClaims(value: unknown): CapabilityClaimsV1 {
  const claims = exactRecord(value, CLAIM_KEYS);
  const kind = claims.kind;
  if (
    claims.capabilityVersion !== 1
    || !bounded(claims.keyId, 256)
    || typeof claims.projectId !== "string" || !UUID.test(claims.projectId)
    || typeof claims.vaultId !== "string" || !UUID.test(claims.vaultId)
    || typeof claims.storeId !== "string" || !UUID.test(claims.storeId)
    || typeof claims.workspaceId !== "string" || !HASH.test(claims.workspaceId)
    || !bounded(claims.clientNamespace, 256)
    || typeof claims.sessionId !== "string" || !UUID.test(claims.sessionId)
    || (kind !== "root-session-handle" && kind !== "root-resume-token" && kind !== "child-session-handle")
    || !positiveGeneration(claims.capabilityGeneration)
    || !timestamp(claims.issuedAt)
    || !bounded(claims.policyCode, 128)
    || (claims.expiryKind !== "until-revoked" && claims.expiryKind !== "absolute")
    || (claims.expiryKind === "until-revoked" && claims.expiresAt !== null)
    || (claims.expiryKind === "absolute" && !timestamp(claims.expiresAt))
    || typeof claims.issueNonce !== "string" || !HASH.test(claims.issueNonce)
  ) invalid();
  if (
    (kind === "root-session-handle" && (
      claims.actorRole !== "primary" || !bounded(claims.clientInstanceId, 256)
    ))
    || (kind === "root-resume-token" && (
      claims.actorRole !== "primary" || claims.clientInstanceId !== null
    ))
    || (kind === "child-session-handle" && (
      claims.actorRole !== "untrusted" || !bounded(claims.clientInstanceId, 256)
    ))
  ) invalid();
  if (
    claims.expiresAt !== null
    && Date.parse(claims.expiresAt as string) <= Date.parse(claims.issuedAt as string)
  ) invalid();
  return Object.freeze({
    capabilityVersion: 1,
    keyId: claims.keyId,
    projectId: claims.projectId,
    vaultId: claims.vaultId,
    storeId: claims.storeId,
    workspaceId: claims.workspaceId,
    clientNamespace: claims.clientNamespace,
    sessionId: claims.sessionId,
    kind,
    capabilityGeneration: claims.capabilityGeneration,
    issuedAt: claims.issuedAt,
    policyCode: claims.policyCode,
    expiryKind: claims.expiryKind,
    expiresAt: claims.expiresAt as string | null,
    issueNonce: claims.issueNonce,
    actorRole: claims.actorRole as "primary" | "untrusted",
    clientInstanceId: claims.clientInstanceId as string | null,
  });
}

function parseCapability(value: string): ParsedCapability {
  if (value.length > MAX_CAPABILITY_WIRE_CHARS) invalid();
  const segments = value.split(".");
  if (segments.length !== 4 || segments[0] !== "pmcap1") invalid();
  let keyIdBytes: Buffer | undefined;
  let claimsBytes: Buffer | undefined;
  let mac: Buffer | undefined;
  try {
    keyIdBytes = decodeBase64url(segments[1]!, 256);
    claimsBytes = decodeBase64url(segments[2]!, MAX_CLAIMS_BYTES);
    mac = decodeBase64url(segments[3]!, 32);
    if (mac.length !== 32) invalid();
    const keyId = utf8(keyIdBytes);
    const claimsText = utf8(claimsBytes);
    const parsed = JSON.parse(claimsText) as unknown;
    if (canonicalJson(parsed) !== claimsText) invalid();
    const claims = decodeCapabilityClaims(parsed);
    if (claims.keyId !== keyId) invalid();
    return { claims, claimsBytes, mac };
  } catch (error) {
    claimsBytes?.fill(0);
    mac?.fill(0);
    if (error instanceof LifecycleError && error.code === "SESSION_CAPABILITY_INVALID") throw error;
    return invalid();
  } finally {
    keyIdBytes?.fill(0);
  }
}

function keyAvailable(provider: CapabilityKeyProvider, claims: CapabilityClaimsV1): void {
  let status: "available" | "revoked" | "unavailable";
  try {
    status = provider.status(
      { projectId: claims.projectId, storeId: claims.storeId },
      claims.kind,
      claims.keyId,
    );
  } catch {
    keyUnavailable();
  }
  if (status !== "available") keyUnavailable();
}

function reconstruct(
  provider: CapabilityKeyProvider,
  claimsInput: CapabilityClaimsV1,
  requireCurrent: boolean,
): SecretString {
  let claims: CapabilityClaimsV1;
  try {
    claims = decodeCapabilityClaims(claimsInput);
  } catch {
    invalid();
  }
  if (requireCurrent) {
    let current: string;
    try {
      current = provider.currentKey(
        { projectId: claims.projectId, storeId: claims.storeId },
        claims.kind,
      ).keyId;
    } catch {
      keyUnavailable();
    }
    if (current !== claims.keyId) keyUnavailable();
  } else {
    keyAvailable(provider, claims);
  }
  const claimsBytes = Buffer.from(canonicalJson(claims), "utf8");
  let mac: Buffer | undefined;
  try {
    const result = provider.mac({
      projectId: claims.projectId,
      storeId: claims.storeId,
      purpose: claims.kind,
      keyId: claims.keyId,
      domain: CAPABILITY_MAC_DOMAIN,
      bytes: claimsBytes,
    });
    mac = Buffer.from(result);
    if (mac.length !== 32) keyUnavailable();
    return SecretString.from(
      `pmcap1.${Buffer.from(claims.keyId, "utf8").toString("base64url")}.${claimsBytes.toString("base64url")}.${mac.toString("base64url")}`,
    );
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    return keyUnavailable();
  } finally {
    claimsBytes.fill(0);
    mac?.fill(0);
  }
}

export function issueCapability(
  provider: CapabilityKeyProvider,
  claims: CapabilityClaimsV1,
): SecretString {
  return reconstruct(provider, claims, true);
}

export function reconstructCapability(
  provider: CapabilityKeyProvider,
  claims: CapabilityClaimsV1,
): SecretString {
  return reconstruct(provider, claims, false);
}

function assertUse(claims: CapabilityClaimsV1, expected: CapabilityUseExpectationV1): void {
  const audience = expected.audience;
  if (
    claims.projectId !== expected.projectId
    || claims.vaultId !== expected.vaultId
    || claims.storeId !== expected.storeId
    || claims.workspaceId !== expected.workspaceId
    || claims.clientNamespace !== expected.clientNamespace
    || claims.sessionId !== expected.sessionId
    || claims.kind !== expected.kind
    || claims.capabilityGeneration !== expected.capabilityGeneration
  ) invalid();
  switch (claims.kind) {
    case "root-session-handle":
      if (
        audience.presentingActorRole !== "primary"
        || audience.presentingClientInstanceId !== claims.clientInstanceId
      ) invalid();
      return;
    case "root-resume-token":
      if (
        audience.presentingActorRole !== "primary"
        || audience.targetActorRole !== "primary"
        || audience.presentingClientInstanceId !== audience.targetClientInstanceId
      ) invalid();
      return;
    case "child-session-handle":
      if (
        audience.presentingActorRole !== "untrusted"
        || audience.targetActorRole !== "untrusted"
        || audience.presentingClientInstanceId !== claims.clientInstanceId
        || audience.targetClientInstanceId !== claims.clientInstanceId
      ) invalid();
  }
}

export function verifyCapability(
  provider: CapabilityKeyProvider,
  bearer: SecretString,
  expected: CapabilityUseExpectationV1,
  nowMs: bigint,
): CapabilityClaimsV1 {
  return bearer.withValue((value) => {
    let parsed: ParsedCapability;
    try {
      parsed = parseCapability(value);
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      return invalid();
    }
    try {
      keyAvailable(provider, parsed.claims);
      let verified = false;
      try {
        verified = provider.verify({
          projectId: parsed.claims.projectId,
          storeId: parsed.claims.storeId,
          purpose: parsed.claims.kind,
          keyId: parsed.claims.keyId,
          domain: CAPABILITY_MAC_DOMAIN,
          bytes: parsed.claimsBytes,
          mac: parsed.mac,
        });
      } catch {
        invalid();
      }
      if (!verified) invalid();
      assertUse(parsed.claims, expected);
      if (
        parsed.claims.expiresAt !== null
        && nowMs >= BigInt(Date.parse(parsed.claims.expiresAt))
      ) expired();
      return parsed.claims;
    } finally {
      parsed.claimsBytes.fill(0);
      parsed.mac.fill(0);
    }
  });
}

export function proofKey(bearer: string): Buffer {
  const bearerBytes = Buffer.from(bearer, "utf8");
  try {
    return Buffer.from(hkdfSync(
      "sha256",
      bearerBytes,
      ZERO_SALT,
      PROOF_DOMAIN,
      32,
    ));
  } finally {
    bearerBytes.fill(0);
  }
}

function role(value: unknown): value is "primary" | "maintenance" | "untrusted" {
  return value === "primary" || value === "maintenance" || value === "untrusted";
}

export function decodeCapabilityProofTarget(value: unknown): CapabilityProofTargetV1 {
  const source = plainRecord(value);
  const record = exactRecord(
    source,
    source.target === "semantic-command" ? SEMANTIC_TARGET_KEYS : BOUNDED_TARGET_KEYS,
  );
  if (
    record.proofVersion !== 1
    || (record.target !== "semantic-command" && record.target !== "bounded-operation")
    || typeof record.authoritySessionId !== "string" || !UUID.test(record.authoritySessionId)
    || typeof record.targetSessionId !== "string" || !UUID.test(record.targetSessionId)
    || !role(record.presentingActorRole)
    || !bounded(record.presentingClientInstanceId, 256)
    || !role(record.targetActorRole)
    || !bounded(record.targetClientInstanceId, 256)
    || !positiveGeneration(record.capabilityGeneration)
    || typeof record.proofNonce !== "string" || !UUID.test(record.proofNonce)
  ) invalid();
  if (record.target === "semantic-command") {
    if (
      typeof record.projectId !== "string" || !UUID.test(record.projectId)
      || typeof record.vaultId !== "string" || !UUID.test(record.vaultId)
      || typeof record.storeId !== "string" || !UUID.test(record.storeId)
      || typeof record.workspaceId !== "string" || !HASH.test(record.workspaceId)
      || !bounded(record.clientNamespace, 256)
      || !CAPABILITY_KINDS.has(record.capabilityKind as CapabilityKind)
      || typeof record.commandId !== "string" || !UUID.test(record.commandId)
      || !bounded(record.idempotencyKey, 512)
      || typeof record.intentHash !== "string" || !HASH.test(record.intentHash)
    ) invalid();
  } else if (
    !bounded(record.operationType, 128)
    || typeof record.operationId !== "string" || !UUID.test(record.operationId)
    || typeof record.requestId !== "string" || !UUID.test(record.requestId)
    || typeof record.operationHash !== "string" || !HASH.test(record.operationHash)
    || !timestamp(record.expiresAt)
  ) invalid();
  return Object.freeze({ ...record }) as unknown as CapabilityProofTargetV1;
}

const CAPABILITY_KINDS = new Set<CapabilityKind>([
  "root-session-handle",
  "root-resume-token",
  "child-session-handle",
]);

export function capabilityProofMac(
  bearer: SecretString,
  target: CapabilityProofTargetV1,
): Buffer {
  const canonicalTarget = decodeCapabilityProofTarget(target);
  return bearer.withValue((value) => {
    const key = proofKey(value);
    const targetBytes = Buffer.from(canonicalJson(canonicalTarget), "utf8");
    try {
      return createHmac("sha256", key)
        .update(PROOF_DOMAIN)
        .update(targetBytes)
        .digest();
    } finally {
      key.fill(0);
      targetBytes.fill(0);
    }
  });
}

export function capabilityProofDigest(mac: Uint8Array): string {
  return createHash("sha256")
    .update(PROOF_DIGEST_DOMAIN, "utf8")
    .update(mac)
    .digest("hex");
}

export function createCapabilityProof(
  bearer: SecretString,
  target: CapabilityProofTargetV1,
): CapabilityProofV1 {
  const mac = capabilityProofMac(bearer, target);
  try {
    return Object.freeze({
      proofVersion: 1,
      target: target.target,
      proofNonce: target.proofNonce,
      proofFingerprint: mac.toString("hex"),
    });
  } finally {
    mac.fill(0);
  }
}

export function verifyCapabilityProof(
  bearer: SecretString,
  target: CapabilityProofTargetV1,
  proofInput: CapabilityProofV1,
): VerifiedCapabilityProofV1 {
  const proof = exactRecord(
    proofInput,
    ["proofVersion", "target", "proofNonce", "proofFingerprint"],
  );
  if (
    proof.proofVersion !== 1
    || proof.target !== target.target
    || proof.proofNonce !== target.proofNonce
    || typeof proof.proofNonce !== "string" || !UUID.test(proof.proofNonce)
    || typeof proof.proofFingerprint !== "string" || !HASH.test(proof.proofFingerprint)
  ) invalid();
  const actual = capabilityProofMac(bearer, target);
  const expected = Buffer.from(proof.proofFingerprint, "hex");
  try {
    if (expected.length !== 32 || !timingSafeEqual(actual, expected)) invalid();
    return Object.freeze({
      version: 1,
      nonce: proof.proofNonce,
      digest: capabilityProofDigest(actual),
    });
  } finally {
    actual.fill(0);
    expected.fill(0);
  }
}

export function capabilityVerifier(
  provider: CapabilityKeyProvider,
  bearer: SecretString,
  claims: CapabilityClaimsV1,
): string {
  return bearer.withValue((value) => {
    const bytes = Buffer.from(value, "utf8");
    try {
      const fingerprint = provider.fingerprint({
        projectId: claims.projectId,
        storeId: claims.storeId,
        purpose: claims.kind,
        keyId: claims.keyId,
        domain: CAPABILITY_VERIFIER_DOMAIN,
        bytes,
      });
      if (!HASH.test(fingerprint)) keyUnavailable();
      return fingerprint;
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      return keyUnavailable();
    } finally {
      bytes.fill(0);
    }
  });
}
