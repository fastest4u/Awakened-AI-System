import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FrontmatterService } from "../src/services/frontmatter.service.js";
import { VaultService } from "../src/services/vault.service.js";

const GOOD = `---\ntitle: "Good"\ntype: session-log\nsession-date: "2026-06-01"\nagent: cascade\noutcomes:\n  - did a thing\ncreated: "2026-06-01"\nupdated: "2026-06-01"\ntags:\n  - session-log\n---\n\n# Good\n`;

// Insight missing the required derived-from + confidence fields (errors).
const MISSING = `---\ntitle: "Missing"\ntype: insight\ncreated: "2026-06-01"\nupdated: "2026-06-01"\n---\n\n# Missing\n`;

// snake_case alias + unquoted dates (coerced to Date by gray-matter) -> auto-fixable info.
const ALIAS = `---\ntitle: "Alias Note"\ntype: note\ncreated_at: 2026-01-02\nupdated: 2026-01-03\n---\n\n# Alias Note\n`;

// Unclosed frontmatter -> critical / blocked.
const UNCLOSED = `---\ntitle: Broken\ntype: note\n\n# Body\n`;

describe("FrontmatterService", () => {
  let root: string;
  let vault: VaultService;
  let service: FrontmatterService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fm-svc-"));
    mkdirSync(join(root, "05_Agent_Session_Logs"), { recursive: true });
    mkdirSync(join(root, "07_Insights"), { recursive: true });
    mkdirSync(join(root, "99_Templates"), { recursive: true });
    mkdirSync(join(root, "bad"), { recursive: true });
    writeFileSync(join(root, "05_Agent_Session_Logs", "good.md"), GOOD);
    writeFileSync(join(root, "07_Insights", "missing-fields.md"), MISSING);
    writeFileSync(join(root, "note-alias.md"), ALIAS);
    writeFileSync(
      join(root, "99_Templates", "Template-Daily-Note.md"),
      `---\ntitle: "<% tp.date.now(\\"YYYY-MM-DD\\") %>"\ntype: note\ncreated: "<% tp.date.now(\\"YYYY-MM-DD\\") %>"\nupdated: "<% tp.date.now(\\"YYYY-MM-DD\\") %>"\n---\n\n# Daily\n`,
    );
    writeFileSync(join(root, "bad", "unclosed.md"), UNCLOSED);
    vault = new VaultService(root);
    service = new FrontmatterService(vault);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("validate: counts severities and identifies blocked files", async () => {
    const summary = await service.validate();
    assert.equal(summary.filesScanned, 5);
    assert.equal(summary.filesWithIssues, 3); // good.md is clean
    assert.equal(summary.counts.critical, 1);
    assert.equal(summary.counts.error, 2); // insight missing derived-from + confidence
    assert.ok(summary.counts.info >= 3); // 1 alias + 2 date normalizations
    assert.equal(summary.blockedFiles, 1);
    assert.equal(summary.autoFixableFiles, 1); // only note-alias is safely fixable
  });

  it("validate: a clean note has no diagnostics", async () => {
    const summary = await service.validate(["05_Agent_Session_Logs/good.md"]);
    assert.equal(summary.filesWithIssues, 0);
  });

  it("validate: template placeholders are exempt from semantic date warnings", async () => {
    const summary = await service.validate(["99_Templates/Template-Daily-Note.md"]);
    assert.equal(summary.filesWithIssues, 0);
    assert.equal(summary.counts.warning, 0);
  });

  it("fix default: dry-runs rather than writing files", async () => {
    const before = readFileSync(join(root, "note-alias.md"), "utf8");
    const result = await service.fix();
    assert.equal(result.dryRun, true);
    assert.equal(result.backupDir, null);
    assert.ok(result.results.some((r) => r.path === "note-alias.md" && r.status === "would-fix"));
    assert.equal(readFileSync(join(root, "note-alias.md"), "utf8"), before);
  });

  it("fix dry-run: reports changes without touching files or creating backups", async () => {
    const before = readFileSync(join(root, "note-alias.md"), "utf8");
    const result = await service.fix({ dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.backupDir, null);
    assert.ok(result.results.some((r) => r.path === "note-alias.md" && r.status === "would-fix"));
    assert.ok(result.results.some((r) => r.path === "bad/unclosed.md" && r.status === "manual"));
    assert.equal(readFileSync(join(root, "note-alias.md"), "utf8"), before);
  });

  it("fix apply: canonicalizes frontmatter, writes a backup, and clears the issues", async () => {
    const result = await service.fix({ dryRun: false, backup: true });
    assert.equal(result.dryRun, false);
    assert.ok(result.backupDir && existsSync(result.backupDir));

    const fixed = readFileSync(join(root, "note-alias.md"), "utf8");
    assert.match(fixed, /created: "2026-01-02"/);
    assert.match(fixed, /updated: "2026-01-03"/);
    assert.doesNotMatch(fixed, /created_at/);

    // The original is preserved in the backup directory.
    const backupCopy = join(result.backupDir!, "note-alias.md");
    assert.ok(existsSync(backupCopy));
    assert.match(readFileSync(backupCopy, "utf8"), /created_at/);

    // Re-validating the now-fixed file yields no diagnostics.
    const after = await service.validate(["note-alias.md"]);
    assert.equal(after.filesWithIssues, 0);
  });

  it("fix never rewrites an unparseable file", async () => {
    const before = readFileSync(join(root, "bad", "unclosed.md"), "utf8");
    await service.fix({ dryRun: false, backup: false });
    assert.equal(readFileSync(join(root, "bad", "unclosed.md"), "utf8"), before);
  });

  it("migrate default: dry-runs rather than stamping schema versions", async () => {
    const before = readFileSync(join(root, "05_Agent_Session_Logs", "good.md"), "utf8");
    const result = await service.migrate();
    assert.equal(result.dryRun, true);
    assert.ok(result.migrated >= 1);
    assert.equal(readFileSync(join(root, "05_Agent_Session_Logs", "good.md"), "utf8"), before);
  });

  it("migrate apply: stamps the schema version on legacy notes and skips blocked files", async () => {
    const result = await service.migrate({ dryRun: false, backup: true });
    assert.equal(result.targetVersion, "1");
    assert.equal(result.manual, 1); // the unclosed file
    assert.ok(result.migrated >= 3);
    const good = readFileSync(join(root, "05_Agent_Session_Logs", "good.md"), "utf8");
    assert.match(good, /schema-version/);
  });

  it("report: renders text and markdown", async () => {
    const summary = await service.validate();
    const text = service.report(summary, "text");
    assert.match(text, /Frontmatter validation/);
    const markdown = service.report(summary, "markdown");
    assert.match(markdown, /# Frontmatter Validation Report/);
    const json = service.report(summary, "json");
    assert.equal(JSON.parse(json).filesScanned, 5);
  });

  it("rollback restores notes from the most recent backup", async () => {
    const original = readFileSync(join(root, "note-alias.md"), "utf8");
    const fixResult = await service.fix({ dryRun: false, backup: true });
    assert.ok(fixResult.backupDir);
    assert.notEqual(readFileSync(join(root, "note-alias.md"), "utf8"), original);

    const rollback = await service.rollback({ dryRun: false });
    assert.ok(rollback.restored >= 1);
    assert.equal(readFileSync(join(root, "note-alias.md"), "utf8"), original);
  });

  it("rollback default: dry-runs rather than restoring files", async () => {
    const original = readFileSync(join(root, "note-alias.md"), "utf8");
    const fixResult = await service.fix({ dryRun: false, backup: true });
    assert.ok(fixResult.backupDir);
    const fixed = readFileSync(join(root, "note-alias.md"), "utf8");
    assert.notEqual(fixed, original);

    const rollback = await service.rollback();

    assert.equal(rollback.dryRun, true);
    assert.ok(rollback.results.some((result) => result.status === "would-restore"));
    assert.equal(readFileSync(join(root, "note-alias.md"), "utf8"), fixed);
  });
});

describe("FrontmatterService unsafe fixes", () => {
  let root: string;
  let service: FrontmatterService;
  const NO_TYPE = `---\ntitle: "No Type"\ncreated: "2026-06-01"\nupdated: "2026-06-01"\n---\n\n# No Type\n`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fm-unsafe-"));
    mkdirSync(join(root, "07_Insights"), { recursive: true });
    writeFileSync(join(root, "07_Insights", "no-type.md"), NO_TYPE);
    service = new FrontmatterService(new VaultService(root));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not apply unsafe fixes without --confirm", async () => {
    const result = await service.fix({ dryRun: false, unsafe: true, confirm: false });
    assert.equal(result.unsafe, false);
    assert.equal(result.requiresConfirm, true);
    assert.doesNotMatch(readFileSync(join(root, "07_Insights", "no-type.md"), "utf8"), /type:\s*insight/);
  });

  it("infers a missing type with --unsafe --confirm", async () => {
    const result = await service.fix({ dryRun: false, unsafe: true, confirm: true });
    assert.equal(result.unsafe, true);
    assert.match(readFileSync(join(root, "07_Insights", "no-type.md"), "utf8"), /type:\s*insight/);
  });
});

describe("FrontmatterService safety hardening", () => {
  let root: string;
  let service: FrontmatterService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fm-safe-"));
    service = new FrontmatterService(new VaultService(root));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("migrate does NOT fabricate frontmatter for a body-only note", async () => {
    const plain = "# Just a body\n\nno frontmatter here\n";
    writeFileSync(join(root, "plain.md"), plain);
    const result = await service.migrate({ dryRun: false });
    const outcome = result.results.find((r) => r.path === "plain.md");
    assert.equal(outcome?.status, "skipped");
    // The file is untouched: no guessed title / created date is written.
    assert.equal(readFileSync(join(root, "plain.md"), "utf8"), plain);
  });

  it("fix --apply takes a backup even when backup:false is requested", async () => {
    writeFileSync(join(root, "alias.md"), `---\ntitle: "A"\ntype: note\ncreated_at: 2026-01-02\nupdated: "2026-01-03"\n---\n\n# A\n`);
    const result = await service.fix({ dryRun: false, backup: false });
    assert.ok(result.backupDir && existsSync(result.backupDir), "a backup dir must exist even with backup:false");
    assert.ok(existsSync(join(result.backupDir!, "alias.md")), "the original must be copied into the backup");
  });

  it("fix marks a file with multiple frontmatter blocks as manual instead of rewriting it", async () => {
    const multi = `---\ntitle: One\ntype: note\n---\n\n---\ntitle: Two\n---\n\nbody\n`;
    writeFileSync(join(root, "multi.md"), multi);
    const result = await service.fix({ dryRun: false });
    const outcome = result.results.find((r) => r.path === "multi.md");
    assert.equal(outcome?.status, "manual");
    assert.equal(readFileSync(join(root, "multi.md"), "utf8"), multi);
  });

  it("migrate refuses to downgrade a note whose schema-version is newer than current", async () => {
    const future = `---\ntitle: "F"\ntype: note\nschema-version: "2"\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n\n# F\n`;
    writeFileSync(join(root, "future.md"), future);
    const result = await service.migrate({ dryRun: false });
    const outcome = result.results.find((r) => r.path === "future.md");
    assert.equal(outcome?.status, "skipped");
    assert.match(outcome?.reason ?? "", /newer/);
    assert.equal(readFileSync(join(root, "future.md"), "utf8"), future);
  });

  it("migrate skips a note whose schema-version is not a recognized integer", async () => {
    const garbage = `---\ntitle: "G"\ntype: note\nschema-version: "v1.2"\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n\n# G\n`;
    writeFileSync(join(root, "garbage.md"), garbage);
    const result = await service.migrate({ dryRun: false });
    const outcome = result.results.find((r) => r.path === "garbage.md");
    assert.equal(outcome?.status, "skipped");
    assert.match(outcome?.reason ?? "", /[Uu]nrecognized/);
    assert.equal(readFileSync(join(root, "garbage.md"), "utf8"), garbage);
  });

  it("migrate stamps a legacy (version 0) note up to the current version", async () => {
    writeFileSync(join(root, "legacy.md"), `---\ntitle: "L"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n\n# L\n`);
    const result = await service.migrate({ dryRun: false });
    const outcome = result.results.find((r) => r.path === "legacy.md");
    assert.equal(outcome?.status, "fixed");
    assert.equal(outcome?.fromVersion, "0");
    assert.equal(outcome?.toVersion, "1");
    assert.match(readFileSync(join(root, "legacy.md"), "utf8"), /schema-version: 1/);
  });

  it("fix preserves CRLF line endings and body indentation", async () => {
    writeFileSync(
      join(root, "crlf.md"),
      `---\r\ntitle: "C"\r\ntype: note\r\ncreated_at: 2026-01-02\r\nupdated: "2026-01-03"\r\n---\r\n\r\n# Heading\r\n    indented\r\n`,
    );
    const result = await service.fix({ dryRun: false });
    assert.ok(result.results.some((r) => r.path === "crlf.md" && r.status === "fixed"));
    const fixed = readFileSync(join(root, "crlf.md"), "utf8");
    assert.ok(fixed.includes("\r\n"), "CRLF must be preserved");
    assert.doesNotMatch(fixed, /[^\r]\n/); // no lone LF introduced
    assert.match(fixed, /\r\n {4}indented/); // indentation preserved
    assert.match(fixed, /created: "2026-01-02"/); // alias still canonicalized
    assert.doesNotMatch(fixed, /created_at/);
  });

  it("rollback snapshots current content before restoring (a reversible rollback)", async () => {
    writeFileSync(join(root, "alias.md"), `---\ntitle: "A"\ntype: note\ncreated_at: 2026-01-02\nupdated: "2026-01-03"\n---\n\n# A\n`);
    const fix = await service.fix({ dryRun: false });
    assert.ok(fix.backupDir);

    // The user edits the fixed note afterwards.
    const edited = `${readFileSync(join(root, "alias.md"), "utf8")}extra line\n`;
    writeFileSync(join(root, "alias.md"), edited);

    const rollback = await service.rollback({ dryRun: false });
    // The pre-rollback (edited) content is preserved so the rollback is reversible.
    assert.ok(rollback.snapshotDir && existsSync(rollback.snapshotDir));
    assert.equal(readFileSync(join(rollback.snapshotDir!, "alias.md"), "utf8"), edited);
    // And the note is restored to the original pre-fix content.
    assert.match(readFileSync(join(root, "alias.md"), "utf8"), /created_at/);
  });
});

describe("FrontmatterService semantic exemption policy", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fm-policy-"));
    mkdirSync(join(root, "Custom_Templates"), { recursive: true });
    writeFileSync(
      join(root, "Custom_Templates", "Daily.md"),
      `---\ntitle: "<% tp.date.now(\\"YYYY-MM-DD\\") %>"\ntype: note\ncreated: "<% tp.date.now(\\"YYYY-MM-DD\\") %>"\nupdated: "<% tp.date.now(\\"YYYY-MM-DD\\") %>"\n---\n\n# Daily\n`,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses configured semantic exemptions instead of hard-coding only 99_Templates", async () => {
    const service = new FrontmatterService(
      new VaultService(root),
      undefined,
      [],
      { semanticExemptPaths: ["Custom_Templates/**"] },
    );

    const summary = await service.validate(["Custom_Templates/Daily.md"]);

    assert.equal(summary.filesWithIssues, 0);
    assert.equal(summary.counts.warning, 0);
  });
});
