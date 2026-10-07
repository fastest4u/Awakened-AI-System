# V2 public capability and release coverage — 2026-10-07

Status: **production implementation incomplete**.
Inspection HEAD: `c6e653f0da311e990aa7ff7e70a5b51d4c4f15eb`; product-source baseline: `b1646c1c8d9d04345af6d456be4f5724c7f068d2`. The prior goal turn made progress through committed, independently reviewed readiness/design artifacts. This continuation adds exact requirement coverage while human review of the unchanged [F2 read-workflow specification](../specs/2026-10-07-v2-native-read-workflows-design.md) remains pending.

This is a source-backed coverage audit, not a deployed capability manifest, implementation plan, fresh test run or release approval.

## 1. Exact public inventory

The six controllers attached by `src/app.ts` register **32 legacy tools**: 4 note, 5 write, 6 verify, 3 frontmatter, 7 maintenance and 7 workflow. Prompt registrations are not tools. Root's independent literal-registration extraction agrees with the delegated inventory.

Current `src/v2/app.ts` lists only **`memory_v2Status`**. `src/v2/config.ts` declares content unavailable, and `src/v2/composition.ts` retains `productionReady:false` with closed content admission. None of the 32 legacy tool names is currently exposed as a public V2 workflow.

The [approved fresh-start specification](../specs/2026-09-29-v2-fresh-start-production-design.md), section 5, requires essential workflows and an explicit supported/superseded/unavailable disposition for every old name. It does not require every Markdown behavior to survive. The following labels are **proposed review categories**, not new approval or shipped behavior:

- **Native:** provide a documented V2 equivalent, or make an explicit supported-scope/naming decision where semantics differ.
- **Operator:** supersede ordinary tool invocation with trusted operator diagnostics/maintenance.
- **Unavailable:** disclose typed unavailability; do not invoke V1 or mutate Markdown through V2.

| Legacy tool | Proposed category | V2 behavior / semantic decision | Registration source |
| --- | --- | --- | --- |
| `memory_search` | Native | Scoped projected-content search; public adapter still missing | `src/controllers/note.controller.ts:25` |
| `memory_get` | Native | Stable canonical record ID; no invented Markdown path/body or fuzzy identity fallback | `src/controllers/note.controller.ts:26` |
| `memory_list` | Native | Scoped canonical browsing and honest continuation | `src/controllers/note.controller.ts:27` |
| `memory_recent` | Native | Latest projected state by source-event position, with disclosed ordering | `src/controllers/note.controller.ts:28` |
| `memory_writeSessionLog` | Native | Governed durable session-log command, provenance and idempotent result | `src/controllers/write.controller.ts:18` |
| `memory_writeInsight` | Native | Governed durable insight command | `src/controllers/write.controller.ts:19` |
| `memory_writeMistake` | Native | Governed durable mistake command | `src/controllers/write.controller.ts:20` |
| `memory_writeADR` | Native | Governed durable decision command | `src/controllers/write.controller.ts:21` |
| `memory_createFromTemplate` | Unavailable | Markdown path/directory template semantics excluded; structured commands are separate | `src/controllers/write.controller.ts:22` |
| `memory_verifyVault` | Native | V2 integrity/coverage/privacy/recovery health; never reuse V1 vault health | `src/controllers/verify.controller.ts:10` |
| `memory_verifyNote` | Native | Native record/provenance/governance checks with a versioned schema | `src/controllers/verify.controller.ts:11` |
| `memory_verifySourceTruth` | Native | Define or rename provenance/evidence checks; metadata presence cannot prove factual truth | `src/controllers/verify.controller.ts:12` |
| `memory_findBrokenLinks` | Native | Proposed typed-reference integrity equivalent; rename or typed-unavailable decision required | `src/controllers/verify.controller.ts:13` |
| `memory_findDuplicates` | Native | Native duplicate/conflict analysis; no automatic promotion or resolution | `src/controllers/verify.controller.ts:14` |
| `memory_checkStaleness` | Native | Native verification-age/expiry evidence; distinguish event position from wall time | `src/controllers/verify.controller.ts:15` |
| `memory_validateFrontmatter` | Unavailable | Markdown frontmatter diagnostic semantics | `src/controllers/frontmatter.controller.ts:18` |
| `memory_fixFrontmatter` | Unavailable | Markdown rewrite and backup semantics | `src/controllers/frontmatter.controller.ts:27` |
| `memory_migrateFrontmatter` | Unavailable | Markdown migration/rollback semantics | `src/controllers/frontmatter.controller.ts:36` |
| `memory_bootstrapProject` | Operator | Explicit fresh/resume initialization; existing admin covers foundation only | `src/controllers/maintenance.controller.ts:20` |
| `memory_reindex` | Operator | Verified derived-projection rebuild | `src/controllers/maintenance.controller.ts:21` |
| `memory_indexNote` | Operator | Document projection repair/rebuild supersession; no direct caller mutation of authority | `src/controllers/maintenance.controller.ts:22` |
| `memory_compactVault` | Unavailable | Existing folder/session-digest semantics; any V2 compaction needs a separate governed contract | `src/controllers/maintenance.controller.ts:23` |
| `memory_export` | Unavailable | Registered V1 NOT_IMPLEMENTED stub; curated export is not the required backup workflow | `src/controllers/maintenance.controller.ts:24` |
| `memory_import` | Unavailable | Registered V1 NOT_IMPLEMENTED stub; import is not restore and fresh-start V1 import is excluded | `src/controllers/maintenance.controller.ts:25` |
| `memory_diagnoseWorkspace` | Operator | Redacted trusted binding/build/store diagnostics | `src/controllers/maintenance.controller.ts:26` |
| `memory_sessionStart` | Native | Bound root session ownership and private capability handling | `src/controllers/workflow.controller.ts:10` |
| `memory_contextPack` | Native | V2 scope/consistency before ranking; one-image projected content | `src/controllers/workflow.controller.ts:11` |
| `memory_awaken` | Native | Native state/evidence assessment | `src/controllers/workflow.controller.ts:12` |
| `memory_selfCheck` | Native | Native risk/mistake/evidence assessment with explicit lifecycle semantics | `src/controllers/workflow.controller.ts:13` |
| `memory_sessionEnd` | Native | Governed recoverable end, stable retry identity and named verification profiles | `src/controllers/workflow.controller.ts:14` |
| `memory_lifecycleStatus` | Native | Native session/ownership/end/quality evidence | `src/controllers/workflow.controller.ts:15` |
| `memory_followUpRadar` | Native | Scoped durable open/blocked follow-ups | `src/controllers/workflow.controller.ts:16` |

All **32/32 names are inventoried**, not implemented in V2. Proposed categories total 21 Native / 4 Operator / 7 Unavailable. Choosing typed unavailability for broken Markdown links instead of the proposed reference-integrity replacement would make 20/4/8; that choice is not silently made by this audit.

The legacy `verifySourceTruth` checks source/last-verified/verified-by/confidence metadata in `src/services/vault-health.service.ts`; it does not independently establish factual truth. Broken-link checks resolve Markdown wikilinks. The native equivalents therefore require deliberate names, schemas and response claims.

Root/child continuation, checkpoints, full-evidence capture/finalization and backup/restore/rebuild are additional required V2 capabilities with no complete legacy tool counterpart in this 32-name inventory. A manifest that merely lists the old names would not cover them. Four durable legacy writers create Markdown paths; porting those handlers would not provide governed events, stable IDs, transaction acknowledgment or retry recovery.

## 2. All eight compiled public-service release scenarios

The approved specification section 9 requires the **actual compiled public service** on isolated stores. Every row remains **open at that scope**, even where internal/component evidence exists. Test names below locate the nearest source producers; this continuation did not execute them or recertify historical results.

| # | Required release proof | Nearest existing source producers | Proven component scope and missing public/operational proof |
| --- | --- | --- | --- |
| 1 | Empty first start/reads; first durable write; read-after-write; restart; later-session retrieval | `tests/fresh-start-initializer.test.ts`; `tests/v2-native-content-entry.test.ts`; `tests/v2-retained-evidence-entry.test.ts` | Prepared genesis, private empty/content reads and fixture-fed commit/reopen exist. Public governed first write and later-session retrieval are missing. |
| 2 | Complete session/checkpoint/end; every required public workflow; retries and stable IDs | `tests/lifecycle.crash.test.ts`; `tests/lifecycle.concurrent.test.ts`; `tests/session-end-workflow.test.ts`; native-content entry tests | Internal lifecycle/materialization/replay and private search/get are prerequisites. Public lifecycle, durable writers, list/recent/context/radar/self-check/awaken/verification and a shipped capability disposition are missing. |
| 3 | Instrumented V1 sentinel archive; no reads/results; denied writes; alias/overlap rejection | `tests/v2-foundation-entry.test.ts`; initializer tests; `scripts/smoke-v2-fresh-start.js` | Compiled prepared/status-only isolation and path refusals exist. Enabled public workflows and real read-only archive protection/manifest/denied-write evidence remain unproved. |
| 4 | Foreign project/workspace/session, capability, release/build, generation and unsupported-tool rejection | `tests/fresh-start-admission.test.ts`; `tests/v2-retained-evidence-command.test.ts`; foundation-entry tests | Internal authorization and compiled foundation mismatches fail closed. Enabled public transport/schema authorization and manifest-specific unsupported behavior remain missing. |
| 5 | Before/after-commit process failure; unknown-result recovery; concurrent recovery fence; no lost/duplicate acknowledged commits | Retained-evidence command/entry/replay tests; fresh-start admission tests | Compound rollback/uncertainty, private native acknowledgement loss/reopen replay and dedup/fencing exist. The compiled public workflow/reconnection matrix and common mutation recovery identity contract remain missing. |
| 6 | Verified backup, isolated restore, full replay, compatible software rollback if available; incomplete/incompatible refusal | Maintenance-fence, event-integrity, projection-rebuild and reopen components | These primitives do not assemble backup/restore. Required artifacts/key recovery, acknowledged-tail reconciliation, compatibility, schedule/overdue health, measured recovery time/loss exposure and backup receipts remain absent. |
| 7 | Redaction/encryption/key loss for enabled content; erasure survives restoration | `tests/v2-retained-evidence-redaction.test.ts`; envelope/command tests; `scripts/run-v2-retained-evidence.js` | Private redaction/authenticated envelopes/key refusals are qualified within their original scope. Synthetic surviving providers are not deployed key custody/rotation/recovery. Governed erasure and older-backup restoration fences remain missing. |
| 8 | Bounded projection lag/provider unavailability/operational limits; no indefinite wait or fallback | `tests/v2-internal-verified-read-child.test.ts`; native-content entry/supervisor/gate tests; `tests/retrieval-service.test.ts` | Private deadlines, queue/cleanup/packing limits and process containment exist. Enabled public caller proof, declared provider behavior, deployed operational health/limits and backup-overdue behavior remain missing. |

## 3. Release gate scope

`scripts/run-v2-fresh-start-release.js` is absent. No existing package command produces the complete eight-scenario public-service/recovery release report.

Current component gates cover foundation, internal verified-read, native search/get and private retained evidence. Their tests, source/build measurements, platform limits and historical failures remain useful evidence within those scopes.

The existing `.github/workflows/v2-release-qualification.yml` binds exact candidate/control/workflow blobs, lockfile, OS/run/attempt, emitting phase receipts, compiled outputs, deployment/build identity and five measured artifacts. Its eleven required product outcomes cover installation policy/install/capability, runtime, typecheck, build, default tests, lifecycle, rollout, foundation and artifacts. Its six emitting phase receipts and qualification marker certify that defined CI closure; they do not replace the unimplemented complete public/recovery release producer or activation evidence. Explicit component runners also retain their distinct acceptance scope; default tests alone must not be interpreted as execution of every native acceptance runner.

Before **ready for activation**, deliver essential public workflows/governance, deployed privacy/key recovery and restore-safe erasure, operational V2 backup/recovery, and one unified identity-bound release report satisfying these eight rows plus applicable integrity/isolation/retrieval thresholds.

After readiness, the approved exact target/release still needs V1 archive protection and client cutover, followed by a real normal session, durable write, later retrieval and healthy backup/status on the deployed build. V1 migration is not a fresh-start requirement.

## 4. Execution boundary and verification

The unchanged next F2 written specification at `c6e653f` still awaits human review. This automatically continued goal message is not a human approval of that specification. The selected Superpowers architectural path requires written-spec review before writing-plans, then executable-plan review before implementation; preserve the already chosen Subagent-Driven method.

Two independent read-only audits produced the tool inventory and release-scenario mapping. Root separately extracted the 32 registrations, confirmed all six controllers are attached, re-read current V2 registration/capability source, and natively verified clean inspection HEAD. Document verification checks inventory equality, duplicate absence, eight numbered scenarios, source/reference existence and exact staged scope. No product source, current launch configuration, installed dependencies or live data is changed.
