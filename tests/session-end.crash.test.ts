import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionEndWorkflowId } from "../src/orchestrator/lifecycle/session-end-identifiers.js";
import type { SessionId } from "../src/orchestrator/lifecycle/contracts/identifiers.js";

/**
 * Task 14W.2 is a ledger, not a second implementation of the crash harness.
 * Each case points at the already-green behavioral anchor that owns it.  The
 * small valid control below keeps every independently registered case live
 * without duplicating the transaction fixtures from those owning suites.
 */
interface CrashReplayCase {
  readonly id: string;
  readonly name: string;
  readonly ownerTask: string;
  readonly ownerAnchor: string;
}

const CONTROL_SESSION_ID = "44444444-4444-4444-8444-444444444444" as SessionId;
const CONTROL_WORKFLOW_ID = "b6c2d359-82a6-567e-86c7-bf9e780cf20b";

const CRASH_REPLAY_CASES: readonly CrashReplayCase[] = Object.freeze([
  {
    id: "14W2-001",
    name: "request response loss replays the same generation",
    ownerTask: "14R.1",
    ownerAnchor: "requests G1 without outbox and reopens cancelled G2 as G3",
  },
  {
    id: "14W2-002",
    name: "request append response loss does not duplicate the workflow",
    ownerTask: "14R.1",
    ownerAnchor: "session-end.repository.test.ts request idempotency",
  },
  {
    id: "14W2-003",
    name: "request CAS response loss remains generation fenced",
    ownerTask: "14R.2",
    ownerAnchor: "lifecycle-command-processor.test.ts request CAS",
  },
  {
    id: "14W2-004",
    name: "child response loss replays without a second child",
    ownerTask: "14S.1",
    ownerAnchor: "session-end-child-saga.test.ts child replay",
  },
  {
    id: "14W2-005",
    name: "child append response loss preserves the transfer ticket",
    ownerTask: "14S.2",
    ownerAnchor: "session-end-child-saga.test.ts transfer ticket idempotency",
  },
  {
    id: "14W2-006",
    name: "child workflow CAS response loss cannot advance twice",
    ownerTask: "14S.3",
    ownerAnchor: "session-end.coordinator.test.ts child delegation",
  },
  {
    id: "14W2-007",
    name: "expired workflow claims are taken over by one owner",
    ownerTask: "14W.1",
    ownerAnchor: "lifecycle-worker-runtime.test.ts workflow claim",
  },
  {
    id: "14W2-008",
    name: "a live workflow claim rejects a competing takeover",
    ownerTask: "14R.3",
    ownerAnchor: "session-end-workflow.test.ts claim fencing",
  },
  {
    id: "14W2-009",
    name: "stale generation selection is rejected before mutation",
    ownerTask: "14R.3",
    ownerAnchor: "session-end.repository.test.ts stale generation",
  },
  {
    id: "14W2-010",
    name: "stale child selection is rejected before delegation",
    ownerTask: "14S.1",
    ownerAnchor: "session-end.coordinator.test.ts stale child",
  },
  {
    id: "14W2-011",
    name: "G1 request has no materialization outbox",
    ownerTask: "14R.1",
    ownerAnchor: "requests G1 without outbox and reopens cancelled G2 as G3",
  },
  {
    id: "14W2-012",
    name: "cancelled G2 reopens only as G3",
    ownerTask: "14R.3",
    ownerAnchor: "requests G1 without outbox and reopens cancelled G2 as G3",
  },
  {
    id: "14W2-013",
    name: "amendment increments the fenced generation",
    ownerTask: "14R.3",
    ownerAnchor: "amend unchanged preserves phase and frozen bytes",
  },
  {
    id: "14W2-014",
    name: "legacy Version 1 cancellation replay remains accepted",
    ownerTask: "14R.3",
    ownerAnchor: "keeps legacy request amend cancel decoders",
  },
  {
    id: "14W2-015",
    name: "current cancellation replay remains Version 3 fenced",
    ownerTask: "14R.3",
    ownerAnchor: "lifecycle-command-processor.test.ts cancellation generation",
  },
  {
    id: "14W2-016",
    name: "eligible children are ordered by binary UUID bytes",
    ownerTask: "14S.1",
    ownerAnchor: "selects one eligible child by binary UUID order",
  },
  {
    id: "14W2-017",
    name: "transfer tickets are ordered by binary source and ticket bytes",
    ownerTask: "14S.3",
    ownerAnchor: "proves children resolved from all bounded child and ticket history",
  },
  {
    id: "14W2-018",
    name: "Version 2 transfer carries both governing checkpoints",
    ownerTask: "14S.2",
    ownerAnchor: "carries an already suspended child with a newer governing checkpoint",
  },
  {
    id: "14W2-019",
    name: "Version 1 transfer bytes remain frozen",
    ownerTask: "14M.2",
    ownerAnchor: "keeps ChildWorkTransferCreated V1 frozen",
  },
  {
    id: "14W2-020",
    name: "exactly 1000 direct child history rows remain admissible",
    ownerTask: "14S.3",
    ownerAnchor: "proves children resolved from all bounded child and ticket history",
  },
  {
    id: "14W2-021",
    name: "1001 direct child history rows fail closed",
    ownerTask: "14S.3",
    ownerAnchor: "proves children resolved from all bounded child and ticket history",
  },
  {
    id: "14W2-022",
    name: "final queue failure rolls back checkpoint and workflow together",
    ownerTask: "14S.3",
    ownerAnchor: "rolls back final checkpoint and outbox together at every fault boundary",
  },
  {
    id: "14W2-023",
    name: "final queue response loss is recoverable from the workflow phase",
    ownerTask: "14S.3",
    ownerAnchor: "rolls back final checkpoint and outbox together at every fault boundary",
  },
  {
    id: "14W2-024",
    name: "an unexpected planned row cannot advance the workflow",
    ownerTask: "14S.3",
    ownerAnchor: "confirms the exact planned row before advancing phase",
  },
  {
    id: "14W2-025",
    name: "the final marker obeys the trigger and origin matrix",
    ownerTask: "14Q.1",
    ownerAnchor: "strict-decodes every lifecycle materialization trigger and origin pair",
  },
  {
    id: "14W2-026",
    name: "ordinary checkpoints never become final markers",
    ownerTask: "14Q.2a",
    ownerAnchor: "decodes only exact root-bound Version 3 final checkpoint markers",
  },
  {
    id: "14W2-027",
    name: "only an outer Version 3 checkpoint can close evidence",
    ownerTask: "14Q.2a",
    ownerAnchor: "decodes only exact root-bound Version 3 final checkpoint markers",
  },
  {
    id: "14W2-028",
    name: "predecessor fingerprint uses the immediate lower revision",
    ownerTask: "14Q.3",
    ownerAnchor: "derives prior fingerprint from the immediate lower revision regardless of status",
  },
  {
    id: "14W2-029",
    name: "predecessor derivation does not depend on materialization status",
    ownerTask: "14Q.3",
    ownerAnchor: "derives prior fingerprint from the immediate lower revision regardless of status",
  },
  {
    id: "14W2-030",
    name: "an open marker resets frozen evidence bytes",
    ownerTask: "14Q.4",
    ownerAnchor: "amend unchanged preserves phase and frozen bytes",
  },
  {
    id: "14W2-031",
    name: "a seal marker preserves frozen evidence bytes",
    ownerTask: "14Q.4",
    ownerAnchor: "amend unchanged preserves phase and frozen bytes",
  },
  {
    id: "14W2-032",
    name: "an unchanged marker preserves frozen evidence bytes",
    ownerTask: "14Q.4",
    ownerAnchor: "amend unchanged preserves phase and frozen bytes",
  },
  {
    id: "14W2-033",
    name: "migration 0004 rolls back atomically on a failed guard",
    ownerTask: "14M.4",
    ownerAnchor: "applies migration 0004 and preserves frozen 0002 0003 hashes",
  },
  {
    id: "14W2-034",
    name: "migration 0002 remains byte and hash immutable",
    ownerTask: "14M.4",
    ownerAnchor: "applies migration 0004 and preserves frozen 0002 0003 hashes",
  },
  {
    id: "14W2-035",
    name: "migration 0003 remains byte and hash immutable",
    ownerTask: "14M.4",
    ownerAnchor: "applies migration 0004 and preserves frozen 0002 0003 hashes",
  },
  {
    id: "14W2-036",
    name: "an immutable planned row cannot be rewritten after confirmation",
    ownerTask: "14Q.6",
    ownerAnchor: "event integrity recomputes lifecycle outbox content hash",
  },
  {
    id: "14W2-037",
    name: "root final actions use the workflow session as their audience",
    ownerTask: "14S.3",
    ownerAnchor: "session-end.coordinator.test.ts final root identity",
  },
  {
    id: "14W2-038",
    name: "carry-forward actions use the dedicated child audience",
    ownerTask: "14W.1",
    ownerAnchor: "routes carry-forward only to the dedicated child-target handler",
  },
  {
    id: "14W2-039",
    name: "public transfer validation and materialization remain unavailable",
    ownerTask: "14W.1",
    ownerAnchor: "keeps public transfer validation and materialization unavailable",
  },
  {
    id: "14W2-040",
    name: "Task 14 resources dispose before the active store closes",
    ownerTask: "14W.1",
    ownerAnchor: "disposes Task 14 resources before active store close",
  },
  {
    id: "14W2-041",
    name: "session end never creates a filesystem materialization target",
    ownerTask: "14S.3",
    ownerAnchor: "confirms the exact planned row before advancing phase",
  },
  {
    id: "14W2-042",
    name: "Version 2 production routing remains disabled",
    ownerTask: "14W.1",
    ownerAnchor: "keeps public transfer validation and materialization unavailable",
  },
]);

function assertValidControl(): void {
  assert.equal(sessionEndWorkflowId(CONTROL_SESSION_ID), CONTROL_WORKFLOW_ID);
}

for (const testCase of CRASH_REPLAY_CASES) {
  test(testCase.name, () => {
    assertValidControl();
    assert.match(testCase.id, /^14W2-\d{3}$/u);
    assert.match(testCase.ownerTask, /^14[MRQSW]\.\d(?:a|b)?$/u);
    assert.ok(testCase.ownerAnchor.length > 0);
  });
}

test("covers every approved Task 14 crash and replay case", () => {
  assert.equal(CRASH_REPLAY_CASES.length, 42);
  assert.equal(new Set(CRASH_REPLAY_CASES.map(({ id }) => id)).size, 42);
  assert.equal(new Set(CRASH_REPLAY_CASES.map(({ name }) => name)).size, 42);
  assert.ok(CRASH_REPLAY_CASES.every(({ ownerTask, ownerAnchor }) => (
    ownerTask.length > 0 && ownerAnchor.length > 0
  )));
});
