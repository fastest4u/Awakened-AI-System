import type { StoredEvent } from "../contracts/event.js";
import type { ProjectContext, ProjectId, StoreId } from "../identity/contracts.js";
import {
  minimumCheckpointUpperBound as checkpointUpperBound,
  minimumFinalEndingScopeBindingsUpperBound as endingScopeUpperBound,
  type MinimumCheckpointCapacityInput,
  type MinimumEndingScopeCapacityInput,
} from "../lifecycle/checkpoint-capacity.js";
import {
  CHECKPOINT_MAX_CANONICAL_BYTES,
  type CheckpointAdapterCoverageV2,
  type CheckpointEvidenceCoverageV2,
} from "../lifecycle/contracts/checkpoint.js";
import type { RecordEvidenceBatchCommandV2 } from "../lifecycle/contracts/commands.js";
import type {
  EvidenceCoverageRecordedV2,
  LifecycleEvidenceFrameRecordedV1,
  LifecycleMissingOrdinalIntervalV1,
} from "../lifecycle/contracts/events.js";
import type {
  AdapterSessionId,
  SessionId,
} from "../lifecycle/contracts/identifiers.js";
import type { FinalEndingScopeBindingV1 } from "../lifecycle/contracts/session-end.js";
import type { CapabilityKeyProvider } from "../lifecycle/authority/capability-key-provider.js";
import {
  advanceEvidenceCoverageIntervals,
  assertEvidenceCoverageProjectionBounds,
  type EvidenceCoverageOrdinalInterval,
} from "../lifecycle/evidence-coverage-accumulator.js";
import {
  isBoundedLifecycleString,
  LifecycleError,
} from "../lifecycle/errors.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { SqliteConnection, SqliteParams, SqliteRow } from "./sqlite-driver.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const UNKNOWN_EVENT_POSITION = SQLITE_INT64_MAX.toString();
const LOWER_HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/;
const STORAGE_INTERVALS = /^\[(?:\[[0-9]+,[0-9]+\](?:,\[[0-9]+,[0-9]+\])*)?\]$/;
const MAX_BATCH_FRAMES = 2_000;

export interface EvidenceCoverageBatchInput {
  readonly context: ProjectContext;
  readonly command: RecordEvidenceBatchCommandV2;
  readonly prospectiveEndingScopeBindings: readonly FinalEndingScopeBindingV1[];
  readonly plannedEventPosition: bigint | null;
}

const PREPARED_EVIDENCE_COVERAGE_BATCH: unique symbol = Symbol(
  "PREPARED_EVIDENCE_COVERAGE_BATCH",
);

export interface PreparedEvidenceCoverageBatch {
  readonly [PREPARED_EVIDENCE_COVERAGE_BATCH]: true;
  readonly projectId: ProjectId;
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  readonly adapterSessionId: AdapterSessionId;
  readonly expectedPriorLatestBatchEventPosition: bigint | null;
  readonly previousCoverageFingerprint: string | null;
  readonly eventPayload: EvidenceCoverageRecordedV2;
  readonly newFrames: readonly LifecycleEvidenceFrameRecordedV1[];
}

interface CurrentAdapter {
  readonly entry: CheckpointAdapterCoverageV2;
  readonly intervals: readonly EvidenceCoverageOrdinalInterval[];
  readonly latestBatchEventPosition: bigint;
  readonly coverageFingerprint: string;
  readonly createdAt: string;
}

interface PreparedMetadata {
  readonly plannedEventPosition: bigint | null;
  readonly eventFramesJson: string;
  readonly newFramesJson: string;
}

const AUTHENTIC_PREPARED = new WeakSet<object>();
const PREPARED_METADATA = new WeakMap<object, PreparedMetadata>();

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function input(field: string): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
}

function string(row: SqliteRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") return integrity();
  return value;
}

function bigint(row: SqliteRow, field: string): bigint {
  const value = row[field];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return integrity();
}

function decimal(value: string, field: string): bigint {
  if (!DECIMAL.test(value)) return input(field);
  const decoded = BigInt(value);
  if (decoded > SQLITE_INT64_MAX) return input(field);
  return decoded;
}

function parseIntervals(
  source: string,
  coverageLastOrdinal: bigint,
): readonly EvidenceCoverageOrdinalInterval[] {
  if (!STORAGE_INTERVALS.test(source)) return integrity();
  const intervals: { firstOrdinal: bigint; lastOrdinal: bigint }[] = [];
  let previousLast = -2n;
  for (const match of source.matchAll(/\[([0-9]+),([0-9]+)\]/g)) {
    const firstOrdinal = BigInt(match[1]!);
    const lastOrdinal = BigInt(match[2]!);
    if (
      lastOrdinal < firstOrdinal
      || lastOrdinal > coverageLastOrdinal
      || firstOrdinal <= previousLast + 1n
    ) return integrity();
    intervals.push(Object.freeze({ firstOrdinal, lastOrdinal }));
    previousLast = lastOrdinal;
  }
  if (intervals.length > 200) {
    throw new LifecycleError("EVIDENCE_COVERAGE_TOO_FRAGMENTED");
  }
  return Object.freeze(intervals);
}

function storageIntervals(
  intervals: readonly LifecycleMissingOrdinalIntervalV1[],
): string {
  return `[${intervals.map((interval) =>
    `[${interval.firstOrdinal},${interval.lastOrdinal}]`).join(",")}]`;
}

function publicIntervals(
  intervals: readonly EvidenceCoverageOrdinalInterval[],
): readonly LifecycleMissingOrdinalIntervalV1[] {
  return Object.freeze(intervals.map((interval) => Object.freeze({
    firstOrdinal: interval.firstOrdinal.toString(),
    lastOrdinal: interval.lastOrdinal.toString(),
  })));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}

function storeIdentity(
  connection: SqliteConnection,
): { readonly projectId: ProjectId; readonly storeId: StoreId } {
  const row = connection.prepare(`
    SELECT project_id, store_id
    FROM project_meta
    WHERE singleton = 1
  `).get();
  if (row === undefined) return integrity();
  return {
    projectId: string(row, "project_id") as ProjectId,
    storeId: string(row, "store_id") as StoreId,
  };
}

function compareTransition(row: SqliteRow): void {
  const pairs = [
    ["latest_batch_id", "transition_batch_id"],
    ["latest_batch_event_position", "transition_batch_event_position"],
    ["first_ordinal", "transition_coverage_first_ordinal"],
    ["last_ordinal", "transition_coverage_last_ordinal"],
    ["highest_contiguous_ordinal", "transition_highest_contiguous_ordinal"],
    ["missing_intervals_json", "transition_missing_intervals_json"],
    ["fingerprint_algorithm", "transition_frame_fingerprint_algorithm"],
    ["fingerprint_schema_version", "transition_frame_fingerprint_schema_version"],
    ["fingerprint_key_id", "transition_frame_fingerprint_key_id"],
    ["fingerprint_domain", "transition_frame_fingerprint_domain"],
    ["coverage_fingerprint_algorithm", "transition_coverage_fingerprint_algorithm"],
    ["coverage_fingerprint_schema_version", "transition_coverage_fingerprint_schema_version"],
    ["coverage_fingerprint_key_id", "transition_coverage_fingerprint_key_id"],
    ["coverage_fingerprint_domain", "transition_coverage_fingerprint_domain"],
    ["coverage_fingerprint_value", "transition_coverage_fingerprint_value"],
    ["capture_mode", "transition_capture_mode"],
  ] as const;
  for (const [aggregate, transition] of pairs) {
    if (row[aggregate] !== row[transition]) return integrity();
  }
  if (row.transition_content_retained !== 0n) return integrity();
  if (
    row.event_project_id !== row.project_id
    || row.event_session_id !== row.session_id
    || row.event_type !== "EvidenceCoverageRecorded"
    || row.event_schema_version !== 2n
  ) return integrity();
}

function currentAdapters(
  connection: SqliteConnection,
  projectId: ProjectId,
  sessionId: SessionId,
  verifyLatestTransition: boolean,
): readonly CurrentAdapter[] {
  const countRow = connection.prepare(`
    SELECT count(*) AS adapter_count
    FROM session_evidence_coverage
    WHERE project_id = $projectId
      AND session_id = $sessionId
  `).get({
    $projectId: projectId,
    $sessionId: sessionId,
  });
  if (countRow === undefined) return integrity();
  if (bigint(countRow, "adapter_count") > 200n) {
    throw new LifecycleError("EVIDENCE_ADAPTER_SESSION_LIMIT");
  }
  const rows = connection.prepare(`
    SELECT coverage.*,
      transition.batch_id AS transition_batch_id,
      transition.batch_event_position AS transition_batch_event_position,
      transition.coverage_first_ordinal AS transition_coverage_first_ordinal,
      transition.coverage_last_ordinal AS transition_coverage_last_ordinal,
      transition.highest_contiguous_ordinal AS transition_highest_contiguous_ordinal,
      transition.missing_intervals_json AS transition_missing_intervals_json,
      transition.frame_fingerprint_algorithm AS transition_frame_fingerprint_algorithm,
      transition.frame_fingerprint_schema_version AS transition_frame_fingerprint_schema_version,
      transition.frame_fingerprint_key_id AS transition_frame_fingerprint_key_id,
      transition.frame_fingerprint_domain AS transition_frame_fingerprint_domain,
      transition.coverage_fingerprint_algorithm AS transition_coverage_fingerprint_algorithm,
      transition.coverage_fingerprint_schema_version AS transition_coverage_fingerprint_schema_version,
      transition.coverage_fingerprint_key_id AS transition_coverage_fingerprint_key_id,
      transition.coverage_fingerprint_domain AS transition_coverage_fingerprint_domain,
      transition.coverage_fingerprint_value AS transition_coverage_fingerprint_value,
      transition.capture_mode AS transition_capture_mode,
      transition.content_retained AS transition_content_retained,
      event.project_id AS event_project_id,
      event.session_id AS event_session_id,
      event.event_type AS event_type,
      event.event_schema_version AS event_schema_version
    FROM session_evidence_coverage AS coverage
    LEFT JOIN session_evidence_coverage_transition_heads AS head
      ON head.project_id = coverage.project_id
      AND head.session_id = coverage.session_id
      AND head.adapter_session_id = coverage.adapter_session_id
    LEFT JOIN session_evidence_coverage_transitions AS transition
      ON transition.project_id = head.project_id
      AND transition.session_id = head.session_id
      AND transition.adapter_session_id = head.adapter_session_id
      AND transition.batch_event_position = head.batch_event_position
    LEFT JOIN events AS event
      ON event.global_position = transition.batch_event_position
    WHERE coverage.project_id = $projectId
      AND coverage.session_id = $sessionId
    ORDER BY CAST(coverage.adapter_session_id AS BLOB)
    LIMIT 200
  `).all({
    $projectId: projectId,
    $sessionId: sessionId,
  });
  let totalIntervals = 0;
  return Object.freeze(rows.map((row): CurrentAdapter => {
    if (verifyLatestTransition) compareTransition(row);
    const coverageLastOrdinal = bigint(row, "last_ordinal");
    const highest = bigint(row, "highest_contiguous_ordinal");
    const intervalJson = string(row, "missing_intervals_json");
    const intervals = parseIntervals(intervalJson, coverageLastOrdinal);
    totalIntervals += intervals.length;
    if (totalIntervals > 200) {
      throw new LifecycleError("EVIDENCE_COVERAGE_TOO_FRAGMENTED");
    }
    const firstMissing = intervals[0];
    const expectedHighest = firstMissing === undefined
      ? coverageLastOrdinal
      : firstMissing.firstOrdinal - 1n;
    const frameKeyId = string(row, "fingerprint_key_id");
    const coverageKeyId = string(row, "coverage_fingerprint_key_id");
    const digest = string(row, "coverage_fingerprint_value");
    if (
      bigint(row, "first_ordinal") !== 0n
      || highest !== expectedHighest
      || string(row, "capture_mode") !== "coverage-only"
      || string(row, "fingerprint_algorithm") !== "hmac-sha256"
      || bigint(row, "fingerprint_schema_version") !== 1n
      || string(row, "fingerprint_domain") !== "pm-evidence-frame-v1"
      || string(row, "coverage_fingerprint_algorithm") !== "hmac-sha256"
      || bigint(row, "coverage_fingerprint_schema_version") !== 1n
      || string(row, "coverage_fingerprint_domain") !== "pm-evidence-coverage-v1"
      || !isBoundedLifecycleString(frameKeyId, 128)
      || frameKeyId !== coverageKeyId
      || !LOWER_HASH.test(digest)
    ) return integrity();
    const position = bigint(row, "latest_batch_event_position");
    return Object.freeze({
      entry: Object.freeze({
        adapterSessionId: string(row, "adapter_session_id") as AdapterSessionId,
        coverageFirstOrdinal: "0",
        coverageLastOrdinal: coverageLastOrdinal.toString(),
        highestContiguousOrdinal: highest === -1n ? null : highest.toString(),
        missingIntervals: publicIntervals(intervals),
        frameFingerprintAlgorithm: "hmac-sha256",
        frameFingerprintSchemaVersion: 1,
        frameFingerprintKeyId: frameKeyId,
        frameFingerprintDomain: "pm-evidence-frame-v1",
        coverageFingerprintAlgorithm: "hmac-sha256",
        coverageFingerprintSchemaVersion: 1,
        coverageFingerprintKeyId: coverageKeyId,
        coverageFingerprintDomain: "pm-evidence-coverage-v1",
        coverageFingerprint: digest,
        latestBatchId: string(row, "latest_batch_id") as CheckpointAdapterCoverageV2["latestBatchId"],
        latestBatchEventPosition: position.toString(),
      }),
      intervals,
      latestBatchEventPosition: position,
      coverageFingerprint: digest,
      createdAt: string(row, "created_at"),
    });
  }));
}

function coverageSnapshot(
  entries: readonly CheckpointAdapterCoverageV2[],
): CheckpointEvidenceCoverageV2 {
  const sorted = [...entries].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.adapterSessionId, "utf8"),
      Buffer.from(right.adapterSessionId, "utf8"),
    ));
  return deepFreeze({
    coverageVersion: 2 as const,
    captureMode: "coverage-only" as const,
    contentRetained: false as const,
    adapterSessions: sorted,
  });
}

function availableProfiles(
  provider: Pick<CapabilityKeyProvider, "status">,
  projectId: ProjectId,
  storeId: StoreId,
  entries: readonly CheckpointAdapterCoverageV2[],
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.coverageFingerprintKeyId)) continue;
    seen.add(entry.coverageFingerprintKeyId);
    if (
      provider.status(
        { projectId, storeId },
        "evidence-fingerprint",
        entry.coverageFingerprintKeyId,
      ) !== "available"
    ) {
      throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
    }
  }
}

function validateCommand(command: RecordEvidenceBatchCommandV2): {
  readonly firstOrdinal: bigint;
  readonly lastOrdinal: bigint;
} {
  const firstOrdinal = decimal(command.firstOrdinal, "firstOrdinal");
  const lastOrdinal = decimal(command.lastOrdinal, "lastOrdinal");
  if (
    lastOrdinal < firstOrdinal
    || command.frames.length < 1
    || command.frames.length > MAX_BATCH_FRAMES
    || BigInt(command.frames.length) !== lastOrdinal - firstOrdinal + 1n
    || command.fingerprintSchemaVersion !== 1
    || command.fingerprintDomain !== "pm-evidence-frame-v1"
    || command.redactionStatus !== "content-not-retained"
    || !isBoundedLifecycleString(command.fingerprintKeyId, 128)
  ) return input("frames");
  const ids = new Set<string>();
  for (let index = 0; index < command.frames.length; index += 1) {
    const frame = command.frames[index]!;
    const ordinal = decimal(frame.ordinal, `frames[${index}].ordinal`);
    if (
      ordinal !== firstOrdinal + BigInt(index)
      || ids.has(frame.frameId)
      || !LOWER_HASH.test(frame.contentFingerprint)
    ) return input(`frames[${index}]`);
    ids.add(frame.frameId);
  }
  return { firstOrdinal, lastOrdinal };
}

function genuinelyNewFrames(
  connection: SqliteConnection,
  projectId: ProjectId,
  sessionId: SessionId,
  adapterSessionId: AdapterSessionId,
  command: RecordEvidenceBatchCommandV2,
  frameKeyId: string,
  priorCoverageLastOrdinal: bigint | null,
  priorMissingIntervals: readonly EvidenceCoverageOrdinalInterval[],
): readonly LifecycleEvidenceFrameRecordedV1[] {
  const parameters: Record<`$${string}`, string | bigint> = {
    $projectId: projectId,
    $sessionId: sessionId,
    $adapterSessionId: adapterSessionId,
  };
  const ordinalNames: string[] = [];
  const frameNames: string[] = [];
  command.frames.forEach((frame, index) => {
    const ordinalName = `$ordinal${index}` as const;
    const frameName = `$frame${index}` as const;
    ordinalNames.push(ordinalName);
    frameNames.push(frameName);
    parameters[ordinalName] = BigInt(frame.ordinal);
    parameters[frameName] = frame.frameId;
  });
  const rows = connection.prepare(`
    SELECT *
    FROM session_evidence_fingerprints
    WHERE project_id = $projectId
      AND (
        (
          session_id = $sessionId
          AND adapter_session_id = $adapterSessionId
          AND ordinal IN (${ordinalNames.join(", ")})
        )
        OR frame_id IN (${frameNames.join(", ")})
      )
    LIMIT ${MAX_BATCH_FRAMES * 2 + 1}
  `).all(parameters as SqliteParams);
  const byOrdinal = new Map<bigint, SqliteRow>();
  const byFrame = new Map<string, SqliteRow>();
  for (const row of rows) {
    if (
      string(row, "session_id") === sessionId
      && string(row, "adapter_session_id") === adapterSessionId
    ) {
      byOrdinal.set(bigint(row, "ordinal"), row);
    }
    byFrame.set(string(row, "frame_id"), row);
  }
  const result: LifecycleEvidenceFrameRecordedV1[] = [];
  for (const frame of command.frames) {
    const ordinal = BigInt(frame.ordinal);
    const ordinalRow = byOrdinal.get(ordinal);
    const frameRow = byFrame.get(frame.frameId);
    const expectedPresent = priorCoverageLastOrdinal !== null
      && ordinal <= priorCoverageLastOrdinal
      && !priorMissingIntervals.some((interval) =>
        ordinal >= interval.firstOrdinal && ordinal <= interval.lastOrdinal);
    if ((ordinalRow !== undefined) !== expectedPresent) return integrity();
    if (ordinalRow === undefined) {
      if (frameRow !== undefined) return input("frames.frameId");
      result.push(Object.freeze({ ...frame }));
      continue;
    }
    if (
      frameRow !== ordinalRow
      || string(ordinalRow, "frame_id") !== frame.frameId
      || string(ordinalRow, "source_kind") !== frame.sourceKind
      || string(ordinalRow, "observed_at") !== frame.observedAt
      || string(ordinalRow, "fingerprint_algorithm") !== "hmac-sha256"
      || bigint(ordinalRow, "fingerprint_schema_version") !== 1n
      || string(ordinalRow, "fingerprint_key_id") !== frameKeyId
      || string(ordinalRow, "fingerprint_domain") !== "pm-evidence-frame-v1"
      || string(ordinalRow, "fingerprint_value") !== frame.contentFingerprint
    ) return input("frames");
  }
  return Object.freeze(result.sort((left, right) =>
    BigInt(left.ordinal) < BigInt(right.ordinal) ? -1 : 1));
}

export class EvidenceCoverageRepository {
  readonly #provider: Pick<
    CapabilityKeyProvider,
    "currentKey" | "status" | "fingerprint"
  >;

  constructor(
    provider: Pick<
      CapabilityKeyProvider,
      "currentKey" | "status" | "fingerprint"
    >,
  ) {
    this.#provider = provider;
  }

  prepareBatch(
    connection: SqliteConnection,
    inputValue: EvidenceCoverageBatchInput,
  ): PreparedEvidenceCoverageBatch {
    const command: RecordEvidenceBatchCommandV2 = deepFreeze({
      ...inputValue.command,
      frames: inputValue.command.frames.map((frame) => ({ ...frame })),
    });
    const identity = storeIdentity(connection);
    const projectId = inputValue.context.binding.projectId;
    const storeId = inputValue.context.binding.storeId;
    if (identity.projectId !== projectId) {
      throw new LifecycleError("PROJECT_ID_MISMATCH");
    }
    if (identity.storeId !== storeId) {
      throw new LifecycleError("STORE_ID_MISMATCH");
    }
    if (
      inputValue.plannedEventPosition !== null
      && (
        inputValue.plannedEventPosition < 1n
        || inputValue.plannedEventPosition > SQLITE_INT64_MAX
      )
    ) input("plannedEventPosition");

    const commandBounds = validateCommand(command);
    const sessionId = command.sessionId;
    const adapterSessionId = command.adapterSessionId;
    const existingAdapterNamespace = connection.prepare(`
      SELECT session_id
      FROM session_evidence_coverage
      WHERE project_id = $projectId
        AND adapter_session_id = $adapterSessionId
    `).get({
      $projectId: projectId,
      $adapterSessionId: adapterSessionId,
    });
    if (
      existingAdapterNamespace !== undefined
      && string(existingAdapterNamespace, "session_id") !== sessionId
    ) input("adapterSessionId");
    const adapters = currentAdapters(connection, projectId, sessionId, true);
    const current = adapters.find(
      (adapter) => adapter.entry.adapterSessionId === adapterSessionId,
    );
    const frameKeyId = current?.entry.frameFingerprintKeyId
      ?? command.fingerprintKeyId;
    if (
      command.fingerprintKeyId !== frameKeyId
      || (
        current !== undefined
        && current.entry.coverageFingerprintKeyId !== frameKeyId
      )
    ) input("fingerprintKeyId");
    const newFrames = genuinelyNewFrames(
      connection,
      projectId,
      sessionId,
      adapterSessionId,
      command,
      frameKeyId,
      current === undefined ? null : BigInt(current.entry.coverageLastOrdinal),
      current?.intervals ?? [],
    );
    const advanced = advanceEvidenceCoverageIntervals({
      priorCoverageLastOrdinal: current === undefined
        ? null
        : BigInt(current.entry.coverageLastOrdinal),
      priorMissingIntervals: current?.intervals ?? [],
      newOrdinals: newFrames.map((frame) => BigInt(frame.ordinal)),
    });
    const position = inputValue.plannedEventPosition?.toString()
      ?? UNKNOWN_EVENT_POSITION;
    const provisionalDigest = current?.coverageFingerprint ?? "0".repeat(64);
    const targetEntry: CheckpointAdapterCoverageV2 = Object.freeze({
      adapterSessionId,
      coverageFirstOrdinal: "0",
      coverageLastOrdinal: advanced.coverageLastOrdinal,
      highestContiguousOrdinal: advanced.highestContiguousOrdinal,
      missingIntervals: advanced.missingIntervals,
      frameFingerprintAlgorithm: "hmac-sha256",
      frameFingerprintSchemaVersion: 1,
      frameFingerprintKeyId: frameKeyId,
      frameFingerprintDomain: "pm-evidence-frame-v1",
      coverageFingerprintAlgorithm: "hmac-sha256",
      coverageFingerprintSchemaVersion: 1,
      coverageFingerprintKeyId: frameKeyId,
      coverageFingerprintDomain: "pm-evidence-coverage-v1",
      coverageFingerprint: provisionalDigest,
      latestBatchId: command.batchId,
      latestBatchEventPosition: position,
    });
    const prospectiveEntries = adapters
      .filter((adapter) => adapter.entry.adapterSessionId !== adapterSessionId)
      .map((adapter) => adapter.entry)
      .concat(targetEntry);
    const evidenceCoverage = coverageSnapshot(prospectiveEntries);
    const currentTotalIntervals = adapters.reduce(
      (total, adapter) => total + adapter.intervals.length,
      0,
    );
    const prospectiveTotalIntervals = currentTotalIntervals
      - (current?.intervals.length ?? 0)
      + advanced.missingIntervals.length;
    assertEvidenceCoverageProjectionBounds({
      prospectiveAdapterCount: adapters.length + (current === undefined ? 1 : 0),
      prospectiveTotalIntervalCount: prospectiveTotalIntervals,
      targetIntervalCount: advanced.missingIntervals.length,
      evidenceCoverage,
    });
    if (
      checkpointUpperBound({
        evidenceCoverage,
        endingScopeBindings: inputValue.prospectiveEndingScopeBindings,
      }) > CHECKPOINT_MAX_CANONICAL_BYTES
      || endingScopeUpperBound({
        endingScopeBindings: inputValue.prospectiveEndingScopeBindings,
      }) > CHECKPOINT_MAX_CANONICAL_BYTES
    ) {
      throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
    }

    if (current === undefined) {
      const selected = this.#provider.currentKey(
        { projectId, storeId },
        "evidence-fingerprint",
      );
      if (selected.keyId !== frameKeyId) input("fingerprintKeyId");
    } else if (
      this.#provider.status(
        { projectId, storeId },
        "evidence-fingerprint",
        frameKeyId,
      ) !== "available"
    ) {
      throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
    }

    let coverageFingerprint = current?.coverageFingerprint ?? provisionalDigest;
    if (newFrames.length > 0) {
      const accumulator = {
        coverageAccumulatorVersion: 1,
        projectId,
        storeId,
        sessionId,
        adapterSessionId,
        previousCoverageFingerprint: current?.coverageFingerprint ?? null,
        captureMode: "coverage-only",
        contentRetained: false,
        frameFingerprintProfile: {
          algorithm: "hmac-sha256",
          schemaVersion: 1,
          keyId: frameKeyId,
          domain: "pm-evidence-frame-v1",
        },
        coverageFingerprintProfile: {
          algorithm: "hmac-sha256",
          schemaVersion: 1,
          keyId: frameKeyId,
          domain: "pm-evidence-coverage-v1",
        },
        coverageFirstOrdinal: "0",
        coverageLastOrdinal: advanced.coverageLastOrdinal,
        highestContiguousOrdinal: advanced.highestContiguousOrdinal,
        missingIntervals: advanced.missingIntervals,
        newFrames,
      };
      const bytes = Buffer.from(canonicalJson(accumulator), "utf8");
      try {
        coverageFingerprint = this.#provider.fingerprint({
          projectId,
          storeId,
          purpose: "evidence-fingerprint",
          keyId: frameKeyId,
          domain: "pm-evidence-coverage-v1",
          bytes,
        });
      } finally {
        bytes.fill(0);
      }
      if (!LOWER_HASH.test(coverageFingerprint)) return integrity();
    }

    const eventPayload: EvidenceCoverageRecordedV2 = deepFreeze({
      adapterSessionId,
      batchId: command.batchId,
      batchFirstOrdinal: commandBounds.firstOrdinal.toString(),
      batchLastOrdinal: commandBounds.lastOrdinal.toString(),
      coverageFirstOrdinal: "0",
      coverageLastOrdinal: advanced.coverageLastOrdinal,
      highestContiguousOrdinal: advanced.highestContiguousOrdinal,
      missingIntervals: advanced.missingIntervals,
      frameFingerprintAlgorithm: "hmac-sha256",
      frameFingerprintSchemaVersion: 1,
      frameFingerprintKeyId: frameKeyId,
      frameFingerprintDomain: "pm-evidence-frame-v1",
      coverageFingerprintAlgorithm: "hmac-sha256",
      coverageFingerprintSchemaVersion: 1,
      coverageFingerprintKeyId: frameKeyId,
      coverageFingerprintDomain: "pm-evidence-coverage-v1",
      coverageFingerprint,
      captureMode: "coverage-only",
      contentRetained: false,
      frames: command.frames.map((frame) => ({ ...frame })),
    });
    const prepared = deepFreeze({
      [PREPARED_EVIDENCE_COVERAGE_BATCH]: true as const,
      projectId,
      storeId,
      sessionId,
      adapterSessionId,
      expectedPriorLatestBatchEventPosition:
        current?.latestBatchEventPosition ?? null,
      previousCoverageFingerprint: current?.coverageFingerprint ?? null,
      eventPayload,
      newFrames,
    });
    AUTHENTIC_PREPARED.add(prepared);
    PREPARED_METADATA.set(prepared, {
      plannedEventPosition: inputValue.plannedEventPosition,
      eventFramesJson: canonicalJson(eventPayload.frames),
      newFramesJson: canonicalJson(newFrames),
    });
    return prepared;
  }

  persistPrepared(
    connection: SqliteConnection,
    prepared: PreparedEvidenceCoverageBatch,
    committedEvent: StoredEvent,
  ): void {
    if (!AUTHENTIC_PREPARED.has(prepared)) return integrity();
    const metadata = PREPARED_METADATA.get(prepared);
    if (metadata === undefined) return integrity();
    if (
      canonicalJson(prepared.eventPayload.frames) !== metadata.eventFramesJson
      || canonicalJson(prepared.newFrames) !== metadata.newFramesJson
    ) return integrity();
    const payloadFrames = new Map(
      prepared.eventPayload.frames.map((frame) => [frame.ordinal, frame]),
    );
    for (const frame of prepared.newFrames) {
      const payloadFrame = payloadFrames.get(frame.ordinal);
      if (
        payloadFrame === undefined
        || canonicalJson(payloadFrame) !== canonicalJson(frame)
      ) return integrity();
    }
    const payloadJson = canonicalJson(prepared.eventPayload);
    if (
      committedEvent.globalPosition < 1n
      || committedEvent.globalPosition > SQLITE_INT64_MAX
      || (
        metadata.plannedEventPosition !== null
        && metadata.plannedEventPosition !== committedEvent.globalPosition
      )
      || committedEvent.projectId !== prepared.projectId
      || committedEvent.storeId !== prepared.storeId
      || committedEvent.sessionId !== prepared.sessionId
      || committedEvent.streamType !== "session"
      || committedEvent.eventType !== "EvidenceCoverageRecorded"
      || committedEvent.eventSchemaVersion !== 2
      || committedEvent.payloadJson !== payloadJson
      || canonicalJson(committedEvent.payload) !== payloadJson
    ) return integrity();
    const storedCommittedEvent = connection.prepare(`
      SELECT event_id, project_id, store_id, session_id, stream_type,
        event_type, event_schema_version, occurred_at, payload_json
      FROM events
      WHERE global_position = $globalPosition
    `).get({
      $globalPosition: committedEvent.globalPosition,
    });
    if (
      storedCommittedEvent === undefined
      || string(storedCommittedEvent, "event_id") !== committedEvent.eventId
      || string(storedCommittedEvent, "project_id") !== prepared.projectId
      || string(storedCommittedEvent, "store_id") !== prepared.storeId
      || string(storedCommittedEvent, "session_id") !== prepared.sessionId
      || string(storedCommittedEvent, "stream_type") !== "session"
      || string(storedCommittedEvent, "event_type") !== "EvidenceCoverageRecorded"
      || bigint(storedCommittedEvent, "event_schema_version") !== 2n
      || string(storedCommittedEvent, "occurred_at") !== committedEvent.occurredAt
      || string(storedCommittedEvent, "payload_json") !== payloadJson
    ) return integrity();
    const prior = connection.prepare(`
      SELECT latest_batch_event_position, coverage_fingerprint_value
      FROM session_evidence_coverage
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND adapter_session_id = $adapterSessionId
    `).get({
      $projectId: prepared.projectId,
      $sessionId: prepared.sessionId,
      $adapterSessionId: prepared.adapterSessionId,
    });
    if (
      prepared.expectedPriorLatestBatchEventPosition === null
        ? prior !== undefined
        : (
          prior === undefined
          || bigint(prior, "latest_batch_event_position")
            !== prepared.expectedPriorLatestBatchEventPosition
          || string(prior, "coverage_fingerprint_value")
            !== prepared.previousCoverageFingerprint
        )
    ) return integrity();

    const payload = prepared.eventPayload;
    const missingIntervalsJson = storageIntervals(payload.missingIntervals);
    const highest = payload.highestContiguousOrdinal === null
      ? -1n
      : BigInt(payload.highestContiguousOrdinal);
    connection.prepare(`
      INSERT INTO session_evidence_coverage_transitions(
        project_id, session_id, adapter_session_id, batch_id,
        batch_event_position, batch_first_ordinal, batch_last_ordinal,
        coverage_first_ordinal, coverage_last_ordinal,
        highest_contiguous_ordinal, missing_intervals_json,
        frame_fingerprint_algorithm, frame_fingerprint_schema_version,
        frame_fingerprint_key_id, frame_fingerprint_domain,
        previous_coverage_fingerprint_value,
        coverage_fingerprint_algorithm, coverage_fingerprint_schema_version,
        coverage_fingerprint_key_id, coverage_fingerprint_domain,
        coverage_fingerprint_value, new_frame_count, capture_mode,
        content_retained, created_at
      ) VALUES (
        $projectId, $sessionId, $adapterSessionId, $batchId,
        $eventPosition, $batchFirstOrdinal, $batchLastOrdinal,
        0, $coverageLastOrdinal, $highestContiguousOrdinal,
        $missingIntervalsJson, 'hmac-sha256', 1, $frameKeyId,
        'pm-evidence-frame-v1', $previousCoverageFingerprint,
        'hmac-sha256', 1, $frameKeyId, 'pm-evidence-coverage-v1',
        $coverageFingerprint, $newFrameCount, 'coverage-only', 0, $createdAt
      )
    `).run({
      $projectId: prepared.projectId,
      $sessionId: prepared.sessionId,
      $adapterSessionId: prepared.adapterSessionId,
      $batchId: payload.batchId,
      $eventPosition: committedEvent.globalPosition,
      $batchFirstOrdinal: BigInt(payload.batchFirstOrdinal),
      $batchLastOrdinal: BigInt(payload.batchLastOrdinal),
      $coverageLastOrdinal: BigInt(payload.coverageLastOrdinal),
      $highestContiguousOrdinal: highest,
      $missingIntervalsJson: missingIntervalsJson,
      $frameKeyId: payload.frameFingerprintKeyId,
      $previousCoverageFingerprint: prepared.previousCoverageFingerprint,
      $coverageFingerprint: payload.coverageFingerprint,
      $newFrameCount: prepared.newFrames.length,
      $createdAt: committedEvent.occurredAt,
    });

    if (prepared.expectedPriorLatestBatchEventPosition === null) {
      connection.prepare(`
        INSERT INTO session_evidence_coverage(
          project_id, session_id, adapter_session_id, capture_mode,
          first_ordinal, last_ordinal, highest_contiguous_ordinal,
          missing_intervals_json, fingerprint_algorithm,
          fingerprint_schema_version, fingerprint_key_id, fingerprint_domain,
          latest_batch_id, latest_batch_event_position, created_at, updated_at,
          coverage_fingerprint_algorithm, coverage_fingerprint_schema_version,
          coverage_fingerprint_key_id, coverage_fingerprint_domain,
          coverage_fingerprint_value
        ) VALUES (
          $projectId, $sessionId, $adapterSessionId, 'coverage-only',
          0, $coverageLastOrdinal, $highestContiguousOrdinal,
          $missingIntervalsJson, 'hmac-sha256', 1, $frameKeyId,
          'pm-evidence-frame-v1', $batchId, $eventPosition, $createdAt,
          $createdAt, 'hmac-sha256', 1, $frameKeyId,
          'pm-evidence-coverage-v1', $coverageFingerprint
        )
      `).run({
        $projectId: prepared.projectId,
        $sessionId: prepared.sessionId,
        $adapterSessionId: prepared.adapterSessionId,
        $coverageLastOrdinal: BigInt(payload.coverageLastOrdinal),
        $highestContiguousOrdinal: highest,
        $missingIntervalsJson: missingIntervalsJson,
        $frameKeyId: payload.frameFingerprintKeyId,
        $batchId: payload.batchId,
        $eventPosition: committedEvent.globalPosition,
        $createdAt: committedEvent.occurredAt,
        $coverageFingerprint: payload.coverageFingerprint,
      });
    } else {
      const result = connection.prepare(`
        UPDATE session_evidence_coverage SET
          last_ordinal = $coverageLastOrdinal,
          highest_contiguous_ordinal = $highestContiguousOrdinal,
          missing_intervals_json = $missingIntervalsJson,
          latest_batch_id = $batchId,
          latest_batch_event_position = $eventPosition,
          updated_at = $updatedAt,
          coverage_fingerprint_value = $coverageFingerprint
        WHERE project_id = $projectId
          AND session_id = $sessionId
          AND adapter_session_id = $adapterSessionId
          AND latest_batch_event_position = $expectedPosition
          AND coverage_fingerprint_value = $previousCoverageFingerprint
      `).run({
        $coverageLastOrdinal: BigInt(payload.coverageLastOrdinal),
        $highestContiguousOrdinal: highest,
        $missingIntervalsJson: missingIntervalsJson,
        $batchId: payload.batchId,
        $eventPosition: committedEvent.globalPosition,
        $updatedAt: committedEvent.occurredAt,
        $coverageFingerprint: payload.coverageFingerprint,
        $projectId: prepared.projectId,
        $sessionId: prepared.sessionId,
        $adapterSessionId: prepared.adapterSessionId,
        $expectedPosition: prepared.expectedPriorLatestBatchEventPosition,
        $previousCoverageFingerprint: prepared.previousCoverageFingerprint,
      });
      if (result.changes !== 1n) return integrity();
    }

    const insertFrame = connection.prepare(`
      INSERT INTO session_evidence_fingerprints(
        project_id, session_id, adapter_session_id, ordinal, frame_id,
        source_kind, observed_at, fingerprint_algorithm,
        fingerprint_schema_version, fingerprint_key_id, fingerprint_domain,
        fingerprint_value, batch_id, recorded_event_position, created_at
      ) VALUES (
        $projectId, $sessionId, $adapterSessionId, $ordinal, $frameId,
        $sourceKind, $observedAt, 'hmac-sha256', 1, $frameKeyId,
        'pm-evidence-frame-v1', $fingerprintValue, $batchId,
        $eventPosition, $createdAt
      )
    `);
    for (const frame of prepared.newFrames) {
      insertFrame.run({
        $projectId: prepared.projectId,
        $sessionId: prepared.sessionId,
        $adapterSessionId: prepared.adapterSessionId,
        $ordinal: BigInt(frame.ordinal),
        $frameId: frame.frameId,
        $sourceKind: frame.sourceKind,
        $observedAt: frame.observedAt,
        $frameKeyId: payload.frameFingerprintKeyId,
        $fingerprintValue: frame.contentFingerprint,
        $batchId: payload.batchId,
        $eventPosition: committedEvent.globalPosition,
        $createdAt: committedEvent.occurredAt,
      });
    }
  }

  assertQuickHealthy(
    connection: SqliteConnection,
    sessionIds: readonly SessionId[],
  ): void {
    const identity = storeIdentity(connection);
    const entries: CheckpointAdapterCoverageV2[] = [];
    for (const sessionId of new Set(sessionIds)) {
      const adapters = currentAdapters(connection, identity.projectId, sessionId, true);
      const snapshot = coverageSnapshot(adapters.map((adapter) => adapter.entry));
      assertEvidenceCoverageProjectionBounds({
        prospectiveAdapterCount: adapters.length,
        prospectiveTotalIntervalCount: adapters.reduce(
          (total, adapter) => total + adapter.intervals.length,
          0,
        ),
        targetIntervalCount: Math.max(
          0,
          ...adapters.map((adapter) => adapter.intervals.length),
        ),
        evidenceCoverage: snapshot,
      });
      entries.push(...adapters.map((adapter) => adapter.entry));
    }
    availableProfiles(
      this.#provider,
      identity.projectId,
      identity.storeId,
      entries,
    );
  }

  assertVersion1Eligible(
    connection: SqliteConnection,
    sessionIds: readonly SessionId[],
  ): void {
    const identity = storeIdentity(connection);
    for (const sessionId of new Set(sessionIds)) {
      const row = connection.prepare(`
        SELECT
          EXISTS(
            SELECT 1 FROM session_evidence_coverage
            WHERE project_id = $projectId AND session_id = $sessionId
          )
          OR EXISTS(
            SELECT 1 FROM session_evidence_coverage_transitions
            WHERE project_id = $projectId AND session_id = $sessionId
          )
          OR EXISTS(
            SELECT 1 FROM session_evidence_coverage_transition_heads
            WHERE project_id = $projectId AND session_id = $sessionId
          )
          OR EXISTS(
            SELECT 1 FROM session_evidence_fingerprints
            WHERE project_id = $projectId AND session_id = $sessionId
          ) AS has_coverage
      `).get({
        $projectId: identity.projectId,
        $sessionId: sessionId,
      });
      if (row === undefined || bigint(row, "has_coverage") !== 0n) {
        throw new LifecycleError("CHECKPOINT_EVIDENCE_VERSION_REQUIRED");
      }
      const artifact = connection.prepare(`
        SELECT 1
        FROM events
        WHERE project_id = $projectId
          AND session_id = $sessionId
          AND stream_type = 'session'
          AND session_id IS NOT NULL
          AND (
            event_type = 'EvidenceCoverageRecorded'
            OR (
              event_type = 'SessionCheckpointRecorded'
              AND (
                json_extract(
                  payload_json,
                  '$.checkpoint.evidenceCoverage.highestContiguousOrdinal'
                ) IS NOT NULL
                OR coalesce(json_array_length(
                  payload_json,
                  '$.checkpoint.evidenceCoverage.missingIntervals'
                ), 0) > 0
                OR coalesce(json_array_length(
                  payload_json,
                  '$.checkpoint.evidenceCoverage.adapterSessions'
                ), 0) > 0
              )
            )
          )
        LIMIT 1
      `).get({
        $projectId: identity.projectId,
        $sessionId: sessionId,
      });
      if (artifact !== undefined) {
        throw new LifecycleError("CHECKPOINT_EVIDENCE_VERSION_REQUIRED");
      }
    }
  }

  snapshotV2(
    connection: SqliteConnection,
    sessionId: SessionId,
    baseEventPosition: bigint,
  ): CheckpointEvidenceCoverageV2 {
    const identity = storeIdentity(connection);
    const adapters = currentAdapters(connection, identity.projectId, sessionId, true);
    if (adapters.some((adapter) =>
      adapter.latestBatchEventPosition > baseEventPosition)) return integrity();
    const entries = adapters.map((adapter) => adapter.entry);
    const snapshot = coverageSnapshot(entries);
    assertEvidenceCoverageProjectionBounds({
      prospectiveAdapterCount: entries.length,
      prospectiveTotalIntervalCount: adapters.reduce(
        (total, adapter) => total + adapter.intervals.length,
        0,
      ),
      targetIntervalCount: Math.max(
        0,
        ...adapters.map((adapter) => adapter.intervals.length),
      ),
      evidenceCoverage: snapshot,
    });
    availableProfiles(
      this.#provider,
      identity.projectId,
      identity.storeId,
      entries,
    );
    return snapshot;
  }

  snapshotFromTransitionsV2(
    connection: SqliteConnection,
    sessionId: SessionId,
    baseEventPosition: bigint,
  ): CheckpointEvidenceCoverageV2 {
    const identity = storeIdentity(connection);
    const adapterSessionIds = connection.prepare(`
      SELECT adapter_session_id
      FROM session_evidence_coverage_transition_heads
      WHERE project_id = $projectId
        AND session_id = $sessionId
      LIMIT 201
    `).all({
      $projectId: identity.projectId,
      $sessionId: sessionId,
    }).map((row) => string(row, "adapter_session_id"))
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    if (adapterSessionIds.length > 200) {
      throw new LifecycleError("EVIDENCE_ADAPTER_SESSION_LIMIT");
    }
    const selectTransition = connection.prepare(`
      SELECT transition.*,
        event.project_id AS event_project_id,
        event.session_id AS event_session_id,
        event.event_type AS event_type,
        event.event_schema_version AS event_schema_version
      FROM session_evidence_coverage_transitions AS transition
      LEFT JOIN events AS event
        ON event.global_position = transition.batch_event_position
      WHERE transition.project_id = $projectId
        AND transition.session_id = $sessionId
        AND transition.adapter_session_id = $adapterSessionId
        AND transition.batch_event_position <= $baseEventPosition
      ORDER BY batch_event_position DESC
      LIMIT 1
    `);
    const rows = adapterSessionIds.flatMap((adapterSessionId) => {
      const row = selectTransition.get({
        $projectId: identity.projectId,
        $sessionId: sessionId,
        $adapterSessionId: adapterSessionId,
        $baseEventPosition: baseEventPosition,
      });
      return row === undefined ? [] : [row];
    });
    let totalIntervals = 0;
    const entries = rows.map((row): CheckpointAdapterCoverageV2 => {
      const last = bigint(row, "coverage_last_ordinal");
      const highest = bigint(row, "highest_contiguous_ordinal");
      const intervals = parseIntervals(
        string(row, "missing_intervals_json"),
        last,
      );
      totalIntervals += intervals.length;
      if (totalIntervals > 200) {
        throw new LifecycleError("EVIDENCE_COVERAGE_TOO_FRAGMENTED");
      }
      const frameKey = string(row, "frame_fingerprint_key_id");
      const coverageKey = string(row, "coverage_fingerprint_key_id");
      const digest = string(row, "coverage_fingerprint_value");
      const firstMissing = intervals[0];
      const expectedHighest = firstMissing === undefined
        ? last
        : firstMissing.firstOrdinal - 1n;
      if (
        bigint(row, "coverage_first_ordinal") !== 0n
        || highest !== expectedHighest
        || string(row, "capture_mode") !== "coverage-only"
        || bigint(row, "content_retained") !== 0n
        || string(row, "frame_fingerprint_algorithm") !== "hmac-sha256"
        || bigint(row, "frame_fingerprint_schema_version") !== 1n
        || string(row, "frame_fingerprint_domain") !== "pm-evidence-frame-v1"
        || string(row, "coverage_fingerprint_algorithm") !== "hmac-sha256"
        || bigint(row, "coverage_fingerprint_schema_version") !== 1n
        || string(row, "coverage_fingerprint_domain") !== "pm-evidence-coverage-v1"
        || frameKey !== coverageKey
        || !isBoundedLifecycleString(frameKey, 128)
        || !LOWER_HASH.test(digest)
        || row.event_project_id !== row.project_id
        || row.event_session_id !== row.session_id
        || row.event_type !== "EvidenceCoverageRecorded"
        || row.event_schema_version !== 2n
      ) return integrity();
      return Object.freeze({
        adapterSessionId: string(row, "adapter_session_id") as AdapterSessionId,
        coverageFirstOrdinal: "0",
        coverageLastOrdinal: last.toString(),
        highestContiguousOrdinal: highest === -1n ? null : highest.toString(),
        missingIntervals: publicIntervals(intervals),
        frameFingerprintAlgorithm: "hmac-sha256",
        frameFingerprintSchemaVersion: 1,
        frameFingerprintKeyId: frameKey,
        frameFingerprintDomain: "pm-evidence-frame-v1",
        coverageFingerprintAlgorithm: "hmac-sha256",
        coverageFingerprintSchemaVersion: 1,
        coverageFingerprintKeyId: coverageKey,
        coverageFingerprintDomain: "pm-evidence-coverage-v1",
        coverageFingerprint: digest,
        latestBatchId: string(row, "batch_id") as CheckpointAdapterCoverageV2["latestBatchId"],
        latestBatchEventPosition: bigint(row, "batch_event_position").toString(),
      });
    });
    const snapshot = coverageSnapshot(entries);
    assertEvidenceCoverageProjectionBounds({
      prospectiveAdapterCount: entries.length,
      prospectiveTotalIntervalCount: totalIntervals,
      targetIntervalCount: Math.max(
        0,
        ...entries.map((entry) => entry.missingIntervals.length),
      ),
      evidenceCoverage: snapshot,
    });
    availableProfiles(
      this.#provider,
      identity.projectId,
      identity.storeId,
      entries,
    );
    return snapshot;
  }

  minimumCheckpointUpperBound(
    _connection: SqliteConnection,
    input: MinimumCheckpointCapacityInput,
  ): number {
    return checkpointUpperBound(input);
  }

  minimumFinalEndingScopeBindingsUpperBound(
    _connection: SqliteConnection,
    input: MinimumEndingScopeCapacityInput,
  ): number {
    return endingScopeUpperBound(input);
  }
}
