# PaperKit engines

The open-source processing engines behind **[PaperKit](https://paperkit.app)** — free research paper tools that run in your browser.
<!-- TODO(lead): replace https://paperkit.app (here and in every packages/*/README.md) with the final PaperKit site URL. -->

These packages parse BibTeX, count LaTeX words, convert tables, clean arXiv submissions, audit double-blind anonymity and check camera-ready PDFs. They are plain TypeScript with no DOM access at import time, so the same code runs in Node 18+ and in the browser. **Everything runs locally: nothing is uploaded, and no network request is made unless you pass a `fetch` function yourself** (DOI/arXiv lookup in `@paperkit/bibtex`).

## Packages

| Package | What it does |
| --- | --- |
| [`@paperkit/bibtex`](packages/bibtex) | BibTeX parser/serializer, cleaner, duplicate finder, DOI/arXiv to BibTeX lookup (injectable fetch). |
| [`@paperkit/latex`](packages/latex) | texcount-style word count, CSV/TSV/Markdown to LaTeX tables, `\input`/`\include` and Overleaf zip resolution. |
| [`@paperkit/arxiv`](packages/arxiv) | Safe comment stripping, include graph, cleanup plan and clean zip for arXiv submissions. |
| [`@paperkit/anon`](packages/anon) | Double-blind anonymity audit: identifiers, self-citations, repo links, PDF/image metadata read and strip. |
| [`@paperkit/pdf-check`](packages/pdf-check) | Camera-ready PDF checks: embedded fonts, Type 3, version, page size, page limit, encryption, active content, margins. |
| [`@paperkit/image`](packages/image) | Whitespace bounding boxes on pixel buffers, PDF crop-box math, target-size quality search. |

## Install

```sh
npm install @paperkit/bibtex @paperkit/latex @paperkit/arxiv @paperkit/anon @paperkit/pdf-check @paperkit/image
```

Every package ships ESM, CommonJS and TypeScript declarations.

## Usage

```js
import { cleanBibtex } from "@paperkit/bibtex";
import { countLatex, toLatex, parseTable } from "@paperkit/latex";
import { stripComments } from "@paperkit/arxiv";
import { scanSourceFile } from "@paperkit/anon";
import { extractPdfFacts, runChecks, optionsForVenue } from "@paperkit/pdf-check";
import { contentBBox } from "@paperkit/image";

cleanBibtex("@article{a, title={Deep Learning}, pages={1-10}, year=2015}").output; // pages = {1--10}
countLatex(String.raw`\section{Intro} Hello world.`).totals.all; // 3
toLatex(parseTable("Model,Acc\nA,0.91")).latex; // \begin{table} ... \toprule ...
stripComments("x % secret\n").text; // "x %\n"
scanSourceFile("main.tex", "Code: https://github.com/janedoe/tool", []); // [{ rule: "repo-link", ... }]
runChecks(await extractPdfFacts(pdfBytes), optionsForVenue("acm")); // [{ id: "fonts", status: "pass", ... }, ...]
```

See each package README for a complete, runnable example and the full API.

## Develop

```sh
npm install
npm run typecheck && npm run lint && npm test && npm run build && npm run smoke
npm run examples   # runs every package README example against dist
```

Not included on purpose: Ghostscript-based features (Ghostscript is AGPL; this repo is MIT), pdf.js loading/worker glue, and canvas/Worker encoding code. Where those were needed the APIs take injected inputs instead (extracted page text, a loaded pdf.js document, an image downscaler callback, a `fetch` function).

## License

[MIT](LICENSE) © 2026 Kevin Antony
