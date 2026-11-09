import JSZip from "jszip";
import { findMainFiles } from "./count";

export interface TexProject {
  /** Text files by path inside the archive (.tex, .bbl, .sty, ...), macOS metadata skipped. */
  files: Record<string, string>;
  /** Candidate main files, best first. */
  mains: string[];
}

const TEXT_EXT = /\.(tex|ltx|bbl|sty|cls|txt)$/i;

/** Read a LaTeX project archive (Overleaf "Download source" zip) entirely in memory. */
export async function readTexZip(data: ArrayBuffer | Uint8Array): Promise<TexProject> {
  const zip = await JSZip.loadAsync(data);
  const files: Record<string, string> = {};
  const entries = Object.values(zip.files).filter(
    (f) => !f.dir && TEXT_EXT.test(f.name) && !f.name.startsWith("__MACOSX/") && !/(^|\/)\._/.test(f.name),
  );
  await Promise.all(
    entries.map(async (f) => {
      files[f.name] = await f.async("string");
    }),
  );
  return { files, mains: findMainFiles(files) };
}
