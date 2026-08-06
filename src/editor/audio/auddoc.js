/**
 * The audio document: a stack of tracks over one timeline, mixed down to the
 * file that is actually the asset.
 *
 * The shape mirrors the texture editor's layer stack on purpose. A track is to
 * a sound what a layer is to an image — the way you build an impact out of a
 * thud, a crack and a tail and can still go back and change the tail. Mixdown
 * is the flatten.
 *
 * One document invariant carries everything: **every track's PCM is already at
 * the document's sample rate.** Conversion happens once, when a track is added
 * (`makeTrack`), rather than on every mixdown. Mixing is then a loop over
 * `Float32Array`s with no per-sample branching, which is what makes scrubbing a
 * multitrack document feel immediate; deferring it would mean resampling
 * minutes of audio on every playhead move.
 */
import {
  createPcm,
  clonePcm,
  frameCount,
  channelCount,
  mixInto,
  panGains,
  toChannels,
} from "./pcm.js";
import { resample } from "./resample.js";

let nextTrackId = 1;
const trackId = () => `t${nextTrackId++}`;

export const TRACK_DEFAULTS = {
  gain: 1,
  pan: 0,
  muted: false,
  solo: false,
  start: 0, // frames from the document's zero
};

/**
 * A track from raw PCM, converted to the document's rate if it differs.
 * `name` is what the header stores; the UI shows it in the track head.
 */
export function makeTrack(pcm, { name = "Track", sampleRate, ...props } = {}) {
  const targetRate = sampleRate ?? pcm.sampleRate;
  const converted = pcm.sampleRate === targetRate ? clonePcm(pcm) : resample(pcm, targetRate);
  return { id: trackId(), name, pcm: converted, ...TRACK_DEFAULTS, ...props };
}

/**
 * A new document. The document's channel count is the widest track it holds —
 * a mono document that later receives a stereo track would otherwise silently
 * fold it down, and "why did my stereo ambience go mono" is not a question the
 * tool should make anyone ask.
 */
export function createDocument(pcm, { name = "Audio", channels } = {}) {
  const source = pcm ?? createPcm(1, 0, 48000);
  const track = makeTrack(source, { name });
  return {
    version: 1,
    sampleRate: source.sampleRate,
    channels: channels ?? Math.max(1, channelCount(source)),
    tracks: [track],
  };
}

export const documentFrameCount = (doc) =>
  doc.tracks.reduce((max, track) => Math.max(max, track.start + frameCount(track.pcm)), 0);

export const documentDuration = (doc) => documentFrameCount(doc) / doc.sampleRate;

export function addTrack(doc, pcm, options = {}) {
  const track = makeTrack(pcm, { sampleRate: doc.sampleRate, ...options });
  doc.tracks.push(track);
  // A stereo track arriving in a mono document widens the document rather than
  // being folded down. See createDocument.
  doc.channels = Math.max(doc.channels, channelCount(track.pcm));
  return track;
}

export function removeTrack(doc, id) {
  const index = doc.tracks.findIndex((t) => t.id === id);
  if (index === -1) return null;
  return doc.tracks.splice(index, 1)[0];
}

export const findTrack = (doc, id) => doc.tracks.find((t) => t.id === id) ?? null;

/**
 * Which tracks are audible. Solo is exclusive-by-presence: if *any* track is
 * soloed, only soloed tracks play, which is what every DAW does and what a
 * mute-only implementation gets subtly wrong.
 */
export function audibleTracks(doc) {
  const soloed = doc.tracks.filter((t) => t.solo && !t.muted);
  if (soloed.length) return soloed;
  return doc.tracks.filter((t) => !t.muted);
}

/**
 * Flattens the stack to one buffer — what gets written to the asset file, and
 * what playback and the waveform display read.
 *
 * Nothing is clamped here. A mix that sums past 0 dBFS is over, and the honest
 * response is to show it as over (the meter turns red, Normalise fixes it),
 * not to clip it silently inside the mixer and leave the user wondering why
 * their layered impact sounds crunchy.
 */
export function mixdown(doc) {
  const frames = documentFrameCount(doc);
  const out = createPcm(doc.channels, frames, doc.sampleRate);
  if (frames === 0) return out;

  for (const track of audibleTracks(doc)) {
    const source = toChannels(track.pcm, doc.channels);
    const [left, right] = panGains(track.pan ?? 0);
    for (let c = 0; c < doc.channels; c++) {
      // Pan is a stereo-field concept: it only means something when there are
      // exactly two output channels to balance between.
      const panGain = doc.channels === 2 ? (c === 0 ? left : right) : 1;
      // Constant-power pan is normalised so centre is 1/√2 per side; without
      // this compensation a centred track drops ~3 dB against an unpanned mix.
      const compensation = doc.channels === 2 ? Math.SQRT2 : 1;
      mixInto(out.channels[c], source.channels[c], track.start, (track.gain ?? 1) * panGain * compensation);
    }
  }
  return out;
}

/** Replaces one track's samples, keeping its identity and mix settings. */
export function setTrackPcm(doc, id, pcm) {
  const track = findTrack(doc, id);
  if (!track) throw new Error(`No track "${id}" in this document`);
  track.pcm = pcm.sampleRate === doc.sampleRate ? pcm : resample(pcm, doc.sampleRate);
  doc.channels = Math.max(doc.channels, channelCount(track.pcm));
  return track;
}

/**
 * Recomputes the document's channel count from the tracks it actually holds.
 *
 * `addTrack` and `setTrackPcm` only ever *widen* the document, deliberately: a
 * stereo track arriving in a mono document must not be folded down. That leaves
 * one case they cannot handle — narrowing. Mono-izing the only track of a
 * stereo document leaves `channels: 2`, so the mixdown writes two identical
 * channels and the file stays stereo, which defeats the entire point of the
 * operation (a stereo file does not spatialise). Anything that can reduce a
 * track's channel count calls this afterwards.
 */
export function reconcileChannels(doc) {
  doc.channels = Math.max(1, ...doc.tracks.map((track) => channelCount(track.pcm)));
  return doc.channels;
}

/** Shallow-clones the document, sharing track PCM. For history snapshots of mix state. */
export function cloneDocumentShallow(doc) {
  return { ...doc, tracks: doc.tracks.map((t) => ({ ...t })) };
}

/** Frame index ↔ seconds, in one place so rounding is consistent everywhere. */
export const secondsToFrames = (doc, seconds) => Math.round(seconds * doc.sampleRate);
export const framesToSeconds = (doc, frames) => frames / doc.sampleRate;
