import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  blankComments,
  cleanProject,
  downscaleTarget,
  extractCommands,
  findCommentStart,
  findMainTex,
  listComments,
  loadProjectZip,
  normalizePath,
  parseGraphicspath,
  planCleanup,
  resolveProject,
  sizeTone,
  stripComments,
  ARXIV_LIMIT_BYTES,
  defaultCleanOptions,
} from "../src";

const strip = (s: string) => stripComments(s).text;

describe("findCommentStart", () => {
  it("finds plain comments", () => {
    expect(findCommentStart("abc % def")).toBe(4);
    expect(findCommentStart("% only")).toBe(0);
    expect(findCommentStart("no comment")).toBe(-1);
  });
  it("ignores escaped percent", () => {
    expect(findCommentStart("5\\% more")).toBe(-1);
    expect(findCommentStart("5\\% more % real")).toBe(9);
  });
  it("treats \\\\% as line break + comment", () => {
    expect(findCommentStart("a \\\\% c")).toBe(4);
    expect(findCommentStart("a \\\\\\% c")).toBe(-1); // \\ then \%
  });
  it("ignores % inside \\url, \\href target and \\verb", () => {
    expect(findCommentStart("\\url{https://x.org/a%20b} ok")).toBe(-1);
    expect(findCommentStart("\\url{a%b} % c")).toBe(10);
    expect(findCommentStart("\\href{https://x.org/%7Euser}{home} % c")).toBe(35);
    expect(findCommentStart("\\verb|50%| and \\verb+%+ x")).toBe(-1);
    expect(findCommentStart("\\verb*|a%b| % c")).toBe(12);
  });
  it("does not confuse control words starting with url", () => {
    expect(findCommentStart("\\urlstyle{same} % c")).toBe(16);
  });
});

describe("stripComments", () => {
  it("drops comment-only lines entirely and keeps the % after code", () => {
    const src = "line one\n% full comment\n   % indented comment\nline two % tail\n";
    expect(strip(src)).toBe("line one\nline two %\n");
  });
  it("keeps the trailing % that suppresses end-of-line space", () => {
    expect(strip("\\newcommand{\\x}{% start\n  body}%\n")).toBe("\\newcommand{\\x}{%\n  body}%\n");
  });
  it("keeps escaped \\% and handles \\\\%", () => {
    expect(strip("5\\% of 10\\% % gone\n")).toBe("5\\% of 10\\% %\n");
    expect(strip("a\\\\% gone\nb\n")).toBe("a\\\\%\nb\n");
  });
  it("leaves verbatim-like environments untouched", () => {
    const src = "\\begin{verbatim}\n100% % kept\n\\end{verbatim}\n\\begin{lstlisting}[language=Python]\nx = 5 % 3\n\\end{lstlisting}\nafter % c\n";
    expect(strip(src)).toBe("\\begin{verbatim}\n100% % kept\n\\end{verbatim}\n\\begin{lstlisting}[language=Python]\nx = 5 % 3\n\\end{lstlisting}\nafter %\n");
  });
  it("handles minted and Verbatim", () => {
    const src = "\\begin{minted}{python}\nprint('%d' % 3)\n\\end{minted}\n\\begin{Verbatim}\n% x\n\\end{Verbatim}\n";
    expect(strip(src)).toBe(src);
  });
  it("does not start verbatim when \\begin{verbatim} is itself commented", () => {
    expect(strip("% \\begin{verbatim}\ncode % c\n")).toBe("code %\n");
  });
  it("keeps urls with %", () => {
    expect(strip("See \\url{https://example.com/a%20b} now. % note\n")).toBe("See \\url{https://example.com/a%20b} now. %\n");
  });
  it("removes comment environments (multi-line, single-line, with trailing text)", () => {
    expect(strip("a\n\\begin{comment}\nhidden\n% x\n\\end{comment}\nb\n")).toBe("a\nb\n");
    expect(strip("a \\begin{comment} x \\end{comment} b\n")).toBe("a  b\n");
    const r = stripComments("\\begin{comment}\n\\end{comment}\n");
    expect(r.blocksRemoved).toBe(1);
    expect(r.text).toBe("");
  });
  it("does not treat a commented \\begin{comment} as a block", () => {
    expect(strip("% \\begin{comment}\nvisible\n")).toBe("visible\n");
  });
  it("preserves CRLF line endings", () => {
    expect(strip("a % c\r\n% d\r\nb\r\n")).toBe("a %\r\nb\r\n");
  });
  it("counts removed comments", () => {
    expect(stripComments("a % 1\n% 2\nb\n").commentsRemoved).toBe(2);
  });
  it("is idempotent", () => {
    const once = strip("x % y\n% z\n\\begin{comment}\nq\n\\end{comment}\n");
    expect(strip(once)).toBe(once);
  });
});

describe("listComments / blankComments", () => {
  it("lists comments with line numbers", () => {
    expect(listComments("a\n% hello\nb % world\n5\\% no")).toEqual([
      { line: 2, text: "% hello" },
      { line: 3, text: "% world" },
    ]);
  });
  it("blanks comments but keeps line count", () => {
    const src = "a % x\n% y\n\\begin{comment}\nz\n\\end{comment}\nb";
    const out = blankComments(src);
    expect(out.split("\n")).toHaveLength(6);
    expect(out).not.toMatch(/[xyz]/);
    expect(out.split("\n")[5]).toBe("b");
  });
});

describe("paths & commands", () => {
  it("normalizes paths", () => {
    expect(normalizePath("./a/../b//c\\d.tex")).toBe("b/c/d.tex");
  });
  it("parses graphicspath", () => {
    expect(parseGraphicspath("{figs/}{img/sub/}")).toEqual(["figs/", "img/sub/"]);
  });
  it("extracts commands with optional args and two-arg forms", () => {
    const cmds = extractCommands("\\includegraphics[width=2cm]{a}\\import{dir/}{file}\\input b \\usepackage[x]{p,q}");
    expect(cmds.map((c) => [c.command, c.args])).toEqual([
      ["includegraphics", ["a"]],
      ["import", ["dir/", "file"]],
      ["input", ["b"]],
      ["usepackage", ["p,q"]],
    ]);
  });
});

describe("findMainTex", () => {
  it("prefers the file with \\documentclass and \\begin{document}", () => {
    const r = findMainTex({
      "sections/a.tex": "\\section{A}",
      "fig/standalone.tex": "\\documentclass{standalone}\\begin{document}x\\end{document}",
      "paper.tex": "\\documentclass{article}\\begin{document}\\end{document}",
      "old.tex": "% \\documentclass{article}",
    });
    expect(r.main).toBe("paper.tex");
    expect(r.candidates).toEqual(["paper.tex", "fig/standalone.tex"]);
  });
});

describe("resolveProject", () => {
  const texts = {
    "main.tex": [
      "\\documentclass{article}",
      "\\graphicspath{{figs/}{img/}}",
      "\\begin{document}",
      "\\input{sec/intro}",
      "\\include{sec/method}",
      "\\subfile{sec/sub.tex}",
      "\\includegraphics{a}",
      "\\includegraphics[scale=.5]{b.png}",
      "\\includegraphics{img/c}",
      "\\includegraphics{Plot.PNG}",
      "\\includegraphics{/Users/jane/fig.pdf}",
      "\\includegraphics{\\figdir/x}",
      "% \\includegraphics{commented}",
      "\\bibliography{refs,more}",
      "\\end{document}",
    ].join("\n"),
    "sec/intro.tex": "\\input{sec/nested}\n\\includegraphics{missing}",
    "sec/method.tex": "x",
    "sec/nested.tex": "y",
    "sec/sub.tex": "\\includegraphics{a}",
  };
  const paths = [
    ...Object.keys(texts),
    "figs/a.pdf",
    "figs/a.png", // .pdf wins
    "figs/b.png",
    "img/c.jpg",
    "figs/plot.png",
    "figs/commented.png",
    "refs.bib",
  ];
  const g = resolveProject("main.tex", texts, paths);

  it("follows \\input/\\include/\\subfile recursively", () => {
    for (const p of ["sec/intro.tex", "sec/method.tex", "sec/nested.tex", "sec/sub.tex"]) expect(g.used.has(p)).toBe(true);
  });
  it("resolves graphics with and without extensions via \\graphicspath, preferring .pdf", () => {
    expect(g.used.has("figs/a.pdf")).toBe(true);
    expect(g.used.has("figs/a.png")).toBe(false);
    expect(g.used.has("figs/b.png")).toBe(true);
    expect(g.used.has("img/c.jpg")).toBe(true);
  });
  it("ignores commented-out includes", () => {
    expect(g.used.has("figs/commented.png")).toBe(false);
  });
  it("warns about case mismatches, absolute paths, macros and missing files", () => {
    const codes = g.warnings.map((w) => w.code);
    expect(codes).toContain("case-mismatch");
    expect(codes).toContain("absolute-path");
    expect(codes).toContain("macro-path");
    const missing = g.warnings.filter((w) => w.code === "missing-file");
    expect(missing.map((w) => w.file)).toEqual(["sec/intro.tex"]);
    expect(missing[0].line).toBe(2);
    expect(g.used.has("figs/plot.png")).toBe(true);
  });
  it("records bibliography databases", () => {
    expect(g.usesBibliography).toBe(true);
    expect(g.used.has("refs.bib")).toBe(true);
    expect(g.refs.filter((r) => r.kind === "bib").map((r) => [r.target, r.resolved])).toEqual([
      ["refs", "refs.bib"],
      ["more", null],
    ]);
  });
  it("resolves relative to the main file's folder", () => {
    const g2 = resolveProject("paper/main.tex", { "paper/main.tex": "\\documentclass{article}\\input{s}\\includegraphics{f}" , "paper/s.tex": "" }, ["paper/main.tex", "paper/s.tex", "paper/f.png"]);
    expect([...g2.used.keys()].sort()).toEqual(["paper/f.png", "paper/main.tex", "paper/s.tex"]);
  });
  it("supports \\import with a base directory for nested inputs", () => {
    const g3 = resolveProject(
      "main.tex",
      { "main.tex": "\\documentclass{article}\\import{chap/}{one}", "chap/one.tex": "\\input{two}\\includegraphics{pic}", "chap/two.tex": "" },
      ["main.tex", "chap/one.tex", "chap/two.tex", "chap/pic.png"],
    );
    expect(g3.used.has("chap/two.tex")).toBe(true);
    expect(g3.used.has("chap/pic.png")).toBe(true);
  });
});

describe("planCleanup", () => {
  it("warns when the .bbl is missing", () => {
    const plan = planCleanup(
      [
        { path: "main.tex", size: 10 },
        { path: "refs.bib", size: 10 },
      ],
      { "main.tex": "\\documentclass{article}\\bibliography{refs}" },
    );
    expect(plan.warnings.some((w) => w.code === "missing-bbl" && w.level === "danger")).toBe(true);
    expect(plan.entries.find((e) => e.path === "refs.bib")!.action).toBe("remove");
    const keep = planCleanup([{ path: "main.tex", size: 1 }, { path: "refs.bib", size: 1 }], { "main.tex": "\\documentclass{article}\\bibliography{refs}" }, { ...defaultCleanOptions, keepBib: true });
    expect(keep.entries.find((e) => e.path === "refs.bib")!.action).toBe("keep");
  });
  it("keeps everything but junk when there is no main file", () => {
    const plan = planCleanup([{ path: "a.tex", size: 1 }, { path: "a.aux", size: 1 }], { "a.tex": "hello" });
    expect(plan.main).toBeNull();
    expect(plan.entries.map((e) => e.action)).toEqual(["keep", "remove"]);
    expect(plan.warnings[0].code).toBe("no-main");
  });
});

describe("size helpers", () => {
  it("computes downscale targets", () => {
    expect(downscaleTarget(4000, 2000, 2000)).toEqual({ width: 2000, height: 1000 });
    expect(downscaleTarget(1000, 3000, 1500)).toEqual({ width: 500, height: 1500 });
    expect(downscaleTarget(800, 600, 2000)).toBeNull();
  });
  it("tones the size against the 50 MB limit", () => {
    expect(sizeTone(1024)).toBe("success");
    expect(sizeTone(ARXIV_LIMIT_BYTES * 0.9)).toBe("warning");
    expect(sizeTone(ARXIV_LIMIT_BYTES + 1)).toBe("danger");
  });
});

describe("cleanProject on the fixture zip (golden)", async () => {
  const bytes = readFileSync(path.join(__dirname, "fixtures/project.zip"));
  const project = await loadProjectZip(new Uint8Array(bytes));
  const result = await cleanProject(project, defaultCleanOptions);
  const action = (p: string) => result.plan.entries.find((e) => e.path === p)?.action;

  it("finds main.tex", () => expect(result.plan.main).toBe("main.tex"));
  it("keeps used files", () => {
    for (const p of ["main.tex", "sections/intro.tex", "sections/method.tex", "sections/details.tex", "mystyle.sty", "figures/plot.pdf", "figures/diagram.png", "figures/photo.JPG", "main.bbl"])
      expect(action(p), p).toBe("keep");
  });
  it("removes unused and junk files", () => {
    for (const p of ["sections/old.tex", "figures/unused.png", "figures/old-plot.png", "refs.bib", "main.aux", "main.log", "main.synctex.gz", "main.pdf", ".DS_Store", "__MACOSX/._main.tex"])
      expect(action(p), p).toBe("remove");
  });
  it("reports warnings for missing figure and case mismatch, not for the bbl", () => {
    const codes = result.plan.warnings.map((w) => w.code);
    expect(codes).toContain("missing-file");
    expect(codes).toContain("case-mismatch");
    expect(codes).not.toContain("missing-bbl");
  });
  it("produces a zip with stripped .tex and untouched .sty", async () => {
    const out = await JSZip.loadAsync(result.output);
    const names = Object.keys(out.files).filter((n) => !out.files[n].dir).sort();
    expect(names).toEqual(["figures/diagram.png", "figures/photo.JPG", "figures/plot.pdf", "main.bbl", "main.tex", "mystyle.sty", "sections/details.tex", "sections/intro.tex", "sections/method.tex"]);
    const main = await out.file("main.tex")!.async("string");
    expect(main).not.toContain("Private note");
    expect(main).not.toContain("TODO tighten");
    expect(main).not.toContain("This whole block is hidden");
    expect(main).toContain("by 5\\% over the baseline. %");
    expect(main).toContain("\\url{https://example.com/a%20b}");
    expect(main).toContain("100% literal % not a comment");
    expect(main).toContain("\\newcommand{\\R}{\\mathbb{R}}%");
    expect(await out.file("sections/intro.tex")!.async("string")).toContain("\\\\%\n");
    expect(await out.file("mystyle.sty")!.async("string")).toContain("% style comment kept");
    expect(result.commentsRemoved).toBeGreaterThan(3);
    expect(result.blocksRemoved).toBe(1);
    expect(result.zipAfter).toBe(result.output.length);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
  });
  it("keeps comments when asked", async () => {
    const r = await cleanProject(project, { ...defaultCleanOptions, keepComments: true });
    const main = await (await JSZip.loadAsync(r.output)).file("main.tex")!.async("string");
    expect(main).toContain("Private note");
    expect(r.commentsRemoved).toBe(0);
  });
  it("calls the downscaler only when enabled, for raster images", async () => {
    const seen: string[] = [];
    await cleanProject(project, defaultCleanOptions, async (p) => (seen.push(p), null));
    expect(seen).toEqual([]);
    const r = await cleanProject(project, { ...defaultCleanOptions, downscaleImages: true, maxImageDimension: 4 }, async (p) => (seen.push(p), new Uint8Array(1)));
    expect(seen.sort()).toEqual(["figures/diagram.png", "figures/photo.JPG"]);
    expect(r.imagesDownscaled.sort()).toEqual(["figures/diagram.png", "figures/photo.JPG"]);
  });
  it("re-roots a project nested in a folder", async () => {
    const z = new JSZip();
    z.file("paper/main.tex", "\\documentclass{article}\\begin{document}\\input{a}\\end{document}");
    z.file("paper/a.tex", "x");
    const p = await loadProjectZip(await z.generateAsync({ type: "uint8array" }));
    const r = await cleanProject(p);
    expect(r.rerooted).toBe("paper/");
    const names = Object.keys((await JSZip.loadAsync(r.output)).files).sort();
    expect(names).toEqual(["a.tex", "main.tex"]);
  });
  it("round-trips non-ASCII bytes unchanged", async () => {
    const z = new JSZip();
    z.file("main.tex", "\\documentclass{article}\nCafé naïve — ü % kommentar\n");
    const r = await cleanProject(await loadProjectZip(await z.generateAsync({ type: "uint8array" })));
    expect(await (await JSZip.loadAsync(r.output)).file("main.tex")!.async("string")).toBe("\\documentclass{article}\nCafé naïve — ü %\n");
  });
});

describe("tracing non-.tex includes (regression)", () => {
  const build = async (files: Record<string, string | Uint8Array>) => {
    const z = new JSZip();
    for (const [p, c] of Object.entries(files)) z.file(p, c);
    return loadProjectZip(await z.generateAsync({ type: "uint8array" }));
  };
  const outNames = async (r: { output: Uint8Array }) => Object.keys((await JSZip.loadAsync(r.output)).files).filter((n) => !n.endsWith("/")).sort();
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0x01]);

  it("keeps a pgfplots table read from an \\input .tikz file", async () => {
    const p = await build({
      "main.tex": "\\documentclass{article}\\usepackage{pgfplots}\\begin{document}\\input{plot.tikz}\\end{document}",
      "plot.tikz": "\\begin{tikzpicture}\\begin{axis}\n\\addplot+[mark=none] table [x=a, y=b] {results.csv};\n\\addplot table{data/more.dat};\n\\end{axis}\\end{tikzpicture}",
      "results.csv": "a,b\n1,2\n",
      "data/more.dat": "1 2\n",
    });
    const r = await cleanProject(p, { ...defaultCleanOptions, removeUnreferenced: true });
    expect(r.plan.entries.find((e) => e.path === "results.csv")!.action).toBe("keep");
    expect(r.plan.entries.find((e) => e.path === "data/more.dat")!.action).toBe("keep");
    expect(await outNames(r)).toEqual(["data/more.dat", "main.tex", "plot.tikz", "results.csv"]);
  });

  it("keeps the PDF behind an Inkscape .pdf_tex (direct \\input and \\import)", async () => {
    const pdfTex = (name: string) => `\\begingroup\\begin{picture}(1,1)\\put(0,0){\\includegraphics[width=\\unitlength,page=1]{${name}.pdf}}\\end{picture}\\endgroup`;
    const p = await build({
      "main.tex": "\\documentclass{article}\\usepackage{import}\\begin{document}\\input{fig.pdf_tex}\\import{figs/}{other.pdf_tex}\\end{document}",
      "fig.pdf_tex": pdfTex("fig"),
      "fig.pdf": pdfBytes,
      "figs/other.pdf_tex": pdfTex("other"),
      "figs/other.pdf": pdfBytes,
      "unused.pdf": pdfBytes,
    });
    const r = await cleanProject(p);
    const act = (x: string) => r.plan.entries.find((e) => e.path === x)!.action;
    expect(act("fig.pdf_tex")).toBe("keep");
    expect(act("fig.pdf")).toBe("keep");
    expect(act("figs/other.pdf_tex")).toBe("keep");
    expect(act("figs/other.pdf")).toBe("keep");
    expect(act("unused.pdf")).toBe("remove");
  });

  it("keeps a figure whose name is only mentioned as name.pdf_tex (untraceable text)", () => {
    const plan = planCleanup(
      [
        { path: "main.tex", size: 1 },
        { path: "fig.pdf", size: 1 },
      ],
      { "main.tex": "\\documentclass{article}\\begin{document}\\input{fig.pdf_tex}\\end{document}" },
    );
    expect(plan.entries.find((e) => e.path === "fig.pdf")!.action).toBe("keep");
  });

  it("resolves listings, verbatim, svg, pdf pages and bib resources from traced non-.tex files", async () => {
    const p = await build({
      "main.tex": "\\documentclass{article}\\usepackage{local}\\begin{document}\\input{body.inc}\\end{document}",
      "local.sty": "\\ProvidesPackage{local}\\addbibresource{refs.bib}",
      "body.inc": "\\lstinputlisting{code/a.py}\\verbatiminput{log.out.txt}\\includesvg{diagram}\\includepdf[pages=-]{appendix}",
      "code/a.py": "print(1)\n",
      "log.out.txt": "x\n",
      "diagram.svg": "<svg/>",
      "svg-inkscape/diagram_svg-tex.pdf": pdfBytes,
      "svg-inkscape/diagram_svg-tex.pdf_tex": "\\includegraphics{diagram_svg-tex.pdf}",
      "appendix.pdf": pdfBytes,
      "refs.bib": "@misc{a}",
    });
    const r = await cleanProject(p, { ...defaultCleanOptions, keepBib: true, removeUnreferenced: true });
    for (const f of ["body.inc", "code/a.py", "log.out.txt", "diagram.svg", "svg-inkscape/diagram_svg-tex.pdf", "svg-inkscape/diagram_svg-tex.pdf_tex", "appendix.pdf", "refs.bib", "local.sty"])
      expect(r.plan.entries.find((e) => e.path === f)!.action, f).toBe("keep");
  });

  it("keeps unreferenced files of unknown type by default, removes them only when asked", () => {
    const files = ["main.tex", "notes.json", "table.dat", "weird.xyz", "extra.csv", "fig.png", "main.aux"].map((path) => ({ path, size: 1 }));
    const texts = { "main.tex": "\\documentclass{article}\\begin{document}x\\end{document}" };
    const plan = planCleanup(files, texts);
    const entry = (x: string) => plan.entries.find((e) => e.path === x)!;
    for (const f of ["notes.json", "table.dat", "weird.xyz", "extra.csv"]) {
      expect(entry(f).action, f).toBe("keep");
      expect(entry(f).reason, f).toMatch(/kept: unknown type/);
    }
    expect(entry("fig.png").action).toBe("remove");
    expect(entry("main.aux").action).toBe("remove");
    expect(plan.warnings.some((w) => w.code === "unknown-kept" && /4 files/.test(w.message))).toBe(true);

    const opt = planCleanup(files, texts, { ...defaultCleanOptions, removeUnreferenced: true });
    for (const f of ["notes.json", "table.dat", "weird.xyz", "extra.csv"]) expect(opt.entries.find((e) => e.path === f)!.action, f).toBe("remove");
    expect(opt.warnings.some((w) => w.code === "unknown-kept")).toBe(false);
  });
});
