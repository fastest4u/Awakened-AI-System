import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename as pathBasename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../../serialization/canonical-json.js";
import { fsyncDirectory, type DirectorySync } from "../../identity/directory-durability.js";
import { LifecycleError } from "../errors.js";
import type {
  CapabilityKeyProvider,
  KeyScope,
  SealedValueV1,
} from "./capability-key-provider.js";
import {
  decodePendingSemanticCommandRecord,
  destroyPendingAuthorization,
  encodePendingSemanticCommandRecord,
  type PendingAuthorizationStore,
  type PendingSemanticCommandRecordV1,
} from "./pending-authorization.store.js";

export const PENDING_AUTHORIZATION_SEAL_DOMAIN = "pm-lifecycle-pending-authorization-v1";

export interface PendingAuthorizationEnvelopeV1 {
  readonly version: 1;
  readonly keyId: string;
  readonly algorithm: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export type PendingAuthorizationStoreFaultPoint =
  | "after-temp-fsync"
  | "before-claim-publish"
  | "before-replace"
  | "after-replace"
  | "after-get-final-observed"
  | "after-list-final-observed"
  | "after-delete-final-observed";

export interface EncryptedPendingAuthorizationStoreOptions {
  readonly privateStateRoot: string;
  readonly scope: KeyScope;
  readonly keyProvider: CapabilityKeyProvider;
  readonly syncDirectory?: DirectorySync;
  readonly faultInjector?: (point: PendingAuthorizationStoreFaultPoint) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const FINAL_NAME = /^([0-9a-f]{64})\.json$/;
const CLAIM_NAME = /^([0-9a-f]{64})\.claim$/;
const TEMP_NAME = /^\.([0-9a-f]{64})\.([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const MAX_CIPHERTEXT_CHARS = 3 * 1024 * 1024;
const MAX_RECONCILE_ATTEMPTS = 64;

function invalid(): never {
  throw new LifecycleError("SESSION_CAPABILITY_INVALID");
}

function unavailable(): never {
  throw new LifecycleError("SESSION_CAPABILITY_KEY_UNAVAILABLE");
}

function conflict(): never {
  throw new LifecycleError("IDEMPOTENCY_CONFLICT");
}

class FinalDisappearedDuringRead extends Error {}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function processIsAlive(pidText: string): boolean {
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) invalid();
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function publicationRace(error: unknown): boolean {
  return new Set(["EACCES", "EEXIST", "ENOENT", "EPERM"]).has(errorCode(error) ?? "");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function contained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot);
}

function canonicalRoot(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || !samePath(resolve(path), path)) invalid();
  try {
    const authority = lstatSync(path);
    if (!authority.isDirectory() || authority.isSymbolicLink()) invalid();
    const canonical = resolve(realpathSync.native(path));
    if (!samePath(canonical, path)) invalid();
    return canonical;
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    return invalid();
  }
}

function canonicalHash(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\n", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function strictEnvelope(value: unknown): PendingAuthorizationEnvelopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const expected = ["algorithm", "ciphertext", "keyId", "nonce", "tag", "version"];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string")
    || Object.keys(descriptors).sort().some((key, index) => key !== expected[index])
    || Object.keys(descriptors).length !== expected.length
  ) invalid();
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || typeof record.keyId !== "string"
    || record.keyId.length === 0
    || Array.from(record.keyId).length > 256
    || typeof record.algorithm !== "string"
    || record.algorithm.length === 0
    || Array.from(record.algorithm).length > 128
    || typeof record.nonce !== "string"
    || record.nonce.length === 0
    || record.nonce.length > 1_024
    || !BASE64URL.test(record.nonce)
    || typeof record.ciphertext !== "string"
    || record.ciphertext.length === 0
    || record.ciphertext.length > MAX_CIPHERTEXT_CHARS
    || !BASE64URL.test(record.ciphertext)
    || typeof record.tag !== "string"
    || record.tag.length === 0
    || record.tag.length > 1_024
    || !BASE64URL.test(record.tag)
  ) invalid();
  for (const segment of [record.nonce, record.ciphertext, record.tag]) {
    const bytes = Buffer.from(segment as string, "base64url");
    try {
      if (bytes.length === 0 || bytes.toString("base64url") !== segment) invalid();
    } finally {
      bytes.fill(0);
    }
  }
  return Object.freeze({
    version: 1,
    keyId: record.keyId,
    algorithm: record.algorithm,
    nonce: record.nonce,
    ciphertext: record.ciphertext,
    tag: record.tag,
  });
}

function validateProvider(provider: CapabilityKeyProvider): void {
  if (
    provider === undefined
    || typeof provider.currentKey !== "function"
    || typeof provider.status !== "function"
    || typeof provider.seal !== "function"
    || typeof provider.open !== "function"
  ) unavailable();
}

export class EncryptedPendingAuthorizationStore implements PendingAuthorizationStore {
  readonly privateStateRoot: string;
  readonly #scope: KeyScope;
  readonly #scopeDirectory: string;
  readonly #provider: CapabilityKeyProvider;
  readonly #syncDirectory: DirectorySync;
  readonly #faultInjector: ((point: PendingAuthorizationStoreFaultPoint) => void) | undefined;

  constructor(options: EncryptedPendingAuthorizationStoreOptions) {
    if (
      options === undefined
      || typeof options !== "object"
      || options === null
      || !UUID.test(options.scope?.projectId ?? "")
      || !UUID.test(options.scope?.storeId ?? "")
    ) invalid();
    validateProvider(options.keyProvider);
    this.privateStateRoot = canonicalRoot(options.privateStateRoot);
    this.#scope = Object.freeze({
      projectId: options.scope.projectId,
      storeId: options.scope.storeId,
    });
    this.#scopeDirectory = join(
      this.privateStateRoot,
      canonicalHash("project-memory/pending-authorization-scope/v1", this.#scope),
    );
    if (!contained(this.privateStateRoot, this.#scopeDirectory)) invalid();
    this.#provider = options.keyProvider;
    this.#syncDirectory = options.syncDirectory ?? fsyncDirectory;
    this.#faultInjector = options.faultInjector;
  }

  async put(record: PendingSemanticCommandRecordV1): Promise<void> {
    const plain = encodePendingSemanticCommandRecord(record);
    if (plain.projectId !== this.#scope.projectId || plain.storeId !== this.#scope.storeId) invalid();
    const directory = this.#ensureScopeDirectory();
    const paths = this.#paths(plain.commandId, plain.idempotencyKey);
    this.#recoverClaim(paths.final, paths.claim, directory);
    if (existsSync(paths.final)) {
      if (this.#sameRecord(paths.final, plain)) return;
      conflict();
    }

    const plaintext = Buffer.from(canonicalJson(plain), "utf8");
    let envelope: PendingAuthorizationEnvelopeV1;
    try {
      let keyId: string;
      try {
        keyId = this.#provider.currentKey(this.#scope, "pending-authorization-encryption").keyId;
      } catch {
        return unavailable();
      }
      try {
        envelope = strictEnvelope(this.#provider.seal({
          ...this.#scope,
          purpose: "pending-authorization-encryption",
          keyId,
          domain: PENDING_AUTHORIZATION_SEAL_DOMAIN,
          bytes: plaintext,
        }));
      } catch (error) {
        if (error instanceof LifecycleError) throw error;
        return unavailable();
      }
      if (envelope.keyId !== keyId) invalid();
    } finally {
      plaintext.fill(0);
    }

    const envelopeBytes = Buffer.from(canonicalJson(envelope), "utf8");
    const temporary = join(
      directory,
      `.${paths.basename}.${process.pid}.${randomUUID()}.tmp`,
    );
    let temporaryExists = false;
    let handle: number | undefined;
    try {
      try {
        handle = openSync(temporary, "wx", 0o600);
        temporaryExists = true;
        writeFileSync(handle, envelopeBytes);
        fsyncSync(handle);
      } finally {
        if (handle !== undefined) {
          closeSync(handle);
          handle = undefined;
        }
      }
      this.#faultInjector?.("after-temp-fsync");

      let linked = false;
      for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
        try {
          linkSync(temporary, paths.claim);
          linked = true;
          break;
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          this.#recoverClaim(paths.final, paths.claim, directory);
          if (existsSync(paths.final)) {
            if (this.#sameRecord(paths.final, plain)) return;
            conflict();
          }
        }
      }
      if (!linked) invalid();
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      temporaryExists = false;
      this.#syncDirectory(directory);
      this.#faultInjector?.("before-replace");
      this.#recoverClaim(paths.final, paths.claim, directory);
      if (!existsSync(paths.final)) invalid();
      if (!this.#sameRecord(paths.final, plain)) conflict();
    } finally {
      envelopeBytes.fill(0);
      if (handle !== undefined) closeSync(handle);
      if (temporaryExists) this.#unlink(temporary, directory);
    }
  }

  async get(
    projectId: string,
    commandId: string,
    idempotencyKey: string,
  ): Promise<PendingSemanticCommandRecordV1 | null> {
    this.#assertLookup(projectId, commandId, idempotencyKey);
    const directory = this.#existingScopeDirectory();
    if (directory === null) return null;
    const paths = this.#paths(commandId, idempotencyKey);
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
      this.#recoverClaim(paths.final, paths.claim, directory);
      if (!existsSync(paths.final)) return null;
      this.#faultInjector?.("after-get-final-observed");
      let record: PendingSemanticCommandRecordV1;
      try {
        record = this.#openRecord(paths.final, true);
      } catch (error) {
        if (error instanceof FinalDisappearedDuringRead) continue;
        throw error;
      }
      if (!this.#identityMatches(record, commandId, idempotencyKey, paths.basename)) {
        destroyPendingAuthorization(record.authorization);
        invalid();
      }
      return record;
    }
    return invalid();
  }

  async list(projectId: string): Promise<readonly PendingSemanticCommandRecordV1[]> {
    if (projectId !== this.#scope.projectId || !UUID.test(projectId)) invalid();
    const directory = this.#existingScopeDirectory();
    if (directory === null) return Object.freeze([]);
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
      this.#recoverDirectory(directory);
      const records: PendingSemanticCommandRecordV1[] = [];
      let retry = false;
      try {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const match = FINAL_NAME.exec(entry.name);
          if (match !== null) {
            if (!entry.isFile() || entry.isSymbolicLink()) invalid();
            this.#faultInjector?.("after-list-final-observed");
            let record: PendingSemanticCommandRecordV1;
            try {
              record = this.#openRecord(join(directory, entry.name), true);
            } catch (error) {
              if (error instanceof FinalDisappearedDuringRead) {
                retry = true;
                break;
              }
              throw error;
            }
            if (!this.#identityMatches(record, record.commandId, record.idempotencyKey, match[1]!)) {
              destroyPendingAuthorization(record.authorization);
              invalid();
            }
            records.push(record);
            continue;
          }
          if (TEMP_NAME.test(entry.name)) {
            if (!entry.isFile() || entry.isSymbolicLink()) invalid();
            continue;
          }
          if (CLAIM_NAME.test(entry.name)) {
            retry = true;
            break;
          }
          invalid();
        }
        if (retry) {
          for (const record of records) destroyPendingAuthorization(record.authorization);
          continue;
        }
        records.sort((left, right) =>
          left.commandId.localeCompare(right.commandId)
          || left.idempotencyKey.localeCompare(right.idempotencyKey));
        return Object.freeze(records);
      } catch (error) {
        for (const record of records) destroyPendingAuthorization(record.authorization);
        if (error instanceof LifecycleError) throw error;
        return invalid();
      }
    }
    return invalid();
  }

  async delete(projectId: string, commandId: string, idempotencyKey: string): Promise<void> {
    this.#assertLookup(projectId, commandId, idempotencyKey);
    const directory = this.#existingScopeDirectory();
    if (directory === null) return;
    const paths = this.#paths(commandId, idempotencyKey);
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
      this.#recoverClaim(paths.final, paths.claim, directory);
      if (!existsSync(paths.final)) return;
      this.#faultInjector?.("after-delete-final-observed");
      let record: PendingSemanticCommandRecordV1;
      try {
        record = this.#openRecord(paths.final, true);
      } catch (error) {
        if (error instanceof FinalDisappearedDuringRead) continue;
        throw error;
      }
      try {
        if (!this.#identityMatches(record, commandId, idempotencyKey, paths.basename)) invalid();
      } finally {
        destroyPendingAuthorization(record.authorization);
      }
      this.#unlink(paths.final, directory);
      return;
    }
    return invalid();
  }

  #assertLookup(projectId: string, commandId: string, idempotencyKey: string): void {
    if (
      projectId !== this.#scope.projectId
      || !UUID.test(projectId)
      || !UUID.test(commandId)
      || typeof idempotencyKey !== "string"
      || idempotencyKey.length === 0
      || Array.from(idempotencyKey).length > 512
    ) invalid();
  }

  #paths(commandId: string, idempotencyKey: string): {
    readonly basename: string;
    readonly final: string;
    readonly claim: string;
  } {
    const basename = canonicalHash("project-memory/pending-authorization-record/v1", {
      projectId: this.#scope.projectId,
      storeId: this.#scope.storeId,
      commandId,
      idempotencyKey,
    });
    const final = join(this.#scopeDirectory, `${basename}.json`);
    const claim = join(this.#scopeDirectory, `${basename}.claim`);
    if (!contained(this.privateStateRoot, final) || !contained(this.privateStateRoot, claim)) invalid();
    return { basename, final, claim };
  }

  #ensureScopeDirectory(): string {
    this.#assertRoot();
    try {
      mkdirSync(this.#scopeDirectory, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") invalid();
    }
    const directory = this.#validateScopeDirectory();
    this.#syncDirectory(this.privateStateRoot);
    return directory;
  }

  #existingScopeDirectory(): string | null {
    this.#assertRoot();
    if (!existsSync(this.#scopeDirectory)) return null;
    const directory = this.#validateScopeDirectory();
    this.#syncDirectory(this.privateStateRoot);
    return directory;
  }

  #assertRoot(): void {
    if (!samePath(canonicalRoot(this.privateStateRoot), this.privateStateRoot)) invalid();
  }

  #validateScopeDirectory(): string {
    try {
      const authority = lstatSync(this.#scopeDirectory);
      if (!authority.isDirectory() || authority.isSymbolicLink()) invalid();
      const canonical = resolve(realpathSync.native(this.#scopeDirectory));
      if (
        !samePath(canonical, this.#scopeDirectory)
        || !contained(this.privateStateRoot, canonical)
      ) invalid();
      return canonical;
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      return invalid();
    }
  }

  #validateFile(path: string, allowDisappearance = false): void {
    try {
      if (!contained(this.privateStateRoot, path)) invalid();
      const authority = lstatSync(path);
      if (!authority.isFile() || authority.isSymbolicLink() || authority.nlink !== 1) invalid();
      const canonical = resolve(realpathSync.native(path));
      if (!samePath(canonical, path) || !samePath(resolve(path, ".."), resolve(this.#scopeDirectory))) invalid();
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      if (allowDisappearance && errorCode(error) === "ENOENT") {
        throw new FinalDisappearedDuringRead();
      }
      return invalid();
    }
  }

  #recoverDirectory(directory: string): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (FINAL_NAME.test(entry.name)) continue;
        const claim = CLAIM_NAME.exec(entry.name);
        if (claim !== null) {
          if (!entry.isFile() || entry.isSymbolicLink()) invalid();
          this.#recoverClaim(
            join(directory, `${claim[1]}.json`),
            join(directory, entry.name),
            directory,
          );
          changed = true;
          break;
        }
        const temporary = TEMP_NAME.exec(entry.name);
        if (temporary !== null) {
          if (!entry.isFile() || entry.isSymbolicLink()) invalid();
          if (!processIsAlive(temporary[2]!)) {
            this.#unlink(join(directory, entry.name), directory);
            changed = true;
            break;
          }
          continue;
        }
        invalid();
      }
    }
  }

  #recoverClaim(final: string, claim: string, directory: string): void {
    const finalName = FINAL_NAME.exec(pathBasename(final));
    if (finalName === null) invalid();
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
      if (!existsSync(claim)) return;
      if (!this.#normalizeInterruptedClaim(claim, directory)) continue;
      try {
        this.#validateFile(claim);
      } catch (error) {
        if (!existsSync(claim)) continue;
        throw error;
      }
      if (existsSync(final)) {
        let claimRecord: PendingSemanticCommandRecordV1 | undefined;
        let finalRecord: PendingSemanticCommandRecordV1 | undefined;
        try {
          claimRecord = this.#openRecord(claim);
          finalRecord = this.#openRecord(final);
          if (
            !this.#identityMatches(
              claimRecord,
              claimRecord.commandId,
              claimRecord.idempotencyKey,
              finalName[1]!,
            )
            || !this.#identityMatches(
              finalRecord,
              finalRecord.commandId,
              finalRecord.idempotencyKey,
              finalName[1]!,
            )
          ) invalid();
        } catch (error) {
          if (!existsSync(claim) && existsSync(final)) continue;
          throw error;
        } finally {
          if (claimRecord !== undefined) destroyPendingAuthorization(claimRecord.authorization);
          if (finalRecord !== undefined) destroyPendingAuthorization(finalRecord.authorization);
        }
        try {
          unlinkSync(claim);
          this.#syncDirectory(directory);
        } catch (error) {
          if (!publicationRace(error)) throw error;
        }
        continue;
      }
      this.#faultInjector?.("before-claim-publish");
      try {
        renameSync(claim, final);
      } catch (error) {
        if (!publicationRace(error)) throw error;
        continue;
      }
      this.#faultInjector?.("after-replace");
      this.#syncDirectory(directory);
      return;
    }
    return invalid();
  }

  #normalizeInterruptedClaim(claim: string, directory: string): boolean {
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
      let authority: ReturnType<typeof lstatSync>;
      try {
        authority = lstatSync(claim);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        return invalid();
      }
      if (!authority.isFile() || authority.isSymbolicLink() || authority.nlink < 1) invalid();
      if (authority.nlink === 1) return true;

      const linkedTemps: string[] = [];
      let raced = false;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!TEMP_NAME.test(entry.name)) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) invalid();
        const path = join(directory, entry.name);
        let candidate: ReturnType<typeof lstatSync>;
        try {
          candidate = lstatSync(path);
        } catch (error) {
          if (errorCode(error) === "ENOENT") {
            raced = true;
            break;
          }
          return invalid();
        }
        if (
          !candidate.isFile()
          || candidate.isSymbolicLink()
          || candidate.dev !== authority.dev
          || candidate.ino !== authority.ino
        ) continue;
        linkedTemps.push(path);
      }
      if (raced) continue;
      let fresh: ReturnType<typeof lstatSync>;
      try {
        fresh = lstatSync(claim);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        return invalid();
      }
      if (
        fresh.dev !== authority.dev
        || fresh.ino !== authority.ino
        || fresh.nlink !== authority.nlink
      ) continue;
      if (linkedTemps.length !== fresh.nlink - 1) invalid();
      let removed = false;
      for (const path of linkedTemps) {
        try {
          unlinkSync(path);
          removed = true;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
      if (removed) this.#syncDirectory(directory);
    }
    return invalid();
  }

  #sameRecord(path: string, plain: ReturnType<typeof encodePendingSemanticCommandRecord>): boolean {
    const existing = this.#openRecord(path);
    try {
      const existingPlain = encodePendingSemanticCommandRecord(existing);
      return this.#sameCanonical(existingPlain, plain);
    } finally {
      destroyPendingAuthorization(existing.authorization);
    }
  }

  #sameCanonical(left: unknown, right: unknown): boolean {
    const leftBytes = Buffer.from(canonicalJson(left), "utf8");
    const rightBytes = Buffer.from(canonicalJson(right), "utf8");
    const padded = leftBytes.length === rightBytes.length
      ? rightBytes
      : Buffer.alloc(leftBytes.length, 0);
    try {
      return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, padded);
    } finally {
      leftBytes.fill(0);
      rightBytes.fill(0);
      if (padded !== rightBytes) padded.fill(0);
    }
  }

  #openRecord(path: string, allowDisappearance = false): PendingSemanticCommandRecordV1 {
    this.#validateFile(path, allowDisappearance);
    let envelopeBytes: Buffer;
    try {
      envelopeBytes = readFileSync(path);
    } catch (error) {
      if (allowDisappearance && errorCode(error) === "ENOENT") {
        throw new FinalDisappearedDuringRead();
      }
      return invalid();
    }
    if (envelopeBytes.length === 0 || envelopeBytes.length > MAX_ENVELOPE_BYTES) {
      envelopeBytes.fill(0);
      invalid();
    }
    let envelope: PendingAuthorizationEnvelopeV1;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(envelopeBytes);
      const parsed = JSON.parse(text) as unknown;
      envelope = strictEnvelope(parsed);
      if (canonicalJson(envelope) !== text) invalid();
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      return invalid();
    } finally {
      envelopeBytes.fill(0);
    }
    let status: "available" | "revoked" | "unavailable";
    try {
      status = this.#provider.status(
        this.#scope,
        "pending-authorization-encryption",
        envelope.keyId,
      );
    } catch {
      return unavailable();
    }
    if (status !== "available") unavailable();
    let opened: Uint8Array;
    try {
      opened = this.#provider.open({
        ...this.#scope,
        purpose: "pending-authorization-encryption",
        keyId: envelope.keyId,
        domain: PENDING_AUTHORIZATION_SEAL_DOMAIN,
        sealed: envelope as SealedValueV1,
      });
    } catch {
      return invalid();
    }
    const plaintext = Buffer.from(opened);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      const parsed = JSON.parse(text) as unknown;
      const record = decodePendingSemanticCommandRecord(parsed);
      const reencoded = encodePendingSemanticCommandRecord(record);
      if (canonicalJson(reencoded) !== text) {
        destroyPendingAuthorization(record.authorization);
        invalid();
      }
      return record;
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      return invalid();
    } finally {
      plaintext.fill(0);
      opened.fill(0);
    }
  }

  #identityMatches(
    record: PendingSemanticCommandRecordV1,
    commandId: string,
    idempotencyKey: string,
    basename: string,
  ): boolean {
    return record.projectId === this.#scope.projectId
      && record.storeId === this.#scope.storeId
      && record.commandId === commandId
      && record.idempotencyKey === idempotencyKey
      && HASH.test(basename)
      && this.#paths(record.commandId, record.idempotencyKey).basename === basename;
  }

  #unlink(path: string, directory: string): void {
    try {
      unlinkSync(path);
      this.#syncDirectory(directory);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}
