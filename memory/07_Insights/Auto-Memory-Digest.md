---
title: Auto Memory Digest
type: insight
derived-from:
  - 05_Agent_Session_Logs/2026-05-17-mcp-improvement-planning-recommendation.md
  - 05_Agent_Session_Logs/2026-05-17-implement-mcp-lifecycle-guardrails-and-quality-gate.md
  - 05_Agent_Session_Logs/2026-05-17-recommend-next-mcp-roadmap-slice.md
  - 05_Agent_Session_Logs/2026-05-17-implement-task-aware-contextpack-presets.md
  - 05_Agent_Session_Logs/2026-05-17-recommend-next-mcp-slice-after-contextpack-presets.md
  - 05_Agent_Session_Logs/2026-05-17-implement-read-only-follow-up-radar.md
  - 05_Agent_Session_Logs/2026-05-17-update-readme-to-comprehensive-thai-documentation.md
  - 05_Agent_Session_Logs/2026-05-16-always-on-project-memory-workflow-for-ide-and-ai-agents.md
  - 05_Agent_Session_Logs/2026-05-16-bootstrap-project-local-obsidian-memory-mcp-and-ide-integration-pack.md
  - 05_Agent_Session_Logs/2026-05-16-enforcing-pre-flight-memory-checks.md
  - 05_Agent_Session_Logs/2026-05-16-enforcing-strictest-memory-protocol-limits.md
  - 05_Agent_Session_Logs/2026-05-16-fix-mcp-regex-constraints-and-add-slash-command-prompts.md
  - 05_Agent_Session_Logs/2026-05-16-implementing-code-obfuscation-for-ip-protection.md
  - 05_Agent_Session_Logs/2026-05-16-obsidian-ai-plugins-integration.md
  - 05_Agent_Session_Logs/2026-05-16-updating-mcp-bootstrap-defaults.md
  - 05_Agent_Session_Logs/2026-05-16-upgrade-project-memory-to-10-out-of-10-autopilot.md
confidence: medium
status: active
created: 2026-05-17
updated: 2026-05-17
tags:
  - digest
  - auto-compact
  - project/general
---
# Auto Memory Digest

Generated: 2026-05-17

> [!important]
> This note is generated from recent session logs. Keep durable architectural choices in ADRs and keep repeated lessons here or in dedicated insight notes.

## High-Signal Outcomes
- Reviewed project-memory context for MCP improvement planning.
- Identified reliability, lifecycle enforcement, retrieval quality, follow-up surfacing, and observability as the highest-value next roadmap areas.
- Recorded an insight about reducing dependency on agent discipline.
- Added a durable MemoryLifecycleService that records sessionStart, contextPack, selfCheck, sessionEnd, active lifecycle state, recent lifecycle history, and end-of-task quality gate results.
- Wired lifecycle tracking into workflow tools and added the read-only memory_lifecycleStatus tool.
- Extended memory_sessionEnd responses with a qualityGate that flags missing lifecycle steps, skipped verification, weak log content, risky work without selfCheck, and vault health warnings.
- Updated README and bootstrap-generated client instructions to mention qualityGate and memory_lifecycleStatus.
- Fixed missing frontmatter in memory/01_Project_Rules/Always-On-Memory-Protocol.md so vault health is clean.
- Reviewed current memory context after lifecycle guardrails implementation.
- Recommended task-aware contextPack presets as the next highest-value MCP improvement.
- Recorded an insight capturing this roadmap decision.
- Added task-aware memory_contextPack modes: auto, coding, debugging, review, deploy, planning, and docs.
- Added auto mode inference from query/taskArea keywords while preserving generic fallback behavior.
- Added preset-specific include defaults, type weight boosts, extra scoring terms, recommended reads, checklist hints, and retrieval rules in contextPack responses.
- Extended memory_sessionStart to accept mode and pass it into its startup contextPack.
- Updated README, bootstrap-generated integration docs, Retrieval Protocol, and Memory Autopilot notes to document task-aware modes.
- Reviewed roadmap context after lifecycle guardrails and task-aware contextPack presets.
- Recommended follow-up radar as the next highest-value implementation slice.
- Recorded an insight documenting the recommendation and rationale.
- Added MemoryFollowUpService to extract open unchecked tasks and bullet items under follow-up sections from vault markdown notes.
- Added memory_followUpRadar read-only MCP tool with query/taskArea/mode/folders/limit inputs.
- Surfaced compact followUps in memory_sessionStart and memory_contextPack responses.
- Wired follow-up radar into app bootstrap, workflow controller, workflow service, and schemas.
- Updated README, bootstrap-generated client docs, Retrieval Protocol, Memory Autopilot, and AI Client Setup notes to document follow-up radar.
- Rewrote README.md in Thai with comprehensive coverage of architecture, installation, environment variables, MCP client setup, bootstrap behavior, workflow protocol, context modes, lifecycle guardrails, Follow-up Radar, Obsidian profile, tools, response envelope, troubleshooting, and roadmap.
- Verified the documentation update did not break the TypeScript project build.
- Added a shared always-on memory protocol to the bootstrap generator
- Generated root .rules for Zed, .windsurfrules, GEMINI.md, GitHub Copilot instructions, Cursor rule, Windsurf rule, and project AGENTS.md
- Updated OpenCode instructions to include the always-on memory protocol note
- Added memory/01_Project_Rules/Always-On-Memory-Protocol.md as the durable vault rule

## Decisions To Remember
- Recommended prioritizing automation and guardrails over adding more note types or manual commands.
- Implemented lifecycle enforcement as non-blocking warnings and quality gates rather than hard failures, because MCP tools may be used standalone or after client restarts.
- Stored lifecycle state project-locally under memory/.memory-mcp/lifecycle.json.
- Archived any still-active lifecycle as failed when a new memory_sessionStart begins, to avoid mixing counts across tasks.
- Prioritized task-aware retrieval presets over client diagnostics as the next slice because it improves context quality across every workflow.
- Kept mode default as auto for backward compatibility.
- Changed contextPack include flags to optional so preset defaults apply unless callers explicitly override them.
- Implemented deterministic keyword inference rather than embeddings or network-dependent semantic routing.
- Kept presets as ranking/default changes only; did not enforce minimum result counts per note type in this slice.
- Prioritized follow-up radar before client diagnostics because it improves everyday task continuity and prevents open work from being buried in session logs.
- Implemented follow-up radar as read-only in v1; it surfaces open work but does not edit or close tasks.
- Scored follow-ups deterministically using query/taskArea/mode terms, note metadata, follow-up section context, type weights, and recency.
- Included compact followUps in sessionStart/contextPack so unresolved work appears before new task execution.
- Kept README as a single comprehensive Thai entry point while preserving exact tool names, paths, commands, and JSON examples in English where they are literal interfaces.
- Documented memory_export and memory_import as registered placeholders to avoid overstating current functionality.
- Use one shared always-on protocol helper in the bootstrap service to avoid rule drift across IDE clients
- Use Zed root .rules because Zed auto-includes .rules at the root of a project's file tree
- Keep session memory writes explicit through MCP calls: sessionStart/contextPack at start, sessionEnd/verifyVault at end
- Store memory in the calling project Obsidian vault by default
- Generate project-local configs where supported and example configs where a client may require user-level import
- Use memory_contextPack before full note reads to reduce token usage
- Created an insight mandating memory checks BEFORE starting work.
- Demonstrated the correct procedure by running memory_sessionStart and memory_selfCheck during this interaction.
- Enforced the strictest memory protocol by updating all workspace rule files.
- Logged the user's non-negotiable memory mandate as a permanent insight.
- Refactored all `memory.*` tools to `memory_*`
- Registered 5 MCP Prompts to allow user to trigger memory workflows via the IDE slash command menu.
- Used esbuild for bundling and javascript-obfuscator for code obfuscation.
- Externalized node_modules during the esbuild phase to avoid dynamic require crashes in the MCP server.
- Integrated Smart Composer and Smart Connections into the core recommended Obsidian plugins for the AI memory vault.

## Open Follow-ups
- [ ] If implementation is requested, inspect source modules for lifecycle hooks, context pack scoring, slash command generation, and vault verification flow.
- [ ] Consider adding task-aware contextPack presets for coding, deployment, review, planning, and debugging as the next roadmap slice.
- [ ] Consider adding client integration diagnostics for Codex, Zed, Cursor, Windsurf, and OpenCode configs.
- [ ] Implement contextPack modes such as coding, debugging, review, deploy, planning, and docs.
- [ ] After presets, implement follow-up radar and client integration diagnostics.
- [ ] Implement follow-up radar next: surface relevant open follow-ups from notes during sessionStart/contextPack.
- [ ] Consider minimum-per-type result diversity if ranking alone does not keep enough ADRs/mistakes/runbooks visible.
- [ ] Consider client integration diagnostics after follow-up radar.
- [ ] Implement follow-up radar: extract open checkboxes and follow-up sections, score them by query/taskArea/mode, and return relevant followUps from sessionStart/contextPack.
- [ ] After follow-up radar, implement client integration diagnostics for Codex, Zed, Cursor, Windsurf, and OpenCode.
- [ ] Implement client integration diagnostics for Codex, Zed, Cursor, Windsurf, and OpenCode.
- [ ] Consider follow-up write workflows later: mark done, promote to Open-Followups, or carry unresolved items into sessionEnd.
- [ ] Consider result diversity constraints for contextPack after observing preset behavior on real projects.
- [ ] Reload Zed so global settings and project .rules are picked up by the Agent Panel
- [ ] For each new project, run memory_bootstrapProject so the same always-on rules are generated there
- [ ] Confirm exact Google Antigravity user-level MCP import location if the client changes its config format
- [ ] The user can test the new slash commands and let us know if any other commands should be added.
- [ ] Reload Zed to pick up updated global tool permissions and root .rules
- [ ] For other projects, rerun memory_bootstrapProject with overwrite when ready to regenerate their always-on rules

## Confidence Lessons
- Zed can auto-include root .rules as project-level instructions. -> Use .rules for Zed while keeping AGENTS.md for broader agent compatibility.
- Using memory_selfCheck and memory_sessionStart before doing any actual work prevents hallucination and context loss. -> Agent must invoke memory_sessionStart followed by memory_selfCheck at the very beginning of every new task context.
- Writing an insight and ending the session immediately aligns with the user's strict memory logging enforcement. -> Never bypass memory operations. Every conversation turn ending a task MUST explicitly call memory_sessionEnd.
- Refactoring dots to underscores solves the regex constraint, and registering Prompts adds slash commands. -> When building MCP servers with the official SDK, ensure tool names adhere to `^[a-zA-Z0-9_-]{1,64}$`. Adding prompts greatly improves UX for executing long tool workflows.
- Bundling with esbuild and obfuscating with javascript-obfuscator will protect the source code. -> Esbuild needs 'packages: external' to prevent dynamic require errors with Node.js builtin modules and external dependencies when outputting ESM.
- Updating community-plugins.json and Plugin-Setup.md integrates the AI stack into the vault natively. -> Keeping the Plugin-Setup.md synced with community-plugins.json helps maintain an understanding of the vault capabilities.
- If the bootstrap code isn't updated, new projects won't receive the new plugin setups by default. -> Always update the bootstrap template logic along with the current vault logic to keep future instantiations in sync.
- The new project-memory workflow is 10/10 for enforceable local memory within MCP limits. -> State the limit clearly: enforcement comes from IDE rules and tool permissions; memory quality comes from MCP tools and vault checks.

## Verification Evidence
- Not recorded
- npm run typecheck passed. npm run build passed. MCP stdio smoke test confirmed memory_lifecycleStatus is registered. Temp-project MCP smoke flow returned qualityGate grade A, score 100, and no missing required steps. memory_verifyVault returned score 90, grade B, errors 0, warnings 0 before final sessionEnd.
- Planning-only task. memory_contextPack reviewed relevant roadmap and recent implementation notes; no code changes were made.
- npm run typecheck passed. npm run build passed. MCP stdio smoke test in a temp project confirmed auto mode inferred coding for an implementation query, explicit docs mode resolved to docs, and docs mode defaulted includeRecentSessions to false.
- Planning-only response. Used memory_sessionStart and planning-mode memory_contextPack to review roadmap context; no code changes were made.
- npm run typecheck passed. npm run build passed. MCP stdio smoke test in a temp project confirmed memory_followUpRadar is registered, returns open follow-ups, reports scannedFiles, and memory_contextPack includes compact followUps. memory_verifyVault returned score 90, grade B, errors 0, warnings 0.
- Ran npm run typecheck and npm run build successfully after editing README.md.
- npm run typecheck passed; npm run build passed; Zed settings JSON validated; required rule files exist; memory_verifyVault reported errors=0 warnings=0
- npm run typecheck; npm run build; smoke bootstrap; memory_verifyVault errors=0 warnings=0
- Insight successfully written and self-check executed.
- Verified insight creation and successful memory_sessionEnd execution.
- Rebuilt the project using `npm run build` with no errors.
- Ran `npm run build` to verify the pipeline and `node dist/index.js` to ensure the server starts properly.
- Verified that both JSON and MD files were correctly modified.
- Ran npm run build successfully to compile and obfuscate the updated bundle.
- npm run typecheck passed; npm run build passed; smoke test confirmed usage.json, Auto-Memory-Digest, session log, and vault health; memory_verifyVault errors=0 warnings=0

## Source Sessions
- [[05_Agent_Session_Logs/2026-05-17-mcp-improvement-planning-recommendation|2026-05-17-mcp-improvement-planning-recommendation.md]]
- [[05_Agent_Session_Logs/2026-05-17-implement-mcp-lifecycle-guardrails-and-quality-gate|2026-05-17-implement-mcp-lifecycle-guardrails-and-quality-gate.md]]
- [[05_Agent_Session_Logs/2026-05-17-recommend-next-mcp-roadmap-slice|2026-05-17-recommend-next-mcp-roadmap-slice.md]]
- [[05_Agent_Session_Logs/2026-05-17-implement-task-aware-contextpack-presets|2026-05-17-implement-task-aware-contextpack-presets.md]]
- [[05_Agent_Session_Logs/2026-05-17-recommend-next-mcp-slice-after-contextpack-presets|2026-05-17-recommend-next-mcp-slice-after-contextpack-presets.md]]
- [[05_Agent_Session_Logs/2026-05-17-implement-read-only-follow-up-radar|2026-05-17-implement-read-only-follow-up-radar.md]]
- [[05_Agent_Session_Logs/2026-05-17-update-readme-to-comprehensive-thai-documentation|2026-05-17-update-readme-to-comprehensive-thai-documentation.md]]
- [[05_Agent_Session_Logs/2026-05-16-always-on-project-memory-workflow-for-ide-and-ai-agents|2026-05-16-always-on-project-memory-workflow-for-ide-and-ai-agents.md]]
- [[05_Agent_Session_Logs/2026-05-16-bootstrap-project-local-obsidian-memory-mcp-and-ide-integration-pack|2026-05-16-bootstrap-project-local-obsidian-memory-mcp-and-ide-integration-pack.md]]
- [[05_Agent_Session_Logs/2026-05-16-enforcing-pre-flight-memory-checks|2026-05-16-enforcing-pre-flight-memory-checks.md]]
- [[05_Agent_Session_Logs/2026-05-16-enforcing-strictest-memory-protocol-limits|2026-05-16-enforcing-strictest-memory-protocol-limits.md]]
- [[05_Agent_Session_Logs/2026-05-16-fix-mcp-regex-constraints-and-add-slash-command-prompts|2026-05-16-fix-mcp-regex-constraints-and-add-slash-command-prompts.md]]
- [[05_Agent_Session_Logs/2026-05-16-implementing-code-obfuscation-for-ip-protection|2026-05-16-implementing-code-obfuscation-for-ip-protection.md]]
- [[05_Agent_Session_Logs/2026-05-16-obsidian-ai-plugins-integration|2026-05-16-obsidian-ai-plugins-integration.md]]
- [[05_Agent_Session_Logs/2026-05-16-updating-mcp-bootstrap-defaults|2026-05-16-updating-mcp-bootstrap-defaults.md]]
- [[05_Agent_Session_Logs/2026-05-16-upgrade-project-memory-to-10-out-of-10-autopilot|2026-05-16-upgrade-project-memory-to-10-out-of-10-autopilot.md]]
