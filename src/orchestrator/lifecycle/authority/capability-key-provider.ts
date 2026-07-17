export type CapabilityKind =
  | "root-session-handle"
  | "root-resume-token"
  | "child-session-handle";

export const PENDING_AUTHORIZATION_ENCRYPTION_PURPOSE = "pending-authorization-encryption";

export type CapabilityKeyPurpose =
  | CapabilityKind
  | "child-binding-grant"
  | "continuity-index"
  | "evidence-fingerprint"
  | "validation-output-fingerprint"
  | "materialization-fingerprint"
  | "recovery-approval"
  | "abandonment-approval"
  | typeof PENDING_AUTHORIZATION_ENCRYPTION_PURPOSE;

export interface KeyScope {
  readonly projectId: string;
  readonly storeId: string;
}

export interface CapabilityKeyRef {
  readonly keyId: string;
}

interface KeyedOperationInput extends KeyScope {
  readonly purpose: CapabilityKeyPurpose;
  readonly keyId: string;
  readonly domain: string;
}

export interface KeyedMacInput extends KeyedOperationInput {
  readonly bytes: Uint8Array;
}

export interface KeyedVerifyInput extends KeyedMacInput {
  readonly mac: Uint8Array;
}

export interface KeyedFingerprintInput extends KeyedMacInput {}

export interface KeyedSealInput extends KeyedMacInput {}

export interface SealedValueV1 {
  readonly version: 1;
  readonly keyId: string;
  readonly algorithm: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface KeyedOpenInput extends KeyedOperationInput {
  readonly sealed: SealedValueV1;
}

export interface CapabilityKeyProvider {
  currentKey(scope: KeyScope, purpose: CapabilityKeyPurpose): CapabilityKeyRef;
  status(
    scope: KeyScope,
    purpose: CapabilityKeyPurpose,
    keyId: string,
  ): "available" | "revoked" | "unavailable";
  mac(input: KeyedMacInput): Uint8Array;
  verify(input: KeyedVerifyInput): boolean;
  fingerprint(input: KeyedFingerprintInput): string;
  /** The provider must not retain `input.bytes`; the caller zeroizes them after return. */
  seal(input: KeyedSealInput): SealedValueV1;
  /** Returns fresh, mutable, caller-owned plaintext bytes that will be zeroized after use. */
  open(input: KeyedOpenInput): Uint8Array;
}
