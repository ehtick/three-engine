/**
 * The variation generator: one footstep becomes eight.
 *
 * The reason this belongs in a game engine's audio editor and not in a general
 * audio editor: a sound that plays more than a few times a minute and is
 * bit-identical every time is the single most recognisable "cheap game" tell.
 * The standard fix is a set of takes the runtime picks between at random —
 * `SoundComponent` already supports that — and recording eight footsteps is a
 * luxury most projects don't have. Jittering one is what everyone actually
 * does, and doing it by hand in a general editor means eight rounds of
 * pitch-shift-and-export.
 *
 * ## Deterministic on purpose
 *
 * Same source, same parameters, same seed ⇒ the same eight files, byte for
 * byte. Two reasons. A build that regenerated its variations would produce a
 * different game every time it was built, which makes a diff meaningless. And
 * an agent driving this through `audio.variations` needs to be able to say what
 * it produced, not "eight random ones".
 *
 * ## Why pitch, not speed
 *
 * `resample.changeSpeed` would be cheaper, but varispeed changes the length
 * too, so eight "variations" of a footstep would have eight different
 * durations — audible as a limp when they're triggered on a fixed step rhythm.
 * `timestretch.pitchShift` keeps the length and moves only the pitch, which is
 * what a different-but-same-footstep sounds like.
 */
import { pitchShift } from "./timestretch.js";
import { amplify } from "./amplitude.js";
import { clonePcm, frameCount } from "./pcm.js";

/**
 * A small deterministic PRNG (mulberry32). `Math.random()` cannot be used here
 * for the determinism reason above, and pulling in a dependency for 6 lines of
 * arithmetic would be worse.
 */
function rng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` variations of `pcm`.
 *
 * `pitchCents` and `gainDb` are the *half-width* of each jitter — 150 cents
 * means "up to a tone and a half either way". Defaults are deliberately
 * conservative: a footstep set that ranges over an octave stops sounding like
 * one surface.
 *
 * Returns descriptors, not just buffers, so the caller can name the files after
 * what was done to them and an agent can report it.
 */
export function makeVariations(pcm, {
  count = 8,
  pitchCents = 150,
  gainDb = 2,
  seed = 1,
  includeOriginal = false,
} = {}) {
  const total = Math.max(1, Math.round(count));
  if (frameCount(pcm) === 0) throw new Error("There is nothing to make variations of — this sound is empty.");
  const random = rng(seed);
  const out = [];

  for (let i = 0; i < total; i++) {
    if (i === 0 && includeOriginal) {
      out.push({ index: 1, pcm: clonePcm(pcm), semitones: 0, db: 0, original: true });
      continue;
    }
    // Symmetric around zero: a set that only ever pitches *down* drifts away
    // from the sound the designer approved.
    const semitones = ((random() * 2 - 1) * pitchCents) / 100;
    const db = (random() * 2 - 1) * gainDb;
    let variant = semitones === 0 ? clonePcm(pcm) : pitchShift(pcm, semitones);
    if (db !== 0) variant = amplify(variant, db);
    out.push({
      index: i + 1,
      pcm: variant,
      semitones: Math.round(semitones * 100) / 100,
      db: Math.round(db * 100) / 100,
      original: false,
    });
  }
  return out;
}

/**
 * `impact.wav` + 3 → `impact_01.wav`, `impact_02.wav`, `impact_03.wav`.
 *
 * Zero-padded so they sort correctly in the Assets grid past nine, which is
 * where an unpadded set stops being readable (`_10` sorting between `_1` and
 * `_2` is the kind of small wrongness that makes a folder look untended).
 */
export function variationName(baseName, index, count, extension = "wav") {
  const stem = baseName.replace(/\.[a-z0-9]+$/i, "");
  const width = Math.max(2, String(count).length);
  return `${stem}_${String(index).padStart(width, "0")}.${extension}`;
}
