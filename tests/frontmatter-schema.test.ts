import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  canonicalizeFrontmatter,
  defaultFrontmatterSchema,
  isCanonicalDate,
  mergeFrontmatterSchema,
  normalizeDateValue,
  validateFrontmatter,
} from "../src/utils/frontmatter-schema.js";

const codesOf = (diags: { code: string }[]) => diags.map((d) => d.code);

describe("normalizeDateValue", () => {
  it("converts a Date to YYYY-MM-DD", () => {
    assert.equal(normalizeDateValue(new Date("2026-06-01T12:34:56Z")), "2026-06-01");
  });

  it("trims an ISO datetime string to the date", () => {
    assert.equal(normalizeDateValue("2026-06-01T10:00:00Z"), "2026-06-01");
    assert.equal(normalizeDateValue("2026-06-01"), "2026-06-01");
  });

  it("returns null for non-dates", () => {
    assert.equal(normalizeDateValue("not a date"), null);
    assert.equal(normalizeDateValue(42), null);
    assert.equal(normalizeDateValue(undefined), null);
  });
});

describe("isCanonicalDate", () => {
  it("accepts only strict YYYY-MM-DD strings", () => {
    assert.equal(isCanonicalDate("2026-06-01"), true);
    assert.equal(isCanonicalDate("2026-06-01T00:00:00Z"), false);
    assert.equal(isCanonicalDate(new Date()), false);
  });
});

describe("canonicalizeFrontmatter", () => {
  it("maps snake_case aliases to canonical kebab-case keys", () => {
    const { data, changes } = canonicalizeFrontmatter({ created_at: "2026-06-01", last_verified: "2026-06-02" });
    assert.equal(data.created, "2026-06-01");
    assert.equal(data["last-verified"], "2026-06-02");
    assert.ok(codesOf(changes).includes("FIELD_ALIASED"));
  });

  it("normalizes a Date value (gray-matter coercion) back to a string", () => {
    const { data, changes } = canonicalizeFrontmatter({ created: new Date("2026-06-01T00:00:00Z") });
    assert.equal(data.created, "2026-06-01");
    assert.equal(typeof data.created, "string");
    assert.ok(codesOf(changes).includes("DATE_NORMALIZED"));
  });

  it("coerces a string tags field to an array", () => {
    const { data, changes } = canonicalizeFrontmatter({ tags: "a, b, c" });
    assert.deepEqual(data.tags, ["a", "b", "c"]);
    assert.ok(codesOf(changes).includes("TAGS_COERCED"));
  });

  it("keeps the canonical key when both alias and canonical are present", () => {
    const { data } = canonicalizeFrontmatter({ created: "2026-06-01", created_at: "1999-01-01" });
    assert.equal(data.created, "2026-06-01");
    assert.equal("created_at" in data, false);
  });
});

describe("validateFrontmatter", () => {
  const schema = defaultFrontmatterSchema();

  it("flags missing frontmatter unless exempt", () => {
    const diags = validateFrontmatter({}, { hasFrontmatter: false }, schema);
    assert.ok(codesOf(diags).includes("MISSING_FRONTMATTER"));
    const exempt = validateFrontmatter({}, { hasFrontmatter: false, isExempt: true }, schema);
    assert.equal(exempt.length, 0);
  });

  it("flags an invalid note type", () => {
    const diags = validateFrontmatter(
      { title: "X", type: "banana", created: "2026-06-01", updated: "2026-06-01" },
      { hasFrontmatter: true },
      schema,
    );
    assert.ok(codesOf(diags).includes("INVALID_TYPE"));
  });

  it("flags missing required fields per type", () => {
    const diags = validateFrontmatter(
      { title: "X", type: "insight", created: "2026-06-01", updated: "2026-06-01" },
      { hasFrontmatter: true },
      schema,
    );
    const missing = diags.filter((d) => d.code === "MISSING_REQUIRED_FIELD").map((d) => d.field);
    assert.ok(missing.includes("derived-from"));
    assert.ok(missing.includes("confidence"));
  });

  it("flags a non-canonical date format", () => {
    const diags = validateFrontmatter(
      { title: "X", type: "note", created: "06/01/2026", updated: "2026-06-01" },
      { hasFrontmatter: true },
      schema,
    );
    assert.ok(codesOf(diags).includes("INVALID_DATE_FORMAT"));
  });

  it("flags tags that are not a list", () => {
    const diags = validateFrontmatter(
      { title: "X", type: "note", created: "2026-06-01", updated: "2026-06-01", tags: "single" },
      { hasFrontmatter: true },
      schema,
    );
    assert.ok(codesOf(diags).includes("INVALID_TAGS"));
  });

  it("passes a fully valid note", () => {
    const diags = validateFrontmatter(
      { title: "X", type: "note", created: "2026-06-01", updated: "2026-06-01", tags: ["a"] },
      { hasFrontmatter: true },
      schema,
    );
    assert.equal(diags.length, 0);
  });
});

describe("mergeFrontmatterSchema", () => {
  it("adds custom aliases on top of the defaults", () => {
    const merged = mergeFrontmatterSchema({ aliases: { author: "source-author" } });
    assert.equal(merged.aliases.author, "source-author");
    // Default alias still present.
    assert.equal(merged.aliases.created_at, "created");
  });

  it("overrides required fields for a type and keeps others", () => {
    const merged = mergeFrontmatterSchema({ requiredFieldsByType: { note: ["title", "type"] } });
    assert.deepEqual(merged.requiredFieldsByType.note, ["title", "type"]);
    assert.ok(merged.requiredFieldsByType.adr.includes("decision-date"));
  });

  it("returns the default schema for no overrides", () => {
    const merged = mergeFrontmatterSchema(null);
    assert.equal(merged.version, defaultFrontmatterSchema().version);
  });
});

describe("validateFrontmatter — unknown fields", () => {
  const base = { title: "X", type: "note", created: "2026-06-01", updated: "2026-06-01", weird: 1 };

  it("ignores unknown fields by default", () => {
    const diags = validateFrontmatter(base, { hasFrontmatter: true }, defaultFrontmatterSchema());
    assert.equal(diags.some((d) => d.code === "UNKNOWN_FIELD"), false);
  });

  it("flags unknown fields when strictUnknownFields is enabled", () => {
    const strict = mergeFrontmatterSchema({ strictUnknownFields: true });
    const diags = validateFrontmatter(base, { hasFrontmatter: true }, strict);
    assert.ok(diags.some((d) => d.code === "UNKNOWN_FIELD" && d.field === "weird"));
  });
});
