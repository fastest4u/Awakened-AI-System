# Project Memory V2 Phase 2: AI + IDE Acceleration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Project Memory V2 with 1-call atomic `memory_sessionStart` bundling, universal parameter synonym normalization, file-path & code-symbol memory graph matching, native Thai `Intl.Segmenter` + IDF hybrid ranking, MCP Resources & Prompts, opt-in auto-heal build identity sync, and automatic `.antigravity/MEMORY_RULES.md` materialization.

**Architecture:** Extend `V2PublicToolRouter` in `src/v2/public-tools.ts` for atomic startup bundling, file/symbol extraction, Thai `Intl.Segmenter` + IDF scoring, parameter synonym normalization, and `.antigravity/MEMORY_RULES.md` sync. Extend `runV2Server` in `src/v2/app.ts` with MCP `resources` and `prompts` handlers, and `createV2Foundation` in `src/v2/composition.ts` with opt-in `MEMORY_V2_AUTO_SYNC_BUILD=1` build-hash self-healing.

**Tech Stack:** TypeScript 5.8, Node.js 24 (`node:sqlite`, `Intl.Segmenter`, `node:test`), `@modelcontextprotocol/sdk`, esbuild.

**Spec:** `docs/superpowers/specs/2026-10-21-v2-ai-ide-acceleration-design.md`

## Global Constraints

- Node.js 24 builtin-only runtime imports in emitted V2 bundles (`scripts/build.js` `assertClosedSyntax` and `freshStartBuild` rules).
- Zero reads or writes inside `v1ArchiveRoot` (`memory/`).
- Preserve all existing behavior enforced by `tests/v2-foundation-entry.test.ts`, `tests/v2-public-mcp-tools.test.ts`, and `tests/v2-awakening-and-multiproject.test.ts`.
- Keep `memory_v2Status` rejecting non-empty arguments in `src/v2/app.ts` as required by `tests/v2-foundation-entry.test.ts`.

## Review Focus

- Calling `memory_sessionStart` in `prepared` mode must still fail closed with `FRESH_START_RELEASE_NOT_READY`, and calling it in `read-only-recovery` mode must fail closed with `FRESH_START_ADMISSION_DENIED`.
- Passing `includeContext: false` to `memory_sessionStart` must skip the awaken/contextPack/selfCheck bundle when minimal startup is requested.
- Passing `noteId`, `targetState: "approved"`, and `verificationMethod: "policy"` to `memory_promote` must succeed and promote the note to `"verified"` (returned as `status: "active"` or `"verified"`).
- Passing `evidence: [{ evidenceType: "test", ref: "tests/foo.test.ts", summary: "Passed" }]` to `memory_recordEvidenceBatch` must retain the serialized evidence text without throwing.
- When `MEMORY_V2_AUTO_SYNC_BUILD` is unset, `createV2Foundation` must still reject a mismatched `build_identity_hash` with `FRESH_START_BUILD_MISMATCH`.

---

### Task 1: Write Comprehensive TDD Red Test Suite (`tests/v2-ai-ide-acceleration.test.ts`)

**Files:**
- Create: `tests/v2-ai-ide-acceleration.test.ts`

**Interfaces:**
- Consumes: `createV2Foundation` (`src/v2/composition.ts`), `loadV2LaunchConfig` (`src/v2/config.ts`)
- Produces: 4 automated integration tests verifying all 6 Spec requirements.

- [ ] **Step 1: Write the failing test file `tests/v2-ai-ide-acceleration.test.ts`**

Test cases to include:
1. `atomic memory_sessionStart returns awaken, contextPack, and selfCheck in a single call and normalizes promote/evidence synonyms`
2. `file-path and code-symbol memory graph boosts file-matched ADRs and mistakes in memory_selfCheck and memory_contextPack`
3. `Thai Intl.Segmenter + IDF hybrid ranking accurately ranks compound Thai and English technical notes`
4. `auto-syncs .antigravity/MEMORY_RULES.md when ADRs or mistakes are written and promoted, and auto-heals build_identity_hash when MEMORY_V2_AUTO_SYNC_BUILD=1`

- [ ] **Step 2: Compile and run test to verify it fails (RED)**

Run: `npm run test:build; node --test dist-test/tests/v2-ai-ide-acceleration.test.js`
Expected: FAIL on missing `start.awaken`, `noteId` synonym in `memory_promote`, `fileMatchedNotes`, and `.antigravity/MEMORY_RULES.md`.

---

### Task 2: Implement Atomic Startup, Synonym Normalization, File/Symbol Graph, Thai `Intl.Segmenter` BM25 & `.antigravity/MEMORY_RULES.md` (`src/v2/public-tools.ts`)

**Files:**
- Modify: `src/v2/public-tools.ts`
- Test: `tests/v2-ai-ide-acceleration.test.ts`

**Interfaces:**
- Produces:
  - `#extractFilePathsAndSymbols(text: string): { readonly filePaths: readonly string[]; readonly symbols: readonly string[] }`
  - `#tokenizeMultilingual(text: string): string[]`
  - `#syncIdeMemoryRulesFile(): Promise<string | null>`
  - Enhanced `#handleSessionStart`, `#handleWriteGovernedNote`, `#handlePromote`, `#handleRecordEvidenceBatch`, `#handleSelfCheck`, `#handleContextPack`

- [ ] **Step 1: Update `PUBLIC_TOOL_SCHEMA_CATALOG` in `src/v2/public-tools.ts`**
  Add `includeContext`, `plannedFiles`, `noteId`, `targetState`, `evidence` properties to the tool schemas for `memory_sessionStart`, `memory_promote`, `memory_recordEvidenceBatch`, and `memory_contextPack`.

- [ ] **Step 2: Implement `#extractFilePathsAndSymbols`, `#tokenizeMultilingual`, and IDF-weighted `#scoreHybridNoteMatch` in `src/v2/public-tools.ts`**
  Use `Intl.Segmenter("th", { granularity: "word" })` for Thai word segmentation, extract normalized file paths and symbols on projection notes, and boost file-path matches by `+250` in `#handleContextPack` and `#handleSelfCheck`.

- [ ] **Step 3: Implement Atomic `#handleSessionStart`, Synonym Normalization in `#handleWriteGovernedNote` / `#handlePromote` / `#handleRecordEvidenceBatch`, and `#syncIdeMemoryRulesFile` in `src/v2/public-tools.ts`**
  Bundle `awaken`, `contextPack`, and `selfCheck` into `#handleSessionStart` when `state.mode === "active"` and `args.includeContext !== false`. Write `<projectRoot>/.antigravity/MEMORY_RULES.md` whenever `.antigravity` directory exists and an ADR/Mistake is written or promoted.

---

### Task 3: Implement Opt-In Auto-Heal Build Sync (`src/v2/composition.ts` & `src/v2/admin.ts`) and MCP Resources/Prompts (`src/v2/app.ts`)

**Files:**
- Modify: `src/v2/composition.ts`
- Modify: `src/v2/admin.ts`
- Modify: `src/v2/app.ts`
- Test: `tests/v2-ai-ide-acceleration.test.ts`

**Interfaces:**
- Produces:
  - `createV2Foundation(input, options?: { readonly entryUrl?: string; readonly autoHealBuildSync?: boolean })`
  - `ListResourcesRequestSchema`, `ReadResourceRequestSchema`, `ListPromptsRequestSchema`, `GetPromptRequestSchema` handlers in `runV2Server()`

- [ ] **Step 1: Add opt-in auto-heal build sync in `src/v2/composition.ts` and include `MEMORY_V2_AUTO_SYNC_BUILD: "1"` in `bootstrap-project` (`src/v2/admin.ts`)**
  When `options?.autoHealBuildSync === true || process.env.MEMORY_V2_AUTO_SYNC_BUILD === "1"`, if `release.buildIdentityHash !== measuredBuild`, update `fresh_start_releases.build_identity_hash = measuredBuild` inside an `IMMEDIATE` transaction before `assertPreparedRelease`.

- [ ] **Step 2: Register MCP `resources` and `prompts` handlers in `src/v2/app.ts`**
  Add `resources: {}` and `prompts: {}` to `Server` capabilities and handle `memory://current/status`, `memory://current/awaken`, `memory://current/rules`, `awaken-session`, and `pre-flight-check`.

- [ ] **Step 3: Compile and run all tests to verify GREEN**

Run: `npm run test:build; node --test dist-test/tests/v2-ai-ide-acceleration.test.js dist-test/tests/v2-awakening-and-multiproject.test.js dist-test/tests/v2-public-mcp-tools.test.js`
Expected: PASS (0 failures).

- [ ] **Step 4: Rebuild `dist/` (`node scripts/build.js`), run `tests/v2-foundation-entry.test.ts`, and sync all 4 local projects**

Run: `node C:\Users\Server\Desktop\Awakened-AI-System\scripts\build.js`
Expected: Build succeeds and all 4 projects (`Awakened-AI-System`, `SPX`, `api gateway`, `laravel`) sync cleanly.
