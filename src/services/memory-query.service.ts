import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IndexRepository, IndexRecord, StoredRecord } from "../repositories/index.repository.js";
import { toPublicRecord } from "../repositories/index.repository.js";
import { tokenize } from "../utils/bm25.js";
import { searchTokens } from "../utils/ngram.js";
import { extractWikilinks } from "../utils/links.js";
import { bestSection, type SectionMatch } from "../utils/sections.js";
import { asStringArray, basenameWithoutExtension, inferTypeFromPath, normalizeMarkdownPath } from "../utils/memory-format.js";
import type { EmbeddingProvider } from "./embedding/embedding-provider.js";
import type { MemoryUsageService } from "./memory-usage.service.js";
import type { VaultService } from "./vault.service.js";

const SEARCH_TEXT_LIMIT = 12000;
const INDEX_VERSION = 3;
/** Signature persisted when no embedding provider is active. */
const NO_EMBEDDER = "none";
/** Characters of (title + body) embedded per note. */
const EMBED_TEXT_LIMIT = 2000;
/** Max records embedded per provider call; keeps first-search requests bounded. */
const EMBED_BATCH_SIZE = 32;
/** Max batches embedded per snapshot — bounds one search's backlog work to
 *  EMBED_BATCH_SIZE * EMBED_MAX_BATCHES docs; later searches drain the rest. */
const EMBED_MAX_BATCHES = 4;
/** After a provider failure, skip embedding attempts for this long (ms) so a
 *  down endpoint can't make every query pay a doomed round-trip. */
const EMBED_COOLDOWN_MS = 60_000;
/** Entries kept in the query-string -> query-vector LRU cache. */
const QUERY_VECTOR_CACHE_SIZE = 32;

/** A search result, optionally annotated with a section anchor and/or full body. */
export type SearchHit = IndexRecord & { match?: SectionMatch; body?: string };

/** Sort orders honored by search(); "relevance" keeps the ranked order. */
export type SearchSortBy = "relevance" | "updatedAt" | "createdAt" | "title" | "path";
/** Which indexed fields a query term must occur in for a note to match. */
export type SearchScope = "all" | "title" | "tags";

export interface SearchOptions {
  /** Default "relevance" (empty queries fall back to updatedAt, newest first). */
  sortBy?: SearchSortBy;
  /** Default "all" (title + tags + aliases + type + body). */
  scope?: SearchScope;
  /** Attach the full note body to each returned hit. Default false. */
  includeBody?: boolean;
}

/** StoredRecord as persisted in index.json (v3): vector is a base64 Float32Array. */
type PersistedRecord = Omit<StoredRecord, "vector"> & { vector?: string };

interface PersistedIndex {
  version: typeof INDEX_VERSION;
  updatedAt: string;
  /** Signature of the embedder whose vectors are stored here ("none" if off).
   *  On load, an embedding process drops vectors whose signature mismatches; a
   *  lexical-only process preserves them (and this tag) untouched. */
  embedder?: string;
  records: Record<string, PersistedRecord>;
}

/** Keep a persisted/returned vector only when it is a non-empty all-finite number array. */
function coerceVector(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const vec = value.map((x) => Number(x));
  return vec.every((x) => Number.isFinite(x)) ? vec : undefined;
}

/** Encode a vector as a base64 Float32Array string (index.json v3 wire form). */
function encodeVector(vector: number[] | undefined): string | undefined {
  if (!vector || vector.length === 0) return undefined;
  const floats = new Float32Array(vector);
  return Buffer.from(floats.buffer, 0, floats.byteLength).toString("base64");
}

/** Decode a persisted base64 vector; any malformed value drops just that vector. */
function decodeVector(value: unknown): number[] | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return undefined;
    // Copy into a fresh ArrayBuffer: a pooled Buffer's byteOffset may not be
    // 4-byte aligned, and an unaligned Float32Array view throws.
    const copy = new Uint8Array(bytes);
    return coerceVector(Array.from(new Float32Array(copy.buffer)));
  } catch {
    return undefined;
  }
}

/** Clamp a persisted numeric field: non-numeric, NaN, or negative -> 0. */
function clampNonNegative(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Case-insensitive, segment-aware folder filter (same semantics as the
 * follow-up service's matcher): the folder must cover whole leading path
 * segments, so a raw substring like "Insights" or a partial segment no longer
 * matches "07_Insights/...".
 */
function matchesFolderFilter(path: string, folder: string): boolean {
  const normalized = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
  if (normalized.length === 0) return true;
  const candidate = path.toLowerCase();
  return candidate === normalized || candidate.startsWith(`${normalized}/`);
}

/** Comparator for the non-relevance sort orders (dates newest-first, text ascending). */
function recordComparator(sortBy: Exclude<SearchSortBy, "relevance">): (a: StoredRecord, b: StoredRecord) => number {
  switch (sortBy) {
    case "title":
      return (a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path);
    case "path":
      return (a, b) => a.path.localeCompare(b.path);
    case "createdAt":
      return (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.path.localeCompare(b.path);
    case "updatedAt":
    default:
      return (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.path.localeCompare(b.path);
  }
}

export class MemoryQueryService {
  private readonly indexPath: string;
  private readonly embedderId: string;
  /** Embedder tag written to index.json. Tracks the loaded cache's tag when no
   *  provider is active, so a lexical-only process never wipes another
   *  process's vectors by re-tagging the cache as "none". */
  private persistedEmbedderId: string;
  private loaded = false;
  private embedCooldownUntil = 0;
  private cacheNeedsPersist = false;
  private readonly queryVectorCache = new Map<string, number[]>();

  constructor(
    private readonly vault: VaultService,
    private readonly index: IndexRepository,
    private readonly usage?: MemoryUsageService,
    private readonly embedder?: EmbeddingProvider,
  ) {
    this.indexPath = join(this.vault.vaultRoot, ".memory-mcp", "index.json");
    this.embedderId = embedder?.id ?? NO_EMBEDDER;
    this.persistedEmbedderId = this.embedderId;
  }

  /**
   * Refresh the index incrementally: re-parse only files whose mtime or size
   * changed (or that are new), drop deleted files, and persist the cache when
   * anything changed. Pass { force: true } to rebuild every record from
   * scratch, or { embed: true } to also (re-)embed records missing a vector
   * when an embedding provider is enabled (only a ranked search passes this;
   * list/get/recent lookups never trigger an embedding pass).
   */
  async snapshotIndex(options: { force?: boolean; embed?: boolean } = {}): Promise<StoredRecord[]> {
    if (options.force) {
      this.index.clear();
      this.loaded = true;
    } else {
      this.ensureLoaded();
    }

    const files = await this.vault.listMarkdownFiles();
    const seen = new Set<string>();
    let changed = false;

    for (const fullPath of files) {
      const relative = this.vault.relativePath(fullPath);
      seen.add(relative);
      const stat = this.statOf(fullPath);
      const existing = this.index.get(relative);
      // Compare mtime AND size so a same-millisecond rewrite is still caught.
      if (existing && existing.mtimeMs === stat.mtimeMs && existing.sizeBytes === stat.sizeBytes) continue;
      try {
        this.index.upsert(this.buildRecord(relative, stat));
        changed = true;
      } catch {
        // Transiently unreadable (deleted/locked between enumeration and read).
        // Keep any prior cached record and skip — one bad file must never break
        // the whole refresh (and every query). `relative` is already in `seen`,
        // so the prune below won't drop the kept record; a file that is truly
        // gone won't be enumerated next time and is pruned then.
      }
    }

    for (const path of this.index.paths()) {
      if (!seen.has(path)) {
        this.index.delete(path);
        changed = true;
      }
    }

    const embedded = options.embed ? await this.embedMissing() : false;

    if (changed || embedded || options.force || this.cacheNeedsPersist) {
      this.persist();
      this.cacheNeedsPersist = false;
    }
    return this.index.list();
  }

  async search(
    query: string,
    tags: string[],
    folder?: string,
    type?: string,
    limit = 10,
    offset = 0,
    includeSections = false,
    options: SearchOptions = {},
  ): Promise<SearchHit[]> {
    const trimmed = (query ?? "").trim();
    // Word tokens key the usage booster (kept aligned with MemoryUsageService);
    // rankTerms add Thai/CJK n-grams so those scripts are actually searchable.
    const wordTerms = trimmed ? tokenize(trimmed) : [];
    const rankTerms = trimmed ? searchTokens(trimmed) : [];
    // Only a real ranked query triggers the embedding pass — memory_list routes
    // here with an empty query and must stay a pure lexical/index refresh.
    await this.snapshotIndex({ embed: rankTerms.length > 0 });

    const scope = options.scope ?? "all";
    const matchesScope = (record: StoredRecord) => {
      if (scope === "all" || rankTerms.length === 0) return true;
      const fieldTokens = new Set(scope === "title" ? searchTokens(record.title) : searchTokens(record.tags.join(" ")));
      return rankTerms.some((term) => fieldTokens.has(term));
    };
    const matchesFilters = (record: StoredRecord) =>
      (tags.length === 0 || tags.some((tag) => record.tags.includes(tag))) &&
      (!folder || matchesFolderFilter(record.path, folder)) &&
      (!type || record.type === type) &&
      matchesScope(record);

    let ranked: StoredRecord[];
    if (rankTerms.length === 0) {
      // No usable query terms — an empty query (e.g. memory_list) or one whose
      // tokens were all dropped (single chars / punctuation). Newest-first is
      // stable and avoids silently returning nothing for a non-empty query.
      ranked = this.index.list().filter(matchesFilters).sort(recordComparator("updatedAt"));
    } else {
      const boost = this.usage ? this.usage.buildBooster(wordTerms) : () => 0;
      // Undefined unless an embedder is enabled -> rankHybrid falls back to the
      // plain lexical rank(), so the default path is unchanged.
      const queryVector = await this.embedQuery(trimmed);
      ranked = this.index.rankHybrid(rankTerms, queryVector, boost, matchesFilters);
    }

    const sortBy = options.sortBy ?? "relevance";
    if (sortBy !== "relevance") ranked = [...ranked].sort(recordComparator(sortBy));

    const page = ranked.slice(offset, offset + limit);
    return page.map((record) => {
      let hit: SearchHit = toPublicRecord(record);
      if (includeSections && rankTerms.length > 0) {
        const match = this.sectionMatchFor(record.path, rankTerms);
        // Section anchors are body-relative; shift by the frontmatter block so
        // the reported line is file-accurate.
        if (match) hit = { ...hit, match: { ...match, line: match.line + clampNonNegative(record.bodyLineOffset) } };
      }
      if (options.includeBody) {
        const body = this.bodyOf(record.path);
        if (body !== undefined) hit = { ...hit, body };
      }
      return hit;
    });
  }

  /**
   * Path -> relevance score for every indexed note matching at least one term:
   * BM25 over the full indexed text plus the capped usage boost. Snapshots the
   * index once and builds the usage booster once. Incoming terms are deduped so
   * a duplicated query gram cannot double-count against doc-side frequencies.
   */
  async rankFor(terms: string[]): Promise<Record<string, number>> {
    await this.snapshotIndex();
    const unique = [...new Set(terms)];
    if (unique.length === 0) return {};
    const boost = this.usage ? this.usage.buildBooster(unique) : () => 0;
    const scores: Record<string, number> = {};
    for (const { doc, score } of this.index.rankScored(unique, boost)) scores[doc.path] = score;
    return scores;
  }

  /** Best-matching section anchor for one note, loaded lazily (opt-in via includeSections). */
  private sectionMatchFor(path: string, terms: string[]): SectionMatch | undefined {
    try {
      return bestSection(this.vault.load(path).parsed.content, terms) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Full body of one note for includeBody hits; undefined when unreadable. */
  private bodyOf(path: string): string | undefined {
    try {
      return this.vault.load(path).parsed.content;
    } catch {
      return undefined;
    }
  }

  async recent(folders: string[], types: string[], sortBy: "updated" | "created", limit: number): Promise<IndexRecord[]> {
    await this.snapshotIndex();
    return this.index
      .list()
      .filter((record) => {
        if (folders.length && !folders.some((folder) => matchesFolderFilter(record.path, folder))) return false;
        if (types.length && !types.includes(record.type)) return false;
        return true;
      })
      .sort(recordComparator(sortBy === "updated" ? "updatedAt" : "createdAt"))
      .slice(0, limit)
      .map(toPublicRecord);
  }

  async get(reference: string) {
    // resolveReference snapshots the index up front (all branches), so the
    // backlink graph below is already current for incomingLinks.
    const relativePath = await this.resolveReference(reference);
    const note = this.vault.load(relativePath);
    return {
      path: relativePath,
      title: String(note.parsed.data.title ?? relativePath),
      type: String(note.parsed.data.type ?? inferTypeFromPath(relativePath)),
      frontmatter: note.parsed.data,
      body: note.parsed.content,
      outgoingLinks: extractWikilinks(note.parsed.content),
      incomingLinks: this.index.incomingLinks(relativePath),
    };
  }

  async resolveReference(reference: string) {
    // Snapshot once, up front, so the index and backlink graph are current for
    // every resolution path — a direct-path hit would otherwise skip the refresh
    // and leave get()'s incomingLinks stale.
    const records = await this.snapshotIndex();
    const normalized = normalizeMarkdownPath(reference);
    if (this.vault.exists(normalized)) return normalized;

    const withoutExtension = reference.replace(/\\/g, "/").replace(/\.md$/i, "");
    const normalizedLookup = withoutExtension.toLowerCase();
    const found = records.find((record) => {
      const pathNoExt = record.path.replace(/\.md$/i, "").toLowerCase();
      const base = basenameWithoutExtension(record.path).toLowerCase();
      return record.path.toLowerCase() === normalized.toLowerCase()
        || pathNoExt === normalizedLookup
        || base === normalizedLookup
        || record.title.toLowerCase() === normalizedLookup
        || record.id?.toLowerCase() === normalizedLookup
        || record.aliases.some((alias) => alias.toLowerCase() === normalizedLookup);
    });

    if (!found) throw new Error(`Note not found: ${reference}`);
    return found.path;
  }

  // ---------- index internals ----------

  /**
   * Embed records still missing a vector (new/modified notes, or all of them
   * after an embedder change) in bounded batches — at most EMBED_MAX_BATCHES
   * batches per call; the remainder is drained by subsequent searches.
   * Best-effort: a provider error or malformed response degrades to
   * lexical-only and starts a short cooldown so a down endpoint can't make
   * every query retry. Returns true if any vector was stored.
   */
  private async embedMissing(): Promise<boolean> {
    if (!this.embedder || Date.now() < this.embedCooldownUntil) return false;
    const pending = this.index
      .list()
      .filter((record) => !record.vector || record.vector.length === 0)
      .slice(0, EMBED_BATCH_SIZE * EMBED_MAX_BATCHES);
    if (pending.length === 0) return false;
    let stored = false;
    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
      try {
        const vectors = await this.embedder.embed(batch.map((record) => this.embedText(record)));
        if (vectors.length !== batch.length) {
          this.recordEmbedFailure();
          return stored;
        }
        const coerced = vectors.map(coerceVector);
        if (coerced.some((vector) => !vector)) {
          this.recordEmbedFailure();
          return stored;
        }
        batch.forEach((record, j) => {
          this.index.upsert({ ...record, vector: coerced[j] as number[] });
          stored = true;
        });
      } catch {
        this.recordEmbedFailure();
        return stored;
      }
    }
    return stored;
  }

  private recordEmbedFailure() {
    this.embedCooldownUntil = Date.now() + EMBED_COOLDOWN_MS;
  }

  /** Embed the query for the semantic arm; undefined when off or on failure.
   *  Successful query vectors are kept in a small LRU keyed by query string. */
  private async embedQuery(text: string): Promise<number[] | undefined> {
    if (!this.embedder) return undefined;
    const cached = this.queryVectorCache.get(text);
    if (cached) {
      // Refresh recency: Map iteration order is insertion order.
      this.queryVectorCache.delete(text);
      this.queryVectorCache.set(text, cached);
      return cached;
    }
    if (Date.now() < this.embedCooldownUntil) return undefined;
    try {
      const vectors = await this.embedder.embed([text]);
      if (vectors.length !== 1) {
        this.recordEmbedFailure();
        return undefined;
      }
      const vector = coerceVector(vectors[0]);
      if (!vector) {
        this.recordEmbedFailure();
        return undefined;
      }
      this.queryVectorCache.set(text, vector);
      if (this.queryVectorCache.size > QUERY_VECTOR_CACHE_SIZE) {
        const oldest = this.queryVectorCache.keys().next().value as string;
        this.queryVectorCache.delete(oldest);
      }
      return vector;
    } catch {
      this.recordEmbedFailure();
      return undefined;
    }
  }

  /** Text embedded for a note: title + a body prefix, capped. */
  private embedText(record: StoredRecord): string {
    return [record.title, record.searchText].filter(Boolean).join("\n").slice(0, EMBED_TEXT_LIMIT);
  }

  private buildRecord(relative: string, stat: { mtimeMs: number; sizeBytes: number }): StoredRecord {
    const raw = this.vault.load(relative);
    const content = raw.parsed.content;
    const body = content.trim();
    // The parsed body is a line-suffix of the raw file, so the line-count
    // difference is exactly the frontmatter block preceding it.
    const bodyLineOffset = Math.max(0, raw.raw.split(/\r?\n/).length - content.split(/\r?\n/).length);
    return {
      id: raw.parsed.data.id ? String(raw.parsed.data.id) : undefined,
      path: relative,
      title: String(raw.parsed.data.title ?? relative),
      type: String(raw.parsed.data.type ?? inferTypeFromPath(relative)),
      tags: asStringArray(raw.parsed.data.tags),
      aliases: asStringArray(raw.parsed.data.aliases),
      updatedAt: String(raw.parsed.data.updated ?? raw.parsed.data["last-verified"] ?? ""),
      createdAt: String(raw.parsed.data.created ?? raw.parsed.data["session-date"] ?? raw.parsed.data["decision-date"] ?? ""),
      excerpt: body.slice(0, 360),
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.sizeBytes,
      searchText: body.slice(0, SEARCH_TEXT_LIMIT),
      bodyLineOffset,
      outgoingLinks: extractWikilinks(body),
    };
  }

  private statOf(fullPath: string): { mtimeMs: number; sizeBytes: number } {
    try {
      const stat = statSync(fullPath);
      return { mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
    } catch {
      return { mtimeMs: 0, sizeBytes: 0 };
    }
  }

  private ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.indexPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as PersistedIndex;
      // Ignore corrupt / foreign / stale-schema caches; mtimes rebuild lazily.
      if (!parsed || parsed.version !== INDEX_VERSION || !parsed.records) return;
      const persistedEmbedder = typeof parsed.embedder === "string" && parsed.embedder ? parsed.embedder : NO_EMBEDDER;
      // Vectors from a different embedder are incomparable to the active one —
      // an embedding process drops them and re-embeds under its own signature.
      // A lexical-only process (no provider) instead PRESERVES foreign vectors
      // and their tag, so it can never wipe a concurrent embedding process's
      // vector cache just by refreshing the lexical fields.
      const lexicalOnly = this.embedderId === NO_EMBEDDER;
      const keepVectors = lexicalOnly || persistedEmbedder === this.embedderId;
      if (lexicalOnly) this.persistedEmbedderId = persistedEmbedder;
      if (!keepVectors) this.cacheNeedsPersist = true;
      const records = Object.values(parsed.records)
        .filter((record): record is PersistedRecord => Boolean(record && record.path))
        .map((record) => this.normalizeStored(record))
        .map((record) => (keepVectors ? record : { ...record, vector: undefined }));
      this.index.bulkUpsert(records);
    } catch {
      // Corrupt or outdated cache — ignore; mtimes will rebuild it lazily.
    }
  }

  /**
   * Coerce a record loaded from the persisted cache so it always satisfies
   * StoredRecord. A hand-edited or stale index.json could otherwise inject a
   * record missing tags/aliases (throws in BM25 tokenization), a non-string id
   * (throws in memory_get's resolver and the link graph), or NaN/negative
   * numeric fields. Vectors are stored base64-encoded; an undecodable vector is
   * dropped without affecting the rest of the record.
   */
  private normalizeStored(record: PersistedRecord): StoredRecord {
    return {
      ...record,
      id: typeof record.id === "string" ? record.id : record.id == null ? undefined : basenameWithoutExtension(record.path),
      title: String(record.title ?? record.path),
      type: String(record.type ?? inferTypeFromPath(record.path)),
      tags: asStringArray(record.tags),
      aliases: asStringArray(record.aliases),
      updatedAt: String(record.updatedAt ?? ""),
      createdAt: String(record.createdAt ?? ""),
      excerpt: String(record.excerpt ?? ""),
      searchText: String(record.searchText ?? ""),
      outgoingLinks: asStringArray(record.outgoingLinks),
      mtimeMs: clampNonNegative(record.mtimeMs),
      sizeBytes: clampNonNegative(record.sizeBytes),
      bodyLineOffset: clampNonNegative(record.bodyLineOffset),
      vector: decodeVector(record.vector),
    };
  }

  private persist() {
    try {
      const records: Record<string, PersistedRecord> = {};
      for (const record of this.index.list()) records[record.path] = { ...record, vector: encodeVector(record.vector) };
      const payload: PersistedIndex = { version: INDEX_VERSION, updatedAt: new Date().toISOString(), embedder: this.persistedEmbedderId, records };
      mkdirSync(dirname(this.indexPath), { recursive: true });
      // Write to a per-process temp file then atomically rename. The vault is
      // shared across agents/processes, so a concurrent or interrupted write
      // must never leave a torn index.json for the next reader (rename over an
      // existing file is atomic on the same filesystem, including Windows).
      const tmp = `${this.indexPath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf8");
      try {
        renameSync(tmp, this.indexPath);
      } catch {
        // Don't leak the temp file when the rename fails (e.g. target locked).
        try {
          unlinkSync(tmp);
        } catch {
          // Best-effort cleanup only.
        }
      }
    } catch {
      // Best-effort cache; never fail a query because the cache could not be written.
    }
  }
}
