import { deflateSync, inflateSync } from "node:zlib";

/** Straight-alpha RGBA8 raster. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(...parts: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(raw: Uint8Array, stride: number, height: number, bytesPerPixel: number): Uint8Array | null {
  const out = new Uint8Array(stride * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset];
    offset += 1;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[offset + x]!;
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel]! : 0;
      const up = prev ? prev[x]! : 0;
      const upLeft = prev && x >= bytesPerPixel ? prev[x - bytesPerPixel]! : 0;
      let decoded: number;
      switch (filter) {
        case 0: decoded = value; break;
        case 1: decoded = value + left; break;
        case 2: decoded = value + up; break;
        case 3: decoded = value + ((left + up) >> 1); break;
        case 4: decoded = value + paeth(left, up, upLeft); break;
        default: return null;
      }
      row[x] = decoded & 0xff;
    }
    offset += stride;
  }
  return out;
}

/**
 * Decode a non-interlaced PNG (any color type, bit depths 1-16) into RGBA8.
 * Returns null for anything it cannot represent so callers can fall back.
 */
export function decodePng(bytes: Uint8Array): RgbaImage | null {
  if (bytes.length < 8 || SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) return null;
    const chunk = bytes.subarray(start, end);
    if (type === "IHDR") {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      bitDepth = bytes[start + 8]!;
      colorType = bytes[start + 9]!;
      interlace = bytes[start + 12]!;
    } else if (type === "PLTE") {
      palette = chunk;
    } else if (type === "tRNS") {
      transparency = chunk;
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }

  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (!width || !height || interlace !== 0 || idat.length === 0 || !channels) return null;
  if (![1, 2, 4, 8, 16].includes(bitDepth)) return null;
  if (colorType === 3 && !palette) return null;

  const bitsPerPixel = channels * bitDepth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);

  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  if (raw.length < (stride + 1) * height) return null;
  const scanlines = unfilter(raw, stride, height, bytesPerPixel);
  if (!scanlines) return null;

  const maxSample = (1 << bitDepth) - 1;
  const readSample = (row: Uint8Array, index: number): number => {
    if (bitDepth === 8) return row[index]!;
    if (bitDepth === 16) return row[index * 2]!;
    const bitOffset = index * bitDepth;
    const byte = row[bitOffset >> 3]!;
    return (byte >> (8 - bitDepth - (bitOffset & 7))) & maxSample;
  };
  const scale = (sample: number): number => (bitDepth === 8 || bitDepth === 16 ? sample : Math.round((sample * 255) / maxSample));

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = scanlines.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      const base = x * channels;
      switch (colorType) {
        case 0: {
          const gray = scale(readSample(row, base));
          data[out] = gray; data[out + 1] = gray; data[out + 2] = gray; data[out + 3] = 255;
          break;
        }
        case 2:
          data[out] = scale(readSample(row, base));
          data[out + 1] = scale(readSample(row, base + 1));
          data[out + 2] = scale(readSample(row, base + 2));
          data[out + 3] = 255;
          break;
        case 3: {
          const index = readSample(row, base);
          data[out] = palette![index * 3] ?? 0;
          data[out + 1] = palette![index * 3 + 1] ?? 0;
          data[out + 2] = palette![index * 3 + 2] ?? 0;
          data[out + 3] = transparency?.[index] ?? 255;
          break;
        }
        case 4: {
          const gray = scale(readSample(row, base));
          data[out] = gray; data[out + 1] = gray; data[out + 2] = gray;
          data[out + 3] = scale(readSample(row, base + 1));
          break;
        }
        default:
          data[out] = scale(readSample(row, base));
          data[out + 1] = scale(readSample(row, base + 1));
          data[out + 2] = scale(readSample(row, base + 2));
          data[out + 3] = scale(readSample(row, base + 3));
      }
    }
  }

  return { width, height, data };
}

function chunk(type: string, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length, 0);
  header.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(header.subarray(4), payload), 0);
  return Buffer.concat([header, payload, crc]);
}

/** Encode an RGBA8 raster as a non-interlaced 8-bit RGBA PNG. */
export function encodePng(image: RgbaImage): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
