# Project Memory V2 Fresh-Start Production Operations Runbook

## 1. Overview & Architecture Posture

Project Memory V2 runs in an isolated fresh-start store (`events.sqlite`, `custody-recovery.sqlite`, and immutable Projection Schema 3 SQLite images) under `<v2-vault-root>/.memory-mcp/v2` while preserving the legacy V1 Markdown vault at `<v1-archive-root>` as a cryptographically verified read-only archive.

- **Public MCP Entrypoint**: `dist/v2.js`
- **Local Operator Administration CLI**: `dist/v2-admin.js`
- **Release Qualification Verifier**: `scripts/run-v2-fresh-start-release.js` (`npm run verify:v2-fresh-start-release`)

Every V2 process requires four explicit, canonical, absolute environment bindings:
- `MEMORY_PROJECT_ROOT`
- `MEMORY_V2_VAULT_PATH`
- `MEMORY_V1_ARCHIVE_PATH`
- `MEMORY_V2_RELEASE_ID`

---

## 2. Step-by-Step Deployment & Activation Cutover

### Step 1: Build and Measure Compiled V2 Artifacts

```bash
npm run build
```

This emits `dist/v2.js`, `dist/v2-admin.js`, `dist/workers/project-store.worker.js`, `dist/internal/v2-internal-verified-read.js`, `dist/internal/v2-internal-verified-read-cleanup.js`, and `dist/v2-build.json`.

### Step 2: Freeze and Verify the V1 Archive

Before activating V2, freeze the legacy V1 archive directory so all files are marked read-only (`0444`) and recorded in `<v2-vault-root>/.memory-mcp/v1-archive-manifest.json`:

```bash
node dist/v2-admin.js freeze-v1-archive \
  --project-root "/abs/path/to/project" \
  --v2-vault-root "/abs/path/to/project/memory-v2" \
  --v1-archive-root "/abs/path/to/project/memory"

node dist/v2-admin.js verify-v1-archive \
  --project-root "/abs/path/to/project" \
  --v2-vault-root "/abs/path/to/project/memory-v2" \
  --v1-archive-root "/abs/path/to/project/memory"
```

### Step 3: Run the 8-Scenario Compiled Release Qualification Gate

```bash
node scripts/run-v2-fresh-start-release.js --output "/abs/path/to/release-evidence.json"
```

Verify that the emitted JSON has `"status": "ready-for-activation"`, `"productionReady": true`, and all 8 scenarios `"passed": true`. Use its `reportDigest` as `release.evidenceDigest` in your `release-manifest.json`.

### Step 4: Initialize the Fresh-Start Store (`prepared` Mode)

```bash
node dist/v2-admin.js initialize-fresh \
  --project-root "/abs/path/to/project" \
  --v2-vault-root "/abs/path/to/project/memory-v2" \
  --v1-archive-root "/abs/path/to/project/memory" \
  --release-manifest "/abs/path/to/release-manifest.json"
```

If interrupted during preparation, resume idempotently with `resume-initialization`.

### Step 5: Sign Operator Approval and Activate (`prepared` -> `active`)

Set `MEMORY_V2_OPERATOR_APPROVAL_KEY` (minimum 16 UTF-8 bytes) in the operator shell, mint a single-use HMAC-SHA256 operator approval envelope bound to the store's current generation and `requestDigest`, and transition the store to `active`:

```bash
export MEMORY_V2_OPERATOR_APPROVAL_KEY="<operator-secret-key>"

node dist/v2-admin.js sign-approval \
  --project-root "/abs/path/to/project" \
  --v2-vault-root "/abs/path/to/project/memory-v2" \
  --v1-archive-root "/abs/path/to/project/memory" \
  --release-manifest "/abs/path/to/release-manifest.json" \
  --next-mode active \
  --output "/abs/path/to/approval-activate.json"

node dist/v2-admin.js activate \
  --project-root "/abs/path/to/project" \
  --v2-vault-root "/abs/path/to/project/memory-v2" \
  --v1-archive-root "/abs/path/to/project/memory" \
  --release-manifest "/abs/path/to/release-manifest.json" \
  --operator-approval "/abs/path/to/approval-activate.json" \
  --release-evidence "/abs/path/to/release-evidence.json"
```

---

## 3. Client Configuration Generation & Cutover

Generate validated MCP client configurations for all 7 supported clients (Codex, OpenCode, Antigravity, Cursor, Zed, Windsurf, and Claude Code):

```bash
node dist/v2-admin.js generate-client-configs \
  --project-root "/abs/path/to/project" \
  --v2-vault-root "/abs/path/to/project/memory-v2" \
  --v1-archive-root "/abs/path/to/project/memory" \
  --release-id "<release-uuid>" \
  --output-dir "/abs/path/to/generated-client-configs"
```

Written files under `--output-dir`:
- `.codex/config.toml`
- `opencode.json`
- `.antigravity/mcp.json`
- `.cursor/mcp.json`
- `.zed/settings.json`
- `.windsurf/mcp.json`
- `.mcp.json` and `.claude/settings.local.json`

---

## 4. Backup, Isolated Restore, Recovery & Rollback Operations

### Create a Fenced Backup (`VACUUM INTO`)

```bash
node dist/v2-admin.js backup \
  --project-root "/abs/path/to/project" \
  --v2-vault-root "/abs/path/to/project/memory-v2" \
  --v1-archive-root "/abs/path/to/project/memory" \
  --backup-root "/abs/path/to/backups/snapshot-001" \
  --reason manual
```

### Verify Backup Health and Rollback Compatibility

```bash
node dist/v2-admin.js verify-recovery \
  --project-root "/abs/path/to/project" \
  --v2-vault-root "/abs/path/to/project/memory-v2" \
  --v1-archive-root "/abs/path/to/project/memory"
```

### Rebuild Projection Schema 3

```bash
node dist/v2-admin.js rebuild-projections \
  --project-root "/abs/path/to/project" \
  --v2-vault-root "/abs/path/to/project/memory-v2" \
  --v1-archive-root "/abs/path/to/project/memory"
```

### Restore to an Isolated Vault with Post-Backup Replay and Pre-Read Erasure Fencing

```bash
node dist/v2-admin.js restore \
  --project-root "/abs/path/to/restored-project" \
  --v2-vault-root "/abs/path/to/restored-project/memory-v2" \
  --v1-archive-root "/abs/path/to/project/memory" \
  --backup-root "/abs/path/to/backups/snapshot-001" \
  --post-backup-vault-root "/abs/path/to/project/memory-v2"
```

### Enter / Exit Read-Only Recovery or Disable Store

Use `sign-approval` with `--next-mode read-only-recovery`, `--next-mode active`, or `--next-mode disabled`, followed by `enter-recovery`, `exit-recovery`, or `disable` with `--operator-approval` and `--release-evidence`.
