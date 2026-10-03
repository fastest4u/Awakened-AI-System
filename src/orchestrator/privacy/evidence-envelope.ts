import type { EvidenceKeyProvider, EvidenceKeyRefV1, WrappedEvidenceKeyV1 } from "./evidence-key-provider.js";
import type { RedactedEvidenceFrameV1 } from "./redaction.js";
import { boundedRetainedJson, retainedExactRecord, RetainedEvidenceError } from "./evidence-contracts.js";
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../serialization/canonical-json.js";
import { decodeEncryptedEvidenceItem, decodeEvidenceFrameMetadata, decodeEvidenceItemBinding, decodeRedactedEvidencePlaintext, decodeWrappedEvidenceKey, RETAINED_EVIDENCE_BUNDLE_BYTES, retainedEvidenceCipherHash as cipherHash, retainedEvidenceWrapHash as wrapHash, verifyRetainedEvidenceTransport } from "./retained-evidence-codec.js";
import { evidenceMac, evidenceMacInput, evidenceProviderCall, requireEvidenceKey } from "./evidence-key-provider.js";
import { RETAINED_EVIDENCE_REDACTED_DOMAIN } from "./retained-evidence-intent.js";
export type EvidenceItemBindingV1 = {
  readonly formatVersion: 1; readonly projectId: string; readonly vaultId: string; readonly storeId: string;
  readonly evidenceId: string; readonly eventId: string; readonly targetSessionId: string; readonly conversationId: string;
  readonly frameId: string; readonly mediaType: "text/plain; charset=utf-8" | "application/json"; readonly policyId: string; readonly policyVersion: string;
};
export type EvidenceFrameMetadataV1 = {
  readonly frameId: string; readonly ordinal: string; readonly role: "user" | "assistant" | "tool";
  readonly category: "user-message" | "assistant-message" | "tool-input" | "tool-output" | "child-report" | "artifact-reference" | "retrieval-feedback" | "user-correction";
  readonly occurredAt: string; readonly mediaType: "text/plain; charset=utf-8" | "application/json";
  readonly previousFrameId: string | null; readonly toolCorrelationId: string | null; readonly artifactHashes: string[];
};
export type EvidenceItemMetadataV1 = {
  readonly binding: EvidenceItemBindingV1; readonly frame: EvidenceFrameMetadataV1;
  readonly wrapKeyRef: EvidenceKeyRefV1; readonly fingerprintKeyRef: EvidenceKeyRefV1;
  readonly ciphertextHash: string; readonly wrappedKeyHash: string; readonly keyedFingerprint: string;
};
export type EncryptedEvidenceItemV1 = EvidenceItemMetadataV1 & {
  readonly formatVersion: 1; readonly algorithm: "AES-256-GCM"; readonly nonce: string; readonly tag: string; readonly ciphertext: string;
  readonly wrappedKey: WrappedEvidenceKeyV1;
};
export type EvidenceSealKeysV1 = { readonly wrapKeyRef: EvidenceKeyRefV1; readonly fingerprintKeyRef: EvidenceKeyRefV1 };
function equalHash(left: string, right: string): boolean { return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex")); }
function integrity(): never { throw new RetainedEvidenceError("INTEGRITY_FAILURE"); }
export function sealEvidenceItem(binding: EvidenceItemBindingV1, frame: RedactedEvidenceFrameV1, provider: EvidenceKeyProvider, keys?: EvidenceSealKeysV1): EncryptedEvidenceItemV1 {
  const admittedBinding = decodeEvidenceItemBinding(binding); const scope = Object.freeze({ projectId: admittedBinding.projectId, storeId: admittedBinding.storeId });
  const raw = retainedExactRecord(frame, ["frameId", "ordinal", "role", "category", "occurredAt", "mediaType", "content", "previousFrameId", "toolCorrelationId", "artifactHashes", "manifest"]);
  const { content, manifest, ...selectors } = raw; const metadata = decodeEvidenceFrameMetadata(selectors);
  if (admittedBinding.frameId !== metadata.frameId || admittedBinding.mediaType !== metadata.mediaType) integrity();
  const pinned = keys === undefined ? undefined : retainedExactRecord(keys, ["wrapKeyRef", "fingerprintKeyRef"]);
  const wrapKeyRef = requireEvidenceKey(provider, scope, "data-key-wrap", pinned === undefined ? evidenceProviderCall(() => provider.currentKey(scope, "data-key-wrap")) : pinned.wrapKeyRef as EvidenceKeyRefV1);
  const fingerprintKeyRef = requireEvidenceKey(provider, scope, "redacted-content-fingerprint", pinned === undefined ? evidenceProviderCall(() => provider.currentKey(scope, "redacted-content-fingerprint")) : pinned.fingerprintKeyRef as EvidenceKeyRefV1);
  let dataKey: Buffer | undefined; let plaintext: Buffer | undefined; let macInput: Buffer | undefined;
  try {
    const plain = decodeRedactedEvidencePlaintext({ content, manifest }, admittedBinding.mediaType);
    const canonical = boundedRetainedJson(plain, RETAINED_EVIDENCE_BUNDLE_BYTES).canonical; plaintext = Buffer.from(canonical);
    macInput = evidenceMacInput(scope, fingerprintKeyRef, canonical);
    const keyedFingerprint = evidenceMac(provider, scope, "redacted-content-fingerprint", fingerprintKeyRef, RETAINED_EVIDENCE_REDACTED_DOMAIN, macInput);
    dataKey = randomBytes(32); const nonce = randomBytes(12); const aad = Buffer.from(canonicalJson(admittedBinding));
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce, { authTagLength: 16 }); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); const tag = cipher.getAuthTag();
    const wrappedKey = evidenceProviderCall(() => decodeWrappedEvidenceKey(provider.wrap(scope, wrapKeyRef, dataKey!, aad)));
    if (canonicalJson(wrappedKey.keyRef) !== canonicalJson(wrapKeyRef)) throw new RetainedEvidenceError("RETAINED_EVIDENCE_KEY_UNAVAILABLE");
    const cipherMetadata = { formatVersion: 1 as const, algorithm: "AES-256-GCM" as const, binding: admittedBinding, frame: metadata, wrapKeyRef, fingerprintKeyRef, nonce: nonce.toString("base64url"), tag: tag.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
    return decodeEncryptedEvidenceItem({ ...cipherMetadata, wrapKeyRef, fingerprintKeyRef, wrappedKey, ciphertextHash: cipherHash(cipherMetadata), wrappedKeyHash: wrapHash(wrappedKey), keyedFingerprint });
  } catch (error) {
    if (error instanceof RetainedEvidenceError) throw error;
    throw new RetainedEvidenceError("RETAINED_EVIDENCE_UNAVAILABLE");
  } finally { dataKey?.fill(0); plaintext?.fill(0); macInput?.fill(0); }
}
export function openEvidenceItem(binding: EvidenceItemBindingV1, item: EncryptedEvidenceItemV1, provider: EvidenceKeyProvider): RedactedEvidenceFrameV1 {
  let expected: EvidenceItemBindingV1; let stored: EncryptedEvidenceItemV1;
  try {
    expected = decodeEvidenceItemBinding(binding); stored = verifyRetainedEvidenceTransport(item);
    if (canonicalJson(expected) !== canonicalJson(stored.binding)) integrity();
  } catch { return integrity(); }
  const scope = Object.freeze({ projectId: expected.projectId, storeId: expected.storeId });
  requireEvidenceKey(provider, scope, "data-key-wrap", stored.wrapKeyRef); requireEvidenceKey(provider, scope, "redacted-content-fingerprint", stored.fingerprintKeyRef);
  let dataKey: Uint8Array | undefined; let first: Buffer | undefined; let last: Buffer | undefined; let plaintext: Buffer | undefined; let canonicalBytes: Buffer | undefined; let macInput: Buffer | undefined;
  try {
    const aad = Buffer.from(canonicalJson(expected));
    // After recorded-key status checks, unwrap/authentication failures are opaque integrity refusals.
    try { dataKey = provider.unwrap(scope, stored.wrappedKey, aad); } catch { integrity(); }
    if (!(dataKey instanceof Uint8Array) || dataKey.byteLength !== 32) integrity();
    const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(stored.nonce, "base64url"), { authTagLength: 16 }); decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(stored.tag, "base64url"));
    first = decipher.update(Buffer.from(stored.ciphertext, "base64url")); last = decipher.final();
    // Nothing from update() escapes until final() authenticates the entire item.
    plaintext = Buffer.concat([first, last]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8")); const plain = decodeRedactedEvidencePlaintext(parsed, expected.mediaType);
    const canonical = boundedRetainedJson(plain, RETAINED_EVIDENCE_BUNDLE_BYTES).canonical;
    canonicalBytes = Buffer.from(canonical, "utf8");
    if (!canonicalBytes.equals(plaintext)) integrity();
    macInput = evidenceMacInput(scope, stored.fingerprintKeyRef, canonical);
    const fingerprint = evidenceMac(provider, scope, "redacted-content-fingerprint", stored.fingerprintKeyRef, RETAINED_EVIDENCE_REDACTED_DOMAIN, macInput);
    if (!equalHash(fingerprint, stored.keyedFingerprint)) integrity();
    return Object.freeze({ ...stored.frame, content: plain.content, manifest: plain.manifest }) as RedactedEvidenceFrameV1;
  } catch (error) {
    if (error instanceof RetainedEvidenceError && error.code === "RETAINED_EVIDENCE_KEY_UNAVAILABLE") throw error;
    return integrity();
  } finally { if (dataKey instanceof Uint8Array) dataKey.fill(0); first?.fill(0); last?.fill(0); plaintext?.fill(0); canonicalBytes?.fill(0); macInput?.fill(0); }
}
