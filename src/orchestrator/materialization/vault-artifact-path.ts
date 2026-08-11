import { LifecycleError } from "../lifecycle/errors.js";
import { parseCanonicalTimestamp, parseLifecycleId, type SessionId } from "../lifecycle/contracts/identifiers.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const SESSION_LOG_ROOT = "05_Agent_Session_Logs";

export interface CompatibilityLogTargetV1 {
  readonly artifactPath: string;
  readonly targetKey: string;
  readonly materializationRevision: string;
}

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

/** Derives the immutable compatibility-log name; it never consults a clock or filesystem. */
export function deriveCompatibilityLogTarget(
  startedAt: string,
  sessionId: SessionId,
  triggeringEventPosition: bigint,
): CompatibilityLogTargetV1 {
  try {
    const timestamp = parseCanonicalTimestamp(startedAt, "startedAt");
    const id = parseLifecycleId<SessionId>(sessionId, "sessionId");
    if (
      typeof triggeringEventPosition !== "bigint"
      || triggeringEventPosition < 1n
      || triggeringEventPosition > SQLITE_INT64_MAX
    ) return integrity();
    const date = timestamp.slice(0, 10);
    const materializationRevision = triggeringEventPosition.toString();
    const artifactPath = `${SESSION_LOG_ROOT}/${date}-session-${id}.md`;
    const prefix = `${SESSION_LOG_ROOT}/`;
    if (
      !artifactPath.startsWith(prefix)
      || artifactPath.includes("\\")
      || artifactPath.split("/").some((part) => part === "" || part === "." || part === "..")
    ) return integrity();
    return Object.freeze({
      artifactPath,
      targetKey: `lifecycle-log/${id}/${materializationRevision}`,
      materializationRevision,
    });
  } catch {
    return integrity();
  }
}
