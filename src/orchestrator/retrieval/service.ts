import { ProjectionLagError } from "../projections/coordinator.js";
import { parseProjectionManifest } from "../projections/manifest.js";
import {
  InternalRetrievalError,
  validateInternalRetrievalRequest,
  type InternalRetrievalRequest,
  type InternalRetrievalResult,
  type InternalRetrievalResultItem,
  type ProjectionLeaseProvider,
  type RetrievalCandidateCollection,
  type RetrievalCandidateRepository,
  type RetrievalChannel,
  type RetrievalRanker,
  type ValidatedInternalRetrievalRequest,
} from "./contracts.js";

export interface InternalRetrievalServiceOptions {
  readonly projections: ProjectionLeaseProvider;
  readonly candidates: RetrievalCandidateRepository;
  readonly ranker?: RetrievalRanker;
}

function estimatedTokens(item: InternalRetrievalResultItem): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(
    `${item.id}\n${item.normalizedKey}\n${item.summary}\n${item.anchor ?? ""}`,
    "utf8",
  ) / 4));
}

class BoundedChannelOrderRanker implements RetrievalRanker {
  select(
    eligible: RetrievalCandidateCollection,
    request: ValidatedInternalRetrievalRequest,
    manifest: Parameters<RetrievalRanker["select"]>[2],
  ): InternalRetrievalResult {
    const contributions = new Map<string, RetrievalChannel[]>();
    for (const channel of eligible.channels) {
      for (const candidate of channel.candidates) {
        const key = `${candidate.item.kind}:${candidate.item.id}`;
        const current = contributions.get(key) ?? [];
        if (!current.includes(channel.channel)) current.push(channel.channel);
        contributions.set(key, current);
      }
    }

    const selected: InternalRetrievalResultItem[] = [];
    const seen = new Set<string>();
    let usedTokens = 0;
    let budgetTruncated = false;
    for (const channel of eligible.channels) {
      for (const candidate of channel.candidates) {
        const key = `${candidate.item.kind}:${candidate.item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const item = Object.freeze({
          ...candidate.item,
          channels: Object.freeze([...(contributions.get(key) ?? [channel.channel])]),
          selectionReason: channel.channel,
        }) as InternalRetrievalResultItem;
        const tokens = estimatedTokens(item);
        if (usedTokens + tokens > request.tokenBudget) {
          budgetTruncated = true;
          continue;
        }
        selected.push(item);
        usedTokens += tokens;
        if (selected.length >= request.limit) break;
      }
      if (selected.length >= request.limit) break;
    }
    const candidateCount = contributions.size;
    return Object.freeze({
      items: Object.freeze(selected),
      generation: manifest.generation,
      terminalEventPosition: BigInt(manifest.terminalEventPosition),
      candidateCount,
      truncated: eligible.truncated
        || budgetTruncated
        || candidateCount > selected.length,
    });
  }
}

export class InternalRetrievalService {
  readonly #projections: ProjectionLeaseProvider;
  readonly #candidates: RetrievalCandidateRepository;
  readonly #ranker: RetrievalRanker;

  constructor(options: InternalRetrievalServiceOptions) {
    this.#projections = options.projections;
    this.#candidates = options.candidates;
    this.#ranker = options.ranker ?? new BoundedChannelOrderRanker();
  }

  async retrieve(input: InternalRetrievalRequest): Promise<InternalRetrievalResult> {
    const request = validateInternalRetrievalRequest(input);
    const lease = await this.#projections.pin(request.binding, request.consistency);
    try {
      let manifest;
      try {
        manifest = parseProjectionManifest(lease.manifest, request.binding);
      } catch {
        throw new InternalRetrievalError("PROJECTION_SCOPE_MISMATCH");
      }
      const available = BigInt(manifest.terminalEventPosition);
      if (available < request.consistency.requiredEventPosition) {
        throw new ProjectionLagError(request.consistency.requiredEventPosition, available);
      }
      const eligible = this.#candidates.collectEligible(lease, request);
      return this.#ranker.select(eligible, request, manifest);
    } finally {
      lease.close();
    }
  }
}
