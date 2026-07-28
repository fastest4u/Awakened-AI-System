import {
  CHECKPOINT_EVIDENCE_COVERAGE_MAX_CANONICAL_BYTES,
  CHECKPOINT_MAX_MISSING_INTERVALS,
  type CheckpointEvidenceCoverageV2,
} from "./contracts/checkpoint.js";
import { LifecycleError } from "./errors.js";
import { canonicalJson } from "../serialization/canonical-json.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const MAX_ADAPTER_SESSIONS = 200;

export interface EvidenceCoverageOrdinalInterval {
  readonly firstOrdinal: bigint;
  readonly lastOrdinal: bigint;
}

export interface EvidenceCoverageIntervalAdvanceInput {
  readonly priorCoverageLastOrdinal: bigint | null;
  readonly priorMissingIntervals: readonly EvidenceCoverageOrdinalInterval[];
  readonly newOrdinals: readonly bigint[];
}

export interface EvidenceCoverageIntervalAdvanceResult {
  readonly coverageLastOrdinal: string;
  readonly highestContiguousOrdinal: string | null;
  readonly missingIntervals: readonly {
    readonly firstOrdinal: string;
    readonly lastOrdinal: string;
  }[];
}

export interface EvidenceCoverageProjectionBoundsInput {
  readonly prospectiveAdapterCount: number;
  readonly prospectiveTotalIntervalCount: number;
  readonly targetIntervalCount: number;
  readonly evidenceCoverage: CheckpointEvidenceCoverageV2;
}

export function advanceEvidenceCoverageIntervals(
  input: EvidenceCoverageIntervalAdvanceInput,
): EvidenceCoverageIntervalAdvanceResult {
  if (
    input.priorCoverageLastOrdinal !== null
    && (
      input.priorCoverageLastOrdinal < 0n
      || input.priorCoverageLastOrdinal > SQLITE_INT64_MAX
    )
  ) {
    throw new LifecycleError("INTEGRITY_FAILURE");
  }

  const intervals = input.priorMissingIntervals.map((interval) => ({
    firstOrdinal: interval.firstOrdinal,
    lastOrdinal: interval.lastOrdinal,
  }));
  let previousLast = -2n;
  for (const interval of intervals) {
    if (
      interval.firstOrdinal < 0n
      || interval.lastOrdinal < interval.firstOrdinal
      || (
        input.priorCoverageLastOrdinal !== null
        && interval.lastOrdinal > input.priorCoverageLastOrdinal
      )
      || interval.firstOrdinal <= previousLast + 1n
    ) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    previousLast = interval.lastOrdinal;
  }

  const ordinals = [...new Set(input.newOrdinals)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0);
  for (const ordinal of ordinals) {
    if (ordinal < 0n || ordinal > SQLITE_INT64_MAX) {
      throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field: "frames.ordinal" });
    }
  }
  const maximumNew = ordinals.at(-1) ?? null;
  const priorLast = input.priorCoverageLastOrdinal;
  const coverageLastOrdinal = maximumNew === null
    ? priorLast
    : priorLast === null || maximumNew > priorLast
      ? maximumNew
      : priorLast;
  if (coverageLastOrdinal === null) {
    throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field: "frames" });
  }

  if (priorLast === null) {
    intervals.push({ firstOrdinal: 0n, lastOrdinal: coverageLastOrdinal });
  } else if (coverageLastOrdinal > priorLast) {
    const tailFirst = priorLast + 1n;
    const tail = intervals.at(-1);
    if (tail !== undefined && tail.lastOrdinal + 1n === tailFirst) {
      tail.lastOrdinal = coverageLastOrdinal;
    } else {
      intervals.push({ firstOrdinal: tailFirst, lastOrdinal: coverageLastOrdinal });
    }
  }

  for (const ordinal of ordinals) {
    let low = 0;
    let high = intervals.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const interval = intervals[middle]!;
      if (ordinal < interval.firstOrdinal) {
        high = middle - 1;
        continue;
      }
      if (ordinal > interval.lastOrdinal) {
        low = middle + 1;
        continue;
      }
      if (interval.firstOrdinal === ordinal && interval.lastOrdinal === ordinal) {
        intervals.splice(middle, 1);
      } else if (interval.firstOrdinal === ordinal) {
        interval.firstOrdinal += 1n;
      } else if (interval.lastOrdinal === ordinal) {
        interval.lastOrdinal -= 1n;
      } else {
        const right = {
          firstOrdinal: ordinal + 1n,
          lastOrdinal: interval.lastOrdinal,
        };
        interval.lastOrdinal = ordinal - 1n;
        intervals.splice(middle + 1, 0, right);
      }
      break;
    }
  }

  const firstMissing = intervals[0];
  const highestContiguousOrdinal = firstMissing === undefined
    ? coverageLastOrdinal.toString()
    : firstMissing.firstOrdinal === 0n
      ? null
      : (firstMissing.firstOrdinal - 1n).toString();
  return Object.freeze({
    coverageLastOrdinal: coverageLastOrdinal.toString(),
    highestContiguousOrdinal,
    missingIntervals: Object.freeze(intervals.map((interval) => Object.freeze({
      firstOrdinal: interval.firstOrdinal.toString(),
      lastOrdinal: interval.lastOrdinal.toString(),
    }))),
  });
}

export function assertEvidenceCoverageProjectionBounds(
  input: EvidenceCoverageProjectionBoundsInput,
): void {
  if (input.prospectiveAdapterCount > MAX_ADAPTER_SESSIONS) {
    throw new LifecycleError("EVIDENCE_ADAPTER_SESSION_LIMIT");
  }
  if (
    input.targetIntervalCount > CHECKPOINT_MAX_MISSING_INTERVALS
    || input.prospectiveTotalIntervalCount > CHECKPOINT_MAX_MISSING_INTERVALS
  ) {
    throw new LifecycleError("EVIDENCE_COVERAGE_TOO_FRAGMENTED");
  }
  if (
    Buffer.byteLength(canonicalJson(input.evidenceCoverage), "utf8")
    > CHECKPOINT_EVIDENCE_COVERAGE_MAX_CANONICAL_BYTES
  ) {
    throw new LifecycleError("EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE");
  }
}
