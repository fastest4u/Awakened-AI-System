import type { IndexRepository, IndexRecord } from "../repositories/index.repository.js";
import { asStringArray, basenameWithoutExtension, inferTypeFromPath, normalizeMarkdownPath } from "../utils/memory-format.js";
import type { VaultService } from "./vault.service.js";

export class MemoryQueryService {
  constructor(private readonly vault: VaultService, private readonly index: IndexRepository) {}

  async snapshotIndex() {
    const files = await this.vault.listMarkdownFiles();
    const records: IndexRecord[] = files.map((fullPath) => {
      const relative = this.vault.relativePath(fullPath);
      const raw = this.vault.load(relative);
      const title = String(raw.parsed.data.title ?? relative);
      const type = String(raw.parsed.data.type ?? inferTypeFromPath(relative));
      return {
        id: raw.parsed.data.id ? String(raw.parsed.data.id) : undefined,
        path: relative,
        title,
        type,
        tags: asStringArray(raw.parsed.data.tags),
        aliases: asStringArray(raw.parsed.data.aliases),
        updatedAt: String(raw.parsed.data.updated ?? raw.parsed.data["last-verified"] ?? ""),
        createdAt: String(raw.parsed.data.created ?? raw.parsed.data["session-date"] ?? raw.parsed.data["decision-date"] ?? ""),
        excerpt: raw.parsed.content.trim().slice(0, 360),
      };
    });
    this.index.bulkUpsert(records);
    return records;
  }

  async search(query: string, tags: string[], folder?: string, type?: string, limit = 10, offset = 0) {
    await this.snapshotIndex();
    return this.index.search(query).filter((record) => {
      const matchesTags = tags.length === 0 || tags.some((tag) => record.tags.includes(tag));
      const matchesFolder = !folder || record.path.includes(folder);
      const matchesType = !type || record.type === type;
      return matchesTags && matchesFolder && matchesType;
    }).slice(offset, offset + limit);
  }

  async recent(folders: string[], types: string[], sortBy: "updated" | "created", limit: number) {
    await this.snapshotIndex();
    return this.index.list().filter((record) => {
      if (folders.length && !folders.some((folder) => record.path.includes(folder))) return false;
      if (types.length && !types.includes(record.type)) return false;
      return true;
    }).sort((a, b) => String(b[sortBy === "updated" ? "updatedAt" : "createdAt"]).localeCompare(String(a[sortBy === "updated" ? "updatedAt" : "createdAt"]))).slice(0, limit);
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
}
