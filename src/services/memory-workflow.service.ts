import type { AuditService } from "./audit.service.js";
import type { MemoryCompactionService } from "./memory-compaction.service.js";
import type { MemoryQueryService } from "./memory-query.service.js";
import type { MemoryTemplateService, SessionLogTemplateInput } from "./memory-template.service.js";
import type { MemoryUsageService } from "./memory-usage.service.js";
import type { NoteService } from "./note.service.js";
import type { VaultHealthService } from "./vault-health.service.js";
import type { VaultService } from "./vault.service.js";

interface ContextPackInput {
  query?: string;
  taskArea?: string;
  maxItems: number;
  maxChars: number;
  includeRecentSessions: boolean;
  includeMistakes: boolean;
  includeAdrs: boolean;
  includeRunbooks: boolean;
}

interface SessionEndWorkflowInput extends SessionLogTemplateInput {
  autoCompact?: boolean;
  verify?: boolean;
}

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
  ) {}

  async sessionStart(input: { taskArea?: string; recentLimit: number; maxItems: number; maxChars: number }) {
    const contextPack = await this.contextPack({
      query: input.taskArea,
      taskArea: input.taskArea,
      maxItems: input.maxItems,
      maxChars: input.maxChars,
      includeRecentSessions: true,
      includeMistakes: true,
      includeAdrs: true,
      includeRunbooks: true,
    });
    const coreFiles = ["AGENTS.md", "AGENT-IDENTITY.md", "00_Index/MOC-Home.md", "00_Index/Goals.md", "00_Index/Open-Followups.md"];

    return {
      vaultRoot: this.vault.vaultRoot,
      files: contextPack.totalIndexed,
      coreFiles: coreFiles.map((path) => ({ path, exists: this.vault.exists(path) })),
      contextPack,
      recommendedReads: this.recommendedReads(input.taskArea),
    };
  }

  async contextPack(input: ContextPackInput) {
    const records = await this.query.snapshotIndex();
    const queryTerms = this.queryTerms(input.query, input.taskArea);
    const scored = records
      .filter((record) => this.shouldInclude(record.type, input))
      .map((record) => ({
        record,
        score: this.scoreRecord(record, queryTerms),
      }))
      .filter((item) => item.score > 0 || queryTerms.length === 0)
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
      retrievalRules: [
        "Use contextPack first; call memory_get only for selected paths that need full body.",
        "Prefer ADRs, runbooks, open mistakes, and recent sessions over broad vault reads.",
        "Promote repeated session lessons into insights instead of re-reading old logs.",
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
    };
  }

  private recommendedReads(taskArea?: string) {
    const common = ["AGENTS.md", "00_Index/Retrieval-Protocol.md", "00_Index/MOC-Home.md", "AGENT-IDENTITY.md", "00_Index/Goals.md"];
    if (!taskArea) return common;

    const area = taskArea.toLowerCase();
    if (area.includes("db") || area.includes("migration")) return [...common, "09_Runbooks/Runbook-DB-Migration.md", "04_Architecture_Decisions/"];
    if (area.includes("api")) return [...common, "02_API_Docs/", "09_Runbooks/"];
    if (area.includes("deploy") || area.includes("prod")) return [...common, "09_Runbooks/Runbook-Deploy-Safety-Checklist.md"];
    if (area.includes("memory") || area.includes("mcp")) return [...common, "07_Insights/Memory-Vault-Principles.md", "00_Index/Vault-Dashboard.md"];
    return common;
  }

  private nextActions(errors: number, warnings: number, openMistakes: number) {
    const actions = [];
    if (errors > 0) actions.push("Fix vault errors before relying on memory.");
    if (warnings > 0) actions.push("Review warnings and decide whether to clean them now or log follow-ups.");
    if (openMistakes > 0) actions.push("Read matching mistake notes before risky work.");
    if (actions.length === 0) actions.push("Memory is ready; retrieve the task-specific cluster before coding.");
    return actions;
  }

  private shouldInclude(type: string, input: ContextPackInput) {
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

  private scoreRecord(record: Awaited<ReturnType<MemoryQueryService["snapshotIndex"]>>[number], terms: string[]) {
    let score = 0;
    const haystack = `${record.path} ${record.title} ${record.type} ${record.tags.join(" ")} ${record.aliases.join(" ")} ${record.excerpt}`.toLowerCase();
    for (const term of terms) {
      if (record.title.toLowerCase().includes(term)) score += 8;
      if (record.path.toLowerCase().includes(term)) score += 6;
      if (record.tags.some((tag) => tag.toLowerCase().includes(term))) score += 5;
      if (haystack.includes(term)) score += 3;
    }
    score += this.typeWeight(record.type);
    score += this.usage.scoreBoost(record.path, terms);
    if (record.type === "mistake" && !haystack.includes("resolved")) score += 5;
    if (record.type === "adr" && !haystack.includes("superseded")) score += 4;
    return score;
  }

  private typeWeight(type: string) {
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
    return weights[type] ?? 1;
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
