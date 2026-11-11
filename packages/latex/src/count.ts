/**
 * texcount-style word counting for LaTeX sources. Pure, no DOM.
 *
 * Counted: running text, section headers, float captions, footnotes.
 * Excluded: commands and their non-text arguments, inline/display math, comments,
 * float bodies (except captions), verbatim-like environments and the bibliography.
 */

import { findCommentStart } from "@paperkit-latex/arxiv";

export type Bucket = "text" | "headers" | "captions" | "footnotes";

export interface SectionCount {
  title: string;
  level: "front" | "part" | "chapter" | "section" | "subsection";
  text: number;
  headers: number;
  captions: number;
  footnotes: number;
}

export interface CountResult {
  sections: SectionCount[];
  totals: { text: number; headers: number; captions: number; footnotes: number; all: number };
  abstract: number;
  /** Inline formulas and display equations (counted, not as words). */
  inlineMath: number;
  displayMath: number;
  /** Files pulled in via \input / \include, and ones that could not be found. */
  included: string[];
  missing: string[];
}

export interface CountOptions {
  /** Other project files by path (for \input / \include resolution). */
  files?: Record<string, string>;
  /** Path of the main file inside `files`, used to resolve relative includes. */
  mainPath?: string;
  /** Count text after \appendix (default true). */
  includeAppendix?: boolean;
}

/* ---------------- comments & includes ---------------- */

/**
 * Remove `%` comments (not `\%`) to end of line, keeping the newline. A `%` inside `\verb|..|`, `\url{..}`,
 * `\path{..}` or the URL of `\href{..}{..}` is literal and kept (shared rules with the arXiv Cleaner).
 */
export function stripComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const cut = findCommentStart(line);
      return cut < 0 ? line : line.slice(0, cut);
    })
    .join("\n");
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i + 1) : "";
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function findFile(files: Record<string, string>, name: string, baseDirs: string[]): string | null {
  const keys = Object.keys(files);
  const byNorm = new Map(keys.map((k) => [normalizePath(k), k]));
  const candidates = [...baseDirs.map((b) => b + name), name].flatMap((c) => [c, c + ".tex"]).map(normalizePath);
  for (const c of candidates) {
    const hit = byNorm.get(c);
    if (hit !== undefined) return hit;
  }
  // Fall back to a unique suffix match (zips often wrap everything in a top folder).
  const tail = normalizePath(name);
  const suffix = keys.filter((k) => {
    const n = normalizePath(k);
    return n.endsWith("/" + tail) || n.endsWith("/" + tail + ".tex");
  });
  return suffix.length === 1 ? suffix[0] : null;
}

/** Inline \input / \include / \subfile / \import recursively. Comments are stripped first so commented-out includes are ignored. */
export function resolveIncludes(
  src: string,
  files: Record<string, string>,
  mainPath = "",
): { text: string; included: string[]; missing: string[] } {
  const included: string[] = [];
  const missing: string[] = [];
  const visit = (text: string, path: string, depth: number, stack: string[]): string => {
    const body = stripComments(text);
    if (depth > 20) return body;
    return body.replace(
      /\\(input|include|subfile|import|subimport)\*?\s*(?:\{([^{}]*)\}\s*)?\{([^{}]+)\}/g,
      (match, cmd: string, dirArg: string | undefined, nameArg: string) => {
        if ((cmd === "import" || cmd === "subimport") && dirArg === undefined) return match;
        if (cmd !== "import" && cmd !== "subimport" && dirArg !== undefined) return match;
        const name = nameArg.trim();
        // LaTeX resolves \input relative to the main file's directory; the including file's folder is a lenient fallback.
        const bases =
          cmd === "subimport"
            ? [dirname(path) + (dirArg ?? "")]
            : cmd === "import"
              ? [dirArg ?? ""]
              : [dirname(mainPath), dirname(path)];
        const hit = findFile(files, name, bases);
        if (!hit) {
          if (!/\.(bbl|sty|cls|bib|tikz|pgf|pdf_tex)$/i.test(name)) missing.push(name);
          return " ";
        }
        if (stack.includes(hit)) return " ";
        if (!included.includes(hit)) included.push(hit);
        const sep = cmd === "include" ? "\n\n" : " ";
        return sep + visit(files[hit], hit, depth + 1, [...stack, hit]) + sep;
      },
    );
  };
  return { text: visit(src, mainPath, 0, [mainPath]), included, missing };
}

/* ---------------- tables of commands & environments ---------------- */

const MATH_ENVS = new Set([
  "equation", "align", "gather", "multline", "flalign", "alignat", "eqnarray", "displaymath", "math", "dmath", "subequations",
]);
/** Environments whose body is skipped except for \caption. */
const FLOAT_ENVS = new Set([
  "figure", "table", "algorithm", "wrapfigure", "wraptable", "subfigure", "subtable", "sidewaysfigure", "sidewaystable", "listing", "SCfigure", "SCtable", "floatrow",
]);
/** Environments skipped entirely. */
const SKIP_ENVS = new Set([
  "verbatim", "Verbatim", "lstlisting", "minted", "comment", "tikzpicture", "pgfpicture", "picture", "thebibliography", "filecontents",
  "tabular", "tabularx", "tabulary", "longtable", "tabu", "array", "algorithmic", "algorithm2e", "forest", "axis", "references",
]);
/** Number of mandatory args to drop after \begin{env}. */
const ENV_ARGS: Record<string, number> = { minipage: 1, multicols: 1, "multicols*": 1, wrapfigure: 2, wraptable: 2, subfigure: 1, subtable: 1, adjustbox: 1, list: 2 };

const HEADER_CMDS: Record<string, SectionCount["level"] | "inline"> = {
  part: "part",
  chapter: "chapter",
  section: "section",
  subsection: "subsection",
  subsubsection: "inline",
  paragraph: "inline",
  subparagraph: "inline",
};

/** Commands whose arguments are not text: number of mandatory args to drop (optional [..] args always dropped). */
const DROP_ARGS: Record<string, number> = {
  label: 1, ref: 1, eqref: 1, pageref: 1, autoref: 1, cref: 1, Cref: 1, nameref: 1, vref: 1,
  cite: 1, citep: 1, citet: 1, citealp: 1, citealt: 1, citeauthor: 1, citeyear: 1, parencite: 1, textcite: 1, autocite: 1, nocite: 1, footcite: 1,
  url: 1, includegraphics: 1, input: 1, include: 1, bibliography: 1, bibliographystyle: 1, usepackage: 1, documentclass: 1,
  vspace: 1, hspace: 1, "vspace*": 1, "hspace*": 1, setlength: 2, addtolength: 2, setcounter: 2, addtocounter: 2, newcounter: 1,
  newcommand: 2, renewcommand: 2, providecommand: 2, DeclareMathOperator: 2, newenvironment: 3, renewenvironment: 3, newtheorem: 2,
  def: 0, let: 0, color: 1, pagecolor: 1, definecolor: 3, hypersetup: 1, graphicspath: 1, sisetup: 1, captionsetup: 1,
  addbibresource: 1, pagestyle: 1, thispagestyle: 1, pagenumbering: 1, linespread: 1, fontsize: 2, selectfont: 0,
  todo: 1, SI: 2, si: 1, num: 1, ang: 1, qty: 2, unit: 1, ensuremath: 1, raisebox: 1, rule: 2, phantom: 1, hphantom: 1, vphantom: 1,
  bibitem: 1, printbibliography: 0, maketitle: 0, tableofcontents: 0, author: 1, date: 1, thanks: 1, affiliation: 1, institute: 1,
  email: 1, address: 1, keywords: 0, acmConference: 0, setcopyright: 1, copyrightyear: 1, acmYear: 1, acmDOI: 1, acmISBN: 1,
  orcid: 1, icmltitlerunning: 1, icmlauthor: 2, icmlaffiliation: 2, icmlcorrespondingauthor: 2, icmlkeywords: 1, runningtitle: 1,
  resizebox: 2, scalebox: 1, adjustbox: 1, includepdf: 1, lstinputlisting: 1, inputminted: 2, subfile: 1, import: 2, subimport: 2,
  newpage: 0, clearpage: 0, cleardoublepage: 0, noindent: 0, centering: 0, appendix: 0, item: 0, hline: 0, toprule: 0, midrule: 0, bottomrule: 0,
};

/** Commands whose last argument is text in the current bucket; earlier mandatory args are dropped. */
const TEXT_ARGS: Record<string, number> = {
  textbf: 1, textit: 1, emph: 1, textsc: 1, texttt: 1, textsf: 1, textrm: 1, textup: 1, textsl: 1, textmd: 1, textnormal: 1,
  underline: 1, uline: 1, mbox: 1, hbox: 1, text: 1, textcolor: 2, colorbox: 2, fbox: 1, framebox: 1, makebox: 1, parbox: 2,
  href: 2, hyperref: 1, hyperlink: 2, emph_: 1, enquote: 1, foreignlanguage: 2, textsuperscript: 1, textsubscript: 1, MakeUppercase: 1,
  MakeLowercase: 1, uppercase: 1, lowercase: 1, highlight: 1, hl: 1, st: 1, sout: 1, marginpar: 1, centerline: 1, ul: 1,
};

/* ---------------- low-level scanning helpers ---------------- */

/** Index after the group that starts at `i` (which must be `{` or `[`); balanced, honours escapes. */
function skipGroup(s: string, i: number): number {
  const open = s[i];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "{" && open === "[") {
      j = skipGroup(s, j) - 1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return s.length;
}

function skipSpaces(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t" || (s[i] === "\n" && s[i + 1] !== "\n"))) i++;
  return i;
}

/** Skip any number of optional [..] arguments. */
function skipOptionals(s: string, i: number): number {
  let j = skipSpaces(s, i);
  while (s[j] === "[") j = skipSpaces(s, skipGroup(s, j));
  return j;
}

/** Read a mandatory argument starting at i (after spaces). Returns [content, endIndex] or null. */
function readArg(s: string, i: number): [string, number] | null {
  const j = skipSpaces(s, i);
  if (s[j] === "{") {
    const end = skipGroup(s, j);
    return [s.slice(j + 1, end - 1), end];
  }
  if (s[j] === "\\") {
    const m = /^\\([a-zA-Z@]+|.)/.exec(s.slice(j));
    if (m) return [m[0], j + m[0].length];
  }
  if (j < s.length && s[j] !== "}") return [s[j], j + 1];
  return null;
}

/** Find the matching \end{env} for a \begin{env} whose body starts at i. Returns [bodyEnd, afterEnd]. */
function findEnvEnd(s: string, i: number, env: string): [number, number] {
  const esc = env.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\\\(begin|end)\\s*\\{${esc}\\}`, "g");
  re.lastIndex = i;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    depth += m[1] === "begin" ? 1 : -1;
    if (depth === 0) return [m.index, m.index + m[0].length];
  }
  return [s.length, s.length];
}

/** Replace accent macros (\'e, \"{o}, \c{c}) and a few ligature macros with plain letters so words stay whole. */
function normalizeAccents(s: string): string {
  return s
    .replace(/\\(['"`^~=.Hcvuk])\s*\{\s*\\?([a-zA-Z])\s*\}/g, "$2")
    .replace(/\\(['"`^~=.])\s*\\?([a-zA-Z])/g, "$2")
    .replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i|j)(?![a-zA-Z])\s?(\{\})?/g, (_m, c: string) => c)
    .replace(/\\-/g, "");
}

/** Readable section title: drop labels/refs/citations, command names and braces; keep inline math as written. */
function plainTitle(s: string): string {
  const cleanText = (t: string) =>
    t
      .replace(/\\(label|cite[a-z]*|ref|eqref|footnote|thanks)\*?\s*(\[[^\]]*\])?\s*\{[^{}]*\}/g, "")
      .replace(/\\(?!\$)[a-zA-Z@]+\*?/g, "")
      .replace(/[{}~]/g, " ");
  // Math ($..$, \(..\)) is kept exactly as written; commands and braces are dropped only from the text around it.
  const parts = texorpdf(s, 1).split(/(\$[^$]*\$|\\\([\s\S]*?\\\))/);
  return parts
    .map((p, i) => (i % 2 ? p : cleanText(p)))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Replace `\texorpdfstring{tex}{plain}` by one of its arguments (0: the typeset TeX, 1: the plain-text form). */
function texorpdf(s: string, keep: 0 | 1): string {
  const re = /\\texorpdfstring\s*\{/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const a = m.index + m[0].length - 1;
    const aEnd = skipGroup(s, a);
    const b = skipSpaces(s, aEnd);
    if (s[b] !== "{") continue;
    const bEnd = skipGroup(s, b);
    const pick = keep === 0 ? s.slice(a, aEnd) : s.slice(b, bEnd);
    out += s.slice(last, m.index) + pick;
    last = bEnd;
    re.lastIndex = bEnd;
  }
  return out + s.slice(last);
}

/* ---------------- user text macros ---------------- */

/** Commands allowed in the body of a macro we expand: text styling, spacing and font switches. */
const SAFE_IN_MACRO = new Set([...Object.keys(TEXT_ARGS), "xspace", "@", "sc", "bf", "it", "em", "rm", "tt", "sf", "scshape", "bfseries", "itshape", "upshape", "normalfont", "small", "footnotesize", "relax", "ignorespaces"]);
const RESERVED_MACROS = new Set([...Object.keys(DROP_ARGS), ...Object.keys(HEADER_CMDS), "caption", "footnote", "begin", "end", "title", "abstract", "item"]);

/**
 * Argument-free macros whose body is plain text, e.g. `\newcommand\bert{BERT\xspace}` or `\def\ours{\textsc{Ours}}`.
 * Method names defined this way are used all over ML papers; without expansion every use counted zero words.
 * Bodies with math (`$ _ ^`), parameters or unknown commands are left alone.
 */
export function collectTextMacros(src: string): Map<string, string> {
  const macros = new Map<string, string>();
  const re = /\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand)\*?\s*(?:\{\s*\\([a-zA-Z@]+)\s*\}|\\([a-zA-Z@]+))\s*\{|\\(?:g|e|x)?def\s*\\([a-zA-Z@]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1] ?? m[2] ?? m[3];
    const open = m.index + m[0].length - 1;
    const end = skipGroup(src, open);
    const body = src.slice(open + 1, end - 1);
    re.lastIndex = end;
    if (RESERVED_MACROS.has(name) || /[#$_^&%]|\\\\/.test(body)) continue;
    const cmds = [...body.matchAll(/\\([a-zA-Z@]+)/g)].map((c) => c[1]);
    if (!cmds.every((c) => SAFE_IN_MACRO.has(c) || macros.has(c))) continue;
    macros.set(name, body.replace(/\\xspace(?![a-zA-Z@])/g, ""));
  }
  return macros;
}

export function expandTextMacros(src: string, macros: Map<string, string>): string {
  if (!macros.size) return src;
  const names = [...macros.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`\\\\(${names.join("|")})(?![a-zA-Z@])(\\{\\})?`, "g");
  let out = src;
  for (let pass = 0; pass < 3; pass++) {
    const next = out.replace(re, (_m, name: string) => `{${macros.get(name)}}`);
    if (next === out) break;
    out = next;
  }
  return out;
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’\-.][\p{L}\p{N}]+|(?<=\p{N}),\p{N}{3}(?!\p{N}))*/gu;

export function countWordsInText(s: string): number {
  return s.match(WORD_RE)?.length ?? 0;
}

/* ---------------- main walker ---------------- */

export function countLatex(source: string, options: CountOptions = {}): CountResult {
  const { includeAppendix = true } = options;
  const resolved = resolveIncludes(source, options.files ?? {}, options.mainPath ?? "");
  let src = normalizeAccents(resolved.text);

  const sections: { meta: SectionCount; chunks: Record<Bucket, string[]> }[] = [];
  const newSection = (title: string, level: SectionCount["level"]) => {
    sections.push({
      meta: { title, level, text: 0, headers: 0, captions: 0, footnotes: 0 },
      chunks: { text: [], headers: [], captions: [], footnotes: [] },
    });
  };
  newSection("Front matter", "front");
  const abstractChunks: string[] = [];
  let abstractDepth = 0;
  let inlineMath = 0;
  let displayMath = 0;

  const emit = (bucket: Bucket, t: string) => {
    sections[sections.length - 1].chunks[bucket].push(t);
    // The abstract count is its running text only (a footnote inside the abstract is not part of it).
    if (abstractDepth > 0 && bucket === "text") abstractChunks.push(t);
  };

  const macros = collectTextMacros(src);

  // Title (often in the preamble) counts as a header of the front matter.
  const titleMatch = /\\title\s*(?:\[[^\]]*\])?\s*\{/.exec(src);
  let titleText = "";
  if (titleMatch) {
    const start = titleMatch.index + titleMatch[0].length - 1;
    titleText = expandTextMacros(src.slice(start + 1, skipGroup(src, start) - 1), macros);
  }

  // Restrict to the document body when there is one.
  const begin = /\\begin\s*\{document\}/.exec(src);
  if (begin) {
    const endDoc = src.indexOf("\\end{document}", begin.index);
    const preamble = src.slice(0, begin.index);
    src = src.slice(begin.index + begin[0].length, endDoc >= 0 ? endDoc : undefined);
    // JCAP/JHEP-style classes take \abstract{...} in the preamble; count it as if it opened the body.
    const pre = /\\abstract\s*\{/.exec(preamble);
    if (pre && !/\\begin\s*\{abstract\}|\\abstract\s*\{/.test(src)) {
      const open = pre.index + pre[0].length - 1;
      src = `\\abstract{${preamble.slice(open + 1, skipGroup(preamble, open) - 1)}}\n${src}`;
    }
  } else {
    // Snippet: drop a preamble if pasted without \begin{document}.
    src = src.replace(/\\documentclass[\s\S]*?(?=\\section|\\chapter|\\begin\{abstract\}|$)/, "");
  }
  src = expandTextMacros(src, macros);
  if (!includeAppendix) {
    const app = src.search(/\\appendix(?![a-zA-Z])|\\begin\s*\{appendices\}/);
    if (app >= 0) src = src.slice(0, app);
  }

  if (titleText) {
    walk(titleText, "headers");
    emit("headers", " ");
  }
  // \title in the body was already counted above.
  walk(src, "text");

  function walk(s: string, bucket: Bucket): void {
    let i = 0;
    let buf = "";
    const flush = () => {
      if (buf) emit(bucket, buf);
      buf = "";
    };
    const sep = () => {
      buf += " ";
    };
    while (i < s.length) {
      const ch = s[i];
      if (ch === "$") {
        flush();
        if (s[i + 1] === "$") {
          const end = s.indexOf("$$", i + 2);
          i = end < 0 ? s.length : end + 2;
          displayMath++;
        } else {
          let j = i + 1;
          while (j < s.length && !(s[j] === "$" && s[j - 1] !== "\\")) j++;
          i = j + 1;
          inlineMath++;
        }
        sep();
        continue;
      }
      if (ch === "{" || ch === "}") {
        i++;
        continue;
      }
      if (ch === "&" || ch === "~") {
        buf += " ";
        i++;
        continue;
      }
      if (ch !== "\\") {
        buf += ch;
        i++;
        continue;
      }
      // Backslash: control symbol or control word.
      const next = s[i + 1];
      if (next === "(" || next === "[") {
        flush();
        const close = next === "(" ? "\\)" : "\\]";
        const end = s.indexOf(close, i + 2);
        i = end < 0 ? s.length : end + 2;
        if (next === "(") inlineMath++;
        else displayMath++;
        sep();
        continue;
      }
      if (next === "\\") {
        i = skipOptionals(s, i + 2);
        sep();
        continue;
      }
      if (next === undefined || !/[a-zA-Z@]/.test(next)) {
        // \%, \&, \_, \#, \$, \, \; \! etc.: punctuation or spacing, never a word.
        if (next === "," || next === ";" || next === "!" || next === " " || next === ":") buf += " ";
        i += 2;
        continue;
      }
      const m = /^[a-zA-Z@]+\*?/.exec(s.slice(i + 1));
      const name = m ? m[0] : "";
      let j = i + 1 + name.length;
      const base = name.replace(/\*$/, "");

      if (base === "verb" || base === "Verb" || base === "lstinline" || base === "mintinline") {
        let k = s[j] === "[" ? skipGroup(s, j) : j;
        if (base === "mintinline" && s[k] === "{") k = skipGroup(s, k); // language argument
        const delim = s[k] === "{" ? "}" : s[k];
        const end = s.indexOf(delim, k + 1);
        i = end < 0 ? s.length : end + 1;
        sep();
        continue;
      }

      if (base === "begin" || base === "end") {
        const arg = readArg(s, j);
        if (!arg) {
          i = j;
          continue;
        }
        const env = arg[0].trim();
        const envBase = env.replace(/\*$/, "");
        j = arg[1];
        if (base === "end") {
          i = j;
          sep();
          continue;
        }
        flush();
        if (MATH_ENVS.has(envBase)) {
          const [, after] = findEnvEnd(s, j, env);
          displayMath++;
          i = after;
        } else if (FLOAT_ENVS.has(envBase)) {
          const [bodyEnd, after] = findEnvEnd(s, j, env);
          walkCaptions(s.slice(j, bodyEnd));
          i = after;
        } else if (SKIP_ENVS.has(envBase)) {
          const [, after] = findEnvEnd(s, j, env);
          i = after;
        } else if (envBase === "abstract") {
          const [bodyEnd, after] = findEnvEnd(s, j, env);
          abstractDepth++;
          walk(s.slice(skipOptionals(s, j), bodyEnd), bucket);
          emit(bucket, " ");
          abstractDepth--;
          i = after;
        } else {
          j = skipOptionals(s, j);
          for (let a = 0; a < (ENV_ARGS[env] ?? 0); a++) {
            const r = readArg(s, j);
            if (r) j = skipOptionals(s, r[1]);
          }
          i = j;
        }
        sep();
        continue;
      }

      if (base in HEADER_CMDS) {
        flush();
        j = skipOptionals(s, j);
        const arg = readArg(s, j);
        if (!arg) {
          i = j;
          continue;
        }
        const level = HEADER_CMDS[base];
        if (level !== "inline") newSection(plainTitle(arg[0]) || base, level);
        walk(arg[0], "headers");
        emit("headers", " ");
        i = arg[1];
        sep();
        continue;
      }

      if (base === "caption" || base === "captionof" || base === "subcaption") {
        flush();
        j = skipSpaces(s, j);
        if (base === "captionof") {
          const t = readArg(s, j);
          if (t) j = t[1];
        }
        j = skipOptionals(s, j);
        const arg = readArg(s, j);
        if (arg) {
          walk(arg[0], "captions");
          emit("captions", " ");
          i = arg[1];
        } else i = j;
        sep();
        continue;
      }

      if (base === "footnote" || base === "footnotetext") {
        flush();
        j = skipOptionals(s, j);
        const arg = readArg(s, j);
        if (arg) {
          walk(arg[0], "footnotes");
          emit("footnotes", " ");
          i = arg[1];
        } else i = j;
        sep();
        continue;
      }

      if (base === "abstract") {
        // \abstract{...} form used by some classes.
        const k = skipSpaces(s, j);
        if (s[k] === "{") {
          flush();
          const arg = readArg(s, k)!;
          abstractDepth++;
          walk(arg[0], bucket);
          emit(bucket, " ");
          abstractDepth--;
          i = arg[1];
          sep();
          continue;
        }
      }

      if (base === "title") {
        // Already counted from the preamble; skip here.
        j = skipOptionals(s, j);
        const arg = readArg(s, j);
        i = arg ? arg[1] : j;
        sep();
        continue;
      }

      if (base === "texorpdfstring") {
        // \texorpdfstring{typeset}{bookmark text}: only the first argument is printed.
        flush();
        const a = readArg(s, j);
        const b = a ? readArg(s, a[1]) : null;
        if (a) walk(a[0], bucket);
        i = b ? b[1] : a ? a[1] : j;
        continue;
      }

      if (base in TEXT_ARGS) {
        flush();
        j = skipOptionals(s, j);
        const n = TEXT_ARGS[base];
        let last: [string, number] | null = null;
        for (let a = 0; a < n; a++) {
          last = readArg(s, j);
          if (!last) break;
          j = a < n - 1 ? skipOptionals(s, last[1]) : last[1];
        }
        if (last) {
          // Text commands render inline: no separator so \textbf{wo}rd stays one word.
          walk(last[0], bucket);
          i = last[1];
        } else i = j;
        continue;
      }

      if (base in DROP_ARGS) {
        flush();
        j = skipOptionals(s, j);
        for (let a = 0; a < DROP_ARGS[base]; a++) {
          const r = readArg(s, j);
          if (!r) break;
          j = skipOptionals(s, r[1]);
        }
        if (base === "def") {
          // \def\name{...}
          const r = readArg(s, j);
          if (r) {
            const k = s.indexOf("{", r[1]);
            j = k >= 0 ? skipGroup(s, k) : r[1];
          }
        }
        i = j;
        sep();
        continue;
      }

      // Unknown command: drop the name, keep following groups as text (texcount default).
      flush();
      i = j;
      sep();
    }
    flush();
  }

  function walkCaptions(body: string): void {
    const re = /\\(caption|subcaption|captionof)\*?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      let j = m.index + m[0].length;
      if (m[1] === "captionof") {
        const t = readArg(body, j);
        if (t) j = t[1];
      }
      j = skipOptionals(body, j);
      const arg = readArg(body, j);
      if (!arg) continue;
      walk(arg[0], "captions");
      emit("captions", " ");
      re.lastIndex = arg[1];
    }
    // Nested floats' own captions are covered by the regex above; footnotes in floats are ignored.
  }

  const out: SectionCount[] = sections.map(({ meta, chunks }) => ({
    ...meta,
    text: countWordsInText(chunks.text.join("")),
    headers: countWordsInText(chunks.headers.join("")),
    captions: countWordsInText(chunks.captions.join("")),
    footnotes: countWordsInText(chunks.footnotes.join("")),
  }));
  const visible = out.filter((s, idx) => idx > 0 || s.text + s.headers + s.captions + s.footnotes > 0);
  const totals = visible.reduce(
    (t, s) => ({
      text: t.text + s.text,
      headers: t.headers + s.headers,
      captions: t.captions + s.captions,
      footnotes: t.footnotes + s.footnotes,
      all: t.all + s.text + s.headers + s.captions + s.footnotes,
    }),
    { text: 0, headers: 0, captions: 0, footnotes: 0, all: 0 },
  );

  return {
    sections: visible,
    totals,
    abstract: countWordsInText(abstractChunks.join("")),
    inlineMath,
    displayMath,
    included: resolved.included,
    missing: resolved.missing,
  };
}

/** Pick the main file of a project: has \documentclass and \begin{document}; prefer main.tex / shortest path. */
export function findMainFiles(files: Record<string, string>): string[] {
  const tex = Object.keys(files).filter((k) => k.toLowerCase().endsWith(".tex"));
  const mains = tex.filter((k) => /\\documentclass/.test(stripComments(files[k])) && /\\begin\s*\{document\}/.test(files[k]));
  const score = (k: string) => (/(^|\/)(main|paper|ms|manuscript)\.tex$/i.test(k) ? 0 : 1) * 1000 + k.split("/").length * 10 + k.length / 1000;
  return (mains.length ? mains : tex).sort((a, b) => score(a) - score(b));
}
