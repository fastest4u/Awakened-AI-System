import { createHash } from "node:crypto";
import { decodeFreshStartIdentity, decodeFreshStartRelease, FreshStartError,
  type FreshStartIdentity, type FreshStartRelease, type FreshStartTransitionRequest } from "./contracts.js";

declare const approvalBrand: unique symbol;
declare const evidenceBrand: unique symbol;
export type VerifiedOperatorApproval = Readonly<{
  [approvalBrand]: true; identity: FreshStartIdentity; approvalId: string; nonceDigest: string;
  actorFingerprint: string; requestDigest: string; evidenceDigest: string;
}>;
export type VerifiedFreshStartEvidence = Readonly<{ [evidenceBrand]: true; release: FreshStartRelease }>;
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
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error();
    const keys = ["identity", "approvalId", "nonceDigest", "actorFingerprint", "requestDigest", "evidenceDigest"];
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some(key => typeof key !== "string" || !keys.includes(key))) throw Error();
    const fields: Record<string, unknown> = {};
    for (const key of keys) {
      const item = Object.getOwnPropertyDescriptor(value, key);
      if (!item || !item.enumerable || !("value" in item)) throw Error();
      fields[key] = item.value;
    }
    if (typeof fields.approvalId !== "string" || !UUID.test(fields.approvalId)) throw Error();
    for (const key of keys.slice(2)) if (typeof fields[key] !== "string" || !HASH.test(fields[key] as string)) throw Error();
    return Object.freeze({ identity: decodeFreshStartIdentity(fields.identity), approvalId: fields.approvalId,
      nonceDigest: fields.nonceDigest as string, actorFingerprint: fields.actorFingerprint as string,
      requestDigest: fields.requestDigest as string, evidenceDigest: fields.evidenceDigest as string });
  } catch { throw new FreshStartError("FRESH_START_APPROVAL_INVALID"); }
}

/** Trusted composition seam. The provider must authenticate operator keys/envelopes.
 * Constructor injection is server authority, never model input or proof by itself.
 * Real cryptographic providers are intentionally deferred to roadmap F3. */
export class TrustedOperatorApprovalVerifier implements OperatorApprovalVerifier {
  constructor(private readonly authenticate: (envelope: Uint8Array, requestDigest: string) => Promise<unknown>) {}
  async verify(envelope: Uint8Array, requestDigest: string): Promise<VerifiedOperatorApproval> {
    if (!(envelope instanceof Uint8Array) || envelope.length === 0 || envelope.length > 65_536
      || envelope.buffer instanceof SharedArrayBuffer || !HASH.test(requestDigest)) throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
    const value = approvalRecord(await this.authenticate(new Uint8Array(envelope), requestDigest)) as VerifiedOperatorApproval;
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
    try { decoded = decodeFreshStartRelease(result); }
    catch { throw new FreshStartError("FRESH_START_EVIDENCE_INVALID"); }
    const value = Object.freeze({ release: decoded }) as VerifiedFreshStartEvidence;
    evidence.add(value);
    return value;
  }
}

export function requireVerifiedOperatorApproval(value: unknown): VerifiedOperatorApproval {
  if (typeof value !== "object" || value === null || !approvals.has(value)) throw new FreshStartError("FRESH_START_APPROVAL_INVALID");
  return value as VerifiedOperatorApproval;
}
export function requireVerifiedFreshStartEvidence(value: unknown): VerifiedFreshStartEvidence {
  if (typeof value !== "object" || value === null || !evidence.has(value)) throw new FreshStartError("FRESH_START_EVIDENCE_INVALID");
  return value as VerifiedFreshStartEvidence;
}

/** Decoder fixes field order, so every identity and release field enters this digest. */
export function freshStartRequestDigest(request: FreshStartTransitionRequest): string {
  return createHash("sha256").update(JSON.stringify({ domain: "fresh-start-transition-v1",
    identity: request.identity, expectedGeneration: request.expectedGeneration.toString(),
    expectedMode: request.expectedMode, expectedReleaseId: request.expectedReleaseId,
    nextMode: request.nextMode, nextRelease: request.nextRelease })).digest("hex");
}

/** Only verifier shipped by the foundation composition. No deployment flag opens it. */
export const DENY_FRESH_START_PROMOTION: OperatorApprovalVerifier & FreshStartEvidenceVerifier = Object.freeze({
  async verify(): Promise<never> { throw new FreshStartError("FRESH_START_RELEASE_NOT_READY"); },
});
