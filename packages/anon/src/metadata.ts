/**
 * PDF metadata read + strip with pdf-lib. Runs in Node and the browser (no DOM needed).
 *
 * Strip removes: the Info dictionary (optionally keeping Title), XMP /Metadata streams on every object,
 * /PieceInfo (Illustrator/Acrobat private data), pdfTeX's /PTEX.FileName and /PTEX.InfoDict on embedded
 * figures, the author (/T), dates (/M, /CreationDate), rich text (/RC) and subject (/Subj) of every annotation
 * (the annotations themselves stay), embedded files (/Names /EmbeddedFiles, /AF and FileAttachment annotations),
 * and then garbage-collects every object no longer reachable, so old values don't survive as orphans.
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
import { loadPdfDocument } from "./pdf-load";
import { jpegMetadataCount, stripJpegMetadata } from "./jpeg";

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
  /** Distinct /T (author) values of annotations (comments, highlights, popups). Form fields are excluded. */
  annotationAuthors: string[];
  /** Number of annotations carrying an author, date, rich text or subject entry. */
  annotationMarkup: number;
  /** Embedded files: document-level (/EmbeddedFiles) and FileAttachment annotations. */
  attachments: { name: string; source: "document" | "annotation" }[];
  /** Link targets pointing at the local file system (file://, /Users/…, C:\…). */
  localLinks: string[];
  /** JPEG images whose data still carries EXIF/XMP/Photoshop/comment segments (camera, author, edit history). */
  imageMetadata: number;
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

const ANNOT_PRIVATE_KEYS = ["T", "M", "CreationDate", "RC", "Subj"];

const nameOf = (o: PDFObject | undefined) => (o instanceof PDFName ? o.decodeText() : null);

/** Every annotation dict on every page, plus their popups. */
function annotations(doc: PDFDocument): PDFDict[] {
  const out = new Set<PDFDict>();
  for (const page of doc.getPages()) {
    const annots = safe(() => page.node.lookup(N("Annots")));
    if (!(annots instanceof PDFArray)) continue;
    for (const ref of annots.asArray()) {
      const a = safe(() => doc.context.lookup(ref));
      if (!(a instanceof PDFDict)) continue;
      out.add(a);
      const popup = safe(() => a.lookup(N("Popup")));
      if (popup instanceof PDFDict) out.add(popup);
    }
  }
  return [...out];
}

const isWidget = (a: PDFDict) => nameOf(a.get(N("Subtype"))) === "Widget";

/** File name of a file specification (string or dictionary). */
function fileSpecName(spec: PDFObject | undefined): string | null {
  const direct = decodeText(spec);
  if (direct && !(spec instanceof PDFName)) return direct;
  if (spec instanceof PDFDict) for (const k of ["UF", "F", "Unix", "DOS", "Mac"]) {
    const v = decodeText(spec.lookup(N(k)));
    if (v) return v;
  }
  return null;
}

/** [key, value] pairs of a PDF name tree. */
function nameTreeEntries(node: PDFDict, out: [string, PDFObject][] = [], depth = 0): [string, PDFObject][] {
  if (depth > 32) return out;
  const names = node.lookup(N("Names"));
  if (names instanceof PDFArray) {
    const arr = names.asArray();
    for (let i = 0; i + 1 < arr.length; i += 2) {
      const value = node.context.lookup(arr[i + 1]);
      if (value) out.push([decodeText(arr[i]) ?? "", value]);
    }
  }
  const kids = node.lookup(N("Kids"));
  if (kids instanceof PDFArray) for (const k of kids.asArray()) {
    const kid = node.context.lookup(k);
    if (kid instanceof PDFDict) nameTreeEntries(kid, out, depth + 1);
  }
  return out;
}

const LOCAL_TARGET_RE = /^(?:file:|\/|~\/|[A-Za-z]:[\\/]|\\\\)/i;
const isLocalTarget = (t: string) => LOCAL_TARGET_RE.test(t.trim()) || new RegExp(LOCAL_PATH_RE.source).test(t);

function readAnnotationLeaks(doc: PDFDocument) {
  const authors: string[] = [];
  let markup = 0;
  const attachments: PdfMetadata["attachments"] = [];
  const localLinks: string[] = [];

  const names = safe(() => doc.catalog.lookup(N("Names")));
  const embedded = names instanceof PDFDict ? safe(() => names.lookup(N("EmbeddedFiles"))) : null;
  if (embedded instanceof PDFDict)
    for (const [key, spec] of nameTreeEntries(embedded)) attachments.push({ name: fileSpecName(spec) ?? (key || "unnamed"), source: "document" });

  for (const a of annotations(doc)) {
    const subtype = nameOf(a.get(N("Subtype")));
    if (subtype !== "Widget") {
      const author = decodeText(a.lookup(N("T")));
      if (author && author.trim()) authors.push(author.trim());
      if (ANNOT_PRIVATE_KEYS.some((k) => a.has(N(k)))) markup++;
    }
    if (subtype === "FileAttachment") attachments.push({ name: fileSpecName(a.lookup(N("FS"))) ?? "unnamed", source: "annotation" });
    const action = safe(() => a.lookup(N("A")));
    if (action instanceof PDFDict) {
      const kind = nameOf(action.get(N("S")));
      const target = kind === "URI" ? decodeText(action.lookup(N("URI"))) : kind === "Launch" || kind === "GoToR" ? fileSpecName(action.lookup(N("F"))) : null;
      if (target && isLocalTarget(target)) localLinks.push(target);
    }
  }
  return { annotationAuthors: [...new Set(authors)], annotationMarkup: markup, attachments, localLinks: [...new Set(localLinks)] };
}

/** Image streams whose data is a plain JPEG (/Filter /DCTDecode, alone). */
function jpegStreams(doc: PDFDocument): [PDFRef, PDFRawStream][] {
  const out: [PDFRef, PDFRawStream][] = [];
  for (const [ref, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream) || nameOf(o.dict.lookup(N("Subtype"))) !== "Image") continue;
    const f = o.dict.lookup(N("Filter"));
    const filter = f instanceof PDFArray && f.size() === 1 ? doc.context.lookup(f.get(0)) : f;
    if (nameOf(filter as PDFObject | undefined) === "DCTDecode") out.push([ref, o]);
  }
  return out;
}

const isXmpStream =(doc: PDFDocument, v: PDFObject | undefined) => {
  const s = v instanceof PDFRef ? doc.context.lookup(v) : v;
  return s instanceof PDFStream;
};

export async function readPdfMetadata(bytes: Uint8Array | ArrayBuffer): Promise<PdfMetadata> {
  const doc = await loadPdfDocument(bytes);
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

  const leaks = encrypted ? { annotationAuthors: [], annotationMarkup: 0, attachments: [], localLinks: [] } : readAnnotationLeaks(doc);

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
    ...leaks,
    imageMetadata: encrypted ? 0 : jpegStreams(doc).filter(([, s]) => jpegMetadataCount(s.getContents()) > 0).length,
    pageCount: doc.getPageCount(),
    encrypted,
  };
}

export interface StripOptions {
  /** Keep the document Title (useful: it shows in the browser tab and on OpenReview). */
  keepTitle: boolean;
  /** Remove embedded files (document attachments and FileAttachment annotations). Default true. */
  removeAttachments?: boolean;
  /** Categories to leave untouched (all removed by default). Additive: used by the Metadata Stripper's per-field toggles. */
  keep?: {
    /** XMP /Metadata streams (document, pages, images). */
    xmp?: boolean;
    /** /PieceInfo and /LastModified. */
    pieceInfo?: boolean;
    /** pdfTeX /PTEX.FileName and /PTEX.InfoDict of embedded figures. */
    figurePaths?: boolean;
    /** Annotation author, dates, rich text and subject. */
    annotations?: boolean;
    /** EXIF/XMP/IPTC segments inside embedded JPEG images. */
    imageMetadata?: boolean;
  };
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
  const doc = await loadPdfDocument(bytes);
  if (doc.isEncrypted) throw new Error("This PDF is encrypted. Remove the password protection first, then strip its metadata.");
  const ctx = doc.context;
  const title = opts.keepTitle ? safe(() => doc.getTitle()) : null;

  const info = ctx.obj({});
  if (title) info.set(N("Title"), PDFHexString.fromText(title));
  ctx.trailerInfo.Info = ctx.register(info);

  const removeAttachments = opts.removeAttachments ?? true;

  if (removeAttachments) {
    const names = doc.catalog.lookup(N("Names"));
    if (names instanceof PDFDict) {
      names.delete(N("EmbeddedFiles"));
      if (names.keys().length === 0) doc.catalog.delete(N("Names"));
    }
    doc.catalog.delete(N("Collection"));
    // Drop FileAttachment annotations (and their popups) from every page.
    for (const page of doc.getPages()) {
      const annots = page.node.lookup(N("Annots"));
      if (!(annots instanceof PDFArray)) continue;
      const dropped = new Set<PDFDict>();
      for (const ref of annots.asArray()) {
        const a = ctx.lookup(ref);
        if (a instanceof PDFDict && nameOf(a.get(N("Subtype"))) === "FileAttachment") dropped.add(a);
      }
      if (!dropped.size) continue;
      const kept = annots.asArray().filter((ref) => {
        const a = ctx.lookup(ref);
        if (!(a instanceof PDFDict)) return true;
        if (dropped.has(a)) return false;
        const parent = a.lookup(N("Parent"));
        return !(nameOf(a.get(N("Subtype"))) === "Popup" && parent instanceof PDFDict && dropped.has(parent));
      });
      // Belt and braces: if something else (e.g. the structure tree) still points at it, it carries no file.
      for (const a of dropped) for (const k of ["FS", "Contents", "Popup", ...ANNOT_PRIVATE_KEYS]) a.delete(N(k));
      page.node.set(N("Annots"), ctx.obj(kept));
    }
  }

  // Annotation author, dates, rich text and subject. Form-field widgets keep /T (it is the field name).
  const keep = opts.keep ?? {};
  if (!keep.annotations) for (const a of annotations(doc)) for (const k of isWidget(a) ? ["M"] : ANNOT_PRIVATE_KEYS) a.delete(N(k));

  const privateKeys = [
    ...(keep.xmp ? [] : ["Metadata"]),
    ...(keep.pieceInfo ? [] : ["PieceInfo", "LastModified"]),
    ...(keep.figurePaths ? [] : ["PTEX.FileName", "PTEX.InfoDict"]),
    ...(removeAttachments ? ["AF"] : []),
  ];
  for (const dict of [...allDicts(doc)]) {
    if (dict === info) continue;
    for (const key of privateKeys) dict.delete(N(key));
  }
  for (const [ref, s] of keep.imageMetadata ? [] : jpegStreams(doc)) {
    const clean = stripJpegMetadata(s.getContents());
    if (clean) ctx.assign(ref, PDFRawStream.of(s.dict, clean));
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
