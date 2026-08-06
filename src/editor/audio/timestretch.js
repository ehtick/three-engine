/**
 * Time stretching and pitch shifting — the pair that `resample.js` deliberately
 * does *not* do.
 *
 * `changeSpeed` there is varispeed: slowing a sound also drops its pitch,
 * because it literally plays the samples slower. That is the right tool for a
 * tape effect and the wrong one for "make this footstep 20% longer" or "give me
 * eight pitch variations of the same length".
 *
 * This is WSOLA (waveform-similarity overlap-add). The idea is simple: cut the
 * signal into overlapping grains, lay them back down at a different spacing, and
 * — the part that makes it WSOLA rather than plain OLA — *slide each grain
 * within a small search window to the position where it best correlates with
 * what has already been written*. Plain overlap-add at a changed hop lands
 * grains at arbitrary phase relative to the waveform already there, and the
 * partial cancellation at every seam is the metallic, phasey artefact that makes
 * naive time-stretching instantly recognisable.
 *
 * Chosen over a phase vocoder because game audio is mostly transient — impacts,
 * footsteps, mechanical clicks — and a phase vocoder smears exactly that
 * material ("transient smearing" is its known weakness) while being several
 * times the code. WSOLA keeps transients intact and degrades on long tonal
 * material, which is the trade this content wants.
 */
import { createPcm, frameCount, channelCount } from "./pcm.js";
import { resample } from "./resample.js";

/**
 * Stretches to `factor` times the original length, preserving pitch.
 * factor > 1 is longer/slower, < 1 is shorter/faster.
 */
export function timeStretch(pcm, factor, { grainMs = 40, searchMs = 10 } = {}) {
  if (!(factor > 0)) throw new Error("timeStretch: factor must be positive");
  const inFrames = frameCount(pcm);
  if (factor === 1 || inFrames === 0) {
    return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((c) => c.slice()) };
  }

  const sampleRate = pcm.sampleRate;
  const grain = Math.max(64, Math.round((grainMs / 1000) * sampleRate));
  const overlap = grain >> 1; // 50% — with a Hann window this sums to unity
  const hop = grain - overlap;
  const search = Math.max(0, Math.round((searchMs / 1000) * sampleRate));
  const analysisHop = Math.max(1, Math.round(hop / factor));

  const outFrames = Math.max(1, Math.round(inFrames * factor));
  const out = createPcm(channelCount(pcm), outFrames + grain, sampleRate);

  // Hann, and a matching normaliser so overlapping windows sum to 1 rather
  // than to whatever the overlap happens to produce.
  const window = new Float32Array(grain);
  for (let i = 0; i < grain; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / grain);

  const weight = new Float32Array(outFrames + grain);
  // Channel 0 drives the alignment search and every channel is shifted by the
  // same amount. Aligning each channel independently would let them drift apart
  // by up to the search window, which destroys the stereo image.
  const guide = pcm.channels[0];

  // Driven by the OUTPUT position, with the read position derived from it.
  //
  // The obvious loop — advance a read cursor by `analysisHop` and stop when it
  // runs off the end of the input — leaves the last grain-and-a-bit of the
  // output never written. That tail of silence is ~4% of a 2x stretch, and it
  // does not look like a bug: the file is the right length, it just measures
  // 4% flat, because the same number of waveform periods now spans a longer
  // buffer. Deriving the read position from the write position instead
  // guarantees the output is covered end to end, and keeps the analysis grid
  // exactly `writePos / factor` so the time-scale can't drift either.
  //
  // The search offset is deliberately NOT fed back into the next read: it's a
  // local correction, and accumulating it would bend the stretch factor.
  for (let writePos = 0; writePos < outFrames; writePos += hop) {
    const nominal = Math.round(writePos / factor);
    const offset = writePos === 0
      ? 0
      : bestOffset(guide, out.channels[0], nominal, writePos, grain, overlap, search, inFrames);
    const from = Math.max(0, Math.min(inFrames - grain, nominal + offset));
    if (from + grain > inFrames) break;

    for (let c = 0; c < out.channels.length; c++) {
      const src = pcm.channels[c] ?? pcm.channels[0];
      const dst = out.channels[c];
      for (let i = 0; i < grain; i++) dst[writePos + i] += src[from + i] * window[i];
    }
    for (let i = 0; i < grain; i++) weight[writePos + i] += window[i];
  }
  void analysisHop;

  // Divide out the accumulated window weight. Without this the first and last
  // half-grain — where only one window contributes — come out at half level,
  // which reads as a fade in and out that nobody asked for.
  for (const ch of out.channels) {
    for (let i = 0; i < ch.length; i++) {
      if (weight[i] > 1e-6) ch[i] /= weight[i];
    }
  }

  return { sampleRate, channels: out.channels.map((ch) => ch.slice(0, outFrames)) };
}

/**
 * Finds the shift, within ±search, that makes the incoming grain line up best
 * with what's already been written into the overlap region. Plain
 * cross-correlation; normalising it made no audible difference here and cost a
 * second pass over every candidate.
 */
function bestOffset(src, written, readPos, writePos, grain, overlap, search, inFrames) {
  if (search === 0) return 0;
  let bestScore = -Infinity;
  let best = 0;
  for (let offset = -search; offset <= search; offset++) {
    const from = readPos + offset;
    if (from < 0 || from + overlap >= inFrames) continue;
    let score = 0;
    // Stride of 4: correlation over a 20 ms window is smooth enough that
    // sampling it quarter-rate picks the same peak for a quarter of the work,
    // and this loop is the whole cost of the algorithm.
    for (let i = 0; i < overlap; i += 4) score += src[from + i] * written[writePos + i];
    if (score > bestScore) {
      bestScore = score;
      best = offset;
    }
  }
  return best;
}

/**
 * Shifts pitch by `semitones` while keeping the length.
 *
 * Stretch by the inverse ratio, then resample by the ratio: the stretch changes
 * the length without touching pitch, and the resample changes both back, which
 * leaves the length where it started and the pitch moved. Doing it in this order
 * matters — resampling first would feed the stretcher a buffer whose transients
 * have already been interpolated.
 */
export function pitchShift(pcm, semitones, options = {}) {
  if (!semitones) return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((c) => c.slice()) };
  const ratio = 2 ** (semitones / 12);
  const stretched = timeStretch(pcm, ratio, options);
  const resampled = resample(stretched, Math.round(pcm.sampleRate / ratio), { taps: 16 });
  // The resample above changed the declared rate to do its work; the samples are
  // now correct for the original rate.
  return { sampleRate: pcm.sampleRate, channels: resampled.channels };
}

/** Stretches to an exact target duration in seconds. */
export function stretchToDuration(pcm, seconds, options = {}) {
  const current = frameCount(pcm) / pcm.sampleRate;
  if (current <= 0) return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((c) => c.slice()) };
  return timeStretch(pcm, seconds / current, options);
}
