import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
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

export type LifecycleTestKeyStatus = "available" | "revoked" | "unavailable";

export interface LifecycleTestKeyBrokerCall {
  readonly operation: "currentKey" | "status" | "mac" | "verify" | "fingerprint" | "seal" | "open";
  readonly projectId: string;
  readonly storeId: string;
  readonly purpose: CapabilityKeyPurpose;
  readonly keyId: string;
  readonly domain: string | null;
  readonly byteLength: number | null;
}

export interface LifecycleTestKeyBrokerFingerprintMatcher {
  readonly projectId?: string;
  readonly storeId?: string;
  readonly purpose?: CapabilityKeyPurpose;
  readonly keyId?: string;
  readonly domain?: string;
}

export interface LifecycleTestKeyBrokerFingerprintFailure {
  readonly matcher?: LifecycleTestKeyBrokerFingerprintMatcher;
  readonly code?: string;
  readonly message?: string;
}

export interface LifecycleTestKeyBrokerOptions {
  /** The seed is hashed into private key material and is never sent to a child. */
  readonly seed?: string;
}

interface KeyRecord {
  readonly keyId: string;
  readonly bytes: Buffer;
  status: LifecycleTestKeyStatus;
}

interface ScopeState {
  readonly keys: Map<string, KeyRecord>;
  readonly currentByPurpose: Map<CapabilityKeyPurpose, string>;
  readonly nextOrdinalByPurpose: Map<CapabilityKeyPurpose, number>;
}

interface FingerprintFailureRecord {
  readonly matcher: LifecycleTestKeyBrokerFingerprintMatcher;
  readonly code: string;
  readonly message: string;
}

const BROKER_DOMAIN = Buffer.from("project-memory/task18-fixture-key-broker/v1\n", "utf8");

function scopeKey(scope: KeyScope): string {
  return `${scope.projectId}\0${scope.storeId}`;
}

function assertScope(scope: KeyScope): void {
  if (typeof scope.projectId !== "string" || scope.projectId.length === 0
    || typeof scope.storeId !== "string" || scope.storeId.length === 0) {
    throw new TypeError("key broker scope is invalid");
  }
}

function assertBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("key broker bytes must be Uint8Array");
}

function keyPurposeFromInput(input: { readonly purpose: CapabilityKeyPurpose }): CapabilityKeyPurpose {
  return input.purpose;
}

function failureError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export class LifecycleTestKeyBroker implements CapabilityKeyProvider {
  readonly calls: LifecycleTestKeyBrokerCall[] = [];
  readonly #scopes = new Map<string, ScopeState>();
  readonly #fingerprintFailures: FingerprintFailureRecord[] = [];
  #masterKey: Buffer;
  #shutdown = false;
  #zeroized = false;
  #keyMaterialCreated = 0;

  constructor(options: LifecycleTestKeyBrokerOptions = {}) {
    const seed = Buffer.from(options.seed ?? "task18-default-fixture-seed", "utf8");
    try {
      this.#masterKey = createHash("sha256").update(BROKER_DOMAIN).update(seed).digest();
    } finally {
      seed.fill(0);
    }
  }

  get isShutdown(): boolean {
    return this.#shutdown;
  }

  get keyMaterialZeroized(): boolean {
    return this.#zeroized;
  }

  get liveKeyMaterialCount(): number {
    return this.#scopes.size === 0
      ? 0
      : [...this.#scopes.values()].reduce((count, state) => count + state.keys.size, 0);
  }

  get keyMaterialCreated(): number {
    return this.#keyMaterialCreated;
  }

  currentKey(scope: KeyScope, purpose: CapabilityKeyPurpose): CapabilityKeyRef {
    this.#assertOpen();
    assertScope(scope);
    const state = this.#state(scope);
    const existing = state.currentByPurpose.get(purpose);
    if (existing !== undefined) {
      const record = state.keys.get(this.#compoundKey(purpose, existing))!;
      this.#record("currentKey", scope, purpose, record.keyId, null, null);
      this.#assertAvailable(record);
      return Object.freeze({ keyId: record.keyId });
    }
    const created = this.#createKey(scope, purpose, state);
    this.#record("currentKey", scope, purpose, created.keyId, null, null);
    return Object.freeze({ keyId: created.keyId });
  }

  status(scope: KeyScope, purpose: CapabilityKeyPurpose, keyId: string): LifecycleTestKeyStatus {
    this.#assertOpen();
    assertScope(scope);
    const record = this.#state(scope).keys.get(this.#compoundKey(purpose, keyId));
    this.#record("status", scope, purpose, keyId, null, null);
    return record?.status ?? "unavailable";
  }

  mac(input: KeyedMacInput): Uint8Array {
    this.#assertOpen();
    assertBytes(input.bytes);
    const record = this.#recordForInput(input);
    this.#record("mac", input, input.purpose, input.keyId, input.domain, input.bytes.byteLength);
    return this.#mac(record.bytes, input.domain, input.bytes);
  }

  verify(input: KeyedVerifyInput): boolean {
    this.#assertOpen();
    assertBytes(input.bytes);
    assertBytes(input.mac);
    const record = this.#recordForInput(input);
    this.#record("verify", input, input.purpose, input.keyId, input.domain, input.bytes.byteLength);
    const expected = this.#mac(record.bytes, input.domain, input.bytes);
    const supplied = Buffer.from(input.mac);
    try {
      return supplied.byteLength === expected.byteLength && timingSafeEqual(expected, supplied);
    } finally {
      expected.fill(0);
      supplied.fill(0);
    }
  }

  fingerprint(input: KeyedFingerprintInput): string {
    this.#assertOpen();
    assertBytes(input.bytes);
    const record = this.#recordForInput(input);
    this.#record("fingerprint", input, input.purpose, input.keyId, input.domain, input.bytes.byteLength);
    const failure = this.#fingerprintFailures.find((candidate) => this.#matches(candidate.matcher, input));
    if (failure !== undefined) throw failureError(failure.code, failure.message);
    const digest = this.#mac(record.bytes, input.domain, input.bytes);
    try {
      return digest.toString("hex");
    } finally {
      digest.fill(0);
    }
  }

  seal(input: KeyedSealInput): SealedValueV1 {
    this.#assertOpen();
    assertBytes(input.bytes);
    const record = this.#recordForInput(input);
    this.#record("seal", input, input.purpose, input.keyId, input.domain, input.bytes.byteLength);
    const nonce = createHmac("sha256", record.bytes)
      .update("nonce\0", "utf8")
      .update(input.domain, "utf8")
      .update(input.bytes)
      .digest()
      .subarray(0, 12);
    const cipher = createCipheriv("aes-256-gcm", record.bytes, nonce);
    const ciphertext = Buffer.concat([cipher.update(input.bytes), cipher.final()]);
    const tag = cipher.getAuthTag();
    try {
      return Object.freeze({
        version: 1,
        keyId: input.keyId,
        algorithm: "aes-256-gcm",
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: tag.toString("base64url"),
      });
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      tag.fill(0);
    }
  }

  open(input: KeyedOpenInput): Uint8Array {
    this.#assertOpen();
    const record = this.#recordForInput(input);
    this.#record("open", input, input.purpose, input.keyId, input.domain, null);
    if (
      input.sealed.version !== 1
      || input.sealed.keyId !== input.keyId
      || input.sealed.algorithm !== "aes-256-gcm"
    ) {
      throw failureError("TEST_SEALED_VALUE_INVALID", "sealed value identity is invalid");
    }
    const nonce = Buffer.from(input.sealed.nonce, "base64url");
    const ciphertext = Buffer.from(input.sealed.ciphertext, "base64url");
    const suppliedTag = Buffer.from(input.sealed.tag, "base64url");
    try {
      if (nonce.byteLength !== 12 || suppliedTag.byteLength !== 16) {
        throw failureError("TEST_SEALED_VALUE_INVALID", "sealed value authentication failed");
      }
      const decipher = createDecipheriv("aes-256-gcm", record.bytes, nonce);
      decipher.setAuthTag(suppliedTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      suppliedTag.fill(0);
    }
  }

  rotate(scope: KeyScope, purpose: CapabilityKeyPurpose): CapabilityKeyRef;
  rotate(purpose: CapabilityKeyPurpose, scope: KeyScope): CapabilityKeyRef;
  rotate(first: KeyScope | CapabilityKeyPurpose, second: CapabilityKeyPurpose | KeyScope): CapabilityKeyRef {
    this.#assertOpen();
    const [scope, purpose] = typeof first === "string"
      ? [second as KeyScope, first]
      : [first, second as CapabilityKeyPurpose];
    assertScope(scope);
    const state = this.#state(scope);
    const created = this.#createKey(scope, purpose, state);
    state.currentByPurpose.set(purpose, created.keyId);
    return Object.freeze({ keyId: created.keyId });
  }

  setHistoricalStatus(
    scope: KeyScope,
    purpose: CapabilityKeyPurpose,
    keyId: string,
    status: LifecycleTestKeyStatus,
  ): void {
    this.#assertOpen();
    assertScope(scope);
    const record = this.#state(scope).keys.get(this.#compoundKey(purpose, keyId));
    if (record === undefined) throw failureError("TEST_KEY_UNKNOWN", `unknown fixture key ${keyId}`);
    record.status = status;
  }

  setKeyStatus(
    scope: KeyScope,
    purpose: CapabilityKeyPurpose,
    keyId: string,
    status: LifecycleTestKeyStatus,
  ): void {
    this.setHistoricalStatus(scope, purpose, keyId, status);
  }

  markUnavailable(scope: KeyScope, purpose: CapabilityKeyPurpose, keyId: string): void {
    this.setHistoricalStatus(scope, purpose, keyId, "unavailable");
  }

  revoke(scope: KeyScope, purpose: CapabilityKeyPurpose, keyId: string): void {
    this.setHistoricalStatus(scope, purpose, keyId, "revoked");
  }

  injectFingerprintFailure(
    matcherOrFailure: LifecycleTestKeyBrokerFingerprintMatcher | LifecycleTestKeyBrokerFingerprintFailure = {},
    error?: Error | string,
  ): () => void {
    this.#assertOpen();
    const failure: LifecycleTestKeyBrokerFingerprintFailure =
      "matcher" in matcherOrFailure || "code" in matcherOrFailure || "message" in matcherOrFailure
        ? matcherOrFailure as LifecycleTestKeyBrokerFingerprintFailure
        : { matcher: matcherOrFailure as LifecycleTestKeyBrokerFingerprintMatcher };
    const record: FingerprintFailureRecord = {
      matcher: failure.matcher ?? {},
      code: failure.code ?? (error instanceof Error && "code" in error
        && typeof (error as Error & { code?: unknown }).code === "string"
        ? (error as Error & { code: string }).code
        : "TEST_FINGERPRINT_FAILURE"),
      message: failure.message ?? (error instanceof Error ? error.message : error ?? "injected fingerprint failure"),
    };
    this.#fingerprintFailures.push(record);
    return () => {
      const index = this.#fingerprintFailures.indexOf(record);
      if (index >= 0) this.#fingerprintFailures.splice(index, 1);
    };
  }

  setFingerprintFailure(failure: LifecycleTestKeyBrokerFingerprintFailure | null): () => void {
    if (failure === null) {
      this.clearFingerprintFailures();
      return () => undefined;
    }
    return this.injectFingerprintFailure(failure);
  }

  clearFingerprintFailures(): void {
    this.#fingerprintFailures.splice(0);
  }

  shutdown(): void {
    if (this.#shutdown) return;
    for (const state of this.#scopes.values()) {
      for (const record of state.keys.values()) record.bytes.fill(0);
    }
    this.#masterKey.fill(0);
    this.#scopes.clear();
    this.#fingerprintFailures.splice(0);
    this.#shutdown = true;
    this.#zeroized = true;
  }

  close(): void {
    this.shutdown();
  }

  #state(scope: KeyScope): ScopeState {
    const identity = scopeKey(scope);
    const existing = this.#scopes.get(identity);
    if (existing !== undefined) return existing;
    const created: ScopeState = {
      keys: new Map(),
      currentByPurpose: new Map(),
      nextOrdinalByPurpose: new Map(),
    };
    this.#scopes.set(identity, created);
    return created;
  }

  #createKey(scope: KeyScope, purpose: CapabilityKeyPurpose, state: ScopeState): KeyRecord {
    const ordinal = state.nextOrdinalByPurpose.get(purpose) ?? 1;
    state.nextOrdinalByPurpose.set(purpose, ordinal + 1);
    const keyId = `fixture-${purpose}-${String(ordinal).padStart(3, "0")}`;
    const bytes = createHmac("sha256", this.#masterKey)
      .update(scope.projectId, "utf8")
      .update("\0", "utf8")
      .update(scope.storeId, "utf8")
      .update("\0", "utf8")
      .update(purpose, "utf8")
      .update("\0", "utf8")
      .update(keyId, "utf8")
      .digest();
    const record: KeyRecord = { keyId, bytes, status: "available" };
    state.keys.set(this.#compoundKey(purpose, keyId), record);
    state.currentByPurpose.set(purpose, keyId);
    this.#keyMaterialCreated += 1;
    return record;
  }

  #recordForInput(input: KeyedMacInput | KeyedOpenInput): KeyRecord {
    assertScope(input);
    const record = this.#state(input).keys.get(this.#compoundKey(keyPurposeFromInput(input), input.keyId));
    if (record === undefined) throw failureError("TEST_KEY_UNAVAILABLE", `unknown fixture key ${input.keyId}`);
    this.#assertAvailable(record);
    return record;
  }

  #assertAvailable(record: KeyRecord): void {
    if (record.status === "revoked") throw failureError("TEST_KEY_REVOKED", `fixture key ${record.keyId} is revoked`);
    if (record.status !== "available") {
      throw failureError("TEST_KEY_UNAVAILABLE", `fixture key ${record.keyId} is unavailable`);
    }
  }

  #assertOpen(): void {
    if (this.#shutdown) throw failureError("TEST_KEY_BROKER_CLOSED", "fixture key broker is shut down");
  }

  #compoundKey(purpose: CapabilityKeyPurpose, keyId: string): string {
    return `${purpose}\0${keyId}`;
  }

  #mac(key: Uint8Array, domain: string, bytes: Uint8Array): Buffer {
    return createHmac("sha256", key)
      .update(domain, "utf8")
      .update(Buffer.from([0]))
      .update(bytes)
      .digest();
  }

  #matches(matcher: LifecycleTestKeyBrokerFingerprintMatcher, input: KeyedFingerprintInput): boolean {
    return (matcher.projectId === undefined || matcher.projectId === input.projectId)
      && (matcher.storeId === undefined || matcher.storeId === input.storeId)
      && (matcher.purpose === undefined || matcher.purpose === input.purpose)
      && (matcher.keyId === undefined || matcher.keyId === input.keyId)
      && (matcher.domain === undefined || matcher.domain === input.domain);
  }

  #record(
    operation: LifecycleTestKeyBrokerCall["operation"],
    input: KeyScope,
    purpose: CapabilityKeyPurpose,
    keyId: string,
    domain: string | null,
    byteLength: number | null,
  ): void {
    this.calls.push(Object.freeze({
      operation,
      projectId: input.projectId,
      storeId: input.storeId,
      purpose,
      keyId,
      domain,
      byteLength,
    }));
  }
}

export type { CapabilityKeyPurpose, CapabilityKeyRef, KeyScope, SealedValueV1 };
