/**
 * Build-time texture size cap.
 *
 * Source art is authored at whatever size the artist exported (4K PBR sets are
 * the norm for downloads), but a web build pays for every texel twice: once on
 * the wire and once in VRAM. The Basis build path resamples anything larger
 * than the cap — the SOURCE is never touched, only the derivative that ships.
 *
 * Per-texture override: `maxSize` in the texture's `.meta`. `0` means "never
 * cap" (a hero texture); any positive number replaces the build-wide cap.
 *
 * Pure on purpose — `node --test tests/texture-build-size.test.mjs`.
 */

export const DEFAULT_MAX_TEXTURE_SIZE = 2048;

const isPowerOfTwo = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
const floorPowerOfTwo = (n) => 2 ** Math.floor(Math.log2(n));

/** The cap that applies to one texture: its meta's `maxSize`, else the build's. 0 = uncapped. */
export function resolveTextureCap(meta, buildMax) {
  const own = meta?.maxSize;
  if (own !== undefined && own !== null && own !== "") {
    const n = Number(own);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const fallback = buildMax === undefined || buildMax === null || buildMax === "" ? NaN : Number(buildMax);
  return Number.isFinite(fallback) && fallback >= 0 ? Math.floor(fallback) : DEFAULT_MAX_TEXTURE_SIZE;
}

/**
 * The size a texture ships at. Aspect ratio is preserved; a power-of-two
 * source stays power-of-two (halved until it fits, so a 3000 cap turns a
 * 4096 map into 2048 rather than a mip-hostile 3000) — NPOT sources scale to
 * the cap exactly.
 *
 * @returns {{ width: number, height: number, resized: boolean, cap: number } | null}
 *   null when the source dimensions are unusable.
 */
export function textureBuildSize({ width, height } = {}, meta, buildMax) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null;
  const cap = resolveTextureCap(meta, buildMax);
  const largest = Math.max(w, h);
  if (cap === 0 || largest <= cap) return { width: w, height: h, resized: false, cap };
  if (isPowerOfTwo(w) && isPowerOfTwo(h)) {
    const divisor = largest / floorPowerOfTwo(cap);
    return {
      width: Math.max(1, Math.floor(w / divisor)),
      height: Math.max(1, Math.floor(h / divisor)),
      resized: true,
      cap,
    };
  }
  const scale = cap / largest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    resized: true,
    cap,
  };
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * Width/height from the head of a PNG or JPEG file (the only formats the
 * Basis build path encodes). A JPEG's frame header follows its EXIF block, so
 * callers should hand over a few hundred KB, not just the first few bytes.
 */
export function imageDimensions(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Uint8Array.from(bytes ?? []);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 3 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; } // fill byte
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // no length
      if (JPEG_SOF.has(marker)) {
        if (i + 8 >= b.length) return null;
        return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return null;
}

/**
 * File name of a capped derivative in the build cache. Keyed by everything
 * that changes the encoded bytes — source path + mtime, target size, codec —
 * so an edited source or a changed cap re-encodes and an unchanged one does
 * not (UASTC on a 4K map costs seconds; live-preview builds run per edit).
 */
export function basisBuildCacheName(source, { mtime = 0, width, height, mode = "srgb" } = {}) {
  const key = `${String(source).replaceAll("\\", "/").toLowerCase()}|${mtime}|${width}x${height}|${mode}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const stem = String(source).split(/[\\/]/).pop().replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "_");
  return `${stem}-${width}x${height}-${hash.toString(16).padStart(8, "0")}.basis`;
}
