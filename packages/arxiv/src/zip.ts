/**
 * Zip in → cleaned zip out. Uses JSZip (works in Node and the browser); image downscaling is
 * injected by the caller because it needs a canvas.
 */
import JSZip from "jszip";
import { stripComments } from "./comments";
import { extname, normalizePath } from "./paths";
import { defaultCleanOptions, planCleanup, TEXT_EXTS, type CleanOptions, type CleanPlan, type PlanEntry } from "./plan";

/** Byte-preserving decode: every byte becomes one char (so UTF-8 and Latin-1 sources both round-trip). */
export function bytesToBinaryString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

export function binaryStringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export interface LoadedProject {
  files: { path: string; bytes: Uint8Array }[];
  texts: Record<string, string>;
  zipSize: number;
}

export async function loadProjectZip(zipBytes: Uint8Array | ArrayBuffer): Promise<LoadedProject> {
  const zip = await JSZip.loadAsync(zipBytes);
  const files: LoadedProject["files"] = [];
  const texts: Record<string, string> = {};
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const path = normalizePath(entry.name);
    if (!path) continue;
    const bytes = await entry.async("uint8array");
    files.push({ path, bytes });
    if (TEXT_EXTS.includes(extname(path))) texts[path] = bytesToBinaryString(bytes);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, texts, zipSize: zipBytes.byteLength };
}

export type Downscaler = (path: string, bytes: Uint8Array, maxDimension: number) => Promise<Uint8Array | null>;

export interface CleanResult {
  plan: CleanPlan;
  output: Uint8Array;
  /** Sum of uncompressed sizes. */
  bytesBefore: number;
  bytesAfter: number;
  zipBefore: number;
  zipAfter: number;
  commentsRemoved: number;
  blocksRemoved: number;
  imagesDownscaled: string[];
  /** Folder prefix removed so the main file sits at the zip root ("" if none). */
  rerooted: string;
  /** Output path for each kept entry. */
  outputPaths: Record<string, string>;
  kept: PlanEntry[];
  removed: PlanEntry[];
}

export async function cleanProject(project: LoadedProject, opts: CleanOptions = defaultCleanOptions, downscale?: Downscaler): Promise<CleanResult> {
  const plan = planCleanup(
    project.files.map((f) => ({ path: f.path, size: f.bytes.length })),
    project.texts,
    opts,
  );
  const kept = plan.entries.filter((e) => e.action === "keep");
  const removed = plan.entries.filter((e) => e.action === "remove");

  // Put the main file at the zip root when everything kept lives under its folder.
  let rerooted = "";
  if (plan.main && plan.main.includes("/")) {
    const prefix = plan.main.slice(0, plan.main.lastIndexOf("/") + 1);
    if (kept.every((e) => e.path.startsWith(prefix))) rerooted = prefix;
  }

  const out = new JSZip();
  const outputPaths: Record<string, string> = {};
  let commentsRemoved = 0;
  let blocksRemoved = 0;
  let bytesAfter = 0;
  const imagesDownscaled: string[] = [];
  const byPath = new Map(project.files.map((f) => [f.path, f.bytes]));

  for (const entry of kept) {
    let bytes = byPath.get(entry.path)!;
    const ext = extname(entry.path);
    if (ext === "tex" && !opts.keepComments) {
      const r = stripComments(project.texts[entry.path] ?? bytesToBinaryString(bytes));
      commentsRemoved += r.commentsRemoved;
      blocksRemoved += r.blocksRemoved;
      bytes = binaryStringToBytes(r.text);
    }
    if (opts.downscaleImages && downscale && ["png", "jpg", "jpeg"].includes(ext)) {
      const smaller = await downscale(entry.path, bytes, opts.maxImageDimension);
      if (smaller && smaller.length < bytes.length) {
        bytes = smaller;
        imagesDownscaled.push(entry.path);
      }
    }
    const outPath = entry.path.slice(rerooted.length);
    outputPaths[entry.path] = outPath;
    bytesAfter += bytes.length;
    out.file(outPath, bytes);
  }

  const output = await out.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return {
    plan,
    output,
    bytesBefore: project.files.reduce((n, f) => n + f.bytes.length, 0),
    bytesAfter,
    zipBefore: project.zipSize,
    zipAfter: output.length,
    commentsRemoved,
    blocksRemoved,
    imagesDownscaled,
    rerooted,
    outputPaths,
    kept,
    removed,
  };
}
