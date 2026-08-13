/**
 * Audio operations: searching the free sound libraries, importing from them,
 * and auditing what the project owes attribution to.
 *
 * These are the same functions the Audio Library panel calls — the panel is a
 * view over `audioLibrary.js` and so is this, rather than the ops re-deriving
 * their own search/import path. That's the property that keeps "what a person
 * can do here" and "what an agent can do here" from drifting apart.
 *
 * The searches hit a rate-limited third-party API (Freesound: 60/min, 2000/day
 * shared across the whole editor), so every op here is one request. Nothing
 * pages ahead on the caller's behalf.
 */
import { defineOp } from "../registry.js";
import { useModulesStore } from "../../modules.js";
import {
  PROVIDERS,
  search,
  getSound,
  importSound,
  readCredits,
  getSavedToken,
} from "../../audioLibrary.js";

/**
 * The module gate is enforced here as well as in the panel. An op that quietly
 * worked while the module was off would make "enabled" meaningless — the
 * project's module list is a statement about what the project uses, and an
 * agent silently importing through a disabled module breaks that.
 */
function requireModule() {
  if (!useModulesStore.getState().enabled.includes("audio-library")) {
    throw new Error('The "audio-library" module is not enabled for this project. Enable it in the Modules panel first.');
  }
}

defineOp({
  name: "audio.library.status",
  readOnly: true,
  description:
    "Which audio libraries can be searched right now: whether the module is on, and whether each provider's credentials are in place. Call this before searching to find out why a search would fail.",
  params: {},
  run() {
    const enabled = useModulesStore.getState().enabled.includes("audio-library");
    const hasFreesoundKey = !!getSavedToken();
    return {
      moduleEnabled: enabled,
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        needsKey: p.needsKey,
        ready: enabled && (!p.needsKey || hasFreesoundKey),
        note:
          p.needsKey && !hasFreesoundKey
            ? "No Freesound API key saved. A free key from https://freesound.org/apiv2/apply/ goes in the Modules panel."
            : null,
      })),
    };
  },
});

defineOp({
  name: "audio.library.search",
  readOnly: true,
  description:
    "Search free sound effects and ambiences. `freesound` is the large designed-SFX library and needs an API key; `commons` (Wikimedia) and `archive` (Internet Archive) need none. Commons is strongest on field recordings; an Archive result is a whole item — often a pack of many sounds — whose licence is declared by the uploader rather than verified. Returns one page of results; each carries the id needed by audio.library.import.",
  params: {
    query: { type: "string", required: true, description: "What to search for, e.g. 'gravel footsteps' or 'forest at night'." },
    provider: { type: "string", default: "freesound", description: "freesound | commons | archive." },
    kind: { type: "string", default: "sfx", description: "'sfx' (under 15s), 'ambience' (15s and up), or 'any'. Ignored by the archive provider, whose search index carries no durations." },
    sort: { type: "string", default: "relevance", description: "relevance | downloads | rating | newest | shortest | longest. Freesound only." },
    cc0Only: { type: "boolean", default: false, description: "Only public-domain sounds that need no credit." },
    monoOnly: { type: "boolean", default: false, description: "Only mono files. Stereo files do not spatialise on a 3D sound. Freesound only." },
    page: { type: "number", default: 1, description: "1-based page number." },
  },
  async run(args) {
    requireModule();
    const { results, total, hasMore } = await search(args);
    return {
      total,
      hasMore,
      page: args.page ?? 1,
      // Trimmed deliberately: the full result carries preview/waveform/download
      // URLs that are of no use to a caller that imports by id, and thirty of
      // them would be most of a tool response spent on strings nobody reads.
      results: results.map((r) => ({
        id: r.id,
        provider: r.provider,
        name: r.name,
        author: r.author,
        durationSeconds: Math.round(r.duration * 100) / 100,
        channels: r.channels,
        sampleRate: r.sampleRate,
        license: r.license.name,
        attributionRequired: r.license.attribution,
        commercialUseAllowed: r.license.commercial,
        tags: r.tags.slice(0, 12),
        sourceUrl: r.pageUrl,
      })),
    };
  },
});

defineOp({
  name: "audio.library.import",
  description:
    "Download into <project>/Audio/<Provider>/ and record the licence in Audio/CREDITS.md. Takes the provider and id from audio.library.search. Freesound and Commons import one sound; an Archive item imports as a folder of every audio file it contains (deduplicated across the Archive's derived formats, capped at 200 with the overflow reported).",
  params: {
    id: { type: "any", required: true, description: "The id from a search result: a number for Freesound, a page id for Commons, an identifier string for the Archive." },
    provider: { type: "string", default: "freesound", description: "freesound | commons | archive." },
  },
  async run({ id, provider = "freesound" }) {
    requireModule();
    const item = await getSound(provider, id);
    const result = await importSound(item);
    return {
      path: result.path.replaceAll("\\", "/"),
      name: result.name,
      bytes: result.bytes,
      // An Archive item imports as a folder of many files; the others are one.
      ...(result.files ? { files: result.files, failed: result.failed, skippedPastCap: result.skipped } : {}),
      license: item.license.name,
      attributionRequired: item.license.attribution,
      commercialUseAllowed: item.license.commercial,
      // Naming the next step, because the shape is not guessable: a Sound
      // component holds a LIST of entries and the file lives on
      // `entries[].audioAsset` — not on a `path`, `clip` or `src` prop.
      next:
        "component.add — type 'sound' on an entity, props "
        + "{ entries: [{ audioAsset: <path>, playback: '2D'|'3D', loop: 'no'|'yes' }] }.",
    };
  },
});

// ===========================================================================
// Audio editor
//
// These act on files, not on the panel's open session, so an agent can edit a
// sound without the Audio Editor tab being open — and they go through the same
// `audioFile.js` + `src/editor/audio/` core the panel does, so there is one
// implementation of what an edit means rather than an agent-only shortcut.
//
// The tradeoff, stated because it's the one thing that can surprise: if the
// panel has the same file open with unsaved changes, saving from either side
// wins over the other. The panel reports a mismatch on reopen rather than
// silently picking, which is the honest half of that bargain.
// ===========================================================================

function requireEditorModule() {
  if (!useModulesStore.getState().enabled.includes("audio-editor")) {
    throw new Error('The "audio-editor" module is not enabled for this project. Enable it in the Modules panel first.');
  }
}

const seconds = (frames, rate) => Math.round((frames / rate) * 1000) / 1000;

async function audioCore() {
  return {
    file: await import("../../audioFile.js"),
    doc: await import("../../audio/auddoc.js"),
    edits: await import("../../audio/edits.js"),
    pcm: await import("../../audio/pcm.js"),
    decode: await import("../../audio/decode.js"),
  };
}

/** Frame range from a seconds range, defaulting to the whole track. */
function frameRange({ startSeconds, endSeconds }, track, rate, pcmMod) {
  const total = pcmMod.frameCount(track.pcm);
  const from = startSeconds == null ? 0 : Math.round(startSeconds * rate);
  const to = endSeconds == null ? total : Math.round(endSeconds * rate);
  return [from, to];
}

defineOp({
  name: "audio.info",
  readOnly: true,
  description:
    "Read an audio file's properties: duration, sample rate, channels, peak level, and whether the Audio Editor has a saved track stack beside it. Works on wav, mp3, ogg and flac.",
  params: { path: { type: "string", required: true, description: "Absolute path to the audio file." } },
  async run({ path }) {
    requireEditorModule();
    const { file, doc: docMod, pcm } = await audioCore();
    const opened = await file.openAudioDocument(path);
    const flat = docMod.mixdown(opened.doc);
    const level = pcm.peak(flat);
    return {
      path: path.replaceAll("\\", "/"),
      sampleRate: opened.doc.sampleRate,
      channels: opened.doc.channels,
      durationSeconds: seconds(pcm.frameCount(flat), opened.doc.sampleRate),
      peakDb: level > 0 ? Math.round(pcm.gainToDb(level) * 10) / 10 : null,
      clipping: level > 1,
      hasTrackStack: opened.fromSidecar,
      trackCount: opened.doc.tracks.length,
      writableInPlace: file.canWriteInPlace(path),
      fileChangedOutsideEditor: opened.fileChangedOutside,
    };
  },
});

defineOp({
  name: "audio.tracks",
  readOnly: true,
  description: "List the tracks in a sound's saved stack, with their mix settings. A file never edited here reports one track.",
  params: { path: { type: "string", required: true } },
  async run({ path }) {
    requireEditorModule();
    const { file, pcm } = await audioCore();
    const { doc: document_ } = await file.openAudioDocument(path);
    return {
      sampleRate: document_.sampleRate,
      tracks: document_.tracks.map((t, index) => ({
        index,
        name: t.name,
        durationSeconds: seconds(pcm.frameCount(t.pcm), document_.sampleRate),
        startSeconds: seconds(t.start, document_.sampleRate),
        gain: t.gain,
        pan: t.pan,
        muted: t.muted,
        solo: t.solo,
        peakDb: Math.round(pcm.gainToDb(pcm.peak(t.pcm)) * 10) / 10,
      })),
    };
  },
});

defineOp({
  name: "audio.edit",
  description:
    "Apply one structural edit to a track and save. Ranges are in seconds and default to the whole track. Edges snap to the nearest zero crossing unless snapToZeroCrossing is false — cutting elsewhere leaves a click.",
  params: {
    path: { type: "string", required: true },
    operation: {
      type: "string",
      required: true,
      description: "delete | silence | trim | duplicate | reverse | trimSilence | insertSilence",
    },
    startSeconds: { type: "number", description: "Range start. Omit for the start of the track." },
    endSeconds: { type: "number", description: "Range end. Omit for the end of the track." },
    track: { type: "number", default: 0, description: "Track index from audio.tracks." },
    snapToZeroCrossing: { type: "boolean", default: true },
    seconds: { type: "number", description: "For insertSilence: how much silence to insert at startSeconds." },
    thresholdDb: { type: "number", default: -60, description: "For trimSilence: what counts as silence." },
  },
  async run(args) {
    requireEditorModule();
    const { file, doc: docMod, edits, pcm } = await audioCore();
    const { doc: document_ } = await file.openAudioDocument(args.path);
    const track = document_.tracks[args.track ?? 0];
    if (!track) throw new Error(`This sound has no track ${args.track ?? 0} (it has ${document_.tracks.length}).`);

    const rate = document_.sampleRate;
    let [from, to] = frameRange(args, track, rate, pcm);
    if (args.snapToZeroCrossing !== false) [from, to] = edits.snapRange(track.pcm, from, to);

    const before = pcm.frameCount(track.pcm);
    const operations = {
      delete: () => edits.deleteRange(track.pcm, from, to),
      silence: () => edits.silenceRange(track.pcm, from, to),
      trim: () => edits.trimToRange(track.pcm, from, to),
      duplicate: () => edits.duplicateRange(track.pcm, from, to),
      reverse: () => edits.reverseRange(track.pcm, from, to),
      trimSilence: () => edits.trimSilence(track.pcm, { thresholdDb: args.thresholdDb ?? -60 }),
      insertSilence: () => edits.insertSilence(track.pcm, from, args.seconds ?? 0),
    };
    const apply = operations[args.operation];
    if (!apply) throw new Error(`Unknown operation "${args.operation}". Try: ${Object.keys(operations).join(", ")}.`);

    docMod.setTrackPcm(document_, track.id, apply());
    const result = await save(file, args.path, document_);
    return {
      ...result,
      operation: args.operation,
      track: args.track ?? 0,
      durationBefore: seconds(before, rate),
      durationAfter: seconds(pcm.frameCount(track.pcm), rate),
    };
  },
});

defineOp({
  name: "audio.addTrack",
  description:
    "Layer another sound onto this one as a new track — how a designed effect is built (a thud, a crack, a tail). The source is resampled to the document's rate automatically.",
  params: {
    path: { type: "string", required: true, description: "The document to add to." },
    sourcePath: { type: "string", required: true, description: "The audio file to layer in." },
    startSeconds: { type: "number", default: 0, description: "Where the new track begins on the timeline." },
    gain: { type: "number", default: 1 },
    pan: { type: "number", default: 0, description: "-1 hard left to +1 hard right." },
  },
  async run({ path, sourcePath, startSeconds = 0, gain = 1, pan = 0 }) {
    requireEditorModule();
    const { file, doc: docMod, decode } = await audioCore();
    const { doc: document_ } = await file.openAudioDocument(path);

    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke("read_binary_file", { path: sourcePath });
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);
    const sourcePcm = await decode.decodeAudioBytes(bytes);

    docMod.addTrack(document_, sourcePcm, {
      name: sourcePath.replaceAll("\\", "/").split("/").pop(),
      start: Math.round(startSeconds * document_.sampleRate),
      gain,
      pan,
    });
    const result = await save(file, path, document_);
    return { ...result, trackCount: document_.tracks.length };
  },
});

defineOp({
  name: "audio.setTrack",
  description: "Change one track's mix settings (gain, pan, mute, solo, start, name) and save.",
  params: {
    path: { type: "string", required: true },
    track: { type: "number", required: true, description: "Track index from audio.tracks." },
    gain: { type: "number" },
    pan: { type: "number", description: "-1 hard left to +1 hard right." },
    muted: { type: "boolean" },
    solo: { type: "boolean" },
    startSeconds: { type: "number" },
    name: { type: "string" },
  },
  async run(args) {
    requireEditorModule();
    const { file } = await audioCore();
    const { doc: document_ } = await file.openAudioDocument(args.path);
    const track = document_.tracks[args.track];
    if (!track) throw new Error(`This sound has no track ${args.track} (it has ${document_.tracks.length}).`);

    for (const key of ["gain", "pan", "muted", "solo", "name"]) {
      if (args[key] !== undefined) track[key] = args[key];
    }
    if (args.startSeconds !== undefined) track.start = Math.round(args.startSeconds * document_.sampleRate);
    return save(file, args.path, document_);
  },
});

defineOp({
  name: "audio.removeTrack",
  description: "Remove a track from the stack and save. A document always keeps at least one track.",
  params: {
    path: { type: "string", required: true },
    track: { type: "number", required: true },
  },
  async run({ path, track }) {
    requireEditorModule();
    const { file, doc: docMod } = await audioCore();
    const { doc: document_ } = await file.openAudioDocument(path);
    if (document_.tracks.length <= 1) throw new Error("A document must keep at least one track.");
    const target = document_.tracks[track];
    if (!target) throw new Error(`This sound has no track ${track} (it has ${document_.tracks.length}).`);
    docMod.removeTrack(document_, target.id);
    const result = await save(file, path, document_);
    return { ...result, trackCount: document_.tracks.length };
  },
});

defineOp({
  name: "audio.effects",
  readOnly: true,
  description:
    "List every processing effect the Audio Editor can apply, with each one's parameters, ranges, units and defaults. Call this before audio.process to find out what a parameter is called and what values it accepts.",
  params: {},
  async run() {
    requireEditorModule();
    const { effectGroups } = await import("../../audio/effects.js");
    return {
      groups: effectGroups().map((group) => ({
        name: group.name,
        effects: group.items.map((effect) => ({
          id: effect.id,
          label: effect.label,
          description: effect.description ?? null,
          changesLength: !!effect.changesLength,
          changesChannelCount: !!effect.changesChannels,
          appliesToWholeBufferOnly: !!effect.wholeBufferOnly,
          needsNoiseProfile: !!effect.needsNoiseProfile,
          params: Object.fromEntries(
            Object.entries(effect.params).map(([key, d]) => [
              key,
              d.type === "number"
                ? { type: "number", default: d.default, min: d.min, max: d.max, unit: d.unit || null, hint: d.hint ?? null }
                : d.type === "enum"
                  ? { type: "enum", default: d.default, options: d.options }
                  : { type: "boolean", default: d.default, hint: d.hint ?? null },
            ]),
          ),
        })),
      })),
    };
  },
});

defineOp({
  name: "audio.process",
  description:
    "Apply one processing effect to a track and save. Effect ids and parameter names come from audio.effects; out-of-range values are clamped rather than rejected. Ranges are in seconds and default to the whole track — note that time-stretch, pitch, resample, delay and reverb always process the whole track regardless.",
  params: {
    path: { type: "string", required: true },
    effect: { type: "string", required: true, description: "An effect id from audio.effects, e.g. 'normalize', 'compressor', 'pitch'." },
    params: { type: "object", description: "Effect parameters. Anything omitted uses that effect's default." },
    startSeconds: { type: "number" },
    endSeconds: { type: "number" },
    track: { type: "number", default: 0 },
    noiseProfileFromSeconds: { type: "number", description: "For 'denoise': start of a noise-ONLY region to build the profile from." },
    noiseProfileToSeconds: { type: "number", description: "For 'denoise': end of that noise-only region." },
  },
  async run(args) {
    requireEditorModule();
    const { file, doc: docMod, pcm } = await audioCore();
    const { applyEffect, EFFECTS } = await import("../../audio/effects.js");
    const { doc: document_ } = await file.openAudioDocument(args.path);
    const track = document_.tracks[args.track ?? 0];
    if (!track) throw new Error(`This sound has no track ${args.track ?? 0} (it has ${document_.tracks.length}).`);

    const rate = document_.sampleRate;
    const range = frameRange(args, track, rate, pcm);

    // The profile is captured from the same file, from a region the caller
    // names — there is nowhere else it could sensibly come from headlessly.
    let context;
    if (EFFECTS[args.effect]?.needsNoiseProfile) {
      if (args.noiseProfileFromSeconds == null || args.noiseProfileToSeconds == null) {
        throw new Error(
          "Noise reduction needs noiseProfileFromSeconds and noiseProfileToSeconds marking a region that contains ONLY the noise you want removed.",
        );
      }
      const { captureNoiseProfile } = await import("../../audio/denoise.js");
      context = {
        noiseProfile: captureNoiseProfile(
          track.pcm,
          Math.round(args.noiseProfileFromSeconds * rate),
          Math.round(args.noiseProfileToSeconds * rate),
        ),
      };
    }

    const before = { frames: pcm.frameCount(track.pcm), peak: pcm.peak(track.pcm), channels: document_.channels };
    docMod.setTrackPcm(document_, track.id, applyEffect(args.effect, track.pcm, args.params ?? {}, range, context));
    // setTrackPcm only ever widens the document. An effect that NARROWS a
    // track (mono-ize) would otherwise leave the mixdown writing two identical
    // channels — the file would still be stereo and still wouldn't spatialise.
    if (EFFECTS[args.effect]?.changesChannels) docMod.reconcileChannels(document_);
    const after = { frames: pcm.frameCount(track.pcm), peak: pcm.peak(track.pcm), channels: document_.channels };

    const result = await save(file, args.path, document_);
    return {
      ...result,
      effect: args.effect,
      track: args.track ?? 0,
      durationBefore: seconds(before.frames, rate),
      durationAfter: seconds(after.frames, rate),
      peakDbBefore: before.peak > 0 ? Math.round(pcm.gainToDb(before.peak) * 10) / 10 : null,
      peakDbAfter: after.peak > 0 ? Math.round(pcm.gainToDb(after.peak) * 10) / 10 : null,
      ...(before.channels !== after.channels ? { channelsBefore: before.channels, channelsAfter: after.channels } : {}),
      // Worth surfacing: a normalise-to-0 followed by anything additive, or an
      // RMS match, can leave the track over full scale. Silently clipping on
      // export is the failure this exists to pre-empt.
      clipping: after.peak > 1,
    };
  },
});

defineOp({
  name: "audio.generate",
  description:
    "Create a new sound file from a generator: silence, a tone, a frequency sweep, or noise. Sound-design primitives — filtered noise is wind, a falling sweep is a laser. Noise and sweeps are seeded, so the same parameters always give the same file.",
  params: {
    path: { type: "string", required: true, description: "Where to write the .wav." },
    generator: { type: "string", required: true, description: "silence | tone | chirp | noise" },
    seconds: { type: "number", default: 1 },
    sampleRate: { type: "number", default: 48000 },
    channels: { type: "number", default: 1 },
    amplitude: { type: "number", default: 0.5 },
    frequency: { type: "number", default: 440, description: "For 'tone'." },
    wave: { type: "string", default: "sine", description: "For 'tone': sine | square | saw | triangle." },
    fromHz: { type: "number", default: 200, description: "For 'chirp'." },
    toHz: { type: "number", default: 2000, description: "For 'chirp'." },
    colour: { type: "string", default: "white", description: "For 'noise': white | pink | brown." },
    seed: { type: "number", default: 1 },
  },
  async run(args) {
    requireEditorModule();
    const gen = await import("../../audio/generate.js");
    const options = {
      sampleRate: Math.round(args.sampleRate ?? 48000),
      channels: Math.max(1, Math.round(args.channels ?? 1)),
      amplitude: args.amplitude ?? 0.5,
      seed: args.seed ?? 1,
    };
    const secs = Math.max(0, args.seconds ?? 1);
    const generators = {
      silence: () => gen.silence(secs, options),
      tone: () => gen.tone(args.frequency ?? 440, secs, { ...options, wave: args.wave ?? "sine" }),
      chirp: () => gen.chirp(args.fromHz ?? 200, args.toHz ?? 2000, secs, options),
      noise: () => gen.noise(secs, { ...options, colour: args.colour ?? "white" }),
    };
    const make = generators[args.generator];
    if (!make) throw new Error(`Unknown generator "${args.generator}". Try: ${Object.keys(generators).join(", ")}.`);

    const pcmOut = make();
    const { encodeWav } = await import("../../audio/wav.js");
    const { writeBinaryFile } = await import("../../assetLoader.js");
    const target = args.path.replace(/\.[a-z0-9]+$/i, "") + ".wav";
    await writeBinaryFile(target, encodeWav(pcmOut, { bitDepth: 24 }));
    const { useProjectStore } = await import("../../store/projectStore.js");
    await useProjectStore.getState().refresh();

    return {
      path: target.replaceAll("\\", "/"),
      generator: args.generator,
      durationSeconds: secs,
      sampleRate: options.sampleRate,
      channels: options.channels,
    };
  },
});

defineOp({
  name: "audio.loop",
  description:
    "Turn a sound into a seamless loop — the thing every ambient bed in a game needs. Give loopStartSeconds and loopEndSeconds to loop a known region, or omit them and the best loop points are found by searching for where the sound most resembles its own beginning. The wrap is click-free by construction: the crossfade uses the audio that really followed the loop end, so the last sample and the first are adjacent samples of the original recording. Set analyzeOnly to see the candidates without changing anything.",
  params: {
    path: { type: "string", required: true },
    track: { type: "number", default: 0 },
    analyzeOnly: { type: "boolean", default: false, description: "Report candidate loop points and their scores; write nothing." },
    loopStartSeconds: { type: "number", description: "Where the loop begins. Omit to search." },
    loopEndSeconds: { type: "number", description: "Where it ends. Omit to search." },
    crossfadeSeconds: { type: "number", default: 0.25, description: "How much material the seam is smoothed over." },
    minSeconds: { type: "number", default: 1, description: "Search only: shortest acceptable loop." },
    maxSeconds: { type: "number", description: "Search only: longest acceptable loop. Omit for no limit." },
    searchStartSeconds: { type: "number", default: 0, description: "Search only: where the loop starts, i.e. how much intro to skip." },
  },
  async run(args) {
    requireEditorModule();
    const { file, doc: docMod, pcm } = await audioCore();
    const loop = await import("../../audio/loop.js");
    const { doc: document_ } = await file.openAudioDocument(args.path);
    const track = document_.tracks[args.track ?? 0];
    if (!track) throw new Error(`This sound has no track ${args.track ?? 0} (it has ${document_.tracks.length}).`);

    const rate = document_.sampleRate;
    const crossfadeSeconds = args.crossfadeSeconds ?? 0.25;

    if (args.analyzeOnly) {
      const analysis = loop.analyzeLoop(track.pcm, {
        minSeconds: args.minSeconds ?? 1,
        maxSeconds: args.maxSeconds ?? null,
        crossfadeSeconds,
        searchStartSeconds: args.searchStartSeconds ?? 0,
      });
      return {
        path: args.path.replaceAll("\\", "/"),
        currentSeam: loop.seamAnalysis(track.pcm),
        // `match` is how alike the two moments are, `levelMatch` how alike
        // their loudness is; the score is their product. Both are reported
        // because "matches well but is 2 dB louder" is a fixable problem and
        // "doesn't match at all" is not.
        candidates: analysis.candidates.map((c) => ({
          loopStartSeconds: seconds(c.loopStart, rate),
          loopEndSeconds: seconds(c.loopEnd, rate),
          loopLengthSeconds: Math.round(c.seconds * 1000) / 1000,
          score: c.score,
          match: c.match,
          levelMatch: c.levelMatch,
        })),
        ...(analysis.reason ? { note: analysis.reason } : {}),
      };
    }

    const explicit = args.loopStartSeconds != null && args.loopEndSeconds != null;
    const result = loop.autoLoop(track.pcm, {
      loopStart: explicit ? Math.round(args.loopStartSeconds * rate) : null,
      loopEnd: explicit ? Math.round(args.loopEndSeconds * rate) : null,
      crossfadeSeconds,
      minSeconds: args.minSeconds ?? 1,
      maxSeconds: args.maxSeconds ?? null,
      searchStartSeconds: args.searchStartSeconds ?? 0,
    });

    const before = pcm.frameCount(track.pcm);
    docMod.setTrackPcm(document_, track.id, result.pcm);
    const saved = await save(file, args.path, document_);
    return {
      ...saved,
      loopStartSeconds: seconds(result.loopStart, rate),
      loopEndSeconds: seconds(result.loopEnd, rate),
      durationBefore: seconds(before, rate),
      durationAfter: seconds(pcm.frameCount(result.pcm), rate),
      crossfadeSeconds: seconds(result.crossfadeFrames, rate),
      // False means there was no audio after the loop end to fade in, so the
      // loop gave up its own tail for the job and came out shorter. Worth
      // knowing: it means the sound ended where the loop wanted to.
      usedTrailingAudio: result.usedTrailingAudio,
      seam: result.seam,
      ...(result.chosen ? { chosenAutomatically: true, score: result.chosen.score } : {}),
      ...(result.note ? { note: result.note } : {}),
    };
  },
});

defineOp({
  name: "audio.variations",
  description:
    "Turn one sound into a numbered set of jittered takes — eight footsteps from one footstep. A sound that repeats identically is the most recognisable 'cheap game' tell, and SoundComponent already picks between entries at random. Pitch is shifted without changing the length, so the set stays rhythmically interchangeable. Deterministic: the same seed always produces the same files.",
  params: {
    path: { type: "string", required: true, description: "The source sound." },
    count: { type: "number", default: 8, description: "How many variations to write." },
    pitchCents: { type: "number", default: 150, description: "Half-width of the pitch jitter. 100 cents is a semitone." },
    gainDb: { type: "number", default: 2, description: "Half-width of the level jitter." },
    seed: { type: "number", default: 1 },
    includeOriginal: { type: "boolean", default: false, description: "Make the first variation an untouched copy." },
    directory: { type: "string", description: "Where to write them. Defaults to beside the source." },
    track: { type: "number", default: 0 },
  },
  async run(args) {
    requireEditorModule();
    const { file, pcm } = await audioCore();
    const { makeVariations, variationName } = await import("../../audio/variations.js");
    const { encodeWav } = await import("../../audio/wav.js");
    const { writeBinaryFile } = await import("../../assetLoader.js");

    const { doc: document_ } = await file.openAudioDocument(args.path);
    const track = document_.tracks[args.track ?? 0];
    if (!track) throw new Error(`This sound has no track ${args.track ?? 0} (it has ${document_.tracks.length}).`);

    const count = Math.max(1, Math.min(64, Math.round(args.count ?? 8)));
    const source = args.path.replaceAll("\\", "/");
    const directory = (args.directory ?? source.slice(0, source.lastIndexOf("/"))).replaceAll("\\", "/");
    const base = source.split("/").pop();

    const variants = makeVariations(track.pcm, {
      count,
      pitchCents: args.pitchCents ?? 150,
      gainDb: args.gainDb ?? 2,
      seed: args.seed ?? 1,
      includeOriginal: !!args.includeOriginal,
    });

    const written = [];
    for (const variant of variants) {
      const target = `${directory}/${variationName(base, variant.index, count)}`;
      await writeBinaryFile(target, encodeWav(variant.pcm, { bitDepth: 24 }));
      written.push({ path: target, semitones: variant.semitones, gainDb: variant.db, original: variant.original });
    }
    const { useProjectStore } = await import("../../store/projectStore.js");
    await useProjectStore.getState().refresh();

    return {
      source,
      count: written.length,
      durationSeconds: seconds(pcm.frameCount(track.pcm), document_.sampleRate),
      files: written,
    };
  },
});

defineOp({
  name: "audio.export",
  description:
    "Write a sound out in another format, and report what it costs. Ogg/Opus is what a web build should ship — audio is usually the largest thing in one, and WAV is typically 15-20x bigger. Pass estimateOnly to compare sizes before committing. Formats: wav (16/24/32-bit) and ogg (Opus, where the browser has an encoder).",
  params: {
    path: { type: "string", required: true, description: "The source sound." },
    format: { type: "string", default: "ogg", description: "ogg | wav" },
    targetPath: { type: "string", description: "Where to write it. Defaults to the source path with the new extension." },
    bitrate: { type: "number", default: 96000, description: "Ogg only. 64000 for mono SFX, 96000 default, 128000 for music." },
    bitDepth: { type: "number", default: 24, description: "WAV only: 16, 24 or 32." },
    estimateOnly: { type: "boolean", default: false, description: "Report the sizes without writing anything." },
  },
  async run(args) {
    requireEditorModule();
    const { file, doc: docMod } = await audioCore();
    const { doc: document_ } = await file.openAudioDocument(args.path);
    const format = (args.format ?? "ogg").toLowerCase();
    const source = args.path.replaceAll("\\", "/");
    const target = (args.targetPath ?? source.replace(/\.[a-z0-9]+$/i, `.${format}`)).replaceAll("\\", "/");

    const durationSeconds = seconds(docMod.documentFrameCount(document_), document_.sampleRate);
    const asWav = file.estimateDocumentBytes(document_, { format: "wav", bitDepth: args.bitDepth ?? 24 });

    if (args.estimateOnly) {
      const estimate = file.estimateDocumentBytes(document_, { format, bitDepth: args.bitDepth ?? 24, bitrate: args.bitrate ?? 96000 });
      return {
        source,
        format,
        durationSeconds,
        estimatedBytes: estimate,
        wavBytes: asWav,
        timesSmallerThanWav: Math.round((asWav / Math.max(1, estimate)) * 10) / 10,
        estimate: true,
      };
    }

    if (target === source && format === "ogg" && !file.canWriteInPlace(source)) {
      throw new Error("This browser has no Opus encoder, so Ogg can't be written here.");
    }
    const result = await file.exportDocument(document_, target, {
      bitDepth: args.bitDepth ?? 24,
      bitrate: args.bitrate ?? 96000,
    });
    return {
      source,
      path: result.path,
      format: result.format,
      bytes: result.bytes,
      durationSeconds: Math.round(result.durationSeconds * 1000) / 1000,
      channels: result.channels,
      sampleRate: result.sampleRate,
      wavBytes: asWav,
      timesSmallerThanWav: Math.round((asWav / Math.max(1, result.bytes)) * 10) / 10,
    };
  },
});

/**
 * Saves in place when the format can be written, and otherwise writes a sibling
 * WAV — the same rule the panel's Save button follows. Reported rather than
 * assumed: an agent that edited `rain.mp3` needs to know its work landed in
 * `rain.wav` and that scene references still point at the mp3.
 */
async function save(file, path, document_) {
  if (file.canWriteInPlace(path)) {
    const result = await file.saveAudioDocument(path, document_);
    return { path: result.path.replaceAll("\\", "/"), savedInPlace: true, ...(result.format ? { format: result.format } : {}) };
  }
  const result = await file.saveAsWav(path, document_);
  return {
    path: result.path.replaceAll("\\", "/"),
    savedInPlace: false,
    note: `${path.split(/[\\/]/).pop()} can't be written here (this editor writes WAV, and Ogg where the browser has an Opus encoder), so the edit was saved as a new WAV beside it. Scene references still point at the original.`,
  };
}

defineOp({
  name: "audio.library.credits",
  readOnly: true,
  description:
    "Every sound imported into this project with the licence it arrived under, parsed from Audio/CREDITS.md. Use it to answer what still needs crediting, or what can't ship in a commercial build.",
  params: {},
  async run() {
    const entries = await readCredits();
    return {
      entries,
      needingAttribution: entries.filter((e) => e.attributionRequired).map((e) => e.file),
      blockingCommercialUse: entries.filter((e) => !e.commercialUseAllowed).map((e) => e.file),
    };
  },
});
