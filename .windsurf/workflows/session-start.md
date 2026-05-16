# session-start

Use MCP server `project-memory`. Call `memory_sessionStart`, then `memory_contextPack`. Do not read the whole vault.

Token rule: use `memory_contextPack` before `memory_get` unless the user explicitly asks for a full note.
