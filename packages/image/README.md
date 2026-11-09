# @paperkit/image

Pure figure helpers from PaperKit, with no canvas and no dependencies: find the content bounding box of an RGBA pixel buffer (whitespace cropping), map pixel boxes to PDF MediaBox/CropBox rectangles (pdfcrop-style, rotation-aware), and binary-search an encoder quality that hits a target file size. Bring your own decoder/encoder (canvas, OffscreenCanvas, sharp, ...). Runs in Node 18+ and browsers.

## Install

```sh
npm install @paperkit/image
```

## Usage

```js
import { contentBBox, padBBox, pixelBoxToPdfRect, searchQuality } from "@paperkit/image";

// 10×10 white image with a black 2×3 block at (4, 2). Works with canvas getImageData().data too.
const width = 10, height = 10;
const data = new Uint8ClampedArray(width * height * 4).fill(255);
for (let y = 2; y < 5; y++) for (let x = 4; x < 6; x++) data.set([0, 0, 0, 255], (y * width + x) * 4);

const box = contentBBox({ data, width, height });
console.log(box); // { x: 4, y: 2, width: 2, height: 3 }
console.log(padBBox(box, 1, width, height)); // { x: 3, y: 1, width: 4, height: 5 }

// Same box on a 10×10 pt PDF page rendered at scale 1: PDF y axis points up.
console.log(pixelBoxToPdfRect(box, [0, 0, 10, 10], 1, 0)); // [4, 5, 6, 8]

// Highest quality whose encoded size fits in 50 kB (encode() returns a byte size).
const encode = async (q) => Math.round(20_000 + q * 60_000);
const { quality, reachedTarget } = await searchQuality(encode, 50_000);
console.log(reachedTarget, quality.toFixed(2)); // true 0.50
```

## API

- **Bounding boxes:** `detectBackground(buf)`, `contentBBox(buf, { threshold?, background? })`, `padBBox`.
- **PDF crop math:** `viewportTransform`, `pixelBoxToPdfRect`, `padPdfRect`. Types: `PixelBuffer`, `BBox`, `PdfRect`, `RGBA`.
- **Compression helpers:** `searchQuality(encode, targetBytes, { min, max, iterations })`, `fitWithin`, `outputMime`, `outputName`, `mimeOf`, `isLossy`, `percentSaved`.

## Part of PaperKit

This package is one of the open-source engines behind **[PaperKit](https://paperkit.app)** <!-- TODO(lead): replace https://paperkit.app with the final PaperKit site URL --> — free research paper tools that run in your browser. Everything runs locally: no uploads, no server round-trips.

Source, issues and the other engines: [kevnantony/paperkit-engines](https://github.com/kevnantony/paperkit-engines).

## License

MIT © 2026 Kevin Antony
