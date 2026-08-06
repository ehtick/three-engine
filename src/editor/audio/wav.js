/**
 * WAV encode/decode, hand-written.
 *
 * Every other format the editor accepts (mp3, ogg, flac, m4a) is decoded by the
 * browser through `decodeAudioData`, at the edge, in `decode.js`. WAV is done
 * here instead for one reason: the test suite needs a real audio format it can
 * round-trip under plain node, and `.aud` documents store their track payloads
 * as WAV so a human with a hex editor can recover the work if the editor ever
 * refuses to open one.
 *
 * Decoding is deliberately tolerant. Real-world WAVs carry `LIST`/`fact`/`cue`
 * chunks in arbitrary order, are sometimes WAVE_FORMAT_EXTENSIBLE rather than
 * plain PCM, and occasionally declare a `data` size larger than the file
 * actually contains (a recorder that was unplugged mid-write). All three are
 * survivable and none of them means the audio is unreadable, so the parser
 * walks the chunk list rather than assuming a canonical 44-byte header, and
 * clamps the data size to what's really there.
 */
import { createPcm, frameCount, channelCount } from "./pcm.js";

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

const fourcc = (view, offset) =>
  String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));

/**
 * Bytes → `{ sampleRate, channels }`. Throws with a specific reason rather
 * than a generic failure: "this is an mp3 named .wav" and "this is 8-channel
 * 64-bit float" want different responses from the caller.
 */
export function decodeWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength < 12) throw new Error("Not a WAV file (too short)");
  if (fourcc(view, 0) !== "RIFF" || fourcc(view, 8) !== "WAVE") {
    throw new Error("Not a WAV file (missing RIFF/WAVE header)");
  }

  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;

  let pos = 12;
  while (pos + 8 <= u8.byteLength) {
    const id = fourcc(view, pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      let format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bitDepth = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE hides the real format in a GUID whose first two
      // bytes are the format tag it stands in for. Without this, every 24-bit
      // file written by a modern DAW reads as "unsupported format 65534".
      if (format === FORMAT_EXTENSIBLE && size >= 40) format = view.getUint16(body + 24, true);
      fmt = { format, channels, sampleRate, bitDepth };
    } else if (id === "data") {
      dataOffset = body;
      dataLength = size;
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte that is
    // not counted in the size field.
    pos = body + size + (size % 2);
  }

  if (!fmt) throw new Error("WAV file has no fmt chunk");
  if (dataOffset < 0) throw new Error("WAV file has no data chunk");
  if (fmt.channels < 1) throw new Error("WAV file declares zero channels");
  if (fmt.format !== FORMAT_PCM && fmt.format !== FORMAT_FLOAT) {
    throw new Error(`Unsupported WAV encoding (format ${fmt.format}) — only PCM and IEEE float are read here`);
  }

  // A truncated file declares more data than it has; read what's present.
  dataLength = Math.min(dataLength, u8.byteLength - dataOffset);

  const bytesPerSample = fmt.bitDepth >> 3;
  if (!bytesPerSample) throw new Error(`Unsupported WAV bit depth (${fmt.bitDepth})`);
  const frames = Math.floor(dataLength / (bytesPerSample * fmt.channels));
  const out = createPcm(fmt.channels, frames, fmt.sampleRate);
  const read = sampleReader(fmt, view, bytesPerSample);

  for (let i = 0; i < frames; i++) {
    const frameStart = dataOffset + i * bytesPerSample * fmt.channels;
    for (let c = 0; c < fmt.channels; c++) {
      out.channels[c][i] = read(frameStart + c * bytesPerSample);
    }
  }
  return out;
}

/**
 * The per-depth sample reader. 8-bit WAV is *unsigned* with 128 as silence,
 * which is the one case that doesn't follow from the others and produces a
 * loud DC-offset buzz if it's read as signed.
 */
function sampleReader(fmt, view, bytesPerSample) {
  if (fmt.format === FORMAT_FLOAT) {
    if (fmt.bitDepth === 32) return (o) => view.getFloat32(o, true);
    if (fmt.bitDepth === 64) return (o) => view.getFloat64(o, true);
    throw new Error(`Unsupported float WAV bit depth (${fmt.bitDepth})`);
  }
  switch (fmt.bitDepth) {
    case 8:
      return (o) => (view.getUint8(o) - 128) / 128;
    case 16:
      return (o) => view.getInt16(o, true) / 32768;
    case 24:
      return (o) => {
        // Little-endian 24-bit, sign-extended by hand — DataView has no getInt24.
        const value = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16);
        return (value & 0x800000 ? value - 0x1000000 : value) / 8388608;
      };
    case 32:
      return (o) => view.getInt32(o, true) / 2147483648;
    default:
      throw new Error(`Unsupported WAV bit depth (${fmt.bitDepth})`);
  }
}

/**
 * `{ sampleRate, channels }` → WAV bytes.
 *
 * `bitDepth` 32 means IEEE float and is lossless for our in-memory form — it's
 * what `.aud` track payloads use, because a document that quantised to 16 bits
 * every time it was saved would audibly degrade over a working session.
 * 16 and 24 are for export, and 16 gets TPDF dither (see below).
 */
export function encodeWav(pcm, { bitDepth = 32, dither = true } = {}) {
  const channels = channelCount(pcm);
  const frames = frameCount(pcm);
  const float = bitDepth === 32;
  const bytesPerSample = float ? 4 : bitDepth >> 3;
  if (![16, 24, 32].includes(bitDepth)) throw new Error(`encodeWav: unsupported bit depth ${bitDepth}`);

  const dataBytes = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const writeTag = (offset, text) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeTag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, float ? FORMAT_FLOAT : FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * channels * bytesPerSample, true); // byte rate
  view.setUint16(32, channels * bytesPerSample, true); // block align
  view.setUint16(34, bitDepth, true);
  writeTag(36, "data");
  view.setUint32(40, dataBytes, true);

  const write = sampleWriter(view, bitDepth, float);
  // TPDF dither: two independent uniform draws summed, scaled to one LSB. It
  // decorrelates the quantisation error from the signal, which is what turns
  // truncation distortion (audible as a gritty edge on fades and reverb tails,
  // exactly where game audio lives) into a steady, much quieter noise floor.
  // Only for 16-bit: at 24 bits the error is already below anything audible and
  // adding noise would be pure loss.
  const lsb = bitDepth === 16 ? 1 / 32768 : 0;
  const useDither = dither && bitDepth === 16;

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let sample = pcm.channels[c][i];
      if (useDither) sample += (Math.random() + Math.random() - 1) * lsb;
      write(44 + (i * channels + c) * bytesPerSample, sample);
    }
  }
  return bytes;
}

function sampleWriter(view, bitDepth, float) {
  if (float) return (o, v) => view.setFloat32(o, v, true);
  // The one place clipping is correct: a fixed-point format has no values
  // outside [-1, 1) to write, so anything hotter has to fold to full scale.
  const clamp = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);
  if (bitDepth === 16) {
    return (o, v) => {
      const s = clamp(v);
      view.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(s * 32767))), true);
    };
  }
  return (o, v) => {
    const s = clamp(v);
    const value = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388607)));
    const unsigned = value < 0 ? value + 0x1000000 : value;
    view.setUint8(o, unsigned & 0xff);
    view.setUint8(o + 1, (unsigned >> 8) & 0xff);
    view.setUint8(o + 2, (unsigned >> 16) & 0xff);
  };
}

/** Cheap format sniff — enough to route a file to the right decoder. */
export function looksLikeWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < 12) return false;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return fourcc(view, 0) === "RIFF" && fourcc(view, 8) === "WAVE";
}
