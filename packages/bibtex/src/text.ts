import type { BibEntry, ValuePart } from "./types";

export const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Map "January", "jan.", "1", "01", "Sept" → "jan" … "dec"; null if it is not a single month. */
export function monthMacro(input: string): (typeof MONTHS)[number] | null {
  const s = input.trim().toLowerCase().replace(/\.$/, "");
  if (/^\d{1,2}$/.test(s)) {
    const n = Number(s);
    return n >= 1 && n <= 12 ? MONTHS[n - 1] : null;
  }
  if (s === "sept") return "sep";
  const i = MONTH_NAMES.findIndex((m) => m === s || (s.length >= 3 && m.startsWith(s) && s === m.slice(0, 3)));
  return i >= 0 ? MONTHS[i] : null;
}

/** Plain text of a value: literals joined, macros resolved via `strings` (month macros become names). */
export function valueText(parts: ValuePart[], strings: Record<string, string> = {}): string {
  return parts
    .map((p) => {
      if (p.type === "literal") return p.value;
      if (p.name in strings) return strings[p.name];
      const m = MONTHS.indexOf(p.name as (typeof MONTHS)[number]);
      return m >= 0 ? MONTH_NAMES[m][0].toUpperCase() + MONTH_NAMES[m].slice(1) : p.name;
    })
    .join("");
}

export function getField(entry: BibEntry, name: string, strings?: Record<string, string>): string | undefined {
  const f = entry.fields.find((x) => x.name === name);
  return f ? valueText(f.value, strings) : undefined;
}

export function hasField(entry: BibEntry, name: string): boolean {
  return entry.fields.some((f) => f.name === name && valueText(f.value).trim() !== "");
}

/** Set (or add) a field to a single braced literal. */
export function setField(entry: BibEntry, name: string, value: string): void {
  const f = entry.fields.find((x) => x.name === name);
  const parts: ValuePart[] = [{ type: "literal", value, delim: "brace" }];
  if (f) f.value = parts;
  else entry.fields.push({ name, value: parts });
}

const ACCENTS: Record<string, string> = { ss: "ss", o: "o", O: "O", l: "l", L: "L", ae: "ae", AE: "AE", oe: "oe", OE: "OE", aa: "a", AA: "A", i: "i", j: "j",
  // accent commands that take an argument: drop the command, keep the letter
  v: "", u: "", H: "", c: "", d: "", b: "", t: "", k: "", r: "",
};

/** Formatting, spacing and punctuation commands that carry no words of their own. */
const DROP_COMMANDS = new Set(
  (
    "emph textbf textit textsc textrm textsf texttt textup textsl textmd textnormal textsuperscript textsubscript mbox hbox makebox " +
    "em it bf sc rm sf tt sl up md normalfont small large Large LARGE huge Huge footnotesize scriptsize tiny normalsize " +
    "url href nolinkurl doi cite ensuremath mathrm mathbf mathit mathcal mathsf mathtt mathbb mathfrak mathscr boldsymbol bm text " +
    "uppercase lowercase MakeUppercase MakeLowercase MakeTextUppercase MakeTextLowercase relax protect noopsort switchargs " +
    "bibinfo newblock xspace textendash textemdash textquoteright textquoteleft textquotedblleft textquotedblright " +
    "textquotesingle textasciitilde textbackslash ldots dots cdots textellipsis slash nobreakspace quad qquad hspace vspace " +
    "kern enspace thinspace left right bigl bigr Bigl Bigr acro acs ac ignorespaces"
  ).split(" "),
);

/**
 * Reduce LaTeX-ish text to plain lowercase words: strips braces, accent commands (\"{o}, {\'e}),
 * formatting commands and diacritics (Latin text becomes ASCII; other scripts are kept). Used for comparing
 * titles and building citation keys.
 */
export function plainText(input: string): string {
  let s = input;
  // Math is kept as words: "$O(n)$" and "$O(n^2)$", or "$\\alpha$-" and "$\\beta$-divergence", are different titles.
  s = s.replace(/\$([^$]*)\$/g, " $1 ");
  s = s.replace(/\\&/g, " and ");
  // Accent commands keep their letter; formatting and punctuation commands disappear; any other command
  // (\TeX, \METAFONT, \alpha) is a word of the title.
  s = s.replace(/\\([a-zA-Z]+)\s*/g, (_, cmd: string) => (cmd in ACCENTS ? ACCENTS[cmd] : DROP_COMMANDS.has(cmd) ? " " : ` ${cmd} `));
  s = s.replace(/\\[^a-zA-Z\s]/g, "");
  s = s.replace(/[{}]/g, "");
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/ß/g, "ss").replace(/[æ]/g, "ae").replace(/[ø]/g, "o").replace(/[łŁ]/g, "l");
  s = s.toLowerCase().replace(/&amp;/g, " and ").replace(/&/g, " and ");
  // Letters of any script count (two Cyrillic or Greek titles that share a few Latin words are not equal).
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");
  return s.trim().replace(/\s+/g, " ");
}

/** Split on whitespace at brace depth 0 (keeps `{Big Company}` as one token). */
export function splitTopLevel(input: string, sep: RegExp = /\s/): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of input) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && sep.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Split an author/editor field on " and " at brace depth 0. */
export function splitNames(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(ch)) {
      const m = /^\s+and\s+/i.exec(input.slice(i));
      if (m) {
        out.push(input.slice(start, i));
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  out.push(input.slice(start));
  // A doubled or dangling "and" ("Tu and and Gerald Tesauro", "Smith and") leaves an empty name next to
  // it; drop the stray "and" instead of reading it as part of a name.
  return out
    .map((n) => n.trim().replace(/\s+/g, " ").replace(/^(?:and(?:\s+|$))+/i, "").replace(/(?:(?:^|\s+)and)+$/i, ""))
    .filter(Boolean);
}

export function normalizeDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const s = doi
    .trim()
    .replace(/^\{|\}$/g, "")
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/\\_/g, "_")
    .trim()
    .toLowerCase();
  return /^10\.\d{4,9}\//.test(s) ? s : undefined;
}

export function yearOf(entry: BibEntry, strings?: Record<string, string>): string {
  const y = getField(entry, "year", strings) ?? getField(entry, "date", strings) ?? "";
  return /\d{4}/.exec(y)?.[0] ?? "";
}

/** Does this entry describe an arXiv preprint (rather than the published version)? */
export function isArxivEntry(entry: BibEntry): boolean {
  const journal = (getField(entry, "journal") ?? getField(entry, "journaltitle") ?? "").toLowerCase();
  const venue = `${journal} ${(getField(entry, "booktitle") ?? "").toLowerCase()} ${(getField(entry, "publisher") ?? "").toLowerCase()}`;
  const prefix = (getField(entry, "archiveprefix") ?? getField(entry, "eprinttype") ?? "").toLowerCase();
  const doi = normalizeDoi(getField(entry, "doi")) ?? "";
  if (doi.startsWith("10.48550/arxiv")) return true;
  if (/arxiv|corr\b|preprint/.test(venue)) return true;
  if (prefix === "arxiv" && !journal && !getField(entry, "booktitle")) return true;
  if (entry.type === "misc" || entry.type === "unpublished" || entry.type === "online") {
    if (getField(entry, "eprint") || /arxiv\.org/i.test(`${getField(entry, "url") ?? ""} ${getField(entry, "howpublished") ?? ""}`)) return true;
  }
  return false;
}
