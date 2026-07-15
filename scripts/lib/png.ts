/**
 * Minimal deterministic PNG codec for the perceptual-golden runner (dev tooling
 * only — never bundled into the plugin). Encodes an 8-bit RGBA framebuffer to a
 * PNG container by hand and decodes one back to pixels for tolerant diffing.
 *
 * Determinism: fixed deflate level, no ancillary/timestamp chunks, and every
 * scanline is written with filter type 0 (None). Same pixels in ⇒ byte-identical
 * file out, on any machine with the same zlib.
 */
import { deflateSync, inflateSync, constants as zlibConstants } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Pinned deflate level: reproducible bytes rather than zlib's default. */
const DEFLATE_LEVEL = 6;

/** CRC32 (IEEE 802.3, the PNG polynomial) — table built once, inline. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "latin1");
  const body = Buffer.concat([typeBytes, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
}

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, length = width * height * 4. */
  data: Uint8Array;
}

/**
 * Encode an RGBA framebuffer to a PNG (color type 6, 8-bit). Every scanline is
 * prefixed with filter byte 0 (None), so the decoder never needs the Sub/Up/
 * Average/Paeth reconstruction paths for our own output.
 */
export function encodePng(img: RgbaImage): Buffer {
  const { width, height, data } = img;
  if (data.length !== width * height * 4) {
    throw new Error(`encodePng: data length ${data.length} ≠ ${width}×${height}×4`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive (only type 0 emitted)
  ihdr[12] = 0; // interlace: none

  // Prefix each scanline with a 0 filter byte.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, dst + 1);
  }
  const idat = deflateSync(raw, { level: DEFLATE_LEVEL, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY });

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG produced by `encodePng` (8-bit RGBA, no interlace) back to
 * pixels. Handles all five scanline filters for correctness even though the
 * encoder only writes filter 0.
 */
export function decodePng(buf: Buffer): RgbaImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("decodePng: bad signature");
  }
  let width = 0;
  let height = 0;
  const idatParts: Buffer[] = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const dataStart = off + 8;
    const data = buf.subarray(dataStart, dataStart + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error("decodePng: only 8-bit RGBA, non-interlaced is supported");
      }
    } else if (type === "IDAT") {
      idatParts.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    off = dataStart + len + 4; // skip data + CRC
  }
  const raw = inflateSync(Buffer.concat(idatParts));
  const stride = width * 4;
  const out = new Uint8Array(width * height * 4);
  const bpp = 4;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dstRow = y * stride;
    for (let i = 0; i < stride; i++) {
      const rawByte = raw[src + i];
      const a = i >= bpp ? out[dstRow + i - bpp] : 0;
      const b = y > 0 ? out[dstRow - stride + i] : 0;
      const c = y > 0 && i >= bpp ? out[dstRow - stride + i - bpp] : 0;
      let val: number;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: val = rawByte + paeth(a, b, c); break;
        default: throw new Error(`decodePng: unknown filter ${filter}`);
      }
      out[dstRow + i] = val & 0xff;
    }
  }
  return { width, height, data: out };
}
