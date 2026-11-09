/** Pure helpers for figure compression (no DOM): sizing, quality search, naming. */

export type OutputFormat = "keep" | "jpeg" | "webp";
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

/** Scale (w, h) down so the longest side is at most `maxDim` (0/undefined = no limit). Never upscales. */
export function fitWithin(w: number, h: number, maxDim?: number): { width: number; height: number; scaled: boolean } {
  if (!maxDim || maxDim <= 0 || Math.max(w, h) <= maxDim) return { width: w, height: h, scaled: false };
  const k = maxDim / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), scaled: true };
}

/** Output mime for an input mime and the chosen format. */
export function outputMime(input: string, format: OutputFormat): ImageMime {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  if (input === "image/jpeg" || input === "image/webp") return input;
  return "image/png";
}

/** Mime type from the File type, falling back to the extension (some drag sources leave type empty). */
export function mimeOf(type: string, name: string): string {
  if (type) return type;
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "pdf") return "application/pdf";
  return "";
}

export function isLossy(mime: string): boolean {
  return mime === "image/jpeg" || mime === "image/webp";
}

const EXT: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** `plot.png` + jpeg → `plot.jpg`; keeps the base name so LaTeX \includegraphics paths stay predictable. */
export function outputName(name: string, mime: ImageMime | "application/pdf"): string {
  const base = name.replace(/\.[^./]+$/, "");
  const ext = mime === "application/pdf" ? "pdf" : EXT[mime];
  return `${base}.${ext}`;
}

/** Percentage saved (positive = smaller). */
export function percentSaved(before: number, after: number): number {
  if (before <= 0) return 0;
  return ((before - after) / before) * 100;
}

export interface QualitySearchResult {
  quality: number;
  size: number;
  /** True when even the lowest quality could not reach the target. */
  reachedTarget: boolean;
  steps: number;
}

/**
 * Binary-search the highest encoder quality whose output fits in `targetBytes`.
 * `encode(q)` must return the encoded size for quality q in [0, 1].
 */
export async function searchQuality(
  encode: (q: number) => Promise<number>,
  targetBytes: number,
  { min = 0.05, max = 0.95, iterations = 7 }: { min?: number; max?: number; iterations?: number } = {},
): Promise<QualitySearchResult> {
  let steps = 0;
  const topSize = await encode(max);
  steps++;
  if (topSize <= targetBytes) return { quality: max, size: topSize, reachedTarget: true, steps };
  const lowSize = await encode(min);
  steps++;
  if (lowSize > targetBytes) return { quality: min, size: lowSize, reachedTarget: false, steps };
  let lo = min;
  let hi = max;
  let best = { quality: min, size: lowSize };
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const size = await encode(mid);
    steps++;
    if (size <= targetBytes) {
      best = { quality: mid, size };
      lo = mid;
    } else hi = mid;
  }
  return { ...best, reachedTarget: true, steps };
}
