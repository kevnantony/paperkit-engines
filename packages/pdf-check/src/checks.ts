import type { PdfFacts, PageFact } from "./types";
import { PT_PER_INCH, classifyPageSize, compareVersions, describePageSize, formatPageList, type PaperName } from "./util";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckRow {
  id: CheckId;
  title: string;
  status: CheckStatus;
  /** One-line result, e.g. "2 of 5 fonts are not embedded". */
  summary: string;
  /** Item-level evidence (font names, pages …). */
  details?: string[];
  /** Why it matters (shown for warn/fail). */
  why?: string;
  /** How to fix it (shown for warn/fail). */
  fix?: string;
  link?: { href: string; label: string };
}

export type CheckId = "fonts" | "type3" | "version" | "page-size" | "page-count" | "encryption" | "active-content" | "metadata" | "margins";

export type VenueId = "generic" | "ieee" | "acm" | "lncs" | "arxiv";

export interface Venue {
  id: VenueId;
  label: string;
  /** Required paper size, or null for "any, but consistent". */
  size: PaperName | null;
  /** Minimum distance from any page edge to text, in inches. */
  marginIn: number;
  note: string;
}

export const VENUES: Venue[] = [
  { id: "generic", label: "Generic", size: null, marginIn: 0.5, note: "Any consistent page size, 0.5 in minimum margin." },
  { id: "ieee", label: "IEEE conference", size: "Letter", marginIn: 0.6, note: "US Letter. IEEEtran uses 0.625 in side and 0.75 in top margins." },
  { id: "acm", label: "ACM (acmart)", size: "Letter", marginIn: 0.5, note: "US Letter for sigconf / acmsmall submissions." },
  { id: "lncs", label: "Springer LNCS", size: "A4", marginIn: 1, note: "A4 with the LNCS 12.2 × 19.3 cm text block, so wide margins." },
  { id: "arxiv", label: "arXiv", size: null, marginIn: 0.25, note: "No fixed size; only text running off the page matters." },
];

export function getVenue(id: VenueId): Venue {
  return VENUES.find((v) => v.id === id) ?? VENUES[0];
}

export interface CheckOptions {
  /** Required size, or null to only require consistency. */
  expectedSize: PaperName | null;
  marginIn: number;
  /** Maximum number of pages, or null for no limit. */
  pageLimit: number | null;
}

export function optionsForVenue(id: VenueId, pageLimit: number | null = null): CheckOptions {
  const v = getVenue(id);
  return { expectedSize: v.size, marginIn: v.marginIn, pageLimit };
}

/* ------------------------------------------------------------------ checks */

export function checkFonts(facts: PdfFacts): CheckRow {
  const base = { id: "fonts" as const, title: "All fonts embedded" };
  if (!facts.fontsReliable) {
    return {
      ...base,
      status: "warn",
      summary: "Fonts could not be inspected because the file is encrypted.",
      why: "Encrypted PDFs hide their font objects, so this check cannot confirm embedding.",
      fix: "Export an unencrypted PDF and check again.",
    };
  }
  if (facts.fonts.length === 0) return { ...base, status: "pass", summary: "No fonts used (image-only or vector-only PDF)." };
  const missing = facts.fonts.filter((f) => !f.embedded);
  if (missing.length === 0) return { ...base, status: "pass", summary: `All ${facts.fonts.length} fonts are embedded.` };
  return {
    ...base,
    status: "fail",
    summary: `${missing.length} of ${facts.fonts.length} fonts ${missing.length === 1 ? "is" : "are"} not embedded.`,
    details: missing.map((f) => `${f.displayName} (${f.subtype}) — first used on page ${f.firstPage}`),
    why: "Submission systems such as IEEE PDF eXpress, ACM TAPS and Springer reject PDFs that rely on fonts installed on the reader's computer; on other machines the text can render with a substitute font.",
    fix: "Run the file through the Font Embedder, or re-export with fonts embedded: pdflatex embeds by default (check that no included figure PDF lacks fonts), in Word use “Save as PDF → Options → ISO 19005-1 (PDF/A)”.",
    link: { href: "/font-embedder", label: "Open Font Embedder" },
  };
}

export function checkType3(facts: PdfFacts): CheckRow {
  const base = { id: "type3" as const, title: "No Type 3 fonts" };
  const t3 = facts.fonts.filter((f) => f.type3);
  if (t3.length === 0) return { ...base, status: "pass", summary: "No Type 3 (bitmap or procedure) fonts found." };
  return {
    ...base,
    status: "warn",
    summary: `${t3.length} Type 3 font${t3.length === 1 ? "" : "s"} found.`,
    details: t3.map((f) => `${f.displayName} — first used on page ${f.firstPage}`),
    why: "Type 3 fonts often come from matplotlib figures or old bitmap fonts. They look blurry when zoomed, are not searchable, and IEEE PDF eXpress and ACM flag them.",
    fix: "In matplotlib set plt.rcParams['pdf.fonttype'] = 42 and ['ps.fonttype'] = 42 before saving figures (or use a vector backend with TrueType). In LaTeX, add \\usepackage[T1]{fontenc} and \\usepackage{lmodern} so Computer Modern bitmap fonts are replaced by Type 1 fonts.",
  };
}

export function checkVersion(facts: PdfFacts): CheckRow {
  const base = { id: "version" as const, title: "PDF version" };
  if (compareVersions(facts.version, "1.7") > 0) {
    return {
      ...base,
      status: "warn",
      summary: `PDF ${facts.version} — newer than 1.7.`,
      why: "Some submission systems (older PDF eXpress profiles, some journal portals) only accept PDF 1.4–1.7.",
      fix: "Re-save with a lower compatibility level, e.g. the Font Embedder outputs PDF 1.4, or Ghostscript with -dCompatibilityLevel=1.7.",
    };
  }
  return { ...base, status: "pass", summary: `PDF ${facts.version}.` };
}

export function groupPageSizes(pages: PageFact[]): { label: string; pages: number[] }[] {
  const groups = new Map<string, number[]>();
  for (const p of pages) {
    const label = describePageSize(p.width, p.height);
    groups.set(label, [...(groups.get(label) ?? []), p.number]);
  }
  return [...groups.entries()].map(([label, pages]) => ({ label, pages })).sort((a, b) => b.pages.length - a.pages.length);
}

export function checkPageSize(facts: PdfFacts, opts: Pick<CheckOptions, "expectedSize">): CheckRow {
  const base = { id: "page-size" as const, title: "Page size" };
  if (facts.pages.length === 0) return { ...base, status: "skip", summary: "No pages." };
  const groups = groupPageSizes(facts.pages);
  const details = groups.map((g) => `${g.label}: page${g.pages.length === 1 ? "" : "s"} ${formatPageList(g.pages)}`);
  if (groups.length > 1) {
    return {
      ...base,
      status: "fail",
      summary: `Mixed page sizes (${groups.length} different sizes).`,
      details,
      why: "Mixed sizes usually mean an appendix or inserted PDF page was produced with a different paper setting. Venues check every page.",
      fix: "Set one paper size everywhere: in LaTeX use \\usepackage[letterpaper]{geometry} (or a4paper) and check included PDF pages; in Word set Layout → Size for every section.",
    };
  }
  const only = facts.pages[0];
  const name = classifyPageSize(only.width, only.height);
  if (opts.expectedSize && name !== opts.expectedSize) {
    return {
      ...base,
      status: "fail",
      summary: `${groups[0].label}, but this venue expects ${opts.expectedSize}.`,
      details,
      why: `The selected venue requires ${opts.expectedSize} paper. A different size changes margins and line breaks after printing or stamping.`,
      fix:
        opts.expectedSize === "Letter"
          ? "In LaTeX pass letterpaper to the document class (and to geometry), and run pdflatex rather than dvips with an A4 default."
          : "In LaTeX pass a4paper to the document class (and to geometry). In Word set Layout → Size → A4.",
    };
  }
  return { ...base, status: "pass", summary: `${groups[0].label} on all ${facts.pageCount} page${facts.pageCount === 1 ? "" : "s"}.` };
}

export function checkPageCount(facts: PdfFacts, opts: Pick<CheckOptions, "pageLimit">): CheckRow {
  const base = { id: "page-count" as const, title: "Page count" };
  const n = facts.pageCount;
  const pages = `${n} page${n === 1 ? "" : "s"}`;
  if (opts.pageLimit == null) return { ...base, status: "pass", summary: `${pages} (no limit set).` };
  if (n > opts.pageLimit) {
    return {
      ...base,
      status: "fail",
      summary: `${pages} — ${n - opts.pageLimit} over the ${opts.pageLimit}-page limit.`,
      why: "Papers over the page limit are commonly desk-rejected. Check whether references or appendices count toward the limit at your venue.",
      fix: "Tighten figures and tables, move material to supplementary files, or check whether references may go on extra pages.",
    };
  }
  return { ...base, status: "pass", summary: `${pages} (limit ${opts.pageLimit}).` };
}

const permissionLabels: Record<string, string> = {
  print: "printing",
  modify: "editing",
  copy: "copying text",
  annotate: "commenting",
  fillForms: "filling forms",
  assemble: "page assembly",
  printHighQuality: "high-quality printing",
};

export function checkEncryption(facts: PdfFacts): CheckRow {
  const base = { id: "encryption" as const, title: "Not encrypted" };
  if (!facts.encrypted) return { ...base, status: "pass", summary: "No password or usage restrictions." };
  const denied = facts.permissions
    ? Object.entries(facts.permissions)
        .filter(([, allowed]) => !allowed)
        .map(([k]) => permissionLabels[k] ?? k)
    : [];
  return {
    ...base,
    status: "fail",
    summary: denied.length ? `Encrypted; restricts ${denied.join(", ")}.` : "Encrypted.",
    why: "Submission systems need to stamp page numbers, copyright notices or headers onto your PDF; security restrictions block that and are usually rejected.",
    fix: "Export again without a password or “restrict editing” option (Word: Options → uncheck Encrypt; Acrobat: File → Properties → Security → No Security).",
  };
}

export function checkActiveContent(facts: PdfFacts): CheckRow {
  const base = { id: "active-content" as const, title: "No scripts, attachments or local file links" };
  const details: string[] = [];
  if (facts.javascript) details.push("Contains JavaScript actions");
  for (const f of facts.embeddedFiles) details.push(`Embedded file: ${f}`);
  for (const l of facts.fileLinks) details.push(`Link to a local file: ${l}`);
  if (details.length === 0) return { ...base, status: "pass", summary: "No JavaScript, embedded files or links to local files." };
  return {
    ...base,
    status: "warn",
    summary: `${details.length} item${details.length === 1 ? "" : "s"} found.`,
    details,
    why: "Many venues reject PDFs with JavaScript or attachments, and links to file:/// paths are broken for everyone else (and can reveal your username or folder names).",
    fix: "Remove attachments and form scripts, and point links at web URLs. In LaTeX, check \\href{file:...} and packages such as attachfile or animate.",
  };
}

export function checkMetadata(facts: PdfFacts): CheckRow {
  const base = { id: "metadata" as const, title: "Author metadata" };
  if (facts.encrypted) return { ...base, status: "skip", summary: "Metadata is encrypted and could not be read." };
  const { author, creator } = facts.metadata;
  if (!author && !creator) return { ...base, status: "pass", summary: "No Author or Creator recorded." };
  const details = [author && `Author: ${author}`, creator && `Creator: ${creator}`].filter(Boolean) as string[];
  return {
    ...base,
    status: "warn",
    summary: author ? "Author name is stored in the PDF metadata." : "Creator application is stored in the PDF metadata.",
    details,
    why: "For double-blind review the Author field can de-anonymise you; Creator reveals your toolchain. It is invisible on the page but shown in every PDF viewer's properties.",
    fix: "Strip metadata before submitting, or in LaTeX set \\hypersetup{pdfauthor={}, pdfcreator={}}.",
    link: { href: "/metadata-stripper", label: "Open Metadata Stripper" },
  };
}

export interface MarginViolation {
  page: number;
  side: "left" | "right" | "top" | "bottom";
  /** Distance from the edge to the closest text, in inches (negative = text runs off the page). */
  inches: number;
  sample?: string;
}

/** Pure margin computation from text bounds. Tolerance avoids flagging text exactly on the margin. */
export function findMarginViolations(pages: PageFact[], marginIn: number, toleranceIn = 0.02): MarginViolation[] {
  const out: MarginViolation[] = [];
  for (const p of pages) {
    if (!p.text) continue;
    const dist = {
      left: p.text.left,
      top: p.text.top,
      right: p.width - p.text.right,
      bottom: p.height - p.text.bottom,
    };
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const inches = dist[side] / PT_PER_INCH;
      if (inches < marginIn - toleranceIn) out.push({ page: p.number, side, inches: Math.round(inches * 100) / 100, sample: p.samples?.[side] });
    }
  }
  return out;
}

export function checkMargins(facts: PdfFacts, opts: Pick<CheckOptions, "marginIn">): CheckRow {
  const base = { id: "margins" as const, title: "Margins" };
  if (!facts.textAnalysed) return { ...base, status: "skip", summary: "Text positions could not be read, so margins were not checked." };
  if (!facts.pages.some((p) => p.text)) return { ...base, status: "skip", summary: "No selectable text found (scanned or image-only PDF)." };
  const v = findMarginViolations(facts.pages, opts.marginIn);
  if (v.length === 0) return { ...base, status: "pass", summary: `All text is at least ${opts.marginIn} in from every edge.` };
  const pages = [...new Set(v.map((x) => x.page))];
  const details = v.slice(0, 12).map((x) => {
    const where = x.inches < 0 ? `runs ${Math.abs(x.inches)} in off the ${x.side} edge` : `${x.inches} in from the ${x.side} edge`;
    return `Page ${x.page}: text ${where}${x.sample ? ` (“${x.sample}”)` : ""}`;
  });
  if (v.length > 12) details.push(`… and ${v.length - 12} more`);
  return {
    ...base,
    status: "warn",
    summary: `Text closer than ${opts.marginIn} in to an edge on ${pages.length} page${pages.length === 1 ? "" : "s"}.`,
    details,
    why: "Text in the margin is often a wide table, figure label or overfull line, and venues stamp headers and page numbers there. This is an approximate check based on text positions.",
    fix: "Look for “Overfull \\hbox” warnings in the LaTeX log, scale wide tables with \\resizebox or adjustbox, and do not change the template's geometry. Page numbers or running heads in the margin may be fine if the template puts them there.",
  };
}

/** Run every check in display order. */
export function runChecks(facts: PdfFacts, opts: CheckOptions): CheckRow[] {
  return [
    checkFonts(facts),
    checkType3(facts),
    checkVersion(facts),
    checkPageSize(facts, opts),
    checkPageCount(facts, opts),
    checkEncryption(facts),
    checkActiveContent(facts),
    checkMetadata(facts),
    checkMargins(facts, opts),
  ];
}

export interface ReportSummary {
  pages: number;
  fonts: number;
  fontsEmbedded: number;
  fails: number;
  warnings: number;
  passes: number;
}

export function summarize(facts: PdfFacts, rows: CheckRow[]): ReportSummary {
  return {
    pages: facts.pageCount,
    fonts: facts.fonts.length,
    fontsEmbedded: facts.fonts.filter((f) => f.embedded).length,
    fails: rows.filter((r) => r.status === "fail").length,
    warnings: rows.filter((r) => r.status === "warn").length,
    passes: rows.filter((r) => r.status === "pass").length,
  };
}

/** Plain-text report for copying into an email or issue. */
export function reportToText(fileName: string, rows: CheckRow[]): string {
  const mark: Record<CheckStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };
  const lines = [`PDF submission check: ${fileName}`, ""];
  for (const r of rows) {
    lines.push(`[${mark[r.status]}] ${r.title}: ${r.summary}`);
    for (const d of r.details ?? []) lines.push(`    - ${d}`);
  }
  return lines.join("\n");
}

/** Parse the page-limit input: blank → null, otherwise a positive integer (invalid → null). */
export function parsePageLimit(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : null;
}
