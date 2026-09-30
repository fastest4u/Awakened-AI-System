# V2 fresh-start delivery roadmap

**Authority:** User-approved [fresh-start production design](../specs/2026-09-29-v2-fresh-start-production-design.md), approved 2026-09-29 after commit `96bc4ea`.
**Current status:** Foundation complete, production implementation incomplete. F1 Tasks1-6 and independent reviews are accepted, including the five-fixture correction `bd35929`. The frozen full increment on `1d41c51` ended native 0 on 2026-09-30: 3,187 tests, 3,171 passed, zero failures/cancellations and 16 skips; source/config and 794 emitted test inputs remained unchanged. The first F2 preparation plan is approved, not actual-host or production proof. F2-F4 remain and no fresh-start deployment has been performed.
**Execution preference:** Preserve the user's Subagent-Driven selection. Each executable plan still receives the review required by Superpowers; do not ask the user to choose the method again.

## Delivery map

The approved design spans independent subsystems. Keep one executable plan per subsystem, with a working testable result at each boundary. The F1 plan is complete; later rows identify remaining delivery work, not completed or silently waived requirements.

| Increment | Deliverable and relevant files | Acceptance evidence | Dependency / status |
| --- | --- | --- | --- |
| F1: Fresh-start foundation | Schema 8 profile storage; fresh/resume initialization; activation state machine; transaction admission; separate dormant `dist/v2.js` and `dist/v2-admin.js`. New `src/orchestrator/fresh-start/` and `src/v2/`; narrow changes to append, worker, schema registry, and build seams. | Prepared stores deny public content; no reset or V1 access; authenticated state transitions; concurrent recovery fence blocks stale appends; compiled entry points and schema upgrades work. | [Six-task executable plan](2026-09-29-v2-fresh-start-foundation.md) complete; [native evidence](../evidence/2026-09-29-v2-fresh-start-foundation.md) includes full regression native 0. Production promotion remains unavailable. |
| F2: Public memory and privacy | V2 schemas/controllers; trusted transport adapter; `src/orchestrator/privacy/`; governed write commands; encrypted evidence and erasure persistence; existing lifecycle/projection/retrieval composition. | Complete session/checkpoint/end and note-style workflows; idempotent restart; scope rejection; secret redaction; authenticated encryption and key recovery; governance/expiry/erasure; actual target client evidence-capture proof. | F1 interfaces are delivered. First host-probe preparation plan is approved for independent synthetic verifier and honest read-only qualification, pending canonical publication. It is not all F2 or actual-host capture proof. Public-memory/privacy implementation and production activation remain incomplete. |
| F3: Recovery and release evidence | `src/orchestrator/recovery/`; backup scheduler; verified restore/replay; erasure restoration; software compatibility checks; fresh-start release verifier; `scripts/run-v2-fresh-start-release.js`; focused CI gate. | Compiled public-service tests on isolated stores, acknowledged-write preservation, restore of all required artifacts/keys, corruption refusal, measured recovery time and storage-loss exposure, final frozen-build checks. | Requires F2's actual content/evidence contracts. Must not implement backup as event-file-only copying. |
| F4: Client cutover and live verification | Operator runbook, approved target bindings/configuration, V1 writer stop/archive/denied-write proof, V2 client registration, real workflow verification and backup/status evidence. | Approved exact release and deployment bindings; V1 archive protected; real V2 session writes and later retrieval succeed; recovery/backup status is healthy. | Requires F3 green report plus explicit activation approval. No current command has been run against PROD. |

F2-F4 are implementation dependencies, not a new request for the user to repeat the approved fresh-start decision. Write their detailed plans from the delivered interfaces instead of inventing integration APIs before those interfaces exist. Any actual change to approved behavior must be called out separately.

## Requirements coverage

| Approved spec section | Owning increment |
| --- | --- |
| 1-3: desired outcome and existing boundary | All; F1 preserves boundary, F4 verifies user outcome |
| 4: empty store and archive separation | F1 initialization and path checks; F4 actual archive protection |
| 5: complete public workflow | F1 separate entry points; F2 all required content adapters and capability inventory |
| 6: independent activation and mutation fencing | F1 durable state/guard; F3 actual release-evidence verifier; F4 approval |
| 7: privacy and governance | F2; F3 checks erasure after restore |
| 8: V2-only recovery | F3; F4 operator procedure |
| 9: verification and truthful status | Focused checks per increment; F3 final checks; F4 live proof |
| 10: scope and historical work | This roadmap and the separate legacy lane below |

## Explicit prerequisite: full visible-evidence capture

The still-applicable umbrella design sections 9.2-9.3 require encrypted evidence and set `requireFullEvidence=true` before primary cutover. Current lifecycle coverage support is not itself a production host adapter. F2 must establish which real target-client integration delivers visible frames, persists send identities before transmission, reports missing ordinals, and keeps private credentials outside model-visible content.

Use a supported, authorized integration for that host; do not fabricate a Codex callback or read hidden reasoning. Fixture-generated frames alone cannot prove the real integration exists. If the target host cannot supply complete visible evidence, record that concrete limitation and seek a scoped policy decision then; do not silently lower the setting or label tool-only capture complete. This dependency does not block implementation of F1.

## Legacy migration lane

- Schema 7 registration at `9aa3a46` remains completed historical work.
- Task 13B has uncommitted CI/package/runtime-test changes and an interrupted migration gate without completion evidence. Preserve and review it independently; it is not newly marked complete.
- Slice 2 Task 14 live-V1 migration rehearsal is **outside the selected fresh-start release scope**, not passed. A Markdown vault is not an authenticated SQLite migration source.
- Existing migration code and applicable regression checks stay in the repository. Profile-specific release evidence does not erase general regression obligations.
- The dirty parent Slice 2 plan is deliberately not rewritten or staged by this planning change. This roadmap states the current selected release scope without absorbing that pending diff.

## Verification budget and status reporting

Run task-focused tests while implementing. Run the relevant increment gate after review, and the applicable complete release checks once for the frozen final candidate. Reuse valid evidence; repeat it only when its inputs changed or a failure/risk invalidates it. Never disguise a required unfinished check as passed, and never restart the old live-V1 migration rehearsal as a fresh-start prerequisite.

F1 completion means **foundation complete, production implementation incomplete**. F2/F3 completion plus a green exact-release report means **ready for activation**. Only F4 can establish **active pending live verification** and then **live operation verified for the declared capabilities**. No percentage of readiness or promised finishing time is inferred from task count.
