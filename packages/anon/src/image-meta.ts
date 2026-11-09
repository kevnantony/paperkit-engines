/**
 * Minimal, dependency-free readers for author-revealing metadata in raster images:
 * JPEG (EXIF APP1 + XMP APP1), PNG (tEXt / iTXt incl. XMP) and TIFF (IFD0). Pure.
 */
import { LOCAL_PATH_RE, xmpAuthors } from "./metadata";

export interface ImageMetaField {
  name: string;
  value: string;
}

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};
const utf8 = (b: Uint8Array) => new TextDecoder("utf-8").decode(b);

/** EXIF tags that carry a person's name. */
const EXIF_TAGS: Record<number, string> = { 0x013b: "EXIF Artist", 0x8298: "EXIF Copyright", 0x9c9d: "EXIF XPAuthor", 0xa430: "EXIF CameraOwnerName" };

export function parseTiffAuthors(t: Uint8Array): ImageMetaField[] {
  if (t.length < 8) return [];
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return [];
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const out: ImageMetaField[] = [];

  const readIfd = (off: number, depth: number) => {
    if (off <= 0 || off + 2 > t.length || depth > 2) return;
    const n = u16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      if (e + 12 > t.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      if (tag === 0x8769) readIfd(u32(e + 8), depth + 1); // Exif sub-IFD
      const name = EXIF_TAGS[tag];
      if (!name) continue;
      const size = type === 2 || type === 1 || type === 7 ? count : 0;
      if (!size) continue;
      const start = size <= 4 ? e + 8 : u32(e + 8);
      if (start + size > t.length) continue;
      const raw = t.subarray(start, start + size);
      const value =
        tag === 0x9c9d
          ? new TextDecoder("utf-16le").decode(raw).replace(/\0+$/g, "")
          : latin1(raw).replace(/\0+$/g, "").trim();
      if (value.trim()) out.push({ name, value: value.trim() });
    }
  };
  readIfd(u32(4), 0);
  return out;
}

function xmpFields(xmp: string): ImageMetaField[] {
  const out: ImageMetaField[] = xmpAuthors(xmp).map((value) => ({ name: "XMP author", value }));
  for (const m of xmp.match(LOCAL_PATH_RE) ?? []) out.push({ name: "XMP file path", value: m });
  return out;
}

export function readJpegMeta(b: Uint8Array): ImageMetaField[] {
  const out: ImageMetaField[] = [];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    const seg = b.subarray(i + 4, i + 2 + len);
    if (marker === 0xe1) {
      const head = latin1(seg.subarray(0, 29));
      if (head.startsWith("Exif\0\0")) out.push(...parseTiffAuthors(seg.subarray(6)));
      else if (head.startsWith("http://ns.adobe.com/xap/1.0/")) out.push(...xmpFields(utf8(seg.subarray(29))));
    }
    i += 2 + len;
  }
  return out;
}

const PNG_KEYS = ["author", "artist", "copyright", "creator", "owner"];

export function readPngMeta(b: Uint8Array): ImageMetaField[] {
  const out: ImageMetaField[] = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 8;
  while (i + 8 <= b.length) {
    const len = dv.getUint32(i);
    const type = latin1(b.subarray(i + 4, i + 8));
    const data = b.subarray(i + 8, i + 8 + len);
    if (type === "tEXt" || type === "iTXt") {
      const z = data.indexOf(0);
      if (z > 0) {
        const key = latin1(data.subarray(0, z));
        let value: string | null = null;
        if (type === "tEXt") value = latin1(data.subarray(z + 1));
        else if (data[z + 1] === 0) {
          // iTXt: key\0 flag method lang\0 translated\0 text
          let p = z + 3;
          p = data.indexOf(0, p) + 1;
          p = data.indexOf(0, p) + 1;
          if (p > 0) value = utf8(data.subarray(p));
        }
        if (value !== null) {
          if (key === "XML:com.adobe.xmp") out.push(...xmpFields(value));
          else if (PNG_KEYS.includes(key.toLowerCase()) && value.trim()) out.push({ name: `PNG ${key}`, value: value.trim() });
        }
      }
    }
    if (type === "IEND") break;
    i += 12 + len;
  }
  return out;
}

/** Author-like metadata in a raster image, by file signature. Unknown formats return []. */
export function readImageMeta(bytes: Uint8Array): ImageMetaField[] {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return readJpegMeta(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return readPngMeta(bytes);
    if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) return parseTiffAuthors(bytes);
  } catch {
    /* malformed image: ignore */
  }
  return [];
}
