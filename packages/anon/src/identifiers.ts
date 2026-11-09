/** User-supplied identifier list → case-insensitive, line-break-tolerant matchers. Pure. */

export function parseIdentifiers(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let id = rawLine.trim().replace(/^[-*•]\s+/, "").trim();
    if (id.startsWith("@") && !id.includes(" ")) id = id.slice(1); // GitHub/Twitter handle
    id = id.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (id.length < 3) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

const escapeChar = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const isWordChar = (c: string) => /[\p{L}\p{N}_]/u.test(c);

/**
 * Regex source for an identifier: case-insensitive (flag set by caller), any whitespace run (or a LaTeX
 * tie `~`) matches any whitespace incl. line breaks, and a word may be split by an end-of-line hyphen.
 */
export function identifierPattern(id: string): string {
  const chars = [...id.trim()];
  let src = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\s/.test(c)) {
      if (!/\s/.test(chars[i - 1] ?? "")) src += "[\\s~]+";
      continue;
    }
    src += escapeChar(c);
    const next = chars[i + 1];
    if (next && /\p{L}/u.test(c) && /\p{L}/u.test(next)) src += "(?:-\\s+)?";
  }
  const pre = isWordChar(chars[0]) ? "(?<![\\p{L}\\p{N}_])" : "";
  const post = isWordChar(chars[chars.length - 1]) ? "(?![\\p{L}\\p{N}_])" : "";
  return pre + src + post;
}

export function identifierRegex(id: string): RegExp {
  return new RegExp(identifierPattern(id), "giu");
}

export interface TextMatch {
  index: number;
  length: number;
  text: string;
}

export function findAll(text: string, re: RegExp): TextMatch[] {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const g = new RegExp(re.source, flags);
  const out: TextMatch[] = [];
  for (const m of text.matchAll(g)) {
    if (!m[0]) continue;
    out.push({ index: m.index!, length: m[0].length, text: m[0] });
  }
  return out;
}

export function findIdentifier(text: string, id: string): TextMatch[] {
  return findAll(text, identifierRegex(id));
}

/** Collapse whitespace and quote a window around a match. */
export function snippetAround(text: string, index: number, length: number, radius = 60): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/** 1-based line number of `index` in `text`. */
export function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
