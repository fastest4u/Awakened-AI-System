import { basename } from "node:path";
import { frontmatter, markdownList, slugify, todayIso } from "../utils/memory-format.js";
import type { MemoryQueryService } from "./memory-query.service.js";
import type { NoteService } from "./note.service.js";

export interface CompactVaultOptions {
  fromFolder: string;
  targetFolder: string;
  maxSessions: number;
  minSessions: number;
  dryRun: boolean;
}

interface ExtractedSession {
  path: string;
  title: string;
  outcomes: string[];
  decisions: string[];
  followUps: string[];
  confidenceLessons: string[];
  verification: string[];
}

export class MemoryCompactionService {
  constructor(
    private readonly query: MemoryQueryService,
    private readonly notes: NoteService,
  ) {}

  async compact(options: CompactVaultOptions) {
    const sessions = await this.query.recent([options.fromFolder], ["session-log"], "updated", options.maxSessions);
    const extracted: ExtractedSession[] = [];
    for (const session of sessions) {
      const note = await this.query.get(session.path);
      extracted.push(this.extractSession(session.path, String(note.frontmatter.title ?? session.title), note.body));
    }

    const digest = this.buildDigest(extracted);
    const targetPath = `${options.targetFolder}/Auto-Memory-Digest.md`;
    const shouldWrite = extracted.length >= options.minSessions && !options.dryRun;
    const savedPath = shouldWrite ? this.notes.create(targetPath, digest.content, true) : null;

    return {
      compacted: shouldWrite,
      path: savedPath,
      promotedNotes: savedPath ? [savedPath] : [],
      candidateSessions: sessions,
      sessionsRead: extracted.length,
      extracted: digest.counts,
      preview: options.dryRun ? digest.content : undefined,
      recommendation: extracted.length < options.minSessions
        ? `Need at least ${options.minSessions} session log(s) before compaction.`
        : "Review Auto-Memory-Digest.md and promote stable decisions into ADRs when they become architectural.",
    };
  }

  private extractSession(path: string, title: string, body: string): ExtractedSession {
    return {
      path,
      title,
      outcomes: this.sectionList(body, ["TL;DR", "What Was Done"]).slice(0, 8),
      decisions: this.sectionList(body, ["Decisions Made"]).slice(0, 8),
      followUps: this.sectionList(body, ["Open Follow-ups"]).slice(0, 8),
      confidenceLessons: this.confidenceLessons(body).slice(0, 6),
      verification: this.sectionText(body, "Verification").slice(0, 3),
    };
  }

  private buildDigest(sessions: ExtractedSession[]) {
    const date = todayIso();
    const sourcePaths = sessions.map((session) => session.path);
    const outcomes = this.unique(sessions.flatMap((session) => session.outcomes)).slice(0, 30);
    const decisions = this.unique(sessions.flatMap((session) => session.decisions)).slice(0, 30);
    const followUps = this.unique(sessions.flatMap((session) => session.followUps)).slice(0, 30);
    const confidenceLessons = this.unique(sessions.flatMap((session) => session.confidenceLessons)).slice(0, 20);
    const verification = this.unique(sessions.flatMap((session) => session.verification)).slice(0, 20);

    const content = frontmatter({
      title: "Auto Memory Digest",
      type: "insight",
      "derived-from": sourcePaths,
      confidence: "medium",
      status: "active",
      created: date,
      updated: date,
      tags: ["digest", "auto-compact", "project/general"],
    }) + [
      "# Auto Memory Digest",
      "",
      `Generated: ${date}`,
      "",
      "> [!important]",
      "> This note is generated from recent session logs. Keep durable architectural choices in ADRs and keep repeated lessons here or in dedicated insight notes.",
      "",
      "## High-Signal Outcomes",
      markdownList(outcomes),
      "",
      "## Decisions To Remember",
      markdownList(decisions),
      "",
      "## Open Follow-ups",
      this.checkboxList(followUps),
      "",
      "## Confidence Lessons",
      markdownList(confidenceLessons),
      "",
      "## Verification Evidence",
      markdownList(verification),
      "",
      "## Source Sessions",
      markdownList(sourcePaths.map((path) => `[[${path.replace(/\.md$/i, "")}|${basename(path)}]]`)),
      "",
    ].join("\n");

    return {
      content,
      counts: {
        outcomes: outcomes.length,
        decisions: decisions.length,
        followUps: followUps.length,
        confidenceLessons: confidenceLessons.length,
        verification: verification.length,
      },
    };
  }

  private sectionList(body: string, headings: string[]) {
    return headings.flatMap((heading) => this.sectionText(body, heading))
      .flatMap((line) => line.split(/\r?\n/))
      .map((line) => line.replace(/^\s*[-*]\s+\[[ xX]\]\s+/, "").replace(/^\s*[-*]\s+/, "").trim())
      .filter((line) => line.length > 0 && line.toLowerCase() !== "none");
  }

  private sectionText(body: string, heading: string) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "gim");
    const matches = Array.from(body.matchAll(pattern));
    return matches.map((match) => match[1].trim()).filter(Boolean);
  }

  private confidenceLessons(body: string) {
    const table = this.sectionText(body, "Confidence Log").join("\n");
    return table
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("|") && !line.includes("---") && !line.includes("Claim / Question"))
      .map((line) => line.split("|").map((cell) => cell.trim()).filter(Boolean))
      .filter((cells) => cells.length >= 4 && cells[0].toLowerCase() !== "none")
      .map((cells) => `${cells[0]} -> ${cells[3]}`);
  }

  private checkboxList(items: string[]) {
    return items.length ? items.map((item) => `- [ ] ${item}`).join("\n") : "- [ ] None";
  }

  private unique(items: string[]) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
      const normalized = item.replace(/\s+/g, " ").trim();
      const key = slugify(normalized);
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
    return result;
  }
}
