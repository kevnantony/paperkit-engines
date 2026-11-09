// Imports every built package through its CJS entry (package "exports" → dist/index.cjs) and runs one function.
const assert = require("node:assert/strict");
const { parseBibtex, entriesOf, cleanBibtex } = require("@paperkit-latex/bibtex");
const { countLatex, toLatex } = require("@paperkit-latex/latex");
const { stripComments } = require("@paperkit-latex/arxiv");
const { scanSourceFile } = require("@paperkit-latex/anon");
const { classifyPageSize, checkFonts } = require("@paperkit-latex/pdf-check");
const { contentBBox } = require("@paperkit-latex/image");

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
console.log("CJS smoke OK: bibtex, latex, arxiv, anon, pdf-check, image");
