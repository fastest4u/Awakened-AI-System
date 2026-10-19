# Full-body governed notes — runtime qualification evidence

**Status: UNQUALIFIED (Prepared candidate template — single contained qualification run `npm.cmd run test:v2-full-body-notes` pending after whole-increment spec, code-quality, and security reviews on the clean committed candidate).**

No runtime qualification is claimed in this prepared candidate commit. Keep `memory_v2Status`-only public registration, `productionReady: false` (`productionReady=false`), closed promotion, `FRESH_START_CONTENT_UNVERIFIED`, `requireFullEvidence=true`, `host-capability-unverified`, and V1 archive isolation. Historical `0ecb75b2a814c408255c940ef0e850135a1d9911` (34 stages / 28 files / 945 pass) remains historical governed-summary-commands qualification only.

## 1. Qualification status and candidate vs documentary HEAD boundary

- **Current qualification status**: `UNQUALIFIED` (prepared template committed with the candidate runner before the single authorized `npm.cmd run test:v2-full-body-notes` invocation).
- **Qualified runtime candidate Git HEAD**: `PENDING_CANDIDATE_QUALIFICATION_RUN`
- **Post-qualification evidence publication Git HEAD**: `PENDING_EVIDENCE_PUBLICATION_COMMIT` (will differ from the qualified runtime candidate HEAD because all tracked non-memory documentation files under `docs/**` participate in `sourceIdentity`).

## 2. Exact gate contract and 37-stage / 31-file literal inventory

- **Exported seam**: `runFullBodyNotesGate(options?: { root?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<void>` in `scripts/run-v2-full-body-notes.js`
- **Package script alias**: `test:v2-full-body-notes` -> `node scripts/run-v2-full-body-notes.js` (no CLI arguments accepted; private exit codes `130` for cancellation and `124` for deadline exhaustion; fixed public failure line `FULL_BODY_NOTES_GATE_FAILED`)
- **Profile / Gate identity**: `profile: "full-body-notes"`, `gate: "v2-full-body-notes"`, `failure: "FULL_BODY_NOTES_GATE_FAILED"`
- **Fixed bounds**: `totalTimeoutMs: 2100000` (35 minutes), `cleanupTimeoutMs: 5000`, `stageOutputMaximumBytes: 16777216` (16 MiB), `evidenceRecordMaximumBytes: 16384` (16 KiB), `evidenceAggregateMaximumBytes: 131072` (128 KiB). This 35-minute outer qualification runner is excluded from the lifecycle validation profile registry (`<= 300000` ms, `<= 1048576` bytes).
- **Containment and ownership contract**: Reuses `runFixedStages` (`scripts/run-v2-internal-verified-read.js`), `V2VerifiedReadJob` (`scripts/v2-verified-read-job.ps1`), and `parseFinalSpecCounts` (`scripts/run-v2-retained-evidence.js`) read-only. Removes inherited `NODE_TEST_CONTEXT`, requires direct child exit, drained stdout/stderr pipes, Windows Job `activeProcesses === 0`, helper close `0`, coherent final stock-spec counts (`tests > 0`, `fail === 0`, `cancelled === 0`, `skipped === 0`, `todo === 0`), exact 21-case `V2_FULL_NOTE_NATIVE_EVIDENCE_V1` verification in stage 19 (`v2-full-note-entry`), postflight source/runtime/build/compiled re-verification, and positive owned `.fresh-start-foundation.lock` release before emitting the single qualification marker.

| Stage(s) | Literal stage invocation |
| --- | --- |
| 1–4 | `runtime` (`scripts/check-runtime.js --json`), `typecheck` (`node_modules/typescript/bin/tsc --noEmit`), `build` (`scripts/build.js`), `compile` (`node_modules/typescript/bin/tsc -p tsconfig.test.json`) |
| 5–12 | `v2-full-body-note-contracts`, `v2-full-body-note-privacy`, `v2-full-body-note-command`, `v2-full-body-note-projection`, `v2-full-body-note-genesis`, `v2-full-body-note-publication`, `v2-full-body-note-summary-regression`, `v2-full-body-note-runtime` |
| 13–20 | `v2-full-note-contracts`, `v2-full-note-query`, `v2-full-note-result`, `v2-full-note-protocol`, `v2-full-note-child`, `v2-full-note-supervisor`, `v2-full-note-entry`, `v2-full-body-notes-gate` |
| 21–25 | `v2-governed-note-contracts`, `v2-governed-note-codec`, `v2-governed-note-recovery`, `v2-governed-note-ownership`, `v2-governed-note-candidate-read` |
| 26–35 | `projection-source-event-codec`, `projection-schema`, `projection-coordinator`, `projection-integrity`, `fresh-start-repository`, `fresh-start-admission`, `v2-native-content-query`, `v2-native-content-entry`, `v2-native-workflow-cursor`, `v2-native-workflow-query` |
| 36–37 | `worker-smoke` (`scripts/smoke-worker.js`), `fresh-start-smoke` (`scripts/smoke-v2-fresh-start.js`) |

## 3. Candidate source, runtime, build, closure, and compiled private custody identities

- **Status**: `UNQUALIFIED / PENDING CANDIDATE RUN`
- **Candidate Git HEAD / tracked non-memory source digest**: `PENDING`
- **Runtime executable (`nodeVersion`, `platform`, `arch`, `executableSha256`)**: `PENDING`
- **Build identity hash (`dist/v2-build.json`) and manifest SHA-256**: `PENDING`
- **Five deployment artifacts (`v2.js`, `v2-admin.js`, `workers/project-store.worker.js`, `internal/v2-internal-verified-read.js`, `internal/v2-internal-verified-read-cleanup.js`)**: `PENDING`
- **Two closure manifests (`internal/v2-internal-verified-read.js.closure.json`, `internal/v2-internal-verified-read-cleanup.js.closure.json`) and input digests/counts**: `PENDING`
- **Full `dist-test` compiled tree digest/count and 25 explicit compiled private closure hashes**: `PENDING`

## 4. Per-stage execution receipts and output digests

- **Status**: `UNQUALIFIED / PENDING CANDIDATE RUN` (37 serial stages / 31 test files pending single candidate execution).

## 5. Bounded safe native evidence (`V2_FULL_NOTE_NATIVE_EVIDENCE_V1` — 21 cases)

- **Status**: `UNQUALIFIED / PENDING CANDIDATE RUN`
- **Configured fixture timing inputs** (qualification fixture inputs, not production SLA): `requestTimeoutMs: 15000`, `closeTimeoutMs: 5000`, `recoveryProofLifetimeMs: 60000`, `maxPending: 128`, `executorLeaseMs: 15000`, `heartbeatIntervalMs: 5000`, `appendRetryDeadlineMs: 15000`, `sqliteBusyTimeoutMs: 5000`, `privateReadBudgetMs: 5000`.
- **21 finite cases** (`round-trip-session-log-root`, `round-trip-insight-root`, `round-trip-mistake-root`, `round-trip-adr-root`, `round-trip-insight-child`, `escaped-65536-old-route`, `same-position-upgrade`, `v1-kind-absent`, `generic-kind-absent`, `v1-recovery-v2`, `sibling-refused`, `ended-refused`, `revoked-refused`, `ineligible-source-refused`, `source-key-unavailable`, `captured-image-stable`, `whole-checksum-refused`, `native-deadline`, `native-cancel`, `native-packing-fault`, `late-success-uncertain-cleanup`): `PENDING CANDIDATE RUN`.

## 6. Whole-increment review outcomes (spec, code-quality, security)

- **Status**: `PENDING WHOLE-INCREMENT REVIEWS` (fresh whole-increment spec compliance, code-quality, and security reviews to be recorded before the single candidate qualification run).

## 7. Preserved historical baselines, claim boundaries, and open readiness limits

- **Preserved historical baselines**:
  - Governed summary commands G11 qualification at runtime `0ecb75b2a814c408255c940ef0e850135a1d9911` (`docs/superpowers/evidence/2026-10-08-v2-governed-summary-commands.md`, 34 stages / 28 files / 945 pass) remains historical summary-only evidence.
  - Native read workflows Task 6 qualification at runtime `56232b5023e27abb35f364051e71c321b33fc0bb` (`docs/superpowers/evidence/2026-10-07-v2-native-read-workflows.md`) remains historical evidence.
- **Claim boundaries and open readiness limits**:
  - Demonstrates private governed V2 full-body creation (`session-log | insight | mistake | adr` candidate/unverified literal Markdown `<= 65,536` UTF-8 bytes), deterministic schema-3 projection (`governed_notes` side table), and dedicated exact-ID private verified read (`get-full-note` over protocol version 4 with `<= 256` KiB complete reply ceiling) while keeping all ordinary retrieval routes summary-only.
  - Does **not** deliver public MCP full-note tools or public write/read routing, Markdown rendering, vault file export/import, factual verification or promotion (`status: "candidate"` only), operational key custody/rotation approval, or production cutover.
  - `productionReady: false` (`productionReady=false`), `memory_v2Status`-only public registration, closed promotion, `FRESH_START_CONTENT_UNVERIFIED`, `requireFullEvidence=true`, `host-capability-unverified`, and V1 archive isolation remain in force.
