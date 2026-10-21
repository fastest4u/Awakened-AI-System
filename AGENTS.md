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

## project-memory V2 Tool Usage Policy (Full-Auto)

> Decided 2026-06-01 & upgraded to V2 on 2026-10-21. The user opted into full-auto use of all 34 Project Memory V2 MCP tools.

- **AUTO — invoke proactively, do NOT ask**: All 34 V2 tools — `memory_v2Status`, `memory_sessionStart`, `memory_contextPack`, `memory_selfCheck`, `memory_get`, `memory_list`, `memory_search`, `memory_recent`, `memory_followUpRadar`, `memory_awaken`, `memory_lifecycleStatus`, `memory_verifyVault`, `memory_verifyNote`, `memory_verifySourceTruth`, `memory_checkStaleness`, `memory_findDuplicates`, `memory_writeSessionLog`, `memory_writeADR`, `memory_writeInsight`, `memory_writeMistake`, `memory_checkpoint`, `memory_recoverSession`, `memory_sessionFork`, `memory_recordChildResult`, `memory_completeChildSession`, `memory_amendSessionEnd`, `memory_cancelSessionEnd`, `memory_recordEvidenceBatch`, `memory_promote`, `memory_supersede`, `memory_retract`, `memory_expire`, `memory_forgetEvidence`, `memory_sessionEnd`.
- **OPERATOR CLI (`node dist/v2-admin.js`)**: Store administration, backups (`backup`), restores (`restore`), projection rebuilds (`rebuild-projections`), and archive verification (`verify-v1-archive`) run through `node dist/v2-admin.js`.

<!-- context7 -->
Use Context7 MCP to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use it even for well-known tools because local knowledge may be stale. Prefer Context7 over web search for library documentation.

Do not use Context7 for refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

## Context7 Steps

1. Always start with `resolve-library-id` using the library name and the user's question, unless the user provides an exact library ID in `/org/project` format.
2. Pick the best match by exact name match, description relevance, code snippet count, source reputation, and benchmark score. Use version-specific IDs when the user mentions a version.
3. Call `query-docs` with the selected library ID and the user's full question.
4. Answer using the fetched docs.
<!-- context7 -->
