import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { countLatex, countWordsInText, findMainFiles, resolveIncludes, stripComments } from "../src";
import { readTexZip } from "../src";

const fixtures = path.resolve(__dirname, "fixtures");
const read = (p: string) => readFileSync(path.join(fixtures, p), "utf8");

function readDir(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, readDir(full, `${prefix}${name}/`));
    else out[prefix + name] = readFileSync(full, "utf8");
  }
  return out;
}

describe("helpers", () => {
  it("strips comments but keeps \\%", () => {
    expect(stripComments("a % b\nc \\% d % e")).toBe("a \nc \\% d ");
  });
  it("keeps % that is literal inside \\url, \\href and \\verb", () => {
    expect(stripComments("\\url{https://x.org/a%20b} ok % c")).toBe("\\url{https://x.org/a%20b} ok ");
    expect(stripComments("\\verb|50%| more")).toBe("\\verb|50%| more");
  });
  it("does not lose text after a URL containing %", () => {
    // Real footnotes link to percent-encoded URLs; cutting at the % left \url{ unbalanced and swallowed the paragraph.
    const r = countLatex("\\begin{document}One two\\footnote{See \\url{https://x.org/a%20b} for more.}\nthree four five six.\n\nSeven.\\end{document}");
    expect(r.totals).toMatchObject({ text: 7, footnotes: 3 });
    expect(countLatex("\\begin{document}Code \\verb|50%| here and more words after it.\\end{document}").totals.text).toBe(7);
    expect(countLatex("\\begin{document}Run \\mintinline{python}|f(a, b)| and \\lstinline{x y} now.\\end{document}").totals.text).toBe(3);
  });
  it("counts numbers with thousands separators as one word", () => {
    // LoRA abstract: "by 10,000 times" was counted as 4 words.
    expect(countWordsInText("reduce it by 10,000 times and 1,234,567.5 more; items 1, 2")).toBe(11);
  });
  it("counts hyphenated words and numbers as single words", () => {
    expect(countWordsInText("State-of-the-art results in 2024, e.g. here.")).toBe(6);
  });
});

describe("countLatex on a small paper (golden)", () => {
  const r = countLatex(read("paper.tex"));

  it("breaks down per section", () => {
    expect(r.sections.map((s) => s.title)).toEqual(["Front matter", "Introduction", "Background on nested braces", "Conclusion"]);
    const [front, intro, bg, concl] = r.sections;
    expect(front).toMatchObject({ headers: 5, text: 10 });
    expect(intro).toMatchObject({ headers: 1, text: 16, footnotes: 4, captions: 0 });
    expect(bg).toMatchObject({ level: "subsection", headers: 4, text: 6, captions: 7 });
    expect(concl).toMatchObject({ headers: 1, text: 2 });
  });

  it("totals and abstract", () => {
    expect(r.totals).toEqual({ text: 34, headers: 11, captions: 7, footnotes: 4, all: 56 });
    expect(r.abstract).toBe(10);
  });

  it("counts formulas separately", () => {
    expect(r.inlineMath).toBe(2);
    expect(r.displayMath).toBe(1);
  });
});

describe("math, braces and commands", () => {
  const body = (s: string) => countLatex(`\\begin{document}${s}\\end{document}`);

  it("skips inline and display math in all syntaxes", () => {
    const r = body("a $x$ b \\(y\\) c \\[z w\\] d $$q r$$ e \\begin{align*} f &= g \\\\ h \\end{align*} i");
    expect(r.totals.text).toBe(6);
    expect(r.inlineMath).toBe(2);
    expect(r.displayMath).toBe(3);
  });

  it("handles nested braces inside text commands without splitting words", () => {
    expect(body("\\textbf{a {b {c}} d} \\emph{wo}rd").totals.text).toBe(5);
  });

  it("drops citations, refs, labels and their optional args", () => {
    expect(body("see \\cite[p.~5]{k1,k2} and \\ref{x}\\label{y} now").totals.text).toBe(3);
  });

  it("counts link text but not URLs", () => {
    expect(body("\\href{https://a.b/c}{our code} and \\url{https://x.y}").totals.text).toBe(3);
  });

  it("ignores verbatim, tabular and bibliography", () => {
    const r = body(
      "x \\verb|a b c| y \\begin{verbatim}p q\\end{verbatim} \\begin{tabular}{ll} m & n\\end{tabular} \\begin{thebibliography}{9}\\bibitem{a} Ref text.\\end{thebibliography}",
    );
    expect(r.totals.all).toBe(2);
  });

  it("handles escaped dollars and accents", () => {
    expect(body("costs \\$5 for Schr\\\"{o}dinger and caf\\'e").totals.text).toBe(6);
  });

  it("counts captions in tables but not cell contents", () => {
    const r = body("\\begin{table}\\caption{Two words}\\begin{tabular}{l}cell text\\end{tabular}\\end{table}");
    expect(r.totals).toMatchObject({ captions: 2, text: 0 });
  });

  it("counts \\paragraph headers inside the current section", () => {
    const r = body("\\section{A}\\paragraph{Bold lead.} Body text.");
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0]).toMatchObject({ headers: 3, text: 2 });
  });

  it("can stop at \\appendix", () => {
    const src = "\\section{A} one two \\appendix \\section{B} three";
    expect(body(src).totals.text).toBe(3);
    expect(countLatex(`\\begin{document}${src}\\end{document}`, { includeAppendix: false }).totals.text).toBe(2);
  });

  it("does not add footnotes inside the abstract to the abstract count", () => {
    // ResNet abstract: a footnote with two URLs and "and" made the abstract one word too long.
    const r = countLatex("\\begin{document}\\begin{abstract}Two words\\footnote{\\url{a} and \\url{b}.}.\\end{abstract}\\end{document}");
    expect(r.abstract).toBe(2);
    expect(r.totals).toMatchObject({ text: 2, footnotes: 1 });
  });

  it("counts an \\abstract{...} given in the preamble (JCAP/JHEP style)", () => {
    // Real astro-ph e-print with jcappub.sty: \abstract{...} sits before \begin{document}; it counted 0 words.
    const r = countLatex("\\documentclass{article}\\title{T}\\abstract{Three short words.}\\begin{document}\\maketitle\\section{Intro}Body text.\\end{document}");
    expect(r.abstract).toBe(3);
    expect(r.totals.text).toBe(5);
  });

  it("keeps section titles readable: math as written, \\texorpdfstring uses its text form", () => {
    const r = countLatex(
      "\\begin{document}\\section{More on the \\texorpdfstring{$SU(2)_1$}{SU(2)1} WZW Model}a\\section{Correlation between $\\Delta W$ and $W$}b\\section{Kernel \\(L_{\\nu}\\)}c\\end{document}",
    );
    expect(r.sections.map((s) => s.title)).toEqual(["More on the SU(2)1 WZW Model", "Correlation between $\\Delta W$ and $W$", "Kernel \\(L_{\\nu}\\)"]);
  });

  it("expands simple user text macros such as a method name", () => {
    // BERT paper: \newcommand\bert{BERT\xspace} is used three times in the abstract; each use was lost.
    const src = [
      "\\documentclass{article}",
      "\\newcommand\\bert{BERT\\xspace}",
      "\\newcommand{\\ours}{\\textsc{AdSteer}}",
      "\\def\\etal{et~al.}",
      "\\newcommand{\\dmodel}{d_{\\text{model}}}",
      "\\newcommand{\\vect}[1]{\\mathbf{#1}}",
      "\\begin{document}",
      "\\bert is simple. We call it \\ours{} and \\ours. Smith \\etal said $\\dmodel$ and \\vect{x} too.",
      "\\end{document}",
    ].join("\n");
    // BERT is simple We call it AdSteer and AdSteer Smith et al said and x too
    expect(countLatex(src).totals.text).toBe(16);
  });

  it("works on snippets without a preamble", () => {
    expect(countLatex("\\section{Intro} Hello world.").totals).toMatchObject({ headers: 1, text: 2 });
  });
});

describe("\\input / \\include resolution", () => {
  const files = readDir(path.join(fixtures, "project"));

  it("inlines nested includes relative to the main file and ignores commented ones", () => {
    const res = resolveIncludes(files["main.tex"], files, "main.tex");
    expect(res.included).toEqual(["sections/intro.tex", "sections/detail.tex", "sections/method.tex"]);
    expect(res.missing).toEqual(["sections/notthere"]);
  });

  it("counts across files", () => {
    const r = countLatex(files["main.tex"], { files, mainPath: "main.tex" });
    expect(r.sections.map((s) => [s.title, s.text])).toEqual([
      ["Intro", 5],
      ["Method", 4],
    ]);
  });

  it("guards against include cycles", () => {
    const cyc = { "a.tex": "A \\input{b}", "b.tex": "B \\input{a}" };
    expect(countLatex(cyc["a.tex"], { files: cyc, mainPath: "a.tex" }).totals.text).toBe(2);
  });

  it("reads a zipped project wrapped in a top folder and finds the main file", async () => {
    const zip = new JSZip();
    for (const [k, v] of Object.entries(files)) zip.file(`paper/${k}`, v);
    zip.file("__MACOSX/paper/._main.tex", "junk");
    const proj = await readTexZip(await zip.generateAsync({ type: "uint8array" }));
    expect(proj.mains[0]).toBe("paper/main.tex");
    expect(Object.keys(proj.files)).not.toContain("__MACOSX/paper/._main.tex");
    const r = countLatex(proj.files[proj.mains[0]], { files: proj.files, mainPath: proj.mains[0] });
    expect(r.totals.text).toBe(9);
  });

  it("prefers main.tex among several candidates", () => {
    const doc = "\\documentclass{article}\\begin{document}\\end{document}";
    expect(findMainFiles({ "z/other.tex": doc, "main.tex": doc, "sec.tex": "x" })[0]).toBe("main.tex");
  });
});
