/**
 * PDF metadata read + strip with pdf-lib. Runs in Node and the browser (no DOM needed).
 *
 * Strip removes: the Info dictionary (optionally keeping Title), XMP /Metadata streams on every object,
 * /PieceInfo (Illustrator/Acrobat private data), pdfTeX's /PTEX.FileName and /PTEX.InfoDict on embedded
 * figures, and then garbage-collects every object no longer reachable, so old values don't survive as orphans.
 */
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject,
} from "pdf-lib";

export interface PdfMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
  creationDate: string | null;
  modDate: string | null;
  /** Any XMP /Metadata stream (document-level or on pages/images). */
  hasXmp: boolean;
  /** Decoded document-level XMP packet (truncated to 64 KB). */
  xmp: string | null;
  hasPieceInfo: boolean;
  /** pdfTeX /PTEX.FileName values of embedded PDF figures (often local paths). */
  embeddedFileNames: string[];
  /** Author/Creator values from embedded figures' /PTEX.InfoDict. */
  embeddedInfo: { field: string; value: string }[];
  pageCount: number;
  encrypted: boolean;
}

export const METADATA_FIELDS = [
  ["title", "Title"],
  ["author", "Author"],
  ["subject", "Subject"],
  ["keywords", "Keywords"],
  ["creator", "Creator"],
  ["producer", "Producer"],
  ["creationDate", "Created"],
  ["modDate", "Modified"],
] as const;

const N = (s: string) => PDFName.of(s);

function safe<T>(f: () => T): T | null {
  try {
    const v = f();
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

function decodeText(obj: PDFObject | undefined): string | null {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  if (obj instanceof PDFName) return obj.decodeText();
  return null;
}

function streamText(stream: PDFStream): string | null {
  try {
    const bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
    return new TextDecoder("utf-8").decode(bytes.subarray(0, 65536));
  } catch {
    return null;
  }
}

/** Every dictionary in the document (indirect objects, stream dicts and nested dicts). */
function* allDicts(doc: PDFDocument): Generator<PDFDict> {
  const seen = new Set<PDFDict>();
  const stack: PDFObject[] = doc.context.enumerateIndirectObjects().map(([, o]) => o);
  stack.push(doc.context.trailerInfo.Info as PDFObject);
  while (stack.length) {
    const o = stack.pop();
    if (!o) continue;
    const dict = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (dict) {
      if (seen.has(dict)) continue;
      seen.add(dict);
      yield dict;
      for (const [, v] of dict.entries()) if (!(v instanceof PDFRef)) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) if (!(v instanceof PDFRef)) stack.push(v);
    }
  }
}

const isXmpStream = (doc: PDFDocument, v: PDFObject | undefined) => {
  const s = v instanceof PDFRef ? doc.context.lookup(v) : v;
  return s instanceof PDFStream;
};

export async function readPdfMetadata(bytes: Uint8Array | ArrayBuffer): Promise<PdfMetadata> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const encrypted = doc.isEncrypted;
  const str = (f: () => string | undefined) => (encrypted ? null : safe(f)) || null;
  const date = (f: () => Date | undefined) => {
    const d = encrypted ? null : safe(f);
    return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
  };

  let xmp: string | null = null;
  const docMeta = doc.catalog.lookup(N("Metadata"));
  if (docMeta instanceof PDFStream) xmp = streamText(docMeta);

  let hasXmp = false;
  let hasPieceInfo = false;
  const embeddedFileNames: string[] = [];
  const embeddedInfo: { field: string; value: string }[] = [];
  for (const dict of allDicts(doc)) {
    if (dict.has(N("Metadata")) && isXmpStream(doc, dict.get(N("Metadata")))) hasXmp = true;
    if (dict.has(N("PieceInfo"))) hasPieceInfo = true;
    const fname = decodeText(dict.get(N("PTEX.FileName")));
    if (fname) embeddedFileNames.push(fname);
    const info = dict.lookup(N("PTEX.InfoDict"));
    if (info instanceof PDFDict) {
      for (const field of ["Author", "Creator"]) {
        const v = decodeText(info.lookup(N(field)));
        if (v && v.trim()) embeddedInfo.push({ field, value: v });
      }
    }
  }

  return {
    title: str(() => doc.getTitle()),
    author: str(() => doc.getAuthor()),
    subject: str(() => doc.getSubject()),
    keywords: str(() => doc.getKeywords()),
    creator: str(() => doc.getCreator()),
    producer: str(() => doc.getProducer()),
    creationDate: date(() => doc.getCreationDate()),
    modDate: date(() => doc.getModificationDate()),
    hasXmp,
    xmp,
    hasPieceInfo,
    embeddedFileNames: [...new Set(embeddedFileNames)],
    embeddedInfo,
    pageCount: doc.getPageCount(),
    encrypted,
  };
}

export interface StripOptions {
  /** Keep the document Title (useful: it shows in the browser tab and on OpenReview). */
  keepTitle: boolean;
}

/** Delete every indirect object not reachable from the trailer (Root / Info). */
function collectGarbage(doc: PDFDocument) {
  const ctx = doc.context;
  const reachable = new Set<PDFRef>();
  const stack: PDFObject[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter(Boolean) as PDFObject[];
  if (ctx.trailerInfo.Encrypt) stack.push(ctx.trailerInfo.Encrypt as PDFObject);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (reachable.has(o)) continue;
      reachable.add(o);
      const target = ctx.lookup(o);
      if (target) stack.push(target);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      stack.push(...o.asArray());
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!reachable.has(ref)) ctx.delete(ref);
}

export async function stripPdfMetadata(bytes: Uint8Array | ArrayBuffer, opts: StripOptions = { keepTitle: false }): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  if (doc.isEncrypted) throw new Error("This PDF is encrypted. Remove the password protection first, then strip its metadata.");
  const ctx = doc.context;
  const title = opts.keepTitle ? safe(() => doc.getTitle()) : null;

  const info = ctx.obj({});
  if (title) info.set(N("Title"), PDFHexString.fromText(title));
  ctx.trailerInfo.Info = ctx.register(info);

  for (const dict of [...allDicts(doc)]) {
    if (dict === info) continue;
    for (const key of ["Metadata", "PieceInfo", "PTEX.FileName", "PTEX.InfoDict", "LastModified"]) dict.delete(N(key));
  }
  // Viewer preference asking to show the Title in the window bar is fine to keep.
  collectGarbage(doc);
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

/** Local filesystem paths that reveal a user name: /Users/jane, /home/jane, C:\Users\jane. */
export const LOCAL_PATH_RE = /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])[^\s/\\"'<>]+/g;

/** Values of dc:creator (and similar author fields) in an XMP packet. */
export function xmpAuthors(xmp: string): string[] {
  const out: string[] = [];
  for (const block of xmp.matchAll(/<(dc:creator|pdf:Author|xmp:Author|photoshop:Credit)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const lis = [...block[2].matchAll(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/g)].map((m) => m[1].trim());
    out.push(...(lis.length ? lis : [block[2].trim()]));
  }
  for (const attr of xmp.matchAll(/\b(?:pdf:Author|xmp:Author)="([^"]*)"/g)) out.push(attr[1]);
  return [...new Set(out.map(decodeXmlEntities).filter(Boolean))];
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}
