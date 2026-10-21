# Implementation Plan: Project Memory V2 Awakening, Retrieval Precision & Multi-Project Support

**Goal:** Upgrade Project Memory V2 (`src/v2/`) with rich MCP tool schemas, hybrid Soft-OR/Thai & cross-session retrieval, autonomous awakening (`memory_awaken`), active pre-flight guardrails (`memory_selfCheck`), structured checkpoints, and multi-project routing + one-command project bootstrapping (`bootstrap-project`, `sync-build`).

**Architecture:** All enhancements are implemented cleanly inside `src/v2/public-tools.ts`, `src/v2/composition.ts`, `src/v2/app.ts`, and `src/v2/admin.ts` without altering low-level `src/orchestrator/` unit-tested primitives, preserving 100% backward compatibility with existing V2 tests while unlocking multi-project autonomy.

---

### Task 1: Write Failing TDD Test Suite (`tests/v2-awakening-and-multiproject.test.ts`)

**Files:**
- Create: `tests/v2-awakening-and-multiproject.test.ts`

- [ ] **Step 1: Write failing tests for all 6 capabilities**
  1. Rich `inputSchema.properties` across all 33 V2 content tools (including `projectRoot`, `query`, `area`, `title`, `summary`, `content`, `nextActions`, `blockers`, `filesTouched`).
  2. Hybrid Soft-OR / multi-word & Thai query retrieval + cross-session visibility when a new session starts.
  3. Autonomous `memory_awaken` returning `continuity`, `workspaceState`, `governanceAlerts`, and `autonomousAgenda`.
  4. Active `memory_selfCheck` returning `pastMistakesToAvoid`, `bindingADRs`, `openConflicts`, `riskLevel`, and `preFlightChecklist`.
  5. Structured `memory_checkpoint` & `memory_sessionEnd` preserving `completedItems`, `inProgressItems`, `blockers`, `nextActions`, `decisions`, and `filesTouched`.
  6. Multi-project `projectRoot` routing across two distinct projects + `runV2Admin(["bootstrap-project", ...])` and `runV2Admin(["sync-build", ...])`.
- [ ] **Step 2: Run the test suite to verify it fails (RED)**
  Run: `node --import tsx --test tests/v2-awakening-and-multiproject.test.ts`

---

### Task 2: Implement Rich Schemas, Cross-Session Hybrid Retrieval, Awakening, Self-Check & Structured Checkpoints (`src/v2/public-tools.ts`)

**Files:**
- Modify: `src/v2/public-tools.ts`

- [ ] **Step 1: Add `TOOL_INPUT_PROPERTIES` map in `src/v2/public-tools.ts`**
  Populate `inputSchema.properties` for all 33 tools in `buildPublicToolDefinitions()`.
- [ ] **Step 2: Upgrade `#resolveReadSessionId` and add cross-session + hybrid Soft-OR/substring scoring**
  Ensure new sessions can read notes from previous sessions and multi-word/Thai queries fall back to tokenized & substring scoring across `canonical_items` and `governed_notes`.
- [ ] **Step 3: Upgrade `checkpointDraftFromArgs`, `#handleCheckpoint`, and `#handleSessionEnd`**
  Accept and persist `completedItems`, `inProgressItems`, `blockers`, `nextActions`, `decisions`, `filesTouched`.
- [ ] **Step 4: Upgrade `#handleSelfCheck` and `#handleAwaken`**
  Synthesize `pastMistakesToAvoid`, `bindingADRs`, `openConflicts`, `riskLevel`, `preFlightChecklist` in `#handleSelfCheck`, and `continuity`, `workspaceState`, `governanceAlerts`, `autonomousAgenda` in `#handleAwaken`.

---

### Task 3: Implement Multi-Project Dynamic Routing & Operator `bootstrap-project` / `sync-build` (`src/v2/admin.ts`, `src/v2/composition.ts`, `src/v2/app.ts`)

**Files:**
- Modify: `src/v2/admin.ts`
- Modify: `src/v2/composition.ts`
- Modify: `src/v2/app.ts`

- [ ] **Step 1: Add `bootstrapProjectV2` and `syncProjectBuildV2` helpers + CLI commands `bootstrap-project` and `sync-build` in `src/v2/admin.ts`**
- [ ] **Step 2: Add dynamic `projectRoot` routing in `src/v2/composition.ts` and `src/v2/app.ts`**
  Allow any tool invocation passing `projectRoot` (or `workspaceRoot`) to route to (and auto-bootstrap/sync if needed) that target project's isolated `V2Foundation`.

---

### Task 4: Build, Verify & Roll Out to All Workspace Projects

- [ ] **Step 1: Build TypeScript & bundle (`npm run build`)**
- [ ] **Step 2: Run new and existing V2 test suites (GREEN)**
  - `node --import tsx --test tests/v2-awakening-and-multiproject.test.ts`
  - `node --import tsx --test tests/v2-public-mcp-tools.test.ts`
  - `node scripts/smoke-worker.js`
- [ ] **Step 3: Sync/Bootstrap all local projects (`Awakened-AI-System`, `SPX`, `api gateway`, `laravel`) and update Antigravity MCP schema cache**
- [ ] **Step 4: Record ADR & Insight in Project Memory V2 and close session with `memory_sessionEnd`**
