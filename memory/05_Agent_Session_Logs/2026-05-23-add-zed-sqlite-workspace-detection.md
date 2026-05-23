---
title: 2026-05-23 - Add Zed SQLite-based workspace detection
type: session-log
session-date: 2026-05-23
agent: cascade
duration-minutes: 30
outcomes:
  - "Closed Zed coverage gap from previous ADR. Zed users now get full auto-detect via SQLite workspaces table read - same first-class status as Cursor and OpenCode."
  - "Discovered Node 22.5+'s built-in node:sqlite makes a SQLite reader feasible without breaking the zero-runtime-dep philosophy. Node 24 (current) has it stable without flags."
  - "Added tryLoadSqlite() with createRequire-based feature detection so older Node runtimes (pre-22.5) silently no-op rather than crash."
  - "Added zedAppDataRoots() / zedDbFiles() for cross-platform paths - Windows uses LOCALAPPDATA + 'Zed', macOS uses Library/Application Support + 'Zed', Linux uses XDG_DATA_HOME or ~/.local/share + lowercase 'zed'. Probes 0-stable / 0-preview / 0-dev release channels."
  - "Added decodeZedPathsColumn() handling both shapes Zed has historically used for the paths column (JSON-encoded array of folders, single-path string)."
  - "Added readZedWorkspaceCandidates() with injectable existsSync and sqliteLoader for tests. Gracefully no-ops on missing sqlite, missing db file, schema mismatch, or open failure."
  - "Wired Zed candidates into findIdeActiveWorkspace() after VS Code-derived and OpenCode candidates."
  - "Added 13 new unit tests (52 total, all green): zedDbFiles paths across platforms, decodeZedPathsColumn for various shapes, readZedWorkspaceCandidates with mocked sqlite covering success path, missing sqlite, throwing prepare/all, and throwing constructor."
  - "Updated README: refreshed compatibility matrix to show Zed with both ✅ marks (cwd + IDE state), added Node 22.5 minimum-version note, removed prior 'ทำงานผ่าน cwd เท่านั้น' caveat for Zed."
  - "Built dist/index.js. Live verification: readZedWorkspaceCandidates() returned [SPX (lastActive), laravel, Awakened-AI-System] from the user's real Zed 0-stable database, exactly matching Zed's recent-workspaces UI."
created: 2026-05-23
updated: 2026-05-23
tags:
  - session-log
  - mcp
  - memory-config
  - workspace-detection
  - zed
  - sqlite
  - project/awakened-ai-system
---
# 2026-05-23 - Add Zed SQLite-based workspace detection

## TL;DR
- User pushed back on the "Zed ไม่รองรับ project root หรอ" gap from the previous ADR. Investigation showed `node:sqlite` is built into Node 22.5+ (stable, no flag in Node 24+), so a Zed reader adds zero runtime deps.
- Implemented full Zed SQLite reader with cross-platform paths, multi-channel probing, schema decoder, and 13 new mocked + live-verified tests (52 total).
- Updated README compatibility matrix - Zed now shows ✅ on both detection columns.
- Live test on the user's machine confirmed correct workspace ordering (SPX → laravel → Awakened-AI-System) matching Zed's recent-workspaces UI.

## Goal
Close the remaining IDE-detection gap (Zed) so the answer to "ทุก IDE ทำงานถูกต้องโดยไม่ต้องตั้ง MEMORY_PROJECT_ROOT?" is unambiguously "yes" for all the major AI IDEs the user listed.

## What Was Done
- Verified Node 24 has `node:sqlite` available without `--experimental-sqlite` flag.
- Live-probed the user's real Zed database at `C:/Users/Server/AppData/Local/Zed/db/0-stable/db.sqlite` to confirm the schema: `workspaces` table with `paths`, `timestamp`, plus 30+ other columns we don't need.
- Confirmed `paths` column stores JSON-encoded folder lists like `"C:\\Users\\Server\\Desktop\\SPX"`.
- Extended `src/config/memory.config.ts`:
  - Imported `createRequire` from `node:module` for sync feature detection
  - Added `tryLoadSqlite()` — memoised, returns `null` if `node:sqlite` not available
  - Added `zedAppDataRoots()` — platform-specific (Windows → LOCALAPPDATA + Zed; macOS → Library/Application Support + Zed; Linux → XDG_DATA_HOME or ~/.local/share + lowercase zed)
  - Added `zedDbFiles()` — multiplies roots × release channels (`0-stable`, `0-preview`, `0-dev`)
  - Added `decodeZedPathsColumn()` — handles JSON array, JSON string, raw string
  - Added `readZedWorkspaceCandidates()` — sync, injectable existsSync + sqliteLoader, multiple try/catch boundaries for graceful failure
  - Wired into `findIdeActiveWorkspace()` after VS Code-derived and OpenCode candidates
  - Exposed new helpers in `__internals` for tests
- Extended `tests/memory.config.test.ts`:
  - Added `zedDbFiles` suite (5 cases): Windows + macOS + Linux + XDG_DATA_HOME + missing-env
  - Added `decodeZedPathsColumn` suite (4 cases): JSON array, JSON string, literal path, edge cases
  - Added `readZedWorkspaceCandidates` suite (4 cases): no sqlite, success ordering, prepare/all throws, constructor throws
- Updated `README.md`:
  - Replaced VS Code-only IDE list with full list including Antigravity/Antigravity IDE
  - Added explicit OpenCode + Zed entries with paths and Node 22.5 note
  - Refreshed compatibility matrix: Zed flipped from "ทำงานผ่าน cwd เท่านั้น" to "ทำงาน 2 ทาง" with both ✅
- Removed temp probe script `scripts/probe-zed-db.mjs` after verification
- Built `dist/index.js` via `npm run build` — green

## Files Touched
- C:/Users/Server/Desktop/Awakened-AI-System/src/config/memory.config.ts
- C:/Users/Server/Desktop/Awakened-AI-System/tests/memory.config.test.ts
- C:/Users/Server/Desktop/Awakened-AI-System/README.md
- C:/Users/Server/Desktop/Awakened-AI-System/dist/index.js
- C:/Users/Server/Desktop/Awakened-AI-System/memory/04_Architecture_Decisions/add-zed-sqlite-workspace-detection.md (new)
- C:/Users/Server/Desktop/Awakened-AI-System/memory/05_Agent_Session_Logs/2026-05-23-add-zed-sqlite-workspace-detection.md (this file)

## Decisions Made
- Use `createRequire` for sync sqlite feature detection. Reason: keeping `loadMemoryConfig` synchronous is much less invasive than threading async through every callsite. The cost is one inline `require()` attempt at startup, cached in a module-scoped variable.
- Probe all three release channels (`0-stable`, `0-preview`, `0-dev`). Reason: Zed users on canary builds use different channels; cost is two extra `existsSync` calls per startup.
- Treat missing/locked/migrated databases as silent skip (continue). Reason: never crash the MCP server because a sibling IDE has its database locked or got renamed in a Zed update.
- Decode `paths` column with try-JSON-array-then-JSON-string-then-literal. Reason: Zed has stored this column in multiple shapes across versions; defensive decoding prevents past versions from breaking detection.
- Don't add `engines` constraint to `package.json`. Reason: only Zed detection requires Node 22.5; the rest works on older Node. Hard-pinning would be too aggressive.

## Open Follow-ups
- [ ] User must reload Windsurf so the running MCP server picks up the rebuilt dist/index.js. This Cascade session's MCP writes still land in the wrong vault until then.
- [ ] After reload, run memory_sessionStart and confirm vaultRoot = c:/Users/Server/Desktop/Awakened-AI-System/memory.
- [ ] Optional: add a `memory_diagnoseWorkspace` MCP tool that prints all detection candidates ordered by priority for debugging multi-IDE setups.
- [ ] Optional: declare a soft minimum Node version in README so users on Node 20 know Zed detection silently no-ops.

## References
- 2026-05-23-extend-workspace-detection-to-antigravity-and-opencode.md (parent session — deferred Zed which this session closes)
- 2026-05-23-add-ide-state-based-workspace-auto-detection-to-memory-config.md (grandparent session — original IDE state detection)
- 04_Architecture_Decisions/add-zed-sqlite-workspace-detection.md (this session's ADR)
- src/config/memory.config.ts
- tests/memory.config.test.ts
- README.md (Auto-detect Workspace + IDE Compatibility Matrix sections)

## Verification
- `npm run typecheck` — green (zero errors)
- `npm run test` — 52/52 pass / 0 fail / 0 skip across 15 suites
- `npm run build` — esbuild + obfuscator both succeeded; `dist/index.js` rewritten
- Live disk verification: `node -e ...` invoked `readZedWorkspaceCandidates()` against the real Zed `0-stable` database and got back `[SPX (lastActive=true), laravel, Awakened-AI-System]` — order matches Zed's UI exactly. Combined with VS Code-derived + OpenCode candidates, `findIdeActiveWorkspace()` picked `Awakened-AI-System` (vault-bearing + Windsurf lastActive).

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Node 22.5+ has node:sqlite built in without a flag | medium | high — Node 24.15.0 in use here loads it via `require('node:sqlite')` directly with `DatabaseSync` exported | Always probe runtime capabilities before deciding to defer; what was "needs a native dep" became "zero deps" once I checked. |
| Zed schema is stable enough to query | medium | high — workspaces table has clear `paths`, `timestamp` columns; even with 30+ other fields the query targets only the two we need | Run a one-off probe script before writing the production reader; gives an accurate picture in 30 seconds. |
| createRequire keeps loadMemoryConfig sync without async ripple | high | confirmed — the entire call chain stayed sync, no edits to app.ts needed | createRequire from node:module is the right tool for sync feature-detect of builtins in ESM. |
| Zed detection wouldn't break on locked/migrated databases | medium | high after testing — three failure-path test cases (missing sqlite, throwing constructor, throwing prepare) all silently no-op | Defensive try/catch around every external boundary is the cheapest way to stay correct in heterogeneous environments. |
| Calling memory_selfCheck before memory_sessionStart was a protocol gap I corrected mid-round | high | confirmed — selfCheck warned about the implicit lifecycle, and re-calling sessionStart properly bracketed the work | Run sessionStart **first**, before any other memory_* tool, even when continuing a multi-turn task. The protocol's quality gate enforces this. |
