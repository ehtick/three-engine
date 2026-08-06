/**
 * Noise reduction by spectral subtraction — the Audacity feature people
 * actually open Audacity for.
 *
 * Two steps, and the first is the reason it works at all: the user selects a
 * region containing *only* the noise (room tone, hiss, a fan) and that becomes a
 * **profile** — an average magnitude spectrum of the thing to remove. Then every
 * frame of the real audio has that profile subtracted from its magnitudes, with
 * the phase left untouched, and is resynthesised.
 *
 * Without a profile step this is guesswork; with it, it's arithmetic. That is
 * why the panel refuses to run this until a profile has been captured, rather
 * than inventing one from the quietest part of the file.
 *
 * ## The artefact, and what's done about it
 *
 * Naive subtraction leaves "musical noise": isolated time-frequency cells
 * randomly land above the noise floor after subtraction and are heard as brief
 * tones flitting about — much more objectionable than the steady hiss they
 * replaced. Two standard mitigations are applied:
 *
 *   - **Oversubtraction with a spectral floor.** Subtract somewhat more than the
 *     profile, but never below a fraction of the original magnitude, so cells
 *     are attenuated toward the floor rather than switched off.
 *   - **Smoothing the gain across frequency.** Musical noise is by definition
 *     isolated cells; a short moving average over neighbouring bins removes the
 *     isolation without touching broad spectral shapes.
 */
import { createPcm, frameCount, channelCount } from "./pcm.js";
import { fft, hann } from "./fft.js";
import { normalizeRange } from "./edits.js";

const FRAME_SIZE = 2048;
const HOP = FRAME_SIZE / 4; // 75% overlap — Hann² sums flat at 4x

/**
 * Averages the magnitude spectrum over a noise-only range.
 *
 * The result is a profile object the caller keeps and passes to `denoise`;
 * keeping it separate is what lets one profile clean several files recorded in
 * the same room.
 */
export function captureNoiseProfile(pcm, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  const span = to - from;
  if (span < FRAME_SIZE) {
    throw new Error(
      `Select at least ${(FRAME_SIZE / pcm.sampleRate).toFixed(2)}s of noise-only audio to build a profile (got ${(span / pcm.sampleRate).toFixed(2)}s).`,
    );
  }
  const window = hann(FRAME_SIZE);
  const bins = FRAME_SIZE / 2;
  const profile = new Float32Array(bins);
  let frames = 0;

  const re = new Float64Array(FRAME_SIZE);
  const im = new Float64Array(FRAME_SIZE);
  // Averaged across channels: room noise is the same room in both, and one
  // profile applied to both is what keeps them from being cleaned differently
  // and drifting apart in timbre.
  for (let position = from; position + FRAME_SIZE <= to; position += HOP) {
    for (let c = 0; c < channelCount(pcm); c++) {
      const src = pcm.channels[c];
      for (let i = 0; i < FRAME_SIZE; i++) {
        re[i] = src[position + i] * window[i];
        im[i] = 0;
      }
      fft(re, im, false);
      for (let b = 0; b < bins; b++) profile[b] += Math.hypot(re[b], im[b]);
      frames++;
    }
  }
  if (!frames) throw new Error("Could not build a noise profile from that selection.");
  for (let b = 0; b < bins; b++) profile[b] /= frames;
  return { bins, frameSize: FRAME_SIZE, sampleRate: pcm.sampleRate, magnitudes: profile };
}

/**
 * Subtracts a captured profile from the range.
 *
 * `amount` scales how much of the profile is removed (1 = exactly the measured
 * noise, higher = oversubtraction), `floorDb` is how far a bin may be pushed
 * down at most — the spectral floor that keeps musical noise at bay.
 */
export function denoise(pcm, profile, {
  amount = 1.5,
  floorDb = -24,
  smoothBins = 2,
} = {}, start, end) {
  if (!profile?.magnitudes) throw new Error("Capture a noise profile first.");
  if (profile.sampleRate !== pcm.sampleRate) {
    throw new Error(
      `That noise profile was captured at ${profile.sampleRate} Hz but this sound is ${pcm.sampleRate} Hz.`,
    );
  }
  const [from, to] = normalizeRange(pcm, start, end);
  const sampleRate = pcm.sampleRate;
  const total = frameCount(pcm);
  const out = createPcm(channelCount(pcm), total, sampleRate);
  // Everything outside the range passes through untouched.
  for (let c = 0; c < out.channels.length; c++) out.channels[c].set(pcm.channels[c]);

  const window = hann(FRAME_SIZE);
  const bins = FRAME_SIZE / 2;
  const floor = 10 ** (floorDb / 20);
  const re = new Float64Array(FRAME_SIZE);
  const im = new Float64Array(FRAME_SIZE);
  const gain = new Float32Array(bins);
  const smoothed = new Float32Array(bins);

  for (let c = 0; c < out.channels.length; c++) {
    const src = pcm.channels[c];
    const acc = new Float64Array(total);
    const weight = new Float64Array(total);

    for (let position = from; position + FRAME_SIZE <= to; position += HOP) {
      for (let i = 0; i < FRAME_SIZE; i++) {
        re[i] = src[position + i] * window[i];
        im[i] = 0;
      }
      fft(re, im, false);

      for (let b = 0; b < bins; b++) {
        const magnitude = Math.hypot(re[b], im[b]);
        const reduced = magnitude - amount * profile.magnitudes[b];
        // Never below the floor: attenuate toward it rather than zeroing, which
        // is what turns musical noise into a quiet, steady residual.
        gain[b] = magnitude > 1e-12 ? Math.max(floor, reduced / magnitude) : 1;
      }

      // Moving average across frequency — kills the isolated cells that are
      // heard as tinkling without flattening real spectral structure.
      for (let b = 0; b < bins; b++) {
        let sum = 0;
        let count = 0;
        for (let k = -smoothBins; k <= smoothBins; k++) {
          const j = b + k;
          if (j < 0 || j >= bins) continue;
          sum += gain[j];
          count++;
        }
        smoothed[b] = sum / count;
      }

      for (let b = 0; b < bins; b++) {
        re[b] *= smoothed[b];
        im[b] *= smoothed[b];
        // Mirror onto the negative-frequency half so the inverse transform
        // comes back real; skipping this leaves an imaginary residue that
        // shows up as a quiet, doubled copy of the signal.
        if (b > 0 && b < bins) {
          re[FRAME_SIZE - b] = re[b];
          im[FRAME_SIZE - b] = -im[b];
        }
      }

      fft(re, im, true);
      for (let i = 0; i < FRAME_SIZE; i++) {
        acc[position + i] += re[i] * window[i];
        weight[position + i] += window[i] * window[i];
      }
    }

    const dst = out.channels[c];
    for (let i = from; i < to; i++) {
      if (weight[i] > 1e-9) dst[i] = acc[i] / weight[i];
    }
  }
  return out;
}
