/**
 * Signal generators.
 *
 * These are sound-design primitives, not test tones. A sine sweep *is* a laser,
 * filtered white noise *is* wind, and a short burst of brown noise through a
 * lowpass *is* a distant explosion. Having them in the editor means a footstep
 * can be built rather than found.
 *
 * **Every generator is seeded.** `Math.random()` would make the same dialog
 * settings produce a different sound each time it previews, so "preview, adjust,
 * preview" would never converge — and undo/redo would not restore what was
 * there. The seed is part of the parameters and shows in the dialog.
 */
import { createPcm } from "./pcm.js";

/**
 * Mulberry32 — small, fast, and good enough for audio noise. Seeded PRNG rather
 * than Math.random for the reason above.
 */
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function silence(seconds, { sampleRate = 48000, channels = 1 } = {}) {
  return createPcm(channels, Math.max(0, Math.round(seconds * sampleRate)), sampleRate);
}

const WAVES = {
  sine: (phase) => Math.sin(phase),
  square: (phase) => (Math.sin(phase) >= 0 ? 1 : -1),
  saw: (phase) => 2 * (((phase / (2 * Math.PI)) % 1) - 0.5),
  triangle: (phase) => (2 / Math.PI) * Math.asin(Math.sin(phase)),
};

/**
 * A tone. Phase is accumulated rather than computed from `i * frequency`, so a
 * frequency that changes over time (the chirp below) stays continuous — the
 * naive form jumps phase every sample and produces clicks.
 */
export function tone(frequency, seconds, {
  sampleRate = 48000,
  channels = 1,
  amplitude = 0.5,
  wave = "sine",
} = {}) {
  const frames = Math.max(0, Math.round(seconds * sampleRate));
  const pcm = createPcm(channels, frames, sampleRate);
  const shape = WAVES[wave] ?? WAVES.sine;
  let phase = 0;
  const step = (2 * Math.PI * frequency) / sampleRate;
  for (let i = 0; i < frames; i++) {
    const v = shape(phase) * amplitude;
    for (let c = 0; c < channels; c++) pcm.channels[c][i] = v;
    phase += step;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
  }
  return pcm;
}

/**
 * A frequency sweep. `logarithmic` sweeps by musical interval rather than by Hz,
 * which is what "sounds like an even sweep" means — a linear 20→20000 Hz sweep
 * spends most of its duration in the top octave, where the ear notices least.
 */
export function chirp(fromHz, toHz, seconds, {
  sampleRate = 48000,
  channels = 1,
  amplitude = 0.5,
  logarithmic = true,
} = {}) {
  const frames = Math.max(0, Math.round(seconds * sampleRate));
  const pcm = createPcm(channels, frames, sampleRate);
  let phase = 0;
  for (let i = 0; i < frames; i++) {
    const t = frames <= 1 ? 0 : i / (frames - 1);
    const f = logarithmic && fromHz > 0 && toHz > 0
      ? fromHz * (toHz / fromHz) ** t
      : fromHz + (toHz - fromHz) * t;
    phase += (2 * Math.PI * f) / sampleRate;
    const v = Math.sin(phase) * amplitude;
    for (let c = 0; c < channels; c++) pcm.channels[c][i] = v;
  }
  return pcm;
}

/**
 * Noise. The three colours differ by spectral slope and each is useful for
 * something different: white for hiss and static, pink for rain and wind (its
 * equal-energy-per-octave matches most natural noise), brown for rumble and
 * distant explosions.
 *
 * Channels get independent noise when `correlated` is false — identical noise in
 * both channels collapses to the centre and sounds mono, which for a wind bed is
 * exactly wrong.
 */
export function noise(seconds, {
  sampleRate = 48000,
  channels = 1,
  amplitude = 0.3,
  colour = "white",
  seed = 1,
  correlated = false,
} = {}) {
  const frames = Math.max(0, Math.round(seconds * sampleRate));
  const pcm = createPcm(channels, frames, sampleRate);
  for (let c = 0; c < channels; c++) {
    const random = seededRandom(correlated ? seed : seed + c * 7919);
    const target = pcm.channels[c];
    if (correlated && c > 0) {
      target.set(pcm.channels[0]);
      continue;
    }
    if (colour === "pink") {
      // Paul Kellet's economical pink filter: a bank of one-pole lowpasses
      // whose sum approximates -3 dB/octave closely enough to be indistinguishable.
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < frames; i++) {
        const white = random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
        target[i] = pink * 0.11 * amplitude;
      }
    } else if (colour === "brown") {
      let last = 0;
      for (let i = 0; i < frames; i++) {
        const white = random() * 2 - 1;
        // Integrate, with a leak so the random walk can't drift into a DC
        // offset that eats all the headroom.
        last = (last + 0.02 * white) * 0.999;
        target[i] = last * 3.5 * amplitude;
      }
    } else {
      for (let i = 0; i < frames; i++) target[i] = (random() * 2 - 1) * amplitude;
    }
  }
  return pcm;
}
