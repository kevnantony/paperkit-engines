import { describe, expect, it } from "vitest";
import { buildModel, detectFormat, escapeLatex, parseNumber, parseTable, toLatex } from "../src";

const tsv = 'Method\tAcc (%)\tF1\tNotes\nBaseline\t85.3\t0.71\t"uses ""pretrained"" weights"\nOurs\t91.2\t0.78\t\nOurs + aug\t91.2\t\t"multi\nline"\n';

describe("format detection", () => {
  it("detects spreadsheet paste (TSV)", () => expect(detectFormat(tsv)).toBe("tsv"));
  it("detects CSV", () => expect(detectFormat("a,b\n1,2")).toBe("csv"));
  it("detects Markdown tables", () => expect(detectFormat("| a | b |\n|---|--:|\n| 1 | 2 |")).toBe("markdown"));
  it("does not treat a CSV with dashes as Markdown", () => expect(detectFormat("a,b\n-1,2\n---,x")).toBe("csv"));
});

describe("parsing", () => {
  it("parses TSV with quoted cells, escaped quotes, embedded newlines and empty cells", () => {
    const t = parseTable(tsv);
    expect(t.rows).toHaveLength(4);
    expect(t.rows[1][3]).toBe('uses "pretrained" weights');
    expect(t.rows[2]).toEqual(["Ours", "91.2", "0.78", ""]);
    expect(t.rows[3][2]).toBe("");
    expect(t.rows[3][3]).toBe("multi line");
  });

  it("parses CSV with commas inside quotes", () => {
    const t = parseTable('Name,Value\n"Smith, J.",3\n"a ""b""",4\n');
    expect(t.format).toBe("csv");
    expect(t.rows).toEqual([
      ["Name", "Value"],
      ["Smith, J.", "3"],
      ['a "b"', "4"],
    ]);
  });

  it("parses semicolon CSV (European Excel)", () => {
    expect(parseTable("a;b\n1,5;2").rows).toEqual([
      ["a", "b"],
      ["1,5", "2"],
    ]);
  });

  it("pads ragged rows and trims blank lines/columns", () => {
    const t = parseTable("\n\na,b,c\n1\n\n", "csv");
    expect(t.rows).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
    ]);
  });

  it("parses Markdown with alignment hints, escaped pipes and emphasis", () => {
    const t = parseTable("| Model | Score |\n| :-- | --: |\n| **A \\| B** | 1.5 |\n| C | `2` |");
    expect(t.format).toBe("markdown");
    expect(t.alignHints).toEqual(["l", "r"]);
    expect(t.rows).toEqual([
      ["Model", "Score"],
      ["A | B", "1.5"],
      ["C", "2"],
    ]);
  });

  it("reduces Markdown links, images and inline HTML in README tables to their text", () => {
    // Ultralytics README: "[YOLO26n](https://...)" and "mAP<sup>val<br>50-95</sup>" were emitted literally
    // (URL in the cell, \textless{}sup\textgreater{} in the header).
    const t = parseTable(
      "| Model | size<br><sup>(pixels)</sup> | mAP<sup>val<br>50-95</sup> | Logo |\n|---|---|---|---|\n| [YOLO26n](https://x.com/y_n) | 640 | 40.9 | ![logo](a.png) |\n| ~~old~~ <b>new</b> | 320 | 1 &lt; 2 | <img src=\"a.png\" width=\"20\"> |",
    );
    expect(t.rows).toEqual([
      ["Model", "size (pixels)", "mAP val 50-95", "Logo"],
      ["YOLO26n", "640", "40.9", "logo"],
      ["old new", "320", "1 < 2", ""],
    ]);
  });

  it("honours a format override", () => {
    expect(parseTable("a\tb,c", "csv").rows).toEqual([["a\tb", "c"]]);
  });
});

describe("numbers", () => {
  it("parses plain, signed, thousands, percent and ± values", () => {
    expect(parseNumber("85.3")?.value).toBe(85.3);
    expect(parseNumber("-0.12")?.value).toBe(-0.12);
    expect(parseNumber("−3")?.value).toBe(-3);
    expect(parseNumber("1,024")?.value).toBe(1024);
    expect(parseNumber("92.1%")?.percent).toBe(true);
    expect(parseNumber("85.3 ± 0.4")).toMatchObject({ value: 85.3, pm: "0.4" });
    expect(parseNumber("1e-3")?.value).toBe(0.001);
    expect(parseNumber(".5")?.value).toBe(0.5);
  });
  it("rejects text", () => {
    for (const s of ["", "abc", "1.2.3", "v2", "12a", "-"]) expect(parseNumber(s)).toBeNull();
  });
});

describe("escaping", () => {
  it("escapes all LaTeX specials", () => {
    expect(escapeLatex("a & b % c $ d # e _ f { g } h ~ i ^ j \\ k")).toBe(
      "a \\& b \\% c \\$ d \\# e \\_ f \\{ g \\} h \\textasciitilde{} i \\textasciicircum{} j \\textbackslash{} k",
    );
  });
  it("maps common Unicode math symbols", () => {
    expect(escapeLatex("85 ± 1 × 2")).toBe("85 $\\pm$ 1 $\\times$ 2");
  });
  it("maps Greek letters, ≈ ≠ ∞ and check marks that pdflatex cannot typeset from UTF-8", () => {
    // Ultralytics README header "mAP<sup>val</sup> δ" hit "Missing character δ" (a hard error under pdflatex).
    expect(escapeLatex("δ=0.5, α ≈ β ≠ ∞, Δ")).toBe("$\\delta$=0.5, $\\alpha$ $\\approx$ $\\beta$ $\\neq$ $\\infty$, $\\Delta$");
    const { latex, packages } = toLatex(parseTable("Method,Open\nA,✓\nB,✗"));
    expect(latex).toContain("A      & $\\checkmark$");
    expect(latex).toContain("$\\times$");
    expect(packages).toContain("amssymb");
  });
  it("is used in output only when enabled", () => {
    const t = parseTable("a_b,c%\n1,2", "csv");
    expect(toLatex(t).latex).toContain("a\\_b & c\\%");
    expect(toLatex(t, { escape: false }).latex).toContain("a_b & c%");
  });
});

describe("best-value bolding", () => {
  const t = parseTable("Model,Acc,Loss\nA,90.1,0.30\nB,91.2,0.25\nC,91.2,0.40\nD,-,0.25");
  it("bolds the max in every numeric column, including ties", () => {
    const m = buildModel(t, { header: true, align: "auto", best: "max" });
    expect(m.numeric).toEqual([false, true, true]);
    expect(m.best.map((r) => r[1])).toEqual([false, true, true, false]);
    expect(m.best.map((r) => r[2])).toEqual([false, false, true, false]);
    expect(m.best.map((r) => r[0])).toEqual([false, false, false, false]);
  });
  it("bolds the min with ties", () => {
    const m = buildModel(t, { header: true, align: "auto", best: "min" });
    expect(m.best.map((r) => r[2])).toEqual([false, true, false, true]);
  });
  it("emits \\textbf in LaTeX", () => {
    const out = toLatex(t, { best: "max" }).latex;
    expect(out).toContain("\\textbf{91.2}");
    expect(out.match(/\\textbf\{91\.2\}/g)).toHaveLength(2);
  });
  it("does nothing when 'none'", () => {
    expect(toLatex(t, { best: "none" }).latex).not.toContain("\\textbf");
  });
  it("treats a lone Unicode minus (copied from a PDF) as a missing value, not text", () => {
    // Real results tables pasted from PDFs use U+2212 for "not reported".
    const m = buildModel(parseTable("Method\tAcc\nBaseline\t85.3 ± 0.4\nOurs\t91.2 ± 0.3\nOracle\t−"), { header: true, align: "auto", best: "max" });
    expect(m.numeric).toEqual([false, true]);
    expect(m.best.map((r) => r[1])).toEqual([false, true, false]);
  });
  it("ignores footnote markers (†, ‡, *) after numbers but keeps them in the output", () => {
    // ResNet-style table: "8.43†" marks a result reported elsewhere.
    const p = parseTable("method\ttop-5\nVGG\t8.43†\nGoogLeNet\t7.89\nResNet-152\t4.49*");
    const m = buildModel(p, { header: true, align: "auto", best: "min" });
    expect(m.numeric).toEqual([false, true]);
    expect(m.best.map((r) => r[1])).toEqual([false, false, true]);
    const { latex, sColumns } = toLatex(p, { best: "min", siunitx: true });
    expect(latex).toContain("\\textbf{4.49*}");
    expect(latex).toContain("8.43†");
    expect(sColumns).toEqual([false, false]); // siunitx can't parse the marker, so the column stays a plain r column
  });
});

describe("LaTeX output", () => {
  const t = parseTable("Method,Acc,F1\nBase,85.3,0.71\nOurs,91.25,0.78");

  it("produces a booktabs table with auto alignment", () => {
    const { latex, packages } = toLatex(t, { caption: "Results on X.", label: "tab:results" });
    expect(packages).toEqual(["booktabs"]);
    expect(latex).toContain("\\begin{table}[t]");
    expect(latex).toContain("\\begin{tabular}{l r r}");
    expect(latex).toContain("\\toprule");
    expect(latex).toContain("\\midrule");
    expect(latex).toContain("\\bottomrule");
    expect(latex).toContain("\\caption{Results on X.}");
    expect(latex).toContain("\\label{tab:results}");
    expect(latex).toMatch(/Method & Acc\s+& F1 \\\\/);
  });

  it("uses \\hline without booktabs", () => {
    const { latex } = toLatex(t, { booktabs: false });
    expect(latex).not.toContain("toprule");
    expect(latex.match(/\\hline/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("supports table*, font size and resizebox", () => {
    const { latex, packages } = toLatex(t, { wide: true, fontSize: "footnotesize", resize: true });
    expect(latex).toContain("\\begin{table*}[t]");
    expect(latex).toContain("\\end{table*}");
    expect(latex).toContain("\\footnotesize");
    expect(latex).toContain("\\resizebox{\\linewidth}{!}{%");
    expect(packages).toContain("graphicx");
  });

  it("uses siunitx S columns with table-format and braces text headers", () => {
    const neg = parseTable("Method,Delta\nA,-1.5\nB,12.25");
    const { latex, packages } = toLatex(neg, { siunitx: true, best: "max" });
    expect(packages).toContain("siunitx");
    expect(latex).toContain("S[table-format=-2.2]");
    expect(latex).toContain("{Delta}");
    expect(latex).toContain("\\bfseries 12.25");
    expect(latex).toContain("detect-weight");
  });

  it("keeps ± and % columns out of S columns", () => {
    const pm = parseTable("M,Acc\nA,85.3 ± 0.4\nB,86.0 ± 0.2");
    const r = toLatex(pm, { siunitx: true });
    expect(r.sColumns).toEqual([false, false]);
    expect(r.latex).toContain("85.3 $\\pm$ 0.4");
  });

  it("omits the header rule when there is no header row", () => {
    const { latex, model } = toLatex(t, { header: false });
    expect(model.header).toBeNull();
    expect(latex).not.toContain("\\midrule");
  });

  it("applies a global alignment override", () => {
    expect(toLatex(t, { align: "c" }).latex).toContain("\\begin{tabular}{c c c}");
  });

  it("uses Markdown alignment hints in auto mode", () => {
    const md = parseTable("| a | b |\n|:-:|:--|\n| 1 | 2 |");
    expect(toLatex(md).latex).toContain("{c l}");
  });
});

describe("decimal commas", () => {
  const semi = parseTable("Model;Acc\nA;0,912\nB;0,875\n");

  it("records the CSV delimiter", () => expect(semi.delimiter).toBe(";"));

  it("treats commas as the decimal mark in semicolon CSV", () => {
    const m = buildModel(semi, { header: true, align: "auto", best: "max" });
    expect(m.numeric).toEqual([false, true]);
    expect(m.decimalComma).toEqual([false, true]);
    expect(m.best).toEqual([
      [false, true],
      [false, false],
    ]);
  });

  it("emits periods and a correct table-format in siunitx mode", () => {
    const { latex } = toLatex(semi, { siunitx: true, best: "max" });
    expect(latex).toContain("S[table-format=1.3]");
    expect(latex).toContain("\\bfseries 0.912");
    expect(latex).toMatch(/0\.875 \\\\/);
    expect(latex).not.toContain("0912");
  });

  it("keeps cells as written without siunitx but compares numerically", () => {
    const { latex } = toLatex(parseTable("M;Loss\nA;1,5\nB;0,25\nC;10"), { best: "min" });
    expect(latex).toContain("\\textbf{0,25}");
    expect(latex).toContain("1,5");
  });

  it("detects decimal commas in a TSV column of d,d values", () => {
    const t = parseTable("M\tAcc\nA\t0,912\nB\t0,875");
    const m = buildModel(t, { header: true, align: "auto", best: "max" });
    expect(m.decimalComma).toEqual([false, true]);
    expect(m.best[0][1]).toBe(true);
    expect(toLatex(t, { siunitx: true }).latex).toContain("S[table-format=1.3]");
  });

  it("still reads 1,024 / 2,048 in a TSV column as thousands", () => {
    const t = parseTable("M\tN\nA\t1,024\nB\t2,048");
    const m = buildModel(t, { header: true, align: "auto", best: "max" });
    expect(m.decimalComma).toEqual([false, false]);
    expect(toLatex(t, { siunitx: true }).latex).toContain("S[table-format=4.0]");
  });

  it("parses comma-decimal numbers with an explicit mark", () => {
    expect(parseNumber("0,912", ",")).toMatchObject({ value: 0.912, intDigits: 1, decDigits: 3 });
    expect(parseNumber("-1,5 ± 0,2", ",")).toMatchObject({ value: -1.5, pm: "0,2" });
    expect(parseNumber("1.2", ",")).toBeNull();
  });
});

describe("angle brackets", () => {
  it("escapes < and > in text cells", () => {
    expect(escapeLatex("p<0.05, q>1")).toBe("p\\textless{}0.05, q\\textgreater{}1");
    expect(toLatex(parseTable("Test,p\nA,<0.05")).latex).toContain("\\textless{}0.05");
  });
});
