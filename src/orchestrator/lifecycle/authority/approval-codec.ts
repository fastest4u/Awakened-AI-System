import { createHash } from "node:crypto";
import { canonicalJson } from "../../serialization/canonical-json.js";
import type { RedactedLifecycleApproval } from "../contracts/commands.js";
import { LifecycleError } from "../errors.js";
import type {
  CapabilityKeyProvider,
  CapabilityKeyPurpose,
} from "./capability-key-provider.js";
import { SecretString } from "./redacted-secret.js";

export const RECOVERY_APPROVAL_DOMAIN = "pm-lifecycle-recovery-approval-v1";
export const ABANDONMENT_APPROVAL_DOMAIN = "pm-lifecycle-abandonment-approval-v1";
export const MAX_APPROVAL_LIFETIME_MS = 600_000n;

const RECOVERY_DIGEST_DOMAIN = "project-memory/recovery-approval-digest/v1\n";
const ABANDONMENT_DIGEST_DOMAIN = "project-memory/abandonment-approval-digest/v1\n";
const NONCE_DIGEST_DOMAIN = "project-memory/approval-nonce-digest/v1\n";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_CLAIMS_BYTES = 32_768;
const MAX_APPROVAL_WIRE_CHARS = 7
  + Math.ceil(256 * 4 / 3)
  + Math.ceil(MAX_CLAIMS_BYTES * 4 / 3)
  + Math.ceil(32 * 4 / 3);
const REASON_CODES = new Set([
  "explicit-user-approval",
  "credential-loss",
  "suspected-compromise",
  "irrecoverable-session",
]);
const CLAIM_KEYS = [
  "approvalVersion",
  "approvalId",
  "keyId",
  "action",
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "sessionId",
  "expectedOwnerGeneration",
  "commandId",
  "idempotencyKey",
  "intentHash",
  "executorActorRole",
  "executorClientInstanceId",
  "targetActorRole",
  "targetClientInstanceId",
  "issuedAt",
  "expiresAt",
  "approvalNonce",
  "reasonCode",
  "redactedApprovalReference",
] as const;

interface ApprovalClaimsBaseV1 {
  readonly approvalVersion: 1;
  readonly approvalId: string;
  readonly keyId: string;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly expectedOwnerGeneration: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly intentHash: string;
  readonly executorActorRole: "primary" | "maintenance";
  readonly executorClientInstanceId: string;
  readonly targetActorRole: "primary";
  readonly targetClientInstanceId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly approvalNonce: string;
  readonly reasonCode: string;
  readonly redactedApprovalReference: string;
}

export interface RecoveryApprovalClaimsV1 extends ApprovalClaimsBaseV1 {
  readonly action: "recover-root-authority";
}

export interface AbandonmentApprovalClaimsV1 extends ApprovalClaimsBaseV1 {
  readonly action: "abandon-root";
  readonly executorActorRole: "primary";
}

export type LifecycleApprovalClaimsV1 =
  | RecoveryApprovalClaimsV1
  | AbandonmentApprovalClaimsV1;

export interface ApprovalVerificationExpectationV1 {
  readonly action: "recover-root-authority" | "abandon-root";
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly expectedOwnerGeneration: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly intentHash: string;
  readonly executorActorRole: "primary" | "maintenance";
  readonly executorClientInstanceId: string;
  readonly targetActorRole: "primary";
  readonly targetClientInstanceId: string;
}

export interface VerifiedLifecycleApprovalV1<T extends LifecycleApprovalClaimsV1> {
  readonly claims: T;
  readonly redacted: RedactedLifecycleApproval;
  readonly approvalDigest: string;
  readonly nonceDigest: string;
}

interface ParsedApproval {
  readonly claims: LifecycleApprovalClaimsV1;
  readonly claimsBytes: Buffer;
  readonly mac: Buffer;
}

interface ApprovalProfile {
  readonly action: LifecycleApprovalClaimsV1["action"];
  readonly purpose: Extract<CapabilityKeyPurpose, "recovery-approval" | "abandonment-approval">;
  readonly domain: string;
  readonly digestDomain: string;
}

const RECOVERY_PROFILE: ApprovalProfile = {
  action: "recover-root-authority",
  purpose: "recovery-approval",
  domain: RECOVERY_APPROVAL_DOMAIN,
  digestDomain: RECOVERY_DIGEST_DOMAIN,
};
const ABANDONMENT_PROFILE: ApprovalProfile = {
  action: "abandon-root",
  purpose: "abandonment-approval",
  domain: ABANDONMENT_APPROVAL_DOMAIN,
  digestDomain: ABANDONMENT_DIGEST_DOMAIN,
};

function invalid(): never {
  throw new LifecycleError("LIFECYCLE_APPROVAL_INVALID");
}

function expired(): never {
  throw new LifecycleError("LIFECYCLE_APPROVAL_EXPIRED");
}

function keyUnavailable(): never {
  throw new LifecycleError("SESSION_CAPABILITY_KEY_UNAVAILABLE");
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

function exactRecord(value: unknown): Record<string, unknown> {
  const record = plainRecord(value);
  const actual = Object.keys(record).sort();
  const expected = [...CLAIM_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
  return record;
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= maximum;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string"
    && TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function generation(value: unknown): value is string {
  if (typeof value !== "string" || !DECIMAL.test(value)) return false;
  const decoded = BigInt(value);
  return decoded > 0n && decoded <= MAX_INT64;
}

function decodeBase64url(segment: string, maximumBytes: number): Buffer {
  if (segment.length > Math.ceil(maximumBytes * 4 / 3) || !BASE64URL.test(segment)) invalid();
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.length === 0 || decoded.length > maximumBytes || decoded.toString("base64url") !== segment) {
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

function decodeClaims(value: unknown): LifecycleApprovalClaimsV1 {
  const claims = exactRecord(value);
  if (
    claims.approvalVersion !== 1
    || typeof claims.approvalId !== "string" || !UUID.test(claims.approvalId)
    || !bounded(claims.keyId, 256)
    || (claims.action !== "recover-root-authority" && claims.action !== "abandon-root")
    || typeof claims.projectId !== "string" || !UUID.test(claims.projectId)
    || typeof claims.vaultId !== "string" || !UUID.test(claims.vaultId)
    || typeof claims.storeId !== "string" || !UUID.test(claims.storeId)
    || typeof claims.workspaceId !== "string" || !HASH.test(claims.workspaceId)
    || typeof claims.sessionId !== "string" || !UUID.test(claims.sessionId)
    || !generation(claims.expectedOwnerGeneration)
    || typeof claims.commandId !== "string" || !UUID.test(claims.commandId)
    || !bounded(claims.idempotencyKey, 512)
    || typeof claims.intentHash !== "string" || !HASH.test(claims.intentHash)
    || (claims.executorActorRole !== "primary" && claims.executorActorRole !== "maintenance")
    || !bounded(claims.executorClientInstanceId, 256)
    || claims.targetActorRole !== "primary"
    || !bounded(claims.targetClientInstanceId, 256)
    || !timestamp(claims.issuedAt)
    || !timestamp(claims.expiresAt)
    || typeof claims.approvalNonce !== "string" || !HASH.test(claims.approvalNonce)
    || typeof claims.reasonCode !== "string" || !REASON_CODES.has(claims.reasonCode)
    || !bounded(claims.redactedApprovalReference, 512)
  ) invalid();
  const lifetime = BigInt(Date.parse(claims.expiresAt as string))
    - BigInt(Date.parse(claims.issuedAt as string));
  if (lifetime <= 0n || lifetime > MAX_APPROVAL_LIFETIME_MS) invalid();
  if (
    claims.action === "abandon-root"
    && (
      claims.executorActorRole !== "primary"
      || claims.executorClientInstanceId !== claims.targetClientInstanceId
    )
  ) invalid();
  return Object.freeze({
    approvalVersion: 1,
    approvalId: claims.approvalId,
    keyId: claims.keyId,
    action: claims.action,
    projectId: claims.projectId,
    vaultId: claims.vaultId,
    storeId: claims.storeId,
    workspaceId: claims.workspaceId,
    sessionId: claims.sessionId,
    expectedOwnerGeneration: claims.expectedOwnerGeneration,
    commandId: claims.commandId,
    idempotencyKey: claims.idempotencyKey,
    intentHash: claims.intentHash,
    executorActorRole: claims.executorActorRole,
    executorClientInstanceId: claims.executorClientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId: claims.targetClientInstanceId,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    approvalNonce: claims.approvalNonce,
    reasonCode: claims.reasonCode,
    redactedApprovalReference: claims.redactedApprovalReference,
  }) as LifecycleApprovalClaimsV1;
}

function parseApproval(value: string): ParsedApproval {
  if (value.length > MAX_APPROVAL_WIRE_CHARS) invalid();
  const segments = value.split(".");
  if (segments.length !== 4 || segments[0] !== "pmrap1") invalid();
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
    const claims = decodeClaims(parsed);
    if (claims.keyId !== keyId) invalid();
    return { claims, claimsBytes, mac };
  } catch (error) {
    claimsBytes?.fill(0);
    mac?.fill(0);
    if (error instanceof LifecycleError) throw error;
    return invalid();
  } finally {
    keyIdBytes?.fill(0);
  }
}

function issue<T extends LifecycleApprovalClaimsV1>(
  provider: CapabilityKeyProvider,
  claimsInput: T,
  profile: ApprovalProfile,
): SecretString {
  let claims: LifecycleApprovalClaimsV1;
  try {
    claims = decodeClaims(claimsInput);
  } catch {
    invalid();
  }
  if (claims.action !== profile.action) invalid();
  let currentKeyId: string;
  try {
    currentKeyId = provider.currentKey(
      { projectId: claims.projectId, storeId: claims.storeId },
      profile.purpose,
    ).keyId;
  } catch {
    keyUnavailable();
  }
  if (currentKeyId !== claims.keyId) keyUnavailable();
  const claimsBytes = Buffer.from(canonicalJson(claims), "utf8");
  let mac: Buffer | undefined;
  try {
    mac = Buffer.from(provider.mac({
      projectId: claims.projectId,
      storeId: claims.storeId,
      purpose: profile.purpose,
      keyId: claims.keyId,
      domain: profile.domain,
      bytes: claimsBytes,
    }));
    if (mac.length !== 32) keyUnavailable();
    return SecretString.from(
      `pmrap1.${Buffer.from(claims.keyId, "utf8").toString("base64url")}.${claimsBytes.toString("base64url")}.${mac.toString("base64url")}`,
    );
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    return keyUnavailable();
  } finally {
    claimsBytes.fill(0);
    mac?.fill(0);
  }
}

export function issueRecoveryApproval(
  provider: CapabilityKeyProvider,
  claims: RecoveryApprovalClaimsV1,
): SecretString {
  return issue(provider, claims, RECOVERY_PROFILE);
}

export function issueAbandonmentApproval(
  provider: CapabilityKeyProvider,
  claims: AbandonmentApprovalClaimsV1,
): SecretString {
  return issue(provider, claims, ABANDONMENT_PROFILE);
}

function expectationsMatch(
  claims: LifecycleApprovalClaimsV1,
  expected: ApprovalVerificationExpectationV1,
): boolean {
  return claims.action === expected.action
    && claims.projectId === expected.projectId
    && claims.vaultId === expected.vaultId
    && claims.storeId === expected.storeId
    && claims.workspaceId === expected.workspaceId
    && claims.sessionId === expected.sessionId
    && claims.expectedOwnerGeneration === expected.expectedOwnerGeneration
    && claims.commandId === expected.commandId
    && claims.idempotencyKey === expected.idempotencyKey
    && claims.intentHash === expected.intentHash
    && claims.executorActorRole === expected.executorActorRole
    && claims.executorClientInstanceId === expected.executorClientInstanceId
    && claims.targetActorRole === expected.targetActorRole
    && claims.targetClientInstanceId === expected.targetClientInstanceId;
}

function digest(domain: string, mac: Uint8Array): string {
  return createHash("sha256").update(domain, "utf8").update(mac).digest("hex");
}

function nonceDigest(nonce: string): string {
  const bytes = Buffer.from(nonce, "hex");
  try {
    return createHash("sha256").update(NONCE_DIGEST_DOMAIN, "utf8").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}

function verify<T extends LifecycleApprovalClaimsV1>(
  provider: CapabilityKeyProvider,
  approval: SecretString,
  expected: ApprovalVerificationExpectationV1,
  nowMs: bigint,
  profile: ApprovalProfile,
): VerifiedLifecycleApprovalV1<T> {
  return approval.withValue((value) => {
    const parsed = parseApproval(value);
    try {
      const actionMatches = parsed.claims.action === profile.action;
      if (actionMatches) {
        let status: "available" | "revoked" | "unavailable";
        try {
          status = provider.status(
            { projectId: parsed.claims.projectId, storeId: parsed.claims.storeId },
            profile.purpose,
            parsed.claims.keyId,
          );
        } catch {
          keyUnavailable();
        }
        if (status !== "available") keyUnavailable();
      }
      let macValid = false;
      try {
        macValid = provider.verify({
          projectId: parsed.claims.projectId,
          storeId: parsed.claims.storeId,
          purpose: profile.purpose,
          keyId: parsed.claims.keyId,
          domain: profile.domain,
          bytes: parsed.claimsBytes,
          mac: parsed.mac,
        });
      } catch {
        invalid();
      }
      if (!macValid || !actionMatches || !expectationsMatch(parsed.claims, expected)) invalid();
      if (nowMs < BigInt(Date.parse(parsed.claims.issuedAt))) invalid();
      if (nowMs >= BigInt(Date.parse(parsed.claims.expiresAt))) expired();
      const approvalDigest = digest(profile.digestDomain, parsed.mac);
      return Object.freeze({
        claims: parsed.claims as T,
        redacted: Object.freeze({
          approvalVersion: 1,
          approvalId: parsed.claims.approvalId as RedactedLifecycleApproval["approvalId"],
          action: parsed.claims.action,
          approvalFingerprint: approvalDigest,
        }),
        approvalDigest,
        nonceDigest: nonceDigest(parsed.claims.approvalNonce),
      });
    } finally {
      parsed.claimsBytes.fill(0);
      parsed.mac.fill(0);
    }
  });
}

export function verifyRecoveryApproval(
  provider: CapabilityKeyProvider,
  approval: SecretString,
  expected: ApprovalVerificationExpectationV1,
  nowMs: bigint,
): VerifiedLifecycleApprovalV1<RecoveryApprovalClaimsV1> {
  return verify(provider, approval, expected, nowMs, RECOVERY_PROFILE);
}

export function verifyAbandonmentApproval(
  provider: CapabilityKeyProvider,
  approval: SecretString,
  expected: ApprovalVerificationExpectationV1,
  nowMs: bigint,
): VerifiedLifecycleApprovalV1<AbandonmentApprovalClaimsV1> {
  return verify(provider, approval, expected, nowMs, ABANDONMENT_PROFILE);
}
