import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionLogTemplateInput } from "./memory-template.service.js";

type LifecycleTool = "memory_sessionStart" | "memory_contextPack" | "memory_selfCheck" | "memory_sessionEnd";

interface LifecycleCounts {
  sessionStart: number;
  contextPack: number;
  selfCheck: number;
  sessionEnd: number;
}

interface LifecycleEvent {
  tool: LifecycleTool;
  at: string;
  details?: Record<string, unknown>;
}

interface LifecycleSession {
  id: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  taskArea?: string;
  topic?: string;
  startedBy: LifecycleTool;
  missingSessionStart?: boolean;
  counts: LifecycleCounts;
  events: LifecycleEvent[];
  lastQualityGate?: {
    ok: boolean;
    score: number;
    grade: string;
    warnings: string[];
  };
}

interface LifecycleState {
  version: 1;
  updatedAt: string;
  activeSession: LifecycleSession | null;
  recentSessions: LifecycleSession[];
}

interface VaultHealthSummary {
  ok: boolean;
  score: number;
  grade: string;
  errors: number;
  warnings: number;
}

interface QualityCheck {
  name: string;
  ok: boolean;
  weight: number;
  detail: string;
  requiredTool?: LifecycleTool;
}

const EMPTY_COUNTS: LifecycleCounts = {
  sessionStart: 0,
  contextPack: 0,
  selfCheck: 0,
  sessionEnd: 0,
};

export class MemoryLifecycleService {
  private readonly lifecyclePath: string;

  constructor(vaultRoot: string) {
    this.lifecyclePath = join(vaultRoot, ".memory-mcp", "lifecycle.json");
  }

  start(input: { taskArea?: string }) {
    const state = this.readState();
    const warnings: string[] = [];
    if (state.activeSession) {
      const abandoned = state.activeSession;
      abandoned.endedAt = new Date().toISOString();
      abandoned.lastQualityGate = {
        ok: false,
        score: 0,
        grade: "F",
        warnings: ["Lifecycle was replaced by a new memory_sessionStart before memory_sessionEnd."],
      };
      state.recentSessions = [abandoned, ...state.recentSessions].slice(0, 20);
      warnings.push("Previous memory lifecycle was still active and was archived before starting a new one.");
    }

    const session = this.createSession("memory_sessionStart", input.taskArea);
    session.missingSessionStart = false;
    session.counts.sessionStart += 1;
    this.appendEvent(session, "memory_sessionStart", { taskArea: input.taskArea });
    state.activeSession = session;
    this.writeState(state);

    return {
      session: this.publicSession(session),
      warnings,
    };
  }

  recordContextPack(input: { query?: string; taskArea?: string }) {
    const state = this.readState();
    const warnings: string[] = [];
    const session = state.activeSession ?? this.createImplicitSession("memory_contextPack", input.taskArea, warnings);
    session.taskArea = input.taskArea ?? session.taskArea;
    session.counts.contextPack += 1;
    this.appendEvent(session, "memory_contextPack", { query: input.query, taskArea: input.taskArea });
    state.activeSession = session;
    this.writeState(state);

    return {
      session: this.publicSession(session),
      warnings,
    };
  }

  recordSelfCheck(input: { task: string; area?: string; riskLevel: string }) {
    const state = this.readState();
    const warnings: string[] = [];
    const session = state.activeSession ?? this.createImplicitSession("memory_selfCheck", input.area, warnings);
    session.taskArea = input.area ?? session.taskArea;
    session.counts.selfCheck += 1;
    this.appendEvent(session, "memory_selfCheck", {
      task: input.task,
      area: input.area,
      riskLevel: input.riskLevel,
    });
    state.activeSession = session;
    this.writeState(state);

    return {
      session: this.publicSession(session),
      warnings,
    };
  }

  end(input: SessionLogTemplateInput & { verify?: boolean }, health: VaultHealthSummary | null) {
    const state = this.readState();
    const warnings: string[] = [];
    const session = state.activeSession ?? this.createImplicitSession("memory_sessionEnd", undefined, warnings);
    session.topic = input.topic;
    session.counts.sessionEnd += 1;
    session.endedAt = new Date().toISOString();
    this.appendEvent(session, "memory_sessionEnd", { topic: input.topic, verify: input.verify !== false });

    const qualityGate = this.qualityGate(session, input, health, warnings);
    session.lastQualityGate = {
      ok: qualityGate.ok,
      score: qualityGate.score,
      grade: qualityGate.grade,
      warnings: qualityGate.warnings,
    };

    state.activeSession = null;
    state.recentSessions = [session, ...state.recentSessions].slice(0, 20);
    this.writeState(state);

    return {
      session: this.publicSession(session),
      qualityGate,
      warnings: qualityGate.warnings,
    };
  }

  status(input: { includeHistory?: boolean }) {
    const state = this.readState();
    const active = state.activeSession ? this.publicSession(state.activeSession) : null;
    const recent = input.includeHistory
      ? state.recentSessions.map((session) => this.publicSession(session))
      : state.recentSessions.slice(0, 3).map((session) => this.publicSession(session));

    return {
      activeSession: active,
      recentSessions: recent,
      updatedAt: state.updatedAt,
      guidance: active
        ? this.activeGuidance(state.activeSession!)
        : ["No active memory lifecycle is recorded. Start work with memory_sessionStart."],
    };
  }

  private qualityGate(
    session: LifecycleSession,
    input: SessionLogTemplateInput & { verify?: boolean },
    health: VaultHealthSummary | null,
    lifecycleWarnings: string[],
  ) {
    const riskyWork = this.infersRisk(input);
    const checks: QualityCheck[] = [
      {
        name: "sessionStart recorded",
        ok: session.counts.sessionStart > 0 && !session.missingSessionStart,
        weight: 16,
        detail: "Every task should begin with memory_sessionStart.",
        requiredTool: "memory_sessionStart",
      },
      {
        name: "contextPack recorded",
        ok: session.counts.contextPack > 0,
        weight: 14,
        detail: "Each task should retrieve a task-specific memory_contextPack.",
        requiredTool: "memory_contextPack",
      },
      {
        name: "selfCheck for risky work",
        ok: !riskyWork || session.counts.selfCheck > 0,
        weight: riskyWork ? 12 : 0,
        detail: riskyWork
          ? "Risky, deployment-like, decision-heavy, or multi-file work needs memory_selfCheck."
          : "No risky-work signal was inferred from the session log input.",
        requiredTool: riskyWork ? "memory_selfCheck" : undefined,
      },
      {
        name: "outcomes recorded",
        ok: (input.outcomes?.length ?? 0) > 0,
        weight: 10,
        detail: "Session logs should include concrete outcomes.",
      },
      {
        name: "verification note recorded",
        ok: Boolean(input.verification?.trim()),
        weight: 8,
        detail: "Session logs should say what verification was run or why it was skipped.",
      },
      {
        name: "vault verification ran",
        ok: input.verify !== false && health !== null,
        weight: 10,
        detail: "End-of-task protocol expects vault verification after memory_sessionEnd.",
      },
      {
        name: "vault has no errors",
        ok: !health || health.errors === 0,
        weight: 12,
        detail: health ? `Vault health: ${health.errors} errors, ${health.warnings} warnings.` : "Vault health was not checked.",
      },
      {
        name: "vault warnings reviewed",
        ok: !health || health.warnings === 0,
        weight: health?.warnings ? Math.min(8, health.warnings * 2) : 0,
        detail: health ? `Vault grade ${health.grade} with score ${health.score}.` : "Vault health was not checked.",
      },
    ];

    const score = Math.max(0, 100 - checks.filter((check) => !check.ok).reduce((sum, check) => sum + check.weight, 0));
    const missingRequiredSteps = checks
      .filter((check) => !check.ok && check.requiredTool)
      .map((check) => check.requiredTool as LifecycleTool);
    const warnings = [
      ...lifecycleWarnings,
      ...checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`),
    ];

    return {
      ok: missingRequiredSteps.length === 0 && score >= 85 && health !== null && health.errors === 0,
      score,
      grade: this.grade(score),
      riskyWork,
      missingRequiredSteps,
      warnings,
      checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })),
      session: this.publicSession(session),
      followUpsRecorded: input.openFollowUps?.length ?? 0,
      recommendedNextActions: this.recommendedNextActions(missingRequiredSteps, warnings, health),
    };
  }

  private activeGuidance(session: LifecycleSession) {
    const guidance = [];
    if (session.counts.sessionStart === 0 || session.missingSessionStart) guidance.push("Run memory_sessionStart before continuing.");
    if (session.counts.contextPack === 0) guidance.push("Run memory_contextPack for the current task.");
    if (session.counts.selfCheck === 0) guidance.push("Run memory_selfCheck before risky, multi-file, deployment, or schema work.");
    guidance.push("Finish meaningful work with memory_sessionEnd and verify the returned qualityGate.");
    return guidance;
  }

  private recommendedNextActions(missingRequiredSteps: LifecycleTool[], warnings: string[], health: VaultHealthSummary | null) {
    const actions = [];
    if (missingRequiredSteps.includes("memory_sessionStart")) actions.push("Start the next task with memory_sessionStart before any other tool.");
    if (missingRequiredSteps.includes("memory_contextPack")) actions.push("Retrieve a task-specific memory_contextPack before making changes.");
    if (missingRequiredSteps.includes("memory_selfCheck")) actions.push("Run memory_selfCheck before risky or multi-file work.");
    if (warnings.some((warning) => warning.includes("verification note"))) actions.push("Record the concrete build, test, or manual verification result in sessionEnd.verification.");
    if (warnings.some((warning) => warning.includes("vault verification ran"))) actions.push("Run memory_verifyVault or end with verify enabled before considering the session complete.");
    if (health && health.warnings > 0) actions.push("Review vault warnings or create explicit follow-ups for deferred cleanup.");
    if (actions.length === 0) actions.push("Lifecycle quality gate passed; continue with normal memory hygiene.");
    return actions;
  }

  private infersRisk(input: SessionLogTemplateInput) {
    const text = [
      input.topic,
      ...(input.outcomes ?? []),
      ...(input.decisionsMade ?? []),
      ...(input.openFollowUps ?? []),
      ...(input.filesTouched ?? []),
    ].join(" ").toLowerCase();

    return (input.filesTouched?.length ?? 0) > 1
      || /\b(deploy|production|prod|migration|schema|database|security|secret|auth|payment|multi-file|refactor)\b/.test(text);
  }

  private createImplicitSession(tool: LifecycleTool, taskArea: string | undefined, warnings: string[]) {
    const session = this.createSession(tool, taskArea);
    session.missingSessionStart = true;
    warnings.push(`No active memory lifecycle was recorded before ${tool}; created an implicit lifecycle for diagnostics.`);
    return session;
  }

  private createSession(startedBy: LifecycleTool, taskArea?: string): LifecycleSession {
    const now = new Date().toISOString();
    return {
      id: `memory-${Date.now()}`,
      startedAt: now,
      updatedAt: now,
      taskArea,
      startedBy,
      counts: { ...EMPTY_COUNTS },
      events: [],
    };
  }

  private appendEvent(session: LifecycleSession, tool: LifecycleTool, details?: Record<string, unknown>) {
    session.updatedAt = new Date().toISOString();
    session.events = [...session.events, { tool, at: session.updatedAt, details }].slice(-30);
  }

  private publicSession(session: LifecycleSession) {
    return {
      id: session.id,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      endedAt: session.endedAt,
      taskArea: session.taskArea,
      topic: session.topic,
      startedBy: session.startedBy,
      missingSessionStart: Boolean(session.missingSessionStart),
      counts: session.counts,
      lastQualityGate: session.lastQualityGate,
    };
  }

  private readState(): LifecycleState {
    if (!existsSync(this.lifecyclePath)) return this.emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.lifecyclePath, "utf8")) as Partial<LifecycleState>;
      return {
        version: 1,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        activeSession: parsed.activeSession ?? null,
        recentSessions: parsed.recentSessions ?? [],
      };
    } catch {
      return this.emptyState();
    }
  }

  private writeState(state: LifecycleState) {
    state.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.lifecyclePath), { recursive: true });
    writeFileSync(this.lifecyclePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private emptyState(): LifecycleState {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      activeSession: null,
      recentSessions: [],
    };
  }

  private grade(score: number) {
    if (score >= 95) return "A";
    if (score >= 85) return "B";
    if (score >= 75) return "C";
    if (score >= 60) return "D";
    return "F";
  }
}
