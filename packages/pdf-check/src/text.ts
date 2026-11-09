import type { TextBounds } from "./types";
import { unionBounds } from "./util";

export type Side = "left" | "top" | "right" | "bottom";

export interface PageText {
  number: number;
  width: number;
  height: number;
  text: TextBounds | null;
  /** The text closest to each edge, to show the user what is near the margin. */
  samples: Partial<Record<Side, string>>;
}

/** Matrix product as in pdf.js Util.transform: m1 × m2. */
function mul(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Box of one text run in display space (y down) from its text matrix, viewport transform and advance width.
 * Covers ascent (one font height above the baseline) and a 20% descent; handles rotated text.
 */
export function textItemBox(viewportTransform: number[], itemTransform: number[], width: number): TextBounds {
  const tx = mul(viewportTransform, itemTransform);
  const scaleX = Math.hypot(tx[0], tx[1]) || 1;
  const ux = tx[0] / scaleX;
  const uy = tx[1] / scaleX;
  // `width` is in unscaled user space; the viewport is scale 1, so it maps 1:1 along the text direction.
  const ex = ux * width;
  const ey = uy * width;
  const upx = tx[2];
  const upy = tx[3];
  const x = tx[4];
  const y = tx[5];
  const pts = [
    [x - upx * 0.2, y - upy * 0.2],
    [x + ex - upx * 0.2, y + ey - upy * 0.2],
    [x + upx, y + upy],
    [x + ex + upx, y + ey + upy],
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** The subset of a pdf.js text item this module reads. */
export interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
}

/** The subset of a pdf.js page (`PDFPageProxy`) this module reads. */
export interface PdfjsPageLike {
  getViewport(params: { scale: number }): { width: number; height: number; transform: number[] };
  getTextContent(): Promise<{ items: ReadonlyArray<TextItemLike | object> }>;
  cleanup?(): unknown;
}

/** The subset of a pdf.js document (`PDFDocumentProxy`) this module reads. */
export interface PdfjsDocumentLike {
  numPages: number;
  getPage(n: number): Promise<PdfjsPageLike>;
}

/**
 * Walk every page of an already-loaded pdf.js document and compute the union of text boxes per page.
 * pdf.js itself is not bundled: load the document with your own pdfjs-dist setup (browser worker or Node
 * legacy build) and pass it in. The caller owns the document and should destroy it afterwards.
 */
export async function extractTextBounds(
  doc: PdfjsDocumentLike,
  onProgress?: (done: number, total: number) => void,
): Promise<PageText[]> {
  const result: PageText[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    let bounds: TextBounds | null = null;
    const best: Partial<Record<Side, { d: number; s: string }>> = {};
    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const item = raw as TextItemLike;
      if (!item.str.trim()) continue;
      const box = textItemBox(viewport.transform, item.transform, item.width);
      bounds = unionBounds(bounds, box);
      const dist: Record<Side, number> = {
        left: box.left,
        top: box.top,
        right: viewport.width - box.right,
        bottom: viewport.height - box.bottom,
      };
      for (const side of Object.keys(dist) as Side[]) {
        if (!best[side] || dist[side] < best[side]!.d) best[side] = { d: dist[side], s: item.str.trim().slice(0, 60) };
      }
    }
    const samples: Partial<Record<Side, string>> = {};
    for (const side of Object.keys(best) as Side[]) samples[side] = best[side]!.s;
    result.push({ number: n, width: viewport.width, height: viewport.height, text: bounds, samples });
    page.cleanup?.();
    onProgress?.(n, doc.numPages);
  }
  return result;
}
