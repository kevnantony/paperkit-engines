// Builds the arXiv cleaner fixture project. Run: node packages/arxiv/test/fixtures/build.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import { makePng } from "../../../anon/test/fixtures/images.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXED = new Date("2024-05-01T10:00:00Z");

export const MAIN_TEX = String.raw`\documentclass[11pt]{article}
\usepackage{graphicx}
\usepackage{mystyle}
\usepackage{hyperref}
\graphicspath{{figures/}}
% Private note: reviewer 2 is probably Bob
\newcommand{\R}{\mathbb{R}}%
\begin{document}
\title{A Paper}
\maketitle
We improve accuracy by 5\% over the baseline. % TODO tighten this claim
See \url{https://example.com/a%20b} for details.
\begin{verbatim}
100% literal % not a comment
\end{verbatim}
\begin{comment}
This whole block is hidden.
\includegraphics{unused}
\end{comment}
\input{sections/intro}
\include{sections/method}
\begin{figure}
  \includegraphics[width=\linewidth]{plot}
  \includegraphics{figures/diagram.png}
  \includegraphics{photo.jpg}
  % \includegraphics{old-plot}
\end{figure}
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`;

const INTRO = String.raw`\section{Introduction}
Text with a line break \\% comment after linebreak
and more text.
\includegraphics{figures/missing}
`;

const METHOD = String.raw`\section{Method}
Our method.%
\input{sections/details.tex}
`;

async function tinyPdf() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([100, 60]).drawRectangle({ x: 10, y: 10, width: 80, height: 40, borderWidth: 1 });
  return doc.save();
}

const zip = new JSZip();
const o = { date: FIXED };
zip.file("main.tex", MAIN_TEX, o);
zip.file("sections/intro.tex", INTRO, o);
zip.file("sections/method.tex", METHOD, o);
zip.file("sections/details.tex", "Details here. % secret\n", o);
zip.file("sections/old.tex", "\\section{Old}\nUnused section.\n", o);
zip.file("mystyle.sty", "\\ProvidesPackage{mystyle}\n% style comment kept\n", o);
zip.file("figures/plot.pdf", await tinyPdf(), o);
zip.file("figures/diagram.png", makePng(16, 8), o);
zip.file("figures/unused.png", makePng(16, 16, [10, 200, 10]), o);
zip.file("figures/old-plot.png", makePng(16, 16, [200, 10, 10]), o);
zip.file("figures/photo.JPG", makePng(4, 4), o);
zip.file("refs.bib", "@article{a, title={A}, author={B}, year={2020}}\n", o);
zip.file("main.bbl", "\\begin{thebibliography}{1}\n\\bibitem{a} B. A. 2020.\n\\end{thebibliography}\n", o);
zip.file("main.aux", "\\relax\n", o);
zip.file("main.log", "This is pdfTeX\n", o);
zip.file("main.synctex.gz", new Uint8Array([31, 139, 8, 0]), o);
zip.file("main.pdf", await tinyPdf(), o);
zip.file(".DS_Store", new Uint8Array([0, 0, 0, 1]), o);
zip.file("__MACOSX/._main.tex", new Uint8Array([0, 5, 22, 7]), o);
writeFileSync(join(here, "project.zip"), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log("arxiv fixture written");
