import { timingSafeEqual } from "node:crypto";
import type { CapabilityProofV1 } from "./contracts/commands.js";
import { LifecycleError } from "./errors.js";
import type { AuthorityMaterialStatus } from "./lifecycle-command.store.js";
import type {
  CapabilityKeyProvider,
  CapabilityKind,
} from "./authority/capability-key-provider.js";
import {
  capabilityVerifier,
  decodeCapabilityProofTarget,
  decodeCapabilityClaims,
  issueCapability,
  reconstructCapability,
  verifyCapability,
  verifyCapabilityProof,
  type CapabilityClaimsV1,
  type CapabilityProofTargetV1,
  type VerifiedCapabilityProofV1,
} from "./authority/capability-codec.js";
import { SecretString } from "./authority/redacted-secret.js";
import { canonicalJson } from "../serialization/canonical-json.js";

export type { AuthorityMaterialStatus } from "./lifecycle-command.store.js";

export const MAX_BOUNDED_PROOF_HORIZON_MS = 120_000n;

export interface CapabilityClock {
  nowMs(): bigint;
}

export interface CapabilityNonceSource {
  bytes(length: number): Uint8Array;
  uuid(): string;
}

export interface CapabilityServiceOptions {
  readonly keyProvider: CapabilityKeyProvider;
  readonly clock: CapabilityClock;
  readonly nonceSource: CapabilityNonceSource;
}

export interface PrepareCapabilityInputV1 {
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly clientNamespace: string;
  readonly sessionId: string;
  readonly kind: CapabilityKind;
  readonly capabilityGeneration: string;
  readonly policyCode: string;
  readonly expiryKind: "until-revoked" | "absolute";
  readonly expiresAt: string | null;
  readonly actorRole: "primary" | "untrusted";
  readonly clientInstanceId: string | null;
}

export interface StoredCapabilityMaterialV1 {
  readonly claims: CapabilityClaimsV1;
  readonly verifier: string;
}

export interface LifecycleAuthorityTarget {
  readonly actorRole: "primary" | "untrusted";
  readonly clientInstanceId: string;
}

export interface AuthorityMaterialDescriptorV1 {
  readonly descriptorVersion: 1;
  readonly authorityCommitment: string;
  readonly capabilityGeneration: string;
  readonly target: LifecycleAuthorityTarget;
  readonly materials: readonly StoredCapabilityMaterialV1[];
}

export interface AuthorityMaterialRequestV1 {
  readonly authorityCommitment: string;
  readonly expectedCapabilityGeneration: string;
  readonly currentCapabilityGeneration: string;
  readonly target: LifecycleAuthorityTarget;
  readonly materials: readonly StoredCapabilityMaterialV1[];
}

export interface AuthorityMaterialResolutionV1 {
  readonly status: AuthorityMaterialStatus;
  readonly descriptor?: AuthorityMaterialDescriptorV1;
  readonly recoveryCode?: "SESSION_HANDLE_STALE" | "SESSION_CAPABILITY_KEY_UNAVAILABLE";
}

export interface ContinuityFingerprintInputV1 {
  readonly projectId: string;
  readonly storeId: string;
  readonly clientNamespace: string;
  readonly continuityKey: string;
}

export interface ContinuityFingerprintV1 {
  readonly algorithm: "hmac-sha256";
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly domain: "pm-continuity-v1";
  readonly fingerprint: string;
}

export type RootOrChildAuthorityMaterial =
  | {
      readonly kind: "root";
      readonly handle: SecretString;
      readonly resumeToken: SecretString | null;
    }
  | {
      readonly kind: "child";
      readonly handle: SecretString;
    };

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function keyUnavailable(): never {
  throw new LifecycleError("SESSION_CAPABILITY_KEY_UNAVAILABLE");
}

function invalid(): never {
  throw new LifecycleError("SESSION_CAPABILITY_INVALID");
}

function expired(): never {
  throw new LifecycleError("SESSION_CAPABILITY_EXPIRED");
}

function positiveGeneration(value: string): boolean {
  if (!DECIMAL.test(value)) return false;
  const generation = BigInt(value);
  return generation > 0n && generation <= 9_223_372_036_854_775_807n;
}

function decodeAuthorityTarget(value: unknown): LifecycleAuthorityTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2
    || keys.some((key) => typeof key !== "string")
    || !keys.includes("actorRole")
    || !keys.includes("clientInstanceId")
  ) invalid();
  const actorRoleDescriptor = Object.getOwnPropertyDescriptor(value, "actorRole");
  const clientDescriptor = Object.getOwnPropertyDescriptor(value, "clientInstanceId");
  if (
    actorRoleDescriptor === undefined
    || clientDescriptor === undefined
    || !actorRoleDescriptor.enumerable
    || !clientDescriptor.enumerable
    || !("value" in actorRoleDescriptor)
    || !("value" in clientDescriptor)
  ) invalid();
  const actorRole = actorRoleDescriptor.value as unknown;
  const clientInstanceId = clientDescriptor.value as unknown;
  if (
    (actorRole !== "primary" && actorRole !== "untrusted")
    || typeof clientInstanceId !== "string"
    || clientInstanceId.length === 0
    || Array.from(clientInstanceId).length > 256
  ) invalid();
  return Object.freeze({ actorRole, clientInstanceId });
}

function sameCapabilityScope(left: CapabilityClaimsV1, right: CapabilityClaimsV1): boolean {
  return left.projectId === right.projectId
    && left.vaultId === right.vaultId
    && left.storeId === right.storeId
    && left.workspaceId === right.workspaceId
    && left.clientNamespace === right.clientNamespace
    && left.sessionId === right.sessionId
    && left.capabilityGeneration === right.capabilityGeneration;
}

function targetAcceptsClaims(
  target: LifecycleAuthorityTarget,
  claims: CapabilityClaimsV1,
): boolean {
  if (claims.kind === "child-session-handle") {
    return target.actorRole === "untrusted"
      && claims.clientInstanceId === target.clientInstanceId;
  }
  if (claims.kind === "root-session-handle") {
    return target.actorRole === "primary"
      && claims.clientInstanceId === target.clientInstanceId;
  }
  return target.actorRole === "primary";
}

function validDependencies(options: CapabilityServiceOptions): boolean {
  const provider = options?.keyProvider as CapabilityKeyProvider | undefined;
  const clock = options?.clock as CapabilityClock | undefined;
  const nonces = options?.nonceSource as CapabilityNonceSource | undefined;
  return provider !== undefined
    && typeof provider.currentKey === "function"
    && typeof provider.status === "function"
    && typeof provider.mac === "function"
    && typeof provider.verify === "function"
    && typeof provider.fingerprint === "function"
    && typeof provider.seal === "function"
    && typeof provider.open === "function"
    && clock !== undefined
    && typeof clock.nowMs === "function"
    && nonces !== undefined
    && typeof nonces.bytes === "function"
    && typeof nonces.uuid === "function";
}

function sameHex(left: string, right: string): boolean {
  if (!HASH.test(left) || !HASH.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  try {
    return timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

export class CapabilityService {
  readonly #provider: CapabilityKeyProvider;
  readonly #clock: CapabilityClock;
  readonly #nonces: CapabilityNonceSource;

  constructor(options: CapabilityServiceOptions) {
    if (!validDependencies(options)) keyUnavailable();
    this.#provider = options.keyProvider;
    this.#clock = options.clock;
    this.#nonces = options.nonceSource;
  }

  continuityFingerprint(input: ContinuityFingerprintInputV1): ContinuityFingerprintV1 {
    if (
      typeof input !== "object"
      || input === null
      || !UUID.test(input.projectId)
      || !UUID.test(input.storeId)
      || typeof input.clientNamespace !== "string"
      || input.clientNamespace.length === 0
      || Array.from(input.clientNamespace).length > 256
      || typeof input.continuityKey !== "string"
      || input.continuityKey.length === 0
      || Array.from(input.continuityKey).length > 1_024
    ) invalid();
    let keyId: string;
    try {
      keyId = this.#provider.currentKey(
        { projectId: input.projectId, storeId: input.storeId },
        "continuity-index",
      ).keyId;
      if (
        typeof keyId !== "string"
        || keyId.length === 0
        || Array.from(keyId).length > 256
        || this.#provider.status(
          { projectId: input.projectId, storeId: input.storeId },
          "continuity-index",
          keyId,
        ) !== "available"
      ) keyUnavailable();
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      keyUnavailable();
    }
    const bytes = Buffer.from(canonicalJson({
      clientNamespace: input.clientNamespace,
      continuityKey: input.continuityKey,
    }), "utf8");
    try {
      const fingerprint = this.#provider.fingerprint({
        projectId: input.projectId,
        storeId: input.storeId,
        purpose: "continuity-index",
        keyId,
        domain: "pm-continuity-v1",
        bytes,
      });
      if (!HASH.test(fingerprint)) invalid();
      return Object.freeze({
        algorithm: "hmac-sha256",
        schemaVersion: 1,
        keyId,
        domain: "pm-continuity-v1",
        fingerprint,
      });
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      keyUnavailable();
    } finally {
      bytes.fill(0);
    }
  }

  prepareCapability(input: PrepareCapabilityInputV1): StoredCapabilityMaterialV1 {
    let keyId: string;
    try {
      keyId = this.#provider.currentKey(
        { projectId: input.projectId, storeId: input.storeId },
        input.kind,
      ).keyId;
    } catch {
      keyUnavailable();
    }
    const nonce = Buffer.from(this.#nonces.bytes(32));
    let issuedAt: string;
    try {
      if (nonce.length !== 32) invalid();
      const nowMs = this.#clock.nowMs();
      if (nowMs < 0n || nowMs > BigInt(8_640_000_000_000_000)) invalid();
      issuedAt = new Date(Number(nowMs)).toISOString();
      const claims = decodeCapabilityClaims({
        capabilityVersion: 1,
        keyId,
        projectId: input.projectId,
        vaultId: input.vaultId,
        storeId: input.storeId,
        workspaceId: input.workspaceId,
        clientNamespace: input.clientNamespace,
        sessionId: input.sessionId,
        kind: input.kind,
        capabilityGeneration: input.capabilityGeneration,
        issuedAt,
        policyCode: input.policyCode,
        expiryKind: input.expiryKind,
        expiresAt: input.expiresAt,
        issueNonce: nonce.toString("hex"),
        actorRole: input.actorRole,
        clientInstanceId: input.clientInstanceId,
      });
      const bearer = issueCapability(this.#provider, claims);
      try {
        return Object.freeze({
          claims,
          verifier: capabilityVerifier(this.#provider, bearer, claims),
        });
      } finally {
        bearer.destroy();
      }
    } finally {
      nonce.fill(0);
    }
  }

  authorityMaterial(input: AuthorityMaterialRequestV1): AuthorityMaterialResolutionV1 {
    const target = decodeAuthorityTarget(input.target);
    if (
      !HASH.test(input.authorityCommitment)
      || !positiveGeneration(input.expectedCapabilityGeneration)
      || !positiveGeneration(input.currentCapabilityGeneration)
      || !Array.isArray(input.materials)
      || input.materials.length > 2
    ) invalid();
    if (input.expectedCapabilityGeneration !== input.currentCapabilityGeneration) {
      return Object.freeze({ status: "stale", recoveryCode: "SESSION_HANDLE_STALE" });
    }
    if (input.materials.length === 0) return Object.freeze({ status: "not-issued" });
    const decodedMaterials: StoredCapabilityMaterialV1[] = [];
    const kinds = new Set<CapabilityKind>();
    let scope: CapabilityClaimsV1 | undefined;
    for (const material of input.materials) {
      const claims = decodeCapabilityClaims(material.claims);
      if (
        !HASH.test(material.verifier)
        || claims.capabilityGeneration !== input.currentCapabilityGeneration
        || !targetAcceptsClaims(target, claims)
        || kinds.has(claims.kind)
        || (scope !== undefined && !sameCapabilityScope(scope, claims))
      ) invalid();
      kinds.add(claims.kind);
      scope ??= claims;
      decodedMaterials.push(Object.freeze({ claims, verifier: material.verifier }));
    }
    if (
      (target.actorRole === "untrusted"
        && (decodedMaterials.length !== 1 || !kinds.has("child-session-handle")))
      || (target.actorRole === "primary"
        && (!kinds.has("root-session-handle") || kinds.has("child-session-handle")))
    ) invalid();
    for (const material of decodedMaterials) {
      const claims = material.claims;
      let status: "available" | "revoked" | "unavailable";
      try {
        status = this.#provider.status(
          { projectId: claims.projectId, storeId: claims.storeId },
          claims.kind,
          claims.keyId,
        );
      } catch {
        status = "unavailable";
      }
      if (status !== "available") {
        return Object.freeze({
          status: "stale",
          recoveryCode: "SESSION_CAPABILITY_KEY_UNAVAILABLE",
        });
      }
    }
    const descriptor: AuthorityMaterialDescriptorV1 = Object.freeze({
      descriptorVersion: 1,
      authorityCommitment: input.authorityCommitment,
      capabilityGeneration: input.currentCapabilityGeneration,
      target: Object.freeze({
        actorRole: target.actorRole,
        clientInstanceId: target.clientInstanceId,
      }),
      materials: Object.freeze(decodedMaterials.map((material) => Object.freeze({
        claims: material.claims,
        verifier: material.verifier,
      }))),
    });
    return Object.freeze({ status: "current", descriptor });
  }

  verifyProof(
    material: StoredCapabilityMaterialV1,
    target: CapabilityProofTargetV1,
    proof: CapabilityProofV1,
  ): VerifiedCapabilityProofV1 {
    const claims = decodeCapabilityClaims(material.claims);
    const decodedTarget = decodeCapabilityProofTarget(target);
    const bearer = reconstructCapability(this.#provider, claims);
    try {
      const verifier = capabilityVerifier(this.#provider, bearer, claims);
      if (!sameHex(verifier, material.verifier)) invalid();
      const audience = {
        presentingActorRole: decodedTarget.presentingActorRole,
        presentingClientInstanceId: decodedTarget.presentingClientInstanceId,
        targetActorRole: decodedTarget.targetActorRole,
        targetClientInstanceId: decodedTarget.targetClientInstanceId,
      };
      const semantic = decodedTarget.target === "semantic-command" ? decodedTarget : null;
      const nowMs = this.#clock.nowMs();
      verifyCapability(this.#provider, bearer, {
        projectId: semantic?.projectId ?? claims.projectId,
        vaultId: semantic?.vaultId ?? claims.vaultId,
        storeId: semantic?.storeId ?? claims.storeId,
        workspaceId: semantic?.workspaceId ?? claims.workspaceId,
        clientNamespace: semantic?.clientNamespace ?? claims.clientNamespace,
        sessionId: decodedTarget.authoritySessionId,
        kind: semantic?.capabilityKind ?? claims.kind,
        capabilityGeneration: decodedTarget.capabilityGeneration,
        audience,
      }, nowMs);
      if (
        decodedTarget.capabilityGeneration !== claims.capabilityGeneration
        || (semantic !== null && semantic.capabilityKind !== claims.kind)
      ) invalid();
      const verified = verifyCapabilityProof(bearer, decodedTarget, proof);
      if (decodedTarget.target === "bounded-operation") {
        const expiresAtMs = BigInt(Date.parse(decodedTarget.expiresAt));
        if (nowMs >= expiresAtMs) expired();
        if (expiresAtMs - nowMs > MAX_BOUNDED_PROOF_HORIZON_MS) invalid();
      }
      return verified;
    } finally {
      bearer.destroy();
    }
  }

  reconstructForTarget(
    descriptor: AuthorityMaterialDescriptorV1,
    authenticatedTarget: LifecycleAuthorityTarget,
  ): RootOrChildAuthorityMaterial {
    if (
      descriptor.target.actorRole !== authenticatedTarget.actorRole
      || descriptor.target.clientInstanceId !== authenticatedTarget.clientInstanceId
      || descriptor.descriptorVersion !== 1
      || !HASH.test(descriptor.authorityCommitment)
      || !positiveGeneration(descriptor.capabilityGeneration)
      || !Array.isArray(descriptor.materials)
      || descriptor.materials.length === 0
      || descriptor.materials.length > 2
    ) invalid();
    const validated: StoredCapabilityMaterialV1[] = [];
    const kinds = new Set<CapabilityKind>();
    let scope: CapabilityClaimsV1 | undefined;
    for (const material of descriptor.materials) {
      const claims = decodeCapabilityClaims(material.claims);
      if (
        !HASH.test(material.verifier)
        || claims.capabilityGeneration !== descriptor.capabilityGeneration
        || !targetAcceptsClaims(authenticatedTarget, claims)
        || kinds.has(claims.kind)
        || (scope !== undefined && !sameCapabilityScope(scope, claims))
      ) invalid();
      kinds.add(claims.kind);
      scope ??= claims;
      validated.push(Object.freeze({ claims, verifier: material.verifier }));
    }
    if (
      (authenticatedTarget.actorRole === "untrusted"
        && (validated.length !== 1 || !kinds.has("child-session-handle")))
      || (authenticatedTarget.actorRole === "primary"
        && (!kinds.has("root-session-handle") || kinds.has("child-session-handle")))
    ) invalid();
    const reconstructed: { kind: CapabilityKind; secret: SecretString }[] = [];
    try {
      for (const material of validated) {
        const claims = material.claims;
        const secret = reconstructCapability(this.#provider, claims);
        reconstructed.push({ kind: claims.kind, secret });
        if (!sameHex(capabilityVerifier(this.#provider, secret, claims), material.verifier)) invalid();
      }
      const child = reconstructed.find((material) => material.kind === "child-session-handle");
      if (child !== undefined) {
        if (reconstructed.length !== 1 || authenticatedTarget.actorRole !== "untrusted") invalid();
        reconstructed.length = 0;
        return Object.freeze({ kind: "child", handle: child.secret });
      }
      const handle = reconstructed.find((material) => material.kind === "root-session-handle");
      const resume = reconstructed.find((material) => material.kind === "root-resume-token");
      if (handle === undefined || authenticatedTarget.actorRole !== "primary") invalid();
      const output = Object.freeze({
        kind: "root" as const,
        handle: handle.secret,
        resumeToken: resume?.secret ?? null,
      });
      reconstructed.length = 0;
      return output;
    } finally {
      for (const material of reconstructed) material.secret.destroy();
    }
  }
}
