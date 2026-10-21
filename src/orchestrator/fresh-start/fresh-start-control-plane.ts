import { randomUUID } from "node:crypto";
import { decodeFreshStartAutomaticStop, decodeFreshStartTransitionRequest, FreshStartError,
  type FreshStartAutomaticStop, type FreshStartIdentity, type FreshStartMode,
  type FreshStartRelease, type FreshStartState, type FreshStartTransitionRequest } from "./contracts.js";
import { SqliteFreshStartRepository, type FreshStartTransaction } from "./fresh-start.repository.js";
import { freshStartRequestDigest, requireVerifiedFreshStartEvidence, requireVerifiedOperatorApproval,
  type FreshStartEvidenceVerifier, type OperatorApprovalVerifier } from "./operator-approval.js";

const EDGES: Readonly<Record<FreshStartMode, readonly FreshStartMode[]>> = Object.freeze({
  prepared: Object.freeze(["active", "disabled"] as const),
  active: Object.freeze(["read-only-recovery", "disabled"] as const),
  "read-only-recovery": Object.freeze(["active", "disabled"] as const),
  disabled: Object.freeze(["prepared"] as const),
});
function sameIdentity(left: FreshStartIdentity, right: FreshStartIdentity): boolean {
  return left.projectId === right.projectId && left.vaultId === right.vaultId && left.storeId === right.storeId;
}
function sameRelease(left: FreshStartRelease, right: FreshStartRelease): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function edge(from: FreshStartMode, to: FreshStartMode): void {
  if (!EDGES[from].includes(to)) throw new FreshStartError("FRESH_START_EDGE_FORBIDDEN");
}
function checkedState(tx: FreshStartTransaction, request: FreshStartTransitionRequest): FreshStartState {
  const state = tx.state();
  if (!state) throw new FreshStartError("FRESH_START_NOT_INITIALIZED");
  if (state.generation !== request.expectedGeneration || state.mode !== request.expectedMode || state.releaseId !== request.expectedReleaseId) throw new FreshStartError("FRESH_START_STALE_STATE");
  edge(state.mode, request.nextMode);
  if (!sameIdentity(state, request.nextRelease)) throw new FreshStartError("FRESH_START_IDENTITY_MISMATCH");
  const replacement = state.releaseId !== request.nextRelease.releaseId;
  if (replacement && (state.mode !== "disabled" || request.nextMode !== "prepared")) throw new FreshStartError("FRESH_START_RELEASE_MISMATCH");
  const stored = tx.release(request.nextRelease.releaseId);
  if ((!replacement && !stored) || (stored && !sameRelease(stored, request.nextRelease))) throw new FreshStartError("FRESH_START_RELEASE_MISMATCH");
  return state;
}

export class FreshStartControlPlane {
  constructor(private readonly repository: SqliteFreshStartRepository,
    private readonly approvals: OperatorApprovalVerifier, private readonly evidence: FreshStartEvidenceVerifier) {}

  async transition(input: FreshStartTransitionRequest): Promise<FreshStartState> {
    // Snapshot every caller-owned field before yielding, including opaque bytes.
    const request = decodeFreshStartTransitionRequest(input);
    this.repository.transact(request.identity, tx => checkedState(tx, request));
    const requestDigest = freshStartRequestDigest(request);
    // No transaction spans external verification. Every explicit operator transition
    // requires both proofs; availability reduction without proofs uses stop().
    const verifiedEvidence = requireVerifiedFreshStartEvidence(await this.evidence.verify(request.nextRelease));
    if (!sameRelease(verifiedEvidence.release, request.nextRelease)) throw new FreshStartError("FRESH_START_EVIDENCE_BINDING_MISMATCH");
    const approval = requireVerifiedOperatorApproval(await this.approvals.verify(request.approvalEnvelope, requestDigest));
    if (!sameIdentity(approval.identity, request.identity) || approval.requestDigest !== requestDigest
      || approval.evidenceDigest !== request.nextRelease.evidenceDigest) throw new FreshStartError("FRESH_START_APPROVAL_BINDING_MISMATCH");
    return this.repository.transact(request.identity, tx => {
      const state = checkedState(tx, request);
      if (!tx.release(request.nextRelease.releaseId)) tx.insertRelease(request.nextRelease);
      const fence = request.nextMode === "read-only-recovery" || request.nextMode === "disabled"
        ? tx.captureRecoveryFence(state.generation) : null;
      return tx.transition({ expectedMode: state.mode, expectedGeneration: state.generation,
        expectedReleaseId: state.releaseId, nextMode: request.nextMode, nextReleaseId: request.nextRelease.releaseId,
        transitionId: randomUUID(), authorization: { kind: "operator", approvalId: approval.approvalId,
          nonceDigest: approval.nonceDigest, actorFingerprint: approval.actorFingerprint, requestDigest },
        evidenceDigest: request.nextRelease.evidenceDigest,
        recoveryPosition: fence?.eventPosition ?? state.recoveryPosition,
        recoveryHash: fence?.eventHash ?? state.recoveryHash, recordedAt: new Date().toISOString() });
    });
  }

  stop(input: FreshStartAutomaticStop): FreshStartState {
    const request = decodeFreshStartAutomaticStop(input);
    return this.repository.transact(request.identity, tx => {
      const state = tx.state();
      if (!state) throw new FreshStartError("FRESH_START_NOT_INITIALIZED");
      if (state.generation !== request.expectedGeneration) throw new FreshStartError("FRESH_START_STALE_STATE");
      edge(state.mode, request.target);
      const release = tx.release(state.releaseId);
      if (!release) throw new FreshStartError("FRESH_START_RELEASE_MISMATCH");
      const fence = tx.captureRecoveryFence(state.generation);
      return tx.transition({ expectedMode: state.mode, expectedGeneration: state.generation,
        expectedReleaseId: state.releaseId, nextMode: request.target, nextReleaseId: state.releaseId,
        transitionId: randomUUID(), authorization: { kind: "automatic-stop", reasonCode: request.reasonCode },
        evidenceDigest: release.evidenceDigest,
        recoveryPosition: fence.eventPosition, recoveryHash: fence.eventHash, recordedAt: new Date().toISOString() });
    });
  }
}
