import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../serialization/canonical-json.js";
import {
  decodeFreshStartIdentity,
  decodeFreshStartRelease,
  FreshStartError,
  type FreshStartIdentity,
  type FreshStartRelease,
  type FreshStartTransitionRequest,
} from "./contracts.js";

declare const approvalBrand: unique symbol;
declare const evidenceBrand: unique symbol;
export type VerifiedOperatorApproval = Readonly<{
  [approvalBrand]: true;
  identity: FreshStartIdentity;
  approvalId: string;
  nonceDigest: string;
  actorFingerprint: string;
  requestDigest: string;
  evidenceDigest: string;
}>;
export type VerifiedFreshStartEvidence = Readonly<{
  [evidenceBrand]: true;
  release: FreshStartRelease;
}>;
export interface OperatorApprovalVerifier {
  verify(envelope: Uint8Array, requestDigest: string): Promise<VerifiedOperatorApproval>;
}
export interface FreshStartEvidenceVerifier {
  verify(release: FreshStartRelease): Promise<VerifiedFreshStartEvidence>;
}
const approvals = new WeakSet<object>();
const evidence = new WeakSet<object>();
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function approvalRecord(value: unknown): Omit<VerifiedOperatorApproval, typeof approvalBrand> {
  try {
    if (
      !value
      || typeof value !== "object"
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
      throw Error();
    }
    const keys = [
      "identity",
      "approvalId",
      "nonceDigest",
      "actorFingerprint",
      "requestDigest",
      "evidenceDigest",
    ];
    const actual = Reflect.ownKeys(value);
    if (
      actual.length !== keys.length
      || actual.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
      throw Error();
    }
    const fields: Record<string, unknown> = {};
    for (const key of keys) {
      const item = Object.getOwnPropertyDescriptor(value, key);
      if (!item || !item.enumerable || !("value" in item)) throw Error();
      fields[key] = item.value;
    }
    if (typeof fields.approvalId !== "string" || !UUID.test(fields.approvalId)) throw Error();
    for (const key of keys.slice(2)) {
      if (typeof fields[key] !== "string" || !HASH.test(fields[key] as string)) throw Error();
    }
    return Object.freeze({
      identity: decodeFreshStartIdentity(fields.identity),
      approvalId: fields.approvalId,
      nonceDigest: fields.nonceDigest as string,
      actorFingerprint: fields.actorFingerprint as string,
      requestDigest: fields.requestDigest as string,
      evidenceDigest: fields.evidenceDigest as string,
    });
  } catch {
    throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
  }
}

/** Trusted composition seam. The provider must authenticate operator keys/envelopes.
 * Constructor injection is server authority, never model input or proof by itself.
 * Real cryptographic providers are intentionally deferred to roadmap F3. */
export class TrustedOperatorApprovalVerifier implements OperatorApprovalVerifier {
  constructor(
    private readonly authenticate: (
      envelope: Uint8Array,
      requestDigest: string,
    ) => Promise<unknown>,
  ) {}
  async verify(envelope: Uint8Array, requestDigest: string): Promise<VerifiedOperatorApproval> {
    if (
      !(envelope instanceof Uint8Array)
      || envelope.length === 0
      || envelope.length > 65_536
      || envelope.buffer instanceof SharedArrayBuffer
      || !HASH.test(requestDigest)
    ) {
      throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
    }
    const value = approvalRecord(
      await this.authenticate(new Uint8Array(envelope), requestDigest),
    ) as VerifiedOperatorApproval;
    approvals.add(value);
    return value;
  }
}
/** The server provider must verify actual release evidence, including all hashes. */
export class TrustedFreshStartEvidenceVerifier implements FreshStartEvidenceVerifier {
  constructor(private readonly authenticate: (release: FreshStartRelease) => Promise<unknown>) {}
  async verify(release: FreshStartRelease): Promise<VerifiedFreshStartEvidence> {
    const input = decodeFreshStartRelease(release);
    const result = await this.authenticate(input);
    let decoded: FreshStartRelease;
    try {
      decoded = decodeFreshStartRelease(result);
    } catch {
      throw new FreshStartError("FRESH_START_EVIDENCE_INVALID");
    }
    const value = Object.freeze({ release: decoded }) as VerifiedFreshStartEvidence;
    evidence.add(value);
    return value;
  }
}

export function requireVerifiedOperatorApproval(value: unknown): VerifiedOperatorApproval {
  if (typeof value !== "object" || value === null || !approvals.has(value)) {
    throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
  }
  return value as VerifiedOperatorApproval;
}
export function requireVerifiedFreshStartEvidence(value: unknown): VerifiedFreshStartEvidence {
  if (typeof value !== "object" || value === null || !evidence.has(value)) {
    throw new FreshStartError("FRESH_START_EVIDENCE_INVALID");
  }
  return value as VerifiedFreshStartEvidence;
}

/** Decoder fixes field order, so every identity and release field enters this digest. */
export function freshStartRequestDigest(request: FreshStartTransitionRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        domain: "fresh-start-transition-v1",
        identity: request.identity,
        expectedGeneration: request.expectedGeneration.toString(),
        expectedMode: request.expectedMode,
        expectedReleaseId: request.expectedReleaseId,
        nextMode: request.nextMode,
        nextRelease: request.nextRelease,
      }),
    )
    .digest("hex");
}

/** Only verifier shipped by the foundation composition. No deployment flag opens it. */
export const DENY_FRESH_START_PROMOTION: OperatorApprovalVerifier & FreshStartEvidenceVerifier =
  Object.freeze({
    async verify(): Promise<never> {
      throw new FreshStartError("FRESH_START_RELEASE_NOT_READY");
    },
  });

export interface SignedOperatorApprovalEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly identity: FreshStartIdentity;
  readonly approvalId: string;
  readonly nonceDigest: string;
  readonly actorFingerprint: string;
  readonly requestDigest: string;
  readonly evidenceDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signatureHex: string;
}

function normalizeSecretBytes(secret: string | Uint8Array): Buffer {
  if (typeof secret === "string") {
    const trimmed = secret.trim();
    if (trimmed !== secret || Buffer.byteLength(secret, "utf8") < 16) {
      throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
    }
    return Buffer.from(secret, "utf8");
  }
  if (
    secret instanceof Uint8Array
    && !(secret.buffer instanceof SharedArrayBuffer)
    && secret.byteLength >= 16
  ) {
    return Buffer.from(secret);
  }
  throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
}

function computeApprovalHmacHex(
  secretBytes: Buffer,
  payload: Omit<SignedOperatorApprovalEnvelopeV1, "signatureHex">,
): string {
  return createHmac("sha256", secretBytes)
    .update(
      canonicalJson({
        domain: "fresh-start-operator-approval-v1",
        schemaVersion: payload.schemaVersion,
        identity: payload.identity,
        approvalId: payload.approvalId,
        nonceDigest: payload.nonceDigest,
        actorFingerprint: payload.actorFingerprint,
        requestDigest: payload.requestDigest,
        evidenceDigest: payload.evidenceDigest,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function createSignedOperatorApprovalEnvelope(
  input: Omit<SignedOperatorApprovalEnvelopeV1, "schemaVersion" | "signatureHex"> & {
    readonly secret: string | Uint8Array;
  },
): SignedOperatorApprovalEnvelopeV1 {
  try {
    const secretBytes = normalizeSecretBytes(input.secret);
    const identity = decodeFreshStartIdentity(input.identity);
    if (typeof input.approvalId !== "string" || !UUID.test(input.approvalId)) {
      throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
    }
    for (const hashField of [
      input.nonceDigest,
      input.actorFingerprint,
      input.requestDigest,
      input.evidenceDigest,
    ]) {
      if (typeof hashField !== "string" || !HASH.test(hashField)) {
        throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
      }
    }
    if (typeof input.issuedAt !== "string" || typeof input.expiresAt !== "string") {
      throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
    }
    const issuedMs = Date.parse(input.issuedAt);
    const expiresMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs <= issuedMs) {
      throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
    }
    const unsigned: Omit<SignedOperatorApprovalEnvelopeV1, "signatureHex"> = {
      schemaVersion: 1,
      identity,
      approvalId: input.approvalId,
      nonceDigest: input.nonceDigest,
      actorFingerprint: input.actorFingerprint,
      requestDigest: input.requestDigest,
      evidenceDigest: input.evidenceDigest,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    };
    const signatureHex = computeApprovalHmacHex(secretBytes, unsigned);
    return Object.freeze({
      ...unsigned,
      signatureHex,
    });
  } catch (error) {
    if (error instanceof FreshStartError) throw error;
    throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
  }
}

export function serializeOperatorApprovalEnvelope(
  envelope: SignedOperatorApprovalEnvelopeV1,
): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalJson(envelope), "utf8"));
}

export function createHmacOperatorApprovalVerifier(
  secret: string | Uint8Array,
  options?: { readonly now?: () => string },
): OperatorApprovalVerifier {
  return new TrustedOperatorApprovalVerifier(async (envelopeBytes, expectedRequestDigest) => {
    try {
      const secretBytes = normalizeSecretBytes(secret);
      const text = Buffer.from(envelopeBytes).toString("utf8");
      const raw = JSON.parse(text) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schemaVersion !== 1) {
        throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
      }
      const identity = decodeFreshStartIdentity(raw.identity);
      const approvalId = raw.approvalId;
      const nonceDigest = raw.nonceDigest;
      const actorFingerprint = raw.actorFingerprint;
      const requestDigest = raw.requestDigest;
      const evidenceDigest = raw.evidenceDigest;
      const issuedAt = raw.issuedAt;
      const expiresAt = raw.expiresAt;
      const signatureHex = raw.signatureHex;

      if (typeof approvalId !== "string" || !UUID.test(approvalId)) {
        throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
      }
      for (const field of [
        nonceDigest,
        actorFingerprint,
        requestDigest,
        evidenceDigest,
        signatureHex,
      ]) {
        if (typeof field !== "string" || !HASH.test(field)) {
          throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
        }
      }
      if (requestDigest !== expectedRequestDigest) {
        throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
      }
      if (typeof issuedAt !== "string" || typeof expiresAt !== "string") {
        throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
      }
      const issuedMs = Date.parse(issuedAt);
      const expiresMs = Date.parse(expiresAt);
      const nowIso = options?.now ? options.now() : new Date().toISOString();
      const nowMs = Date.parse(nowIso);
      if (
        !Number.isFinite(issuedMs)
        || !Number.isFinite(expiresMs)
        || !Number.isFinite(nowMs)
        || expiresMs <= issuedMs
        || nowMs < issuedMs
        || nowMs > expiresMs
      ) {
        throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
      }

      const expectedSignatureHex = computeApprovalHmacHex(secretBytes, {
        schemaVersion: 1,
        identity,
        approvalId,
        nonceDigest: nonceDigest as string,
        actorFingerprint: actorFingerprint as string,
        requestDigest: requestDigest as string,
        evidenceDigest: evidenceDigest as string,
        issuedAt,
        expiresAt,
      });
      const expectedSigBuf = Buffer.from(expectedSignatureHex, "hex");
      const actualSigBuf = Buffer.from(signatureHex as string, "hex");
      if (
        expectedSigBuf.length !== actualSigBuf.length
        || !timingSafeEqual(expectedSigBuf, actualSigBuf)
      ) {
        throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
      }

      return {
        identity,
        approvalId,
        nonceDigest: nonceDigest as string,
        actorFingerprint: actorFingerprint as string,
        requestDigest: requestDigest as string,
        evidenceDigest: evidenceDigest as string,
      };
    } catch (error) {
      if (error instanceof FreshStartError) throw error;
      throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
    }
  });
}

export interface FreshStartReleaseEvidenceReportV1 {
  readonly schemaVersion: 1;
  readonly status: "ready-for-activation" | "live-operation-verified";
  readonly productionReady: true;
  readonly releaseId?: string;
  readonly buildIdentityHash: string;
  readonly schemaIdentityHash: string;
  readonly capabilityManifestHash: string;
  readonly recoveryPolicyHash: string;
  readonly scenarios: readonly { readonly id: string; readonly passed: true }[];
  readonly generatedAt: string;
  readonly reportDigest: string;
}

export function computeReleaseEvidenceReportDigest(
  report: Omit<FreshStartReleaseEvidenceReportV1, "reportDigest">,
): string {
  const { reportDigest: _ignored, ...rest } = report as FreshStartReleaseEvidenceReportV1;
  return createHash("sha256")
    .update(
      canonicalJson({
        domain: "v2-fresh-start-release-evidence-v1",
        ...rest,
      }),
      "utf8",
    )
    .digest("hex");
}

export function createReleaseEvidenceReportVerifier(
  reportOrLoader: unknown | (() => unknown),
): FreshStartEvidenceVerifier {
  return new TrustedFreshStartEvidenceVerifier(async (release) => {
    try {
      const loaded =
        typeof reportOrLoader === "function"
          ? await (reportOrLoader as () => unknown)()
          : reportOrLoader;
      if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
        throw new FreshStartError("FRESH_START_EVIDENCE_INVALID");
      }
      const raw = loaded as Record<string, unknown>;
      if (
        raw.schemaVersion !== 1
        || (raw.status !== "ready-for-activation" && raw.status !== "live-operation-verified")
        || raw.productionReady !== true
        || typeof raw.buildIdentityHash !== "string"
        || !HASH.test(raw.buildIdentityHash)
        || typeof raw.schemaIdentityHash !== "string"
        || !HASH.test(raw.schemaIdentityHash)
        || typeof raw.capabilityManifestHash !== "string"
        || !HASH.test(raw.capabilityManifestHash)
        || typeof raw.recoveryPolicyHash !== "string"
        || !HASH.test(raw.recoveryPolicyHash)
        || typeof raw.generatedAt !== "string"
        || !Number.isFinite(Date.parse(raw.generatedAt))
        || typeof raw.reportDigest !== "string"
        || !HASH.test(raw.reportDigest)
        || !Array.isArray(raw.scenarios)
        || raw.scenarios.length < 8
      ) {
        throw new FreshStartError("FRESH_START_EVIDENCE_INVALID");
      }

      const seenScenarioIds = new Set<string>();
      for (const scenario of raw.scenarios) {
        if (
          !scenario
          || typeof scenario !== "object"
          || typeof (scenario as { id?: unknown }).id !== "string"
          || (scenario as { id: string }).id.length === 0
          || (scenario as { passed?: unknown }).passed !== true
          || seenScenarioIds.has((scenario as { id: string }).id)
        ) {
          throw new FreshStartError("FRESH_START_EVIDENCE_INVALID");
        }
        seenScenarioIds.add((scenario as { id: string }).id);
      }

      const { reportDigest, ...withoutDigest } = raw;
      const expectedDigest = computeReleaseEvidenceReportDigest(
        withoutDigest as unknown as Omit<FreshStartReleaseEvidenceReportV1, "reportDigest">,
      );
      if (reportDigest !== expectedDigest) {
        throw new FreshStartError("FRESH_START_EVIDENCE_INVALID");
      }

      if (
        raw.buildIdentityHash !== release.buildIdentityHash
        || raw.schemaIdentityHash !== release.schemaIdentityHash
        || raw.capabilityManifestHash !== release.capabilityManifestHash
        || raw.recoveryPolicyHash !== release.recoveryPolicyHash
        || reportDigest !== release.evidenceDigest
        || (raw.releaseId !== undefined && raw.releaseId !== release.releaseId)
      ) {
        throw new FreshStartError("FRESH_START_EVIDENCE_INVALID");
      }

      return release;
    } catch (error) {
      if (error instanceof FreshStartError) throw error;
      throw new FreshStartError("FRESH_START_EVIDENCE_INVALID");
    }
  });
}
