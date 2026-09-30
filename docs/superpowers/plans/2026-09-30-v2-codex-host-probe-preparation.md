# V2 Codex Host Probe Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare independently checked synthetic completeness evidence and an honest mechanism-qualification report without pretending that a mock proves the current desktop integration.

**Architecture:** A fixture-only manifest and pure verifier establish exact membership, ordering, scope and correlation checks independently of any observed host stream. Read-only qualification then decides whether a supported, pinned host mechanism can supply the remaining observations. No desktop driver is invented while that mechanism is unknown.

**Tech Stack:** Existing TypeScript, Node >=24.16.0, `node:test`, existing strict lifecycle scalar validators; no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-30-v2-codex-host-boundary-feasibility-design.md`.

**Review status:** The user explicitly approved this preparation plan on 2026-09-30. Implementation uses the preserved Subagent-Driven selection after F1 acceptance. This is the first, independently testable preparation slice, not a complete actual-host driver plan or all of F2. Actual host setup and production activation are not approved by this plan.

**Frozen-candidate rule:** This plan was held in ignored coordination storage without tracked edits, commits, compilation or builds while F1 run `full-suite-1790771147267-22720` was active. That run ended native 0 and F1 closeout is committed at `9035a6fc281eee84695ccd2ad050fc83a21e683e`. This canonical publication precedes execution. Preserve the existing Subagent-Driven selection and all recorded F1 evidence.

## Global Constraints

- Target the user's current Codex desktop, with empty V2 and no V1 import, retrieval or fallback.
- Preserve `requireFullEvidence=true`; public session/workflow IDs are selectors, never bearer authority.
- No real transcript, hidden reasoning, credential, secret-bearing configuration, host installation/trust change, new user-owned conversation or production activation is included.
- Fixture-only frame metadata is not a public wire contract, encrypted retention or `full-adapter` capability.
- All disposable secret material stays in trusted test code; reports contain only permitted metadata, hashes and safe reason codes.
- No repository-wide run for each fixture. After F1 ends, compile once for each RED/GREEN source revision and run its whole affected file serially; do not duplicate compilation for unchanged emitted inputs. This does not waive applicable later F2/F3 release gates.
- Current coverage frames remain `contentRetained:false`. Existing strict end must refuse with `EVIDENCE_CAPTURE_INCOMPLETE`; never lower policy to manufacture native strict completion.

## Review Focus

- An entire omitted category despite contiguous observed ordinals must fail independently of the stream's own coverage claims (Task 1).
- Identical duplicate delivery must be idempotent, while changed content under the same ID must fail (Task 1).
- Host ID aliases or a child mapped to the root must not confer authority or pass attribution (Task 1).
- Missing final response or newly visible content after the declared final response must not pass ordering/completeness (Task 1).
- A green unit verifier, installed version, process file version or passing coverage-only workflow must never become actual-host proof (Task 2).

## File Structure

- Create `tests/support/host-boundary-probe-manifest.ts`: fixture-only types, fixed independent 11-frame manifest and metadata limits.
- Create `tests/support/host-boundary-probe-verifier.ts`: pure strict validation and comparison; no filesystem, host, network, authority or product mutation.
- Create `tests/host-boundary-probe-verifier.test.ts`: whole-file deterministic matrix, including hostile shape and boundary cases.
- Create `docs/superpowers/reports/2026-09-30-v2-codex-host-qualification.md`: source-backed distinction between unit evidence, host observations and unavailable native strict retention.
- Do not modify production lifecycle contracts, public V2 entry points, package/CI commands or hook configuration in this slice.

### Task 1: Independent synthetic manifest and completeness verifier

**Interfaces:**

- `SyntheticProbeCategory = "user-message" | "assistant-message" | "tool-call" | "tool-result" | "child-report" | "reference" | "correction" | "final-assistant"`.
- `SyntheticProbeFrameV1` contains exactly: `frameId:EvidenceFrameId`, `ordinal:string`, `category:SyntheticProbeCategory`, `projectId:string`, `workspaceId:string`, `sessionId:SessionId`, `childId:SessionId|null`, `correlationId:string|null`, `previousFrameId:EvidenceFrameId|null`, `contentHash:string`. It contains no raw content, path, token or key.
- `SyntheticExpectedManifest` contains exactly `manifestVersion:1`, `frames:readonly SyntheticProbeFrameV1[]`.
- `createSyntheticExpectedManifest():SyntheticExpectedManifest` in `tests/support/host-boundary-probe-manifest.ts` returns a fixed deeply frozen fixture, independent of observations.
- `SyntheticVerificationResult` is `{readonly ok:true;readonly uniqueFrameCount:number}` or `{readonly ok:false;readonly reason:"input-invalid"|"limit-exceeded"|"missing-frame"|"unexpected-frame"|"payload-changed"|"scope-mismatch"|"correlation-mismatch"|"order-mismatch"}`.
- `SyntheticProbeLimits` contains exactly `maxObservations:number`, `maxFrameCanonicalBytes:number`, `maxTotalCanonicalBytes:number`. `SYNTHETIC_PROBE_LIMITS` fixes default/hard ceilings at 64, 65_536 and 262_144 respectively; trusted test code may tighten but never exceed them. Every value must be a positive safe integer.
- `verifySyntheticHostObservations(manifest:SyntheticExpectedManifest, observations:unknown, limits:SyntheticProbeLimits = SYNTHETIC_PROBE_LIMITS):SyntheticVerificationResult` in `tests/support/host-boundary-probe-verifier.ts`. The name denotes intended future input, not evidence that an actual host supplied it.
- Limits include duplicates and UTF-8 canonical JSON bytes. These are probe metadata limits, not production full-content limits or existing coverage limits.

- [ ] **Step 1: Write failing whole-file tests for exact membership, ordering and attribution.**

The fixed manifest has ordinals `"0"` through `"10"`: user message, assistant commentary, tool call, its result, structured child report, reference, user correction, assistant commentary, end-request tool call, its requested-status result, final assistant response. Use distinct fixed canonical UUIDs and fixed lowercase hashes; the child report has its own child session plus the fixed child ID. Pair tool call/result correlation IDs; predecessor identity refers to the prior frame. Never construct the expected list from an observed list.

```ts
const manifest = createSyntheticExpectedManifest();
assert.deepEqual(verifySyntheticHostObservations(manifest, manifest.frames),
  { ok: true, uniqueFrameCount: 11 });
assert.equal(verifySyntheticHostObservations(manifest,
  manifest.frames.filter(f => f.category !== "child-report")).ok, false);
assert.equal(verifySyntheticHostObservations(manifest,
  manifest.frames.slice(0, -1)).ok, false);
```

Name and assert tests for: baseline; identical duplicate (count remains 11); changed hash same ID (`payload-changed`); missing interior and entire category (`missing-frame`, even after reordinaling); final missing; extra late frame (`unexpected-frame`); reordered frames/wrong predecessor (`order-mismatch`); foreign project/workspace/session/child (`scope-mismatch`); unmatched or changed tool correlation (`correlation-mismatch`).

- [ ] **Step 2: Run RED and confirm the intended unavailable implementation, not an unrelated compile failure.**

Write minimal typed module stubs solely to let the tests compile, with verifier throwing `Error("not implemented")`. Run `npm run test:build`, then `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/host-boundary-probe-verifier.test.js`. Expect native nonzero and the named contract assertions not satisfied; preserve raw output. Do not run while F1 is active.

- [ ] **Step 3: Implement the exact fixture and verifier interfaces above.**

Use existing `strictRecord`, `strictArray`, `exactRecord`, `parseLifecycleId`, `parseDecimalString` and scalar bounds from `src/orchestrator/lifecycle/contracts/identifiers.ts`; SHA-256 values are exactly lowercase 64 hex digits. Project/workspace fixture IDs and non-null correlation IDs use canonical UUIDs. Validate descriptors before accessing fields: no getters, sparse arrays, exotic prototypes, extra fields or unknown categories. Use existing canonical JSON serialization for byte checks only after safe shape validation. Never stringify arbitrary rejected input into errors or logs.

Validate trusted limits and the expected manifest itself: nonempty, unique identities, exact contiguous ascending ordinals starting at zero, all eight categories, final-assistant only at the end, consistent predecessor links and paired tool calls/results. Bad manifests/limits return `input-invalid`, not a positive proof. Return `limit-exceeded` for exceeded budgets, counting duplicates before deduplication. Compare observed exact identity membership against this independent manifest; permit only byte-equivalent identical duplicates, then compare first-occurrence order, scope, correlation and hashes. Do not trust supplied observed ordinals alone. No production adapter or automatic category inference is added.

- [ ] **Step 4: Add boundary tests and run GREEN once for the whole affected file.**

Pin tests for all invalid scalar/shape cases including caller getters that must not execute; unknown category; malformed UUID/decimal/hash; hostile expected manifest; invalid/over-ceiling trusted limits; 64 versus 65 observations; duplicate frames never hiding missing IDs; and a same-ID altered category. Test byte boundaries using permitted metadata and tightened trusted limits: calculate the actual maximum canonical frame length N and complete-array length M; budgets N/M pass and N-1/M-1 yield `limit-exceeded`. Do not invent raw-content/extra fields to reach a nominal limit.

Run `npm run test:build`, then the exact whole-file Node command from Step 2. Expect native 0, zero failures/cancellations/skips, with all named assertions reached. Run `npm run typecheck`. Save RED/GREEN native evidence; none is actual-host proof.

- [ ] **Step 5: Review and commit only the three new fixture files.**

Preserve all existing production guards and test assertions. Independent scoped review covers spec conformity and task quality. Commit after fresh verification; no compiler ownership overlap or extra broad test run.

### Task 2: Source-backed host qualification and execution stop

**Interfaces:** Consumes Task 1's fixture contract and verified unit results, existing `PrivateAuthorityChannel`, `LifecycleExecutionResult`, `SessionEndStatusV2`, and current official host documentation. Produces a human-readable qualification report, not a signed release or public host-capability API.

**Report fields:** Source/config identities; separate installed-package/process-file/actual-serving-host observations; supported mechanism and release/schema evidence; one row per spec section 7 requirement with `established`, `unverified` or `unsupported`; source references; safe native retention disposition; next permitted diagnostic. Unknown fields are explicitly `unverified`, never empty success.

- [ ] **Step 1: Qualify only supported mechanisms using read-only documentation and non-secret metadata.**

Use the fetched release behavior page [Hooks](https://learn.chatgpt.com/docs/hooks), not GitHub `main` as proof of the actual desktop release. Existing read-only inventory is an input, not proof: installed package `26.928.1915.0`; process file versions `154.0.8037.57` observed for `ChatGPT`, with no link established to the calling conversation. No process command lines, environment inventories, historical transcripts or secret-bearing config reads.

Document candidate hook fields and omitted observability. Tool hooks exclude some paths; transcript format is not stable; hook output may be model-visible. No undocumented attach, transcript watcher, custom-client switch or output field labeled "private" is accepted. Final `Stop` text is not by itself all intermediate assistant content. Keep official-page-derived prose under 200 words total in the report.

- [ ] **Step 2: Pin the native strict-retention limitation without changing it.**

Reference `RecordEvidenceBatchCommandV2` (`commands.ts:283`) and existing bounds: 1–2,000 coverage frames, key ID at most 128 Unicode scalars, 4 MiB lifecycle transport, canonical decimal positions and UTC millisecond timestamps. None supplies a full-content envelope. Reference `session-end-policy.ts:249/269` and `session-end.coordinator.ts:149`: `requireFullEvidence=true` cannot reach strict completed closure from coverage-only evidence; it durably reports `EVIDENCE_CAPTURE_INCOMPLETE`. Existing named tests in `session-end-policy.test.ts` exercise rejection and normalization. Reuse valid F1 evidence where its inputs correspond; do not run those unchanged files for reassurance.

Separately identify missing production redaction/encryption/key recovery/governance/erasure work. A future host-only ordering proof and a weaker-policy unit test cannot satisfy this native retention obligation.

- [ ] **Step 3: Publish the honest qualification result and stop before unauthorized setup.**

If required feed/private storage/finalization/model-boundary instrumentation cannot be qualified, disposition is `host-capability-unverified`, with exact missing proof and no unsupported-desktop inference. A conclusively documented limitation applies to that mechanism, not automatically the whole client. No setup request is issued for an invented mechanism.

If a viable supported mechanism is qualified, prepare a separate mechanism-specific reviewed execution addendum before any driver or host action. It must name exact files/config/trust actions, protected storage, current schema and full-content bounds, independently observable surfaces, one total deadline, synthetic conversation and owned store creation, one lost-response/reconnect case, every negative matrix row, process ownership and recoverable cleanup. Obtain separately scoped authority for actual setup and new user-owned conversation creation. Nothing in this preparation plan preapproves those actions.

- [ ] **Step 4: Self-review and commit the qualification report.**

Every `established` row must have a directly supporting observation; unit-only results stay labeled unit-only. Host-proven and production-ready dispositions are forbidden without the actual evidence. Report sources, unknowns and native incomplete retention explicitly. Verify `git diff --check`, compare report assertions to cited source and preserved logs, then commit only the report.

## Coverage and Handoff

Task 1 implements the spec's independent synthetic completeness/negative-comparison prerequisite. Task 2 implements supported discovery, explicit limitations, native-policy separation and the required early-stop report. Actual host setup, private sentinel boundary instrumentation, durable host retry/restart, supported private finalization and cleanup are intentionally unexecuted until the reviewed mechanism-specific addendum; they remain requirements, not waived tests. Full production retention/public memory, F3 recovery/release and F4 separately approved activation remain outside this preparation slice.

Self-review: interfaces match across tasks; no production API invented; the independent expected manifest covers all eight fixture classes; five review-focus classes have owners/tests; frozen-input ownership is preserved. The current complete actual-host probe plan cannot be finished by guessing an interface. The user's approval permits the preparation tasks only; preserve Subagent-Driven without asking for approval or the method again. Task review and the scoped final preparation review remain required.
