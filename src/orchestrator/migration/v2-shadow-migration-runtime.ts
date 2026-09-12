import { performance } from "node:perf_hooks";
import { deterministicMigrationUuid, ShadowMigrationError, type ShadowMigrationErrorCode } from "./v2-shadow-migration.contracts.js";

/** Runtime authority only. Never serialized into a sealed configuration or corpus. */
export interface ShadowMigrationInvocationDeadline {
  remainingMs(): number;
  readonly signal: AbortSignal;
}

export type ShadowMigrationReconciliation<T> =
  | Readonly<{ status: "committed"; result: T }>
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "unknown"; safeErrorCode: ShadowMigrationErrorCode }>;

/** Cooperative checks cannot interrupt synchronous work; owners dispose in finally on every exit. */
export function createShadowMigrationInvocationDeadline(durationMs: number, now: () => number = () => performance.now()):
ShadowMigrationInvocationDeadline & Readonly<{ dispose(): void }> {
  const controller = new AbortController();
  const exhausted = (): never => {
    controller.abort();
    throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
  };
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 300_000) exhausted();
  const started = now();
  if (!Number.isFinite(started)) exhausted();
  let previous = started;
  const timer = setTimeout(() => controller.abort(), durationMs);
  timer.unref();
  return Object.freeze({
    signal: controller.signal,
    remainingMs(): number {
      if (controller.signal.aborted) exhausted();
      const current = now();
      if (!Number.isFinite(current) || current < previous) exhausted();
      previous = current;
      const remaining = Math.floor(durationMs - (current - started));
      if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > durationMs) exhausted();
      return remaining;
    },
    dispose(): void { clearTimeout(timer); controller.abort(); },
  });
}

export function canonicalShadowMigrationUtc(value: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) invalid();
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) invalid();
  return instant;
}

export function shadowMigrationPhaseMetadata(migrationIdentity: string, sourceCreatedAt: string, ordinal: number):
Readonly<{ attemptId: string; recordedAt: string }> {
  if (!Number.isSafeInteger(ordinal) || Object.is(ordinal, -0) || ordinal < 0 || ordinal > 5) invalid();
  const instant = canonicalShadowMigrationUtc(sourceCreatedAt) + ordinal;
  const recordedAt = new Date(instant).toISOString();
  canonicalShadowMigrationUtc(recordedAt);
  return Object.freeze({ attemptId: deterministicMigrationUuid("attempt", migrationIdentity, ordinal), recordedAt });
}

function invalid(): never { throw new ShadowMigrationError("MIGRATION_SOURCE_INVALID"); }
