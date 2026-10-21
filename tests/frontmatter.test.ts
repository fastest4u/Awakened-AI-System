import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildNoteContent,
  parseFrontmatter,
  serializeFrontmatter,
  yamlScalar,
} from "../src/utils/frontmatter.js";

const codes = (raw: string) => parseFrontmatter(raw).diagnostics.map((d) => d.code);

describe("parseFrontmatter — happy paths", () => {
  it("parses a clean frontmatter block with no diagnostics", () => {
    const result = parseFrontmatter(`---\ntitle: Hello\ntype: note\n---\n\n# Hello\nbody\n`);
    assert.equal(result.hasFrontmatter, true);
    assert.equal(result.data.title, "Hello");
    assert.equal(result.data.type, "note");
    assert.equal(result.diagnostics.length, 0);
    assert.match(result.body, /# Hello/);
  });

  it("reports no frontmatter for a plain markdown file", () => {
    const result = parseFrontmatter(`# Just a title\n\nSome text.\n`);
    assert.equal(result.hasFrontmatter, false);
    assert.deepEqual(result.data, {});
    assert.equal(result.diagnostics.length, 0);
  });

  it("handles CRLF line endings", () => {
    const result = parseFrontmatter(`---\r\ntitle: CRLF\r\ntype: note\r\n---\r\n\r\nbody\r\n`);
    assert.equal(result.hasFrontmatter, true);
    assert.equal(result.data.title, "CRLF");
  });

  it("retains YAML 1.1 date coercion for existing normalization", () => {
    const result = parseFrontmatter(`---\ncreated: 2026-01-02\n---\n`);
    assert.ok(result.data.created instanceof Date);
  });

  it("rejects a non-mapping YAML frontmatter document", () => {
    const result = parseFrontmatter(`---\n- not-a-mapping\n---\nbody\n`);
    assert.deepEqual(result.data, {});
    assert.ok(codes(result.raw).includes("FRONTMATTER_INVALID_YAML"));
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.severity === "critical"));
  });
});

describe("parseFrontmatter — never throws on malformed input", () => {
  it("flags an unclosed block as critical without throwing", () => {
    const result = parseFrontmatter(`---\ntitle: Hello\ntype: note\n\n# Body\n`);
    assert.equal(result.hasFrontmatter, true);
    assert.ok(codes(result.raw).includes("FRONTMATTER_UNCLOSED"));
    assert.ok(result.diagnostics.some((d) => d.severity === "critical"));
  });

  it("classifies a duplicate mapping key as critical with the DUPLICATE_KEY code", () => {
    const result = parseFrontmatter(`---\ntitle: A\ntitle: B\ntype: note\n---\n\nbody\n`);
    assert.ok(result.diagnostics.some((d) => d.severity === "critical"));
    // Pin the exact code so a regression that misclassifies duplicates is caught.
    assert.ok(codes(result.raw).includes("FRONTMATTER_DUPLICATE_KEY"));
  });

  it("classifies an unquoted colon value as critical", () => {
    const result = parseFrontmatter(`---\ntitle: API: Auth Flow\ntype: note\n---\n\nbody\n`);
    assert.ok(result.diagnostics.some((d) => d.severity === "critical"));
    assert.ok(codes(result.raw).includes("FRONTMATTER_UNQUOTED_VALUE"));
  });

  it("classifies bad indentation as critical", () => {
    const result = parseFrontmatter(`---\ntitle: a\n  bad: x\n---\n\nbody\n`);
    assert.ok(result.diagnostics.some((d) => d.severity === "critical"));
    assert.ok(codes(result.raw).includes("FRONTMATTER_BAD_INDENTATION"));
  });

  it("never throws for non-string input", () => {
    for (const input of [undefined, null, 123, {}, []]) {
      const result = parseFrontmatter(input as unknown as string);
      assert.equal(result.hasFrontmatter, false);
      assert.deepEqual(result.data, {});
    }
  });
});

describe("parseFrontmatter — structural diagnostics", () => {
  it("flags an empty frontmatter block as info", () => {
    const result = parseFrontmatter(`---\n---\n\nbody\n`);
    assert.ok(codes(result.raw).includes("FRONTMATTER_EMPTY"));
  });

  it("flags a leading blank line as a warning (gray-matter would ignore it)", () => {
    const result = parseFrontmatter(`\n---\ntitle: Late\ntype: note\n---\n\nbody\n`);
    assert.ok(codes(result.raw).includes("FRONTMATTER_NOT_AT_START"));
    // Despite the blank line, the safe parser still recovers the data.
    assert.equal(result.data.title, "Late");
  });

  it("flags a leading BOM as info and still parses", () => {
    const result = parseFrontmatter(`\uFEFF---\ntitle: Bom\ntype: note\n---\n\nbody\n`);
    assert.ok(codes(result.raw).includes("FRONTMATTER_BOM"));
    assert.equal(result.data.title, "Bom");
  });

  it("flags multiple frontmatter blocks as a warning", () => {
    const result = parseFrontmatter(`---\ntitle: One\ntype: note\n---\n\n---\ntitle: Two\n---\n\nbody\n`);
    assert.ok(codes(result.raw).includes("FRONTMATTER_MULTIPLE_BLOCKS"));
  });

  it("maps each top-level key to its 1-based source line", () => {
    const result = parseFrontmatter(`---\ntitle: X\ntype: note\ncreated: nope\n---\n\nbody\n`);
    assert.equal(result.fieldLines.title, 2);
    assert.equal(result.fieldLines.type, 3);
    assert.equal(result.fieldLines.created, 4);
  });
});

describe("yamlScalar", () => {
  it("quotes date-like strings so they round-trip as strings", () => {
    assert.equal(yamlScalar("2026-06-01"), '"2026-06-01"');
    assert.equal(yamlScalar("2026-06-01T10:00:00Z"), '"2026-06-01T10:00:00Z"');
  });

  it("quotes values containing a colon", () => {
    assert.equal(yamlScalar("API: Auth"), '"API: Auth"');
  });

  it("passes through plain identifiers and numbers/booleans", () => {
    assert.equal(yamlScalar("session-log"), "session-log");
    assert.equal(yamlScalar(42), "42");
    assert.equal(yamlScalar(true), "true");
  });

  it("renders a Date as a quoted YYYY-MM-DD", () => {
    assert.equal(yamlScalar(new Date("2026-06-01T00:00:00Z")), '"2026-06-01"');
  });

  it("quotes values containing '#' (an unquoted '#' starts a YAML comment)", () => {
    assert.equal(yamlScalar("Issue #42"), '"Issue #42"');
    assert.equal(yamlScalar("#tag"), '"#tag"');
  });

  it("quotes leading/trailing whitespace and the empty string", () => {
    assert.equal(yamlScalar(" padded"), '" padded"');
    assert.equal(yamlScalar("padded "), '"padded "');
    assert.equal(yamlScalar(""), '""');
  });

  it("quotes boolean/null lookalikes so they round-trip as strings", () => {
    for (const word of ["true", "false", "yes", "no", "on", "off", "null", "~", "True", "NO"]) {
      assert.equal(yamlScalar(word), JSON.stringify(word), `expected ${word} to be quoted`);
    }
  });

  it("quotes number lookalikes so they round-trip as strings", () => {
    for (const num of ["42", "-7", "3.14", "1e5", "0x1F", "0o17", "0b101", ".inf", ".nan", "1_000"]) {
      assert.equal(yamlScalar(num), JSON.stringify(num), `expected ${num} to be quoted`);
    }
  });

  it("quotes values starting with a YAML indicator character", () => {
    for (const value of ["- item", "? key", "[a]", "{a}", "&anchor", "*star", "!tag", "|block", "> fold", "%pct", "@at", "`tick", '"dq', "'sq"]) {
      assert.equal(yamlScalar(value), JSON.stringify(value), `expected ${JSON.stringify(value)} to be quoted`);
    }
  });

  it("'#' values survive a write + reparse roundtrip (truncation regression)", () => {
    // Regression: an unquoted '#' starts a comment, so a reparse used to
    // silently truncate "Fix #12 - escaping" down to "Fix".
    const data = {
      title: "Fix #12 - escaping",
      type: "note",
      status: "true",
      version: "1.20",
      tags: ["#inbox", "release: 2026"],
    };
    const content = buildNoteContent(data, "body\n", ["title", "type"]);
    const parsed = parseFrontmatter(content);
    assert.equal(parsed.diagnostics.length, 0);
    assert.equal(parsed.data.title, "Fix #12 - escaping");
    assert.equal(parsed.data.status, "true", "boolean lookalike stays a string");
    assert.equal(parsed.data.version, "1.20", "number lookalike stays a string (trailing zero kept)");
    assert.deepEqual(parsed.data.tags, ["#inbox", "release: 2026"]);
  });
});

describe("serializeFrontmatter + buildNoteContent", () => {
  it("orders known keys by schema order and serializes arrays", () => {
    const block = serializeFrontmatter(
      { tags: ["a", "b"], title: "X", type: "note" },
      ["title", "type", "tags"],
    );
    const lines = block.split("\n");
    assert.equal(lines[0], "---");
    assert.equal(lines[1], "title: X");
    assert.equal(lines[2], "type: note");
    assert.equal(lines[3], "tags:");
    assert.equal(lines[4], "  - a");
    assert.equal(lines[5], "  - b");
    assert.equal(lines[6], "---");
  });

  it("round-trips through parseFrontmatter", () => {
    const content = buildNoteContent(
      { title: "Round Trip", type: "note", created: "2026-06-01", updated: "2026-06-01" },
      "# Round Trip\n\nbody text\n",
      ["title", "type", "created", "updated"],
    );
    const parsed = parseFrontmatter(content);
    assert.equal(parsed.diagnostics.length, 0);
    assert.equal(parsed.data.title, "Round Trip");
    assert.equal(parsed.data.created, "2026-06-01");
    assert.match(parsed.body, /body text/);
  });

  it("preserves leading horizontal whitespace in the body (no longer strips indentation)", () => {
    const content = buildNoteContent({ title: "X", type: "note" }, "    indented first line\nplain\n", ["title", "type"]);
    assert.match(content, /\n\n {4}indented first line\n/);
  });

  it("emits CRLF output when the note's line ending is CRLF", () => {
    const content = buildNoteContent({ title: "X", type: "note" }, "line1\r\n    indented\r\n", ["title", "type"], "\r\n");
    assert.ok(content.includes("\r\n"));
    assert.doesNotMatch(content, /[^\r]\n/); // every \n is preceded by \r (no lone LF)
    assert.match(content, /\r\n {4}indented\r\n/);
  });

  it("defaults to LF and does not introduce CR", () => {
    const content = buildNoteContent({ title: "X", type: "note" }, "body\n", ["title", "type"]);
    assert.doesNotMatch(content, /\r/);
  });
});
