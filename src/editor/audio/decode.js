/**
 * One of the two places Web Audio is allowed to appear (the other is
 * `playback.js`). Everything past this boundary is the plain
 * `{ sampleRate, channels }` form that the rest of `src/editor/audio/`
 * operates on and that `npm run test:audio` can exercise under node.
 *
 * WAV is decoded by our own codec rather than by the browser — it's the format
 * the test suite needs to round-trip without a browser, and it avoids a
 * pointless resample when the file already matches. Everything else (mp3, ogg,
 * flac, m4a, webm) goes through `decodeAudioData`, which is the reason the
 * editor accepts those formats at all: writing five more decoders to avoid one
 * call into a decoder every target browser already ships would be silly.
 *
 * The one thing to know about `decodeAudioData`: **it resamples to the
 * AudioContext's rate.** A 22.05 kHz mp3 decoded in a 48 kHz context comes back
 * at 48 kHz, already interpolated. That's why the shared context is created at
 * the highest rate the platform offers and why `sampleRate` on the result is
 * read from the buffer rather than assumed.
 */
import { decodeWav, looksLikeWav } from "./wav.js";
import { opusStreamInfo } from "./ogg.js";

let sharedContext = null;

/**
 * The editor's decode/playback context.
 *
 * Created lazily — constructing an AudioContext before a user gesture makes
 * Chromium log an autoplay warning and start it suspended — and shared, because
 * browsers cap the number of contexts a page may hold and a panel that made one
 * per file would hit that within a session.
 */
export function audioContext() {
  if (sharedContext) return sharedContext;
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) return null;
  sharedContext = new Ctor();
  return sharedContext;
}

/** An `AudioBuffer` → the plain form. Copies; the buffer stays the caller's. */
export function fromAudioBuffer(buffer) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(new Float32Array(buffer.getChannelData(c)));
  return { sampleRate: buffer.sampleRate, channels };
}

/** The plain form → an `AudioBuffer` for playback. */
export function toAudioBuffer(pcm, context = audioContext()) {
  if (!context) throw new Error("No AudioContext available");
  const frames = pcm.channels[0]?.length ?? 0;
  // A zero-length AudioBuffer throws; hand back a single silent frame so
  // callers don't each need to special-case an empty document.
  const buffer = context.createBuffer(Math.max(1, pcm.channels.length), Math.max(1, frames), pcm.sampleRate);
  for (let c = 0; c < pcm.channels.length; c++) buffer.copyToChannel(pcm.channels[c], c);
  return buffer;
}

/**
 * Bytes → the plain form, whatever the format.
 *
 * `decodeAudioData` detaches the ArrayBuffer it's given, so it gets a copy —
 * otherwise the caller's bytes silently become a zero-length buffer and the
 * next thing to touch them (writing the file back, hashing it) sees nothing.
 */
export async function decodeAudioBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (looksLikeWav(u8)) return decodeWav(u8);

  const context = audioContext();
  if (!context) throw new Error("This environment cannot decode compressed audio (no AudioContext)");
  // Read the container's own idea of the length BEFORE decoding — the decoder
  // is about to detach the buffer, and this is the only chance to see it.
  const opus = opusStreamInfo(u8);
  const copy = u8.slice().buffer;
  try {
    return trimToDeclaredLength(fromAudioBuffer(await context.decodeAudioData(copy)), opus);
  } catch (err) {
    throw new Error(`Could not decode this audio file (${err?.message ?? "unsupported format"})`);
  }
}

/**
 * Applies an Ogg Opus stream's end-trim, which `decodeAudioData` does not.
 *
 * Opus encodes whole 20 ms frames, so the last one always runs past the real
 * end of the sound; the final granule position is what says where to stop.
 * Chromium honours the pre-skip at the front and ignores the trim at the back,
 * handing back up to 20 ms of trailing silence. Harmless once — but the editor
 * re-opens the files it writes, so an Ogg saved and reopened repeatedly would
 * grow a little each time, and a seamless loop would quietly acquire the gap it
 * was made to remove.
 *
 * Only ever shortens, and only when the numbers are sane: a file from anywhere
 * else must come back exactly as the browser decoded it.
 */
function trimToDeclaredLength(pcm, opus) {
  if (!opus || !(opus.frames > 0)) return pcm;
  // Granules count 48 kHz samples; the decode landed at the context's rate.
  const target = Math.round((opus.frames * pcm.sampleRate) / 48000);
  const have = pcm.channels[0]?.length ?? 0;
  if (target >= have || have - target > pcm.sampleRate) return pcm;
  return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((ch) => ch.slice(0, target)) };
}
