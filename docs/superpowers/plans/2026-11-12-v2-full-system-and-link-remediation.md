# Project Memory V2 — Full System & Link Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all P0, P1, and P2 system, security, lifecycle, knowledge-graph link, WebUI deep-linking, IDE configuration, documentation, and CI gate defects identified in the deep system audit so `Awakened-AI-System` (Project Memory V2) is 100% production-ready.

**Architecture:**
1. **Dynamic Branch-Scope Projection & Cross-Branch Governance (`src/v2/public-tools.ts`, `src/v2/composition.ts`)**: Resolve the live Git workspace branch (`BranchScopeRepository` + `GitWorkspaceResolver`) so Projection Schema 3 binds to the active branch (`refs/heads/main`) and rebuilds when switching branches, while `memory_findDuplicates`, `memory_checkStaleness`, and `memory_followUpRadar` inspect all active project notes consistently.
2. **Unified Workspace-Aware Entity & Link Extractor (`src/v2/entity-extractor.ts`)**: Replace duplicated regexes in `public-tools.ts` and `webui.ts` with one canonical extractor supporting `.sqlite`/`.mdc`/`.json`/`.test.ts`/Windows paths, left/right token boundaries, root bare-file `existsSync` validation, stop-symbol filtering, `[[wikilink]]` note-to-note resolution (`src/utils/links.ts`), governance lineage edges (`supersedes`, `causal-triad`, child-session `forked-from`), IDF-weighted `causalTriads`, and real `memory_verifySourceTruth` disk + evidence checks.
3. **Complete Session Lifecycle, Read-Only Purity & Clean Note Metadata (`src/v2/public-tools.ts`, `src/v2/curator.ts`, `src/v2/app.ts`)**: Transition `memory_sessionEnd` all the way to `"completed"` with lease release and real `session_leases` expiry inspection; remove mutating `#ensureActiveRootSession` from read-only tools/resources; preserve note `# Heading` titles without naive `": "` truncation or duplicate `"Promoted via..."` body suffixes; add projection/rules sync on `#handleExpire`; fix `V2MemoryCuratorAgent` pagination, duplicate-keeper promotion order, and `autoExecute === false`; and add `ListResourceTemplatesRequestSchema` + `session-handoff` prompt.
4. **Hardened & Deep-Linked Mission Control WebUI (`src/v2/webui.ts`, `src/v2/webui/*`, `src/v2/admin.ts`)**: Enforce loopback `Host` guard, `Content-Type: application/json`, `Origin`/`Sec-Fetch-Site` + `X-PM-CSRF-Token` CSRF protection, `CSP`/`X-Frame-Options`/`X-Content-Type-Options` headers, `knownProjects`-only `GET ?project=` routing (never creating arbitrary SQLite stores on `GET`), `400`/`413` error handling, and `SIGINT`/`SIGTERM` shutdown; fix `vendor-runtime.ts` hook keys, child slot indexing, scroll/selection preservation, and `QueryClient` key filtering; add URL hash/query deep-linking (`#<tab>?project=...&note=...&node=...&session=...&q=...`), narrow-viewport (`<= 1024px`) navigation, cross-view links across Overview/Kanban/Graph/Curator/Note Modal, Causal Triads UI, safe Markdown `<a>` links + code blocks, and complete Lucide icons.
5. **Multi-IDE V2 Sync, Docs, Broken Link Fixes & CI Isolation Gates (`src/v2/admin.ts`, IDE rules, `package.json`, `README.md`, `tests/ci-lifecycle-gates.test.ts`)**: Fix `.claude/settings.local.json` schema and sync all IDE rule files (`CLAUDE.md`, `.rules`, `.windsurfrules`, `.cursor/rules/project-memory.mdc`, `.windsurf/rules/project-memory.md`, `.github/copilot-instructions.md`, example MCP configs) to Project Memory V2; fix all 8 broken Markdown links in `.superpowers/evidence-archive/`; update `package.json`, `README.md`, `AGENTS.md`, and `docs/v2-fresh-start-operations.md`; and update `APPROVED_SEALED_AND_ROLLOUT_SOURCE_DIFF` + `PREPARED_IMPORTS` + `MEMORY_V2_FORCE_WORKER_READ` so all CI and release-qualification test suites pass 100%.

**Tech Stack:** TypeScript 5.8 (ESM, strict), Node.js `>=24.16.0` (`node:sqlite`, `node:test`, `node:http`, `node:vm`), `@modelcontextprotocol/sdk`, esbuild, custom V2 WebUI MVC + Web Components runtime.

---

### Task 1: Core V2 Engine — Branch-Scope Projection, Session Finalization, Read-Only Purity, Note Titles & Curator Fixes

**Files:**
- Modify: `src/v2/public-tools.ts`
- Modify: `src/v2/composition.ts`
- Modify: `src/v2/curator.ts`
- Test: `tests/v2-ai-ide-acceleration.test.ts`
- Test: `tests/v2-webui-and-curator.test.ts`

- [x] **Step 1: Write failing tests (RED)** in `tests/v2-ai-ide-acceleration.test.ts` and `tests/v2-webui-and-curator.test.ts` covering:
  - Active Git branch (`main`) projection binding when an older branch scope exists in `branch_scopes`, plus `memory_findDuplicates` and `memory_checkStaleness` detecting duplicates/stale items on the current branch and across project notes.
  - Read-only purity: calling `memory_awaken`, `memory_selfCheck`, and `memory_lifecycleStatus` on a fresh store creates `0` sessions/events in `events.sqlite`.
  - Complete `memory_sessionEnd`: transitions session `semanticState` to `"completed"` and `leaseState` to `"released"`, and reports `"expired-lease"` when `session_leases.expires_at` is in the past.
  - Clean note titles & bodies: notes with colons in `title`/`summary` keep their full title (never truncated to `"ADR"`/`"Insight"`/`"Mistake"`), `memory_promote` never appends duplicate `"Promoted via..."` text onto `body`, and `memory_expire` republishes projections + syncs `.antigravity/MEMORY_RULES.md`.
  - `V2MemoryCuratorAgent`: `chat({ message: "จัดระเบียบความจำ", autoExecute: false })` previews audit recommendations without mutating notes, and `autoCurate` promotes an unverified keeper before superseding duplicates without leaving `"ending"` sessions behind.
- [x] **Step 2: Run tests to verify RED failure** (`npm run test:build && node --test --test-concurrency=1 dist-test/tests/v2-ai-ide-acceleration.test.js dist-test/tests/v2-webui-and-curator.test.js`).
- [x] **Step 3: Implement minimal production fixes (GREEN)** in `src/v2/public-tools.ts`, `src/v2/composition.ts`, and `src/v2/curator.ts` (including renaming `PM_V2_FORCE_WORKER_READ` -> `MEMORY_V2_FORCE_WORKER_READ` and preventing `resolveRoutedFoundation` from `mkdirSync`-ing non-existent directories unless explicitly bootstrapping).
- [x] **Step 4: Rebuild & run tests to verify GREEN** (`npm run build && npm run test:build && node --test --test-concurrency=1 dist-test/tests/v2-ai-ide-acceleration.test.js dist-test/tests/v2-webui-and-curator.test.js`).

---

### Task 2: Unified Entity/Link Extractor, Wikilinks, Lineage Graph, Causal Triads IDF, `memory_verifySourceTruth` & MCP Resources

**Files:**
- Create: `src/v2/entity-extractor.ts`
- Modify: `src/v2/public-tools.ts`
- Modify: `src/v2/webui.ts`
- Modify: `src/v2/app.ts`
- Test: `tests/v2-ai-ide-acceleration.test.ts`
- Test: `tests/v2-webui-and-curator.test.ts`

- [x] **Step 1: Write failing tests (RED)** covering:
  - `extractMemoryEntities`: preserves `.sqlite`, `.json`, `.mdc`, `.test.ts`, dotfiles (`.github/workflows/ci.yml`), and Windows `\` paths; ignores URL routes (`/mvc/views.js`, `https://...`), bare non-existent filenames (`vendor.js`), and stop-symbols (`null`, `undefined`, `WebUI`, `TypeScript`, `#graph`, kebab-case).
  - `buildMemoryKnowledgeGraph`: emits `links-to-note` edges via `[[wikilinks]]` (`src/utils/links.ts`), `supersedes` edges, `causal-triad` edges, and completed child-session `forked-from` edges; never invents false `defines-symbol` on `filePaths[0]` when multiple files exist and never binds sessionless notes to `sessions[0]`.
  - `memory_verifySourceTruth`: validates project-scoped event count, retained evidence correspondence, existing vs missing `filePaths` on disk, and broken `[[wikilinks]]`.
  - `src/v2/app.ts`: exposes `ListResourceTemplatesRequestSchema` (`memory://notes/{recordId}`, `memory://current/adrs`, `memory://current/mistakes`, `memory://graph`) with `?projectRoot=` support and `session-handoff` prompt without mutating DB state.
- [x] **Step 2: Run tests to verify RED failure**.
- [x] **Step 3: Implement `src/v2/entity-extractor.ts` and wire into `public-tools.ts`, `webui.ts`, and `app.ts` (GREEN)**.
- [x] **Step 4: Rebuild & run tests to verify GREEN**.

---

### Task 3: WebUI Security Hardening, `vendor-runtime.ts` Stability, Deep-Linking, Cross-View Navigation & Safe Markdown Links

**Files:**
- Modify: `src/v2/webui.ts`
- Modify: `src/v2/admin.ts`
- Modify: `src/v2/webui/vendor-runtime.ts`
- Modify: `src/v2/webui/models.ts`
- Modify: `src/v2/webui/controllers.ts`
- Modify: `src/v2/webui/shadcn-ui.ts`
- Modify: `src/v2/webui/views-and-web-components.ts`
- Test: `tests/v2-webui-and-curator.test.ts`

- [x] **Step 1: Write failing tests (RED)** in `tests/v2-webui-and-curator.test.ts` covering:
  - Security: rejects non-loopback `Host` header (`403`), cross-origin `Origin` / `Sec-Fetch-Site: cross-site` (`403`), missing/text-plain `Content-Type` on `POST` (`415`), invalid `X-PM-CSRF-Token` (`403`), malformed JSON (`400`), malformed `%E0%A4%A` URI (`400`), oversize body (`413`), and unknown `GET ?project=/unregistered/path` (`403`/`404` with zero directories created on disk!); emits `Content-Security-Policy`, `X-Frame-Options: DENY`, and `X-Content-Type-Options: nosniff`.
  - Frontend MVC & Deep-Linking: `/mvc/*.js` all compile cleanly via `new vm.Script(...)`, include URL hash/query router (`#<tab>?project=...&note=...&node=...&session=...`), narrow-screen (`<= 1024px`) tab switcher, `openInGraph` / `openInKanban` cross-navigation, Causal Triads rendering, safe Markdown `<a href>` allowlist (`https:`, `http:`, `mailto:`, `vscode:`, `cursor:` — blocking `javascript:`/`data:`), fenced code blocks, Note double-click -> `inspectNote`, `Ctrl/Meta + wheel` zoom, per-instance + `projectRoot` custom-element hook keys, scroll/focus preservation, and zero raw emoji icons (`🎯`/`📍` replaced by Lucide SVG icons).
- [x] **Step 2: Run tests to verify RED failure**.
- [x] **Step 3: Implement WebUI security, runtime, controller, style, and view upgrades (GREEN)** (double-escaping all regexes/escapes inside browser JS template literals!).
- [x] **Step 4: Rebuild & run tests to verify GREEN**.

---

### Task 4: Multi-IDE V2 Rules/Config Sync, Broken Markdown Links, Documentation & CI Lifecycle Gates

**Files:**
- Modify: `src/v2/admin.ts`
- Modify: `.claude/settings.local.json`, `CLAUDE.md`, `.rules`, `.windsurfrules`, `.cursor/rules/project-memory.mdc`, `.windsurf/rules/project-memory.md`, `.github/copilot-instructions.md`, `.antigravity/mcp.example.json`, `.windsurf/mcp_config.example.json`
- Delete: `.cursor/rules/pordee.mdc`
- Modify: `package.json`, `AGENTS.md`, `README.md`, `docs/v2-fresh-start-operations.md`, `.agents/workflows/strict-pr-review-8-category.md`, `.windsurf/workflows/strict-pr-review-8-category.md`
- Modify: `.superpowers/evidence-archive/task6-56232b5-20261008-handoff/final-evidence-rendered.md`, `final-plan-appendix-rendered.md`, `final-plan-prepared.md`
- Modify: `tests/ci-lifecycle-gates.test.ts`

- [x] **Step 1: Write failing test assertions (RED)** for `generateClientConfigs` (valid `.claude/settings.local.json` schema + V2 IDE rules sync) and inspect `tests/ci-lifecycle-gates.test.ts` failure.
- [x] **Step 2: Fix `generateClientConfigs` in `src/v2/admin.ts`, regenerate IDE configs/rules, remove stray `.cursor/rules/pordee.mdc`, fix all 8 broken Markdown links, update `package.json` / `README.md` / `AGENTS.md` / `docs/v2-fresh-start-operations.md` / workflow files, and update `APPROVED_SEALED_AND_ROLLOUT_SOURCE_DIFF` + `PREPARED_IMPORTS` in `tests/ci-lifecycle-gates.test.ts` (GREEN)**.
- [x] **Step 3: Run `npm run typecheck`, `npm run build`, `node dist/v2-admin.js sync-build`, `node dist/v2-admin.js verify-v1-archive`, broken-link scan, and full CI/test suites**.

---

### Task 5: Live Vault Curation, Independent Code Review, Full Verification & Governed Session Closure

- [x] **Step 1: Run full verification matrix**:
  - `npm run typecheck`
  - `npm run build`
  - `node dist/v2-admin.js sync-build`
  - `node dist/v2-admin.js verify-v1-archive`
  - `npm run test:rollout-control-plane`
  - `npm run test:v2-fresh-start-foundation`
  - `npm run test:build-artifacts`
  - `npm test`
  - Empirical Markdown & Knowledge Graph link audit (`0` broken Markdown links, `0` phantom graph file links, all 18+ `main` notes projected in Schema 3!).
- [x] **Step 2: Dispatch independent code review subagent (`superpowers:requesting-code-review`)** and resolve any findings.
- [x] **Step 3: Record governed ADR (`memory_writeADR` with `autoVerify: true`), call `memory_sessionEnd` (`7477e89b-6ce0-44a0-8b23-ad3816f33531`), and verify vault health (`memory_verifyVault` + `memory_v2Status`)**.
