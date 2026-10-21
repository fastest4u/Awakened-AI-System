# Antigravity instructions for this workspace (Project Memory V2)

This is the project-local AGENTS file Antigravity reads on every turn in this workspace.
The workspace runs **Project Memory V2** (`dist/v2.js`) backed by the append-only SQLite event store and `memory-v2/` vault (`releaseId: d45b1956-e05b-4316-b68d-7014d7dda665`). The legacy `memory/` directory is a frozen read-only V1 archive (`0o444`) and must never be modified.

## Memory V2 Protocol: Mandatory Every Turn

Use the `project-memory` MCP server (V2) as the durable memory source for this project:

1. **Status / Readiness Check (Optional)**: Call `memory_v2Status` to inspect the active V2 store (`mode: "active"`, `productionReady: true`, `generation: "1"`).
2. **Task Start (MANDATORY)**: Call `memory_sessionStart` before other work (`topic` / `taskArea`). Save the returned `sessionId`, `leaseId`, `leaseToken`, and `fencingToken` for governed session operations.
3. **Context Gathering**: Call `memory_contextPack` for the current task area, and read full governed notes with `memory_get` or search with `memory_search` / `memory_list` / `memory_recent` / `memory_followUpRadar`.
4. **Pre-Flight Check**: Call `memory_selfCheck` before risky work or multi-file edits.
5. **During Work**:
   - Record architecture decisions with `memory_writeADR`, insights with `memory_writeInsight`, mistakes with `memory_writeMistake`, and session logs with `memory_writeSessionLog`.
   - Use V2-native lifecycle and governance tools when needed: `memory_checkpoint`, `memory_recordEvidenceBatch`, `memory_sessionFork`, `memory_recordChildResult`, `memory_completeChildSession`, `memory_promote`, `memory_supersede`, `memory_retract`, `memory_expire`, `memory_forgetEvidence`.
6. **Task End (MANDATORY)**: Call `memory_sessionEnd` (passing the active `sessionId`, `leaseId`, `leaseToken`, `fencingToken`, `summary`, and `outcomes`) and verify vault integrity via `memory_verifyVault` or `memory_lifecycleStatus`.
