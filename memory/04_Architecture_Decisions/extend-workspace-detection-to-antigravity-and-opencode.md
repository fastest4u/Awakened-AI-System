---
title: Extend workspace auto-detection to Antigravity and OpenCode
type: adr
status: accepted
confidence: high
decision-date: "2026-05-23"
supersedes: []
tags:
  - mcp
  - memory-config
  - workspace-detection
  - antigravity
  - opencode
  - cross-ide
created: "2026-05-23"
updated: "2026-05-23"
---

## Context
The earlier ADR `add-ide-state-based-workspace-auto-detection.md` added IDE-state reading for VS Code-derived products (Windsurf, Windsurf-Next, Cursor, Code, VSCodium). The user asked whether **Windsurf, Zed, Antigravity, and OpenCode** would all work without explicit `MEMORY_PROJECT_ROOT`.

Empirical investigation of `%APPDATA%` on Windows showed:

- **Antigravity** (legacy, last opened 2026-05-19) and **Antigravity IDE** (current, last opened 2026-05-23) both ship full VS Code-derived layouts at `<APPDATA>\Antigravity\User\globalStorage\storage.json` and `<APPDATA>\Antigravity IDE\User\globalStorage\storage.json`. They contain `windowsState.lastActiveWindow.folder` and `backupWorkspaces.folders[]` exactly like Windsurf.
- **OpenCode (Tauri desktop)** does **not** use the VS Code layout. Its state lives at `<APPDATA>\ai.opencode.desktop\` with a JSON-string-of-JSON file `opencode.global.dat` that includes `notification.list[].directory` entries plus `time` timestamps for every directory the user has worked in. Trailing entry order = chronological.
- **Zed** stores recent workspaces in SQLite (`%LOCALAPPDATA%\Zed\db\0-stable\db.sqlite`). Reading it would require either a sqlite native dependency or shelling out to `sqlite3` — neither acceptable for a small zero-dep MCP server. Zed's per-project `.zed/settings.json` already pins `MEMORY_PROJECT_ROOT=dynamic` and Zed launches stdio MCP from `cwd = project root`, so cwd walk-up alone is sufficient for Zed in practice.

## Decision
1. **Add `Antigravity` and `Antigravity IDE` to `IDE_PRODUCT_DIRS`** so the existing `readIdeWorkspaceCandidates()` immediately picks them up. No code path changes.
2. **Add an OpenCode-specific reader** (`readOpencodeWorkspaceCandidates`) that targets `<app-data>/ai.opencode.desktop/opencode.global.dat`. The extractor uses a two-tier strategy:
   - **Fast path**: parse the outer JSON, then for each string-valued field re-parse it as JSON, then iterate `list[].directory` + `list[].time`. This is the documented format.
   - **Fallback**: if the structured parse yields zero matches, run a regex sweep on a flattened copy of the raw bytes. Tolerates future format drift (new top-level keys, additional escape layers).
3. **Add a `unescapeJsonString()` helper** that supports `\\`, `\"`, `\/`, and `\uXXXX` so paths from the regex fallback round-trip correctly.
4. **Wire OpenCode candidates into `findIdeActiveWorkspace()`** after VS Code-derived candidates. The dedup pass keeps VS Code-derived entries first because IDE state files are usually fresher than OpenCode's append-only notification log.
5. **Document IDE compatibility matrix** in README so users know exactly which IDEs auto-detect via cwd, IDE state file, both, or neither.
6. **Defer Zed SQLite support** as a follow-up. Zed already works via cwd walk-up because its per-project config makes Zed spawn the MCP server with cwd = project root; only edge cases (running Zed-launched MCP from a non-project cwd) would need it.

## Consequences
- **Antigravity, Antigravity IDE, and OpenCode** now resolve their active workspace automatically when launched as a global MCP server (e.g. `mcp_config.json` user-level installs).
- **Cursor, VS Code, and OpenCode** users who use per-project config files (`.cursor/mcp.json`, `opencode.json`) get redundant detection — both cwd walk-up and IDE state file will resolve correctly. Defense in depth.
- **Zed** users: works via cwd walk-up only. If a Zed user reports the MCP server resolving to the wrong vault, the next step is either (a) hard-pin `MEMORY_PROJECT_ROOT` per project, or (b) implement the SQLite reader.
- **Codex CLI** users: works via cwd because the CLI is invoked from the project directory; no IDE state file applicable.
- Adds 11 new unit tests (39 total) covering Antigravity probing, JSON unescape rules, OpenCode structured + regex extraction paths, and OpenCode fs-mocked candidate reads. Zero new runtime/dev dependencies.
- Adds tiny IO cost on startup: at most 7 × VS Code-derived storage.json + 1 × opencode.global.dat reads, all skipped if the file doesn't exist. Negligible compared to vault scan.
- Format drift safety: OpenCode's `opencode.global.dat` may evolve. The regex fallback ensures the detector won't break even if Tauri renames keys, as long as `"directory":"..."` patterns still appear somewhere in the file.

## Verification
- 39/39 unit tests passing on Windows under Node 24
- Live disk probe: `findIdeActiveWorkspace()` correctly identifies `c:/Users/Server/Desktop/Awakened-AI-System` from a real machine running Windsurf, Cursor, Antigravity, Antigravity IDE, and OpenCode simultaneously, picking the vault-bearing project that Windsurf had as `lastActiveWindow`
- esbuild + obfuscator production build green; no runtime errors during MCP stdio handshake

## Follow-ups
- [ ] Consider Zed SQLite reader if Zed user reports auto-detect failure
- [ ] Investigate Codex CLI workspace state for CI/agent-runner scenarios where cwd may not be the project
- [ ] Add a one-shot diagnostic tool (`memory_diagnoseWorkspace`) that prints all detection candidates ordered by priority for debugging multi-IDE setups
