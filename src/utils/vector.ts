/**
 * Dependency-free vector helpers for the optional embedding/hybrid layer:
 * L2 normalization, cosine similarity, and Reciprocal Rank Fusion (RRF) for
 * combining several ranked lists into one ordering without comparing their raw
 * (incomparable) score scales.
 */

/** L2-normalize a vector. A zero vector is returned as a copy (no divide-by-0). */
export function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v.slice();
  return v.map((x) => x / norm);
}

/**
 * Cosine similarity in [-1, 1]; 0 when either vector is empty or zero, and 0
 * when the lengths differ — mismatched dimensions mean different embedding
 * spaces, and silently truncating to the shorter length would produce a
 * meaningless score. Computes its own magnitudes so it is correct for
 * un-normalized inputs too.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  let na = 0;
  for (const x of a) na += x * x;
  let nb = 0;
  for (const x of b) nb += x * x;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Reciprocal Rank Fusion over several ranked key lists. Each list is an
 * ordering (best-first) of opaque keys; a key's fused score is the sum over the
 * lists it appears in of `1 / (k + rank)` (1-based rank). `k` (default 60, the
 * standard) dampens how much top ranks dominate. Returns a key -> score map;
 * callers sort the union by score and break ties however they like.
 */
export function reciprocalRankFusion(lists: ReadonlyArray<ReadonlyArray<string>>, k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i += 1) {
      const key = list[i];
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1));
    }
  }
  return scores;
}
