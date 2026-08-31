# Child Transfer Claim Fixture Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore truthful coverage for the child-transfer claim pre-read protocol so the three stale storage tests no longer contradict the production concurrency fence.

**Architecture:** `ChildTransferRepository.claim` now reads the ticket before the conditional update, rejecting a missing, changed, or already claimed record before it writes. The production implementation is correct and must remain unchanged. Update only its `RecordingConnection` fixtures so they model the unclaimed pre-read followed by the claimed post-write read, and so the losing-write test permits the pre-read before returning `changes: 0`.

**Tech Stack:** TypeScript, Node test runner, SQLite repository test doubles.

**Spec:** `.superpowers/sdd/2026-08-24-subproject-3-final-review-remediation/task-8-report.md` (the five production-readiness blockers) and the root-cause reproduction recorded in the active session.

## Global Constraints

- Keep `ChildTransferRepository.claim`'s pre-read and conditional null-group CAS unchanged.
- Do not change V2 routing, production deployment configuration, or external interfaces.
- Use canonical four-digit timestamp fixtures and exact SQL assertions.
- Build `dist-test` with Node 24.16 before executing compiled tests.

---

### Task 1: Model the two-read claim protocol in storage fixtures

**Files:**
- Modify: `tests/lifecycle-storage.repositories.test.ts:313-412`

**Interfaces:**
- Consumes: `ChildTransferRepository.claim(connection, ChildTransferClaim)`, which first calls `get`, performs one conditional `UPDATE`, then calls `get` again.
- Produces: fixture evidence that a valid unclaimed ticket can be claimed, a zero-row conditional write becomes `EVENT_CONFLICT`, and the maximum canonical timestamp is serialized on a real claim path.

- [ ] **Step 1: Update the three existing fixtures to express the desired protocol**

  In the successful claim fixture, return `unclaimedTicketRow()` for the first `get` and `claimedTicketRow()` for the second. In the losing-write fixture, allow a first `get` returning `unclaimedTicketRow()` before the zero-row `UPDATE`. In the timestamp fixture, return an unclaimed row for the first `get` and a claimed row carrying `MAX_CANONICAL_TIMESTAMP` for the second.

  Add a call counter where needed, for example:

  ```ts
  let reads = 0;
  if (kind === "get" && /FROM child_transfer_tickets/iu.test(sql)) {
    reads += 1;
    return reads === 1 ? unclaimedTicketRow() : claimedTicketRow();
  }
  ```

- [ ] **Step 2: Run the three compiled tests to verify the current stale fixtures fail**

  Run:

  ```text
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="inserts canonical ticket evidence|returns EVENT_CONFLICT to every loser|keeps insert and claim timestamps" dist-test/tests/lifecycle-storage.repositories.test.js
  ```

  Expected before the fixture change: all three fail through either early `EVENT_CONFLICT` or an unexpected pre-read `SELECT`.

- [ ] **Step 3: Apply only the fixture-response changes from Step 1**

  Keep the existing assertions that claim SQL sets only the nullable claim group and preserves source lineage. Do not remove the `created_event_position` or all-four-null guards.

- [ ] **Step 4: Rebuild and verify the three tests are green**

  Run:

  ```text
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="inserts canonical ticket evidence|returns EVENT_CONFLICT to every loser|keeps insert and claim timestamps" dist-test/tests/lifecycle-storage.repositories.test.js
  ```

  Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit the fixture-only repair**

  Run:

  ```text
  git add -- tests/lifecycle-storage.repositories.test.ts
  git commit -m "test: align child transfer claim fixtures with pre-read"
  ```

## Plan self-review

- Spec coverage: the three immutable-child-transfer baseline failures each map to Task 1.
- Placeholder scan: no TBD/TODO work remains; every command and fixture transition is explicit.
- Type consistency: both fixture row helpers already return `SqliteRow`; no production method signature changes.

