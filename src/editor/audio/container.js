/**
 * The `.aud` sidecar: a binary container holding a document's track stack.
 *
 *     magic "AUDDOC1" | u32 headerLen | headerLen bytes of JSON | wav | wav | …
 *
 * Same shape as the texture editor's `.tex`, for the same reasons. Base64
 * inside JSON was the obvious alternative and is a bad one: it inflates 33%,
 * and a two-minute stereo document with four tracks becomes a ~100 MB *string*
 * that has to be parsed, held twice, and pushed through Tauri's IPC as text.
 *
 * The payloads are ordinary 32-bit float WAVs, concatenated. Float rather than
 * 16-bit because a document that requantised every time it was saved would
 * audibly degrade across a working session — and because anything that can read
 * a WAV can recover the tracks from this file with a few lines of script if the
 * editor ever refuses to open it.
 *
 * The header carries mix state only. It never carries sample data, so it stays
 * small enough to read and print while debugging.
 */
import { encodeWav, decodeWav } from "./wav.js";
import { makeTrack } from "./auddoc.js";

const MAGIC = "AUDDOC1";
const HEADER_OFFSET = MAGIC.length + 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Document → bytes. */
export function encodeAud(doc) {
  const payloads = doc.tracks.map((track) => encodeWav(track.pcm, { bitDepth: 32 }));

  let offset = 0;
  const header = {
    version: 1,
    sampleRate: doc.sampleRate,
    channels: doc.channels,
    tracks: doc.tracks.map((track, i) => {
      const entry = {
        name: track.name,
        offset,
        length: payloads[i].byteLength,
        gain: track.gain ?? 1,
        pan: track.pan ?? 0,
        muted: !!track.muted,
        solo: !!track.solo,
        start: track.start ?? 0,
      };
      offset += payloads[i].byteLength;
      return entry;
    }),
  };

  const headerBytes = encoder.encode(JSON.stringify(header));
  const total = HEADER_OFFSET + headerBytes.byteLength + offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
  view.setUint32(MAGIC.length, headerBytes.byteLength, true);
  out.set(headerBytes, HEADER_OFFSET);

  const base = HEADER_OFFSET + headerBytes.byteLength;
  for (let i = 0; i < payloads.length; i++) out.set(payloads[i], base + header.tracks[i].offset);
  return out;
}

/** True for bytes that begin with the container magic. */
export function looksLikeAud(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < HEADER_OFFSET) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (u8[i] !== MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Bytes → document. A track whose payload fails to decode is dropped with a
 * warning rather than failing the whole open: losing one track of a four-track
 * document is recoverable, losing the session isn't.
 */
export function decodeAud(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!looksLikeAud(u8)) throw new Error("Not an .aud document (bad magic)");

  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const headerLength = view.getUint32(MAGIC.length, true);
  const base = HEADER_OFFSET + headerLength;
  if (base > u8.byteLength) throw new Error(".aud document is truncated (header runs past the end of the file)");

  const header = JSON.parse(decoder.decode(u8.subarray(HEADER_OFFSET, base)));
  const tracks = [];
  for (const entry of header.tracks ?? []) {
    const from = base + entry.offset;
    const to = from + entry.length;
    if (to > u8.byteLength) {
      console.warn(`.aud: track "${entry.name}" runs past the end of the file — skipped`);
      continue;
    }
    try {
      const pcm = decodeWav(u8.subarray(from, to));
      tracks.push(
        makeTrack(pcm, {
          name: entry.name ?? "Track",
          sampleRate: header.sampleRate,
          gain: entry.gain ?? 1,
          pan: entry.pan ?? 0,
          muted: !!entry.muted,
          solo: !!entry.solo,
          start: entry.start ?? 0,
        }),
      );
    } catch (err) {
      console.warn(`.aud: track "${entry.name}" failed to decode (${err.message}) — skipped`);
    }
  }

  return {
    version: header.version ?? 1,
    sampleRate: header.sampleRate,
    channels: header.channels ?? Math.max(1, ...tracks.map((t) => t.pcm.channels.length)),
    tracks,
  };
}
