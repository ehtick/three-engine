/**
 * The plain form every other module in `src/editor/audio/` operates on:
 *
 *     { sampleRate: number, channels: Float32Array[] }
 *
 * One `Float32Array` per channel, samples in [-1, 1], planar rather than
 * interleaved. Planar because every operation here is per-channel — a fade, a
 * filter, a normalise — and interleaved storage would make each of them do
 * index arithmetic to find the next sample of the channel it's working on.
 * Only the WAV codec interleaves, at the boundary, where the format demands it.
 *
 * **Samples are never clamped in transit.** A compressor may legitimately hand
 * a +1.4 peak to a normalise that is about to bring the whole thing down to
 * 0 dBFS; clamping between the two would destroy information the second step
 * needed and produce a quieter, distorted result from two individually correct
 * operations. Clipping happens exactly once, in `wav.js`, on the way to a
 * fixed-point format.
 *
 * No AudioContext, no AudioBuffer, no DOM. That's what lets the whole DSP layer
 * run under node in `npm run test:audio`, and it's why `OfflineAudioContext`
 * isn't used for offline processing: it renders in 128-sample quanta with
 * implementation-defined AudioParam smoothing, so "normalise" would mean
 * something slightly different on a different Chromium build.
 */

/** A silent buffer. */
export function createPcm(channelCount, length, sampleRate) {
  const channels = [];
  for (let c = 0; c < channelCount; c++) channels.push(new Float32Array(length));
  return { sampleRate, channels };
}

export const channelCount = (pcm) => pcm.channels.length;
export const frameCount = (pcm) => (pcm.channels[0]?.length ?? 0);
export const duration = (pcm) => frameCount(pcm) / pcm.sampleRate;

export function clonePcm(pcm) {
  return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((ch) => ch.slice()) };
}

/** `[start, end)` in frames, clamped. Returns a copy, never a view. */
export function slicePcm(pcm, start, end) {
  const total = frameCount(pcm);
  const from = Math.max(0, Math.min(total, Math.floor(start)));
  const to = Math.max(from, Math.min(total, Math.floor(end)));
  return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((ch) => ch.slice(from, to)) };
}

/**
 * End to end. Channel counts are reconciled by widening the narrower one —
 * dropping a channel to match would silently discard audio, and a caller
 * pasting a stereo clip into a mono document means to hear both sides.
 */
export function concatPcm(...parts) {
  const pieces = parts.filter((p) => p && frameCount(p) > 0);
  if (pieces.length === 0) return createPcm(1, 0, parts[0]?.sampleRate ?? 48000);
  const sampleRate = pieces[0].sampleRate;
  const channels = Math.max(...pieces.map(channelCount));
  const total = pieces.reduce((sum, p) => sum + frameCount(p), 0);
  const out = createPcm(channels, total, sampleRate);
  let offset = 0;
  for (const piece of pieces) {
    for (let c = 0; c < channels; c++) {
      // A mono piece feeds every channel; that's an upmix, not silence.
      const src = piece.channels[c] ?? piece.channels[0];
      out.channels[c].set(src, offset);
    }
    offset += frameCount(piece);
  }
  return out;
}

/** In-place `dest[destOffset…] += src * gain`, clipped to dest's length. */
export function mixInto(dest, src, destOffset, gain = 1) {
  const count = Math.min(src.length, dest.length - destOffset);
  for (let i = 0; i < count; i++) dest[destOffset + i] += src[i] * gain;
}

/** Largest absolute sample across every channel. */
export function peak(pcm) {
  let max = 0;
  for (const ch of pcm.channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i] < 0 ? -ch[i] : ch[i];
      if (v > max) max = v;
    }
  }
  return max;
}

/** Root-mean-square across every channel, over an optional frame range. */
export function rms(pcm, start = 0, end = frameCount(pcm)) {
  let sum = 0;
  let count = 0;
  for (const ch of pcm.channels) {
    const to = Math.min(end, ch.length);
    for (let i = Math.max(0, start); i < to; i++) {
      sum += ch[i] * ch[i];
      count++;
    }
  }
  return count ? Math.sqrt(sum / count) : 0;
}

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (gain) => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);

/**
 * Stereo (or wider) to mono.
 *
 * Not `(L+R)/2`. A stereo file whose sides are out of phase — a widened synth
 * pad, a mid/side-processed recording — cancels to near-silence under a naive
 * average, and the failure is silent in both senses: the file looks fine in the
 * grid and plays as almost nothing. So the correlation between channels is
 * measured first, and when they're substantially anti-correlated the second
 * channel is inverted before summing, which preserves the energy instead of
 * nulling it.
 *
 * This matters because a stereo file will not spatialise on a `SoundComponent`
 * — Web Audio's PannerNode collapses it — so "make this mono" is a routine
 * operation on imported game audio, not an exotic one.
 */
export function toMono(pcm) {
  const count = channelCount(pcm);
  if (count === 1) return clonePcm(pcm);
  const frames = frameCount(pcm);
  const out = createPcm(1, frames, pcm.sampleRate);
  const dst = out.channels[0];

  const flip = new Float32Array(count);
  flip[0] = 1;
  for (let c = 1; c < count; c++) flip[c] = correlation(pcm.channels[0], pcm.channels[c]) < -0.4 ? -1 : 1;

  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < count; c++) sum += pcm.channels[c][i] * flip[c];
    dst[i] = sum / count;
  }
  return out;
}

/** Normalised cross-correlation at zero lag; 0 when either side is silent. */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  let sumAB = 0;
  let sumAA = 0;
  let sumBB = 0;
  for (let i = 0; i < n; i++) {
    sumAB += a[i] * b[i];
    sumAA += a[i] * a[i];
    sumBB += b[i] * b[i];
  }
  const denom = Math.sqrt(sumAA * sumBB);
  return denom > 0 ? sumAB / denom : 0;
}

/** Mono to `count` identical channels; wider inputs are returned untouched. */
export function toChannels(pcm, count) {
  const have = channelCount(pcm);
  if (have === count) return clonePcm(pcm);
  if (have === 1) {
    const out = createPcm(count, frameCount(pcm), pcm.sampleRate);
    for (let c = 0; c < count; c++) out.channels[c].set(pcm.channels[0]);
    return out;
  }
  if (count === 1) return toMono(pcm);
  const out = createPcm(count, frameCount(pcm), pcm.sampleRate);
  for (let c = 0; c < count; c++) out.channels[c].set(pcm.channels[Math.min(c, have - 1)]);
  return out;
}

/**
 * Constant-power pan for a stereo pair. `pan` is -1 (hard left) to +1 (hard
 * right). Linear panning dips ~3 dB in the middle, which is audible as a
 * loudness hole when a sound sweeps across the field.
 */
export function panGains(pan) {
  const angle = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  return [Math.cos(angle), Math.sin(angle)];
}

/**
 * Nearest frame index at or before `frame` where the waveform crosses zero.
 *
 * Cutting anywhere else leaves a step discontinuity, which is a click — the
 * single most common way an edited game sound comes out sounding broken. Every
 * edit that can snap, does. Returns `frame` unchanged when nothing qualifies
 * within `window`, so snapping can never move a cut somewhere surprising.
 */
export function nearestZeroCrossing(pcm, frame, window = 512) {
  const ch = pcm.channels[0];
  if (!ch || ch.length === 0) return frame;
  const centre = Math.max(0, Math.min(ch.length - 1, Math.round(frame)));
  for (let offset = 0; offset <= window; offset++) {
    for (const i of offset === 0 ? [centre] : [centre - offset, centre + offset]) {
      if (i <= 0 || i >= ch.length) continue;
      // A crossing is a sign change between neighbours; pick whichever of the
      // two is closer to zero so the residual step is as small as possible.
      if ((ch[i - 1] <= 0 && ch[i] >= 0) || (ch[i - 1] >= 0 && ch[i] <= 0)) {
        return Math.abs(ch[i - 1]) <= Math.abs(ch[i]) ? i - 1 : i;
      }
    }
  }
  return centre;
}
