import { Bm25Index, tokenize, weighted } from "../utils/bm25.js";
import { basenameWithoutExtension } from "../utils/memory-format.js";
import { searchTokens } from "../utils/ngram.js";
import { cosine, reciprocalRankFusion } from "../utils/vector.js";

/** RRF dampening constant (standard default) for fusing hybrid arms. */
const RRF_K = 60;
/** Max docs the vector arm contributes — bounds semantic-only injection so a
 *  weakly-similar tail can't drown out lexical matches (RRF ranks the rest). */
const VECTOR_ARM_LIMIT = 25;

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
  /**
   * Optional L2-normalized embedding for the body (Tier 3 hybrid search).
   * Present only when an embedding provider is enabled; stripped from public
   * results. Tagged with the active embedder signature in the persisted index.
   */
  vector?: number[];
}

export function toPublicRecord(stored: StoredRecord): IndexRecord {
  const { mtimeMs: _mtimeMs, searchText: _searchText, outgoingLinks: _outgoingLinks, vector: _vector, ...rest } = stored;
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

  /**
   * Hybrid ranked search: fuse a lexical (BM25) arm, a semantic (cosine vs the
   * query vector) arm, and a usage arm via Reciprocal Rank Fusion. Because the
   * three signals are on incomparable scales, RANK — not raw score — is fused.
   *
   * Falls back to the plain additive-boost `rank()` (byte-identical behavior)
   * whenever there is no usable query vector or no document carries a vector, so
   * the lexical-only/default path is never disturbed by enabling this method.
   *
   * The usage arm only re-orders documents already surfaced lexically or
   * semantically (never injects a popular-but-irrelevant note), and the vector
   * arm is capped so a weakly-similar tail cannot dominate exact matches.
   */
  rankHybrid(
    queryTerms: string[],
    queryVector: number[] | undefined,
    boost: (path: string) => number = () => 0,
    eligible: (record: StoredRecord) => boolean = () => true,
  ): StoredRecord[] {
    const hasVectorArm = Array.isArray(queryVector)
      && queryVector.length > 0
      && this.hasAnyVector(eligible);
    if (!hasVectorArm) return this.rank(queryTerms, boost).filter(eligible);

    const lexical = this.rank(queryTerms).filter(eligible).map((doc) => doc.path); // pure BM25 order, matched-only
    const vector = this.vectorRank(queryVector as number[], eligible);
    const candidates = new Set<string>([...lexical, ...vector]);
    const usage = this.usageRank(boost, candidates); // re-rank within candidates only

    const fused = reciprocalRankFusion([lexical, vector, usage], RRF_K);
    return [...fused.keys()]
      .map((path) => this.records.get(path))
      .filter((doc): doc is StoredRecord => Boolean(doc))
      .sort((a, b) => {
        const diff = (fused.get(b.path) ?? 0) - (fused.get(a.path) ?? 0);
        if (diff !== 0) return diff;
        return String(b.updatedAt).localeCompare(String(a.updatedAt));
      });
  }

  private hasAnyVector(eligible: (record: StoredRecord) => boolean): boolean {
    for (const record of this.records.values()) {
      if (eligible(record) && record.vector && record.vector.length > 0) return true;
    }
    return false;
  }

  /** Top documents by cosine similarity to the query vector (capped, score > 0). */
  private vectorRank(queryVector: number[], eligible: (record: StoredRecord) => boolean): string[] {
    const scored: Array<{ path: string; score: number }> = [];
    for (const record of this.records.values()) {
      if (!eligible(record)) continue;
      if (!record.vector || record.vector.length === 0) continue;
      const score = cosine(queryVector, record.vector);
      if (score > 0) scored.push({ path: record.path, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, VECTOR_ARM_LIMIT).map((entry) => entry.path);
  }

  /** Candidate paths ordered by usage boost (descending); boost-0 paths dropped. */
  private usageRank(boost: (path: string) => number, candidates: Set<string>): string[] {
    const scored: Array<{ path: string; score: number }> = [];
    for (const path of candidates) {
      const score = boost(path);
      if (score > 0) scored.push({ path, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((entry) => entry.path);
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

  /**
   * Field-weighted token bag for a document (title > tags/aliases > type/body).
   * Text fields use `searchTokens` so Thai/CJK content (which has no inter-word
   * spaces) contributes character n-grams and becomes searchable; for Latin/code
   * `searchTokens` is identical to `tokenize`, so that ranking is unchanged. The
   * `type` enum is always ASCII, so plain `tokenize` is enough there.
   */
  private documentTerms(record: StoredRecord): string[] {
    return [
      ...weighted(searchTokens(record.title), 3),
      ...weighted(searchTokens(record.tags.join(" ")), 2),
      ...weighted(searchTokens(record.aliases.join(" ")), 2),
      ...tokenize(record.type),
      ...searchTokens(record.searchText),
    ];
  }
}
