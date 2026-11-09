import type { Permissions, TextBounds } from "./types";

export const PT_PER_INCH = 72;
export const PT_PER_MM = 72 / 25.4;

export type PaperName = "Letter" | "A4" | "Legal" | "A3" | "A5";

export const PAPER_SIZES: Record<PaperName, { width: number; height: number }> = {
  Letter: { width: 612, height: 792 },
  A4: { width: 595.28, height: 841.89 },
  Legal: { width: 612, height: 1008 },
  A3: { width: 841.89, height: 1190.55 },
  A5: { width: 419.53, height: 595.28 },
};

/** Tolerance in points when matching a page to a named paper size (~1 mm). */
const SIZE_TOLERANCE = 3;

/** Name a page size ("Letter", "A4" …, with " landscape" when wider than tall) or null if it is custom. */
export function classifyPageSize(width: number, height: number): string | null {
  const portrait = { w: Math.min(width, height), h: Math.max(width, height) };
  for (const [name, s] of Object.entries(PAPER_SIZES)) {
    if (Math.abs(portrait.w - s.width) <= SIZE_TOLERANCE && Math.abs(portrait.h - s.height) <= SIZE_TOLERANCE) {
      return width > height ? `${name} landscape` : name;
    }
  }
  return null;
}

/** Human label for a page size: "Letter (8.5 × 11 in)" or "Custom (500 × 700 pt)". */
export function describePageSize(width: number, height: number): string {
  const name = classifyPageSize(width, height);
  const inch = `${fmt(width / PT_PER_INCH)} × ${fmt(height / PT_PER_INCH)} in`;
  const mm = `${Math.round(width / PT_PER_MM)} × ${Math.round(height / PT_PER_MM)} mm`;
  if (name?.startsWith("A")) return `${name} (${mm})`;
  if (name) return `${name} (${inch})`;
  return `Custom (${inch})`;
}

function fmt(n: number): string {
  return Number(n.toFixed(2)).toString();
}

/** Remove the 6 uppercase letter subset tag ("ABCDEF+Times-Roman" → "Times-Roman"). */
export function stripSubsetPrefix(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, "");
}

/** Compare "1.4" vs "1.7" style versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Read the "%PDF-x.y" header from the first KB of the file. */
export function readHeaderVersion(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const m = head.match(/%PDF-(\d+\.\d+)/);
  return m ? m[1] : null;
}

/** Decode the /P permission integer of a standard security handler (PDF 32000-1, table 22). */
export function decodePermissions(p: number): Permissions {
  const bit = (n: number) => ((p >>> (n - 1)) & 1) === 1;
  return {
    print: bit(3),
    modify: bit(4),
    copy: bit(5),
    annotate: bit(6),
    fillForms: bit(9),
    assemble: bit(11),
    printHighQuality: bit(12),
  };
}

export function unionBounds(a: TextBounds | null, b: TextBounds): TextBounds {
  if (!a) return { ...b };
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/** Compact page list: [1,2,3,5,7,8] → "1–3, 5, 7–8". */
export function formatPageList(pages: number[], max = 12): string {
  const sorted = [...new Set(pages)].sort((x, y) => x - y);
  const ranges: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    ranges.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  if (ranges.length > max) return `${ranges.slice(0, max).join(", ")} …`;
  return ranges.join(", ");
}
