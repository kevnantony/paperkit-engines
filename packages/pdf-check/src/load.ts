import { PDFDict, PDFDocument, PDFRef, type PDFObject } from "pdf-lib";

/**
 * The one way PaperKit opens a PDF with pdf-lib: tolerant of encryption and broken objects, never rewrites
 * metadata, and repairs the trailer that pdf-lib loses on files with cross-reference streams.
 *
 * pdf-lib parses the file front to back and *replaces* its trailer info with every xref stream it meets. In a
 * linearized file (Acrobat "Fast Web View", many publisher and Word PDFs) the first-page xref stream carries
 * /Root, /Info and /Encrypt while the final one carries only /Size, so /Info and /Encrypt were dropped: the
 * author went unreported and an encrypted file looked unencrypted.
 */
export async function loadPdfDocument(bytes: Uint8Array | ArrayBuffer): Promise<PDFDocument> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  repairTrailer(doc, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return doc;
}

const TRAILER_KEYS = ["Info", "Encrypt"] as const;

/** Raw dictionaries that can hold trailer entries: `trailer << … >>` and xref stream dicts. */
function trailerDictTexts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/trailer\s*<</g)) out.push(text.slice(m.index!, m.index! + 2048));
  for (const m of text.matchAll(/\/Type\s*\/XRef\b/g)) {
    const start = Math.max(0, text.lastIndexOf("obj", m.index!));
    const end = text.indexOf("stream", m.index!);
    out.push(text.slice(start, end > 0 && end - start < 4096 ? end : m.index! + 2048));
  }
  return out;
}

export function repairTrailer(doc: PDFDocument, bytes: Uint8Array): void {
  const ctx = doc.context;
  const missing = TRAILER_KEYS.filter((k) => !(ctx.lookup(ctx.trailerInfo[k] as PDFObject | undefined) instanceof PDFDict));
  if (!missing.length) return;
  // Only trailers/xref dicts are scanned; decoding the whole file as latin1 is cheap compared with parsing it.
  const text = new TextDecoder("latin1").decode(bytes);
  if (!/\/Type\s*\/XRef\b/.test(text)) return; // classic trailers are merged correctly by pdf-lib
  const found: Partial<Record<(typeof TRAILER_KEYS)[number], PDFRef>> = {};
  for (const dict of trailerDictTexts(text)) {
    for (const key of missing) {
      const m = new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`).exec(dict);
      if (!m) continue;
      const ref = PDFRef.of(Number(m[1]), Number(m[2]));
      // Later sections win (incremental updates), but only if the object really is a dictionary.
      if (ctx.lookup(ref) instanceof PDFDict) found[key] = ref;
    }
  }
  if (found.Info) ctx.trailerInfo.Info = found.Info;
  if (found.Encrypt) {
    ctx.trailerInfo.Encrypt = found.Encrypt;
    (doc as { isEncrypted: boolean }).isEncrypted = true;
  }
}
