---
title: Auto Memory Digest
type: insight
derived-from:
  - 05_Agent_Session_Logs/2026-05-16-always-on-project-memory-workflow-for-ide-and-ai-agents.md
  - 05_Agent_Session_Logs/2026-05-16-bootstrap-project-local-obsidian-memory-mcp-and-ide-integration-pack.md
  - 05_Agent_Session_Logs/2026-05-16-fix-mcp-regex-constraints-and-add-slash-command-prompts.md
  - 05_Agent_Session_Logs/2026-05-16-implementing-code-obfuscation-for-ip-protection.md
  - 05_Agent_Session_Logs/2026-05-16-upgrade-project-memory-to-10-out-of-10-autopilot.md
confidence: medium
status: active
created: 2026-05-16
updated: 2026-05-16
tags:
  - digest
  - auto-compact
  - project/general
---
# Auto Memory Digest

Generated: 2026-05-16

> [!important]
> This note is generated from recent session logs. Keep durable architectural choices in ADRs and keep repeated lessons here or in dedicated insight notes.

## High-Signal Outcomes
- Added a shared always-on memory protocol to the bootstrap generator
- Generated root .rules for Zed, .windsurfrules, GEMINI.md, GitHub Copilot instructions, Cursor rule, Windsurf rule, and project AGENTS.md
- Updated OpenCode instructions to include the always-on memory protocol note
- Added memory/01_Project_Rules/Always-On-Memory-Protocol.md as the durable vault rule
- Allowed key project-memory MCP tools in global Zed tool permissions
- Created project-local memory vault for the MCP server root
- Generated OpenCode, Codex, Zed, Cursor, Windsurf, and Google Antigravity MCP integration files
- Added AI client setup note and README documentation
- Verified vault health with zero warnings
- Resolved MCP regex validation errors.
- Added UI slash commands for 5 key memory functions (session_start, session_end, self_check, awaken, write_adr).
- Successfully compiled the codebase.
- Replaced standard tsc build with an obfuscated build pipeline.
- Added build script to bundle using esbuild and obfuscate the generated file.
- Verified the obfuscated server starts successfully without module loading errors.
- Added lightweight usage scoring that boosts repeatedly selected notes in future context packs
- Implemented deterministic session-log compaction into 07_Insights/Auto-Memory-Digest.md
- Made memory_sessionEnd write the session log, auto-compact recent sessions, and return vault health by default
- Updated Zed permissions for key project-memory MCP tools
- Regenerated always-on rules and project memory notes for the current repository

## Decisions To Remember
- Use one shared always-on protocol helper in the bootstrap service to avoid rule drift across IDE clients
- Use Zed root .rules because Zed auto-includes .rules at the root of a project's file tree
- Keep session memory writes explicit through MCP calls: sessionStart/contextPack at start, sessionEnd/verifyVault at end
- Store memory in the calling project Obsidian vault by default
- Generate project-local configs where supported and example configs where a client may require user-level import
- Use memory_contextPack before full note reads to reduce token usage
- Refactored all `memory.*` tools to `memory_*`
- Registered 5 MCP Prompts to allow user to trigger memory workflows via the IDE slash command menu.
- Used esbuild for bundling and javascript-obfuscator for code obfuscation.
- Externalized node_modules during the esbuild phase to avoid dynamic require crashes in the MCP server.
- Use usage scoring as lightweight local learning stored in memory/.memory-mcp/usage.json
- Keep compaction deterministic and source-backed instead of LLM-generated
- Run compaction and health verification inside sessionEnd by default while keeping verifyVault available as an explicit tool

## Open Follow-ups
- [ ] Reload Zed so global settings and project .rules are picked up by the Agent Panel
- [ ] For each new project, run memory_bootstrapProject so the same always-on rules are generated there
- [ ] Confirm exact Google Antigravity user-level MCP import location if the client changes its config format
- [ ] The user can test the new slash commands and let us know if any other commands should be added.
- [ ] Reload Zed to pick up updated global tool permissions and root .rules
- [ ] For other projects, rerun memory_bootstrapProject with overwrite when ready to regenerate their always-on rules

## Confidence Lessons
- Zed can auto-include root .rules as project-level instructions. -> Use .rules for Zed while keeping AGENTS.md for broader agent compatibility.
- Refactoring dots to underscores solves the regex constraint, and registering Prompts adds slash commands. -> When building MCP servers with the official SDK, ensure tool names adhere to `^[a-zA-Z0-9_-]{1,64}$`. Adding prompts greatly improves UX for executing long tool workflows.
- Bundling with esbuild and obfuscating with javascript-obfuscator will protect the source code. -> Esbuild needs 'packages: external' to prevent dynamic require errors with Node.js builtin modules and external dependencies when outputting ESM.
- The new project-memory workflow is 10/10 for enforceable local memory within MCP limits. -> State the limit clearly: enforcement comes from IDE rules and tool permissions; memory quality comes from MCP tools and vault checks.

## Verification Evidence
- npm run typecheck passed; npm run build passed; Zed settings JSON validated; required rule files exist; memory_verifyVault reported errors=0 warnings=0
- npm run typecheck; npm run build; smoke bootstrap; memory_verifyVault errors=0 warnings=0
- Rebuilt the project using `npm run build` with no errors.
- Ran `npm run build` to verify the pipeline and `node dist/index.js` to ensure the server starts properly.
- npm run typecheck passed; npm run build passed; smoke test confirmed usage.json, Auto-Memory-Digest, session log, and vault health; memory_verifyVault errors=0 warnings=0

## Source Sessions
- [[05_Agent_Session_Logs/2026-05-16-always-on-project-memory-workflow-for-ide-and-ai-agents|2026-05-16-always-on-project-memory-workflow-for-ide-and-ai-agents.md]]
- [[05_Agent_Session_Logs/2026-05-16-bootstrap-project-local-obsidian-memory-mcp-and-ide-integration-pack|2026-05-16-bootstrap-project-local-obsidian-memory-mcp-and-ide-integration-pack.md]]
- [[05_Agent_Session_Logs/2026-05-16-fix-mcp-regex-constraints-and-add-slash-command-prompts|2026-05-16-fix-mcp-regex-constraints-and-add-slash-command-prompts.md]]
- [[05_Agent_Session_Logs/2026-05-16-implementing-code-obfuscation-for-ip-protection|2026-05-16-implementing-code-obfuscation-for-ip-protection.md]]
- [[05_Agent_Session_Logs/2026-05-16-upgrade-project-memory-to-10-out-of-10-autopilot|2026-05-16-upgrade-project-memory-to-10-out-of-10-autopilot.md]]
