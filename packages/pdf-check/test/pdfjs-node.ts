/**
 * Test helper: load a PDF with the pdf.js legacy build in Node (no worker) and run the package's
 * `extractTextBounds` over it. pdfjs-dist is a devDependency only; the package does not bundle pdf.js.
 */
import { extractTextBounds as fromDocument, type PageText } from "../src";

export async function extractTextBounds(bytes: Uint8Array): Promise<PageText[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    return await fromDocument(doc);
  } finally {
    await task.destroy();
  }
}
