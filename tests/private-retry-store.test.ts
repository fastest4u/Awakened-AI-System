import assert from "node:assert/strict";
import { fork as forkChildProcess, type ChildProcess } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  linkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
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
} from "../src/orchestrator/lifecycle/authority/capability-key-provider.js";
import {
  EncryptedPendingAuthorizationStore,
  type PendingAuthorizationStoreFaultPoint,
} from "../src/orchestrator/lifecycle/authority/encrypted-pending-authorization.store.js";
import type { PendingSemanticCommandRecordV1 } from "../src/orchestrator/lifecycle/authority/pending-authorization.store.js";
import { SecretString } from "../src/orchestrator/lifecycle/authority/redacted-secret.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import { canonicalMkdtemp } from "./support/canonical-temp.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const VAULT_ID = "00000000-0000-4000-8000-000000000002";
const STORE_ID = "00000000-0000-4000-8000-000000000003";
const ROOT_SESSION_ID = "00000000-0000-4000-8000-000000000010";
const COMMAND_ID = "00000000-0000-4000-8000-000000000020";
const WORKSPACE_ID = "1".repeat(64);
const PROOF_MAC_CANARY = randomBytes(32).toString("hex");
const APPROVAL_CANARY = `pmrap1.${randomUUID()}.${randomBytes(24).toString("base64url")}`;
const GRANT_CANARY = `${randomUUID()}.${randomBytes(24).toString("base64url")}`;
const BEARER_CANARY = `pmcap1.${randomUUID()}.${randomBytes(24).toString("base64url")}`;
const PROVIDER_KEY_CANARY = randomBytes(32).toString("base64url");
const SEMANTIC_CANARY = `${randomUUID()}.${randomBytes(24).toString("base64url")}`;
const DIFFERENT_SEMANTIC_CANARY = `${randomUUID()}.${randomBytes(24).toString("base64url")}`;
const CONCURRENT_SEMANTIC_CANARY = `${randomUUID()}.${randomBytes(24).toString("base64url")}`;
const CHILD_PROCESS_MODE = process.env.PENDING_AUTHORIZATION_TEST_CHILD === "1";

const roots: string[] = [];

if (!CHILD_PROCESS_MODE) afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class PrivateStateProvider implements CapabilityKeyProvider {
  readonly #key: Buffer;
  available = true;
  lastSealInput: Uint8Array | null = null;
  lastOpenOutput: Uint8Array | null = null;

  constructor(keyMaterial = PROVIDER_KEY_CANARY) {
    this.#key = createHash("sha256").update(keyMaterial, "utf8").digest();
  }

  currentKey(_scope: KeyScope, purpose: CapabilityKeyPurpose): CapabilityKeyRef {
    assert.equal(purpose, "pending-authorization-encryption");
    return { keyId: "pending-key-v1" };
  }

  status(_scope: KeyScope, purpose: CapabilityKeyPurpose, keyId: string): "available" | "revoked" | "unavailable" {
    assert.equal(purpose, "pending-authorization-encryption");
    return this.available && keyId === "pending-key-v1" ? "available" : "unavailable";
  }

  seal(input: KeyedSealInput): SealedValueV1 {
    this.lastSealInput = input.bytes;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const ciphertext = Buffer.concat([cipher.update(input.bytes), cipher.final()]);
    const tag = cipher.getAuthTag();
    try {
      return {
        version: 1,
        keyId: input.keyId,
        algorithm: "aes-256-gcm",
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: tag.toString("base64url"),
      };
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      tag.fill(0);
    }
  }

  open(input: KeyedOpenInput): Uint8Array {
    if (input.sealed.algorithm !== "aes-256-gcm") throw new Error("SEALED_VALUE_INVALID");
    const nonce = Buffer.from(input.sealed.nonce, "base64url");
    const ciphertext = Buffer.from(input.sealed.ciphertext, "base64url");
    const tag = Buffer.from(input.sealed.tag, "base64url");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      this.lastOpenOutput = plaintext;
      return plaintext;
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      tag.fill(0);
    }
  }

  mac(_input: KeyedMacInput): Uint8Array { throw new Error("UNUSED_PROVIDER_OPERATION"); }
  verify(_input: KeyedVerifyInput): boolean { throw new Error("UNUSED_PROVIDER_OPERATION"); }
  fingerprint(_input: KeyedFingerprintInput): string { throw new Error("UNUSED_PROVIDER_OPERATION"); }

  destroy(): void {
    this.#key.fill(0);
  }
}

function privateRoot(prefix: string): string {
  const root = canonicalMkdtemp(prefix);
  roots.push(root);
  return root;
}

function store(
  root: string,
  provider: CapabilityKeyProvider,
  faultInjector?: (point: PendingAuthorizationStoreFaultPoint) => void,
): EncryptedPendingAuthorizationStore {
  return new EncryptedPendingAuthorizationStore({
    privateStateRoot: root,
    scope: { projectId: PROJECT_ID, storeId: STORE_ID },
    keyProvider: provider,
    ...(faultInjector === undefined ? {} : { faultInjector }),
  });
}

function forkRecord(overrides: Partial<PendingSemanticCommandRecordV1> = {}): PendingSemanticCommandRecordV1 {
  return {
    recordVersion: 1,
    projectId: PROJECT_ID,
    storeId: STORE_ID,
    commandId: COMMAND_ID,
    idempotencyKey: "fork/private-retry/1",
    command: {
      commandType: "fork-child",
      commandId: COMMAND_ID,
      idempotencyKey: "fork/private-retry/1",
      agentId: "agent-primary",
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedBranchRef: "refs/heads/private-retry",
      parentSessionId: ROOT_SESSION_ID,
      expectedStreamVersion: "7",
      assignment: {
        assignmentId: "00000000-0000-4000-8000-000000000030",
        summary: SEMANTIC_CANARY,
        scope: "tests/private-retry-store.test.ts",
      },
      directAccessRequested: true,
    },
    authoritySessionId: ROOT_SESSION_ID,
    targetSessionId: ROOT_SESSION_ID,
    stableBinding: {
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "desktop/private-retry-tests",
      audience: {
        presentingActorRole: "primary",
        presentingClientInstanceId: "primary-a",
        targetActorRole: "untrusted",
        targetClientInstanceId: "child-a",
      },
    },
    candidateIntentHash: "b".repeat(64),
    authorization: {
      kind: "protected",
      proof: {
        proofVersion: 1,
        target: "semantic-command",
        proofNonce: "00000000-0000-4000-8000-000000000040",
        proofFingerprint: PROOF_MAC_CANARY,
      },
      approval: null,
      childBindingGrant: SecretString.from(GRANT_CANARY),
    },
    createdAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  } as PendingSemanticCommandRecordV1;
}

function abandonmentRecord(): PendingSemanticCommandRecordV1 {
  const commandId = "00000000-0000-4000-8000-000000000021";
  const base = forkRecord();
  try {
    return {
      ...base,
      commandId,
      idempotencyKey: "abandon/private-retry/1",
      command: {
        commandType: "abandon-session",
        commandId,
        idempotencyKey: "abandon/private-retry/1",
        agentId: "agent-primary",
        expectedProjectId: PROJECT_ID,
        expectedVaultId: VAULT_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedBranchRef: null,
        sessionId: ROOT_SESSION_ID,
        expectedStreamVersion: "7",
        preTransitionCheckpointId: "00000000-0000-4000-8000-000000000031",
        reasonCode: "irrecoverable-session",
      },
      authorization: {
        kind: "protected",
        proof: {
          proofVersion: 1,
          target: "semantic-command",
          proofNonce: "00000000-0000-4000-8000-000000000041",
          proofFingerprint: "c".repeat(64),
        },
        approval: SecretString.from(APPROVAL_CANARY),
        childBindingGrant: null,
      },
      candidateIntentHash: "d".repeat(64),
    } as PendingSemanticCommandRecordV1;
  } finally {
    destroyRecord(base);
  }
}

function allFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else output.push(path);
    }
  };
  visit(root);
  return output.sort();
}

function retainedText(root: string): string {
  return allFiles(root).map((path) => `${relative(root, path)}\n${readFileSync(path, "utf8")}`).join("\n");
}

function secretValue(secret: SecretString | null): string | null {
  return secret?.withValue((value) => value) ?? null;
}

function destroyRecord(record: PendingSemanticCommandRecordV1 | null): void {
  if (record?.authorization.kind === "protected") {
    record.authorization.approval?.destroy();
    record.authorization.childBindingGrant?.destroy();
  }
}

function assertCode(code: string, error: unknown): boolean {
  assert.ok(error instanceof LifecycleError);
  assert.equal(error.code, code);
  assert.doesNotMatch(String(error), new RegExp([
    BEARER_CANARY,
    APPROVAL_CANARY,
    GRANT_CANARY,
    PROVIDER_KEY_CANARY,
    SEMANTIC_CANARY,
  ].join("|"), "i"));
  return true;
}

interface ConcurrentChildConfig {
  readonly operation: "put" | "get" | "list" | "delete";
  readonly root: string;
  readonly providerKey: string;
  readonly semantic: string;
  readonly grant: string;
  readonly proofFingerprint: string;
  readonly agentId: string;
  readonly pausePoint: PendingAuthorizationStoreFaultPoint;
  readonly readyPath: string;
  readonly releasePath: string;
}

interface ConcurrentChildOutcome {
  readonly status: "fulfilled" | "rejected";
  readonly code: string | null;
  readonly recordCount?: number;
}

function childRecord(config: ConcurrentChildConfig): PendingSemanticCommandRecordV1 {
  const base = forkRecord();
  try {
    assert.equal(base.command.commandType, "fork-child");
    return {
      ...base,
      command: {
        ...base.command,
        agentId: config.agentId,
        assignment: {
          ...base.command.assignment,
          summary: config.semantic,
        },
      },
      authorization: {
        kind: "protected",
        proof: {
          proofVersion: 1,
          target: "semantic-command",
          proofNonce: "00000000-0000-4000-8000-000000000040",
          proofFingerprint: config.proofFingerprint,
        },
        approval: null,
        childBindingGrant: SecretString.from(config.grant),
      },
    } as PendingSemanticCommandRecordV1;
  } finally {
    destroyRecord(base);
  }
}

async function runConcurrentChild(): Promise<void> {
  const config = await new Promise<ConcurrentChildConfig>((resolveConfig) => {
    process.once("message", (message) => resolveConfig(message as ConcurrentChildConfig));
  });
  const provider = new PrivateStateProvider(config.providerKey);
  const record = config.operation === "put" ? childRecord(config) : null;
  const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let paused = false;
  const pending = store(config.root, provider, (point) => {
    if (paused || point !== config.pausePoint) return;
    paused = true;
    writeFileSync(config.readyPath, "ready", { encoding: "utf8", flag: "wx" });
    const deadline = Date.now() + 20_000;
    while (!existsSync(config.releasePath)) {
      if (Date.now() >= deadline) throw new Error("CHILD_BARRIER_TIMEOUT");
      Atomics.wait(waitCell, 0, 0, 10);
    }
  });
  let outcome: ConcurrentChildOutcome;
  try {
    if (config.operation === "put") {
      assert.ok(record !== null);
      await pending.put(record);
      outcome = { status: "fulfilled", code: null };
    } else if (config.operation === "get") {
      const loaded = await pending.get(PROJECT_ID, COMMAND_ID, "fork/private-retry/1");
      outcome = { status: "fulfilled", code: null, recordCount: loaded === null ? 0 : 1 };
      destroyRecord(loaded);
    } else if (config.operation === "list") {
      const records = await pending.list(PROJECT_ID);
      outcome = { status: "fulfilled", code: null, recordCount: records.length };
      for (const loaded of records) destroyRecord(loaded);
    } else {
      await pending.delete(PROJECT_ID, COMMAND_ID, "fork/private-retry/1");
      outcome = { status: "fulfilled", code: null };
    }
  } catch (error) {
    outcome = {
      status: "rejected",
      code: error instanceof LifecycleError
        ? error.code
        : typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "RAW_ERROR",
    };
  } finally {
    destroyRecord(record);
    provider.destroy();
  }
  await new Promise<void>((resolveSend, rejectSend) => {
    if (process.send === undefined) return rejectSend(new Error("CHILD_IPC_UNAVAILABLE"));
    process.send(outcome, (error) => error === null ? resolveSend() : rejectSend(error));
  });
  process.disconnect();
}

interface LaunchedChild {
  readonly child: ChildProcess;
  readonly outcome: Promise<ConcurrentChildOutcome>;
}

function launchConcurrentChild(config: ConcurrentChildConfig): LaunchedChild {
  const child = forkChildProcess(fileURLToPath(import.meta.url), [], {
    env: { ...process.env, PENDING_AUTHORIZATION_TEST_CHILD: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const outcome = new Promise<ConcurrentChildOutcome>((resolveOutcome, rejectOutcome) => {
    let result: ConcurrentChildOutcome | undefined;
    child.on("message", (message) => { result = message as ConcurrentChildOutcome; });
    child.once("error", rejectOutcome);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null && result !== undefined) resolveOutcome(result);
      else rejectOutcome(new Error(
        `CHILD_EXIT_${String(code)}_${String(signal)}\n${stdout}\n${stderr}`,
      ));
    });
  });
  child.send(config);
  return { child, outcome };
}

async function waitForBarrier(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`BARRIER_TIMEOUT:${basename(path)}`);
    await delay(10);
  }
}

function childConfig(
  root: string,
  barrierRoot: string,
  label: string,
  pausePoint: PendingAuthorizationStoreFaultPoint,
  values: {
    readonly providerKey: string;
    readonly semantic: string;
    readonly grant: string;
    readonly proofFingerprint: string;
    readonly agentId: string;
  },
): ConcurrentChildConfig {
  return {
    operation: "put",
    root,
    ...values,
    pausePoint,
    readyPath: join(barrierRoot, `${label}.ready`),
    releasePath: join(barrierRoot, `${label}.release`),
  };
}

if (!CHILD_PROCESS_MODE) describe("encrypted pending authorization store", () => {
  it("writes, reopens, reads, lists, and deletes only a strict sealed envelope", async () => {
    const root = privateRoot("pending-private-roundtrip-");
    const provider = new PrivateStateProvider();
    const pending = store(root, provider);
    const fork = forkRecord();
    const abandon = abandonmentRecord();
    try {
      await pending.put(fork);
      await pending.put(abandon);

      assert.ok(provider.lastSealInput !== null);
      assert.equal([...provider.lastSealInput].every((byte) => byte === 0), true, "seal plaintext must be zeroized");

      const reopened = store(root, provider);
      const loaded = await reopened.get(PROJECT_ID, COMMAND_ID, "fork/private-retry/1");
      assert.ok(loaded !== null);
      assert.deepEqual(loaded.command, fork.command);
      assert.deepEqual(loaded.authorization.proof, fork.authorization.proof);
      assert.equal(
        loaded.authorization.kind === "protected"
          ? secretValue(loaded.authorization.childBindingGrant)
          : null,
        GRANT_CANARY,
      );
      assert.ok(provider.lastOpenOutput !== null);
      assert.equal([...provider.lastOpenOutput].every((byte) => byte === 0), true, "opened plaintext must be zeroized");

      const listed = await reopened.list(PROJECT_ID);
      assert.deepEqual(listed.map((record: PendingSemanticCommandRecordV1) => record.commandId), [COMMAND_ID, abandon.commandId]);

      const files = allFiles(root);
      assert.equal(files.length, 2);
      for (const path of files) {
        const envelope = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        assert.deepEqual(Object.keys(envelope).sort(), [
          "algorithm", "ciphertext", "keyId", "nonce", "tag", "version",
        ]);
        assert.equal(envelope.version, 1);
        const authority = statSync(path);
        assert.equal(authority.isFile(), true);
        if (process.platform !== "win32") assert.equal(authority.mode & 0o777, 0o600);
      }
      const retained = retainedText(root);
      for (const canary of [
        BEARER_CANARY,
        PROOF_MAC_CANARY,
        APPROVAL_CANARY,
        GRANT_CANARY,
        PROVIDER_KEY_CANARY,
        SEMANTIC_CANARY,
        COMMAND_ID,
        "fork/private-retry/1",
      ]) assert.equal(retained.includes(canary), false, canary);

      await reopened.delete(PROJECT_ID, COMMAND_ID, "fork/private-retry/1");
      assert.equal(await reopened.get(PROJECT_ID, COMMAND_ID, "fork/private-retry/1"), null);
      const remaining = await reopened.list(PROJECT_ID);
      assert.equal(remaining.length, 1);
      destroyRecord(loaded);
      for (const record of listed) destroyRecord(record);
      for (const record of remaining) destroyRecord(record);
    } finally {
      if (fork.authorization.kind === "protected") fork.authorization.childBindingGrant?.destroy();
      if (abandon.authorization.kind === "protected") abandon.authorization.approval?.destroy();
      provider.destroy();
    }
  });

  it("accepts an exact duplicate but rejects the same identity with different plaintext", async () => {
    const root = privateRoot("pending-private-conflict-");
    const provider = new PrivateStateProvider();
    const pending = store(root, provider);
    const original = forkRecord();
    const changed = forkRecord({
      command: {
        ...original.command,
        agentId: DIFFERENT_SEMANTIC_CANARY,
      } as PendingSemanticCommandRecordV1["command"],
    });
    try {
      await pending.put(original);
      await pending.put(original);
      await assert.rejects(pending.put(changed), (error) => assertCode("IDEMPOTENCY_CONFLICT", error));
      const loaded = await pending.get(PROJECT_ID, COMMAND_ID, "fork/private-retry/1");
      assert.deepEqual(loaded?.command, original.command);
      destroyRecord(loaded);
    } finally {
      if (original.authorization.kind === "protected") original.authorization.childBindingGrant?.destroy();
      if (changed.authorization.kind === "protected") changed.authorization.childBindingGrant?.destroy();
      provider.destroy();
    }
  });

  it("rejects extra record fields and accessor-bearing authorization without invoking accessors", async () => {
    const root = privateRoot("pending-private-strict-input-");
    const provider = new PrivateStateProvider();
    const pending = store(root, provider);
    const record = forkRecord();
    let kindReads = 0;
    const accessorAuthorization = {
      proof: record.authorization.proof,
      approval: null,
      childBindingGrant: record.authorization.kind === "protected"
        ? record.authorization.childBindingGrant
        : null,
    };
    Object.defineProperty(accessorAuthorization, "kind", {
      enumerable: true,
      get: () => {
        kindReads += 1;
        return "protected";
      },
    });
    try {
      await assert.rejects(
        pending.put({ ...record, authorization: accessorAuthorization } as PendingSemanticCommandRecordV1),
        (error) => assertCode("SESSION_CAPABILITY_INVALID", error),
      );
      assert.equal(kindReads, 0);
      await assert.rejects(
        pending.put({ ...record, bearer: BEARER_CANARY } as unknown as PendingSemanticCommandRecordV1),
        (error) => assertCode("SESSION_CAPABILITY_INVALID", error),
      );
      assert.equal(allFiles(root).length, 0);
    } finally {
      destroyRecord(record);
      provider.destroy();
    }
  });

  it("fails closed for corrupt, torn, tampered, and unavailable-key records including list", async () => {
    for (const replacement of ["{", "{}", JSON.stringify({
      version: 1,
      keyId: "pending-key-v1",
      algorithm: "aes-256-gcm",
      nonce: "AA",
      ciphertext: "AA",
      tag: "AA",
      extra: true,
    })]) {
      const root = privateRoot("pending-private-corrupt-");
      const provider = new PrivateStateProvider();
      const pending = store(root, provider);
      const record = forkRecord();
      try {
        await pending.put(record);
        const [path] = allFiles(root);
        assert.ok(path !== undefined);
        writeFileSync(path, replacement, "utf8");
        await assert.rejects(
          pending.get(PROJECT_ID, COMMAND_ID, "fork/private-retry/1"),
          (error) => assertCode("SESSION_CAPABILITY_INVALID", error),
        );
        await assert.rejects(pending.list(PROJECT_ID), (error) => assertCode("SESSION_CAPABILITY_INVALID", error));
      } finally {
        if (record.authorization.kind === "protected") record.authorization.childBindingGrant?.destroy();
        provider.destroy();
      }
    }

    const tamperedRoot = privateRoot("pending-private-authenticated-tamper-");
    const tamperedProvider = new PrivateStateProvider();
    const tamperedPending = store(tamperedRoot, tamperedProvider);
    const tamperedRecord = forkRecord();
    try {
      await tamperedPending.put(tamperedRecord);
      const [path] = allFiles(tamperedRoot);
      assert.ok(path !== undefined);
      const envelope = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      assert.equal(typeof envelope.ciphertext, "string");
      const ciphertext = envelope.ciphertext as string;
      envelope.ciphertext = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
      writeFileSync(path, JSON.stringify(envelope), "utf8");
      await assert.rejects(
        tamperedPending.get(PROJECT_ID, COMMAND_ID, "fork/private-retry/1"),
        (error) => assertCode("SESSION_CAPABILITY_INVALID", error),
      );
      await assert.rejects(
        tamperedPending.list(PROJECT_ID),
        (error) => assertCode("SESSION_CAPABILITY_INVALID", error),
      );
    } finally {
      destroyRecord(tamperedRecord);
      tamperedProvider.destroy();
    }

    const root = privateRoot("pending-private-key-missing-");
    const provider = new PrivateStateProvider();
    const pending = store(root, provider);
    const record = forkRecord();
    try {
      await pending.put(record);
      provider.available = false;
      await assert.rejects(
        pending.get(PROJECT_ID, COMMAND_ID, "fork/private-retry/1"),
        (error) => assertCode("SESSION_CAPABILITY_KEY_UNAVAILABLE", error),
      );
      await assert.rejects(pending.list(PROJECT_ID), (error) => assertCode("SESSION_CAPABILITY_KEY_UNAVAILABLE", error));
    } finally {
      if (record.authorization.kind === "protected") record.authorization.childBindingGrant?.destroy();
      provider.destroy();
    }
  });

  it("recovers the exact fsynced record when death is injected before or after atomic replace", async () => {
    for (const deathPoint of ["before-replace", "after-replace"] as const) {
      const root = privateRoot(`pending-private-${deathPoint}-`);
      const provider = new PrivateStateProvider();
      let injected = false;
      const pending = store(root, provider, (point) => {
        if (!injected && point === deathPoint) {
          injected = true;
          const files = allFiles(root);
          assert.equal(files.length, 1, "an interrupted write must leave one recoverable envelope");
          assert.equal(statSync(files[0] as string).nlink, 1, "the envelope must not retain a temp hard link");
          throw new Error("SIMULATED_PROCESS_DEATH");
        }
      });
      const record = forkRecord();
      try {
        await assert.rejects(pending.put(record), /SIMULATED_PROCESS_DEATH/);
        const reopened = store(root, provider);
        const loaded = await reopened.get(PROJECT_ID, COMMAND_ID, "fork/private-retry/1");
        assert.ok(loaded !== null, deathPoint);
        assert.deepEqual(loaded.command, record.command);
        const text = retainedText(root);
        assert.equal(text.includes(SEMANTIC_CANARY), false);
        for (const path of allFiles(root)) {
          assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")) as object).sort(), [
            "algorithm", "ciphertext", "keyId", "nonce", "tag", "version",
          ]);
        }
        destroyRecord(loaded);
      } finally {
        if (record.authorization.kind === "protected") record.authorization.childBindingGrant?.destroy();
        provider.destroy();
      }
    }
  });

  it("recovers a process death between the exclusive claim link and temp unlink", async () => {
    const root = privateRoot("pending-private-claim-link-death-");
    const provider = new PrivateStateProvider();
    const pending = store(root, provider);
    const record = forkRecord();
    try {
      await pending.put(record);
      const [final] = allFiles(root);
      assert.ok(final !== undefined);
      const digest = basename(final, ".json");
      const claim = join(dirname(final), `${digest}.claim`);
      const temporary = join(dirname(final), `.${digest}.${process.pid}.${randomUUID()}.tmp`);
      renameSync(final, claim);
      linkSync(claim, temporary);
      assert.equal(statSync(claim).nlink, 2);

      const loaded = await store(root, provider).get(PROJECT_ID, COMMAND_ID, "fork/private-retry/1");
      assert.ok(loaded !== null);
      assert.deepEqual(loaded.command, record.command);
      const recoveredFiles = allFiles(root);
      assert.equal(recoveredFiles.length, 1);
      assert.equal(statSync(recoveredFiles[0] as string).nlink, 1);
      destroyRecord(loaded);
    } finally {
      destroyRecord(record);
      provider.destroy();
    }
  });

  it("re-fsyncs an existing scope entry before relying on it after restart", async () => {
    const root = privateRoot("pending-private-existing-scope-sync-");
    const provider = new PrivateStateProvider();
    const record = forkRecord();
    try {
      await store(root, provider).put(record);
      const synced: string[] = [];
      const reopened = new EncryptedPendingAuthorizationStore({
        privateStateRoot: root,
        scope: { projectId: PROJECT_ID, storeId: STORE_ID },
        keyProvider: provider,
        syncDirectory: (path) => synced.push(resolve(path)),
      });
      const loaded = await reopened.get(PROJECT_ID, COMMAND_ID, "fork/private-retry/1");
      assert.ok(loaded !== null);
      assert.deepEqual(synced, [resolve(root)]);
      destroyRecord(loaded);
    } finally {
      destroyRecord(record);
      provider.destroy();
    }
  });

  it("linearizes get and list when a separate process deletes a discovered final", async () => {
    const outcomes: Array<{ readonly operation: "get" | "list" } & ConcurrentChildOutcome> = [];
    for (const operation of ["get", "list"] as const) {
      const root = privateRoot(`pending-private-${operation}-delete-process-`);
      const barrierRoot = privateRoot(`pending-private-${operation}-delete-barrier-`);
      const values = {
        providerKey: randomBytes(32).toString("base64url"),
        semantic: randomUUID(),
        grant: randomBytes(32).toString("base64url"),
        proofFingerprint: randomBytes(32).toString("hex"),
        agentId: `agent-${operation}-delete`,
      };
      const provider = new PrivateStateProvider(values.providerKey);
      const record = childRecord({
        ...childConfig(
          root,
          barrierRoot,
          operation,
          operation === "get" ? "after-get-final-observed" : "after-list-final-observed",
          values,
        ),
        operation: "put",
      });
      try {
        const pending = store(root, provider);
        await pending.put(record);
        const readConfig: ConcurrentChildConfig = {
          ...childConfig(
            root,
            barrierRoot,
            operation,
            operation === "get" ? "after-get-final-observed" : "after-list-final-observed",
            values,
          ),
          operation,
        };
        const reader = launchConcurrentChild(readConfig);
        await waitForBarrier(readConfig.readyPath);
        await pending.delete(PROJECT_ID, COMMAND_ID, "fork/private-retry/1");
        writeFileSync(readConfig.releasePath, "release", { encoding: "utf8", flag: "wx" });
        outcomes.push({ operation, ...await reader.outcome });
        assert.equal(allFiles(root).length, 0);
      } finally {
        destroyRecord(record);
        provider.destroy();
      }
    }
    assert.deepEqual(outcomes, [
      { operation: "get", status: "fulfilled", code: null, recordCount: 0 },
      { operation: "list", status: "fulfilled", code: null, recordCount: 0 },
    ]);
  });

  it("makes two separate-process deletes idempotent after both discover the final", async () => {
    const root = privateRoot("pending-private-concurrent-delete-process-");
    const barrierRoot = privateRoot("pending-private-concurrent-delete-barrier-");
    const values = {
      providerKey: randomBytes(32).toString("base64url"),
      semantic: randomUUID(),
      grant: randomBytes(32).toString("base64url"),
      proofFingerprint: randomBytes(32).toString("hex"),
      agentId: "agent-concurrent-delete",
    };
    const provider = new PrivateStateProvider(values.providerKey);
    const seedConfig = childConfig(
      root,
      barrierRoot,
      "seed",
      "after-delete-final-observed",
      values,
    );
    const record = childRecord(seedConfig);
    try {
      await store(root, provider).put(record);
      const firstConfig: ConcurrentChildConfig = {
        ...childConfig(
          root,
          barrierRoot,
          "first-delete",
          "after-delete-final-observed",
          values,
        ),
        operation: "delete",
      };
      const secondConfig: ConcurrentChildConfig = {
        ...childConfig(
          root,
          barrierRoot,
          "second-delete",
          "after-delete-final-observed",
          values,
        ),
        operation: "delete",
      };
      const first = launchConcurrentChild(firstConfig);
      await waitForBarrier(firstConfig.readyPath);
      const second = launchConcurrentChild(secondConfig);
      await waitForBarrier(secondConfig.readyPath);

      writeFileSync(secondConfig.releasePath, "release", { encoding: "utf8", flag: "wx" });
      const secondOutcome = await second.outcome;
      writeFileSync(firstConfig.releasePath, "release", { encoding: "utf8", flag: "wx" });
      const firstOutcome = await first.outcome;

      assert.deepEqual([firstOutcome, secondOutcome], [
        { status: "fulfilled", code: null },
        { status: "fulfilled", code: null },
      ]);
      assert.equal(allFiles(root).length, 0);
    } finally {
      destroyRecord(record);
      provider.destroy();
    }
  });

  it("linearizes identical writers racing claim publication in separate processes", async () => {
    const root = privateRoot("pending-private-identical-processes-");
    const barrierRoot = privateRoot("pending-private-identical-barrier-");
    const values = {
      providerKey: randomBytes(32).toString("base64url"),
      semantic: randomUUID(),
      grant: randomBytes(32).toString("base64url"),
      proofFingerprint: randomBytes(32).toString("hex"),
      agentId: "agent-identical",
    };
    const firstConfig = childConfig(root, barrierRoot, "first", "before-claim-publish", values);
    const secondConfig = childConfig(root, barrierRoot, "second", "before-claim-publish", values);
    const first = launchConcurrentChild(firstConfig);
    await waitForBarrier(firstConfig.readyPath);
    const second = launchConcurrentChild(secondConfig);
    await waitForBarrier(secondConfig.readyPath);
    writeFileSync(secondConfig.releasePath, "release", { encoding: "utf8", flag: "wx" });
    const secondOutcome = await second.outcome;
    writeFileSync(firstConfig.releasePath, "release", { encoding: "utf8", flag: "wx" });
    const outcomes = [await first.outcome, secondOutcome];
    assert.deepEqual(outcomes, [
      { status: "fulfilled", code: null },
      { status: "fulfilled", code: null },
    ]);
    const provider = new PrivateStateProvider(values.providerKey);
    try {
      const records = await store(root, provider).list(PROJECT_ID);
      assert.equal(records.length, 1);
      for (const record of records) destroyRecord(record);
      assert.equal(allFiles(root).length, 1);
    } finally {
      provider.destroy();
    }
  });

  it("returns one typed conflict when different writers race claim publication in separate processes", async () => {
    const root = privateRoot("pending-private-conflicting-processes-");
    const barrierRoot = privateRoot("pending-private-conflicting-barrier-");
    const shared = {
      providerKey: randomBytes(32).toString("base64url"),
      semantic: randomUUID(),
      grant: randomBytes(32).toString("base64url"),
      proofFingerprint: randomBytes(32).toString("hex"),
    };
    const firstConfig = childConfig(root, barrierRoot, "first", "before-claim-publish", {
      ...shared,
      agentId: "agent-first",
    });
    const secondConfig = childConfig(root, barrierRoot, "second", "before-claim-publish", {
      ...shared,
      agentId: CONCURRENT_SEMANTIC_CANARY,
    });
    const first = launchConcurrentChild(firstConfig);
    await waitForBarrier(firstConfig.readyPath);
    const second = launchConcurrentChild(secondConfig);
    await waitForBarrier(secondConfig.readyPath);
    writeFileSync(secondConfig.releasePath, "release", { encoding: "utf8", flag: "wx" });
    const secondOutcome = await second.outcome;
    writeFileSync(firstConfig.releasePath, "release", { encoding: "utf8", flag: "wx" });
    const outcomes = [await first.outcome, secondOutcome];
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.deepEqual(
      outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.code),
      ["IDEMPOTENCY_CONFLICT"],
    );
    assert.equal(allFiles(root).length, 1);
  });

  it("lists safely while a separate writer is paused before claim and preserves that live temp", async () => {
    const root = privateRoot("pending-private-live-temp-process-");
    const barrierRoot = privateRoot("pending-private-live-temp-barrier-");
    const values = {
      providerKey: randomBytes(32).toString("base64url"),
      semantic: randomUUID(),
      grant: randomBytes(32).toString("base64url"),
      proofFingerprint: randomBytes(32).toString("hex"),
      agentId: "agent-live-temp",
    };
    const config = childConfig(root, barrierRoot, "writer", "after-temp-fsync", values);
    const writer = launchConcurrentChild(config);
    await waitForBarrier(config.readyPath);
    const provider = new PrivateStateProvider(values.providerKey);
    try {
      assert.deepEqual(await store(root, provider).list(PROJECT_ID), []);
      const liveFileCount = allFiles(root).length;
      writeFileSync(config.releasePath, "release", { encoding: "utf8", flag: "wx" });
      const outcome = await writer.outcome;
      assert.equal(liveFileCount, 1, "list must not delete a live pre-claim temp");
      assert.deepEqual(outcome, { status: "fulfilled", code: null });
      const records = await store(root, provider).list(PROJECT_ID);
      assert.equal(records.length, 1);
      for (const record of records) destroyRecord(record);
      assert.equal(allFiles(root).length, 1);
    } finally {
      provider.destroy();
    }
  });

  it("removes a pre-claim temp only after its separate writer process is dead", async () => {
    const root = privateRoot("pending-private-orphan-temp-process-");
    const barrierRoot = privateRoot("pending-private-orphan-temp-barrier-");
    const values = {
      providerKey: randomBytes(32).toString("base64url"),
      semantic: randomUUID(),
      grant: randomBytes(32).toString("base64url"),
      proofFingerprint: randomBytes(32).toString("hex"),
      agentId: "agent-orphan-temp",
    };
    const config = childConfig(root, barrierRoot, "writer", "after-temp-fsync", values);
    const writer = launchConcurrentChild(config);
    await waitForBarrier(config.readyPath);
    const exited = writer.outcome.then(
      () => assert.fail("killed writer must not report success"),
      () => undefined,
    );
    assert.equal(writer.child.kill(), true);
    await exited;
    const provider = new PrivateStateProvider(values.providerKey);
    try {
      assert.deepEqual(await store(root, provider).list(PROJECT_ID), []);
      assert.equal(allFiles(root).length, 0);
    } finally {
      provider.destroy();
    }
  });

  it("requires an absolute canonical root and contains hostile identity strings under hashed paths", async () => {
    const provider = new PrivateStateProvider();
    assert.throws(
      () => store("relative-private-root", provider),
      (error) => assertCode("SESSION_CAPABILITY_INVALID", error),
    );

    const base = privateRoot("pending-private-root-link-");
    const realRoot = join(base, "real");
    const linkedRoot = join(base, "linked");
    mkdirSync(realRoot);
    symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    assert.notEqual(resolve(realpathSync.native(linkedRoot)), resolve(linkedRoot));
    assert.throws(() => store(linkedRoot, provider), (error) => assertCode("SESSION_CAPABILITY_INVALID", error));

    const root = privateRoot("pending-private-containment-");
    const pending = store(root, provider);
    const record = forkRecord();
    const hostileRecord = {
      ...record,
      idempotencyKey: "../../outside/private-retry",
      command: {
        ...record.command,
        idempotencyKey: "../../outside/private-retry",
      } as PendingSemanticCommandRecordV1["command"],
    } as PendingSemanticCommandRecordV1;
    try {
      await pending.put(hostileRecord);
      for (const path of allFiles(root)) {
        const fromRoot = relative(root, path);
        assert.equal(isAbsolute(fromRoot), false);
        assert.equal(fromRoot === ".." || fromRoot.startsWith(`..${sep}`), false);
        assert.equal(path.includes("outside"), false);
      }
    } finally {
      if (record.authorization.kind === "protected") record.authorization.childBindingGrant?.destroy();
      provider.destroy();
    }
  });

  it("closes every file handle before Windows rename and deletion", async () => {
    const root = privateRoot("pending-private-windows-handles-");
    const provider = new PrivateStateProvider();
    const pending = store(root, provider);
    const record = forkRecord();
    try {
      await pending.put(record);
      const loaded = await pending.get(PROJECT_ID, COMMAND_ID, "fork/private-retry/1");
      destroyRecord(loaded);
      await pending.delete(PROJECT_ID, COMMAND_ID, "fork/private-retry/1");
      const moved = `${root}-moved`;
      renameSync(root, moved);
      renameSync(moved, root);
      assert.equal(allFiles(root).length, 0);
    } finally {
      if (record.authorization.kind === "protected") record.authorization.childBindingGrant?.destroy();
      provider.destroy();
    }
  });
});

if (CHILD_PROCESS_MODE) await runConcurrentChild();
