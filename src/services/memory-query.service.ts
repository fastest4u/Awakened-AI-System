import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IndexRepository, IndexRecord, StoredRecord } from "../repositories/index.repository.js";
import { toPublicRecord } from "../repositories/index.repository.js";
import { tokenize } from "../utils/bm25.js";
import { extractWikilinks } from "../utils/links.js";
import { bestSection, type SectionMatch } from "../utils/sections.js";
import { asStringArray, basenameWithoutExtension, inferTypeFromPath, normalizeMarkdownPath } from "../utils/memory-format.js";
import type { MemoryUsageService } from "./memory-usage.service.js";
import type { VaultService } from "./vault.service.js";

const SEARCH_TEXT_LIMIT = 4000;
const INDEX_VERSION = 2;

/** A search result, optionally annotated with the best-matching section anchor. */
export type SearchHit = IndexRecord & { match?: SectionMatch };

interface PersistedIndex {
  version: typeof INDEX_VERSION;
  updatedAt: string;
  records: Record<string, StoredRecord>;
}

export class MemoryQueryService {
  private readonly indexPath: string;
  private loaded = false;

  constructor(
    private readonly vault: VaultService,
    private readonly index: IndexRepository,
    private readonly usage?: MemoryUsageService,
  ) {
    this.indexPath = join(this.vault.vaultRoot, ".memory-mcp", "index.json");
  }

  /**
   * Refresh the index incrementally: re-parse only files whose mtime changed
   * (or that are new), drop deleted files, and persist the cache when anything
   * changed. Pass { force: true } to rebuild every record from scratch.
   */
  async snapshotIndex(options: { force?: boolean } = {}): Promise<StoredRecord[]> {
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

    if (changed || options.force) this.persist();
    return this.index.list();
  }

  async search(query: string, tags: string[], folder?: string, type?: string, limit = 10, offset = 0, includeSections = false): Promise<SearchHit[]> {
    await this.snapshotIndex();
    const matchesFilters = (record: StoredRecord) =>
      (tags.length === 0 || tags.some((tag) => record.tags.includes(tag))) &&
      (!folder || record.path.includes(folder)) &&
      (!type || record.type === type);

    const trimmed = (query ?? "").trim();
    const terms = trimmed ? tokenize(trimmed) : [];
    let ranked: StoredRecord[];
    if (terms.length === 0) {
      // No usable query terms — either an empty query (e.g. memory_list) or a
      // query whose tokens were all dropped (single chars / punctuation / a
      // script the tokenizer does not segment). Newest-first is stable and
      // avoids silently returning nothing for a non-empty query.
      ranked = this.index.list().filter(matchesFilters).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    } else {
      const boost = this.usage ? this.usage.buildBooster(terms) : () => 0;
      ranked = this.index.rank(terms, boost).filter(matchesFilters);
    }

    const page = ranked.slice(offset, offset + limit);
    if (!includeSections || terms.length === 0) return page.map(toPublicRecord);
    return page.map((record) => {
      const match = this.sectionMatchFor(record.path, terms);
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
      const records = Object.values(parsed.records)
        .filter((record): record is StoredRecord => Boolean(record && record.path))
        .map((record) => this.normalizeStored(record));
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
    };
  }

  private persist() {
    try {
      const records: Record<string, StoredRecord> = {};
      for (const record of this.index.list()) records[record.path] = record;
      const payload: PersistedIndex = { version: INDEX_VERSION, updatedAt: new Date().toISOString(), records };
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
