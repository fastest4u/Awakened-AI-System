# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) server, **awakened-ai-memory-mcp**, that gives any project a project-local Markdown "memory vault" (`memory/`) shared across multiple AI agents/IDEs. The server registers **32 `memory_*` tools** (plus 4 MCP prompts: `session_start`, `session_end`, `self_check`, `awaken`) over stdio for searching, reading, writing, verifying, and running session-lifecycle workflows against the vault. The vault is plain Markdown (Obsidian-compatible but Obsidian is optional) and is meant to live next to the code it documents and be versioned in git.

The primary README is in Thai (`README.md`) and is the most complete reference for the tool surface and vault layout. Caveat: `memory_export` and `memory_import` are not implemented yet — they return `NOT_IMPLEMENTED` error envelopes.

## Operating protocol — Full-Auto project memory (read first)

This repo opts into **Full-Auto** use of the `project-memory` MCP server. When that server is connected, run the SPX memory lifecycle automatically for every meaningful task — do not ask first for read/additive-write/verify tools. The tier policy lives **only in root `AGENTS.md`**; `.rules`, `.windsurfrules`, and `GEMINI.md` carry just the Always-On protocol (no tiers), and the full-auto ADR path that `AGENTS.md` cites does not exist in the vault.

Per-task flow:

1. **Start** every task with `memory_sessionStart` (pass `taskArea` + `mode`; it auto-attaches a `contextPack` and open `followUps`).
2. **Gather context** with `memory_contextPack` for the task area; read full notes only for selected paths via `memory_get`.
3. **Before risky work** — multi-file edits, schema/DB, auth, infra, deploys, decision-heavy changes — call `memory_selfCheck`. Single-file low-risk doc edits may skip it (the quality gate only requires `selfCheck` when it infers risk: `filesTouched > 1` or deploy/migration/schema/auth/secret/refactor keywords in topic/outcomes).
4. **During work** record durable knowledge: `memory_writeADR` (decisions), `memory_writeInsight` (lessons), `memory_writeMistake` (failures).
5. **End** every meaningful task with `memory_sessionEnd` (include `outcomes`, `filesTouched`, `verification`, and carry unresolved items in `openFollowUps`). Do not consider the task done until this succeeds.
6. **Verify** via the `qualityGate` returned by `sessionEnd`, or call `memory_verifyVault`. Aim for gate `ok: true`.

Tool invocation policy:

- **AUTO — invoke proactively, never ask**: all read, additive-write, and verify tools (`memory_sessionStart`, `memory_contextPack`, `memory_selfCheck`, `memory_get/list/search/recent`, `memory_followUpRadar`, `memory_awaken`, `memory_lifecycleStatus`, `memory_verify*`, `memory_find*`, `memory_checkStaleness`, `memory_indexNote`, `memory_write*`, `memory_createFromTemplate`, `memory_sessionEnd`).
- **WARN-THEN-RUN — state reason + impact before each run**: destructive/heavy tools (`memory_compactVault`, `memory_reindex`, `memory_bootstrapProject`, `memory_import`). Never run these silently.
- `memory_diagnoseWorkspace` and the three frontmatter tools (`validate`/`fix`/`migrateFrontmatter`) are not assigned a tier in `AGENTS.md`; treat validate/diagnose as AUTO and fix/migrate (which write) as WARN-THEN-RUN.
- If the MCP server is **unavailable**, read `memory/AGENTS.md` and tell the user explicitly that memory writes were skipped.
- This server resolves its own vault via `memory.config.ts`; confirm with `memory_diagnoseWorkspace` that `vaultRoot` points at this repo's `memory/` (not a stray IDE-state workspace) before writing.

Notes:

- Suppressing the IDE's per-call approval prompt requires the user to allowlist `project-memory` — in this repo that lives in `.claude/settings.local.json` (`permissions.allow` + `enabledMcpjsonServers: context7, project-memory, git`). You control *whether* a tool is invoked, not whether the IDE prompts.
- Expect `memory/.memory-mcp/lifecycle.json` and `usage.json` to show as modified in `git status` after any session — even "read" tools (`sessionStart`/`contextPack`) record usage scoring and lifecycle events there. This is normal, not corruption. (`index.json*` and `backups/` in the same dir are gitignored.)
- `AGENTS.md` also mandates Context7 MCP (`resolve-library-id` → `query-docs`) for library/framework/SDK/API documentation lookups, preferred over web search.

## Commands

The supported runtime floor is Node.js 24.16.0 or newer within the Node.js 24 LTS line, with runtime SQLite 3.51.3 or newer. `npm run check:runtime` verifies the Node/SQLite versions plus WAL, FTS5, foreign-key, synchronous, busy-timeout, trusted-schema, rollback, in-memory database deserialization, and query-only capabilities before authoritative-store work.

```bash
npm install              # install deps
npm run check:runtime     # fail-closed Node/node:sqlite/WAL capability probe
npm run build            # emit server, CLI, worker, and build-info artifacts under dist/
npm run typecheck        # tsc --noEmit (npm run lint is an alias; there is no eslint/prettier)
npm run start            # node dist/index.js  (runs the built MCP server over stdio)
npm run dev              # build then start
npm test                 # compile tests to dist-test/ then run node --test
npm run test:stress      # compile and run the opt-in 10-seed event-store stress gate
npm run test:build-artifacts  # rebuild and smoke-test the bundled worker
npm run memory-vault -- validate   # run the built CLI without npm link (package is private; bin is link-only)
```

Run a single test file:

```bash
npm run test:build       # tsc -p tsconfig.test.json -> dist-test/
node --test --test-reporter=spec "dist-test/tests/frontmatter.test.js"
```

Tests are flat `tests/*.test.ts` files run with the Node built-in test runner on the supported Node.js 24.16.0+ runtime — no Jest/Vitest. `tsconfig.test.json` compiles **both** `src/` and `tests/` with `rootDir: '.'` into `dist-test/`, which is why compiled tests live at `dist-test/tests/*.test.js` and import production code as `../src/<path>.js`. Two pitfalls: running `node --test` without re-running `test:build` executes stale output, and tsc never cleans `dist-test/` — deleted/renamed tests leave stale `.js` files that still execute (delete `dist-test/` when in doubt). Ordinary `npm test` intentionally skips the 10 release-stress seeds; run `npm run test:stress` explicitly for that gate. `.github/workflows/ci.yml` runs the runtime probe, typecheck, tests, build, and artifact smoke test on Ubuntu and Windows at Node.js 24.16.0, plus a negative gate proving Node.js 22.22.3 is rejected before authoritative-store access. `.github/workflows/sqlite-stress.yml` runs the serialized stress suite weekly or by manual dispatch.

## Build is obfuscated

`npm run build` (`scripts/build.js`) has four stages: (1) esbuild bundles `src/index.ts` → `dist/index.js` (ESM, minified, `packages: 'external'` — node_modules are *not* bundled, so `dist/` still needs `node_modules` at runtime); (2) `javascript-obfuscator` rewrites `dist/index.js` in place — only the server entry is obfuscated; (3) esbuild bundles `src/cli.ts` → `dist/cli.js` (minified, **not** obfuscated, shebang banner); (4) esbuild bundles the unobfuscated `src/workers/project-store.worker.ts` → `dist/workers/project-store.worker.js` so worker failures remain diagnosable. It also writes `dist/build-info.json`, which is read at runtime by the doctor diagnostics (missing → `BUILD_INFO_MISSING` issue with an `npm run build` remediation). All JavaScript bundles target Node.js 24.16. **`dist/` is gitignored — regenerate it, never hand-edit it.** MCP clients load `dist/index.js`, so after any source change you must `npm run build` and reload the client for it to see new behavior.

## Architecture

Strict MVC-ish layering, wired together in `src/app.ts` (`bootstrap()`), the single composition root. `src/index.ts` just re-exports it — but note `bootstrap()` **self-invokes at module load** (bottom of `app.ts`), so importing the entry module starts the stdio server as a side effect; tests import services directly for this reason.

```
schemas/        Zod input schemas for every tool (schemas/memory.ts, schemas/common.ts)
controllers/    Register tools on the McpServer + adapt input/output. One per tool group.
services/       All business logic. Controllers hold no logic; services/embedding/ holds Tier-3 providers.
repositories/   Vault/file + index access (note.repository, vault.repository, index.repository)
models/         Typed note shapes (adr, mistake, session-log, note, frontmatter)
config/         memory.config (vault resolution + MCP doctor), frontmatter.config, embedding.config, vault-policy
utils/          Frontmatter parsing/schema, formatting, search machinery (bm25, ngram, vector, sections, links)
```

Data flow: `McpServer` (stdio) → **Controller** (`register(server)` calls `server.registerTool(name, {description, inputSchema, annotations}, handler)`) → **Service** → **Repository** → vault files. Every tool returns a uniform envelope built by `ToolResponseService` (`{ ok, data, warnings, meta }`, or `{ ok:false, error, meta }`), delivered as a **compact** JSON text block plus `structuredContent`; handlers wrap service calls with `responses.buildOk(...)`. All input schemas are `.strict()` (unknown keys are rejected, not silently stripped) and date fields require `YYYY-MM-DD`.

The six controllers map to tool groups: `NoteController` (read), `WriteController` (write), `VerifyController` (verification), `FrontmatterController`, `MaintenanceController` (bootstrap/reindex/compact/export-import stubs/diagnose), `WorkflowController` (session lifecycle + the 4 MCP prompts). To add a tool: define its Zod schema in `schemas/`, add logic in a service, register it in the matching controller, and wire any new service in `bootstrap()`.

`MemoryWorkflowService` is the orchestration hub — it composes nearly every other service (query, health, notes, templates, audit, usage, compactor, lifecycle, followUps) to implement the session-start → context-pack → self-check → session-end flow.

## Search/index subsystem (three tiers)

`IndexRepository` + `MemoryQueryService` implement vault search in three layered tiers:

- **Tier 1 — persistent incremental index + BM25.** The index persists at `<vault>/.memory-mcp/index.json` (gitignored, version-stamped — vectors stored as base64 Float32, atomic tmp+rename writes, self-healing if corrupt). Ranking is field-weighted Okapi BM25 (`utils/bm25.ts`): title ×3, tags/aliases ×2, body capped at 12000 chars. The usage boost applies only to docs whose BM25 score > 0 and is capped at 0.75× that score, so popular-but-irrelevant notes cannot outrank exact matches.
- **Tier 2 — backlink graph + section anchors.** Wikilinks are extracted by `utils/links.ts` (the same extractor the health scan uses, so they can't drift); a lazy reverse-link graph resolves targets with precedence path/basename > title/id > aliases. `memory_get` returns `incomingLinks`; `memory_search` with `includeSections: true` attaches `{section, line, snippet}` heading anchors.
- **Tier 3 — optional embeddings + hybrid ranking.** With a provider configured, `rankHybrid()` fuses three *rank* lists via Reciprocal Rank Fusion (k=60): BM25, cosine vector (capped at top 25, cosine < 0.15 filtered out), and usage (re-ranks already-surfaced candidates only). With embeddings off, results are byte-identical to plain BM25.

Freshness: there is **no file watcher** — every read tool lazily runs `snapshotIndex()`, re-parsing only files whose mtime changed and pruning deletions. `memory_reindex` (forced full rebuild) is almost never needed. `updatedAt`/`createdAt` in index records come from **frontmatter** (`updated`/`last-verified`, `created`/…), not file mtime, so `memory_recent` ordering depends on frontmatter hygiene. Thai/CJK/Hangul get char 2/3-grams (`utils/ngram.ts`) so non-spaced scripts are searchable; keep `tokenize` (bm25.ts) as the canonical word tokenizer — `usage.json` context keys depend on it.

`memory_contextPack` shares this stack: it gets relevance from `MemoryQueryService.rankFor(terms)` (BM25 over the full indexed text + the capped usage boost, with the usage booster built once per call), then layers mode-preset type weights and open-mistake/ADR bonuses under a maxItems/maxChars budget. A relevance gate excludes records with zero term relevance — type weight alone cannot admit a note. Pack items are lean (`path/title/type/score/tags/updatedAt/excerpt`; no usage telemetry on the wire).

Embeddings are env-gated, **off by default**: `MEMORY_EMBEDDINGS=none|hash|http` (`openai`/`ollama` alias to http; unknown values fail safe to `none`), `MEMORY_EMBEDDINGS_DIM` (default 256, clamped 32–4096; sent to http providers when set), `MEMORY_EMBEDDINGS_ENDPOINT` + `MEMORY_EMBEDDINGS_MODEL` (both required for http — provider creation throws; `bootstrap()` catches, logs to stderr, and continues lexical-only), `MEMORY_EMBEDDINGS_API_KEY`, `MEMORY_EMBEDDINGS_TIMEOUT_MS` (default 15000). Only `memory_search` triggers embedding (at most 4 batches of 32 per call — a large backlog is worked off across calls; query vectors are LRU-cached; `get`/`recent`/`list` never embed); any provider failure starts a 60s cooldown and silently degrades to lexical — "semantic search not working" is usually this, check stderr. The index stores the embedder signature (`hash:v1:<dims>` / `http:<model>:<dims>`); on mismatch only cached vectors are dropped and re-embedded, lexical fields survive, and a lexical-only process preserves (never wipes) vectors written by an embedding-enabled process.

## Vault location resolution (the subtle part)

`config/memory.config.ts` decides **where the `memory/` vault lives**, and this is the trickiest logic in the codebase. An MCP server is usually spawned with a `cwd` of the *client's* install dir, not the user's project, so the vault can easily be created in the wrong place. Resolution order in `loadMemoryConfig` / `resolveDynamicProjectRoot`:

1. Explicit env: `MEMORY_PROJECT_ROOT` / `PROJECT_ROOT` / `WORKSPACE_ROOT` wins outright — unless set to a dynamic sentinel (`auto`/`detect`/`dynamic`/`workspace`, case-insensitive).
2. **Vault-marker pass**: all env candidates (`MEMORY_WORKSPACE_ROOT`, `WORKSPACE_ROOT`, `PROJECT_ROOT`, `INIT_CWD`, `PWD`, `OLDPWD`) *and* `cwd` — first whose walk-up finds the vault marker `memory/AGENTS.md`.
3. Intentional env only (`MEMORY_WORKSPACE_ROOT`, `WORKSPACE_ROOT`, `PROJECT_ROOT`, `INIT_CWD` — *not* `PWD`/`OLDPWD`) — first that walks up to any workspace marker (`.git`, `AGENTS.md`, `GEMINI.md`, `package.json`, `memory/AGENTS.md`).
4. **IDE-state probing**: last-active workspace from VS Code-derived products (`<appdata>/<product>/User/globalStorage/storage.json` — Windsurf, Windsurf-Next, Cursor, Code, VSCodium, Antigravity/"Antigravity IDE", Kiro, devin), OpenCode (`opencode.global.dat`), and Zed (`db.sqlite` via feature-detected `node:sqlite`, so older Node degrades gracefully). Candidates already containing `memory/AGENTS.md` win.
5. `PWD`/`OLDPWD` walk-up to any workspace marker (incidental shell residue is deliberately the *last* env tier), then the raw IDE-state path, else `cwd`.

The walk-up never accepts the user's home directory or a filesystem root as a workspace. The resolved config carries provenance (`config.resolution = { source, vaultMarkerFound }`), and the doctor raises a `PROJECT_ROOT_UNVERIFIED` warning when the root came from IDE state/incidental env/fallback without a vault marker. `memory_bootstrapProject` pins the **literal** project root in the configs it generates (the `dynamic` sentinel is opt-in), and doctor remediation snippets do the same.

Env overrides: `MEMORY_VAULT_DIR` (default `memory`), `MEMORY_VAULT_PATH` (absolute path, bypasses project-root + dir join). When in doubt, set `MEMORY_PROJECT_ROOT` explicitly. The `__internals` export and `diagnoseMemoryConfig` exist for tests and the diagnose CLI; keep `__internals` tight.

**MCP doctor**: `diagnoseMemoryConfig()` returns a `doctor` payload — environment checks plus a scan of 7 clients' *project-local* MCP configs (claude-code `.claude/settings.local.json` + `.mcp.json`, codex `.codex/config.toml`, cursor `.cursor/mcp.json`, windsurf, zed, opencode, antigravity) and the *global* `~/.claude.json` (scope `global`; suppresses false `NO_CLIENT_CONFIGS_FOUND`/`CLIENT_CONFIG_MISSING` alarms for global setups) — emitting coded issues (`VAULT_ROOT_MISSING`, `PROJECT_ROOT_UNVERIFIED`, …) with ready-to-paste remediation snippets. It lives entirely in `memory.config.ts` (*not* a service) and is surfaced via the `memory_diagnoseWorkspace` tool and `memory-vault diagnose` — there is no `doctor` subcommand. It's the first stop for "vault resolved to the wrong place" bugs.

## memory-vault CLI

`dist/cli.js` (`bin: memory-vault`, source `src/cli.ts`) is a standalone frontmatter validator/fixer and explicit V2 administrator. Legacy commands are `validate`, `report` (= validate with markdown output), `fix`, `migrate` (`--rollback`), `init`, and `diagnose`. V2 administration commands are `orchestrator-init`, `orchestrator-status`, and `orchestrator-integrity`; all require literal `--project-root` and `--vault` paths. `orchestrator-init` is inspection-only unless `--apply` is supplied, copied descriptors without local store evidence additionally require `--replica initialize-local`, and integrity uses `--full` for the full chain check. These commands do not enable V2 MCP traffic or primary-mode cutover. Footguns: fix/migrate are dry-run by default (`--apply` to write); `--unsafe` without `--confirm` silently applies only safe fixes; `--no-backup` is accepted but deliberately **ignored** — a timestamped backup is always taken before writes; `diagnose` ignores `--vault` and uses `process.cwd()`. Exit codes are CI-oriented: validate/report exit 1 on error/critical findings, fix/migrate exit 1 when manual-attention items remain, 2 for bad usage.

Frontmatter rules come from layered config — built-in defaults → `~/.memory-vault/frontmatter.config.json` → `<vault>/.memory-mcp/frontmatter.config.json` (the project layer lives *inside the vault*, not at project root). Array fields (`dateFields`, `validTypes`, `semanticExemptPaths`) are set-unioned across layers while `keyOrder`/`strictUnknownFields` are overridden; malformed layers are skipped non-fatally. Default `semanticExemptPaths` is `99_Templates/**` (`config/vault-policy.ts`). See `docs/frontmatter.config.schema.json` and `docs/frontmatter-system-th.md` (Thai design doc for the never-throw parser and severity taxonomy).

## Session lifecycle mechanics

- `memory/.memory-mcp/lifecycle.json` holds `activeSession` + the last 20 sessions (≤30 events each); both it and `usage.json` are written atomically (tmp + rename), and per-note usage `contexts` are capped at the top 40 terms. A new `sessionStart` archives any still-active session with `lastQualityGate: null` and `endReason: 'superseded'` (gate-history readers must null-check). `memory_awaken` is lifecycle-non-mutating — it never starts, rotates, or supersedes a session. `contextPack`/`selfCheck`/`sessionEnd` without a prior `sessionStart` create an implicit session that fails the gate's sessionStart check.
- `sessionEnd` writes the session log, then **auto-compacts** session logs into `07_Insights` once ≥5 logs have accumulated (`minSessions: 5`; disable with `autoCompact: false`), reporting lean `candidateCount`/`candidatePaths`, then runs `verifyVault` (unless `verify: false`). The risky-work gate matches whole tokens (English **and** Thai keywords).
- Quality gate `ok: true` requires score ≥ 85 **and** zero vault health errors **and** verification ran — `sessionEnd` with `verify: false` can never produce `ok: true`.

## Note on the project's own `memory/` vault and agent rules

This repo dogfoods itself: the populated `memory/` vault plus root agent-rule files (`AGENTS.md`, `.rules`, `.windsurfrules`, `GEMINI.md`) are the source of the Full-Auto memory protocol described at the top of this file. When editing this server's own source, the vault under `memory/` is also live test/example data for the very tools you're changing — don't confuse it with the code in `src/`, and expect your own `memory_*` calls to read/write it.

Encoding: source comments and the vault contain multi-byte UTF-8 (em-dashes, arrows, Thai text). Edit with UTF-8-safe tooling — a non-UTF-8 write has already corrupted `memory.config.ts` comments once (U+FFFD mojibake); on PowerShell 5.1 pass `-Encoding utf8` explicitly.
