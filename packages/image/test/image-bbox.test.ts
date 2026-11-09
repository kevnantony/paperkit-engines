import { describe, expect, it } from "vitest";
import { contentBBox, detectBackground, padBBox, padPdfRect, pixelBoxToPdfRect, viewportTransform, type PdfRect, type RGBA } from "../src";

/** Synthetic RGBA buffer filled with `bg`, with rectangles painted in `fg`. */
function makeBuffer(w: number, h: number, bg: RGBA, rects: { x: number; y: number; w: number; h: number; c: RGBA }[] = []) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(bg, i * 4);
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) data.set(r.c, (y * w + x) * 4);
  return { data, width: w, height: h };
}

const WHITE: RGBA = [255, 255, 255, 255];
const BLACK: RGBA = [0, 0, 0, 255];

describe("contentBBox", () => {
  it("finds a single rectangle on white", () => {
    const buf = makeBuffer(50, 40, WHITE, [{ x: 10, y: 5, w: 20, h: 8, c: BLACK }]);
    expect(contentBBox(buf)).toEqual({ x: 10, y: 5, width: 20, height: 8 });
  });

  it("unions several marks", () => {
    const buf = makeBuffer(60, 60, WHITE, [
      { x: 5, y: 30, w: 2, h: 2, c: BLACK },
      { x: 40, y: 3, w: 10, h: 1, c: [200, 0, 0, 255] },
    ]);
    expect(contentBBox(buf)).toEqual({ x: 5, y: 3, width: 45, height: 29 });
  });

  it("returns null for a blank image", () => {
    expect(contentBBox(makeBuffer(10, 10, WHITE))).toBeNull();
  });

  it("ignores near-background noise under the threshold", () => {
    const buf = makeBuffer(30, 30, WHITE, [
      { x: 1, y: 1, w: 1, h: 1, c: [250, 250, 250, 255] },
      { x: 10, y: 10, w: 5, h: 5, c: [120, 120, 120, 255] },
    ]);
    expect(contentBBox(buf, { threshold: 10 })).toEqual({ x: 10, y: 10, width: 5, height: 5 });
    expect(contentBBox(buf, { threshold: 2 })).toEqual({ x: 1, y: 1, width: 14, height: 14 });
  });

  it("handles transparent backgrounds by alpha", () => {
    const buf = makeBuffer(20, 20, [0, 0, 0, 0], [{ x: 3, y: 4, w: 5, h: 6, c: [255, 255, 255, 255] }]);
    expect(detectBackground(buf)[3]).toBe(0);
    expect(contentBBox(buf)).toEqual({ x: 3, y: 4, width: 5, height: 6 });
  });

  it("handles dark (non-white) backgrounds", () => {
    const buf = makeBuffer(20, 20, [30, 30, 30, 255], [{ x: 0, y: 19, w: 4, h: 1, c: WHITE }]);
    expect(contentBBox(buf)).toEqual({ x: 0, y: 19, width: 4, height: 1 });
  });

  it("detects the majority corner colour even when content touches one corner", () => {
    const buf = makeBuffer(10, 10, WHITE, [{ x: 0, y: 0, w: 3, h: 3, c: BLACK }]);
    expect(detectBackground(buf)).toEqual(WHITE);
    expect(contentBBox(buf)).toEqual({ x: 0, y: 0, width: 3, height: 3 });
  });

  it("handles a 1×1 content pixel and full-bleed content", () => {
    expect(contentBBox(makeBuffer(9, 9, WHITE, [{ x: 4, y: 4, w: 1, h: 1, c: BLACK }]))).toEqual({ x: 4, y: 4, width: 1, height: 1 });
    expect(contentBBox(makeBuffer(4, 4, WHITE), { background: BLACK })).toEqual({ x: 0, y: 0, width: 4, height: 4 });
  });
});

describe("padBBox", () => {
  it("adds margin and clamps to the image", () => {
    expect(padBBox({ x: 2, y: 10, width: 5, height: 5 }, 4, 20, 16)).toEqual({ x: 0, y: 6, width: 11, height: 10 });
  });
});

describe("PDF mapping", () => {
  const view: PdfRect = [0, 0, 200, 100];
  it("matches pdf.js viewport transform for rotation 0", () => {
    expect(viewportTransform(view, 2, 0)).toEqual([2, 0, 0, -2, 0, 200]);
  });

  it("maps pixel boxes back to user space (rotation 0, y flipped)", () => {
    // Content at PDF x 50–100, y 20–60 → canvas (scale 2) x 100–200, y 80–160.
    const r = pixelBoxToPdfRect({ x: 100, y: 80, width: 100, height: 80 }, view, 2, 0);
    expect(r.map((v) => Math.round(v * 1000) / 1000)).toEqual([50, 20, 100, 60]);
  });

  it("honours a non-zero view origin", () => {
    const r = pixelBoxToPdfRect({ x: 0, y: 0, width: 10, height: 10 }, [100, 200, 300, 400], 1, 0);
    expect(r).toEqual([100, 390, 110, 400]);
  });

  it("round-trips through every rotation", () => {
    for (const rot of [0, 90, 180, 270]) {
      const [a, b, c, d, e, f] = viewportTransform(view, 1.5, rot);
      const pdfRect: PdfRect = [30, 10, 90, 70];
      const pts = [
        [pdfRect[0], pdfRect[1]],
        [pdfRect[2], pdfRect[3]],
      ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
      const box = {
        x: Math.min(pts[0][0], pts[1][0]),
        y: Math.min(pts[0][1], pts[1][1]),
        width: Math.abs(pts[0][0] - pts[1][0]),
        height: Math.abs(pts[0][1] - pts[1][1]),
      };
      expect(pixelBoxToPdfRect(box, view, 1.5, rot).map((v) => Math.round(v * 1000) / 1000)).toEqual(pdfRect);
    }
  });

  it("pads PDF rects within the page", () => {
    expect(padPdfRect([5, 10, 190, 95], 10, view)).toEqual([0, 0, 200, 100]);
    expect(padPdfRect([50, 20, 100, 60], 2, view)).toEqual([48, 18, 102, 62]);
  });
});
