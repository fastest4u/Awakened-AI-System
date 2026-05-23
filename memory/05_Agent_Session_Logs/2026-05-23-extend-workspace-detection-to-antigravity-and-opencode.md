---
title: 2026-05-23 - Extend workspace detection to Antigravity and OpenCode
type: session-log
session-date: 2026-05-23
agent: cascade
duration-minutes: 25
outcomes:
  - "Added Antigravity (legacy) and Antigravity IDE (current) to IDE_PRODUCT_DIRS — both use VS Code-derived layout so existing readIdeWorkspaceCandidates() handles them immediately."
  - "Added OpenCode reader (readOpencodeWorkspaceCandidates) targeting <app-data>/ai.opencode.desktop/opencode.global.dat with a two-tier extractor: fast structured JSON.parse path, regex fallback for format drift."
  - "Added unescapeJsonString() supporting \\\\, \\\", \\/, and \\uXXXX escape sequences for robust path decoding."
  - "Wired OpenCode candidates into findIdeActiveWorkspace() after VS Code-derived candidates so dedup keeps fresher entries."
  - "Added 11 new unit tests (39 total, all green) covering Antigravity probing, JSON unescape, OpenCode structured+regex parsing, and fs-mocked candidate reads."
  - "Updated README with full IDE compatibility matrix showing each IDE's detection path (cwd, IDE state file, both, or neither)."
  - "Documented Zed limitation (SQLite-based, not yet supported) and the practical workaround (cwd walk-up via per-project .zed/settings.json works for typical Zed launch behavior)."
  - "Built dist/index.js. Verified live: findIdeActiveWorkspace() detected c:/Users/Server/Desktop/Awakened-AI-System on a machine running Windsurf, Cursor, Antigravity, Antigravity IDE, and OpenCode simultaneously."
created: 2026-05-23
updated: 2026-05-23
tags:
  - session-log
  - mcp
  - memory-config
  - workspace-detection
  - antigravity
  - opencode
  - project/awakened-ai-system
---
# 2026-05-23 - Extend workspace detection to Antigravity and OpenCode

## TL;DR
- User asked whether Windsurf, Zed, Antigravity, and OpenCode would all work without explicit MEMORY_PROJECT_ROOT.
- Empirical investigation: Antigravity uses VS Code-derived layout (easy add), OpenCode uses its own JSON-string-of-JSON format (custom reader needed), Zed uses SQLite (deferred).
- Added Antigravity + Antigravity IDE to the IDE list and a dedicated OpenCode reader with structured-then-regex extraction.
- 39/39 tests passing. Production build green. Live disk verification confirms correct workspace detection.

## Goal
Honestly answer the user's compatibility question and close the gap for IDEs not yet covered by the previous ADR.

## What Was Done
- Investigated installed IDEs on the user's Windows machine and discovered:
  - `%APPDATA%\Antigravity\` (legacy, mtime 2026-05-19) and `%APPDATA%\Antigravity IDE\` (current, mtime 2026-05-23) both have full VS Code-derived state files at `User\globalStorage\storage.json`
  - `%APPDATA%\ai.opencode.desktop\opencode.global.dat` (95 KB, JSON-string-of-JSON containing recent directories with timestamps)
  - `%APPDATA%\Zed\` only contains plain `settings.json` — no per-workspace state JSON
  - `%LOCALAPPDATA%\Zed\db\0-stable\db.sqlite` confirmed Zed uses SQLite for workspace state
- Extended `src/config/memory.config.ts`:
  - Added `Antigravity` and `Antigravity IDE` to `IDE_PRODUCT_DIRS` (1-line list change)
  - Added `OPENCODE_PRODUCT_DIR` and `OPENCODE_GLOBAL_FILE` constants
  - Added `opencodeGlobalFiles()` to compute platform-specific candidate paths
  - Added `unescapeJsonString()` for robust JSON escape handling (`\\`, `\"`, `\/`, `\uXXXX`)
  - Added `extractOpencodeDirectories()` with two-tier strategy: fast structured `JSON.parse(outer).<field-as-string>.list[].directory` path with regex fallback that flattens one level of escaping before scanning
  - Added `readOpencodeWorkspaceCandidates()` with fs injection for tests; sets `lastActive=true` on the newest-time directory
  - Wired OpenCode results into `findIdeActiveWorkspace()` alongside VS Code-derived candidates
  - Exposed new helpers in `__internals` for testing
- Hit a real-world bug while writing the OpenCode reader: the file is doubly-escaped (`\"directory\":\"C:\\\\\\\\Users\\\\\\\\Server...`). My initial regex matched `"directory"` (single-quoted) and missed everything. The fix was the structured-first / flatten-then-regex strategy.
- Extended `tests/memory.config.test.ts`:
  - Added Antigravity assertions to the existing `ideStorageFiles` suite
  - Added 4 new suites: `unescapeJsonString`, `opencodeGlobalFiles`, `extractOpencodeDirectories`, `readOpencodeWorkspaceCandidates`
  - 11 new test cases, 39 total, all green
- Updated `README.md`:
  - Replaced the brief auto-detect section with detailed IDE-state coverage and OpenCode-specific format
  - Added an explicit **IDE Compatibility Matrix** table that honestly shows whether each IDE auto-detects via cwd, IDE state, both, or only via explicit override
  - Updated "when to set explicit path" guidance to mention Zed
- Built `dist/index.js` via `npm run build` (esbuild + obfuscator) — green
- Live verification: ran `findIdeActiveWorkspace()` against the real machine and confirmed it correctly returned `c:/Users/Server/Desktop/Awakened-AI-System` while listing all 9 IDE-state candidates and 1 OpenCode candidate

## Files Touched
- C:/Users/Server/Desktop/Awakened-AI-System/src/config/memory.config.ts
- C:/Users/Server/Desktop/Awakened-AI-System/tests/memory.config.test.ts
- C:/Users/Server/Desktop/Awakened-AI-System/README.md
- C:/Users/Server/Desktop/Awakened-AI-System/dist/index.js
- C:/Users/Server/Desktop/Awakened-AI-System/memory/04_Architecture_Decisions/extend-workspace-detection-to-antigravity-and-opencode.md (new)
- C:/Users/Server/Desktop/Awakened-AI-System/memory/05_Agent_Session_Logs/2026-05-23-extend-workspace-detection-to-antigravity-and-opencode.md (this file)

## Decisions Made
- Treat OpenCode's `opencode.global.dat` as the canonical state file (vs `opencode.workspace.<base64>.dat` filenames). Reasons: simpler to parse, contains timestamps for ranking, single file scan vs many.
- Two-tier extractor (structured fast path + regex fallback) instead of just regex. Reasons: structured parse handles new top-level keys gracefully, regex fallback handles format-drift (escape level changes, new wrappers).
- Defer Zed SQLite reader. Reasons: zero-dep philosophy, Zed's per-project `.zed/settings.json` + cwd-from-project launch makes cwd walk-up sufficient for typical Zed users.
- Document compatibility matrix transparently in README (including known limits) rather than overstate coverage.

## Open Follow-ups
- [ ] User must reload Windsurf so the running MCP server picks up the rebuilt dist/index.js. Until then, this Cascade session's MCP writes still land in C:/Users/Server/AppData/Local/Programs/Windsurf/memory.
- [ ] After Windsurf restart, run memory_sessionStart again and confirm vaultRoot resolves to c:/Users/Server/Desktop/Awakened-AI-System/memory.
- [ ] Optional: implement Zed SQLite reader if any Zed user reports auto-detect failure (would need either a sqlite native dep or a `better-sqlite3`-style binding; current bias is to keep zero deps).
- [ ] Optional: add a `memory_diagnoseWorkspace` MCP tool that prints all detection candidates ordered by priority for debugging multi-IDE setups.

## References
- 2026-05-23-add-ide-state-based-workspace-auto-detection-to-memory-config.md (previous session that introduced the IDE state framework this session extends)
- 2026-05-23-implement-dynamic-memory-project-root-detection-for-project-memory-mcp.md (original "dynamic" mode introducing env+cwd detection)
- 04_Architecture_Decisions/add-ide-state-based-workspace-auto-detection.md (parent ADR)
- 04_Architecture_Decisions/extend-workspace-detection-to-antigravity-and-opencode.md (this session's ADR)
- src/config/memory.config.ts
- tests/memory.config.test.ts
- README.md (IDE Compatibility Matrix section)

## Verification
- `npm run typecheck` — green (zero errors)
- `npm run test` — 39/39 pass / 0 fail / 0 skip across 12 suites
- `npm run build` — esbuild + obfuscator both succeeded; `dist/index.js` rewritten
- Live disk verification: `findIdeActiveWorkspace()` returned `c:/Users/Server/Desktop/Awakened-AI-System` while reading 9 unique candidates from Windsurf+Cursor+Antigravity+Antigravity IDE storage.json files plus 1 OpenCode candidate from `opencode.global.dat`. The picker correctly preferred the vault-bearing `lastActive` project from Windsurf's storage.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Antigravity uses VS Code-derived layout because it's a Chromium-based fork | medium | high — confirmed by direct file inspection; both `Antigravity` and `Antigravity IDE` directories have identical `User/globalStorage/storage.json` structure to Windsurf | Trust but verify; checking the actual files took 2 minutes and avoided guessing. |
| OpenCode would have a single readable JSON workspace state file | medium | partial — `opencode.global.dat` is JSON, but doubly-escaped (JSON string of JSON), and there are also `opencode.workspace.<base64>.dat` per-workspace files I chose not to parse | Two-tier extractor (structured + regex) handles this gracefully; trying to parse the .dat per-workspace files would have been more brittle. |
| First regex would handle the OpenCode format | high | wrong — first regex matched `"directory"` patterns but the file has `\"directory\"` (escaped). Tests with the real file caught this immediately | Always run the extractor against the real-world fixture before claiming completeness. The user-facing live probe via `node -e ...` was indispensable. |
| Zed could be added with a small SQLite reader | medium | deferred — adding sqlite would require a native dep, breaking the zero-dep philosophy; Zed's per-project config + cwd-from-project launch makes cwd walk-up sufficient anyway | Sometimes the right answer is "this works fine through another mechanism, document the gap, defer code". |
