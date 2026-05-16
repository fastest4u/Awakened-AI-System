# Awakened AI Memory MCP Server

Project-local, SPX-style memory vault exposed through MCP tools. The server is
designed to be reused by many projects while keeping each project's memory in
that project.

## Design

SPX's memory system is a plain Markdown vault with:

- `memory/AGENTS.md` as the agent constitution
- `00_Index/` for navigation, goals, follow-ups, and dashboard notes
- `04_Architecture_Decisions/` for ADRs
- `05_Agent_Session_Logs/` for append-only work history
- `07_Insights/` for durable lessons
- `08_Mistakes/` for failure modes and prevention
- `09_Runbooks/` for repeatable operations
- `99_Templates/` for note conventions
- `.obsidian/` for the project-local Obsidian profile

This MCP server wraps that model in tools so OpenCode, Codex, Zed, Cursor,
Windsurf, Google Antigravity, and other MCP-capable clients can call the same
memory operations without repo-specific slash commands.

## Obsidian Plugin Profile

`memory_bootstrapProject` writes an Obsidian-ready vault profile:

- `.obsidian/app.json`
- `.obsidian/community-plugins.json`
- `00_Index/Plugin-Setup.md`
- Dataview and Tasks dashboards
- Templater-friendly templates in `99_Templates/`
- Daily notes, task inbox, Kanban, diagram, and mind map starter notes
- `00_Index/Retrieval-Protocol.md` and `00_Index/Memory-Digest.md` for token-efficient retrieval

Recommended productivity plugins:

- Templater: dynamic templates and JavaScript-backed note creation
- Dataview: query notes and frontmatter like a database
- Tasks: task queries with due dates, priority, and recurrence
- QuickAdd: fast capture actions
- Obsidian Git: vault backup through project git
- Calendar: daily-note navigation
- Linter: format and frontmatter consistency

Recommended visual plugins:

- Excalidraw: diagrams, flows, architecture sketches
- Kanban: board view for goals and follow-ups
- Iconize: icons for folders and notes
- Mind Map: heading-based mind maps

MCP writes the config and notes, but it does not download or execute community
plugin code. Install and enable plugins from Obsidian's Community Plugins UI so
the user remains in control of plugin trust.

## Storage Model

Default behavior is project-local memory:

```text
<calling-project>/
  memory/
    .obsidian/
    AGENTS.md
    00_Index/
    05_Agent_Session_Logs/
    10_Daily/
    11_Tasks/
    12_Kanban/
    13_Diagrams/
    14_Mindmaps/
    ...
```

That is the recommended mode. It keeps code and memory together, works with git,
and lets each project carry its own decisions, mistakes, and session history.

Configuration:

- `MEMORY_PROJECT_ROOT`: project where the `memory/` vault should live
- `MEMORY_VAULT_DIR`: vault folder name, defaults to `memory`
- `MEMORY_VAULT_PATH`: explicit vault path; overrides project root + vault dir

For MCP clients that do not start servers from the workspace root, set
`MEMORY_PROJECT_ROOT` explicitly.

## Install

```bash
npm install
npm run build
```

Run locally:

```bash
npm run start
```

Development loop:

```bash
npm run typecheck
npm run build
```

## MCP Client Setup

Use stdio for broad local compatibility:

```json
{
  "mcpServers": {
    "project-memory": {
      "command": "node",
      "args": ["C:/Users/Server/Desktop/Awakened-AI-System/dist/index.js"],
      "env": {
        "MEMORY_PROJECT_ROOT": "C:/path/to/your/project"
      }
    }
  }
}
```

For each project, point `MEMORY_PROJECT_ROOT` at that project. The first call
should usually be:

```text
memory_bootstrapProject
```

By default, `memory_bootstrapProject` also writes a project-local integration
pack for the clients this repo is optimized for:

- OpenCode: `opencode.json` with memory instructions and `.opencode/commands/*.md`
- Codex: `.codex/config.toml`
- Zed: `.zed/settings.json` and root `.rules`
- Cursor: `.cursor/mcp.json` and `.cursor/rules/project-memory.mdc`
- Windsurf: `.windsurfrules`, `.windsurf/rules/project-memory.md`, `.windsurf/workflows/*.md`, and `.windsurf/mcp_config.example.json`
- Google Antigravity: `.antigravity/mcp.example.json`
- Gemini/Antigravity compatibility: `GEMINI.md`
- GitHub Copilot compatibility: `.github/copilot-instructions.md`
- Shared agent rule: `AGENTS.md`

The project files point every client at the same stdio MCP server and set
`MEMORY_PROJECT_ROOT` to the project being bootstrapped. Existing files are
skipped unless `overwrite: true` is passed. Set `ideConfigs: false` when you
only want the Obsidian vault.

Some clients still prefer or require a user-level MCP config. For those, copy
the generated example into the client settings UI or global config file, keeping
`MEMORY_PROJECT_ROOT` pointed at the project root.

The generated agent rules all use the same always-on session contract:
`memory_sessionStart` at the beginning, `memory_contextPack` before full-note
reads, `memory_selfCheck` before risky work, and `memory_sessionEnd` plus
`memory_verifyVault` before the session is considered complete.

`memory_contextPack` also updates lightweight usage scoring in
`memory/.memory-mcp/usage.json`, so notes repeatedly selected for similar work
rank higher over time. `memory_sessionEnd` writes the session log, refreshes
`07_Insights/Auto-Memory-Digest.md`, and returns a vault health summary by
default.

## Core Workflow

1. `memory_bootstrapProject` creates the SPX-style vault structure.
2. `memory_contextPack` builds a token-budgeted context pack for the task.
3. `memory_sessionStart` uses that compact context instead of broad note dumps.
4. `memory_selfCheck` returns a confidence and mistake-awareness checklist before risky work.
5. `memory_search`, `memory_get`, `memory_list`, and `memory_recent` retrieve targeted memory.
6. `memory_writeADR`, `memory_writeMistake`, and `memory_writeInsight` persist durable knowledge.
7. `memory_sessionEnd` writes append-only session history, auto-compacts recent sessions, and returns vault health.
8. `memory_verifyVault` checks frontmatter, required fields, wikilinks, duplicates, open mistakes, and quality score.
9. `memory_compactVault` refreshes `07_Insights/Auto-Memory-Digest.md` or returns a dry-run preview.

The token-saving rule is simple: call `memory_contextPack` first, then call
`memory_get` only for selected paths that need full bodies.

## Tools

Read:

- `memory_search`
- `memory_get`
- `memory_list`
- `memory_recent`

Workflow:

- `memory_bootstrapProject`
- `memory_contextPack`
- `memory_sessionStart`
- `memory_awaken`
- `memory_selfCheck`
- `memory_sessionEnd`
- `memory_compactVault`

Write:

- `memory_writeSessionLog`
- `memory_writeInsight`
- `memory_writeMistake`
- `memory_writeADR`
- `memory_createFromTemplate`

Verification:

- `memory_verifyVault`
- `memory_verifyNote`
- `memory_verifySourceTruth`
- `memory_findBrokenLinks`
- `memory_findDuplicates`
- `memory_checkStaleness`

Maintenance:

- `memory_reindex`
- `memory_indexNote`
- `memory_export`
- `memory_import`

`memory_export` and `memory_import` are registered placeholders for the next
implementation pass.

## Response Format

All tools return JSON text and `structuredContent` with the same envelope:

```json
{
  "ok": true,
  "data": {},
  "warnings": [],
  "meta": {
    "tool": "memory_sessionStart",
    "elapsedMs": 12
  }
}
```

Errors use the same envelope with `ok: false` and an `error` object.

## Notes On Compatibility

MCP gives a common protocol for clients that support MCP. This server currently
uses stdio transport, which is the right default for local IDE/agent use. Agents
or IDEs without MCP support can still read the same project-local Markdown vault
directly, but they cannot call MCP tools until they add MCP support or use a
bridge.
