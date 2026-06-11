/**
 * Canonical `[[wikilink]]` extraction, shared by the index (outgoing-link
 * capture / backlink graph) and the vault-health broken-link scan so the two
 * never drift apart. Captures the link target only — the part before any
 * `#section` or `|display` suffix — trims it, drops trailing-slash/empty
 * targets, strips a trailing `.md`, and de-duplicates within one document.
 */
import { basenameWithoutExtension } from "./memory-format.js";

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

export interface WikilinkNoteKeys {
  path: string;
  title?: string;
  id?: string;
  aliases?: string[];
}

/**
 * Shared wikilink-target resolution with the SAME semantics as the index
 * backlink graph (index.repository `ensureLinkGraph`), so the vault-health
 * broken-link scan and the graph can never disagree.
 *
 * Keys are registered in precedence tiers across ALL notes — path/basename
 * first, then title/id, then aliases — case-insensitively, so a note's own
 * strong identity always wins over another note's weaker keys. Within a tier a
 * collision goes to the lexicographically-first path. Lookups strip a trailing
 * `.md`. Self-links are NOT excluded here; a caller building a graph excludes
 * them itself.
 */
export function buildWikilinkResolver(
  notes: ReadonlyArray<WikilinkNoteKeys>,
): (target: string) => string | undefined {
  const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path));
  const resolve = new Map<string, string>();
  const register = (key: string | undefined, path: string) => {
    const k = key?.trim().toLowerCase().replace(/\.md$/i, "");
    if (k && !resolve.has(k)) resolve.set(k, path);
  };
  // Tier 1 — strong identity (path, then basename) for every note.
  for (const note of sorted) {
    register(note.path, note.path);
    register(basenameWithoutExtension(note.path), note.path);
  }
  // Tier 2 — declared identity (title, then id); fills only unclaimed keys.
  for (const note of sorted) {
    register(note.title, note.path);
    register(note.id, note.path);
  }
  // Tier 3 — aliases (weakest); fills only what remains.
  for (const note of sorted) {
    for (const alias of note.aliases ?? []) register(alias, note.path);
  }
  return (target: string) => resolve.get(String(target ?? "").trim().toLowerCase().replace(/\.md$/i, ""));
}

export function extractWikilinks(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of String(content ?? "").matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim().replace(/\.md$/i, "");
    if (!target || target.endsWith("/")) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}
