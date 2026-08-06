/**
 * Dynamics: compressor, limiter, gate.
 *
 * Three decisions shape all of them.
 *
 * **The detector is shared across channels.** A stereo file compressed with
 * independent per-channel detectors wanders — a loud transient on the left
 * ducks only the left, and the image lurches to the right for the duration of
 * the release. Linked detection (the loudest channel drives the gain applied to
 * every channel) is what keeps the image still, and it's what every hardware
 * compressor does.
 *
 * **Gain is computed in dB, smoothed, then converted once.** Smoothing a linear
 * gain gives a release that sounds fast at the top and slow at the bottom,
 * because loudness is logarithmic. Attack/release times therefore mean the same
 * thing regardless of how far the gain has to travel.
 *
 * **The limiter looks ahead; the compressor doesn't.** A compressor that
 * catches a transient after the fact is doing its job — that's the character.
 * A limiter that does the same has already let the overshoot through, which
 * makes it not a limiter.
 */
import { clonePcm, frameCount, dbToGain, gainToDb } from "./pcm.js";
import { normalizeRange } from "./edits.js";

/** Time constant for a one-pole smoother, as a per-sample coefficient. */
const coefficient = (ms, sampleRate) =>
  ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * sampleRate));

/** Loudest absolute sample across every channel at frame `i`. */
function linkedPeak(channels, i) {
  let max = 0;
  for (const ch of channels) {
    const v = ch[i] < 0 ? -ch[i] : ch[i];
    if (v > max) max = v;
  }
  return max;
}

/**
 * Downward compressor with a soft knee.
 *
 * `knee` is the width in dB over which the ratio eases in. A hard knee (0) is
 * audible as a "grab" on every transient that crosses the threshold; a few dB of
 * knee is what makes compression sound like level control rather than an effect.
 */
export function compress(pcm, {
  thresholdDb = -18,
  ratio = 4,
  attackMs = 5,
  releaseMs = 100,
  kneeDb = 6,
  makeupDb = 0,
  autoMakeup = false,
} = {}, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  const out = clonePcm(pcm);
  const attack = coefficient(attackMs, pcm.sampleRate);
  const release = coefficient(releaseMs, pcm.sampleRate);
  const safeRatio = Math.max(1, ratio);

  // Auto-makeup restores roughly what the threshold and ratio took away, so
  // A/B-ing the effect compares tone rather than loudness — without it every
  // compressor sounds "worse" simply because it's quieter.
  const makeup = autoMakeup
    ? -thresholdDb * (1 - 1 / safeRatio) * 0.5
    : makeupDb;
  const makeupGain = dbToGain(makeup);

  let envelopeDb = 0; // current gain reduction, in dB (<= 0)
  for (let i = from; i < to; i++) {
    const level = linkedPeak(out.channels, i);
    const levelDb = level > 0 ? gainToDb(level) : -120;
    const targetDb = -Math.max(0, gainComputer(levelDb, thresholdDb, safeRatio, kneeDb));
    // More reduction = attack; less = release. Comparing in dB is what makes
    // the two times mean the same thing at any depth.
    const c = targetDb < envelopeDb ? attack : release;
    envelopeDb = targetDb + c * (envelopeDb - targetDb);
    const gain = dbToGain(envelopeDb) * makeupGain;
    for (const ch of out.channels) ch[i] *= gain;
  }
  return out;
}

/** How many dB to remove at this input level. Returns >= 0. */
function gainComputer(levelDb, thresholdDb, ratio, kneeDb) {
  const over = levelDb - thresholdDb;
  if (kneeDb > 0 && over > -kneeDb / 2 && over < kneeDb / 2) {
    // Quadratic interpolation across the knee — the standard soft-knee curve.
    const x = over + kneeDb / 2;
    return ((1 / ratio - 1) * x * x) / (2 * kneeDb) * -1;
  }
  if (over <= 0) return 0;
  return over - over / ratio;
}

/**
 * Brick-wall limiter with lookahead.
 *
 * The delay line is what makes it a limiter rather than a fast compressor: the
 * gain for a peak is computed and ramped in *before* the peak arrives, so
 * nothing crosses the ceiling. The output is delayed by `lookaheadMs`; the tail
 * is padded so no audio is lost, which means the result is very slightly longer
 * than the input.
 */
export function limit(pcm, { ceilingDb = -0.3, lookaheadMs = 5, releaseMs = 50 } = {}, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  const sampleRate = pcm.sampleRate;
  const lookahead = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate));
  const ceiling = dbToGain(ceilingDb);
  const release = coefficient(releaseMs, sampleRate);
  const out = clonePcm(pcm);
  const span = to - from;
  if (span <= 0) return out;

  // 1. The gain each frame needs on its own.
  const need = new Float32Array(span);
  for (let i = 0; i < span; i++) {
    const level = linkedPeak(out.channels, from + i);
    need[i] = level > ceiling ? ceiling / level : 1;
  }

  // 2. Sliding minimum over the lookahead window, so frame i already knows
  //    about the loudest thing arriving within the window ahead of it. This is
  //    what lookahead *is*, and a monotonic deque computes it in O(n) rather
  //    than the O(n·window) a naive rescan costs — at 48 kHz with a 5 ms window
  //    that is the difference between instant and a visible stall.
  const target = new Float32Array(span);
  const deque = new Int32Array(span);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < span; i++) {
    const bound = Math.min(span - 1, i + lookahead);
    // Extend the window to cover everything up to `bound`.
    for (let j = i === 0 ? 0 : Math.min(span - 1, i - 1 + lookahead + 1); j <= bound; j++) {
      while (tail > head && need[deque[tail - 1]] >= need[j]) tail--;
      deque[tail++] = j;
    }
    while (deque[head] < i) head++;
    target[i] = need[deque[head]];
  }

  // 3. Attack is instant (the whole point — nothing may cross the ceiling),
  //    release is smoothed so the gain returns gradually instead of stepping.
  let current = 1;
  for (let i = 0; i < span; i++) {
    current = target[i] < current ? target[i] : target[i] + release * (current - target[i]);
    for (const ch of out.channels) ch[from + i] *= current;
  }
  return out;
}

/**
 * Noise gate with hysteresis and a hold time.
 *
 * Two thresholds, not one: a single threshold makes a signal hovering around it
 * chatter open and shut many times a second, which is far more noticeable than
 * the noise being gated. The gate opens at `thresholdDb` and only closes once
 * the signal falls below `thresholdDb - hysteresisDb`, then waits `holdMs`
 * before starting to close — which is what stops a reverb tail or a breath
 * being chopped off mid-decay.
 */
export function gate(pcm, {
  thresholdDb = -40,
  hysteresisDb = 6,
  attackMs = 1,
  holdMs = 50,
  releaseMs = 100,
  floorDb = -80,
} = {}, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  const out = clonePcm(pcm);
  const open = dbToGain(thresholdDb);
  const close = dbToGain(thresholdDb - Math.abs(hysteresisDb));
  const attack = coefficient(attackMs, pcm.sampleRate);
  const release = coefficient(releaseMs, pcm.sampleRate);
  const holdFrames = Math.round((holdMs / 1000) * pcm.sampleRate);
  const floor = dbToGain(floorDb);

  let gain = 0;
  let isOpen = false;
  let holdCounter = 0;

  for (let i = from; i < to; i++) {
    const level = linkedPeak(out.channels, i);
    if (level >= open) {
      isOpen = true;
      holdCounter = holdFrames;
    } else if (isOpen && level < close) {
      if (holdCounter > 0) holdCounter--;
      else isOpen = false;
    }
    const target = isOpen ? 1 : floor;
    const c = target > gain ? attack : release;
    gain = target + c * (gain - target);
    for (const ch of out.channels) ch[i] *= gain;
  }
  return out;
}

/**
 * Peak and RMS of a range, in dB — what the panel's meter reads and what
 * "did this actually do anything" is judged by.
 */
export function measure(pcm, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  let peak = 0;
  let sum = 0;
  let count = 0;
  for (const ch of pcm.channels) {
    for (let i = from; i < to; i++) {
      const v = ch[i] < 0 ? -ch[i] : ch[i];
      if (v > peak) peak = v;
      sum += ch[i] * ch[i];
      count++;
    }
  }
  const rms = count ? Math.sqrt(sum / count) : 0;
  return {
    peak,
    rms,
    peakDb: peak > 0 ? gainToDb(peak) : -Infinity,
    rmsDb: rms > 0 ? gainToDb(rms) : -Infinity,
    frames: Math.max(0, to - from),
    clipping: peak > 1,
  };
}

export { frameCount };
