/**
 * Lossless removal of metadata segments from JPEG (DCTDecode) image data embedded in a PDF.
 * PDF renderers ignore these segments, so dropping them never changes how the page looks.
 *
 * Removed: APP1 (EXIF, XMP: camera, author, software, edit history), APP13 (Photoshop IRB/IPTC), COM (comments).
 * Kept: APP0 (JFIF), APP2 (ICC colour profile), APP14 (Adobe colour transform) and every coding segment.
 */
const DROP = new Set([0xe1, 0xed, 0xfe]);

/** Markers without a length field. */
const STANDALONE = (m: number) => m === 0x01 || (m >= 0xd0 && m <= 0xd7);

function segments(bytes: Uint8Array): { marker: number; start: number; end: number }[] | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const out: { marker: number; start: number; end: number }[] = [];
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) return null; // not where a marker should be: leave the image alone
    let j = i + 1;
    while (j < bytes.length && bytes[j] === 0xff) j++; // fill bytes
    const marker = bytes[j];
    if (marker === undefined) return null;
    if (STANDALONE(marker)) {
      out.push({ marker, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) {
      out.push({ marker, start: i, end: bytes.length }); // start of scan: the rest is entropy-coded data
      return out;
    }
    if (j + 2 >= bytes.length) return null;
    const len = (bytes[j + 1] << 8) | bytes[j + 2];
    const end = j + 1 + len;
    if (len < 2 || end > bytes.length) return null;
    out.push({ marker, start: i, end });
    i = end;
  }
  return out;
}

/** Number of metadata segments (EXIF/XMP/Photoshop/comment) in a JPEG. */
export function jpegMetadataCount(bytes: Uint8Array): number {
  return segments(bytes)?.filter((s) => DROP.has(s.marker)).length ?? 0;
}

/** The JPEG without metadata segments, or null if it has none or cannot be parsed safely. */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array | null {
  const segs = segments(bytes);
  if (!segs || !segs.some((s) => DROP.has(s.marker))) return null;
  const keep = segs.filter((s) => !DROP.has(s.marker));
  const size = 2 + keep.reduce((n, s) => n + s.end - s.start, 0);
  const out = new Uint8Array(size);
  out.set([0xff, 0xd8], 0);
  let o = 2;
  for (const s of keep) {
    out.set(bytes.subarray(s.start, s.end), o);
    o += s.end - s.start;
  }
  return out;
}
