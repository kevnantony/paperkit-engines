import { plainText } from "./text";

/** Normalized title for comparison: plain lowercase ASCII words. */
export function normalizeTitle(title: string): string {
  return plainText(title);
}

export function tokenJaccard(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 1 − distance / longer length, in [0, 1]. */
export function levenshteinRatio(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  return len === 0 ? 1 : 1 - levenshtein(a, b) / len;
}

/**
 * Edit distance if it is at most `k`, otherwise k + 1. Only a diagonal band of width 2k+1 is
 * computed, so this is O(k·n) instead of O(n²).
 */
export function levenshteinBounded(a: string, b: string, k: number): number {
  if (Math.abs(a.length - b.length) > k) return k + 1;
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  const BIG = k + 1;
  let prev = new Array<number>(m + 1).fill(BIG);
  let cur = new Array<number>(m + 1).fill(BIG);
  for (let j = 0; j <= Math.min(m, k); j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(1, i - k);
    const hi = Math.min(m, i + k);
    cur.fill(BIG);
    cur[0] = i <= k ? i : BIG;
    let rowMin = cur[0];
    for (let j = lo; j <= hi; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v > BIG ? BIG : v;
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > k) return BIG;
    [prev, cur] = [cur, prev];
  }
  return Math.min(prev[m], BIG);
}

/**
 * Like titleSimilarity, but returns 0 as soon as it is clear the score is below `t`.
 * Pass precomputed token sets to avoid rebuilding them for every pair.
 */
export function titleSimilarityAtLeast(a: string, b: string, t: number, setA?: Set<string>, setB?: Set<string>): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = setA ?? new Set(a.split(" "));
  const B = setB ?? new Set(b.split(" "));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  // Same words in a different order ("The Art of Computer Programming" / "The Programming of Computer Art")
  // are not the same title: the word-set score only counts when the words appear in the same order.
  const raw = inter / (A.size + B.size - inter);
  const j = raw >= t && !sameWordOrder(a, b) ? 0 : raw;
  const maxLen = Math.max(a.length, b.length);
  const lenRatio = Math.min(a.length, b.length) / maxLen;
  // Edit-distance ratio can never exceed the length ratio.
  if (lenRatio < 0.85 || raw < 0.5 || lenRatio < t) return j >= t ? j : 0;
  const k = Math.floor((1 - t) * maxLen);
  const d = levenshteinBounded(a, b, k);
  const lev = d > k ? 0 : 1 - d / maxLen;
  const best = Math.max(j, lev);
  return best >= t ? best : 0;
}

/**
 * Similarity of two already-normalized titles: max of token Jaccard and Levenshtein ratio.
 * Cheap pre-filters skip the quadratic edit distance for clearly different strings.
 */
export function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const raw = tokenJaccard(a, b);
  const j = raw >= 0.5 && !sameWordOrder(a, b) ? raw / 2 : raw;
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (lenRatio < 0.85 || raw < 0.5) return j;
  return Math.max(j, levenshteinRatio(a, b));
}

/**
 * True when the shared words of two titles appear in (nearly) the same order: the longest common
 * subsequence of words covers at least 80% of the shorter title.
 */
export function sameWordOrder(a: string, b: string): boolean {
  const A = a.split(" ");
  const B = b.split(" ");
  let prev = new Array<number>(B.length + 1).fill(0);
  let cur = new Array<number>(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return prev[B.length] >= 0.8 * Math.min(A.length, B.length);
}
