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

export type BibItem = BibEntry | BibStringDef | BibPreamble | BibComment;

export interface ParseWarning {
  line: number;
  message: string;
  /** The skipped source chunk (trimmed, possibly truncated). */
  raw: string;
}

export interface BibFile {
  items: BibItem[];
  warnings: ParseWarning[];
}
