import { basename } from "node:path";
import {
  defaultFrontmatterPolicy,
  isSemanticFrontmatterExempt,
  type FrontmatterPolicy,
} from "../config/vault-policy.js";
import type { FrontmatterDiagnostic } from "../utils/frontmatter.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { canonicalizeFrontmatter, validateFrontmatter } from "../utils/frontmatter-schema.js";
import { buildWikilinkResolver, extractWikilinks } from "../utils/links.js";
import { asStringArray, basenameWithoutExtension, inferTypeFromPath } from "../utils/memory-format.js";
import { charNgrams } from "../utils/ngram.js";
import type { VaultService } from "./vault.service.js";

export interface VaultIssue {
  severity: FrontmatterDiagnostic["severity"];
  code: string;
  message: string;
  path?: string;
  line?: number;
  field?: string;
  suggestion?: string;
  autoFixAvailable?: boolean;
}

/** Which per-note checks `verifyNote` runs; every flag defaults to true. */
export interface VerifyNoteOptions {
  checkLinks?: boolean;
  checkFrontmatter?: boolean;
  checkStaleness?: boolean;
}

interface NoteHealthRecord {
  path: string;
  base: string;
  raw: string;
  body: string;
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown> | null;
  diagnostics: FrontmatterDiagnostic[];
}

const PLACEHOLDER_LINKS = new Set([
  "Note Name",
  "Note",
  "X",
  "Wikilinks",
  "06_Sources/...",
  "ADR-NNN",
  "ADR-NNN-...",
  "Mistake-NNN",
  "Mistake-NNN-...",
  "YYYY-MM-DD-...",
  "YYYY-MM-DD-session",
  "Runbook-NNN",
  "Template-NNN",
  "Insight title",
  "source",
]);

export class VaultHealthService {
  constructor(
    private readonly vault: VaultService,
    private readonly policy: FrontmatterPolicy = defaultFrontmatterPolicy(),
  ) {}

  async verifyVault(options: { includeWarnings?: boolean; minScore?: number } = {}) {
    const notes = await this.readNotes();
    const issues = this.collectIssues(notes);
    const blocking = (severity: VaultIssue["severity"]) => severity === "error" || severity === "critical";
    const visibleIssues = options.includeWarnings === false
      ? issues.filter((issue) => blocking(issue.severity))
      : issues.filter((issue) => issue.severity !== "info");
    const score = this.score(notes, issues);

    return {
      vaultRoot: this.vault.vaultRoot,
      filesScanned: notes.length,
      score,
      grade: this.grade(score),
      ok: issues.every((issue) => !blocking(issue.severity)) && (options.minScore === undefined || score >= options.minScore),
      criticals: issues.filter((issue) => issue.severity === "critical").length,
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
      issues: visibleIssues,
    };
  }

  async verifyNote(reference: string, options: VerifyNoteOptions = {}) {
    const { checkFrontmatter = true, checkLinks = true, checkStaleness = true } = options;
    const notes = await this.readNotes();
    const note = notes.find((item) => item.path === reference || item.base === basenameWithoutExtension(reference));
    if (!note) {
      return {
        valid: false,
        issues: [{ severity: "error", code: "NOT_FOUND", message: "Note not found", path: reference }] satisfies VaultIssue[],
      };
    }

    // Scoped to the one note: its frontmatter, its outgoing links (resolved
    // against a vault-wide map built once), and its staleness — not a
    // full-vault verification filtered down to one path.
    const issues: VaultIssue[] = [];
    if (!this.isSemanticExempt(note.path)) {
      if (checkFrontmatter) issues.push(...this.collectNoteFrontmatterIssues(note));
      if (checkLinks) issues.push(...this.collectNoteBrokenLinks(note, this.buildLinkResolver(notes)));
    }
    if (checkStaleness) issues.push(...this.collectNoteStalenessIssues(note));
    return {
      valid: issues.every((issue) => issue.severity !== "error" && issue.severity !== "critical"),
      issues,
    };
  }

  async findBrokenLinks(folders: string[] = [], limit = 100) {
    const notes = await this.readNotes();
    return this.collectBrokenLinks(notes)
      .filter((issue) => folders.length === 0 || folders.some((folder) => issue.path?.includes(folder)))
      .slice(0, limit);
  }

  async findDuplicates(similarityThreshold = 0.85) {
    const notes = await this.readNotes();
    const byBase = new Map<string, string[]>();
    const byTitle = new Map<string, string[]>();
    const titled: Array<{ path: string; title: string }> = [];

    for (const note of notes) {
      if (!["readme", "index", "_index"].includes(note.base.toLowerCase())) {
        this.pushMap(byBase, note.base.toLowerCase(), note.path);
      }
      const title = note.frontmatter?.title;
      if (title) {
        this.pushMap(byTitle, String(title).toLowerCase(), note.path);
        titled.push({ path: note.path, title: String(title) });
      }
    }

    // Near-duplicate titles: frequency-aware Dice over character bigrams, so
    // "Deploy Runbook" vs "Deploy Runbooks" registers while unrelated titles
    // stay far below any sensible threshold. Exact (case-insensitive) matches
    // are already reported under duplicateTitles, so they are skipped here.
    const similarTitles: Array<{ paths: string[]; titles: string[]; similarity: number }> = [];
    for (let i = 0; i < titled.length; i += 1) {
      for (let j = i + 1; j < titled.length; j += 1) {
        const a = titled[i];
        const b = titled[j];
        if (a.title.toLowerCase() === b.title.toLowerCase()) continue;
        const similarity = this.titleSimilarity(a.title.toLowerCase(), b.title.toLowerCase());
        if (similarity >= similarityThreshold) {
          similarTitles.push({
            paths: [a.path, b.path],
            titles: [a.title, b.title],
            similarity: Math.round(similarity * 1000) / 1000,
          });
        }
      }
    }

    return {
      duplicateBasenames: [...byBase.entries()].filter(([, paths]) => paths.length > 1).map(([name, paths]) => ({ name, paths })),
      duplicateTitles: [...byTitle.entries()].filter(([, paths]) => paths.length > 1).map(([title, paths]) => ({ title, paths })),
      similarTitles,
    };
  }

  /** Dice coefficient over character-bigram multisets of two (lowercased) titles. */
  private titleSimilarity(a: string, b: string) {
    if (a === b) return 1;
    const gramsA = charNgrams(a, 2, 2);
    const gramsB = charNgrams(b, 2, 2);
    if (gramsA.length === 0 || gramsB.length === 0) return 0;
    const counts = new Map<string, number>();
    for (const gram of gramsA) counts.set(gram, (counts.get(gram) ?? 0) + 1);
    let overlap = 0;
    for (const gram of gramsB) {
      const remaining = counts.get(gram) ?? 0;
      if (remaining > 0) {
        overlap += 1;
        counts.set(gram, remaining - 1);
      }
    }
    return (2 * overlap) / (gramsA.length + gramsB.length);
  }

  async checkStaleness(folders: string[] = [], olderThanDays = 90) {
    const notes = await this.readNotes();
    const stale = [];
    for (const note of notes) {
      if (folders.length && !folders.some((folder) => note.path.includes(folder))) continue;
      const updated = this.parseDate(note.frontmatter?.updated);
      const verified = this.parseDate(note.frontmatter?.["last-verified"]);
      if (updated && this.ageDays(updated) > olderThanDays) {
        stale.push({ path: note.path, field: "updated", value: updated.toISOString().slice(0, 10), ageDays: this.ageDays(updated) });
      }
      if (verified && this.ageDays(verified) > olderThanDays) {
        stale.push({ path: note.path, field: "last-verified", value: verified.toISOString().slice(0, 10), ageDays: this.ageDays(verified) });
      }
    }
    return stale;
  }

  async verifySourceTruth(reference: string, claimsOnly: boolean) {
    const notes = await this.readNotes();
    const note = notes.find((item) => item.path === reference || item.base === basenameWithoutExtension(reference));
    if (!note) {
      return { verified: false, claims: [], issues: [{ severity: "error", code: "NOT_FOUND", message: "Note not found", path: reference }] satisfies VaultIssue[] };
    }

    const required = ["source", "last-verified", "verified-by", "confidence"];
    const missing = required.filter((field) => !note.frontmatter?.[field]);
    const claims = claimsOnly ? this.extractClaimLines(note.body) : [];
    return {
      verified: missing.length === 0,
      claims,
      issues: missing.map((field) => ({
        severity: "warning" as const,
        code: "MISSING_TRUTH_FIELD",
        message: `Missing truth-maintenance field: ${field}`,
        path: note.path,
      })),
    };
  }

  async readNotes(): Promise<NoteHealthRecord[]> {
    const files = await this.vault.listMarkdownFiles();
    return files.map((file) => {
      const path = this.vault.relativePath(file);
      const raw = this.vault.readRaw(path);
      const parsed = parseFrontmatter(raw);
      const { data, changes } = canonicalizeFrontmatter(parsed.data);
      return {
        path,
        base: basename(file, ".md"),
        raw,
        body: parsed.body,
        hasFrontmatter: parsed.hasFrontmatter,
        frontmatter: parsed.hasFrontmatter ? data : null,
        diagnostics: [...parsed.diagnostics, ...changes],
      };
    });
  }

  private collectIssues(notes: NoteHealthRecord[]) {
    const issues: VaultIssue[] = [];
    for (const note of notes) {
      if (this.isSemanticExempt(note.path)) continue;
      issues.push(...this.collectNoteFrontmatterIssues(note));
    }
    issues.push(...this.collectBrokenLinks(notes));
    issues.push(...this.collectDuplicateIssues(notes));
    return issues;
  }

  /** Structural + schema frontmatter issues for ONE note. */
  private collectNoteFrontmatterIssues(note: NoteHealthRecord): VaultIssue[] {
    const issues: VaultIssue[] = [];
    const isRootMeta = ["README", "AGENTS", "AGENT-IDENTITY"].includes(note.base) && !note.path.includes("/");

    // Structural parse diagnostics (unclosed / duplicate-key / unquoted colon)
    // are surfaced directly with their line numbers and suggestions.
    const hasCritical = note.diagnostics.some((diagnostic) => diagnostic.severity === "critical");
    for (const diagnostic of note.diagnostics) {
      if (diagnostic.severity === "info") continue;
      issues.push(this.toIssue(diagnostic, note.path));
    }

    // A file we cannot parse cannot be schema-validated meaningfully; skip the
    // required-field checks so one YAML error does not cascade into noise.
    if (hasCritical) return issues;

    const validationDiagnostics = validateFrontmatter(note.frontmatter ?? {}, {
      type: inferTypeFromPath(note.path),
      path: note.path,
      hasFrontmatter: note.hasFrontmatter,
      isExempt: isRootMeta,
    });
    for (const diagnostic of validationDiagnostics) {
      if (diagnostic.severity === "info") continue;
      issues.push(this.toIssue(diagnostic, note.path));
    }
    return issues;
  }

  private toIssue(diagnostic: FrontmatterDiagnostic, path: string): VaultIssue {
    return {
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      path,
      line: diagnostic.line,
      field: diagnostic.field,
      suggestion: diagnostic.suggestion,
      autoFixAvailable: diagnostic.autoFixAvailable,
    };
  }

  private collectBrokenLinks(notes: NoteHealthRecord[]) {
    const resolveLink = this.buildLinkResolver(notes);
    const issues: VaultIssue[] = [];
    for (const note of notes) {
      if (this.isSemanticExempt(note.path)) continue;
      issues.push(...this.collectNoteBrokenLinks(note, resolveLink));
    }
    return issues;
  }

  /**
   * Vault-wide wikilink resolver with the shared index semantics
   * (path/basename > title/id > aliases, case-insensitive, lexicographic
   * tie-break), so this scan can never disagree with the backlink graph.
   */
  private buildLinkResolver(notes: NoteHealthRecord[]) {
    return buildWikilinkResolver(notes.map((note) => ({
      path: note.path,
      title: note.frontmatter?.title === undefined ? undefined : String(note.frontmatter.title),
      id: note.frontmatter?.id === undefined ? undefined : String(note.frontmatter.id),
      aliases: asStringArray(note.frontmatter?.aliases),
    })));
  }

  /**
   * Broken outgoing wikilinks for ONE note. Targets resolve by full title (no
   * " - " truncation), id, alias, basename, or vault-relative path — so a
   * path-style link to a missing note is now flagged instead of skipped.
   */
  private collectNoteBrokenLinks(note: NoteHealthRecord, resolveLink: (target: string) => string | undefined): VaultIssue[] {
    const issues: VaultIssue[] = [];
    for (const link of this.findWikilinks(note.raw)) {
      if (resolveLink(link)) continue;
      if (PLACEHOLDER_LINKS.has(link)) continue;
      if (/^(ADR|Mistake|YYYY-MM-DD|G-NNN|Runbook-NNN|Template-NNN|NNN)/.test(link)) continue;
      issues.push({ severity: "warning", code: "BROKEN_WIKILINK", message: `Broken wikilink: [[${link}]]`, path: note.path });
    }
    return issues;
  }

  /** Staleness of ONE note's `updated` / `last-verified` dates, as advisory issues. */
  private collectNoteStalenessIssues(note: NoteHealthRecord, olderThanDays = 90): VaultIssue[] {
    const issues: VaultIssue[] = [];
    for (const field of ["updated", "last-verified"] as const) {
      const date = this.parseDate(note.frontmatter?.[field]);
      if (!date) continue;
      const ageDays = this.ageDays(date);
      if (ageDays <= olderThanDays) continue;
      issues.push({
        severity: "warning",
        code: "STALE_NOTE",
        message: `'${field}' is ${ageDays} days old (older than ${olderThanDays} days)`,
        path: note.path,
        field,
        suggestion: "Re-verify the note's content and refresh its date fields.",
      });
    }
    return issues;
  }

  private collectDuplicateIssues(notes: NoteHealthRecord[]) {
    const issues: VaultIssue[] = [];
    const duplicates = new Map<string, string[]>();
    for (const note of notes) {
      if (["readme", "index", "_index"].includes(note.base.toLowerCase())) continue;
      this.pushMap(duplicates, note.base.toLowerCase(), note.path);
    }
    for (const [name, paths] of duplicates.entries()) {
      if (paths.length > 1) {
        for (const path of paths) issues.push({ severity: "warning", code: "DUPLICATE_BASENAME", message: `Duplicate filename base: ${name}`, path });
      }
    }
    return issues;
  }

  private score(notes: NoteHealthRecord[], issues: VaultIssue[]) {
    const uncheckedFollowUps = notes.reduce((sum, note) => sum + note.body.split(/\r?\n/).filter((line) => /^\s*-\s+\[\s\]\s+/.test(line)).length, 0);
    const openMistakes = notes.filter((note) => note.frontmatter?.type === "mistake" && String(note.frontmatter.status ?? "open") === "open").length;
    const stale = notes.filter((note) => {
      const updated = this.parseDate(note.frontmatter?.updated);
      return updated && this.ageDays(updated) > 90;
    }).length;
    const deductions = issues.filter((issue) => issue.severity === "critical").length * 10
      + issues.filter((issue) => issue.severity === "error").length * 6
      + issues.filter((issue) => issue.severity === "warning").length * 2
      + Math.min(uncheckedFollowUps, 10)
      + Math.min(openMistakes, 5) * 2
      + Math.min(stale, 10) * 2;
    return Math.max(0, 100 - deductions);
  }

  private grade(score: number) {
    if (score >= 95) return "A";
    if (score >= 85) return "B";
    if (score >= 75) return "C";
    if (score >= 60) return "D";
    return "F";
  }

  private findWikilinks(content: string) {
    return extractWikilinks(content);
  }

  private extractClaimLines(content: string) {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("|"))
      .slice(0, 25);
  }

  private parseDate(value: unknown) {
    if (!value) return null;
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private ageDays(date: Date) {
    return Math.floor((Date.now() - date.getTime()) / 86400000);
  }

  private pushMap(map: Map<string, string[]>, key: string, value: string) {
    map.set(key, [...(map.get(key) ?? []), value]);
  }

  private isSemanticExempt(path: string) {
    return isSemanticFrontmatterExempt(path, this.policy.semanticExemptPaths);
  }
}
