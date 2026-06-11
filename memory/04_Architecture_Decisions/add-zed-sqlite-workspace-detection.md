---
title: Add Zed SQLite-based workspace detection
type: adr
status: accepted
confidence: high
decision-date: "2026-05-23"
supersedes: []
tags:
  - mcp
  - memory-config
  - workspace-detection
  - zed
  - sqlite
created: "2026-05-23"
updated: "2026-05-23"
---

## Context
The previous ADR `extend-workspace-detection-to-antigravity-and-opencode.md` deferred Zed support because Zed stores workspace history in SQLite (`%LOCALAPPDATA%\Zed\db\0-stable\db.sqlite` on Windows; equivalent paths on macOS/Linux), and adding a SQLite dependency contradicted this project's zero-runtime-dep philosophy. The user pushed back: "Zed ไม่รองรับ project root หรอ" — flagging that the README compatibility matrix made Zed feel like a second-class citizen even though cwd walk-up handled it for typical setups.

Investigation surfaced two facts that changed the trade-off:

1. **`node:sqlite` is built into Node 22.5+** (stable, no flag in Node 24+). Reading Zed's database adds *zero* native dependencies — it only pins a minimum Node version, which we can detect at runtime.
2. **Zed's schema is stable and easy to query**. The `workspaces` table has `paths` (a JSON-encoded folder list, or a single path string) and `timestamp` (sortable text). A single query reproduces what Zed shows in its "Recent" picker:

   ```sql
   SELECT paths, timestamp FROM workspaces
   WHERE paths IS NOT NULL
   ORDER BY timestamp DESC LIMIT 20
   ```

Live probe against the user's machine confirmed the schema and produced the expected ordering: SPX (last opened) → laravel → Awakened-AI-System.

## Decision
1. Add a Zed SQLite reader in `src/config/memory.config.ts`:
   - `tryLoadSqlite()` — memoised feature-detect via `createRequire("node:sqlite")`. Returns `null` on failure (older Node). Synchronous so it does not propagate async through `loadMemoryConfig`.
   - `zedAppDataRoots()` / `zedDbFiles()` — cross-platform path resolution. Windows: `LOCALAPPDATA\Zed`. macOS: `~/Library/Application Support/Zed`. Linux: `$XDG_DATA_HOME` or `~/.local/share/zed` (lowercase product directory). Probes all three release channels: `0-stable`, `0-preview`, `0-dev`.
   - `decodeZedPathsColumn()` — handles both shapes that Zed has historically used for `workspaces.paths` (JSON array of folder paths and raw single-path string).
   - `readZedWorkspaceCandidates()` — sync function with injectable `existsSync` and `sqliteLoader` for tests. Returns empty silently when sqlite is unavailable, when the database file is missing, when the schema does not match, or when the `DatabaseSync` constructor throws (e.g. file locked).
2. Wire Zed candidates into `findIdeActiveWorkspace()` after VS Code-derived and OpenCode candidates so dedup keeps the freshest source first.
3. Document Node 22.5 as the minimum version for Zed detection in README, plus note the graceful no-op fallback for older Node runtimes.

## Consequences
- **Zed users now get full coverage**: cwd walk-up via `.zed/settings.json` *plus* SQLite-based last-active detection. Two-tier detection mirrors what Cursor and OpenCode get with their per-project configs + IDE state files.
- **No new runtime/dev dependencies**. `node:sqlite` is built-in.
- **Effective minimum Node version is 22.5** for Zed detection only. Older Node versions still work for everything else; the Zed reader silently returns `[]`. We do not add `engines` to `package.json` because the rest of the codebase remains compatible with earlier Node 20.x.
- **Cross-platform parity verified**: tests assert correct paths on Windows (`LOCALAPPDATA`), macOS (`Library/Application Support`), and Linux (lowercase `zed` under `XDG_DATA_HOME` or `~/.local/share`).
- **Failure modes covered**: mocked tests cover (a) no sqlite available, (b) DatabaseSync constructor throws, (c) `prepare/all` throws on a schema mismatch. Real-world Zed dbs that get migrated (column rename, table split) will gracefully no-op rather than crash the MCP server.
- **Live verification on the user's Windows machine**: `readZedWorkspaceCandidates()` returned `[SPX (lastActive), laravel, Awakened-AI-System]` from the real `0-stable` database — exactly matching Zed's recent-workspaces UI. Combined with the existing IDE state and OpenCode signals, `findIdeActiveWorkspace()` correctly picked `Awakened-AI-System` (vault-bearing + Windsurf lastActive).
- **Test count grew from 39 to 52** with 13 new cases for `zedDbFiles`, `decodeZedPathsColumn`, and `readZedWorkspaceCandidates` (success path, missing-sqlite path, two failure paths).
- **Zed limitation now closed in the README compatibility matrix** — Zed shows ✅ on both cwd and IDE-state columns, removing the prior "ทำงานผ่าน cwd เท่านั้น" caveat.

## Verification
- `npm run typecheck` green
- `npm run test` — 52/52 pass / 0 fail / 0 skip across 15 suites
- `npm run build` (esbuild + obfuscator) green
- Live disk probe via `node -e "..."` confirmed the reader returns expected paths from the real Zed `0-stable` SQLite database

## Follow-ups
- [ ] Optional: add a `memory_diagnoseWorkspace` MCP tool that prints all detection candidates ordered by priority for debugging multi-IDE setups
- [ ] Optional: declare a soft minimum Node version in README so users on Node 20 know Zed detection silently no-ops
