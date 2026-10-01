# V2 verified-read Task 5: conservative restart amendment

Status: **Written amendment approved by the user on 2026-10-01.** The user replied `อนุมัติ` to the explicit written-review request for this artifact at `e6e1f67`, after earlier approving the approach “ห้ามเริ่มจนลบเสร็จจริง”. The original [verified-read design](2026-10-01-v2-internal-verified-read-design.md) and [implementation plan](../plans/2026-10-01-v2-internal-verified-read.md) now reflect this contract; the amended Task 5 plan steps await review before implementation resumes. Historical Tasks 1–4 acceptance remains unchanged. This is not Task 5 acceptance or production activation.

## 1. Outcome and reason

Prevent an old read owner from deleting a replacement owner's intent during cooperative completion. The pending Task 5 implementation marks `verified-read-owner.json` as `complete`, then removes that pathname asynchronously. If another repository automatically reclaims that `complete` record first, it can install a new intent while the old removal is still pending. The old removal can then delete the new intent.

Change the restart rule, not the resource or process architecture: **an existing record never authorizes automatic replacement, including a record whose state is `complete`.** A new owner can start only through exclusive creation after the old ownership record has actually been removed.

This deliberately trades automatic crash reopening for conservative refusal. A crashed owner may leave a `complete` record after closing resources but before removing the record. Such a record blocks restart until a separately trusted reconciliation proves it safe. This increment does not implement that reconciliation or require a manual broad deletion.

## 2. Binding ownership contract

1. Keep the existing single filename `verified-read-owner.json`, 8 KiB bound, four states `launch-intent | child-observed | complete | incomplete`, identities and repository method signatures. No second persistent claim, process pool, new public API or schema migration is introduced.
2. `begin(intent)` must refuse if any ownership record already exists, regardless of its state. Invalid, foreign or uncertain existing input also cannot authorize replacement. Inspection followed by blind overwrite or deletion is forbidden. Establish new ownership with exclusive creation; a creation collision refuses rather than reclaiming.
3. `inspect()` may report `complete` for diagnostics. That state proves neither pathname absence nor permission to start. Persisted PIDs and elapsed time remain diagnostic, never kill or reclamation authority.
4. Only the creating owner may finish its own record, with matching binding/build/supervisor/request/attempt/token and existing directory/file provenance checks. `complete(ids)` remains asynchronous: record `complete` only after positive resource proof, then remove only that verified owned record. Do not remove a foreign record, install a replacement after removal, or mark closure complete while record removal or other owned I/O remains uncertain.
5. Treat ownership-record closure as complete only after actual owned removal and disposition of the attempt's owned I/O are known. A failure or unresolved operation retains uncertainty and restart denial; it cannot be hidden by a successful resource-close message. Repeated close/completion remains idempotent and cannot perform a delayed write/removal against a later owner.
6. Normal success still requires positive image/reader/descriptor closure, owned publication-lock release, normal read-child exit and completed ownership-record closure within the original response budget. No new receipt escapes while any proof is missing.
7. After unsuccessful response, retain the original separate 2000 ms cleanup observation window and at most 100 ms grace within it. No stage restarts the window. Late positive closure and actual final record removal can permit a **fresh trusted adapter** to obtain new ownership; the old quarantined adapter stays quarantined and its settled caller outcome never becomes success. Timeout alone never authorizes replacement.

The cooperative guarantee assumes participating repositories obey these rules; it is not protection against an arbitrary hostile filesystem actor. Existing provenance defenses remain required. A `complete` crash-left record is an explicit availability limitation, not a silently successful restart or proof of whole-system recovery.

## 3. Exact amendment to prior requirements

- Replace the design section 8 `Crash/restart` expectation “known complete record permits normal reopen” with “all existing records, including complete, refuse automatic reopening; normal reopening follows positive closure and actual record removal.”
- Replace Task 5 Step 1's “a complete record permits reopen” test with refusal of an existing complete record, and successful exclusive reopening after actual owned removal.
- Clarify design section 6 and Task 5 ownership completion text with the contract in section 2 above. All other approved resource bounds, metadata-only receipt behavior, public denials, deadlines, cleanup rules and accepted Tasks 1–4 remain unchanged.
- After written approval, reconcile the original design/Task 5 brief and plan with these exact replacements before resuming implementation. Do not mark Task 5 or Task 6 complete from this document.

## 4. Focused acceptance evidence

| Case | Required observable result |
| --- | --- |
| Each persisted state, including `complete` | An independent repository refuses `begin`; original bytes/identity remain unchanged |
| Cooperative completion race | Hold owner A's real asynchronous removal after its `complete` publication; owner B refuses to install an intent; release removal; B can then obtain exclusive ownership; no late A operation removes B's record |
| Crash after `complete` publication, before removal | Fresh repository refuses automatic reopening; no PID kill, elapsed-time clearing or invented reconciliation |
| Positive normal closure and actual removal | Fresh owner can begin, while duplicate owners/collisions still refuse |
| Removal/update error or unresolved I/O | Cleanup remains incomplete/unavailable; no successful receipt or replacement launch |
| Duplicate/late completion | Settled caller outcome is unchanged; old quarantined adapter does not resume; a later owner's bytes/identity are preserved |

Use deterministic barriers around the actual ownership I/O seam, real owned filesystem records and the production repository. Do not test merely a fake delayed promise or delete production guards to manufacture RED. Extend the exact Task 5 ownership/supervisor tests first, observe genuine race/refusal RED, then implement the smallest correction and run their final serialized group plus typecheck. Preserve existing native synchronous-hang and independently owned writer checks. Independent spec/quality review is required before Task 5 acceptance; the existing Task 6 compiled gate remains pending. No multi-hour V1 migration replay is a prerequisite for this fresh-start correction.

## 5. Scope and handoff

Keep the selected Subagent-Driven method and existing worktree. Preserve the six unaccepted Task 5 candidate files and existing evidence while the amended Task 5 plan steps await review. Written approval authorizes reconciling the Task 5 plan/brief for its existing review checkpoints before implementation resumes; it does not authorize deployment, live configuration/trust changes, transcript/credential reads, V1 import/fallback, public content enablement, push or hosted CI.

F2 public native memory/privacy and actual Codex desktop integration, F3 recovery of newly acknowledged V2 data plus exact-release evidence, and F4 explicitly approved activation/live verification remain unfinished. This amendment cannot certify PROD-ready, recovered content or actual host capture.

Self-review: approval stages explicit; old/new rule and crash availability cost stated; single-record protocol preserved; actual removal distinguished from `complete` metadata; duplicate/late I/O and foreign ownership protected; deadlines unchanged; no guessed reconciliation or live activation. This is written-contract review, not executable verification.
