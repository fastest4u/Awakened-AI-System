# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) server, **awakened-ai-memory-mcp**, that gives any project a project-local Markdown "memory vault" (`memory/`) shared across multiple AI agents/IDEs. The server exposes ~40 `memory_*` tools over stdio for searching, reading, writing, verifying, and running session-lifecycle workflows against the vault. The vault is plain Markdown (Obsidian-compatible but Obsidian is optional) and is meant to live next to the code it documents and be versioned in git.

The primary README is in Thai (`README.md`) and is the most complete reference for the tool surface and vault layout.

## Operating protocol — Full-Auto project memory (read first)

This repo opts into **Full-Auto** use of the `project-memory` MCP server. When that server is connected, run the SPX memory lifecycle automatically for every meaningful task — do not ask first for read/additive-write/verify tools. (Source of truth: `AGENTS.md`, `.rules`, `01_Project_Rules/Always-On-Memory-Protocol.md`, and ADR `04_Architecture_Decisions/adr-full-auto-invocation-policy-for-project-memory-mcp-tools.md`.)

Per-task flow:

1. **Start** every task with `memory_sessionStart` (pass `taskArea` + `mode`; it auto-attaches a `contextPack` and open `followUps`).
2. **Gather context** with `memory_contextPack` for the task area; read full notes only for selected paths via `memory_get`.
3. **Before risky work** — multi-file edits, schema/DB, auth, infra, deploys, decision-heavy changes — call `memory_selfCheck`. Single-file low-risk doc edits may skip it (the quality gate only flags `selfCheck` when it infers a risky-work signal).
4. **During work** record durable knowledge: `memory_writeADR` (decisions), `memory_writeInsight` (lessons), `memory_writeMistake` (failures).
5. **End** every meaningful task with `memory_sessionEnd` (include `outcomes`, `filesTouched`, `verification`, and carry unresolved items in `openFollowUps`). Do not consider the task done until this succeeds.
6. **Verify** via the `qualityGate` returned by `sessionEnd`, or call `memory_verifyVault`. Aim for gate `ok: true`.

Tool invocation policy:

- **AUTO — invoke proactively, never ask**: all read, additive-write, and verify tools (`memory_sessionStart`, `memory_contextPack`, `memory_selfCheck`, `memory_get/list/search/recent`, `memory_followUpRadar`, `memory_awaken`, `memory_lifecycleStatus`, `memory_verify*`, `memory_find*`, `memory_checkStaleness`, `memory_indexNote`, `memory_write*`, `memory_createFromTemplate`, `memory_sessionEnd`).
- **WARN-THEN-RUN — state reason + impact before each run**: destructive/heavy tools (`memory_compactVault`, `memory_reindex`, `memory_bootstrapProject`, `memory_import`). Never run these silently.
- If the MCP server is **unavailable**, read `memory/AGENTS.md` and tell the user explicitly that memory writes were skipped.
- This server resolves its own vault via `memory.config.ts`; confirm with `memory_diagnoseWorkspace` that `vaultRoot` points at this repo's `memory/` (not a stray IDE-state workspace) before writing.

Note: suppressing the IDE's per-call approval prompt requires the user to add `project-memory` to the client allowlist (e.g. `.claude/settings.json` → `permissions.allow`). You control *whether* a tool is invoked, not whether the IDE prompts.

## Commands

```bash
npm install              # install deps
npm run build            # bundle src/index.ts -> dist/index.js (obfuscated) + dist/cli.js, writes dist/build-info.json
npm run typecheck        # tsc --noEmit (npm run lint is an alias)
npm run start            # node dist/index.js  (runs the built MCP server over stdio)
npm run dev              # build then start
npm test                 # compile tests to dist-test/ then run node --test
```

Run a single test file:

```bash
npm run test:build       # tsc -p tsconfig.test.json -> dist-test/
node --test --test-reporter=spec "dist-test/tests/frontmatter.test.js"
```

Tests are written in `tests/*.test.ts`, compiled to `dist-test/` (separate `tsconfig.test.json`), and run with the Node built-in test runner — there is no Jest/Vitest. Always run `test:build` (or `npm test`) first; running stale `dist-test/` output is a common pitfall.

## Build is obfuscated

`npm run build` (see `scripts/build.js`) does two stages: esbuild bundles `src/index.ts` to ESM with `packages: 'external'` (node_modules are *not* bundled, so `dist/` still needs `node_modules` present at runtime), then `javascript-obfuscator` rewrites `dist/index.js` in place. **`dist/` is a gitignored build artifact (see `.gitignore`) — it is NOT committed; regenerate it with `npm run build` and never hand-edit it.** Change `src/`, then rebuild. MCP clients load `dist/index.js`, so after any source change you must `npm run build` and reload the client for it to see new behavior.

## Architecture

Strict MVC-ish layering, wired together in `src/app.ts` (`bootstrap()`), the single composition root. `src/index.ts` just re-exports it.

```
schemas/        Zod input schemas for every tool (schemas/memory.ts, schemas/common.ts)
controllers/    Register tools on the McpServer + adapt input/output. One per tool group.
services/       All business logic. Controllers hold no logic; they delegate here.
repositories/   Vault/file + index access (note.repository, vault.repository, index.repository)
models/         Typed note shapes (adr, mistake, session-log, note, frontmatter)
config/         Config loading + vault policy (memory.config, frontmatter.config, vault-policy)
utils/          Frontmatter parsing/schema helpers, formatting
```

Data flow: `McpServer` (stdio) → **Controller** (`register(server)` calls `server.registerTool(name, {description, inputSchema, annotations}, handler)`) → **Service** → **Repository** → vault files. Every tool returns a uniform envelope built by `ToolResponseService` (`{ ok, data, warnings, meta }`, or `{ ok:false, error }`), so handlers wrap service calls with `responses.buildOk(...)`.

The six controllers map to tool groups: `NoteController` (read), `WriteController` (write), `VerifyController` (verification), `FrontmatterController`, `MaintenanceController` (bootstrap/reindex/compact/diagnose), `WorkflowController` (session lifecycle). To add a tool: define its Zod schema in `schemas/`, add logic in a service, register it in the matching controller, and wire any new service in `bootstrap()`.

`MemoryWorkflowService` is the orchestration hub — it composes nearly every other service (query, health, notes, templates, audit, usage, compactor, lifecycle, followUps) to implement the session-start → context-pack → self-check → session-end flow and the lifecycle/quality-gate state in `memory/.memory-mcp/lifecycle.json`.

## Vault location resolution (the subtle part)

`config/memory.config.ts` decides **where the `memory/` vault lives**, and this is the trickiest logic in the codebase. An MCP server is usually spawned with a `cwd` of the *client's* install dir, not the user's project, so the vault can easily be created in the wrong place. Resolution order in `loadMemoryConfig` / `resolveDynamicProjectRoot`:

1. Explicit env: `MEMORY_PROJECT_ROOT` / `PROJECT_ROOT` / `WORKSPACE_ROOT` (unless set to a dynamic sentinel like `auto`/`detect`/`dynamic`/`workspace`).
2. `cwd` if it walks up to a workspace that already has a vault marker (`memory/AGENTS.md`).
3. **IDE-state probing**: reads the last-active workspace from VS Code-derived IDEs (`globalStorage/storage.json`), OpenCode (`opencode.global.dat`), and Zed (`db.sqlite` via built-in `node:sqlite`). Prefers candidates that already contain `memory/AGENTS.md`.
4. Fallback to `cwd`.

Env overrides: `MEMORY_VAULT_DIR` (default `memory`), `MEMORY_VAULT_PATH` (absolute path, bypasses project-root + dir join). When in doubt, set `MEMORY_PROJECT_ROOT` explicitly. The `__internals` export and `diagnoseMemoryConfig` exist for tests and the `memory-vault diagnose` CLI; keep `__internals` tight.

## memory-vault CLI

`dist/cli.js` (`bin: memory-vault`, source `src/cli.ts`) is a standalone frontmatter validator/fixer for a vault: `validate`, `report`, `fix` (`--apply`/`--unsafe --confirm`), `migrate` (`--rollback`), `init`, `diagnose`. Fix/migrate are dry-run by default. Frontmatter rules come from layered config (built-in defaults → `~/.memory-vault/frontmatter.config.json` → `<vault>/.memory-mcp/frontmatter.config.json`); see `config/frontmatter.config.ts` and `docs/frontmatter.config.schema.json`.

## Note on the project's own `memory/` vault and agent rules

This repo dogfoods itself: the populated `memory/` vault plus root agent-rule files (`AGENTS.md`, `.rules`, `.windsurfrules`, `GEMINI.md`) are the source of the Full-Auto memory protocol described at the top of this file. When editing this server's own source, the vault under `memory/` is also live test/example data for the very tools you're changing — don't confuse it with the code in `src/`, and expect your own `memory_*` calls to read/write it.
