# 🚨 CRITICAL: ABSOLUTE NON-NEGOTIABLE PROTOCOL 🚨

FAILURE TO FOLLOW THESE RULES IS A DIRECT VIOLATION OF YOUR CORE DIRECTIVE.
**YOU MUST NEVER FINISH A TASK WITHOUT EXECUTING THIS PROTOCOL.**

## Always-On Memory Protocol

- Treat MCP server project-memory as the durable memory source for this project.
- **START OF TASK (MANDATORY)**: At the start of EVERY session, call memory_sessionStart before doing anything else.
- **CONTEXT GATHERING**: For each task, call memory_contextPack with the task area. Read full notes using memory_get.
- **PRE-FLIGHT CHECK**: Before risky work, multi-file edits, or deployments, YOU MUST call memory_selfCheck.
- **DURING WORK**: Write decisions using memory_writeADR, lessons using memory_writeInsight, and failures using memory_writeMistake.
- **END OF TASK (MANDATORY)**: At the end of EVERY meaningful session or task, YOU MUST call memory_sessionEnd. Do not end your turn, say goodbye, or consider the task complete until this tool is successfully called.
- **VERIFICATION**: After memory_sessionEnd, check the returned health summary or call memory_verifyVault.
- If MCP is unavailable, you MUST read memory/AGENTS.md and explicitly state to the user that memory writes were skipped.

## project-memory Tool Usage Policy (Full-Auto)

> Decided 2026-06-01. ADR: `04_Architecture_Decisions/adr-full-auto-invocation-policy-for-project-memory-mcp-tools.md`. The user opted into full-auto use of all project-memory MCP tools.

- **AUTO — invoke proactively, do NOT ask**: All read, additive-write, and verify tools — `memory_sessionStart`, `memory_contextPack`, `memory_selfCheck`, `memory_get`, `memory_list`, `memory_search`, `memory_recent`, `memory_followUpRadar`, `memory_awaken`, `memory_lifecycleStatus`, `memory_verifyVault`, `memory_verifyNote`, `memory_verifySourceTruth`, `memory_checkStaleness`, `memory_findBrokenLinks`, `memory_findDuplicates`, `memory_indexNote`, `memory_writeSessionLog`, `memory_writeADR`, `memory_writeInsight`, `memory_writeMistake`, `memory_createFromTemplate`, `memory_sessionEnd`, `memory_export`.
- **WARN-THEN-RUN — state reason + impact before each run**: Destructive/heavy tools — `memory_compactVault`, `memory_reindex`, `memory_bootstrapProject`, `memory_import`. Never run these silently.
- **APPROVAL WINDOW**: Suppressing the per-call approval prompt requires the user to add `project-memory` to the IDE auto-run allowlist. The agent cannot set this; it only controls whether a tool is *invoked*, not whether the IDE prompts.
