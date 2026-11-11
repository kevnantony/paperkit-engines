/**
 * LaTeX comment handling. Pure string functions, no DOM.
 *
 * Rules implemented:
 * - `%` starts a comment unless escaped (`\%`). `\\%` is a line break followed by a comment.
 * - `%` inside `\verb|..|`, `\url{..}`, `\path{..}` and the first argument of `\href{..}{..}` is literal.
 * - Lines inside verbatim-like environments (verbatim, lstlisting, minted, ...) are never touched.
 * - `\begin{comment} ... \end{comment}` blocks are removed (they are comments too).
 * - A line that is only a comment is dropped entirely; an inline comment keeps its `%` so the
 *   end-of-line space suppression (`\newcommand{\x}{%`) still works.
 */

export const VERBATIM_ENVS = [
  "verbatim",
  "verbatim*",
  "Verbatim",
  "Verbatim*",
  "BVerbatim",
  "LVerbatim",
  "spverbatim",
  "lstlisting",
  "minted",
  "filecontents",
  "filecontents*",
] as const;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const verbatimBeginRe = new RegExp(`\\\\begin\\s*\\{(${VERBATIM_ENVS.map(escapeRe).join("|")})\\}`);

/** Index just after the brace group starting at `open` (which must be `{`), or line end. */
function skipBraceGroup(line: string, open: number): number {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return line.length;
}

/** Index of the first `%` that starts a comment on this line, or -1. */
export function findCommentStart(line: string): number {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "%") return i;
    if (c !== "\\") {
      i++;
      continue;
    }
    // Control sequence
    const next = line[i + 1];
    if (next === undefined) return -1;
    if (!/[A-Za-z@]/.test(next)) {
      i += 2; // \% \\ \{ \$ ...
      continue;
    }
    let j = i + 1;
    while (j < line.length && /[A-Za-z@]/.test(line[j])) j++;
    const name = line.slice(i + 1, j);
    if (name === "verb" || name === "Verb") {
      if (line[j] === "*") j++;
      const delim = line[j];
      if (delim === undefined) return -1;
      const end = line.indexOf(delim, j + 1);
      i = end < 0 ? line.length : end + 1;
      continue;
    }
    if (name === "lstinline" || name === "mintinline") {
      // \lstinline[opts]|code| or {code}; \mintinline[opts]{lang}|code| or {code}. The code is read verbatim.
      while (line[j] === " ") j++;
      if (line[j] === "[") {
        const close = line.indexOf("]", j);
        j = close < 0 ? line.length : close + 1;
      }
      if (name === "mintinline" && line[j] === "{") j = skipBraceGroup(line, j);
      const delim = line[j];
      if (delim === undefined) return -1;
      const end = line.indexOf(delim === "{" ? "}" : delim, j + 1);
      i = end < 0 ? line.length : end + 1;
      continue;
    }
    if (name === "url" || name === "path" || name === "href" || name === "nolinkurl") {
      let k = j;
      while (line[k] === " ") k++;
      if (line[k] === "{") {
        i = skipBraceGroup(line, k);
        continue;
      }
    }
    i = j;
  }
  return -1;
}

/** Split a line into code and comment (comment includes the leading `%`). */
export function splitComment(line: string): { code: string; comment: string | null } {
  const idx = findCommentStart(line);
  return idx < 0 ? { code: line, comment: null } : { code: line.slice(0, idx), comment: line.slice(idx) };
}

export interface StripResult {
  text: string;
  /** Number of comments (inline + whole-line) removed. */
  commentsRemoved: number;
  /** Number of `comment` environments removed. */
  blocksRemoved: number;
}

/** Remove LaTeX comments and `comment` environments from a .tex source. */
export function stripComments(text: string): StripResult {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let verbatimEnv: string | null = null;
  let inCommentEnv = false;
  let commentsRemoved = 0;
  let blocksRemoved = 0;

  for (const line of lines) {
    if (verbatimEnv) {
      out.push(line);
      if (line.includes(`\\end{${verbatimEnv}}`)) verbatimEnv = null;
      continue;
    }
    if (inCommentEnv) {
      const end = line.search(/\\end\s*\{comment\}/);
      if (end >= 0) {
        inCommentEnv = false;
        const rest = line.slice(end).replace(/^\\end\s*\{comment\}/, "");
        if (rest.trim()) out.push(rest);
      }
      continue;
    }

    // Verbatim begins: keep the whole line untouched from here on.
    const vm = verbatimBeginRe.exec(line);
    if (vm && findCommentStart(line.slice(0, vm.index)) < 0) {
      out.push(line);
      if (!line.slice(vm.index).includes(`\\end{${vm[1]}}`)) verbatimEnv = vm[1];
      continue;
    }

    const { code, comment } = splitComment(line);
    let kept = code;

    const cb = kept.search(/\\begin\s*\{comment\}/);
    if (cb >= 0) {
      blocksRemoved++;
      const after = kept.slice(cb).replace(/^\\begin\s*\{comment\}/, "");
      const endIdx = after.search(/\\end\s*\{comment\}/);
      if (endIdx >= 0) {
        kept = kept.slice(0, cb) + after.slice(endIdx).replace(/^\\end\s*\{comment\}/, "");
      } else {
        kept = kept.slice(0, cb);
        inCommentEnv = true;
      }
      if (comment !== null) commentsRemoved++;
      if (kept.trim()) out.push(kept);
      continue;
    }

    if (comment === null) {
      out.push(line);
      continue;
    }
    commentsRemoved++;
    if (!code.trim()) continue; // comment-only line: drop entirely (it contributes nothing to the output)
    out.push(`${code}%`);
  }

  return { text: out.join(eol), commentsRemoved, blocksRemoved };
}

/**
 * Iterate the comments of a source (for the anonymity scan): yields line number (1-based) and comment text.
 * Verbatim lines are skipped; `comment` environment lines are reported as comments.
 */
export function listComments(text: string): { line: number; text: string }[] {
  const lines = text.split(/\r?\n/);
  const res: { line: number; text: string }[] = [];
  let verbatimEnv: string | null = null;
  let inCommentEnv = false;
  lines.forEach((line, i) => {
    if (verbatimEnv) {
      if (line.includes(`\\end{${verbatimEnv}}`)) verbatimEnv = null;
      return;
    }
    if (inCommentEnv) {
      if (/\\end\s*\{comment\}/.test(line)) inCommentEnv = false;
      else res.push({ line: i + 1, text: line });
      return;
    }
    const vm = verbatimBeginRe.exec(line);
    if (vm && findCommentStart(line.slice(0, vm.index)) < 0) {
      if (!line.slice(vm.index).includes(`\\end{${vm[1]}}`)) verbatimEnv = vm[1];
      return;
    }
    const { code, comment } = splitComment(line);
    if (/\\begin\s*\{comment\}/.test(code) && !/\\end\s*\{comment\}/.test(code)) inCommentEnv = true;
    if (comment !== null && comment.replace(/^%+/, "").trim()) res.push({ line: i + 1, text: comment });
  });
  return res;
}

/**
 * Replace comments with nothing but keep line structure (same number of lines), so line numbers
 * of the result still match the original. Used for scanning code with accurate line numbers.
 */
export function blankComments(text: string): string {
  const lines = text.split(/\r?\n/);
  let verbatimEnv: string | null = null;
  let inCommentEnv = false;
  return lines
    .map((line) => {
      if (verbatimEnv) {
        if (line.includes(`\\end{${verbatimEnv}}`)) verbatimEnv = null;
        return "";
      }
      if (inCommentEnv) {
        if (/\\end\s*\{comment\}/.test(line)) inCommentEnv = false;
        return "";
      }
      const vm = verbatimBeginRe.exec(line);
      if (vm && findCommentStart(line.slice(0, vm.index)) < 0) {
        if (!line.slice(vm.index).includes(`\\end{${vm[1]}}`)) verbatimEnv = vm[1];
        return line.slice(0, vm.index);
      }
      const { code } = splitComment(line);
      const cb = code.search(/\\begin\s*\{comment\}/);
      if (cb >= 0) {
        if (!/\\end\s*\{comment\}/.test(code.slice(cb))) inCommentEnv = true;
        return code.slice(0, cb);
      }
      return code;
    })
    .join("\n");
}
