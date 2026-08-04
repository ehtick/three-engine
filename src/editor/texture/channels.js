/**
 * Channel operations — the part of this editor that exists specifically because
 * it lives in a game engine.
 *
 * A PBR set arrives as four separate greyscale files (roughness, metalness,
 * ambient occlusion, height) and ships as one RGB texture, because four
 * single-channel textures cost four samplers, four decode passes and four times
 * the memory of the one that holds all of them. Doing that repack anywhere else
 * means leaving the editor for every material, which is exactly the round trip
 * this module is meant to end.
 *
 * Sources of different sizes are resampled to the output size rather than
 * refused: a 2K albedo with a 1K roughness beside it is completely normal, and
 * "these must match" is a worse answer than resampling one of them.
 */

import { createBuffer, resizeBuffer } from "./pixels.js";
import { luminance } from "./adjust.js";

/** @typedef {import("./pixels.js").PixelBuffer} PixelBuffer */

/** What a channel can be filled from. `luminance` is the one that matters for
 *  packing: a "greyscale" map exported as RGB has its data in all three. */
export const CHANNEL_SOURCES = ["r", "g", "b", "a", "luminance", "one", "zero"];

const CHANNEL_INDEX = { r: 0, g: 1, b: 2, a: 3 };

function sampleChannel(data, i, source) {
  if (source === "one") return 255;
  if (source === "zero") return 0;
  if (source === "luminance") return luminance(data[i], data[i + 1], data[i + 2]);
  return data[i + (CHANNEL_INDEX[source] ?? 0)];
}

/**
 * Rewrites a buffer's channels from its own channels.
 *
 * @param {PixelBuffer} buffer
 * @param {{r?: string, g?: string, b?: string, a?: string}} mapping source per output channel
 * @param {{invert?: {r?: boolean, g?: boolean, b?: boolean, a?: boolean}}} [options]
 */
export function swizzle(buffer, mapping = {}, { invert = {} } = {}) {
  const { data } = buffer;
  const src = new Uint8ClampedArray(data);
  const plan = [
    ["r", mapping.r ?? "r"],
    ["g", mapping.g ?? "g"],
    ["b", mapping.b ?? "b"],
    ["a", mapping.a ?? "a"],
  ];
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      const [name, source] = plan[c];
      const value = sampleChannel(src, i, source);
      data[i + c] = invert[name] ? 255 - value : value;
    }
  }
  return buffer;
}

/**
 * Builds one texture from up to four sources — the repack.
 *
 * @param {{width: number, height: number, filter?: string,
 *          channels: {r?: Slot, g?: Slot, b?: Slot, a?: Slot}}} spec
 *   where Slot = `{ buffer, source, invert, constant }`. A slot with no buffer
 *   uses `constant` (0..255), which is how "metalness is 0 everywhere" is
 *   expressed without authoring a black image for it.
 * @returns {PixelBuffer}
 */
export function packChannels({ width, height, channels = {}, filter = "bilinear" }) {
  const out = createBuffer(width, height, [0, 0, 0, 255]);
  const names = ["r", "g", "b", "a"];
  // Resample each distinct source once, not once per channel — the common case
  // is one file feeding two channels.
  const resampled = new Map();
  const fit = (buffer) => {
    if (!buffer) return null;
    if (buffer.width === out.width && buffer.height === out.height) return buffer;
    if (!resampled.has(buffer)) resampled.set(buffer, resizeBuffer(buffer, out.width, out.height, { filter }));
    return resampled.get(buffer);
  };

  for (let c = 0; c < 4; c++) {
    const slot = channels[names[c]];
    const constant = Math.max(0, Math.min(255, Math.round(slot?.constant ?? (c === 3 ? 255 : 0))));
    const source = fit(slot?.buffer);
    if (!source) {
      for (let i = c; i < out.data.length; i += 4) out.data[i] = constant;
      continue;
    }
    const from = slot?.source ?? "luminance";
    for (let i = 0; i < out.data.length; i += 4) {
      const value = sampleChannel(source.data, i, from);
      out.data[i + c] = slot?.invert ? 255 - value : value;
    }
  }
  return out;
}

/** One greyscale buffer per channel — the inverse of packing, for pulling a
 *  packed map apart to edit one of its channels. */
export function splitChannels(buffer) {
  const out = {};
  for (const [name, index] of Object.entries(CHANNEL_INDEX)) {
    const channel = createBuffer(buffer.width, buffer.height);
    for (let i = 0; i < buffer.data.length; i += 4) {
      const v = buffer.data[i + index];
      channel.data[i] = channel.data[i + 1] = channel.data[i + 2] = v;
      channel.data[i + 3] = 255;
    }
    out[name] = channel;
  }
  return out;
}

/**
 * Premultiply / unpremultiply.
 *
 * Needed when a pipeline outside the editor expects one convention or the
 * other — some sprite atlases and some video codecs are premultiplied. The
 * editor itself is straight-alpha throughout, so these are explicit
 * conversions, never applied silently.
 */
export function premultiply(buffer) {
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    data[i] *= a;
    data[i + 1] *= a;
    data[i + 2] *= a;
  }
  return buffer;
}

export function unpremultiply(buffer) {
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a <= 0) continue;
    data[i] /= a;
    data[i + 1] /= a;
    data[i + 2] /= a;
  }
  return buffer;
}

/** Turns brightness into transparency — how a scanned decal or a logo on a
 *  white background becomes a usable texture in one step. */
export function alphaFromLuminance(buffer, { invert = false, keepColor = true } = {}) {
  const { data } = buffer;
  for (let i = 0; i < data.length; i += 4) {
    const l = luminance(data[i], data[i + 1], data[i + 2]);
    data[i + 3] = invert ? 255 - l : l;
    if (!keepColor) data[i] = data[i + 1] = data[i + 2] = 255;
  }
  return buffer;
}

/** Discards alpha — makes an opaque texture out of one with holes. */
export function fillChannel(buffer, channel, value = 255) {
  const index = CHANNEL_INDEX[channel] ?? 3;
  const v = Math.max(0, Math.min(255, Math.round(value)));
  for (let i = index; i < buffer.data.length; i += 4) buffer.data[i] = v;
  return buffer;
}

/**
 * Bleeds visible colour outward into transparent texels.
 *
 * Not cosmetic: a sprite's transparent border holds arbitrary RGB, and bilinear
 * filtering (or a mipmap) averages it into the visible edge — the dark or white
 * fringe every atlas has until someone does this. `distance` passes of a
 * nearest-opaque flood is enough for any mip chain that matters.
 */
export function bleedAlpha(buffer, { distance = 4 } = {}) {
  const { width, height, data } = buffer;
  let filled = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) filled[i] = data[i * 4 + 3] > 0 ? 1 : 0;

  for (let pass = 0; pass < Math.max(1, Math.round(distance)); pass++) {
    const next = new Uint8Array(filled);
    let changed = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (filled[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const sx = x + kx;
            const sy = y + ky;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
            const s = sy * width + sx;
            if (!filled[s]) continue;
            r += data[s * 4];
            g += data[s * 4 + 1];
            b += data[s * 4 + 2];
            n++;
          }
        }
        if (!n) continue;
        data[i * 4] = r / n;
        data[i * 4 + 1] = g / n;
        data[i * 4 + 2] = b / n;
        // Alpha stays zero — the point is to fix what filtering samples, not
        // to make the border visible.
        next[i] = 1;
        changed = true;
      }
    }
    filled = next;
    if (!changed) break;
  }
  return buffer;
}
