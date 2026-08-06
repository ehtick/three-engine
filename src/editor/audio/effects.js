/**
 * The effect registry: one description per effect, used by everything.
 *
 * The panel generates its dialogs from these descriptors, and the `audio.process`
 * MCP op validates and dispatches through the same table. That is the point —
 * an effect added here appears in the UI, in the tool schema an agent sees, and
 * in the tests, without being wired up three times and drifting in two of them.
 *
 * `apply(pcm, params, range)` is the whole contract. Effects that change the
 * length (delay, reverb) say so with `changesLength`, because the panel has to
 * decide whether a preview can be A/B'd in place and the caller has to expect a
 * different buffer back.
 */
import * as amplitude from "./amplitude.js";
import * as filters from "./filters.js";
import * as dynamics from "./dynamics.js";
import * as timestretch from "./timestretch.js";
import * as space from "./space.js";
import * as resample from "./resample.js";
import * as edits from "./edits.js";
import { denoise } from "./denoise.js";
import { autoLoop } from "./loop.js";
import { toMono, frameCount } from "./pcm.js";

/**
 * A parameter descriptor. `type` is "number" | "boolean" | "enum"; `unit` is
 * shown in the UI and, more importantly, tells a reader what the number means
 * without having to guess whether 5 is dB, ms or a ratio.
 */
const num = (label, def, min, max, { unit = "", step, hint } = {}) => ({
  type: "number", label, default: def, min, max, unit, step: step ?? (max - min) / 100, hint,
});
const bool = (label, def, hint) => ({ type: "boolean", label, default: def, hint });
const choice = (label, def, options, hint) => ({ type: "enum", label, default: def, options, hint });

export const EFFECTS = {
  amplify: {
    label: "Amplify",
    group: "Level",
    description: "Change the level by a fixed amount in dB.",
    params: { db: num("Gain", 0, -60, 24, { unit: "dB", step: 0.1 }) },
    apply: (pcm, p, [from, to]) => amplitude.amplify(pcm, p.db, from, to),
  },

  normalize: {
    label: "Normalize",
    group: "Level",
    description:
      "Scale so the loudest sample sits at the target. One gain across all channels, so a panned sound stays panned.",
    params: {
      targetDb: num("Target peak", -1, -24, 0, { unit: "dBFS", step: 0.1 }),
    },
    apply: (pcm, p, [from, to]) => amplitude.normalizePeak(pcm, p.targetDb, from, to),
  },

  normalizeLoudness: {
    label: "Match loudness (RMS)",
    group: "Level",
    description:
      "Scale so the AVERAGE level hits the target. What makes a set of footsteps sound like one set; peak normalising leaves the sharp ones quieter to the ear.",
    params: { targetDb: num("Target RMS", -18, -40, -6, { unit: "dB", step: 0.1 }) },
    apply: (pcm, p, [from, to]) => amplitude.normalizeRms(pcm, p.targetDb, from, to).pcm,
  },

  fadeIn: {
    label: "Fade in",
    group: "Level",
    params: { shape: choice("Shape", "equalPower", Object.keys(amplitude.FADE_SHAPES)) },
    apply: (pcm, p, [from, to]) => amplitude.fade(pcm, { direction: "in", shape: p.shape, start: from, end: to }),
  },

  fadeOut: {
    label: "Fade out",
    group: "Level",
    params: { shape: choice("Shape", "equalPower", Object.keys(amplitude.FADE_SHAPES)) },
    apply: (pcm, p, [from, to]) => amplitude.fade(pcm, { direction: "out", shape: p.shape, start: from, end: to }),
  },

  invert: {
    label: "Invert polarity",
    group: "Level",
    description: "Flip the waveform. Summing the result with the original gives silence.",
    params: {},
    apply: (pcm, p, [from, to]) => amplitude.invert(pcm, from, to),
  },

  removeDc: {
    label: "Remove DC offset",
    group: "Level",
    description:
      "Centre each channel on zero. An offset costs headroom for nothing and stops edits snapping to a zero crossing.",
    params: {},
    apply: (pcm, p, [from, to]) => amplitude.removeDcOffset(pcm, from, to),
  },

  reverse: {
    label: "Reverse",
    group: "Level",
    params: {},
    apply: (pcm, p, [from, to]) => edits.reverseRange(pcm, from, to),
  },

  filter: {
    label: "Filter",
    group: "Tone",
    description: "One biquad. Zero-phase by default, so transients keep their shape.",
    params: {
      type: choice("Type", "lowpass", ["lowpass", "highpass", "bandpass", "notch", "peaking", "lowshelf", "highshelf", "allpass"]),
      frequency: num("Frequency", 1000, 20, 20000, { unit: "Hz", step: 1 }),
      q: num("Q", 0.707, 0.1, 18, { step: 0.01 }),
      gainDb: num("Gain", 0, -24, 24, { unit: "dB", step: 0.1, hint: "Peaking and shelf types only" }),
      zeroPhase: bool("Zero phase", true, "Filter forwards and backwards so nothing is time-smeared"),
    },
    apply: (pcm, p, [from, to]) => filters.applyBiquad(pcm, p, from, to),
  },

  compressor: {
    label: "Compressor",
    group: "Dynamics",
    description: "Even out the level. Detection is linked across channels so the stereo image stays put.",
    params: {
      thresholdDb: num("Threshold", -18, -60, 0, { unit: "dB", step: 0.5 }),
      ratio: num("Ratio", 4, 1, 20, { step: 0.1 }),
      attackMs: num("Attack", 5, 0.1, 200, { unit: "ms", step: 0.1 }),
      releaseMs: num("Release", 100, 5, 2000, { unit: "ms", step: 1 }),
      kneeDb: num("Knee", 6, 0, 24, { unit: "dB", step: 0.5 }),
      autoMakeup: bool("Auto make-up", true, "Restore the level it took away so A/B compares tone, not loudness"),
    },
    apply: (pcm, p, [from, to]) => dynamics.compress(pcm, p, from, to),
  },

  limiter: {
    label: "Limiter",
    group: "Dynamics",
    description: "Nothing gets past the ceiling. Looks ahead, so peaks are caught before they arrive.",
    params: {
      ceilingDb: num("Ceiling", -0.3, -12, 0, { unit: "dBFS", step: 0.1 }),
      lookaheadMs: num("Lookahead", 5, 0.5, 20, { unit: "ms", step: 0.5 }),
      releaseMs: num("Release", 50, 5, 500, { unit: "ms", step: 1 }),
    },
    apply: (pcm, p, [from, to]) => dynamics.limit(pcm, p, from, to),
  },

  gate: {
    label: "Noise gate",
    group: "Dynamics",
    description: "Silence below the threshold. Two thresholds and a hold, so it can't chatter.",
    params: {
      thresholdDb: num("Threshold", -40, -80, 0, { unit: "dB", step: 0.5 }),
      hysteresisDb: num("Hysteresis", 6, 0, 24, { unit: "dB", step: 0.5 }),
      attackMs: num("Attack", 1, 0.1, 50, { unit: "ms", step: 0.1 }),
      holdMs: num("Hold", 50, 0, 500, { unit: "ms", step: 1 }),
      releaseMs: num("Release", 100, 5, 1000, { unit: "ms", step: 1 }),
    },
    apply: (pcm, p, [from, to]) => dynamics.gate(pcm, p, from, to),
  },

  pitch: {
    label: "Pitch shift",
    group: "Time",
    description: "Move the pitch, keep the length. This is what makes eight variations of one footstep.",
    params: { semitones: num("Shift", 0, -24, 24, { unit: "st", step: 0.1 }) },
    wholeBufferOnly: true,
    apply: (pcm, p) => timestretch.pitchShift(pcm, p.semitones),
  },

  tempo: {
    label: "Time stretch",
    group: "Time",
    description: "Change the length, keep the pitch.",
    params: { factor: num("Length", 1, 0.25, 4, { step: 0.01, hint: "2 = twice as long" }) },
    wholeBufferOnly: true,
    changesLength: true,
    apply: (pcm, p) => timestretch.timeStretch(pcm, p.factor),
  },

  speed: {
    label: "Speed (varispeed)",
    group: "Time",
    description: "The tape effect — slowing it down also drops the pitch.",
    params: { factor: num("Speed", 1, 0.25, 4, { step: 0.01 }) },
    wholeBufferOnly: true,
    changesLength: true,
    apply: (pcm, p) => resample.changeSpeed(pcm, p.factor),
  },

  resample: {
    label: "Resample",
    group: "Time",
    description: "Change the sample rate. Anti-aliased, so downsampling doesn't fold hiss into the audible band.",
    params: { sampleRate: num("Rate", 48000, 8000, 96000, { unit: "Hz", step: 100 }) },
    wholeBufferOnly: true,
    changesLength: true,
    apply: (pcm, p) => resample.resample(pcm, Math.round(p.sampleRate)),
  },

  delay: {
    label: "Delay / echo",
    group: "Space",
    params: {
      timeMs: num("Time", 250, 1, 2000, { unit: "ms", step: 1 }),
      feedback: num("Feedback", 0.4, 0, 0.95, { step: 0.01 }),
      mix: num("Mix", 0.35, 0, 1, { step: 0.01 }),
      pingPong: bool("Ping-pong", false, "Bounce repeats between channels (stereo only)"),
    },
    wholeBufferOnly: true,
    changesLength: true,
    apply: (pcm, p) => space.delay(pcm, p),
  },

  reverb: {
    label: "Reverb",
    group: "Space",
    params: {
      roomSize: num("Room size", 0.5, 0, 1, { step: 0.01 }),
      damping: num("Damping", 0.4, 0, 0.99, { step: 0.01, hint: "How fast the highs decay — how soft the room is" }),
      preDelayMs: num("Pre-delay", 20, 0, 200, { unit: "ms", step: 1 }),
      width: num("Width", 1, 0, 2, { step: 0.01 }),
      mix: num("Mix", 0.3, 0, 1, { step: 0.01 }),
    },
    wholeBufferOnly: true,
    changesLength: true,
    apply: (pcm, p) => space.reverb(pcm, p),
  },

  chorus: {
    label: "Chorus",
    group: "Space",
    params: {
      baseMs: num("Delay", 25, 5, 60, { unit: "ms", step: 0.5 }),
      depthMs: num("Depth", 6, 0.1, 20, { unit: "ms", step: 0.1 }),
      rateHz: num("Rate", 0.6, 0.05, 8, { unit: "Hz", step: 0.01 }),
      feedback: num("Feedback", 0, 0, 0.9, { step: 0.01 }),
      mix: num("Mix", 0.45, 0, 1, { step: 0.01 }),
    },
    apply: (pcm, p, [from, to]) => space.modulatedDelay(pcm, p, from, to),
  },

  flanger: {
    label: "Flanger",
    group: "Space",
    params: {
      baseMs: num("Delay", 3, 0.5, 12, { unit: "ms", step: 0.1 }),
      depthMs: num("Depth", 2.5, 0.1, 10, { unit: "ms", step: 0.1 }),
      rateHz: num("Rate", 0.25, 0.02, 5, { unit: "Hz", step: 0.01 }),
      feedback: num("Feedback", 0.6, 0, 0.9, { step: 0.01 }),
      mix: num("Mix", 0.5, 0, 1, { step: 0.01 }),
    },
    apply: (pcm, p, [from, to]) => space.modulatedDelay(pcm, p, from, to),
  },

  seamlessLoop: {
    label: "Make seamless loop",
    group: "Game",
    description:
      "Turn an ambience into a loop with no audible seam. Select the loop region first, or leave nothing selected and the best loop points are found automatically. The wrap is click-free by construction — the crossfade uses the audio that really came next in the recording.",
    changesLength: true,
    params: {
      crossfadeMs: num("Crossfade", 250, 5, 4000, { unit: "ms", step: 5, hint: "Longer hides more; too long and the loop sounds like it breathes" }),
      minSeconds: num("Shortest loop", 1, 0.05, 120, { unit: "s", step: 0.05, hint: "Auto-search only" }),
      maxSeconds: num("Longest loop", 0, 0, 600, { unit: "s", step: 1, hint: "Auto-search only. 0 means no limit" }),
    },
    apply: (pcm, p, [from, to]) => {
      const total = frameCount(pcm);
      // A real sub-selection IS the loop region — that is what selecting one
      // means. Everything selected (or nothing) hands it to the search.
      const explicit = to > from && (from > 0 || to < total);
      return autoLoop(pcm, {
        loopStart: explicit ? from : null,
        loopEnd: explicit ? to : null,
        crossfadeSeconds: p.crossfadeMs / 1000,
        minSeconds: p.minSeconds,
        maxSeconds: p.maxSeconds > 0 ? p.maxSeconds : null,
      }).pcm;
    },
  },

  mono: {
    label: "Mono-ize for 3D",
    group: "Game",
    description:
      "Fold to one channel so the sound will spatialise. A stereo file on a 3D sound does not pan — Web Audio collapses it — and the result is quietly wrong. Correlation-aware, so an anti-phase stereo pair doesn't cancel to silence.",
    wholeBufferOnly: true,
    changesChannels: true,
    params: {},
    apply: (pcm) => toMono(pcm),
  },

  denoise: {
    label: "Noise reduction",
    group: "Restore",
    description:
      "Subtract a captured noise profile. Select a noise-only region and capture a profile first — without one this is guesswork.",
    needsNoiseProfile: true,
    params: {
      amount: num("Amount", 1.5, 0.5, 4, { step: 0.1, hint: "Above 1 removes more than was measured" }),
      floorDb: num("Floor", -24, -60, 0, { unit: "dB", step: 1, hint: "How far a bin may be pushed down — keeps musical noise away" }),
      smoothBins: num("Smoothing", 2, 0, 8, { step: 1 }),
    },
    apply: (pcm, p, [from, to], context) => denoise(pcm, context?.noiseProfile, p, from, to),
  },
};

/** Defaults for one effect, as a plain object. */
export function defaultParams(id) {
  const effect = EFFECTS[id];
  if (!effect) throw new Error(`Unknown effect "${id}"`);
  const out = {};
  for (const [key, descriptor] of Object.entries(effect.params)) out[key] = descriptor.default;
  return out;
}

/**
 * Runs an effect. Clamps numbers into their declared range rather than trusting
 * the caller — a scripted caller passing `ratio: 0` would otherwise divide by
 * zero deep inside the compressor, and the error would name neither the effect
 * nor the parameter.
 */
export function applyEffect(id, pcm, params = {}, range, context) {
  const effect = EFFECTS[id];
  if (!effect) {
    throw new Error(`Unknown effect "${id}". Available: ${Object.keys(EFFECTS).join(", ")}.`);
  }
  if (effect.needsNoiseProfile && !context?.noiseProfile) {
    throw new Error(`"${effect.label}" needs a noise profile — select a noise-only region and capture one first.`);
  }
  const merged = {};
  for (const [key, descriptor] of Object.entries(effect.params)) {
    const value = params[key] ?? descriptor.default;
    merged[key] = descriptor.type === "number"
      ? Math.max(descriptor.min, Math.min(descriptor.max, Number(value)))
      : value;
  }
  const total = pcm.channels[0]?.length ?? 0;
  // Effects whose maths spans the whole buffer (a stretch resamples everything;
  // a reverb tail runs past the end) can't be confined to a selection, and
  // pretending otherwise would silently produce a discontinuity at the edges.
  const span = effect.wholeBufferOnly ? [0, total] : (range ?? [0, total]);
  return effect.apply(pcm, merged, span, context);
}

/** Grouped list for menus, in a stable order. */
export function effectGroups() {
  const groups = new Map();
  for (const [id, effect] of Object.entries(EFFECTS)) {
    const list = groups.get(effect.group) ?? [];
    list.push({ id, ...effect });
    groups.set(effect.group, list);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}
