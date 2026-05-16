import {
  checkboxList,
  frontmatter,
  markdownList,
  slugify,
  todayIso,
  TYPE_FOLDERS,
} from "../utils/memory-format.js";

export interface ConfidenceLogEntry {
  claim: string;
  statedConfidence: "high" | "medium" | "low" | "guess";
  actualResult: string;
  lesson: string;
}

export interface SessionLogTemplateInput {
  date?: string;
  topic: string;
  agent: string;
  durationMinutes?: number;
  outcomes?: string[];
  filesTouched?: string[];
  decisionsMade?: string[];
  openFollowUps?: string[];
  references?: string[];
  confidenceLog?: ConfidenceLogEntry[];
  verification?: string;
}

export class MemoryTemplateService {
  sessionLogPath(input: SessionLogTemplateInput) {
    const date = input.date ?? todayIso();
    return `${TYPE_FOLDERS["session-log"]}/${date}-${slugify(input.topic)}.md`;
  }

  sessionLog(input: SessionLogTemplateInput) {
    const date = input.date ?? todayIso();
    const outcomes = input.outcomes ?? [];
    const filesTouched = input.filesTouched ?? [];
    const decisionsMade = input.decisionsMade ?? [];
    const openFollowUps = input.openFollowUps ?? [];
    const references = input.references ?? [];
    const confidenceLog = input.confidenceLog ?? [];

    return frontmatter({
      title: `${date} - ${input.topic}`,
      type: "session-log",
      "session-date": date,
      agent: input.agent,
      "duration-minutes": input.durationMinutes,
      outcomes,
      created: date,
      updated: date,
      tags: ["session-log", "project/general"],
    }) + [
      `# ${date} - ${input.topic}`,
      "",
      "## TL;DR",
      markdownList(outcomes),
      "",
      "## Goal",
      input.topic,
      "",
      "## What Was Done",
      markdownList(outcomes),
      "",
      "## Files Touched",
      markdownList(filesTouched),
      "",
      "## Decisions Made",
      markdownList(decisionsMade),
      "",
      "## Open Follow-ups",
      checkboxList(openFollowUps),
      "",
      "## References",
      markdownList(references),
      "",
      "## Verification",
      input.verification ?? "Not recorded",
      "",
      "## Confidence Log",
      "| Claim / Question | Confidence Stated | Actual Result | Lesson |",
      "|---|---|---|---|",
      ...(
        confidenceLog.length
          ? confidenceLog.map((item) => `| ${item.claim} | ${item.statedConfidence} | ${item.actualResult} | ${item.lesson} |`)
          : ["| None | n/a | n/a | n/a |"]
      ),
      "",
    ].join("\n");
  }

  insight(title: string, content: string, confidence: string, derivedFrom: string[], tags: string[]) {
    const date = todayIso();
    return frontmatter({
      title,
      type: "insight",
      "derived-from": derivedFrom,
      confidence,
      status: "active",
      created: date,
      updated: date,
      tags,
    }) + `${content.trim()}\n`;
  }

  mistake(input: {
    title: string;
    area: string;
    severity: string;
    occurredDate: string;
    agent: string;
    confidence: string;
    problem: string;
    rootCause: string;
    avoidance: string;
    references: string[];
  }) {
    return frontmatter({
      title: input.title,
      type: "mistake",
      severity: input.severity,
      status: "open",
      "occurred-date": input.occurredDate,
      agent: input.agent,
      area: input.area,
      confidence: input.confidence,
      created: input.occurredDate,
      updated: input.occurredDate,
      tags: [`area/${input.area}`, "topic/memory-vault"],
    }) + [
      "## Problem",
      input.problem,
      "",
      "## Root Cause",
      input.rootCause,
      "",
      "## Avoidance",
      input.avoidance,
      "",
      "## References",
      markdownList(input.references),
      "",
    ].join("\n");
  }

  adr(input: {
    title: string;
    status: string;
    decisionDate: string;
    confidence: string;
    context: string;
    decision: string;
    consequences: string[];
    supersedes: string[];
    tags: string[];
  }) {
    return frontmatter({
      title: input.title,
      type: "adr",
      status: input.status,
      "decision-date": input.decisionDate,
      confidence: input.confidence,
      supersedes: input.supersedes,
      created: input.decisionDate,
      updated: input.decisionDate,
      tags: input.tags,
    }) + [
      "## Context",
      input.context,
      "",
      "## Decision",
      input.decision,
      "",
      "## Consequences",
      markdownList(input.consequences),
      "",
    ].join("\n");
  }

  fromTemplate(template: string, values: Record<string, unknown>) {
    const title = String(values.title ?? values.name ?? "Untitled");
    const date = String(values.date ?? todayIso());
    const content = String(values.content ?? "");

    if (template === "session-log") {
      return this.sessionLog({
        date,
        topic: title,
        agent: String(values.agent ?? "agent"),
        outcomes: [],
      });
    }

    return frontmatter({
      title,
      type: template,
      created: date,
      updated: date,
      tags: [],
    }) + `${content}\n`;
  }
}
