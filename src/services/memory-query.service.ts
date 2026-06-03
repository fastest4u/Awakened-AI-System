import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IndexRepository, IndexRecord, StoredRecord } from "../repositories/index.repository.js";
import { toPublicRecord } from "../repositories/index.repository.js";
import { tokenize } from "../utils/bm25.js";
import { asStringArray, basenameWithoutExtension, inferTypeFromPath, normalizeMarkdownPath } from "../utils/memory-format.js";
import type { MemoryUsageService } from "./memory-usage.service.js";
import type { VaultService } from "./vault.service.js";

const SEARCH_TEXT_LIMIT = 4000;

interface PersistedIndex {
  version: 1;
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
      this.index.upsert(this.buildRecord(relative, mtimeMs));
      changed = true;
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

  async search(query: string, tags: string[], folder?: string, type?: string, limit = 10, offset = 0): Promise<IndexRecord[]> {
    await this.snapshotIndex();
    const matchesFilters = (record: StoredRecord) =>
      (tags.length === 0 || tags.some((tag) => record.tags.includes(tag))) &&
      (!folder || record.path.includes(folder)) &&
      (!type || record.type === type);

    const trimmed = (query ?? "").trim();
    let ranked: StoredRecord[];
    if (!trimmed) {
      // No query terms (e.g. memory_list): newest-first is stable and useful.
      ranked = this.index.list().filter(matchesFilters).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    } else {
      const terms = tokenize(trimmed);
      const boost = this.usage ? this.usage.buildBooster(terms) : () => 0;
      ranked = this.index.rank(terms, boost).filter(matchesFilters);
    }

    return ranked.slice(offset, offset + limit).map(toPublicRecord);
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
    const relativePath = await this.resolveReference(reference);
    const note = this.vault.load(relativePath);
    return {
      path: relativePath,
      title: String(note.parsed.data.title ?? relativePath),
      type: String(note.parsed.data.type ?? inferTypeFromPath(relativePath)),
      frontmatter: note.parsed.data,
      body: note.parsed.content,
      outgoingLinks: Array.from(note.raw.matchAll(/\[\[([^\]]+)\]\]/g)).map((m) => m[1]),
      incomingLinks: [],
    };
  }

  async resolveReference(reference: string) {
    const normalized = normalizeMarkdownPath(reference);
    if (this.vault.exists(normalized)) return normalized;

    const withoutExtension = reference.replace(/\\/g, "/").replace(/\.md$/i, "");
    const records = await this.snapshotIndex();
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
      const records = parsed && parsed.records ? Object.values(parsed.records) : [];
      this.index.bulkUpsert(records.filter((record): record is StoredRecord => Boolean(record && record.path)));
    } catch {
      // Corrupt or outdated cache — ignore; mtimes will rebuild it lazily.
    }
  }

  private persist() {
    try {
      const records: Record<string, StoredRecord> = {};
      for (const record of this.index.list()) records[record.path] = record;
      const payload: PersistedIndex = { version: 1, updatedAt: new Date().toISOString(), records };
      mkdirSync(dirname(this.indexPath), { recursive: true });
      writeFileSync(this.indexPath, `${JSON.stringify(payload)}\n`, "utf8");
    } catch {
      // Best-effort cache; never fail a query because the cache could not be written.
    }
  }
}
