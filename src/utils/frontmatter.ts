import matter from "gray-matter";

/**
 * Severity taxonomy for every frontmatter / vault diagnostic.
 *
 * - info: advisory normalization (BOM, alias, date quoting) — never blocks.
 * - warning: should be fixed but does not corrupt retrieval.
 * - error: schema violation (missing required field, invalid type).
 * - critical: the file cannot be parsed at all (unclosed / invalid YAML) and
 *   would crash naive read paths.
 */
export type FrontmatterSeverity = "info" | "warning" | "error" | "critical";

/**
 * Single source of truth for every frontmatter diagnostic code. Emitters, the
 * fixer, reports, tests, and docs all reference these so a typo cannot silently
 * diverge — `FrontmatterDiagnostic.code` is typed to this union, so an unknown
 * code is a compile error.
 */
export const FRONTMATTER_CODES = {
  BOM: "FRONTMATTER_BOM",
  NOT_AT_START: "FRONTMATTER_NOT_AT_START",
  UNCLOSED: "FRONTMATTER_UNCLOSED",
  EMPTY: "FRONTMATTER_EMPTY",
  MULTIPLE_BLOCKS: "FRONTMATTER_MULTIPLE_BLOCKS",
  DUPLICATE_KEY: "FRONTMATTER_DUPLICATE_KEY",
  BAD_INDENTATION: "FRONTMATTER_BAD_INDENTATION",
  UNQUOTED_VALUE: "FRONTMATTER_UNQUOTED_VALUE",
  INVALID_YAML: "FRONTMATTER_INVALID_YAML",
  FIELD_ALIASED: "FIELD_ALIASED",
  DATE_NORMALIZED: "DATE_NORMALIZED",
  TAGS_COERCED: "TAGS_COERCED",
  MISSING_FRONTMATTER: "MISSING_FRONTMATTER",
  INVALID_TYPE: "INVALID_TYPE",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  INVALID_DATE_FORMAT: "INVALID_DATE_FORMAT",
  INVALID_TAGS: "INVALID_TAGS",
  UNKNOWN_FIELD: "UNKNOWN_FIELD",
} as const;

export type FrontmatterCode = (typeof FRONTMATTER_CODES)[keyof typeof FRONTMATTER_CODES];

export interface FrontmatterDiagnostic {
  /** Stable machine code from FRONTMATTER_CODES, e.g. FRONTMATTER_UNCLOSED. */
  code: FrontmatterCode;
  severity: FrontmatterSeverity;
  /** Human-readable, suggestion-oriented message. */
  message: string;
  /** 1-based line number in the source file when known. */
  line?: number;
  /** Frontmatter field the diagnostic relates to, when applicable. */
  field?: string;
  /** Concrete fix hint for a human or the auto-fixer. */
  suggestion?: string;
  /** True when the safe auto-fixer can resolve this without guessing. */
  autoFixAvailable: boolean;
}

export interface ParsedFrontmatter {
  /** True when a `---` delimited block was present at (or near) the top. */
  hasFrontmatter: boolean;
  /** Parsed YAML mapping. `{}` when missing or unparseable. */
  data: Record<string, unknown>;
  /** Markdown body with the frontmatter removed. */
  body: string;
  /** The original, unmodified source text. */
  raw: string;
  /** Dominant line ending of the source ("\r\n" if any CRLF present, else "\n"). */
  eol: string;
  /** Top-level frontmatter key (as written) -> 1-based source line number. */
  fieldLines: Record<string, number>;
  /** Structural diagnostics discovered while parsing. Never throws. */
  diagnostics: FrontmatterDiagnostic[];
}

/** A line that is exactly `---` (allowing trailing whitespace / CR). */
const DELIMITER = /^---[ \t]*\r?$/;

/**
 * Parse frontmatter from a markdown string WITHOUT EVER THROWING.
 *
 * gray-matter (js-yaml under the hood) throws a YAMLException on unclosed
 * blocks, duplicate keys, unquoted colons and bad indentation. The historic
 * read paths called `matter()` directly, so a single malformed note crashed
 * the entire retrieval surface. This wrapper performs structural pre-checks on
 * the raw delimiters, isolates the YAML parse in a try/catch, classifies the
 * failure into an actionable diagnostic, and always returns a usable result.
 */
export function parseFrontmatter(input: unknown): ParsedFrontmatter {
  const raw = typeof input === "string" ? input : "";
  const diagnostics: FrontmatterDiagnostic[] = [];
  // Preserve the note's own line-ending style so a rewrite never silently
  // converts CRLF -> LF (the frontmatter block is serialized with LF and would
  // otherwise leave the file with mixed endings).
  const eol = /\r\n/.test(raw) ? "\r\n" : "\n";

  let content = raw;
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
    diagnostics.push({
      code: "FRONTMATTER_BOM",
      severity: "info",
      message: "File starts with a UTF-8 byte-order-mark that can confuse YAML parsers.",
      line: 1,
      suggestion: "Remove the leading BOM character and save the file as UTF-8 without BOM.",
      autoFixAvailable: true,
    });
  }

  const lines = content.split(/\r?\n/);
  const firstNonEmptyIdx = lines.findIndex((line) => line.trim().length > 0);

  // No content, or the first real line is not a delimiter -> structurally no
  // frontmatter. Whether that is a problem depends on note type/policy, which
  // is decided by validateFrontmatter, not here.
  if (firstNonEmptyIdx === -1 || !DELIMITER.test(lines[firstNonEmptyIdx])) {
    return { hasFrontmatter: false, data: {}, body: raw, raw, eol, fieldLines: {}, diagnostics };
  }

  const openIdx = firstNonEmptyIdx;
  const leadingBlank = openIdx > 0;
  if (leadingBlank) {
    diagnostics.push({
      code: "FRONTMATTER_NOT_AT_START",
      severity: "warning",
      message: "Frontmatter is preceded by blank lines, so gray-matter ignores it as body text.",
      line: 1,
      suggestion: "Remove the blank lines before the opening '---'.",
      autoFixAvailable: true,
    });
  }

  let closeIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i += 1) {
    if (DELIMITER.test(lines[i])) {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) {
    diagnostics.push({
      code: "FRONTMATTER_UNCLOSED",
      severity: "critical",
      message: "Frontmatter opens with '---' but is never closed.",
      line: openIdx + 1,
      suggestion: "Add a closing '---' line directly after the frontmatter fields.",
      autoFixAvailable: false,
    });
    return { hasFrontmatter: true, data: {}, body: raw, raw, eol, fieldLines: {}, diagnostics };
  }

  const innerLines = lines.slice(openIdx + 1, closeIdx);
  // Map each top-level key (column 0, no indentation) to its 1-based file line
  // so schema-layer diagnostics (invalid type/date/tags) can point at the field.
  const fieldLines: Record<string, number> = {};
  innerLines.forEach((innerLine, index) => {
    const match = /^([A-Za-z0-9_][A-Za-z0-9_-]*)\s*:/.exec(innerLine);
    if (match) fieldLines[match[1]] = openIdx + 2 + index;
  });
  if (innerLines.every((line) => line.trim().length === 0)) {
    diagnostics.push({
      code: "FRONTMATTER_EMPTY",
      severity: "info",
      message: "Frontmatter block is present but empty.",
      line: openIdx + 1,
      suggestion: "Add fields (title, type, created, updated) or remove the empty block.",
      autoFixAvailable: false,
    });
  }

  // Detect a second frontmatter-looking block at the very top of the body.
  const afterClose = lines.slice(closeIdx + 1);
  const nextNonEmpty = afterClose.findIndex((line) => line.trim().length > 0);
  if (nextNonEmpty !== -1 && DELIMITER.test(afterClose[nextNonEmpty])) {
    const hasSecondClose = afterClose.slice(nextNonEmpty + 1).some((line) => DELIMITER.test(line));
    if (hasSecondClose) {
      diagnostics.push({
        code: "FRONTMATTER_MULTIPLE_BLOCKS",
        severity: "warning",
        message: "Multiple frontmatter-like blocks found; only the first one is used.",
        line: closeIdx + 1 + nextNonEmpty + 1,
        suggestion: "Merge all fields into a single frontmatter block at the top of the file.",
        autoFixAvailable: false,
      });
    }
  }

  // gray-matter only recognizes frontmatter at byte 0, so feed it a copy that
  // starts exactly at the opening delimiter (after BOM / leading-blank fixes).
  const toParse = leadingBlank ? lines.slice(openIdx).join("\n") : content;
  try {
    // gray-matter caches results keyed by the input string; on a re-parse of an
    // identical malformed note it returns the cached (non-throwing, empty)
    // result instead of throwing again, which would silently drop a critical
    // diagnostic the second time. Clear the cache so parsing is idempotent.
    // (clearCache exists at runtime but is absent from gray-matter's types.)
    (matter as unknown as { clearCache?: () => void }).clearCache?.();
    const result = matter(toParse);
    const data = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {};
    return { hasFrontmatter: true, data, body: result.content ?? "", raw, eol, fieldLines, diagnostics };
  } catch (error) {
    diagnostics.push(classifyYamlError(error, openIdx));
    return { hasFrontmatter: true, data: {}, body: lines.slice(closeIdx + 1).join("\n"), raw, eol, fieldLines, diagnostics };
  }
}

/** Map a thrown js-yaml error to a specific, actionable diagnostic. */
function classifyYamlError(error: unknown, openIdx: number): FrontmatterDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const mark = (error as { mark?: { line?: number } } | null)?.mark;
  // mark.line is 0-based within the YAML body (which begins on the file line
  // AFTER the opening '---'). Convert to a 1-based file line.
  const line = typeof mark?.line === "number" ? openIdx + 2 + mark.line : openIdx + 2;

  if (/duplicated mapping key/i.test(message)) {
    return {
      code: "FRONTMATTER_DUPLICATE_KEY",
      severity: "critical",
      message: "Duplicate key in frontmatter YAML.",
      line,
      suggestion: "Remove the duplicated key so each key appears only once.",
      autoFixAvailable: false,
    };
  }
  if (/bad indentation/i.test(message)) {
    return {
      code: "FRONTMATTER_BAD_INDENTATION",
      severity: "critical",
      message: "Bad indentation in frontmatter YAML.",
      line,
      suggestion: "Use consistent 2-space indentation for nested values and list items.",
      autoFixAvailable: false,
    };
  }
  if (/mapping values are not allowed|incomplete explicit mapping pair|can not read|unexpected end|end of the stream|unexpected/i.test(message)) {
    return {
      code: "FRONTMATTER_UNQUOTED_VALUE",
      severity: "critical",
      message: "A value likely contains an unquoted special character such as ':'.",
      line,
      suggestion: 'Wrap values containing ":" or other special characters in double quotes, e.g. title: "API: Auth Flow".',
      autoFixAvailable: false,
    };
  }
  return {
    code: "FRONTMATTER_INVALID_YAML",
    severity: "critical",
    message: `Frontmatter YAML could not be parsed: ${message}`,
    line,
    suggestion: "Check the YAML syntax (indentation, quotes, and colons).",
    autoFixAvailable: false,
  };
}

/**
 * Serialize a single scalar for YAML output. Numbers/booleans pass through;
 * any string that would not round-trip as the same string is double-quoted:
 * date-like values (no Date coercion), values containing ':' or '#' (an
 * unquoted '#' starts a comment and silently truncates the value on the next
 * parse), leading/trailing whitespace, boolean/null-looking keywords,
 * number-looking strings, and values starting with a YAML indicator character.
 */
export function yamlScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) {
    return JSON.stringify(Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10));
  }
  const str = String(value ?? "");
  return needsYamlQuoting(str) ? JSON.stringify(str) : str;
}

/** js-yaml (1.1 schema) parses these back as booleans/null instead of strings. */
const YAML_KEYWORD_LIKE = /^(?:true|false|yes|no|on|off|null|~)$/i;
/** Int/float shapes (with optional '_' separators and exponent). */
const YAML_NUMBER_LIKE = /^[+-]?(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]*\d)(?:[eE][+-]?\d+)?$/;
/** Special numeric forms: .inf/.nan and hex/octal/binary prefixes. */
const YAML_SPECIAL_NUMBER_LIKE = /^(?:[+-]?\.inf|\.nan|[+-]?0[xob][0-9a-fA-F_]+)$/i;
/** A YAML indicator in the first character makes a plain scalar unsafe. */
const YAML_LEADING_INDICATOR = /^[-?\[\]{}&*!|>%@`"']/;
/** Conservative plain-scalar whitelist; NOTE: '#' is deliberately excluded. */
const YAML_SAFE_PLAIN = /^[a-zA-Z0-9_./@ -]+$/;

function needsYamlQuoting(str: string): boolean {
  if (str.length === 0 || str !== str.trim()) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return true;
  if (str.includes(":") || str.includes("#")) return true;
  if (YAML_LEADING_INDICATOR.test(str)) return true;
  if (YAML_KEYWORD_LIKE.test(str) || YAML_NUMBER_LIKE.test(str) || YAML_SPECIAL_NUMBER_LIKE.test(str)) return true;
  return !YAML_SAFE_PLAIN.test(str);
}

function orderedKeys(keys: string[], keyOrder: readonly string[]): string[] {
  const known = keyOrder.filter((key) => keys.includes(key));
  const rest = keys.filter((key) => !keyOrder.includes(key));
  return [...known, ...rest];
}

/** Serialize a frontmatter mapping to a `---` block WITHOUT a trailing newline. */
export function serializeFrontmatter(data: Record<string, unknown>, keyOrder: readonly string[] = []): string {
  const lines = ["---"];
  for (const key of orderedKeys(Object.keys(data), keyOrder)) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
      }
      continue;
    }
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Rebuild a full note from canonical frontmatter data and a markdown body.
 *
 * Only the frontmatter block is reshaped. The body is preserved as-is except
 * for a leading BOM and the blank line(s) that conventionally separate the
 * frontmatter from the body \u2014 leading spaces/tabs (e.g. an indented code block)
 * are NOT stripped. The whole result is emitted with the note's own dominant
 * line ending so a CRLF note is never silently downgraded to LF.
 */
export function buildNoteContent(
  data: Record<string, unknown>,
  body: string,
  keyOrder: readonly string[] = [],
  eol: string = "\n",
): string {
  const frontmatterBlock = serializeFrontmatter(data, keyOrder);
  // Strip a leading BOM and only the leading newline separator(s); keep any
  // leading horizontal whitespace and the rest of the body byte-for-byte.
  const cleanBody = body.replace(/^\uFEFF/, "").replace(/^(?:\r?\n)+/, "");
  const assembled = cleanBody.length
    ? `${frontmatterBlock}\n\n${cleanBody}${cleanBody.endsWith("\n") ? "" : "\n"}`
    : `${frontmatterBlock}\n`;
  // Normalize to a single, consistent line ending (the note's own) so we never
  // leave the file with mixed CRLF/LF terminators.
  const lf = assembled.replace(/\r\n/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, eol);
}
