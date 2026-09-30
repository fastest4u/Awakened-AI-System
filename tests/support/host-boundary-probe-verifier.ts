import { exactRecord, strictRecord, strictArray, parseLifecycleId, parseDecimalString, parseBoundedString, parseEnum, parseInteger, type EvidenceFrameId, type SessionId } from "../../src/orchestrator/lifecycle/contracts/identifiers.js";
import { canonicalJson } from "../../src/orchestrator/serialization/canonical-json.js";
import type { SyntheticExpectedManifest, SyntheticProbeFrameV1 } from "./host-boundary-probe-manifest.js";

export type SyntheticVerificationResult = { readonly ok: true; readonly uniqueFrameCount: number } | { readonly ok: false; readonly reason: "input-invalid" | "limit-exceeded" | "missing-frame" | "unexpected-frame" | "payload-changed" | "scope-mismatch" | "correlation-mismatch" | "order-mismatch" };
export interface SyntheticProbeLimits {
  readonly maxObservations: number;
  readonly maxFrameCanonicalBytes: number;
  readonly maxTotalCanonicalBytes: number;
}
export const SYNTHETIC_PROBE_LIMITS: SyntheticProbeLimits = Object.freeze({ maxObservations: 64, maxFrameCanonicalBytes: 65_536, maxTotalCanonicalBytes: 262_144 });
const CATEGORIES = ["user-message", "assistant-message", "tool-call", "tool-result", "child-report", "reference", "correction", "final-assistant"] as const;
const FRAME_KEYS = ["frameId", "ordinal", "category", "projectId", "workspaceId", "sessionId", "childId", "correlationId", "previousFrameId", "contentHash"] as const;
const LIMIT_KEYS = ["maxObservations", "maxFrameCanonicalBytes", "maxTotalCanonicalBytes"] as const;
class LimitExceeded extends Error {}
const invalid = (): never => { throw new Error("synthetic input invalid"); };
const fail = (reason: Extract<SyntheticVerificationResult, { ok: false }>["reason"]): SyntheticVerificationResult => ({ ok: false, reason });

function parseLimits(value: unknown): SyntheticProbeLimits {
  const record = exactRecord(value, LIMIT_KEYS, "limits");
  return {
    maxObservations: parseInteger(record.maxObservations, "maxObservations", 1, SYNTHETIC_PROBE_LIMITS.maxObservations),
    maxFrameCanonicalBytes: parseInteger(record.maxFrameCanonicalBytes, "maxFrameCanonicalBytes", 1, SYNTHETIC_PROBE_LIMITS.maxFrameCanonicalBytes),
    maxTotalCanonicalBytes: parseInteger(record.maxTotalCanonicalBytes, "maxTotalCanonicalBytes", 1, SYNTHETIC_PROBE_LIMITS.maxTotalCanonicalBytes),
  };
}

function boundedArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) return invalid();
  // strictArray allocates keys from length; cap this before asking it to inspect shape.
  if (length.value > maximum) throw new LimitExceeded();
  return strictArray(value, "frames");
}

function parseFrame(value: unknown): SyntheticProbeFrameV1 {
  const record = exactRecord(value, FRAME_KEYS, "frame");
  const boundedAscii = (v: unknown, field: string, maximum: number): string => {
    // Canonical UUID/hash/decimal fields are ASCII. Bound code units before the
    // shared scalar parser allocates Array.from(v) to count Unicode scalars.
    if (typeof v !== "string" || v.length > maximum) return invalid();
    return parseBoundedString(v, field, maximum);
  };
  const uuid = <T extends string>(v: unknown, field: string): T => parseLifecycleId<T>(boundedAscii(v, field, 36), field);
  const hash = boundedAscii(record.contentHash, "contentHash", 64);
  if (!/^[0-9a-f]{64}$/.test(hash)) invalid();
  return {
    frameId: uuid<EvidenceFrameId>(record.frameId, "frameId"),
    ordinal: parseDecimalString(boundedAscii(record.ordinal, "ordinal", 19), "ordinal"),
    category: parseEnum(record.category, CATEGORIES, "category"),
    projectId: uuid(record.projectId, "projectId"), workspaceId: uuid(record.workspaceId, "workspaceId"),
    sessionId: uuid<SessionId>(record.sessionId, "sessionId"),
    childId: record.childId === null ? null : uuid<SessionId>(record.childId, "childId"),
    correlationId: record.correlationId === null ? null : uuid(record.correlationId, "correlationId"),
    previousFrameId: record.previousFrameId === null ? null : uuid<EvidenceFrameId>(record.previousFrameId, "previousFrameId"),
    contentHash: hash,
  };
}

function parsedFrames(value: unknown, limits: SyntheticProbeLimits): readonly SyntheticProbeFrameV1[] {
  const frames = boundedArray(value, limits.maxObservations).map(parseFrame);
  // Serialize only the validated data copies; duplicates are still present here.
  if (frames.some(f => Buffer.byteLength(canonicalJson(f), "utf8") > limits.maxFrameCanonicalBytes)
    || Buffer.byteLength(canonicalJson(frames), "utf8") > limits.maxTotalCanonicalBytes) throw new LimitExceeded();
  return frames;
}

function parseManifest(value: unknown): readonly SyntheticProbeFrameV1[] {
  const record = exactRecord(strictRecord(value, "manifest"), ["manifestVersion", "frames"], "manifest");
  if (record.manifestVersion !== 1) invalid();
  const frames = parsedFrames(record.frames, SYNTHETIC_PROBE_LIMITS);
  if (frames.length === 0) invalid();
  const first = frames[0]!;
  if (first.childId !== null || first.category === "child-report") invalid();
  const seen = new Set<string>();
  const categories = new Set<string>();
  const pendingCalls = new Set<string>();
  const usedCorrelations = new Set<string>();
  for (const [index, frame] of frames.entries()) {
    if (seen.has(frame.frameId) || frame.ordinal !== String(index)
      || frame.previousFrameId !== (index === 0 ? null : frames[index - 1]!.frameId)
      || frame.projectId !== first.projectId || frame.workspaceId !== first.workspaceId) invalid();
    seen.add(frame.frameId);
    categories.add(frame.category);
    if (frame.category === "final-assistant" && index !== frames.length - 1) invalid();
    if (frame.category === "child-report") {
      if (frame.childId === null || frame.sessionId !== frame.childId || frame.sessionId === first.sessionId) invalid();
    } else if (frame.childId !== null || frame.sessionId !== first.sessionId) invalid();
    if (frame.category === "tool-call") {
      if (frame.correlationId === null || usedCorrelations.has(frame.correlationId)) return invalid();
      usedCorrelations.add(frame.correlationId);
      pendingCalls.add(frame.correlationId);
    } else if (frame.category === "tool-result") {
      if (frame.correlationId === null || !pendingCalls.delete(frame.correlationId)) invalid();
    } else if (frame.correlationId !== null) invalid();
  }
  if (pendingCalls.size !== 0 || CATEGORIES.some(c => !categories.has(c)) || frames.at(-1)!.category !== "final-assistant") invalid();
  return frames;
}

/** Synthetic metadata completeness only: neither host proof nor authority. */
export function verifySyntheticHostObservations(manifest: SyntheticExpectedManifest, observations: unknown, limits: SyntheticProbeLimits = SYNTHETIC_PROBE_LIMITS): SyntheticVerificationResult {
  let expected: readonly SyntheticProbeFrameV1[];
  let budget: SyntheticProbeLimits;
  try {
    budget = parseLimits(limits);
    expected = parseManifest(manifest);
  } catch { return fail("input-invalid"); }
  let observed: readonly SyntheticProbeFrameV1[];
  try { observed = parsedFrames(observations, budget); }
  catch (error) { return fail(error instanceof LimitExceeded ? "limit-exceeded" : "input-invalid"); }
  const unique = new Map<string, SyntheticProbeFrameV1>();
  let conflictingDuplicate = false;
  for (const frame of observed) {
    const earlier = unique.get(frame.frameId);
    if (earlier === undefined) unique.set(frame.frameId, frame);
    else if (canonicalJson(earlier) !== canonicalJson(frame)) conflictingDuplicate = true;
  }
  const expectedIds = new Set(expected.map(f => f.frameId));
  if (expected.some(f => !unique.has(f.frameId))) return fail("missing-frame");
  if ([...unique.keys()].some(id => !expectedIds.has(id as EvidenceFrameId))) return fail("unexpected-frame");
  if (conflictingDuplicate) return fail("payload-changed");
  const ordered = [...unique.values()];
  for (const [index, frame] of ordered.entries()) {
    const wanted = expected[index]!;
    if (frame.frameId !== wanted.frameId || frame.ordinal !== wanted.ordinal || frame.previousFrameId !== wanted.previousFrameId) return fail("order-mismatch");
    if (frame.projectId !== wanted.projectId || frame.workspaceId !== wanted.workspaceId || frame.sessionId !== wanted.sessionId || frame.childId !== wanted.childId) return fail("scope-mismatch");
    if (frame.correlationId !== wanted.correlationId) return fail("correlation-mismatch");
    if (frame.category !== wanted.category || frame.contentHash !== wanted.contentHash) return fail("payload-changed");
  }
  return { ok: true, uniqueFrameCount: unique.size };
}
