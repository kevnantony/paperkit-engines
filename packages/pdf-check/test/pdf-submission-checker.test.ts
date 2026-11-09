import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FontFact, PdfFacts } from "../src";
import { extractStructure } from "../src";
import { extractTextBounds } from "./pdfjs-node";
import { mergeText } from "../src";
import {
  checkActiveContent,
  checkEncryption,
  checkFonts,
  checkMargins,
  checkMetadata,
  checkPageCount,
  checkPageSize,
  checkType3,
  checkVersion,
  findMarginViolations,
  getVenue,
  optionsForVenue,
  parsePageLimit,
  reportToText,
  runChecks,
  summarize,
} from "../src";

const letter = (n: number, text = { left: 72, top: 72, right: 540, bottom: 720 }) => ({ number: n, width: 612, height: 792, rotate: 0, text });

function facts(over: Partial<PdfFacts> = {}): PdfFacts {
  return {
    fileSize: 1000,
    version: "1.5",
    pageCount: 2,
    pages: [letter(1), letter(2)],
    fonts: [],
    encrypted: false,
    permissions: null,
    fontsReliable: true,
    javascript: false,
    embeddedFiles: [],
    fileLinks: [],
    metadata: {},
    textAnalysed: true,
    ...over,
  };
}

const font = (over: Partial<FontFact>): FontFact => ({
  name: "Times-Roman",
  displayName: "Times-Roman",
  subtype: "Type1",
  embedded: true,
  type3: false,
  pages: [1],
  firstPage: 1,
  ...over,
});

describe("checkFonts", () => {
  it("passes when every font is embedded", () => {
    expect(checkFonts(facts({ fonts: [font({}), font({ name: "ABCDEF+CMR10", displayName: "CMR10" })] })).status).toBe("pass");
  });
  it("passes with no fonts", () => {
    expect(checkFonts(facts()).summary).toMatch(/No fonts/);
  });
  it("fails and lists non-embedded fonts with first page", () => {
    const r = checkFonts(facts({ fonts: [font({}), font({ name: "Helvetica", displayName: "Helvetica", embedded: false, firstPage: 3 })] }));
    expect(r.status).toBe("fail");
    expect(r.summary).toBe("1 of 2 fonts is not embedded.");
    expect(r.details).toEqual(["Helvetica (Type1) — first used on page 3"]);
    expect(r.fix).toBeTruthy();
    expect(r.link?.href).toBe("/font-embedder");
  });
  it("warns when fonts cannot be inspected", () => {
    expect(checkFonts(facts({ fontsReliable: false })).status).toBe("warn");
  });
});

describe("checkType3", () => {
  it("warns about Type 3 fonts with matplotlib advice", () => {
    const r = checkType3(facts({ fonts: [font({ type3: true, subtype: "Type3", displayName: "DejaVuSans" })] }));
    expect(r.status).toBe("warn");
    expect(r.fix).toMatch(/fonttype'\] = 42/);
  });
  it("passes without Type 3", () => expect(checkType3(facts({ fonts: [font({})] })).status).toBe("pass"));
});

describe("checkVersion", () => {
  it("passes 1.7 and below", () => expect(checkVersion(facts({ version: "1.7" })).status).toBe("pass"));
  it("warns above 1.7 and shows version", () => {
    const r = checkVersion(facts({ version: "2.0" }));
    expect(r.status).toBe("warn");
    expect(r.summary).toContain("2.0");
  });
});

describe("checkPageSize", () => {
  it("passes consistent Letter for generic and IEEE", () => {
    expect(checkPageSize(facts(), { expectedSize: null }).status).toBe("pass");
    expect(checkPageSize(facts(), { expectedSize: "Letter" }).summary).toBe("Letter (8.5 × 11 in) on all 2 pages.");
  });
  it("fails Letter when the venue expects A4", () => {
    const r = checkPageSize(facts(), { expectedSize: "A4" });
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/expects A4/);
  });
  it("fails mixed sizes and lists pages", () => {
    const r = checkPageSize(facts({ pages: [letter(1), { number: 2, width: 595.28, height: 841.89, rotate: 0 }, letter(3)], pageCount: 3 }), {
      expectedSize: null,
    });
    expect(r.status).toBe("fail");
    expect(r.details).toEqual(["Letter (8.5 × 11 in): pages 1, 3", "A4 (210 × 297 mm): page 2"]);
  });
  it("skips empty documents", () => expect(checkPageSize(facts({ pages: [], pageCount: 0 }), { expectedSize: null }).status).toBe("skip"));
});

describe("checkPageCount", () => {
  it("passes with no limit", () => expect(checkPageCount(facts(), { pageLimit: null }).summary).toBe("2 pages (no limit set)."));
  it("passes at the limit", () => expect(checkPageCount(facts(), { pageLimit: 2 }).status).toBe("pass"));
  it("fails over the limit", () => {
    const r = checkPageCount(facts({ pageCount: 10 }), { pageLimit: 8 });
    expect(r.status).toBe("fail");
    expect(r.summary).toContain("2 over the 8-page limit");
  });
  it("parses the limit input", () => {
    expect(parsePageLimit("")).toBeNull();
    expect(parsePageLimit(" 8 ")).toBe(8);
    expect(parsePageLimit("0")).toBeNull();
    expect(parsePageLimit("2.5")).toBeNull();
    expect(parsePageLimit("abc")).toBeNull();
  });
});

describe("checkEncryption", () => {
  it("passes unencrypted", () => expect(checkEncryption(facts()).status).toBe("pass"));
  it("fails encrypted and lists restrictions", () => {
    const r = checkEncryption(
      facts({
        encrypted: true,
        permissions: { print: true, modify: false, copy: false, annotate: true, fillForms: true, assemble: true, printHighQuality: true },
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.summary).toBe("Encrypted; restricts editing, copying text.");
  });
});

describe("checkActiveContent", () => {
  it("passes a plain PDF", () => expect(checkActiveContent(facts()).status).toBe("pass"));
  it("warns on JS, attachments and file links", () => {
    const r = checkActiveContent(facts({ javascript: true, embeddedFiles: ["a.csv"], fileLinks: ["file:///x.pdf"] }));
    expect(r.status).toBe("warn");
    expect(r.details).toHaveLength(3);
  });
});

describe("checkMetadata", () => {
  it("passes without author/creator", () => expect(checkMetadata(facts({ metadata: { producer: "pdfTeX" } })).status).toBe("pass"));
  it("warns and links to the metadata stripper", () => {
    const r = checkMetadata(facts({ metadata: { author: "Jane", creator: "Word" } }));
    expect(r.status).toBe("warn");
    expect(r.details).toEqual(["Author: Jane", "Creator: Word"]);
    expect(r.link?.href).toBe("/metadata-stripper");
  });
  it("skips encrypted files", () => expect(checkMetadata(facts({ encrypted: true })).status).toBe("skip"));
});

describe("margins", () => {
  it("finds violations per side in inches", () => {
    const pages = [letter(1, { left: 9, top: 72, right: 600, bottom: 720 })];
    const v = findMarginViolations(pages, 0.5);
    expect(v.map((x) => x.side)).toEqual(["left", "right"]);
    expect(v[0].inches).toBe(0.13);
  });
  it("reports text off the page as negative", () => {
    const v = findMarginViolations([letter(1, { left: -10, top: 72, right: 540, bottom: 720 })], 0.5);
    expect(v[0].inches).toBeLessThan(0);
    const r = checkMargins(facts({ pages: [letter(1, { left: -10, top: 72, right: 540, bottom: 720 })] }), { marginIn: 0.5 });
    expect(r.details?.[0]).toMatch(/off the left edge/);
  });
  it("respects tolerance at exactly the margin", () => {
    expect(findMarginViolations([letter(1, { left: 36, top: 36, right: 576, bottom: 756 })], 0.5)).toEqual([]);
  });
  it("passes, warns and skips", () => {
    expect(checkMargins(facts(), { marginIn: 0.5 }).status).toBe("pass");
    expect(checkMargins(facts(), { marginIn: 1.5 }).status).toBe("warn");
    expect(checkMargins(facts({ textAnalysed: false }), { marginIn: 0.5 }).status).toBe("skip");
    expect(checkMargins(facts({ pages: [{ number: 1, width: 612, height: 792, rotate: 0, text: null }] }), { marginIn: 0.5 }).status).toBe("skip");
  });
});

describe("venues and report", () => {
  it("maps presets to options", () => {
    expect(optionsForVenue("ieee", 6)).toEqual({ expectedSize: "Letter", marginIn: 0.6, pageLimit: 6 });
    expect(optionsForVenue("lncs").expectedSize).toBe("A4");
    expect(getVenue("arxiv").size).toBeNull();
  });
  it("runs all nine checks in order and summarises", () => {
    const f = facts({ fonts: [font({ embedded: false, displayName: "Helvetica" })], version: "2.0" });
    const rows = runChecks(f, optionsForVenue("generic"));
    expect(rows.map((r) => r.id)).toEqual(["fonts", "type3", "version", "page-size", "page-count", "encryption", "active-content", "metadata", "margins"]);
    expect(summarize(f, rows)).toMatchObject({ pages: 2, fonts: 1, fontsEmbedded: 0, fails: 1, warnings: 1 });
    expect(reportToText("p.pdf", rows)).toContain("[FAIL] All fonts embedded");
  });
});

describe("golden fixtures end to end (pdf-lib + pdf.js in Node)", () => {
  const load = async (name: string) => {
    const bytes = new Uint8Array(readFileSync(path.join(__dirname, "fixtures", name)));
    return mergeText(await extractStructure(bytes), await extractTextBounds(bytes).catch(() => null));
  };
  const statuses = async (name: string, venue: Parameters<typeof optionsForVenue>[0] = "generic", limit: number | null = null) =>
    Object.fromEntries(runChecks(await load(name), optionsForVenue(venue, limit)).map((r) => [r.id, r.status]));

  it("clean, embedded Letter PDF passes everything for IEEE", async () => {
    expect(await statuses("embedded.pdf", "ieee", 8)).toEqual({
      fonts: "pass",
      type3: "pass",
      version: "pass",
      "page-size": "pass",
      "page-count": "pass",
      encryption: "pass",
      "active-content": "pass",
      metadata: "pass",
      margins: "pass",
    });
  });
  it("non-embedded fixture fails fonts and page limit 1", async () => {
    const s = await statuses("nonembedded.pdf", "generic", 1);
    expect(s.fonts).toBe("fail");
    expect(s["page-count"]).toBe("fail");
  });
  it("same Letter file fails for LNCS (A4)", async () => {
    expect((await statuses("embedded.pdf", "lncs"))["page-size"]).toBe("fail");
  });
  it("mixed sizes fail", async () => expect((await statuses("mixed-sizes.pdf"))["page-size"]).toBe("fail"));
  it("metadata warns", async () => expect((await statuses("metadata.pdf")).metadata).toBe("warn"));
  it("type3 warns", async () => expect((await statuses("type3.pdf")).type3).toBe("warn"));
  it("risky warns on version, active content and margins", async () => {
    const s = await statuses("risky.pdf");
    expect(s.version).toBe("warn");
    expect(s["active-content"]).toBe("warn");
    expect(s.margins).toBe("warn");
  });
  it("encrypted fails", async () => expect((await statuses("encrypted.pdf")).encryption).toBe("fail"));
});
