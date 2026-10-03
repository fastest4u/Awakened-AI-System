/** Private local seam. Purpose keys stay inside the provider; keys/MAC outputs are fresh caller-owned buffers. Providers retain no borrowed inputs. */
export type EvidenceKeyScope = { readonly projectId: string; readonly storeId: string };
export type EvidenceKeyRefV1 = { readonly keyId: string; readonly version: string };
export type EvidenceKeyPurpose = "data-key-wrap" | "original-input-commitment" | "redacted-content-fingerprint";
export type WrappedEvidenceKeyV1 = {
  readonly formatVersion: 1; readonly keyRef: EvidenceKeyRefV1; readonly algorithm: "AES-256-GCM";
  readonly nonce: string; readonly ciphertext: string; readonly tag: string;
};
export interface EvidenceKeyProvider {
  currentKey(scope: EvidenceKeyScope, purpose: EvidenceKeyPurpose): EvidenceKeyRefV1;
  status(scope: EvidenceKeyScope, purpose: EvidenceKeyPurpose, ref: EvidenceKeyRefV1): "available" | "revoked" | "unavailable";
  wrap(scope: EvidenceKeyScope, ref: EvidenceKeyRefV1, dataKey: Uint8Array, aad: Uint8Array): WrappedEvidenceKeyV1;
  unwrap(scope: EvidenceKeyScope, wrapped: WrappedEvidenceKeyV1, aad: Uint8Array): Uint8Array;
  /** HMAC-SHA-256 of UTF-8(domain + newline) followed by bytes, under the recorded scoped purpose key. */
  mac(scope: EvidenceKeyScope, purpose: "original-input-commitment" | "redacted-content-fingerprint", ref: EvidenceKeyRefV1, domain: string, bytes: Uint8Array): Uint8Array;
}

import { RetainedEvidenceError } from "./evidence-contracts.js";
import { decodeEvidenceKeyRef } from "./retained-evidence-codec.js";
import { canonicalJson } from "../serialization/canonical-json.js";

/** Provider/native exception text, codes, handles and causes never cross this boundary. */
export function evidenceProviderCall<T>(operation: () => T): T {
  try { return operation(); } catch { throw new RetainedEvidenceError("RETAINED_EVIDENCE_KEY_UNAVAILABLE"); }
}
export function requireEvidenceKey(provider: EvidenceKeyProvider, scope: EvidenceKeyScope, purpose: EvidenceKeyPurpose, value: EvidenceKeyRefV1): EvidenceKeyRefV1 {
  const ref = evidenceProviderCall(() => decodeEvidenceKeyRef(value));
  if (evidenceProviderCall(() => provider.status(scope, purpose, ref)) !== "available") throw new RetainedEvidenceError("RETAINED_EVIDENCE_KEY_UNAVAILABLE");
  return ref;
}
/** Input is already bounded canonical JSON. Compose without recursive serialization of deep content. */
export function evidenceMacInput(scope: EvidenceKeyScope, ref: EvidenceKeyRefV1, canonicalInput: string): Buffer {
  return Buffer.from(`{"input":${canonicalInput},"keyRef":${canonicalJson(ref)},"projectId":${canonicalJson(scope.projectId)},"storeId":${canonicalJson(scope.storeId)}}`, "utf8");
}
export function evidenceMac(provider: EvidenceKeyProvider, scope: EvidenceKeyScope, purpose: "original-input-commitment" | "redacted-content-fingerprint", ref: EvidenceKeyRefV1, domain: string, bytes: Uint8Array): string {
  let output: Uint8Array | undefined;
  try {
    output = evidenceProviderCall(() => provider.mac(scope, purpose, ref, domain, bytes));
    if (!(output instanceof Uint8Array) || output.byteLength !== 32) throw new RetainedEvidenceError("RETAINED_EVIDENCE_KEY_UNAVAILABLE");
    return Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString("hex");
  } finally { if (output instanceof Uint8Array) output.fill(0); }
}
