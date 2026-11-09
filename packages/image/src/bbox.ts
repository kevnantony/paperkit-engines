/** Pure content-bounding-box logic on RGBA pixel buffers (as returned by canvas getImageData). */

export interface PixelBuffer {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RGBA = [number, number, number, number];

/** Background colour guessed from the four corners: the most common corner colour (ties → top-left). */
export function detectBackground(buf: PixelBuffer): RGBA {
  const { data, width: w, height: h } = buf;
  const at = (x: number, y: number): RGBA => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
  const key = (c: RGBA) => c.join(",");
  const counts = new Map<string, number>();
  for (const c of corners) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
  let best = corners[0];
  for (const c of corners) if ((counts.get(key(c)) ?? 0) > (counts.get(key(best)) ?? 0)) best = c;
  return best;
}

export interface BBoxOptions {
  /** Per-channel tolerance 0–255: pixels within it of the background count as background. Default 10. */
  threshold?: number;
  /** Override the detected background colour. */
  background?: RGBA;
}

/**
 * Smallest box containing every non-background pixel, or null if the image is blank.
 * Transparent backgrounds compare alpha only; opaque backgrounds compare colour, and
 * fully transparent pixels count as background.
 */
export function contentBBox(buf: PixelBuffer, opts: BBoxOptions = {}): BBox | null {
  const { data, width: w, height: h } = buf;
  if (w === 0 || h === 0) return null;
  const t = opts.threshold ?? 10;
  const bg = opts.background ?? detectBackground(buf);
  const transparentBg = bg[3] < 128;

  const isContent = (i: number) => {
    const a = data[i + 3];
    if (transparentBg) return a > t;
    if (a <= t) return false;
    return Math.abs(data[i] - bg[0]) > t || Math.abs(data[i + 1] - bg[1]) > t || Math.abs(data[i + 2] - bg[2]) > t;
  };

  const rowHas = (y: number, x0 = 0, x1 = w) => {
    for (let x = x0; x < x1; x++) if (isContent((y * w + x) * 4)) return true;
    return false;
  };

  let top = 0;
  while (top < h && !rowHas(top)) top++;
  if (top === h) return null;
  let bottom = h - 1;
  while (bottom > top && !rowHas(bottom)) bottom--;

  const colHas = (x: number) => {
    for (let y = top; y <= bottom; y++) if (isContent((y * w + x) * 4)) return true;
    return false;
  };
  let left = 0;
  while (left < w && !colHas(left)) left++;
  let right = w - 1;
  while (right > left && !colHas(right)) right--;

  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Grow a box by `margin` on every side, clamped to [0, maxW] × [0, maxH] when bounds are given. */
export function padBBox(b: BBox, margin: number, maxW = Infinity, maxH = Infinity): BBox {
  const x0 = Math.max(0, b.x - margin);
  const y0 = Math.max(0, b.y - margin);
  const x1 = Math.min(maxW, b.x + b.width + margin);
  const y1 = Math.min(maxH, b.y + b.height + margin);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/* ---------------- PDF mapping ---------------- */

/** PDF rectangle in user space: [x0, y0, x1, y1] with x0<x1, y0<y1. */
export type PdfRect = [number, number, number, number];

/**
 * The affine transform pdf.js uses for a page viewport (PageViewport): maps PDF user space
 * to canvas pixels for a given viewBox, scale and rotation (0/90/180/270).
 */
export function viewportTransform(viewBox: PdfRect, scale: number, rotation: number): [number, number, number, number, number, number] {
  const [x1, y1, x2, y2] = viewBox;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  let a: number, b: number, c: number, d: number;
  switch ((((rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270) {
    case 90:
      [a, b, c, d] = [0, 1, 1, 0];
      break;
    case 180:
      [a, b, c, d] = [-1, 0, 0, 1];
      break;
    case 270:
      [a, b, c, d] = [0, -1, -1, 0];
      break;
    default:
      [a, b, c, d] = [1, 0, 0, -1];
  }
  let ox: number, oy: number;
  if (a === 0) {
    ox = Math.abs(cy - y1) * scale;
    oy = Math.abs(cx - x1) * scale;
  } else {
    ox = Math.abs(cx - x1) * scale;
    oy = Math.abs(cy - y1) * scale;
  }
  return [a * scale, b * scale, c * scale, d * scale, ox - a * scale * cx - c * scale * cy, oy - b * scale * cx - d * scale * cy];
}

/** Map a pixel box on a rendered page back to a PDF user-space rectangle. */
export function pixelBoxToPdfRect(box: BBox, viewBox: PdfRect, scale: number, rotation: number): PdfRect {
  const [a, b, c, d, e, f] = viewportTransform(viewBox, scale, rotation);
  const det = a * d - b * c;
  const toPdf = (px: number, py: number): [number, number] => {
    const x = px - e;
    const y = py - f;
    return [(d * x - c * y) / det, (-b * x + a * y) / det];
  };
  const pts = [
    toPdf(box.x, box.y),
    toPdf(box.x + box.width, box.y),
    toPdf(box.x, box.y + box.height),
    toPdf(box.x + box.width, box.y + box.height),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Expand a PDF rect by `margin` points, clamped to `bounds`. */
export function padPdfRect(r: PdfRect, margin: number, bounds: PdfRect): PdfRect {
  return [
    Math.max(bounds[0], r[0] - margin),
    Math.max(bounds[1], r[1] - margin),
    Math.min(bounds[2], r[2] + margin),
    Math.min(bounds[3], r[3] + margin),
  ];
}
