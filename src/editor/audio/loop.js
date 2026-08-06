/**
 * The seamless loop maker.
 *
 * Every looping ambient bed in every game needs one, and doing it by hand is
 * miserable: you hunt for two points that match, cut, crossfade, play it round
 * twenty times, and still hear a bump. This is the single strongest reason to
 * have an audio editor inside the engine rather than telling people to open
 * Audacity, which has no reason to care about looping.
 *
 * ## The construction, and why the wrap is click-free *by construction*
 *
 * Given a loop region `[start, end)`, the naive approach — cut there and
 * crossfade the region's own tail into its own head — leaves a step at the wrap
 * unless the edges happen to line up. This does something better: it crossfades
 * the audio that *really came next* in the recording over the head of the loop.
 *
 *     body = pcm[start … bodyEnd)          the loop itself
 *     tail = pcm[bodyEnd … bodyEnd + X)    what actually followed it
 *     out[i < X]  = body[i]·sin + tail[i]·cos      (equal power)
 *     out[i >= X] = body[i]
 *
 * At the wrap, `out[last] = pcm[bodyEnd − 1]` and `out[0] = tail[0] =
 * pcm[bodyEnd]` — two *adjacent samples of the original recording*. There is no
 * discontinuity to click, at any loop point, whether or not it sits on a zero
 * crossing. That is why nothing here snaps to zero crossings: it would move the
 * edit for no benefit.
 *
 * What the search below is for, then, is not the click — that's already gone —
 * but whether the crossfade *sounds* like the recording continuing rather than
 * like two different moments dissolved together. That is a question about how
 * similar the head and the tail are, which is what the correlation measures.
 *
 * Pure, like everything else in this directory: no Web Audio, no canvas,
 * exercised under node by `npm run test:audio`.
 */
import { clonePcm, createPcm, frameCount, channelCount, slicePcm, toMono, rms } from "./pcm.js";

/**
 * Normalised cross-correlation between two equal-length windows of one signal.
 * 1 is identical, 0 unrelated, −1 inverted. Windows that are silent score 0
 * rather than dividing by zero — a loop point in a silent passage is a real
 * possibility on an ambience with a quiet moment.
 */
function nccAt(signal, a, b, length) {
  let sumAB = 0;
  let sumAA = 0;
  let sumBB = 0;
  for (let i = 0; i < length; i++) {
    const x = signal[a + i];
    const y = signal[b + i];
    sumAB += x * y;
    sumAA += x * x;
    sumBB += y * y;
  }
  const denom = Math.sqrt(sumAA * sumBB);
  return denom > 0 ? sumAB / denom : 0;
}

function rmsAt(signal, offset, length) {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += signal[offset + i] * signal[offset + i];
  return Math.sqrt(sum / Math.max(1, length));
}

/**
 * Box-averaged decimation for the search only.
 *
 * The search is O(candidates × window) and both scale with the sample rate, so
 * a two-minute 48 kHz ambience searched at full rate is billions of operations
 * for an answer that does not depend on anything above a few kHz — loop-point
 * similarity is about the texture, not the top octave. Averaging rather than
 * dropping samples is what keeps the decimation from aliasing hiss into the
 * band the score is computed over.
 */
function decimate(signal, factor) {
  if (factor <= 1) return signal;
  const out = new Float32Array(Math.floor(signal.length / factor));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += signal[i * factor + j];
    out[i] = sum / factor;
  }
  return out;
}

const ANALYSIS_RATE = 4000;

/**
 * Finds the best places to loop.
 *
 * `loopStart` is fixed (default the beginning, or wherever the caller says the
 * intro ends) and the end is searched. Searching both ends is a
 * two-dimensional problem with no better answer in practice: an ambience's
 * intro is a judgement call a person makes in one click, and once it's made the
 * remaining question is genuinely one-dimensional.
 *
 * Returns candidates sorted best-first, each with the two numbers behind its
 * score, because "0.86" tells nobody anything but "the material matches well
 * (0.91) but is 2 dB louder at the loop point (0.79)" tells them what to fix.
 */
export function analyzeLoop(pcm, {
  minSeconds = 1,
  maxSeconds = null,
  crossfadeSeconds = 0.25,
  searchStartSeconds = 0,
  candidates = 5,
} = {}) {
  const rate = pcm.sampleRate;
  const total = frameCount(pcm);
  const mono = channelCount(pcm) === 1 ? pcm.channels[0] : toMono(pcm).channels[0];

  const factor = Math.max(1, Math.floor(rate / ANALYSIS_RATE));
  const signal = decimate(mono, factor);
  const analysisRate = rate / factor;

  const crossfade = Math.max(1, Math.round(crossfadeSeconds * rate));
  const window = Math.max(8, Math.round(crossfade / factor));

  const start = Math.max(0, Math.min(total - 1, Math.round(searchStartSeconds * rate)));
  const startD = Math.floor(start / factor);

  // The loop end has to leave `crossfade` frames of real material behind it —
  // that trailing audio IS the crossfade. Without it the construction has to
  // fall back to eating into the loop itself (see makeSeamlessLoop), which
  // works but is not what the search should be aiming at.
  const lastEnd = total - crossfade;
  const minEnd = start + Math.max(crossfade, Math.round(minSeconds * rate));
  const maxEnd = maxSeconds ? Math.min(lastEnd, start + Math.round(maxSeconds * rate)) : lastEnd;
  if (minEnd >= maxEnd || startD + window >= signal.length) {
    return { candidates: [], searched: 0, reason: "This sound is too short to loop with that crossfade — shorten the crossfade or the minimum length." };
  }

  const headRms = rmsAt(signal, startD, window);
  const scored = [];
  const fromD = Math.floor(minEnd / factor);
  const toD = Math.min(Math.floor(maxEnd / factor), signal.length - window);

  for (let endD = fromD; endD <= toD; endD++) {
    const match = nccAt(signal, startD, endD, window);
    if (match <= 0) continue;
    const tailRms = rmsAt(signal, endD, window);
    const level = headRms > 0 && tailRms > 0 ? Math.min(headRms, tailRms) / Math.max(headRms, tailRms) : 0;
    scored.push({ endD, match, level, score: match * level });
  }
  if (scored.length === 0) {
    return { candidates: [], searched: toD - fromD + 1, reason: "Nothing in this sound resembles its own beginning closely enough to loop cleanly." };
  }

  // Non-maximum suppression. Neighbouring frames score almost identically, so
  // without this the "five best candidates" are five versions of the same one
  // and the list is useless as a set of alternatives to try.
  const separation = Math.max(1, Math.round(0.25 * analysisRate));
  scored.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const candidate of scored) {
    if (chosen.some((c) => Math.abs(c.endD - candidate.endD) < separation)) continue;
    chosen.push(candidate);
    if (chosen.length >= candidates) break;
  }

  return {
    searched: toD - fromD + 1,
    candidates: chosen.map((candidate) => {
      const loopEnd = refine(mono, start, candidate.endD * factor, factor, crossfade, total);
      return {
        loopStart: start,
        loopEnd,
        frames: loopEnd - start,
        seconds: (loopEnd - start) / rate,
        // Rounded: these are shown to a person choosing between options, and
        // three decimals of a heuristic is false precision.
        score: Math.round(candidate.score * 1000) / 1000,
        match: Math.round(candidate.match * 1000) / 1000,
        levelMatch: Math.round(candidate.level * 1000) / 1000,
      };
    }),
  };
}

/**
 * Full-rate refinement around a decimated hit.
 *
 * The search runs at ~4 kHz, so its answer is only accurate to a dozen samples.
 * That is inaudible at the wrap (which is continuous regardless) but it does
 * shift the crossfade's alignment, and on tonal material — a hum, an engine —
 * a dozen samples is a noticeable phase error that comes out as a flange
 * through the fade. A short full-rate window fixes it cheaply.
 */
function refine(mono, start, approxEnd, factor, crossfade, total) {
  if (factor <= 1) return approxEnd;
  const window = Math.min(crossfade, 2048);
  if (start + window >= total) return approxEnd;
  let best = approxEnd;
  let bestScore = -Infinity;
  for (let end = approxEnd - factor; end <= approxEnd + factor; end++) {
    if (end < start + window || end + window > total) continue;
    const score = nccAt(mono, start, end, window);
    if (score > bestScore) {
      bestScore = score;
      best = end;
    }
  }
  return best;
}

/**
 * Builds the loop.
 *
 * Returns the numbers alongside the audio — which points were actually used and
 * how long the crossfade ended up — because both can differ from what was
 * asked for when the sound is too short, and silently returning a different
 * loop than the one requested is how a tool loses someone's trust.
 */
export function makeSeamlessLoop(pcm, { loopStart = 0, loopEnd = null, crossfadeSeconds = 0.25 } = {}) {
  const rate = pcm.sampleRate;
  const total = frameCount(pcm);
  const channels = channelCount(pcm);

  const start = Math.max(0, Math.min(total, Math.round(loopStart)));
  const requestedEnd = loopEnd == null ? total : Math.round(loopEnd);
  const end = Math.max(start, Math.min(total, requestedEnd));

  // The crossfade cannot be longer than half the loop — beyond that the fade-in
  // and fade-out overlap the same material twice and the result is mush.
  const span = end - start;
  let crossfade = Math.max(0, Math.round(crossfadeSeconds * rate));
  crossfade = Math.min(crossfade, Math.floor(span / 2));

  if (span <= 1 || crossfade === 0) {
    return { pcm: slicePcm(pcm, start, end), loopStart: start, loopEnd: end, crossfadeFrames: 0, usedTrailingAudio: false, shortened: 0 };
  }

  // The crossfade material is always the `crossfade` frames that follow the
  // body in the original recording. When there is real audio after the loop
  // end, that is exactly it and the loop keeps its full length. When there is
  // not, the body gives up its own last `crossfade` frames to play that role —
  // the loop comes out shorter, which is reported rather than hidden.
  const bodyEnd = Math.min(end, total - crossfade);
  const usedTrailingAudio = bodyEnd === end;
  if (bodyEnd - start <= crossfade) {
    return { pcm: slicePcm(pcm, start, end), loopStart: start, loopEnd: end, crossfadeFrames: 0, usedTrailingAudio: false, shortened: 0 };
  }

  const length = bodyEnd - start;
  const out = createPcm(channels, length, rate);
  for (let c = 0; c < channels; c++) {
    const src = pcm.channels[c];
    const dst = out.channels[c];
    for (let i = 0; i < length; i++) dst[i] = src[start + i];
    for (let i = 0; i < crossfade; i++) {
      // Equal power, matching `amplitude.crossfade` — two linear fades summed
      // dip ~3 dB in the middle, which on a loop seam is a hole that pulses
      // once per repeat and is the exact artefact this is here to remove.
      const t = crossfade === 1 ? 1 : i / (crossfade - 1);
      const fadeIn = Math.sin((t * Math.PI) / 2);
      const fadeOut = Math.cos((t * Math.PI) / 2);
      dst[i] = src[start + i] * fadeIn + src[bodyEnd + i] * fadeOut;
    }
  }

  return {
    pcm: out,
    loopStart: start,
    loopEnd: bodyEnd,
    crossfadeFrames: crossfade,
    usedTrailingAudio,
    shortened: end - bodyEnd,
  };
}

/**
 * How well does this buffer loop *as it stands*?
 *
 * Runs on the result of the loop maker as a regression check, and on any
 * imported file to answer "is this already a loop?".
 *
 * The click is measured as the sample step across the wrap compared with the
 * steps the waveform takes anyway. An absolute threshold cannot work: a step of
 * 0.02 is nothing in a loud noisy bed and a distinct tick in a quiet drone.
 * The ratio is what the ear responds to.
 */
export function seamAnalysis(pcm) {
  const total = frameCount(pcm);
  if (total < 4) return { clickRatio: 0, clickDb: -Infinity, levelMatch: 1, smooth: true };

  let wrapStep = 0;
  let stepSum = 0;
  let stepCount = 0;
  // Sample the step statistics rather than walking every frame of a ten-minute
  // bed — a few thousand of them give the same mean to two decimal places.
  //
  // The stride skips *positions*, and the step measured at each is still
  // between ADJACENT samples. Measuring `|ch[i + stride] - ch[i]|` instead
  // would compare the wrap (which is an adjacent-sample step) against a much
  // larger stridden one, and the longer the file the more it would understate
  // the click — a ten-minute bed with an obvious tick would score as clean.
  const stride = Math.max(1, Math.floor(total / 20000));

  for (const ch of pcm.channels) {
    wrapStep = Math.max(wrapStep, Math.abs(ch[0] - ch[total - 1]));
    for (let i = 0; i + 1 < total; i += stride) {
      stepSum += Math.abs(ch[i + 1] - ch[i]);
      stepCount++;
    }
  }
  const typicalStep = stepCount ? stepSum / stepCount : 0;

  const window = Math.min(Math.floor(total / 4), Math.round(0.05 * pcm.sampleRate));
  const headRms = rms(pcm, 0, window);
  const tailRms = rms(pcm, total - window, total);
  const levelMatch = headRms > 0 && tailRms > 0 ? Math.min(headRms, tailRms) / Math.max(headRms, tailRms) : headRms === tailRms ? 1 : 0;

  const clickRatio = typicalStep > 0 ? wrapStep / typicalStep : wrapStep > 0 ? Infinity : 0;
  return {
    clickRatio: Number.isFinite(clickRatio) ? Math.round(clickRatio * 100) / 100 : clickRatio,
    clickDb: wrapStep > 0 ? Math.round(20 * Math.log10(wrapStep) * 10) / 10 : -Infinity,
    levelMatch: Math.round(levelMatch * 1000) / 1000,
    // Thresholds chosen against real material: a wrap step within ~3× the
    // waveform's own typical step is inaudible, and a level mismatch under
    // ~3.5 dB (0.67) doesn't read as a pulse once per repeat.
    smooth: clickRatio <= 3 && levelMatch >= 0.67,
  };
}

/**
 * The one-call version: find the best loop and build it.
 *
 * `loopStart`/`loopEnd` skip the search when the caller already knows where the
 * loop goes — which is what a selection in the panel means.
 */
export function autoLoop(pcm, {
  loopStart = null,
  loopEnd = null,
  crossfadeSeconds = 0.25,
  minSeconds = 1,
  maxSeconds = null,
  searchStartSeconds = 0,
} = {}) {
  if (loopStart != null && loopEnd != null) {
    const built = makeSeamlessLoop(pcm, { loopStart, loopEnd, crossfadeSeconds });
    return { ...built, seam: seamAnalysis(built.pcm), chosen: null, alternatives: [] };
  }

  const analysis = analyzeLoop(pcm, { minSeconds, maxSeconds, crossfadeSeconds, searchStartSeconds });
  const best = analysis.candidates[0];
  if (!best) {
    // No candidate is not a failure — looping the whole thing is still the
    // right answer for a sound that is already one cycle long, and it still
    // gets a click-free wrap out of the same construction.
    const built = makeSeamlessLoop(pcm, {
      loopStart: Math.round(searchStartSeconds * pcm.sampleRate),
      loopEnd: frameCount(pcm),
      crossfadeSeconds,
    });
    return { ...built, seam: seamAnalysis(built.pcm), chosen: null, alternatives: [], note: analysis.reason };
  }

  const built = makeSeamlessLoop(pcm, { loopStart: best.loopStart, loopEnd: best.loopEnd, crossfadeSeconds });
  return { ...built, seam: seamAnalysis(built.pcm), chosen: best, alternatives: analysis.candidates.slice(1) };
}

/** Repeats a loop `times` over, for auditioning the seam. */
export function repeatLoop(pcm, times = 3) {
  const total = frameCount(pcm);
  const count = Math.max(1, Math.round(times));
  const out = createPcm(channelCount(pcm), total * count, pcm.sampleRate);
  for (let c = 0; c < pcm.channels.length; c++) {
    for (let n = 0; n < count; n++) out.channels[c].set(pcm.channels[c], n * total);
  }
  return total === 0 ? clonePcm(pcm) : out;
}
