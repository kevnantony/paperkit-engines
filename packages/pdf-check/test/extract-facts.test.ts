import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractPdfFacts, PdfReadError, runChecks, optionsForVenue } from "../src";
import { extractTextBounds } from "./pdfjs-node";

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, "fixtures", name)));

describe("extractPdfFacts (injectable text pass)", () => {
  it("runs the structure pass alone when no text extractor is given", async () => {
    const facts = await extractPdfFacts(fixture("embedded.pdf"));
    expect(facts.textAnalysed).toBe(false);
    expect(facts.pageCount).toBeGreaterThan(0);
    const margins = runChecks(facts, optionsForVenue("ieee")).find((r) => r.id === "margins");
    expect(margins?.status).toBe("skip");
  });

  it("merges injected page text and reports progress", async () => {
    const phases: string[] = [];
    const facts = await extractPdfFacts(fixture("embedded.pdf"), {
      extractText: (bytes) => extractTextBounds(bytes),
      onProgress: (p) => phases.push(p.phase),
    });
    expect(facts.textAnalysed).toBe(true);
    expect(facts.pages[0].text).not.toBeNull();
    expect(phases[0]).toBe("structure");
  });

  it("skips text when the extractor throws", async () => {
    const facts = await extractPdfFacts(fixture("embedded.pdf"), { extractText: async () => { throw new Error("boom"); } });
    expect(facts.textAnalysed).toBe(false);
  });

  it("rejects non-PDF input", async () => {
    await expect(extractPdfFacts(new TextEncoder().encode("hello"))).rejects.toBeInstanceOf(PdfReadError);
  });
});
