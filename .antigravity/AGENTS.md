# Antigravity instructions for this workspace

This is the project-local AGENTS file Antigravity should read on every
turn in this workspace. The full shared protocol is in the repo-root
`AGENTS.md`; this file makes the `project_memory` MCP workflow explicit
for Antigravity.

The workspace uses `MEMORY_PROJECT_ROOT=dynamic` in `.antigravity/mcp.json`
and `.antigravity/mcp_config.json`. The MCP server resolves the active
project from IDE state, explicit workspace environment variables, or the
current working directory.

## Memory protocol: mandatory every turn

Use `project_memory` MCP as the durable memory source for this project.
On every substantive task or turn that touches code, config, infra,
tests, project docs, or makes a durable decision, follow this lifecycle.

### Verify vault routing first

The first `memory_*` call returns `vaultRoot`. It must end with:

`Awakened-AI-System\memory`

If it does not, stop before editing files and report the bad route. Do
not try to repair routing by passing ad hoc arguments to tools; fix the
MCP dynamic root detection or use a project-local MCP config only as an
explicit override.

### Required lifecycle

1. Task start: call `memory_sessionStart` before other work, with a
   short `taskArea`. Use the returned context pack first.
2. Context: call `memory_contextPack` for the current task area. Read
   full notes only when selected by the context pack.
3. Continuing turns: do not call `memory_sessionStart` again for the
   same active task. Continue the active lifecycle; if the topic changes,
   call `memory_contextPack` again or close the current session cleanly.
4. Risk check: call `memory_selfCheck` before risky work. Risky includes
   3+ files, migrations, security, auth, infra, public API types, shared
   services, MCP config, `.antigravity/`, `.agents/`, `.codex/`,
   `.cursor/`, `.windsurf/`, and `memory/`.
5. During work: record durable architecture decisions with
   `memory_writeADR`, lessons with `memory_writeInsight`, and failures or
   repeated misses with `memory_writeMistake`.
6. Task end: call `memory_sessionEnd` with `topic`, `outcomes`,
   `decisionsMade`, `filesTouched`, `openFollowUps`, and a concrete
   `verification` string describing what was run or why verification was
   skipped. Set `verify: true`, then check vault health with
   `memory_verifyVault` or `memory_lifecycleStatus`.

### Anti-patterns

- Do not edit notes under `memory/` directly when MCP tools are
  available.
- Do not call `memory_sessionStart` twice without a matching
  `memory_sessionEnd`.
- Do not finish a meaningful task without `memory_sessionEnd`.
- Do not omit the `verification` field in `memory_sessionEnd`.
- Do not bulk-read the vault; use `memory_contextPack` first.

If MCP is unavailable, read `memory/AGENTS.md`, continue from local
rules, and explicitly tell the user memory writes were skipped.
