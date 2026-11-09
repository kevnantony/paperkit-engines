import { extractStructure, type StructureFacts } from "./structure";
import type { PageText } from "./text";
import type { PdfFacts } from "./types";

export type FactsProgress = { phase: "structure" } | { phase: "text"; done: number; total: number };

/** Combine structural facts with per-page text bounds. */
export function mergeText(structure: StructureFacts, text: PageText[] | null): PdfFacts {
  if (!text) return { ...structure, textAnalysed: false };
  const byNumber = new Map(text.map((t) => [t.number, t]));
  return {
    ...structure,
    textAnalysed: true,
    pages: structure.pages.map((p) => {
      const t = byNumber.get(p.number);
      return t ? { ...p, text: t.text, samples: t.samples } : p;
    }),
  };
}

export class PdfReadError extends Error {}

export interface ExtractOptions {
  /**
   * Optional per-page text pass (e.g. `extractTextBounds` over a pdf.js document). When omitted or when it
   * throws, `textAnalysed` is false and the margin check is skipped; every other check still runs.
   */
  extractText?: (bytes: Uint8Array, onProgress?: (done: number, total: number) => void) => Promise<PageText[]>;
  onProgress?: (p: FactsProgress) => void;
}

/** Full extraction: pdf-lib structure pass plus an optional injected text pass. Runs in Node and browsers. */
export async function extractPdfFacts(input: Uint8Array | ArrayBuffer, opts: ExtractOptions = {}): Promise<PdfFacts> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { onProgress } = opts;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw new PdfReadError("This file does not look like a PDF (no %PDF header).");

  onProgress?.({ phase: "structure" });
  let structure: StructureFacts;
  try {
    structure = await extractStructure(bytes);
  } catch (err) {
    throw new PdfReadError(`Could not parse the PDF: ${err instanceof Error ? err.message : String(err)}`);
  }

  let text: PageText[] | null = null;
  if (opts.extractText) {
    try {
      text = await opts.extractText(bytes, (done, total) => onProgress?.({ phase: "text", done, total }));
    } catch {
      // Password-protected or malformed content streams: margin check is skipped, other checks still run.
      text = null;
    }
  }
  return mergeText(structure, text);
}
