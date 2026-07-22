import { createHash, createHmac } from "node:crypto";
import { canonicalJson } from "../../src/orchestrator/serialization/canonical-json.js";

export function canonicalUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

export function compareCanonicalUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function referenceCheckpointFingerprint(
  checkpointVersion: 1 | 2,
  checkpoint: unknown,
): string {
  return createHash("sha256")
    .update(`project-memory/checkpoint/v${checkpointVersion}\n`, "utf8")
    .update(canonicalJson(checkpoint), "utf8")
    .digest("hex");
}

export function unknownJsonStringUpperBound(maximumScalars: number): number {
  return 2 + (6 * maximumScalars);
}

export function referenceCoverageAccumulatorHmac(
  key: Uint8Array,
  accumulator: unknown,
): string {
  return createHmac("sha256", key)
    .update("pm-evidence-coverage-v1", "utf8")
    .update(Buffer.from([0]))
    .update(canonicalJson(accumulator), "utf8")
    .digest("hex");
}
