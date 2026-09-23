import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { types as utilTypes } from "node:util";
import type { ProjectContext } from "../identity/contracts.js";
import type { SqliteConnection, SqliteDriver } from "../storage/sqlite-driver.js";
import type { RetrievalEvaluationBundleV2, SealedRetrievalEvaluationCorpusV2 } from "../retrieval/evaluation.js";
import { decodeExpectedDifferenceRuleV1, type ExpectedDifferenceRuleV1 } from "../parity/v2-expected-difference.js";
import { authenticateSealedRetrievalSource, compareV1V2Snapshots, reconcileV1V2Snapshots, type SnapshotParityReportV1, type SnapshotParityInput } from "../parity/v2-snapshot-parity.js";
import { V2ShadowCompatibilityMaterializer, type CompatibilityMaterializationResult } from "../materialization/v2-shadow-compatibility.materializer.js";
import { captureCompatibilityPath } from "../materialization/stable-compatibility-directory.js";
import { V2ShadowProjectionPublisher, type ShadowProjectionResult } from "./v2-shadow-projection.js";
import { V2ShadowImporter, type V2ShadowImportResult } from "./v2-shadow-importer.js";
import { ShadowMigrationError, SHADOW_MIGRATION_PHASES, deterministicMigrationUuid, decodeShadowMigrationConfigurationV1,
  decodeShadowMigrationPolicyV1, shadowMigrationConfigurationChecksum, shadowMigrationPolicyChecksum,
  type ShadowMigrationConfigurationV1, type ShadowMigrationPolicyV1, type ShadowMigrationErrorCode, type ShadowMigrationPhase } from "./v2-shadow-migration.contracts.js";
import { canonicalShadowMigrationUtc, createShadowMigrationInvocationDeadline, shadowMigrationPhaseMetadata,
  type ShadowMigrationInvocationDeadline, type ShadowMigrationReconciliation } from "./v2-shadow-migration-runtime.js";
import { verifyV1SourceCopy, type VerifiedV1SourceCopy } from "./v1-source-copy.js";
import { sealV2MigrationPackage, reconcileSealedV2MigrationPackage, type SealedV2MigrationPackage } from "./v2-migration-package.js";
import { assertBoundSqliteConnectionIdentity } from "../storage/node-sqlite-driver.js";
import { SqliteV2ShadowMigrationRepository, type V2ShadowMigrationRun, type V2ShadowMigrationTransaction,
  type V2ShadowMigrationAttemptEvidence } from "../storage/v2-shadow-migration.repository.js";
import { SqliteRolloutControlPlaneRepository } from "../storage/rollout-control-plane.repository.js";
import { RolloutControlPlane } from "../rollout/rollout-control-plane.js";
import { EventStoreError, SqliteEventStoreStatements } from "../storage/event-store.js";
import { isPrimarySqliteBusy, type EventStoreFaultInjector } from "../storage/event-append-transaction.js";
import { MaintenanceFence } from "../storage/maintenance-fence.js";
import { BranchScopeRepository } from "../storage/branch-scope.repository.js";
import { canonicalJson } from "../serialization/canonical-json.js";

export const SHADOW_MIGRATION_FAULT_BOUNDARIES = Object.freeze([
  "after-source-verified", "after-package-published", "after-run-created", "after-import-commit",
  "after-projection-publish", "after-parity-report", "after-compatibility-replace", "after-compatibility-ack",
] as const);
export type ShadowMigrationFaultBoundary = typeof SHADOW_MIGRATION_FAULT_BOUNDARIES[number];
export interface ShadowMigrationFaultInjector { hit(boundary: ShadowMigrationFaultBoundary): void | Promise<void>; }
export interface V2ShadowMigrationRunInput {
  readonly projectId: string; readonly rolloutRevisionId: string; readonly targetContext: ProjectContext;
  readonly sourceRoot: string; readonly sourceManifestPath: string; readonly liveEventStorePath: string;
  readonly liveLegacyArtifactRoot: string; readonly packageRoot: string; readonly v1ProjectionRoot: string;
  readonly v2ProjectionRoot: string; readonly compatibilityRoot: string; readonly buildIdentityHash: string;
  readonly configuration: ShadowMigrationConfigurationV1; readonly policy: ShadowMigrationPolicyV1;
  readonly sealedRetrieval: Readonly<{ corpus: SealedRetrievalEvaluationCorpusV2; expectedBundle: RetrievalEvaluationBundleV2 }>;
  readonly expectedDifferenceRules: readonly ExpectedDifferenceRuleV1[]; readonly creationReasonCode: "production-shaped-rehearsal";
}
export interface V2ShadowMigrationRunResult {
  readonly schemaVersion: 1; readonly status: "compatibility-complete"; readonly migrationIdentity: string;
  readonly rolloutRevisionId: string; readonly sourceManifestChecksum: string; readonly packageChecksum: string;
  readonly import: V2ShadowImportResult; readonly projection: ShadowProjectionResult; readonly parity: SnapshotParityReportV1;
  readonly compatibility: CompatibilityMaterializationResult; readonly deduplicated: boolean;
}
const SAFE_CODES = new Set<ShadowMigrationErrorCode>(["MIGRATION_POLICY_INVALID", "MIGRATION_SOURCE_INVALID", "MIGRATION_SOURCE_MUTATED",
  "MIGRATION_LIMIT_EXCEEDED", "MIGRATION_IDENTITY_CONFLICT", "MIGRATION_LEDGER_INTEGRITY_FAILURE", "MIGRATION_OUTCOME_UNKNOWN",
  "MIGRATION_RETRY_EXHAUSTED", "PROJECTION_INTEGRITY_FAILURE", "PARITY_RULE_INVALID", "PARITY_BLOCKING_DIVERGENCE", "COMPATIBILITY_INTEGRITY_FAILURE"]);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fail(code: ShadowMigrationErrorCode = "MIGRATION_LEDGER_INTEGRITY_FAILURE"): never { throw new ShadowMigrationError(code); }
const equal = (a: unknown, b: unknown): boolean => canonicalJson(decimal(a)) === canonicalJson(decimal(b));
function decimal(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(decimal);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decimal(entry)]));
}
function capture<T>(value: T, deadline?: ShadowMigrationInvocationDeadline, ancestors = new Set<object>()): T {
  deadline?.remainingMs();
  if (typeof value !== "object" || value === null) return value;
  if (utilTypes.isProxy(value) || ancestors.has(value)) fail("MIGRATION_SOURCE_INVALID");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) fail("MIGRATION_SOURCE_INVALID");
  const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("MIGRATION_SOURCE_INVALID");
    Object.defineProperty(result, key, { value: capture(descriptor.value, deadline, ancestors), enumerable: true });
  }
  ancestors.delete(value);
  return Object.freeze(result) as T;
}
const INPUT_KEYS = ["projectId", "rolloutRevisionId", "targetContext", "sourceRoot", "sourceManifestPath", "liveEventStorePath",
  "liveLegacyArtifactRoot", "packageRoot", "v1ProjectionRoot", "v2ProjectionRoot", "compatibilityRoot", "buildIdentityHash",
  "configuration", "policy", "sealedRetrieval", "expectedDifferenceRules", "creationReasonCode"] as const;
function inputFields(value: unknown): V2ShadowMigrationRunInput {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("MIGRATION_SOURCE_INVALID");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== INPUT_KEYS.length || keys.some(key => typeof key !== "string" || !INPUT_KEYS.includes(key as typeof INPUT_KEYS[number]))) fail("MIGRATION_SOURCE_INVALID");
  const fields: Record<string, unknown> = {};
  for (const key of INPUT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("MIGRATION_SOURCE_INVALID");
    fields[key] = descriptor.value;
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  for (const key of ["projectId", "rolloutRevisionId"]) if (typeof fields[key] !== "string" || !uuid.test(fields[key])) fail("MIGRATION_SOURCE_INVALID");
  return Object.freeze(fields) as unknown as V2ShadowMigrationRunInput;
}
function overlaps(a: string, b: string): boolean {
  const child = relative(a, b); return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

type Attempt = Omit<V2ShadowMigrationAttemptEvidence, "projectId" | "migrationIdentity" | "attemptOrdinal" | "phase" | "priorCommittedPhase">;
export interface V2ShadowMigrationPreflightEvidence {
  readonly schemaVersion: 1; readonly rolloutRevisionId: string; readonly sourceManifestChecksum: string | null;
  readonly migrationIdentity: string | null; readonly attempts: readonly (Attempt & { readonly operation: "source-verify" | "package-seal" | "baseline-prepare" })[];
}
/** An exported constructor is intentionally insufficient to confer evidence authority. */
export class V2ShadowMigrationPreflightFailure extends ShadowMigrationError {
  constructor(code: ShadowMigrationErrorCode, readonly evidence: V2ShadowMigrationPreflightEvidence) {
    super(code); this.name = "V2ShadowMigrationPreflightFailure";
  }
}
const genuineFailures = new WeakMap<object, V2ShadowMigrationPreflightEvidence>();
export function readV2ShadowMigrationPreflightEvidence(value: unknown): V2ShadowMigrationPreflightEvidence | null {
  return (typeof value === "object" && value !== null) || typeof value === "function" ? genuineFailures.get(value as object) ?? null : null;
}

interface RunnerOptions {
  readonly driver: SqliteDriver; readonly utcNow?: () => string; readonly monotonicNow?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>; readonly faultInjector?: ShadowMigrationFaultInjector;
  readonly importFaultInjector?: EventStoreFaultInjector;
}
export class V2ShadowMigrationRunner {
  readonly #options: Readonly<RunnerOptions>;
  constructor(options: RunnerOptions) { this.#options = Object.freeze({ ...options }); }
  async run(value: V2ShadowMigrationRunInput): Promise<V2ShadowMigrationRunResult> {
    const fields = inputFields(value), policy = decodeShadowMigrationPolicyV1(fields.policy), configuration = decodeShadowMigrationConfigurationV1(fields.configuration);
    const utc = () => { const value = (this.#options.utcNow ?? (() => new Date().toISOString()))(); canonicalShadowMigrationUtc(value); return value; };
    utc();
    const deadline = createShadowMigrationInvocationDeadline(policy.deadlineMs, this.#options.monotonicNow);
    let input: V2ShadowMigrationRunInput;
    let source: VerifiedV1SourceCopy | undefined, sealedPackage: SealedV2MigrationPackage | undefined, connection: SqliteConnection | undefined;
    const proofPackages = new Set<SealedV2MigrationPackage>();
    let run: V2ShadowMigrationRun | null = null, failed = false;
    const buffered: Attempt[] = [];
    let migrationIdentity: string | null = null;
    const injected = new WeakMap<object, string>();
    const fault = (point: ShadowMigrationFaultBoundary): void | Promise<void> => {
      const annotate = (error: unknown): never => {
        if (typeof error === "object" && error !== null && !utilTypes.isProxy(error)) {
          const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
          if (["EBUSY", "EAGAIN", "EINTR", "WORKER_INTERRUPTED"].includes(code)) injected.set(error, code);
        }
        throw error;
      };
      try { const pending = this.#options.faultInjector?.hit(point); return pending === undefined ? undefined : pending.catch(annotate); }
      catch (error) { return annotate(error); }
    };
    const safeCode = (error: unknown): ShadowMigrationErrorCode => {
      if (error instanceof ShadowMigrationError && SAFE_CODES.has(error.code)) return error.code;
      return "MIGRATION_SOURCE_INVALID";
    };
    try {
      input = Object.freeze({ ...capture({ ...fields, policy: undefined, configuration: undefined }, deadline), policy, configuration });
      if (input.creationReasonCode !== "production-shaped-rehearsal" || input.projectId !== input.targetContext.binding.projectId
        || configuration.policyChecksum !== shadowMigrationPolicyChecksum(policy)
        || configuration.expectedDifferencePolicyVersion !== policy.expectedDifferencePolicyVersion) fail("MIGRATION_POLICY_INVALID");
      const configurationChecksum = shadowMigrationConfigurationChecksum(configuration);
      const eventStorePath = input.targetContext.binding.storeRoute.eventsPath;
      const targetIdentity = captureCompatibilityPath(eventStorePath, false);
      const liveIdentity = captureCompatibilityPath(input.liveEventStorePath, false);
      if (equal(targetIdentity, liveIdentity) || overlaps(input.sourceRoot, eventStorePath)
        || overlaps(input.liveLegacyArtifactRoot, eventStorePath)) fail("MIGRATION_IDENTITY_CONFLICT");
      const roots = [input.sourceRoot, input.packageRoot, input.v1ProjectionRoot, input.v2ProjectionRoot, input.compatibilityRoot, input.liveLegacyArtifactRoot];
      const rootIdentities = roots.map(root => captureCompatibilityPath(root, true));
      for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
        if (equal(rootIdentities[i], rootIdentities[j]) || overlaps(roots[i]!, roots[j]!) || overlaps(roots[j]!, roots[i]!)) fail("MIGRATION_IDENTITY_CONFLICT");
      }
      connection = this.#options.driver.open(eventStorePath, { mode: "existing", busyTimeoutMs: Math.min(5000, deadline.remainingMs()), bindFileIdentity: true });
      const target = connection;
      const authority = () => {
        deadline.remainingMs(); assertBoundSqliteConnectionIdentity(target, eventStorePath, targetIdentity);
        for (const [index, root] of roots.entries()) if (!equal(captureCompatibilityPath(root, true), rootIdentities[index])) fail("MIGRATION_IDENTITY_CONFLICT");
        deadline.remainingMs();
      };
      authority();
      const repository = new SqliteV2ShadowMigrationRepository(target);
      const control = new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(target));
      let revision: ReturnType<RolloutControlPlane["revision"]>;
      let locator: string;
      const rules = () => {
        const actual = utc(), instant = canonicalShadowMigrationUtc(actual), ids = new Set<string>();
        for (const supplied of input.expectedDifferenceRules) {
          deadline.remainingMs(); const rule = decodeExpectedDifferenceRuleV1(supplied);
          if (ids.has(rule.ruleId) || rule.policyVersion !== policy.expectedDifferencePolicyVersion || rule.rolloutRevisionId !== input.rolloutRevisionId
            || rule.migrationIdentity !== locator || Date.parse(rule.issuedAt) > instant || Date.parse(rule.expiresAt) <= instant
            || instant - Date.parse(rule.issuedAt) > policy.maxExpectedDifferenceRuleAgeMs) fail("PARITY_RULE_INVALID"); ids.add(rule.ruleId);
        }
        return actual;
      };
      const reconciledOperations = new Set<string>();
      // These dependencies are trusted in-process runtime services, not a sandbox.
      // data_version only invalidates a proof on OTHER-connection commits; it is
      // neither authentication nor protection against malicious same-handle use.
      let proofVersion: bigint | undefined;
      const dataVersion = (): bigint => {
        try {
          deadline.remainingMs();
          const row = target.prepare("PRAGMA main.data_version").get();
          const version = row?.data_version;
          if (!(typeof version === "bigint" && version >= 0n && version <= 0xffffffffn)
            && !(typeof version === "number" && Number.isSafeInteger(version) && version >= 0 && version <= 0xffffffff)) fail("MIGRATION_OUTCOME_UNKNOWN");
          deadline.remainingMs(); return BigInt(version);
        } catch { fail("MIGRATION_OUTCOME_UNKNOWN"); }
      };
      const assertProofCurrent = () => { if (proofVersion !== undefined && dataVersion() !== proofVersion) fail("MIGRATION_OUTCOME_UNKNOWN"); };
      const checkedProof = async <T>(reconcile: () => ShadowMigrationReconciliation<T> | Promise<ShadowMigrationReconciliation<T>>) => {
        assertProofCurrent();
        const before = dataVersion();
        const result = await reconcile();
        if (dataVersion() !== before) fail("MIGRATION_OUTCOME_UNKNOWN");
        if (result.status === "committed") proofVersion = before;
        return result;
      };
      let snapshotEvidence: string | undefined;
      const transact = <T>(callback: (tx: V2ShadowMigrationTransaction) => T): T => {
        authority(); const result = repository.transact(input.projectId, locator, tx => { authority(); const result = callback(tx); authority(); return result; }); authority(); return result;
      };
      const chain = () => transact(tx => {
        const phases = tx.readTransitions();
        if (source) for (const phase of phases) {
          const expected = shadowMigrationPhaseMetadata(locator, source.manifest.createdAt, phase.ordinal);
          if (phase.attemptId !== expected.attemptId || phase.recordedAt !== expected.recordedAt) fail();
        }
        if (snapshotEvidence !== undefined && phases[0]?.evidenceDigest !== undefined && phases[0].evidenceDigest !== snapshotEvidence) fail();
        if (run && !equal(tx.readRun(), run)) fail();
        return phases;
      });
      const verify = (readChain = true) => {
        authority(); const state = control.state(input.projectId);
        if (state.mode !== "off" || state.revisionId !== null || !equal(control.revision(input.projectId, input.rolloutRevisionId), revision)) fail("MIGRATION_IDENTITY_CONFLICT");
        source?.assertUnchanged(); sealedPackage?.assertUnchanged();
        if (source && snapshotEvidence !== undefined) {
          const parsed = authenticateSealedRetrievalSource(input.sealedRetrieval.corpus, source, deadline);
          if (canonicalJson(parsed.bundle) !== canonicalJson(input.sealedRetrieval.expectedBundle)) fail("MIGRATION_SOURCE_INVALID");
          if (readChain) chain();
        }
        authority(); assertProofCurrent();
      };
      let proofRepositoryUnavailable = false;
      // Only runner-owned writes use this guard. Known typed contradictions stay terminal.
      const mutate = <T>(callback: (tx: V2ShadowMigrationTransaction) => T): T => {
        let possibleCommit = false;
        try { return transact(tx => { const result = callback(tx); possibleCommit = true; return result; }); }
        catch (error) {
          if (possibleCommit && (!(error instanceof ShadowMigrationError) || error.code === "MIGRATION_RETRY_EXHAUSTED")) fail("MIGRATION_OUTCOME_UNKNOWN");
          throw error;
        }
      };
      const ownedProof = <T>(callback: (tx: V2ShadowMigrationTransaction) => ShadowMigrationReconciliation<T>): ShadowMigrationReconciliation<T> => {
        verify(false);
        let entered = false, result: ShadowMigrationReconciliation<T>;
        try { result = repository.transact(input.projectId, locator, tx => { entered = true; return callback(tx); }); }
        catch (error) {
          if (entered && error instanceof ShadowMigrationError && error.code !== "MIGRATION_RETRY_EXHAUSTED") throw error;
          proofRepositoryUnavailable = true;
          return Object.freeze({ status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
        }
        verify(false); return result;
      };
      const record = (operation: string, index: number, phase: ShadowMigrationPhase, category: Attempt["outcomeCategory"], code: string, recordedAt: string) => {
        deadline.remainingMs();
        const body = { operation, operationAttemptIndex: index, outcomeCategory: category, safeErrorCode: code };
        const attempt: Attempt = Object.freeze({ ...body, attemptId: randomUUID(), recordedAt,
          evidenceDigest: hash("project-memory/v2-shadow-migration-attempt-evidence/v1\n" + canonicalJson(body)) });
        if (!run) { buffered.push(attempt); return; }
        pendingAttempts.push(Object.freeze({ attempt, phase }));
        try { flushAttempts(); } catch (error) { if (!primaryBusy(error)) throw error; }
      };
      const pendingAttempts: Readonly<{ attempt: Attempt; phase: ShadowMigrationPhase }>[] = [];
      const flushAttempts = () => {
        if (!pendingAttempts.length) return;
        mutate(tx => {
          const phases = tx.readTransitions(), priorCommittedPhase = phases.at(-1)?.phase ?? null;
          let attemptOrdinal = tx.readAttemptEvidence().length;
          for (const { attempt, phase } of pendingAttempts) {
            authority();
            tx.appendAttemptEvidence({ ...attempt, projectId: input.projectId, migrationIdentity: locator,
              attemptOrdinal: attemptOrdinal++, phase, priorCommittedPhase });
          }
        });
        pendingAttempts.length = 0;
      };
      const primaryBusy = (error: unknown) => {
        const cause = error instanceof ShadowMigrationError ? Object.getOwnPropertyDescriptor(error, "cause")?.value : undefined;
        return error instanceof EventStoreError && error.code === "SQLITE_BUSY" || isPrimarySqliteBusy(error)
          || error instanceof ShadowMigrationError && error.code === "MIGRATION_IDENTITY_CONFLICT"
            && cause instanceof EventStoreError && cause.code === "SQLITE_BUSY";
      };
      const attemptIndices = new Map<string, number>();
      const backoff = async (index: number) => {
        const milliseconds = Math.min(policy.maxBackoffMs, policy.initialBackoffMs * 2 ** index, deadline.remainingMs());
        try {
          if (this.#options.sleep) await this.#options.sleep(milliseconds, deadline.signal);
          else await delay(milliseconds, undefined, { signal: deadline.signal });
        } catch (error) { deadline.remainingMs(); throw error; }
      };
      // Read retry never re-enters the action that produced a completed result.
      // The operation shares one retry counter across its action and checked reads.
      // A held writer can prevent redacted evidence persistence: retain observations
      // only in memory, and flush before any subsequent semantic work. Exhaustion
      // does not grant authority to write late or claim those observations durable.
      const readChecked = async <T>(operation: string, phase: ShadowMigrationPhase, read: () => T,
        possibleOutcome = false, unresolvedOutcome = false): Promise<T> => {
        let retry = false;
        for (;;) {
          try {
            deadline.remainingMs();
            if (retry) { if (revision) verify(); else authority(); }
            const result = read(); flushAttempts(); return result;
          } catch (error) {
            if (!primaryBusy(error)) {
              if (possibleOutcome && (!(error instanceof ShadowMigrationError) || safeCode(error) === "MIGRATION_RETRY_EXHAUSTED")) fail("MIGRATION_OUTCOME_UNKNOWN");
              throw error;
            }
            // Unresolved mutation proofs have stricter authority than ordinary
            // completed-action validation: contention retains unknown, without
            // another proof, action, or forced/out-of-order evidence write.
            if (unresolvedOutcome) fail("MIGRATION_OUTCOME_UNKNOWN");
            try { deadline.remainingMs(); } catch { fail(possibleOutcome ? "MIGRATION_OUTCOME_UNKNOWN" : "MIGRATION_RETRY_EXHAUSTED"); }
            const index = attemptIndices.get(operation) ?? 0, exhausted = index >= policy.maxRetries;
            try { record(operation, index, phase, exhausted ? "retry-exhausted" : "retryable-failure",
              exhausted ? "MIGRATION_RETRY_EXHAUSTED" : "SQLITE_BUSY", utc()); }
            catch (error) {
              if (possibleOutcome && (!(error instanceof ShadowMigrationError) || safeCode(error) === "MIGRATION_RETRY_EXHAUSTED")) fail("MIGRATION_OUTCOME_UNKNOWN");
              throw error;
            }
            if (exhausted) fail(possibleOutcome ? "MIGRATION_OUTCOME_UNKNOWN" : "MIGRATION_RETRY_EXHAUSTED");
            attemptIndices.set(operation, index + 1);
            try { await backoff(index); } catch (error) {
              if (possibleOutcome && safeCode(error) === "MIGRATION_RETRY_EXHAUSTED") fail("MIGRATION_OUTCOME_UNKNOWN");
              throw error;
            }
            retry = true;
          }
        }
      };
      const execute = async <T>(operation: string, phase: ShadowMigrationPhase, action: () => T | Promise<T>,
        reconcile?: () => ShadowMigrationReconciliation<T> | Promise<ShadowMigrationReconciliation<T>>): Promise<T> => {
        for (;;) {
          await readChecked(operation, phase, verify);
          let result: T;
          try { result = await action(); }
          catch (error) {
            let index = attemptIndices.get(operation) ?? 0;
            const code = safeCode(error);
            const injectedCode = typeof error === "object" && error !== null ? injected.get(error) : undefined;
            const busy = primaryBusy(error);
            const retryable = busy || injectedCode !== undefined;
            const unknown = code === "MIGRATION_OUTCOME_UNKNOWN" || (injectedCode === "WORKER_INTERRUPTED" && operation !== "source-verify");
            try { deadline.remainingMs(); } catch { if (unknown) fail("MIGRATION_OUTCOME_UNKNOWN"); throw error instanceof ShadowMigrationError ? new ShadowMigrationError(code) : new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED"); }
            // Timestamp the observed failure, before proof; never invoke the UTC
            // dependency between committed proof and its operational attempt.
            const observedAt = utc();
            if (unknown) {
              let proof: ShadowMigrationReconciliation<T> | undefined;
              try { await readChecked(operation, phase, () => verify(false), true, true); proof = reconcile ? await checkedProof(reconcile) : undefined; }
              catch (proofError) {
                if (primaryBusy(proofError) || safeCode(proofError) === "MIGRATION_RETRY_EXHAUSTED") fail("MIGRATION_OUTCOME_UNKNOWN");
                throw proofError;
              }
              try { deadline.remainingMs(); } catch { fail("MIGRATION_OUTCOME_UNKNOWN"); }
              if (!proofRepositoryUnavailable) {
                await readChecked(operation, phase, verify, true, true);
                try { record(operation, index, phase, "unknown-outcome", "MIGRATION_OUTCOME_UNKNOWN", observedAt); }
                catch (error) {
                  // A failed operational evidence write cannot resolve the original
                  // possible component mutation; independent contradictions stay terminal.
                  if (!(error instanceof ShadowMigrationError) || error.code === "MIGRATION_RETRY_EXHAUSTED") fail("MIGRATION_OUTCOME_UNKNOWN");
                  throw error;
                }
              }
              if (proof?.status === "committed") {
                await readChecked(operation, phase, verify, true, true);
                reconciledOperations.add(operation); return proof.result;
              }
              if (proof?.status !== "absent") {
                fail("MIGRATION_OUTCOME_UNKNOWN");
              }
            } else if (!retryable) { record(operation, index, phase, "terminal-failure", code, observedAt); throw new ShadowMigrationError(code); }
            index = attemptIndices.get(operation) ?? index;
            if (index >= policy.maxRetries) { record(operation, index, phase, "retry-exhausted", "MIGRATION_RETRY_EXHAUSTED", observedAt); fail("MIGRATION_RETRY_EXHAUSTED"); }
            if (!unknown) record(operation, index, phase, "retryable-failure", busy ? "SQLITE_BUSY" : injectedCode ?? code, observedAt);
            attemptIndices.set(operation, index + 1);
            await backoff(index);
            continue;
          }
          await readChecked(operation, phase, verify, operation !== "source-verify");
          return result;
        }
      };
      revision = await readChecked("source-verify", "snapshot-verified", () => {
        authority(); const result = control.revision(input.projectId, input.rolloutRevisionId); authority(); return result;
      });
      if (!revision || revision.projectId !== input.projectId || revision.buildIdentityHash !== input.buildIdentityHash
        || revision.configurationChecksum !== configurationChecksum) fail("MIGRATION_IDENTITY_CONFLICT");
      locator = revision.migrationIdentityHash;
      rules();
      const binding = input.targetContext.binding;
      source = await execute("source-verify", "snapshot-verified", async () => {
        source?.close(); source = undefined;
        source = await verifyV1SourceCopy({ driver: this.#options.driver, sourceRoot: input.sourceRoot, manifestPath: input.sourceManifestPath,
          liveEventStorePath: input.liveEventStorePath, liveLegacyArtifactRoot: input.liveLegacyArtifactRoot,
          expectedBinding: { projectId: binding.projectId, vaultId: binding.vaultId, storeId: binding.storeId, workspaceId: binding.workspaceId,
            branchScopeId: input.targetContext.branchScopeId ?? null,
            branchRef: input.targetContext.workspace.kind === "git" ? input.targetContext.workspace.branchRef : null, sessionId: null }, policy, invocationDeadline: deadline });
        const pending = fault("after-source-verified"); if (pending !== undefined) await pending;
        const parsed = authenticateSealedRetrievalSource(input.sealedRetrieval.corpus, source, deadline);
        if (canonicalJson(parsed.bundle) !== canonicalJson(input.sealedRetrieval.expectedBundle)) fail("MIGRATION_SOURCE_INVALID");
        return source;
      });
      const verifiedSource = source;
      const corpus = authenticateSealedRetrievalSource(input.sealedRetrieval.corpus, source, deadline);
      if (canonicalJson(corpus.bundle) !== canonicalJson(input.sealedRetrieval.expectedBundle)) fail("MIGRATION_SOURCE_INVALID");
      const corpusPin = hash("project-memory/v2-shadow-migration-corpus-pin/v1\n" + canonicalJson(corpus.bundle));
      snapshotEvidence = hash("project-memory/v2-shadow-migration-snapshot-evidence/v1\n" + canonicalJson({ sourceManifestChecksum: source.manifest.manifestChecksum, corpusPin }));
      for (let ordinal = 0; ordinal < 6; ordinal++) shadowMigrationPhaseMetadata(locator, source.manifest.createdAt, ordinal);
      const assertNoOwnedEffects = (tx: V2ShadowMigrationTransaction) => {
        if (tx.readImportedRecords().length || tx.readCompatibilityOutbox().length || tx.readCompatibilityClaims().length
          || tx.readCompatibilityAcknowledgements().length || tx.readExpectedDifferenceRules().length || tx.readParityReport()) fail();
        const params = { $stream: `v2-shadow-import/${locator}`, $prefix: `v2-shadow-import:${locator}:*`, $identity: locator };
        if (target.prepare("SELECT 1 FROM events WHERE stream_id=$stream OR idempotency_key GLOB $prefix OR (json_valid(payload_json) AND json_extract(payload_json,'$.migrationIdentity')=$identity) LIMIT 1").get(params)
          || target.prepare("SELECT 1 FROM command_dedup WHERE idempotency_key GLOB $prefix LIMIT 1").get({ $prefix: params.$prefix })) fail();
        const statement = target.prepare("SELECT 1 FROM events WHERE event_id=$id LIMIT 1");
        for (let ordinal = 0; ordinal < verifiedSource.manifest.eventCount + verifiedSource.manifest.legacyArtifacts.length; ordinal++) {
          authority(); if (statement.get({ $id: deterministicMigrationUuid("event", locator, ordinal) })) fail();
        }
      };
      const prior = await readChecked("source-verify", "snapshot-verified", () => transact(tx => {
        const existing = tx.readRun(), phases = tx.readTransitions();
        if (existing && (existing.projectId !== input.projectId || existing.rolloutRevisionId !== input.rolloutRevisionId
          || existing.migrationIdentity !== locator || existing.sourceManifestChecksum !== verifiedSource.manifest.manifestChecksum
          || existing.sourceTerminalPosition !== BigInt(verifiedSource.manifest.terminalEventPosition)
          || existing.sourceTerminalHash !== verifiedSource.manifest.terminalEventHash || existing.configurationChecksum !== configurationChecksum
          || existing.policyChecksum !== shadowMigrationPolicyChecksum(policy) || existing.buildIdentityHash !== input.buildIdentityHash
          || existing.createdAt !== verifiedSource.manifest.createdAt)) fail();
        if (phases.length && !existing) fail();
        if (phases[0] && phases[0].evidenceDigest !== snapshotEvidence) fail();
        if (!phases.length) assertNoOwnedEffects(tx);
        return { existing, phases };
      }));
      const completed = prior.phases.length === 6;
      await readChecked("package-seal", "package-sealed", verify);
      const packageInput = { source: verifiedSource, packageRoot: input.packageRoot, policy, buildIdentityHash: input.buildIdentityHash,
        configurationChecksum, invocationDeadline: deadline };
      const packageProof = () => {
        const proof = reconcileSealedV2MigrationPackage({ ...packageInput, expectedMigrationIdentity: locator });
        if (proof.status === "committed") proofPackages.add(proof.result);
        return proof;
      };
      const committed = <T>(proof: ShadowMigrationReconciliation<T>): T => { if (proof.status !== "committed") fail("MIGRATION_OUTCOME_UNKNOWN"); return proof.result; };
      sealedPackage = completed ? committed(await checkedProof(packageProof)) : await execute("package-seal", "package-sealed", () => sealV2MigrationPackage({ ...packageInput,
        onPhase: phase => phase === "after-final-rename-before-response" ? fault("after-package-published") : undefined }), packageProof);
      proofPackages.delete(sealedPackage);
      migrationIdentity = sealedPackage.migrationIdentity;
      if (migrationIdentity !== locator) fail("MIGRATION_IDENTITY_CONFLICT");
      const package_ = sealedPackage;
      const componentFault = (point: "after-projection-publish" | "after-parity-report"): void | Promise<void> => {
        const pending = fault(point);
        const settled = () => {
          const check = () => { verify(); if (point === "after-parity-report") rules(); };
          try { check(); } catch (error) {
            if (!primaryBusy(error)) throw error;
            // The first observed busy must be handled, not silently discarded.
            let first = true;
            return readChecked(point === "after-projection-publish" ? "projection" : "parity",
              point === "after-projection-publish" ? "projection-verified" : "parity-complete", () => {
                if (first) { first = false; throw error; } check();
              }, true);
          }
        };
        if (pending !== undefined) return pending.then(settled);
        return settled();
      };
      const publisherOptions = { driver: this.#options.driver, connection: target, eventStorePath, liveEventStorePath: input.liveEventStorePath,
        liveVaultRoot: input.liveLegacyArtifactRoot, v1ProjectionDirectory: input.v1ProjectionRoot, v2ProjectionDirectory: input.v2ProjectionRoot, policy,
        faultInjector: { hit: (boundary: "before-v2-integrity" | "before-v1-manifest") => boundary === "before-v2-integrity" ? componentFault("after-projection-publish") : undefined } };
      const publisher = new V2ShadowProjectionPublisher(publisherOptions);
      const baselineInput = { source: verifiedSource, sealedPackage: package_, invocationDeadline: deadline };
      const baselineProof = () => publisher.reconcileV1Baseline(baselineInput);
      const preparedV1 = completed ? committed(await checkedProof(baselineProof)) : await execute("baseline-prepare", "package-sealed", () => publisher.prepareV1Baseline(baselineInput), baselineProof);
      if (preparedV1.baselineChecksum !== revision.v1BaselineChecksum) fail("MIGRATION_IDENTITY_CONFLICT");
      await readChecked("baseline-prepare", "package-sealed", verify);
      const expectedRun: V2ShadowMigrationRun = Object.freeze({ projectId: input.projectId, migrationIdentity: locator, rolloutRevisionId: input.rolloutRevisionId,
        sourceManifestChecksum: verifiedSource.manifest.manifestChecksum, sourceTerminalPosition: BigInt(verifiedSource.manifest.terminalEventPosition),
        sourceTerminalHash: verifiedSource.manifest.terminalEventHash, packageChecksum: package_.manifest.packageChecksum, configurationChecksum,
        policyChecksum: shadowMigrationPolicyChecksum(policy), buildIdentityHash: input.buildIdentityHash, createdAt: verifiedSource.manifest.createdAt });
      if (prior.existing && !equal(prior.existing, expectedRun)) fail();
      let flushed: V2ShadowMigrationAttemptEvidence[] = [];
      if (prior.existing && buffered.length === 0) run = prior.existing;
      else await execute("run-create", "snapshot-verified", async () => {
        mutate(tx => {
          const existing = tx.readRun();
          if (existing && !equal(existing, expectedRun)) fail();
          if (!existing) tx.insertRun(expectedRun);
          const attempts = tx.readAttemptEvidence(), priorCommittedPhase = tx.readTransitions().at(-1)?.phase ?? null;
          flushed = buffered.map((attempt, index) => ({ ...attempt, projectId: input.projectId, migrationIdentity: locator,
            attemptOrdinal: attempts.length + index, phase: attempt.operation === "source-verify" ? "snapshot-verified" : "package-sealed", priorCommittedPhase }));
          for (const attempt of flushed) tx.appendAttemptEvidence(attempt);
        }); run = expectedRun;
        if (!prior.existing) {
          try { const pending = fault("after-run-created"); if (pending !== undefined) await pending; deadline.remainingMs(); }
          catch { fail("MIGRATION_OUTCOME_UNKNOWN"); }
        }
        return expectedRun;
      }, () => ownedProof(tx => { const actual = tx.readRun(); if (!actual) return Object.freeze({ status: "absent" as const });
        if (!equal(actual, expectedRun)) fail();
        const attempts = tx.readAttemptEvidence();
        if (flushed.some(expected => !equal(attempts[expected.attemptOrdinal], expected))) fail();
        run = actual; return Object.freeze({ status: "committed" as const, result: actual }); }));
      buffered.length = 0;
      const append = async (ordinal: 0 | 1 | 2 | 5, evidenceDigest: string) => {
        await readChecked(`phase-${ordinal}`, SHADOW_MIGRATION_PHASES[ordinal], verify);
        const transition = await readChecked(`phase-${ordinal}`, SHADOW_MIGRATION_PHASES[ordinal], () => transact(tx => {
          const phases = tx.readTransitions();
          const body = { projectId: input.projectId, migrationIdentity: locator, ordinal, ...shadowMigrationPhaseMetadata(locator, verifiedSource.manifest.createdAt, ordinal),
            phase: SHADOW_MIGRATION_PHASES[ordinal], priorTransitionHash: ordinal ? phases[ordinal - 1]?.transitionHash : "0".repeat(64), evidenceDigest };
          if (body.priorTransitionHash === undefined) fail();
          const transition = { ...body, priorTransitionHash: body.priorTransitionHash!, transitionHash: hash("project-memory/v2-shadow-migration-transition/v1\n" + canonicalJson(body)) };
          if (phases[ordinal] && !equal(phases[ordinal], transition)) fail();
          return transition;
        }));
        if ((await readChecked(`phase-${ordinal}`, SHADOW_MIGRATION_PHASES[ordinal], chain))[ordinal]) return;
        await execute(`phase-${ordinal}`, SHADOW_MIGRATION_PHASES[ordinal], () => mutate(tx => {
          assertProofCurrent();
          const phases = tx.readTransitions();
          if (phases[ordinal]) { if (!equal(phases[ordinal], transition)) fail(); return transition; }
          if (phases.length !== ordinal || (ordinal && phases[ordinal - 1]?.transitionHash !== transition.priorTransitionHash)) fail();
          // The early preparation check is not a lock across awaited work.
          // Repeat it while this first-pin transaction owns the writer position.
          if (ordinal === 0) assertNoOwnedEffects(tx);
          tx.appendTransition(transition); return transition;
        }), () => ownedProof(tx => {
          const phases = tx.readTransitions();
          if (!phases[ordinal]) return Object.freeze({ status: "absent" as const });
          if (!equal(phases[ordinal], transition)) fail();
          return Object.freeze({ status: "committed" as const, result: phases[ordinal]! });
        }));
      };
      await append(0, snapshotEvidence);
      if (!completed && !reconciledOperations.has("package-seal")) {
        const authenticated = committed(await checkedProof(packageProof)); authenticated.close(); proofPackages.delete(authenticated);
      }
      await append(1, package_.manifest.packageChecksum);
      const importer = new V2ShadowImporter({ connection: target, statements: new SqliteEventStoreStatements(target), maintenance: new MaintenanceFence(),
        branchScopes: new BranchScopeRepository(), policy, eventStorePath, ...(this.#options.importFaultInjector ? { faultInjector: this.#options.importFaultInjector } : {}) });
      const importInput = { context: input.targetContext, sealedPackage: package_, invocationDeadline: deadline };
      const importProof = () => importer.reconcile(importInput);
      const imported = completed ? committed(await checkedProof(importProof)) : await execute("import", "import-committed", async () => {
        const result = importer.import(importInput);
        try { const pending = fault("after-import-commit"); if (pending !== undefined) await pending; deadline.remainingMs(); }
        catch { fail("MIGRATION_OUTCOME_UNKNOWN"); }
        return result;
      }, importProof);
      if (!completed && !reconciledOperations.has("import")) committed(await checkedProof(importProof));
      await append(2, imported.importedEventsChecksum);
      const projectionInput = { ...baselineInput, preparedV1, rolloutRevisionId: input.rolloutRevisionId };
      const projectionProof = () => publisher.reconcileV2(projectionInput);
      const projection = completed ? committed(await checkedProof(projectionProof)) : await execute("projection", "projection-verified", () => publisher.publishV2(projectionInput), projectionProof);
      await readChecked("projection", "projection-verified", verify);
      const parityInput = (): SnapshotParityInput => ({ ...publisherOptions, ...projectionInput, projections: projection, runStartedAt: rules(),
        rules: input.expectedDifferenceRules, sealedRetrieval: { corpus }, faultInjector: { hit: () => componentFault("after-parity-report") } });
      const parityProof = () => reconcileV1V2Snapshots(parityInput());
      const parity = completed ? committed(await checkedProof(parityProof)) : await execute("parity", "parity-complete", () => compareV1V2Snapshots(parityInput()), parityProof);
      await readChecked("parity", "parity-complete", verify);
      const compatibility = new V2ShadowCompatibilityMaterializer({ driver: this.#options.driver, connection: target, eventStorePath,
        isolatedRoot: input.compatibilityRoot, liveEventStorePath: input.liveEventStorePath, liveVaultRoot: input.liveLegacyArtifactRoot,
        policy, fault: point => fault(point) });
      const compatibilityInput = { ...baselineInput, rolloutRevisionId: input.rolloutRevisionId };
      const compatibilityProof = () => compatibility.reconcile(compatibilityInput);
      const materialized = completed ? committed(await checkedProof(compatibilityProof)) : await execute("compatibility", "compatibility-complete", () => compatibility.materializePending(compatibilityInput), compatibilityProof);
      if (!completed && !reconciledOperations.has("compatibility")) committed(await checkedProof(compatibilityProof));
      if (!completed && !reconciledOperations.has("parity")) committed(await checkedProof(parityProof));
      await append(5, materialized.artifactSetChecksum);
      rules(); await readChecked("compatibility", "compatibility-complete", verify);
      if ((await readChecked("compatibility", "compatibility-complete", chain)).length !== 6) fail();
      return Object.freeze({ schemaVersion: 1, status: "compatibility-complete", migrationIdentity: locator, rolloutRevisionId: input.rolloutRevisionId,
        sourceManifestChecksum: verifiedSource.manifest.manifestChecksum, packageChecksum: package_.manifest.packageChecksum,
        import: imported, projection, parity, compatibility: materialized, deduplicated: completed });
    } catch (error) {
      failed = true;
      const code = safeCode(error);
      if (!run) {
        const attempts = buffered.filter((attempt): attempt is Attempt & { operation: "source-verify" | "package-seal" | "baseline-prepare" } =>
          ["source-verify", "package-seal", "baseline-prepare"].includes(attempt.operation));
        const evidence: V2ShadowMigrationPreflightEvidence = capture({ schemaVersion: 1, rolloutRevisionId: fields.rolloutRevisionId,
          sourceManifestChecksum: source?.manifest.manifestChecksum ?? null, migrationIdentity, attempts });
        const failure = new V2ShadowMigrationPreflightFailure(code, evidence);
        genuineFailures.set(failure, evidence); Object.freeze(failure); throw failure;
      }
      throw new ShadowMigrationError(code);
    } finally {
      let cleanupFailed = false;
      for (const close of [...Array.from(proofPackages, proof => () => proof.close()), () => sealedPackage?.close(), () => source?.close(), () => connection?.close()]) try { close(); } catch { cleanupFailed = true; }
      try { if (!failed) deadline.remainingMs(); } finally { deadline.dispose(); }
      if (cleanupFailed && !failed) fail("MIGRATION_OUTCOME_UNKNOWN");
    }
  }
}
