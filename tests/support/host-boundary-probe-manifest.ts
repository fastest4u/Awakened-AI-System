import type { EvidenceFrameId, SessionId } from "../../src/orchestrator/lifecycle/contracts/identifiers.js";

export type SyntheticProbeCategory = "user-message" | "assistant-message" | "tool-call" | "tool-result" | "child-report" | "reference" | "correction" | "final-assistant";
export interface SyntheticProbeFrameV1 {
  readonly frameId: EvidenceFrameId;
  readonly ordinal: string;
  readonly category: SyntheticProbeCategory;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: SessionId;
  readonly childId: SessionId | null;
  readonly correlationId: string | null;
  readonly previousFrameId: EvidenceFrameId | null;
  readonly contentHash: string;
}
export interface SyntheticExpectedManifest {
  readonly manifestVersion: 1;
  readonly frames: readonly SyntheticProbeFrameV1[];
}

// Fixed synthetic metadata, independent of any observed stream.
export function createSyntheticExpectedManifest(): SyntheticExpectedManifest {
  const categories: readonly SyntheticProbeCategory[] = ["user-message", "assistant-message", "tool-call", "tool-result", "child-report", "reference", "correction", "assistant-message", "tool-call", "tool-result", "final-assistant"];
  const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003", "10000000-0000-4000-8000-000000000004", "10000000-0000-4000-8000-000000000005", "10000000-0000-4000-8000-000000000006", "10000000-0000-4000-8000-000000000007", "10000000-0000-4000-8000-000000000008", "10000000-0000-4000-8000-000000000009", "10000000-0000-4000-8000-00000000000a", "10000000-0000-4000-8000-00000000000b"] as EvidenceFrameId[];
  const root = "20000000-0000-4000-8000-000000000001" as SessionId;
  const child = "20000000-0000-4000-8000-000000000002" as SessionId;
  const hashes = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a"];
  const frames = categories.map((category, index): SyntheticProbeFrameV1 => Object.freeze({
    frameId: ids[index]!, ordinal: String(index), category,
    projectId: "30000000-0000-4000-8000-000000000001",
    workspaceId: "40000000-0000-4000-8000-000000000001",
    sessionId: category === "child-report" ? child : root,
    childId: category === "child-report" ? child : null,
    correlationId: index === 2 || index === 3 ? "50000000-0000-4000-8000-000000000001" : index === 8 || index === 9 ? "50000000-0000-4000-8000-000000000002" : null,
    previousFrameId: index === 0 ? null : ids[index - 1]!,
    contentHash: hashes[index]!.repeat(64),
  }));
  return Object.freeze({ manifestVersion: 1, frames: Object.freeze(frames) });
}
