import type { AuditService } from "./audit.service.js";
import type { MemoryFollowUpService } from "./memory-follow-up.service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle.service.js";
import type { MemoryCompactionService } from "./memory-compaction.service.js";
import type { MemoryQueryService } from "./memory-query.service.js";
import type { MemoryTemplateService, SessionLogTemplateInput } from "./memory-template.service.js";
import type { MemoryUsageService } from "./memory-usage.service.js";
import type { NoteService } from "./note.service.js";
import type { VaultHealthService } from "./vault-health.service.js";
import type { VaultService } from "./vault.service.js";

type ContextPackMode = "auto" | "coding" | "debugging" | "review" | "deploy" | "planning" | "docs";

interface ContextPackIncludes {
  includeRecentSessions: boolean;
  includeMistakes: boolean;
  includeAdrs: boolean;
  includeRunbooks: boolean;
}

interface ContextPackPreset {
  description: string;
  defaultIncludes: ContextPackIncludes;
  typeWeights: Record<string, number>;
  extraTerms: string[];
  recommendedReads: string[];
  checklistHints: string[];
  retrievalRules: string[];
}

interface ContextPackInput {
  query?: string;
  taskArea?: string;
  mode?: ContextPackMode;
  maxItems: number;
  maxChars: number;
  includeRecentSessions?: boolean;
  includeMistakes?: boolean;
  includeAdrs?: boolean;
  includeRunbooks?: boolean;
}

interface SessionEndWorkflowInput extends SessionLogTemplateInput {
  autoCompact?: boolean;
  verify?: boolean;
}

const CONTEXT_PACK_PRESETS: Record<ContextPackMode, ContextPackPreset> = {
  auto: {
    description: "Generic retrieval with legacy-compatible defaults. Auto mode resolves to a focused mode when query/taskArea has a strong signal.",
    defaultIncludes: { includeRecentSessions: true, includeMistakes: true, includeAdrs: true, includeRunbooks: true },
    typeWeights: {},
    extraTerms: [],
    recommendedReads: [],
    checklistHints: ["Use an explicit mode when the task category is known."],
    retrievalRules: ["Auto mode keeps generic behavior unless query/taskArea clearly matches a preset."],
  },
  coding: {
    description: "Implementation-focused retrieval for code changes, APIs, components, schemas, and tests.",
    defaultIncludes: { includeRecentSessions: true, includeMistakes: true, includeAdrs: true, includeRunbooks: true },
    typeWeights: { component: 5, adr: 4, runbook: 3, insight: 2, mistake: 2, "session-log": 2, reference: 1 },
    extraTerms: ["code", "implementation", "api", "component", "service", "schema", "test"],
    recommendedReads: ["04_Architecture_Decisions/", "03_Reusable_Components/", "09_Runbooks/"],
    checklistHints: ["Read matching ADRs before changing shared behavior.", "Check recent sessions for partial work in the same area."],
    retrievalRules: ["Coding mode boosts components, ADRs, runbooks, recent implementation logs, and relevant mistakes."],
  },
  debugging: {
    description: "Failure-focused retrieval for bugs, regressions, exceptions, flaky behavior, and broken workflows.",
    defaultIncludes: { includeRecentSessions: true, includeMistakes: true, includeAdrs: true, includeRunbooks: true },
    typeWeights: { mistake: 7, "session-log": 5, runbook: 3, adr: 2, insight: 2 },
    extraTerms: ["bug", "debug", "error", "failure", "exception", "regression", "fix"],
    recommendedReads: ["08_Mistakes/", "05_Agent_Session_Logs/", "09_Runbooks/"],
    checklistHints: ["Read open mistakes in the affected area first.", "Look for the last known good verification in recent sessions."],
    retrievalRules: ["Debugging mode boosts mistakes, recent sessions, and runbooks ahead of generic references."],
  },
  review: {
    description: "Risk-focused retrieval for code review, audits, PR checks, and quality assessment.",
    defaultIncludes: { includeRecentSessions: true, includeMistakes: true, includeAdrs: true, includeRunbooks: false },
    typeWeights: { rules: 5, mistake: 5, adr: 4, insight: 3, "session-log": 2, reference: 1 },
    extraTerms: ["review", "audit", "risk", "quality", "regression", "verification"],
    recommendedReads: ["01_Project_Rules/", "04_Architecture_Decisions/", "08_Mistakes/"],
    checklistHints: ["Lead with bugs, regressions, and missing tests.", "Check whether the change violates accepted ADRs or project rules."],
    retrievalRules: ["Review mode boosts project rules, ADRs, mistakes, and verification-oriented notes."],
  },
  deploy: {
    description: "Production-focused retrieval for deploys, releases, migrations, rollback planning, and operations.",
    defaultIncludes: { includeRecentSessions: true, includeMistakes: true, includeAdrs: true, includeRunbooks: true },
    typeWeights: { runbook: 8, mistake: 6, adr: 4, "session-log": 3, rules: 2, reference: 1 },
    extraTerms: ["deploy", "production", "prod", "release", "rollback", "migration", "database"],
    recommendedReads: ["09_Runbooks/", "08_Mistakes/", "04_Architecture_Decisions/", "00_Index/Open-Followups.md"],
    checklistHints: ["Run memory_selfCheck before production or migration work.", "Confirm rollback and verification steps are documented."],
    retrievalRules: ["Deploy mode boosts runbooks, operational mistakes, ADRs, and recent production sessions."],
  },
  planning: {
    description: "Decision-focused retrieval for roadmap, design, prioritization, and architecture planning.",
    defaultIncludes: { includeRecentSessions: true, includeMistakes: false, includeAdrs: true, includeRunbooks: false },
    typeWeights: { goals: 7, insight: 6, adr: 5, dashboard: 3, index: 3, "session-log": 2, reference: 1 },
    extraTerms: ["plan", "roadmap", "design", "architecture", "prioritize", "decision"],
    recommendedReads: ["00_Index/Goals.md", "00_Index/Open-Followups.md", "04_Architecture_Decisions/", "07_Insights/"],
    checklistHints: ["Promote durable decisions into ADRs.", "Capture follow-ups explicitly instead of burying them in session prose."],
    retrievalRules: ["Planning mode boosts goals, insights, ADRs, dashboards, and recent planning logs."],
  },
  docs: {
    description: "Documentation-focused retrieval for README, setup, reference notes, guides, and protocol updates.",
    defaultIncludes: { includeRecentSessions: false, includeMistakes: false, includeAdrs: true, includeRunbooks: true },
    typeWeights: { reference: 8, rules: 5, index: 4, dashboard: 3, runbook: 3, adr: 2, insight: 2 },
    extraTerms: ["docs", "documentation", "readme", "guide", "setup", "reference", "protocol"],
    recommendedReads: ["README.md", "00_Index/", "01_Project_Rules/", "09_Runbooks/"],
    checklistHints: ["Update generated bootstrap docs when changing user-facing workflow.", "Keep protocol docs aligned with actual tool responses."],
    retrievalRules: ["Docs mode boosts references, rules, index notes, dashboards, and runbooks."],
  },
};

export class MemoryWorkflowService {
  constructor(
    private readonly vault: VaultService,
    private readonly query: MemoryQueryService,
    private readonly health: VaultHealthService,
    private readonly notes: NoteService,
    private readonly templates: MemoryTemplateService,
    private readonly audit: AuditService,
    private readonly usage: MemoryUsageService,
    private readonly compactor: MemoryCompactionService,
    private readonly lifecycle: MemoryLifecycleService,
    private readonly followUps: MemoryFollowUpService,
  ) {}

  async sessionStart(input: { taskArea?: string; mode?: ContextPackMode; recentLimit: number; maxItems: number; maxChars: number }) {
    const lifecycleStart = this.lifecycle.start({ taskArea: input.taskArea });
    const contextPack = await this.contextPack({
      query: input.taskArea,
      taskArea: input.taskArea,
      mode: input.mode,
      maxItems: input.maxItems,
      maxChars: input.maxChars,
    });
    const coreFiles = ["AGENTS.md", "AGENT-IDENTITY.md", "00_Index/MOC-Home.md", "00_Index/Goals.md", "00_Index/Open-Followups.md"];

    return {
      vaultRoot: this.vault.vaultRoot,
      files: contextPack.totalIndexed,
      coreFiles: coreFiles.map((path) => ({ path, exists: this.vault.exists(path) })),
      contextPack,
      followUps: contextPack.followUps,
      lifecycle: { session: contextPack.lifecycle.session, warnings: this.uniqueStrings([...lifecycleStart.warnings, ...contextPack.lifecycle.warnings]) },
      recommendedReads: contextPack.mode.recommendedReads,
    };
  }

  async contextPack(input: ContextPackInput) {
    const lifecycle = this.lifecycle.recordContextPack({ query: input.query, taskArea: input.taskArea });
    const mode = this.resolveContextMode(input.mode, input.query, input.taskArea);
    const preset = CONTEXT_PACK_PRESETS[mode.resolved];
    const includes = this.effectiveIncludes(input, preset);
    const followUps = await this.followUps.compact({
      query: input.query,
      taskArea: input.taskArea,
      mode: mode.resolved,
      limit: 8,
    });
    const records = await this.query.snapshotIndex();
    const queryTerms = this.queryTerms(input.query, input.taskArea);
    const scoringTerms = this.uniqueTerms([...queryTerms, ...preset.extraTerms]);
    const scored = records
      .filter((record) => this.shouldInclude(record.type, includes))
      .map((record) => ({
        record,
        score: this.scoreRecord(record, scoringTerms, preset),
      }))
      .filter((item) => item.score > 0 || scoringTerms.length === 0)
      .sort((a, b) => b.score - a.score || String(b.record.updatedAt).localeCompare(String(a.record.updatedAt)));

    const selected = [];
    let usedChars = 0;
    for (const item of scored) {
      if (selected.length >= input.maxItems) break;
      const compact = this.compactRecord(item.record, item.score);
      const size = JSON.stringify(compact).length;
      if (selected.length > 0 && usedChars + size > input.maxChars) continue;
      selected.push(compact);
      usedChars += size;
    }
    const usageState = this.usage.recordContextPack(selected, { query: input.query, taskArea: input.taskArea });

    return {
      totalIndexed: records.length,
      query: input.query,
      taskArea: input.taskArea,
      mode: {
        requested: mode.requested,
        resolved: mode.resolved,
        inferred: mode.requested === "auto" && mode.resolved !== "auto",
        description: preset.description,
        effectiveIncludes: includes,
        boostedTypes: this.boostedTypes(preset),
        extraTerms: preset.extraTerms,
        recommendedReads: this.recommendedReads(input.taskArea, mode.resolved),
        checklistHints: preset.checklistHints,
      },
      budget: {
        maxItems: input.maxItems,
        maxChars: input.maxChars,
        usedChars,
        estimatedTokens: Math.ceil(usedChars / 4),
      },
      selected,
      omittedCount: Math.max(0, scored.length - selected.length),
      usage: {
        trackedNotes: Object.keys(usageState.records).length,
        updatedAt: usageState.updatedAt,
      },
      followUps,
      lifecycle,
      retrievalRules: [
        "Use contextPack first; call memory_get only for selected paths that need full body.",
        "Prefer ADRs, runbooks, open mistakes, and recent sessions over broad vault reads.",
        "Promote repeated session lessons into insights instead of re-reading old logs.",
        ...preset.retrievalRules,
      ],
    };
  }

  async awaken(input: { focus?: string }) {
    const context = await this.sessionStart({ taskArea: input.focus, recentLimit: 5, maxItems: 12, maxChars: 6000 });
    const health = await this.health.verifyVault({ includeWarnings: true });
    return {
      focus: input.focus,
      context,
      health: {
        ok: health.ok,
        score: health.score,
        grade: health.grade,
        errors: health.errors,
        warnings: health.warnings,
      },
      nextActions: this.nextActions(health.errors, health.warnings, context.contextPack.selected.filter((item) => item.type === "mistake").length),
    };
  }

  async selfCheck(input: { task: string; area?: string; riskLevel: "low" | "medium" | "high" }) {
    const lifecycle = this.lifecycle.recordSelfCheck(input);
    const records = await this.query.snapshotIndex();
    const area = input.area?.toLowerCase();
    const matchingMistakes = area
      ? records.filter((record) => record.type === "mistake" && `${record.path} ${record.title} ${record.tags.join(" ")}`.toLowerCase().includes(area)).slice(0, 10)
      : records.filter((record) => record.type === "mistake").slice(0, 5);

    return {
      task: input.task,
      riskLevel: input.riskLevel,
      area: input.area,
      confidencePrompt: "State confidence as high, medium, low, or guess, with evidence paths.",
      pastMistakesToAvoid: matchingMistakes,
      lifecycle,
      checklist: [
        "Read the source files before editing.",
        "Check matching memory notes, ADRs, runbooks, and mistakes.",
        "Use the smallest safe change.",
        "Run the right verification gate.",
        "Write a session log after meaningful work.",
      ],
    };
  }

  async sessionEnd(input: SessionEndWorkflowInput) {
    const path = this.notes.create(this.templates.sessionLogPath(input), this.templates.sessionLog(input));
    this.audit.record("memory_sessionEnd", { path, topic: input.topic, agent: input.agent });
    const compact = input.autoCompact === false
      ? { compacted: false, path: null, promotedNotes: [], reason: "autoCompact disabled" }
      : await this.compactor.compact({
        fromFolder: "05_Agent_Session_Logs",
        targetFolder: "07_Insights",
        maxSessions: 30,
        minSessions: 1,
        dryRun: false,
      });
    const health = input.verify === false
      ? null
      : await this.health.verifyVault({ includeWarnings: true });
    return {
      saved: true,
      path,
      autoCompact: compact,
      health: health
        ? {
          ok: health.ok,
          score: health.score,
          grade: health.grade,
          errors: health.errors,
          warnings: health.warnings,
        }
        : null,
      ...this.lifecycle.end(input, health),
    };
  }

  lifecycleStatus(input: { includeHistory?: boolean }) {
    return this.lifecycle.status(input);
  }

  followUpRadar(input: { query?: string; taskArea?: string; mode?: ContextPackMode; folders?: string[]; limit: number }) {
    return this.followUps.radar(input);
  }

  private recommendedReads(taskArea?: string, mode: ContextPackMode = "auto") {
    const common = ["AGENTS.md", "00_Index/Retrieval-Protocol.md", "00_Index/MOC-Home.md", "AGENT-IDENTITY.md", "00_Index/Goals.md"];
    const presetReads = CONTEXT_PACK_PRESETS[mode].recommendedReads;
    if (!taskArea) return this.uniqueStrings([...common, ...presetReads]);

    const area = taskArea.toLowerCase();
    const areaReads = [];
    if (area.includes("db") || area.includes("migration")) areaReads.push("09_Runbooks/Runbook-DB-Migration.md", "04_Architecture_Decisions/");
    if (area.includes("api")) areaReads.push("02_API_Docs/", "09_Runbooks/");
    if (area.includes("deploy") || area.includes("prod")) areaReads.push("09_Runbooks/Runbook-Deploy-Safety-Checklist.md");
    if (area.includes("memory") || area.includes("mcp")) areaReads.push("07_Insights/Memory-Vault-Principles.md", "00_Index/Vault-Dashboard.md");
    return this.uniqueStrings([...common, ...presetReads, ...areaReads]);
  }

  private nextActions(errors: number, warnings: number, openMistakes: number) {
    const actions = [];
    if (errors > 0) actions.push("Fix vault errors before relying on memory.");
    if (warnings > 0) actions.push("Review warnings and decide whether to clean them now or log follow-ups.");
    if (openMistakes > 0) actions.push("Read matching mistake notes before risky work.");
    if (actions.length === 0) actions.push("Memory is ready; retrieve the task-specific cluster before coding.");
    return actions;
  }

  private shouldInclude(type: string, input: ContextPackIncludes) {
    if (type === "session-log") return input.includeRecentSessions;
    if (type === "mistake") return input.includeMistakes;
    if (type === "adr") return input.includeAdrs;
    if (type === "runbook") return input.includeRunbooks;
    return ["rules", "goals", "identity", "moc", "dashboard", "reference", "insight", "component", "index"].includes(type);
  }

  private queryTerms(query?: string, taskArea?: string) {
    return `${query ?? ""} ${taskArea ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9ก-๙_-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length > 1);
  }

  private scoreRecord(record: Awaited<ReturnType<MemoryQueryService["snapshotIndex"]>>[number], terms: string[], preset: ContextPackPreset) {
    let score = 0;
    const haystack = `${record.path} ${record.title} ${record.type} ${record.tags.join(" ")} ${record.aliases.join(" ")} ${record.excerpt}`.toLowerCase();
    for (const term of terms) {
      if (record.title.toLowerCase().includes(term)) score += 8;
      if (record.path.toLowerCase().includes(term)) score += 6;
      if (record.tags.some((tag) => tag.toLowerCase().includes(term))) score += 5;
      if (haystack.includes(term)) score += 3;
    }
    score += this.typeWeight(record.type, preset);
    score += this.usage.scoreBoost(record.path, terms);
    if (record.type === "mistake" && !haystack.includes("resolved")) score += 5;
    if (record.type === "adr" && !haystack.includes("superseded")) score += 4;
    return score;
  }

  private typeWeight(type: string, preset: ContextPackPreset) {
    const weights: Record<string, number> = {
      rules: 9,
      goals: 8,
      identity: 8,
      adr: 8,
      runbook: 7,
      mistake: 7,
      insight: 6,
      component: 5,
      reference: 4,
      "session-log": 3,
      moc: 3,
      dashboard: 2,
      index: 2,
    };
    return (weights[type] ?? 1) + (preset.typeWeights[type] ?? 0);
  }

  private resolveContextMode(mode: ContextPackMode | undefined, query?: string, taskArea?: string) {
    const requested = mode ?? "auto";
    if (requested !== "auto") return { requested, resolved: requested };

    const text = `${query ?? ""} ${taskArea ?? ""}`.toLowerCase();
    if (this.hasAny(text, ["deploy", "production", "prod", "release", "rollback", "migration", "database", "schema"])) {
      return { requested, resolved: "deploy" as const };
    }
    if (this.hasAny(text, ["debug", "bug", "error", "exception", "failure", "failing", "regression", "broken", "fix"])) {
      return { requested, resolved: "debugging" as const };
    }
    if (this.hasAny(text, ["review", "audit", "pr", "pull request", "risk", "quality", "regression test"])) {
      return { requested, resolved: "review" as const };
    }
    if (this.hasAny(text, ["docs", "documentation", "readme", "guide", "setup", "reference", "protocol"])) {
      return { requested, resolved: "docs" as const };
    }
    if (this.hasAny(text, ["plan", "roadmap", "design", "architecture", "prioritize", "strategy", "decide"])) {
      return { requested, resolved: "planning" as const };
    }
    if (this.hasAny(text, ["code", "implement", "build", "feature", "refactor", "test", "api", "component", "typescript"])) {
      return { requested, resolved: "coding" as const };
    }
    return { requested, resolved: "auto" as const };
  }

  private effectiveIncludes(input: ContextPackInput, preset: ContextPackPreset): ContextPackIncludes {
    return {
      includeRecentSessions: input.includeRecentSessions ?? preset.defaultIncludes.includeRecentSessions,
      includeMistakes: input.includeMistakes ?? preset.defaultIncludes.includeMistakes,
      includeAdrs: input.includeAdrs ?? preset.defaultIncludes.includeAdrs,
      includeRunbooks: input.includeRunbooks ?? preset.defaultIncludes.includeRunbooks,
    };
  }

  private boostedTypes(preset: ContextPackPreset) {
    return Object.entries(preset.typeWeights)
      .filter(([, weight]) => weight > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([type, weight]) => ({ type, weight }));
  }

  private uniqueTerms(terms: string[]) {
    return this.uniqueStrings(terms.map((term) => term.toLowerCase().trim()).filter((term) => term.length > 1));
  }

  private uniqueStrings(values: string[]) {
    return [...new Set(values.filter((value) => value.length > 0))];
  }

  private hasAny(text: string, terms: string[]) {
    return terms.some((term) => text.includes(term));
  }

  private compactRecord(record: Awaited<ReturnType<MemoryQueryService["snapshotIndex"]>>[number], score: number) {
    return {
      path: record.path,
      title: record.title,
      type: record.type,
      score,
      tags: record.tags.slice(0, 6),
      updatedAt: record.updatedAt,
      usage: this.usage.statsFor(record.path),
      excerpt: this.truncate(record.excerpt, record.type === "session-log" ? 180 : 260),
    };
  }

  private truncate(value: string, maxLength: number) {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
  }
}
