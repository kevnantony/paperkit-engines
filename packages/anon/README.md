# @paperkit/anon

Double-blind anonymity audit for paper submissions. Scans LaTeX sources and extracted PDF text for author names, emails, institutions, self-citations ("our previous work [3]"), GitHub/Hugging Face links, local paths and acknowledgements; reads and strips PDF metadata (Info dictionary and XMP) and image EXIF/XMP/PNG text. Runs in Node 18+ and browsers.

PDF *text extraction* is not bundled: pass the page strings you extracted (pdf.js in the browser, pdfjs-dist or any other tool in Node).

## Install

```sh
npm install @paperkit/anon
```

## Usage

```js
import { PDFDocument } from "pdf-lib";
import { runAudit, readPdfMetadata, stripPdfMetadata } from "@paperkit/anon";

// A PDF whose metadata gives the author away.
const doc = await PDFDocument.create();
doc.addPage();
doc.setAuthor("Jane Doe");
const pdf = await doc.save();

const report = await runAudit({
  identifiers: ["Jane Doe", "Example University"],
  pdf: {
    name: "paper.pdf",
    bytes: pdf,
    pages: ["In our previous work [3] we released code at https://github.com/janedoe/tool."],
  },
});
console.log(report.stats.high > 0); // true
console.log([...new Set(report.findings.map((f) => f.rule))]); // ["pdf-metadata", "repo-link", "self-citation"]

const clean = await stripPdfMetadata(pdf);
console.log((await readPdfMetadata(clean)).author); // null
```

## API

- **Audit:** `runAudit({ identifiers, pdf?: { name, bytes, pages }, zip?: { name, bytes } })` → `{ findings, stats, metadata }`; `scanSourceZip`, `sortFindings`, `formatLocation`, `reportToMarkdown`.
- **Rules:** `scanPdfPages(pages, identifiers)`, `scanSourceFile(path, text, identifiers)`, `scanPdfMetadata`, `selfCitationMatches`, `isScannableSource`, `hasLocalPath`, and the regexes `EMAIL_RE`, `REPO_URL_RE`, `INSTITUTION_RE`, `SELF_CITATION_RES`, `LOCAL_PATH_RE`.
- **Identifiers:** `parseIdentifiers`, `identifierPattern`, `identifierRegex`, `findIdentifier`, `findAll`, `snippetAround`, `lineOf`.
- **PDF metadata (pdf-lib):** `readPdfMetadata`, `stripPdfMetadata(bytes, { keepTitle })`, `xmpAuthors`, `METADATA_FIELDS`.
- **Image metadata:** `readImageMeta`, `readJpegMeta`, `readPngMeta`, `parseTiffAuthors`.
- **Types:** `Finding`, `Severity`, `RuleId`, `severityOrder`.

LaTeX comment handling comes from [`@paperkit/arxiv`](https://github.com/kevnantony/paperkit-engines/tree/main/packages/arxiv).

## Part of PaperKit

This package is one of the open-source engines behind **[PaperKit](https://paperkit.app)** <!-- TODO(lead): replace https://paperkit.app with the final PaperKit site URL --> — free research paper tools that run in your browser. Everything runs locally: no uploads, no server round-trips.

Source, issues and the other engines: [kevnantony/paperkit-engines](https://github.com/kevnantony/paperkit-engines).

## License

MIT © 2026 Kevin Antony
