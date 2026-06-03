import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  buildNoteContent,
  parseFrontmatter,
  type FrontmatterDiagnostic,
  type FrontmatterSeverity,
} from "../utils/frontmatter.js";
import {
  defaultFrontmatterPolicy,
  isSemanticFrontmatterExempt,
  type FrontmatterPolicy,
} from "../config/vault-policy.js";
import {
  canonicalizeFrontmatter,
  defaultFrontmatterSchema,
  validateFrontmatter,
  FRONTMATTER_SCHEMA_VERSION,
  type FrontmatterSchema,
} from "../utils/frontmatter-schema.js";
import { basenameWithoutExtension, inferTypeFromPath, todayIso } from "../utils/memory-format.js";
import type { VaultService } from "./vault.service.js";

const ROOT_META_BASENAMES = ["README", "AGENTS", "AGENT-IDENTITY"];
const CANONICALIZE_FIX_CODES = new Set(["FIELD_ALIASED", "DATE_NORMALIZED", "TAGS_COERCED"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface FileFrontmatterReport {
  path: string;
  hasFrontmatter: boolean;
  blocked: boolean;
  autoFixableCount: number;
  diagnostics: FrontmatterDiagnostic[];
}

export interface ValidationSummary {
  vaultRoot: string;
  filesScanned: number;
  validFiles: number;
  filesWithIssues: number;
  counts: Record<FrontmatterSeverity, number>;
  byCode: Record<string, number>;
  autoFixableFiles: number;
  blockedFiles: number;
  configSources: string[];
  files: FileFrontmatterReport[];
}

export interface FixOutcome {
  path: string;
  status: "fixed" | "would-fix" | "manual" | "skipped";
  reason?: string;
  appliedFixes: string[];
}

export interface FixSummary {
  vaultRoot: string;
  dryRun: boolean;
  unsafe: boolean;
  requiresConfirm: boolean;
  backupDir: string | null;
  scanned: number;
  changed: number;
  manual: number;
  results: FixOutcome[];
}

export interface RollbackOutcome {
  path: string;
  status: "restored" | "would-restore";
}

export interface RollbackSummary {
  vaultRoot: string;
  dryRun: boolean;
  backupDir: string | null;
  restored: number;
  results: RollbackOutcome[];
}

export interface MigrateOutcome extends FixOutcome {
  fromVersion: string;
  toVersion: string;
}

export interface MigrateSummary {
  vaultRoot: string;
  dryRun: boolean;
  backupDir: string | null;
  targetVersion: string;
  scanned: number;
  migrated: number;
  manual: number;
  results: MigrateOutcome[];
}

interface ScanResult {
  path: string;
  raw: string;
  body: string;
  eol: string;
  data: Record<string, unknown>;
  hasFrontmatter: boolean;
  hasCritical: boolean;
  isExempt: boolean;
  diagnostics: FrontmatterDiagnostic[];
}

/**
 * Frontmatter-focused operations shared by the MCP tools and the CLI: scan,
 * validate, safe auto-fix (with timestamped backups), migration, and report
 * rendering. The core parse/canonicalize/validate logic lives in utils so this
 * service stays a thin orchestration + IO layer.
 */
export class FrontmatterService {
  constructor(
    private readonly vault: VaultService,
    private readonly schema: FrontmatterSchema = defaultFrontmatterSchema(),
    private readonly configSources: string[] = [],
    private readonly policy: FrontmatterPolicy = defaultFrontmatterPolicy(),
  ) {}

  async validate(paths?: string[]): Promise<ValidationSummary> {
    const targets = await this.resolveTargets(paths);
    const counts: Record<FrontmatterSeverity, number> = { info: 0, warning: 0, error: 0, critical: 0 };
    const byCode: Record<string, number> = {};
    const files: FileFrontmatterReport[] = [];

    for (const relativePath of targets) {
      const scan = this.scanFile(relativePath);
      for (const diagnostic of scan.diagnostics) {
        counts[diagnostic.severity] += 1;
        byCode[diagnostic.code] = (byCode[diagnostic.code] ?? 0) + 1;
      }
      if (scan.diagnostics.length) {
        files.push({
          path: relativePath,
          hasFrontmatter: scan.hasFrontmatter,
          blocked: scan.hasCritical,
          autoFixableCount: scan.diagnostics.filter((diagnostic) => diagnostic.autoFixAvailable).length,
          diagnostics: scan.diagnostics,
        });
      }
    }

    return {
      vaultRoot: this.vault.vaultRoot,
      filesScanned: targets.length,
      validFiles: targets.length - files.length,
      filesWithIssues: files.length,
      counts,
      byCode,
      autoFixableFiles: files.filter((file) => file.autoFixableCount > 0 && !file.blocked).length,
      blockedFiles: files.filter((file) => file.blocked).length,
      configSources: this.configSources,
      files,
    };
  }

  async fix(options: { dryRun?: boolean; paths?: string[]; backup?: boolean; unsafe?: boolean; confirm?: boolean } = {}): Promise<FixSummary> {
    const dryRun = options.dryRun ?? true;
    const backup = options.backup ?? true;
    const unsafeRequested = options.unsafe ?? false;
    // Unsafe fixes require BOTH --unsafe and explicit --confirm.
    const unsafe = unsafeRequested && (options.confirm ?? false);
    const targets = await this.resolveTargets(options.paths);
    // Backups are mandatory for any real write; the `backup` flag is honored
    // only in that it cannot turn safety OFF (see writeNote). The directory is
    // created lazily on the first actual write so dry-runs leave no artifacts.
    void backup;
    let backupDir: string | null = null;
    const results: FixOutcome[] = [];

    for (const relativePath of targets) {
      const scan = this.scanFile(relativePath);
      const blockReason = this.rewriteBlockReason(scan);
      if (blockReason) {
        results.push({ path: relativePath, status: "manual", reason: blockReason, appliedFixes: [] });
        continue;
      }
      const { content, appliedFixes } = this.computeRewrite(scan, { unsafe });
      if (!appliedFixes.length || content === scan.raw) continue;
      if (!dryRun) {
        try {
          backupDir = this.writeNote(relativePath, scan.raw, content, backupDir);
        } catch (error) {
          results.push({ path: relativePath, status: "manual", reason: `Write failed: ${errorMessage(error)}`, appliedFixes: [] });
          continue;
        }
      }
      results.push({ path: relativePath, status: dryRun ? "would-fix" : "fixed", appliedFixes });
    }

    return {
      vaultRoot: this.vault.vaultRoot,
      dryRun,
      unsafe,
      requiresConfirm: unsafeRequested && !unsafe,
      backupDir,
      scanned: targets.length,
      changed: results.filter((result) => result.status === "fixed" || result.status === "would-fix").length,
      manual: results.filter((result) => result.status === "manual").length,
      results,
    };
  }

  /** Restore notes from a backup directory (default: the most recent one). */
  async rollback(options: { dryRun?: boolean; backupDir?: string } = {}): Promise<RollbackSummary> {
    const dryRun = options.dryRun ?? true;
    const backupsRoot = join(this.vault.vaultRoot, ".memory-mcp", "backups");
    const backupDir = options.backupDir ?? this.latestBackupDir(backupsRoot);
    const results: RollbackOutcome[] = [];
    if (!backupDir || !existsSync(backupDir)) {
      return { vaultRoot: this.vault.vaultRoot, dryRun, backupDir: null, restored: 0, results };
    }
    for (const absolute of this.listFilesRecursive(backupDir)) {
      const rel = relative(backupDir, absolute).replace(/\\/g, "/");
      if (!dryRun) {
        try {
          const target = this.vault.noteFullPath(rel);
          mkdirSync(dirname(target), { recursive: true });
          this.writeFileAtomic(target, readFileSync(absolute, "utf8"));
        } catch {
          // Skip a single un-restorable file rather than abort the whole
          // restore and leave the vault in a half-rolled-back state.
          continue;
        }
      }
      results.push({ path: rel, status: dryRun ? "would-restore" : "restored" });
    }
    return { vaultRoot: this.vault.vaultRoot, dryRun, backupDir, restored: results.length, results };
  }

  async migrate(options: { dryRun?: boolean; paths?: string[]; backup?: boolean } = {}): Promise<MigrateSummary> {
    const dryRun = options.dryRun ?? true;
    void (options.backup ?? true); // backups are mandatory on write; see writeNote.
    const targets = await this.resolveTargets(options.paths);
    let backupDir: string | null = null;
    const results: MigrateOutcome[] = [];

    for (const relativePath of targets) {
      const scan = this.scanFile(relativePath);
      const fromVersion = String(scan.data["schema-version"] ?? "0");
      if (scan.hasCritical) {
        results.push({ path: relativePath, status: "manual", reason: "Unparseable YAML; fix by hand.", appliedFixes: [], fromVersion, toVersion: fromVersion });
        continue;
      }
      if (scan.isExempt || fromVersion === FRONTMATTER_SCHEMA_VERSION) continue;
      // Migration only stamps notes that already declare frontmatter. It must
      // NOT invent a block (title/created) for a body-only note — that would
      // persist guessed data. Adding frontmatter is the `fix` command's job.
      if (!scan.hasFrontmatter) {
        results.push({
          path: relativePath,
          status: "skipped",
          reason: "No frontmatter; migration does not fabricate one. Run `fix` to add it.",
          appliedFixes: [],
          fromVersion,
          toVersion: fromVersion,
        });
        continue;
      }
      const blockReason = this.rewriteBlockReason(scan);
      if (blockReason) {
        results.push({ path: relativePath, status: "manual", reason: blockReason, appliedFixes: [], fromVersion, toVersion: fromVersion });
        continue;
      }
      const { content, appliedFixes } = this.computeRewrite(scan, { stampVersion: true });
      if (content === scan.raw) continue;
      if (!dryRun) {
        try {
          backupDir = this.writeNote(relativePath, scan.raw, content, backupDir);
        } catch (error) {
          results.push({ path: relativePath, status: "manual", reason: `Write failed: ${errorMessage(error)}`, appliedFixes: [], fromVersion, toVersion: fromVersion });
          continue;
        }
      }
      results.push({
        path: relativePath,
        status: dryRun ? "would-fix" : "fixed",
        appliedFixes: [...appliedFixes, "STAMP_SCHEMA_VERSION"],
        fromVersion,
        toVersion: FRONTMATTER_SCHEMA_VERSION,
      });
    }

    return {
      vaultRoot: this.vault.vaultRoot,
      dryRun,
      backupDir,
      targetVersion: FRONTMATTER_SCHEMA_VERSION,
      scanned: targets.length,
      migrated: results.filter((result) => result.status === "fixed" || result.status === "would-fix").length,
      manual: results.filter((result) => result.status === "manual").length,
      results,
    };
  }

  report(summary: ValidationSummary, format: "text" | "json" | "markdown" = "text"): string {
    if (format === "json") return JSON.stringify(summary, null, 2);
    if (format === "markdown") return this.renderMarkdown(summary);
    return this.renderText(summary);
  }

  /** Render a migration summary. JSON is machine-readable; text is human-readable. */
  reportMigrate(summary: MigrateSummary, format: "text" | "json" | "markdown" = "text"): string {
    if (format === "json") return JSON.stringify(summary, null, 2);
    const lines: string[] = [];
    lines.push(`Frontmatter migration for ${summary.vaultRoot}`);
    lines.push(`Target schema-version: ${summary.targetVersion} | ${summary.dryRun ? "DRY-RUN (no files written)" : "APPLIED"}`);
    lines.push(`Scanned: ${summary.scanned} | ${summary.dryRun ? "would migrate" : "migrated"}: ${summary.migrated} | manual: ${summary.manual}`);
    if (summary.backupDir) lines.push(`Backup: ${summary.backupDir}`);
    lines.push("");
    for (const result of summary.results) {
      lines.push(`  [${result.status}] ${result.path} (${result.fromVersion} → ${result.toVersion})${result.reason ? ` — ${result.reason}` : ""}`);
    }
    if (!summary.results.length) lines.push("Nothing to migrate; all notes are already current.");
    return lines.join("\n");
  }

  private scanFile(relativePath: string): ScanResult {
    const raw = this.vault.readRaw(relativePath);
    const parsed = parseFrontmatter(raw);
    const isExempt = this.isExempt(relativePath);
    const semanticExempt = this.isSemanticExempt(relativePath);
    const { data, changes } = semanticExempt
      ? { data: parsed.data, changes: [] }
      : canonicalizeFrontmatter(parsed.data, this.schema);
    const hasCritical = parsed.diagnostics.some((diagnostic) => diagnostic.severity === "critical");
    const validation = hasCritical || semanticExempt
      ? []
      : validateFrontmatter(data, {
          type: inferTypeFromPath(relativePath),
          path: relativePath,
          hasFrontmatter: parsed.hasFrontmatter,
          isExempt,
        }, this.schema);
    return {
      path: relativePath,
      raw,
      body: parsed.body,
      eol: parsed.eol,
      data,
      hasFrontmatter: parsed.hasFrontmatter,
      hasCritical,
      isExempt,
      diagnostics: [...parsed.diagnostics, ...changes, ...validation],
    };
  }

  private computeRewrite(scan: ScanResult, options: { stampVersion?: boolean; unsafe?: boolean } = {}): { content: string; appliedFixes: string[] } {
    const applied = new Set<string>();
    const data: Record<string, unknown> = { ...scan.data };
    const today = todayIso();

    for (const diagnostic of scan.diagnostics) {
      if (CANONICALIZE_FIX_CODES.has(diagnostic.code)) applied.add(diagnostic.code);
      if (diagnostic.code === "FRONTMATTER_BOM" || diagnostic.code === "FRONTMATTER_NOT_AT_START") applied.add(diagnostic.code);
      if (diagnostic.code === "MISSING_REQUIRED_FIELD" && diagnostic.autoFixAvailable && diagnostic.field) {
        const field = diagnostic.field;
        if (data[field] === undefined || data[field] === "") {
          data[field] = this.defaultForField(field, data, scan.path, today);
          applied.add(`FILL_${field}`);
        }
      }
    }

    if (!scan.hasFrontmatter && !scan.isExempt) {
      data.title = data.title ?? this.inferTitle(scan);
      data.type = data.type ?? inferTypeFromPath(scan.path);
      data.created = data.created ?? today;
      data.updated = data.updated ?? today;
      applied.add("ADD_FRONTMATTER");
    }

    if (options.unsafe) {
      const currentType = data.type;
      if (currentType === undefined || !this.schema.validTypes.includes(String(currentType))) {
        data.type = inferTypeFromPath(scan.path);
        applied.add("INFER_TYPE");
      }
      if (this.schema.strictUnknownFields) {
        const known = new Set<string>([...this.schema.keyOrder, ...(this.schema.requiredFieldsByType[String(data.type)] ?? [])]);
        for (const key of Object.keys(data)) {
          if (!known.has(key)) {
            delete data[key];
            applied.add(`DROP_${key}`);
          }
        }
      }
    }

    if (options.stampVersion) {
      data["schema-version"] = FRONTMATTER_SCHEMA_VERSION;
    }

    const content = buildNoteContent(data, scan.body, this.schema.keyOrder, scan.eol);
    return { content, appliedFixes: [...applied] };
  }

  private latestBackupDir(backupsRoot: string): string | undefined {
    if (!existsSync(backupsRoot)) return undefined;
    const dirs = readdirSync(backupsRoot)
      .map((name) => join(backupsRoot, name))
      .filter((full) => {
        try {
          return statSync(full).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
    return dirs.length ? dirs[dirs.length - 1] : undefined;
  }

  private listFilesRecursive(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...this.listFilesRecursive(full));
      else out.push(full);
    }
    return out;
  }

  private defaultForField(field: string, data: Record<string, unknown>, path: string, today: string): unknown {
    switch (field) {
      case "created":
        return data.updated ?? today;
      case "updated":
        return data.created ?? today;
      case "status":
        return inferTypeFromPath(path) === "mistake" ? "open" : "active";
      case "schema-version":
        return FRONTMATTER_SCHEMA_VERSION;
      default:
        return today;
    }
  }

  private inferTitle(scan: ScanResult): string {
    const heading = scan.body.match(/^#\s+(.+)$/m);
    if (heading) return heading[1].trim();
    return basenameWithoutExtension(scan.path).replace(/[-_]+/g, " ").trim() || "Untitled";
  }

  private isExempt(path: string): boolean {
    if (this.isSemanticExempt(path)) return true;
    const base = basenameWithoutExtension(path);
    return ROOT_META_BASENAMES.includes(base) && !path.includes("/");
  }

  private isSemanticExempt(path: string): boolean {
    return isSemanticFrontmatterExempt(path, this.policy.semanticExemptPaths);
  }

  private async resolveTargets(paths?: string[]): Promise<string[]> {
    if (paths && paths.length) return paths.map((path) => path.replace(/\\/g, "/"));
    const files = await this.vault.listMarkdownFiles();
    return files.map((file) => this.vault.relativePath(file));
  }

  private makeBackupDir(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(this.vault.vaultRoot, ".memory-mcp", "backups", stamp);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Back up the original (verified) then atomically write the new content.
   * Returns the backup directory used, creating it lazily on first call so a
   * run that ends up writing nothing leaves no empty backup folder. A backup is
   * ALWAYS taken before a destructive write — there is no opt-out.
   */
  private writeNote(relativePath: string, originalRaw: string, content: string, backupDir: string | null): string {
    const dir = backupDir ?? this.makeBackupDir();
    this.backupFileVerified(relativePath, originalRaw, dir);
    this.writeFileAtomic(this.vault.noteFullPath(relativePath), content);
    return dir;
  }

  /** Write the backup copy, then read it back and assert it is intact. */
  private backupFileVerified(relativePath: string, raw: string, backupDir: string): void {
    const dest = join(backupDir, relativePath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, raw, "utf8");
    if (readFileSync(dest, "utf8") !== raw) {
      throw new Error(`Backup verification failed for ${relativePath}; refusing to overwrite the original.`);
    }
  }

  /** Atomic write: stage to a temp file in the same dir, then rename over the target. */
  private writeFileAtomic(fullPath: string, content: string): void {
    const tmp = `${fullPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, fullPath);
  }

  /** Reason a note must not be auto-rewritten (returns null when it is safe). */
  private rewriteBlockReason(scan: ScanResult): string | null {
    if (scan.hasCritical) return "Unparseable YAML; fix by hand.";
    if (scan.diagnostics.some((diagnostic) => diagnostic.code === "FRONTMATTER_MULTIPLE_BLOCKS")) {
      return "Multiple frontmatter blocks; merge into one by hand before auto-fixing.";
    }
    return null;
  }

  private renderText(summary: ValidationSummary): string {
    const lines: string[] = [];
    lines.push(`Frontmatter validation for ${summary.vaultRoot}`);
    lines.push(`Files scanned: ${summary.filesScanned} | valid: ${summary.validFiles} | with issues: ${summary.filesWithIssues}`);
    lines.push(
      `Severity: ${summary.counts.critical} critical, ${summary.counts.error} error, ${summary.counts.warning} warning, ${summary.counts.info} info`,
    );
    lines.push(`Auto-fixable files: ${summary.autoFixableFiles} | blocked (manual): ${summary.blockedFiles}`);
    if (summary.configSources.length) lines.push(`Config: ${summary.configSources.join(", ")}`);
    lines.push("");
    for (const file of summary.files) {
      lines.push(`• ${file.path}${file.blocked ? " [BLOCKED]" : ""}`);
      for (const diagnostic of file.diagnostics) {
        const where = diagnostic.line ? `:${diagnostic.line}` : "";
        const fixable = diagnostic.autoFixAvailable ? " (auto-fixable)" : "";
        lines.push(`    [${diagnostic.severity}] ${diagnostic.code}${where} — ${diagnostic.message}${fixable}`);
      }
    }
    if (!summary.files.length) lines.push("No frontmatter issues found.");
    return lines.join("\n");
  }

  private renderMarkdown(summary: ValidationSummary): string {
    const lines: string[] = [];
    lines.push(`# Frontmatter Validation Report`);
    lines.push("");
    lines.push(`- **Vault:** \`${summary.vaultRoot}\``);
    lines.push(`- **Files scanned:** ${summary.filesScanned}`);
    lines.push(`- **Valid files:** ${summary.validFiles}`);
    lines.push(`- **Files with issues:** ${summary.filesWithIssues}`);
    lines.push(
      `- **Severity:** ${summary.counts.critical} critical / ${summary.counts.error} error / ${summary.counts.warning} warning / ${summary.counts.info} info`,
    );
    lines.push(`- **Auto-fixable files:** ${summary.autoFixableFiles}`);
    lines.push(`- **Blocked (manual):** ${summary.blockedFiles}`);
    if (summary.configSources.length) lines.push(`- **Config sources:** ${summary.configSources.map((source) => `\`${source}\``).join(", ")}`);
    lines.push("");
    if (!summary.files.length) {
      lines.push("No frontmatter issues found.");
      return lines.join("\n");
    }
    lines.push("| File | Severity | Code | Line | Message | Auto-fix |");
    lines.push("|---|---|---|---|---|---|");
    for (const file of summary.files) {
      for (const diagnostic of file.diagnostics) {
        lines.push(
          `| \`${file.path}\` | ${diagnostic.severity} | ${diagnostic.code} | ${diagnostic.line ?? ""} | ${diagnostic.message.replace(/\|/g, "\\|")} | ${diagnostic.autoFixAvailable ? "yes" : "no"} |`,
        );
      }
    }
    return lines.join("\n");
  }
}
