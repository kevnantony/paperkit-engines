import Papa from "papaparse";

/** Pure table → LaTeX conversion. No DOM access; shared by the UI preview and unit tests. */

export type TableFormat = "tsv" | "csv" | "markdown";
export type Align = "l" | "c" | "r";
export type BestMode = "none" | "max" | "min";
export type FontSize = "normalsize" | "small" | "footnotesize" | "scriptsize";
export type AlignMode = "auto" | Align;

export interface ParsedTable {
  format: TableFormat;
  rows: string[][];
  /** Alignment hints from a Markdown separator row (`:--`, `:-:`, `--:`), if any. */
  alignHints?: (Align | null)[];
  /** Field delimiter for CSV/TSV input (`,`, `;` or tab). A `;` delimiter implies decimal commas. */
  delimiter?: string;
}

export interface LatexTableOptions {
  booktabs: boolean;
  caption: string;
  label: string;
  /** Use siunitx S columns for numeric columns (decimal alignment). */
  siunitx: boolean;
  align: AlignMode;
  best: BestMode;
  escape: boolean;
  header: boolean;
  /** `table*` spanning both columns of a two-column layout. */
  wide: boolean;
  fontSize: FontSize;
  /** Wrap the tabular in \resizebox{\linewidth}{!}{...}. */
  resize: boolean;
}

export const defaultTableOptions: LatexTableOptions = {
  booktabs: true,
  caption: "",
  label: "",
  siunitx: false,
  align: "auto",
  best: "none",
  escape: true,
  header: true,
  wide: false,
  fontSize: "normalsize",
  resize: false,
};

/* ---------------- parsing ---------------- */

const MD_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Guess the format of pasted text. Markdown wins if a separator row exists, then tabs (spreadsheet paste), else CSV. */
export function detectFormat(text: string): TableFormat {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length >= 2 && lines.some((l) => l.includes("|")) && lines.some((l) => l.includes("-") && MD_SEPARATOR.test(l))) {
    return "markdown";
  }
  if (lines.some((l) => l.includes("\t"))) return "tsv";
  return "csv";
}

/** Split a Markdown row on unescaped pipes, dropping the optional outer pipes. */
function splitMarkdownRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cur += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseMarkdown(text: string): { rows: string[][]; alignHints?: (Align | null)[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const rows: string[][] = [];
  let alignHints: (Align | null)[] | undefined;
  for (const line of lines) {
    if (!alignHints && line.includes("-") && MD_SEPARATOR.test(line)) {
      alignHints = splitMarkdownRow(line).map((c) => {
        const left = c.startsWith(":");
        const right = c.endsWith(":");
        if (left && right) return "c";
        if (right) return "r";
        if (left) return "l";
        return null;
      });
      continue;
    }
    rows.push(splitMarkdownRow(line).map(stripMarkdownInline));
  }
  return { rows, alignHints };
}

const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/**
 * Reduce a Markdown cell to its text: emphasis/code markers, links and images (`[text](url)` → text), and the inline
 * HTML GitHub READMEs put in tables (`<br>`, `<sup>`, `<b>`, `<img>`; tags are dropped, line breaks become spaces).
 */
function stripMarkdownInline(cell: string): string {
  return cell
    .replace(/!?\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/<br\s*\/?>|<\/?(?:sup|sub|p|div)\b[^>]*>/gi, " ")
    .replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, e: string) => HTML_ENTITIES[e])
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const res = Papa.parse<string[]>(text.replace(/\r\n?/g, "\n"), { delimiter, skipEmptyLines: false });
  return res.data;
}

/** Pick `,` or `;` for CSV by counting delimiters outside quotes on the first non-empty line. */
function guessCsvDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  let inQ = false;
  let commas = 0;
  let semis = 0;
  for (const ch of first) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === ",") commas++;
    else if (!inQ && ch === ";") semis++;
  }
  return semis > commas ? ";" : ",";
}

/** Trim cells, drop blank trailing/leading rows, pad ragged rows, drop fully empty trailing columns. */
export function normalizeRows(rows: string[][]): string[][] {
  let out = rows.map((r) => r.map((c) => (c ?? "").replace(/\r?\n/g, " ").trim()));
  const isBlank = (r: string[]) => r.every((c) => c === "");
  while (out.length && isBlank(out[out.length - 1])) out.pop();
  while (out.length && isBlank(out[0])) out.shift();
  const width = Math.max(0, ...out.map((r) => r.length));
  out = out.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : r));
  let keep = width;
  while (keep > 0 && out.every((r) => r[keep - 1] === "")) keep--;
  return out.map((r) => r.slice(0, keep));
}

export function parseTable(text: string, format: TableFormat | "auto" = "auto"): ParsedTable {
  const fmt = format === "auto" ? detectFormat(text) : format;
  if (fmt === "markdown") {
    const { rows, alignHints } = parseMarkdown(text);
    return { format: fmt, rows: normalizeRows(rows), alignHints };
  }
  const delimiter = fmt === "tsv" ? "\t" : guessCsvDelimiter(text);
  return { format: fmt, rows: normalizeRows(parseDelimited(text, delimiter)), delimiter };
}

/* ---------------- numbers ---------------- */

// "−" (U+2212) is what a dash copied out of a PDF usually becomes.
const MISSING = new Set(["", "-", "–", "—", "−", "n/a", "na", "nan", "--", "?", "x", "×"]);

/** Footnote markers papers put after a number (`8.43†`, `91.2*`). Ignored for the value, kept in the output. */
const MARKERS_RE = /\s*[†‡§¶*]+$/;

export function isMissing(cell: string): boolean {
  return MISSING.has(cell.trim().toLowerCase());
}

export interface ParsedNumber {
  value: number;
  /** Integer digit count (without sign / thousands separators). */
  intDigits: number;
  decDigits: number;
  negative: boolean;
  /** "± x" uncertainty, as written. */
  pm?: string;
  percent: boolean;
}

export type DecimalMark = "." | ",";

/** Period decimal mark, comma thousands separators (`1,024.5`). */
const NUM_RE = /^([+\-−]?)(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d+))?(?:[eE]([+\-]?\d+))?$/;
/** Comma decimal mark (`0,912`); no thousands separators, so `1.234` is rejected rather than guessed. */
const NUM_RE_COMMA = /^([+\-−]?)(\d*)(?:,(\d+))?(?:[eE]([+\-]?\d+))?$/;
const PM_RE = /^(.*?)\s*(?:±|\+-|\+\/-|\\pm)\s*([0-9.]+)\s*(%?)$/;
const PM_RE_COMMA = /^(.*?)\s*(?:±|\+-|\+\/-|\\pm)\s*([0-9,]+)\s*(%?)$/;

/**
 * Parse a numeric cell like `85.3`, `-0.12`, `1,024`, `92.1%`, `85.3 ± 0.4`, `85.3 +- 0.4`. Returns null for text.
 * With `decimal = ","` the comma is the decimal mark (`0,912` → 0.912).
 */
export function parseNumber(cell: string, decimal: DecimalMark = "."): ParsedNumber | null {
  let s = cell.trim().replace(MARKERS_RE, "");
  if (!s) return null;
  let pm: string | undefined;
  const pmMatch = s.match(decimal === "," ? PM_RE_COMMA : PM_RE);
  if (pmMatch) {
    s = pmMatch[1] + pmMatch[3];
    pm = pmMatch[2];
  }
  let percent = false;
  if (s.endsWith("%")) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  const m = s.match(decimal === "," ? NUM_RE_COMMA : NUM_RE);
  if (!m) return null;
  const [, sign, intPart, dec, exp] = m;
  if (!intPart && !dec) return null;
  const negative = sign === "-" || sign === "−";
  const digits = intPart.replace(/,/g, "");
  const value = Number(`${negative ? "-" : ""}${digits || "0"}${dec ? "." + dec : ""}${exp ? "e" + exp : ""}`);
  if (!Number.isFinite(value)) return null;
  return { value, intDigits: Math.max(1, digits.length), decDigits: dec ? dec.length : 0, negative, pm, percent };
}

/* ---------------- table model ---------------- */

export interface TableModel {
  header: string[] | null;
  body: string[][];
  columns: number;
  /** Column is numeric: every non-missing body cell parses as a number (and there is at least one). */
  numeric: boolean[];
  /** Column uses a comma as its decimal mark (`0,912`). */
  decimalComma: boolean[];
  aligns: Align[];
  /** best[r][c] — body cell is the best value of its column. */
  best: boolean[][];
}

const COMMA_DECIMAL_CELL = /^[+\-−]?\d+,\d+$/;
const THOUSANDS_CELL = /^[+\-−]?[1-9]\d{0,2}(?:,\d{3})+$/;

/** Strip `± x` and `%` so only the number itself is inspected for its decimal mark. */
function numberCore(cell: string): string {
  return cell
    .trim()
    .replace(MARKERS_RE, "")
    .replace(/\s*(?:±|\+-|\+\/-|\\pm)\s*[0-9.,]+\s*(%?)$/, "$1")
    .replace(/%$/, "")
    .trim();
}

/**
 * Decide the decimal mark of one column. Comma when the column has commas but no periods and either
 * the input was `;`-delimited (European spreadsheets) or every comma cell is `d,d` and at least one of
 * them cannot be a thousands group (`0,912`, `1,5`). `1,024` / `2,048` stay thousands separators.
 */
export function detectDecimalMark(cells: string[], delimiter?: string): DecimalMark {
  const cores = cells.filter((c) => !isMissing(c)).map(numberCore);
  const withComma = cores.filter((c) => c.includes(","));
  if (withComma.length === 0 || cores.some((c) => c.includes("."))) return ".";
  if (delimiter === ";") return ",";
  if (withComma.every((c) => COMMA_DECIMAL_CELL.test(c)) && withComma.some((c) => !THOUSANDS_CELL.test(c))) return ",";
  return ".";
}

export function buildModel(
  parsed: Pick<ParsedTable, "rows" | "alignHints" | "delimiter">,
  opts: Pick<LatexTableOptions, "header" | "align" | "best">,
): TableModel {
  const rows = parsed.rows;
  const header = opts.header && rows.length > 0 ? rows[0] : null;
  const body = opts.header ? rows.slice(1) : rows;
  const columns = rows[0]?.length ?? 0;

  const marks: DecimalMark[] = Array.from({ length: columns }, (_, c) =>
    detectDecimalMark(
      body.map((r) => r[c] ?? ""),
      parsed.delimiter,
    ),
  );
  const decimalComma = marks.map((m) => m === ",");

  const numeric: boolean[] = [];
  for (let c = 0; c < columns; c++) {
    let count = 0;
    let ok = true;
    for (const r of body) {
      const cell = r[c] ?? "";
      if (isMissing(cell)) continue;
      if (parseNumber(cell, marks[c])) count++;
      else {
        ok = false;
        break;
      }
    }
    numeric.push(ok && count > 0);
  }

  const aligns: Align[] = numeric.map((isNum, c) => {
    if (opts.align !== "auto") return opts.align;
    const hint = parsed.alignHints?.[c];
    if (hint) return hint;
    return isNum ? "r" : "l";
  });

  const best: boolean[][] = body.map((r) => r.map(() => false));
  if (opts.best !== "none") {
    for (let c = 0; c < columns; c++) {
      if (!numeric[c]) continue;
      let target: number | null = null;
      for (const r of body) {
        const n = parseNumber(r[c] ?? "", marks[c]);
        if (!n) continue;
        if (target === null || (opts.best === "max" ? n.value > target : n.value < target)) target = n.value;
      }
      if (target === null) continue;
      body.forEach((r, ri) => {
        const n = parseNumber(r[c] ?? "", marks[c]);
        if (n && n.value === target) best[ri][c] = true;
      });
    }
  }

  return { header, body, columns, numeric, decimalComma, aligns, best };
}

/* ---------------- LaTeX output ---------------- */

const ESCAPES: Record<string, string> = {
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
  "\\": "\\textbackslash{}",
  // Under the default OT1 font encoding `<` and `>` typeset as ¡ and ¿ in text mode.
  "<": "\\textless{}",
  ">": "\\textgreater{}",
};

const UNICODE: Record<string, string> = {
  "±": "$\\pm$",
  "×": "$\\times$",
  "≤": "$\\leq$",
  "≥": "$\\geq$",
  "−": "$-$",
  "→": "$\\rightarrow$",
  "↑": "$\\uparrow$",
  "↓": "$\\downarrow$",
  "°": "$^\\circ$",
  "µ": "$\\mu$",
  "μ": "$\\mu$",
  "≈": "$\\approx$",
  "∼": "$\\sim$",
  "≠": "$\\neq$",
  "∞": "$\\infty$",
  "←": "$\\leftarrow$",
  "✓": "$\\checkmark$",
  "✔": "$\\checkmark$",
  "✗": "$\\times$",
  "✘": "$\\times$",
};

// Greek letters: pdflatex's utf8 input has no text glyphs for them, so they become math (`δ` → `$\delta$`).
const GREEK = "αβγδεζηθικλνξπρστυφχψωΓΔΘΛΞΠΣΥΦΨΩ";
const GREEK_NAMES =
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda nu xi pi rho sigma tau upsilon phi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega".split(" ");
[...GREEK].forEach((ch, i) => (UNICODE[ch] = `$\\${GREEK_NAMES[i]}$`));

const ESCAPE_RE = new RegExp(`[&%$#_{}~^\\\\<>${Object.keys(UNICODE).join("")}]`, "gu");

/** Escape LaTeX special characters: & % $ # _ { } ~ ^ \ < > (plus common Unicode math symbols and Greek letters). */
export function escapeLatex(s: string): string {
  return s.replace(ESCAPE_RE, (ch) => ESCAPES[ch] ?? UNICODE[ch] ?? ch);
}

function siunitxFormat(body: string[][], c: number, mark: DecimalMark): string {
  let int = 1;
  let dec = 0;
  let neg = false;
  for (const r of body) {
    const n = parseNumber(r[c] ?? "", mark);
    if (!n) continue;
    int = Math.max(int, n.intDigits);
    dec = Math.max(dec, n.decDigits);
    neg ||= n.negative;
  }
  return `S[table-format=${neg ? "-" : ""}${int}.${dec}]`;
}

/** S columns only for plain numbers: values with ± or % keep a normal column so nothing is silently dropped. */
function siunitxEligible(body: string[][], c: number, mark: DecimalMark): boolean {
  return body.every((r) => {
    const cell = r[c] ?? "";
    if (isMissing(cell)) return true;
    const n = parseNumber(cell, mark);
    return !!n && !n.pm && !n.percent && !/[eE]/.test(cell) && !MARKERS_RE.test(cell.trim());
  });
}

/** Format a numeric cell for an S column: Unicode minus normalized, thousands separators dropped, decimal comma → period. */
function siunitxCell(cell: string, mark: DecimalMark): string {
  const s = cell.trim().replace(/−/g, "-");
  return mark === "," ? s.replace(/,/g, ".") : s.replace(/,(?=\d{3})/g, "");
}

export interface LatexResult {
  latex: string;
  packages: string[];
  model: TableModel;
  /** Columns emitted as siunitx S columns. */
  sColumns: boolean[];
}

export function toLatex(parsed: Pick<ParsedTable, "rows" | "alignHints" | "delimiter">, options: Partial<LatexTableOptions> = {}): LatexResult {
  const opts = { ...defaultTableOptions, ...options };
  const model = buildModel(parsed, opts);
  const { header, body, columns, numeric, decimalComma, aligns, best } = model;
  const mark = (c: number): DecimalMark => (decimalComma[c] ? "," : ".");
  const sCols = numeric.map((isNum, c) => opts.siunitx && opts.align === "auto" && isNum && siunitxEligible(body, c, mark(c)));
  const isS = (c: number) => sCols[c];
  const esc = (s: string) => (opts.escape ? escapeLatex(s) : s);

  const packages: string[] = [];
  if (opts.booktabs) packages.push("booktabs");
  if (sCols.some(Boolean)) packages.push("siunitx");
  if (opts.resize) packages.push("graphicx");
  if (opts.escape && [...(header ?? []), ...body.flat(), opts.caption].some((c) => /[✓✔]/.test(c))) packages.push("amssymb");

  const spec = aligns.map((a, c) => (isS(c) ? siunitxFormat(body, c, mark(c)) : a)).join(" ");

  const fmtHeader = (cell: string, c: number) => {
    const text = esc(cell);
    return isS(c) ? `{${text}}` : text;
  };
  const fmtBody = (cell: string, r: number, c: number) => {
    if (isS(c)) {
      if (isMissing(cell)) return cell === "" ? "" : `{${esc(cell)}}`;
      const v = siunitxCell(cell, mark(c));
      return best[r][c] ? `\\bfseries ${v}` : v;
    }
    const text = esc(cell);
    return best[r][c] && text ? `\\textbf{${text}}` : text;
  };

  const lines: string[][] = [];
  if (header) lines.push(header.map(fmtHeader));
  body.forEach((row, r) => lines.push(row.map((cell, c) => fmtBody(cell, r, c))));

  // Pad cells so the & separators line up in the source.
  const widths = Array.from({ length: columns }, (_, c) => Math.max(0, ...lines.map((l) => (l[c] ?? "").length)));
  const renderRow = (l: string[]) =>
    l
      .map((cell, c) => (c === columns - 1 ? cell : cell.padEnd(widths[c])))
      .join(" & ")
      .trimEnd() + " \\\\";

  const top = opts.booktabs ? "\\toprule" : "\\hline";
  const mid = opts.booktabs ? "\\midrule" : "\\hline";
  const bottom = opts.booktabs ? "\\bottomrule" : "\\hline";
  const env = opts.wide ? "table*" : "table";
  const ind = "  ";

  const out: string[] = [];
  if (packages.length) out.push(`% Requires: ${packages.map((p) => `\\usepackage{${p}}`).join(" ")}`);
  if (best.some((r) => r.some((b, c) => b && sCols[c]))) {
    out.push("% Bold numbers in S columns need: \\sisetup{detect-weight=true, mode=text}");
  }
  out.push(`\\begin{${env}}[t]`);
  out.push(`${ind}\\centering`);
  if (opts.fontSize !== "normalsize") out.push(`${ind}\\${opts.fontSize}`);
  if (opts.caption.trim()) out.push(`${ind}\\caption{${esc(opts.caption.trim())}}`);
  if (opts.label.trim()) out.push(`${ind}\\label{${opts.label.trim()}}`);
  if (opts.resize) out.push(`${ind}\\resizebox{\\linewidth}{!}{%`);
  out.push(`${ind}\\begin{tabular}{${spec}}`);
  out.push(`${ind}${ind}${top}`);
  let i = 0;
  if (header) {
    out.push(`${ind}${ind}${renderRow(lines[0])}`);
    out.push(`${ind}${ind}${mid}`);
    i = 1;
  }
  for (; i < lines.length; i++) {
    out.push(`${ind}${ind}${renderRow(lines[i])}`);
    if (!opts.booktabs && i < lines.length - 1) out.push(`${ind}${ind}\\hline`);
  }
  out.push(`${ind}${ind}${bottom}`);
  out.push(`${ind}\\end{tabular}${opts.resize ? "%" : ""}`);
  if (opts.resize) out.push(`${ind}}`);
  out.push(`\\end{${env}}`);

  return { latex: out.join("\n") + "\n", packages, model, sColumns: sCols };
}
