import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extractWikilinks } from "../utils/links.js";

export interface ExtractedMemoryEntities {
  readonly filePaths: readonly string[];
  readonly symbols: readonly string[];
  readonly wikilinks: readonly string[];
}

export interface CausalTriadNoteInput {
  readonly id: string;
  readonly recordId: string;
  readonly recordKind: string;
  readonly title: string;
  readonly sessionId: string | null;
  readonly filePaths: readonly string[];
  readonly symbols: readonly string[];
}

export interface CausalTriadLinkedNote {
  readonly recordId: string;
  readonly title: string;
  readonly score: number;
}

export interface CausalTriadSummary {
  readonly anchorMistakeId: string;
  readonly mistakeTitle: string;
  readonly relatedInsightIds: readonly string[];
  readonly relatedAdrIds: readonly string[];
  readonly relatedInsights: readonly CausalTriadLinkedNote[];
  readonly relatedAdrs: readonly CausalTriadLinkedNote[];
  readonly sharedContext: readonly string[];
}

const GENERIC_KIND_PREFIXES = new Set([
  "adr",
  "insight",
  "mistake",
  "session-log",
  "session log",
  "session",
  "note",
  "decision",
]);

const GENERIC_SECTION_HEADING_RE =
  /^(?:root\s+causes?|causes?|context|background|problem|problem\s+statement|decisions?|consequences|summary|overview|details|prevention|fix|fixes|solution|solutions|resolution|impact|notes|rationale|motivation|implementation|verification)(?:\s*(?:&|and|\/|-|\+)\s*(?:prevention|fix|fixes|solution|solutions|resolution|mitigation|impact|consequences|verification|details))?$/iu;

export function isGenericSectionHeading(rawHeading: string): boolean {
  const cleaned = String(rawHeading ?? "")
    .trim()
    .replace(/^#+\s*/u, "")
    .replace(/:+$/u, "")
    .trim();
  if (!cleaned) return true;
  if (GENERIC_KIND_PREFIXES.has(cleaned.toLowerCase())) return true;
  return GENERIC_SECTION_HEADING_RE.test(cleaned);
}

export function stripLeadingKindPrefix(rawTitle: string): string {
  const trimmed = String(rawTitle ?? "").trim();
  const colonIdx = trimmed.indexOf(": ");
  if (colonIdx <= 0) return trimmed;
  const prefix = trimmed.slice(0, colonIdx).trim().toLowerCase();
  if (!GENERIC_KIND_PREFIXES.has(prefix)) return trimmed;
  const remainder = trimmed.slice(colonIdx + 2).trim();
  return remainder.length > 0 ? remainder : trimmed;
}

export function deriveCleanNoteTitleFromFields(
  fields: {
    readonly title?: unknown;
    readonly summary?: unknown;
    readonly text?: unknown;
    readonly body?: unknown;
    readonly preserveExplicitKindPrefixInHeading?: boolean;
  },
  recordId: string,
): { readonly title: string; readonly cleanSummary: string } {
  const summary = String(fields.summary ?? fields.text ?? "").trim();
  const body = typeof fields.body === "string" ? fields.body : "";
  const explicitTitle = typeof fields.title === "string" ? fields.title.trim() : "";

  let title = "";
  if (explicitTitle.length > 0 && !isGenericSectionHeading(explicitTitle)) {
    title = explicitTitle;
  } else {
    const h1Match = /^\s*#\s+([^\r\n]+)/mu.exec(body);
    const h1Candidate = h1Match?.[1]?.trim() ?? "";
    if (h1Candidate.length > 0 && !isGenericSectionHeading(h1Candidate)) {
      title = fields.preserveExplicitKindPrefixInHeading
        ? h1Candidate
        : stripLeadingKindPrefix(h1Candidate);
    } else {
      const colonIdx = summary.indexOf(": ");
      if (colonIdx > 0) {
        const prefix = summary.slice(0, colonIdx).trim();
        if (!GENERIC_KIND_PREFIXES.has(prefix.toLowerCase()) && !isGenericSectionHeading(prefix)) {
          title = prefix;
        } else {
          const afterPrefix = summary.slice(colonIdx + 2).trim();
          const secondColon = afterPrefix.indexOf(": ");
          if (secondColon > 0) {
            const candidate = afterPrefix.slice(0, secondColon).trim();
            title = !isGenericSectionHeading(candidate) ? candidate : afterPrefix;
          } else {
            title = afterPrefix || summary;
          }
        }
      } else {
        title = summary || recordId;
      }
    }
  }

  const normalizedTitle = title || recordId;
  const strippedSummary = stripLeadingKindPrefix(summary);
  const cleanSummary = strippedSummary.startsWith(`${normalizedTitle}: `)
    ? strippedSummary.slice(normalizedTitle.length + 2).trim()
    : summary.startsWith(`${normalizedTitle}: `)
      ? summary.slice(normalizedTitle.length + 2).trim()
      : strippedSummary || summary;

  return {
    title: normalizedTitle,
    cleanSummary,
  };
}

const PROSE_FALSE_POSITIVE_PATHS = new Set([
  "e.g",
  "e.g.",
  "i.e",
  "i.e.",
  "etc",
  "etc.",
  "vs",
  "vs.",
  "cf",
  "cf.",
  "fig",
  "fig.",
  "node.js",
  "next.js",
  "react.js",
  "vue.js",
  "nuxt.js",
  "express.js",
  "nest.js",
  "bun.js",
  "deno.js",
  "three.js",
  "chart.js",
  "d3.js",
  "vite.js",
]);

const WELL_KNOWN_ROOT_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "tsconfig.test.json",
  "readme.md",
  "agents.md",
  "gemini.md",
  "claude.md",
  "opencode.json",
  ".mcp.json",
  ".rules",
  ".windsurfrules",
]);

const BUILD_OUTPUT_PREFIXES = ["dist/", "build/", "out/", "coverage/"] as const;
const IGNORED_PATH_PREFIXES = ["memory/", "memory-v2/", "node_modules/", ".git/", ".memory-mcp/"] as const;

const STOP_SYMBOLS = new Set([
  "null",
  "undefined",
  "true",
  "false",
  "NaN",
  "Infinity",
  "void",
  "any",
  "unknown",
  "never",
  "string",
  "number",
  "boolean",
  "object",
  "symbol",
  "bigint",
  "const",
  "let",
  "var",
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "return",
  "async",
  "await",
  "import",
  "export",
  "default",
  "from",
  "this",
  "super",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "Summary",
  "Context",
  "Decision",
  "Mistake",
  "Insight",
  "Session",
  "Status",
  "Result",
  "Action",
  "Target",
  "Source",
  "Notes",
  "Title",
  "Overview",
  "Details",
  "Date",
  "JSON",
  "Math",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Array",
  "Object",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "String",
  "Number",
  "Boolean",
  "Buffer",
  "Record",
  "Readonly",
  "ReadonlyArray",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "RegExp",
  "URL",
  "URLSearchParams",
  "WebUI",
  "TypeScript",
  "JavaScript",
  "Markdown",
  "SQLite",
  "GitHub",
  "GitLab",
  "Windows",
  "Linux",
  "macOS",
  "PowerShell",
  "OpenCode",
  "Windsurf",
  "Cursor",
  "Antigravity",
  "Claude",
  "ClaudeCode",
  "NodeJs",
  "React",
  "TanStack",
  "Lucide",
  "Shadcn",
  "ADR",
  "MCP",
  "API",
  "URL",
  "URI",
  "CLI",
  "SQL",
  "CSS",
  "SVG",
  "HTML",
  "HTTP",
  "HTTPS",
  "UUID",
  "UTF8",
  "SHA256",
  "HMAC",
  "CSRF",
  "CORS",
  "XSS",
  "CSP",
  "LRU",
  "IDF",
  "TDD",
  "MVC",
  "main",
  "master",
  "HEAD",
  "develop",
  "trunk",
  "origin",
  "upstream",
  "branch",
  "commit",
  "merge",
  "rebase",
  "squash",
  "Problem",
  "Solution",
  "Root",
  "Cause",
  "Causes",
  "Prevention",
  "Fix",
  "Fixes",
  "Background",
  "Consequences",
  "Rationale",
  "Impact",
  "Verification",
]);

const WORKSPACE_PATH_RE =
  /(?:^|[\s`'":(\[<])((?:\.[\\/])?(?:(?:src|tests|scripts|docs|app|routes|config|packages|lib|\.github|\.agents|\.cursor|\.windsurf|\.antigravity|\.claude|\.vscode|\.codex|\.zed|\.superpowers|dist|build|out|coverage)[\\/][A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,10}|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdc|sql|sqlite|py|php|go|rs|java|toml|yaml|yml|css|html|sh|ps1)))(?=$|[\s`'");,\]>!?]|:\d|\.(?:\s|$))/gu;

function normalizeCandidatePath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/[#?].*$/u, "")
    .replace(/:L?\d+(?:-L?\d+)?$/u, "")
    .trim();
}

function isAcceptablePath(candidate: string, projectRoot?: string): boolean {
  if (candidate.length < 3 || candidate.length > 180) return false;
  if (candidate.startsWith("/") || candidate.startsWith("..") || candidate.includes("//")) {
    return false;
  }
  const lower = candidate.toLowerCase();
  if (PROSE_FALSE_POSITIVE_PATHS.has(lower)) return false;
  if (/^v?\d+(?:\.\d+)+$/iu.test(candidate)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(candidate)) return false;
  if (IGNORED_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;

  if (BUILD_OUTPUT_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    if (!projectRoot) return false;
    try {
      return existsSync(join(projectRoot, ...candidate.split("/")));
    } catch {
      return false;
    }
  }

  if (!candidate.includes("/")) {
    if (projectRoot) {
      try {
        return existsSync(join(projectRoot, candidate));
      } catch {
        return false;
      }
    }
    return WELL_KNOWN_ROOT_FILES.has(lower);
  }

  return true;
}

function isAcceptableSymbol(sym: string, filePathBasenames: ReadonlySet<string>): boolean {
  if (sym.length < 3 || sym.length > 64) return false;
  if (sym.includes("-") || sym.includes("/") || sym.includes("\\") || sym.includes(".")) {
    return false;
  }
  if (STOP_SYMBOLS.has(sym) || STOP_SYMBOLS.has(sym.toLowerCase())) {
    return false;
  }
  if (/^[A-Z0-9_]{1,5}$/u.test(sym)) {
    return false;
  }
  if (/^\d/u.test(sym)) {
    return false;
  }
  if (sym.startsWith("#")) {
    return /^#[a-z][a-z0-9]*[A-Z][A-Za-z0-9_]*$/u.test(sym);
  }
  if (filePathBasenames.has(sym.toLowerCase())) {
    return false;
  }
  return true;
}

export function extractMemoryEntities(
  rawText: string,
  options?: { readonly projectRoot?: string },
): ExtractedMemoryEntities {
  const text = String(rawText ?? "");
  const projectRoot = options?.projectRoot ? resolve(options.projectRoot) : undefined;
  const wikilinks = extractWikilinks(text);
  const filePaths = new Set<string>();

  // 1. Convert file:/// URIs inside projectRoot to workspace-relative forward-slash paths
  const withoutFileUris = text.replace(
    /\bfile:\/\/\/[^\s`'")>\]]+/giu,
    (matchedUri) => {
      if (projectRoot) {
        try {
          const cleanUri = matchedUri.replace(/[#?].*$/u, "");
          const absFile = resolve(fileURLToPath(cleanUri));
          const rel = relative(projectRoot, absFile).split(sep).join("/");
          if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
            const normalized = normalizeCandidatePath(rel);
            if (isAcceptablePath(normalized, projectRoot)) {
              filePaths.add(normalized);
            }
          }
        } catch {
          // Ignore malformed file:// URIs
        }
      }
      return " ";
    },
  );

  // 2. Strip external URLs and non-file URI schemes so URL segments never leak as file paths
  const sanitized = withoutFileUris.replace(
    /\b(?:https?|mailto|vscode|cursor|sidecar|conversation|data|javascript|ws|wss|ftp):[^\s`'")>\]]*/giu,
    " ",
  );

  // 3. Extract workspace paths with strict token boundaries
  for (const match of sanitized.matchAll(WORKSPACE_PATH_RE)) {
    const rawCandidate = match[1];
    if (!rawCandidate) continue;
    const normalized = normalizeCandidatePath(rawCandidate);
    if (isAcceptablePath(normalized, projectRoot)) {
      filePaths.add(normalized);
    }
  }

  const filePathBasenames = new Set<string>();
  for (const fp of filePaths) {
    const parts = fp.split("/");
    const base = parts[parts.length - 1] ?? fp;
    const stem = base.replace(/\.[A-Za-z0-9.]+$/u, "").toLowerCase();
    if (stem) filePathBasenames.add(stem);
  }

  // 4. Strip [[wikilinks]] before symbol scanning so prose titles don't pollute symbols
  const textForSymbols = sanitized.replace(/\[\[[^\]]+\]\]/gu, " ");
  const symbols = new Set<string>();

  for (const match of textForSymbols.matchAll(/`([#A-Za-z_][A-Za-z0-9_]{2,64})(?:\(\))?`/gu)) {
    const sym = match[1]?.trim() ?? "";
    if (isAcceptableSymbol(sym, filePathBasenames)) {
      symbols.add(sym);
    }
  }

  for (const match of textForSymbols.matchAll(/#[a-z][a-z0-9]*[A-Z][A-Za-z0-9_]*/gu)) {
    const sym = match[0]?.trim() ?? "";
    if (isAcceptableSymbol(sym, filePathBasenames)) {
      symbols.add(sym);
    }
  }

  for (const match of textForSymbols.matchAll(
    /\b(?:[a-z][a-z0-9]*[A-Z][A-Za-z0-9_]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9_]*)\b/gu,
  )) {
    const sym = match[0]?.trim() ?? "";
    if (isAcceptableSymbol(sym, filePathBasenames)) {
      symbols.add(sym);
    }
  }

  return Object.freeze({
    filePaths: Object.freeze([...filePaths].slice(0, 32)),
    symbols: Object.freeze([...symbols].slice(0, 32)),
    wikilinks: Object.freeze(wikilinks.slice(0, 32)),
  });
}

export function computeCausalTriads<TNote extends CausalTriadNoteInput>(
  scoredEntries: ReadonlyArray<{ readonly note: TNote; readonly score: number }>,
  allNotes: ReadonlyArray<TNote>,
): {
  readonly boostedEntries: Array<{ readonly note: TNote; readonly score: number }>;
  readonly causalTriads: ReadonlyArray<CausalTriadSummary>;
} {
  const corpusSize = allNotes.length;
  const symbolDf = new Map<string, number>();
  for (const note of allNotes) {
    for (const sym of new Set(note.symbols)) {
      symbolDf.set(sym, (symbolDf.get(sym) ?? 0) + 1);
    }
  }

  const isInformativeSymbol = (sym: string): boolean => {
    const df = symbolDf.get(sym) ?? 0;
    if (corpusSize > 3 && df / corpusSize > 0.4) {
      return false;
    }
    return true;
  };

  const symbolBoostWeight = (sym: string): number => {
    const df = symbolDf.get(sym) ?? 1;
    const idf = Math.max(0.5, Math.log((corpusSize + 1) / (df + 1)) + 0.5);
    return Math.round(120 * Math.min(2.0, idf));
  };

  const scoreById = new Map<string, number>();
  for (const entry of scoredEntries) {
    scoreById.set(entry.note.recordId, entry.score);
  }

  const matchedAnchors = scoredEntries
    .filter(
      (e) =>
        e.score > 0 &&
        (e.note.recordKind === "mistake" ||
          e.note.recordKind === "adr" ||
          e.note.recordKind === "insight"),
    )
    .map((e) => e.note);

  for (const anchor of matchedAnchors) {
    for (const candidate of allNotes) {
      if (candidate.recordId === anchor.recordId) continue;
      const sharedFiles = candidate.filePaths.filter((fp) => anchor.filePaths.includes(fp));
      const sharedSymbols = candidate.symbols.filter(
        (sym) => anchor.symbols.includes(sym) && isInformativeSymbol(sym),
      );
      const sameSession =
        anchor.sessionId !== null &&
        anchor.sessionId.length > 0 &&
        candidate.sessionId === anchor.sessionId;
      if (sharedFiles.length > 0 || sharedSymbols.length > 0 || sameSession) {
        const symBoost =
          sharedSymbols.length > 0
            ? Math.max(...sharedSymbols.map((s) => symbolBoostWeight(s)))
            : 0;
        const boost =
          (sharedFiles.length > 0 ? 180 : 0) + symBoost + (sameSession ? 160 : 0);
        scoreById.set(candidate.recordId, (scoreById.get(candidate.recordId) ?? 0) + boost);
      }
    }
  }

  const boostedEntries = scoredEntries.map((entry) => ({
    note: entry.note,
    score: scoreById.get(entry.note.recordId) ?? entry.score,
  }));

  const matchedMistakes = boostedEntries
    .filter((e) => e.score > 0 && e.note.recordKind === "mistake")
    .map((e) => e.note);

  const causalTriads: CausalTriadSummary[] = [];
  for (const mistake of matchedMistakes) {
    const relatedInsightsList: CausalTriadLinkedNote[] = [];
    const relatedAdrsList: CausalTriadLinkedNote[] = [];
    const sharedFileSet = new Set<string>();
    const sharedSymbolSet = new Set<string>();
    const sharedSessionSet = new Set<string>();
    for (const other of allNotes) {
      if (other.recordId === mistake.recordId) continue;
      if (other.recordKind !== "insight" && other.recordKind !== "adr") continue;
      const sharedFiles = other.filePaths.filter((fp) => mistake.filePaths.includes(fp));
      const sharedSymbols = other.symbols.filter(
        (sym) => mistake.symbols.includes(sym) && isInformativeSymbol(sym),
      );
      const sameSession =
        mistake.sessionId !== null &&
        mistake.sessionId.length > 0 &&
        other.sessionId === mistake.sessionId;
      if (sharedFiles.length === 0 && sharedSymbols.length === 0 && !sameSession) continue;

      const pairScore =
        sharedFiles.length * 200 +
        sharedSymbols.reduce((acc, s) => acc + symbolBoostWeight(s), 0) +
        (sameSession ? 160 : 0);

      for (const f of sharedFiles) sharedFileSet.add(`file:${f}`);
      for (const s of sharedSymbols) sharedSymbolSet.add(`symbol:${s}`);
      if (sameSession) sharedSessionSet.add(`session:${mistake.sessionId}`);

      const linkedEntry: CausalTriadLinkedNote = Object.freeze({
        recordId: other.recordId,
        title: stripLeadingKindPrefix(other.title) || other.recordId,
        score: pairScore,
      });
      if (other.recordKind === "insight") relatedInsightsList.push(linkedEntry);
      else if (other.recordKind === "adr") relatedAdrsList.push(linkedEntry);
    }
    if (relatedInsightsList.length > 0 || relatedAdrsList.length > 0) {
      relatedInsightsList.sort(
        (a, b) => b.score - a.score || a.recordId.localeCompare(b.recordId),
      );
      relatedAdrsList.sort(
        (a, b) => b.score - a.score || a.recordId.localeCompare(b.recordId),
      );
      const prioritizedContext = [
        ...sharedFileSet,
        ...sharedSymbolSet,
        ...sharedSessionSet,
      ];
      causalTriads.push(
        Object.freeze({
          anchorMistakeId: mistake.recordId,
          mistakeTitle: stripLeadingKindPrefix(mistake.title) || mistake.title,
          relatedInsightIds: Object.freeze(relatedInsightsList.map((i) => i.recordId)),
          relatedAdrIds: Object.freeze(relatedAdrsList.map((a) => a.recordId)),
          relatedInsights: Object.freeze(relatedInsightsList),
          relatedAdrs: Object.freeze(relatedAdrsList),
          sharedContext: Object.freeze(prioritizedContext),
        }),
      );
    }
  }

  return {
    boostedEntries,
    causalTriads: Object.freeze(causalTriads),
  };
}
