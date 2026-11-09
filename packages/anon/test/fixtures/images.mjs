// Tiny image encoders for fixtures (no dependencies beyond node:zlib).
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)])), 8 + data.length);
  return out;
}

/** Solid-color RGB PNG, optionally with tEXt chunks. */
export function makePng(width, height, rgb = [80, 120, 200], text = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const texts = Object.entries(text).map(([k, v]) => chunk("tEXt", Buffer.from(`${k}\0${v}`, "latin1")));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...texts,
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** JPEG-shaped bytes carrying an EXIF APP1 with IFD0 Artist (enough for metadata readers). */
export function makeJpegWithArtist(artist) {
  const value = Buffer.from(artist + "\0", "latin1");
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + value.length);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); // one entry
  tiff.writeUInt16LE(0x013b, 10); // Artist
  tiff.writeUInt16LE(2, 12); // ASCII
  tiff.writeUInt32LE(value.length, 14);
  tiff.writeUInt32LE(8 + 2 + 12 + 4, 18); // offset to value
  tiff.writeUInt32LE(0, 22); // next IFD
  value.copy(tiff, 26);
  const app1Body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(app1Body.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, app1Body, Buffer.from([0xff, 0xd9])]);
}
