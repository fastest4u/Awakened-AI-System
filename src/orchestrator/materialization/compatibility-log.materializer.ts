import { Buffer } from "node:buffer";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ProjectContext } from "../identity/contracts.js";
import { createDirectoryDurably, fsyncDirectory } from "../identity/directory-durability.js";
import type { CapabilityKeyProvider } from "../lifecycle/authority/capability-key-provider.js";
import {
  NO_LIFECYCLE_FAULTS,
  type LifecycleFaultContext,
  type LifecycleFaultInjector,
} from "../lifecycle/lifecycle-faults.js";
import { LifecycleError } from "../lifecycle/errors.js";
import type {
  LifecycleOutboxClaimV1,
  LifecycleOutboxExactClaimInputV1,
  LifecycleOutboxMaterializationResultV1,
  LifecycleOutboxAcknowledgementInputV1,
} from "../storage/lifecycle-storage.types.js";
import type {
  KeyedFingerprintV1,
  LifecycleOutboxPlannedRevision,
  LifecycleRenderTriggerV1,
  LifecycleRenderClosureV1,
} from "../lifecycle/materialization-queue.port.js";
import { payloadHash } from "../crypto/event-hash.js";
import { projectCompatibilityLogV2 } from "./compatibility-log.projection.js";
import { renderCompatibilityLogV2 } from "./compatibility-log.renderer.js";
import { AtomicArtifactReplacer } from "./atomic-artifact-replacer.js";
import { SqliteLifecycleRenderClosureReader } from "./sqlite-lifecycle-render-closure.reader.js";
import { resolveContainedProjectPath } from "../identity/canonical-path.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";

const MATERIALIZATION_PURPOSE = "materialization-fingerprint" as const;
const MATERIALIZATION_DOMAIN = "pm-materialization-fingerprint-v1" as const;

export interface LifecycleOutboxMaterializationOperations {
  getExactClaim(input: LifecycleOutboxExactClaimInputV1): LifecycleOutboxClaimV1;
  isLatestRevision(plan: LifecycleOutboxPlannedRevision): boolean;
  isCurrentWorkflowGeneration(plan: LifecycleOutboxPlannedRevision): boolean;
  listCommittedLowerRevisionFingerprints(
    claim: LifecycleOutboxClaimV1,
  ): readonly KeyedFingerprintV1[];
  acknowledgeAfterReplacement(
    input: LifecycleOutboxAcknowledgementInputV1,
  ): LifecycleOutboxMaterializationResultV1;
}

export interface CompatibilityLogMaterializationInput extends LifecycleOutboxExactClaimInputV1 {
  readonly context: ProjectContext;
}

export interface CompatibilityLogMaterializerOptions {
  readonly connection?: SqliteConnection;
  readonly keyProvider: Pick<CapabilityKeyProvider, "status" | "fingerprint">;
  readonly nowMs: () => bigint;
  readonly render?: (
    context: ProjectContext,
    plan: LifecycleOutboxPlannedRevision,
  ) => Uint8Array;
  readonly replacerFactory?: (durableBase: string) => AtomicArtifactReplacer;
  readonly syncDirectory?: (path: string) => void;
  readonly faultInjector?: LifecycleFaultInjector;
}

function materializationConflict(): never {
  throw new LifecycleError("MATERIALIZATION_CONFLICT");
}

function inputInvalid(): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function positiveNow(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 8_640_000_000_000_000n) inputInvalid();
  return value;
}

function timestampMs(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) materializationConflict();
  return milliseconds;
}

function sameFingerprint(left: KeyedFingerprintV1, right: KeyedFingerprintV1): boolean {
  return left.algorithm === right.algorithm
    && left.schemaVersion === right.schemaVersion
    && left.keyId === right.keyId
    && left.domain === right.domain
    && left.value === right.value;
}

function fingerprintMatches(
  keyProvider: Pick<CapabilityKeyProvider, "status" | "fingerprint">,
  context: ProjectContext,
  bytes: Uint8Array,
  expected: KeyedFingerprintV1,
): boolean {
  if (
    expected.algorithm !== "hmac-sha256"
    || expected.schemaVersion !== 1
    || expected.domain !== MATERIALIZATION_DOMAIN
    || keyProvider.status(
      { projectId: context.binding.projectId, storeId: context.binding.storeId },
      MATERIALIZATION_PURPOSE,
      expected.keyId,
    ) !== "available"
  ) return false;
  const candidate = Buffer.from(bytes);
  try {
    const value = keyProvider.fingerprint({
      projectId: context.binding.projectId,
      storeId: context.binding.storeId,
      purpose: MATERIALIZATION_PURPOSE,
      keyId: expected.keyId,
      domain: expected.domain,
      bytes: candidate,
    });
    return value === expected.value;
  } finally {
    candidate.fill(0);
  }
}

function exactTarget(
  context: ProjectContext,
  plan: LifecycleOutboxPlannedRevision,
): string {
  try {
    return resolveContainedProjectPath(context.binding.vaultRoot, plan.artifactPath);
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    return materializationConflict();
  }
}

function readExistingTarget(path: string): Uint8Array | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) materializationConflict();
    return readFileSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof LifecycleError) throw error;
    throw error;
  }
}

function tempPath(targetPath: string, plan: LifecycleOutboxPlannedRevision, claimToken: bigint): string {
  return join(
    dirname(targetPath),
    `.${basename(targetPath)}.pm-materialize-${plan.sessionId}-${plan.materializationRevision.toString()}-${claimToken.toString()}.tmp`,
  );
}

function defaultRender(
  connection: SqliteConnection,
  context: ProjectContext,
  plan: LifecycleOutboxPlannedRevision,
): Uint8Array {
  const reader = new SqliteLifecycleRenderClosureReader(connection);
  const closure = reader.readStrictLifecycleClosure(
    plan.projectId,
    plan.sessionId,
    plan.materializationRevision + 1n,
  );
  const event = closure.root.find((candidate) => (
    candidate.globalPosition === plan.triggeringEventPosition.toString()
    && candidate.eventType === plan.triggeringEventType
  ));
  if (event === undefined) return materializationConflict();
  if (payloadHash(event.payload) !== plan.triggeringPayloadHash) return materializationConflict();
  const priorRoot = closure.root.filter((candidate) => candidate.globalPosition !== event.globalPosition);
  if (priorRoot.length + 1 !== closure.root.length) return materializationConflict();
  const priorClosure: LifecycleRenderClosureV1 = Object.freeze({
    ...closure,
    root: Object.freeze(priorRoot),
  });
  const trigger: LifecycleRenderTriggerV1 = Object.freeze({
    ...event,
    materializationOrigin: plan.origin,
  });
  const target = Object.freeze({
    artifactPath: plan.artifactPath,
    targetKey: plan.targetKey,
    materializationRevision: plan.materializationRevision.toString(),
  });
  const projection = projectCompatibilityLogV2({
    closure: priorClosure,
    trigger,
    target,
  });
  return renderCompatibilityLogV2(projection);
}

function assertRenderedFingerprint(
  keyProvider: Pick<CapabilityKeyProvider, "status" | "fingerprint">,
  context: ProjectContext,
  bytes: Uint8Array,
  plan: LifecycleOutboxPlannedRevision,
): void {
  if (!fingerprintMatches(keyProvider, context, bytes, plan.nextFingerprint)) {
    materializationConflict();
  }
}

export class CompatibilityLogMaterializer {
  readonly #connection: SqliteConnection | undefined;
  readonly #keyProvider: Pick<CapabilityKeyProvider, "status" | "fingerprint">;
  readonly #nowMs: () => bigint;
  readonly #render: (
    context: ProjectContext,
    plan: LifecycleOutboxPlannedRevision,
  ) => Uint8Array;
  readonly #replacerFactory: (durableBase: string) => AtomicArtifactReplacer;
  readonly #syncDirectory: (path: string) => void;
  readonly #faults: LifecycleFaultInjector;

  constructor(options: CompatibilityLogMaterializerOptions) {
    if (typeof options !== "object" || options === null) inputInvalid();
    if (typeof options.nowMs !== "function") inputInvalid();
    if (typeof options.keyProvider?.status !== "function"
      || typeof options.keyProvider?.fingerprint !== "function") inputInvalid();
    if (options.render === undefined && options.connection === undefined) inputInvalid();
    this.#connection = options.connection;
    this.#keyProvider = options.keyProvider;
    this.#nowMs = options.nowMs;
    this.#render = options.render ?? ((context, plan) => defaultRender(this.#connection!, context, plan));
    this.#syncDirectory = options.syncDirectory ?? fsyncDirectory;
    this.#faults = options.faultInjector ?? NO_LIFECYCLE_FAULTS;
    this.#replacerFactory = options.replacerFactory
      ?? ((durableBase) => new AtomicArtifactReplacer({
        durableBase,
        syncDirectory: this.#syncDirectory,
        faultInjector: this.#faults,
      }));
  }

  materialize(
    input: CompatibilityLogMaterializationInput,
    operations: LifecycleOutboxMaterializationOperations,
  ): LifecycleOutboxMaterializationResultV1 {
    if (
      typeof input !== "object"
      || input === null
      || input.context.binding.projectId !== input.projectId
      || typeof operations?.getExactClaim !== "function"
      || typeof operations?.isLatestRevision !== "function"
      || typeof operations?.isCurrentWorkflowGeneration !== "function"
      || typeof operations?.listCommittedLowerRevisionFingerprints !== "function"
      || typeof operations?.acknowledgeAfterReplacement !== "function"
    ) inputInvalid();
    const claim = operations.getExactClaim(input);
    const plan = claim.planned;
    const faultContext: LifecycleFaultContext = Object.freeze({
      projectId: input.context.binding.projectId,
      sessionId: plan.sessionId,
      workflowId: null,
      commandId: null,
      idempotencyKeyHash: null,
      workId: plan.targetKey,
      eventPosition: plan.triggeringEventPosition.toString(),
      materializationRevision: plan.materializationRevision.toString(),
    });
    if (
      plan.projectId !== input.context.binding.projectId
      || plan.targetKey !== input.targetKey
      || plan.materializationRevision !== input.materializationRevision
      || claim.claimOwner !== input.ownerId
      || claim.claimToken !== input.claimToken
    ) throw new LifecycleError("EVENT_CONFLICT");
    const targetPath = exactTarget(input.context, plan);
    const replacer = this.#replacerFactory(input.context.binding.vaultRoot);
    const stagedPath = tempPath(targetPath, plan, claim.claimToken);
    if (claim.status === "completed") {
      // A completed replay is a read-only proof.  In particular, do not
      // create the artifact directory or remove a stale temporary file until
      // the retained target has been verified.
      if (!operations.isLatestRevision(plan)) {
        return Object.freeze({
          status: "superseded-after-completion" as const,
          claim,
        });
      }
      const existing = readExistingTarget(targetPath);
      if (
        existing === null
        || !fingerprintMatches(this.#keyProvider, input.context, existing, plan.nextFingerprint)
      ) {
        existing?.fill(0);
        materializationConflict();
      }
      existing.fill(0);
      return Object.freeze({
        status: "completed" as const,
        claim,
      });
    }

    if (claim.status !== "claimed" || claim.claimExpiresAt === null) {
      throw new LifecycleError("EVENT_CONFLICT");
    }
    const now = positiveNow(this.#nowMs());
    if (timestampMs(claim.claimExpiresAt) <= Number(now)) {
      throw new LifecycleError("EVENT_CONFLICT");
    }
    if (!operations.isLatestRevision(plan)) {
      throw new LifecycleError("EVENT_CONFLICT");
    }
    if (!operations.isCurrentWorkflowGeneration(plan)) {
      throw new LifecycleError("EVENT_CONFLICT");
    }

    createDirectoryDurably(dirname(targetPath), input.context.binding.vaultRoot, this.#syncDirectory);
    replacer.cleanup({ targetPath, tempPath: stagedPath });
    const existing = readExistingTarget(targetPath);

    let rendered: Uint8Array | null = null;
    try {
      rendered = this.#render(input.context, plan);
      if (!(rendered instanceof Uint8Array)) materializationConflict();
      assertRenderedFingerprint(this.#keyProvider, input.context, rendered, plan);

      let replace = existing === null;
      if (existing !== null && !bytesEqual(existing, rendered)) {
        const historical = [
          ...(plan.expectedPriorFingerprint === null ? [] : [plan.expectedPriorFingerprint]),
          ...operations.listCommittedLowerRevisionFingerprints(claim),
        ];
        replace = historical.some((fingerprint) => (
          fingerprintMatches(this.#keyProvider, input.context, existing, fingerprint)
        ));
        if (!replace) materializationConflict();
      }
      if (replace) {
        replacer.replace({
          targetPath,
          tempPath: stagedPath,
          bytes: rendered,
          faultContext,
        });
      }
      this.#faults.hit("materialization-ack", "before-write", faultContext);
      const acknowledged = operations.acknowledgeAfterReplacement({
        projectId: plan.projectId,
        targetKey: plan.targetKey,
        materializationRevision: plan.materializationRevision,
        ownerId: claim.claimOwner,
        claimToken: claim.claimToken,
        completedAt: new Date(Number(now)).toISOString(),
        targetPath: plan.artifactPath,
        targetFingerprint: plan.nextFingerprint,
      });
      this.#faults.hit("materialization-ack", "after-write-before-commit", faultContext);
      return acknowledged;
    } finally {
      existing?.fill(0);
      rendered?.fill(0);
    }
  }
}
