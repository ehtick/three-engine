// @ts-check
/**
 * Bit twiddling, packing and hashing.
 *
 * Three jobs that keep coming up once a game is more than a prototype:
 *
 *   - **Flag sets.** Layer masks, ability flags, "which of these 32 doors are
 *     open" — one integer instead of an array of booleans, and free to compare
 *     and serialize.
 *   - **Packing.** Squeezing a value into a texture channel or a save file,
 *     and getting it back out unchanged.
 *   - **Hashing.** Turning a name into a stable number: a seed, a colour, a
 *     bucket index. Stable across runs and machines, unlike anything derived
 *     from object identity.
 *
 * All the bitwise operations work on 32-bit integers, because that is what
 * JavaScript's `&`/`|`/`<<` silently coerce their operands to. Passing a value
 * above 2³¹ or a fractional one gets you the truncated result, not an error.
 */

/**
 * True when `flags` has every bit in `mask` set.
 *
 * @param {number} flags
 * @param {number} mask
 * @returns {boolean}
 */
export function hasFlag(flags, mask) {
  return (flags & mask) === mask;
}

/**
 * True when `flags` has *any* bit in `mask` — the test a layer mask wants.
 *
 * @param {number} flags
 * @param {number} mask
 * @returns {boolean}
 */
export function hasAnyFlag(flags, mask) {
  return (flags & mask) !== 0;
}

/**
 * @param {number} flags
 * @param {number} mask
 * @returns {number}
 */
export function setFlag(flags, mask) {
  return (flags | mask) >>> 0;
}

/**
 * @param {number} flags
 * @param {number} mask
 * @returns {number}
 */
export function clearFlag(flags, mask) {
  return (flags & ~mask) >>> 0;
}

/**
 * @param {number} flags
 * @param {number} mask
 * @returns {number}
 */
export function toggleFlag(flags, mask) {
  return (flags ^ mask) >>> 0;
}

/**
 * Sets or clears in one call, for the common `setVisible(bool)` shape.
 *
 * @param {number} flags
 * @param {number} mask
 * @param {boolean} enabled
 * @returns {number}
 */
export function writeFlag(flags, mask, enabled) {
  return enabled ? setFlag(flags, mask) : clearFlag(flags, mask);
}

/**
 * The mask for a single bit index — `bit(3)` is 8.
 *
 * @param {number} index 0..31.
 * @returns {number}
 */
export function bit(index) {
  return (1 << index) >>> 0;
}

/**
 * How many bits are set — a population count, for "how many layers does this
 * mask cover" or a cheap similarity metric between two flag sets.
 *
 * @param {number} value
 * @returns {number}
 */
export function bitCount(value) {
  // The standard SWAR popcount: pairs, then nibbles, then bytes, in five
  // steps with no loop and no lookup table.
  let v = value >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >>> 24) & 0xff;
}

/**
 * The index of the lowest set bit, or -1 for zero.
 *
 * @param {number} value
 * @returns {number}
 */
export function lowestBitIndex(value) {
  const v = value >>> 0;
  return v === 0 ? -1 : 31 - Math.clz32(v & -v);
}

/**
 * Every set bit's index, as an array — turning a mask back into the list of
 * layers it names.
 *
 * @param {number} value
 * @returns {number[]}
 */
export function bitIndices(value) {
  const indices = [];
  let v = value >>> 0;
  while (v !== 0) {
    const index = 31 - Math.clz32(v & -v);
    indices.push(index);
    v = (v & (v - 1)) >>> 0;
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/**
 * Splits a 32-bit integer into four bytes, high byte first. Writing an id into
 * an RGBA pixel, or a value into a binary asset.
 *
 * @param {number} value
 * @param {number[]} [out]
 * @returns {number[]} `[b3, b2, b1, b0]`, each 0..255.
 */
export function intToBytes32(value, out = []) {
  out[0] = (value >> 24) & 0xff;
  out[1] = (value >> 16) & 0xff;
  out[2] = (value >> 8) & 0xff;
  out[3] = value & 0xff;
  out.length = 4;
  return out;
}

/**
 * The inverse of {@link intToBytes32}.
 *
 * @param {number} b3
 * @param {number} b2
 * @param {number} b1
 * @param {number} b0
 * @returns {number}
 */
export function bytesToInt32(b3, b2, b1, b0) {
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
}

/**
 * Three bytes — what fits in an RGB pixel without an alpha channel to fight
 * over with premultiplication.
 *
 * @param {number} value
 * @param {number[]} [out]
 * @returns {number[]}
 */
export function intToBytes24(value, out = []) {
  out[0] = (value >> 16) & 0xff;
  out[1] = (value >> 8) & 0xff;
  out[2] = value & 0xff;
  out.length = 3;
  return out;
}

/**
 * The inverse of {@link intToBytes24}.
 *
 * @param {number} b2
 * @param {number} b1
 * @param {number} b0
 * @returns {number}
 */
export function bytesToInt24(b2, b1, b0) {
  return ((b2 << 16) | (b1 << 8) | b0) >>> 0;
}

/**
 * Packs two 16-bit halves into one 32-bit integer — a pair of grid
 * coordinates into a single `Map` key, which is far cheaper than a string.
 *
 * @param {number} high
 * @param {number} low
 * @returns {number}
 */
export function packUint16Pair(high, low) {
  return (((high & 0xffff) << 16) | (low & 0xffff)) >>> 0;
}

/**
 * The inverse of {@link packUint16Pair}.
 *
 * @param {number} packed
 * @param {{ high: number, low: number }} [out]
 * @returns {{ high: number, low: number }}
 */
export function unpackUint16Pair(packed, out = { high: 0, low: 0 }) {
  out.high = (packed >>> 16) & 0xffff;
  out.low = packed & 0xffff;
  return out;
}

/**
 * Packs an RGB triple of 0..1 floats into one integer, `0xRRGGBB` — the form
 * three's `Color.getHex()` uses and the one a CSS string wants.
 *
 * @param {number} r 0..1
 * @param {number} g 0..1
 * @param {number} b 0..1
 * @returns {number}
 */
export function packColor(r, g, b) {
  const to8 = (/** @type {number} */ v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return ((to8(r) << 16) | (to8(g) << 8) | to8(b)) >>> 0;
}

/**
 * The inverse of {@link packColor}.
 *
 * @param {number} hex
 * @param {{ r: number, g: number, b: number }} [out]
 * @returns {{ r: number, g: number, b: number }}
 */
export function unpackColor(hex, out = { r: 0, g: 0, b: 0 }) {
  out.r = ((hex >> 16) & 0xff) / 255;
  out.g = ((hex >> 8) & 0xff) / 255;
  out.b = (hex & 0xff) / 255;
  return out;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Avalanche mix for a 32-bit integer, in the style of PCG's output
 * permutation: flipping one input bit changes about half the output bits.
 *
 * Exists as its own function because *every* hash here needs it as a
 * finisher, and because it doubles as an integer hash for lattice
 * coordinates (which is exactly what the noise field uses it for).
 *
 * @param {number} value
 * @returns {number} a well-mixed uint32.
 */
export function hashInt(value) {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * FNV-1a over a string, avalanche-mixed, as a uint32. Stable across runs,
 * machines and sessions, which is what makes it usable as a seed, a bucket
 * index or a save key — none of which can be built on object identity or
 * insertion order.
 *
 * The {@link hashInt} finisher is not optional. Raw FNV-1a barely diffuses its
 * last byte into the high bits, so `"enemy_01"` and `"enemy_02"` come out
 * within half a percent of each other — which means every value derived from
 * the top of the hash (a hue, a `[0, 1)` float, a bucket) is nearly identical
 * for adjacent names. That is precisely the case these are used for.
 *
 * Not a cryptographic hash. Do not use it where an attacker picks the input.
 *
 * @param {string} text
 * @returns {number}
 */
export function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hashInt(hash);
}

/**
 * Mixes two hashes into one, order-dependently — building a key out of several
 * parts without concatenating strings.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function hashCombine(a, b) {
  // The constant is the 32-bit golden ratio; the shifts stop nearby inputs
  // from producing nearby outputs, which a plain xor does not.
  return (a ^ (b + 0x9e3779b9 + (a << 6) + (a >>> 2))) >>> 0;
}

/**
 * A uint32 as a `[0, 1)` float — the bridge from a hash to anything that wants
 * a normalized random-looking value (a colour, a jitter, a probability).
 *
 * @param {number} hash
 * @returns {number}
 */
export function hashToFloat(hash) {
  return (hash >>> 0) / 4294967296;
}

/**
 * A visually distinct colour for a string, as `0xRRGGBB`. Debug overlays,
 * per-player colours, per-thread timeline bars: the same name always gets the
 * same colour, and adjacent names get different ones.
 *
 * @param {string} text
 * @param {number} [saturation=0.65]
 * @param {number} [lightness=0.55]
 * @returns {number}
 */
export function colorFromString(text, saturation = 0.65, lightness = 0.55) {
  const hue = hashToFloat(hashString(text));
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hp = hue * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = lightness - c / 2;
  /** @type {[number, number, number]} */
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return packColor(rgb[0] + m, rgb[1] + m, rgb[2] + m);
}
