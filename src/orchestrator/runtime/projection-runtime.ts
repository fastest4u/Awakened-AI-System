import type { ProjectionBuildCoordinator } from "../projections/coordinator.js";
import type {
  ProjectionLeaseProvider,
  RetrievalCandidateRepository,
  RetrievalRanker,
  VectorCandidateChannel,
} from "../retrieval/contracts.js";
import { InternalRetrievalService } from "../retrieval/service.js";

export interface InternalProjectionRuntimeDependencies {
  readonly coordinator: ProjectionBuildCoordinator;
  readonly candidates: RetrievalCandidateRepository;
  readonly ranker?: RetrievalRanker;
  readonly vectorChannel?: VectorCandidateChannel;
}

export interface InternalProjectionRuntime {
  readonly coordinator: ProjectionBuildCoordinator;
  readonly projections: ProjectionLeaseProvider;
  readonly retrieval: InternalRetrievalService;
}

export function createInternalProjectionRuntime(
  dependencies: InternalProjectionRuntimeDependencies,
): InternalProjectionRuntime {
  const coordinator = dependencies.coordinator;
  const candidates = dependencies.candidates;
  const ranker = dependencies.ranker;
  const vectorChannel = dependencies.vectorChannel;
  const projections: ProjectionLeaseProvider = Object.freeze({
    async pin(
      binding: Parameters<ProjectionLeaseProvider["pin"]>[0],
      consistency: Parameters<ProjectionLeaseProvider["pin"]>[1],
    ) {
      await coordinator.ensurePublished(
        binding,
        consistency.requiredEventPosition,
        consistency.deadlineMs,
      );
      return coordinator.leasePublished(binding);
    },
  });
  const retrieval = new InternalRetrievalService({
    projections,
    candidates,
    ...(ranker === undefined ? {} : { ranker }),
    ...(vectorChannel === undefined
      ? {}
      : { vectorChannel }),
  });
  return Object.freeze({
    coordinator,
    projections,
    retrieval,
  });
}
