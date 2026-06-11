/**
 * Section-level helpers for the memory index. A note body is split into
 * sections by ATX markdown headings (`#`..`######`), each carrying a 1-based
 * line number so a search hit can point a reader at the relevant heading
 * instead of just the note. Any text before the first heading is kept as an
 * intro section anchored at line 1.
 */
import { searchTokens } from "./ngram.js";

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
const FENCE_RE = /^\s*(```|~~~)/;

export function splitSections(body: string): Section[] {
  const lines = String(body ?? "").split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section | null = null;
  let buf: string[] = [];
  let inFence = false;

  const flush = () => {
    if (!current) return;
    current.text = buf.join("\n").trim();
    sections.push(current);
    buf = [];
  };

  lines.forEach((line, i) => {
    if (FENCE_RE.test(line)) {
      // A ``` / ~~~ delimiter toggles fenced-code state; the delimiter and its
      // contents are body, never headings (a `# comment` inside a code block is
      // not a section), so they would otherwise fragment a real section.
      inFence = !inFence;
      if (!current) current = { heading: "", level: 0, line: 1, text: "" };
      buf.push(line);
      return;
    }
    const m = inFence ? null : HEADING_RE.exec(line);
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
    for (const token of searchTokens(section.text)) if (terms.has(token)) score += 1;
    for (const token of searchTokens(section.heading)) if (terms.has(token)) score += 2;
    // Higher score wins; on a tie prefer a real heading over the level-0 intro
    // so the anchor points at the named section, not the top of the note.
    const better = !best || score > best.score || (score === best.score && best.section.level === 0 && section.level > 0);
    if (score > 0 && better) best = { section, score };
  }
  if (!best) return null;

  const { section } = best;
  const sliced = (section.text || section.heading).replace(/\s+/g, " ").trim().slice(0, 160);
  // slice() counts UTF-16 code units; drop a dangling lone high surrogate so the
  // snippet never ends mid-character (astral chars like emoji are 2 code units).
  const snippet = /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced;
  return { section: section.heading || "(intro)", line: section.line, snippet };
}
