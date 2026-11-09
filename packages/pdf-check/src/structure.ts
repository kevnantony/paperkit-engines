import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFContext,
} from "pdf-lib";
import type { FontFact, PageFact, PdfFacts, PdfMetadata } from "./types";
import { compareVersions, decodePermissions, readHeaderVersion, stripSubsetPrefix } from "./util";

/** Facts that pdf-lib can read without rendering. Text bounds are added later by the pdf.js pass. */
export type StructureFacts = Omit<PdfFacts, "textAnalysed">;

const N = (s: string) => PDFName.of(s);

function deref(ctx: PDFContext, obj: PDFObject | undefined): PDFObject | undefined {
  return obj instanceof PDFRef ? ctx.lookup(obj) : obj;
}

function asDict(ctx: PDFContext, obj: PDFObject | undefined): PDFDict | undefined {
  const o = deref(ctx, obj);
  if (o instanceof PDFDict) return o;
  if (o instanceof PDFStream) return o.dict;
  return undefined;
}

function nameOf(obj: PDFObject | undefined): string | undefined {
  return obj instanceof PDFName ? obj.decodeText() : undefined;
}

function textOf(ctx: PDFContext, obj: PDFObject | undefined): string | undefined {
  const o = deref(ctx, obj);
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  if (o instanceof PDFName) return o.decodeText();
  return undefined;
}

function hasFontFile(desc: PDFDict | undefined): boolean {
  if (!desc) return false;
  return ["FontFile", "FontFile2", "FontFile3"].some((k) => desc.get(N(k)) !== undefined);
}

interface RawFont {
  name: string;
  subtype: string;
  embedded: boolean;
  type3: boolean;
}

function describeFont(ctx: PDFContext, font: PDFDict): RawFont {
  const subtype = nameOf(font.get(N("Subtype"))) ?? "Unknown";
  const name = nameOf(font.get(N("BaseFont"))) ?? textOf(ctx, font.get(N("Name"))) ?? "(unnamed)";
  if (subtype === "Type3") return { name: name === "(unnamed)" ? "Type 3 font" : name, subtype, embedded: true, type3: true };
  if (subtype === "Type0") {
    const desc = deref(ctx, font.get(N("DescendantFonts")));
    const cid = desc instanceof PDFArray && desc.size() > 0 ? asDict(ctx, desc.get(0)) : undefined;
    const fd = cid ? asDict(ctx, cid.get(N("FontDescriptor"))) : undefined;
    const cidType = cid ? nameOf(cid.get(N("Subtype"))) : undefined;
    return { name, subtype: cidType ? `Type0/${cidType}` : subtype, embedded: hasFontFile(fd), type3: false };
  }
  const fd = asDict(ctx, font.get(N("FontDescriptor")));
  return { name, subtype, embedded: hasFontFile(fd), type3: false };
}

/** Walk a resource dictionary (and nested Form XObjects / Type 3 resources) and report every font. */
function collectFonts(
  ctx: PDFContext,
  resources: PDFDict | undefined,
  onFont: (font: RawFont) => void,
  visited: Set<PDFObject>,
  depth = 0,
) {
  if (!resources || visited.has(resources) || depth > 12) return;
  visited.add(resources);

  const fonts = asDict(ctx, resources.get(N("Font")));
  if (fonts) {
    for (const [, ref] of fonts.entries()) {
      const font = asDict(ctx, ref);
      if (!font) continue;
      onFont(describeFont(ctx, font));
      // Type 3 glyph procedures can use other fonts.
      if (nameOf(font.get(N("Subtype"))) === "Type3") {
        collectFonts(ctx, asDict(ctx, font.get(N("Resources"))), onFont, visited, depth + 1);
      }
    }
  }

  const xobjects = asDict(ctx, resources.get(N("XObject")));
  if (xobjects) {
    for (const [, ref] of xobjects.entries()) {
      const xo = deref(ctx, ref);
      if (!(xo instanceof PDFStream) || visited.has(xo)) continue;
      visited.add(xo);
      if (nameOf(xo.dict.get(N("Subtype"))) !== "Form") continue;
      collectFonts(ctx, asDict(ctx, xo.dict.get(N("Resources"))), onFont, visited, depth + 1);
    }
  }
}

/** Fonts inside annotation appearance streams (form fields, stamps). */
function collectAnnotationFonts(ctx: PDFContext, annots: PDFArray | undefined, onFont: (f: RawFont) => void, visited: Set<PDFObject>) {
  if (!annots) return;
  for (let i = 0; i < annots.size(); i++) {
    const annot = asDict(ctx, annots.get(i));
    const ap = annot && asDict(ctx, annot.get(N("AP")));
    if (!ap) continue;
    for (const key of ["N", "R", "D"]) {
      const entry = deref(ctx, ap.get(N(key)));
      const streams: PDFStream[] = [];
      if (entry instanceof PDFStream) streams.push(entry);
      else if (entry instanceof PDFDict) {
        for (const [, v] of entry.entries()) {
          const s = deref(ctx, v);
          if (s instanceof PDFStream) streams.push(s);
        }
      }
      for (const s of streams) collectFonts(ctx, asDict(ctx, s.dict.get(N("Resources"))), onFont, visited);
    }
  }
}

interface RiskScan {
  javascript: boolean;
  embeddedFiles: string[];
  fileLinks: string[];
}

/** Scan every object in the file for JavaScript actions, attachments and links to local files. */
function scanRisks(ctx: PDFContext): RiskScan {
  const out: RiskScan = { javascript: false, embeddedFiles: [], fileLinks: [] };
  const seen = new Set<PDFObject>();

  const visit = (obj: PDFObject | undefined, depth: number) => {
    if (!obj || depth > 8 || seen.has(obj)) return;
    if (obj instanceof PDFArray) {
      seen.add(obj);
      for (let i = 0; i < obj.size(); i++) {
        const v = obj.get(i);
        if (!(v instanceof PDFRef)) visit(v, depth + 1);
      }
      return;
    }
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    if (!dict) return;
    seen.add(obj);

    const s = nameOf(dict.get(N("S")));
    if (s === "JavaScript" || dict.get(N("JS")) !== undefined) out.javascript = true;
    if (s === "Launch" || s === "GoToR" || s === "GoToE") {
      const target = fileSpecName(ctx, dict.get(N("F"))) ?? textOf(ctx, dict.get(N("Win"))) ?? `${s} action`;
      out.fileLinks.push(target);
    }
    if (s === "URI") {
      const uri = textOf(ctx, dict.get(N("URI")));
      if (uri && /^file:/i.test(uri.trim())) out.fileLinks.push(uri.trim());
    }
    if (dict.get(N("EF")) !== undefined) {
      out.embeddedFiles.push(textOf(ctx, dict.get(N("UF"))) ?? textOf(ctx, dict.get(N("F"))) ?? "(unnamed attachment)");
    }

    for (const [, v] of dict.entries()) {
      if (!(v instanceof PDFRef)) visit(v, depth + 1);
    }
  };

  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj, 0);
  out.embeddedFiles = [...new Set(out.embeddedFiles)];
  out.fileLinks = [...new Set(out.fileLinks)];
  return out;
}

function fileSpecName(ctx: PDFContext, obj: PDFObject | undefined): string | undefined {
  const direct = textOf(ctx, obj);
  if (direct) return direct;
  const spec = asDict(ctx, obj);
  if (!spec) return undefined;
  return textOf(ctx, spec.get(N("UF"))) ?? textOf(ctx, spec.get(N("F")));
}

function clean(s: string | undefined): string | undefined {
  const t = s?.replace(/\u0000/g, "").trim();
  return t ? t : undefined;
}

/** Extract structural facts (fonts, sizes, security, metadata) with pdf-lib. Runs in the browser or Node. */
export async function extractStructure(input: ArrayBuffer | Uint8Array): Promise<StructureFacts> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const ctx = doc.context;

  // Version: header, overridden by a newer catalog /Version.
  let version = readHeaderVersion(bytes) ?? "1.4";
  const catalogVersion = nameOf(doc.catalog.get(N("Version")));
  if (catalogVersion && /^\d+\.\d+$/.test(catalogVersion) && compareVersions(catalogVersion, version) > 0) version = catalogVersion;

  // Encryption.
  const encryptDict = asDict(ctx, ctx.trailerInfo.Encrypt as PDFObject | undefined);
  const encrypted = doc.isEncrypted || !!encryptDict;
  let permissions = null;
  if (encryptDict) {
    const p = deref(ctx, encryptDict.get(N("P")));
    if (p instanceof PDFNumber) permissions = decodePermissions(p.asNumber());
  }

  // Pages + fonts.
  const fontMap = new Map<string, FontFact>();
  const pages: PageFact[] = doc.getPages().map((page, i) => {
    const number = i + 1;
    const box = page.getCropBox();
    const rotate = ((page.getRotation().angle % 360) + 360) % 360;
    const swap = rotate === 90 || rotate === 270;
    const onFont = (f: RawFont) => {
      const key = `${f.name}|${f.subtype}|${f.embedded}`;
      const existing = fontMap.get(key);
      if (existing) {
        if (!existing.pages.includes(number)) existing.pages.push(number);
      } else {
        fontMap.set(key, { ...f, displayName: stripSubsetPrefix(f.name), pages: [number], firstPage: number });
      }
    };
    const visited = new Set<PDFObject>();
    collectFonts(ctx, page.node.Resources(), onFont, visited);
    collectAnnotationFonts(ctx, page.node.Annots(), onFont, visited);
    return {
      number,
      width: round2(swap ? box.height : box.width),
      height: round2(swap ? box.width : box.height),
      rotate,
    };
  });

  const fonts = [...fontMap.values()].sort((a, b) => a.firstPage - b.firstPage || a.displayName.localeCompare(b.displayName));
  const risks = scanRisks(ctx);

  const metadata: PdfMetadata = encrypted
    ? {} // strings are encrypted; pdf-lib cannot decrypt them
    : {
        title: clean(safe(() => doc.getTitle())),
        author: clean(safe(() => doc.getAuthor())),
        subject: clean(safe(() => doc.getSubject())),
        keywords: clean(safe(() => doc.getKeywords())),
        creator: clean(safe(() => doc.getCreator())),
        producer: clean(safe(() => doc.getProducer())),
      };

  return {
    fileSize: bytes.byteLength,
    version,
    pageCount: pages.length,
    pages,
    fonts,
    encrypted,
    permissions,
    fontsReliable: !(encrypted && fonts.length === 0),
    javascript: risks.javascript,
    embeddedFiles: risks.embeddedFiles,
    fileLinks: risks.fileLinks,
    metadata,
  };
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
