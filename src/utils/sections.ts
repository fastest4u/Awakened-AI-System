/**
 * Section-level helpers for the memory index. A note body is split into
 * sections by ATX markdown headings (`#`..`######`), each carrying a 1-based
 * line number so a search hit can point a reader at the relevant heading
 * instead of just the note. Any text before the first heading is kept as an
 * intro section anchored at line 1.
 */
import { tokenize } from "./bm25.js";

export interface Section {
  heading: string;
  level: number;
  line: number;
  text: string;
}

export interface SectionMatch {
  section: string;
  line: number;
  snippet: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;

export function splitSections(body: string): Section[] {
  const lines = String(body ?? "").split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (!current) return;
    current.text = buf.join("\n").trim();
    sections.push(current);
    buf = [];
  };

  lines.forEach((line, i) => {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      current = { heading: m[2].trim(), level: m[1].length, line: i + 1, text: "" };
    } else {
      if (!current) current = { heading: "", level: 0, line: 1, text: "" };
      buf.push(line);
    }
  });
  flush();
  return sections;
}

/**
 * Pick the section that best matches the query terms (heading hits weighted
 * higher than body hits). Returns the section label, its 1-based start line,
 * and a short snippet — or null when there is no body or no term overlaps.
 */
export function bestSection(body: string, queryTerms: string[]): SectionMatch | null {
  const terms = new Set(queryTerms);
  if (terms.size === 0) return null;
  const sections = splitSections(body);
  if (sections.length === 0) return null;

  let best: { section: Section; score: number } | null = null;
  for (const section of sections) {
    let score = 0;
    for (const token of tokenize(section.text)) if (terms.has(token)) score += 1;
    for (const token of tokenize(section.heading)) if (terms.has(token)) score += 2;
    if (score > 0 && (!best || score > best.score)) best = { section, score };
  }
  if (!best) return null;

  const { section } = best;
  const snippet = (section.text || section.heading).replace(/\s+/g, " ").trim().slice(0, 160);
  return { section: section.heading || "(intro)", line: section.line, snippet };
}
