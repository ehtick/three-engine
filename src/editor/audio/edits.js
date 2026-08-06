/**
 * Structural edits: the operations that change how long a sound is or where
 * its parts sit. Amplitude, filtering and time-stretching are effects and live
 * elsewhere; these are the cut-and-paste layer.
 *
 * Every function is pure — takes PCM and a range, returns new PCM — which is
 * what lets undo be "keep the old buffer" rather than an inverse operation per
 * edit. Buffers are large but a session's worth of them is bounded by
 * `history.js`, and an inverse-operation undo stack is where subtle
 * irreversibility bugs live.
 *
 * Ranges are `[start, end)` in frames. Callers that got their range from a
 * pointer drag should pass it through `snapRange` first: a cut on a non-zero
 * sample leaves a step discontinuity, which is a click, and a click is the most
 * common way an edited game sound comes out sounding broken.
 */
import {
  createPcm,
  clonePcm,
  slicePcm,
  concatPcm,
  frameCount,
  channelCount,
  nearestZeroCrossing,
} from "./pcm.js";

/** Clamps and orders a range against a buffer's real length. */
export function normalizeRange(pcm, start, end) {
  const total = frameCount(pcm);
  let from = Math.max(0, Math.min(total, Math.floor(start ?? 0)));
  let to = Math.max(0, Math.min(total, Math.floor(end ?? total)));
  if (to < from) [from, to] = [to, from];
  return [from, to];
}

/** Both edges moved to the nearest zero crossing within `window` frames. */
export function snapRange(pcm, start, end, window = 512) {
  const [from, to] = normalizeRange(pcm, start, end);
  return [nearestZeroCrossing(pcm, from, window), nearestZeroCrossing(pcm, to, window)];
}

/** The selection, as its own buffer. This is Copy. */
export function copyRange(pcm, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  return slicePcm(pcm, from, to);
}

/** Removes the selection and closes the gap. This is Cut/Delete. */
export function deleteRange(pcm, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  if (from === to) return clonePcm(pcm);
  return concatPcm(slicePcm(pcm, 0, from), slicePcm(pcm, to, frameCount(pcm)));
}

/** Zeros the selection, keeping the length. Audacity's Silence. */
export function silenceRange(pcm, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  const out = clonePcm(pcm);
  for (const ch of out.channels) ch.fill(0, from, to);
  return out;
}

/** Keeps only the selection. Audacity's Trim. */
export function trimToRange(pcm, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  return slicePcm(pcm, from, to);
}

/** Inserts a clip at `at`, pushing everything after it later. */
export function insertAt(pcm, at, clip) {
  const total = frameCount(pcm);
  const position = Math.max(0, Math.min(total, Math.floor(at)));
  return concatPcm(slicePcm(pcm, 0, position), clip, slicePcm(pcm, position, total));
}

/** Replaces the selection with a clip. This is Paste over a selection. */
export function replaceRange(pcm, start, end, clip) {
  const [from, to] = normalizeRange(pcm, start, end);
  return concatPcm(slicePcm(pcm, 0, from), clip, slicePcm(pcm, to, frameCount(pcm)));
}

/** Inserts a copy of the selection immediately after it. */
export function duplicateRange(pcm, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  if (from === to) return clonePcm(pcm);
  return insertAt(pcm, to, slicePcm(pcm, from, to));
}

/** Inserts `seconds` of silence at `at`. */
export function insertSilence(pcm, at, seconds) {
  const frames = Math.max(0, Math.round(seconds * pcm.sampleRate));
  return insertAt(pcm, at, createPcm(channelCount(pcm), frames, pcm.sampleRate));
}

/**
 * Reverses the selection in place (the rest of the buffer is untouched).
 * Cheap, obviously correct, and a genuine sound-design tool — a reversed tail
 * is how you make a "sucking in" pre-impact whoosh.
 */
export function reverseRange(pcm, start, end) {
  const [from, to] = normalizeRange(pcm, start, end);
  const out = clonePcm(pcm);
  for (const ch of out.channels) {
    for (let i = from, j = to - 1; i < j; i++, j--) {
      const tmp = ch[i];
      ch[i] = ch[j];
      ch[j] = tmp;
    }
  }
  return out;
}

/**
 * Removes silence from the head and tail.
 *
 * The threshold is in dBFS and the default (-60) is chosen to sit below a quiet
 * room tone but above a dithered digital floor. `padSeconds` leaves a little
 * air rather than cutting hard against the first transient — a trimmed sound
 * that starts on sample zero of its attack can click on playback, which is the
 * thing this is supposed to prevent.
 */
export function trimSilence(pcm, { thresholdDb = -60, padSeconds = 0.005 } = {}) {
  const threshold = 10 ** (thresholdDb / 20);
  const total = frameCount(pcm);
  const loudAt = (i) => {
    for (const ch of pcm.channels) {
      if (Math.abs(ch[i]) > threshold) return true;
    }
    return false;
  };

  let first = 0;
  while (first < total && !loudAt(first)) first++;
  if (first === total) return createPcm(channelCount(pcm), 0, pcm.sampleRate); // silent throughout

  let last = total - 1;
  while (last > first && !loudAt(last)) last--;

  const pad = Math.round(padSeconds * pcm.sampleRate);
  return slicePcm(pcm, Math.max(0, first - pad), Math.min(total, last + 1 + pad));
}
