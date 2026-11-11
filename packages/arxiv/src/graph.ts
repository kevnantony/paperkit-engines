/**
 * Dependency graph of a LaTeX project: which files does the main .tex actually use?
 * Pure: operates on a map of path → text plus the list of every path in the archive.
 */
import { blankComments } from "./comments";
import { basename, dirname, extname, isAbsolutePath, join, normalizePath } from "./paths";

export type RefKind = "tex" | "graphics" | "bib" | "bst" | "cls" | "sty" | "file";

export interface Reference {
  kind: RefKind;
  command: string;
  target: string;
  from: string;
  line: number;
  resolved: string | null;
  caseMismatch?: boolean;
  absolute?: boolean;
  macro?: boolean;
}

export type WarningLevel = "danger" | "warning" | "info";
export interface ProjectWarning {
  level: WarningLevel;
  code: "missing-bbl" | "missing-file" | "absolute-path" | "case-mismatch" | "macro-path" | "no-main" | "multiple-main" | "biblatex" | "size" | "unknown-kept";
  message: string;
  file?: string;
  line?: number;
}

export const GRAPHICS_EXTS = ["pdf", "png", "jpg", "jpeg", "eps", "ps", "mps", "jbig2", "jb2", "svg", "gif", "tif", "tiff", "bmp"];
/** Order pdflatex tries when \includegraphics has no extension (then the eps fallback via epstopdf). */
const GRAPHICS_TRY = [".pdf", ".png", ".jpg", ".mps", ".jpeg", ".jbig2", ".jb2", ".PDF", ".PNG", ".JPG", ".JPEG", ".eps", ".ps", ".svg"];

const MAIN_NAMES = ["main.tex", "ms.tex", "paper.tex", "article.tex", "manuscript.tex"];

/** Pick the root .tex file: one with an uncommented \documentclass, preferring \begin{document} at top level. */
export function findMainTex(texts: Record<string, string>): { main: string | null; candidates: string[] } {
  const candidates = Object.keys(texts)
    .filter((p) => extname(p) === "tex")
    .filter((p) => /\\document(?:class|style)\s*(\[[^\]]*\])?\s*\{/.test(blankComments(texts[p])))
    .sort((a, b) => {
      const score = (p: string) =>
        (/\\begin\s*\{document\}/.test(blankComments(texts[p])) ? 0 : 10) +
        (/\\documentclass\s*(\[[^\]]*\])?\s*\{standalone\}/.test(texts[p]) ? 20 : 0) +
        p.split("/").length +
        (MAIN_NAMES.includes(p.split("/").pop()!.toLowerCase()) ? 0 : 1);
      return score(a) - score(b) || a.localeCompare(b);
    });
  return { main: candidates[0] ?? null, candidates };
}

/** Read a balanced {group} starting at `i` (which must point at `{`). Returns content and end index. */
function readGroup(s: string, i: number): { value: string; end: number } | null {
  if (s[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { value: s.slice(i + 1, j), end: j + 1 };
    }
  }
  return null;
}

function skipOptional(s: string, i: number): number {
  for (;;) {
    while (/\s/.test(s[i] ?? "")) i++;
    if (s[i] === "[") {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === "[") depth++;
        else if (s[j] === "]" && --depth === 0) break;
      }
      i = j + 1;
    } else if (s[i] === "<") {
      const j = s.indexOf(">", i);
      if (j < 0) return i;
      i = j + 1;
    } else return i;
  }
}

const CMD_RE =
  /\\(@@input|@input|InputIfFileExists|input|include|subfile|includegraphics|includesvg|includepdf|includestandalone|lstinputlisting|verbatiminput|inputminted|bibliography|addbibresource|addglobalbib|graphicspath|import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom|usepackage|RequirePackage|documentclass|LoadClass|bibliographystyle)(?![A-Za-z@])\*?/g;

interface RawCommand {
  command: string;
  args: string[];
  index: number;
}

/** Extract file-referencing commands from (comment-blanked) LaTeX source. */
export function extractCommands(src: string): RawCommand[] {
  const res: RawCommand[] = [];
  for (const m of src.matchAll(CMD_RE)) {
    const command = m[1];
    let i = skipOptional(src, m.index! + m[0].length);
    const g1 = readGroup(src, i);
    if (!g1) {
      if (command === "input" || command === "@@input" || command === "@input") {
        const bare = /^\s*([^\s{}\\%]+)/.exec(src.slice(m.index! + m[0].length));
        if (bare) res.push({ command, args: [bare[1]], index: m.index! });
      }
      continue;
    }
    const args = [g1.value];
    if (["import", "subimport", "inputminted", "inputfrom", "subinputfrom", "includefrom", "subincludefrom"].includes(command)) {
      i = skipOptional(src, g1.end);
      const g2 = readGroup(src, i);
      if (!g2) continue;
      args.push(g2.value);
    }
    res.push({ command, args, index: m.index! });
  }
  return res;
}

const DATA_RE = /\\(addplot3?|pgfplotstableread|pgfplotstabletypeset|csvreader|csvautotabular|csvautobooktabular|csvautolongtable|DTLloaddb|DTLloadrawdb)(?![A-Za-z@])\*?/g;

/**
 * Data files read by plotting/table packages: pgfplots `\addplot table {f}` / `\addplot file {f}`,
 * `\pgfplotstableread{f}`, csvsimple, datatool. Inline tables and macro arguments are skipped.
 */
export function extractDataRefs(src: string): { command: string; target: string; index: number }[] {
  const res: { command: string; target: string; index: number }[] = [];
  for (const m of src.matchAll(DATA_RE)) {
    const command = m[1];
    let i = m.index! + m[0].length;
    if (command.startsWith("addplot")) {
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] === "+") i++;
      i = skipOptional(src, i);
      const kw = /^(table|file)(?![A-Za-z@])/.exec(src.slice(i, i + 6));
      if (!kw) continue;
      i = skipOptional(src, i + kw[1].length);
    } else {
      i = skipOptional(src, i);
      if (command.startsWith("DTLload")) {
        const name = readGroup(src, i);
        if (!name) continue;
        i = skipOptional(src, name.end);
      }
    }
    const g = readGroup(src, i);
    if (!g) continue;
    const target = g.value.trim();
    if (!target || /[\s\\#{}]/.test(target)) continue;
    res.push({ command, target, index: m.index! });
  }
  return res;
}

export function parseGraphicspath(arg: string): string[] {
  const dirs: string[] = [];
  for (const m of arg.matchAll(/\{([^{}]*)\}/g)) dirs.push(m[1].trim());
  if (!dirs.length && arg.trim()) dirs.push(arg.trim());
  return dirs;
}

class FileIndex {
  private exact: Set<string>;
  private lower = new Map<string, string>();
  constructor(paths: string[]) {
    this.exact = new Set(paths);
    for (const p of paths) if (!this.lower.has(p.toLowerCase())) this.lower.set(p.toLowerCase(), p);
  }
  /** First exact hit across candidates; otherwise first case-insensitive hit. */
  find(candidates: string[]): { path: string; caseMismatch: boolean } | null {
    for (const c of candidates) if (this.exact.has(c)) return { path: c, caseMismatch: false };
    for (const c of candidates) {
      const hit = this.lower.get(c.toLowerCase());
      if (hit) return { path: hit, caseMismatch: true };
    }
    return null;
  }
}

const lineAt = (s: string, index: number) => s.slice(0, index).split("\n").length;
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

export interface ProjectGraph {
  main: string;
  /** used path → human-readable reason */
  used: Map<string, string>;
  refs: Reference[];
  warnings: ProjectWarning[];
  /** True if \bibliography / \addbibresource appears. */
  usesBibliography: boolean;
  usesBiblatex: boolean;
}

/** Walk the include graph from `main`, resolving every referenced file against `allPaths`. */
export function resolveProject(main: string, texts: Record<string, string>, allPaths: string[]): ProjectGraph {
  const index = new FileIndex(allPaths.map(normalizePath));
  const mainDir = dirname(main);
  const used = new Map<string, string>([[main, "main file (has \\documentclass)"]]);
  const refs: Reference[] = [];
  const warnings: ProjectWarning[] = [];
  const graphicsDirs: string[] = [];
  const pendingGraphics: { cmd: RawCommand; target: string; from: string; line: number; fileDir: string }[] = [];
  let usesBibliography = false;
  let usesBiblatex = false;

  const queue: { path: string; importBase: string | null }[] = [{ path: main, importBase: null }];
  const visited = new Set<string>();

  const record = (ref: Reference, reason: string) => {
    refs.push(ref);
    if (ref.resolved) {
      if (!used.has(ref.resolved)) used.set(ref.resolved, reason);
      if (ref.caseMismatch)
        warnings.push({
          level: "warning",
          code: "case-mismatch",
          message: `\\${ref.command}{${ref.target}} only matches "${ref.resolved}" ignoring case. arXiv's file system is case-sensitive; TeX Live usually still finds the file through its case-insensitive fallback, but other tools and TeX setups may not. Rename the file or fix the reference so they match exactly.`,
          file: ref.from,
          line: ref.line,
        });
    }
  };

  while (queue.length) {
    const { path, importBase } = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const raw = texts[path];
    if (raw === undefined) continue;
    const src = blankComments(raw);
    const fileDir = dirname(path);
    const bases = uniq([importBase ?? mainDir, mainDir, fileDir]);

    for (const cmd of extractCommands(src)) {
      const line = lineAt(src, cmd.index);
      const at = `${path}:${line}`;
      const target = cmd.args[cmd.args.length - 1].trim();
      const base: Reference = { kind: "file", command: cmd.command, target, from: path, line, resolved: null };

      if (cmd.command === "graphicspath") {
        graphicsDirs.push(...parseGraphicspath(cmd.args[0]));
        continue;
      }
      if (/[\\#]/.test(target)) {
        refs.push({ ...base, macro: true });
        warnings.push({
          level: "info",
          code: "macro-path",
          message: `\\${cmd.command}{${target}} uses a macro, so the file can't be resolved statically. Files whose name appears in the source are kept to be safe.`,
          file: path,
          line,
        });
        continue;
      }
      if (["input", "@@input", "@input", "InputIfFileExists", "include", "subfile", "import", "subimport", "inputfrom", "subinputfrom", "includefrom", "subincludefrom", "includestandalone"].includes(cmd.command)) {
        let dirs = bases;
        let nextImportBase: string | null = importBase;
        if (cmd.args.length === 2) {
          const dirArg = cmd.args[0].trim();
          const rel = cmd.command.startsWith("sub");
          const importDir = rel ? join(fileDir, dirArg) : join(mainDir, dirArg);
          dirs = [importDir];
          nextImportBase = importDir;
        }
        if (isAbsolutePath(target) || (cmd.args.length === 2 && isAbsolutePath(cmd.args[0]))) {
          refs.push({ ...base, kind: "tex", absolute: true });
          warnings.push({ level: "danger", code: "absolute-path", message: `Absolute path in \\${cmd.command}{${target}}. arXiv only sees files inside your upload; use a relative path.`, file: path, line });
          continue;
        }
        const names = cmd.command === "include" || cmd.command === "includefrom" || cmd.command === "subincludefrom" ? [`${target}.tex`] : [`${target}.tex`, target];
        const hit = index.find(dirs.flatMap((d) => names.map((n) => join(d, n))));
        const ref: Reference = { ...base, kind: "tex", resolved: hit?.path ?? null, caseMismatch: hit?.caseMismatch };
        record(ref, `\\${cmd.command} in ${at}`);
        if (hit) queue.push({ path: hit.path, importBase: nextImportBase });
        else if (cmd.command === "InputIfFileExists") continue;
        else if (cmd.command !== "includestandalone" || !index.find(dirs.map((d) => join(d, `${target}.pdf`))))
          warnings.push({ level: "danger", code: "missing-file", message: `\\${cmd.command}{${target}} points to a file that isn't in the zip.`, file: path, line });
        else {
          const pdf = index.find(dirs.map((d) => join(d, `${target}.pdf`)))!;
          record({ ...ref, kind: "graphics", resolved: pdf.path }, `\\${cmd.command} in ${at}`);
        }
        continue;
      }
      if (["includegraphics", "includesvg", "includepdf"].includes(cmd.command)) {
        pendingGraphics.push({ cmd, target, from: path, line, fileDir: importBase ?? fileDir });
        continue;
      }
      if (["lstinputlisting", "verbatiminput", "inputminted"].includes(cmd.command)) {
        if (isAbsolutePath(target)) {
          warnings.push({ level: "danger", code: "absolute-path", message: `Absolute path in \\${cmd.command}{${target}}.`, file: path, line });
          continue;
        }
        const hit = index.find(bases.map((d) => join(d, target)));
        record({ ...base, resolved: hit?.path ?? null, caseMismatch: hit?.caseMismatch }, `\\${cmd.command} in ${at}`);
        if (!hit) warnings.push({ level: "danger", code: "missing-file", message: `\\${cmd.command}{${target}} points to a file that isn't in the zip.`, file: path, line });
        continue;
      }
      if (cmd.command === "bibliography" || cmd.command === "addbibresource" || cmd.command === "addglobalbib") {
        usesBibliography = true;
        if (cmd.command !== "bibliography") usesBiblatex = true;
        const items = cmd.command === "bibliography" ? target.split(",").map((s) => s.trim()).filter(Boolean) : [target];
        for (const item of items) {
          const file = /\.bib$/i.test(item) ? item : `${item}.bib`;
          const hit = index.find(bases.map((d) => join(d, file)));
          record({ ...base, kind: "bib", target: item, resolved: hit?.path ?? null, caseMismatch: hit?.caseMismatch }, `bibliography database (\\${cmd.command} in ${at})`);
        }
        continue;
      }
      if (cmd.command === "bibliographystyle") {
        const hit = index.find(bases.map((d) => join(d, `${target}.bst`)));
        if (hit) record({ ...base, kind: "bst", resolved: hit.path, caseMismatch: hit.caseMismatch }, `bibliography style (\\bibliographystyle in ${at})`);
        continue;
      }
      if (cmd.command === "usepackage" || cmd.command === "RequirePackage") {
        for (const pkg of target.split(",").map((s) => s.trim()).filter(Boolean)) {
          const hit = index.find(bases.map((d) => join(d, `${pkg}.sty`)));
          if (hit) {
            record({ ...base, kind: "sty", target: pkg, resolved: hit.path, caseMismatch: hit.caseMismatch }, `local package (\\usepackage in ${at})`);
            queue.push({ path: hit.path, importBase });
          }
        }
        continue;
      }
      if (cmd.command === "documentclass" || cmd.command === "LoadClass") {
        const hit = index.find(bases.map((d) => join(d, `${target}.cls`)));
        if (hit) {
          record({ ...base, kind: "cls", resolved: hit.path, caseMismatch: hit.caseMismatch }, `local class (\\${cmd.command} in ${at})`);
          queue.push({ path: hit.path, importBase });
        }
      }
    }

    for (const d of extractDataRefs(src)) {
      const line = lineAt(src, d.index);
      const base: Reference = { kind: "file", command: d.command, target: d.target, from: path, line, resolved: null };
      if (isAbsolutePath(d.target)) {
        refs.push({ ...base, absolute: true });
        warnings.push({ level: "danger", code: "absolute-path", message: `Absolute path in \\${d.command}{${d.target}}. arXiv only sees files inside your upload; use a relative path.`, file: path, line });
        continue;
      }
      const hit = index.find(bases.map((dir) => join(dir, d.target)));
      record({ ...base, resolved: hit?.path ?? null, caseMismatch: hit?.caseMismatch }, `data file (\\${d.command} in ${path}:${line})`);
      if (!hit) warnings.push({ level: "warning", code: "missing-file", message: `\\${d.command} reads ${d.target}, which isn't in the zip.`, file: path, line });
    }
  }

  const gDirs = uniq(graphicsDirs.map((d) => join(mainDir, d)));
  for (const { cmd, target, from, line, fileDir } of pendingGraphics) {
    const base: Reference = { kind: "graphics", command: cmd.command, target, from, line, resolved: null };
    if (isAbsolutePath(target)) {
      refs.push({ ...base, absolute: true });
      warnings.push({ level: "danger", code: "absolute-path", message: `Absolute path in \\${cmd.command}{${target}}. arXiv only sees files inside your upload; use a relative path.`, file: from, line });
      continue;
    }
    const clean = target.replace(/^"(.*)"$/, "$1");
    const hasKnownExt = GRAPHICS_EXTS.includes(extname(clean));
    const names = hasKnownExt ? [clean] : [...GRAPHICS_TRY.map((e) => clean + e), clean];
    const dirs = uniq([...gDirs, mainDir, fileDir]);
    let hit = index.find(dirs.flatMap((d) => names.map((n) => join(d, n))));
    // epstopdf convention: an .eps reference may be satisfied by the converted pdf and vice versa.
    if (!hit && extname(clean) === "eps") hit = index.find(dirs.map((d) => join(d, clean.replace(/\.eps$/i, "-eps-converted-to.pdf"))));
    record({ ...base, resolved: hit?.path ?? null, caseMismatch: hit?.caseMismatch }, `figure (\\${cmd.command} in ${from}:${line})`);
    let exports = 0;
    if (cmd.command === "includesvg") {
      // svg package: Inkscape exports cached in svg-inkscape/<name>_svg-tex.pdf(+_tex) are used instead of the .svg.
      const stem = basename(clean).replace(/\.svg$/i, "");
      for (const d of uniq([mainDir, fileDir]))
        for (const kind of ["tex", "raw"])
          for (const e of ["pdf", "pdf_tex", "eps", "eps_tex", "png"]) {
            const exp = index.find([join(d, `svg-inkscape/${stem}_svg-${kind}.${e}`)]);
            if (!exp) continue;
            exports++;
            record({ ...base, resolved: exp.path, caseMismatch: exp.caseMismatch }, `Inkscape export for \\includesvg in ${from}:${line}`);
          }
    }
    if (!hit && !exports) warnings.push({ level: "danger", code: "missing-file", message: `\\${cmd.command}{${target}} points to a figure that isn't in the zip.`, file: from, line });
  }

  return { main, used, refs, warnings, usesBibliography, usesBiblatex };
}
