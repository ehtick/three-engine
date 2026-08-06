/**
 * Radix-2 FFT, in-place, plus the window functions the spectral code needs.
 *
 * Hand-written rather than pulled from a library because it's forty lines, it
 * has no dependencies, and every other option either assumes a browser
 * (`AnalyserNode`, which only gives you smoothed magnitudes and no phase) or
 * drags in a package for one function.
 *
 * Real input is passed as separate re/im arrays with im zeroed. That wastes
 * roughly half the work compared with a real-only transform, and it is the
 * right trade here: the spectral subtraction below needs the phase back to
 * resynthesise, so a real-optimised forward transform would have to be undone
 * anyway, and the clarity is worth more than the cycles at these sizes.
 */

/** In-place complex FFT. `re`/`im` must be the same power-of-two length. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fft: length must be a power of two, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const aRe = re[i + j];
        const aIm = im[i + j];
        const bRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const bIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = aRe + bRe;
        im[i + j] = aIm + bIm;
        re[i + j + len / 2] = aRe - bRe;
        im[i + j + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Hann window. Used for both analysis and synthesis in the overlap-add below,
 * which is why the 75% overlap matters: Hann² summed at 4x overlap is constant,
 * so the resynthesis has no amplitude ripple. At 50% overlap it does, and the
 * output gains a periodic wobble at the hop rate.
 */
export function hann(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

/** Magnitude spectrum of one windowed frame — the spectrogram's raw material. */
export function magnitudes(re, im) {
  const half = re.length / 2;
  const out = new Float32Array(half);
  for (let i = 0; i < half; i++) out[i] = Math.hypot(re[i], im[i]);
  return out;
}

/** Next power of two at or above `n`. */
export const nextPow2 = (n) => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};
