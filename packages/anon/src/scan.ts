/**
 * Detectors for de-anonymizing content in PDF text and LaTeX sources. Pure functions over strings.
 */
import { blankComments, listComments } from "@paperkit/arxiv";
import { findAll, findIdentifier, lineOf, snippetAround, type TextMatch } from "./identifiers";
import { LOCAL_PATH_RE, xmpAuthors, type PdfMetadata } from "./metadata";
import type { Finding, Severity } from "./types";

export const EMAIL_RE = /(?:\{[A-Za-z0-9._%+\-, ]+\}|[A-Za-z0-9._%+-]+)@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export const REPO_URL_RE = /(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com|huggingface\.co|bitbucket\.org|github\.io|[a-z0-9-]+\.github\.io)(?:\/[^\s)}\]>,;"'\\]*)?/gi;

/** Phrases that reveal the authors' own prior work. `\s+` so they match across line breaks. */
export const SELF_CITATION_RES: RegExp[] = [
  /\bour\s+(?:own\s+)?(?:previous|prior|earlier|recent|past)\s+(?:work|works|paper|papers|study|studies|publication|publications|approach|method|results?|findings|research)\b/gi,
  /\bwe\s+(?:have\s+)?previously\b/gi,
  /\bin\s+our\s+(?:prior|previous|earlier|recent|companion)\s+(?:paper|work|study|publication)\b/gi,
  /\bas\s+we\s+(?:have\s+)?(?:showed|shown|demonstrated|proposed|reported|argued|found|described)\b/gi,
  /\b(?:extends?|extending|builds?\s+on|building\s+on)\s+our\s+(?:\w+\s+){0,2}(?:work|paper|method|framework|system)\b/gi,
  /\bwe\s+(?:extend|build\s+on|build\s+upon)\s+our\b/gi,
  /\b(?:in|from)\s+our\s+(?:previous|prior|earlier)\b/gi,
];

const FUNDING_RE =
  /\b(?:[Tt]his\s+(?:work|research|project|material|study)\s+(?:was|is|has\s+been)\s+(?:\w+\s+)?(?:supported|funded|sponsored)\b|(?:supported|funded|sponsored)\s+(?:in\s+part\s+|partially\s+|partly\s+|generously\s+)?by\s+(?:the\s+|a\s+|an\s+)?(?:[Gg]rants?|[Aa]wards?|[Ff]ellowships?|[Nn]ational|[Ee]uropean|[A-Z]{2,})|[Gg]rant\s+(?:[Nn]o\.?|[Nn]umber|[Aa]greement|ID)\s*:?\s*[A-Z0-9][\w/.-]+)/g;

const ACK_HEADING_RE = /(?:^|\n|\.\s)\s*(?:\d+(?:\.\d+)*\.?\s*)?(Acknowledge?ments?|ACKNOWLEDGE?MENTS?|Funding|FUNDING)\b[.:]?/g;
const WITHHELD_RE = /anonym|withheld|removed\s+for|redacted|omitted|blind\s+review|will\s+be\s+(?:added|included|provided)|camera[- ]ready/i;
const REFERENCES_RE = /(?:^|\n)\s*(?:\d+\.?\s*)?(References|REFERENCES|Bibliography|BIBLIOGRAPHY)\s*(?:\n|$)/;

/** Institution keywords that should not appear near the title of an anonymous submission. */
export const INSTITUTION_RE =
  /\b(?:Universit(?:y|é|ä|à|at|ät|e|ade|ad|à)|Institute|Institut|College|Laborator(?:y|ies)|Labs?|School\s+of|Department|Dept\.|Facult(?:y|é|ad)|Inc\.|Ltd\.?|GmbH|Corporation|Research\s+Cent(?:er|re)|Google|Microsoft|Meta\s+AI|DeepMind|OpenAI|Amazon|NVIDIA|IBM\s+Research|Apple|Adobe|Baidu|Alibaba|Tencent|ByteDance|Huawei|Samsung|EPFL|ETH|MIT|CMU|Stanford|Berkeley|Oxford|Cambridge|Tsinghua|Peking)\b/g;

export const hasLocalPath = (s: string) => new RegExp(LOCAL_PATH_RE.source).test(s);

/** All self-citation phrases, with overlapping/adjacent hits merged into one range. */
export function selfCitationMatches(text: string): TextMatch[] {
  const all = SELF_CITATION_RES.flatMap((re) => findAll(text, re)).sort((a, b) => a.index - b.index);
  const out: TextMatch[] = [];
  for (const m of all) {
    const prev = out[out.length - 1];
    if (prev && m.index <= prev.index + prev.length + 12) {
      const end = Math.max(prev.index + prev.length, m.index + m.length);
      prev.length = end - prev.index;
      prev.text = text.slice(prev.index, end);
    } else out.push({ ...m });
  }
  return out;
}

const add = (list: Finding[], f: Finding) => {
  const key = `${f.rule}|${JSON.stringify(f.location)}|${f.snippet}`;
  if (!list.some((g) => `${g.rule}|${JSON.stringify(g.location)}|${g.snippet}` === key)) list.push(f);
};

/** Region of a PDF page that is part of the references list (from the heading to the end). */
function referencesStart(text: string): number {
  const m = REFERENCES_RE.exec(text);
  return m ? m.index : Infinity;
}

/**
 * Scan extracted PDF text, one string per page. `inReferences` is carried from page to page:
 * once the References heading is seen, matches of your own name are downgraded (citing yourself in
 * the third person is allowed).
 */
export function scanPdfPages(pages: string[], identifiers: string[]): Finding[] {
  const out: Finding[] = [];
  let inRefs = false;
  pages.forEach((raw, i) => {
    const page = i + 1;
    const text = raw.replace(/[ \t\f\r]+/g, " ");
    const refStart = inRefs ? 0 : referencesStart(text);
    const loc = { kind: "pdf" as const, page };
    const snip = (index: number, length: number) => snippetAround(text, index, length);

    for (const id of identifiers) {
      for (const m of findIdentifier(text, id)) {
        const refs = m.index >= refStart;
        add(out, {
          severity: refs ? "low" : "high",
          rule: "identifier",
          title: refs ? `“${id}” appears in the references` : `Your identifier “${id}” appears in the text`,
          location: loc,
          snippet: snip(m.index, m.length),
          hint: refs ? "Fine if you cite yourself in the third person; check it isn't marked as your own work." : undefined,
        });
      }
    }
    for (const m of findAll(text, EMAIL_RE)) {
      add(out, { severity: "high", rule: "email", title: "Email address", location: loc, snippet: snip(m.index, m.length) });
    }
    for (const m of findAll(text, REPO_URL_RE)) {
      if (!/\//.test(m.text.replace(/^https?:\/\//i, "")) && !/github\.io/i.test(m.text)) continue; // bare domain mention
      const refs = m.index >= refStart;
      add(out, {
        severity: refs ? "medium" : "high",
        rule: "repo-link",
        title: "Non-anonymous code or model link",
        location: loc,
        snippet: snip(m.index, m.length),
        hint: "Use an anonymized mirror such as anonymous.4open.science for review.",
      });
    }
    {
      for (const m of selfCitationMatches(text)) {
        add(out, { severity: "medium", rule: "self-citation", title: "Self-citation phrasing", location: loc, snippet: snip(m.index, m.length), hint: "Refer to your earlier work in the third person: “Smith et al. [3] showed…”." });
      }
    }
    for (const m of findAll(text, ACK_HEADING_RE)) {
      const after = text.slice(m.index + m.length, m.index + m.length + 220);
      if (WITHHELD_RE.test(after) || after.trim().length < 15) continue;
      add(out, {
        severity: "high",
        rule: "acknowledgments",
        title: "Acknowledgments section",
        location: loc,
        snippet: snippetAround(text, m.index, Math.min(m.length + 160, text.length - m.index), 0),
        hint: "Remove acknowledgments for review, or replace them with “Acknowledgments withheld for review.”",
      });
    }
    for (const m of findAll(text, FUNDING_RE)) {
      add(out, { severity: "high", rule: "funding", title: "Funding statement", location: loc, snippet: snip(m.index, m.length) });
    }
    if (page === 1) {
      const abs = text.search(/\bAbstract\b|\bABSTRACT\b/);
      const head = text.slice(0, abs > 0 && abs < 2000 ? abs : 700);
      for (const m of findAll(head, INSTITUTION_RE)) {
        add(out, {
          severity: "medium",
          rule: "institution",
          title: `Institution keyword “${m.text}” near the title`,
          location: loc,
          snippet: snippetAround(head, m.index, m.length, 50),
          hint: "Author block should read “Anonymous Authors”.",
        });
      }
    }
    if (refStart !== Infinity) inRefs = true;
  });
  return out;
}

/** Read a balanced {…} group starting at `i`. */
function group(s: string, i: number): { value: string; end: number } | null {
  while (/\s/.test(s[i] ?? "")) i++;
  if (s[i] === "[") {
    const j = s.indexOf("]", i);
    if (j < 0) return null;
    i = j + 1;
    while (/\s/.test(s[i] ?? "")) i++;
  }
  if (s[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return { value: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

const SOURCE_TEXT_EXTS = ["tex", "ltx", "sty", "cls", "bib", "bbl", "txt", "md", "cfg", "def", "tikz", "pgf"];
export const isScannableSource = (path: string) => SOURCE_TEXT_EXTS.includes(path.split(".").pop()!.toLowerCase());

/** Scan one LaTeX/text source file. Comments are scanned separately (low severity). */
export function scanSourceFile(path: string, text: string, identifiers: string[]): Finding[] {
  const out: Finding[] = [];
  const isTex = /\.(tex|ltx|sty|cls|tikz|pgf)$/i.test(path);
  const isBib = /\.(bib|bbl)$/i.test(path);
  const code = isTex ? blankComments(text) : text;
  const at = (index: number) => ({ kind: "source" as const, file: path, line: lineOf(code, index) });
  const snip = (index: number, length: number) => snippetAround(code, index, length, 50);
  const sev = (s: Severity, bib: Severity): Severity => (isBib ? bib : s);

  for (const id of identifiers) {
    for (const m of findIdentifier(code, id)) {
      add(out, {
        severity: sev("high", "low"),
        rule: "identifier",
        title: isBib ? `“${id}” appears in the bibliography` : `Your identifier “${id}” appears in the source`,
        location: at(m.index),
        snippet: snip(m.index, m.length),
        hint: isBib ? "Fine if you cite yourself in the third person." : undefined,
      });
    }
  }
  for (const m of findAll(code, EMAIL_RE)) add(out, { severity: sev("high", "low"), rule: "email", title: "Email address", location: at(m.index), snippet: snip(m.index, m.length) });
  for (const m of findAll(code, REPO_URL_RE)) {
    if (!/\//.test(m.text.replace(/^https?:\/\//i, "")) && !/github\.io/i.test(m.text)) continue;
    add(out, { severity: sev("high", "medium"), rule: "repo-link", title: "Non-anonymous code or model link", location: at(m.index), snippet: snip(m.index, m.length), hint: "Use an anonymized mirror such as anonymous.4open.science for review." });
  }

  if (isTex) {
    for (const m of code.matchAll(/\\(author|icmlauthor|IEEEauthorblockN|affiliation|institute|icmlaffiliation|address)\b\*?/g)) {
      const g = group(code, m.index! + m[0].length);
      if (!g) continue;
      const value = g.value.replace(/\s+/g, " ").trim();
      if (!value || /anonym|blind|withheld|for review|submission/i.test(value)) continue;
      add(out, {
        severity: "high",
        rule: "author-command",
        title: `\\${m[1]}{…} is not anonymized`,
        location: at(m.index!),
        snippet: `\\${m[1]}{${value.length > 110 ? value.slice(0, 110) + "…" : value}}`,
        hint: "Even if the style hides it in review mode, anyone opening the source sees it. Use “Anonymous Authors”.",
      });
    }
    for (const m of code.matchAll(/\\thanks\b/g)) {
      const g = group(code, m.index! + m[0].length);
      const value = g?.value.replace(/\s+/g, " ").trim() ?? "";
      if (/anonym/i.test(value)) continue;
      add(out, { severity: "medium", rule: "thanks", title: "\\thanks{…} footnote", location: at(m.index!), snippet: `\\thanks{${value.slice(0, 110)}${value.length > 110 ? "…" : ""}}` });
    }
    for (const m of code.matchAll(/\\(?:section|subsection|paragraph|chapter)\*?\s*\{\s*(Acknowledge?ments?|Funding)[^}]*\}|\\begin\s*\{(ack|acks|acknowledgments?|acknowledgements?)\}|\\(acknowledgments|acknowledgements|acks)\b/gi)) {
      const after = code.slice(m.index! + m[0].length, m.index! + m[0].length + 240);
      if (WITHHELD_RE.test(after) || !after.replace(/\\end\s*\{[^}]*\}/, "").trim()) continue;
      add(out, {
        severity: "high",
        rule: "acknowledgments",
        title: "Acknowledgments section",
        location: at(m.index!),
        snippet: snippetAround(code, m.index!, m[0].length + 140, 0),
        hint: "Some styles hide this in review mode, but it is still in the source. Remove it or wrap it in a camera-ready switch.",
      });
    }
    for (const m of code.matchAll(/\\(?:usepackage|documentclass)\s*\[([^\]]*)\]\s*\{([^}]*)\}/g)) {
      const opt = m[1].split(",").map((s) => s.trim()).find((o) => /^(final|accepted|camera-?ready|cameraready|preprint|nonanonymous|non-anonymous)$/i.test(o));
      if (opt)
        add(out, {
          severity: "low",
          rule: "final-option",
          title: `“${opt}” option on ${m[2]}`,
          location: at(m.index!),
          snippet: m[0],
          hint: "Camera-ready/preprint options usually print author names. Use the review/anonymous mode for submission.",
        });
    }
  }
  if (!isBib) {
    for (const m of selfCitationMatches(code))
      add(out, { severity: "medium", rule: "self-citation", title: "Self-citation phrasing", location: at(m.index), snippet: snip(m.index, m.length), hint: "Refer to your earlier work in the third person." });
    for (const m of findAll(code, FUNDING_RE)) add(out, { severity: "high", rule: "funding", title: "Funding statement", location: at(m.index), snippet: snip(m.index, m.length) });
  }

  if (isTex) {
    for (const c of listComments(text)) {
      const hits = identifiers.filter((id) => findIdentifier(c.text, id).length);
      const emails = findAll(c.text, EMAIL_RE).map((m) => m.text);
      const todo = /\b(?:TODO|FIXME|NOTE|XXX)\s*\(([A-Za-z][\w.-]{1,30})\)/.exec(c.text);
      const who = [...hits, ...emails, ...(todo ? [todo[1]] : [])];
      if (!who.length) continue;
      add(out, {
        severity: "low",
        rule: "comment-name",
        title: `Comment mentions ${who.map((w) => `“${w}”`).join(", ")}`,
        location: { kind: "source", file: path, line: c.line },
        snippet: c.text.trim().slice(0, 160),
        hint: "Comments ship with the source. The arXiv Cleaner strips them.",
      });
    }
  }
  return out;
}

/** Findings from PDF document metadata (Info dict, XMP, embedded figure info). */
export function scanPdfMetadata(meta: PdfMetadata, identifiers: string[]): Finding[] {
  const out: Finding[] = [];
  const fields: [string, string | null][] = [
    ["Title", meta.title],
    ["Author", meta.author],
    ["Subject", meta.subject],
    ["Keywords", meta.keywords],
    ["Creator", meta.creator],
    ["Producer", meta.producer],
  ];
  const hint = "Use “Strip PDF metadata” (or the Metadata Stripper tool) before submitting.";
  for (const [field, value] of fields) {
    if (!value || !value.trim()) continue;
    const loc = { kind: "metadata" as const, field };
    if (field === "Author" && !/^\s*(anonymous|anon\.?|author|authors|unknown)\s*$/i.test(value)) {
      add(out, { severity: "high", rule: "pdf-metadata", title: "PDF metadata names an author", location: loc, snippet: value, hint });
      continue;
    }
    const path = value.match(LOCAL_PATH_RE);
    if (path) {
      add(out, { severity: "high", rule: "pdf-metadata", title: `PDF ${field} contains a local path`, location: loc, snippet: value, hint });
      continue;
    }
    const ids = identifiers.filter((id) => findIdentifier(value, id).length);
    if (ids.length) add(out, { severity: "high", rule: "pdf-metadata", title: `PDF ${field} contains “${ids[0]}”`, location: loc, snippet: value, hint });
  }
  if (meta.xmp) {
    for (const a of xmpAuthors(meta.xmp)) {
      if (/^\s*anonym/i.test(a)) continue;
      add(out, { severity: "high", rule: "pdf-metadata", title: "XMP metadata names an author", location: { kind: "metadata", field: "XMP dc:creator" }, snippet: a, hint });
    }
    for (const p of new Set(meta.xmp.match(LOCAL_PATH_RE) ?? []))
      add(out, { severity: "high", rule: "pdf-metadata", title: "XMP metadata contains a local path", location: { kind: "metadata", field: "XMP" }, snippet: p, hint });
  }
  for (const f of meta.embeddedFileNames) {
    if (hasLocalPath(f) || identifiers.some((id) => findIdentifier(f, id).length))
      add(out, { severity: "high", rule: "embedded-path", title: "Embedded figure records a local path", location: { kind: "metadata", field: "PTEX.FileName" }, snippet: f, hint });
  }
  for (const { field, value } of meta.embeddedInfo) {
    const path = hasLocalPath(value);
    if (field === "Author" || path)
      add(out, { severity: "low", rule: "image-metadata", title: `Embedded figure metadata: ${field}`, location: { kind: "metadata", field: `Figure ${field}` }, snippet: value, hint });
  }
  return out;
}
