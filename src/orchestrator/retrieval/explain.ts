import type { ProjectionManifestV1 } from "../projections/manifest.js";
import {
  RETRIEVAL_LIMITS,
  type RetrievalChannel,
} from "./contracts.js";
import {
  DEFAULT_RANKING_POLICY,
  RERANK_FEATURE_NAMES,
  type RerankFeatureName,
} from "./ranking.js";

export const REDACTED_DROP_REASONS = Object.freeze([
  "scopeDenied",
  "temporalDenied",
  "statusDenied",
  "freshnessDenied",
  "eligibilityDenied",
  "candidateBound",
  "diversity",
  "resultLimit",
  "tokenBudget",
] as const);

export type RedactedDropReason = typeof REDACTED_DROP_REASONS[number];

export interface RedactedDropCounts {
  readonly total: number;
  readonly byReason: Readonly<Record<RedactedDropReason, number>>;
}

export interface RetrievalChannelContribution {
  readonly channel: RetrievalChannel;
  readonly eligibleCount: number;
  readonly selectedCount: number;
  readonly bestRank: number | null;
  readonly worstRank: number | null;
  readonly fusionContribution: number;
}

export interface RankedRetrieval {
  readonly eligibleCount: number;
  readonly redactedDropCounts: Readonly<{
    readonly total?: number;
    readonly byReason: Readonly<Partial<Record<RedactedDropReason, number>>>;
  }>;
  readonly channelContributions: readonly RetrievalChannelContribution[];
  readonly manifest: Pick<ProjectionManifestV1, "generation">;
  readonly requiredEventPosition: bigint;
  readonly publishedEventPosition: bigint;
  readonly rankingPolicyVersion?: string;
  readonly rerankFeatureNames?: readonly string[];
  readonly conflicts?: Readonly<{
    readonly groupCount: number;
    readonly totalMemberCount: number;
    readonly truncated: boolean;
    readonly cursor: string | null;
  }>;
  readonly truncated?: boolean;
}

export interface RetrievalExplanation {
  readonly eligibleCount: number;
  readonly dropped: RedactedDropCounts;
  readonly channels: readonly RetrievalChannelContribution[];
  readonly projectionGeneration: number;
  readonly requiredEventPosition: string;
  readonly publishedEventPosition: string;
  readonly consistency: Readonly<{
    readonly projectionGeneration: number;
    readonly requiredEventPosition: string;
    readonly publishedEventPosition: string;
  }>;
  readonly ranking: Readonly<{
    readonly policyVersion: string;
    readonly rerankFeatureNames: readonly RerankFeatureName[];
  }>;
  readonly conflicts: Readonly<{
    readonly groupCount: number;
    readonly totalMemberCount: number;
    readonly truncated: boolean;
    readonly cursorAvailable: boolean;
  }>;
  readonly truncated: boolean;
}

const CHANNELS = Object.freeze([
  "exact",
  "alias",
  "lexical",
  "symbol-path",
  "session-checkpoint",
  "open-follow-up",
] as const satisfies readonly RetrievalChannel[]);
const CHANNEL_SET = new Set<RetrievalChannel>(CHANNELS);
const FEATURE_SET = new Set<string>(RERANK_FEATURE_NAMES);

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function safeRank(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
}

function safeScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function safePosition(value: unknown): string {
  if (typeof value !== "bigint" || value < 0n) throw new TypeError("retrieval explanation position");
  return value.toString();
}

function dropCounts(source: RankedRetrieval["redactedDropCounts"]): RedactedDropCounts {
  const byReason = Object.fromEntries(REDACTED_DROP_REASONS.map((reason) => [
    reason,
    safeCount(source.byReason[reason]),
  ])) as unknown as Record<RedactedDropReason, number>;
  const frozenReasons = Object.freeze(byReason);
  return Object.freeze({
    total: REDACTED_DROP_REASONS.reduce((total, reason) => total + frozenReasons[reason], 0),
    byReason: frozenReasons,
  });
}

function channelContributions(
  source: readonly RetrievalChannelContribution[],
): readonly RetrievalChannelContribution[] {
  const aggregate = new Map<RetrievalChannel, RetrievalChannelContribution>();
  for (const contribution of source) {
    if (!CHANNEL_SET.has(contribution.channel)) continue;
    const current = aggregate.get(contribution.channel);
    const best = safeRank(contribution.bestRank);
    const worst = safeRank(contribution.worstRank);
    aggregate.set(contribution.channel, Object.freeze({
      channel: contribution.channel,
      eligibleCount: Math.max(
        current?.eligibleCount ?? 0,
        safeCount(contribution.eligibleCount),
      ),
      selectedCount: Math.max(
        current?.selectedCount ?? 0,
        safeCount(contribution.selectedCount),
      ),
      bestRank: current?.bestRank === null || current === undefined
        ? best
        : best === null ? current.bestRank : Math.min(current.bestRank, best),
      worstRank: current?.worstRank === null || current === undefined
        ? worst
        : worst === null ? current.worstRank : Math.max(current.worstRank, worst),
      fusionContribution: (current?.fusionContribution ?? 0)
        + safeScore(contribution.fusionContribution),
    }));
  }
  return Object.freeze(CHANNELS.flatMap((channel) => {
    const contribution = aggregate.get(channel);
    return contribution === undefined ? [] : [contribution];
  }));
}

function rerankFeatures(source: readonly string[]): readonly RerankFeatureName[] {
  const present = new Set(source.filter((name) => FEATURE_SET.has(name)));
  return Object.freeze(RERANK_FEATURE_NAMES.filter((name) => present.has(name)));
}

/**
 * Builds a new aggregate-only object. No candidate object, text, identifier,
 * provider input, authority handle, raw evidence, or cursor is copied through.
 */
export function buildRetrievalExplanation(
  result: RankedRetrieval,
): RetrievalExplanation {
  const generation = safeCount(result.manifest.generation);
  const requiredEventPosition = safePosition(result.requiredEventPosition);
  const publishedEventPosition = safePosition(result.publishedEventPosition);
  const consistency = Object.freeze({
    projectionGeneration: generation,
    requiredEventPosition,
    publishedEventPosition,
  });
  const output = Object.freeze({
    eligibleCount: safeCount(result.eligibleCount),
    dropped: dropCounts(result.redactedDropCounts),
    channels: channelContributions(result.channelContributions),
    projectionGeneration: generation,
    requiredEventPosition,
    publishedEventPosition,
    consistency,
    ranking: Object.freeze({
      policyVersion: result.rankingPolicyVersion === undefined
        || result.rankingPolicyVersion === DEFAULT_RANKING_POLICY.version
        ? DEFAULT_RANKING_POLICY.version
        : "unknown",
      rerankFeatureNames: rerankFeatures(
        result.rerankFeatureNames ?? DEFAULT_RANKING_POLICY.rerankFeatureNames,
      ),
    }),
    conflicts: Object.freeze({
      groupCount: safeCount(result.conflicts?.groupCount),
      totalMemberCount: safeCount(result.conflicts?.totalMemberCount),
      truncated: result.conflicts?.truncated === true,
      cursorAvailable: result.conflicts?.cursor !== undefined
        && result.conflicts.cursor !== null,
    }),
    truncated: result.truncated === true,
  });
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > RETRIEVAL_LIMITS.explainBytes) {
    throw new TypeError("retrieval explanation exceeds internal bound");
  }
  return output;
}
