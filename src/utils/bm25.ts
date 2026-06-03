/**
 * Minimal, dependency-free BM25 ranker for the memory index.
 *
 * The tokenizer matches MemoryUsageService.queryTerms so that query terms align
 * with the usage-context keys used for re-ranking (keeps `_` and `-` inside a
 * token, so kebab tags like `session-log` stay one term). Thai code points are
 * preserved alongside ASCII alphanumerics.
 */
export function tokenize(text: unknown): string[] {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9ก-๙_-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
}

/** Repeat a token list `times` times to apply a simple field weight. */
export function weighted(terms: string[], times: number): string[] {
  if (times <= 1) return terms;
  const out: string[] = [];
  for (let i = 0; i < times; i += 1) out.push(...terms);
  return out;
}

export interface RankedDoc<T> {
  doc: T;
  score: number;
}

interface DocStats<T> {
  doc: T;
  tf: Map<string, number>;
  length: number;
}

/**
 * Standard Okapi BM25 over an in-memory document set. Built once from a list of
 * `{ doc, terms }` pairs; `score(queryTerms)` returns every doc with its score
 * (0 when no query term occurs in the doc). Lucene-style IDF (always >= 0).
 */
export class Bm25Index<T> {
  private readonly df = new Map<string, number>();
  private readonly docs: DocStats<T>[] = [];
  private readonly avgdl: number;

  constructor(items: Array<{ doc: T; terms: string[] }>, private readonly k1 = 1.5, private readonly b = 0.75) {
    let totalLength = 0;
    for (const { doc, terms } of items) {
      const tf = new Map<string, number>();
      for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
      for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
      this.docs.push({ doc, tf, length: terms.length });
      totalLength += terms.length;
    }
    this.avgdl = this.docs.length ? totalLength / this.docs.length : 0;
  }

  get size(): number {
    return this.docs.length;
  }

  score(queryTerms: string[]): Array<RankedDoc<T>> {
    const total = this.docs.length;
    const unique = [...new Set(queryTerms)];
    return this.docs.map(({ doc, tf, length }) => {
      let score = 0;
      for (const term of unique) {
        const freq = tf.get(term);
        if (!freq) continue;
        const docFreq = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (total - docFreq + 0.5) / (docFreq + 0.5));
        const norm = this.avgdl > 0 ? length / this.avgdl : 0;
        const denom = freq + this.k1 * (1 - this.b + this.b * norm);
        score += idf * ((freq * (this.k1 + 1)) / denom);
      }
      return { doc, score };
    });
  }
}
