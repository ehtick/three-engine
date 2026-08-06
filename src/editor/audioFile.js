/**
 * Opening and saving audio documents — the bridge between the pure DSP core in
 * `src/editor/audio/` and the project's files.
 *
 * The shape is the texture editor's, deliberately. `Audio/impact.wav` stays
 * exactly what every `SoundComponent` already references; beside it sits
 * `Audio/impact.wav.aud`, hidden from the Assets grid, holding the track stack.
 * **A file with no sidecar opens as a single track**, so every sound already in
 * every project is editable with no migration step.
 *
 * ## What can be written, and what still can't
 *
 * WAV, always — it's our own codec. **Ogg/Opus wherever WebCodecs has an Opus
 * encoder**, which is every Chromium build the editor runs in; that is what
 * makes editing a Freesound import save in place instead of leaving a sibling
 * `.wav` behind. mp3, flac and m4a are still decode-only: the browser will
 * decode them and will not encode them, and shipping half an encoder would be
 * worse than an honest refusal, so those still route through `saveAsWav`.
 *
 * The capability test is deliberately *sync* (`opusEncodingAvailable`) because
 * `canWriteInPlace` decides the Save button's label during render, and an async
 * probe there would flicker between "Save" and "Save as WAV".
 */
import { decodeAudioBytes } from "./audio/decode.js";
import { encodeWav } from "./audio/wav.js";
import { encodeOpusOgg, opusEncodingAvailable, estimateOpusBytes } from "./audio/encodeOpus.js";
import { encodeAud, decodeAud, looksLikeAud } from "./audio/container.js";
import { createDocument, mixdown, documentFrameCount } from "./audio/auddoc.js";

const SIDECAR_EXT = ".aud";

/** Formats we can write, given what this environment can do. */
export function writableExtensions() {
  return opusEncodingAvailable() ? ["wav", "ogg"] : ["wav"];
}

const extOf = (path) => (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "").toLowerCase();
const baseName = (path) => path.replace(/\\/g, "/").split("/").pop() ?? path;
const stripExt = (name) => name.replace(/\.[a-z0-9]+$/i, "");

export const canWriteInPlace = (path) => writableExtensions().includes(extOf(path));
export const sidecarPath = (path) => `${path}${SIDECAR_EXT}`;

/**
 * Mixdown → the bytes of `format`. One place that knows how a document becomes
 * a file, so the panel's Save, the `audio.export` op and the size estimate
 * cannot disagree about what a given format produces.
 */
export async function encodeDocument(flat, { format = "wav", bitDepth = 24, bitrate = 96000, onProgress } = {}) {
  if (format === "ogg" || format === "opus") return encodeOpusOgg(flat, { bitrate, onProgress });
  if (format === "wav") return encodeWav(flat, { bitDepth });
  throw new Error(`Can't write ${format.toUpperCase()} — this editor writes WAV, and Ogg where the browser has an Opus encoder.`);
}

/**
 * What a format would cost on disk, before committing to it.
 *
 * Takes the shape rather than the samples (`{ frames, channels, sampleRate }`)
 * so the export menu can price four bitrates per render without mixing the
 * document down four times.
 */
export function estimateBytes({ frames, channels, sampleRate }, { format = "wav", bitDepth = 24, bitrate = 96000 } = {}) {
  if (format === "ogg" || format === "opus") return estimateOpusBytes(frames / sampleRate, bitrate);
  return 44 + frames * channels * (bitDepth === 32 ? 4 : bitDepth >> 3);
}

/** The same estimate straight from a document, without flattening it. */
export function estimateDocumentBytes(doc, options) {
  return estimateBytes(
    { frames: documentFrameCount(doc), channels: doc.channels, sampleRate: doc.sampleRate },
    options,
  );
}

async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(cmd, args);
}

async function readBytes(path) {
  const value = await invoke("read_binary_file", { path });
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new Error(`Could not read ${baseName(path)}`);
}

/**
 * Opens `path` as a document.
 *
 * The sidecar is the source of truth when it exists — it holds the unflattened
 * work. The audio file is still read even then, but only to notice it has been
 * replaced behind the editor's back: an artist who overwrote `impact.wav` from
 * a DAW expects to see their new file, not a stale track stack. Rather than
 * silently picking one, that mismatch is reported on the returned document so
 * the panel can ask.
 */
export async function openAudioDocument(path) {
  const fileBytes = await readBytes(path);
  const pcm = await decodeAudioBytes(fileBytes);

  let sidecar = null;
  try {
    const sidecarBytes = await readBytes(sidecarPath(path));
    if (looksLikeAud(sidecarBytes)) sidecar = decodeAud(sidecarBytes);
  } catch {
    // No sidecar is the normal case for every sound that was never edited here.
  }

  if (!sidecar || sidecar.tracks.length === 0) {
    return {
      doc: createDocument(pcm, { name: stripExt(baseName(path)) }),
      path,
      fromSidecar: false,
      fileChangedOutside: false,
      sourcePcm: pcm,
    };
  }

  // A cheap, decisive check: if the flattened stack no longer has the same
  // length as the file on disk, something else wrote that file.
  const flattened = mixdown(sidecar);
  const fileFrames = pcm.channels[0]?.length ?? 0;
  const stackFrames = flattened.channels[0]?.length ?? 0;
  const fileChangedOutside = Math.abs(fileFrames - stackFrames) > 2 || pcm.sampleRate !== sidecar.sampleRate;

  return { doc: sidecar, path, fromSidecar: true, fileChangedOutside, sourcePcm: pcm };
}

/**
 * Writes the sidecar, and the mixdown back to `path` when that format can be
 * written. Returns what it actually did, because "saved" and "saved the stack
 * but not the audio" are different outcomes and the panel must not report them
 * the same way.
 */
export async function saveAudioDocument(path, doc, { bitDepth = 24, bitrate = 96000, onProgress } = {}) {
  const sidecarBytes = encodeAud(doc);
  const { writeBinaryFile } = await import("./assetLoader.js");
  await writeBinaryFile(sidecarPath(path), sidecarBytes);

  const format = extOf(path);
  if (!canWriteInPlace(path)) {
    return {
      path,
      wroteAudio: false,
      wroteSidecar: true,
      reason:
        format === "ogg"
          ? "This browser has no Opus encoder, so the Ogg can't be rewritten — use Save As WAV."
          : `${format.toUpperCase()} files can't be written — only WAV, and Ogg where the browser has an Opus encoder. Use Save As WAV.`,
    };
  }

  const flat = mixdown(doc);
  // Encode BEFORE writing. An Opus encode can fail (an unsupported channel
  // count, a browser without the codec) and a failed encode that has already
  // truncated the file would have destroyed the only copy of the sound.
  const bytes = await encodeDocument(flat, { format, bitDepth, bitrate, onProgress });
  await writeBinaryFile(path, bytes);
  await refreshProject();
  return { path, wroteAudio: true, wroteSidecar: true, format, bytes: bytes.byteLength, sidecarBytes: sidecarBytes.byteLength };
}

/**
 * Mixes down to a new `.wav` beside the original and moves the document there.
 * The source file is left exactly as it was — an import from a sound library is
 * the only copy of that file, and overwriting it with a re-encode would be a
 * silent quality loss on top of a destructive one.
 */
export async function saveAsWav(path, doc, { bitDepth = 24 } = {}) {
  const target = `${path.replace(/\.[a-z0-9]+$/i, "")}.wav`;
  const flat = mixdown(doc);
  const { writeBinaryFile } = await import("./assetLoader.js");
  await writeBinaryFile(target, encodeWav(flat, { bitDepth }));
  await writeBinaryFile(sidecarPath(target), encodeAud(doc));
  await refreshProject();
  return { path: target, wroteAudio: true, wroteSidecar: true };
}

/** Mixdown as bytes, without touching disk. */
export function exportBytes(doc, { format = "wav", bitDepth = 24, bitrate = 96000 } = {}) {
  return encodeDocument(mixdown(doc), { format, bitDepth, bitrate });
}

/**
 * Mixes down to `targetPath`, in whatever format that path's extension names.
 *
 * This is the honest-about-size half of the design: audio is usually the
 * largest thing in a web build and nothing else in the editor says so, which is
 * why every result here reports the byte count and how it compares with the
 * source. Writes the sidecar next to the *target* so the exported file is
 * itself editable.
 */
export async function exportDocument(doc, targetPath, { bitDepth = 24, bitrate = 96000, onProgress } = {}) {
  const format = extOf(targetPath);
  const flat = mixdown(doc);
  const bytes = await encodeDocument(flat, { format, bitDepth, bitrate, onProgress });
  const { writeBinaryFile } = await import("./assetLoader.js");
  await writeBinaryFile(targetPath, bytes);
  await writeBinaryFile(sidecarPath(targetPath), encodeAud(doc));
  await refreshProject();
  return {
    path: targetPath,
    format,
    bytes: bytes.byteLength,
    durationSeconds: (flat.channels[0]?.length ?? 0) / flat.sampleRate,
    channels: flat.channels.length,
    sampleRate: flat.sampleRate,
  };
}

async function refreshProject() {
  const { useProjectStore } = await import("./store/projectStore.js");
  await useProjectStore.getState().refresh();
}

/** Creates an empty document backed by a new file in the project. */
export async function createAudioFile(directory, name, { sampleRate = 48000, channels = 1, seconds = 1 } = {}) {
  const { createPcm } = await import("./audio/pcm.js");
  const pcm = createPcm(channels, Math.round(seconds * sampleRate), sampleRate);
  const target = `${directory}/${name.replace(/\.[a-z0-9]+$/i, "")}.wav`;
  const { writeBinaryFile } = await import("./assetLoader.js");
  await writeBinaryFile(target, encodeWav(pcm, { bitDepth: 24 }));
  await refreshProject();
  return target;
}
