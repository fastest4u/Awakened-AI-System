import { basename } from "node:path";
import { frontmatter, markdownList, todayIso } from "../utils/memory-format.js";
import type { MemoryQueryService } from "./memory-query.service.js";
import type { NoteService } from "./note.service.js";

export interface CompactVaultOptions {
  fromFolder: string;
  targetFolder: string;
  maxSessions: number;
  minSessions: number;
  dryRun: boolean;
}

/** Max candidate paths echoed back in the result (paths only, no records/excerpts). */
const MAX_CANDIDATE_PATHS = 30;

interface ExtractedSession {
  path: string;
  title: string;
  outcomes: string[];
  decisions: string[];
  followUps: string[];
  confidenceLessons: string[];
  verification: string[];
}

interface FollowUpEntry {
  text: string;
  source: string;
}

export class MemoryCompactionService {
  constructor(
    private readonly query: MemoryQueryService,
    private readonly notes: NoteService,
  ) {}

  async compact(options: CompactVaultOptions) {
    // One index pass with bodies attached. The old recent() + per-session
    // get() loop re-snapshotted the whole index once per session log.
    const sessions = await this.query.search(
      "",
      [],
      options.fromFolder,
      "session-log",
      options.maxSessions,
      0,
      false,
      { sortBy: "updatedAt", includeBody: true },
    );
    const extracted: ExtractedSession[] = sessions.map((session) =>
      this.extractSession(session.path, session.title, session.body ?? ""));

    const targetPath = `${options.targetFolder}/Auto-Memory-Digest.md`;
    const digest = this.buildDigest(extracted, await this.existingCreated(targetPath));
    const shouldWrite = extracted.length >= options.minSessions && !options.dryRun;
    const savedPath = shouldWrite ? this.notes.create(targetPath, digest.content, true) : null;

    return {
      compacted: shouldWrite,
      path: savedPath,
      promotedNotes: savedPath ? [savedPath] : [],
      // Paths only: full candidate records with excerpts cost thousands of
      // tokens per sessionEnd response without adding decision value.
      candidateCount: sessions.length,
      candidatePaths: sessions.slice(0, MAX_CANDIDATE_PATHS).map((session) => session.path),
      sessionsRead: extracted.length,
      extracted: digest.counts,
      preview: options.dryRun ? digest.content : undefined,
      recommendation: extracted.length < options.minSessions
        ? `Need at least ${options.minSessions} session log(s) before compaction.`
        : "Review Auto-Memory-Digest.md and promote stable decisions into ADRs when they become architectural.",
    };
  }

  /** created date of the existing digest note, so a rewrite never resets its
   *  recency (a fresh `created` every run kept the digest atop recency ranks). */
  private async existingCreated(targetPath: string): Promise<string | null> {
    try {
      const existing = await this.query.get(targetPath);
      const value = existing.frontmatter?.created;
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      const text = String(value ?? "").trim();
      return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
    } catch {
      return null;
    }
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

  private buildDigest(sessions: ExtractedSession[], existingCreated: string | null) {
    const date = todayIso();
    const sourcePaths = sessions.map((session) => session.path);
    const outcomes = this.unique(sessions.flatMap((session) => session.outcomes)).slice(0, 30);
    const decisions = this.unique(sessions.flatMap((session) => session.decisions)).slice(0, 30);
    const followUps = this.uniqueFollowUps(sessions).slice(0, 30);
    const confidenceLessons = this.unique(sessions.flatMap((session) => session.confidenceLessons)).slice(0, 20);
    const verification = this.unique(sessions.flatMap((session) => session.verification)).slice(0, 20);

    const content = frontmatter({
      title: "Auto Memory Digest",
      type: "insight",
      "derived-from": sourcePaths,
      confidence: "medium",
      status: "active",
      created: existingCreated ?? date,
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
      // Heading deliberately avoids the radar's follow-up patterns
      // (follow-up/next action/open item/todo/task): this is a read-only echo —
      // the live items stay tracked in the source session logs.
      "## Unresolved From Source Sessions",
      this.openFollowUpLines(followUps),
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

  /** Plain (non-checkbox) lines: a digest re-emitting open follow-ups as live
   *  `- [ ]` checkboxes duplicated every item into the follow-up radar. */
  private openFollowUpLines(entries: FollowUpEntry[]) {
    return entries.length
      ? entries
        .map((entry) => `- (open) ${entry.text} — [[${entry.source.replace(/\.md$/i, "")}|${basename(entry.source)}]]`)
        .join("\n")
      : "- None";
  }

  /** Follow-up texts deduped across sessions, each keeping its first source path. */
  private uniqueFollowUps(sessions: ExtractedSession[]): FollowUpEntry[] {
    const seen = new Set<string>();
    const result: FollowUpEntry[] = [];
    for (const session of sessions) {
      for (const raw of session.followUps) {
        const text = raw.replace(/\s+/g, " ").trim();
        if (!text) continue;
        const key = this.dedupeKey(text);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ text, source: session.path });
      }
    }
    return result;
  }

  private unique(items: string[]) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
      const normalized = item.replace(/\s+/g, " ").trim();
      if (!normalized) continue;
      const key = this.dedupeKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
    return result;
  }

  /** Unicode-safe dedupe key. slugify() strips every non-ASCII character, which
   *  collapsed all distinct Thai lessons into one "untitled" bucket. */
  private dedupeKey(value: string) {
    const key = value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "");
    return key || value;
  }
}
