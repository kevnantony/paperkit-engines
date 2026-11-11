/**
 * Regressions found by running the PDF tools over a corpus of real papers (arXiv, ACL, Nature, PLOS, Word, Google Docs)
 * and comparing with pypdf. Every fixture here is synthetic and built in the test.
 */
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractStructure } from "../src";
import { loadPdfDocument } from "../src";
import { readPdfMetadata, stripPdfMetadata } from "../../anon/src";
import { checkPageSize, type CheckOptions } from "../src";
import type { PdfFacts, PageFact } from "../src";

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/**
 * A linearized-style file with cross-reference *streams*: the first xref stream (first-page section) carries
 * /Root, /Info and /Encrypt, the main xref stream at the end carries only /Size, exactly like pdfTeX output that
 * was linearized, or Acrobat "Fast Web View" files. pdf-lib replaces its trailer info with each xref stream it
 * parses, so it used to lose /Info and /Encrypt.
 */
function linearizedXrefStreamPdf(opts: { encrypt?: boolean } = {}): Uint8Array {
  const objs: string[] = [];
  const xref = (dict: string) => `<< /Type /XRef /W [1 1 1] /Index [0 0] /Length 0 ${dict} >>\nstream\n\nendstream`;
  objs.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`);
  objs.push(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj`);
  objs.push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj`);
  objs.push(`4 0 obj\n<< /Author (Jane Doe) /Creator (/Users/jane/paper.tex) /Producer (pdfTeX-1.40.26) >>\nendobj`);
  if (opts.encrypt) objs.push(`5 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 /P -3904 /O <00> /U <00> >>\nendobj`);
  const first = `9 0 obj\n${xref(`/Size 10 /Root 1 0 R /Info 4 0 R ${opts.encrypt ? "/Encrypt 5 0 R " : ""}/ID [<01><01>] /Prev 0`)}\nendobj`;
  const main = `8 0 obj\n${xref("/Size 9")}\nendobj`;
  return latin1(`%PDF-1.5\n%\xe2\xe3\xcf\xd3\n${first}\n${objs.join("\n")}\n${main}\nstartxref\n0\n%%EOF\n`);
}

describe("trailer recovery for cross-reference streams (linearized files)", () => {
  it("finds /Info that only the first-page xref stream carries", async () => {
    const bytes = linearizedXrefStreamPdf();
    const s = await extractStructure(bytes);
    expect(s.metadata.author).toBe("Jane Doe");
    expect(s.metadata.producer).toBe("pdfTeX-1.40.26");
    const m = await readPdfMetadata(bytes);
    expect(m.author).toBe("Jane Doe");
    expect(m.creator).toBe("/Users/jane/paper.tex");
  });

  it("detects encryption declared only in the first-page xref stream", async () => {
    const bytes = linearizedXrefStreamPdf({ encrypt: true });
    const s = await extractStructure(bytes);
    expect(s.encrypted).toBe(true);
    expect(s.permissions?.print).toBe(false);
    expect((await readPdfMetadata(bytes)).encrypted).toBe(true);
    await expect(stripPdfMetadata(bytes)).rejects.toThrow(/encrypted/i);
  });

  it("the stripper removes the recovered Info dictionary", async () => {
    const out = await stripPdfMetadata(linearizedXrefStreamPdf());
    const m = await readPdfMetadata(out);
    expect(m.author).toBeNull();
    expect(m.creator).toBeNull();
    expect(new TextDecoder("latin1").decode(out)).not.toContain("Jane Doe");
  });

  it("leaves ordinary files alone", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.setAuthor("A. Person");
    const loaded = await loadPdfDocument(await doc.save({ useObjectStreams: true }));
    expect(loaded.getAuthor()).toBe("A. Person");
    expect(loaded.isEncrypted).toBe(false);
  });
});

describe("font names stored as indirect objects", () => {
  it("reports each font under its own name instead of one merged “(unnamed)” entry", async () => {
    // Seen in arXiv papers whose figures were included from pdfTeX output (GPT-4 report, SSD, ResNet):
    // /BaseFont 1080 0 R pointing at a name object.
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const ctx = doc.context;
    const fonts = ctx.obj({});
    for (const [key, name, embedded] of [
      ["F1", "ABCDEF+LMRoman10-Regular", true],
      ["F2", "Helvetica", false],
    ] as const) {
      const fd = ctx.obj({ Type: "FontDescriptor", FontName: PDFName.of(name), ...(embedded ? { FontFile: ctx.register(ctx.stream("x")) } : {}) });
      const font = ctx.obj({
        Type: "Font",
        Subtype: ctx.register(PDFName.of("Type1")),
        BaseFont: ctx.register(PDFName.of(name)),
        FontDescriptor: ctx.register(fd),
      });
      fonts.set(PDFName.of(key), ctx.register(font));
    }
    page.node.set(PDFName.of("Resources"), ctx.obj({ Font: fonts }));
    const s = await extractStructure(await doc.save());
    expect(s.fonts.map((f) => [f.name, f.subtype, f.embedded])).toEqual([
      ["Helvetica", "Type1", false],
      ["ABCDEF+LMRoman10-Regular", "Type1", true],
    ]);
  });
});

describe("attachment detection", () => {
  it("does not mistake the /EF permission array of a usage-rights signature for an attachment", async () => {
    // IRS forms and other Reader-extended PDFs carry /TransformParams << /EF [/Create /Delete ...] >>.
    const doc = await PDFDocument.create();
    doc.addPage();
    const ctx = doc.context;
    const params = ctx.obj({ Type: "TransformParams", EF: [PDFName.of("Create"), PDFName.of("Delete")], V: PDFName.of("2.2") });
    const sig = ctx.obj({ Type: "Sig", Reference: [ctx.obj({ Type: "SigRef", TransformMethod: "UR3", TransformParams: params })] });
    doc.catalog.set(PDFName.of("Perms"), ctx.obj({ UR3: ctx.register(sig) }));
    const s = await extractStructure(await doc.save());
    expect(s.embeddedFiles).toEqual([]);
  });

  it("still reports real file specifications with an /EF dictionary", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    await doc.attach(new TextEncoder().encode("data"), "data.csv", { mimeType: "text/csv" });
    const s = await extractStructure(await doc.save());
    expect(s.embeddedFiles).toEqual(["data.csv"]);
  });
});

describe("page size check with landscape pages", () => {
  const page = (number: number, width: number, height: number): PageFact => ({ number, width, height, rotate: width > height ? 90 : 0 });
  const facts = (pages: PageFact[]) => ({ pages, pageCount: pages.length }) as unknown as PdfFacts;
  const opts = (expectedSize: CheckOptions["expectedSize"]) => ({ expectedSize });

  it("a Letter paper with one landscape (rotated) table page is not “mixed sizes”", () => {
    const f = facts([page(1, 612, 792), page(2, 792, 612), page(3, 612, 792)]);
    const row = checkPageSize(f, opts("Letter"));
    expect(row.status).toBe("warn");
    expect(row.summary).toMatch(/Letter/);
    expect(row.details?.join(" ")).toMatch(/landscape.*2|2.*landscape/i);
    expect(checkPageSize(f, opts(null)).status).toBe("warn");
  });

  it("still fails a real mix of paper sizes and a wrong size", () => {
    expect(checkPageSize(facts([page(1, 612, 792), page(2, 595.28, 841.89)]), opts(null)).status).toBe("fail");
    expect(checkPageSize(facts([page(1, 842, 595)]), opts("Letter")).status).toBe("fail");
    expect(checkPageSize(facts([page(1, 612, 792)]), opts("Letter")).status).toBe("pass");
  });
});

describe("standard-font PDFs (Word/Docs-like) are read", () => {
  it("flags non-embedded base-14 fonts", async () => {
    const doc = await PDFDocument.create();
    const p = doc.addPage();
    p.drawText("Hello", { font: await doc.embedFont(StandardFonts.TimesRoman) });
    const s = await extractStructure(await doc.save());
    expect(s.fonts).toMatchObject([{ name: "Times-Roman", embedded: false, type3: false }]);
  });
});
