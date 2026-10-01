# V2 internal verified-read admission and consistency design

Status: Written specification explicitly approved by the user on 2026-10-01 with `อนุมัติสเปก V2 verified-read written`, reviewing commit `37d31d1aab52fe8e42f8c2c335a9d8ea037a7055`. Implementation planning is authorized; the executable plan still requires review before implementation. Production activation remains separately gated.

Source inspected: `de2fee723322a28c915b26dfcfa5466203deadff` on `codex/v2-fresh-start`.

## 1. Outcome and limits

Deliver the smallest genuine V2 internal boundary that admits a trusted read, captures and verifies the actual published image, enforces a required committed position, revalidates authority and releases only a detached bounded result after cleanup. The initial operation is `verify-published-view`: it reads image metadata and returns a verification receipt, not memory content. This proves the ownership/admission/consistency seam before a separately reviewed native retrieval increment. It is not a public search/get/list/context-pack implementation.

This follows the approved [fresh-start profile](2026-09-29-v2-fresh-start-production-design.md) and the independent-read provision in section 9 of the [host-boundary design](2026-09-30-v2-codex-host-boundary-feasibility-design.md). V2 starts empty; V1 Markdown data is never imported, consulted or used as fallback. The current Codex desktop remains the selected client. Actual host capture, private continuation, raw-evidence encryption/governance, authenticated recovery and release/cutover proof remain separate requirements.

Preserve public `memory_v2Status`-only registration, content/promotion denial, `productionReady:false` and `requireFullEvidence=true`. Coverage-only `contentRetained:false` cannot certify strict completion. A successful receipt is not a release certificate, recovered-view certificate, complete host proof or whole-system PROD-ready claim.

Written-spec approval authorizes preparing an executable plan for review. The selected execution method remains Subagent-Driven. It does not authorize implementation before plan review, live configuration/trust/installation, transcript or credential reads, a new user-owned conversation, push/merge, hosted CI, deployment or activation.

## 2. Existing seams and required new work

`FreshStartAdmissionGuard` currently denies every `content-read`; public composition also denies content and promotion. Do not enable either by adding this internal slice. Add a distinct internal verification admission path that can validate an active fixture/runtime binding for the allowlisted operation without masquerading as a semantic mutation or command recovery. Current public guard behavior remains unchanged.

`ProjectionManifestV2`, copied generation images and `openVerifiedV2ProjectionImage` are genuine V2 inputs. The parity evaluator's V1 manifest facade is not. Existing metadata validation in `retrieval/candidates.ts` is private and must become a shared, independently tested V2 validation primitive where needed, without weakening V1 behavior.

The current stable-directory API launches synchronous helper processes with a fixed five-second timeout. The V2 coordinator also has uncancellable queue/source/build waits. Neither provides this design's total response deadline. There is no exported subprocess-free stable capture API today. A narrow extraction of existing cwd-relative capture/lock checks is new work; it must preserve their provenance and race defenses rather than inventing an already available directory-handle API.

The existing lifecycle writer executor demonstrates reject-before-background-termination, but is not the read executor and its awaited close path does not establish bounded cleanup. Do not add read messages to its mutation protocol or terminate it on read failure.

## 3. Trusted composition and private operation contract

One server-owned adapter instance binds one explicit project/V2-store/projection directory. Composition supplies and snapshots these private inputs:

- Project/vault/store, workspace, branch-scope and branch-ref identity; normalized real store and projection locations with filesystem provenance.
- Expected release ID and control generation; measured build and registered schema identities; configuration, capability-manifest, recovery-policy and evidence hashes for that release.
- An optional authenticated session binding and its committed minimum position, established by trusted lifecycle composition rather than model-controlled selectors.
- Fixed compiled executor/cleanup entry points and an owned executor-state directory separate from V1 and projection generation files.

Only trusted server code can construct this binding. Public tool arguments cannot supply a path, release, role, capability, alternate workspace, session authority or executable. No bearer/resume/encryption material is needed by this metadata-only process; none is copied into its environment, arguments, IPC, logs or receipts. Session IDs are identifiers, not authority.

The proposed private read request has exactly `operation`, `consistency`, `minimumEventPosition` and `budgetMs`; `operation` is only `verify-published-view`, consistency is only `session-strong` or `project-strong`, the position is a canonical unsigned decimal string at most SQLite INT64_MAX, and the budget is an integer in 0..30000. Composition resolves an absent trusted caller override to the mode's default before encoding; the wire always has an explicit budget. A session-strong request requires the separately bound session. The minimum cannot lower that session's trusted committed position. Both modes conservatively include the captured project-wide committed tail; this is stronger than a session-only lower bound, not a promise of a faster path.

The supervisor wraps this request in an exact version-1 IPC envelope containing a fresh request ID, lane epoch and attempt ID. All reply variants repeat those identities. Trusted bootstrap data is delivered over private IPC, not serialized into a command line. Decoders reject extra keys, unsupported shapes, accessors, invalid numbers, oversized messages and wrong operation or receipt identity. Known closed-lane/old-epoch replies are ignored and cannot poison a later request or cause success; an unrecognized identity on the live child's current lane is a protocol failure. No arbitrary callback, SQL, module URL, evaluator lease, database handle or image bytes crosses the boundary. Internal callbacks are an ownership convenience for reviewed server code, not a sandbox for model-supplied code.

The detached receipt has exactly: `operation`, `consistency`, `scope` (project/vault/store/workspace/branch-scope/branch-ref and bound session or null), `releaseId`, `controlGeneration`, `requiredEventPosition`, `projectionGeneration`, `projectionEventPosition`, `projectionEventHash`, `imageSha256` and `verification`. `verification` is the literal `image-scope-position-and-active-admission`; it cannot be `recovery-verified` or `production-ready`. Positions/control generation use canonical decimal strings; projection generation follows the existing manifest numeric bounds. No paths, timestamps presented as proof, content, secrets or copied manifest objects appear. The result is freshly decoded/copied/frozen by the supervisor.

Adding a content read, ranker, provider, overlay or another private operation requires its own reviewed contract and proof; this initial allowlist is not extensible through caller registration.

## 4. Concrete executor and read sequence

Use a dedicated child process, not a worker thread or the lifecycle writer. The supervisor launches a fixed compiled entry point with `cwd` equal to the trusted projection directory, hidden on Windows, shell disabled and private IPC. Supply an explicit minimal non-secret environment and fixed runtime arguments; do not inherit `NODE_OPTIONS`, preloads, credentials or caller-selected executable configuration. The child imports only the allowlisted read/admission and detached-image primitives. It must not invoke `spawn`, `spawnSync`, `exec`, worker-thread creation or existing helper-backed filesystem methods; reviewed dependency structure and tests enforce this invariant. This is trusted fixed code isolation, not an OS sandbox for arbitrary code. There are no child descendants to leave behind.

Inside this process, extract/reuse the existing stable helper's direct synchronous operations: relative `lstat/open/fstat/read/recheck`, canonical cwd/device/inode checks, regular-file and symlink rejection, size/ctime continuity, sidecar checks and exact publication-token acquisition/release. These operations may block this disposable process, but not the serving supervisor's event loop. No new native dependency or platform-specific directory-handle guarantee is assumed.

Each admitted request follows this sequence:

1. The supervisor records monotonic arrival before bounded input validation, derives the one response expiry, records ownership and queues/launches the read process. Validation/encoding time counts too. An expired or zero budget launches nothing.
2. In one short, read-only SQLite snapshot transaction, the child checks the installation and project metadata, the exact release and all expected release hashes, the actual registered schema/build, active mode and matching control generation. It captures the committed global position/hash and derives `required = max(captured tail, trusted session minimum, request minimum)`. An uninitialized, prepared or disabled store is denied; read-only recovery is always `FRESH_START_CONTENT_UNVERIFIED` in this slice.
3. End that transaction before projection waiting or capture. Do not hold `BEGIN IMMEDIATE`, a writer lease or any authoritative transaction across asynchronous work. Admission is not obtained by calling a mutation operation as a shortcut. The event database is opened read-only with existing store-provenance checks; missing storage is not initialized or reset.
4. Attempt the existing cooperative publication lock with the request's preallocated token. A busy lock, absent manifest or well-formed insufficient generation is a wait observation, never success. Release a lock acquired for an insufficient generation before waiting. Retry inside the same child and original budget; do not create another writer or helper process.
5. Under an owned lock, capture and parse the actual V2 manifest, validate its scope, capture its named image and recheck the manifest/directory/file/sidecars. Reject ambiguous publication/reconciliation state; do not repair, retire, install or advance a generation/journal. The image must meet `required`. Do not trust an earlier `ensurePublished` result: the generation actually captured is what is validated.
6. Copy the bounded image, verify filename and SHA against the actual manifest, open a guarded detached SQLite image, and independently read/validate its singleton `projection_metadata`: schema 2, project/vault/store/workspace/branch-ref/scope, null image session, generation, terminal position and hash. Parse `highestObservedGeneration` under the existing V2 rules. Perform these checks before the allowlisted metadata read; a later candidate collector is not a substitute.
7. Build the detached receipt internally, close the image and file descriptors, and release the exact owned publication token using existing retained-publication-artifact safeguards. Cleanup must succeed before considering a successful result. A primary failure cannot be masked by another cleanup failure; record both as distinct outcomes.
8. In a new short authoritative read snapshot, repeat the installation/release/build/schema/mode/control-generation checks. Confirm the event history has not regressed below the captured tail, that its hash still matches at that captured position, and that the image's terminal position/hash is present in authoritative committed history (position zero uses the genesis hash). A new ordinary commit is allowed; the required read position is fixed at admission, not moved on every retry. Reject changed authority, generation, recovery/disabled mode, a missing anchor or an image beyond the authoritative committed tail.
9. That final successful authoritative observation is the read's linearization point. Close the authoritative reader, report the bounded candidate receipt and cleanup attestations, then exit normally. The parent releases success only after matching receipt/attestation, normal owned exit, its own still-current composition epoch and an unexpired response budget. Any missing proof discards the receipt.

A transition occurring before the final observation is fenced; a transition after that successful linearization point does not retroactively invalidate the completed read. This does not claim detection of all transitions up to network delivery. A composition-epoch change observed by the supervisor before settlement still discards a pending result. No result is streamed before final acceptance.

Projection production remains a separately owned existing activity. This adapter only waits for/captures published images; it does not initiate a build, refresh, generic append or journal reconciliation. Later public composition must supply the genuine V2 publisher before expecting read-after-write availability. A missing/lagging publisher here yields a bounded lag error. Any future prerequisite wait must consume the original budget, not restart it. No invented refresh API or synchronous publisher work is added to the supervisor.

Image SHA, metadata, scope and committed-position anchors verify this declared seam only. They do not authenticate the entire source history, recompute semantic core checksums, establish restored erasure/privacy or certify recovery. A forged self-consistent core is not ruled out by SHA alone. Recovery stays denied until separately designed source authentication, replay and current privacy/erasure proof exist.

## 5. Response deadline and fixed initial resource bounds

The initial bounds are design choices to verify, not measured performance guarantees:

| Bound | Initial contract |
| --- | --- |
| Response budget | 2000 ms session-strong; 5000 ms project-strong; trusted override integer 0..30000 ms |
| Budget origin | Supervisor request arrival before queue/startup/ownership I/O; one monotonic clock, no resets |
| Queue/processes | One adapter/binding per server composition; 8 unsettled requests including the active request; one read or cleanup child at a time |
| Publication wait | 50 ms cancellable waits, at most 600 attempts, also limited by the original remaining response budget |
| Manifest | Existing 64 KiB maximum |
| Read image | 64 MiB maximum for this new slice; legacy 512 MiB helper limit is unchanged; no image bytes transported over IPC |
| Wire messages | 8 KiB request/bootstrap envelope, 16 KiB receipt/envelope, at most 8 bounded stage/terminal messages per request |
| Child output | stdout/stderr discarded, no raw text logged; each stream over 4 KiB is a protocol failure and terminates the request |
| Cleanup observation | Separate fixed 2000 ms, beginning when the response lane closes or normal child exit is requested; includes grace, termination, reaping, lock cleanup and ownership-record closure |
| Grace before termination | At most 100 ms within cleanup observation; no new response time |

The smaller image bound is deliberately local to this increment. Oversize is a typed refusal, not truncation. Copies, native SQLite allocations and startup costs remain explicit capacity risks; a file-byte bound is not a whole-process RSS cap. Before broadening capacity or concurrency, measure and review it. No new pool, unbounded retry or automatic deadline inflation is allowed.

The supervisor alone decides the response deadline. Child-local remaining-budget checks avoid useless work but cannot extend it or act as timing authority. Budget zero refuses even an already sufficient generation. Startup, queue, lock wait, capture/hash/deserialization/query, final checks, normal exit and success cleanup all fit the original budget. This differs from the umbrella's existing 2/5-second projection-wait budgets: it is a new internal total-response contract, not a claim that public semantics already changed.

On timeout/cancellation, settle the caller once, close its response lane and ignore all later successes, stale identities and messages. Native synchronous work cannot prevent that supervisor decision. Use nonblocking supervision and monotonic expiry checks before every settlement; a delayed timer cannot permit a late success. This is a bounded logical response contract subject to ordinary scheduler/OS latency, not a hard real-time guarantee or a promise that termination already finished.

Queue overflow refuses with `STORE_QUEUE_FULL`; queued requests keep their original deadlines. Closing/quarantining the adapter settles remaining requests without spawning more processes. The fixed process slot remains occupied until cleanup is positively complete. No writer receives cancellation, termination or copied mutating commands from this read lane.

## 6. Ownership, cleanup and restart

The supervisor allocates a request/attempt ID, lane epoch and 32-hex publication token before launch. In the trusted executor-state directory, it persists one bounded ownership record using atomic, nonblocking I/O before spawning: binding fingerprint, entry-point/build identity, supervisor instance identity, attempt and token, launch-intent/observed child ownership, and cleanup state. This directory is explicitly supplied by server composition, is not a secret store and is never discovered by scanning user files. Record bytes are capped at 8 KiB. Its existence/updates do not initialize V2 or authorize activation.

Unfinished ownership I/O cannot cause an expired request to launch later. Track unresolved I/O as cleanup-incomplete and suppress further launch until its disposition is known. An observed child is tracked through its actual process handle/IPC/exit events, not a guessed/reused PID. The record survives a supervisor crash: on restart, any unresolved intent/child/cleanup record or unresolved publication lock prevents new read launches. Do not kill a process by a stale numeric PID or automatically clear records because a lease or wall clock elapsed. Explicit trusted reconciliation after proof is separate work, not an automatic fresh reset.

Normal success requires positive image/reader/descriptor closure, owned-lock release, normal process exit and completed ownership-record closure before response settlement. Double close and repeated exit/cleanup messages are idempotent. An image close exception cannot report success. Process exit is evidence that OS handles are gone, but is not evidence that an on-disk lock was removed.

After an unsuccessful response, the supervisor uses the separate cleanup observation window. It requests cooperative stop, then terminates only its exact live read child if necessary and observes actual exit. Signal acceptance or an unresolved termination promise is not exit proof. A parent disconnect requests child exit between blocking operations; it cannot preempt synchronous work, so the durable record remains the restart backstop.

Only after confirmed read-child exit may the supervisor launch one fixed cleanup child, owned directly by the same supervisor, in the same trusted cwd. It creates no descendants and has only `release-owned-read-lock`: inspect directory identity, exact token and existing retained-publication-artifact checks; remove only a fully matching owned lock when those checks permit. An absent lock can confirm no owned lock remains; a foreign token is never removed and leaves the binding unavailable until publication state is resolved. A partial token, changed directory, uncertain retained state, launch/exit failure or blocked cleanup cannot be guessed safe. Never use broad deletion, remove generation files or clear a writer's lock.

The cleanup child and all ownership I/O consume what remains of the same cleanup window; it is not a fresh two seconds per stage. It may replace the already exited read child, not run beside it. If its exit or exact lock disposition cannot be confirmed in time, quarantine the slot/binding and retain the record/evidence. Initiate termination only for that owned cleanup child; do not await it indefinitely or spawn replacements. A late completion may be recorded, but cannot automatically unquarantine the adapter or revise the settled response into success.

Expose internal cleanup state as `pending`, `complete` or `incomplete`, separately from the primary request code. Timeout initially has pending cleanup, not an invented complete result. At the observation limit report `incomplete` and refuse reuse. A failed ordinary read with otherwise proven cleanup need not quarantine permanently; it still cannot return its discarded result. No unknown lock/process is silently released, and no unresolved attempts accumulate behind replacement children.

## 7. Typed failures and information boundary

Use existing stable error families where their meaning applies; do not serialize underlying exceptions, database rows, request bodies, paths, command lines, captured output or credentials. The read protocol is separate from lifecycle command-result decoding; read transport failure is not an unknown semantic commit.

| Failure | Primary disposition |
| --- | --- |
| Invalid shape/budget/session requirement | `FRESH_START_INPUT_INVALID` |
| Missing trusted binding or installation | `FRESH_START_CONTEXT_REQUIRED` / `FRESH_START_NOT_INITIALIZED` |
| Foreign identity or changed path | Existing fresh-start identity/path failure |
| Wrong release/build/schema or release metadata | Corresponding fresh-start mismatch; other bound release-hash differences use `FRESH_START_RELEASE_MISMATCH` |
| Prepared/disabled | `FRESH_START_ADMISSION_DENIED` |
| Read-only recovery, unproved readable view | `FRESH_START_CONTENT_UNVERIFIED` |
| Control generation/composition changed | `FRESH_START_ADMISSION_STALE` |
| Missing/behind/busy projection at the limit | `PROJECTION_LAG`, with only bounded required/observed positions |
| Image corruption, SHA/metadata/anchor inconsistency or ambiguous publication | `INTEGRITY_FAILURE` / existing projection scope/path/conflict failure, no receipt |
| Response expires outside a known projection-wait phase | `WORKER_TIMEOUT` |
| Cancel/adapter closed | `WORKER_CLOSED`, internal cancellation reason only |
| Saturated queue | `STORE_QUEUE_FULL` |
| Invalid/current-lane unknown identity/oversized IPC, descendant creation | `WORKER_PROTOCOL_ERROR`; known late/old-lane messages are ignored |
| Launch/unexpected exit/termination or quarantined lane | `WORKER_UNAVAILABLE` |

Cleanup failure is attached to internal bounded diagnostics as its separate state/reason; it never replaces the primary timeout/admission/integrity error. A diagnostic includes only opaque attempt ID, phase enum, primary code, cleanup state and bounded counts/positions. It cannot expose the publication token, ownership record, filenames or process output. No public tool/result or public error registry is expanded in this increment.

There is no eventual fallback, V1 lookup, stale receipt reuse, global/provider query, best-effort partial result or repair-on-read. A well-formed empty genesis view may produce a receipt at position zero; an absent store is not a truthful empty view.

## 8. Focused acceptance evidence

The implementation plan must map these rows to production seams, owned isolated SQLite stores, compiled process entry points and deterministic failure injection. Do not merely mock the interface whose behavior is being claimed.

| Proof | Required evidence |
| --- | --- |
| Fresh/reopen | Real empty initialized V2 view, zero/genesis receipt, later committed position and reopen of the same identities; no reset on missing storage |
| Admission | Trusted session/project scopes; foreign binding, release/build/schema/hash mismatches, missing context, prepared/disabled and recovery denial |
| Consistent authority | State/release/tail captured in one snapshot; transition before/after pin and before final snapshot refuses; a transition after the declared linearization point is not misreported as a missed fence |
| Actual image | Scope/metadata mismatch despite valid byte SHA, corruption/truncation, sidecars, file/directory swap, manifest replacement between observations and wrong authoritative terminal hash; validate captured image rather than earlier publication result |
| Position | Required committed minimum observed or bounded lag; ordinary later commits permitted; same captured anchor intact; absent/ahead/rollback history rejected |
| Native isolation | A genuinely blocking read process cannot block the supervisor timer; no helper descendants, no lifecycle/projection writer killed or mutating command issued |
| Deadlines/queue | Zero/already expired, queued expiry, launch delay, hung waits/native stages, late success and delayed timer; one response, no budget resets, saturated queue bounded |
| Wire/results | Unknown/extra fields, stale request/epoch/attempt, wrong receipt scope, oversize output/IPC, escaping handles or image bytes; all refused/redacted |
| Cleanup | Once-only close, close/release exception, unconfirmed termination, lock partial/foreign token, retained publication artifacts, directory change, hung cleanup child/I/O and late cleanup; primary outcome preserved, incomplete quarantine/no replacement |
| Crash/restart | Supervisor crash around intent/spawn/PID observation/lock acquisition; unresolved ownership prevents automatic re-launch/reset; known complete record permits normal reopen |
| Public isolation | Existing V2 content/promotion still denied, no new public tool, no V1 access using a uniquely instrumented fixture; strict evidence setting unchanged |

Use deterministic clock/barriers for logical races and a bounded real-process test for actual blocking/exit behavior. Timing assertions allow documented scheduling slack and distinguish measured settlement from actual cleanup. On timeout/cancel, preserve bounded redacted evidence and report native outcomes, including incomplete cleanup. Synthetic pass cannot claim current-desktop capability or whole-system recovery.

The executable plan uses task-focused TDD and one increment-level compiled-process gate, plus checks invalidated by actual changes. Reuse accepted unchanged F1 and synthetic host-preparation evidence; do not rerun them just for reassurance or delete regression coverage to shorten a run. Applicable final release gates remain required when their inputs change.

## 9. Handoff, dependencies and self-review

After the user approves this written artifact, write a concrete plan with exact files/interfaces, staged extraction of shared checks without legacy semantic changes, admission/protocol/supervisor/process/cleanup ownership work, bounded acceptance tests and a final code-review checkpoint. Retain Subagent-Driven. No runtime capacity, deadline or cleanup success is claimed before implementation and fresh verification.

Completing this increment delivers only the internal verification-receipt boundary. Native V2 retrieval/public controllers, governed memory writes, actual desktop capture/private closure, raw-evidence/privacy, source-authenticated backup/restore/replay, exact release proof and explicitly approved client cutover/live verification remain. A complete F2/F3/F4 roadmap must not be marked finished by this slice.

Inline self-review checks: approval stages distinct; concrete owned process rather than fictional preemptible timer; shared writer untouched; no nested synchronous helpers; exact allowlist and resource bounds; actual pinned V2 image and authoritative anchors verified; final linearization point explicit; response/cleanup deadlines separate; poisoned resources/restart uncertainty retained; recovery still denied; no evaluator facade, public content, V1 fallback or fictional PROD claim. This is document self-review, not executable verification.

Source references: `src/v2/composition.ts`; `src/v2/app.ts`; `src/orchestrator/fresh-start/fresh-start-admission.ts`; `src/orchestrator/fresh-start/fresh-start.repository.ts`; `src/orchestrator/fresh-start/contracts.ts`; `src/orchestrator/projections/coordinator.ts`; `src/orchestrator/projections/stable-directory.ts`; `src/orchestrator/projections/manifest.ts`; `src/orchestrator/projections/v2-reader-lease.ts`; `src/orchestrator/projections/integrity.ts`; `src/orchestrator/retrieval/candidates.ts`; `src/orchestrator/retrieval/contracts.ts`; `src/orchestrator/runtime/project-store-executor.ts`; `src/orchestrator/runtime/worker-protocol.ts`; `src/orchestrator/parity/v2-snapshot-parity.ts`.
