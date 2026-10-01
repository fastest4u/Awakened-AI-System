export const READ_UUID = "11111111-1111-4111-8111-111111111111";
export const READ_HASH = "a".repeat(64);
export function readScope() {
  return { projectId: READ_UUID, vaultId: READ_UUID, storeId: READ_UUID, workspaceId: READ_HASH,
    branchScopeId: null, branchRef: null, sessionId: null };
}
export function readRequest() {
  return { operation: "verify-published-view", consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000 };
}
export function readReceipt() {
  return { operation: "verify-published-view", consistency: "project-strong", scope: readScope(),
    releaseId: READ_UUID, controlGeneration: "0", requiredEventPosition: "0", projectionGeneration: 1,
    projectionEventPosition: "0", projectionEventHash: READ_HASH, imageSha256: READ_HASH,
    verification: "image-scope-position-and-active-admission" };
}
export function readBootstrap() {
  const directory = () => ({ canonicalPath: "C:/owned", device: "1", inode: "2" });
  return { version: 1, ids: { requestId: "request", attemptId: "attempt", laneEpoch: "epoch" },
    binding: { projectionBinding: readScope(), expectedRelease: { projectId: READ_UUID, vaultId: READ_UUID,
      storeId: READ_UUID, profileVersion: 1, releaseId: READ_UUID, buildIdentityHash: READ_HASH,
      schemaIdentityHash: READ_HASH, configurationHash: READ_HASH, capabilityManifestHash: READ_HASH,
      recoveryPolicyHash: READ_HASH, evidenceDigest: READ_HASH, createdAt: "2026-10-01T00:00:00.000Z" },
      controlGeneration: "0", session: null, eventsFile: { path: "C:/owned/events.sqlite", device: "1", inode: "2" },
      projectionDirectory: directory(), executorStateDirectory: directory(), deploymentDirectory: directory(), compositionEpoch: "epoch" },
    request: readRequest(), lockToken: "a".repeat(32), remainingMs: 5000 };
}
