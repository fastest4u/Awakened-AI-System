# V2 Fresh-Start Production Release Evidence

## Summary

This document records the compiled-artifact verification evidence for the V2 Fresh-Start production cutover gate (`npm run verify:v2-fresh-start-release` / `node scripts/run-v2-fresh-start-release.js`).

- **Status**: `ready-for-activation` (Release Qualification) / `live-operation-verified` (F4 Live Cutover)
- **Production Ready**: `true`
- **Schema Version**: `1`
- **Build Identity Hash**: `8eb071df26881b26c93a99dd4f0a83a7622256536d4f671e8523db8bca295843`
- **Schema Identity Hash**: `f10eb1976f2fd97d899163d930a91e21f66daaccf448a76334d5c9b13ffd6df1`
- **Capability Manifest Hash**: `69b56af9f0b267422e6e241d90cae312111a12caf45dae9dde47eacfe5f16870`
- **Recovery Policy Hash**: `ac2e271e0320cdb0797316a61ab2edc3f42fa8f0926c51623c95eae0cef8a7c8`
- **Report Digest**: `4cad0bcd5bbe2be66f2df2daa6261513e7fc6ada50d013154a7a79053d086580`
- **Generated At**: `2026-10-21T03:05:02.409Z`

---

## Verified Compiled Artifacts

All 8 release scenarios were executed against the compiled `dist/` bundle:

1. `dist/v2.js`
2. `dist/v2-admin.js`
3. `dist/v2-build.json`
4. `dist/workers/project-store.worker.js`
5. `dist/internal/v2-internal-verified-read.js`
6. `dist/internal/v2-internal-verified-read-cleanup.js`

---

## 8-Scenario Verification Matrix

| Scenario ID | Description | Result |
|---|---|---|
| `scenario-1-empty-start-write-restart-retrieval` | Empty start (`memory_search`, `memory_list`, `memory_recent`, `memory_contextPack`, `memory_followUpRadar`), first governed write (`memory_writeInsight`), immediate `memory_get` read-after-write, process restart, and later-session retrieval (`memory_search` + `memory_get`). | `passed: true` |
| `scenario-2-public-workflows-and-governance` | Complete public MCP workflow (`memory_sessionStart` -> `memory_writeInsight` / `memory_writeMistake` / `memory_writeADR` / `memory_writeSessionLog` -> `memory_checkpoint` -> `memory_sessionEnd` / `memory_amendSessionEnd` / `memory_cancelSessionEnd`), child session saga (`memory_sessionFork` -> `memory_recordChildResult` -> `memory_completeChildSession`), governance transitions (`memory_promote`, `memory_supersede`, `memory_retract`, `memory_expire`), and verification tools (`memory_verifyVault`, `memory_verifyNote`, `memory_verifySourceTruth`, `memory_findDuplicates`, `memory_checkStaleness`). | `passed: true` |
| `scenario-3-v1-archive-isolation-and-path-overlap` | Runtime V1 archive zero-access sentinel verification (`NODE_OPTIONS=--import` filesystem access monitor), `FRESH_START_PATH_OVERLAP` refusal on overlapping vault/archive roots, and explicit operator `freeze-v1-archive` / `verify-v1-archive` write-denial verification. | `passed: true` |
| `scenario-4-binding-capability-and-generation-refusals` | Wrong `releaseId` refusal (`FRESH_START_RELEASE_MISMATCH`), replayed/stale control generation approval refusal, foreign session binding refusal (`FRESH_START_INPUT_INVALID`), unavailable V1 tool refusals (`FRESH_START_CAPABILITY_UNAVAILABLE`), and operator-only V1 tool refusals (`FRESH_START_OPERATOR_ONLY_TOOL`). | `passed: true` |
| `scenario-5-crash-recovery-and-idempotent-fencing` | Abrupt post-commit process termination (`SIGKILL`), session lease recovery (`memory_recoverSession`), idempotent retry returning identical `recordId` without duplicating events, and `read-only-recovery` mode write fencing (`FRESH_START_ADMISSION_DENIED`) with read availability (`memory_get`). | `passed: true` |
| `scenario-6-verified-backup-isolated-restore-replay-and-rollback` | Verified backup creation (`v2-admin.js backup`), isolated restore with post-backup event replay (`v2-admin.js restore`), recovery & rollback compatibility verification (`v2-admin.js verify-recovery`), and incomplete recovery fence detection (`status: "incomplete-fence"`, `missingRange`). | `passed: true` |
| `scenario-7-privacy-redaction-encryption-key-rotation-and-erasure-after-restore` | Secret redaction before SQLite persistence (`fixture_secret_*` absent from raw `events.sqlite` bytes), cryptographic evidence erasure (`memory_forgetEvidence`), wrap-key rotation, and verification that erasure remains effective after restoring from a pre-erasure backup plus post-backup event log. | `passed: true` |
| `scenario-8-bounded-failures-and-operational-limits` | Bounded failure codes on malformed/invalid inputs (`FRESH_START_INPUT_INVALID`), bounded Projection Schema 3 rebuild (`v2-admin.js rebuild-projections`), and deterministic 7-client MCP configuration generation (`v2-admin.js generate-client-configs`). | `passed: true` |

---

## Canonical Release Evidence Report JSON

```json
{"buildIdentityHash":"8eb071df26881b26c93a99dd4f0a83a7622256536d4f671e8523db8bca295843","capabilityManifestHash":"69b56af9f0b267422e6e241d90cae312111a12caf45dae9dde47eacfe5f16870","generatedAt":"2026-10-21T03:05:02.409Z","productionReady":true,"recoveryPolicyHash":"ac2e271e0320cdb0797316a61ab2edc3f42fa8f0926c51623c95eae0cef8a7c8","reportDigest":"4cad0bcd5bbe2be66f2df2daa6261513e7fc6ada50d013154a7a79053d086580","scenarios":[{"id":"scenario-1-empty-start-write-restart-retrieval","passed":true},{"id":"scenario-2-public-workflows-and-governance","passed":true},{"id":"scenario-3-v1-archive-isolation-and-path-overlap","passed":true},{"id":"scenario-4-binding-capability-and-generation-refusals","passed":true},{"id":"scenario-5-crash-recovery-and-idempotent-fencing","passed":true},{"id":"scenario-6-verified-backup-isolated-restore-replay-and-rollback","passed":true},{"id":"scenario-7-privacy-redaction-encryption-key-rotation-and-erasure-after-restore","passed":true},{"id":"scenario-8-bounded-failures-and-operational-limits","passed":true}],"schemaIdentityHash":"f10eb1976f2fd97d899163d930a91e21f66daaccf448a76334d5c9b13ffd6df1","schemaVersion":1,"status":"ready-for-activation"}
```

---

## F4 Live Cutover & Production Operation Receipt (`live-operation-verified`)

Following explicit user authorization (`Option (A)`), F4 Live Cutover was executed on `C:\Users\Server\Desktop\Awakened-AI-System`:

- **Live Project Root**: `C:\Users\Server\Desktop\Awakened-AI-System`
- **Live V2 Vault Root**: `C:\Users\Server\Desktop\Awakened-AI-System\memory-v2`
- **Frozen V1 Archive Root**: `C:\Users\Server\Desktop\Awakened-AI-System\memory`
- **Project ID**: `4111e02a-6f30-4425-acef-967641cff6bc`
- **Vault ID**: `68e7e9ab-8ec5-488e-a2f0-eb84887919ac`
- **Store ID**: `dc9b7303-ef48-41c0-b668-b581f03e3a5f`
- **Release ID**: `d45b1956-e05b-4316-b68d-7014d7dda665`
- **Gate 1 — Frozen & Verified V1 Archive**:
  - `fileCount`: `1525` (`verifiedFiles`: `1525`, `writeDenied`: `true`)
  - `manifestSha256`: `3cf58085b8871d8353f8bb8019539f36ca13e35d7b311e3792c241bf934c4680`
- **Gate 2 — Operator Approval & Active V2 Store**:
  - `approvalId`: `dc662237-e674-4418-bdc9-7e31931e9fbe`
  - `requestDigest`: `05b8dff43435254b5681584f45a4bd0aaa5a4781704b4ab15d3f37440d08bb4e`
  - `mode`: `active`, `generation`: `1`, `productionReady`: `true`, `schemaVersion`: `9`
- **Generated Client MCP Configurations**:
  - `.codex/config.toml`
  - `opencode.json`
  - `.antigravity/mcp.json`
  - `.cursor/mcp.json`
  - `.zed/settings.json`
  - `.windsurf/mcp.json`
  - `.mcp.json`
  - `.claude/settings.local.json`
- **Live V2 MCP Stdio Verification**:
  - Verified `memory_v2Status`, `memory_sessionStart`, `memory_contextPack`, `memory_selfCheck`, `memory_writeADR` (`recordId: 8f7942d6-a5b6-4b32-8db6-5d5303a1b4c7`), `memory_get`, `memory_search`, `memory_verifyVault`, and `memory_sessionEnd`.
- **Initial Verified V2 Backup & Recovery Check**:
  - `backupId`: `630940e2-ea86-4336-aa9d-ae67356aeed4`
  - `backupManifestDigest`: `31dd6afed59b926ca3d74ff9c6afd1bc01e32b3ef91ab7936634d2625fd0bb82`
  - `verify-recovery`: `ok: true`, `healthy: true`, `compatible: true`

