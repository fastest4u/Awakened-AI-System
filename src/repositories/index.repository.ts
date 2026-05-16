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

export class IndexRepository {
  private readonly records = new Map<string, IndexRecord>();

  upsert(record: IndexRecord) {
    this.records.set(record.path, record);
  }

  bulkUpsert(records: IndexRecord[]) {
    for (const record of records) {
      this.upsert(record);
    }
  }

  get(path: string) {
    return this.records.get(path);
  }

  list() {
    return Array.from(this.records.values());
  }

  search(query: string) {
    const normalized = query.toLowerCase();
    return this.list().filter((record) => {
      const haystack = `${record.id ?? ""}\n${record.path}\n${record.title}\n${record.excerpt}\n${record.tags.join(" ")}\n${record.aliases.join(" ")}`.toLowerCase();
      return normalized.length === 0 || haystack.includes(normalized);
    });
  }
}
