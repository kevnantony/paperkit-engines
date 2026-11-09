import type { BibEntry, BibItem, ValuePart } from "./types";

export function serializeValue(parts: ValuePart[]): string {
  return parts
    .map((p) => {
      if (p.type === "macro") return p.name;
      if (p.delim === "bare" && /^[0-9]+$/.test(p.value)) return p.value;
      return `{${p.value}}`;
    })
    .join(" # ");
}

export interface SerializeOptions {
  /** Indentation before each field. Default two spaces. */
  indent?: string;
}

export function serializeEntry(entry: BibEntry, opts: SerializeOptions = {}): string {
  const indent = opts.indent ?? "  ";
  const lines = entry.fields.map((f) => `${indent}${f.name} = ${serializeValue(f.value)},`);
  return `@${entry.type}{${entry.key}${lines.length ? ",\n" + lines.join("\n") + "\n" : ""}}`;
}

export function serializeItem(item: BibItem, opts: SerializeOptions = {}): string {
  switch (item.kind) {
    case "entry":
      return serializeEntry(item, opts);
    case "string":
      return `@string{${item.name} = ${serializeValue(item.value)}}`;
    case "preamble":
      return `@preamble{${serializeValue(item.value)}}`;
    case "comment":
      return item.explicit ? `@comment{${item.text}}` : item.text;
    case "unparsed":
      return item.raw;
  }
}

/** Serialize a list of items separated by blank lines, ending with a newline. */
export function serializeBibtex(items: BibItem[], opts: SerializeOptions = {}): string {
  if (!items.length) return "";
  return items.map((i) => serializeItem(i, opts)).join("\n\n") + "\n";
}
