// Imports every built package through its ESM entry (package "exports" → dist/index.js) and runs one function.
import assert from "node:assert/strict";
import { parseBibtex, entriesOf, cleanBibtex } from "@paperkit/bibtex";
import { countLatex, toLatex } from "@paperkit/latex";
import { stripComments } from "@paperkit/arxiv";
import { scanSourceFile } from "@paperkit/anon";
import { classifyPageSize, checkFonts } from "@paperkit/pdf-check";
import { contentBBox } from "@paperkit/image";

assert.equal(entriesOf(parseBibtex("@article{a, title={X}, year=2020}")).length, 1);
assert.match(cleanBibtex("@article{a, title={X}, year=2020}").output, /@article/);
assert.equal(countLatex("\\section{Intro} Hello world.").totals.all, 3);
assert.match(toLatex({ rows: [["a", "b"], ["1", "2"]] }).latex, /\\begin\{tabular\}/);
assert.equal(stripComments("x % secret\n").text.includes("secret"), false);
assert.ok(scanSourceFile("main.tex", "Code: https://github.com/janedoe/repo\n", []).length > 0);
assert.equal(classifyPageSize(612, 792), "Letter");
assert.equal(typeof checkFonts, "function");
const data = new Uint8ClampedArray(4 * 4 * 4).fill(255);
data.set([0, 0, 0, 255], (1 * 4 + 2) * 4);
assert.deepEqual(contentBBox({ data, width: 4, height: 4 }), { x: 2, y: 1, width: 1, height: 1 });
console.log("ESM smoke OK: bibtex, latex, arxiv, anon, pdf-check, image");
