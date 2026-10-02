# V2 retained evidence privacy foundation

**Status:** Conversational direction and architecture, data, failure and focused-test design approved by the user on 2026-10-02. This written specification awaits human review. Implementation planning, product implementation and production activation have not been approved by this document's publication.
**Source baseline:** `653cb2305ad0e8e91360bd943252da4b6081b05b` on `codex/v2-fresh-start`.
**Authority:** Approved [fresh-start production design](2026-09-29-v2-fresh-start-production-design.md), [host boundary design](2026-09-30-v2-codex-host-boundary-feasibility-design.md), and umbrella sections 8, 9 and 19. Execution remains Subagent-Driven after the written-spec and implementation-plan gates.

## 1 Outcome and scope

Deliver one private, project-local retained-evidence command boundary for F2. A trusted caller can submit bounded visible evidence; the service redacts secrets, encrypts the redacted content, and commits the evidence, source event and canonical command result together. A lost response or restart recovers the original committed result without duplicating evidence or semantic events. Historical empty-evidence events retain their exact hashes and meaning.

This subsystem is not the everyday public V2 replacement. It does not register public content tools, produce governed canonical notes, implement full conversation capture, change desktop configuration, or activate a release. It retains only accepted batches, not an assertion that every eligible host frame was observed. The existing coverage-only path and strict `requireFullEvidence=true` session-end refusal remain unchanged.

Governed memory commands, canonical promotion/correction/conflict policies, erasure and restoration fencing, operational key recovery/rotation, public list/recent/context/radar/lifecycle adapters, and actual Codex desktop qualification remain later F2 work. F3 still owns complete backup/restore and exact-release evidence; F4 owns separately approved cutover and live verification. This design introduces no V1 import, access or fallback.

## 2 Verified starting point

- `src/v2/app.ts` exposes only `memory_v2Status`; `composition.ts` denies content, and `config.ts` keeps `productionReady:false`.
- `storage/event-append-transaction.ts` rejects nonempty evidence refs/digests, hardcodes empty evidence into command planning and SQL, and assigns event IDs during preparation. `StoredEvent` declares empty evidence tuples.
- `storage/event-store.ts` performs `BEGIN IMMEDIATE`, authoritative replay lookup, admission, append, dedup and commit, with a safe unknown-outcome identity after an uncertain commit.
- `crypto/event-hash.ts` supplies established hash domains. `integrity/stored-event-authenticator.ts` already includes evidence refs/digests in event hash material. Command integrity reconstruction currently distinguishes generic commands from lifecycle witnesses only.
- `projections/event-reader.ts` and `projections/source-event-codec.ts` require empty evidence. Unknown historical event names may be `unprojected`; that behavior is not a universal unknown-event rejection rule.
- Lifecycle capability proof, protected command dispatch, maintenance/fresh-start admission and target-session checks are reusable. Coverage commands retain fingerprints and `content-not-retained`, not encrypted bodies. The existing provider seals pending authority, not retained evidence.

These are source observations at the baseline, not passing tests for this new design. The [host qualification report](../reports/2026-09-30-v2-codex-host-qualification.md) remains `host-capability-unverified`.

## 3 Components and trust boundary

Use three focused units under `src/orchestrator/privacy/`: strict evidence contracts/intake, deterministic redaction plus authenticated envelopes, and a retained-evidence command service/repository. Extend the established authoritative transaction and readers only where necessary. Do not create another event store or reuse the Markdown workflow services.

Define a new private versioned `retain-evidence-batch` command, distinct from coverage-only `record-evidence-batch`. Generic append continues to reject evidence and reserves this command and `EvidenceBatchRetained` event against generic submission, even with empty refs. Only a protected, evidence-aware preparation path can construct the internal accepted bundle; a model-supplied command type, hash override or boolean cannot grant access to it.

The caller supplies stable selectors and content, not trusted role/project binding, encryption keys or caller-selected event IDs. The adapter must persist command, idempotency, conversation and frame identities before first send. The backend validates them but cannot prove actual desktop persistence in this slice.

Verify the existing private capability proof and current root/child authority. Reuse evidence coverage's target rules: an owner can record its own root or authorized directly owned child; a child cannot record its root or another child. Bind project/vault/store/workspace/client namespace, target session, parent relation and current owner/capability generations. Revalidate current ownership, live target and mutation/maintenance admission inside the authoritative transaction. Release control generation and session owner generation are separate fences.

Replay also requires trusted authority. A public session, command or frame ID never authorizes retrieval. Store exact admitted authorizing/target generations and binding metadata for evidence-specific replay; do not reinterpret the lifecycle authorization record or let generic `findReplay` bypass it. A lost capability requires the separately trusted recovery path, not a caller assertion.

## 4 Bounded input contract

The first format accepts text and canonical JSON frames only. Each batch has one target session and one conversation. Root/child attribution must agree with that target; separate targets use separate batches. The version-1 command has exactly `version`, `commandType`, `commandId`, `idempotencyKey`, `targetSessionId`, `conversationId` and `frames`; version is 1, command type is `retain-evidence-batch`, and command/idempotency IDs are canonical UUIDv4 values minted before send. Policy/key selection and private capability proof are supplied separately by trusted code, never fields in this command.

Each frame has exactly `frameId`, `ordinal`, `role`, `category`, `occurredAt`, `mediaType`, `content`, `previousFrameId`, `toolCorrelationId` and `artifactHashes`. Session/conversation/frame/correlation selectors are canonical UUIDv4 values; nullable selectors are explicit nulls, not aliases. Ordinals use the existing nonnegative SQLite-int64 decimal format; timestamps use the existing canonical UTC millisecond parser. Artifact hashes are unique lowercase SHA-256 values. Media types are `text/plain; charset=utf-8` with string content and `application/json` with a strict JSON value. Reject malformed Unicode rather than silently replacing it.

Roles are `user`, `assistant` and `tool`. Categories are `user-message`, `assistant-message`, `tool-input`, `tool-output`, `child-report`, `artifact-reference`, `retrieval-feedback` and `user-correction`. User-message/correction require user role, assistant-message/child-report require assistant role, and tool-input/output require tool role and a nonnull stable correlation ID; the remaining categories may use any of those visible roles and have null correlation IDs. A tool-output correlation must resolve to its preceding accepted tool-input in this stream or earlier in the same batch. Other frame categories have null correlations. Use existing identifier/time parsers where these semantics match; reject arbitrary extra fields, accessors, prototypes, sparse arrays and unknown versions. These are backend format choices, not claims about the actual desktop wire schema.

The contract has these fixed initial caps, checked before expensive copying, canonicalization or cryptography:

| Item | Maximum |
| --- | --- |
| Frames per batch | 64 |
| Original UTF-8 content per frame | 65,536 bytes |
| Entire canonical original batch | 1,048,576 bytes |
| Artifact hash references per frame | 32 |
| Redaction rules per policy | 256 |
| Literal pattern per rule | 2,048 UTF-8 bytes |
| Redaction spans per batch | 4,096 |
| Entire encrypted bundle including metadata and wrapped keys | 2,097,152 bytes |
| Private key or policy identifier | 128 Unicode scalars |
| Complete safe result envelope | 16,384 bytes |

Recheck redacted/encrypted sizes after transformation. Exceeding a cap rejects the whole command; never truncate content or skip a frame. Binary import, compression and chunk reassembly are not implemented by this initial format and return a typed unsupported-format/size failure. Their absence remains a public/full-host readiness dependency, not a reason to report complete capture for a large dropped frame.

Within a batch, ordinals are consecutive, frame IDs unique, correlations valid and predecessors consistent. Maintain a retained-stream head per target/conversation, updated in the same transaction: the first new batch starts at ordinal zero with no predecessor; later batches continue the exact committed head. A frame already bound to another command returns a safe frame-identity conflict; callers must recover/retry its original command instead of inventing a replacement batch. Contiguity proves only the accepted stream, not completeness of the host feed or observed categories.

## 5 Redaction before encryption

A trusted, immutable versioned policy applies known credential fields, authorization headers, private-key blocks, configured token rules, explicitly supplied process-secret values and user-defined literal rules. The caller cannot select a weaker policy. Policy metadata contains only non-secret identifiers and permitted structural configuration; do not persist an unkeyed hash of secret rule values. This authoring task reads no real environment secrets or client configuration.

Use deterministic bounded scanners/field rules and bounded literal matching. Do not execute arbitrary regular expressions, callbacks or scripts from tool input. Unsupported rules, unavailable required secret references or too many matches fail before acceptance. A rule cannot opt out of excluding hidden reasoning, private credentials or key material; those must already be excluded by the trusted capture boundary.

The redaction manifest records rule IDs and original UTF-8 byte ranges, never matched secret values. Encrypt the manifest together with the redacted content; expose only allowed counts and policy identity outside it. Apply redaction to content and structured reference/correlation fields that can carry text. Keep identity selectors outside free-text handling and validate their exact bounded types.

No original content enters event payloads, dedup responses, outbox payloads, logs, metrics, temporary files or reports. Canonical memory projections remain a separate governed feature; this command creates no plaintext searchable memory. Mutable transient byte buffers are caller-owned and cleared after use. JavaScript strings and runtime copies cannot be promised secure zeroization; do not claim memory protection against a process/local administrator.

## 6 Encrypted evidence envelope

Follow the approved envelope contract: each item receives a fresh random 256-bit data key, AES-256-GCM with a fresh 96-bit nonce and a 128-bit tag. Associated authenticated data binds format version, project/vault/store IDs, evidence ID, the exact planned event ID, target session/conversation/frame identity, media type and redaction policy identity.

Allocate the event identity through a trusted planning seam before encryption. The same identity must appear in the committed event, blob relation and AAD. A placeholder, caller-chosen identity, changed event allocation or foreign-project bundle must fail. A concurrent losing preparation is discarded and never becomes durable.

Use a purpose-separated private `EvidenceKeyProvider` contract for key wrapping, original-input commitments and redacted-content fingerprints. The provider owns project/store-scoped key selection/status and wrap/unwrap/MAC operations; neither callers nor public results receive key-encryption or fingerprint keys. Do not reuse a session capability or pending-authorization key as an evidence key. No plaintext key file is allowed in the project, vault, database, logs or Git.

Persist only a wrapped data key and non-secret key/version references. Define distinct domains for the keyed commitment to original command input and the HMAC-SHA-256 fingerprint of redacted plaintext. No unkeyed original/redacted plaintext digest is stored. A ciphertext digest covers canonical immutable cipher/AAD metadata, nonce, tag and ciphertext. Bind the initial wrapped-key envelope digest in the event's authenticated payload as well. Any future rewrap is a separately governed change; rotation cannot silently rewrite historical hashes.

The private reader authenticates event/blob correspondence, ciphertext/wrapped-key digests, AAD and GCM tag, and verifies the redacted-content fingerprint under its recorded key/domain before returning redacted content to authorized internal code. Missing, revoked or unavailable required keys and authentication failure return safe typed errors with no plaintext fallback. A synthetic test provider proves this seam, not actual OS-backed credential storage, operational recovery or current desktop isolation.

## 7 Stable intent identity and retries

Equality means the exact bounded original semantic input, including frame metadata/content and stable command identities, not merely identical redacted text. Two different secrets that redact to the same placeholder still conflict if sent under the same idempotency identity.

Define a versioned retained-evidence intent witness containing normalized trusted scope, attribution/admitted generations, command/idempotency IDs, frame identities/order, accepted policy/fingerprint-key versions and a purpose-separated keyed commitment to the original canonical input. It contains no plaintext or private capability. Compute the stable command hash from `project-memory/retained-evidence-command/v1`, a newline, and the canonical witness. Use distinct keyed purposes/domains `retained-evidence-original-input/v1` and `retained-evidence-redacted-content/v1`; their MAC inputs bind project/store identity and the appropriate bounded canonical input. Random data keys, nonces, ciphertext and wrapped-key bytes are excluded from intent equality.

Store the immutable witness in the new retained-evidence event payload, where the existing payload/event hashes authenticate it, and bind evidence-specific authorization metadata to the dedup entry in the same transaction. Extend integrity reconstruction with an exact new command/event branch; do not use the current lifecycle-only `commandHashOverride` as an unvalidated escape hatch.

On retry, inspect the authoritative prior witness under the same trusted binding and use its accepted policy/key versions to compare the original-input commitment. Do not use the current policy/key by default, re-redact/re-encrypt committed data, or replace the accepted bundle. If the needed historical commitment key is unavailable/revoked, fail closed with the original recovery identity; equality is unverified, not a new command. If no prior command exists, use the current approved policy and keys and perform an authoritative duplicate recheck inside the write transaction. If a concurrent winner appears at that recheck, compare against the winner's pinned witness/key, not the loser's newly prepared hash or ciphertext; return the winner only after the same authority/equality checks, and discard the losing prepared bundle.

An identical authorized replay returns the original evidence IDs, event position/range and canonical result. Changed input, changed semantic selectors, a different command under the same idempotency key or unauthorized replay fails. Ordinary replay requires a currently valid private proof matching the exact recorded authorizing and target generations and binding. After an owner/capability transfer, ordinary replay rejects rather than accepting stale proof or disclosing the old result to a new owner automatically. Cross-generation recovery is deferred to a separately defined trusted recovery contract and cannot be implemented through a caller flag in this slice.

Integrity replay can reconstruct the command hash from the stored witness without plaintext or provider access. It proves committed witness/hash correspondence, not independently that an HMAC represents a particular original message. Authorized decryption/fingerprint checks are separate. Preserve this distinction in reports.

## 8 Atomic storage and schema compatibility

Register one new checksummed schema migration after current schema 8. Do not edit migrations 1-8, historical registry checksums or event rows. Add project-local evidence blob, retained-stream-head and evidence-command-authorization storage, with identity constraints, unique frame/command bindings and foreign-key relations to the authoritative event/dedup entries. Initial evidence and authorization rows are immutable; there is no generic update/delete/cleanup API. Future governed erasure requires its own explicit event/tombstone and restoration-fence design.

The new command emits one recognized `EvidenceBatchRetained` event version 1. Its payload carries the bounded intent witness and non-secret evidence/cipher/wrapped-key metadata, never content. Source refs and ordered evidence refs/digests must exactly correspond to the accepted rows. Retain the existing event hash envelope/domain because it already covers payload and evidence digests; its original empty-evidence serialization must remain byte-identical. Use the new intent command-hash domain only for the new command type.

The write sequence is: validate trusted input/authority and bounded intent; recover a prior authorized result if present; plan exact event identity and prepare redacted/encrypted blobs; enter `BEGIN IMMEDIATE`; recheck dedup, authority, stream version, fresh-start and maintenance admission; append the event, blobs, stream head, immutable authorization and one canonical dedup result; commit; acknowledge. Foreign keys may be deferred inside this one transaction where insert ordering requires it. Nothing becomes acknowledged before commit.

A pre-commit failure leaves no event, blob, head or dedup effect. A failure after possible commit yields the established unknown-outcome identity. Recovery uses V2's original command identity; never create a new command or fall back to V1. Crypto preparation before the transaction does not bypass the authoritative duplicate/admission recheck.

Extend all strict stored-event readers, authenticators, command-integrity reconstruction, lifecycle reads and projection source decoders that encounter these rows. Legacy commands still require empty evidence; the new branch validates exact supported witness/envelope/ref shapes and row correspondence. The retained-evidence event advances the projection position without producing canonical items or decrypting raw evidence. Unsupported retained-evidence versions/shapes fail integrity checks; preserve unrelated historical `unprojected` behavior. Existing projection schema 2 is not renamed or falsely advertised as an evidence catalog.

## 9 Admission and safe failures

The command remains a protected internal backend operation, not a public MCP tool. Add only the necessary private dispatch/decoder contract; do not modify `V2_CAPABILITIES`, public registration, promotion denial or `productionReady:false`. Apply the existing fresh-start connection and maintenance mutation guards. Prepared/disabled/recovery production bindings still reject mutations; an isolated backend fixture is not permission to bypass these states.

Provider work in this slice is bounded local cryptography through trusted injected implementations, with no network/secret-service discovery or real-host installation. Validate input/transform caps and keep the existing bounded storage-busy behavior. The implementation plan must identify actual request/runtime budget and cancellation seams before adding a worker operation. A check after an uninterruptible call is not proof of an end-to-end deadline; do not invent a hard timing guarantee from these data bounds.

Failures use closed non-secret codes for invalid format/limit, policy unavailable, frame/order conflict, foreign/unauthorized scope, key unavailable, integrity failure, idempotency conflict, admission refusal and command outcome unknown. Wrap provider/native errors; never serialize raw input, paths, secret values, key handles or exception messages. Return only allowed stable IDs, retention format, target scope assertions, event position and retry/recovery disposition. A receipt may state that its batch was retained; it must not say `full-adapter`, complete host capture, successful strict session end or whole-system readiness.

## 10 Focused acceptance evidence

Use isolated owned temporary stores and synthetic credentials/content. Bootstrap real schema/authority/transaction primitives, not hand-built hashes or a fake active production release. Backend happy-path fixtures are not the compiled public fresh-start service. Independently exercise real prepared/recovery/disabled fresh-start rejection without changing those guards.

| Proof | Required observation |
| --- | --- |
| Redaction and secrecy | All enabled rule categories redact before encryption; known synthetic secrets absent from persisted JSON/rows, safe results/errors, outbox/log/report surfaces; private keys never appear |
| Envelope authentication | Authorized internal read recovers only redacted content; changed ciphertext/tag/nonce/AAD/project/event/media/key envelope refuses |
| Missing key or policy | No semantic/blob/dedup/head commit and no plaintext fallback; revoked historical retry key refuses without a replacement command |
| Retry and restart | Exact retry, lost response and restarted service recover identical committed IDs/ciphertext/result; changed original text that redacts identically still conflicts |
| Concurrent duplicate | Two preparations race at the authoritative boundary; one accepted bundle/event/result, no losing blob or head movement |
| Transaction faults | Actual faults before commit roll back every effect; after possible commit recover original identity without a duplicate |
| Scope and authority | Foreign project/workspace/client/session, sibling/child-to-root, stale owner/capability and unauthorized replay reject before disclosure; release/maintenance fences rechecked inside transaction |
| Frames and limits | Gaps/predecessor/correlation/duplicate/version/hostile-shape and exact cap boundaries fail for their intended reason; no dropped/truncated frame |
| Old and new integrity | Original empty-event hash/checksum witnesses unchanged; mixed retained/legacy chain and new command witness reconstruct/replay; malformed refs or missing blob refuse |
| Projection and status | New event advances position but creates no canonical content; unknown historical unprojected behavior preserved; public status-only/full-evidence denial remains |

Use real focused RED/GREEN for new behavior, then affected source tests, typecheck/build and relevant increment acceptance after independent reviews. The executable plan must enumerate exact files/commands and retained evidence identities from the implementation, not guess a passing count here. Do not rerun the full suite for every scenario or delete migration tests. Reuse unchanged historical evidence only at its original scope; final exact-release qualification remains F3.

## 11 Handoff and remaining production work

After human approval of this written spec, prepare one concrete reviewed implementation plan for contracts/redaction/envelopes, schema/atomic command/replay, strict readers/private dispatch and compiled isolated acceptance. Preserve Subagent-Driven without asking for the method again. If a real key provider, runtime budget or recovery mechanism requires a new interface or authority, expose it rather than fabricate support or expand this scope silently.

Completion language is **private retained-evidence foundation accepted**, not F2 complete or PROD ready. Later work must provide governed canonical memory, erasure/rotation/key recovery, large-frame handling, public workflows and actual supported desktop capture/private persistence/finalization. Only after F3 exact-release/recovery proof and separately approved F4 deployment/live verification can V2 be declared operational for its stated capabilities.

Authoring self-review checked placeholders, scope, ambiguity and consistency with the approved conversational design and inspected source. It clarified exact frame fields, pinned retry comparison, ordinary replay generation checks and historical unprojected behavior. Relative document links and listed source paths resolve. No runtime tests/builds, actual-host probe or deployment proof is created by publishing this document.

## 12 Source references

- [Umbrella evidence and event contracts](2026-07-11-full-event-sourced-memory-orchestrator-design.md).
- [Fresh-start delivery roadmap](../plans/2026-09-29-v2-fresh-start-delivery-roadmap.md).
- [Accepted private native content design](2026-10-02-v2-native-content-query-design.md).
- `src/orchestrator/contracts/event.ts`; `storage/event-store.ts`; `storage/event-append-transaction.ts`; `storage/migrations/registry.ts`.
- `src/orchestrator/crypto/event-hash.ts`; `integrity/stored-event-authenticator.ts`; `integrity/event-integrity.service.ts`.
- `src/orchestrator/lifecycle/capability.service.ts`; `lifecycle/contracts/commands.ts`; `lifecycle/evidence-coverage.service.ts`; `lifecycle/authority/capability-key-provider.ts`.
- `src/orchestrator/fresh-start/fresh-start-admission.ts`; `runtime/lifecycle-worker-runtime.factory.ts`; `runtime/lifecycle-worker-protocol.ts`.
- `src/orchestrator/projections/event-reader.ts`; `projections/source-event-codec.ts`; `src/v2/app.ts`; `src/v2/composition.ts`; `src/v2/config.ts`.
