# @paperkit-latex/arxiv

Prepare a LaTeX project for arXiv: strip comments without breaking `\\%`, `verbatim` or `\\url`, resolve the `\\input`/`\\includegraphics`/`\\bibliography` graph, plan which files to keep, and write a clean zip. Runs in Node 18+ and browsers (zip handling via jszip).

## Install

```sh
npm install @paperkit-latex/arxiv
```

## Usage

```js
import JSZip from "jszip";
import { stripComments, loadProjectZip, cleanProject } from "@paperkit-latex/arxiv";

console.log(stripComments("50\\% done % TODO: ask Bob\n").text); // "50\% done %\n" (a bare % is kept so no line-end space is introduced)

// Build a tiny project zip (in practice: the bytes of an Overleaf download).
const zip = new JSZip();
zip.file("main.tex", "\\documentclass{article}\n% private note\n\\begin{document}\\input{intro}\\end{document}\n");
zip.file("intro.tex", "Hello.\n");
zip.file("unused.tex", "Not referenced.\n");
zip.file("main.aux", "build junk");
const bytes = await zip.generateAsync({ type: "uint8array" });

const result = await cleanProject(await loadProjectZip(bytes));
console.log(result.kept.map((e) => e.path)); // ["intro.tex", "main.tex"]
console.log(result.removed.map((e) => e.path)); // ["main.aux", "unused.tex"]
console.log(result.commentsRemoved); // 1
// result.output is the cleaned zip as a Uint8Array.
```

## API

- **Comments:** `stripComments`, `blankComments`, `listComments`, `splitComment`, `findCommentStart`, `VERBATIM_ENVS`.
- **Include graph:** `findMainTex`, `resolveProject`, `extractCommands`, `parseGraphicspath`, `GRAPHICS_EXTS`.
- **Cleanup plan:** `planCleanup`, `defaultCleanOptions`, `downscaleTarget`, `sizeTone`, `ARXIV_LIMIT_BYTES`, `TEXT_EXTS`.
- **Zip:** `loadProjectZip`, `cleanProject(project, options?, downscale?)` (image downscaling is an injected callback, so you choose canvas, sharp, or nothing), `bytesToBinaryString`, `binaryStringToBytes`.
- **Paths:** `normalizePath`, `dirname`, `basename`, `extname`, `stripExt`, `join`, `isAbsolutePath`.

## Part of PaperKit

This package is one of the open-source engines behind **[PaperKit](https://paperkit.pages.dev)** — free research paper tools that run in your browser. Everything runs locally: no uploads, no server round-trips.

Source, issues and the other engines: [kevnantony/paperkit-engines](https://github.com/kevnantony/paperkit-engines).

## License

MIT © 2026 Kevin Antony
