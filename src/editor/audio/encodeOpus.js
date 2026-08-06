/**
 * Opus encoding — the third and last place a Web API appears in this directory
 * (the others being `decode.js` and `playback.js`).
 *
 * `AudioEncoder` (WebCodecs) hands back raw Opus packets and stops there;
 * nothing in the browser will put them in a container. `ogg.js` does that half
 * in plain JS so it can be tested under node. This file is the thin, untestable
 * bridge between them, and it is kept thin for exactly that reason.
 *
 * ## Why encode at all
 *
 * Two reasons, both concrete. Every sound the Audio Library imports from
 * Freesound is a `.ogg`, and until this existed, editing one could not save in
 * place — it wrote a sibling `.wav` and said so. And a shipped web build is
 * usually mostly audio: a two-minute stereo ambience is 20 MB as 32-bit WAV and
 * about 1.5 MB at 96 kbps Opus.
 *
 * ## The three things that make this correct rather than nearly correct
 *
 *  1. **Opus is a 48 kHz codec.** Feeding it another rate either fails or gets
 *     resampled by an implementation we don't control. `resample.js` does it
 *     here instead, so the output is identical on every browser and the input
 *     rate survives in the OpusHead field for anything that wants to know.
 *  2. **Mapping family 0 is mono or stereo.** More than two channels needs the
 *     surround mapping, which no game sound uses; this refuses rather than
 *     silently downmixing someone's 5.1 bed.
 *  3. **Pre-skip has to be declared, and the encoder will not tell us.**
 *     `AudioEncoder` timestamps its first chunk at 0 and does not report its
 *     algorithmic delay, so the value below is libopus's documented lookahead
 *     for a 48 kHz encoder. It is verified empirically rather than assumed —
 *     `npm run smoke:audio` encodes a click, decodes it back in the same
 *     browser, and asserts the transient did not move. If a browser ever
 *     changes its lookahead, that check fails with the measured offset.
 */
import { resample } from "./resample.js";
import { frameCount, channelCount } from "./pcm.js";
import { muxOpusOgg } from "./ogg.js";

/** libopus's lookahead at 48 kHz — 6.5 ms. See the note above. */
export const OPUS_PRE_SKIP = 312;

const OPUS_RATE = 48000;
/** Opus's default frame: 20 ms at 48 kHz. The encoder works in whole ones. */
const OPUS_FRAME_SIZE = 960;
/** Fed to the encoder in blocks so a long file doesn't allocate one huge AudioData. */
const BLOCK_FRAMES = OPUS_RATE / 2;

/**
 * Whether this environment can encode Opus at all.
 *
 * Sync, because `canWriteInPlace` is called while rendering the Save button's
 * label and an async capability check there would flicker between "Save" and
 * "Save as WAV" on every render.
 */
export function opusEncodingAvailable() {
  return typeof globalThis.AudioEncoder !== "undefined" && typeof globalThis.AudioData !== "undefined";
}

/** Bitrates offered in the UI, with what they're for. */
export const OPUS_BITRATES = [
  { value: 64000, label: "64 kbps", hint: "Mono SFX — transparent for short sounds" },
  { value: 96000, label: "96 kbps", hint: "Default. Stereo ambience at good quality" },
  { value: 128000, label: "128 kbps", hint: "Music and long stereo beds" },
  { value: 192000, label: "192 kbps", hint: "When size doesn't matter" },
];

/**
 * `{ sampleRate, channels }` → the bytes of a complete `.ogg` file.
 *
 * `onProgress(fraction)` is called as blocks are fed, because a two-minute
 * stereo file takes long enough that a frozen Save button reads as a hang.
 */
export async function encodeOpusOgg(pcm, { bitrate = 96000, vendor = "engine-audio-editor", comments = [], onProgress } = {}) {
  if (!opusEncodingAvailable()) {
    throw new Error("This browser has no WebCodecs Opus encoder, so Ogg can't be written here. Save as WAV instead.");
  }
  const channels = channelCount(pcm);
  if (channels < 1 || channels > 2) {
    throw new Error(`Ogg Opus is written as mono or stereo; this document has ${channels} channels. Mix it down first.`);
  }

  const inputRate = pcm.sampleRate;
  const source = inputRate === OPUS_RATE ? pcm : resample(pcm, OPUS_RATE);
  const frames = frameCount(source);
  if (frames === 0) throw new Error("There is nothing to encode — this document is empty.");

  const packets = [];
  let encodeError = null;

  const encoder = new globalThis.AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      // `duration` is in microseconds and is what tells the muxer how far the
      // granule advances. Chromium reports it; the 20 ms fallback is the frame
      // size Opus uses by default, so a browser that omits it still muxes to a
      // stream of the right length.
      const packetFrames = chunk.duration ? Math.round((chunk.duration * OPUS_RATE) / 1e6) : 960;
      packets.push({ data, frames: packetFrames });
    },
    error: (err) => {
      encodeError = err;
    },
  });

  encoder.configure({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: channels, bitrate });

  // Pad the input with silence up to a whole number of 20 ms frames past
  // `preSkip + frames`.
  //
  // Two separate things make this necessary, and both were measured rather
  // than assumed — a one-second tone came back 47688 frames instead of 48000,
  // precisely 312 short, while being perfectly aligned at the start, which is
  // what pinned the loss to the end rather than the beginning:
  //
  //  1. The encoder is a pipeline. The packets it emits for N input frames
  //     decode to 312 frames of ramp-up followed by only N − 312 frames of
  //     real signal, so the tail needs `preSkip` more frames pushed through it.
  //  2. `flush()` does NOT pad a partial trailing buffer — it drops it.
  //     Feeding exactly `frames + 312` changed nothing at all (same packet
  //     count, same byte count) because those 312 never filled a frame. Only
  //     rounding up to a whole frame gets them out.
  //
  // The extra silence beyond the real end is then trimmed by `finalGranule`.
  // Six and a half milliseconds missing off the end is inaudible on a one-shot
  // and is a gap at the wrap of every loop — the exact artefact the loop maker
  // exists to remove.
  const paddedFrames = Math.ceil((frames + OPUS_PRE_SKIP) / OPUS_FRAME_SIZE) * OPUS_FRAME_SIZE;

  // Planar float is the format the rest of this directory already holds, so
  // feeding "f32-planar" means no interleave pass and no extra copy per block.
  for (let offset = 0; offset < paddedFrames; offset += BLOCK_FRAMES) {
    if (encodeError) break;
    const count = Math.min(BLOCK_FRAMES, paddedFrames - offset);
    const planar = new Float32Array(count * channels);
    const real = Math.max(0, Math.min(count, frames - offset));
    for (let c = 0; c < channels; c++) {
      if (real > 0) planar.set(source.channels[c].subarray(offset, offset + real), c * count);
      // Anything past `frames` stays zero — that's the flush padding.
    }
    const audioData = new globalThis.AudioData({
      format: "f32-planar",
      sampleRate: OPUS_RATE,
      numberOfFrames: count,
      numberOfChannels: channels,
      timestamp: Math.round((offset / OPUS_RATE) * 1e6),
      data: planar,
    });
    encoder.encode(audioData);
    audioData.close();
    onProgress?.(Math.min(1, (offset + count) / paddedFrames));
    // Let the encoder drain. Without this the whole file is queued in one task
    // and the UI is frozen for the duration — which on a long ambience is the
    // difference between a progress bar and an apparent hang.
    if (encoder.encodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await encoder.flush();
  encoder.close();
  if (encodeError) throw new Error(`Opus encoding failed (${encodeError.message ?? encodeError})`);
  if (packets.length === 0) throw new Error("The Opus encoder produced no data.");

  return muxOpusOgg({
    packets,
    channels,
    preSkip: OPUS_PRE_SKIP,
    inputSampleRate: inputRate,
    vendor,
    comments,
    // Trims the encoder's padding: Opus works in whole 20 ms frames, so the
    // last one runs past the real end of the sound. Without this a looping
    // ambience gains up to 20 ms of silence at the wrap.
    finalGranule: OPUS_PRE_SKIP + frames,
  });
}

/**
 * What `seconds` of audio would cost as Opus, without encoding it.
 *
 * Takes a duration rather than a buffer on purpose: the export menu shows an
 * estimate per bitrate while it is open, and mixing a document down four times
 * per render to measure something that only depends on its length would
 * allocate tens of megabytes for nothing.
 *
 * Opus is VBR, so this is the bitrate times the duration plus container
 * overhead — right to within a few percent, and honest about being an estimate
 * rather than pretending to a byte count it cannot know.
 */
export function estimateOpusBytes(seconds, bitrate = 96000) {
  const payload = (seconds * bitrate) / 8;
  const pageOverhead = Math.ceil(payload / 4000) * 30;
  return Math.round(payload + pageOverhead + 100);
}
