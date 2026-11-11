import { splitNames, splitTopLevel } from "./text";

export interface PersonName {
  first: string;
  von: string;
  last: string;
  jr: string;
}

const SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv)$/i;

/** True when a token starts lower-case (BibTeX's "von" rule), ignoring leading braces/accents. */
function isLowerToken(tok: string): boolean {
  if (tok.startsWith("{")) return false; // braced tokens are treated as upper-case words
  const stripped = tok.replace(/\\[a-zA-Z]+|\\./g, "");
  const letter = Array.from(stripped).find((ch) => ch.toLowerCase() !== ch.toUpperCase());
  return letter !== undefined && letter === letter.toLowerCase();
}

/** Split on top-level commas, keeping empty parts (", Lucas" is an empty last name, not "Lucas"). */
function splitCommas(name: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of name) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Parse one BibTeX name in any of the forms "First von Last", "von Last, First", "von Last, Jr, First". */
export function parseName(raw: string): PersonName {
  const name = raw.trim().replace(/\s+/g, " ");
  const parts = splitCommas(name);

  if (parts.length >= 2) {
    const head = splitTopLevel(parts[0]);
    let i = 0;
    while (i < head.length - 1 && isLowerToken(head[i])) i++;
    return {
      von: head.slice(0, i).join(" "),
      last: head.slice(i).join(" "),
      jr: parts.length >= 3 ? parts[1] : "",
      first: parts.length >= 3 ? parts.slice(2).join(", ") : parts[1],
    };
  }

  const toks = splitTopLevel(name);
  if (toks.length <= 1) return { first: "", von: "", last: toks[0] ?? "", jr: "" };
  let jr = "";
  if (toks.length > 2 && SUFFIX.test(toks[toks.length - 1])) jr = toks.pop()!;
  // von part: first lower-case token (not the last word) up to the last lower-case token.
  const lastIdx = toks.length - 1;
  let vonStart = -1;
  let vonEnd = -1;
  for (let i = 1; i < lastIdx; i++) {
    if (isLowerToken(toks[i])) {
      if (vonStart < 0) vonStart = i;
      vonEnd = i;
    }
  }
  if (vonStart >= 0) {
    return { first: toks.slice(0, vonStart).join(" "), von: toks.slice(vonStart, vonEnd + 1).join(" "), last: toks.slice(vonEnd + 1).join(" "), jr };
  }
  return { first: toks.slice(0, lastIdx).join(" "), von: "", last: toks[lastIdx], jr };
}

export function formatName(n: PersonName): string {
  const last = [n.von, n.last].filter(Boolean).join(" ");
  if (!n.first && !n.jr) return last;
  return [last, n.jr, n.first].filter(Boolean).join(", ");
}

/** Normalize an author/editor list to "Last, First and Last, First"; keeps "others" and {Corporate Names}. */
export function normalizeNameList(value: string): string {
  return splitNames(value)
    .map((n) => {
      // "et al." typed as a name is BibTeX's "others" (styles then print "et al." themselves).
      if (n.toLowerCase() === "others" || /^et\.?\s*al\.?$/i.test(n)) return "others";
      const p = parseName(n);
      // Malformed names (", Lucas", "Smith, Jr.,") cannot be rewritten without guessing: keep them as typed.
      if (!p.last || (p.jr && !p.first)) return n;
      // "The pandas development team, " (DataCite): a several-word last name with no first name. Without
      // the comma BibTeX would read "team" as the last name, so keep the words together in braces.
      if (!p.first && !p.jr && splitCommas(n.trim()).length > 1 && splitTopLevel(p.last).length > 1) {
        return [p.von, `{${p.last}}`].filter(Boolean).join(" ");
      }
      return formatName(p);
    })
    .join(" and ");
}
