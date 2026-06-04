/**
 * Canonical `[[wikilink]]` extraction, shared by the index (outgoing-link
 * capture / backlink graph) and the vault-health broken-link scan so the two
 * never drift apart. Captures the link target only — the part before any
 * `#section` or `|display` suffix — trims it, drops trailing-slash/empty
 * targets, strips a trailing `.md`, and de-duplicates within one document.
 */
const WIKILINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

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
