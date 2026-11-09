import {
  getField,
  isArxivEntry,
  normalizeDoi,
  normalizeTitle,
  parseBibtex,
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

export interface DupGroup {
  id: number;
  members: Candidate[];
  reasons: DupReason[];
  /** Highest title similarity between members, in [0, 1]. */
  similarity: number;
  /** Candidate id suggested to keep (published version, most fields). */
  suggested: number;
  /**
   * Pre-selected choice. "all" when the only link is a shared citation key between entries whose
   * titles differ: those are different papers that need a new key, not a merge.
   */
  defaultChoice: number | "all";
}

export interface FindResult {
  candidates: Candidate[];
  groups: DupGroup[];
  warnings: (ParseWarning & { source: string })[];
  /** @string / @preamble / @comment items from all inputs, deduplicated. */
  extras: BibItem[];
}

export interface FindOptions {
  /** Minimum title similarity (token Jaccard or Levenshtein ratio) to group. Default 0.9. */
  threshold: number;
}

export function findDuplicates(files: SourceFile[], opts: FindOptions = { threshold: 0.9 }): FindResult {
  const candidates: Candidate[] = [];
  const warnings: FindResult["warnings"] = [];
  const extras: BibItem[] = [];
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
      } else if (it.kind !== "comment" || it.explicit) {
        const sig = serializeItem(it);
        if (!seenExtras.has(sig)) {
          seenExtras.add(sig);
          extras.push(it);
        }
      }
    }
  }

  // Union-find over candidates, remembering why pairs were linked.
  const parent = candidates.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const pairReasons = new Map<number, Set<DupReason>>();
  const pairSim = new Map<number, number>();
  const link = (a: number, b: number, reason: DupReason, sim: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
    const root = find(a);
    // attach reason to the root after union; re-keyed when groups are collected
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

  // 1. Exact DOI (arXiv DOIs 10.48550/... excluded: they never match a journal DOI anyway).
  const byDoi = new Map<string, number>();
  for (const c of candidates) {
    if (!c.doi) continue;
    const prev = byDoi.get(c.doi);
    if (prev === undefined) byDoi.set(c.doi, c.id);
    else link(prev, c.id, "doi", 1);
  }

  // 2. Same citation key (only meaningful across files, but also catches copy-paste within one).
  const byKey = new Map<string, number>();
  for (const c of candidates) {
    const k = c.entry.key.toLowerCase();
    const prev = byKey.get(k);
    if (prev === undefined) byKey.set(k, c.id);
    else link(prev, c.id, "same-key", titleSimilarity(candidates[prev].title, c.title));
  }

  // 3. Title similarity, with arXiv-vs-published pairs called out.
  const sets = candidates.map((c) => new Set(c.title.split(" ")));
  for (const [i, j] of candidatePairs(candidates)) {
    const a = candidates[i];
    const b = candidates[j];
    // Different DOIs on both sides means two distinct publications (e.g. conference + journal version).
    if (a.doi && b.doi && a.doi !== b.doi && !a.arxiv && !b.arxiv) continue;
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

  const groups: DupGroup[] = [];
  for (const [root, members] of byRoot) {
    if (members.length < 2) continue;
    const order: DupReason[] = ["doi", "arxiv-published", "same-title", "similar-title", "same-key"];
    const reasons = order.filter((r) => pairReasons.get(root)?.has(r));
    const similarity = pairSim.get(root) ?? 0;
    const suggested = suggestKeep(members);
    const keyOnly = reasons.length === 1 && reasons[0] === "same-key" && similarity < opts.threshold;
    groups.push({ id: groups.length, members, reasons, similarity, suggested, defaultChoice: keyOnly ? "all" : suggested });
  }

  return { candidates, groups, warnings, extras };
}

/**
 * Pairs of titles that could reach a token Jaccard of 0.5 (titleSimilarity never exceeds the Jaccard
 * below that point). Prefix filtering: order each title's tokens rarest-first; two sets with
 * Jaccard >= 0.5 must share a token within the first |A| - ceil(|A|/2) + 1 tokens. This keeps large
 * bibliographies (thousands of entries) fast without missing any match at thresholds >= 0.5.
 */
function candidatePairs(cands: Candidate[]): [number, number][] {
  const tokens = cands.map((c) => (c.title.length >= 8 ? [...new Set(c.title.split(" "))] : []));
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

/** Prefer the published version, then the entry with most fields, then the first one seen. */
export function suggestKeep(members: Candidate[]): number {
  return [...members].sort((a, b) => Number(a.arxiv) - Number(b.arxiv) || b.fieldCount - a.fieldCount || a.id - b.id)[0].id;
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
  const drop = new Set<number>();
  const renames: { from: string; to: string }[] = [];
  const filled = new Map<number, BibEntry>();

  for (const g of result.groups) {
    const choice = choices[g.id] ?? g.defaultChoice;
    if (choice === "all") continue;
    const keep = g.members.find((m) => m.id === choice) ?? g.members.find((m) => m.id === g.suggested)!;
    let merged: BibEntry | null = null;
    for (const m of g.members) {
      if (m.id === keep.id) continue;
      drop.add(m.id);
      if (m.entry.key !== keep.entry.key && !renames.some((r) => r.from === m.entry.key)) {
        renames.push({ from: m.entry.key, to: keep.entry.key });
      }
      if (opts.fillMissing) {
        merged ??= { ...keep.entry, fields: [...keep.entry.fields] };
        for (const f of m.entry.fields) {
          if (!merged.fields.some((x) => x.name === f.name)) merged.fields.push(f);
        }
      }
    }
    if (merged && merged.fields.length !== keep.entry.fields.length) filled.set(keep.id, merged);
  }

  // The kept entry takes the position of the first member of its group.
  const slot = new Map<number, number>(); // first member id → kept id
  const placed = new Set<number>();
  for (const g of result.groups) {
    const choice = choices[g.id] ?? g.defaultChoice;
    if (choice === "all") continue;
    const keepId = g.members.some((m) => m.id === choice) ? choice : g.suggested;
    slot.set(Math.min(...g.members.map((m) => m.id)), keepId);
  }

  const blocks: string[] = result.extras.map((x) => serializeItem(x));
  let kept = 0;
  for (const c of result.candidates) {
    const id = slot.get(c.id) ?? (drop.has(c.id) || placed.has(c.id) ? undefined : c.id);
    if (id === undefined) continue;
    placed.add(id);
    kept++;
    const f = filled.get(id);
    blocks.push(f ? serializeEntry(f) : result.candidates[id].entry.raw.trim());
  }

  return { output: blocks.length ? blocks.join("\n\n") + "\n" : "", renames, removed: drop.size, kept };
}

/** Plain-text rename map, one "old -> new" per line, for fixing \cite commands. */
export function renameMapText(renames: { from: string; to: string }[]): string {
  return renames.map((r) => `${r.from} -> ${r.to}`).join("\n");
}
