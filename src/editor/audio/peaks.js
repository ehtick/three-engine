/**
 * Waveform drawing data.
 *
 * A waveform lane is a few hundred pixels wide and the buffer behind it can be
 * tens of millions of samples, so drawing must never touch every sample. What a
 * lane actually needs per pixel column is the min and max in that column's
 * sample span — that's what makes a waveform look like a waveform rather than
 * an aliased mess of whichever sample happened to land on the pixel.
 *
 * So: one base summary at a fixed bucket size, built once per edit, and coarser
 * zoom levels aggregated down from it. Reading a coarse level from the base is
 * O(columns), not O(samples), which is what keeps zooming out over a ten-minute
 * ambience instant.
 *
 * Below the base bucket size the raw samples are read directly — at that zoom
 * there are few enough of them that it's cheaper than any summary, and it's the
 * zoom level where sample-accurate truth matters most (finding a zero crossing,
 * inspecting a click).
 */
import { frameCount } from "./pcm.js";

export const BASE_BUCKET = 256;

/**
 * Builds the base min/max summary. One `{ min, max }` pair of `Float32Array`s
 * per channel, each `ceil(frames / BASE_BUCKET)` long — about 0.8% of the
 * source size, so a summary for a ten-minute stereo ambience is under a
 * megabyte.
 */
export function buildPeaks(pcm, bucket = BASE_BUCKET) {
  const frames = frameCount(pcm);
  const buckets = Math.ceil(frames / bucket);
  const channels = pcm.channels.map((ch) => {
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    for (let b = 0; b < buckets; b++) {
      const from = b * bucket;
      const to = Math.min(frames, from + bucket);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = from; i < to; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[b] = lo === Infinity ? 0 : lo;
      max[b] = hi === -Infinity ? 0 : hi;
    }
    return { min, max };
  });
  return { bucket, buckets, frames, sampleRate: pcm.sampleRate, channels };
}

/**
 * Column min/max for a lane: `columns` pixels covering frames `[from, to)`.
 *
 * Reads the summary when a column spans at least one whole bucket, and the raw
 * samples when it doesn't. `pcm` may be omitted, in which case a zoomed-in
 * request falls back to the summary and simply looks blockier — better than
 * throwing at the exact moment someone zooms in.
 */
export function columnPeaks(peaks, pcm, channel, from, to, columns) {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const span = Math.max(1, to - from);
  const framesPerColumn = span / columns;

  const summary = peaks?.channels?.[channel];
  const raw = pcm?.channels?.[channel];
  const useRaw = raw && framesPerColumn < (peaks?.bucket ?? BASE_BUCKET);

  for (let x = 0; x < columns; x++) {
    const start = from + x * framesPerColumn;
    const end = start + framesPerColumn;
    let lo = Infinity;
    let hi = -Infinity;

    if (useRaw) {
      const i0 = Math.max(0, Math.floor(start));
      // At extreme zoom a column can cover less than one sample; always read at
      // least one so a column never comes back empty and draws as a gap.
      const i1 = Math.min(raw.length, Math.max(i0 + 1, Math.ceil(end)));
      for (let i = i0; i < i1; i++) {
        const v = raw[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    } else if (summary) {
      const b0 = Math.max(0, Math.floor(start / peaks.bucket));
      const b1 = Math.min(peaks.buckets, Math.max(b0 + 1, Math.ceil(end / peaks.bucket)));
      for (let b = b0; b < b1; b++) {
        if (summary.min[b] < lo) lo = summary.min[b];
        if (summary.max[b] > hi) hi = summary.max[b];
      }
    }

    min[x] = lo === Infinity ? 0 : lo;
    max[x] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}
