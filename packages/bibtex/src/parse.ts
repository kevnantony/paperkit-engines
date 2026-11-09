import type { BibEntry, BibField, BibFile, BibItem, ParseWarning, ValuePart } from "./types";

class ParseError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
  }
}

const IDENT = /[^\s"#%'(),={}]/;
/** A line that starts a new `@type{` / `@type(` block. Used to recover from malformed entries. */
const BLOCK_START = /@[a-zA-Z][\w-]*\s*[{(]/g;
const ENTRY_START = /\n[ \t]*@[a-zA-Z]+[ \t]*[{(]/g;

/**
 * Parse BibTeX source. Never throws: a block it cannot understand is kept verbatim as an "unparsed" item,
 * reported in `warnings`, and parsing resumes at the next line that starts with `@`.
 */
export function parseBibtex(src: string): BibFile {
  const text = src.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const items: BibItem[] = [];
  const warnings: ParseWarning[] = [];
  const lineAt = makeLineIndex(text);
  let pos = 0;

  while (pos < text.length) {
    BLOCK_START.lastIndex = pos;
    const m = BLOCK_START.exec(text);
    const at = m ? m.index : -1;
    const stray = text.slice(pos, at === -1 ? text.length : at);
    if (stray.trim()) {
      items.push({ kind: "comment", text: stray.trim(), explicit: false, raw: stray, line: lineAt(pos + stray.search(/\S/)) });
    }
    if (at === -1) break;

    try {
      const { item, end } = parseBlock(text, at, lineAt);
      if (item) {
        if (item.kind === "entry") {
          const seen = new Set<string>();
          for (const f of item.fields) {
            if (seen.has(f.name)) {
              warnings.push({ line: item.line, message: `Duplicate field "${f.name}" in ${item.key || "entry"}; kept the first one`, raw: "" });
            }
            seen.add(f.name);
          }
          item.fields = item.fields.filter((f, i, arr) => arr.findIndex((g) => g.name === f.name) === i);
        }
        items.push(item);
      }
      pos = end;
    } catch (e) {
      const err = e instanceof ParseError ? e : new ParseError(String(e), at);
      ENTRY_START.lastIndex = at + 1;
      const next = ENTRY_START.exec(text);
      const end = next ? next.index + 1 : text.length;
      const raw = text.slice(at, end).trim();
      const message = `${err.message} (line ${lineAt(err.pos)}); copied unchanged`;
      items.push({ kind: "unparsed", raw, message, line: lineAt(at) });
      warnings.push({ line: lineAt(at), message, raw: truncate(raw, 400) });
      pos = end;
    }
  }

  return { items, warnings };
}

function parseBlock(text: string, at: number, lineAt: (p: number) => number): { item: BibItem | null; end: number } {
  let p = at + 1;
  const typeMatch = /^[a-zA-Z][\w-]*/.exec(text.slice(p, p + 64));
  if (!typeMatch) throw new ParseError("Expected an entry type after @", p);
  const type = typeMatch[0].toLowerCase();
  p += typeMatch[0].length;
  p = skipWs(text, p);
  const open = text[p];
  if (open !== "{" && open !== "(") throw new ParseError(`Expected "{" after @${typeMatch[0]}`, p);
  const close = open === "{" ? "}" : ")";
  p++;

  if (type === "comment") {
    // @comment swallows a balanced block.
    const end = matchBalanced(text, p - 1, open, close);
    const body = text.slice(p, end);
    return { item: { kind: "comment", text: body.trim(), explicit: true, raw: text.slice(at, end + 1), line: lineAt(at) }, end: end + 1 };
  }

  if (type === "preamble") {
    p = skipWs(text, p);
    const { parts, end } = parseValue(text, p);
    p = skipWs(text, end);
    if (text[p] !== close) throw new ParseError(`Expected "${close}" to close @preamble`, p);
    return { item: { kind: "preamble", value: parts, raw: text.slice(at, p + 1), line: lineAt(at) }, end: p + 1 };
  }

  if (type === "string") {
    p = skipWs(text, p);
    const name = readIdent(text, p);
    if (!name) throw new ParseError("Expected a macro name in @string", p);
    p = skipWs(text, p + name.length);
    if (text[p] !== "=") throw new ParseError(`Expected "=" after @string name "${name}"`, p);
    p = skipWs(text, p + 1);
    const { parts, end } = parseValue(text, p);
    p = skipWs(text, end);
    if (text[p] === ",") p = skipWs(text, p + 1);
    if (text[p] !== close) throw new ParseError(`Expected "${close}" to close @string`, p);
    return { item: { kind: "string", name: name.toLowerCase(), value: parts, raw: text.slice(at, p + 1), line: lineAt(at) }, end: p + 1 };
  }

  // Regular entry: key, then fields.
  p = skipWs(text, p);
  let keyEnd = p;
  while (keyEnd < text.length && !/[\s,]/.test(text[keyEnd]) && text[keyEnd] !== close) {
    if (text[keyEnd] === "=" || text[keyEnd] === "{" || text[keyEnd] === "@") throw new ParseError("Missing citation key", p);
    keyEnd++;
  }
  const key = text.slice(p, keyEnd);
  if (!key) throw new ParseError("Missing citation key", p);
  p = skipWsAndComments(text, keyEnd);
  const fields: BibField[] = [];
  if (text[p] === ",") p++;
  else if (text[p] !== close) throw new ParseError(`Expected "," after key "${key}"`, p);

  for (;;) {
    p = skipWsAndComments(text, p);
    if (p >= text.length) throw new ParseError(`Unexpected end of file inside "${key}"`, p);
    if (text[p] === close) {
      p++;
      break;
    }
    const name = readIdent(text, p);
    if (!name) throw new ParseError(`Expected a field name in "${key}"`, p);
    p = skipWs(text, p + name.length);
    if (text[p] !== "=") throw new ParseError(`Expected "=" after field "${name}" in "${key}"`, p);
    p = skipWs(text, p + 1);
    const { parts, end } = parseValue(text, p);
    fields.push({ name: name.toLowerCase(), value: parts });
    p = skipWsAndComments(text, end);
    if (text[p] === ",") {
      p++;
      continue;
    }
    if (text[p] === close) {
      p++;
      break;
    }
    // A braced value that swallowed following fields almost always means a missing closing brace.
    const swallowed = parts.some((x) => x.type === "literal" && /,\s*\n\s*[a-zA-Z][\w-]*\s*=/.test(x.value));
    if (swallowed) throw new ParseError(`Unbalanced braces in field "${name}" of "${key}"`, p);
    throw new ParseError(`Expected "," or "${close}" after field "${name}" in "${key}"`, p);
  }

  const entry: BibEntry = { kind: "entry", type, key, fields, raw: text.slice(at, p), line: lineAt(at) };
  return { item: entry, end: p };
}

function parseValue(text: string, start: number): { parts: ValuePart[]; end: number } {
  const parts: ValuePart[] = [];
  let p = start;
  for (;;) {
    p = skipWs(text, p);
    const c = text[p];
    if (c === "{") {
      const end = matchBalanced(text, p, "{", "}", true);
      parts.push({ type: "literal", value: text.slice(p + 1, end), delim: "brace" });
      p = end + 1;
    } else if (c === '"') {
      let depth = 0;
      let q = p + 1;
      for (; q < text.length; q++) {
        const ch = text[q];
        if (ch === "\\") {
          q++;
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        else if (ch === '"' && depth === 0) break;
        else if (ch === "\n" && depth >= 0 && startsEntry(text, q)) throw new ParseError("Unterminated quoted value", p);
      }
      if (q >= text.length) throw new ParseError("Unterminated quoted value", p);
      parts.push({ type: "literal", value: text.slice(p + 1, q), delim: "quote" });
      p = q + 1;
    } else if (c !== undefined && /[0-9]/.test(c)) {
      const m = /^[0-9]+/.exec(text.slice(p, p + 32))!;
      parts.push({ type: "literal", value: m[0], delim: "bare" });
      p += m[0].length;
    } else {
      const name = readIdent(text, p);
      if (!name) throw new ParseError("Expected a value", p);
      parts.push({ type: "macro", name: name.toLowerCase() });
      p += name.length;
    }
    const after = skipWs(text, p);
    if (text[after] === "#") {
      p = after + 1;
      continue;
    }
    return { parts, end: p };
  }
}

/** Index of the brace/paren matching the opener at `start`. */
function matchBalanced(text: string, start: number, open: string, close: string, guard = false): number {
  let depth = 0;
  for (let q = start; q < text.length; q++) {
    const ch = text[q];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return q;
    } else if (guard && ch === "\n" && startsEntry(text, q)) {
      throw new ParseError("Unbalanced braces", start);
    }
  }
  throw new ParseError(open === "{" ? "Unbalanced braces" : `Missing "${close}"`, start);
}

/** True when the line after the newline at `nl` looks like the start of a new entry. */
function startsEntry(text: string, nl: number): boolean {
  return /^[ \t]*@[a-zA-Z]+[ \t]*[{(]/.test(text.slice(nl + 1, nl + 64));
}

function readIdent(text: string, p: number): string {
  let q = p;
  while (q < text.length && IDENT.test(text[q])) q++;
  return text.slice(p, q);
}

function skipWs(text: string, p: number): number {
  while (p < text.length && /\s/.test(text[p])) p++;
  return p;
}

/**
 * Like skipWs, but also skips `%` comments up to the end of the line. Only used between fields of an
 * entry, never inside braced or quoted values, so `50\%` and `{a % b}` are untouched. `%` can never
 * start a field name, so this cannot hide a real field.
 */
function skipWsAndComments(text: string, p: number): number {
  for (;;) {
    p = skipWs(text, p);
    if (text[p] !== "%") return p;
    const nl = text.indexOf("\n", p);
    p = nl === -1 ? text.length : nl + 1;
  }
}

function makeLineIndex(text: string): (pos: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (pos: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Convenience: just the entries. */
export function entriesOf(file: BibFile): BibEntry[] {
  return file.items.filter((i): i is BibEntry => i.kind === "entry");
}
