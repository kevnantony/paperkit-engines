import {
  getField,
  isArxivEntry,
  normalizeDoi,
  normalizeTitle,
  parseBibtex,
  plainText,
  serializeEntry,
  serializeItem,
  titleSimilarity,
  titleSimilarityAtLeast,
  valueText,
  yearOf,
  type BibEntry,
  type BibItem,
  type ParseWarning,
} from "./core";

export interface SourceFile {
  name: string;
  text: string;
}

export interface Candidate {
  /** Stable id: position in the combined input. */
  id: number;
  entry: BibEntry;
  source: string;
  title: string;
  year: string;
  doi?: string;
  arxiv: boolean;
  fieldCount: number;
}

export type DupReason = "doi" | "arxiv-published" | "same-title" | "similar-title" | "same-key";

export const reasonLabel: Record<DupReason, string> = {
  doi: "Same DOI",
  "arxiv-published": "arXiv + published",
  "same-title": "Same title",
  "similar-title": "Similar title",
  "same-key": "Same key",
};

/**
 * "duplicates": linked by DOI, or by title with a compatible year. "same-key": entries that only share
 * a citation key; they are probably different papers and are never merged unless the user says so.
 */
export type DupGroupKind = "duplicates" | "same-key";

export interface DupGroup {
  id: number;
  kind: DupGroupKind;
  members: Candidate[];
  reasons: DupReason[];
  /** Highest title similarity between members, in [0, 1]. */
  similarity: number;
  /** Candidate id suggested to keep (published version, most fields). */
  suggested: number;
  /** Pre-selected choice: the suggested entry for duplicates, "all" for same-key groups. */
  defaultChoice: number | "all";
}

/** A block the parser could not read. It is copied to the merged output unchanged. */
export interface Passthrough {
  raw: string;
  source: string;
  line: number;
  /** Number of candidates that come before it in the combined input. */
  before: number;
}

export interface FindResult {
  candidates: Candidate[];
  groups: DupGroup[];
  warnings: (ParseWarning & { source: string })[];
  /** @string / @preamble / @comment items from all inputs, deduplicated. */
  extras: BibItem[];
  /** Unreadable chunks, kept in their original position in the merged output. */
  passthrough: Passthrough[];
}

export interface FindOptions {
  /** Minimum title similarity (token Jaccard or Levenshtein ratio) to group. Default 0.9. */
  threshold: number;
}

export function findDuplicates(files: SourceFile[], opts: FindOptions = { threshold: 0.9 }): FindResult {
  const candidates: Candidate[] = [];
  const warnings: FindResult["warnings"] = [];
  const extras: BibItem[] = [];
  const passthrough: Passthrough[] = [];
  const seenExtras = new Set<string>();

  for (const file of files) {
    const parsed = parseBibtex(file.text);
    warnings.push(...parsed.warnings.map((w) => ({ ...w, source: file.name })));
    const strings: Record<string, string> = {};
    for (const it of parsed.items) {
      if (it.kind === "string") strings[it.name] = valueText(it.value, strings);
      if (it.kind === "entry") {
        candidates.push({
          id: candidates.length,
          entry: it,
          source: file.name,
          title: normalizeTitle(getField(it, "title", strings) ?? ""),
          year: yearOf(it, strings),
          doi: normalizeDoi(getField(it, "doi", strings)),
          arxiv: isArxivEntry(it),
          fieldCount: it.fields.filter((f) => valueText(f.value).trim()).length,
        });
      } else if (it.kind === "unparsed") {
        passthrough.push({ raw: it.raw, source: file.name, line: it.line, before: candidates.length });
      } else if (it.kind !== "comment" || it.explicit) {
        const sig = serializeItem(it);
        if (!seenExtras.has(sig)) {
          seenExtras.add(sig);
          extras.push(it);
        }
      }
    }
  }

  // Union-find over candidates, remembering why pairs were linked. Only DOI and title links are
  // unioned; a shared key alone never puts entries into a duplicate group (see same-key groups below).
  const parent = candidates.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const pairReasons = new Map<number, Set<DupReason>>();
  const pairSim = new Map<number, number>();
  const link = (a: number, b: number, reason: DupReason, sim: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
    const root = find(a);
    const set = pairReasons.get(root) ?? new Set<DupReason>();
    set.add(reason);
    pairReasons.set(root, set);
    pairSim.set(root, Math.max(pairSim.get(root) ?? 0, sim));
    // merge any reasons stored on the absorbed root
    for (const r of [ra, rb]) {
      if (r !== root && pairReasons.has(r)) {
        for (const x of pairReasons.get(r)!) set.add(x);
        pairSim.set(root, Math.max(pairSim.get(root) ?? 0, pairSim.get(r) ?? 0));
        pairReasons.delete(r);
        pairSim.delete(r);
      }
    }
  };

  const people = candidates.map((c) => personTokens(c.entry));
  /** Both author lists known and without a single surname in common: written by different people. */
  const differentPeople = (i: number, j: number) => {
    if (!people[i].size || !people[j].size) return false;
    for (const t of people[i]) if (people[j].has(t)) return false;
    return true;
  };

  // 1. Exact DOI (arXiv DOIs 10.48550/... excluded: they never match a journal DOI anyway). A shared DOI
  // on two entries with unrelated titles AND unrelated authors is a data error (e.g. two letters in one
  // journal column given the column's DOI), not a duplicate: merging would silently drop a paper.
  const byDoi = new Map<string, number>();
  for (const c of candidates) {
    if (!c.doi) continue;
    const prev = byDoi.get(c.doi);
    if (prev === undefined) byDoi.set(c.doi, c.id);
    else if (titlesRelated(candidates[prev].title, c.title) || !differentPeople(prev, c.id)) link(prev, c.id, "doi", 1);
  }

  // 2. Title similarity, with arXiv-vs-published pairs called out.
  const sets = candidates.map((c) => new Set(c.title.split(" ")));
  const markers = candidates.map((c) => seriesMarkers(c.title));
  for (const [i, j] of candidatePairs(candidates)) {
    const a = candidates[i];
    const b = candidates[j];
    // Different DOIs on both sides means two distinct publications (e.g. conference + journal version).
    if (a.doi && b.doi && a.doi !== b.doi && !a.arxiv && !b.arxiv) continue;
    // Part I / Part II, 2019 / 2020 proceedings, or different years: different works.
    if (markers[i] !== markers[j] || !yearsCompatible(a, b)) continue;
    // Same title, completely different authors: different works ("Introduction", "Editorial", replies).
    if (differentPeople(i, j) || distinctPlacement(a.entry, b.entry)) continue;
    const sim = titleSimilarityAtLeast(a.title, b.title, opts.threshold, sets[i], sets[j]);
    if (!sim) continue;
    if (a.arxiv !== b.arxiv) link(i, j, "arxiv-published", sim);
    else link(i, j, sim === 1 ? "same-title" : "similar-title", sim);
  }

  const byRoot = new Map<number, Candidate[]>();
  for (const c of candidates) {
    const r = find(c.id);
    byRoot.set(r, [...(byRoot.get(r) ?? []), c]);
  }

  const groups: Omit<DupGroup, "id">[] = [];
  const order: DupReason[] = ["doi", "arxiv-published", "same-title", "similar-title"];
  for (const [root, members] of byRoot) {
    if (members.length < 2) continue;
    const reasons = order.filter((r) => pairReasons.get(root)?.has(r));
    const suggested = suggestKeep(members);
    groups.push({ kind: "duplicates", members, reasons, similarity: pairSim.get(root) ?? 0, suggested, defaultChoice: suggested });
  }

  // 3. Shared citation keys, reported on their own and defaulting to "keep all". Skipped when every
  // entry with that key is already in the same duplicate group (merging that group resolves it).
  const byKey = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = c.entry.key.toLowerCase();
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }
  for (const members of byKey.values()) {
    if (members.length < 2) continue;
    if (members.every((m) => find(m.id) === find(members[0].id))) continue;
    let similarity = 0;
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) similarity = Math.max(similarity, titleSimilarity(members[i].title, members[j].title));
    groups.push({ kind: "same-key", members, reasons: ["same-key"], similarity, suggested: suggestKeep(members), defaultChoice: "all" });
  }

  const first = (g: Omit<DupGroup, "id">) => g.members[0].id;
  const sorted = groups
    .sort((a, b) => first(a) - first(b) || (a.kind === b.kind ? 0 : a.kind === "duplicates" ? -1 : 1))
    .map((g, id) => ({ id, ...g }));

  return { candidates, groups: sorted, warnings, extras, passthrough };
}

const ROMAN = /^(?=[ivxlc])c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;
const SERIES_WORDS = new Set(["part", "volume", "vol", "chapter"]);
const MONTH_WORDS = new Set("january february march april june july august september october november december".split(" "));

/**
 * Tokens that tell apart works in a series: numbers (years, editions, ResNet-50/101), roman numerals,
 * month names (journal issues), and the word after "part" / "volume" / "vol" / "chapter". Titles are only
 * linked when these match.
 */
export function seriesMarkers(title: string): string {
  const toks = title.split(" ");
  const out: string[] = [];
  toks.forEach((t, i) => {
    if (/\d/.test(t) || ROMAN.test(t) || MONTH_WORDS.has(t) || (i > 0 && SERIES_WORDS.has(toks[i - 1]))) out.push(t);
  });
  return out.sort().join(" ");
}

/** Same year, or one unknown. An arXiv preprint and its published version may be a year apart. */
function yearsCompatible(a: Candidate, b: Candidate): boolean {
  if (!a.year || !b.year) return true;
  const d = Math.abs(Number(a.year) - Number(b.year));
  return d === 0 || (d <= 1 && a.arxiv !== b.arxiv);
}

/**
 * Pairs of titles that could reach a token Jaccard of 0.5 (titleSimilarity never exceeds the Jaccard
 * below that point). Prefix filtering: order each title's tokens rarest-first; two sets with
 * Jaccard >= 0.5 must share a token within the first |A| - ceil(|A|/2) + 1 tokens. This keeps large
 * bibliographies (thousands of entries) fast without missing any match at thresholds >= 0.5.
 */
/**
 * Title length in Latin-letter units, used to ignore titles too short to compare ("Preface", "Reviews").
 * Han, kana and Hangul characters each carry roughly a word's meaning, so a 6-character Japanese title
 * ("機械学習入門") is not "short".
 */
export function titleWeight(title: string): number {
  let n = 0;
  for (const ch of title) n += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch) ? 3 : 1;
  return n;
}

function candidatePairs(cands: Candidate[]): [number, number][] {
  const tokens = cands.map((c) => (titleWeight(c.title) >= 8 ? [...new Set(c.title.split(" "))] : []));
  const df = new Map<string, number>();
  for (const ts of tokens) for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1);
  const index = new Map<string, number[]>();
  const seen = new Set<number>();
  const out: [number, number][] = [];
  const n = cands.length;
  tokens.forEach((ts, i) => {
    if (!ts.length) return;
    const sorted = [...ts].sort((a, b) => df.get(a)! - df.get(b)! || (a < b ? -1 : 1));
    const prefix = sorted.slice(0, sorted.length - Math.ceil(sorted.length / 2) + 1);
    for (const t of prefix) {
      const list = index.get(t) ?? [];
      for (const j of list) {
        const id = j * n + i;
        if (!seen.has(id)) {
          seen.add(id);
          out.push([j, i]);
        }
      }
      list.push(i);
      index.set(t, list);
    }
  });
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * Prefer a complete entry (title, author or editor, year), then the published version, then the entry with
 * most fields, then the first one seen. A bare "title + URL" stub is never preferred over a full record.
 */
export function suggestKeep(members: Candidate[]): number {
  const complete = (c: Candidate) =>
    Number(Boolean(c.title && c.year && c.entry.fields.some((f) => (f.name === "author" || f.name === "editor") && valueText(f.value).trim())));
  return [...members].sort(
    (a, b) => complete(b) - complete(a) || Number(a.arxiv) - Number(b.arxiv) || b.fieldCount - a.fieldCount || a.id - b.id,
  )[0].id;
}

const NAME_NOISE = new Set(["and", "others", "et", "al", "von", "van", "der", "den", "de", "la", "le", "di", "da", "del", "jr", "sr"]);

/**
 * Lower-case name words (initials and particles dropped) of the authors, or of the editors when there are
 * no authors. Editors of an @inproceedings are the volume's editors, shared by every paper in it.
 */
function personTokens(entry: BibEntry): Set<string> {
  const names = getField(entry, "author")?.trim() || getField(entry, "editor") || "";
  return new Set(plainText(names).split(" ").filter((t) => t.length > 1 && !NAME_NOISE.has(t)));
}

/**
 * Two items in the same journal or proceedings but at a different volume, issue or page range are different
 * items, even with the same title ("Advertisements", "Book Reviews", "Concluding Remarks" in every issue).
 */
function distinctPlacement(a: BibEntry, b: BibEntry): boolean {
  // Anonymous items (front matter, proceedings volumes) on two different pages of the same site:
  // aclanthology.org/J87-1024 vs /J87-3015. Not used when authors are known: one paper often has several
  // URL forms on one site (dl.acm.org/doi/X vs /doi/abs/X), and the author check already separates works.
  const anonymous = (e: BibEntry) => !getField(e, "author")?.trim();
  const ua = normalizeUrl(getField(a, "url"));
  const ub = normalizeUrl(getField(b, "url"));
  if (anonymous(a) && anonymous(b) && ua && ub && ua !== ub && ua.split("/")[0] === ub.split("/")[0]) return true;
  const venue = (e: BibEntry) => plainText(getField(e, "journal") ?? getField(e, "journaltitle") ?? getField(e, "booktitle") ?? "");
  const va = venue(a);
  if (!va || va !== venue(b)) return false;
  const differs = (name: string, norm: (s: string) => string = (s) => plainText(s)) => {
    const x = getField(a, name);
    const y = getField(b, name);
    return Boolean(x?.trim() && y?.trim() && norm(x) !== norm(y));
  };
  return (
    differs("volume") ||
    differs("number") ||
    differs("issue") ||
    differs("pages", (s) => s.replace(/[\s\-\u2010-\u2015]+/g, "-").toLowerCase())
  );
}

/** "https://www.arxiv.org/pdf/1706.03762v5.pdf" → "arxiv.org/1706.03762"; "" when there is no URL. */
function normalizeUrl(url: string | undefined): string {
  if (!url?.trim()) return "";
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/^dx\.doi\.org\//, "doi.org/")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.pdf$/, "")
    .replace(/^(export\.)?arxiv\.org\/(?:abs|pdf|html)\/(.+?)(?:v\d+)?$/, "arxiv.org/$2");
}

/** Titles that plausibly describe the same work: one missing, one containing the other, or similar words. */
function titlesRelated(a: string, b: string): boolean {
  if (!a || !b || a.includes(b) || b.includes(a)) return true;
  return titleSimilarity(a, b) >= 0.5;
}

/** Group id → candidate id to keep, or "all" to keep every member (not actually duplicates). */
export type Choices = Record<number, number | "all">;

export interface MergeOptions {
  /** Copy fields that the kept entry lacks (e.g. doi, eprint) from the discarded duplicates. */
  fillMissing: boolean;
}

export interface MergeResult {
  output: string;
  renames: { from: string; to: string }[];
  removed: number;
  kept: number;
}

export function mergeDuplicates(result: FindResult, choices: Choices, opts: MergeOptions = { fillMissing: false }): MergeResult {
  // Resolve each group's choice. An entry chosen in any group is never dropped by another group.
  const resolved: { group: DupGroup; keep: Candidate }[] = [];
  for (const g of result.groups) {
    const choice = choices[g.id] ?? g.defaultChoice;
    if (choice === "all") continue;
    const keep = g.members.find((m) => m.id === choice) ?? g.members.find((m) => m.id === g.suggested)!;
    resolved.push({ group: g, keep });
  }
  const keepIds = new Set(resolved.map((r) => r.keep.id));
  const drop = new Set<number>();
  for (const { group, keep } of resolved) for (const m of group.members) if (m.id !== keep.id && !keepIds.has(m.id)) drop.add(m.id);

  const renames: { from: string; to: string }[] = [];
  const filled = new Map<number, BibEntry>();
  // The kept entry takes the position of the first member of its group.
  const slot = new Map<number, number>();
  for (const { group, keep } of resolved) {
    slot.set(keep.id, Math.min(slot.get(keep.id) ?? keep.id, ...group.members.map((m) => m.id)));
    for (const m of group.members) {
      if (!drop.has(m.id)) continue;
      if (m.entry.key !== keep.entry.key && !renames.some((r) => r.from === m.entry.key)) {
        renames.push({ from: m.entry.key, to: keep.entry.key });
      }
      if (opts.fillMissing) {
        const merged = filled.get(keep.id) ?? { ...keep.entry, fields: [...keep.entry.fields] };
        for (const f of m.entry.fields) {
          if (!merged.fields.some((x) => x.name === f.name)) merged.fields.push(f);
        }
        filled.set(keep.id, merged);
      }
    }
  }

  const blocks: { pos: number; text: string }[] = [];
  for (const c of result.candidates) {
    if (drop.has(c.id)) continue;
    const f = filled.get(c.id);
    const text = f && f.fields.length !== c.entry.fields.length ? serializeEntry(f) : c.entry.raw.trim();
    blocks.push({ pos: slot.get(c.id) ?? c.id, text });
  }
  const kept = blocks.length;
  // Unreadable chunks stay where they were, between the same entries as in the input.
  for (const p of result.passthrough) blocks.push({ pos: p.before - 0.5, text: p.raw });
  blocks.sort((a, b) => a.pos - b.pos);

  const all = [...result.extras.map((x) => serializeItem(x)), ...blocks.map((b) => b.text)];
  return { output: all.length ? all.join("\n\n") + "\n" : "", renames, removed: drop.size, kept };
}

/** Plain-text rename map, one "old -> new" per line, for fixing \cite commands. */
export function renameMapText(renames: { from: string; to: string }[]): string {
  return renames.map((r) => `${r.from} -> ${r.to}`).join("\n");
}
