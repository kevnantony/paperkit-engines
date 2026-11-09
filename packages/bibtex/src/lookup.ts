import { parseBibtex, type BibEntry, type BibField } from "./core";
import { cleanItems, defaultCleanOptions, type CleanOptions } from "./clean";

export type Identifier =
  | { kind: "doi"; id: string }
  | { kind: "arxiv"; id: string; version?: string };

export interface InputLine {
  line: number;
  input: string;
  ident?: Identifier;
  error?: string;
}

/** Recognize a DOI or arXiv identifier in one line (bare, prefixed, or as a URL). */
export function parseIdentifier(raw: string): Identifier | null {
  const s = raw.trim().replace(/^<|>$/g, "");
  if (!s) return null;

  // arXiv URLs and prefixed IDs first: arxiv.org/abs/2101.00001v2, arXiv:2101.00001, arxiv.org/pdf/hep-th/9901001
  const arxivUrl = /arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i.exec(s);
  if (arxivUrl) return { kind: "arxiv", id: arxivUrl[1], version: arxivUrl[2] };
  const arxivPrefixed = /^arxiv\s*:\s*([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?$/i.exec(s);
  if (arxivPrefixed) return { kind: "arxiv", id: arxivPrefixed[1], version: arxivPrefixed[2] };
  const arxivBare = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/i.exec(s);
  if (arxivBare) return { kind: "arxiv", id: arxivBare[1], version: arxivBare[2] };

  // arXiv's own DOI (10.48550/arXiv.2101.00001) is better served by the arXiv API.
  const arxivDoi = /10\.48550\/arxiv\.(\d{4}\.\d{4,5})(v\d+)?/i.exec(s);
  if (arxivDoi) return { kind: "arxiv", id: arxivDoi[1], version: arxivDoi[2] };

  const doi = /(10\.\d{4,9}\/\S+)/.exec(s.replace(/^doi\s*:\s*/i, ""));
  if (doi) {
    let id = doi[1].replace(/[.,;]+$/, "");
    try {
      id = decodeURIComponent(id);
    } catch {
      /* keep as is */
    }
    return { kind: "doi", id };
  }
  return null;
}

export function parseInput(text: string): InputLine[] {
  const out: InputLine[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const input = raw.trim();
    if (!input || input.startsWith("#") || input.startsWith("%")) return;
    const ident = parseIdentifier(input);
    out.push(ident ? { line: i + 1, input, ident } : { line: i + 1, input, error: "Not a DOI or arXiv ID" });
  });
  return out;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface LookupResult {
  line: number;
  input: string;
  status: "ok" | "failed";
  /** Short reason for failures, or the source used for successes. */
  message: string;
  entry?: BibEntry;
}

export class LookupError extends Error {}

export async function fetchDoi(doi: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<BibEntry> {
  const url = `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/x-bibtex; charset=utf-8" }, signal });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new LookupError("Network error: check your connection");
  }
  if (res.status === 404) throw new LookupError("DOI not found");
  if (!res.ok) throw new LookupError(`doi.org answered HTTP ${res.status}`);
  const body = await res.text();
  const entry = parseBibtex(fixCrossrefText(body)).items.find((i): i is BibEntry => i.kind === "entry");
  if (!entry) throw new LookupError("No BibTeX returned for this DOI");
  return entry;
}

/** Crossref BibTeX sometimes carries HTML entities and inline tags (<i>, <sub>) in titles. */
export function fixCrossrefText(s: string): string {
  return s
    .replace(/<\/?(?:i|b|em|strong|sub|sup|scp|mml:[a-z]+)[^>]*>/gi, "")
    .replace(/&amp;/g, "\\&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * Look up arXiv IDs in one batched call to the arXiv API. Returns a map id → entry; IDs with no
 * match are missing from the map. Throws LookupError when the API itself cannot be reached.
 */
export async function fetchArxivBatch(ids: string[], fetchImpl: FetchLike, signal?: AbortSignal): Promise<Map<string, BibEntry>> {
  const url = `https://export.arxiv.org/api/query?id_list=${ids.map(encodeURIComponent).join(",")}&max_results=${ids.length}`;
  let res;
  try {
    res = await fetchImpl(url, { signal });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new LookupError("arXiv API unreachable from the browser");
  }
  if (!res.ok) throw new LookupError(`arXiv API answered HTTP ${res.status}`);
  const xml = await res.text();
  const map = new Map<string, BibEntry>();
  for (const e of parseArxivAtom(xml)) map.set(e.id, e.entry);
  return map;
}

export interface ArxivRecord {
  id: string;
  version?: string;
  entry: BibEntry;
}

/** Minimal Atom parser for arXiv API responses (no DOMParser needed, so it runs in tests and workers). */
export function parseArxivAtom(xml: string): ArxivRecord[] {
  const out: ArxivRecord[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const body = m[1];
    const tag = (name: string) => {
      const r = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(body);
      return r ? decodeXml(r[1]).replace(/\s+/g, " ").trim() : "";
    };
    const idUrl = tag("id");
    const idm = /arxiv\.org\/abs\/(.+?)(v\d+)?$/.exec(idUrl);
    const title = tag("title");
    if (!idm || !title || /api\/errors/.test(idUrl)) continue;
    const id = idm[1];
    const authors = [...body.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((a) => decodeXml(a[1]).trim());
    const published = tag("published");
    const primary = /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(body)?.[1];
    const doi = tag("arxiv:doi");
    const journalRef = tag("arxiv:journal_ref");
    const fields: [string, string][] = [
      // arXiv gives "First Last" names, which BibTeX parses correctly (von particles and Jr. included).
      ["author", authors.map(bibtexName).join(" and ")],
      ["title", title],
      ["year", published.slice(0, 4)],
      ["eprint", id],
      ["archiveprefix", "arXiv"],
    ];
    if (primary) fields.push(["primaryclass", primary]);
    if (doi) fields.push(["doi", doi]);
    if (journalRef) fields.push(["note", journalRef]);
    fields.push(["url", `https://arxiv.org/abs/${id}`]);
    out.push({
      id,
      version: idm[2],
      entry: {
        kind: "entry",
        type: "misc",
        key: `arxiv:${id}`,
        fields: fields.filter(([, v]) => v).map(([name, value]): BibField => ({ name, value: [{ type: "literal", value: escapeTex(value), delim: "brace" }] })),
        raw: "",
        line: 0,
      },
    });
  }
  return out;
}

/**
 * Fallback for arXiv when the arXiv API is blocked by CORS: arXiv registers a DataCite DOI
 * (10.48550/arXiv.<id>) for every paper, and doi.org serves BibTeX for it with CORS enabled.
 */
export async function fetchArxivViaDoi(id: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<BibEntry> {
  const entry = await fetchDoi(`10.48550/arXiv.${id}`, fetchImpl, signal).catch((e) => {
    if (e instanceof LookupError && e.message === "DOI not found") throw new LookupError("arXiv ID not found");
    throw e;
  });
  const fields = entry.fields.filter((f) => !["keywords", "copyright", "publisher"].includes(f.name));
  const lit = (value: string): BibField["value"] => [{ type: "literal", value, delim: "brace" }];
  if (!fields.some((f) => f.name === "eprint")) fields.push({ name: "eprint", value: lit(id) });
  if (!fields.some((f) => f.name === "archiveprefix")) fields.push({ name: "archiveprefix", value: lit("arXiv") });
  return { ...entry, type: "misc", fields };
}

function bibtexName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** Escape BibTeX/LaTeX specials in plain text, leaving $…$ math and already-escaped characters alone. */
function escapeTex(s: string): string {
  return s
    .split(/(\$[^$]*\$)/)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/(?<!\\)([&%#_])/g, "\\$1")))
    .join("");
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

export interface ResolveOptions {
  fetch: FetchLike;
  signal?: AbortSignal;
  /** Parallel DOI requests. Default 4. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Resolve every recognized line. Duplicate identifiers are fetched once. */
export async function resolveAll(lines: InputLine[], opts: ResolveOptions): Promise<LookupResult[]> {
  const results = new Map<number, LookupResult>();
  const valid = lines.filter((l) => l.ident);
  for (const l of lines) if (!l.ident) results.set(l.line, { line: l.line, input: l.input, status: "failed", message: l.error ?? "Not recognized" });

  const total = valid.length;
  let done = 0;
  const tick = () => opts.onProgress?.(++done, total);

  // arXiv: one batched API call, then per-ID DOI fallback if the API is unreachable (CORS).
  const arxivLines = valid.filter((l) => l.ident!.kind === "arxiv");
  const arxivIds = [...new Set(arxivLines.map((l) => l.ident!.id))];
  const arxivEntries = new Map<string, BibEntry | LookupError>();
  let arxivSource = "arXiv API";
  if (arxivIds.length) {
    try {
      const found = await fetchArxivBatch(arxivIds, opts.fetch, opts.signal);
      for (const id of arxivIds) arxivEntries.set(id, found.get(id) ?? new LookupError("arXiv ID not found"));
    } catch (e) {
      if (isAbort(e)) throw e;
      arxivSource = "DataCite DOI";
      await pool(arxivIds, opts.concurrency ?? 4, async (id) => {
        try {
          arxivEntries.set(id, await fetchArxivViaDoi(id, opts.fetch, opts.signal));
        } catch (err) {
          if (isAbort(err)) throw err;
          const reason = err instanceof LookupError ? err.message : "Lookup failed";
          arxivEntries.set(id, new LookupError(reason === "Network error: check your connection" ? "arXiv lookup blocked or offline" : reason));
        }
      });
    }
    for (const l of arxivLines) {
      const r = arxivEntries.get(l.ident!.id)!;
      results.set(
        l.line,
        r instanceof LookupError
          ? { line: l.line, input: l.input, status: "failed", message: r.message }
          : { line: l.line, input: l.input, status: "ok", message: arxivSource, entry: r },
      );
      tick();
    }
  }

  const doiLines = valid.filter((l) => l.ident!.kind === "doi");
  const doiCache = new Map<string, Promise<BibEntry>>();
  await pool(doiLines, opts.concurrency ?? 4, async (l) => {
    const id = l.ident!.id.toLowerCase();
    if (!doiCache.has(id)) doiCache.set(id, fetchDoi(l.ident!.id, opts.fetch, opts.signal));
    try {
      const entry = await doiCache.get(id)!;
      results.set(l.line, { line: l.line, input: l.input, status: "ok", message: "doi.org", entry });
    } catch (e) {
      if (isAbort(e)) throw e;
      results.set(l.line, { line: l.line, input: l.input, status: "failed", message: e instanceof LookupError ? e.message : "Lookup failed" });
    }
    tick();
  });

  return lines.map((l) => results.get(l.line)!);
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export const doiCleanOptions: CleanOptions = {
  ...defaultCleanOptions,
  regenerateKeys: true,
  removeUrlWhenDoi: true,
};

/** Combine successful lookups into one cleaned .bib (unique entries, unique keys). */
export function combine(results: LookupResult[], opts: CleanOptions = doiCleanOptions): { output: string; count: number } {
  const seen = new Set<BibEntry>();
  const entries: BibEntry[] = [];
  for (const r of results) {
    if (r.status === "ok" && r.entry && !seen.has(r.entry)) {
      seen.add(r.entry);
      entries.push(r.entry);
    }
  }
  if (!entries.length) return { output: "", count: 0 };
  const items = entries.map((e) => ({ ...e, fields: [...e.fields] }));
  if (!opts.regenerateKeys) {
    // Make keys from services safe and unique (DataCite returns URL-shaped keys).
    const used = new Set<string>();
    for (const e of items) {
      let k = e.key.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/[^\w:.\-/]/g, "_");
      while (used.has(k)) k += "_";
      used.add(k);
      e.key = k;
    }
  }
  const res = cleanItems(items, opts);
  return { output: res.output, count: res.stats.entries };
}
