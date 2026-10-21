# Project Memory V2 WebUI & AI Memory Curator Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete Multi-Project WebUI Dashboard and AI Memory Curator Agent (`src/v2/curator.ts`, `src/v2/webui.ts`, `src/v2/admin.ts`) for Project Memory V2.

**Architecture:** `V2MemoryCuratorAgent` wraps `V2PublicToolRouter` to provide autonomous vault auditing, 1-click governed auto-curation (`promote`, `supersede`, `expire`), and bilingual Thai/English natural-language memory management. `startV2WebUiServer` serves a zero-dependency Node `node:http` REST API and Mission Control SPA capable of switching across all local V2 vaults (`Awakened-AI-System`, `SPX`, `api gateway`, `laravel`), visualizing the File/Symbol Knowledge Graph, and running the AI Curator.

**Tech Stack:** TypeScript, Node.js >= 24.16.0 (`node:http`, `node:sqlite`, `node:test`), Project Memory V2 (`V2PublicToolRouter`, `createV2Foundation`).

**Spec:** `docs/superpowers/specs/2026-10-21-v2-webui-and-ai-curator-design.md`

## Global Constraints

- Node.js `>=24.16.0` with zero new external runtime npm dependencies (must pass `scripts/fresh-start-build.js` external import gate).
- Do not alter the 34 tool definitions count in `V2_PUBLIC_TOOL_DEFINITIONS` so existing V2 contract tests remain 100% green.
- All governance mutations triggered by the WebUI or AI Curator (`promote`, `supersede`, `retract`, `expire`, `writeADR`, `writeInsight`, `writeMistake`) must execute through `V2PublicToolRouter` so event-store hash chains and SQLite projections remain authoritative.

## Review Focus

1. Empty or newly bootstrapped vault with zero notes: `auditVault`, `/api/overview`, and `/api/graph` must return valid zeroed structures (`healthScore: 100`, empty arrays) without throwing.
2. Duplicate candidate notes with identical titles/bodies: `autoCurate` must promote or retain the newest/highest-salience note and `memory_supersede` the redundant duplicate without self-superseding (`noteId === supersededByNoteId`).
3. Thai & English natural language commands in `curator.chat`: prompts like `"ช่วยตรวจความจำซ้ำ"`, `"อนุมัติ candidate ทั้งหมด"`, `"สรุปความจำโปรเจคนี้"`, and `"ค้นหา auth"` must route to the right V2 tools and return structured data.
4. Invalid or unknown project path in `/api/overview?project=...`: WebUI handler must reject non-absolute or traversal paths cleanly with HTTP 400 JSON error instead of crashing the server.
5. Build integrity across all local projects: after bundling `dist/v2.js` and `dist/v2-admin.js`, all 4 local projects (`Awakened-AI-System`, `SPX`, `api gateway`, `laravel`) must be synced via `sync-build` and report `mode: "active", productionReady: true`.

---

### Task 1: AI Memory Curator Agent (`src/v2/curator.ts`)

**Files:**
- Create: `src/v2/curator.ts`
- Test: `tests/v2-webui-and-curator.test.ts`

**Interfaces:**
- Consumes: `V2PublicToolRouter` from `src/v2/public-tools.ts`
- Produces:
  - `V2MemoryCuratorAgent` class with:
    - `auditVault(options?: { staleDays?: number; limit?: number }): Promise<CuratorAuditReport>`
    - `autoCurate(options?: { promoteCandidates?: boolean; resolveDuplicates?: boolean; expireStale?: boolean; staleDays?: number }): Promise<CuratorExecutionReceipt>`
    - `chat(request: { message: string; autoExecute?: boolean }): Promise<CuratorChatResponse>`

- [ ] **Step 1: Write failing tests for `V2MemoryCuratorAgent` (`auditVault`, `autoCurate`, `chat`) in `tests/v2-webui-and-curator.test.ts`**
- [ ] **Step 2: Run test to verify RED**
  Run: `npm run test:build && node --test dist-test/tests/v2-webui-and-curator.test.js`
- [ ] **Step 3: Implement `src/v2/curator.ts`**
- [ ] **Step 4: Run test to verify GREEN**
  Run: `npm run test:build && node --test dist-test/tests/v2-webui-and-curator.test.js`

---

### Task 2: Multi-Project WebUI Server, Knowledge Graph API & SPA (`src/v2/webui.ts`)

**Files:**
- Create: `src/v2/webui.ts`
- Modify: `tests/v2-webui-and-curator.test.ts`

**Interfaces:**
- Consumes: `createV2Foundation`, `ensureProjectV2StoreReady` from `src/v2/composition.ts`, `V2PublicToolRouter` from `src/v2/public-tools.ts`, `V2MemoryCuratorAgent` from `src/v2/curator.ts`
- Produces:
  - `discoverV2Projects(seedProjectRoot: string, extraRoots?: readonly string[]): string[]`
  - `buildMemoryKnowledgeGraph(notes: readonly Record<string, unknown>[]): { nodes: GraphNode[]; edges: GraphEdge[]; stats: Record<string, number> }`
  - `createV2WebUiHandler(options: V2WebUiOptions)`
  - `startV2WebUiServer(options: V2WebUiOptions & { port?: number; host?: string })`

- [ ] **Step 1: Add failing HTTP API & Knowledge Graph tests in `tests/v2-webui-and-curator.test.ts`**
- [ ] **Step 2: Run test to verify RED**
  Run: `npm run test:build && node --test dist-test/tests/v2-webui-and-curator.test.js`
- [ ] **Step 3: Implement `src/v2/webui.ts` with REST endpoints, Knowledge Graph builder, and Mission Control HTML SPA**
- [ ] **Step 4: Run test to verify GREEN**
  Run: `npm run test:build && node --test dist-test/tests/v2-webui-and-curator.test.js`

---

### Task 3: V2 Admin CLI `webui` Command, Production Build & Multi-Project Sync (`src/v2/admin.ts`, `package.json`)

**Files:**
- Modify: `src/v2/admin.ts`
- Modify: `package.json`
- Modify: `tests/v2-webui-and-curator.test.ts`

**Interfaces:**
- Consumes: `startV2WebUiServer` from `src/v2/webui.ts`
- Produces:
  - `node dist/v2-admin.js webui --project-root <path> [--port 4321] [--host 127.0.0.1]`
  - `npm run webui` script in `package.json`

- [ ] **Step 1: Add failing CLI `webui` flag/invocation test in `tests/v2-webui-and-curator.test.ts`**
- [ ] **Step 2: Implement `webui` command in `src/v2/admin.ts` and `npm run webui` in `package.json`**
- [ ] **Step 3: Run full test suite, production `scripts/build.js`, sync all 4 local project vaults, and launch live WebUI server**
