import { yamlScalar } from "./frontmatter.js";

export const VALID_NOTE_TYPES = [
  "note",
  "index",
  "moc",
  "dashboard",
  "reference",
  "rules",
  "glossary",
  "identity",
  "goals",
  "adr",
  "session-log",
  "component",
  "source",
  "insight",
  "mistake",
  "runbook",
] as const;

export type MemoryNoteType = (typeof VALID_NOTE_TYPES)[number];

export const REQUIRED_FIELDS_BY_TYPE: Record<string, string[]> = {
  default: ["title", "type", "created", "updated"],
  adr: ["title", "type", "status", "decision-date", "confidence", "created", "updated"],
  "session-log": ["title", "type", "session-date", "agent", "outcomes", "created", "updated"],
  component: ["title", "type", "language", "status", "created", "updated"],
  source: ["title", "type", "source-author", "source-date", "created", "updated"],
  insight: ["title", "type", "derived-from", "confidence", "created", "updated"],
  mistake: ["title", "type", "severity", "status", "occurred-date", "agent", "area", "confidence", "created", "updated"],
  runbook: ["title", "type", "status", "last-verified", "verified-by", "source", "confidence", "created", "updated"],
};

export const TYPE_FOLDERS: Record<string, string> = {
  rules: "01_Project_Rules",
  reference: "02_API_Docs",
  component: "03_Reusable_Components",
  adr: "04_Architecture_Decisions",
  "session-log": "05_Agent_Session_Logs",
  source: "06_Sources",
  insight: "07_Insights",
  mistake: "08_Mistakes",
  runbook: "09_Runbooks",
};

export function todayIso(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function slugify(value: string) {
  return value
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "untitled";
}

export function normalizeMarkdownPath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "") + ".md";
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export function inferTypeFromPath(path: string): MemoryNoteType {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.includes("05_Agent_Session_Logs")) return "session-log";
  if (normalized.includes("04_Architecture_Decisions")) return "adr";
  if (normalized.includes("07_Insights")) return "insight";
  if (normalized.includes("08_Mistakes")) return "mistake";
  if (normalized.includes("09_Runbooks")) return "runbook";
  if (normalized.includes("03_Reusable_Components")) return "component";
  if (normalized.includes("06_Sources")) return "source";
  if (normalized.includes("00_Index")) return "index";
  return "note";
}

export function frontmatter(fields: Record<string, string | number | boolean | string[] | undefined>) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
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
  lines.push("---", "");
  return lines.join("\n");
}

export function markdownList(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

export function checkboxList(items: string[]) {
  return items.length ? items.map((item) => `- [ ] ${item}`).join("\n") : "- [x] None";
}

export function basenameWithoutExtension(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return base.replace(/\.md$/i, "");
}
