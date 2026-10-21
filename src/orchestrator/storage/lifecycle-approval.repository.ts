import { LifecycleError } from "../lifecycle/errors.js";
import { MAX_CANONICAL_TIMESTAMP_MS } from "../runtime/clock.js";
import type { ApprovalConsumptionInput } from "./lifecycle-storage.types.js";
import type { SqliteConnection } from "./sqlite-driver.js";

const INPUT_KEYS = [
  "approvalId",
  "nonceDigest",
  "projectId",
  "sessionId",
  "action",
  "commandId",
  "targetActorRole",
  "targetClientInstanceId",
  "redactedApprovalReference",
  "consumedEventPosition",
  "consumedAtMs",
] as const;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LOWER_HASH = /^[0-9a-f]{64}$/u;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;

function invalid(): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
}

function data(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
  return descriptor.value;
}

function exactInput(input: ApprovalConsumptionInput): ApprovalConsumptionInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid();
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== INPUT_KEYS.length || keys.some((key) => typeof key !== "string" || !INPUT_KEYS.includes(key as typeof INPUT_KEYS[number]))) {
    invalid();
  }
  const values = Object.fromEntries(INPUT_KEYS.map((key) => [key, data(input, key)])) as Record<string, unknown>;
  if (typeof values.approvalId !== "string" || !LOWER_UUID.test(values.approvalId)
    || typeof values.nonceDigest !== "string" || !LOWER_HASH.test(values.nonceDigest)
    || typeof values.projectId !== "string" || !LOWER_UUID.test(values.projectId)
    || typeof values.sessionId !== "string" || !LOWER_UUID.test(values.sessionId)
    || typeof values.commandId !== "string" || !LOWER_UUID.test(values.commandId)
    || (values.action !== "recover-root-authority" && values.action !== "abandon-root")
    || values.targetActorRole !== "primary"
    || typeof values.targetClientInstanceId !== "string"
    || values.targetClientInstanceId.length === 0
    || Array.from(values.targetClientInstanceId).length > 256
    || typeof values.redactedApprovalReference !== "string"
    || values.redactedApprovalReference.length === 0
    || Array.from(values.redactedApprovalReference).length > 512
    || typeof values.consumedEventPosition !== "bigint"
    || values.consumedEventPosition < 1n
    || values.consumedEventPosition > SQLITE_INT64_MAX
    || typeof values.consumedAtMs !== "bigint"
    || values.consumedAtMs < 0n
    || values.consumedAtMs > MAX_CANONICAL_TIMESTAMP_MS) invalid();
  return values as unknown as ApprovalConsumptionInput;
}

function timestamp(milliseconds: bigint): string {
  if (milliseconds < 0n || milliseconds > MAX_CANONICAL_TIMESTAMP_MS) invalid();
  return new Date(Number(milliseconds)).toISOString();
}

function alreadyConsumed(
  connection: SqliteConnection,
  approvalId: string,
  nonceDigest: string,
): boolean {
  return connection.prepare(`
    SELECT 1 AS present
    FROM lifecycle_approval_consumptions
    WHERE approval_id = $approvalId OR nonce_digest = $nonceDigest
    LIMIT 1
  `).get({ $approvalId: approvalId, $nonceDigest: nonceDigest }) !== undefined;
}

export class LifecycleApprovalRepository {
  consume(connection: SqliteConnection, source: ApprovalConsumptionInput): void {
    const input = exactInput(source);
    if (alreadyConsumed(connection, input.approvalId, input.nonceDigest)) {
      throw new LifecycleError("LIFECYCLE_APPROVAL_REPLAYED");
    }
    try {
      const result = connection.prepare(`
        INSERT INTO lifecycle_approval_consumptions(
          project_id, approval_id, nonce_digest, session_id, action,
          command_id, target_actor_role, target_client_instance_id,
          consumed_event_position, consumed_at
        ) VALUES (
          $projectId, $approvalId, $nonceDigest, $sessionId, $action,
          $commandId, $targetActorRole, $targetClientInstanceId,
          $consumedEventPosition, $consumedAt
        )
      `).run({
        $projectId: input.projectId,
        $approvalId: input.approvalId,
        $nonceDigest: input.nonceDigest,
        $sessionId: input.sessionId,
        $action: input.action,
        $commandId: input.commandId,
        $targetActorRole: input.targetActorRole,
        $targetClientInstanceId: input.targetClientInstanceId,
        $consumedEventPosition: input.consumedEventPosition,
        $consumedAt: timestamp(input.consumedAtMs),
      });
      if (result.changes !== 1n) throw new LifecycleError("INTEGRITY_FAILURE");
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      if (alreadyConsumed(connection, input.approvalId, input.nonceDigest)) {
        throw new LifecycleError("LIFECYCLE_APPROVAL_REPLAYED");
      }
      throw error;
    }
  }
}
