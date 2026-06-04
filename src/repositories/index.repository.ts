import { Bm25Index, tokenize, weighted } from "../utils/bm25.js";
import { basenameWithoutExtension } from "../utils/memory-format.js";

/** Public, lean index record returned to callers (search/list/recent results). */
export interface IndexRecord {
  id?: string;
  path: string;
  title: string;
  type: string;
  tags: string[];
  aliases: string[];
  updatedAt: string;
  createdAt: string;
  excerpt: string;
}

/**
 * Internal record persisted in the index: the public fields plus the file
 * mtime (for incremental re-indexing) and a capped body text (for ranked
 * full-text search). `mtimeMs`/`searchText` are stripped before results leave
 * the service so tool responses stay lean.
 */
export interface StoredRecord extends IndexRecord {
  mtimeMs: number;
  searchText: string;
  /** Normalized `[[wikilink]]` targets in this note's body (for the backlink graph). */
  outgoingLinks: string[];
}

export function toPublicRecord(stored: StoredRecord): IndexRecord {
  const { mtimeMs: _mtimeMs, searchText: _searchText, outgoingLinks: _outgoingLinks, ...rest } = stored;
  return rest;
}

export class IndexRepository {
  private readonly records = new Map<string, StoredRecord>();
  private bm25: Bm25Index<StoredRecord> | undefined;
  private bm25Revision = -1;
  private linkGraph: Map<string, string[]> | undefined;
  private linkRevision = -1;
  /** Bumped on every mutation; cached derivations (BM25, link graph) rebuild when their stamp lags. */
  private revision = 0;

  upsert(record: StoredRecord) {
    this.records.set(record.path, record);
    this.revision += 1;
  }

  bulkUpsert(records: StoredRecord[]) {
    for (const record of records) this.upsert(record);
  }

  delete(path: string) {
    if (this.records.delete(path)) this.revision += 1;
  }

  clear() {
    this.records.clear();
    this.revision += 1;
  }

  get(path: string) {
    return this.records.get(path);
  }

  paths() {
    return Array.from(this.records.keys());
  }

  list() {
    return Array.from(this.records.values());
  }

  /**
   * Ranked full-text search: BM25 over the query terms plus an optional
   * per-path boost (e.g. usage scoring). Only documents that actually contain a
   * query term are returned, best-first. The BM25 model is cached and rebuilt
   * only when the record set changed.
   */
  rank(queryTerms: string[], boost: (path: string) => number = () => 0): StoredRecord[] {
    return this.ensureBm25()
      .score(queryTerms)
      .map(({ doc, score }) => ({ doc, score: score + boost(doc.path), matched: score > 0 }))
      .filter((entry) => entry.matched)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.doc);
  }

  /** Backlinks: paths of notes whose body `[[wikilink]]`s resolve to `path`. */
  incomingLinks(path: string): string[] {
    return this.ensureLinkGraph().get(path) ?? [];
  }

  private ensureBm25(): Bm25Index<StoredRecord> {
    if (this.bm25 && this.bm25Revision === this.revision) return this.bm25;
    const items = this.list().map((doc) => ({ doc, terms: this.documentTerms(doc) }));
    this.bm25 = new Bm25Index(items);
    this.bm25Revision = this.revision;
    return this.bm25;
  }

  /**
   * Build the reverse-link (backlink) map: for each note, resolve its outgoing
   * `[[wikilink]]` targets against the indexed notes (by path, basename, title,
   * id, or alias — case-insensitive) and record the edge target -> [sources].
   *
   * Keys are registered in precedence tiers across ALL notes — path/basename
   * first, then title/id, then aliases — so a note's own strong identity always
   * wins over another note's weaker keys (e.g. a bare `[[setup]]` resolves to the
   * note named `setup`, not one merely titled "Setup"). Within a tier a collision
   * goes to the sorted-first path, so a duplicate basename in two folders resolves
   * to the lexicographically first (a bare `[[link]]` cannot disambiguate folder).
   * Self-links are ignored. Cached until the record set changes.
   */
  private ensureLinkGraph(): Map<string, string[]> {
    if (this.linkGraph && this.linkRevision === this.revision) return this.linkGraph;
    const sorted = [...this.records.values()].sort((a, b) => a.path.localeCompare(b.path));

    const resolve = new Map<string, string>();
    const register = (key: string | undefined, path: string) => {
      const k = key?.trim().toLowerCase().replace(/\.md$/i, "");
      if (k && !resolve.has(k)) resolve.set(k, path);
    };
    // Tier 1 — strong identity (path, then basename) for every note.
    for (const record of sorted) {
      register(record.path, record.path);
      register(basenameWithoutExtension(record.path), record.path);
    }
    // Tier 2 — declared identity (title, then id); fills only keys no path/basename claimed.
    for (const record of sorted) {
      register(record.title, record.path);
      register(record.id, record.path);
    }
    // Tier 3 — aliases (weakest); fills only what remains.
    for (const record of sorted) {
      for (const alias of record.aliases) register(alias, record.path);
    }

    const incoming = new Map<string, Set<string>>();
    for (const record of sorted) {
      for (const target of record.outgoingLinks) {
        // Targets come from extractWikilinks, which already strips `.md`; only the
        // register() side needs the strip (record.path keys retain their `.md`).
        const targetPath = resolve.get(target.trim().toLowerCase());
        if (!targetPath || targetPath === record.path) continue;
        let sources = incoming.get(targetPath);
        if (!sources) {
          sources = new Set();
          incoming.set(targetPath, sources);
        }
        sources.add(record.path);
      }
    }

    this.linkGraph = new Map([...incoming].map(([path, sources]) => [path, [...sources].sort()]));
    this.linkRevision = this.revision;
    return this.linkGraph;
  }

  /** Field-weighted token bag for a document (title > tags/aliases > type/body). */
  private documentTerms(record: StoredRecord): string[] {
    return [
      ...weighted(tokenize(record.title), 3),
      ...weighted(tokenize(record.tags.join(" ")), 2),
      ...weighted(tokenize(record.aliases.join(" ")), 2),
      ...tokenize(record.type),
      ...tokenize(record.searchText),
    ];
  }
}
