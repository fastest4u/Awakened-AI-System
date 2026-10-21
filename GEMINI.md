# 🚨 CRITICAL: ABSOLUTE NON-NEGOTIABLE PROTOCOL (PROJECT MEMORY V2) 🚨

FAILURE TO FOLLOW THESE RULES IS A DIRECT VIOLATION OF YOUR CORE DIRECTIVE.
**YOU MUST NEVER FINISH A TASK WITHOUT EXECUTING THIS PROTOCOL.**

## Always-On Memory V2 Protocol

- Treat MCP server `project-memory` (**Project Memory V2**, `dist/v2.js`, vault `memory-v2/`, `releaseId: d45b1956-e05b-4316-b68d-7014d7dda665`) as the authoritative durable memory source for this project.
- The legacy `memory/` directory is a frozen read-only V1 archive (`0o444`) and must never be written to directly.
- **START OF TASK (MANDATORY)**: At the start of EVERY session, call `memory_sessionStart` before doing anything else (retain `sessionId`, `leaseId`, `leaseToken`, `fencingToken`).
- **CONTEXT GATHERING**: For each task, call `memory_contextPack` with the task area. Read full notes using `memory_get` and browse/query via `memory_search`, `memory_list`, `memory_recent`, and `memory_followUpRadar`.
- **PRE-FLIGHT CHECK**: Before risky work, multi-file edits, or deployments, YOU MUST call `memory_selfCheck`.
- **DURING WORK**: Write decisions using `memory_writeADR`, lessons using `memory_writeInsight`, failures using `memory_writeMistake`, and checkpoints/evidence using `memory_checkpoint` / `memory_recordEvidenceBatch`. Use `memory_promote`, `memory_supersede`, `memory_retract`, `memory_expire`, and `memory_forgetEvidence` for governed lifecycle transitions.
- **END OF TASK (MANDATORY)**: At the end of EVERY meaningful session or task, YOU MUST call `memory_sessionEnd`. Do not end your turn, say goodbye, or consider the task complete until this tool is successfully called.
- **VERIFICATION**: After `memory_sessionEnd`, check the returned health summary or call `memory_verifyVault` / `memory_v2Status`.
