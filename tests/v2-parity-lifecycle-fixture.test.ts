import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalMkdtemp } from "./support/canonical-temp.js";
import { LifecycleFixtureClient, type LifecycleFixtureJsonValue } from "./support/lifecycle-fixture-client.js";
import { LifecycleTestKeyBroker } from "./support/lifecycle-test-key-broker.js";
import { decodeCheckpointDraft } from "../src/orchestrator/lifecycle/contracts/checkpoint.js";

test("parity lifecycle fixture preserves defaults and permits only validated checkpoint content and positions", async t => {
  const root = canonicalMkdtemp("parity-lifecycle-");
  const projectRoot = join(root, "project"), vaultRoot = join(projectRoot, "memory");
  mkdirSync(projectRoot); mkdirSync(vaultRoot);
  const client = new LifecycleFixtureClient({ fixturePath: fileURLToPath(new URL("./fixtures/project-store-lifecycle-child.js", import.meta.url)),
    timeoutMs: 15000, cleanupTimeoutMs: 15000, keyBroker: new LifecycleTestKeyBroker() });
  t.after(async () => { try { await client.dispose(); } finally { rmSync(root, { recursive: true, force: true }); } });
  await client.ready();
  const started = await client.start({ projectRoot, vaultRoot, clientInstanceId: "parity-lifecycle", useParentKeyBroker: true });
  assert.equal(started.type, "started", JSON.stringify(started));
  const eventsPath = (started.payload as Record<string, unknown>).eventsPath;
  assert.equal(typeof eventsPath, "string");
  assert.equal((await client.mutation({ operation: "root-start", continuityKey: "parity-root", idempotencyKey: "parity-start" })).type, "result");
  assert.equal((await client.mutation({ operation: "record-root-checkpoint" })).type, "result");
  const read = () => {
    const db = new DatabaseSync(eventsPath as string, { readOnly: true });
    try { return db.prepare("SELECT event_type, payload_json FROM events ORDER BY global_position").all(); } finally { db.close(); }
  };
  const initial = read();
  assert.equal(initial.length, 2);
  const first = JSON.parse(String(initial[1]!.payload_json)).checkpoint;
  assert.equal(first.taskSummary, "Task 18 root checkpoint before a process session-end request");
  assert.equal(first.checkpointVersion, 2);
  assert.deepEqual(first.artifactReferences, []);
  const draft = decodeCheckpointDraft({ checkpointVersion: 1, taskSummary: "Parity history checkpoint", completedItems: [], inProgressItems: [],
    blockers: [], nextActions: [], decisions: [], assumptions: [], unresolvedConflicts: [], filesTouched: [],
    artifactReferences: [{ artifactId: "70000000-0000-4000-8000-000000000701", path: "src/parity.ts", summary: "Metadata sentinel",
      contentHash: "a".repeat(64), confidence: "high" }], sourceReferences: [], commandResults: [], testResults: [], materialClaims: [] });
  for (const overrides of [{ expectedStreamVersion: "02" }, { expectedBaseEventPosition: -1 }, { draft: { ...draft, unexpected: true } },
    { authority: "forged" }, { sessionId: first.sessionId }, { agentId: "forged" }, { context: {} }, { extra: true }]) {
    assert.equal((await client.mutation(JSON.parse(JSON.stringify({ operation: "record-root-checkpoint", ...overrides })) as LifecycleFixtureJsonValue)).type, "error");
    assert.equal(read().length, 2);
  }
  assert.equal((await client.mutation(JSON.parse(JSON.stringify({ operation: "record-root-checkpoint", expectedStreamVersion: "2", expectedBaseEventPosition: "2", draft })) as LifecycleFixtureJsonValue)).type, "result");
  const events = read();
  assert.equal(events.length, 3);
  const second = JSON.parse(String(events[2]!.payload_json)).checkpoint;
  assert.equal(second.checkpointVersion, 1);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.creatorAgentId, first.creatorAgentId);
  assert.equal(second.taskSummary, draft.taskSummary);
  assert.deepEqual(second.artifactReferences, draft.artifactReferences);
  assert.notEqual(second.checkpointId, first.checkpointId);
});
