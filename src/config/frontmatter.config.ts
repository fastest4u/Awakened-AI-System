import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultFrontmatterSchema,
  mergeFrontmatterSchema,
  type FrontmatterSchema,
} from "../utils/frontmatter-schema.js";
import { defaultFrontmatterPolicy, type FrontmatterPolicy } from "./vault-policy.js";

/**
 * Optional, project-agnostic frontmatter configuration.
 *
 * Resolution order (later wins): built-in defaults -> global user config
 * (~/.memory-vault/frontmatter.config.json) -> project config
 * (<vaultRoot>/.memory-mcp/frontmatter.config.json). Every layer is optional;
 * a missing or malformed file is ignored (with a non-fatal error recorded) so
 * the validator always has a usable schema.
 */
export interface FrontmatterConfigResult {
  schema: FrontmatterSchema;
  policy: FrontmatterPolicy;
  sources: string[];
  errors: string[];
}

type RawFrontmatterConfig = Partial<{
  aliases: Record<string, string>;
  requiredFieldsByType: Record<string, string[]>;
  dateFields: string[];
  validTypes: string[];
  keyOrder: string[];
  semanticExemptPaths: string[];
  strictUnknownFields: boolean;
}>;

export const GLOBAL_CONFIG_PATH = join(homedir(), ".memory-vault", "frontmatter.config.json");
export const PROJECT_CONFIG_RELATIVE = join(".memory-mcp", "frontmatter.config.json");
export const PROJECT_CONFIG_SCHEMA_RELATIVE = join(".memory-mcp", "frontmatter.config.schema.json");

export function projectConfigPath(vaultRoot: string): string {
  return join(vaultRoot, PROJECT_CONFIG_RELATIVE);
}

export function projectConfigSchemaPath(vaultRoot: string): string {
  return join(vaultRoot, PROJECT_CONFIG_SCHEMA_RELATIVE);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readStringArrayField(raw: Record<string, unknown>, field: string, path: string, errors: string[]): string[] | undefined {
  if (!(field in raw)) return undefined;
  const value = raw[field];
  if (!Array.isArray(value)) {
    errors.push(`Ignored ${path}.${field}: expected an array of strings.`);
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
    else errors.push(`Ignored ${path}.${field} entry: expected a string.`);
  }
  return out;
}

function readStringMapField(raw: Record<string, unknown>, field: string, path: string, errors: string[]): Record<string, string> | undefined {
  if (!(field in raw)) return undefined;
  const value = raw[field];
  if (!isPlainRecord(value)) {
    errors.push(`Ignored ${path}.${field}: expected an object of string values.`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
    else errors.push(`Ignored ${path}.${field}.${key}: expected a string.`);
  }
  return out;
}

function readRequiredFields(raw: Record<string, unknown>, path: string, errors: string[]): Record<string, string[]> | undefined {
  if (!("requiredFieldsByType" in raw)) return undefined;
  const value = raw.requiredFieldsByType;
  if (!isPlainRecord(value)) {
    errors.push(`Ignored ${path}.requiredFieldsByType: expected an object of string arrays.`);
    return undefined;
  }
  const out: Record<string, string[]> = {};
  for (const [type, fields] of Object.entries(value)) {
    if (!Array.isArray(fields)) {
      errors.push(`Ignored ${path}.requiredFieldsByType.${type}: expected an array of strings.`);
      continue;
    }
    out[type] = fields.filter((field): field is string => {
      const valid = typeof field === "string";
      if (!valid) errors.push(`Ignored ${path}.requiredFieldsByType.${type} entry: expected a string.`);
      return valid;
    });
  }
  return out;
}

function readBooleanField(raw: Record<string, unknown>, field: string, path: string, errors: string[]): boolean | undefined {
  if (!(field in raw)) return undefined;
  const value = raw[field];
  if (typeof value === "boolean") return value;
  errors.push(`Ignored ${path}.${field}: expected a boolean.`);
  return undefined;
}

function normalizeConfig(raw: Record<string, unknown>, path: string, errors: string[]): RawFrontmatterConfig {
  return {
    aliases: readStringMapField(raw, "aliases", path, errors),
    requiredFieldsByType: readRequiredFields(raw, path, errors),
    dateFields: readStringArrayField(raw, "dateFields", path, errors),
    validTypes: readStringArrayField(raw, "validTypes", path, errors),
    keyOrder: readStringArrayField(raw, "keyOrder", path, errors),
    semanticExemptPaths: readStringArrayField(raw, "semanticExemptPaths", path, errors),
    strictUnknownFields: readBooleanField(raw, "strictUnknownFields", path, errors),
  };
}

function readJson(path: string, errors: string[]): RawFrontmatterConfig | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isPlainRecord(parsed)) {
      return normalizeConfig(parsed, path, errors);
    }
    errors.push(`Ignored ${path}: expected a JSON object.`);
    return null;
  } catch (error) {
    errors.push(`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function mergeRaw(base: RawFrontmatterConfig | null, override: RawFrontmatterConfig | null): RawFrontmatterConfig {
  const lower = base ?? {};
  const higher = override ?? {};
  return {
    aliases: { ...(lower.aliases ?? {}), ...(higher.aliases ?? {}) },
    requiredFieldsByType: { ...(lower.requiredFieldsByType ?? {}), ...(higher.requiredFieldsByType ?? {}) },
    dateFields: [...new Set([...(lower.dateFields ?? []), ...(higher.dateFields ?? [])])],
    validTypes: [...new Set([...(lower.validTypes ?? []), ...(higher.validTypes ?? [])])],
    keyOrder: higher.keyOrder ?? lower.keyOrder,
    semanticExemptPaths: [...new Set([...(lower.semanticExemptPaths ?? []), ...(higher.semanticExemptPaths ?? [])])],
    strictUnknownFields: higher.strictUnknownFields ?? lower.strictUnknownFields,
  };
}

export function loadFrontmatterConfig(
  vaultRoot: string,
  options: { globalPath?: string } = {},
): FrontmatterConfigResult {
  const errors: string[] = [];
  const sources: string[] = [];
  const globalPath = options.globalPath ?? GLOBAL_CONFIG_PATH;

  const global = readJson(globalPath, errors);
  if (global) sources.push(globalPath);

  const projectPath = projectConfigPath(vaultRoot);
  const project = readJson(projectPath, errors);
  if (project) sources.push(projectPath);

  const defaults = defaultFrontmatterPolicy();
  const merged = mergeRaw({ semanticExemptPaths: defaults.semanticExemptPaths }, mergeRaw(global, project));

  if (!global && !project) {
    return { schema: defaultFrontmatterSchema(), policy: defaults, sources, errors };
  }

  const schema = mergeFrontmatterSchema({
    aliases: merged.aliases,
    requiredFieldsByType: merged.requiredFieldsByType,
    dateFields: merged.dateFields,
    validTypes: merged.validTypes,
    keyOrder: merged.keyOrder,
    strictUnknownFields: merged.strictUnknownFields,
  });
  const policy = {
    semanticExemptPaths: merged.semanticExemptPaths?.length
      ? merged.semanticExemptPaths
      : defaults.semanticExemptPaths,
  };

  return { schema, policy, sources, errors };
}

/** A documented sample project config written by `memory-vault init`. */
export function sampleProjectConfig(): string {
  return JSON.stringify(
    {
      $schema: "./frontmatter.config.schema.json",
      aliases: { author: "source-author" },
      requiredFieldsByType: {},
      dateFields: [],
      validTypes: [],
      semanticExemptPaths: [],
      strictUnknownFields: false,
    },
    null,
    2,
  ) + "\n";
}

/** JSON Schema written beside the project config by `memory-vault init`. */
export function sampleProjectConfigSchema(): string {
  return JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://awakened-ai-memory-mcp.local/frontmatter.config.schema.json",
      title: "Memory Vault frontmatter config",
      type: "object",
      additionalProperties: false,
      properties: {
        $schema: { type: "string" },
        aliases: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Map alternate frontmatter field names to canonical field names.",
        },
        requiredFieldsByType: {
          type: "object",
          additionalProperties: {
            type: "array",
            items: { type: "string" },
          },
          description: "Override required fields per note type.",
        },
        dateFields: {
          type: "array",
          items: { type: "string" },
          description: "Additional fields that should be normalized as YYYY-MM-DD dates.",
        },
        validTypes: {
          type: "array",
          items: { type: "string" },
          description: "Additional valid note types for this vault.",
        },
        semanticExemptPaths: {
          type: "array",
          items: { type: "string" },
          description: "Vault-relative glob patterns that skip semantic frontmatter validation/fix/migration.",
        },
        keyOrder: {
          type: "array",
          items: { type: "string" },
          description: "Preferred frontmatter key order when rewriting notes.",
        },
        strictUnknownFields: {
          type: "boolean",
          description: "When true, unknown fields are reported as info diagnostics.",
        },
      },
    },
    null,
    2,
  ) + "\n";
}
