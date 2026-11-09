/** A piece of a field value. `a # "b" # c` is three parts. */
export type ValuePart =
  | { type: "literal"; value: string; delim: "brace" | "quote" | "bare" }
  | { type: "macro"; name: string };

export interface BibField {
  /** Lower-cased field name (BibTeX field names are case-insensitive). */
  name: string;
  value: ValuePart[];
}

export interface BibEntry {
  kind: "entry";
  /** Lower-cased entry type, e.g. "article". */
  type: string;
  key: string;
  fields: BibField[];
  /** Original source text of the entry. */
  raw: string;
  /** 1-based line where the entry starts. */
  line: number;
}

export interface BibStringDef {
  kind: "string";
  name: string;
  value: ValuePart[];
  raw: string;
  line: number;
}

export interface BibPreamble {
  kind: "preamble";
  value: ValuePart[];
  raw: string;
  line: number;
}

/** `@comment{...}` blocks and free text between entries (which BibTeX ignores). */
export interface BibComment {
  kind: "comment";
  text: string;
  /** true for an explicit @comment block, false for stray text between entries. */
  explicit: boolean;
  raw: string;
  line: number;
}

/**
 * A block the parser could not read (for example a missing comma between fields). Kept so tools can
 * copy it to their output unchanged instead of silently dropping an entry; a ParseWarning explains why.
 */
export interface BibUnparsed {
  kind: "unparsed";
  /** Original source text, trimmed. */
  raw: string;
  message: string;
  line: number;
}

export type BibItem = BibEntry | BibStringDef | BibPreamble | BibComment | BibUnparsed;

export interface ParseWarning {
  line: number;
  message: string;
  /** The unreadable source chunk (trimmed, possibly truncated). It is kept verbatim as a BibUnparsed item. */
  raw: string;
}

export interface BibFile {
  items: BibItem[];
  warnings: ParseWarning[];
}
