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
