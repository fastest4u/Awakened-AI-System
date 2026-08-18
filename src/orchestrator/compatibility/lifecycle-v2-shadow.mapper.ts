import { createHash } from "node:crypto";
import type { JsonValue } from "../contracts/event.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { RootSessionState, SessionId } from "../lifecycle/contracts/identifiers.js";
import {
  type CapturedV1LifecycleExchange,
  type RedactedSessionSummary,
  type RedactedTrustedBindingSummary,
  type ShadowCandidateSummary,
  type ShadowComparisonV1,
  type ShadowDivergence,
} from "./lifecycle-v2-disabled.adapter.js";

type SafeHints = {
  sessionId?: SessionId;
  state?: RootSessionState;
  eventPosition?: string;
  continuityKeyHash?: string;
  superseded?: boolean;
  invariantParity?: "match" | "differs";
  requireFullEvidence?: boolean;
  evidenceMode?: "coverage-only" | "none";
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_POSITION_PATTERN = /^[0-9]{1,32}$/;
const CONTINUITY_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const SAFE_HINT_CONTAINERS = ["authority", "data", "lifecycle", "result", "session", "status", "summary", "value"] as const;
const SHADOW_INTENT_DOMAIN = "project-memory/shadow-v1-intent/v1";
const SHADOW_OUTCOME_DOMAIN = "project-memory/shadow-v1-outcome/v1";
const MAX_SUMMARY_IDENTIFIER_LENGTH = 128;
const MAX_SUMMARY_GENERATION_LENGTH = 64;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRootSessionState(value: unknown): value is RootSessionState {
  return value === "active"
    || value === "suspended"
    || value === "ending"
    || value === "ended"
    || value === "abandoned";
}

function readSessionId(value: unknown): SessionId | undefined {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value as SessionId : undefined;
}

function readEventPosition(value: unknown): string | undefined {
  return typeof value === "string" && EVENT_POSITION_PATTERN.test(value) ? value : undefined;
}

function readContinuityKeyHash(value: unknown): string | undefined {
  return typeof value === "string" && CONTINUITY_HASH_PATTERN.test(value) ? value : undefined;
}

function boundedText<T extends string>(value: T, maximum: number): T {
  return (value.length <= maximum ? value : value.slice(0, maximum)) as T;
}

function mergeHints(target: SafeHints, source: SafeHints): void {
  if (target.sessionId === undefined && source.sessionId !== undefined) target.sessionId = source.sessionId;
  if (target.state === undefined && source.state !== undefined) target.state = source.state;
  if (target.eventPosition === undefined && source.eventPosition !== undefined) target.eventPosition = source.eventPosition;
  if (target.continuityKeyHash === undefined && source.continuityKeyHash !== undefined) target.continuityKeyHash = source.continuityKeyHash;
  if (target.superseded === undefined && source.superseded !== undefined) target.superseded = source.superseded;
  if (target.invariantParity === undefined && source.invariantParity !== undefined) target.invariantParity = source.invariantParity;
  if (target.requireFullEvidence === undefined && source.requireFullEvidence !== undefined) target.requireFullEvidence = source.requireFullEvidence;
  if (target.evidenceMode === undefined && source.evidenceMode !== undefined) target.evidenceMode = source.evidenceMode;
}

function readSafeHints(value: unknown, depth = 0): SafeHints {
  if (depth > 3 || !isPlainRecord(value)) return {};

  const hints: SafeHints = {};
  const sessionId = readSessionId(value.sessionId);
  if (sessionId !== undefined) hints.sessionId = sessionId;
  if (isRootSessionState(value.state)) hints.state = value.state;

  const eventPosition = readEventPosition(value.eventPosition);
  if (eventPosition !== undefined) hints.eventPosition = eventPosition;
  const continuityKeyHash = readContinuityKeyHash(value.continuityKeyHash);
  if (continuityKeyHash !== undefined) hints.continuityKeyHash = continuityKeyHash;
  if (typeof value.superseded === "boolean") hints.superseded = value.superseded;
  if (value.invariantParity === "match" || value.invariantParity === "differs") {
    hints.invariantParity = value.invariantParity;
  } else if (typeof value.invariantParity === "boolean") {
    hints.invariantParity = value.invariantParity ? "match" : "differs";
  }
  if (typeof value.requireFullEvidence === "boolean") hints.requireFullEvidence = value.requireFullEvidence;
  if (value.evidenceMode === "coverage-only" || value.evidenceMode === "none") {
    hints.evidenceMode = value.evidenceMode;
  }

  for (const key of SAFE_HINT_CONTAINERS) {
    mergeHints(hints, readSafeHints(value[key], depth + 1));
  }
  return hints;
}

function freezeDeep<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function hashRedacted(domain: string, value: JsonValue): string {
  return createHash("sha256")
    .update(`${domain}\n${canonicalJson(value)}`, "utf8")
    .digest("hex");
}

function redactedCandidate(candidate: ShadowCandidateSummary): RedactedSessionSummary {
  return freezeDeep({
    projectId: boundedText(candidate.projectId, MAX_SUMMARY_IDENTIFIER_LENGTH),
    storeId: boundedText(candidate.storeId, MAX_SUMMARY_IDENTIFIER_LENGTH),
    workspaceId: boundedText(candidate.workspaceId, MAX_SUMMARY_IDENTIFIER_LENGTH),
    sessionId: boundedText(candidate.sessionId, MAX_SUMMARY_IDENTIFIER_LENGTH),
    state: candidate.state,
    continuityKeyHash: boundedText(candidate.continuityKeyHash, MAX_SUMMARY_IDENTIFIER_LENGTH),
    ownerGeneration: boundedText(candidate.ownerGeneration, MAX_SUMMARY_GENERATION_LENGTH),
    eventPosition: boundedText(candidate.eventPosition, MAX_SUMMARY_GENERATION_LENGTH),
    evidenceMode: candidate.evidenceMode,
  });
}

function divergence(
  code: ShadowDivergence["code"],
  field: string,
  v1Summary: Record<string, JsonValue>,
  v2Summary: Record<string, JsonValue>,
): ShadowDivergence {
  return { code, field, v1Summary, v2Summary };
}

function associationDivergence(
  captured: CapturedV1LifecycleExchange,
  association: "none" | "ambiguous",
  eligibleCount: number,
): ShadowDivergence {
  return divergence(
    "V2_SELECTION_DIFFERS",
    "association",
    { operation: captured.operation, association },
    { eligibleCandidateCount: eligibleCount },
  );
}

export function mapLifecycleShadowComparison(
  captured: CapturedV1LifecycleExchange,
  binding: RedactedTrustedBindingSummary,
  candidates: readonly ShadowCandidateSummary[],
): ShadowComparisonV1 {
  const intentMaterial = {
    operation: captured.operation,
    redactedInput: captured.redactedInput,
  } as JsonValue;
  const outcomeMaterial = {
    operation: captured.operation,
    redactedOutcome: captured.redactedOutcome,
  } as JsonValue;
  const eligible = candidates.filter((candidate) => (
    candidate.projectId === binding.projectId
    && candidate.storeId === binding.storeId
    && candidate.workspaceId === binding.workspaceId
  ));
  const association: ShadowComparisonV1["association"] = eligible.length === 1
    ? "unique"
    : eligible.length === 0 ? "none" : "ambiguous";
  const selected = eligible.length === 1 ? eligible[0] : undefined;
  const divergences: ShadowDivergence[] = [];

  if (selected === undefined) {
    const missingAssociation = eligible.length === 0 ? "none" : "ambiguous";
    divergences.push(associationDivergence(captured, missingAssociation, eligible.length));
  } else {
    const selectedSummary = redactedCandidate(selected);
    const inputHints = readSafeHints(captured.redactedInput);
    const outcomeHints = captured.redactedOutcome.ok
      ? readSafeHints(captured.redactedOutcome.value)
      : {};
    const hints: SafeHints = { ...inputHints, ...outcomeHints };

    if (hints.superseded !== undefined && hints.superseded !== (selected.state === "abandoned")) {
      divergences.push(divergence(
        "V1_SUPERSESSION_DIFFERS",
        "superseded",
        { superseded: hints.superseded },
        { state: selected.state },
      ));
    }

    const authorityFields: string[] = [];
    if (hints.state !== undefined && hints.state !== selected.state) authorityFields.push("state");
    if (binding.continuityKeyHash !== null && binding.continuityKeyHash !== selected.continuityKeyHash) {
      authorityFields.push("continuityKeyHash");
    }
    if (authorityFields.length > 0) {
      const v1Authority: Record<string, JsonValue> = {};
      if (hints.state !== undefined) v1Authority.state = hints.state;
      if (binding.continuityKeyHash !== null) {
        v1Authority.continuityKeyHash = boundedText(binding.continuityKeyHash, MAX_SUMMARY_IDENTIFIER_LENGTH);
      }
      const v2Authority: Record<string, JsonValue> = {
        state: selectedSummary.state,
        continuityKeyHash: selectedSummary.continuityKeyHash,
      };
      divergences.push(divergence(
        "V2_AUTHORITY_DIFFERS",
        authorityFields.join(","),
        v1Authority,
        v2Authority,
      ));
    }

    if (hints.invariantParity === "differs") {
      divergences.push(divergence(
        "INVARIANT_PARITY_DIFFERS",
        "invariantParity",
        { invariantParity: hints.invariantParity },
        { invariantParity: "unsupported" },
      ));
    }

    const identityPositionDiffers = (
      (hints.sessionId !== undefined && hints.sessionId !== selectedSummary.sessionId)
      || (hints.eventPosition !== undefined && hints.eventPosition !== selectedSummary.eventPosition)
      || (hints.continuityKeyHash !== undefined && hints.continuityKeyHash !== selectedSummary.continuityKeyHash)
    );
    if (identityPositionDiffers) {
      const v1Identity: Record<string, JsonValue> = {};
      if (hints.sessionId !== undefined) v1Identity.sessionId = hints.sessionId;
      if (hints.eventPosition !== undefined) v1Identity.eventPosition = hints.eventPosition;
      if (hints.continuityKeyHash !== undefined) v1Identity.continuityKeyHash = hints.continuityKeyHash;
      divergences.push(divergence(
        "IDENTITY_POSITION_DIFFERS",
        "identity-or-event-position",
        v1Identity,
        {
          sessionId: selectedSummary.sessionId,
          continuityKeyHash: selectedSummary.continuityKeyHash,
          eventPosition: selectedSummary.eventPosition,
        },
      ));
    }

    if (selectedSummary.evidenceMode === "coverage-only") {
      divergences.push(divergence(
        "EVIDENCE_RETENTION_UNSUPPORTED",
        "evidenceMode",
        {
          evidenceMode: hints.evidenceMode
            ?? (hints.requireFullEvidence === true ? "full" : "unknown"),
        },
        { evidenceMode: selectedSummary.evidenceMode },
      ));
    }
  }

  const comparison: ShadowComparisonV1 = {
    schemaVersion: 1,
    executable: false,
    v1IntentHash: hashRedacted(SHADOW_INTENT_DOMAIN, intentMaterial),
    v1OutcomeHash: hashRedacted(SHADOW_OUTCOME_DOMAIN, outcomeMaterial),
    association,
    ...(selected === undefined ? {} : { candidate: redactedCandidate(selected) }),
    divergence: divergences,
  };
  return freezeDeep(comparison);
}
