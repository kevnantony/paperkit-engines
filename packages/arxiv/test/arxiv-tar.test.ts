import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { cleanProject, isTarHeader, loadProjectArchive, readTar, safeArchivePath, singleFileName, sniffArchive } from "../src";

/* Minimal tar writer for fixtures (ustar, with optional GNU long-name and pax records). */
function header(name: string, size: number, type = "0", prefix = ""): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, at: number, len: number) => h.set(new TextEncoder().encode(s).subarray(0, len), at);
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  put("00000000000\0", 136, 12);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  const sum = h.reduce((n, b) => n + b, 0);
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

function pad(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
}

type TarEntry = { name: string; data?: string | Uint8Array; type?: string; prefix?: string };

function tar(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const data = typeof e.data === "string" ? new TextEncoder().encode(e.data) : (e.data ?? new Uint8Array());
    parts.push(header(e.name, data.length, e.type, e.prefix), pad(data));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("tar reader", () => {
  it("reads files, skips directories and handles ustar prefixes, GNU long names and pax paths", async () => {
    const long = "figures/" + "a".repeat(120) + ".pdf";
    const t = tar([
      { name: "./", type: "5" },
      { name: "./main.tex", data: "\\documentclass{article}" },
      { name: "sec/", type: "5" },
      { name: "intro.tex", prefix: "sec", data: "Intro" },
      { name: "././@LongLink", type: "L", data: long + "\0" },
      { name: "figures/aaaa.pdf", data: "%PDF" },
      { name: "PaxHeader", type: "x", data: "27 path=data/pax-name.txt\n" },
      { name: "short.txt", data: "pax" },
      { name: "link", type: "2" },
    ]);
    expect(isTarHeader(t.subarray(0, 512))).toBe(true);
    expect(sniffArchive(t)).toBe("tar");
    const files = await readTar(t);
    expect(files.map((f) => f.path)).toEqual(["main.tex", "sec/intro.tex", long, "data/pax-name.txt"]);
    expect(text(files[1].bytes)).toBe("Intro");
  });

  it("streams: works when chunks split headers and data at odd offsets", async () => {
    const t = tar([
      { name: "a.tex", data: "x".repeat(700) },
      { name: "b.tex", data: "yz" },
    ]);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < t.length; i += 37) c.enqueue(t.slice(i, i + 37));
        c.close();
      },
    });
    const files = await readTar(stream);
    expect(files.map((f) => [f.path, f.bytes.length])).toEqual([
      ["a.tex", 700],
      ["b.tex", 2],
    ]);
  });

  it("rejects path traversal and absolute paths", async () => {
    await expect(readTar(tar([{ name: "../evil.tex", data: "x" }]))).rejects.toThrow(/outside the project/);
    await expect(readTar(tar([{ name: "ok/../../evil.tex", data: "x" }]))).rejects.toThrow(/outside the project/);
    await expect(readTar(tar([{ name: "/etc/passwd", data: "x" }]))).rejects.toThrow(/absolute path/);
    expect(() => safeArchivePath("C:\\x.tex")).toThrow(/absolute/);
    expect(safeArchivePath("./a/./b.tex")).toBe("a/b.tex");
  });

  it("rejects a corrupt header and a truncated file", async () => {
    const t = tar([{ name: "a.tex", data: "hello" }]);
    const bad = t.slice();
    bad[0] ^= 0xff;
    await expect(readTar(bad)).rejects.toThrow(/tar archive/);
    await expect(readTar(t.slice(0, 514))).rejects.toThrow(/truncated/);
  });
});

describe("loadProjectArchive", () => {
  const project = tar([
    { name: "ms.tex", data: "\\documentclass{article}\n\\begin{document}\nHi % secret\n\\input{sec}\n\\end{document}\n" },
    { name: "sec.tex", data: "Section." },
    { name: "ms.bbl", data: "\\begin{thebibliography}{1}\\end{thebibliography}" },
    { name: "ms.aux", data: "aux" },
  ]);

  it("opens an arXiv .tar.gz e-print and cleans it like a zip", async () => {
    const gz = new Uint8Array(gzipSync(project));
    expect(sniffArchive(gz)).toBe("gzip");
    const p = await loadProjectArchive(gz, "2101.00001.tar.gz");
    expect(p.format).toBe("tar.gz");
    expect(p.files.map((f) => f.path)).toEqual(["ms.aux", "ms.bbl", "ms.tex", "sec.tex"]);
    expect(p.zipSize).toBe(gz.length);
    const r = await cleanProject(p);
    const z = await JSZip.loadAsync(r.output);
    expect(Object.keys(z.files).sort()).toEqual(["ms.bbl", "ms.tex", "sec.tex"]);
    expect(await z.file("ms.tex")!.async("string")).not.toContain("secret");
  });

  it("opens a plain .tar", async () => {
    const p = await loadProjectArchive(project, "x.tar");
    expect(p.format).toBe("tar");
    expect(p.texts["sec.tex"]).toBe("Section.");
  });

  it("opens a single-file gzip e-print as one .tex file", async () => {
    const gz = new Uint8Array(gzipSync(new TextEncoder().encode("\\documentclass{article}\\begin{document}x\\end{document}")));
    const p = await loadProjectArchive(gz, "2101.00001v2.gz");
    expect(p.format).toBe("gz");
    expect(p.files.map((f) => f.path)).toEqual(["2101.00001v2.tex"]);
  });

  it("still opens zips and rejects other files", async () => {
    const z = new JSZip();
    z.file("a.tex", "x");
    const p = await loadProjectArchive(await z.generateAsync({ type: "uint8array" }));
    expect(p.format).toBe("zip");
    await expect(loadProjectArchive(new TextEncoder().encode("hello world"))).rejects.toThrow(/isn't a \.zip/);
    await expect(loadProjectArchive(new Uint8Array([0x1f, 0x8b, 1, 2, 3]))).rejects.toThrow();
  });

  it("names single-file e-prints", () => {
    expect(singleFileName("ms.tex.gz")).toBe("ms.tex");
    expect(singleFileName("2101.00001.gz")).toBe("2101.00001.tex");
    expect(singleFileName("2101.00001")).toBe("2101.00001.tex");
    expect(singleFileName("hep-th/9901001.gz")).toBe("9901001.tex");
  });
});
