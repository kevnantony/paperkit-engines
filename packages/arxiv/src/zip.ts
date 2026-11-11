/**
 * Zip in → cleaned zip out. Uses JSZip (works in Node and the browser); image downscaling is
 * injected by the caller because it needs a canvas.
 */
import JSZip from "jszip";
import { stripComments } from "./comments";
import { extname, normalizePath } from "./paths";
import { BINARY_EXTS, defaultCleanOptions, looksLikeText, planCleanup, TEXT_EXTS, type CleanOptions, type CleanPlan, type PlanEntry } from "./plan";

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
    const ext = extname(path);
    if (TEXT_EXTS.includes(ext) || (!BINARY_EXTS.includes(ext) && looksLikeText(bytes))) texts[path] = bytesToBinaryString(bytes);
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

/* ---------------- tar / gzip (arXiv e-prints) ---------------- */

/**
 * What arXiv hands out as an "e-print": a gzipped tarball (.tar.gz / .tgz), sometimes a plain .tar, or for
 * single-file submissions just the gzipped .tex. Detected by magic bytes, never by the file name (arXiv's
 * download names often have no extension at all).
 */
export type ArchiveFormat = "zip" | "gzip" | "tar" | "unknown";

export function sniffArchive(bytes: Uint8Array): ArchiveFormat {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7)) return "zip";
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  if (bytes.length >= 512 && isTarHeader(bytes.subarray(0, 512))) return "tar";
  return "unknown";
}

/** A valid tar header block: the stored header checksum matches (works for ustar, GNU and old v7 tar). */
export function isTarHeader(block: Uint8Array): boolean {
  if (block.length < 512 || block.every((b) => b === 0)) return false;
  const stored = parseOctal(block.subarray(148, 156));
  if (stored === null) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  return sum === stored;
}

function parseOctal(field: Uint8Array): number | null {
  let s = "";
  for (const b of field) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  s = s.trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) return null;
  return parseInt(s, 8);
}

/** Size field: octal, or GNU base-256 when the high bit of the first byte is set. */
function parseSize(field: Uint8Array): number {
  if (field[0] & 0x80) {
    let n = field[0] & 0x7f;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    return n;
  }
  const v = parseOctal(field);
  if (v === null) throw new Error("This tar archive has a corrupt header.");
  return v;
}

function cString(field: Uint8Array): string {
  const end = field.indexOf(0);
  return new TextDecoder("utf-8").decode(end < 0 ? field : field.subarray(0, end));
}

/** Throws for entries that would land outside the project folder (`../x`, `/etc/x`, `C:\x`, `~/x`). */
export function safeArchivePath(raw: string): string {
  const p = raw.replace(/\\/g, "/");
  if (/^\//.test(p) || /^[A-Za-z]:\//.test(p) || /^~/.test(p)) throw new Error(`Refusing an archive entry with an absolute path: ${raw}`);
  if (p.split("/").some((seg) => seg === "..")) throw new Error(`Refusing an archive entry that points outside the project: ${raw}`);
  return normalizePath(p);
}

/** Pulls exact byte counts out of a chunked stream, buffering only what is needed. */
class ChunkReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;
  constructor(private readonly it: AsyncIterator<Uint8Array>) {}

  private async fill(n: number): Promise<void> {
    while (this.buffered < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else if (r.value.length) {
        this.chunks.push(r.value);
        this.buffered += r.value.length;
      }
    }
  }

  /** Exactly `n` bytes, or fewer at the end of the stream. */
  async read(n: number): Promise<Uint8Array> {
    await this.fill(n);
    const take = Math.min(n, this.buffered);
    const out = new Uint8Array(take);
    let at = 0;
    while (at < take) {
      const c = this.chunks[0];
      const k = Math.min(c.length, take - at);
      out.set(c.subarray(0, k), at);
      at += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.buffered -= take;
    return out;
  }

  async peek(n: number): Promise<Uint8Array> {
    await this.fill(n);
    const out = new Uint8Array(Math.min(n, this.buffered));
    let at = 0;
    for (const c of this.chunks) {
      if (at >= out.length) break;
      const k = Math.min(c.length, out.length - at);
      out.set(c.subarray(0, k), at);
      at += k;
    }
    return out;
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      const got = await this.read(Math.min(left, 1 << 20));
      if (!got.length) return;
      left -= got.length;
    }
  }
}

type ByteSource = Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

async function* iterate(source: ByteSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  yield* source as AsyncIterable<Uint8Array>;
}

/** Streams the decompressed bytes of a gzip file (DecompressionStream: every current browser, Node ≥ 18). */
export function gunzipStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decompress .gz files. Unpack the archive and drop a .zip instead.");
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return input.pipeThrough(new DecompressionStream("gzip")) as ReadableStream<Uint8Array>;
}

/** Files of a tar archive, read header by header from a stream. Directories, links and devices are skipped. */
export async function readTar(source: ByteSource): Promise<{ path: string; bytes: Uint8Array }[]> {
  return readTarFrom(new ChunkReader(iterate(source)));
}

async function readTarFrom(r: ChunkReader): Promise<{ path: string; bytes: Uint8Array }[]> {
  const files: { path: string; bytes: Uint8Array }[] = [];
  let longName: string | null = null;
  let paxPath: string | null = null;
  let first = true;
  for (;;) {
    const header = await r.read(512);
    if (header.length < 512 || header.every((b) => b === 0)) break;
    if (!isTarHeader(header)) throw new Error(first ? "This doesn't look like a tar archive." : "This tar archive is corrupt (bad header checksum).");
    first = false;
    const size = parseSize(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const padded = Math.ceil(size / 512) * 512;
    if (type === "L" || type === "x") {
      // GNU long name / pax extended header: applies to the next entry.
      const data = await r.read(size);
      await r.skip(padded - size);
      if (type === "L") longName = cString(data);
      else {
        const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(new TextDecoder("utf-8").decode(data));
        if (m) paxPath = m[1];
      }
      continue;
    }
    const magic = cString(header.subarray(257, 263));
    const prefix = magic.startsWith("ustar") ? cString(header.subarray(345, 500)) : "";
    const short = cString(header.subarray(0, 100));
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${short}` : short);
    paxPath = null;
    longName = null;
    if (type === "0" || type === "7") {
      const path = safeArchivePath(name);
      const bytes = await r.read(size);
      if (bytes.length < size) throw new Error("This tar archive is truncated.");
      await r.skip(padded - size);
      if (path) files.push({ path, bytes });
    } else {
      if (name) safeArchivePath(name);
      await r.skip(padded);
    }
  }
  return files;
}

/** Name for a single-file gzip e-print: "ms.tex.gz" → "ms.tex", "2101.00001.gz" or "2101.00001" → "2101.00001.tex". */
export function singleFileName(archiveName: string): string {
  const base = archiveName.replace(/^.*[\\/]/, "").replace(/\.gz$/i, "") || "main";
  return /\.[a-z][a-z0-9]{0,3}$/i.test(base) ? base : `${base}.tex`;
}

export type ProjectFormat = "zip" | "tar" | "tar.gz" | "gz";

/**
 * Load a project from what you have: an Overleaf .zip, an arXiv e-print (.tar.gz / .tgz / .tar), or a single
 * gzipped .tex. The format comes from magic bytes; `name` only names a single-file e-print.
 */
export async function loadProjectArchive(input: Uint8Array | ArrayBuffer, name = "main.tex.gz"): Promise<LoadedProject & { format: ProjectFormat }> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const kind = sniffArchive(bytes);
  if (kind === "zip") return { ...(await loadProjectZip(bytes)), format: "zip" };
  let files: { path: string; bytes: Uint8Array }[];
  let format: ProjectFormat;
  if (kind === "tar") {
    files = await readTar(bytes);
    format = "tar";
  } else if (kind === "gzip") {
    const r = new ChunkReader(iterate(gunzipStream(bytes)));
    let head: Uint8Array;
    try {
      head = await r.peek(512);
    } catch {
      throw new Error("This .gz file is corrupt and could not be decompressed.");
    }
    if (isTarHeader(head)) {
      files = await readTarFrom(r);
      format = "tar.gz";
    } else {
      const parts: Uint8Array[] = [];
      for (;;) {
        const c = await r.read(1 << 20);
        if (!c.length) break;
        parts.push(c);
      }
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
      }
      if (!looksLikeText(all)) throw new Error("This .gz file contains neither a tar archive nor a .tex file.");
      files = [{ path: singleFileName(name), bytes: all }];
      format = "gz";
    }
  } else {
    throw new Error("This file isn't a .zip, .tar, .tar.gz or .gz archive.");
  }
  const texts: Record<string, string> = {};
  for (const f of files) {
    const ext = extname(f.path);
    if (TEXT_EXTS.includes(ext) || (!BINARY_EXTS.includes(ext) && looksLikeText(f.bytes))) texts[f.path] = bytesToBinaryString(f.bytes);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, texts, zipSize: bytes.length, format };
}
