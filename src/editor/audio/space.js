/**
 * Space: delay, reverb, and the modulated delays (chorus/flanger).
 *
 * All three are the same primitive — a delay line — differing in how long it is
 * and what modulates it. They're together for that reason.
 *
 * Every one of them **extends the buffer**. A reverb applied to a one-second
 * impact produces more than one second of audio, and truncating the tail at the
 * original length is the single most common way an effect implementation
 * produces a result that sounds abruptly wrong. The caller gets a longer buffer
 * and the panel reports the new length.
 */
import { createPcm, frameCount, channelCount, clonePcm } from "./pcm.js";
import { normalizeRange } from "./edits.js";

/**
 * Echo with feedback.
 *
 * The tail is sized from how long the feedback takes to fall below -60 dB
 * rather than from a fixed guess: at 0.8 feedback a 500 ms delay is still
 * audible seven seconds later, and a fixed two-second tail would cut it off
 * mid-repeat.
 */
export function delay(pcm, {
  timeMs = 250,
  feedback = 0.4,
  mix = 0.35,
  pingPong = false,
} = {}) {
  const sampleRate = pcm.sampleRate;
  const delayFrames = Math.max(1, Math.round((timeMs / 1000) * sampleRate));
  const fb = Math.max(0, Math.min(0.95, feedback));
  const repeats = fb > 0.001 ? Math.ceil(Math.log(0.001) / Math.log(fb)) : 1;
  const tail = Math.min(delayFrames * repeats, sampleRate * 30);

  const inFrames = frameCount(pcm);
  const channels = channelCount(pcm);
  const out = createPcm(channels, inFrames + tail, sampleRate);

  for (let c = 0; c < channels; c++) {
    const src = pcm.channels[c];
    const dst = out.channels[c];
    for (let i = 0; i < inFrames; i++) dst[i] = src[i] * (1 - mix);
  }

  // Feed each repeat from the *wet* signal so feedback compounds, which is what
  // makes repeats decay rather than all being the same level.
  const wet = [];
  for (let c = 0; c < channels; c++) wet.push(new Float32Array(inFrames + tail));

  for (let c = 0; c < channels; c++) {
    const src = pcm.channels[c];
    const line = wet[c];
    for (let i = 0; i < inFrames + tail; i++) {
      const from = i - delayFrames;
      if (from < 0) continue;
      const dry = from < inFrames ? src[from] : 0;
      line[i] = dry + line[from] * fb;
    }
  }

  for (let c = 0; c < channels; c++) {
    // Ping-pong sends each repeat to the opposite channel; with one channel
    // there is no "opposite", so it degrades to a normal delay rather than
    // silently doing nothing.
    const source = pingPong && channels === 2 ? wet[1 - c] : wet[c];
    const dst = out.channels[c];
    for (let i = 0; i < dst.length; i++) dst[i] += source[i] * mix;
  }
  return out;
}

/**
 * Reverb: a Schroeder/Moorer topology — four parallel comb filters into two
 * series allpasses, per channel.
 *
 * Convolution with a real impulse response would sound better and needs an
 * impulse file we don't have and can't ship the rights to. This is the classic
 * algorithmic alternative: the combs build density, the allpasses smear it so
 * the comb resonances stop being individually audible, and the whole thing is
 * about sixty lines with no assets.
 *
 * The comb delays are mutually prime-ish on purpose. Related delay lengths make
 * their echoes coincide, which is heard as a metallic ringing at the common
 * frequency instead of as a room.
 */
const COMB_DELAYS_MS = [29.7, 37.1, 41.1, 43.7];
const ALLPASS_DELAYS_MS = [5.0, 1.7];

export function reverb(pcm, {
  roomSize = 0.5,
  damping = 0.4,
  mix = 0.3,
  preDelayMs = 20,
  width = 1,
} = {}) {
  const sampleRate = pcm.sampleRate;
  const inFrames = frameCount(pcm);
  const channels = channelCount(pcm);
  const feedback = 0.7 + 0.28 * Math.max(0, Math.min(1, roomSize));
  const damp = Math.max(0, Math.min(0.99, damping));

  // Tail length from the decay the feedback actually implies, same reasoning as
  // the delay above.
  const longestComb = (COMB_DELAYS_MS[COMB_DELAYS_MS.length - 1] / 1000) * sampleRate;
  const decayRepeats = Math.ceil(Math.log(0.001) / Math.log(feedback));
  const preDelay = Math.round((preDelayMs / 1000) * sampleRate);
  const tail = Math.min(Math.round(longestComb * decayRepeats) + preDelay, sampleRate * 20);
  const out = createPcm(channels, inFrames + tail, sampleRate);

  for (let c = 0; c < channels; c++) {
    const src = pcm.channels[c];
    const total = inFrames + tail;
    const input = new Float32Array(total);
    // Pre-delay separates the direct sound from the onset of the reflections,
    // which is most of what makes a reverb read as "a big room" rather than as
    // "a blurry copy of the sound".
    for (let i = 0; i < inFrames; i++) input[i + preDelay < total ? i + preDelay : total - 1] += src[i];

    let wet = new Float32Array(total);
    for (const [index, ms] of COMB_DELAYS_MS.entries()) {
      // Stagger the second channel's delays slightly so the two sides aren't
      // identical — identical channels give a reverb that collapses to the
      // centre and sounds mono.
      const spread = c === 1 ? 1 + 0.012 * width : 1;
      const size = Math.max(1, Math.round((ms / 1000) * sampleRate * spread));
      comb(input, wet, size, feedback, damp);
      void index;
    }
    for (let i = 0; i < total; i++) wet[i] /= COMB_DELAYS_MS.length;

    for (const ms of ALLPASS_DELAYS_MS) {
      const size = Math.max(1, Math.round((ms / 1000) * sampleRate));
      wet = allpass(wet, size, 0.5);
    }

    const dst = out.channels[c];
    for (let i = 0; i < total; i++) {
      const dry = i < inFrames ? src[i] : 0;
      dst[i] = dry * (1 - mix) + wet[i] * mix;
    }
  }
  return out;
}

/** One lowpass-damped comb, accumulated into `acc`. */
function comb(input, acc, size, feedback, damping) {
  const buffer = new Float32Array(size);
  let index = 0;
  let store = 0;
  for (let i = 0; i < input.length; i++) {
    const delayed = buffer[index];
    acc[i] += delayed;
    // One-pole lowpass inside the feedback path: real rooms absorb high
    // frequencies faster than low ones, and without this the tail stays bright
    // forever and sounds like a spring, not a room.
    store = delayed * (1 - damping) + store * damping;
    buffer[index] = input[i] + store * feedback;
    if (++index >= size) index = 0;
  }
}

/** One Schroeder allpass — diffuses without colouring the magnitude response. */
function allpass(input, size, gain) {
  const out = new Float32Array(input.length);
  const buffer = new Float32Array(size);
  let index = 0;
  for (let i = 0; i < input.length; i++) {
    const delayed = buffer[index];
    out[i] = -input[i] + delayed;
    buffer[index] = input[i] + delayed * gain;
    if (++index >= size) index = 0;
  }
  return out;
}

/**
 * Chorus and flanger: a short delay whose length is modulated by an LFO.
 *
 * The only real difference between them is that scale — a flanger's delay is
 * short enough (under ~10 ms) for the comb notches it creates to land in the
 * audible band and sweep, while a chorus's is long enough (~20-40 ms) to read as
 * a second, slightly-late, slightly-detuned voice. Same code, different presets.
 */
export function modulatedDelay(pcm, {
  baseMs = 20,
  depthMs = 5,
  rateHz = 0.5,
  feedback = 0,
  mix = 0.5,
  stereoPhase = 0.25,
} = {}, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  const sampleRate = pcm.sampleRate;
  const out = clonePcm(pcm);
  const base = (baseMs / 1000) * sampleRate;
  const depth = (depthMs / 1000) * sampleRate;
  const maxDelay = Math.ceil(base + depth) + 2;
  const fb = Math.max(0, Math.min(0.9, feedback));

  for (let c = 0; c < out.channels.length; c++) {
    const src = pcm.channels[c];
    const dst = out.channels[c];
    const line = new Float32Array(maxDelay);
    let index = 0;
    // Offsetting the LFO per channel is what gives the effect width; with both
    // channels in phase it is a mono effect on a stereo file.
    const phase = c * stereoPhase * 2 * Math.PI;
    for (let i = from; i < to; i++) {
      const lfo = Math.sin((2 * Math.PI * rateHz * (i - from)) / sampleRate + phase);
      const delaySamples = base + depth * lfo;
      // Fractional delay by linear interpolation. Rounding to the nearest
      // sample instead produces a stepping, "zippering" artefact as the LFO
      // sweeps, which is audible precisely because the sweep is the effect.
      const read = index - delaySamples;
      const readIndex = ((Math.floor(read) % maxDelay) + maxDelay) % maxDelay;
      const nextIndex = (readIndex + 1) % maxDelay;
      const frac = read - Math.floor(read);
      const delayed = line[readIndex] * (1 - frac) + line[nextIndex] * frac;

      line[index] = src[i] + delayed * fb;
      if (++index >= maxDelay) index = 0;
      dst[i] = src[i] * (1 - mix) + delayed * mix;
    }
  }
  return out;
}

export const CHORUS = { baseMs: 25, depthMs: 6, rateHz: 0.6, feedback: 0, mix: 0.45 };
export const FLANGER = { baseMs: 3, depthMs: 2.5, rateHz: 0.25, feedback: 0.6, mix: 0.5 };
