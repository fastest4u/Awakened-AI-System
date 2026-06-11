import { statSync } from "node:fs";
import { basename } from "node:path";
import { asStringArray, inferTypeFromPath } from "../utils/memory-format.js";
import type { VaultService } from "./vault.service.js";

type FollowUpMode = "auto" | "coding" | "debugging" | "review" | "deploy" | "planning" | "docs";

interface FollowUpRadarInput {
  query?: string;
  taskArea?: string;
  mode?: FollowUpMode;
  folders?: string[];
  limit: number;
}

interface FollowUpCandidate {
  path: string;
  title: string;
  type: string;
  tags: string[];
  updatedAt: string;
  line: number;
  section?: string;
  text: string;
  source: "checkbox" | "follow-up-section";
}

/** Cached per-file extraction; valid while the file's mtime AND size match. */
interface CachedExtraction {
  mtimeMs: number;
  sizeBytes: number;
  candidates: FollowUpCandidate[];
}

const MODE_TERMS: Record<FollowUpMode, string[]> = {
  auto: [],
  coding: ["code", "implementation", "api", "component", "service", "schema", "test"],
  debugging: ["bug", "debug", "error", "failure", "exception", "regression", "fix"],
  review: ["review", "audit", "risk", "quality", "regression", "verification"],
  deploy: ["deploy", "production", "prod", "release", "rollback", "migration", "database"],
  planning: ["plan", "roadmap", "design", "architecture", "prioritize", "decision", "followup", "follow-up"],
  docs: ["docs", "documentation", "readme", "guide", "setup", "reference", "protocol"],
};

const MODE_WEIGHTS: Record<FollowUpMode, Record<string, number>> = {
  auto: {},
  coding: { "session-log": 3, adr: 2, runbook: 2, component: 2 },
  debugging: { mistake: 5, "session-log": 4, runbook: 2 },
  review: { rules: 4, mistake: 4, adr: 3, "session-log": 2 },
  deploy: { runbook: 5, mistake: 4, adr: 3, "session-log": 2 },
  planning: { goals: 5, insight: 4, index: 3, dashboard: 2, "session-log": 2 },
  docs: { reference: 5, rules: 4, index: 3, runbook: 2 },
};

/**
 * Auto-mode inference keywords, checked in order (kept aligned with the
 * context-pack presets). English keywords match whole tokens only (so "pr" no
 * longer matches "project", nor "prod" "product"); Thai keywords and
 * multi-word phrases match as substrings because Thai is written without word
 * separators.
 */
const MODE_KEYWORDS: Array<{ mode: Exclude<FollowUpMode, "auto">; keywords: string[] }> = [
  { mode: "deploy", keywords: ["deploy", "production", "prod", "release", "rollback", "migration", "database", "schema", "ดีพลอย", "ปล่อย", "รีลีส"] },
  { mode: "debugging", keywords: ["debug", "bug", "error", "exception", "failure", "failing", "regression", "broken", "fix", "ดีบัก", "แก้บั๊ก", "บั๊ก"] },
  { mode: "review", keywords: ["review", "audit", "pr", "pull request", "risk", "quality", "regression test", "รีวิว", "ตรวจโค้ด"] },
  { mode: "docs", keywords: ["docs", "documentation", "readme", "guide", "setup", "reference", "protocol", "เอกสาร"] },
  { mode: "planning", keywords: ["plan", "roadmap", "design", "architecture", "prioritize", "strategy", "decide", "วางแผน", "แผน"] },
  { mode: "coding", keywords: ["code", "implement", "build", "feature", "refactor", "test", "api", "component", "typescript", "เขียนโค้ด", "พัฒนา"] },
];

export class MemoryFollowUpService {
  /** path -> cached follow-up extraction, so an unchanged file is not re-read
   *  and re-parsed on every radar call. */
  private readonly extractionCache = new Map<string, CachedExtraction>();

  constructor(private readonly vault: VaultService) {}

  async radar(input: FollowUpRadarInput) {
    const mode = this.resolveMode(input.mode, input.query, input.taskArea);
    const queryTerms = this.uniqueTerms(this.queryTerms(input.query, input.taskArea));
    const terms = this.uniqueTerms([...queryTerms, ...MODE_TERMS[mode.resolved]]);
    const { candidates, scannedFiles } = await this.extractCandidates(input.folders ?? []);
    const scored = candidates
      .map((candidate) => ({
        ...candidate,
        score: this.score(candidate, terms, mode.resolved),
        matchedTerms: this.matchedTerms(candidate, terms),
      }))
      .sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)));

    // With terms, an item matching NO term ranks strictly below every termed
    // match (base score alone admitted everything before). Only user-supplied
    // query/taskArea terms may empty the result so the "none matched" guidance
    // can fire; MODE_TERMS alone are for scoring/ordering, so an explicit mode
    // without a query must still surface every open follow-up.
    let ordered = scored;
    if (terms.length > 0) {
      const matched = scored.filter((candidate) => candidate.matchedTerms.length > 0);
      const unmatched = scored.filter((candidate) => candidate.matchedTerms.length === 0);
      ordered = matched.length === 0 && queryTerms.length > 0 ? [] : [...matched, ...unmatched];
    }

    const followUps = ordered.slice(0, input.limit).map((candidate) => ({
      path: candidate.path,
      title: candidate.title,
      type: candidate.type,
      line: candidate.line,
      section: candidate.section,
      text: candidate.text,
      source: candidate.source,
      score: candidate.score,
      matchedTerms: candidate.matchedTerms,
      updatedAt: candidate.updatedAt,
    }));

    return {
      query: input.query,
      taskArea: input.taskArea,
      mode: {
        requested: mode.requested,
        resolved: mode.resolved,
        inferred: mode.requested === "auto" && mode.resolved !== "auto",
      },
      scannedFiles,
      totalOpen: candidates.length,
      returned: followUps.length,
      followUps,
      recommendedActions: this.recommendedActions(followUps.length, candidates.length),
    };
  }

  async compact(input: FollowUpRadarInput) {
    const result = await this.radar(input);
    return {
      ...result,
      followUps: result.followUps.slice(0, Math.min(input.limit, 8)),
    };
  }

  private async extractCandidates(folders: string[]) {
    const files = await this.vault.listMarkdownFiles();
    const candidates: FollowUpCandidate[] = [];
    const seen = new Set<string>();
    let scannedFiles = 0;

    for (const file of files) {
      const path = this.vault.relativePath(file);
      seen.add(path);
      if (folders.length > 0 && !folders.some((folder) => this.matchesFolder(path, folder))) continue;
      scannedFiles += 1;
      candidates.push(...this.extractFile(file, path));
    }

    // Drop cache entries for files no longer in the vault.
    for (const path of this.extractionCache.keys()) {
      if (!seen.has(path)) this.extractionCache.delete(path);
    }

    return { candidates: this.dedupe(candidates), scannedFiles };
  }

  /** Follow-up candidates for one file, served from the mtime+size cache when
   *  the file is unchanged (mtime AND size, so a same-millisecond rewrite is
   *  still caught). Cached entries are never mutated by callers. */
  private extractFile(fullPath: string, path: string): FollowUpCandidate[] {
    const stat = this.statOf(fullPath);
    const cached = this.extractionCache.get(path);
    if (cached && stat && cached.mtimeMs === stat.mtimeMs && cached.sizeBytes === stat.sizeBytes) {
      return cached.candidates;
    }

    let extracted: FollowUpCandidate[];
    try {
      const note = this.vault.load(path);
      const title = String(note.parsed.data.title ?? basename(fullPath, ".md"));
      const type = String(note.parsed.data.type ?? inferTypeFromPath(path));
      const tags = asStringArray(note.parsed.data.tags);
      const updatedAt = String(note.parsed.data.updated ?? note.parsed.data["session-date"] ?? note.parsed.data.created ?? "");
      extracted = this.extractFromBody(note.parsed.content, { path, title, type, tags, updatedAt });
    } catch {
      // Transiently unreadable (deleted/locked between enumeration and read):
      // fall back to the stale cached extraction rather than failing the radar.
      return cached ? cached.candidates : [];
    }

    if (stat) this.extractionCache.set(path, { ...stat, candidates: extracted });
    return extracted;
  }

  private statOf(fullPath: string): { mtimeMs: number; sizeBytes: number } | undefined {
    try {
      const stat = statSync(fullPath);
      return { mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
    } catch {
      return undefined;
    }
  }

  private extractFromBody(body: string, metadata: Omit<FollowUpCandidate, "line" | "section" | "text" | "source">) {
    const candidates: FollowUpCandidate[] = [];
    const lines = body.split(/\r?\n/);
    let section: string | undefined;
    let inFollowUpSection = false;

    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index] ?? "";
      const heading = rawLine.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (heading) {
        section = heading[2]?.trim();
        inFollowUpSection = this.isFollowUpHeading(section);
        continue;
      }

      const checkbox = rawLine.match(/^\s*[-*]\s+\[\s\]\s+(.+?)\s*$/);
      if (checkbox?.[1]) {
        candidates.push({
          ...metadata,
          line: index + 1,
          section,
          text: this.cleanText(checkbox[1]),
          source: "checkbox",
        });
        continue;
      }

      if (!inFollowUpSection) continue;
      const bullet = rawLine.match(/^\s*[-*]\s+(?!\[[xX]\])(.+?)\s*$/);
      if (!bullet?.[1]) continue;
      const text = this.cleanText(bullet[1]);
      if (text.length === 0 || /^none$/i.test(text) || /^n\/a$/i.test(text)) continue;
      candidates.push({
        ...metadata,
        line: index + 1,
        section,
        text,
        source: "follow-up-section",
      });
    }

    return candidates;
  }

  private score(candidate: FollowUpCandidate, terms: string[], mode: FollowUpMode) {
    const haystack = this.haystack(candidate);
    let score = candidate.source === "follow-up-section" ? 8 : 5;
    if (candidate.path.includes("Open-Followups")) score += 8;
    if (candidate.section && this.isFollowUpHeading(candidate.section)) score += 5;
    score += MODE_WEIGHTS[mode][candidate.type] ?? 0;
    score += this.recencyBoost(candidate.updatedAt);

    for (const term of terms) {
      if (candidate.text.toLowerCase().includes(term)) score += 8;
      if (candidate.title.toLowerCase().includes(term)) score += 5;
      if (candidate.path.toLowerCase().includes(term)) score += 4;
      if (candidate.tags.some((tag) => tag.toLowerCase().includes(term))) score += 3;
      if (haystack.includes(term)) score += 1;
    }

    return Math.round(score * 10) / 10;
  }

  private matchedTerms(candidate: FollowUpCandidate, terms: string[]) {
    const haystack = this.haystack(candidate);
    return terms.filter((term) => haystack.includes(term)).slice(0, 12);
  }

  private resolveMode(mode: FollowUpMode | undefined, query?: string, taskArea?: string): { requested: FollowUpMode; resolved: FollowUpMode } {
    const requested = mode ?? "auto";
    if (requested !== "auto") return { requested, resolved: requested };

    const text = `${query ?? ""} ${taskArea ?? ""}`.toLowerCase();
    const tokens = new Set(text.split(/[^a-z0-9ก-๙_-]+/i).filter(Boolean));
    // Kebab/snake slugs ("deploy-pipeline") also contribute their fragments so
    // single-word keywords match; the full token is kept for exact matches.
    for (const token of [...tokens]) {
      for (const fragment of token.split(/[-_]/)) {
        if (fragment.length > 0) tokens.add(fragment);
      }
    }
    for (const candidate of MODE_KEYWORDS) {
      if (candidate.keywords.some((keyword) => this.matchesKeyword(tokens, text, keyword))) {
        return { requested, resolved: candidate.mode };
      }
    }
    return { requested, resolved: "auto" };
  }

  /** Thai keywords and multi-word phrases cannot be token-matched (Thai has no
   *  word separators), so they fall back to substring matching on the raw text. */
  private matchesKeyword(tokens: Set<string>, text: string, keyword: string) {
    if (keyword.includes(" ") || /[ก-๙]/.test(keyword)) return text.includes(keyword);
    return tokens.has(keyword);
  }

  private recommendedActions(returned: number, totalOpen: number) {
    if (totalOpen === 0) return ["No open follow-ups found in the scanned scope."];
    if (returned === 0) return ["Open follow-ups exist, but none matched the current query strongly; broaden query or folders if needed."];
    return [
      "Review relevant follow-ups before making new changes.",
      "Carry unresolved items into memory_sessionEnd.openFollowUps if they remain open.",
    ];
  }

  private dedupe(candidates: FollowUpCandidate[]) {
    const seen = new Set<string>();
    const deduped: FollowUpCandidate[] = [];
    for (const candidate of candidates) {
      const key = `${candidate.path}:${candidate.line}:${candidate.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(candidate);
    }
    return deduped;
  }

  private matchesFolder(path: string, folder: string) {
    const normalized = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return normalized.length === 0 || path === normalized || path.startsWith(`${normalized}/`);
  }

  private isFollowUpHeading(value?: string) {
    if (!value) return false;
    return /follow[- ]?ups?|next actions?|open items?|todo|tasks?/i.test(value);
  }

  private cleanText(value: string) {
    return value
      .replace(/^\[\s\]\s+/, "")
      .replace(/\s+#\w[\w/-]*/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private queryTerms(query?: string, taskArea?: string) {
    return `${query ?? ""} ${taskArea ?? ""}`
      .toLowerCase()
      .split(/[^\p{L}0-9_-]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length > 1);
  }

  private uniqueTerms(terms: string[]) {
    return [...new Set(terms.map((term) => term.toLowerCase().trim()).filter((term) => term.length > 1))];
  }

  private haystack(candidate: FollowUpCandidate) {
    return `${candidate.text} ${candidate.path} ${candidate.title} ${candidate.type} ${candidate.tags.join(" ")} ${candidate.section ?? ""}`.toLowerCase();
  }

  private recencyBoost(value: string) {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return 0;
    const ageDays = (Date.now() - timestamp) / 86_400_000;
    if (ageDays <= 1) return 4;
    if (ageDays <= 7) return 2;
    if (ageDays <= 30) return 1;
    return 0;
  }
}
