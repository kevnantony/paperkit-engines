/**
 * Decide what goes into the arXiv upload. Pure: input is the file list (+ texts), output is a plan.
 */
import { blankComments } from "./comments";
import { findMainTex, GRAPHICS_EXTS, resolveProject, type ProjectWarning, type Reference } from "./graph";
import { basename, dirname, extname, stripExt } from "./paths";

export const ARXIV_LIMIT_BYTES = 50 * 1024 * 1024;

export interface ProjectFile {
  path: string;
  size: number;
}

export interface CleanOptions {
  /** Keep % comments in .tex files. Default false. */
  keepComments: boolean;
  /** Keep .bib files (arXiv only needs the .bbl). Default false. */
  keepBib: boolean;
  /** Downscale raster images larger than `maxImageDimension` (applied by the caller, in the browser). */
  downscaleImages: boolean;
  maxImageDimension: number;
}

export const defaultCleanOptions: CleanOptions = {
  keepComments: false,
  keepBib: false,
  downscaleImages: false,
  maxImageDimension: 2000,
};

export type FileKind = "tex" | "figure" | "bibliography" | "support" | "build" | "system" | "other";

export interface PlanEntry {
  path: string;
  size: number;
  kind: FileKind;
  action: "keep" | "remove";
  reason: string;
}

export interface CleanPlan {
  main: string | null;
  mainCandidates: string[];
  entries: PlanEntry[];
  warnings: ProjectWarning[];
  refs: Reference[];
}

/** Text-like files we need to read to analyse the project. */
export const TEXT_EXTS = ["tex", "ltx", "sty", "cls", "bib", "bbl", "bst", "bbx", "cbx", "def", "cfg", "clo", "tikz", "pgf", "txt"];

const BUILD_EXTS = ["aux", "log", "out", "toc", "lof", "lot", "fls", "fdb_latexmk", "blg", "bcf", "nav", "snm", "vrb", "dvi", "xdv", "idx", "ilg", "ind", "brf", "glg", "glo", "gls", "ist", "acn", "acr", "alg", "loa", "thm", "spl", "synctex", "pyg", "listing"];
const SUPPORT_EXTS = ["sty", "cls", "bst", "bbx", "cbx", "def", "cfg", "clo", "fd", "ldf", "ins", "dtx"];
const DATA_EXTS = ["csv", "dat", "tsv", "txt", "tikz", "pgf", "table", "json"];

function systemJunk(path: string): string | null {
  const name = basename(path);
  if (path.startsWith("__MACOSX/") || path.includes("/__MACOSX/")) return "macOS resource fork folder";
  if (name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini") return "OS metadata file";
  if (name.startsWith("._")) return "macOS resource fork";
  if (/(^|\/)\.(git|svn|hg|vscode|idea)\//.test(path)) return "version-control / editor folder";
  if (name.endsWith("~") || /\.(bak|swp|tmp|backup)$/i.test(name)) return "backup / temp file";
  if (/\.synctex(\(busy\))?(\.gz)?$/i.test(name)) return "SyncTeX data (build output)";
  if (name === ".latexmkrc" || name === "latexmkrc" || name === "Makefile" || name === ".gitignore") return "build script, not used by arXiv";
  return null;
}

/** Is `name` (without extension) mentioned as a {…name} token or path segment in the sources? */
function mentionedIn(allSource: string, path: string): boolean {
  const stem = basename(stripExt(path));
  if (stem.length < 2) return false;
  const re = new RegExp(`[{/,\\s]${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.[A-Za-z0-9]+)?\\s*[},]`);
  return re.test(allSource);
}

export function planCleanup(files: ProjectFile[], texts: Record<string, string>, opts: CleanOptions = defaultCleanOptions): CleanPlan {
  const { main, candidates } = findMainTex(texts);
  const warnings: ProjectWarning[] = [];

  if (!main) {
    warnings.push({ level: "danger", code: "no-main", message: "No .tex file with \\documentclass was found, so nothing can be traced. Nothing was removed except build junk." });
  } else if (candidates.length > 1) {
    warnings.push({
      level: "info",
      code: "multiple-main",
      message: `Several files have \\documentclass (${candidates.slice(0, 4).join(", ")}${candidates.length > 4 ? ", …" : ""}). Using ${main} as the main file; the others are only kept if it includes them.`,
    });
  }

  const graph = main ? resolveProject(main, texts, files.map((f) => f.path)) : null;
  if (graph) warnings.push(...graph.warnings);
  const used = graph?.used ?? new Map<string, string>();
  const allSource = Object.entries(texts)
    .filter(([p]) => extname(p) === "tex" && (!graph || used.has(p)))
    .map(([, t]) => blankComments(t))
    .join("\n");
  const mainStem = main ? stripExt(main) : null;
  const hasMacroRefs = graph?.refs.some((r) => r.macro) ?? false;

  const entries: PlanEntry[] = files.map(({ path, size }) => {
    const ext = extname(path);
    const name = basename(path);
    const e = (kind: FileKind, action: "keep" | "remove", reason: string): PlanEntry => ({ path, size, kind, action, reason });

    const junk = systemJunk(path);
    if (junk) return e("system", "remove", junk);
    if (path === main) return e("tex", "keep", "main file (has \\documentclass)");
    if (name === "00README.json" || name === "00README.XXX" || name === "00README") return e("support", "keep", "arXiv processing instructions");

    if (ext === "bbl") return e("bibliography", "keep", stripExt(path) === mainStem ? "compiled bibliography (arXiv needs it)" : "compiled bibliography");
    if (ext === "bib") {
      const why = used.get(path);
      return opts.keepBib
        ? e("bibliography", "keep", why ? `kept by option (${why})` : "kept by option")
        : e("bibliography", "remove", "arXiv builds from the .bbl; turn on “Keep .bib” to include it");
    }
    if (BUILD_EXTS.includes(ext) || (ext === "gz" && /\.synctex\.gz$/i.test(name))) return e("build", "remove", `LaTeX build output (.${ext})`);
    if (ext === "pdf" && mainStem && stripExt(path) === mainStem) return e("build", "remove", "compiled paper PDF; arXiv would use it instead of your sources");

    const reason = used.get(path);
    if (reason) return e(ext === "tex" ? "tex" : GRAPHICS_EXTS.includes(ext) ? "figure" : SUPPORT_EXTS.includes(ext) ? "support" : "other", "keep", reason);

    if (!graph) return e(ext === "tex" ? "tex" : "other", "keep", "kept (no main file to trace from)");
    if (ext === "tex") {
      if (mentionedIn(allSource, path) && hasMacroRefs) return e("tex", "keep", "name appears in the source (possibly included via a macro)");
      return e("tex", "remove", `not included from ${main}`);
    }
    if (GRAPHICS_EXTS.includes(ext)) {
      if (mentionedIn(allSource, path)) return e("figure", "keep", "name appears in the source (possibly included via a macro)");
      return e("figure", "remove", "unused figure: never referenced by \\includegraphics");
    }
    if (SUPPORT_EXTS.includes(ext)) return e("support", "keep", "LaTeX support file (style/class)");
    if (DATA_EXTS.includes(ext)) {
      if (mentionedIn(allSource, path) || allSource.includes(name)) return e("other", "keep", "data file mentioned in the source");
      return e("other", "remove", "not referenced by any included file");
    }
    if (dirname(path) === "" && /^readme/i.test(name)) return e("other", "remove", "README is not needed by arXiv");
    return e("other", "remove", "not referenced by any included file");
  });

  if (graph?.usesBibliography && mainStem) {
    const bbl = files.find((f) => f.path === `${mainStem}.bbl`);
    if (!bbl)
      warnings.push({
        level: "danger",
        code: "missing-bbl",
        message: `${basename(mainStem)}.bbl is missing. arXiv does not run BibTeX/Biber, so your references will show as “?”. Compile locally and add ${basename(mainStem)}.bbl next to ${basename(main!)}.`,
      });
    if (graph.usesBiblatex)
      warnings.push({ level: "info", code: "biblatex", message: "biblatex detected: the .bbl must be produced by the same biblatex version arXiv uses (check arXiv's TeX Live year)." });
  }

  return { main, mainCandidates: candidates, entries, warnings, refs: graph?.refs ?? [] };
}

/** Compute target size when downscaling so the longest side is at most `max`. Null if no change needed. */
export function downscaleTarget(width: number, height: number, max: number): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest <= max || max <= 0) return null;
  const s = max / longest;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

export type SizeTone = "success" | "warning" | "danger";
export function sizeTone(bytes: number, limit = ARXIV_LIMIT_BYTES): SizeTone {
  if (bytes > limit) return "danger";
  if (bytes > limit * 0.8) return "warning";
  return "success";
}
