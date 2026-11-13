# V2 Next-Gen AI Memory Intelligence & P0/P1 Engine Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 28s+ projection reconciliation latency cliff (P0), fix the home `projectRoot` self-routing overlap error (P1), and upgrade Project Memory V2 with 4 autonomous AI intelligence capabilities: Git-Diff Auto-Context, 1-Call Auto-Verify & Task Binding, Bilingual Technical Synonym + Causal Triad Boosting, and Session-End Autonomous Curation.

**Architecture:**
1. **In-Process Stable Projection Inspection (`src/orchestrator/projections/stable-directory.ts`):** Replace `spawnSync` child-process invocations in read/verification operations (`captureRetiredGeneration`, `readReconciliationRetirements`, `assertGeneration`, `captureManifest`) with direct in-process verification plus a `dev:ino:size:ctimeNs`-keyed SHA-256 cache for immutable retired SQLite files, preserving all symlink/hardlink/lock-token/directory-identity/sidecar invariants.
2. **Self-Root Early Return (`src/v2/composition.ts`):** In `resolveRoutedFoundation`, check if `resolvedTarget === resolve(paths.projectRoot)` or `canonicalTarget === paths.projectRoot` before checking `freshStartPathContains(resolvedTarget, paths.v1ArchiveRoot)`.
3. **Autonomous AI Intelligence (`src/v2/public-tools.ts`):**
   - Auto-merge dirty/untracked files from `#inspectLiveWorkspaceState()` into `plannedFiles` when `plannedFiles` is omitted in `memory_sessionStart` and `memory_selfCheck`.
   - Bind `taskSummary` during `memory_sessionStart` via an initial checkpoint and default `autoVerify: true` in `#handleWriteGovernedNote` to auto-promote notes to `verified` in one call.
   - Expand `#tokenizeMultilingual` with a curated Thai ↔ English technical synonym dictionary and boost sibling `insight`/`adr` notes connected to matched `mistake` notes (`Causal Triad Boosting`).
   - Auto-promote remaining session `candidate` notes during `#handleSessionEnd` and return `curationSummary`.

**Tech Stack:** TypeScript, Node.js (`node:fs`, `node:crypto`, `node:sqlite`), Project Memory V2 MCP Runtime.

---

### Task 1: P0 Fix — Fast In-Process Retired Generation & Manifest Inspection (`src/orchestrator/projections/stable-directory.ts`)

**Files:**
- Modify: `src/orchestrator/projections/stable-directory.ts`
- Test: `tests/v2-ai-ide-acceleration.test.ts`
- Regression Test: `tests/projection-coordinator.test.ts`

- [ ] **Step 1: Write failing test in `tests/v2-ai-ide-acceleration.test.ts`**
  Assert that `filesystemStableProjectionDirectoryOperations.captureRetiredGeneration` and `readReconciliationRetirements` across 60 retired generations execute in `< 300ms` total while still enforcing lock-token and sidecar integrity checks.
- [ ] **Step 2: Run test to verify failure or baseline**
- [ ] **Step 3: Implement in-process `captureRetiredGeneration`, `readReconciliationRetirements`, `assertGeneration`, and `captureManifest` with stat-keyed SHA-256 caching in `src/orchestrator/projections/stable-directory.ts`**
- [ ] **Step 4: Run `tests/projection-coordinator.test.ts` and `tests/v2-ai-ide-acceleration.test.ts` to verify all invariants pass**

---

### Task 2: P1 Fix — Home `projectRoot` Self-Routing (`src/v2/composition.ts`)

**Files:**
- Modify: `src/v2/composition.ts`
- Test: `tests/v2-ai-ide-acceleration.test.ts`

- [ ] **Step 1: Write failing test in `tests/v2-ai-ide-acceleration.test.ts`**
  Create a fixture where `v1ArchiveRoot` is `<projectRoot>/memory` (matching production layout) and invoke `memory_lifecycleStatus` with `projectRoot: fixture.projectRoot`. Confirm it fails with `FRESH_START_PATH_OVERLAP` before the fix.
- [ ] **Step 2: Update `resolveRoutedFoundation` in `src/v2/composition.ts`**
  Return `null` immediately when `resolvedTarget === resolve(paths.projectRoot)` or after canonical resolution when `canonicalTarget === paths.projectRoot`, prior to checking `v1ArchiveRoot` overlap.
- [ ] **Step 3: Run test to verify it passes**

---

### Task 3: Next-Gen AI Memory Intelligence Strategies 1–4 (`src/v2/public-tools.ts`)

**Files:**
- Modify: `src/v2/public-tools.ts`
- Test: `tests/v2-ai-ide-acceleration.test.ts`

- [ ] **Step 1: Write failing tests in `tests/v2-ai-ide-acceleration.test.ts`** covering:
  1. Git-Diff Auto-Context in `memory_sessionStart` and `memory_selfCheck` when `plannedFiles` is omitted.
  2. 1-Call Auto-Verify (`autoVerify: true` by default in `memory_writeInsight` / `memory_writeADR` / `memory_writeMistake`, opt-out via `autoVerify: false`) and immediate `currentTask` binding in `memory_sessionStart`.
  3. Bilingual Thai ↔ English technical synonym search (e.g., Thai query `"ฐานข้อมูลค้างและช้า"` finding English notes with `"sqlite"`, `"timeout"`, `"latency"`) and Causal Triad Boosting (`mistake` match boosts sibling `insight` and `adr` from the same session/files).
  4. Autonomous Curation on `memory_sessionEnd` (`curationSummary` auto-promoting candidate notes created in the session).
- [ ] **Step 2: Implement Strategies 1–4 in `src/v2/public-tools.ts`**
- [ ] **Step 3: Compile and run `tests/v2-ai-ide-acceleration.test.ts` and `tests/v2-webui-and-curator.test.ts`**

---

### Task 4: Build, Sync Build Identity, and Complete Project Memory V2 Session

**Files:**
- Build output: `dist/`

- [ ] **Step 1: Run `npm run build` and `node dist/v2-admin.js sync-build --project-root "C:\Users\Server\Desktop\Awakened-AI-System"`**
- [ ] **Step 2: Record ADR (`memory_writeADR`) and Insight (`memory_writeInsight`), end session (`memory_sessionEnd`), and verify (`memory_verifyVault` / `memory_v2Status`)**
