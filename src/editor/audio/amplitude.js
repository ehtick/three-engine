/**
 * Level: the operations that change how loud something is without changing
 * what it is.
 *
 * All of them take a frame range and default to the whole buffer, because
 * "apply to the selection, or to everything if nothing is selected" is the
 * convention every audio editor uses and the one the panel relies on.
 *
 * Nothing here clamps. A normalise that runs after a compressor needs to see
 * the +1.4 peak the compressor left behind; clipping between steps would
 * destroy the information the next step was going to use. Clipping happens once,
 * in `wav.js`, on the way to a fixed-point format.
 */
import { clonePcm, frameCount, dbToGain, gainToDb, peak as peakOf } from "./pcm.js";
import { normalizeRange } from "./edits.js";

/** Multiplies the range by a constant gain expressed in dB. */
export function amplify(pcm, db, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  const gain = dbToGain(db);
  const out = clonePcm(pcm);
  for (const ch of out.channels) {
    for (let i = from; i < to; i++) ch[i] *= gain;
  }
  return out;
}

/**
 * Scales the range so its loudest sample lands exactly on `targetDb`.
 *
 * One gain for **all** channels, computed from the loudest sample across all of
 * them. Normalising each channel to its own peak is a different operation that
 * silently rewrites the stereo image — a sound panned 70% left comes back
 * centred — and it is almost never what someone asking to "normalise" wants.
 */
export function normalizePeak(pcm, targetDb = -1, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  let max = 0;
  for (const ch of pcm.channels) {
    for (let i = from; i < to; i++) {
      const v = ch[i] < 0 ? -ch[i] : ch[i];
      if (v > max) max = v;
    }
  }
  // Digital silence has no peak to normalise to; scaling it by anything is
  // still silence, and dividing by zero would fill the buffer with NaN.
  if (max === 0) return clonePcm(pcm);
  return amplify(pcm, gainToDb(dbToGain(targetDb) / max), from, to);
}

/**
 * Scales the range so its *average* level lands on `targetDb`.
 *
 * RMS matching is what makes a set of footsteps sound like one set: peak
 * normalising them leaves the ones with a sharp transient much quieter to the
 * ear than the ones without. The tradeoff is that RMS can push peaks past full
 * scale, so this reports what it did rather than silently limiting — the caller
 * decides whether to follow with a limiter.
 */
export function normalizeRms(pcm, targetDb = -18, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  let sum = 0;
  let count = 0;
  for (const ch of pcm.channels) {
    for (let i = from; i < to; i++) {
      sum += ch[i] * ch[i];
      count++;
    }
  }
  const rms = count ? Math.sqrt(sum / count) : 0;
  if (rms === 0) return { pcm: clonePcm(pcm), appliedDb: 0, resultingPeak: 0 };
  const appliedDb = targetDb - gainToDb(rms);
  const out = amplify(pcm, appliedDb, from, to);
  return { pcm: out, appliedDb, resultingPeak: peakOf(out) };
}

/**
 * Fade shapes.
 *
 * `equalPower` is the one that matters for crossfades: two linear fades summed
 * across a crossfade dip ~3 dB in the middle, which is audible as a hole. The
 * sine/cosine pair sums to constant power instead. `logarithmic` is the natural
 * shape for a fade-out you want to *hear* as even, because loudness perception
 * is roughly logarithmic — a linear fade-out sounds like it hangs at the top and
 * then drops off a cliff.
 */
export const FADE_SHAPES = {
  linear: (t) => t,
  equalPower: (t) => Math.sin((t * Math.PI) / 2),
  logarithmic: (t) => t * t,
  exponential: (t) => Math.sqrt(t),
  smooth: (t) => t * t * (3 - 2 * t),
};

/** Ramps the range from silence to full (`direction: "in"`) or the reverse. */
export function fade(pcm, { direction = "in", shape = "equalPower", start, end } = {}) {
  const [from, to] = normalizeRange(pcm, start, end);
  const span = to - from;
  if (span <= 0) return clonePcm(pcm);
  const curve = FADE_SHAPES[shape] ?? FADE_SHAPES.linear;
  const out = clonePcm(pcm);
  for (const ch of out.channels) {
    for (let i = from; i < to; i++) {
      const t = (i - from) / span;
      ch[i] *= curve(direction === "out" ? 1 - t : t);
    }
  }
  return out;
}

/**
 * Crossfades `b` into the tail of `a` over `frames`, returning one buffer
 * shorter than `a + b` by exactly the overlap.
 *
 * Equal-power on both sides, for the reason in FADE_SHAPES: this is the
 * primitive the seamless-loop maker is built on, and a 3 dB dip at the loop
 * point is precisely the artefact it exists to remove.
 */
export function crossfade(a, b, frames) {
  const aLen = frameCount(a);
  const bLen = frameCount(b);
  const overlap = Math.max(0, Math.min(frames, aLen, bLen));
  const channels = Math.max(a.channels.length, b.channels.length);
  const total = aLen + bLen - overlap;
  const out = { sampleRate: a.sampleRate, channels: [] };
  for (let c = 0; c < channels; c++) out.channels.push(new Float32Array(total));

  for (let c = 0; c < channels; c++) {
    const srcA = a.channels[c] ?? a.channels[0];
    const srcB = b.channels[c] ?? b.channels[0];
    const dst = out.channels[c];
    for (let i = 0; i < aLen - overlap; i++) dst[i] = srcA[i];
    for (let i = 0; i < overlap; i++) {
      const t = overlap === 1 ? 1 : i / (overlap - 1);
      const gainOut = Math.cos((t * Math.PI) / 2);
      const gainIn = Math.sin((t * Math.PI) / 2);
      dst[aLen - overlap + i] = srcA[aLen - overlap + i] * gainOut + srcB[i] * gainIn;
    }
    for (let i = overlap; i < bLen; i++) dst[aLen - overlap + i] = srcB[i];
  }
  return out;
}

/** Flips polarity. Summing the result with the original gives digital silence. */
export function invert(pcm, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  const out = clonePcm(pcm);
  for (const ch of out.channels) {
    for (let i = from; i < to; i++) ch[i] = -ch[i];
  }
  return out;
}

/**
 * Removes a constant DC offset by subtracting each channel's own mean.
 *
 * Per channel, not one mean for all of them: DC offset comes from the capture
 * chain (a mic preamp, a cheap interface) and there is no reason two channels
 * would share the same error. An offset costs headroom for nothing and makes
 * every edit boundary click, because a "zero crossing" that never crosses zero
 * cannot be snapped to.
 */
export function removeDcOffset(pcm, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  const span = to - from;
  if (span <= 0) return clonePcm(pcm);
  const out = clonePcm(pcm);
  for (const ch of out.channels) {
    let sum = 0;
    for (let i = from; i < to; i++) sum += ch[i];
    const mean = sum / span;
    for (let i = from; i < to; i++) ch[i] -= mean;
  }
  return out;
}

/**
 * Applies a piecewise-linear gain envelope. `points` are `{ t, gain }` with `t`
 * in 0..1 across the range — what the panel's envelope tool draws.
 */
export function applyEnvelope(pcm, points, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  const span = to - from;
  if (span <= 0 || !points?.length) return clonePcm(pcm);
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const out = clonePcm(pcm);
  for (const ch of out.channels) {
    for (let i = from; i < to; i++) ch[i] *= envelopeAt(sorted, (i - from) / span);
  }
  return out;
}

function envelopeAt(points, t) {
  if (t <= points[0].t) return points[0].gain;
  const last = points[points.length - 1];
  if (t >= last.t) return last.gain;
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].t) {
      const a = points[i - 1];
      const b = points[i];
      const span = b.t - a.t;
      return span === 0 ? b.gain : a.gain + ((t - a.t) / span) * (b.gain - a.gain);
    }
  }
  return last.gain;
}
