/**
 * Plain-data description of a PDF ("facts"), extracted once and then fed to pure check functions.
 * Everything here is JSON-serialisable so it can cross a Web Worker boundary and be used in unit tests.
 */

export interface FontFact {
  /** BaseFont as written in the PDF, e.g. "ABCDEF+Helvetica" (subset prefix kept). */
  name: string;
  /** Display name without the 6-letter subset prefix. */
  displayName: string;
  /** Font Subtype: Type1, TrueType, Type0, Type3, MMType1, CIDFontType0/2 ... */
  subtype: string;
  embedded: boolean;
  type3: boolean;
  /** 1-based page numbers the font is referenced from. */
  pages: number[];
  firstPage: number;
}

/** Text bounding box in display space: origin top-left, y grows downwards, units = PDF points. */
export interface TextBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PageFact {
  /** 1-based page number. */
  number: number;
  /** Displayed width/height in points (CropBox, rotation applied). */
  width: number;
  height: number;
  rotate: number;
  /** Union of all text boxes on the page, or null if the page has no text (or text was not analysed). */
  text?: TextBounds | null;
  /** The text run closest to each edge (for explaining margin warnings). */
  samples?: Partial<Record<"left" | "top" | "right" | "bottom", string>>;
}

export interface Permissions {
  print: boolean;
  modify: boolean;
  copy: boolean;
  annotate: boolean;
  fillForms: boolean;
  assemble: boolean;
  printHighQuality: boolean;
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
}

export interface PdfFacts {
  fileSize: number;
  /** e.g. "1.5" (header, or the catalog /Version override if newer). */
  version: string;
  pageCount: number;
  pages: PageFact[];
  fonts: FontFact[];
  encrypted: boolean;
  /** Only set when encrypted. */
  permissions: Permissions | null;
  /** False when fonts could not be inspected (e.g. encrypted object streams). */
  fontsReliable: boolean;
  javascript: boolean;
  /** Names of embedded file attachments. */
  embeddedFiles: string[];
  /** file:, Launch and GoToR (remote file) link targets. */
  fileLinks: string[];
  metadata: PdfMetadata;
  /** Whether page text bounds were computed (pdf.js pass). */
  textAnalysed: boolean;
}
