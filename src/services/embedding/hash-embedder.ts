/**
 * Offline, deterministic, dependency-free embedding via the hashing trick.
 *
 * Each document/query is reduced to a sparse bag of lexical features — word
 * tokens, Thai/CJK character n-grams (from searchTokens), and Latin sub-word
 * n-grams for longer words — and each feature is hashed into a fixed-width
 * vector with a signed bucket. The result is L2-normalized so cosine similarity
 * reflects sub-word/lexical overlap. This needs no model and no network, so it
 * is safe in the local-first/offline default posture, and it makes the hybrid
 * pipeline (RRF over lexical + vector arms) real and testable without an
 * external service.
 *
 * It captures sub-word/paraphrase/typo overlap *within* a script; it does NOT
 * bridge languages that share no characters (Thai<->English true synonymy) —
 * that needs a real model via the optional HTTP provider.
 */
import { tokenize } from "../../utils/bm25.js";
import { charNgrams, searchTokens } from "../../utils/ngram.js";
import { l2normalize } from "../../utils/vector.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

// FNV-1a (32-bit). Deterministic and fast; `Math.imul` keeps the multiply in
// 32-bit space across platforms.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Lexical features: word tokens + Thai/CJK n-grams + Latin sub-word n-grams. */
function features(text: string): string[] {
  const out = searchTokens(text);
  for (const word of tokenize(text)) {
    if (word.length >= 5) {
      for (const gram of charNgrams(word, 3, 4)) out.push(gram);
    }
  }
  return out;
}

export class HashEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;

  constructor(dimensions = 256) {
    // Clamp to a sane power-ish range; tiny dims collide too much, huge dims
    // waste cache space for a lexical signal.
    this.dimensions = Math.max(32, Math.min(4096, Math.floor(dimensions) || 256));
    this.id = `hash:v1:${this.dimensions}`;
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.vectorize(text)));
  }

  private vectorize(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const feature of features(String(text ?? ""))) {
      const hash = fnv1a(feature);
      const bucket = hash % this.dimensions;
      // Use a high bit (independent of the bucket bits) for a stable +/- sign so
      // colliding features can cancel rather than always reinforce.
      const sign = (hash & 0x8000) === 0 ? 1 : -1;
      vector[bucket] += sign;
    }
    return l2normalize(vector);
  }
}
