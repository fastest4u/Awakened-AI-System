import { basename } from "node:path";
import {
  defaultFrontmatterPolicy,
  isSemanticFrontmatterExempt,
  type FrontmatterPolicy,
} from "../config/vault-policy.js";
import type { FrontmatterDiagnostic } from "../utils/frontmatter.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { canonicalizeFrontmatter, validateFrontmatter } from "../utils/frontmatter-schema.js";
import { asStringArray, basenameWithoutExtension, inferTypeFromPath } from "../utils/memory-format.js";
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

  async verifyNote(reference: string) {
    const notes = await this.readNotes();
    const note = notes.find((item) => item.path === reference || item.base === basenameWithoutExtension(reference));
    if (!note) {
      return {
        valid: false,
        issues: [{ severity: "error", code: "NOT_FOUND", message: "Note not found", path: reference }] satisfies VaultIssue[],
      };
    }

    const issues = this.collectIssues(notes).filter((issue) => issue.path === note.path);
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

  async findDuplicates() {
    const notes = await this.readNotes();
    const byBase = new Map<string, string[]>();
    const byTitle = new Map<string, string[]>();

    for (const note of notes) {
      if (!["readme", "index", "_index"].includes(note.base.toLowerCase())) {
        this.pushMap(byBase, note.base.toLowerCase(), note.path);
      }
      const title = note.frontmatter?.title;
      if (title) this.pushMap(byTitle, String(title).toLowerCase(), note.path);
    }

    return {
      duplicateBasenames: [...byBase.entries()].filter(([, paths]) => paths.length > 1).map(([name, paths]) => ({ name, paths })),
      duplicateTitles: [...byTitle.entries()].filter(([, paths]) => paths.length > 1).map(([title, paths]) => ({ title, paths })),
    };
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
      if (hasCritical) continue;

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
    }

    issues.push(...this.collectBrokenLinks(notes));
    issues.push(...this.collectDuplicateIssues(notes));
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
    const basenames = new Set(notes.map((note) => note.base));
    const titles = new Set<string>();
    const aliases = new Set<string>();

    for (const note of notes) {
      if (!note.frontmatter) continue;
      if (note.frontmatter.title) titles.add(String(note.frontmatter.title).split(" - ")[0].trim());
      for (const alias of asStringArray(note.frontmatter.aliases)) aliases.add(alias);
    }

    const issues: VaultIssue[] = [];
    for (const note of notes) {
      if (this.isSemanticExempt(note.path)) continue;
      for (const link of this.findWikilinks(note.raw)) {
        if (basenames.has(link) || titles.has(link) || aliases.has(link)) continue;
        if (PLACEHOLDER_LINKS.has(link)) continue;
        if (link.includes("/") || link.startsWith(".")) continue;
        if (/^(ADR|Mistake|YYYY-MM-DD|G-NNN|Runbook-NNN|Template-NNN|NNN)/.test(link)) continue;
        issues.push({ severity: "warning", code: "BROKEN_WIKILINK", message: `Broken wikilink: [[${link}]]`, path: note.path });
      }
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
    const links: string[] = [];
    for (const match of content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
      const target = match[1]?.trim();
      if (!target || target.endsWith("/")) continue;
      links.push(target.replace(/\.md$/i, ""));
    }
    return links;
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
