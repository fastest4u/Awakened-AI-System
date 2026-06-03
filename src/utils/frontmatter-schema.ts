import type { FrontmatterDiagnostic } from "./frontmatter.js";
import { REQUIRED_FIELDS_BY_TYPE, VALID_NOTE_TYPES } from "./memory-format.js";

/**
 * Bumped whenever the canonical frontmatter shape changes in a way that needs
 * migration. Notes without a `schema-version` field are treated as legacy (0).
 */
export const FRONTMATTER_SCHEMA_VERSION = "1";

export interface FrontmatterSchema {
  version: string;
  validTypes: readonly string[];
  requiredFieldsByType: Record<string, string[]>;
  /** lower-cased alias -> canonical (kebab-case) key. */
  aliases: Record<string, string>;
  /** Canonical fields whose value must be a YYYY-MM-DD date string. */
  dateFields: readonly string[];
  /** Preferred key order used when the fixer rewrites frontmatter. */
  keyOrder: readonly string[];
  /** When true, fields outside the known set are reported as info. */
  strictUnknownFields: boolean;
}

/**
 * Option C (hybrid) alias map: canonical keys stay kebab-case to match the
 * existing vault, while snake_case / camelCase variants are accepted on read
 * and rewritten on fix. Keys are matched case-insensitively.
 */
const DEFAULT_ALIASES: Record<string, string> = {
  created_at: "created",
  createdat: "created",
  updated_at: "updated",
  updatedat: "updated",
  last_verified: "last-verified",
  lastverified: "last-verified",
  decision_date: "decision-date",
  decisiondate: "decision-date",
  session_date: "session-date",
  sessiondate: "session-date",
  occurred_date: "occurred-date",
  occurreddate: "occurred-date",
  derived_from: "derived-from",
  derivedfrom: "derived-from",
  source_author: "source-author",
  sourceauthor: "source-author",
  source_date: "source-date",
  sourcedate: "source-date",
  verified_by: "verified-by",
  verifiedby: "verified-by",
  duration_minutes: "duration-minutes",
  durationminutes: "duration-minutes",
  schema_version: "schema-version",
  schemaversion: "schema-version",
};

const DEFAULT_DATE_FIELDS = [
  "created",
  "updated",
  "last-verified",
  "decision-date",
  "session-date",
  "occurred-date",
  "source-date",
] as const;

const DEFAULT_KEY_ORDER = [
  "id",
  "title",
  "type",
  "status",
  "priority",
  "project",
  "severity",
  "confidence",
  "agent",
  "area",
  "language",
  "source",
  "source-author",
  "source-date",
  "verified-by",
  "last-verified",
  "decision-date",
  "session-date",
  "occurred-date",
  "duration-minutes",
  "supersedes",
  "derived-from",
  "outcomes",
  "aliases",
  "tags",
  "schema-version",
  "created",
  "updated",
] as const;

let cachedDefault: FrontmatterSchema | undefined;

/** Built-in, project-agnostic schema. Cached and frozen. */
export function defaultFrontmatterSchema(): FrontmatterSchema {
  if (!cachedDefault) {
    cachedDefault = Object.freeze({
      version: FRONTMATTER_SCHEMA_VERSION,
      validTypes: VALID_NOTE_TYPES,
      requiredFieldsByType: REQUIRED_FIELDS_BY_TYPE,
      aliases: DEFAULT_ALIASES,
      dateFields: DEFAULT_DATE_FIELDS,
      keyOrder: DEFAULT_KEY_ORDER,
      strictUnknownFields: false,
    }) as FrontmatterSchema;
  }
  return cachedDefault;
}

/**
 * Merge optional partial overrides (e.g. from a project/global config file)
 * over the built-in schema. Arrays/maps are merged, not replaced wholesale, so
 * a project can add aliases without losing the defaults.
 */
export function mergeFrontmatterSchema(overrides?: Partial<FrontmatterSchema> | null): FrontmatterSchema {
  const base = defaultFrontmatterSchema();
  if (!overrides) return base;
  return {
    version: overrides.version ?? base.version,
    validTypes: overrides.validTypes ? Array.from(new Set([...base.validTypes, ...overrides.validTypes])) : base.validTypes,
    requiredFieldsByType: { ...base.requiredFieldsByType, ...(overrides.requiredFieldsByType ?? {}) },
    aliases: { ...base.aliases, ...lowerCaseKeys(overrides.aliases) },
    dateFields: overrides.dateFields ? Array.from(new Set([...base.dateFields, ...overrides.dateFields])) : base.dateFields,
    keyOrder: overrides.keyOrder ?? base.keyOrder,
    strictUnknownFields: overrides.strictUnknownFields ?? base.strictUnknownFields,
  };
}

function lowerCaseKeys(map?: Record<string, string>): Record<string, string> {
  if (!map) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) out[key.toLowerCase()] = value;
  return out;
}

/** True for a strict canonical `YYYY-MM-DD` date string. */
export function isCanonicalDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Coerce a Date object or ISO-ish string to a canonical `YYYY-MM-DD` string.
 * Returns null when the value is not a recognizable date (so callers can flag
 * it rather than silently inventing a date).
 */
export function normalizeDateValue(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
    if (!match) return null;
    const iso = `${match[1]}-${match[2]}-${match[3]}`;
    const date = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : iso;
  }
  return null;
}

export interface CanonicalizeResult {
  data: Record<string, unknown>;
  changes: FrontmatterDiagnostic[];
}

/**
 * Resolve aliases to canonical keys, normalize date values to strings, and
 * coerce a `tags` string into an array. Returns the canonical data plus an
 * info-level change log (used by the auto-fixer and reports). Pure: never
 * mutates the input.
 */
export function canonicalizeFrontmatter(
  input: Record<string, unknown>,
  schema: FrontmatterSchema = defaultFrontmatterSchema(),
): CanonicalizeResult {
  const data: Record<string, unknown> = {};
  const changes: FrontmatterDiagnostic[] = [];

  for (const [rawKey, value] of Object.entries(input ?? {})) {
    const canonical = schema.aliases[rawKey.toLowerCase()] ?? rawKey;
    if (canonical !== rawKey) {
      changes.push({
        code: "FIELD_ALIASED",
        severity: "info",
        field: rawKey,
        message: `Field '${rawKey}' canonicalized to '${canonical}'.`,
        suggestion: `Rename '${rawKey}' to '${canonical}'.`,
        autoFixAvailable: true,
      });
      // When both the alias and the canonical key are present, keep canonical.
      if (canonical in data || canonical in input) continue;
    }
    data[canonical] = value;
  }

  for (const field of schema.dateFields) {
    if (!(field in data)) continue;
    const original = data[field];
    const normalized = normalizeDateValue(original);
    if (normalized === null) continue;
    const wasString = typeof original === "string";
    if (!wasString || original !== normalized) {
      changes.push({
        code: "DATE_NORMALIZED",
        severity: "info",
        field,
        message: `Date field '${field}' normalized to '${normalized}'.`,
        suggestion: `Quote the value as "${normalized}" (YYYY-MM-DD) to keep it a string.`,
        autoFixAvailable: true,
      });
    }
    data[field] = normalized;
  }

  if (typeof data.tags === "string") {
    const parts = (data.tags as string).split(",").map((part) => part.trim()).filter(Boolean);
    changes.push({
      code: "TAGS_COERCED",
      severity: "info",
      field: "tags",
      message: "String 'tags' coerced to a list.",
      suggestion: "Use a YAML list for tags.",
      autoFixAvailable: true,
    });
    data.tags = parts.length ? parts : [data.tags];
  }

  return { data, changes };
}

export interface ValidateContext {
  /** Note type when known from the path; data.type takes precedence. */
  type?: string;
  path?: string;
  hasFrontmatter: boolean;
  /** Root meta files (README/AGENTS) are allowed to omit frontmatter. */
  isExempt?: boolean;
}

const AUTO_FIXABLE_REQUIRED = new Set(["created", "updated", "status", "schema-version"]);

/**
 * Validate already-canonicalized frontmatter against the schema. Returns
 * diagnostics; never throws. Date/tag *shape* problems are surfaced here while
 * date/tag *normalizations* come from canonicalizeFrontmatter.
 */
export function validateFrontmatter(
  data: Record<string, unknown>,
  context: ValidateContext,
  schema: FrontmatterSchema = defaultFrontmatterSchema(),
): FrontmatterDiagnostic[] {
  const diagnostics: FrontmatterDiagnostic[] = [];

  if (!context.hasFrontmatter) {
    if (!context.isExempt) {
      diagnostics.push({
        code: "MISSING_FRONTMATTER",
        severity: "warning",
        message: "Note has no frontmatter block.",
        suggestion: "Add a frontmatter block with at least title, type, created, and updated.",
        autoFixAvailable: true,
      });
    }
    return diagnostics;
  }

  const type = String(data.type ?? context.type ?? "note");
  if (data.type !== undefined && !schema.validTypes.includes(type)) {
    diagnostics.push({
      code: "INVALID_TYPE",
      severity: "error",
      field: "type",
      message: `Invalid note type: ${type}`,
      suggestion: `Use one of: ${schema.validTypes.join(", ")}.`,
      autoFixAvailable: false,
    });
  }

  const required = schema.requiredFieldsByType[type] ?? schema.requiredFieldsByType.default;
  for (const field of required) {
    const value = data[field];
    const missing = value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
    if (missing) {
      diagnostics.push({
        code: "MISSING_REQUIRED_FIELD",
        severity: "error",
        field,
        message: `Missing required field for type ${type}: ${field}`,
        suggestion: AUTO_FIXABLE_REQUIRED.has(field)
          ? `Add '${field}' (the fixer can fill a safe default).`
          : `Provide a value for '${field}'.`,
        autoFixAvailable: AUTO_FIXABLE_REQUIRED.has(field),
      });
    }
  }

  for (const field of schema.dateFields) {
    if (!(field in data) || data[field] === undefined) continue;
    if (!isCanonicalDate(data[field])) {
      diagnostics.push({
        code: "INVALID_DATE_FORMAT",
        severity: "warning",
        field,
        message: `Field '${field}' is not in YYYY-MM-DD format.`,
        suggestion: "Use a quoted YYYY-MM-DD date string.",
        autoFixAvailable: normalizeDateValue(data[field]) !== null,
      });
    }
  }

  if (data.tags !== undefined && !Array.isArray(data.tags)) {
    diagnostics.push({
      code: "INVALID_TAGS",
      severity: "warning",
      field: "tags",
      message: "'tags' should be a YAML list.",
      suggestion: "Convert tags to a list of strings.",
      autoFixAvailable: typeof data.tags === "string",
    });
  }

  if (schema.strictUnknownFields) {
    const known = new Set<string>([...schema.keyOrder, ...required]);
    for (const key of Object.keys(data)) {
      if (!known.has(key)) {
        diagnostics.push({
          code: "UNKNOWN_FIELD",
          severity: "info",
          field: key,
          message: `Unknown frontmatter field '${key}'.`,
          suggestion: "Remove it or move the information into the note body.",
          autoFixAvailable: false,
        });
      }
    }
  }

  return diagnostics;
}
