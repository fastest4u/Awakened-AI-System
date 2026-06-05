---
title: "2026-05-23 - Add IDE-state-based workspace auto-detection to memory config"
type: session-log
agent: cascade
session-date: "2026-05-23"
duration-minutes: 35
outcomes:
  - "Added IDE-state-based workspace auto-detection to project-memory MCP. resolveDynamicProjectRoot() now probes VS Code-derived IDE storage files (Windsurf, Windsurf-Next, Cursor, Code, VSCodium) for the active workspace when env/cwd-based detection yields nothing."
  - "Implemented decodeFileUri() with proper handling of Windows drive-letter URIs (file:///c%3A/...) and POSIX URIs."
  - Added a vault-marker-first ranking so multi-window IDE setups still pick the project the user has opted-in to memory MCP.
  - "Added Node built-in test runner suite tests/memory.config.test.ts covering 28 cases across decodeFileUri, ideStorageFiles, readIdeWorkspaceCandidates, pickIdeActiveWorkspace, findIdeActiveWorkspace, loadMemoryConfig, and resolveDynamicProjectRoot priority order. All 28 pass on Windows."
  - "Added tsconfig.test.json plus npm scripts test:build and test that compile to dist-test/ and run node --test."
  - "Updated README with new Auto-detect Workspace section, troubleshooting guidance, and documented the npm run test command."
  - "Verified behaviour with a direct loadMemoryConfig probe: simulated Windsurf-install cwd resolved to projectRoot=c:/Users/Server/Desktop/Awakened-AI-System and vaultRoot=.../memory."
  - "Built dist/index.js (esbuild + obfuscator) successfully. MCP server initialized JSON-RPC handshake without errors."
tags:
  - session-log
  - mcp
  - memory-config
  - workspace-detection
  - project/awakened-ai-system
created: "2026-05-23"
updated: "2026-05-23"
---

# 2026-05-23 - Add IDE-state-based workspace auto-detection to memory config

## TL;DR
- Closed the open follow-up from the previous "dynamic" implementation: full IDE-aware workspace detection now works when MCP is launched from an IDE install dir with no workspace env vars.
- Added cross-platform parsing of `globalStorage/storage.json` (Windows / macOS / Linux) for Windsurf, Windsurf-Next, Cursor, VS Code, and VSCodium.
- New ranking prefers projects with `memory/AGENTS.md` so multi-window users keep getting the right vault.
- Backward compatible: explicit `MEMORY_PROJECT_ROOT`, env overrides, and the existing cwd walk-up still run in their existing order.
- 28/28 unit tests passing; production build green.

## Goal
Answer the user's question — "MEMORY_PROJECT_ROOT รู้เองได้ไหมว่าควรดึง memory บันทึก memory ไว้ที่ไหน โดยไม่ต้องกำหนด" — by making the existing `dynamic` mode actually detect the workspace when running under Windsurf, Cursor, or VS Code.

## What Was Done
- Investigated the active MCP server: `memory_sessionStart` reported `vaultRoot=C:\Users\Server\AppData\Local\Programs\Windsurf\memory` with `files: 0`, confirming the bug — auto-detect was falling back to the IDE install folder because Windsurf does not pass workspace env vars and launches MCP from its own install directory.
- Inspected Windsurf state at `%APPDATA%\Windsurf\User\globalStorage\storage.json` and `workspaceStorage\<hash>\workspace.json` to map what data is reliably available (`windowsState.lastActiveWindow.folder`, `backupWorkspaces.folders[]`, encoded as `file:///c%3A/...` URIs).
- Extended `src/config/memory.config.ts`:
  - Added `decodeFileUri()` with safe fallback on malformed encoding and explicit handling of Windows drive-letter URIs.
  - Added `ideAppDataRoots()` and `ideStorageFiles()` for cross-platform path resolution including `XDG_CONFIG_HOME` on Linux.
  - Added `readIdeWorkspaceCandidates()` (with an injectable fs for tests) and `pickIdeActiveWorkspace()` with vault-marker-first ranking.
  - Wired `findIdeActiveWorkspace()` into `resolveDynamicProjectRoot()` between explicit env vars and `cwd`, with a final fallback to the IDE-reported path even if it has no markers yet.
  - Exported `__internals` for unit testing without polluting the public API surface.
- Added `tests/memory.config.test.ts` with 28 cases using Node 24's built-in `node --test` runner. Mocked fs via the new injection point for `readIdeWorkspaceCandidates`; used real temp dirs for everything that touches `existsSync` directly.
- Added `tsconfig.test.json` (extends the main config, emits to `dist-test/`) and two npm scripts: `test:build` and `test`.
- Updated `.gitignore` to exclude `dist-test/`.
- Documented the new behaviour in `README.md` with a dedicated **Auto-detect Workspace** section, refreshed the **Environment Variables** table, expanded the **Troubleshooting → Vault ถูกสร้างผิดที่** subsection, and added the test command to the scripts table.
- Verified with a direct `loadMemoryConfig` probe: simulated cwd `C:/Users/Server/AppData/Local/Programs/Windsurf` plus `MEMORY_PROJECT_ROOT=dynamic` correctly resolved to `projectRoot=c:\Users\Server\Desktop\Awakened-AI-System` and `vaultRoot=...\memory`.
- Wrote ADR `04_Architecture_Decisions/add-ide-state-based-workspace-auto-detection.md`.

## Files Touched
- C:/Users/Server/Desktop/Awakened-AI-System/src/config/memory.config.ts
- C:/Users/Server/Desktop/Awakened-AI-System/tests/memory.config.test.ts (new)
- C:/Users/Server/Desktop/Awakened-AI-System/tsconfig.test.json (new)
- C:/Users/Server/Desktop/Awakened-AI-System/package.json
- C:/Users/Server/Desktop/Awakened-AI-System/.gitignore
- C:/Users/Server/Desktop/Awakened-AI-System/README.md
- C:/Users/Server/Desktop/Awakened-AI-System/dist/index.js
- C:/Users/Server/Desktop/Awakened-AI-System/memory/04_Architecture_Decisions/add-ide-state-based-workspace-auto-detection.md (new)
- C:/Users/Server/Desktop/Awakened-AI-System/memory/05_Agent_Session_Logs/2026-05-23-add-ide-state-based-workspace-auto-detection-to-memory-config.md (this file)

## Decisions Made
- Probe a fixed list of VS Code-derived IDE product directories (Windsurf, Windsurf-Next, Cursor, Code, VSCodium) instead of trying to auto-discover every JSON file under app-data. Avoids accidental reads from unrelated tools and keeps the surface predictable.
- Rank vault-marker candidates above plain workspace markers so multi-window users keep getting their vault project. Documented as a heuristic — explicit `MEMORY_PROJECT_ROOT` remains the deterministic escape hatch.
- Use Node's built-in `node --test` runner instead of pulling in a third-party test framework. Keeps deps to zero new packages.
- Expose an `__internals` object instead of re-exporting individual helpers, so the public API surface stays exactly `loadMemoryConfig`.

## Open Follow-ups
- [ ] User must reload Windsurf so the running MCP server picks up the rebuilt `dist/index.js`. The current Cascade session is still talking to the old MCP process whose `vaultRoot` is `C:\Users\Server\AppData\Local\Programs\Windsurf\memory`; any `memory_*` writes during this session land there until restart.
- [ ] After restart, run `memory_sessionStart` again and confirm `vaultRoot` is `c:/Users/Server/Desktop/Awakened-AI-System/memory`.
- [ ] Optional: extend detection to non-VS-Code-derived IDEs (Zed uses SQLite at `~/.local/share/zed/db`; OpenCode/Codex storage layouts not yet investigated).

## References
- 2026-05-23-implement-dynamic-memory-project-root-detection-for-project-memory-mcp.md (introduced the "dynamic" alias and cwd walk-up; this session adds the missing IDE-state layer)
- 2026-05-23-check-whether-project-memory-mcp-uses-dynamic-workspace-detection.md (raised the open follow-up that this session closes)
- src/config/memory.config.ts
- tests/memory.config.test.ts
- README.md (Auto-detect Workspace section)

## Verification
- `npm run typecheck` — green
- `npm run test` — 28 pass / 0 fail / 0 skip across 8 suites (decodeFileUri, isDynamicRootValue, ideStorageFiles, readIdeWorkspaceCandidates, pickIdeActiveWorkspace, findIdeActiveWorkspace, loadMemoryConfig, resolveDynamicProjectRoot priority order)
- `npm run build` — esbuild + obfuscator both succeeded; `dist/index.js` rewritten
- Direct probe: `node -e "import('./dist-test/.../memory.config.js').then(m => m.loadMemoryConfig({MEMORY_PROJECT_ROOT:'dynamic',APPDATA:process.env.APPDATA},'C:/Users/Server/AppData/Local/Programs/Windsurf'))"` returned `projectRoot=c:\Users\Server\Desktop\Awakened-AI-System`, `vaultRoot=...\memory` — exactly the desired outcome.
- MCP stdio handshake: piped a JSON-RPC `initialize` request to the rebuilt `dist/index.js`; the server processed it and exited cleanly when stdin closed (no startup errors).

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Windsurf stores workspace at `windowsState.lastActiveWindow.folder` in `globalStorage/storage.json` | high | Confirmed by reading the live file; matches VS Code's documented schema. | None new — keep relying on VS Code-derived layouts. |
| Node built-in `node --test` can run TS via `tsc -p tsconfig.test.json && node --test dist-test/...` without extra deps | high | Worked on first try after fixing two TS overload casts and three Windows path-separator test issues. | Keep platform-specific tests separator-agnostic via a `toPosix` helper instead of asserting raw `path.join` output. |
| Memory writes from this Cascade session land in the wrong vault until Windsurf restarts | high | Confirmed via initial `memory_sessionStart` returning `vaultRoot=...\Windsurf\memory`. ADR and session log written directly to the real vault via the file edit tools as a workaround. | When the MCP-resolved vault is wrong, write notes via direct file IO into the real vault and explicitly call out the restart requirement. |
