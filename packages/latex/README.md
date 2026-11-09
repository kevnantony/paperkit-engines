# @paperkit-latex/latex

LaTeX utilities from PaperKit: a texcount-style word counter (text, headers, captions, footnotes, per section), CSV/TSV/Markdown to LaTeX table conversion (booktabs, siunitx, best-value bolding), and `\\input`/`\\include` resolution for multi-file projects and Overleaf zips. Runs in Node 18+ and browsers.

## Install

```sh
npm install @paperkit-latex/latex
```

## Usage

```js
import { countLatex, toLatex, parseTable } from "@paperkit-latex/latex";

const tex = String.raw`\section{Introduction}
We study tables. % a comment is not counted
\begin{figure}\caption{A short caption.}\end{figure}`;

const count = countLatex(tex);
console.log(count.totals); // { text: 3, headers: 1, captions: 3, footnotes: 0, all: 7 }

const table = parseTable("Model,Acc\nA,0.91\nB,0.87");
const { latex, packages } = toLatex(table, { best: "max", caption: "Results" });
console.log(packages); // ["booktabs"]
console.log(latex.includes("\\textbf{0.91}")); // true
```

Multi-file projects: pass `{ files, mainPath }` to `countLatex`, or read an Overleaf "Download source" zip with `readTexZip(bytes)` to get `{ files, mains }`.

## API

- **Word count:** `countLatex(source, { files?, mainPath?, includeAppendix? })` → per-section counts, totals, abstract, math counts, included/missing files. Also `countWordsInText`, `stripComments`, `resolveIncludes`, `findMainFiles`.
- **Projects:** `readTexZip(zipBytes)` → `{ files, mains }` (uses jszip, entirely in memory).
- **Tables:** `detectFormat`, `parseTable`, `normalizeRows`, `parseNumber`, `isMissing`, `buildModel`, `escapeLatex`, `toLatex`, `defaultTableOptions`.

## Part of PaperKit

This package is one of the open-source engines behind **[PaperKit](https://paperkit.pages.dev)** — free research paper tools that run in your browser. Everything runs locally: no uploads, no server round-trips.

Source, issues and the other engines: [kevnantony/paperkit-engines](https://github.com/kevnantony/paperkit-engines).

## License

MIT © 2026 Kevin Antony
