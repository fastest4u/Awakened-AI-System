import { Bm25Index, tokenize, weighted } from "../utils/bm25.js";

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
}

export function toPublicRecord(stored: StoredRecord): IndexRecord {
  const { mtimeMs: _mtimeMs, searchText: _searchText, ...rest } = stored;
  return rest;
}

export class IndexRepository {
  private readonly records = new Map<string, StoredRecord>();
  private bm25: Bm25Index<StoredRecord> | undefined;
  private dirty = true;

  upsert(record: StoredRecord) {
    this.records.set(record.path, record);
    this.dirty = true;
  }

  bulkUpsert(records: StoredRecord[]) {
    for (const record of records) this.upsert(record);
  }

  delete(path: string) {
    if (this.records.delete(path)) this.dirty = true;
  }

  clear() {
    this.records.clear();
    this.dirty = true;
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

  private ensureBm25(): Bm25Index<StoredRecord> {
    if (this.bm25 && !this.dirty) return this.bm25;
    const items = this.list().map((doc) => ({ doc, terms: this.documentTerms(doc) }));
    this.bm25 = new Bm25Index(items);
    this.dirty = false;
    return this.bm25;
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
