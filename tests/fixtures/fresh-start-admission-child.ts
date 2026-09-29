import type { AppendCommand, JsonValue } from "../../src/orchestrator/contracts/event.js";
import type { ProjectContext, WorkspaceId } from "../../src/orchestrator/identity/contracts.js";
import { computeProjectContextFingerprint } from "../../src/orchestrator/identity/project-binding.service.js";
import { FRESH_IDENTITY, FRESH_NOW } from "../support/fresh-start-fixture.js";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { NodeSqliteDriver } from "../../src/orchestrator/storage/node-sqlite-driver.js";
import { bindFreshStartAdmissionContext, FreshStartAdmissionGuard } from "../../src/orchestrator/fresh-start/fresh-start-admission.js";
import { EventStore, SqliteEventStoreStatements } from "../../src/orchestrator/storage/event-store.js";
import { EventAppendTransaction } from "../../src/orchestrator/storage/event-append-transaction.js";
import { MaintenanceFence } from "../../src/orchestrator/storage/maintenance-fence.js";
import { BranchScopeRepository } from "../../src/orchestrator/storage/branch-scope.repository.js";
import { SqliteFreshStartRepository } from "../../src/orchestrator/fresh-start/fresh-start.repository.js";
import { FreshStartControlPlane } from "../../src/orchestrator/fresh-start/fresh-start-control-plane.js";
import { DENY_FRESH_START_PROMOTION } from "../../src/orchestrator/fresh-start/operator-approval.js";
import { LifecycleCommandStore, type LifecycleCommandEnvelope } from "../../src/orchestrator/lifecycle/lifecycle-command.store.js";
import type { RootStartCommandV2 } from "../../src/orchestrator/lifecycle/contracts/commands.js";
import { buildLifecycleIntentWitness } from "../../src/orchestrator/lifecycle/lifecycle-intent-witness.js";

export function lifecycleEnvelope(): LifecycleCommandEnvelope {
  const basic = command();
  const semanticCommand: RootStartCommandV2 = { commandType: "root-start", commandId: basic.commandId,
    idempotencyKey: basic.idempotencyKey, agentId: basic.agentId, expectedProjectId: FRESH_IDENTITY.projectId,
    expectedVaultId: FRESH_IDENTITY.vaultId, expectedWorkspaceId: basic.context.binding.workspaceId,
    expectedBranchRef: null, continuityKey: "fixture-root", resumePolicy: "new" };
  const intent = buildLifecycleIntentWitness(semanticCommand, { authorizationKind: "initial-authority", authorizationSessionId: null,
    targetSessionId: basic.commandId, ...FRESH_IDENTITY, workspaceId: basic.context.binding.workspaceId,
    clientNamespace: "fixture", capabilityKind: null, capabilityGeneration: null,
    presentingActorRole: "primary", presentingClientInstanceId: "fixture-client", targetActorRole: "primary", targetClientInstanceId: "fixture-client",
    internalWorkflowId: null, internalWorkflowGeneration: null, internalPlannedWorkId: null });
  return { context: basic.context, commandId: basic.commandId, idempotencyKey: basic.idempotencyKey,
    commandType: "root-start", candidateIntentHash: intent.intentHash, authoritativeIntentHash: intent.intentHash,
    semanticCommand, capabilityKind: null, capabilityGeneration: null,
    replayExpectation: { kind: "initial-authority",
      presenting: { actorRole: "primary", clientInstanceId: "fixture-client" }, target: { actorRole: "primary", clientInstanceId: "fixture-client" } } };
}

if (process.send && process.argv[2]) {
  const [path, mode, gate] = process.argv.slice(2) as [string, string, string];
  const connection = new NodeSqliteDriver({ DatabaseSync }).open(path, { mode: "existing", busyTimeoutMs: 10000 });
  const trusted = { identity: FRESH_IDENTITY, releaseId: "44444444-4444-4444-8444-444444444444", measuredBuildHash: "a".repeat(64), generation: 1n };
  bindFreshStartAdmissionContext(connection, trusted);
  const finish = (value: unknown) => { connection.close(); process.send?.(value, () => process.disconnect()); };
  const perform = () => {
    try {
      if (mode === "stop") {
        const control = new FreshStartControlPlane(new SqliteFreshStartRepository(connection), DENY_FRESH_START_PROMOTION, DENY_FRESH_START_PROMOTION);
        const stopped = control.stop({ identity: FRESH_IDENTITY, expectedGeneration: 1n, target: "read-only-recovery", reasonCode: "integrity-failure" });
        finish({ type: "result", position: stopped.recoveryPosition?.toString(), hash: stopped.recoveryHash }); return;
      }
      const maintenance = new MaintenanceFence();
      const statements = new SqliteEventStoreStatements(connection);
      if (mode === "stale-lifecycle") {
        const store = new LifecycleCommandStore({ connection, events: new EventAppendTransaction(connection, statements, maintenance, new BranchScopeRepository()),
          projectionWriter: { append: () => undefined }, transaction: () => { throw new Error("authority transaction must not be reached"); } });
        store.execute(lifecycleEnvelope(), () => { throw new Error("authority callback must not be reached"); });
      } else {
        const store = new EventStore(connection, statements, maintenance, new BranchScopeRepository(), () => FRESH_NOW, undefined, {
          hit(boundary) {
            if (mode !== "writer" || boundary !== "after-first-insert-before-commit") return;
            process.send?.({ type: "writer-held" });
            const until = Date.now() + 10000;
            while (!existsSync(gate)) { if (Date.now() > until) throw new Error("writer gate timeout"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
          },
        });
        const result = store.append(command());
        finish({ type: "result", position: result.lastGlobalPosition.toString(), eventIds: result.eventIds }); return;
      }
      finish({ type: "result" });
    } catch (error) { finish({ type: "error", code: (error as { code?: string }).code ?? "UNTYPED_ERROR" }); }
  };
  if (mode === "stop") { process.send({ type: "ready" }); perform(); }
  else {
    new FreshStartAdmissionGuard(connection).assertRequestAllowed({ ...trusted, operation: "semantic-mutation" });
    process.send({ type: "admitted" });
    process.once("message", perform);
  }
}

export function context(root = "C:/fixture", path = `${root}/events.sqlite`): ProjectContext {
  const workspace = { kind: "non-git" as const, workspaceRoot: root, workspaceId: "1".repeat(64) as WorkspaceId };
  const result: ProjectContext = { workspace, checkedAt: FRESH_NOW, binding: {
    ...FRESH_IDENTITY, projectBindingId: "fixture-binding", generation: 1, contextFingerprint: "fixture-fingerprint",
    source: "explicit-cli", workspaceId: workspace.workspaceId, clientNamespace: "fixture", clientInstanceId: "fixture-client",
    actorRole: "primary", projectRoot: root, vaultRoot: root, descriptorPath: `${root}/descriptor.json`,
    storeRoute: { kind: "vault-local", storeRoot: root, eventsPath: path, storeManifestPath: `${root}/store.json`, projectionManifestPath: `${root}/projection.json` },
    workspace, establishedAt: FRESH_NOW,
  } };
  result.binding.contextFingerprint = computeProjectContextFingerprint(result.binding);
  return result;
}
export function command(): AppendCommand<JsonValue> {
  return { context: context(), commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", idempotencyKey: "fresh:one",
    commandType: "RecordOne", correlationId: "correlation", agentId: "fixture-agent", expectedStreamVersion: 0n,
    streamId: "stream-one", streamType: "test", events: [{ eventType: "OneRecorded", eventSchemaVersion: 1,
      occurredAt: FRESH_NOW, visibilityScope: "project", confidence: "high", verificationStatus: "verified",
      payload: { one: 1 }, sourceRefs: [], evidenceRefs: [], evidenceDigests: [] }], outbox: [], publicResponse: { accepted: true } };
}
