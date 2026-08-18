import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

import type { CapabilityKeyProvider } from "./authority/capability-key-provider.js";
import {
  TrustedValidationProfileRegistry,
  expandValidationAttemptPlan,
  type ResolvedTrustedValidationProfile,
} from "./validation-profile.registry.js";
import type { ValidationAttemptPlanIdentityV1 } from "./contracts/commands.js";
import {
  decodeValidationResultV1,
  type ValidationResultV1,
} from "./contracts/session-end.js";
import type { SourceStateFingerprintV1 } from "./contracts/checkpoint.js";
import { LifecycleError } from "./errors.js";
import {
  NO_LIFECYCLE_FAULTS,
  type LifecycleFaultContext,
  type LifecycleFaultInjector,
} from "./lifecycle-faults.js";

const MAX_SUMMARY_SCALARS = 4_000;
const HASH = /^[0-9a-f]{64}$/u;

export interface ValidationProcessInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface ValidationProcessResult {
  readonly status: number | null;
  readonly stdout: string | Uint8Array;
  readonly stderr: string | Uint8Array;
  readonly timedOut?: boolean;
}

export interface ValidationProcessRunner {
  run(invocation: ValidationProcessInvocation): Promise<ValidationProcessResult>;
}

export interface ValidationProfileRunnerOptions {
  readonly registry: TrustedValidationProfileRegistry;
  readonly keyProvider: Pick<CapabilityKeyProvider, "currentKey" | "fingerprint">;
  readonly processRunner?: ValidationProcessRunner;
  readonly now?: () => string;
  readonly faultInjector?: LifecycleFaultInjector;
}

export interface ValidationProfileRunInput {
  readonly attemptPlan: ValidationAttemptPlanIdentityV1;
  readonly sourceStateAtStart: SourceStateFingerprintV1;
  readonly sourceStateAtCompletion: SourceStateFingerprintV1;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly fresh?: boolean;
  readonly artifactReferences?: readonly string[];
}

class NodeValidationProcessRunner implements ValidationProcessRunner {
  run(invocation: ValidationProcessInvocation): Promise<ValidationProcessResult> {
    return new Promise((resolve) => {
      execFile(invocation.executable, [...invocation.args], {
        cwd: invocation.cwd,
        env: { ...invocation.env },
        shell: false,
        timeout: invocation.timeoutMs,
        maxBuffer: invocation.maxOutputBytes,
        encoding: "buffer",
        windowsHide: true,
      }, (error, stdout, stderr) => {
        const status = error === null ? 0
          : typeof error.code === "number" ? error.code
            : null;
        resolve(Object.freeze({
          status,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
          timedOut: error !== null && (error.killed === true || error.code === "ETIMEDOUT"),
        }));
      });
    });
  }
}

function invalid(): never {
  throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
}

interface BoundedOutput {
  readonly bytes: Buffer;
  readonly exceeded: boolean;
}

function outputBytes(value: string | Uint8Array, maximumBytes: number): BoundedOutput {
  if (typeof value === "string") {
    const byteLength = Buffer.byteLength(value, "utf8");
    // Copy at most the trusted bound.  A hostile process adapter can return a
    // giant string, but the runner never needs to materialize it in full.
    return {
      bytes: Buffer.from(byteLength > maximumBytes ? value.slice(0, maximumBytes) : value, "utf8"),
      exceeded: byteLength > maximumBytes,
    };
  }
  if (!(value instanceof Uint8Array)) invalid();
  return {
    bytes: Buffer.from(value.subarray(0, maximumBytes)),
    exceeded: value.byteLength > maximumBytes,
  };
}

function zeroizeMutable(value: unknown): void {
  if (!(value instanceof Uint8Array)) return;
  try {
    value.fill(0);
  } catch {
    // Some host-owned typed-array views may be immutable; the copied Buffer is still cleared.
  }
}

function redactOutput(value: string): string {
  return value
    .replace(/(?:^|(?<=[{,\s]))(["']?)[A-Z0-9_-]*(?:SECRET|TOKEN|PASSWORD|PASSPHRASE|API[_-]?KEY|AUTHORIZATION|AUTH|CREDENTIAL|KEY)[A-Z0-9_-]*\1\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/giu, "[REDACTED]")
    // Unknown diagnostic field names are not a secrecy boundary.  Redact all
    // quoted JSON values before either summary construction or fingerprinting.
    .replace(/(["'][^"'\\]*(?:\\.[^"'\\]*)*["'])\s*:\s*(["'])(?:\\.|[^\\])*?\2/gu, "$1: \"[REDACTED]\"")
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [REDACTED]")
    .replace(/[A-Za-z]:\\[^\r\n\s]+/gu, "[PATH]")
    .replace(/(?:^|\s)\/[^\r\n\s]+/gu, " [PATH]");
}

function summary(
  status: "pass" | "fail" | "unavailable",
  exitClassification: "passed" | "failed" | "unavailable",
  output: string,
): string {
  const prefix = status === "pass" ? "Validation passed"
    : status === "fail" ? "Validation failed"
      : "Validation unavailable";
  const safeOutput = redactOutput(output).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ").trim();
  const value = safeOutput.length === 0
    ? `${prefix} (${exitClassification})`
    : `${prefix} (${exitClassification}): ${safeOutput}`;
  return Array.from(value).slice(0, MAX_SUMMARY_SCALARS).join("");
}

function sourceState(value: SourceStateFingerprintV1): SourceStateFingerprintV1 {
  return Object.freeze({ ...value });
}

function outputFingerprint(
  keyProvider: Pick<CapabilityKeyProvider, "currentKey" | "fingerprint">,
  attemptPlan: ValidationAttemptPlanIdentityV1,
  bytes: Uint8Array,
): ValidationResultV1["outputFingerprint"] {
  const key = keyProvider.currentKey({
    projectId: attemptPlan.projectId,
    storeId: attemptPlan.storeId,
  }, "validation-output-fingerprint");
  const fingerprint = keyProvider.fingerprint({
    projectId: attemptPlan.projectId,
    storeId: attemptPlan.storeId,
    purpose: "validation-output-fingerprint",
    keyId: key.keyId,
    domain: "pm-validation-output-v1",
    bytes,
  });
  if (typeof fingerprint !== "string" || !HASH.test(fingerprint)) invalid();
  return Object.freeze({
    fingerprintSchemaVersion: 1,
    fingerprintKeyId: key.keyId,
    fingerprintDomain: "pm-validation-output-v1",
    fingerprint,
  });
}

function invocation(profile: ResolvedTrustedValidationProfile): ValidationProcessInvocation {
  return Object.freeze({
    executable: profile.executable,
    args: profile.args,
    cwd: profile.cwd,
    env: profile.env ?? Object.freeze({}),
    shell: false,
    timeoutMs: profile.timeoutMs,
    maxOutputBytes: profile.maxOutputBytes,
  });
}

export class ValidationProfileRunner {
  readonly #registry: TrustedValidationProfileRegistry;
  readonly #keyProvider: Pick<CapabilityKeyProvider, "currentKey" | "fingerprint">;
  readonly #processRunner: ValidationProcessRunner;
  readonly #now: () => string;
  readonly #faults: LifecycleFaultInjector;

  constructor(options: ValidationProfileRunnerOptions) {
    this.#registry = options.registry;
    this.#keyProvider = options.keyProvider;
    this.#processRunner = options.processRunner ?? new NodeValidationProcessRunner();
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#faults = options.faultInjector ?? NO_LIFECYCLE_FAULTS;
    Object.freeze(this);
  }

  async run(input: ValidationProfileRunInput): Promise<ValidationResultV1> {
    const suppliedPlan = input.attemptPlan;
    const attemptPlan = expandValidationAttemptPlan({
      plan: {
        profileId: suppliedPlan.profileId,
        profileVersion: suppliedPlan.profileVersion,
        runId: suppliedPlan.runId,
        resultId: suppliedPlan.resultId,
        commandId: suppliedPlan.resultCommandId,
        idempotencyKey: suppliedPlan.resultIdempotencyKey,
      },
      context: suppliedPlan,
      expectedProfileConfigurationHash: suppliedPlan.profileConfigurationHash,
    }, this.#registry);
    const profile = this.#registry.resolve(attemptPlan.profileId, attemptPlan.profileVersion);
    const startedAt = input.startedAt ?? this.#now();
    const faultContext: LifecycleFaultContext = Object.freeze({
      projectId: attemptPlan.projectId,
      sessionId: attemptPlan.sessionId,
      workflowId: attemptPlan.workflowId,
      commandId: attemptPlan.resultCommandId,
      idempotencyKeyHash: createHash("sha256")
        .update(attemptPlan.resultIdempotencyKey, "utf8")
        .digest("hex"),
      workId: attemptPlan.plannedWorkId,
      eventPosition: null,
      materializationRevision: null,
    });
    this.#faults.hit("validation-result", "before-external-start", faultContext);
    let processResult: ValidationProcessResult;
    try {
      processResult = await this.#processRunner.run(invocation(profile));
    } catch {
      processResult = { status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (typeof processResult !== "object" || processResult === null) {
      processResult = { status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    let rawStdout: unknown;
    let rawStderr: unknown;
    let processStatus: number | null = null;
    let processTimedOut = false;
    try {
      rawStdout = processResult.stdout;
      rawStderr = processResult.stderr;
      processStatus = typeof processResult.status === "number"
        && Number.isSafeInteger(processResult.status)
        ? processResult.status
        : null;
      processTimedOut = processResult.timedOut === true;
    } catch {
      rawStdout = undefined;
      rawStderr = undefined;
      processStatus = null;
      processTimedOut = false;
    }
    let stdout: Buffer | undefined;
    let stderr: Buffer | undefined;
    let combined: Buffer | undefined;
    let redactedOutput: Buffer | undefined;
    try {
      let stdoutOutput: BoundedOutput;
      let stderrOutput: BoundedOutput;
      try {
        stdoutOutput = outputBytes(rawStdout as string | Uint8Array, profile.maxOutputBytes);
        stderrOutput = outputBytes(rawStderr as string | Uint8Array, profile.maxOutputBytes);
      } catch {
        // A malformed adapter result is an unavailable validation, not a
        // reason to escape before the cleanup boundary.
        stdoutOutput = { bytes: Buffer.alloc(0), exceeded: true };
        stderrOutput = { bytes: Buffer.alloc(0), exceeded: true };
      }
      stdout = stdoutOutput.bytes;
      stderr = stderrOutput.bytes;
      const totalLength = stdout.length + 1 + stderr.length;
      const boundedLength = Math.min(totalLength, profile.maxOutputBytes);
      combined = Buffer.allocUnsafe(boundedLength);
      const stdoutLength = Math.min(stdout.length, boundedLength);
      stdout.copy(combined, 0, 0, stdoutLength);
      if (stdoutLength < boundedLength) {
        combined[stdoutLength] = 10;
        stderr.copy(combined, stdoutLength + 1, 0, boundedLength - stdoutLength - 1);
      }
      const outputExceeded = stdoutOutput.exceeded || stderrOutput.exceeded || totalLength > profile.maxOutputBytes;
      // JavaScript strings cannot be zeroized; raw output remains scoped here
      // and is never persisted or fingerprinted.
      const outputText = combined.toString("utf8");
      redactedOutput = Buffer.from(redactOutput(outputText), "utf8");
      const boundedRedactedOutput = redactedOutput.length > profile.maxOutputBytes
        ? redactedOutput.subarray(0, profile.maxOutputBytes)
        : redactedOutput;
      const status = processTimedOut || outputExceeded || processStatus === null ? "unavailable" as const
        : processStatus === 0 ? "pass" as const : "fail" as const;
      const exitClassification = status === "pass" ? "passed" as const
        : status === "fail" ? "failed" as const : "unavailable" as const;
      const fingerprint = outputFingerprint(this.#keyProvider, attemptPlan, boundedRedactedOutput);
      this.#faults.hit("validation-result", "after-external-complete-before-result-commit", faultContext);
      const completedAt = input.completedAt ?? this.#now();
      const result = {
        validationResultVersion: 1 as const,
        resultId: attemptPlan.resultId,
        projectId: attemptPlan.projectId,
        vaultId: attemptPlan.vaultId,
        storeId: attemptPlan.storeId,
        workspaceId: attemptPlan.workspaceId,
        sessionId: attemptPlan.sessionId,
        workflowId: attemptPlan.workflowId,
        workflowGeneration: attemptPlan.workflowGeneration,
        finalCheckpointId: attemptPlan.finalCheckpointId,
        finalCheckpointFingerprint: attemptPlan.finalCheckpointFingerprint,
        profileId: attemptPlan.profileId,
        profileVersion: attemptPlan.profileVersion,
        profileConfigurationHash: attemptPlan.profileConfigurationHash,
        runId: attemptPlan.runId,
        runnerId: profile.runnerId,
        sourceStateAtStart: sourceState(input.sourceStateAtStart),
        sourceStateAtCompletion: sourceState(input.sourceStateAtCompletion),
        startedAt,
        completedAt,
        status,
        exitClassification,
        summary: summary(status, exitClassification, boundedRedactedOutput.toString("utf8")),
        outputFingerprint: fingerprint,
        artifactReferences: Object.freeze([...(input.artifactReferences ?? [])]),
        fresh: input.fresh ?? true,
      };
      return decodeValidationResultV1(Object.freeze(result));
    } finally {
      stdout?.fill(0);
      stderr?.fill(0);
      combined?.fill(0);
      redactedOutput?.fill(0);
      zeroizeMutable(rawStdout);
      zeroizeMutable(rawStderr);
    }
  }
}
