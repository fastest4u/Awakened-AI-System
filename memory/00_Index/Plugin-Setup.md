---
title: Plugin Setup
type: reference
status: active
created: 2026-05-16
updated: 2026-05-16
tags:
  - obsidian
  - plugins
  - project/general
last-verified: 2026-05-16
verified-by: memory-mcp
source: "file:.obsidian/community-plugins.json"
confidence: medium
---
# Plugin Setup

> [!important]
> MCP creates the Obsidian vault profile and recommended plugin list. Obsidian still needs the plugin code installed from Community Plugins before each plugin can run.

## Recommended Community Plugins

| Plugin | ID | Purpose |
|---|---|---|
| Templater | `templater-obsidian` | Dynamic templates and JavaScript-backed note creation |
| Dataview | `dataview` | Query notes and frontmatter like a database |
| Tasks | `obsidian-tasks-plugin` | Task queries with due dates, priority, and recurrence |
| QuickAdd | `quickadd` | Fast capture actions for inbox, session logs, and tasks |
| Obsidian Git | `obsidian-git` | Project-local memory backup through git |
| Calendar | `calendar` | Calendar sidebar linked to daily notes |
| Linter | `obsidian-linter` | Format notes and maintain frontmatter consistency |
| Excalidraw | `obsidian-excalidraw-plugin` | Diagrams, flows, sketches, and architecture maps |
| Kanban | `obsidian-kanban` | Board view for goals, follow-ups, and work states |
| Iconize | `obsidian-icon-folder` | Icons for folders, files, and note labels |
| Mind Map | `obsidian-mind-map` | Markdown heading trees as interactive mind maps |
| Smart Composer | `smart-composer` | AI chat and composing with vault context and MCP support |
| Smart Connections | `smart-connections` | RAG-based automated semantic note linking |

## Productivity Stack

- Templater drives files in `99_Templates/`.
- Dataview powers `00_Index/Vault-Dashboard.md`.
- Tasks reads task checkboxes across `10_Daily/`, `11_Tasks/`, session logs, and follow-ups.
- QuickAdd should capture to `00_Index/Inbox.md`, `11_Tasks/Tasks.md`, and `05_Agent_Session_Logs/`.
- Obsidian Git should commit vault changes with project changes.
- Calendar should use `10_Daily/` for daily notes.
- Linter should preserve YAML frontmatter and update `updated:` on save if you enable timestamp rules.

## Visual Stack

- Excalidraw files live in `13_Diagrams/`.
- Kanban boards live in `12_Kanban/`.
- Iconize can decorate the numbered folders.
- Mind Map notes live in `14_Mindmaps/` and should use heading hierarchy.

## AI / Smart Stack

- Smart Composer provides writing assistance and chat using vault context and MCP support.
- Smart Connections uses RAG to automatically find and link related notes across the vault.
