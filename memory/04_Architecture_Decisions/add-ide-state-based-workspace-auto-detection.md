---
title: Add IDE-state-based workspace auto-detection for project-memory MCP
type: adr
status: accepted
confidence: high
decision-date: "2026-05-23"
supersedes: []
tags:
  - mcp
  - memory-config
  - workspace-detection
  - cross-ide
created: "2026-05-23"
updated: "2026-05-23"
---

## Context
The earlier "dynamic" mode added in `2026-05-23-implement-dynamic-memory-project-root-detection-for-project-memory-mcp.md` resolved `MEMORY_PROJECT_ROOT=dynamic|auto|detect|workspace` by walking up from `process.cwd()` and a small set of workspace-related env vars (`MEMORY_WORKSPACE_ROOT`, `WORKSPACE_ROOT`, `PROJECT_ROOT`, `INIT_CWD`, `PWD`, `OLDPWD`).

That works only when the MCP client launches the server with the project as its `cwd`. Windsurf (and other VS Code-derived IDEs) actually spawn stdio MCP servers from the IDE installation directory, so `cwd = C:\Users\Server\AppData\Local\Programs\Windsurf\` and **none** of the workspace env vars are passed. In that case `findWorkspaceRoot()` walks up from the IDE install dir, finds nothing, and falls back to `resolve(cwd)` — producing `vaultRoot = C:\Users\Server\AppData\Local\Programs\Windsurf\memory`. Memory writes silently land in the IDE install folder.

Empirical confirmation in the active workspace: `memory_sessionStart` returned `vaultRoot: C:\Users\Server\AppData\Local\Programs\Windsurf\memory` with `files: 0`, while the real project vault at `C:/Users/Server/Desktop/Awakened-AI-System/memory` already contained 83 session logs and 5 ADRs.

The open follow-up from the prior session log explicitly called this out: *"If full Dynamic Workspace Detection is desired, implement project-root discovery in project-memory MCP and rebuild/reload clients."* This ADR closes that follow-up.

## Decision
Extend `resolveDynamicProjectRoot()` in `src/config/memory.config.ts` to read the active workspace from VS Code-derived IDE state files when the env-based candidates produce no marker hit. Specifically:

1. Probe `<app-data>/<IDE>/User/globalStorage/storage.json` for **Windsurf, Windsurf-Next, Cursor, Code, VSCodium**.
   - Windows: `%APPDATA%`
   - macOS: `~/Library/Application Support`
   - Linux: `$XDG_CONFIG_HOME` or `~/.config`
2. Extract candidate workspace paths from `windowsState.lastActiveWindow.folder` and `backupWorkspaces.folders[].folderUri`. URIs are decoded with a custom `decodeFileUri()` that handles both `file:///c%3A/...` (Windows) and `file:///home/...` (POSIX).
3. Rank candidates by the presence of `memory/AGENTS.md` (vault marker) first, then by `lastActive`. This ensures that when several projects are open simultaneously, the one the user has actually opted-in to memory MCP wins.
4. Insert the IDE candidate into the existing priority chain **after explicit env vars but before `cwd`**, so user-set overrides still beat IDE state, and IDE state still beats a misleading `cwd`.
5. As a final fallback, if IDE state returned a path but no marker was found anywhere, return `resolve(ideWorkspace)` — supports brand-new projects that haven't been initialized with a vault yet.

A small public hook `__internals` is exported from `memory.config.ts` purely for unit tests; production code continues to use `loadMemoryConfig()`.

## Consequences
- Windsurf, Cursor, and VS Code users with `MEMORY_PROJECT_ROOT=dynamic` (or `auto` / `detect` / `workspace`) now resolve to the correct project vault automatically, even when the MCP server is launched from the IDE install directory.
- Backward compatible: explicit absolute `MEMORY_PROJECT_ROOT` still wins; explicit env overrides still beat IDE state; the previous cwd walk-up still runs first when applicable.
- Multi-window workflow: when the user has several IDE windows open, the heuristic favours projects that already have a `memory/` vault. Users who routinely keep multiple vault-equipped projects open can still pin behaviour by setting `MEMORY_PROJECT_ROOT` to an absolute path.
- Heuristic limit: stale IDE state (e.g. user just switched window without giving the IDE a moment to flush) may still pick the previous workspace. Documented in README troubleshooting.
- Adds a tiny IO cost on startup (one or two JSON reads from app-data); negligible compared to the existing vault scan.
- Adds a Node `--test`-based unit-test suite (`tests/memory.config.test.ts`) and `tsconfig.test.json` so the new logic has regression coverage without introducing new runtime dependencies.
