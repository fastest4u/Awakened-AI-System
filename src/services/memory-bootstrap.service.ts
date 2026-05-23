import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { frontmatter, todayIso } from "../utils/memory-format.js";

const FOLDERS = [
  "00_Index",
  "01_Project_Rules",
  "02_API_Docs",
  "03_Reusable_Components",
  "04_Architecture_Decisions",
  "05_Agent_Session_Logs",
  "06_Sources",
  "07_Insights",
  "08_Mistakes",
  "09_Runbooks",
  "10_Daily",
  "11_Tasks",
  "12_Kanban",
  "13_Diagrams",
  "14_Mindmaps",
  "98_Attachments",
  "99_Templates",
];

const OBSIDIAN_PLUGINS = [
  { id: "templater-obsidian", name: "Templater", purpose: "Dynamic templates and JavaScript-backed note creation" },
  { id: "dataview", name: "Dataview", purpose: "Query notes and frontmatter like a database" },
  { id: "obsidian-tasks-plugin", name: "Tasks", purpose: "Task queries with due dates, priority, and recurrence" },
  { id: "quickadd", name: "QuickAdd", purpose: "Fast capture actions for inbox, session logs, and tasks" },
  { id: "obsidian-git", name: "Obsidian Git", purpose: "Project-local memory backup through git" },
  { id: "calendar", name: "Calendar", purpose: "Calendar sidebar linked to daily notes" },
  { id: "obsidian-linter", name: "Linter", purpose: "Format notes and maintain frontmatter consistency" },
  { id: "obsidian-excalidraw-plugin", name: "Excalidraw", purpose: "Diagrams, flows, sketches, and architecture maps" },
  { id: "obsidian-kanban", name: "Kanban", purpose: "Board view for goals, follow-ups, and work states" },
  { id: "obsidian-icon-folder", name: "Iconize", purpose: "Icons for folders, files, and note labels" },
  { id: "obsidian-mind-map", name: "Mind Map", purpose: "Markdown heading trees as interactive mind maps" },
  { id: "smart-connections", name: "Smart Connections", purpose: "RAG-based automated semantic note linking" },
  { id: "smart-composer", name: "Smart Composer", purpose: "AI chat and composing with vault context and MCP support" },
];

export interface BootstrapProjectOptions {
  projectName?: string;
  overwrite?: boolean;
  ideConfigs?: boolean;
}

export class MemoryBootstrapService {
  private readonly projectRoot: string;
  private readonly serverEntrypoint: string;

  constructor(private readonly vaultRoot: string) {
    this.projectRoot = dirname(resolve(vaultRoot));
    this.serverEntrypoint = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js").replace(/\\/g, "/");
  }

  bootstrap(options: BootstrapProjectOptions = {}) {
    const projectName = options.projectName ?? "Project";
    const created: string[] = [];
    const skipped: string[] = [];
    const ideConfigs = options.ideConfigs ?? true;

    mkdirSync(this.vaultRoot, { recursive: true });
    for (const folder of FOLDERS) {
      const fullPath = join(this.vaultRoot, folder);
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
        created.push(`${folder}/`);
      }
    }

    for (const [relativePath, content] of this.seedFiles(projectName)) {
      const result = this.writeIfNeeded(relativePath, content, Boolean(options.overwrite));
      result === "created" ? created.push(relativePath) : skipped.push(relativePath);
    }

    if (ideConfigs) {
      for (const [relativePath, content] of this.projectIntegrationFiles(projectName)) {
        const result = this.writeProjectIfNeeded(relativePath, content, Boolean(options.overwrite));
        result === "created" ? created.push(`../${relativePath}`) : skipped.push(`../${relativePath}`);
      }
    }

    return {
      vaultRoot: this.vaultRoot,
      projectRoot: this.projectRoot,
      created,
      skipped,
      folders: FOLDERS,
      obsidianPlugins: OBSIDIAN_PLUGINS,
      ideConfigs,
    };
  }

  private writeIfNeeded(relativePath: string, content: string, overwrite: boolean) {
    const fullPath = join(this.vaultRoot, relativePath);
    if (existsSync(fullPath) && !overwrite) return "skipped";
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
    return "created";
  }

  private writeProjectIfNeeded(relativePath: string, content: string, overwrite: boolean) {
    const fullPath = resolve(this.projectRoot, relativePath);
    const root = resolve(this.projectRoot);
    if (fullPath !== root && !fullPath.startsWith(`${root}\\`) && !fullPath.startsWith(`${root}/`)) {
      throw new Error(`Path escapes project root: ${relativePath}`);
    }
    if (existsSync(fullPath) && !overwrite) return "skipped";
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
    return "created";
  }

  private projectIntegrationFiles(projectName: string): Array<[string, string]> {
    const mcpJson = {
      mcpServers: {
        "project-memory": {
          command: "node",
          args: [this.serverEntrypoint],
          env: {
            MEMORY_PROJECT_ROOT: "dynamic",
          },
        },
      },
    };

    const opencodeJson = {
      $schema: "https://opencode.ai/config.json",
      instructions: [
        "AGENTS.md",
        ".rules",
        "memory/AGENTS.md",
        "memory/01_Project_Rules/Always-On-Memory-Protocol.md",
        "memory/00_Index/Retrieval-Protocol.md",
        "memory/00_Index/AI-Client-Setup.md",
      ],
      mcp: {
        "project-memory": {
          type: "local",
          command: ["node", this.serverEntrypoint],
          enabled: true,
          environment: {
            MEMORY_PROJECT_ROOT: "dynamic",
          },
        },
      },
    };

    return [
      ["AGENTS.md", this.rootAgents(projectName)],
      [".rules", this.plainMemoryRule()],
      [".windsurfrules", this.plainMemoryRule()],
      ["GEMINI.md", this.rootAgents(projectName)],
      [".github/copilot-instructions.md", this.plainMemoryRule()],
      [".cursor/mcp.json", `${JSON.stringify(mcpJson, null, 2)}\n`],
      [".cursor/rules/project-memory.mdc", this.cursorRule()],
      [".codex/config.toml", this.codexConfigToml()],
      ["opencode.json", `${JSON.stringify(opencodeJson, null, 2)}\n`],
      [".zed/settings.json", `${JSON.stringify({
        context_servers: {
          "project-memory": {
            command: "node",
            args: [this.serverEntrypoint],
            env: {
              MEMORY_PROJECT_ROOT: "dynamic",
            },
          },
        },
      }, null, 2)}\n`],
      [".opencode/commands/session-start.md", this.commandDoc("session-start", "Call `memory_sessionStart` first, then use `memory_contextPack` for the current task before reading full notes. Use `mode: \"auto\"` or an explicit mode such as `coding`, `debugging`, `review`, `deploy`, `planning`, or `docs`.")],
      [".opencode/commands/context-pack.md", this.commandDoc("context-pack", "Call `memory_contextPack` with `query`, `taskArea`, and `mode`. Use `mode: \"auto\"` unless the task clearly fits `coding`, `debugging`, `review`, `deploy`, `planning`, or `docs`.")],
      [".opencode/commands/session-end.md", this.commandDoc("session-end", "Call `memory_sessionEnd` after meaningful work. Include outcomes, files touched, decisions made, open follow-ups, verification, and confidence lessons. Inspect the returned `qualityGate`; call `memory_verifyVault` if vault health was skipped or unclear.")],
      [".opencode/commands/memory-verify.md", this.commandDoc("memory-verify", "Call `memory_verifyVault` and fix errors before relying on memory.")],
      [".opencode/commands/awaken.md", this.commandDoc("awaken", "Call `memory_awaken` to assess current memory state, risks, and next actions.")],
      [".opencode/commands/self-check.md", this.commandDoc("self-check", "Call `memory_selfCheck` before risky, multi-file, production, database, auth, or deploy work.")],
      [".opencode/commands/lifecycle-status.md", this.commandDoc("lifecycle-status", "Call `memory_lifecycleStatus` to inspect the active memory lifecycle, recent quality gates, and missing protocol steps.")],
      [".opencode/commands/follow-up-radar.md", this.commandDoc("follow-up-radar", "Call `memory_followUpRadar` with `query`, `taskArea`, and `mode` to surface relevant open follow-ups before starting new work.")],
      [".windsurf/workflows/session-start.md", this.commandDoc("session-start", "Use MCP server `project-memory`. Call `memory_sessionStart`, then `memory_contextPack` with `mode: \"auto\"` or an explicit task mode. Do not read the whole vault.")],
      [".windsurf/workflows/context-pack.md", this.commandDoc("context-pack", "Use MCP server `project-memory`. Call `memory_contextPack` with `query`, `taskArea`, and `mode`; available modes are `auto`, `coding`, `debugging`, `review`, `deploy`, `planning`, and `docs`.")],
      [".windsurf/workflows/session-end.md", this.commandDoc("session-end", "Use MCP server `project-memory`. Call `memory_sessionEnd`, inspect `qualityGate`, and call `memory_verifyVault` if vault health was skipped or unclear.")],
      [".windsurf/workflows/self-check.md", this.commandDoc("self-check", "Use MCP server `project-memory`. Call `memory_selfCheck` before high-risk work.")],
      [".windsurf/workflows/lifecycle-status.md", this.commandDoc("lifecycle-status", "Use MCP server `project-memory`. Call `memory_lifecycleStatus` to inspect the active lifecycle and recent quality gates.")],
      [".windsurf/workflows/follow-up-radar.md", this.commandDoc("follow-up-radar", "Use MCP server `project-memory`. Call `memory_followUpRadar` with `query`, `taskArea`, and `mode` to surface relevant open follow-ups before starting new work.")],
      [".windsurf/rules/project-memory.md", this.windsurfRule()],
      [".windsurf/mcp_config.example.json", `${JSON.stringify(mcpJson, null, 2)}\n`],
      [".antigravity/mcp.example.json", `${JSON.stringify(mcpJson, null, 2)}\n`],
    ];
  }

  private rootAgents(projectName: string) {
    return [
      "# Repository Agent Memory",
      "",
      `This project uses an Obsidian-first memory vault at \`memory/\` for ${projectName}.`,
      "",
      ...this.alwaysOnMemoryProtocol(),
      "",
      "Do not read or dump the whole vault unless the user explicitly asks.",
      "",
    ].join("\n");
  }

  private codexConfigToml() {
    const server = this.tomlString(this.serverEntrypoint);
    return [
      "[mcp_servers.project-memory]",
      "command = \"node\"",
      `args = [${server}]`,
      "startup_timeout_sec = 20",
      "tool_timeout_sec = 60",
      "enabled = true",
      "",
      "[mcp_servers.project-memory.env]",
      "MEMORY_PROJECT_ROOT = \"dynamic\"",
      "",
    ].join("\n");
  }

  private commandDoc(name: string, instruction: string) {
    return [
      `# ${name}`,
      "",
      instruction,
      "",
      "Token rule: use `memory_contextPack` with the right `mode` before `memory_get` unless the user explicitly asks for a full note.",
      "",
    ].join("\n");
  }

  private cursorRule() {
    return [
      "---",
      "description: Always use project-memory MCP at session start and session end.",
      "globs:",
      "alwaysApply: true",
      "---",
      "",
      "# Project Memory",
      "",
      ...this.alwaysOnMemoryProtocol(),
      "",
    ].join("\n");
  }

  private windsurfRule() {
    return [
      "---",
      "trigger: always_on",
      "---",
      "",
      "# Project Memory",
      "",
      ...this.alwaysOnMemoryProtocol(),
      "",
    ].join("\n");
  }

  private plainMemoryRule() {
    return [
      "# Project Memory",
      "",
      ...this.alwaysOnMemoryProtocol(),
      "",
    ].join("\n");
  }

  private alwaysOnMemoryProtocol() {
    return [
      "## Always-On Memory Protocol",
      "",
      "- Treat MCP server `project-memory` as the durable memory source for this project.",
      "- At the start of every IDE/agent session, call `memory_sessionStart` before broad code exploration; this also updates lightweight usage scoring.",
      "- For each concrete task, call `memory_contextPack` with the task area and a retrieval mode (`auto`, `coding`, `debugging`, `review`, `deploy`, `planning`, or `docs`); read full notes only with `memory_get` for selected paths.",
      "- Review `followUps` returned by `memory_sessionStart` and `memory_contextPack`; call `memory_followUpRadar` when you need a focused open-work scan.",
      "- Before risky work, multi-file edits, database/schema changes, auth, deploys, or production operations, call `memory_selfCheck`.",
      "- During work, write durable decisions with `memory_writeADR`, repeated lessons with `memory_writeInsight`, and failure modes with `memory_writeMistake`.",
      "- At the end of every meaningful session, call `memory_sessionEnd` with outcomes, files touched, decisions made, open follow-ups, verification, and confidence lessons. It auto-compacts recent sessions into `07_Insights/Auto-Memory-Digest.md` when supported.",
      "- After `memory_sessionEnd`, inspect the returned `qualityGate` and health summary or call `memory_verifyVault`; fix errors before considering the session complete.",
      "- Use `memory_lifecycleStatus` when you need to audit whether the current task has followed the required memory lifecycle.",
      "- If MCP is unavailable, read `memory/AGENTS.md` and `memory/00_Index/Retrieval-Protocol.md`, then mention that memory tool writes were skipped.",
    ];
  }

  private tomlString(value: string) {
    return JSON.stringify(value);
  }

  private seedFiles(projectName: string): Array<[string, string]> {
    const date = todayIso();
    return [
      [".obsidian/app.json", JSON.stringify({
        attachmentFolderPath: "98_Attachments",
        alwaysUpdateLinks: true,
        newFileLocation: "folder",
        newFileFolderPath: "00_Index",
      }, null, 2) + "\n"],
      [".obsidian/community-plugins.json", JSON.stringify(OBSIDIAN_PLUGINS.map((plugin) => plugin.id), null, 2) + "\n"],
      ["README.md", `# ${projectName} Memory Vault\n\nPersistent SPX-style memory for AI agents working in this project.\n\nStart with \`AGENTS.md\`, then \`00_Index/MOC-Home.md\`.\n`],
      ["AGENTS.md", frontmatter({
        title: "Memory Vault Entry Point",
        type: "rules",
        status: "active",
        created: date,
        updated: date,
        tags: ["meta", "agent-rules", "entry-point"],
      }) + [
        "# AGENTS.md",
        "",
        "Every AI agent should read this file at session start.",
        "",
        "See [[Always-On-Memory-Protocol]] for the mandatory session contract shared by all IDEs and AI agents.",
        "",
        "## Session Start",
        "",
        "1. Call `memory_sessionStart`.",
        "2. Call `memory_contextPack` with the current task area and mode.",
        "3. Read full notes only when selected by the context pack.",
        "4. Review returned `followUps` or call `memory_followUpRadar`.",
        "5. Check `00_Index/Goals.md` and recent session logs.",
        "6. Search `08_Mistakes/` or call `memory_selfCheck` before risky work.",
        "",
        "## Session End",
        "",
        "Call `memory_sessionEnd` after meaningful work, including outcomes, files touched, decisions made, open follow-ups, verification, and confidence lessons. Inspect the returned `qualityGate`; call `memory_verifyVault` if vault health was skipped or unclear.",
        "",
        "> [!tip]",
        "> This vault is Obsidian-first but plain Markdown-safe. MCP writes notes in the project-local vault, while Obsidian plugins provide dashboards, tasks, templates, visuals, and git backup.",
        "",
        "## Token Economy",
        "",
        "- Start with [[Retrieval-Protocol]] and `memory_contextPack` using `mode: \"auto\"` or the explicit task mode.",
        "- Read full note bodies only after the compact pack selects paths.",
        "- Promote repeated session lessons into [[Memory-Digest]] or `07_Insights/`.",
        "- Keep session logs append-only; compact learnings into insights monthly.",
        "",
      ].join("\n")],
      ["AGENT-IDENTITY.md", frontmatter({
        title: "Agent Identity",
        type: "identity",
        status: "active",
        created: date,
        updated: date,
        tags: ["identity", "project/general"],
      }) + "# Agent Identity\n\nRole: project-aware coding assistant with persistent memory.\n"],
      ["00_Index/MOC-Home.md", frontmatter({
        title: "MOC Home",
        type: "moc",
        created: date,
        updated: date,
        tags: ["moc", "project/general"],
      }) + [
        "# MOC Home",
        "",
        "- [[Goals]]",
        "- [[Open-Followups]]",
        "- [[Vault-Dashboard]]",
        "- [[Plugin-Setup]]",
        "- [[AI-Client-Setup]]",
        "- [[Memory-Autopilot]]",
        "- [[Always-On-Memory-Protocol]]",
        "- [[Retrieval-Protocol]]",
        "- [[Memory-Digest]]",
        "- [[Daily-Notes]]",
        "- [[Tasks]]",
        "- [[Memory-Kanban]]",
        "- [[Memory-Mindmap]]",
        "- `01_Project_Rules/`",
        "- `04_Architecture_Decisions/`",
        "- `05_Agent_Session_Logs/`",
        "- `07_Insights/`",
        "- `08_Mistakes/`",
        "- `09_Runbooks/`",
        "",
      ].join("\n")],
      ["00_Index/Goals.md", frontmatter({
        title: "Goals",
        type: "goals",
        status: "active",
        created: date,
        updated: date,
        tags: ["goals", "project/general"],
      }) + "# Goals\n\n## Active Goals\n\n- [ ] Define project goals.\n"],
      ["00_Index/Open-Followups.md", frontmatter({
        title: "Open Followups",
        type: "index",
        created: date,
        updated: date,
        tags: ["followups", "project/general"],
      }) + "# Open Followups\n\n- [ ] Review recent session logs.\n"],
      ["01_Project_Rules/Always-On-Memory-Protocol.md", frontmatter({
        title: "Always-On Memory Protocol",
        type: "rules",
        status: "active",
        created: date,
        updated: date,
        tags: ["agent-rules", "mcp", "project-memory", "project/general"],
      }) + this.plainMemoryRule()],
      ["00_Index/Vault-Dashboard.md", frontmatter({
        title: "Vault Dashboard",
        type: "dashboard",
        created: date,
        updated: date,
        tags: ["dashboard", "project/general"],
      }) + [
        "# Vault Dashboard",
        "",
        "Use `memory_verifyVault` for MCP-side health. In Obsidian, Dataview and Tasks make the vault browsable.",
        "",
        "## Recent Sessions",
        "",
        "```dataview",
        "TABLE file.mtime AS Updated, agent, outcomes",
        "FROM \"05_Agent_Session_Logs\"",
        "WHERE type = \"session-log\"",
        "SORT row[\"session-date\"] DESC",
        "LIMIT 10",
        "```",
        "",
        "## Open Mistakes",
        "",
        "```dataview",
        "TABLE severity, area, confidence, file.mtime AS Updated",
        "FROM \"08_Mistakes\"",
        "WHERE type = \"mistake\" AND status = \"open\"",
        "SORT severity DESC",
        "```",
        "",
        "## Active ADRs",
        "",
        "```dataview",
        "TABLE status, confidence, file.mtime AS Updated",
        "FROM \"04_Architecture_Decisions\"",
        "WHERE type = \"adr\" AND status != \"superseded\"",
        "SORT row[\"decision-date\"] DESC",
        "```",
        "",
        "## Open Tasks",
        "",
        "```tasks",
        "not done",
        "path includes memory",
        "sort by priority",
        "sort by due",
        "```",
        "",
      ].join("\n")],
      ["00_Index/Plugin-Setup.md", frontmatter({
        title: "Plugin Setup",
        type: "reference",
        status: "active",
        created: date,
        updated: date,
        tags: ["obsidian", "plugins", "project/general"],
        "last-verified": date,
        "verified-by": "memory-mcp",
        source: "file:.obsidian/community-plugins.json",
        confidence: "medium",
      }) + [
        "# Plugin Setup",
        "",
        "> [!important]",
        "> MCP creates the Obsidian vault profile and recommended plugin list. Obsidian still needs the plugin code installed from Community Plugins before each plugin can run.",
        "",
        "## Recommended Community Plugins",
        "",
        "| Plugin | ID | Purpose |",
        "|---|---|---|",
        ...OBSIDIAN_PLUGINS.map((plugin) => `| ${plugin.name} | \`${plugin.id}\` | ${plugin.purpose} |`),
        "",
        "## Productivity Stack",
        "",
        "- Templater drives files in `99_Templates/`.",
        "- Dataview powers `00_Index/Vault-Dashboard.md`.",
        "- Tasks reads task checkboxes across `10_Daily/`, `11_Tasks/`, session logs, and follow-ups.",
        "- QuickAdd should capture to `00_Index/Inbox.md`, `11_Tasks/Tasks.md`, and `05_Agent_Session_Logs/`.",
        "- Obsidian Git should commit vault changes with project changes.",
        "- Calendar should use `10_Daily/` for daily notes.",
        "- Linter should preserve YAML frontmatter and update `updated:` on save if you enable timestamp rules.",
        "",
        "## Visual Stack",
        "",
        "- Excalidraw files live in `13_Diagrams/`.",
        "- Kanban boards live in `12_Kanban/`.",
        "- Iconize can decorate the numbered folders.",
        "- Mind Map notes live in `14_Mindmaps/` and should use heading hierarchy.",
        "",
        "## AI / Smart Stack",
        "",
        "- Smart Composer provides writing assistance and chat using vault context and MCP support.",
        "- Smart Connections uses RAG to automatically find and link related notes across the vault.",
        "",
      ].join("\n")],
      ["00_Index/AI-Client-Setup.md", frontmatter({
        title: "AI Client Setup",
        type: "reference",
        status: "active",
        created: date,
        updated: date,
        tags: ["mcp", "ai-clients", "project/general"],
        "last-verified": date,
        "verified-by": "memory-mcp",
        source: "memory-mcp bootstrap",
        confidence: "medium",
      }) + [
        "# AI Client Setup",
        "",
        "This project is optimized for OpenCode, Codex, Zed, Cursor, Windsurf, and Google Antigravity.",
        "",
        "## Generated Project Files",
        "",
        "- `../AGENTS.md`: shared agent instructions for project memory.",
        "- `../.rules`: Zed project-level always-on memory rule.",
        "- `../.windsurfrules`: Windsurf compatibility memory rule.",
        "- `../GEMINI.md`: Gemini and Google Antigravity compatibility memory rule.",
        "- `../.github/copilot-instructions.md`: GitHub Copilot compatibility memory rule.",
        "- `../opencode.json`: OpenCode MCP server configuration and memory instruction list.",
        "- `../.opencode/commands/`: OpenCode memory workflow commands.",
        "- `../.codex/config.toml`: Codex project MCP configuration.",
        "- `../.zed/settings.json`: Zed custom MCP context server.",
        "- `../.cursor/mcp.json`: Cursor project MCP configuration.",
        "- `../.cursor/rules/project-memory.mdc`: Cursor always-on memory rule.",
        "- `../.windsurf/rules/project-memory.md`: Windsurf always-on memory rule.",
        "- `../.windsurf/workflows/`: Windsurf workflow prompts.",
        "- `../.windsurf/mcp_config.example.json`: Windsurf MCP example for user-level import.",
        "- `../.antigravity/mcp.example.json`: Google Antigravity MCP example for user-level import.",
        "",
        "## Required Flow",
        "",
        "1. Call `memory_sessionStart` when opening the IDE or starting meaningful work.",
        "2. Call `memory_contextPack` for task-specific memory with `mode: \"auto\"` or an explicit mode. Do not dump the full vault.",
        "3. Review returned `followUps` or call `memory_followUpRadar` for a focused open-work scan.",
        "4. Call `memory_selfCheck` before risky edits.",
        "5. Call `memory_sessionEnd` before ending the session. It auto-compacts recent sessions and returns vault health plus a lifecycle quality gate when supported.",
        "6. Inspect `qualityGate`; call `memory_lifecycleStatus` or `memory_verifyVault` when the sessionEnd response shows gaps.",
        "",
        "See [[Always-On-Memory-Protocol]] for the mandatory session contract shared by all AI clients.",
        "",
      ].join("\n")],
      ["00_Index/Memory-Autopilot.md", frontmatter({
        title: "Memory Autopilot",
        type: "reference",
        status: "active",
        created: date,
        updated: date,
        tags: ["autopilot", "project-memory", "token-economy", "project/general"],
        "last-verified": date,
        "verified-by": "memory-mcp",
        source: "memory-mcp bootstrap",
        confidence: "medium",
      }) + [
        "# Memory Autopilot",
        "",
        "Memory autopilot is the strongest supported workflow for this vault.",
        "",
        "## What Runs Automatically When Agents Follow The Protocol",
        "",
        "- `memory_sessionStart` loads startup context and updates lightweight usage scoring.",
        "- `memory_contextPack` selects a compact task-specific pack, supports task-aware modes, and learns which notes are repeatedly selected.",
        "- `memory_followUpRadar` scans unchecked tasks and follow-up sections, then scores open work by query, task area, and mode.",
        "- `memory_sessionEnd` writes the session log, updates `07_Insights/Auto-Memory-Digest.md`, and returns vault health plus a lifecycle quality gate.",
        "- `memory_lifecycleStatus` reports the active lifecycle and recent quality gates from `.memory-mcp/lifecycle.json`.",
        "- `memory_compactVault` can be run manually for dry runs or forced digest refreshes.",
        "",
        "## Limits",
        "",
        "- MCP servers cannot force an IDE to call tools, but the lifecycle quality gate makes skipped steps visible.",
        "- If an agent ignores the rules, ask it to call `memory_lifecycleStatus`, then `memory_sessionStart` before continuing and `memory_sessionEnd` before stopping.",
        "",
      ].join("\n")],
      ["00_Index/Retrieval-Protocol.md", frontmatter({
        title: "Retrieval Protocol",
        type: "reference",
        status: "active",
        created: date,
        updated: date,
        tags: ["retrieval", "token-economy", "project/general"],
        "last-verified": date,
        "verified-by": "memory-mcp",
        source: "memory-mcp bootstrap",
        confidence: "medium",
      }) + [
        "# Retrieval Protocol",
        "",
        "> [!important]",
        "> The goal is to retrieve the right memory, not the most memory.",
        "",
        "## Default MCP Flow",
        "",
        "1. Call `memory_sessionStart` for startup context and lifecycle tracking.",
        "2. Call `memory_contextPack` with the current task or area and mode.",
        "3. Inspect selected paths, scores, and usage hints.",
        "4. Review returned `followUps`; call `memory_followUpRadar` for a focused open-work scan.",
        "5. Call `memory_get` only for paths that need full body.",
        "6. If a lesson repeats across sessions, write an insight instead of re-reading every old log.",
        "7. End meaningful work with `memory_sessionEnd`; it writes a session log, refreshes `Auto-Memory-Digest`, and returns vault health plus a quality gate when supported.",
        "",
        "## Context Pack Modes",
        "",
        "- `auto`: infer a mode from `query` and `taskArea`, falling back to generic retrieval.",
        "- `coding`: implementation, APIs, components, schemas, and tests.",
        "- `debugging`: bugs, regressions, exceptions, and broken workflows.",
        "- `review`: code review, risk audit, PR checks, and quality assessment.",
        "- `deploy`: production, releases, migrations, rollback, and operations.",
        "- `planning`: roadmap, architecture, prioritization, and decisions.",
        "- `docs`: README, setup, reference notes, guides, and protocol updates.",
        "",
        "## Read Order",
        "",
        "1. Rules and goals",
        "2. Matching ADRs",
        "3. Matching runbooks",
        "4. Open mistakes in the area",
        "5. Recent session logs",
        "6. Full note bodies only when needed",
        "",
        "## Token Budget Defaults",
        "",
        "- Startup context: 12 items / 6000 chars",
        "- Task context: 10 items / 5000 chars",
        "- Session logs: excerpts only until selected",
        "- Mistakes and ADRs outrank generic notes",
        "- Repeatedly selected notes receive a lightweight usage boost",
        "",
      ].join("\n")],
      ["00_Index/Memory-Digest.md", frontmatter({
        title: "Memory Digest",
        type: "dashboard",
        created: date,
        updated: date,
        tags: ["digest", "token-economy", "project/general"],
      }) + [
        "# Memory Digest",
        "",
        "This page is the compact map agents should update when repeated lessons become durable.",
        "",
        "## Stable Decisions",
        "",
        "```dataview",
        "TABLE status, confidence, file.link AS Note",
        "FROM \"04_Architecture_Decisions\"",
        "WHERE type = \"adr\" AND status = \"accepted\"",
        "SORT row[\"decision-date\"] DESC",
        "LIMIT 10",
        "```",
        "",
        "## Durable Insights",
        "",
        "```dataview",
        "TABLE confidence, file.link AS Note",
        "FROM \"07_Insights\"",
        "WHERE type = \"insight\"",
        "SORT file.mtime DESC",
        "LIMIT 10",
        "```",
        "",
        "## Failure Modes",
        "",
        "```dataview",
        "TABLE severity, area, confidence, file.link AS Note",
        "FROM \"08_Mistakes\"",
        "WHERE type = \"mistake\" AND status = \"open\"",
        "SORT severity DESC",
        "LIMIT 10",
        "```",
        "",
      ].join("\n")],
      ["00_Index/Daily-Notes.md", frontmatter({
        title: "Daily Notes",
        type: "reference",
        status: "active",
        created: date,
        updated: date,
        tags: ["daily-notes", "calendar", "project/general"],
        "last-verified": date,
        "verified-by": "memory-mcp",
        source: "memory-mcp bootstrap",
        confidence: "medium",
      }) + [
        "# Daily Notes",
        "",
        "Daily notes are kept in `10_Daily/` and are meant for quick capture before promotion into durable memory.",
        "",
        "```dataview",
        "LIST",
        "FROM \"10_Daily\"",
        "SORT file.name DESC",
        "LIMIT 14",
        "```",
        "",
      ].join("\n")],
      ["00_Index/Inbox.md", frontmatter({
        title: "Inbox",
        type: "index",
        created: date,
        updated: date,
        tags: ["inbox", "project/general"],
      }) + "# Inbox\n\n- [ ] Triage this vault after bootstrap.\n"],
      ["11_Tasks/Tasks.md", frontmatter({
        title: "Tasks",
        type: "dashboard",
        created: date,
        updated: date,
        tags: ["tasks", "project/general"],
      }) + [
        "# Tasks",
        "",
        "## Inbox",
        "",
        "- [ ] Review memory bootstrap output #task",
        "",
        "## Query",
        "",
        "```tasks",
        "not done",
        "sort by priority",
        "sort by due",
        "```",
        "",
      ].join("\n")],
      ["12_Kanban/Memory-Kanban.md", frontmatter({
        title: "Memory Kanban",
        type: "dashboard",
        created: date,
        updated: date,
        tags: ["kanban", "project/general"],
        "kanban-plugin": "board",
      }) + [
        "# Memory Kanban",
        "",
        "## Inbox",
        "",
        "- Review new notes",
        "",
        "## Doing",
        "",
        "## Waiting",
        "",
        "## Done",
        "",
      ].join("\n")],
      ["13_Diagrams/README.md", frontmatter({
        title: "Diagrams",
        type: "index",
        created: date,
        updated: date,
        tags: ["diagrams", "excalidraw", "project/general"],
      }) + "# Diagrams\n\nUse Excalidraw for architecture sketches and Mermaid for lightweight diagrams.\n"],
      ["13_Diagrams/Memory-System-Map.md", frontmatter({
        title: "Memory System Map",
        type: "reference",
        status: "active",
        created: date,
        updated: date,
        tags: ["diagram", "memory-vault", "project/general"],
        "last-verified": date,
        "verified-by": "memory-mcp",
        source: "memory-mcp bootstrap",
        confidence: "medium",
      }) + [
        "# Memory System Map",
        "",
        "```mermaid",
        "graph TD",
        "  MCP[MCP Server] --> Vault[Project Obsidian Vault]",
        "  Vault --> Sessions[Session Logs]",
        "  Vault --> ADRs[Architecture Decisions]",
        "  Vault --> Insights[Insights]",
        "  Vault --> Mistakes[Mistakes]",
        "  Vault --> Runbooks[Runbooks]",
        "  Obsidian[Obsidian Plugins] --> Vault",
        "  Agent[AI Agent / IDE] --> MCP",
        "```",
        "",
      ].join("\n")],
      ["14_Mindmaps/Memory-Mindmap.md", frontmatter({
        title: "Memory Mindmap",
        type: "reference",
        status: "active",
        created: date,
        updated: date,
        tags: ["mindmap", "project/general"],
        "last-verified": date,
        "verified-by": "memory-mcp",
        source: "memory-mcp bootstrap",
        confidence: "medium",
      }) + [
        "# Memory Mindmap",
        "",
        "## Project Memory",
        "",
        "### Rules",
        "",
        "### Goals",
        "",
        "### Decisions",
        "",
        "### Session Logs",
        "",
        "### Insights",
        "",
        "### Mistakes",
        "",
        "### Runbooks",
        "",
      ].join("\n")],
      ["99_Templates/Template-Session-Log.md", frontmatter({
        title: "Template Session Log",
        type: "reference",
        status: "active",
        created: date,
        updated: date,
        tags: ["template", "session-log"],
      }) + "# Template Session Log\n\nUse `memory_writeSessionLog` or `memory_sessionEnd`.\n"],
      ["99_Templates/Template-ADR.md", frontmatter({
        title: "Template ADR",
        type: "reference",
        status: "active",
        created: date,
        updated: date,
        tags: ["template", "adr"],
      }) + "# Template ADR\n\nUse `memory_writeADR`.\n"],
      ["99_Templates/Template-Mistake.md", frontmatter({
        title: "Template Mistake",
        type: "reference",
        status: "active",
        created: date,
        updated: date,
        tags: ["template", "mistake"],
      }) + "# Template Mistake\n\nUse `memory_writeMistake`.\n"],
      ["99_Templates/Template-Insight.md", frontmatter({
        title: "Template Insight",
        type: "reference",
        status: "active",
        created: date,
        updated: date,
        tags: ["template", "insight"],
      }) + "# Template Insight\n\nUse `memory_writeInsight`.\n"],
      ["99_Templates/Template-Daily-Note.md", frontmatter({
        title: "<% tp.date.now(\"YYYY-MM-DD\") %>",
        type: "note",
        created: "<% tp.date.now(\"YYYY-MM-DD\") %>",
        updated: "<% tp.date.now(\"YYYY-MM-DD\") %>",
        tags: ["daily", "project/general"],
      }) + [
        "# <% tp.date.now(\"YYYY-MM-DD\") %>",
        "",
        "## Capture",
        "",
        "- [ ] ",
        "",
        "## Work Log",
        "",
        "## Promote",
        "",
        "- ADR:",
        "- Insight:",
        "- Mistake:",
        "- Session log:",
        "",
      ].join("\n")],
    ];
  }
}
