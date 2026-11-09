/**
 * Orchestrates an anonymity audit. PDF text extraction is injected (pdfjs in the browser, plain strings
 * in tests), everything else is runtime-agnostic.
 */
import JSZip from "jszip";
import { readImageMeta } from "./image-meta";
import { readPdfMetadata, type PdfMetadata } from "./metadata";
import { isScannableSource, scanPdfMetadata, scanPdfPages, scanSourceFile, hasLocalPath } from "./scan";
import { severityOrder, type Finding, type Severity } from "./types";

export interface AuditInput {
  pdf?: { name: string; bytes: Uint8Array; pages: string[] };
  zip?: { name: string; bytes: Uint8Array };
  identifiers: string[];
}

export interface AuditStats {
  pagesScanned: number;
  filesScanned: number;
  high: number;
  medium: number;
  low: number;
}

export interface AuditReport {
  findings: Finding[];
  stats: AuditStats;
  metadata: PdfMetadata | null;
  pdfName: string | null;
  zipName: string | null;
  identifiers: string[];
}

const IMAGE_EXTS = ["jpg", "jpeg", "png", "tif", "tiff"];

export async function scanSourceZip(bytes: Uint8Array, identifiers: string[]): Promise<{ findings: Finding[]; filesScanned: number }> {
  const zip = await JSZip.loadAsync(bytes);
  const findings: Finding[] = [];
  let filesScanned = 0;
  const entries = Object.values(zip.files)
    .filter((e) => !e.dir && !e.name.startsWith("__MACOSX/") && !e.name.split("/").pop()!.startsWith("._"))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const ext = entry.name.split(".").pop()!.toLowerCase();
    if (isScannableSource(entry.name)) {
      filesScanned++;
      const text = new TextDecoder("utf-8").decode(await entry.async("uint8array"));
      findings.push(...scanSourceFile(entry.name, text, identifiers));
    } else if (IMAGE_EXTS.includes(ext)) {
      filesScanned++;
      for (const f of readImageMeta(await entry.async("uint8array"))) {
        findings.push({
          severity: "low",
          rule: "image-metadata",
          title: `Image metadata: ${f.name}`,
          location: { kind: "file", file: entry.name, field: f.name },
          snippet: f.value,
          hint: "Re-export the figure or strip its EXIF/XMP data (e.g. exiftool -all= file).",
        });
      }
    } else if (ext === "pdf") {
      filesScanned++;
      try {
        const meta = await readPdfMetadata(await entry.async("uint8array"));
        const author = meta.author?.trim();
        if (author)
          findings.push({ severity: "low", rule: "image-metadata", title: "Figure PDF metadata: Author", location: { kind: "file", file: entry.name, field: "Author" }, snippet: author, hint: "Figure PDFs keep their own metadata; pdfTeX can copy it into your paper." });
        for (const v of [meta.creator, meta.producer, meta.title])
          if (v && hasLocalPath(v))
            findings.push({ severity: "low", rule: "image-metadata", title: "Figure PDF metadata contains a local path", location: { kind: "file", file: entry.name }, snippet: v });
      } catch {
        /* not a readable PDF: skip */
      }
    }
  }
  return { findings, filesScanned };
}

export function sortFindings(findings: Finding[]): Finding[] {
  const order = (s: Severity) => severityOrder.indexOf(s);
  const locKey = (f: Finding) => {
    const l = f.location;
    if (l.kind === "metadata") return `0|${l.field}`;
    if (l.kind === "pdf") return `1|${String(l.page).padStart(5, "0")}`;
    if (l.kind === "source") return `2|${l.file}|${String(l.line).padStart(6, "0")}`;
    return `3|${l.file}`;
  };
  return [...findings].sort((a, b) => order(a.severity) - order(b.severity) || locKey(a).localeCompare(locKey(b)));
}

export async function runAudit(input: AuditInput): Promise<AuditReport> {
  const findings: Finding[] = [];
  let metadata: PdfMetadata | null = null;
  if (input.pdf) {
    metadata = await readPdfMetadata(input.pdf.bytes);
    findings.push(...scanPdfMetadata(metadata, input.identifiers));
    findings.push(...scanPdfPages(input.pdf.pages, input.identifiers));
  }
  let filesScanned = 0;
  if (input.zip) {
    const r = await scanSourceZip(input.zip.bytes, input.identifiers);
    findings.push(...r.findings);
    filesScanned = r.filesScanned;
  }
  const sorted = sortFindings(findings);
  const count = (s: Severity) => sorted.filter((f) => f.severity === s).length;
  return {
    findings: sorted,
    stats: { pagesScanned: input.pdf?.pages.length ?? 0, filesScanned, high: count("high"), medium: count("medium"), low: count("low") },
    metadata,
    pdfName: input.pdf?.name ?? null,
    zipName: input.zip?.name ?? null,
    identifiers: input.identifiers,
  };
}

export function formatLocation(l: Finding["location"]): string {
  switch (l.kind) {
    case "pdf":
      return `p. ${l.page}`;
    case "source":
      return `${l.file}:${l.line}`;
    case "metadata":
      return `metadata · ${l.field}`;
    case "file":
      return l.field ? `${l.file} · ${l.field}` : l.file;
  }
}

const label: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };

/** Markdown report for sharing with co-authors. */
export function reportToMarkdown(r: AuditReport, now = new Date()): string {
  const lines: string[] = [];
  lines.push("# Anonymity audit", "");
  lines.push(`Generated by PaperKit on ${now.toISOString().slice(0, 10)}. Everything ran locally in the browser.`, "");
  if (r.pdfName) lines.push(`- PDF: \`${r.pdfName}\` (${r.stats.pagesScanned} pages scanned)`);
  if (r.zipName) lines.push(`- Source: \`${r.zipName}\` (${r.stats.filesScanned} files scanned)`);
  lines.push(`- Identifiers checked: ${r.identifiers.length}`);
  lines.push(`- Findings: **${r.stats.high} high**, ${r.stats.medium} medium, ${r.stats.low} low`, "");
  for (const s of severityOrder) {
    const fs = r.findings.filter((f) => f.severity === s);
    if (!fs.length) continue;
    lines.push(`## ${label[s]} (${fs.length})`, "");
    for (const f of fs) {
      lines.push(`- **${f.title}** — ${formatLocation(f.location)}`);
      lines.push(`  > ${f.snippet.replace(/\n/g, " ")}`);
      if (f.hint) lines.push(`  ${f.hint}`);
    }
    lines.push("");
  }
  if (!r.findings.length) lines.push("No issues found.", "");
  return lines.join("\n");
}
