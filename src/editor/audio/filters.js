/**
 * Biquad filters and the EQ built from them.
 *
 * Coefficients follow the Audio EQ Cookbook (Robert Bristow-Johnson), which is
 * the same set Web Audio's BiquadFilterNode uses — so a filter dialled in here
 * and the same filter in a runtime graph agree, and nobody has to learn two
 * different meanings of "Q".
 *
 * **Filtering runs forwards then backwards** (`filtfilt`) when `zeroPhase` is
 * on. A single forward pass is causal and therefore shifts different frequencies
 * by different amounts, which smears transients — on a game SFX, a kick's attack
 * arrives before its body and the sound loses its punch. Running the filter
 * again over the reversed signal cancels the phase shift exactly, at the cost of
 * doubling the effective filter order (a 12 dB/oct filter becomes 24).
 */
import { clonePcm } from "./pcm.js";
import { normalizeRange } from "./edits.js";

/**
 * Cookbook coefficients, normalised so a0 = 1.
 * `type` is one of: lowpass, highpass, bandpass, notch, allpass, peaking,
 * lowshelf, highshelf. `gainDb` only means something for the last three.
 */
export function biquadCoefficients({ type, frequency, sampleRate, q = Math.SQRT1_2, gainDb = 0 }) {
  // Above Nyquist a filter is meaningless and the maths goes imaginary; clamp
  // just under so a user dragging a cutoff to the top gets "everything passes"
  // rather than NaN across the whole buffer.
  const f0 = Math.max(1, Math.min(frequency, sampleRate * 0.499));
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const Q = Math.max(0.0001, q);
  const alpha = sin / (2 * Q);
  const A = 10 ** (gainDb / 40);

  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case "lowpass":
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case "highpass":
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case "bandpass": // constant 0 dB peak gain
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case "notch":
      b0 = 1; b1 = -2 * cos; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case "allpass":
      b0 = 1 - alpha; b1 = -2 * cos; b2 = 1 + alpha;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case "peaking":
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
      break;
    case "lowshelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + s);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - s);
      a0 = A + 1 + (A - 1) * cos + s;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - s;
      break;
    }
    case "highshelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + s);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - s);
      a0 = A + 1 - (A - 1) * cos + s;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - s;
      break;
    }
    default:
      throw new Error(`Unknown filter type "${type}"`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** One forward pass of a direct-form-I biquad over a Float32Array slice. */
function runBiquad(data, from, to, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = from; i < to; i++) {
    const x0 = data[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
    data[i] = y0;
  }
}

function runBiquadReverse(data, from, to, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = to - 1; i >= from; i--) {
    const x0 = data[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
    data[i] = y0;
  }
}

/**
 * Applies one biquad to a range. `zeroPhase` runs it forwards and backwards
 * (see the module note) — on by default, because preserving transients is
 * almost always what game audio wants.
 */
export function applyBiquad(pcm, options, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  const coefficients = biquadCoefficients({ ...options, sampleRate: pcm.sampleRate });
  const out = clonePcm(pcm);
  for (const ch of out.channels) {
    runBiquad(ch, from, to, coefficients);
    if (options.zeroPhase !== false) runBiquadReverse(ch, from, to, coefficients);
  }
  return out;
}

/**
 * A chain of bands applied in order. Bands are
 * `{ type, frequency, q, gainDb, enabled }`.
 *
 * Applied as a chain rather than summed in parallel: series is how a mixing EQ
 * behaves and how the coefficients above are derived. Summing parallel bands
 * would make overlapping bands interfere and produce comb filtering nobody asked
 * for.
 */
export function applyEq(pcm, bands, start, end) {
  let out = pcm;
  for (const band of bands ?? []) {
    if (band.enabled === false) continue;
    if (band.type !== "peaking" && band.type !== "lowshelf" && band.type !== "highshelf") {
      out = applyBiquad(out, band, start, end);
    } else if (band.gainDb !== 0) {
      // A 0 dB peaking/shelf band is a no-op, and running it anyway costs a
      // full pass over the buffer plus the rounding it introduces.
      out = applyBiquad(out, band, start, end);
    }
  }
  return out === pcm ? clonePcm(pcm) : out;
}

/** The default four-band EQ the panel opens with — flat, so it does nothing. */
export const DEFAULT_EQ_BANDS = [
  { type: "highpass", frequency: 20, q: 0.707, gainDb: 0, enabled: false },
  { type: "lowshelf", frequency: 120, q: 0.707, gainDb: 0, enabled: true },
  { type: "peaking", frequency: 1000, q: 1, gainDb: 0, enabled: true },
  { type: "highshelf", frequency: 6000, q: 0.707, gainDb: 0, enabled: true },
  { type: "lowpass", frequency: 20000, q: 0.707, gainDb: 0, enabled: false },
];

/**
 * The chain's magnitude response at one frequency, in dB — what the panel's
 * curve is drawn from. Evaluated analytically rather than by measuring a swept
 * sine, so the curve is exact and costs nothing to redraw while dragging.
 */
export function eqMagnitudeDb(bands, frequency, sampleRate) {
  let db = 0;
  for (const band of bands ?? []) {
    if (band.enabled === false) continue;
    const c = biquadCoefficients({ ...band, sampleRate });
    const w = (2 * Math.PI * frequency) / sampleRate;
    const cos1 = Math.cos(w), sin1 = Math.sin(w);
    const cos2 = Math.cos(2 * w), sin2 = Math.sin(2 * w);
    const numRe = c.b0 + c.b1 * cos1 + c.b2 * cos2;
    const numIm = -(c.b1 * sin1 + c.b2 * sin2);
    const denRe = 1 + c.a1 * cos1 + c.a2 * cos2;
    const denIm = -(c.a1 * sin1 + c.a2 * sin2);
    const magnitude = Math.sqrt((numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm));
    // Doubling accounts for the second (reverse) pass that applyBiquad runs.
    db += 2 * 20 * Math.log10(Math.max(1e-9, magnitude));
  }
  return db;
}
