import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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

const SEARCH_TEXT_LIMIT = 4000;
const INDEX_VERSION = 2;
/** Signature persisted when no embedding provider is active. */
const NO_EMBEDDER = "none";
/** Characters of (title + body) embedded per note. */
const EMBED_TEXT_LIMIT = 2000;
/** Max records embedded per provider call; keeps first-search requests bounded. */
const EMBED_BATCH_SIZE = 32;
/** After a provider failure, skip embedding attempts for this long (ms) so a
 *  down endpoint can't make every query pay a doomed round-trip. */
const EMBED_COOLDOWN_MS = 60_000;

/** A search result, optionally annotated with the best-matching section anchor. */
export type SearchHit = IndexRecord & { match?: SectionMatch };

interface PersistedIndex {
  version: typeof INDEX_VERSION;
  updatedAt: string;
  /** Signature of the embedder whose vectors are stored here ("none" if off).
   *  On load, a mismatch with the active embedder drops the cached vectors so
   *  vectors from different embedding spaces are never mixed. */
  embedder?: string;
  records: Record<string, StoredRecord>;
}

/** Keep a persisted/returned vector only when it is a non-empty all-finite number array. */
function coerceVector(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const vec = value.map((x) => Number(x));
  return vec.every((x) => Number.isFinite(x)) ? vec : undefined;
}

export class MemoryQueryService {
  private readonly indexPath: string;
  private readonly embedderId: string;
  private loaded = false;
  private embedCooldownUntil = 0;
  private cacheNeedsPersist = false;

  constructor(
    private readonly vault: VaultService,
    private readonly index: IndexRepository,
    private readonly usage?: MemoryUsageService,
    private readonly embedder?: EmbeddingProvider,
  ) {
    this.indexPath = join(this.vault.vaultRoot, ".memory-mcp", "index.json");
    this.embedderId = embedder?.id ?? NO_EMBEDDER;
  }

  /**
   * Refresh the index incrementally: re-parse only files whose mtime changed
   * (or that are new), drop deleted files, and persist the cache when anything
   * changed. Pass { force: true } to rebuild every record from scratch, or
   * { embed: true } to also (re-)embed any records missing a vector when an
   * embedding provider is enabled (search passes this; get/recent do not, so a
   * lookup never triggers an embedding pass).
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
      const mtimeMs = this.mtimeOf(fullPath);
      const existing = this.index.get(relative);
      if (existing && existing.mtimeMs === mtimeMs) continue;
      try {
        this.index.upsert(this.buildRecord(relative, mtimeMs));
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

  async search(query: string, tags: string[], folder?: string, type?: string, limit = 10, offset = 0, includeSections = false): Promise<SearchHit[]> {
    await this.snapshotIndex({ embed: true });
    const matchesFilters = (record: StoredRecord) =>
      (tags.length === 0 || tags.some((tag) => record.tags.includes(tag))) &&
      (!folder || record.path.includes(folder)) &&
      (!type || record.type === type);

    const trimmed = (query ?? "").trim();
    // Word tokens key the usage booster (kept aligned with MemoryUsageService);
    // rankTerms add Thai/CJK n-grams so those scripts are actually searchable.
    const wordTerms = trimmed ? tokenize(trimmed) : [];
    const rankTerms = trimmed ? searchTokens(trimmed) : [];
    let ranked: StoredRecord[];
    if (rankTerms.length === 0) {
      // No usable query terms — an empty query (e.g. memory_list) or one whose
      // tokens were all dropped (single chars / punctuation). Newest-first is
      // stable and avoids silently returning nothing for a non-empty query.
      ranked = this.index.list().filter(matchesFilters).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    } else {
      const boost = this.usage ? this.usage.buildBooster(wordTerms) : () => 0;
      // Undefined unless an embedder is enabled -> rankHybrid falls back to the
      // plain lexical rank(), so the default path is unchanged.
      const queryVector = await this.embedQuery(trimmed);
      ranked = this.index.rankHybrid(rankTerms, queryVector, boost, matchesFilters);
    }

    const page = ranked.slice(offset, offset + limit);
    if (!includeSections || rankTerms.length === 0) return page.map(toPublicRecord);
    return page.map((record) => {
      const match = this.sectionMatchFor(record.path, rankTerms);
      return match ? { ...toPublicRecord(record), match } : toPublicRecord(record);
    });
  }

  /** Best-matching section anchor for one note, loaded lazily (opt-in via includeSections). */
  private sectionMatchFor(path: string, terms: string[]): SectionMatch | undefined {
    try {
      return bestSection(this.vault.load(path).parsed.content, terms) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async recent(folders: string[], types: string[], sortBy: "updated" | "created", limit: number): Promise<IndexRecord[]> {
    await this.snapshotIndex();
    const key = sortBy === "updated" ? "updatedAt" : "createdAt";
    return this.index
      .list()
      .filter((record) => {
        if (folders.length && !folders.some((folder) => record.path.includes(folder))) return false;
        if (types.length && !types.includes(record.type)) return false;
        return true;
      })
      .sort((a, b) => String(b[key]).localeCompare(String(a[key])))
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
   * Embed any records still missing a vector (new/modified notes, or all of
   * them after an embedder change) in bounded batches. Best-effort: a provider
   * error or malformed response degrades to lexical-only and starts a short
   * cooldown so a down endpoint can't make every query retry. Returns true if
   * any vector was stored.
   */
  private async embedMissing(): Promise<boolean> {
    if (!this.embedder || Date.now() < this.embedCooldownUntil) return false;
    const pending = this.index.list().filter((record) => !record.vector || record.vector.length === 0);
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

  /** Embed the query for the semantic arm; undefined when off or on failure. */
  private async embedQuery(text: string): Promise<number[] | undefined> {
    if (!this.embedder || Date.now() < this.embedCooldownUntil) return undefined;
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

  private buildRecord(relative: string, mtimeMs: number): StoredRecord {
    const raw = this.vault.load(relative);
    const body = raw.parsed.content.trim();
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
      mtimeMs,
      searchText: body.slice(0, SEARCH_TEXT_LIMIT),
      outgoingLinks: extractWikilinks(body),
    };
  }

  private mtimeOf(fullPath: string): number {
    try {
      return statSync(fullPath).mtimeMs;
    } catch {
      return 0;
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
      // Vectors from a different embedder (or none) are incomparable to the
      // active one — keep the cheap lexical fields, drop the vectors, and let
      // the next search re-embed. Lexical data is embedder-independent.
      const sameEmbedder = (parsed.embedder ?? NO_EMBEDDER) === this.embedderId;
      if (!sameEmbedder) this.cacheNeedsPersist = true;
      const records = Object.values(parsed.records)
        .filter((record): record is StoredRecord => Boolean(record && record.path))
        .map((record) => this.normalizeStored(record))
        .map((record) => (sameEmbedder ? record : { ...record, vector: undefined }));
      this.index.bulkUpsert(records);
    } catch {
      // Corrupt or outdated cache — ignore; mtimes will rebuild it lazily.
    }
  }

  /**
   * Coerce a record loaded from the persisted cache so it always satisfies
   * StoredRecord. A hand-edited or stale index.json could otherwise inject a
   * record missing tags/aliases, which would throw in BM25 tokenization
   * (`tags.join`) on the next ranked search.
   */
  private normalizeStored(record: StoredRecord): StoredRecord {
    return {
      ...record,
      title: String(record.title ?? record.path),
      type: String(record.type ?? inferTypeFromPath(record.path)),
      tags: asStringArray(record.tags),
      aliases: asStringArray(record.aliases),
      updatedAt: String(record.updatedAt ?? ""),
      createdAt: String(record.createdAt ?? ""),
      excerpt: String(record.excerpt ?? ""),
      searchText: String(record.searchText ?? ""),
      outgoingLinks: asStringArray(record.outgoingLinks),
      mtimeMs: typeof record.mtimeMs === "number" ? record.mtimeMs : 0,
      vector: coerceVector(record.vector),
    };
  }

  private persist() {
    try {
      const records: Record<string, StoredRecord> = {};
      for (const record of this.index.list()) records[record.path] = record;
      const payload: PersistedIndex = { version: INDEX_VERSION, updatedAt: new Date().toISOString(), embedder: this.embedderId, records };
      mkdirSync(dirname(this.indexPath), { recursive: true });
      // Write to a per-process temp file then atomically rename. The vault is
      // shared across agents/processes, so a concurrent or interrupted write
      // must never leave a torn index.json for the next reader (rename over an
      // existing file is atomic on the same filesystem, including Windows).
      const tmp = `${this.indexPath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf8");
      renameSync(tmp, this.indexPath);
    } catch {
      // Best-effort cache; never fail a query because the cache could not be written.
    }
  }
}
