import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractStructure } from "../src";
import { textItemBox } from "../src";
import { extractTextBounds } from "./pdfjs-node";
import { mergeText } from "../src";
import {
  classifyPageSize,
  compareVersions,
  decodePermissions,
  describePageSize,
  formatPageList,
  readHeaderVersion,
  stripSubsetPrefix,
  unionBounds,
} from "../src";

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, "fixtures", name)));

describe("pdf util", () => {
  it("classifies paper sizes with tolerance and orientation", () => {
    expect(classifyPageSize(612, 792)).toBe("Letter");
    expect(classifyPageSize(595, 842)).toBe("A4");
    expect(classifyPageSize(842, 595)).toBe("A4 landscape");
    expect(classifyPageSize(500, 700)).toBeNull();
    expect(describePageSize(612, 792)).toBe("Letter (8.5 × 11 in)");
    expect(describePageSize(595.28, 841.89)).toBe("A4 (210 × 297 mm)");
    expect(describePageSize(500, 700)).toMatch(/^Custom/);
  });

  it("compares versions and reads headers", () => {
    expect(compareVersions("1.4", "1.7")).toBeLessThan(0);
    expect(compareVersions("2.0", "1.7")).toBeGreaterThan(0);
    expect(compareVersions("1.7", "1.7")).toBe(0);
    expect(readHeaderVersion(new TextEncoder().encode("%PDF-1.5\n%âãÏÓ"))).toBe("1.5");
    expect(readHeaderVersion(new TextEncoder().encode("hello"))).toBeNull();
  });

  it("decodes permission bits", () => {
    expect(decodePermissions(-3904)).toEqual({
      print: false,
      modify: false,
      copy: false,
      annotate: false,
      fillForms: false,
      assemble: false,
      printHighQuality: false,
    });
    expect(decodePermissions(-4).print).toBe(true);
    expect(decodePermissions(-4).copy).toBe(true);
  });

  it("formats names, page lists and bounds", () => {
    expect(stripSubsetPrefix("ABCDEF+Times-Roman")).toBe("Times-Roman");
    expect(stripSubsetPrefix("Times-Roman")).toBe("Times-Roman");
    expect(formatPageList([1, 2, 3, 5, 7, 8])).toBe("1–3, 5, 7–8");
    expect(unionBounds(null, { left: 1, top: 2, right: 3, bottom: 4 })).toEqual({ left: 1, top: 2, right: 3, bottom: 4 });
    expect(unionBounds({ left: 1, top: 2, right: 3, bottom: 4 }, { left: 0, top: 5, right: 9, bottom: 3 })).toEqual({
      left: 0,
      top: 2,
      right: 9,
      bottom: 4,
    });
  });

  it("computes a text box for upright text in a Letter viewport", () => {
    // pdf.js viewport transform for a 612×792 page at scale 1 flips y.
    const vt = [1, 0, 0, -1, 0, 792];
    const box = textItemBox(vt, [10, 0, 0, 10, 72, 700], 100);
    expect(box.left).toBeCloseTo(72);
    expect(box.right).toBeCloseTo(172);
    expect(box.top).toBeCloseTo(82); // 792 - 700 - 10
    expect(box.bottom).toBeCloseTo(94); // baseline 92 + 2 descent
  });
});

describe("extractStructure (pdf-lib, fixtures)", () => {
  it("finds non-embedded standard fonts and their first page", async () => {
    const f = await extractStructure(fixture("nonembedded.pdf"));
    expect(f.pageCount).toBe(2);
    expect(f.encrypted).toBe(false);
    const byName = Object.fromEntries(f.fonts.map((x) => [x.displayName, x]));
    expect(byName["Helvetica"]).toMatchObject({ embedded: false, firstPage: 1, subtype: "Type1" });
    expect(byName["Times-Roman"]).toMatchObject({ embedded: false, firstPage: 2 });
    expect(f.pages[0]).toMatchObject({ width: 612, height: 792 });
    expect(f.metadata.author).toBeUndefined();
  });

  it("sees embedded subset fonts after Ghostscript", async () => {
    const f = await extractStructure(fixture("embedded.pdf"));
    expect(f.fonts.length).toBeGreaterThanOrEqual(2);
    expect(f.fonts.every((x) => x.embedded)).toBe(true);
    expect(f.version).toBe("1.4");
  });

  it("reports mixed page sizes", async () => {
    const f = await extractStructure(fixture("mixed-sizes.pdf"));
    expect(f.pages.map((p) => classifyPageSize(p.width, p.height))).toEqual(["Letter", "A4", "Letter"]);
  });

  it("reads author and creator metadata", async () => {
    const f = await extractStructure(fixture("metadata.pdf"));
    expect(f.metadata.author).toBe("Jane Doe");
    expect(f.metadata.creator).toBe("LaTeX with hyperref");
  });

  it("detects Type 3 fonts", async () => {
    const f = await extractStructure(fixture("type3.pdf"));
    expect(f.fonts).toHaveLength(1);
    expect(f.fonts[0]).toMatchObject({ type3: true, embedded: true });
  });

  it("detects JavaScript, attachments, file: links and version 2.0", async () => {
    const f = await extractStructure(fixture("risky.pdf"));
    expect(f.version).toBe("2.0");
    expect(f.javascript).toBe(true);
    expect(f.embeddedFiles).toEqual(["data.csv"]);
    expect(f.fileLinks).toEqual(["file:///C:/Users/me/paper/fig1.pdf"]);
  });

  it("detects encryption and restrictions", async () => {
    const f = await extractStructure(fixture("encrypted.pdf"));
    expect(f.encrypted).toBe(true);
    expect(f.permissions?.print).toBe(false);
    expect(f.permissions?.modify).toBe(false);
  });

  it("rejects non-PDF input", async () => {
    await expect(extractStructure(new TextEncoder().encode("not a pdf"))).rejects.toThrow();
  });
});

describe("extractTextBounds (pdf.js legacy build in Node)", () => {
  it("measures text near the left edge", async () => {
    const bytes = fixture("risky.pdf");
    const text = await extractTextBounds(bytes);
    expect(text).toHaveLength(1);
    const t = text[0].text!;
    expect(t.left).toBeGreaterThanOrEqual(7);
    expect(t.left).toBeLessThan(10);
    expect(text[0].samples.left).toBe("Edge note");
    const facts = mergeText(await extractStructure(bytes), text);
    expect(facts.textAnalysed).toBe(true);
    expect(facts.pages[0].text).toEqual(t);
  });

  it("keeps text inside 1 inch for the clean fixture", async () => {
    const text = await extractTextBounds(fixture("embedded.pdf"));
    for (const p of text) {
      expect(p.text!.left).toBeGreaterThanOrEqual(71);
      expect(p.width - p.text!.right).toBeGreaterThan(72);
    }
  });
});
