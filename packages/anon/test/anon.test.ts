import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { formatLocation, reportToMarkdown, runAudit, scanSourceZip } from "../src";
import { findIdentifier, identifierRegex, parseIdentifiers, snippetAround } from "../src";
import { readImageMeta } from "../src";
import { readPdfMetadata, stripPdfMetadata, xmpAuthors } from "../src";
import { scanPdfMetadata, scanPdfPages, scanSourceFile } from "../src";
import type { Finding } from "../src";

const fx = (p: string) => new Uint8Array(readFileSync(path.join(__dirname, "fixtures", p)));
const rules = (fs: Finding[]) => fs.map((f) => `${f.severity}:${f.rule}`);

describe("parseIdentifiers", () => {
  it("splits lines, trims bullets/handles/urls, dedupes case-insensitively, drops short entries", () => {
    expect(parseIdentifiers("Jane Doe\n- jane doe\n@janedoe\nhttps://github.com/janedoe/\n\nMIT\nab\n  jane.doe@x.edu  ")).toEqual([
      "Jane Doe",
      "janedoe",
      "github.com/janedoe",
      "MIT",
      "jane.doe@x.edu",
    ]);
  });
});

describe("identifier matching", () => {
  it("is case-insensitive", () => {
    expect(findIdentifier("by JANE DOE and others", "Jane Doe")).toHaveLength(1);
  });
  it("matches across line breaks, repeated spaces and LaTeX ties", () => {
    expect(findIdentifier("by Jane\nDoe", "Jane Doe")).toHaveLength(1);
    expect(findIdentifier("by Jane   \n  Doe", "Jane Doe")).toHaveLength(1);
    expect(findIdentifier("by Jane~Doe", "Jane Doe")).toHaveLength(1);
  });
  it("matches words hyphenated at a line break", () => {
    expect(findIdentifier("Univer-\nsity of Somewhere", "University of Somewhere")).toHaveLength(1);
  });
  it("respects word boundaries", () => {
    expect(findIdentifier("Admit the MITigation", "MIT")).toHaveLength(0);
    expect(findIdentifier("at MIT.", "MIT")).toHaveLength(1);
    expect(findIdentifier("Janet Doerr", "Jane Doe")).toHaveLength(0);
  });
  it("escapes regex characters (emails, urls)", () => {
    expect(findIdentifier("mail jane.doe@x.edu now", "jane.doe@x.edu")).toHaveLength(1);
    expect(findIdentifier("mail janexdoe@x.edu now", "jane.doe@x.edu")).toHaveLength(0);
    expect(identifierRegex("a+b (c)").test("A+B (C)")).toBe(true);
  });
  it("handles accented names", () => {
    expect(findIdentifier("José Müller wrote", "josé müller")).toHaveLength(1);
  });
  it("builds whitespace-collapsed snippets", () => {
    expect(snippetAround("aaa\n\nbbb   ccc", 5, 3, 3)).toBe("…a bbb…");
  });
});

describe("scanPdfPages", () => {
  const pages = [
    "A Title\nJane Doe\nUniversity of Somewhere\njane.doe@somewhere.edu\nAbstract\nWe extend our previous work [3]. Code: https://github.com/janedoe/x\nAs we\nshowed in [4] it works.",
    "Method uses anonymous.4open.science/r/abc.\nAcknowledgments\nThis work was supported by NSF grant IIS-1234567.\nReferences\n[3] Jane Doe. Things. 2023. https://github.com/other/repo",
  ];
  const fs = scanPdfPages(pages, ["Jane Doe"]);

  it("finds identifiers, emails, links, self-citations, institutions, acks and funding", () => {
    const r = rules(fs);
    expect(r).toContain("high:identifier");
    expect(r).toContain("high:email");
    expect(r).toContain("high:repo-link");
    expect(r).toContain("medium:self-citation");
    expect(r).toContain("medium:institution");
    expect(r).toContain("high:acknowledgments");
    expect(r).toContain("high:funding");
  });
  it("reports page numbers", () => {
    expect(fs.find((f) => f.rule === "email")!.location).toEqual({ kind: "pdf", page: 1 });
    expect(fs.find((f) => f.rule === "funding")!.location).toEqual({ kind: "pdf", page: 2 });
  });
  it("matches self-citation phrases across line breaks", () => {
    expect(fs.filter((f) => f.rule === "self-citation").map((f) => f.snippet).join(" ")).toMatch(/As we showed/);
  });
  it("downgrades names and links in the references", () => {
    const ref = fs.filter((f) => f.location.kind === "pdf" && f.location.page === 2 && f.rule === "identifier");
    expect(ref.map((f) => f.severity)).toEqual(["low"]);
    expect(fs.find((f) => f.rule === "repo-link" && f.snippet.includes("other/repo"))!.severity).toBe("medium");
  });
  it("does not flag anonymous.4open.science or withheld acknowledgments", () => {
    expect(fs.some((f) => f.snippet.includes("4open") && f.rule === "repo-link")).toBe(false);
    expect(scanPdfPages(["Acknowledgments\nWithheld for anonymous review."], []).filter((f) => f.rule === "acknowledgments")).toHaveLength(0);
  });
  it("is quiet on a clean anonymous page", () => {
    expect(scanPdfPages(["Paper Title\nAnonymous Authors\nAbstract\nSmith et al. [3] showed that this works."], ["Jane Doe"])).toEqual([]);
  });
});

describe("scanSourceFile", () => {
  const tex = [
    "\\documentclass{article}",
    "\\usepackage[final]{neurips_2024}",
    "\\author{Jane Doe\\thanks{Funded by X.} \\\\ \\texttt{jane@x.edu}}",
    "\\begin{document}",
    "% TODO(bob): fix",
    "In our prior paper we", // line 6
    "previously showed it. % Jane Doe wrote this",
    "\\url{https://github.com/janedoe/repo}",
    "\\section*{Acknowledgments}",
    "We thank our funders.",
    "\\end{document}",
  ].join("\n");
  const fs = scanSourceFile("main.tex", tex, ["Jane Doe"]);

  it("flags \\author, identifiers, emails, links and acks as high", () => {
    const r = rules(fs);
    for (const x of ["high:author-command", "high:identifier", "high:email", "high:repo-link", "high:acknowledgments"]) expect(r).toContain(x);
  });
  it("flags \\thanks and self-citations as medium, final option and comments as low", () => {
    const r = rules(fs);
    for (const x of ["medium:thanks", "medium:self-citation", "low:final-option", "low:comment-name"]) expect(r).toContain(x);
  });
  it("gives file:line locations", () => {
    expect(fs.find((f) => f.rule === "author-command")!.location).toEqual({ kind: "source", file: "main.tex", line: 3 });
    expect(fs.find((f) => f.rule === "self-citation")!.location).toEqual({ kind: "source", file: "main.tex", line: 6 });
    expect(formatLocation(fs.find((f) => f.rule === "repo-link")!.location)).toBe("main.tex:8");
  });
  it("treats names in comments as low, not high", () => {
    const highIds = fs.filter((f) => f.rule === "identifier");
    expect(highIds.every((f) => f.location.kind === "source" && f.location.line === 3)).toBe(true);
    const comments = fs.filter((f) => f.rule === "comment-name").map((f) => f.title);
    expect(comments).toEqual(["Comment mentions “bob”", "Comment mentions “Jane Doe”"]);
  });
  it("accepts anonymized author blocks", () => {
    expect(scanSourceFile("m.tex", "\\author{Anonymous Author(s)}", []).filter((f) => f.rule === "author-command")).toEqual([]);
  });
  it("downgrades bibliography files", () => {
    const bib = scanSourceFile("refs.bib", "@article{doe, author={Jane Doe}, url={https://github.com/janedoe/x}}", ["Jane Doe"]);
    expect(rules(bib)).toEqual(["low:identifier", "medium:repo-link"]);
  });
});

describe("PDF metadata", () => {
  it("reads Info, XMP and PieceInfo from the fixture", async () => {
    const m = await readPdfMetadata(fx("paper.pdf"));
    expect(m.author).toBe("Jane Doe");
    expect(m.title).toBe("Learning Sparse Things");
    expect(m.creator).toBe("/Users/janedoe/papers/sparse/main.tex");
    expect(m.creationDate).toBe("2024-05-01T10:00:00.000Z");
    expect(m.hasXmp).toBe(true);
    expect(m.hasPieceInfo).toBe(true);
    expect(m.pageCount).toBe(2);
    expect(xmpAuthors(m.xmp!)).toEqual(["Jane Doe"]);
  });

  it("flags author, local path and XMP creator as high", async () => {
    const fs = scanPdfMetadata(await readPdfMetadata(fx("paper.pdf")), ["Jane Doe"]);
    expect(fs.map((f) => f.title)).toEqual([
      "PDF metadata names an author",
      "PDF Creator contains a local path",
      "XMP metadata names an author",
    ]);
    expect(fs.every((f) => f.severity === "high")).toBe(true);
  });

  it("strips everything (optionally keeping the title) and leaves no orphans", async () => {
    const original = fx("paper.pdf");
    const stripped = await stripPdfMetadata(original, { keepTitle: false });
    const m = await readPdfMetadata(stripped);
    expect([m.title, m.author, m.subject, m.keywords, m.creator, m.producer, m.creationDate, m.modDate]).toEqual([null, null, null, null, null, null, null, null]);
    expect(m.hasXmp).toBe(false);
    expect(m.hasPieceInfo).toBe(false);
    expect(m.pageCount).toBe(2);
    const raw = Buffer.from(stripped).toString("latin1");
    expect(raw).not.toContain("Jane Doe");
    expect(raw).not.toContain("janedoe-private");
    expect(raw).not.toContain("/Users/");
    // Page content survives
    const doc = await PDFDocument.load(stripped);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });

    const kept = await readPdfMetadata(await stripPdfMetadata(original, { keepTitle: true }));
    expect(kept.title).toBe("Learning Sparse Things");
    expect(kept.author).toBeNull();
  });

  it("is a no-op-safe on already clean PDFs", async () => {
    const once = await stripPdfMetadata(fx("figure.pdf"));
    const twice = await stripPdfMetadata(once);
    expect((await readPdfMetadata(twice)).author).toBeNull();
  });
});

describe("PDF annotations, attachments and local links (regression)", () => {
  it("reads annotation authors, attachments and local links", async () => {
    const m = await readPdfMetadata(fx("annotated.pdf"));
    expect(m.annotationAuthors).toEqual(["Reviewer Ann Author"]);
    expect(m.annotationMarkup).toBe(3);
    expect(m.attachments.map((a) => a.name).sort()).toEqual(["ann-lab-notebook.txt", "ann-supplement.zip"]);
    expect(m.localLinks).toEqual(["file:///Users/annauthor/results/table.csv"]);
    const clean = await readPdfMetadata(fx("paper.pdf"));
    expect([clean.annotationAuthors, clean.attachments, clean.localLinks, clean.annotationMarkup]).toEqual([[], [], [], 0]);
  });

  it("flags annotation authors, attachments and local links as high", async () => {
    const fs = scanPdfMetadata(await readPdfMetadata(fx("annotated.pdf")), []);
    const byRule = (r: string) => fs.filter((f) => f.rule === r);
    expect(byRule("annotation-author").map((f) => [f.severity, f.snippet])).toEqual([["high", "Reviewer Ann Author"]]);
    expect(byRule("attachment")).toHaveLength(1);
    expect(byRule("attachment")[0].severity).toBe("high");
    expect(byRule("attachment")[0].title).toBe("PDF has 2 embedded attachments");
    expect(byRule("attachment")[0].snippet).toBe("ann-supplement.zip, ann-lab-notebook.txt");
    expect(byRule("local-link").map((f) => [f.severity, f.snippet])).toEqual([["high", "file:///Users/annauthor/results/table.csv"]]);
  });

  it("strips annotation authors/dates and attachments, keeps annotations, links and form fields", async () => {
    const out = await stripPdfMetadata(fx("annotated.pdf"));
    const raw = Buffer.from(out).toString("latin1");
    for (const leak of ["Ann Author", "ann-lab-notebook", "ann-supplement", "ann private", "D:20240501"]) expect(raw, leak).not.toContain(leak);
    const m = await readPdfMetadata(out);
    expect([m.annotationAuthors, m.attachments, m.annotationMarkup]).toEqual([[], [], 0]);
    expect(m.localLinks).toHaveLength(1);
    const doc = await PDFDocument.load(out);
    const annots = doc.getPage(0).node.Annots()!.asArray().map((r) => doc.context.lookup(r) as PDFDict);
    const subtypes = annots.map((a) => a.get(PDFName.of("Subtype"))!.toString()).sort();
    expect(subtypes).toEqual(["/Link", "/Link", "/Popup", "/Text", "/Widget"]);
    const note = annots.find((a) => a.get(PDFName.of("Subtype"))!.toString() === "/Text")!;
    expect(note.get(PDFName.of("Contents"))!.toString()).toContain("Check this claim");
    expect(doc.getForm().getFields().map((f) => f.getName())).toEqual(["reviewer.notes"]);
  });

  it("keeps attachments when asked, still dropping annotation authors", async () => {
    const out = await stripPdfMetadata(fx("annotated.pdf"), { keepTitle: false, removeAttachments: false });
    const m = await readPdfMetadata(out);
    expect(m.attachments).toHaveLength(2);
    expect(m.annotationAuthors).toEqual([]);
  });
});

describe("image metadata", () => {
  it("reads EXIF Artist from JPEG and Author from PNG tEXt", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(fx("source.zip"));
    const jpg = await zip.file("figures/photo.jpg")!.async("uint8array");
    const png = await zip.file("figures/plot.png")!.async("uint8array");
    const clean = await zip.file("figures/clean.png")!.async("uint8array");
    expect(readImageMeta(jpg)).toEqual([{ name: "EXIF Artist", value: "Jane Doe" }]);
    expect(readImageMeta(png)).toEqual([{ name: "PNG Author", value: "Jane Doe" }]);
    expect(readImageMeta(clean)).toEqual([]);
    expect(readImageMeta(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});

describe("runAudit (fixtures)", () => {
  it("combines PDF, metadata and source findings with stats", async () => {
    const report = await runAudit({
      pdf: { name: "paper.pdf", bytes: fx("paper.pdf"), pages: ["Jane Doe\njane.doe@somewhere.edu\nWe extend our previous work [3]."] },
      zip: { name: "source.zip", bytes: fx("source.zip") },
      identifiers: ["Jane Doe"],
    });
    expect(report.stats.pagesScanned).toBe(1);
    expect(report.stats.filesScanned).toBe(6);
    expect(report.stats.high).toBeGreaterThan(5);
    expect(report.stats.medium).toBeGreaterThan(0);
    expect(report.stats.low).toBeGreaterThan(0);
    // sorted high → medium → low
    const sev = report.findings.map((f) => f.severity);
    expect(sev).toEqual([...sev].sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b)));
    const md = reportToMarkdown(report, new Date("2024-01-02"));
    expect(md).toContain("# Anonymity audit");
    expect(md).toContain("Generated by PaperKit on 2024-01-02");
    expect(md).toMatch(/## High \(\d+\)/);
    expect(md).toContain("main.tex:5");
    expect(md.match(/Self-citation phrasing\*\* — main\.tex:12/g)).toHaveLength(1);
  });

  it("scans source zips: low-severity image and figure metadata", async () => {
    const { findings } = await scanSourceZip(fx("source.zip"), []);
    const files = findings.filter((f) => f.rule === "image-metadata").map((f) => formatLocation(f.location));
    expect(files).toEqual(["figures/chart.pdf · Author", "figures/photo.jpg · EXIF Artist", "figures/plot.png · PNG Author"]);
  });
});
