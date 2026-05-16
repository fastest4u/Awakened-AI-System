# Repository Agent Memory

This project uses an Obsidian-first memory vault at `memory/` for Awakened AI Memory MCP.

## Always-On Memory Protocol

- Treat MCP server `project-memory` as the durable memory source for this project.
- At the start of every IDE/agent session, call `memory_sessionStart` before broad code exploration; this also updates lightweight usage scoring.
- For each concrete task, call `memory_contextPack` with the task area and read full notes only with `memory_get` for selected paths. The context pack learns which notes are repeatedly selected.
- Before risky work, multi-file edits, database/schema changes, auth, deploys, or production operations, call `memory_selfCheck`.
- During work, write durable decisions with `memory_writeADR`, repeated lessons with `memory_writeInsight`, and failure modes with `memory_writeMistake`.
- At the end of every meaningful session, call `memory_sessionEnd` with outcomes, files touched, decisions made, open follow-ups, verification, and confidence lessons. It auto-compacts recent sessions into `07_Insights/Auto-Memory-Digest.md` when supported.
- After `memory_sessionEnd`, check the returned health summary or call `memory_verifyVault`; fix errors before considering the session complete.
- If MCP is unavailable, read `memory/AGENTS.md` and `memory/00_Index/Retrieval-Protocol.md`, then mention that memory tool writes were skipped.

Do not read or dump the whole vault unless the user explicitly asks.
