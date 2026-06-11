/**
 * Cross-script tokenization for the memory index.
 *
 * `tokenize` (bm25.ts) splits on whitespace/punctuation, which works for
 * space-delimited scripts (Latin) but collapses an entire Thai/CJK phrase into
 * one giant, effectively unsearchable token — those scripts write words with no
 * inter-word spaces. `searchTokens` augments the word tokens with character
 * n-grams over runs of such scripts so a partial Thai/CJK query can still match.
 *
 * Latin/digit text is left byte-identical to `tokenize` (no n-grams added), so
 * English and code ranking is unchanged; only non-space-delimited runs gain the
 * extra n-gram terms. `tokenize` stays the canonical word tokenizer used by the
 * usage-scoring keys, so this never disturbs that alignment.
 */
import { tokenize } from "./bm25.js";

// BMP code-point ranges for scripts written without inter-word spaces, so
// whitespace tokenization can't segment them. Built from numeric bounds (no
// literal glyphs) so the boundaries are exact and the source stays ASCII.
const CJK_THAI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0e00, 0x0e7f], // Thai
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xac00, 0xd7af], // Hangul Syllables
];

const CJK_THAI_CLASS = CJK_THAI_RANGES
  .map(([lo, hi]) => `\\u${lo.toString(16).padStart(4, "0")}-\\u${hi.toString(16).padStart(4, "0")}`)
  .join("");

// A run of >= 2 such characters gets character n-grams. `match()` ignores the
// `g`-flag lastIndex, so reusing this shared instance across calls is safe.
const CJK_THAI_RUN = new RegExp(`[${CJK_THAI_CLASS}]{2,}`, "g");

const MIN_N = 2;
const MAX_N = 3;

/**
 * Sliding character n-grams (`minN`..`maxN`) over a string, code-point safe.
 * A run shorter than `n` contributes no n-gram of that length. Used both for
 * the cross-script lexical tokens and (over Latin words too) by the hash
 * embedder's feature extraction.
 */
export function charNgrams(run: string, minN = MIN_N, maxN = MAX_N): string[] {
  const chars = Array.from(String(run ?? ""));
  const out: string[] = [];
  for (let n = minN; n <= maxN; n += 1) {
    for (let i = 0; i + n <= chars.length; i += 1) {
      out.push(chars.slice(i, i + n).join(""));
    }
  }
  return out;
}

/**
 * Word tokens plus character n-grams for any non-space-delimited (Thai/CJK)
 * runs in the text. Every n-gram occurrence is kept (NOT de-duplicated): BM25
 * term frequency needs a keyword appearing 10x to emit its grams 10x, or that
 * document ranks no higher than one mentioning it once. Query-side callers
 * that want a distinct term list must dedupe it themselves. Returns the plain
 * word tokens unchanged when the text has no such runs.
 */
export function searchTokens(text: unknown): string[] {
  const words = tokenize(text);
  const runs = String(text ?? "").toLowerCase().match(CJK_THAI_RUN);
  if (!runs) return words;
  const out = [...words];
  for (const run of runs) out.push(...charNgrams(run));
  return out;
}
