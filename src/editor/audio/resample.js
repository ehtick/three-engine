/**
 * Sample-rate conversion, and the speed change that falls out of it.
 *
 * Windowed-sinc rather than linear interpolation. Linear is one line and it is
 * wrong in a way that matters here: it is a crude lowpass that dulls everything
 * above a few kHz, and game audio is full of exactly the transient content —
 * impacts, clicks, footsteps — that it smears. It also aliases badly when
 * downsampling, folding hiss down into the audible band.
 *
 * Two details do the real work:
 *
 *   - **Anti-aliasing on downsample.** Going from 48k to 22.05k, everything
 *     above the new Nyquist must be removed *before* it's resampled or it folds
 *     back as inharmonic noise. Scaling the sinc's cutoff by the rate ratio
 *     makes the interpolation kernel do the filtering too, in the same pass.
 *   - **A Blackman window** on the finite tap range. An abruptly truncated sinc
 *     ripples in the frequency domain (Gibbs), which shows up as a ringing
 *     pre-echo before sharp transients.
 */
import { createPcm, frameCount, channelCount } from "./pcm.js";

const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

/**
 * Resamples to `targetRate`. `taps` is the half-width of the kernel: 16 is
 * transparent for editing work, 32 is for a final export, 4 is for a live
 * preview scrub where latency beats fidelity.
 */
export function resample(pcm, targetRate, { taps = 16 } = {}) {
  const sourceRate = pcm.sampleRate;
  if (!targetRate || targetRate === sourceRate) return { sampleRate: sourceRate, channels: pcm.channels.map((c) => c.slice()) };
  if (targetRate <= 0) throw new Error("resample: target rate must be positive");

  const ratio = sourceRate / targetRate;
  const inFrames = frameCount(pcm);
  const outFrames = Math.max(0, Math.round(inFrames / ratio));
  const out = createPcm(channelCount(pcm), outFrames, targetRate);

  // Below 1 the kernel narrows in frequency to protect the new Nyquist; above
  // 1 (upsampling) there is nothing to protect and the cutoff stays at 1.
  const cutoff = ratio > 1 ? 1 / ratio : 1;
  const halfWidth = Math.ceil(taps / cutoff);

  for (let c = 0; c < out.channels.length; c++) {
    const src = pcm.channels[c];
    const dst = out.channels[c];
    for (let i = 0; i < outFrames; i++) {
      const position = i * ratio;
      const centre = Math.floor(position);
      let sum = 0;
      let weightSum = 0;
      for (let k = -halfWidth; k <= halfWidth; k++) {
        const index = centre + k;
        if (index < 0 || index >= inFrames) continue;
        const distance = position - index;
        const window = blackman(distance / halfWidth);
        if (window <= 0) continue;
        const weight = cutoff * sinc(cutoff * distance) * window;
        sum += src[index] * weight;
        weightSum += weight;
      }
      // Normalising by the realised weight sum is what keeps the first and
      // last few frames — where the kernel hangs off the end of the buffer and
      // half its taps contribute nothing — at full level instead of fading in.
      dst[i] = weightSum !== 0 ? sum / weightSum : 0;
    }
  }
  return out;
}

function blackman(x) {
  if (x <= -1 || x >= 1) return 0;
  const t = (x + 1) / 2;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}

/**
 * Playback-speed change: the tape effect, where slowing down also drops the
 * pitch. Implemented as a resample that keeps the declared sample rate, which
 * is exactly what varispeed is.
 *
 * The pitch-preserving version (`timeStretch`) is a different algorithm
 * entirely and arrives with phase 2 — conflating the two in one "speed" control
 * is a classic way to make a tool confusing.
 */
export function changeSpeed(pcm, factor, { taps = 16 } = {}) {
  if (!(factor > 0)) throw new Error("changeSpeed: factor must be positive");
  if (factor === 1) return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((c) => c.slice()) };
  const resampled = resample(pcm, Math.round(pcm.sampleRate / factor), { taps });
  return { sampleRate: pcm.sampleRate, channels: resampled.channels };
}
