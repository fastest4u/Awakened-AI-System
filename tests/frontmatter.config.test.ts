import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  loadFrontmatterConfig,
  sampleProjectConfig,
  sampleProjectConfigSchema,
} from "../src/config/frontmatter.config.js";

describe("loadFrontmatterConfig", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fm-cfg-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeProject = (data: unknown) => {
    mkdirSync(join(root, ".memory-mcp"), { recursive: true });
    writeFileSync(join(root, ".memory-mcp", "frontmatter.config.json"), JSON.stringify(data));
  };

  it("falls back to defaults when no config files exist", () => {
    const result = loadFrontmatterConfig(root, { globalPath: join(root, "missing.json") });
    assert.deepEqual(result.sources, []);
    assert.equal(result.errors.length, 0);
    assert.equal(result.schema.aliases.created_at, "created");
  });

  it("applies a project config override on top of defaults", () => {
    writeProject({
      aliases: { author: "source-author" },
      requiredFieldsByType: { note: ["title", "type"] },
      semanticExemptPaths: ["Custom_Templates/**"],
      strictUnknownFields: true,
    });
    const result = loadFrontmatterConfig(root, { globalPath: join(root, "missing.json") });
    assert.equal(result.schema.aliases.author, "source-author");
    assert.equal(result.schema.aliases.created_at, "created"); // default kept
    assert.deepEqual(result.schema.requiredFieldsByType.note, ["title", "type"]);
    assert.deepEqual(result.policy.semanticExemptPaths, ["99_Templates/**", "Custom_Templates/**"]);
    assert.equal(result.schema.strictUnknownFields, true);
    assert.ok(result.sources.some((source) => source.includes("frontmatter.config.json")));
  });

  it("lets project config override global config for overlapping keys", () => {
    const globalPath = join(root, "global.json");
    writeFileSync(globalPath, JSON.stringify({ aliases: { author: "global-author" }, requiredFieldsByType: { note: ["title"] } }));
    writeProject({ aliases: { author: "source-author" } });
    const result = loadFrontmatterConfig(root, { globalPath });
    assert.equal(result.schema.aliases.author, "source-author"); // project wins
    assert.deepEqual(result.schema.requiredFieldsByType.note, ["title"]); // global-only key kept
    assert.equal(result.sources.length, 2);
  });

  it("ignores malformed config without throwing", () => {
    const globalPath = join(root, "global.json");
    writeFileSync(globalPath, "{ not valid json");
    const result = loadFrontmatterConfig(root, { globalPath });
    assert.ok(result.errors.length >= 1);
    assert.equal(result.schema.aliases.created_at, "created"); // still usable
  });

  it("ignores invalid config shapes without poisoning the schema", () => {
    writeProject({
      aliases: ["not-a-map"],
      requiredFieldsByType: "not-a-map",
      dateFields: "not-an-array",
      validTypes: "not-an-array",
      keyOrder: "not-an-array",
      semanticExemptPaths: "not-an-array",
      strictUnknownFields: "yes",
    });

    const result = loadFrontmatterConfig(root, { globalPath: join(root, "missing.json") });

    assert.ok(result.errors.length >= 1);
    assert.equal(result.schema.aliases.created_at, "created");
    assert.equal(result.schema.aliases["0"], undefined);
    assert.equal(result.schema.strictUnknownFields, false);
    assert.ok(Array.isArray(result.schema.dateFields));
    assert.ok(Array.isArray(result.schema.validTypes));
    assert.ok(Array.isArray(result.schema.keyOrder));
    assert.deepEqual(result.policy.semanticExemptPaths, ["99_Templates/**"]);
  });

  it("ships a local JSON schema reference for project configs", () => {
    const sample = JSON.parse(sampleProjectConfig());
    const schema = JSON.parse(sampleProjectConfigSchema());

    assert.equal(sample.$schema, "./frontmatter.config.schema.json");
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.type, "object");
    assert.equal(schema.properties.$schema.type, "string");
    assert.equal(schema.properties.aliases.additionalProperties.type, "string");
    assert.equal(schema.properties.requiredFieldsByType.additionalProperties.items.type, "string");
    assert.equal(schema.properties.semanticExemptPaths.items.type, "string");
    assert.equal(schema.properties.strictUnknownFields.type, "boolean");
  });

  it("keeps the checked-in docs JSON schema in sync with the generator", () => {
    const docsSchema = readFileSync("docs/frontmatter.config.schema.json", "utf8").replace(/\r\n/g, "\n");
    assert.equal(docsSchema, sampleProjectConfigSchema());
  });
});
