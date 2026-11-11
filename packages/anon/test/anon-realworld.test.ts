/**
 * Regressions found by auditing real papers (arXiv, ACL, ICML/ICLR anonymous templates, Nature, Word exports).
 * All inputs are synthetic strings or PDFs built in the test.
 */
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { readPdfMetadata, stripPdfMetadata, type PdfMetadata } from "../src";
import { scanPdfMetadata, scanPdfPages, scanSourceFile } from "../src";
import type { Finding } from "../src";

const high = (fs: Finding[]) => fs.filter((f) => f.severity === "high");
const meta = (m: Partial<PdfMetadata>): PdfMetadata => ({
  title: null,
  author: null,
  subject: null,
  keywords: null,
  creator: null,
  producer: null,
  creationDate: null,
  modDate: null,
  hasXmp: false,
  xmp: null,
  hasPieceInfo: false,
  embeddedFileNames: [],
  embeddedInfo: [],
  annotationAuthors: [],
  annotationMarkup: 0,
  attachments: [],
  localLinks: [],
  imageMetadata: 0,
  pageCount: 1,
  encrypted: false,
  ...m,
});

describe("properly anonymized submissions produce no High findings", () => {
  it("accepts the anonymous placeholders of the ICML/ICLR templates", () => {
    // ICML example_paper.pdf in submission mode: Info /Author (Anonymous Submission) and a placeholder email.
    expect(scanPdfMetadata(meta({ author: "Anonymous Submission" }), [])).toEqual([]);
    expect(scanPdfMetadata(meta({ author: "Anonymous Authors" }), [])).toEqual([]);
    expect(scanPdfMetadata(meta({ author: "Anonymous Author(s)" }), [])).toEqual([]);
    const page1 =
      "Anonymous Authors1\nAbstract\nWe study things.\n1Anonymous Institution, Anonymous City, Anonymous Region, Anonymous Country. Correspondence to: Anonymous Author <anon.email@domain.com>.\nPreliminary work. Under review by the International Conference on Machine Learning (ICML).";
    const page3 = "List the corresponding authors and their emails (in the format Full Name <email@domain.com>).";
    expect(high(scanPdfPages([page1, "", page3], []))).toEqual([]);
  });

  it("still flags a real author name and a real email", () => {
    expect(high(scanPdfMetadata(meta({ author: "Jane Doe" }), []))).toHaveLength(1);
    expect(high(scanPdfMetadata(meta({ author: "Anonymous; Jane Doe" }), []))).toHaveLength(1);
    expect(high(scanPdfPages(["Jane Doe\njane.doe@uni-somewhere.edu\nAbstract"], []))).toHaveLength(1);
    expect(high(scanPdfPages(["{kahe, v-xiangz, jiansun}@microsoft.com"], []))).toHaveLength(1);
  });

  it("ignores placeholder emails in LaTeX sources too", () => {
    const tex = "\\icmlcorrespondingauthor{Firstname Lastname}{first1.last1@xxx.edu}\n";
    expect(scanSourceFile("main.tex", tex, []).filter((f) => f.rule === "email")).toEqual([]);
  });

  it("third-party code links are not High; your own release is", () => {
    // ICLR template: notation from a textbook available on GitHub; BERT footnote to tensor2tensor.
    const third = scanPdfPages(
      ["We follow the notation of Deep Learning Goodfellow et al. (2016) available at https://github.com/goodfeli/dlbook_notation/.\n1https://github.com/tensorflow/tensor2tensor"],
      [],
    ).filter((f) => f.rule === "repo-link");
    expect(third.length).toBe(2);
    expect(third.every((f) => f.severity === "medium")).toBe(true);

    const own = [
      "The code and pre-trained models are available at https://github.com/google-research/bert.",
      "Code is available at: https://github.com/weiliu89/caffe/tree/ssd .",
      "We release our code and pre-trained model weights at https://github.com/OpenAI/CLIP.",
      "The code we used to train and evaluate our models is available at https://github.com/tensorflow/tensor2tensor.",
    ];
    for (const text of own) expect(scanPdfPages([text], []).find((f) => f.rule === "repo-link")?.severity, text).toBe("high");
    // A link that contains one of your identifiers is always High.
    expect(scanPdfPages(["see https://github.com/janedoe/tool"], ["janedoe"]).find((f) => f.rule === "repo-link")?.severity).toBe("high");
  });

  it("does not report a table-of-contents entry as an acknowledgments section", () => {
    const toc = "Contents\nAbstract iv\nAcknowledgments vi\n1 Introduction 1\n1.1 Overview . . . . . . . . . . 1";
    expect(scanPdfPages([toc], []).filter((f) => f.rule === "acknowledgments")).toEqual([]);
    const dots = "Contents\n6 Acknowledgments . . . . . . . . . . . . . . 12\n7 References . . . . . . 13";
    expect(scanPdfPages([dots], []).filter((f) => f.rule === "acknowledgments")).toEqual([]);
    const real = "Acknowledgments\nWe thank Jane Roe for comments and the XYZ lab for compute.";
    expect(scanPdfPages([real], []).filter((f) => f.rule === "acknowledgments")).toHaveLength(1);
  });
});

describe("XMP author list", () => {
  it("is reported as one finding, not one per author (Nature PDFs list 30+ authors)", () => {
    const names = Array.from({ length: 34 }, (_, i) => `Author Number${i}`);
    const xmp = `<x:xmpmeta><rdf:RDF><rdf:Description><dc:creator><rdf:Seq>${names.map((n) => `<rdf:li>${n}</rdf:li>`).join("")}</rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const fs = scanPdfMetadata(meta({ xmp, hasXmp: true }), []).filter((f) => f.location.kind === "metadata" && f.location.field === "XMP dc:creator");
    expect(fs).toHaveLength(1);
    expect(fs[0].severity).toBe("high");
    expect(fs[0].title).toMatch(/34 authors/);
    expect(fs[0].snippet).toContain("Author Number0");
  });
});

/** Minimal JPEG byte layout: SOI, APP0 JFIF, APP1 XMP, APP1 Exif, APP13 Photoshop, COM, APP2 ICC, APP14 Adobe, DQT, SOS data, EOI. */
function jpegWithMetadata(): Uint8Array {
  const seg = (marker: number, payload: string | number[]) => {
    const body = typeof payload === "string" ? [...payload].map((c) => c.charCodeAt(0)) : payload;
    const len = body.length + 2;
    return [0xff, marker, len >> 8, len & 0xff, ...body];
  };
  return Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, "JFIF\0\x01\x01\0\0\x01\0\x01\0\0"),
    ...seg(0xe1, "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><dc:creator>Jane Doe</dc:creator></x:xmpmeta>"),
    ...seg(0xe1, "Exif\0\0MM\0*Artist Jane Doe"),
    ...seg(0xed, "Photoshop 3.0\x008BIM Jane Doe"),
    ...seg(0xfe, "Created by Jane Doe"),
    ...seg(0xe2, "ICC_PROFILE\0\x01\x01profile"),
    ...seg(0xee, "Adobe\0\x64\0\0\0\0\x01"),
    ...seg(0xdb, [0, ...Array(64).fill(1)]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    0x12, 0x34, 0xff, 0x00, 0x56,
    0xff, 0xd9,
  ]);
}

describe("metadata inside embedded JPEG images", () => {
  async function pdfWithJpeg() {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const ctx = doc.context;
    const img = PDFRawStream.of(
      ctx.obj({ Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" }),
      jpegWithMetadata(),
    );
    page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { Im0: ctx.register(img) } }));
    return doc.save();
  }

  it("is reported", async () => {
    const m = await readPdfMetadata(await pdfWithJpeg());
    expect(m.imageMetadata).toBe(1);
  });

  it("is removed losslessly: EXIF/XMP/Photoshop/comment segments go, colour segments and image data stay", async () => {
    const out = await stripPdfMetadata(await pdfWithJpeg());
    const raw = new TextDecoder("latin1").decode(out);
    expect(raw).not.toContain("Jane Doe");
    expect(raw).toContain("JFIF");
    expect(raw).toContain("ICC_PROFILE");
    expect(raw).toContain("Adobe\0");
    expect((await readPdfMetadata(out)).imageMetadata).toBe(0);
    const doc = await PDFDocument.load(out);
    const [, im] = doc.context.enumerateIndirectObjects().find(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))!;
    const bytes = (im as PDFRawStream).getContents();
    expect([...bytes.slice(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...bytes.slice(-7)]).toEqual([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]);
  });
});
