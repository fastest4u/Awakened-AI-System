# Project Memory V2 Evolution: High-Precision Retrieval, Autonomous Awakening & Multi-Project Architecture

**Date:** 2026-10-21  
**Status:** Approved for Implementation  

## 1. Problem Statement & Goals

Project Memory V2 (`dist/v2.js`) provides cryptographic provenance, child-process verified reads, and immutable Projection Schema 3 generations. However, an engineering audit identified 6 critical areas needed to achieve **maximum retrieval accuracy**, **true autonomous awakening**, and **seamless multi-project scalability**:

1. **Empty MCP Tool Input Schemas**: `buildPublicToolDefinitions()` in `src/v2/public-tools.ts` previously emitted `properties: {}` for all 33 content tools, forcing LLM agents to guess parameter names.
2. **Strict-AND FTS & Single-Session Isolation**:
   - Multi-word or Thai natural-language queries fail when strict `AND` FTS5 requires every token in a single chunk.
   - Starting a new session (`memory_sessionStart`) caused `#resolveReadSessionId` to filter reads to the new empty session, hiding notes from prior sessions.
3. **Passive `memory_awaken`**: Only returned `sessionId`, `mode`, and `contextPack`, without synthesizing unfinished work (`continuity`), live Git workspace state (`workspaceState`), governance debt (`governanceAlerts`), or a self-directed action plan (`autonomousAgenda`).
4. **Static `memory_selfCheck`**: Returned a static `{ status: "healthy" }` payload without checking the current `taskSummary` and `filesTouched` against past `mistake` and `adr` records or open conflicts.
5. **Empty Checkpoint Draft Arrays**: `#handleCheckpoint` and `#handleSessionEnd` always initialized `emptyCheckpointDraftV2(taskSummary)` instead of preserving caller-supplied `completedItems`, `inProgressItems`, `blockers`, `nextActions`, `decisions`, and `filesTouched`.
6. **Single-Project MCP Binding & Build-Hash Lockout**:
   - Global MCP clients (like Google Antigravity) spawn a single `project-memory` server process configured with default env vars, needing dynamic `projectRoot` routing so any current or future project can use its own isolated `memory-v2` vault.
   - Rebuilding `dist/` changes `buildIdentityHash`, which previously required manual SQLite updates across every project store, and onboarding a new project required a 6-step manual ceremony.

---

## 2. Architecture & Component Design

### 2.1 Rich MCP Tool Schemas (`src/v2/public-tools.ts`)
- Define explicit JSON Schema `properties` and `description` metadata for all 34 V2 tools while keeping `additionalProperties: true` on the 33 content tools for backward compatibility.
- Include optional `projectRoot` (`string`) on all 33 content tools so multi-project MCP clients can target any workspace directory dynamically.

### 2.2 Cross-Session Visibility & Hybrid Retrieval (`src/v2/public-tools.ts`)
- **Cross-Session Resolution**:
  - Update `#resolveReadSessionId` so that if an explicit or active session has 0 governed notes of its own, verified child-process reads use the latest populated session for candidate hydration, AND merge project-wide eligible records across all sessions in `#handleSearch`, `#handleList`, `#handleRecent`, `#handleContextPack`, and `#handleAwaken`.
- **Hybrid Multi-Stage Search & ContextPack**:
  - Stage 1: Child-process `VerifiedReadAdapter` (`search` / `contextPack`).
  - Stage 2: Soft-OR / per-token lexical & Thai/substring scoring across project-wide `canonical_items` and `governed_notes` (matching `title`, `summary`, `body`, `normalized_key`) weighted by verification boost (`active` > `provisional` > `candidate`), kind boost (`mistake` / `adr` / `insight`), and recency.
  - All cross-session/hybrid matches are verified and deduplicated by `id`, guaranteeing high recall without sacrificing V2 governance integrity.

### 2.3 Autonomous Awakening Engine (`#handleAwaken` in `src/v2/public-tools.ts`)
- Preserves `{ ok: true, sessionId, mode, contextPack }` and adds:
  - `continuity`: `{ latestCheckpoint, inProgressItems, blockers, nextActions, recentSessionLogs, recentDecisions }`
  - `workspaceState`: `{ projectRoot, branch, headCommit, isDirty, modifiedFiles, untrackedFiles }`
  - `governanceAlerts`: `{ conflictedCount, staleCount, unpromotedCandidateCount, openFollowUpCount, alerts }`
  - `autonomousAgenda`: Prioritized array of `{ priority, category, action, rationale, suggestedTool, relatedRecordIds }` synthesized automatically from blockers, nextActions, dirty workspace files, open conflicts, and unpromoted high-confidence notes.

### 2.4 Active Pre-Flight Guardrail (`#handleSelfCheck` in `src/v2/public-tools.ts`)
- Preserves `{ ok: true, sessionId, status: "healthy", taskSummary, mode }` and adds:
  - `pastMistakesToAvoid`: Ranked `mistake` notes matching `taskSummary` / `filesTouched` (or recent active mistakes).
  - `bindingADRs`: Ranked `adr` notes matching `taskSummary` / `filesTouched` (or recent active ADRs).
  - `openConflicts`: Active conflicted items in the project.
  - `riskLevel`: `"low" | "medium" | "high"` computed from matching mistakes, open conflicts, and touched files.
  - `preFlightChecklist`: Concrete verification steps tailored to the matched ADRs and mistakes.

### 2.5 Structured Checkpoints (`#handleCheckpoint` & `#handleSessionEnd`)
- Parse optional `completedItems`, `inProgressItems`, `blockers`, `nextActions`, `decisions`, and `filesTouched` string arrays into `CheckpointDraftV2` and persist them in the session checkpoint event payload so subsequent `memory_awaken` calls can resume work seamlessly.

### 2.6 Multi-Project Dynamic Routing & Zero-Friction Admin (`src/v2/composition.ts`, `src/v2/app.ts`, `src/v2/admin.ts`)
- **Dynamic `projectRoot` Routing**:
  - When a tool call includes `projectRoot` (different from the default foundation's `projectRoot`), `V2Foundation` / `runV2Server` resolves or auto-bootstraps the target project's `memory-v2` vault (`<projectRoot>/memory-v2` and `<projectRoot>/memory`) and delegates the tool call to a cached `V2Foundation` instance for that project.
- **New Operator CLI Commands (`node dist/v2-admin.js`)**:
  - `bootstrap-project --project-root <path> [--v2-vault-root <path>] [--v1-archive-root <path>] [--release-id <uuid>]`: Idempotently creates directories, writes the production release manifest, initializes the V2 store, promotes it to `"active"`, optionally imports V1 markdown notes from `memory/`, freezes the V1 archive, and writes `.antigravity/mcp.json` / client configs.
  - `sync-build --project-root <path> [--v2-vault-root <path>] [--v1-archive-root <path>]`: Updates `fresh_start_releases` and `release-manifest.json` in an existing project store to match the current `inspectV2Build()` and `configurationDigest(config)` after an engine upgrade.
