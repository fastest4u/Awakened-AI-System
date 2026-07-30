import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../../src/orchestrator/serialization/canonical-json.js";
import type {
  CapabilityKeyProvider,
  CapabilityKeyPurpose,
  CapabilityKeyRef,
  KeyScope,
  KeyedFingerprintInput,
  KeyedMacInput,
  KeyedOpenInput,
  KeyedSealInput,
  KeyedVerifyInput,
  SealedValueV1,
} from "../../src/orchestrator/lifecycle/authority/capability-key-provider.js";
import { SecretString } from "../../src/orchestrator/lifecycle/authority/redacted-secret.js";

const PROOF_DOMAIN = Buffer.from("pm-lifecycle-command-proof-v1", "utf8");
const PROOF_DIGEST_DOMAIN = Buffer.from("project-memory/proof-digest/v1\n", "utf8");
const ZERO_SALT = Buffer.alloc(32, 0);

export interface ProviderCall {
  readonly operation: "currentKey" | "status" | "mac" | "verify" | "fingerprint" | "seal" | "open";
  readonly projectId: string;
  readonly storeId: string;
  readonly purpose: CapabilityKeyPurpose;
  readonly keyId: string;
  readonly domain: string | null;
  readonly byteLength: number | null;
}

const DEFAULT_SCOPE: KeyScope = Object.freeze({
  projectId: "00000000-0000-4000-8000-000000000001",
  storeId: "00000000-0000-4000-8000-000000000003",
});

function keyIdentity(purpose: CapabilityKeyPurpose): string {
  return `test-${purpose}-key-v1`;
}

function deriveFixtureKey(
  scope: KeyScope,
  purpose: CapabilityKeyPurpose,
  keyId: string,
): Buffer {
  return createHash("sha256")
    .update("project-memory/test-provider-key/v1\n", "utf8")
    .update(scope.projectId, "utf8")
    .update("\n", "utf8")
    .update(scope.storeId, "utf8")
    .update("\n", "utf8")
    .update(purpose, "utf8")
    .update("\n", "utf8")
    .update(keyId, "utf8")
    .digest();
}

function providerMac(
  scope: KeyScope,
  purpose: CapabilityKeyPurpose,
  keyId: string,
  domain: string,
  bytes: Uint8Array,
): Buffer {
  const key = deriveFixtureKey(scope, purpose, keyId);
  try {
    return createHmac("sha256", key)
      .update(domain, "utf8")
      .update(Buffer.from([0]))
      .update(bytes)
      .digest();
  } finally {
    key.fill(0);
  }
}

export class DeterministicCapabilityKeyProvider implements CapabilityKeyProvider {
  readonly calls: ProviderCall[] = [];
  readonly fingerprintInputs: Uint8Array[] = [];
  readonly #statuses = new Map<string, "available" | "revoked" | "unavailable">();

  currentKey(scope: KeyScope, purpose: CapabilityKeyPurpose): CapabilityKeyRef {
    const keyId = keyIdentity(purpose);
    this.calls.push({
      operation: "currentKey",
      projectId: scope.projectId,
      storeId: scope.storeId,
      purpose,
      keyId,
      domain: null,
      byteLength: null,
    });
    return Object.freeze({ keyId });
  }

  status(scope: KeyScope, purpose: CapabilityKeyPurpose, keyId: string): "available" | "revoked" | "unavailable" {
    this.calls.push({
      operation: "status",
      projectId: scope.projectId,
      storeId: scope.storeId,
      purpose,
      keyId,
      domain: null,
      byteLength: null,
    });
    return this.#statuses.get(`${scope.projectId}\0${scope.storeId}\0${purpose}\0${keyId}`)
      ?? (keyId === keyIdentity(purpose) ? "available" : "unavailable");
  }

  setStatus(
    purpose: CapabilityKeyPurpose,
    keyId: string,
    status: "available" | "revoked" | "unavailable",
    scope: KeyScope = DEFAULT_SCOPE,
  ): void {
    this.#statuses.set(`${scope.projectId}\0${scope.storeId}\0${purpose}\0${keyId}`, status);
  }

  mac(input: KeyedMacInput): Uint8Array {
    this.#record("mac", input);
    return providerMac(input, input.purpose, input.keyId, input.domain, input.bytes);
  }

  verify(input: KeyedVerifyInput): boolean {
    this.#record("verify", input);
    const actual = providerMac(input, input.purpose, input.keyId, input.domain, input.bytes);
    const candidate = input.mac.byteLength === actual.byteLength
      ? Buffer.from(input.mac)
      : Buffer.alloc(actual.byteLength, 0);
    try {
      return timingSafeEqual(actual, candidate) && input.mac.byteLength === actual.byteLength;
    } finally {
      actual.fill(0);
      candidate.fill(0);
    }
  }

  fingerprint(input: KeyedFingerprintInput): string {
    this.fingerprintInputs.push(input.bytes);
    this.#record("fingerprint", input);
    const digest = providerMac(input, input.purpose, input.keyId, input.domain, input.bytes);
    try {
      return digest.toString("hex");
    } finally {
      digest.fill(0);
    }
  }

  seal(input: KeyedSealInput): SealedValueV1 {
    this.#record("seal", input);
    const nonce = createHash("sha256")
      .update(input.projectId, "utf8")
      .update(input.storeId, "utf8")
      .update(input.domain, "utf8")
      .update(input.bytes)
      .digest()
      .subarray(0, 12);
    const key = deriveFixtureKey(input, input.purpose, input.keyId);
    const ciphertext = Buffer.alloc(input.bytes.byteLength);
    try {
      for (let index = 0; index < ciphertext.length; index += 1) {
        ciphertext[index] = input.bytes[index]! ^ key[index % key.length]!;
      }
      const tag = providerMac(input, input.purpose, input.keyId, input.domain, ciphertext);
      try {
        return Object.freeze({
          version: 1,
          keyId: input.keyId,
          algorithm: "test-xor-hmac-sha256",
          nonce: nonce.toString("base64url"),
          ciphertext: ciphertext.toString("base64url"),
          tag: tag.toString("base64url"),
        });
      } finally {
        tag.fill(0);
      }
    } finally {
      nonce.fill(0);
      key.fill(0);
      ciphertext.fill(0);
    }
  }

  open(input: KeyedOpenInput): Uint8Array {
    this.calls.push({
      operation: "open",
      projectId: input.projectId,
      storeId: input.storeId,
      purpose: input.purpose,
      keyId: input.keyId,
      domain: input.domain,
      byteLength: null,
    });
    const ciphertext = Buffer.from(input.sealed.ciphertext, "base64url");
    const expected = providerMac(input, input.purpose, input.keyId, input.domain, ciphertext);
    const supplied = Buffer.from(input.sealed.tag, "base64url");
    const key = deriveFixtureKey(input, input.purpose, input.keyId);
    try {
      if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
        throw new Error("TEST_SEALED_VALUE_INVALID");
      }
      const plaintext = Buffer.alloc(ciphertext.length);
      for (let index = 0; index < plaintext.length; index += 1) {
        plaintext[index] = ciphertext[index]! ^ key[index % key.length]!;
      }
      return plaintext;
    } finally {
      ciphertext.fill(0);
      expected.fill(0);
      supplied.fill(0);
      key.fill(0);
    }
  }

  #record(
    operation: "mac" | "verify" | "fingerprint" | "seal",
    input: KeyedMacInput | KeyedVerifyInput | KeyedFingerprintInput | KeyedSealInput,
  ): void {
    this.calls.push({
      operation,
      projectId: input.projectId,
      storeId: input.storeId,
      purpose: input.purpose,
      keyId: input.keyId,
      domain: input.domain,
      byteLength: input.bytes.byteLength,
    });
  }
}

export interface SyntheticProofReference {
  readonly bearer: SecretString;
  readonly expectedProofMac: Buffer;
  readonly expectedProofDigest: string;
  destroy(): void;
}

export function syntheticProofReference(target: unknown): SyntheticProofReference {
  const keyIdBytes = Buffer.from("synthetic-reference-key", "utf8");
  const claimBytes = Buffer.from(canonicalJson({
    capabilityVersion: 1,
    keyId: "synthetic-reference-key",
    purpose: "deliberately-not-issued",
  }), "utf8");
  const invalidCapabilityMac = Buffer.alloc(32, 0x5a);
  const bearerBytes = Buffer.from(
    `pmcap1.${keyIdBytes.toString("base64url")}.${claimBytes.toString("base64url")}.${invalidCapabilityMac.toString("base64url")}`,
    "utf8",
  );
  const derivedKey = Buffer.from(hkdfSync(
    "sha256",
    bearerBytes,
    ZERO_SALT,
    PROOF_DOMAIN,
    32,
  ));
  const targetBytes = Buffer.from(canonicalJson(target), "utf8");
  const expectedProofMac = createHmac("sha256", derivedKey)
    .update(PROOF_DOMAIN)
    .update(targetBytes)
    .digest();
  const expectedProofDigest = createHash("sha256")
    .update(PROOF_DIGEST_DOMAIN)
    .update(expectedProofMac)
    .digest("hex");
  const bearer = SecretString.from(bearerBytes.toString("utf8"));

  keyIdBytes.fill(0);
  claimBytes.fill(0);
  invalidCapabilityMac.fill(0);
  bearerBytes.fill(0);
  derivedKey.fill(0);
  targetBytes.fill(0);

  return {
    bearer,
    expectedProofMac,
    expectedProofDigest,
    destroy(): void {
      expectedProofMac.fill(0);
      bearer.destroy();
    },
  };
}
