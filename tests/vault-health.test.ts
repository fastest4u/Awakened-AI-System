import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { VaultHealthService } from "../src/services/vault-health.service.js";
import { VaultService } from "../src/services/vault.service.js";

const TODAY = new Date().toISOString().slice(0, 10);

function note(frontmatterLines: string[], body: string) {
  return ["---", ...frontmatterLines, "---", "", body, ""].join("\n");
}

function makeVault(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "vault-health-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content, "utf8");
  }
  return { root, health: new VaultHealthService(new VaultService(root)) };
}

describe("VaultHealthService broken-link scan (shared resolver semantics)", () => {
  let root: string;
  let health: VaultHealthService;

  beforeEach(() => {
    ({ root, health } = makeVault({
      "notes/2026-06-03-some-title.md": note(
        [
          'title: "2026-06-03 - Some Title"',
          "type: note",
          "aliases:",
          "  - Known Alias",
          `created: "${TODAY}"`,
          `updated: "${TODAY}"`,
        ],
        "Target body.",
      ),
      "notes/linker.md": note(
        ['title: "Linker"', "type: note", `created: "${TODAY}"`, `updated: "${TODAY}"`],
        [
          "Full title: [[2026-06-03 - Some Title]]",
          "Alias, case-insensitive: [[known alias]]",
          "Path-style: [[notes/2026-06-03-some-title]]",
          "Broken path-style: [[notes/does-not-exist]]",
          "Broken: [[Totally Missing Note]]",
        ].join("\n"),
      ),
    }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does NOT flag a full-title wikilink containing ' - ' (truncation regression)", async () => {
    const broken = await health.findBrokenLinks();
    const messages = broken.map((issue) => issue.message);
    assert.ok(
      !messages.some((message) => message.includes("2026-06-03 - Some Title")),
      `full-title link must resolve, got: ${JSON.stringify(messages)}`,
    );
  });

  it("resolves alias and path-style links, and flags genuinely missing targets", async () => {
    const broken = await health.findBrokenLinks();
    const messages = broken.map((issue) => issue.message);
    assert.ok(!messages.some((message) => message.includes("known alias")), "alias must resolve");
    assert.ok(!messages.some((message) => message.includes("[[notes/2026-06-03-some-title]]")), "existing path must resolve");
    assert.ok(messages.some((message) => message.includes("[[notes/does-not-exist]]")), "missing path-style target must be flagged");
    assert.ok(messages.some((message) => message.includes("[[Totally Missing Note]]")), "missing target must be flagged");
    assert.equal(broken.length, 2);
    assert.ok(broken.every((issue) => issue.path === "notes/linker.md" && issue.code === "BROKEN_WIKILINK"));
  });
});

describe("VaultHealthService.verifyNote (scoped verification)", () => {
  let root: string;
  let health: VaultHealthService;

  beforeEach(() => {
    ({ root, health } = makeVault({
      // Missing `created` (error), one broken link, stale `updated`.
      "notes/scoped.md": note(
        ['title: "Scoped"', "type: note", 'updated: "2020-01-01"'],
        "See [[Totally Missing Note]]",
      ),
      // A second note full of its own problems that must NOT leak into the result.
      "notes/other-bad.md": note(
        ['title: "Other Bad"', "type: note", 'updated: "2019-01-01"'],
        "See [[Another Missing Note]]",
      ),
    }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports only the requested note's issues (frontmatter + links + staleness)", async () => {
    const result = await health.verifyNote("notes/scoped.md");
    assert.equal(result.valid, false);
    assert.ok(result.issues.length > 0);
    assert.ok(result.issues.every((issue) => issue.path === "notes/scoped.md"), "no other note's issues may leak in");
    const codes = result.issues.map((issue) => issue.code);
    assert.ok(codes.includes("MISSING_REQUIRED_FIELD"), "missing `created` must be reported");
    assert.ok(codes.includes("BROKEN_WIKILINK"), "the note's broken outgoing link must be reported");
    assert.ok(codes.includes("STALE_NOTE"), "the stale `updated` date must be reported");
    assert.ok(!codes.some((code) => code === "DUPLICATE_BASENAME"), "vault-wide duplicate scan must not run");
  });

  it("honors checkFrontmatter / checkLinks / checkStaleness flags", async () => {
    const noFrontmatter = await health.verifyNote("notes/scoped.md", { checkFrontmatter: false });
    assert.ok(!noFrontmatter.issues.some((issue) => issue.code === "MISSING_REQUIRED_FIELD"));
    assert.ok(noFrontmatter.issues.some((issue) => issue.code === "BROKEN_WIKILINK"));

    const noLinks = await health.verifyNote("notes/scoped.md", { checkLinks: false });
    assert.ok(!noLinks.issues.some((issue) => issue.code === "BROKEN_WIKILINK"));
    assert.ok(noLinks.issues.some((issue) => issue.code === "MISSING_REQUIRED_FIELD"));

    const noStaleness = await health.verifyNote("notes/scoped.md", { checkStaleness: false });
    assert.ok(!noStaleness.issues.some((issue) => issue.code === "STALE_NOTE"));

    const none = await health.verifyNote("notes/scoped.md", {
      checkFrontmatter: false,
      checkLinks: false,
      checkStaleness: false,
    });
    assert.deepEqual(none.issues, []);
    assert.equal(none.valid, true);
  });

  it("returns NOT_FOUND for an unknown reference", async () => {
    const result = await health.verifyNote("notes/nope.md");
    assert.equal(result.valid, false);
    assert.equal(result.issues[0]?.code, "NOT_FOUND");
  });
});

describe("VaultHealthService.findDuplicates (similarity threshold)", () => {
  let root: string;
  let health: VaultHealthService;

  beforeEach(() => {
    ({ root, health } = makeVault({
      "notes/dup-a.md": note(['title: "Deployment Runbook"', "type: note", `created: "${TODAY}"`, `updated: "${TODAY}"`], "a"),
      "notes/dup-b.md": note(['title: "Deployment Runbooks"', "type: note", `created: "${TODAY}"`, `updated: "${TODAY}"`], "b"),
      "notes/dup-c.md": note(['title: "Same Title"', "type: note", `created: "${TODAY}"`, `updated: "${TODAY}"`], "c"),
      "sub/dup-c.md": note(['title: "Same Title"', "type: note", `created: "${TODAY}"`, `updated: "${TODAY}"`], "d"),
    }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports near-duplicate titles at the default threshold", async () => {
    const result = await health.findDuplicates();
    const pair = result.similarTitles.find((entry) => entry.titles.includes("Deployment Runbook"));
    assert.ok(pair, "near-identical titles must be reported at 0.85");
    assert.ok(pair.similarity >= 0.85 && pair.similarity <= 1);
    assert.deepEqual([...pair.paths].sort(), ["notes/dup-a.md", "notes/dup-b.md"]);
  });

  it("a stricter threshold excludes the near-duplicate pair", async () => {
    const result = await health.findDuplicates(0.99);
    assert.equal(result.similarTitles.length, 0);
  });

  it("keeps exact duplicate titles/basenames in their own buckets, not similarTitles", async () => {
    const result = await health.findDuplicates();
    assert.ok(result.duplicateTitles.some((entry) => entry.title === "same title"));
    assert.ok(result.duplicateBasenames.some((entry) => entry.name === "dup-c"));
    assert.ok(
      !result.similarTitles.some((entry) => entry.titles.every((title) => title === "Same Title")),
      "exact matches are excluded from the similarity bucket",
    );
  });
});
