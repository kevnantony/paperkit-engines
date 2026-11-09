# @paperkit/pdf-check

Camera-ready PDF checks from PaperKit: all fonts embedded, no Type 3 fonts, PDF version, page size (Letter/A4, per venue), page limit, encryption, JavaScript/attachments/file links, metadata, and text-to-edge margins. Structure is read with [pdf-lib](https://pdf-lib.js.org); the checks are pure functions over a JSON-serialisable `PdfFacts` object. Runs in Node 18+ and browsers.

## Install

```sh
npm install @paperkit/pdf-check
```

## Usage

```js
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfFacts, runChecks, optionsForVenue, summarize } from "@paperkit/pdf-check";

// Any PDF bytes work; here we make an A4 page with a non-embedded standard font.
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
doc.addPage([595.28, 841.89]).drawText("Hello", { x: 72, y: 720, font });
const bytes = await doc.save();

const facts = await extractPdfFacts(bytes);
const rows = runChecks(facts, optionsForVenue("ieee", 8));
for (const r of rows) console.log(r.status.padEnd(4), r.id, "-", r.summary);
// fail fonts - 1 of 1 fonts is not embedded.
// pass type3 - No Type 3 (bitmap or procedure) fonts found.
// fail page-size - A4 (210 × 297 mm), but this venue expects Letter.
// ...
// skip margins - Text positions could not be read, so margins were not checked.
console.log(summarize(facts, rows)); // { pages: 1, fonts: 1, fontsEmbedded: 0, fails: 2, warnings: 1, passes: 5 }
```

### Margin check (optional text pass)

Margins need text positions. This package does not bundle pdf.js; load the document with your own `pdfjs-dist` and pass it to `extractTextBounds`:

```ts
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractPdfFacts, extractTextBounds } from "@paperkit/pdf-check";

const facts = await extractPdfFacts(bytes, {
  extractText: async (b) => {
    const task = pdfjs.getDocument({ data: b.slice(), isEvalSupported: false });
    try { return await extractTextBounds(await task.promise); } finally { await task.destroy(); }
  },
});
```

## API

- **Facts:** `extractPdfFacts(bytes, { extractText?, onProgress? })`, `extractStructure(bytes)` (pdf-lib only), `extractTextBounds(pdfjsDocument)`, `textItemBox`, `mergeText`, `PdfReadError`. Types: `PdfFacts`, `PageFact`, `FontFact`, `TextBounds`, `Permissions`.
- **Checks:** `runChecks(facts, options)`, `checkFonts`, `checkType3`, `checkVersion`, `checkPageSize`, `checkPageCount`, `checkEncryption`, `checkActiveContent`, `checkMetadata`, `checkMargins`, `findMarginViolations`, `groupPageSizes`, `summarize`, `reportToText`, `parsePageLimit`.
- **Venues:** `VENUES` (generic, IEEE, ACM, LNCS, arXiv), `getVenue`, `optionsForVenue(id, pageLimit?)`.
- **Utilities:** `PAPER_SIZES`, `classifyPageSize`, `describePageSize`, `compareVersions`, `readHeaderVersion`, `decodePermissions`, `stripSubsetPrefix`, `unionBounds`, `formatPageList`, `PT_PER_INCH`, `PT_PER_MM`.

## Part of PaperKit

This package is one of the open-source engines behind **[PaperKit](https://paperkit.pages.dev)** — free research paper tools that run in your browser. Everything runs locally: no uploads, no server round-trips.

Source, issues and the other engines: [kevnantony/paperkit-engines](https://github.com/kevnantony/paperkit-engines).

## License

MIT © 2026 Kevin Antony
