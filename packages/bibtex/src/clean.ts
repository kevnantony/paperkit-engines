import {
  getField,
  hasField,
  monthMacro,
  normalizeNameList,
  parseBibtex,
  parseName,
  plainText,
  serializeBibtex,
  splitNames,
  valueText,
  yearOf,
  type BibEntry,
  type BibItem,
  type ParseWarning,
  type ValuePart,
} from "./core";

export type SortMode = "none" | "key" | "year";

export interface CleanOptions {
  /** Rewrite keys as authorYEARfirstword (e.g. vaswani2017attention). */
  regenerateKeys: boolean;
  sort: SortMode;
  /** Wrap acronyms / mixed-case words in titles with braces so styles keep their capitals. */
  protectCapitals: boolean;
  /** Rewrite author/editor lists as "Last, First and Last, First". */
  normalizeAuthors: boolean;
  removeAbstract: boolean;
  removeKeywords: boolean;
  removeFile: boolean;
  /** Drop `url` when the entry already has a DOI. */
  removeUrlWhenDoi: boolean;
  /** 12-34, 12 – 34, 12---34 → 12--34 */
  pageRanges: boolean;
  /** month = {January} → month = jan */
  monthMacros: boolean;
  /** Put fields in a conventional order (author, title, venue, … ). */
  fieldOrder: boolean;
  /** Collapse runs of whitespace and line breaks inside values. */
  trimWhitespace: boolean;
}

export const defaultCleanOptions: CleanOptions = {
  regenerateKeys: false,
  sort: "none",
  protectCapitals: true,
  normalizeAuthors: true,
  removeAbstract: true,
  removeKeywords: true,
  removeFile: true,
  removeUrlWhenDoi: false,
  pageRanges: true,
  monthMacros: true,
  fieldOrder: true,
  trimWhitespace: true,
};

export interface CleanStats {
  entries: number;
  fieldsRemoved: number;
  entriesChanged: number;
  warnings: ParseWarning[];
}

export interface CleanResult {
  output: string;
  stats: CleanStats;
  /** Old key → new key, only for keys that changed. */
  keyChanges: { from: string; to: string }[];
  entries: BibEntry[];
}

export const FIELD_ORDER = [
  "author",
  "editor",
  "title",
  "booktitle",
  "journal",
  "journaltitle",
  "series",
  "volume",
  "number",
  "issue",
  "chapter",
  "pages",
  "year",
  "month",
  "date",
  "edition",
  "publisher",
  "organization",
  "institution",
  "school",
  "address",
  "location",
  "howpublished",
  "type",
  "isbn",
  "issn",
  "doi",
  "eprint",
  "archiveprefix",
  "primaryclass",
  "eprinttype",
  "url",
  "urldate",
  "note",
  "abstract",
  "keywords",
  "file",
];

const STOPWORDS = new Set(
  "a an the on of in for to and or with without towards toward via from is are at by into do does how what when why we our can".split(" "),
);

/** Clean a .bib source string. Pure; never throws (parse problems end up in stats.warnings). */
export function cleanBibtex(src: string, opts: CleanOptions = defaultCleanOptions): CleanResult {
  const parsed = parseBibtex(src);
  return cleanItems(parsed.items, opts, parsed.warnings);
}

export function cleanItems(items: BibItem[], opts: CleanOptions, warnings: ParseWarning[] = []): CleanResult {
  const strings: Record<string, string> = {};
  for (const it of items) if (it.kind === "string") strings[it.name] = valueText(it.value, strings);

  let fieldsRemoved = 0;
  const out: BibItem[] = [];
  const originals: BibEntry[] = [];
  const entries: BibEntry[] = [];

  for (const it of items) {
    if (it.kind !== "entry") {
      if (it.kind === "comment" && !it.explicit) continue; // stray text between entries is ignored by BibTeX
      out.push(it);
      continue;
    }
    const { entry, removed } = cleanEntry(it, opts);
    fieldsRemoved += removed;
    out.push(entry);
    originals.push(it);
    entries.push(entry);
  }

  const keyChanges: { from: string; to: string }[] = [];
  if (opts.regenerateKeys) {
    const bases = entries.map((e) => makeKey(e, strings));
    const total = new Map<string, number>();
    for (const b of bases) total.set(b, (total.get(b) ?? 0) + 1);
    const seen = new Map<string, number>();
    entries.forEach((e, i) => {
      const base = bases[i];
      let key = base;
      if ((total.get(base) ?? 0) > 1) {
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        key = base + suffix(n);
      }
      if (key !== e.key) {
        keyChanges.push({ from: e.key, to: key });
        e.key = key;
      }
    });
    if (keyChanges.length) retargetKeyReferences(entries, keyChanges);
  }
  const entriesChanged = entries.filter((e, i) => fingerprint(e) !== fingerprint(originals[i])).length;

  let ordered = out;
  if (opts.sort !== "none") {
    // Unreadable chunks go last: an unbalanced brace there cannot swallow the entries after it.
    const head = out.filter((i) => i.kind !== "entry" && i.kind !== "unparsed");
    const tail = out.filter((i) => i.kind === "unparsed");
    const sorted = [...entries].sort((a, b) => {
      if (opts.sort === "year") {
        const ya = yearOf(a, strings) || "9999";
        const yb = yearOf(b, strings) || "9999";
        if (ya !== yb) return ya < yb ? -1 : 1;
      }
      return a.key.localeCompare(b.key, "en", { sensitivity: "base", numeric: true });
    });
    ordered = [...head, ...sorted, ...tail];
  }

  return {
    output: serializeBibtex(ordered),
    stats: { entries: entries.length, fieldsRemoved, entriesChanged, warnings },
    keyChanges,
    entries,
  };
}

/** Fields whose value is a citation key, or a comma-separated list of keys. */
const KEY_REFERENCE_FIELDS = new Set(["crossref", "xdata", "related"]);

/**
 * After keys are rewritten, point crossref / xdata / related at the new keys. When an old key was used
 * by several entries, the first one wins (BibTeX itself resolves duplicates to the first entry too).
 */
function retargetKeyReferences(entries: BibEntry[], changes: { from: string; to: string }[]): void {
  const exact = new Map<string, string>();
  const folded = new Map<string, string>();
  for (const c of changes) {
    if (!exact.has(c.from)) exact.set(c.from, c.to);
    if (!folded.has(c.from.toLowerCase())) folded.set(c.from.toLowerCase(), c.to);
  }
  const renamed = new Set(changes.map((c) => c.from));
  const stillUsed = new Set(entries.map((e) => e.key));
  const map = (k: string) => {
    // A key that some entry still has (after rewriting) already points at the right place.
    if (!renamed.has(k) && stillUsed.has(k)) return k;
    return exact.get(k) ?? folded.get(k.toLowerCase()) ?? k;
  };
  for (const e of entries) {
    for (const f of e.fields) {
      if (!KEY_REFERENCE_FIELDS.has(f.name)) continue;
      for (const p of f.value) {
        if (p.type !== "literal") continue;
        p.value = p.value
          .split(/(\s*,\s*)/)
          .map((tok, i) => (i % 2 === 1 || !tok.trim() ? tok : tok.replace(/^(\s*)(.*?)(\s*)$/, (_, a: string, k: string, b: string) => a + map(k) + b)))
          .join("");
      }
    }
  }
}

function suffix(n: number): string {
  // a, b, …, z, aa, ab …
  let s = "";
  let x = n;
  do {
    s = String.fromCharCode(97 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}

function fingerprint(e: BibEntry): string {
  return JSON.stringify([e.type, e.key, e.fields]);
}

function cleanEntry(input: BibEntry, opts: CleanOptions): { entry: BibEntry; removed: number } {
  const entry: BibEntry = { ...input, fields: input.fields.map((f) => ({ name: f.name, value: f.value.map((p) => ({ ...p })) })) };
  let removed = 0;

  const drop = (pred: (name: string) => boolean) => {
    const n = entry.fields.length;
    entry.fields = entry.fields.filter((f) => !pred(f.name));
    removed += n - entry.fields.length;
  };

  // Empty fields carry no information.
  drop((name) => {
    const f = entry.fields.find((x) => x.name === name)!;
    return f.value.length === 1 && f.value[0].type === "literal" && f.value[0].value.trim() === "";
  });
  if (opts.removeAbstract) drop((n) => n === "abstract");
  if (opts.removeKeywords) drop((n) => n === "keywords");
  if (opts.removeFile) drop((n) => n === "file");
  if (opts.removeUrlWhenDoi && hasField(entry, "doi")) drop((n) => n === "url");

  for (const f of entry.fields) {
    const lit = singleLiteral(f.value);
    if (opts.trimWhitespace) {
      // Inside a concatenation, edge spaces are meaningful (nips # " 27"), so only collapse runs.
      for (const p of f.value) if (p.type === "literal") p.value = p.value.replace(/\s+/g, " ");
      if (lit) lit.value = lit.value.trim();
    }
    if (!lit) {
      if (f.name === "month" && opts.monthMacros && f.value.length === 1 && f.value[0].type === "macro") {
        const m = monthMacro(f.value[0].name);
        if (m) f.value = [{ type: "macro", name: m }];
      }
      continue;
    }
    if ((f.name === "author" || f.name === "editor") && opts.normalizeAuthors) {
      lit.value = normalizeNameList(lit.value);
    }
    if (f.name === "title" && opts.protectCapitals) lit.value = protectCapitals(lit.value);
    if (f.name === "pages" && opts.pageRanges) lit.value = fixPageRange(lit.value);
    if (f.name === "month" && opts.monthMacros) {
      const m = monthMacro(lit.value);
      if (m) f.value = [{ type: "macro", name: m }];
    }
    if (f.name === "year" && /^\d+$/.test(lit.value) && lit.delim !== "brace") lit.delim = "brace";
  }

  if (opts.fieldOrder) {
    // Unknown fields go after the standard ones (before note/abstract), keeping their relative order.
    const unknownRank = FIELD_ORDER.indexOf("note") - 0.5;
    const rank = (n: string) => {
      const i = FIELD_ORDER.indexOf(n);
      return i < 0 ? unknownRank : i;
    };
    entry.fields = entry.fields
      .map((f, i) => ({ f, i }))
      .sort((a, b) => rank(a.f.name) - rank(b.f.name) || a.i - b.i)
      .map((x) => x.f);
  }
  return { entry, removed };
}

function singleLiteral(parts: ValuePart[]): Extract<ValuePart, { type: "literal" }> | null {
  return parts.length === 1 && parts[0].type === "literal" ? parts[0] : null;
}

/** "12-34", "12 – 34", "12---34" → "12--34". Leaves single pages and article numbers alone. */
export function fixPageRange(pages: string): string {
  const m = /^\s*([^\s\-–—]+)\s*(?:-{1,3}|–|—|‒)\s*([^\s\-–—]+)\s*$/.exec(pages);
  return m ? `${m[1]}--${m[2]}` : pages;
}

/**
 * Wrap words that must keep their capitals in braces: acronyms (BERT, GPU, COVID-19),
 * mixed-case names (ImageNet, iPhone, PyTorch) and tokens like 3D. Already-braced groups,
 * math and LaTeX commands are left untouched. A title wrapped entirely in braces is left as is.
 */
export function protectCapitals(title: string): string {
  const t = title.trim();
  if (isFullyBraced(t)) return title;

  let out = "";
  let depth = 0;
  let token = "";
  const flush = () => {
    if (token) out += protectToken(token);
    token = "";
  };
  for (const ch of title) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) {
      flush();
      out += ch;
    } else token += ch;
  }
  flush();
  return out;
}

function isFullyBraced(s: string): boolean {
  if (!s.startsWith("{") || !s.endsWith("}")) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0 && i < s.length - 1) return false;
    }
  }
  return true;
}

function protectToken(tok: string): string {
  if (/[{}\\$]/.test(tok)) return tok;
  const chars = Array.from(tok);
  let a = 0;
  let b = chars.length;
  while (a < b && !isWordChar(chars[a])) a++;
  while (b > a && !isWordChar(chars[b - 1])) b--;
  if (a === b) return tok;
  const pre = chars.slice(0, a).join("");
  const core = chars.slice(a, b).join("");
  const post = chars.slice(b).join("");
  // A capital anywhere after the first character of a word (BERT, ImageNet, iPhone, 3D, COVID-19).
  const needs = core.split(/[-/]/).some((seg) => Array.from(seg).slice(1).some(isUpper));
  return needs ? `${pre}{${core}}${post}` : tok;
}

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

function isWordChar(ch: string): boolean {
  return /[0-9]/.test(ch) || ch.toLowerCase() !== ch.toUpperCase();
}

/** Google-Scholar-style key: first author's last name + year + first significant title word. */
export function makeKey(entry: BibEntry, strings: Record<string, string> = {}): string {
  const people = getField(entry, "author", strings) ?? getField(entry, "editor", strings) ?? "";
  const first = splitNames(people)[0];
  let last = "";
  if (first && first.toLowerCase() !== "others") {
    const n = parseName(first);
    last = plainText(n.last).replace(/\s+/g, "");
  }
  const year = yearOf(entry, strings);
  const words = plainText(getField(entry, "title", strings) ?? "").split(" ").filter(Boolean);
  const word = words.find((w) => !STOPWORDS.has(w) && /[a-z]/.test(w)) ?? words[0] ?? "";
  const key = `${last || "anon"}${year}${word}`;
  return key.replace(/[^a-z0-9]/g, "") || "entry";
}
