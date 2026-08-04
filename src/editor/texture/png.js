/**
 * A PNG encoder/decoder for the subset the texture editor produces and reads.
 *
 * Writing our own is not reinvention for its own sake — it is the only way to
 * get a **lossless round trip on alpha**. The canvas route (`putImageData` →
 * `toBlob` → `createImageBitmap` → `getImageData`) goes through premultiplied
 * storage in both directions, so a texel at alpha 3 comes back with a
 * different colour than it went in with. Every save/load cycle compounds it,
 * and the artefact shows up in exactly the places nobody looks until a sprite
 * is composited in-game and has a coloured fringe.
 *
 * Compression is the platform's: `CompressionStream("deflate")` emits a
 * zlib-wrapped deflate stream, which is precisely what a PNG IDAT holds. It
 * exists in Chromium and in Node ≥18, so this file stays pure and testable.
 *
 * Supported on decode: 8-bit non-interlaced greyscale / greyscale+alpha /
 * truecolour / truecolour+alpha. Anything else (palette, 16-bit, interlaced)
 * throws `UnsupportedPng`, and the editor falls back to decoding it through an
 * ImageBitmap — correctness there costs nothing, since a palette PNG has no
 * partial alpha to lose.
 */

/** @typedef {import("./pixels.js").PixelBuffer} PixelBuffer */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class UnsupportedPng extends Error {}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

async function streamThrough(transform, bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Chooses a filter per scanline by minimum sum of absolute *signed* values —
 * the heuristic the PNG spec itself recommends. Filtering matters more than it
 * looks: a flat-colour UI sprite stored unfiltered compresses to roughly twice
 * the size, and a normal map to considerably more.
 */
function filterScanlines(data, width, height, bpp) {
  const stride = width * bpp;
  const out = new Uint8Array((stride + 1) * height);
  const line = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  let prev = new Uint8Array(stride);
  let outAt = 0;

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    let bestType = 0;
    let bestScore = Infinity;

    for (let type = 0; type < 5; type++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const raw = data[rowStart + i];
        const a = i >= bpp ? data[rowStart + i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v;
        if (type === 0) v = raw;
        else if (type === 1) v = raw - a;
        else if (type === 2) v = raw - b;
        else if (type === 3) v = raw - ((a + b) >> 1);
        else v = raw - paeth(a, b, c);
        v &= 0xff;
        line[i] = v;
        score += v < 128 ? v : 256 - v;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best.set(line);
      }
    }

    out[outAt++] = bestType;
    out.set(best, outAt);
    outAt += stride;
    prev = data.subarray(rowStart, rowStart + stride);
  }
  return out;
}

function unfilterScanlines(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const type = raw[at++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[at + i];
      const a = i >= bpp ? out[rowStart + i - bpp] : 0;
      const b = y > 0 ? out[prevStart + i] : 0;
      const c = i >= bpp && y > 0 ? out[prevStart + i - bpp] : 0;
      let v;
      if (type === 0) v = x;
      else if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) v = x + paeth(a, b, c);
      else throw new UnsupportedPng(`Unknown PNG filter type ${type}`);
      out[rowStart + i] = v & 0xff;
    }
    at += stride;
  }
  return out;
}

function writeChunk(parts, type, body) {
  const chunk = new Uint8Array(12 + body.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(body, 8);
  view.setUint32(8 + body.length, crc32(chunk, 4, 8 + body.length));
  parts.push(chunk);
}

/**
 * @param {PixelBuffer} buffer
 * @returns {Promise<Uint8Array>} a complete PNG file
 */
export async function encodePng(buffer) {
  const { width, height, data } = buffer;
  const filtered = filterScanlines(
    data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.length),
    width,
    height,
    4,
  );
  const compressed = await streamThrough(new CompressionStream("deflate"), filtered);

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const parts = [new Uint8Array(SIGNATURE)];
  writeChunk(parts, "IHDR", ihdr);
  writeChunk(parts, "IDAT", compressed);
  writeChunk(parts, "IEND", new Uint8Array(0));

  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** True when `decodePng` can handle these bytes (cheap header-only check). */
export function isDecodablePng(bytes) {
  if (!bytes || bytes.length < 26) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false;
  const depth = bytes[24];
  const colorType = bytes[25];
  const interlace = bytes[28];
  return depth === 8 && (colorType === 0 || colorType === 2 || colorType === 4 || colorType === 6) && interlace === 0;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<PixelBuffer>}
 * @throws {UnsupportedPng} for anything outside the supported subset
 */
export async function decodePng(bytes) {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new UnsupportedPng("Not a PNG file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let bpp = 0;
  let colorType = 0;
  const idat = [];

  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const body = at + 8;
    if (type === "IHDR") {
      width = view.getUint32(body);
      height = view.getUint32(body + 4);
      const depth = bytes[body + 8];
      colorType = bytes[body + 9];
      const interlace = bytes[body + 12];
      if (depth !== 8) throw new UnsupportedPng(`Unsupported PNG bit depth ${depth}`);
      if (interlace !== 0) throw new UnsupportedPng("Interlaced PNGs are not supported");
      bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType] ?? 0;
      if (!bpp) throw new UnsupportedPng(`Unsupported PNG colour type ${colorType}`);
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(body, body + length));
    } else if (type === "IEND") {
      break;
    }
    at = body + length + 4;
  }
  if (!width || !height) throw new UnsupportedPng("PNG has no IHDR");

  let compressedLength = 0;
  for (const part of idat) compressedLength += part.length;
  const compressed = new Uint8Array(compressedLength);
  let ci = 0;
  for (const part of idat) {
    compressed.set(part, ci);
    ci += part.length;
  }

  const raw = unfilterScanlines(
    await streamThrough(new DecompressionStream("deflate"), compressed),
    width,
    height,
    bpp,
  );

  const data = new Uint8ClampedArray(width * height * 4);
  const count = width * height;
  for (let i = 0; i < count; i++) {
    const s = i * bpp;
    const d = i * 4;
    if (colorType === 6) {
      data[d] = raw[s];
      data[d + 1] = raw[s + 1];
      data[d + 2] = raw[s + 2];
      data[d + 3] = raw[s + 3];
    } else if (colorType === 2) {
      data[d] = raw[s];
      data[d + 1] = raw[s + 1];
      data[d + 2] = raw[s + 2];
      data[d + 3] = 255;
    } else if (colorType === 4) {
      data[d] = data[d + 1] = data[d + 2] = raw[s];
      data[d + 3] = raw[s + 1];
    } else {
      data[d] = data[d + 1] = data[d + 2] = raw[s];
      data[d + 3] = 255;
    }
  }
  return { width, height, data };
}
