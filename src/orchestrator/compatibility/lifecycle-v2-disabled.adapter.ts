import type { JsonValue } from "../contracts/event.js";
import type { ProjectId, StoreId, WorkspaceId } from "../identity/contracts.js";
import type { RootSessionState, SessionId } from "../lifecycle/contracts/identifiers.js";
import type { MemoryWorkflowService } from "../../services/memory-workflow.service.js";

export type LifecycleV1Port = Pick<
  MemoryWorkflowService,
  | "sessionStart"
  | "contextPack"
  | "awaken"
  | "selfCheck"
  | "sessionEnd"
  | "lifecycleStatus"
  | "followUpRadar"
>;

export type CapturedV1LifecycleExchange = {
  readonly [K in keyof LifecycleV1Port]: {
    readonly operation: K;
    readonly redactedInput: JsonValue;
    readonly redactedOutcome:
      | { readonly ok: true; readonly value: JsonValue }
      | { readonly ok: false; readonly safeErrorCode: string };
  };
}[keyof LifecycleV1Port];

export interface RedactedTrustedBindingSummary {
  readonly projectId: ProjectId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly clientNamespace: string;
  readonly continuityKeyHash: string | null;
}

export interface ShadowCandidateSummary {
  readonly projectId: ProjectId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly state: RootSessionState;
  readonly continuityKeyHash: string;
  readonly ownerGeneration: string;
  readonly eventPosition: string;
  readonly evidenceMode: "coverage-only" | "none";
}

export type RedactedSessionSummary = ShadowCandidateSummary;

export interface ShadowDivergence {
  readonly code:
    | "V1_SUPERSESSION_DIFFERS"
    | "V2_SELECTION_DIFFERS"
    | "V2_AUTHORITY_DIFFERS"
    | "INVARIANT_PARITY_DIFFERS"
    | "IDENTITY_POSITION_DIFFERS"
    | "EVIDENCE_RETENTION_UNSUPPORTED";
  readonly field: string;
  readonly v1Summary: JsonValue;
  readonly v2Summary: JsonValue;
}

export interface ShadowComparisonV1 {
  readonly schemaVersion: 1;
  readonly executable: false;
  readonly v1IntentHash: string;
  readonly v1OutcomeHash: string;
  readonly association: "unique" | "none" | "ambiguous";
  readonly candidate?: RedactedSessionSummary;
  readonly divergence: readonly ShadowDivergence[];
}

export class LifecycleV2DisabledAdapter {
  constructor(private readonly v1: LifecycleV1Port) {}

  invoke<K extends keyof LifecycleV1Port>(
    operation: K,
    input: Parameters<LifecycleV1Port[K]>[0],
  ): ReturnType<LifecycleV1Port[K]> {
    const method = this.v1[operation] as unknown as (
      value: Parameters<LifecycleV1Port[K]>[0],
    ) => ReturnType<LifecycleV1Port[K]>;
    return method.call(this.v1, input);
  }
}
