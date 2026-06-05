---
title: "2026-05-23 - Add Kiro to IDE_PRODUCT_DIRS"
type: session-log
agent: cascade
session-date: "2026-05-23"
duration-minutes: 8
outcomes:
  - "Confirmed Kiro (AWS VS Code fork) uses identical VS Code-derived layout: User/globalStorage/storage.json with windowsState.lastActiveWindow.folder + backupWorkspaces.folders[]."
  - "Added 'Kiro' as an 8th entry in IDE_PRODUCT_DIRS - one-line list change. No new helper functions or schema work needed; the existing readIdeWorkspaceCandidates() handles Kiro immediately."
  - Updated existing ideStorageFiles test to assert /Kiro/User/globalStorage/storage.json is probed.
  - "Updated README compatibility matrix: Kiro now shows ✅ on both cwd and IDE-state columns (per-project + user-level .kiro/settings/mcp.json + Kiro storage.json)."
  - "Live verification: 8 IDE storage files probed, Kiro FOUND, candidates list grew from 9 to 11 (Kiro contributed lastActive=SPX + backup=SPX)."
tags:
  - session-log
  - mcp
  - memory-config
  - workspace-detection
  - kiro
  - project/awakened-ai-system
created: "2026-05-23"
updated: "2026-05-23"
---

# 2026-05-23 - Add Kiro to IDE_PRODUCT_DIRS

## TL;DR
- User asked "Kiro ใช้ได้ไหม". Live disk inspection confirmed Kiro = VS Code fork with identical state-file layout.
- Single-line addition to IDE_PRODUCT_DIRS. Plus matching test assertion + README row.
- 52/52 tests still passing. Build green. Live probe shows Kiro storage.json being read and Kiro's lastActive workspace appearing in candidate list.

## Goal
Close the Kiro coverage gap with the smallest possible change.

## What Was Done
- Probed `%APPDATA%\Kiro\User\globalStorage\storage.json` directly: confirmed VS Code-derived layout with `windowsState.lastActiveWindow.folder` = `file:///c%3A/Users/Server/Desktop/SPX` and `backupWorkspaces.folders` containing the same.
- Added `"Kiro"` to `IDE_PRODUCT_DIRS` in `src/config/memory.config.ts`. Updated the surrounding comment to mention Kiro.
- Added one assertion to the existing `ideStorageFiles` test verifying `/Kiro/User/globalStorage/storage.json` is probed.
- Added a Kiro row to the README **IDE Compatibility Matrix** showing ✅ on both columns. Also added Kiro to the inline list under "VS Code-derived IDE".
- Ran `npm run typecheck` → green; `npm run test` → 52/52 pass; `npm run build` → green.
- Live disk probe confirmed: 8 storage.json files now probed (was 7), Kiro FOUND, total candidates grew from 9 to 11.

## Files Touched
- C:/Users/Server/Desktop/Awakened-AI-System/src/config/memory.config.ts
- C:/Users/Server/Desktop/Awakened-AI-System/tests/memory.config.test.ts
- C:/Users/Server/Desktop/Awakened-AI-System/README.md
- C:/Users/Server/Desktop/Awakened-AI-System/dist/index.js
- C:/Users/Server/Desktop/Awakened-AI-System/memory/05_Agent_Session_Logs/2026-05-23-add-kiro-to-ide-product-dirs.md (this file)

## Decisions Made
- No ADR for this change. The decision logic was already covered by `add-ide-state-based-workspace-auto-detection.md` ("probe a fixed list of VS Code-derived IDE product dirs"); adding another product to that list is an extension, not a new architectural decision.
- Use `"Kiro"` (capitalized) because that's the canonical install directory on Windows. Linux/macOS would also use `Kiro` (Kiro distributes as a single signed app bundle). Windows filesystem is case-insensitive so `kiro` or `Kiro` both resolve to the same path.

## Open Follow-ups
- [ ] User must reload Windsurf so MCP server picks up rebuilt dist/index.js.
- [ ] After reload, run memory_sessionStart and confirm vaultRoot resolves to current project.

## References
- 04_Architecture_Decisions/add-ide-state-based-workspace-auto-detection.md (parent ADR — decision was "maintain a fixed product-dir list")
- 04_Architecture_Decisions/extend-workspace-detection-to-antigravity-and-opencode.md (added Antigravity using the same pattern — Kiro followed the same playbook)
- src/config/memory.config.ts (Kiro added to IDE_PRODUCT_DIRS)
- tests/memory.config.test.ts (Kiro assertion added)
- README.md (Kiro row in compatibility matrix)

## Verification
- `npm run typecheck` — green
- `npm run test` — 52/52 pass / 0 fail / 0 skip across 15 suites
- `npm run build` — esbuild + obfuscator green
- Live disk probe via `node -e ...` confirmed Kiro storage.json is found and parsed. Probed 8 IDE storage files (Windsurf FOUND, Windsurf-Next miss, Cursor FOUND, Code miss, VSCodium miss, Antigravity FOUND, Antigravity IDE FOUND, **Kiro FOUND**); candidates list correctly extended with Kiro's SPX lastActive entry plus backup.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Kiro is a VS Code fork using identical storage layout | high | Confirmed by directly inspecting `%APPDATA%\Kiro\User\globalStorage\storage.json` — same windowsState/backupWorkspaces/profileAssociations schema as Windsurf/Cursor/Antigravity | When a probe takes 30 seconds and removes all guesswork, always probe before adding code. |
| Single-line change is sufficient | high | Confirmed — adding "Kiro" to IDE_PRODUCT_DIRS triggers the existing reader pipeline; no new helpers or branches needed | The right architecture lets new IDEs cost one line of code. The earlier ADR's "maintain a fixed product-dir list" decision is paying off. |
