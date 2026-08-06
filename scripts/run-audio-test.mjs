/**
 * Audio modules — headless checks.
 *
 * Covers the parts of `src/editor/audioLibrary.js` that decide something:
 * licence classification, Freesound's Solr filter construction, response
 * normalisation for both providers, and the CREDITS.md merge/parse round trip.
 * All of it is pure — the module has no static imports of editor
 * infrastructure precisely so this file can import it under plain node.
 *
 * What is deliberately *not* here: live API calls. Freesound needs a personal
 * key this suite has no business holding, and a test that fails when someone
 * else's server is slow isn't testing us. The response shapes below are real
 * ones, captured from the live APIs while building the module.
 *
 * The DSP core lands in the same file as the Audio Editor phases arrive.
 */
import nodeAssert from "node:assert/strict";
import { inspect, isDeepStrictEqual } from "node:util";

const brief = (value) =>
  value && typeof value === "object"
    ? inspect(value, { depth: 1, getters: false, customInspect: false, breakLength: 100 })
    : inspect(value);
const because = (message) => (message ? `${message} — ` : "");
const assert = {
  ok: nodeAssert.ok,
  equal(actual, expected, message) {
    if (Object.is(actual, expected)) return;
    throw new Error(`${because(message)}expected ${brief(expected)}, got ${brief(actual)}`);
  },
  deepEqual(actual, expected, message) {
    if (isDeepStrictEqual(actual, expected)) return;
    throw new Error(`${because(message)}expected ${brief(expected)}, got ${brief(actual)}`);
  },
  match(actual, regex, message) {
    if (regex.test(actual)) return;
    throw new Error(`${because(message)}expected ${brief(actual)} to match ${regex}`);
  },
  includes(haystack, needle, message) {
    if (String(haystack).includes(needle)) return;
    throw new Error(`${because(message)}expected output to contain ${brief(needle)}`);
  },
};

// `getSavedToken` reads localStorage at module scope only when called, but the
// panel-facing exports touch it, so give node a stub rather than a guard in
// production code for a case that only exists in a test.
globalThis.localStorage ??= {
  _map: new Map(),
  getItem(k) { return this._map.get(k) ?? null; },
  setItem(k, v) { this._map.set(k, String(v)); },
  removeItem(k) { this._map.delete(k); },
};

const lib = await import("../src/editor/audioLibrary.js");

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};
const section = (title) => console.log(`\n${title}`);

// ---------------------------------------------------------------------------

section("licences");

await check("CC0 is recognised from Freesound's URL form and the filter's name form", () => {
  for (const raw of [
    "http://creativecommons.org/publicdomain/zero/1.0/",
    "https://creativecommons.org/publicdomain/zero/1.0/",
    "Creative Commons 0",
    "CC0 1.0",
  ]) {
    const lic = lib.normalizeLicense(raw);
    assert.equal(lic.id, "cc0", `"${raw}"`);
    assert.equal(lic.attribution, false, `"${raw}" should need no credit`);
    assert.equal(lic.commercial, true, `"${raw}" should be commercial-safe`);
  }
});

await check("NonCommercial is not mistaken for plain Attribution", () => {
  // The trap: every NonCommercial licence URL also contains "by", so an
  // attribution check that ran first would clear a sound for commercial use
  // that its licence forbids.
  for (const raw of [
    "http://creativecommons.org/licenses/by-nc/3.0/",
    "Attribution NonCommercial",
    "CC BY-NC 4.0",
  ]) {
    const lic = lib.normalizeLicense(raw);
    assert.equal(lic.id, "by-nc", `"${raw}"`);
    assert.equal(lic.commercial, false, `"${raw}" must not be cleared for commercial use`);
  }
});

await check("plain Attribution needs credit but ships commercially", () => {
  const lic = lib.normalizeLicense("http://creativecommons.org/licenses/by/4.0/");
  assert.equal(lic.id, "by");
  assert.equal(lic.attribution, true);
  assert.equal(lic.commercial, true);
});

await check("ShareAlike and Sampling+ keep their own identities", () => {
  assert.equal(lib.normalizeLicense("CC BY-SA 3.0").id, "by-sa");
  assert.equal(lib.normalizeLicense("http://creativecommons.org/licenses/sampling+/1.0/").id, "sampling+");
  assert.equal(lib.normalizeLicense("http://creativecommons.org/licenses/sampling+/1.0/").commercial, false);
});

await check("an unrecognised licence fails closed, not open", () => {
  const lic = lib.normalizeLicense("Some bespoke studio licence");
  assert.equal(lic.id, "unknown");
  assert.equal(lic.attribution, true, "unknown must assume credit is required");
  assert.equal(lic.commercial, false, "unknown must not be presented as commercial-safe");
});

// ---------------------------------------------------------------------------

section("Freesound query construction");

await check("kind presets become duration ranges", () => {
  assert.equal(lib.freesoundFilter({ kind: "sfx" }), "duration:[0 TO 15]");
  assert.equal(lib.freesoundFilter({ kind: "ambience" }), "duration:[15 TO 3600]");
  assert.equal(lib.freesoundFilter({ kind: "any" }), "", "'any' must add no duration term at all");
});

await check("filters AND together in Solr syntax", () => {
  const filter = lib.freesoundFilter({ cc0Only: true, monoOnly: true, kind: "sfx" });
  assert.includes(filter, 'license:"Creative Commons 0"');
  assert.includes(filter, "channels:1");
  assert.includes(filter, "duration:[0 TO 15]");
  assert.equal(filter.split(" ").length >= 3, true, "terms must be space-separated");
});

await check("explicit durations override the preset", () => {
  assert.equal(lib.freesoundFilter({ kind: "sfx", maxDuration: 3 }), "duration:[0 TO 3]");
});

// ---------------------------------------------------------------------------

section("Freesound normalisation");

// A real search result, trimmed to the fields we request.
const FREESOUND_RESULT = {
  id: 411089,
  name: "Metal Impact.wav",
  username: "InspectorJ",
  url: "https://freesound.org/people/InspectorJ/sounds/411089/",
  license: "http://creativecommons.org/licenses/by/3.0/",
  duration: 3.041,
  channels: 2,
  samplerate: 44100,
  filesize: 1073152,
  type: "wav",
  tags: ["metal", "impact", "hit"],
  num_downloads: 12034,
  previews: {
    "preview-hq-mp3": "https://cdn.freesound.org/previews/411/411089_5121236-hq.mp3",
    "preview-lq-mp3": "https://cdn.freesound.org/previews/411/411089_5121236-lq.mp3",
    "preview-hq-ogg": "https://cdn.freesound.org/previews/411/411089_5121236-hq.ogg",
    "preview-lq-ogg": "https://cdn.freesound.org/previews/411/411089_5121236-lq.ogg",
  },
  images: { waveform_m: "https://cdn.freesound.org/displays/411/411089_5121236_wave_M.png" },
};

await check("prefers the hq ogg preview for the download", () => {
  const item = lib.normalizeFreesound(FREESOUND_RESULT);
  assert.equal(item.downloadUrl, FREESOUND_RESULT.previews["preview-hq-ogg"]);
  assert.equal(item.downloadExt, "ogg");
});

await check("falls back to mp3 when no ogg preview was generated", () => {
  const noOgg = { ...FREESOUND_RESULT, previews: { "preview-hq-mp3": FREESOUND_RESULT.previews["preview-hq-mp3"] } };
  const item = lib.normalizeFreesound(noOgg);
  assert.equal(item.downloadExt, "mp3");
  assert.equal(item.downloadUrl, noOgg.previews["preview-hq-mp3"]);
});

await check("does not report the original upload size as the download size", () => {
  // `filesize` is the 1MB original WAV; what we actually fetch is a ~100KB
  // preview. Reporting the former would overstate the import 10x.
  const item = lib.normalizeFreesound(FREESOUND_RESULT);
  assert.equal(item.downloadBytes, null);
  assert.equal(item.originalBytes, 1073152);
});

await check("carries identity, licence and audition URLs through", () => {
  const item = lib.normalizeFreesound(FREESOUND_RESULT);
  assert.equal(item.key, "freesound:411089");
  assert.equal(item.provider, "freesound");
  assert.equal(item.author, "InspectorJ");
  assert.equal(item.license.id, "by");
  assert.equal(item.channels, 2);
  assert.ok(item.previewUrl, "a row with no preview URL cannot be auditioned");
  assert.ok(item.waveformUrl);
});

// ---------------------------------------------------------------------------

section("Commons normalisation");

// A real page object from the live generator=search response.
const COMMONS_PAGE = {
  pageid: 38306311,
  ns: 6,
  title: "File:Urban Street on a Rainy Afternoon.flac",
  index: 1,
  imageinfo: [
    {
      user: "Extemporalist",
      size: 91187572,
      duration: 1800,
      url: "https://upload.wikimedia.org/wikipedia/commons/8/8c/Urban_Street_on_a_Rainy_Afternoon.flac?utm_source=commons.wikimedia.org&utm_campaign=imageinfo",
      descriptionurl: "https://commons.wikimedia.org/wiki/File:Urban_Street_on_a_Rainy_Afternoon.flac",
      extmetadata: {
        ObjectName: { value: "Urban Street on a Rainy Afternoon" },
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Extemporalist" title="User:Extemporalist">Extemporalist</a>' },
        LicenseShortName: { value: "CC BY-SA 4.0" },
        LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
      },
      mime: "audio/x-flac",
    },
  ],
};

await check("strips Commons' analytics query params off the download URL", () => {
  const item = lib.normalizeCommons(COMMONS_PAGE);
  assert.equal(item.downloadUrl.includes("?"), false, "query params would end up in the saved filename");
  assert.equal(item.downloadExt, "flac");
});

await check("unwraps the HTML in the Artist field", () => {
  const item = lib.normalizeCommons(COMMONS_PAGE);
  assert.equal(item.author, "Extemporalist", "raw HTML would land in CREDITS.md verbatim");
});

await check("reads duration and true file size (Commons files can be enormous)", () => {
  const item = lib.normalizeCommons(COMMONS_PAGE);
  assert.equal(item.duration, 1800);
  assert.equal(item.downloadBytes, 91187572);
  assert.equal(item.license.id, "by-sa");
});

// ---------------------------------------------------------------------------

section("Internet Archive normalisation");

// A real item's file list. The Archive derives extra formats from every
// upload, so one source sound appears three times under three extensions.
const ARCHIVE_FILES = [
  { name: "footstep_gravel.wav", format: "WAVE", source: "original", size: "441044", length: "2.5" },
  { name: "footstep_gravel.mp3", format: "VBR MP3", source: "derivative", size: "40122", length: "2.5" },
  { name: "footstep_gravel.ogg", format: "Ogg Vorbis", source: "derivative", size: "31004", length: "2.5" },
  { name: " footstep_dirt.m4a", format: "MPEG-4 Audio", source: "original", size: "123228", length: "1.8" },
  { name: "cover.png", format: "PNG", source: "original", size: "35326" },
  { name: "__ia_thumb.jpg", format: "Item Tile", source: "derivative", size: "2803" },
  { name: "item_archive.torrent", format: "Archive BitTorrent", source: "metadata", size: "2438" },
  { name: "item_meta.sqlite", format: "Metadata", source: "metadata", size: "20480" },
];

await check("keeps one file per sound, not one per derived format", () => {
  const picked = lib.pickArchiveFiles(ARCHIVE_FILES, "my-item");
  assert.equal(picked.length, 2, "three formats of one sound must collapse to one");
  assert.deepEqual(picked.map((f) => f.ext).sort(), ["m4a", "wav"]);
});

await check("prefers the uploader's original over the Archive's derivative", () => {
  const picked = lib.pickArchiveFiles(ARCHIVE_FILES, "my-item");
  const gravel = picked.find((f) => /gravel/.test(f.name));
  assert.equal(gravel.ext, "wav", "the original upload should win over the transcodes");
  assert.equal(gravel.isOriginal, true);
});

await check("drops images, thumbnails, torrents and metadata", () => {
  const picked = lib.pickArchiveFiles(ARCHIVE_FILES, "my-item");
  assert.equal(picked.some((f) => /png|jpg|torrent|sqlite/.test(f.name)), false);
});

await check("encodes filenames with leading spaces into a usable URL", () => {
  const picked = lib.pickArchiveFiles(ARCHIVE_FILES, "my-item");
  const dirt = picked.find((f) => /dirt/.test(f.name));
  assert.includes(dirt.url, "https://archive.org/download/my-item/");
  assert.equal(dirt.url.includes(" "), false, "a raw space would produce a broken URL");
  assert.equal(dirt.name, "footstep_dirt.m4a", "the display name should be trimmed");
});

await check("carries per-file size and duration through", () => {
  const gravel = lib.pickArchiveFiles(ARCHIVE_FILES, "my-item").find((f) => /gravel/.test(f.name));
  assert.equal(gravel.bytes, 441044);
  assert.equal(gravel.seconds, 2.5);
});

await check("an item with no audio yields nothing rather than junk", () => {
  assert.deepEqual(lib.pickArchiveFiles(ARCHIVE_FILES.slice(4), "x"), []);
  assert.deepEqual(lib.pickArchiveFiles(undefined, "x"), []);
});

// ---------------------------------------------------------------------------

section("filenames");

await check("drops the source extension and sanitises the rest", () => {
  assert.equal(lib.safeName("Metal Impact.wav"), "Metal Impact");
  assert.equal(lib.safeName("swoosh/whoosh:01.ogg"), "swoosh_whoosh_01");
  assert.equal(lib.safeName(""), "Sound", "an empty name must still produce a writable file");
});

// ---------------------------------------------------------------------------

section("CREDITS.md");

const item = lib.normalizeFreesound(FREESOUND_RESULT);
const cc0Item = lib.normalizeFreesound({ ...FREESOUND_RESULT, id: 7, name: "Click", license: "Creative Commons 0" });

await check("a first import writes the header and one entry", () => {
  const md = lib.mergeCredits(null, item, "Freesound/Metal Impact.ogg");
  assert.includes(md, "# Audio credits");
  assert.includes(md, "<!-- audio-credit:freesound:411089 -->");
  assert.includes(md, "Attribution required");
});

await check("a second, different sound appends rather than replacing", () => {
  const first = lib.mergeCredits(null, item, "Freesound/Metal Impact.ogg");
  const both = lib.mergeCredits(first, cc0Item, "Freesound/Click.ogg");
  assert.equal(lib.parseCredits(both).length, 2);
  assert.includes(both, "<!-- audio-credit:freesound:411089 -->");
  assert.includes(both, "<!-- audio-credit:freesound:7 -->");
});

await check("re-importing the same sound rewrites its own entry, not a duplicate", () => {
  let md = lib.mergeCredits(null, item, "Freesound/Metal Impact.ogg");
  md = lib.mergeCredits(md, cc0Item, "Freesound/Click.ogg");
  md = lib.mergeCredits(md, item, "Freesound/Metal Impact 2.ogg");
  const entries = lib.parseCredits(md);
  assert.equal(entries.length, 2, "re-import must not append a third entry");
  const rewritten = entries.find((e) => e.key === "freesound:411089");
  assert.equal(rewritten.file, "Freesound/Metal Impact 2.ogg", "the entry should now name the new file");
  assert.ok(entries.find((e) => e.key === "freesound:7"), "the neighbouring entry must survive the rewrite");
});

await check("a rewritten entry that loses a warning line doesn't leave the line behind", () => {
  // A CC-BY sound re-imported after Freesound relicensed it to CC0: the
  // "Attribution required" line must go, which a naive line-based replace
  // would strand in the file.
  const relicensed = lib.normalizeFreesound({ ...FREESOUND_RESULT, license: "Creative Commons 0" });
  let md = lib.mergeCredits(null, item, "Freesound/Metal Impact.ogg");
  md = lib.mergeCredits(md, relicensed, "Freesound/Metal Impact.ogg");
  assert.equal(md.includes("Attribution required"), false);
  assert.equal(lib.parseCredits(md).length, 1);
});

await check("parse recovers the fields the licence audit needs", () => {
  const md = lib.mergeCredits(lib.mergeCredits(null, item, "Freesound/Metal Impact.ogg"), cc0Item, "Freesound/Click.ogg");
  const entries = lib.parseCredits(md);
  const byEntry = entries.find((e) => e.key === "freesound:411089");
  assert.equal(byEntry.name, "Metal Impact.wav");
  assert.equal(byEntry.author, "InspectorJ");
  assert.equal(byEntry.license, "CC BY");
  assert.equal(byEntry.attributionRequired, true);
  assert.equal(byEntry.commercialUseAllowed, true);
  assert.match(byEntry.source, /freesound\.org/);

  const cc0Entry = entries.find((e) => e.key === "freesound:7");
  assert.equal(cc0Entry.attributionRequired, false);
});

await check("parse of an empty or missing file is empty, not a crash", () => {
  assert.deepEqual(lib.parseCredits(null), []);
  assert.deepEqual(lib.parseCredits(""), []);
  assert.deepEqual(lib.parseCredits("# Audio credits\n\nnothing here yet\n"), []);
});

// ===========================================================================
// Audio editor — the DSP core. No browser, no AudioContext: that's the whole
// point of keeping `src/editor/audio/` free of Web Audio.
// ===========================================================================

const pcmMod = await import("../src/editor/audio/pcm.js");
const wav = await import("../src/editor/audio/wav.js");
const resampleMod = await import("../src/editor/audio/resample.js");
const doc = await import("../src/editor/audio/auddoc.js");
const container = await import("../src/editor/audio/container.js");
const edits = await import("../src/editor/audio/edits.js");
const peaksMod = await import("../src/editor/audio/peaks.js");
const historyMod = await import("../src/editor/audio/history.js");

/** A pure tone — the signal whose every property is known analytically. */
function sine(freq, seconds, sampleRate = 48000, { channels = 1, amplitude = 0.5, phase = 0 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const pcm = pcmMod.createPcm(channels, frames, sampleRate);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < frames; i++) {
      pcm.channels[c][i] = amplitude * Math.sin(2 * Math.PI * freq * (i / sampleRate) + phase);
    }
  }
  return pcm;
}

/** Frequency by zero-crossing count — exact enough for a pure tone. */
function measureFrequency(pcm, channel = 0) {
  const ch = pcm.channels[channel];
  let crossings = 0;
  for (let i = 1; i < ch.length; i++) {
    if ((ch[i - 1] < 0 && ch[i] >= 0) || (ch[i - 1] >= 0 && ch[i] < 0)) crossings++;
  }
  return (crossings / 2) * (pcm.sampleRate / ch.length);
}

const closeTo = (actual, expected, tolerance, message) => {
  if (Math.abs(actual - expected) <= tolerance) return;
  throw new Error(`${because(message)}expected ${expected} ±${tolerance}, got ${actual}`);
};

// ---------------------------------------------------------------------------

section("WAV codec");

for (const bitDepth of [16, 24, 32]) {
  await check(`round-trips ${bitDepth}-bit without changing length, rate or channel count`, () => {
    const source = sine(440, 0.05, 44100, { channels: 2 });
    const decoded = wav.decodeWav(wav.encodeWav(source, { bitDepth, dither: false }));
    assert.equal(decoded.sampleRate, 44100);
    assert.equal(decoded.channels.length, 2);
    assert.equal(pcmMod.frameCount(decoded), pcmMod.frameCount(source));
  });

  await check(`round-trips ${bitDepth}-bit within that depth's quantisation step`, () => {
    const source = sine(440, 0.05, 44100, { channels: 2 });
    const decoded = wav.decodeWav(wav.encodeWav(source, { bitDepth, dither: false }));
    // One LSB of headroom; 32-bit float is exact.
    const tolerance = bitDepth === 32 ? 1e-7 : 2 / 2 ** (bitDepth - 1);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < pcmMod.frameCount(source); i++) {
        closeTo(decoded.channels[c][i], source.channels[c][i], tolerance, `channel ${c} frame ${i}`);
      }
    }
  });
}

await check("channels stay separate through interleaving", () => {
  // The classic interleave bug swaps or duplicates channels and is invisible
  // on a symmetric test signal, so make the two channels plainly different.
  const source = pcmMod.createPcm(2, 100, 48000);
  source.channels[0].fill(0.5);
  source.channels[1].fill(-0.25);
  const decoded = wav.decodeWav(wav.encodeWav(source, { bitDepth: 32 }));
  closeTo(decoded.channels[0][50], 0.5, 1e-6, "left");
  closeTo(decoded.channels[1][50], -0.25, 1e-6, "right");
});

await check("reads a file with extra chunks before the data chunk", () => {
  // Real WAVs from real recorders carry LIST/fact chunks; a parser that
  // assumes a canonical 44-byte header reads their bytes as audio.
  const base = wav.encodeWav(sine(440, 0.01, 48000), { bitDepth: 16, dither: false });
  const listChunk = new Uint8Array(20); // "LIST" + size(12) + 12 bytes of junk
  listChunk.set([0x4c, 0x49, 0x53, 0x54], 0);
  new DataView(listChunk.buffer).setUint32(4, 12, true);

  const spliced = new Uint8Array(base.byteLength + listChunk.byteLength);
  spliced.set(base.subarray(0, 36), 0); // through the fmt chunk
  spliced.set(listChunk, 36);
  spliced.set(base.subarray(36), 36 + listChunk.byteLength);
  new DataView(spliced.buffer).setUint32(4, spliced.byteLength - 8, true);

  const decoded = wav.decodeWav(spliced);
  assert.equal(pcmMod.frameCount(decoded), 480);
});

await check("survives a data chunk that claims more bytes than the file holds", () => {
  const bytes = wav.encodeWav(sine(440, 0.01, 48000), { bitDepth: 16, dither: false });
  new DataView(bytes.buffer).setUint32(40, 999999, true);
  const decoded = wav.decodeWav(bytes);
  assert.equal(pcmMod.frameCount(decoded), 480, "should read what's actually there");
});

await check("rejects non-WAV bytes with a reason, not a crash", () => {
  nodeAssert.throws(() => wav.decodeWav(new Uint8Array([0xff, 0xfb, 0x90, 0x00])), /Not a WAV/);
});

await check("16-bit dither is on by default and stays sub-LSB", () => {
  const silence = pcmMod.createPcm(1, 2000, 48000);
  const dithered = wav.decodeWav(wav.encodeWav(silence, { bitDepth: 16 }));
  const undithered = wav.decodeWav(wav.encodeWav(silence, { bitDepth: 16, dither: false }));
  assert.equal(pcmMod.peak(undithered), 0, "without dither, digital silence stays silent");
  assert.ok(pcmMod.peak(dithered) > 0, "dither should add noise");
  assert.ok(pcmMod.peak(dithered) <= 2 / 32768, "dither must stay within a couple of LSBs");
});

// ---------------------------------------------------------------------------

section("resampling");

await check("halving the rate preserves the tone's frequency", () => {
  const source = sine(1000, 0.5, 48000);
  const out = resampleMod.resample(source, 24000);
  assert.equal(out.sampleRate, 24000);
  closeTo(pcmMod.frameCount(out), 12000, 2, "frame count");
  closeTo(measureFrequency(out), 1000, 10, "measured frequency");
});

await check("upsampling preserves the tone's frequency", () => {
  const out = resampleMod.resample(sine(1000, 0.5, 22050), 48000);
  closeTo(measureFrequency(out), 1000, 10);
});

await check("amplitude survives the round trip, including at the buffer edges", () => {
  // The edge case that catches an unnormalised kernel: at the first and last
  // few frames half the taps hang off the end of the buffer, so without
  // normalising by realised weight the signal fades in and out.
  const source = sine(500, 0.3, 48000, { amplitude: 0.8 });
  const out = resampleMod.resample(source, 32000);
  closeTo(pcmMod.peak(out), 0.8, 0.02, "peak");
  const head = pcmMod.rms({ ...out, channels: [out.channels[0].slice(0, 200)] });
  const middle = pcmMod.rms({ ...out, channels: [out.channels[0].slice(4000, 4200)] });
  closeTo(head, middle, 0.05, "head should be as loud as the middle");
});

await check("downsampling does not fold high frequencies back into the band", () => {
  // 10kHz into a 16kHz rate: above the new 8kHz Nyquist. Without the
  // anti-aliasing cutoff this reappears at 6kHz as a loud phantom tone.
  const out = resampleMod.resample(sine(10000, 0.3, 48000, { amplitude: 0.9 }), 16000);
  assert.ok(
    pcmMod.rms(out) < 0.1,
    `aliased energy should be filtered away, got RMS ${pcmMod.rms(out).toFixed(3)}`,
  );
});

await check("changeSpeed keeps the declared rate and scales the length", () => {
  const out = resampleMod.changeSpeed(sine(440, 1, 48000), 2);
  assert.equal(out.sampleRate, 48000, "varispeed must not change the file's rate");
  closeTo(pcmMod.frameCount(out), 24000, 5, "twice as fast is half as long");
  closeTo(measureFrequency(out), 880, 15, "and an octave up — that's the tape effect");
});

// ---------------------------------------------------------------------------

section("channels and panning");

await check("constant-power pan holds level across the sweep", () => {
  for (const pan of [-1, -0.5, 0, 0.5, 1]) {
    const [l, r] = pcmMod.panGains(pan);
    closeTo(Math.sqrt(l * l + r * r), 1, 1e-6, `pan ${pan} should hold constant power`);
  }
  const [l, r] = pcmMod.panGains(0);
  closeTo(l, r, 1e-9, "centre should be balanced");
});

await check("mono downmix of anti-phase stereo keeps the energy", () => {
  // The failure this exists to prevent: a naive (L+R)/2 on an out-of-phase
  // stereo file cancels to near-silence, and nothing about the file says why.
  const source = pcmMod.createPcm(2, 4800, 48000);
  for (let i = 0; i < 4800; i++) {
    const v = 0.6 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    source.channels[0][i] = v;
    source.channels[1][i] = -v;
  }
  const mono = pcmMod.toMono(source);
  assert.equal(mono.channels.length, 1);
  closeTo(pcmMod.peak(mono), 0.6, 0.01, "anti-phase content must survive the downmix");
});

await check("mono downmix of ordinary stereo is the plain average", () => {
  const source = pcmMod.createPcm(2, 100, 48000);
  source.channels[0].fill(0.4);
  source.channels[1].fill(0.2);
  closeTo(pcmMod.toMono(source).channels[0][50], 0.3, 1e-6);
});

await check("zero-crossing snap lands on a crossing and never wanders far", () => {
  const source = sine(100, 0.1, 48000); // period = 480 frames
  const snapped = pcmMod.nearestZeroCrossing(source, 1000, 512);
  const ch = source.channels[0];
  assert.ok(
    (ch[snapped] <= 0 && ch[snapped + 1] >= 0) || (ch[snapped] >= 0 && ch[snapped + 1] <= 0) || Math.abs(ch[snapped]) < 0.02,
    "snapped frame should sit on a crossing",
  );
  assert.ok(Math.abs(snapped - 1000) <= 512, "must stay inside the search window");
});

// ---------------------------------------------------------------------------

section("edits");

const clip = sine(440, 1, 48000); // 48000 frames

await check("delete closes the gap", () => {
  const out = edits.deleteRange(clip, 1000, 2000);
  assert.equal(pcmMod.frameCount(out), 47000);
});

await check("silence keeps the length and zeros only the selection", () => {
  const out = edits.silenceRange(clip, 1000, 2000);
  assert.equal(pcmMod.frameCount(out), 48000);
  assert.equal(out.channels[0][1500], 0);
  assert.ok(Math.abs(out.channels[0][500]) > 0, "outside the selection must be untouched");
  assert.ok(Math.abs(out.channels[0][2500]) > 0);
});

await check("trim keeps only the selection", () => {
  assert.equal(pcmMod.frameCount(edits.trimToRange(clip, 1000, 5000)), 4000);
});

await check("duplicate inserts a copy right after the selection", () => {
  const out = edits.duplicateRange(clip, 1000, 2000);
  assert.equal(pcmMod.frameCount(out), 49000);
  closeTo(out.channels[0][2500], out.channels[0][1500], 1e-6, "the copy should match the original");
});

await check("insert silence lengthens by exactly the requested time", () => {
  const out = edits.insertSilence(clip, 24000, 0.5);
  assert.equal(pcmMod.frameCount(out), 48000 + 24000);
  assert.equal(out.channels[0][30000], 0);
});

await check("replace swaps a range for a clip of a different length", () => {
  const out = edits.replaceRange(clip, 1000, 2000, sine(440, 0.1, 48000)); // 4800 frames in
  assert.equal(pcmMod.frameCount(out), 48000 - 1000 + 4800);
});

await check("reverse mirrors the selection and leaves the rest alone", () => {
  const ramp = pcmMod.createPcm(1, 100, 48000);
  for (let i = 0; i < 100; i++) ramp.channels[0][i] = i / 100;
  const out = edits.reverseRange(ramp, 10, 20);
  closeTo(out.channels[0][10], 0.19, 1e-6, "first frame of the selection becomes the last");
  closeTo(out.channels[0][19], 0.1, 1e-6);
  closeTo(out.channels[0][50], 0.5, 1e-6, "outside the selection is untouched");
});

await check("ranges are clamped and order-independent", () => {
  assert.equal(pcmMod.frameCount(edits.trimToRange(clip, 2000, 1000)), 1000, "reversed range");
  assert.equal(pcmMod.frameCount(edits.trimToRange(clip, -500, 999999)), 48000, "out of bounds");
});

await check("trimSilence removes the padding but leaves air before the transient", () => {
  const padded = pcmMod.createPcm(1, 48000, 48000);
  for (let i = 20000; i < 25000; i++) padded.channels[0][i] = 0.5;
  const out = edits.trimSilence(padded, { thresholdDb: -60, padSeconds: 0.005 });
  const pad = Math.round(0.005 * 48000);
  closeTo(pcmMod.frameCount(out), 5000 + pad * 2, 2);
  assert.equal(out.channels[0][0], 0, "the leading pad should still be silence");
});

await check("trimSilence on a wholly silent buffer returns empty, not the whole thing", () => {
  assert.equal(pcmMod.frameCount(edits.trimSilence(pcmMod.createPcm(1, 1000, 48000))), 0);
});

// ---------------------------------------------------------------------------

section("document + mixdown");

await check("a new document holds one track at the source's rate", () => {
  const d = doc.createDocument(sine(440, 1, 44100), { name: "Impact" });
  assert.equal(d.tracks.length, 1);
  assert.equal(d.sampleRate, 44100);
  assert.equal(d.tracks[0].name, "Impact");
});

await check("adding a track at another rate converts it to the document's", () => {
  const d = doc.createDocument(sine(440, 1, 48000));
  const track = doc.addTrack(d, sine(440, 1, 22050), { name: "Other" });
  assert.equal(track.pcm.sampleRate, 48000, "mixdown must never have to resample");
  closeTo(pcmMod.frameCount(track.pcm), 48000, 5);
});

await check("a stereo track widens a mono document rather than being folded down", () => {
  const d = doc.createDocument(sine(440, 0.1, 48000, { channels: 1 }));
  assert.equal(d.channels, 1);
  doc.addTrack(d, sine(440, 0.1, 48000, { channels: 2 }));
  assert.equal(d.channels, 2);
  assert.equal(doc.mixdown(d).channels.length, 2);
});

await check("document length is the furthest track end, not the longest track", () => {
  const d = doc.createDocument(sine(440, 0.1, 48000)); // 4800 frames
  doc.addTrack(d, sine(440, 0.1, 48000), { start: 24000 });
  assert.equal(doc.documentFrameCount(d), 28800);
});

await check("track gain scales the mix", () => {
  const d = doc.createDocument(pcmConst(1, 1000, 0.5));
  d.tracks[0].gain = 0.5;
  closeTo(doc.mixdown(d).channels[0][500], 0.25, 1e-6);
});

await check("muting removes a track; soloing removes everything else", () => {
  const d = doc.createDocument(pcmConst(1, 1000, 0.5));
  doc.addTrack(d, pcmConst(1, 1000, 0.25));

  closeTo(doc.mixdown(d).channels[0][500], 0.75, 1e-6, "both tracks sum");

  d.tracks[1].muted = true;
  closeTo(doc.mixdown(d).channels[0][500], 0.5, 1e-6, "muted track drops out");

  d.tracks[1].muted = false;
  d.tracks[1].solo = true;
  closeTo(doc.mixdown(d).channels[0][500], 0.25, 1e-6, "solo must silence non-soloed tracks");
});

await check("a centred pan does not lose 3 dB against the unpanned case", () => {
  const d = doc.createDocument(pcmConst(2, 1000, 0.5));
  d.tracks[0].pan = 0;
  closeTo(doc.mixdown(d).channels[0][500], 0.5, 1e-6, "centre must be unity, not 0.707");
});

await check("hard pan sends the track to one side only", () => {
  const d = doc.createDocument(pcmConst(2, 1000, 0.5));
  d.tracks[0].pan = -1;
  const mix = doc.mixdown(d);
  closeTo(mix.channels[0][500], 0.5 * Math.SQRT2, 1e-6, "left gets the energy");
  closeTo(mix.channels[1][500], 0, 1e-6, "right is silent");
});

await check("mixdown does not clip a hot sum — over is reported, not hidden", () => {
  const d = doc.createDocument(pcmConst(1, 1000, 0.8));
  doc.addTrack(d, pcmConst(1, 1000, 0.8));
  closeTo(doc.mixdown(d).channels[0][500], 1.6, 1e-6, "clamping here would hide the clip from Normalise");
});

function pcmConst(channels, frames, value) {
  const p = pcmMod.createPcm(channels, frames, 48000);
  for (const ch of p.channels) ch.fill(value);
  return p;
}

// ---------------------------------------------------------------------------

section(".aud container");

await check("round-trips a multitrack document with its mix state", () => {
  const d = doc.createDocument(sine(440, 0.2, 44100), { name: "Thud" });
  doc.addTrack(d, sine(880, 0.1, 44100), { name: "Crack", gain: 0.4, pan: -0.5, start: 2205, muted: true });

  const restored = container.decodeAud(container.encodeAud(d));
  assert.equal(restored.sampleRate, 44100);
  assert.equal(restored.tracks.length, 2);
  assert.deepEqual(
    restored.tracks.map((t) => [t.name, t.gain, t.pan, t.start, t.muted]),
    [["Thud", 1, 0, 0, false], ["Crack", 0.4, -0.5, 2205, true]],
  );
});

await check("track samples survive the round trip exactly (float payloads)", () => {
  const d = doc.createDocument(sine(440, 0.1, 48000, { channels: 2 }));
  const restored = container.decodeAud(container.encodeAud(d));
  const before = d.tracks[0].pcm.channels[1];
  const after = restored.tracks[0].pcm.channels[1];
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i += 97) closeTo(after[i], before[i], 1e-7, `frame ${i}`);
});

await check("the mixdown of a restored document matches the original's", () => {
  const d = doc.createDocument(sine(440, 0.1, 48000));
  doc.addTrack(d, sine(660, 0.1, 48000), { gain: 0.3, start: 1000 });
  const a = doc.mixdown(d);
  const b = doc.mixdown(container.decodeAud(container.encodeAud(d)));
  assert.equal(pcmMod.frameCount(a), pcmMod.frameCount(b));
  for (let i = 0; i < pcmMod.frameCount(a); i += 101) closeTo(b.channels[0][i], a.channels[0][i], 1e-6, `frame ${i}`);
});

await check("a truncated container drops the unreadable track, not the document", () => {
  const d = doc.createDocument(sine(440, 0.1, 48000), { name: "Keep" });
  doc.addTrack(d, sine(880, 0.1, 48000), { name: "Lose" });
  const bytes = container.encodeAud(d);
  const truncated = bytes.subarray(0, bytes.byteLength - 4000);

  const restored = container.decodeAud(truncated);
  assert.equal(restored.tracks.length, 1, "the intact track should survive");
  assert.equal(restored.tracks[0].name, "Keep");
});

await check("rejects bytes that aren't a container", () => {
  nodeAssert.throws(() => container.decodeAud(new Uint8Array(64)), /Not an \.aud/);
  assert.equal(container.looksLikeAud(new Uint8Array(64)), false);
  assert.equal(container.looksLikeAud(container.encodeAud(doc.createDocument(sine(440, 0.01, 48000)))), true);
});

// ---------------------------------------------------------------------------

section("waveform peaks");

await check("summary min/max bracket the real samples", () => {
  const source = sine(440, 1, 48000, { amplitude: 0.7 });
  const peaks = peaksMod.buildPeaks(source);
  closeTo(Math.max(...peaks.channels[0].max), 0.7, 0.01);
  closeTo(Math.min(...peaks.channels[0].min), -0.7, 0.01);
});

await check("a zoomed-out lane reads the summary and still spans the signal", () => {
  const source = sine(440, 10, 48000, { amplitude: 0.7 });
  const peaks = peaksMod.buildPeaks(source);
  const cols = peaksMod.columnPeaks(peaks, source, 0, 0, pcmMod.frameCount(source), 400);
  assert.equal(cols.max.length, 400);
  closeTo(Math.max(...cols.max), 0.7, 0.01);
});

await check("a zoomed-in lane reads raw samples, so no column comes back empty", () => {
  const source = sine(440, 1, 48000, { amplitude: 0.7 });
  const peaks = peaksMod.buildPeaks(source);
  // 200 frames across 400 columns: half a frame per column.
  const cols = peaksMod.columnPeaks(peaks, source, 0, 1000, 1200, 400);
  for (let x = 0; x < 400; x++) {
    assert.ok(cols.max[x] >= cols.min[x], `column ${x} should be a valid range`);
  }
  assert.ok(Math.max(...cols.max) > 0, "a zoomed-in view of a loud region must not be flat");
});

await check("silence summarises as flat zero rather than ±Infinity", () => {
  const peaks = peaksMod.buildPeaks(pcmMod.createPcm(1, 5000, 48000));
  assert.equal(Math.max(...peaks.channels[0].max), 0);
  assert.equal(Math.min(...peaks.channels[0].min), 0);
});

// ---------------------------------------------------------------------------

section("history");

await check("undo restores the previous samples, redo reapplies", () => {
  const d = doc.createDocument(sine(440, 1, 48000));
  const history = historyMod.createHistory();
  const originalFrames = pcmMod.frameCount(d.tracks[0].pcm);

  historyMod.pushHistory(history, d, "Delete");
  doc.setTrackPcm(d, d.tracks[0].id, edits.deleteRange(d.tracks[0].pcm, 0, 24000));
  assert.equal(pcmMod.frameCount(d.tracks[0].pcm), originalFrames - 24000);

  assert.equal(historyMod.undo(history, d), "Delete");
  assert.equal(pcmMod.frameCount(d.tracks[0].pcm), originalFrames);

  assert.equal(historyMod.redo(history, d), "Delete");
  assert.equal(pcmMod.frameCount(d.tracks[0].pcm), originalFrames - 24000);
});

await check("undo mutates the document in place so open views stay pointed at it", () => {
  // The texture editor's equivalent bug: undo returned a new document and the
  // canvas kept drawing the state that had just been rewound.
  const d = doc.createDocument(sine(440, 0.5, 48000));
  const history = historyMod.createHistory();
  const identity = d;

  historyMod.pushHistory(history, d, "Silence");
  doc.setTrackPcm(d, d.tracks[0].id, edits.silenceRange(d.tracks[0].pcm, 0, 1000));
  historyMod.undo(history, d);

  assert.equal(d, identity, "undo must not replace the document object");
  assert.ok(Math.abs(d.tracks[0].pcm.channels[0][500]) > 0, "and it must actually restore the samples");
});

await check("mix state (gain/pan/mute) is undoable too, not just samples", () => {
  const d = doc.createDocument(sine(440, 0.1, 48000));
  const history = historyMod.createHistory();
  historyMod.pushHistory(history, d, "Gain");
  d.tracks[0].gain = 0.25;
  historyMod.undo(history, d);
  assert.equal(d.tracks[0].gain, 1);
});

await check("a new edit clears the redo branch", () => {
  const d = doc.createDocument(sine(440, 0.1, 48000));
  const history = historyMod.createHistory();
  historyMod.pushHistory(history, d, "First");
  d.tracks[0].gain = 0.5;
  historyMod.undo(history, d);
  assert.equal(historyMod.canRedo(history), true);

  historyMod.pushHistory(history, d, "Second");
  assert.equal(historyMod.canRedo(history), false, "undo, undo, edit must not leave a stale redo");
});

await check("the stack evicts by bytes and never drops the newest entry", () => {
  const d = doc.createDocument(sine(440, 1, 48000)); // ~192KB per snapshot
  const history = historyMod.createHistory({ budgetBytes: 400 * 1024 });
  for (let i = 0; i < 20; i++) {
    historyMod.pushHistory(history, d, `Edit ${i}`);
    doc.setTrackPcm(d, d.tracks[0].id, edits.silenceRange(d.tracks[0].pcm, i * 100, i * 100 + 50));
  }
  assert.ok(history.past.length < 20, "old entries should have been evicted");
  assert.ok(history.past.length >= 1, "the most recent entry must survive any budget");
  assert.equal(historyMod.undoLabel(history), "Edit 19");
  assert.ok(historyMod.stackBytes(history) <= 400 * 1024 * 2, "should stay near the budget");
});

await check("shared buffers are counted once, not once per snapshot", () => {
  const d = doc.createDocument(sine(440, 1, 48000));
  doc.addTrack(d, sine(880, 1, 48000));
  const history = historyMod.createHistory();
  const oneTrack = pcmMod.frameCount(d.tracks[0].pcm) * 4;

  historyMod.pushHistory(history, d, "A");
  historyMod.pushHistory(history, d, "B");
  historyMod.pushHistory(history, d, "C");
  // Three snapshots of the same two untouched buffers is two buffers' worth.
  closeTo(historyMod.stackBytes(history), oneTrack * 2, oneTrack * 0.1);
});

// ===========================================================================
// Phase 2 — processing. Every check is against a signal whose correct answer
// is known analytically, not against a recorded expectation.
// ===========================================================================

const amp = await import("../src/editor/audio/amplitude.js");
const filters = await import("../src/editor/audio/filters.js");
const dyn = await import("../src/editor/audio/dynamics.js");
const stretch = await import("../src/editor/audio/timestretch.js");
const space = await import("../src/editor/audio/space.js");
const gen = await import("../src/editor/audio/generate.js");
const fftMod = await import("../src/editor/audio/fft.js");
const denoiseMod = await import("../src/editor/audio/denoise.js");

const rmsOf = (pcm) => pcmMod.rms(pcm);
const dbOf = (v) => 20 * Math.log10(v);

// ---------------------------------------------------------------------------

section("amplitude");

await check("amplify by +6 dB doubles the amplitude", () => {
  const out = amp.amplify(sine(440, 0.1, 48000, { amplitude: 0.25 }), 6);
  closeTo(pcmMod.peak(out), 0.5, 0.005);
});

await check("normalize hits the requested peak exactly", () => {
  for (const target of [0, -1, -6]) {
    const out = amp.normalizePeak(sine(440, 0.1, 48000, { amplitude: 0.13 }), target);
    closeTo(dbOf(pcmMod.peak(out)), target, 0.05, `target ${target} dBFS`);
  }
});

await check("normalize uses ONE gain for all channels, preserving the stereo image", () => {
  // The trap: per-channel normalising re-centres a panned sound. Left is 4x
  // the level of right here, and that ratio must survive.
  const pcm = pcmMod.createPcm(2, 1000, 48000);
  pcm.channels[0].fill(0.4);
  pcm.channels[1].fill(0.1);
  const out = amp.normalizePeak(pcm, 0);
  closeTo(out.channels[0][10], 1, 1e-4, "loud channel goes to full scale");
  closeTo(out.channels[1][10], 0.25, 1e-4, "quiet channel keeps its 4:1 relationship");
});

await check("normalizing silence returns silence, not NaN", () => {
  const out = amp.normalizePeak(pcmMod.createPcm(1, 100, 48000), 0);
  assert.equal(Number.isNaN(out.channels[0][10]), false);
  assert.equal(out.channels[0][10], 0);
});

await check("RMS normalise reports the gain it applied and the peak it produced", () => {
  const result = amp.normalizeRms(sine(440, 0.2, 48000, { amplitude: 0.1 }), -18);
  closeTo(dbOf(pcmMod.rms(result.pcm)), -18, 0.1);
  assert.ok(result.appliedDb > 0, "a quiet source should have been turned up");
  assert.ok(result.resultingPeak > 0, "and the resulting peak reported so a limiter can follow");
});

await check("fade in starts at silence and ends at full", () => {
  const flat = pcmConst(1, 1000, 1);
  const out = amp.fade(flat, { direction: "in", shape: "linear" });
  closeTo(out.channels[0][0], 0, 1e-6);
  closeTo(out.channels[0][999], 1, 0.002);
});

await check("fade out is the mirror of fade in", () => {
  const flat = pcmConst(1, 1000, 1);
  const out = amp.fade(flat, { direction: "out", shape: "linear" });
  closeTo(out.channels[0][0], 1, 1e-6);
  closeTo(out.channels[0][999], 0, 0.002);
});

await check("a crossfade shortens the total by exactly the overlap", () => {
  const out = amp.crossfade(pcmConst(1, 2000, 0.5), pcmConst(1, 2000, 0.5), 1000);
  assert.equal(pcmMod.frameCount(out), 3000);
});

await check("an equal-power crossfade holds POWER through the seam", () => {
  // The property that matters, tested on the material it's for. Equal-power is
  // correct for *uncorrelated* sources — two different parts of one ambience,
  // which is what the loop maker crossfades — where power adds and amplitude
  // does not. (On identical sources it deliberately bulges; that's the known
  // trade against linear, which instead dips 3 dB on uncorrelated material.)
  const a = gen.noise(0.5, { seed: 1, amplitude: 0.3 });
  const b = gen.noise(0.5, { seed: 2, amplitude: 0.3 });
  const overlap = 12000;
  const out = amp.crossfade(a, b, overlap);
  const seamStart = pcmMod.frameCount(a) - overlap;
  const window = (from) => pcmMod.rms({ ...out, channels: [out.channels[0].slice(from, from + 2000)] });
  const before = window(1000);
  for (const at of [0.25, 0.5, 0.75]) {
    closeTo(window(seamStart + Math.round(overlap * at)), before, before * 0.16, `${at * 100}% through the seam`);
  }
});

await check("the crossfade gain pair is exactly constant-power", () => {
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const out = Math.cos((t * Math.PI) / 2);
    const inn = Math.sin((t * Math.PI) / 2);
    closeTo(out * out + inn * inn, 1, 1e-9, `t=${t}`);
  }
});

await check("invert plus original is digital silence", () => {
  const original = sine(440, 0.05, 48000);
  const flipped = amp.invert(original);
  for (let i = 0; i < pcmMod.frameCount(original); i += 37) {
    closeTo(original.channels[0][i] + flipped.channels[0][i], 0, 1e-9, `frame ${i}`);
  }
});

await check("DC offset removal zeroes the mean, per channel", () => {
  const pcm = sine(440, 0.2, 48000, { channels: 2 });
  for (let i = 0; i < pcmMod.frameCount(pcm); i++) {
    pcm.channels[0][i] += 0.2;
    pcm.channels[1][i] -= 0.05; // a different error per channel, as in real capture
  }
  const out = amp.removeDcOffset(pcm);
  for (let c = 0; c < 2; c++) {
    let sum = 0;
    for (let i = 0; i < out.channels[c].length; i++) sum += out.channels[c][i];
    closeTo(sum / out.channels[c].length, 0, 1e-6, `channel ${c}`);
  }
});

await check("an envelope interpolates linearly between its points", () => {
  const out = amp.applyEnvelope(pcmConst(1, 1000, 1), [
    { t: 0, gain: 0 },
    { t: 0.5, gain: 1 },
    { t: 1, gain: 0 },
  ]);
  closeTo(out.channels[0][0], 0, 0.01);
  closeTo(out.channels[0][250], 0.5, 0.01);
  closeTo(out.channels[0][500], 1, 0.01);
  closeTo(out.channels[0][750], 0.5, 0.01);
});

// ---------------------------------------------------------------------------

section("filters");

await check("a lowpass passes what's below it and stops what's above", () => {
  const low = filters.applyBiquad(sine(200, 0.3, 48000, { amplitude: 0.5 }), { type: "lowpass", frequency: 2000 });
  const high = filters.applyBiquad(sine(15000, 0.3, 48000, { amplitude: 0.5 }), { type: "lowpass", frequency: 2000 });
  closeTo(rmsOf(low), rmsOf(sine(200, 0.3, 48000, { amplitude: 0.5 })), 0.02, "passband should be untouched");
  assert.ok(rmsOf(high) < 0.01, `15kHz should be well down, got RMS ${rmsOf(high).toFixed(4)}`);
});

await check("a highpass is the mirror of that", () => {
  const low = filters.applyBiquad(sine(50, 0.3, 48000, { amplitude: 0.5 }), { type: "highpass", frequency: 1000 });
  const high = filters.applyBiquad(sine(8000, 0.3, 48000, { amplitude: 0.5 }), { type: "highpass", frequency: 1000 });
  assert.ok(rmsOf(low) < 0.02, `50Hz should be removed, got ${rmsOf(low).toFixed(4)}`);
  closeTo(rmsOf(high), rmsOf(sine(8000, 0.3, 48000, { amplitude: 0.5 })), 0.03);
});

await check("a notch removes its own frequency and leaves its neighbours", () => {
  const at = filters.applyBiquad(sine(1000, 0.3, 48000, { amplitude: 0.5 }), { type: "notch", frequency: 1000, q: 4 });
  const away = filters.applyBiquad(sine(4000, 0.3, 48000, { amplitude: 0.5 }), { type: "notch", frequency: 1000, q: 4 });
  assert.ok(rmsOf(at) < 0.05, `the notched tone should collapse, got ${rmsOf(at).toFixed(4)}`);
  closeTo(rmsOf(away), rmsOf(sine(4000, 0.3, 48000, { amplitude: 0.5 })), 0.03, "a tone two octaves up is untouched");
});

await check("a peaking band boosts by the gain it was given", () => {
  const source = sine(1000, 0.3, 48000, { amplitude: 0.3 });
  const out = filters.applyBiquad(source, { type: "peaking", frequency: 1000, q: 1, gainDb: 6 });
  // Zero-phase runs the filter twice, so a +6 dB band gives +12 dB overall.
  closeTo(dbOf(rmsOf(out)) - dbOf(rmsOf(source)), 12, 1.5);
});

await check("the drawn EQ curve agrees with what the filter actually does", () => {
  // The curve is analytic and the audio is measured; if they disagree, the
  // panel is drawing a lie.
  const bands = [{ type: "peaking", frequency: 2000, q: 1, gainDb: 8, enabled: true }];
  const source = sine(2000, 0.3, 48000, { amplitude: 0.2 });
  const out = filters.applyEq(source, bands);
  const measured = dbOf(rmsOf(out)) - dbOf(rmsOf(source));
  const drawn = filters.eqMagnitudeDb(bands, 2000, 48000);
  closeTo(measured, drawn, 1.5, `curve says ${drawn.toFixed(1)}dB, audio measured ${measured.toFixed(1)}dB`);
});

await check("a flat EQ is a no-op", () => {
  const source = sine(1000, 0.1, 48000, { amplitude: 0.4 });
  const out = filters.applyEq(source, filters.DEFAULT_EQ_BANDS);
  closeTo(rmsOf(out), rmsOf(source), 1e-6);
});

await check("a cutoff above Nyquist clamps instead of producing NaN", () => {
  const out = filters.applyBiquad(sine(1000, 0.05, 48000, { amplitude: 0.4 }), { type: "lowpass", frequency: 96000 });
  assert.equal(Number.isFinite(out.channels[0][100]), true);
});

// ---------------------------------------------------------------------------

section("dynamics");

await check("a compressor pulls down what's above the threshold", () => {
  const loud = pcmConst(1, 48000, 0.9); // -0.9 dBFS, well over
  const out = dyn.compress(loud, { thresholdDb: -20, ratio: 4, attackMs: 1, releaseMs: 50 });
  const settled = dyn.measure(out, 24000, 48000);
  assert.ok(settled.peakDb < -8, `should be compressed toward the threshold, got ${settled.peakDb.toFixed(1)}dB`);
  assert.ok(settled.peakDb > -20, "but not squashed below the threshold itself");
});

await check("…and leaves what's below it alone", () => {
  const quiet = pcmConst(1, 24000, 0.02); // -34 dBFS
  const out = dyn.compress(quiet, { thresholdDb: -20, ratio: 4 });
  closeTo(dyn.measure(out, 12000, 24000).peak, 0.02, 0.002);
});

await check("a stereo compressor moves both channels together", () => {
  // Independent per-channel detection makes the image lurch; linked detection
  // keeps the 4:1 ratio between the channels intact.
  const pcm = pcmMod.createPcm(2, 48000, 48000);
  pcm.channels[0].fill(0.8);
  pcm.channels[1].fill(0.2);
  const out = dyn.compress(pcm, { thresholdDb: -20, ratio: 4, attackMs: 1 });
  const ratio = out.channels[0][40000] / out.channels[1][40000];
  closeTo(ratio, 4, 0.05, "the channel balance must survive compression");
});

await check("a limiter never lets anything past the ceiling", () => {
  const spiky = sine(200, 0.5, 48000, { amplitude: 0.4 });
  // A burst that would clip badly.
  for (let i = 10000; i < 10200; i++) spiky.channels[0][i] = 2.5;
  const out = dyn.limit(spiky, { ceilingDb: -1, lookaheadMs: 5, releaseMs: 50 });
  const ceiling = 10 ** (-1 / 20);
  assert.ok(
    pcmMod.peak(out) <= ceiling + 1e-4,
    `peak ${pcmMod.peak(out).toFixed(4)} must not exceed ceiling ${ceiling.toFixed(4)}`,
  );
});

await check("…including the very first sample of a burst (that's the lookahead)", () => {
  const pcm = pcmMod.createPcm(1, 48000, 48000);
  pcm.channels[0].fill(0.1);
  for (let i = 24000; i < 24100; i++) pcm.channels[0][i] = 3;
  const out = dyn.limit(pcm, { ceilingDb: 0, lookaheadMs: 5 });
  assert.ok(out.channels[0][24000] <= 1.0001, `first frame of the burst was ${out.channels[0][24000].toFixed(3)}`);
});

await check("a gate silences the noise floor and passes the signal", () => {
  const pcm = pcmMod.createPcm(1, 48000, 48000);
  for (let i = 0; i < 48000; i++) {
    const loud = i > 20000 && i < 30000;
    pcm.channels[0][i] = (loud ? 0.5 : 0.001) * Math.sin((2 * Math.PI * 440 * i) / 48000);
  }
  const out = dyn.gate(pcm, { thresholdDb: -30, attackMs: 1, holdMs: 5, releaseMs: 20 });
  const quiet = dyn.measure(out, 2000, 15000);
  const loud = dyn.measure(out, 24000, 28000);
  assert.ok(quiet.peak < 0.0005, `floor should be gated, got ${quiet.peak.toFixed(6)}`);
  assert.ok(loud.peak > 0.4, `signal should pass, got ${loud.peak.toFixed(3)}`);
});

await check("measure reports peak, RMS and clipping honestly", () => {
  const m = dyn.measure(pcmConst(1, 1000, 1.5));
  assert.equal(m.clipping, true);
  closeTo(m.peak, 1.5, 1e-6);
  closeTo(m.rms, 1.5, 1e-6);
});

// ---------------------------------------------------------------------------

section("time stretch and pitch shift");

await check("stretching to 2x doubles the length", () => {
  const out = stretch.timeStretch(sine(440, 0.5, 48000), 2);
  closeTo(pcmMod.frameCount(out) / 48000, 1, 0.02);
});

await check("…without moving the pitch (that's the whole point)", () => {
  const out = stretch.timeStretch(sine(440, 1, 48000), 2);
  closeTo(measureFrequency(out), 440, 12, "a varispeed would have halved this to 220");
});

await check("shortening works the same way", () => {
  const out = stretch.timeStretch(sine(440, 1, 48000), 0.5);
  closeTo(pcmMod.frameCount(out) / 48000, 0.5, 0.02);
  closeTo(measureFrequency(out), 440, 15);
});

await check("a stretch keeps a steady level rather than fading at the edges", () => {
  // The failure this catches: forgetting to divide by the accumulated window
  // weight leaves the first and last half-grain at half level.
  const out = stretch.timeStretch(sine(440, 1, 48000, { amplitude: 0.5 }), 1.5);
  const head = pcmMod.rms({ ...out, channels: [out.channels[0].slice(2000, 6000)] });
  const middle = pcmMod.rms({ ...out, channels: [out.channels[0].slice(30000, 34000)] });
  closeTo(head, middle, 0.06, "head and middle should be the same loudness");
});

await check("pitch shifting up an octave doubles the frequency", () => {
  const out = stretch.pitchShift(sine(440, 1, 48000), 12);
  closeTo(measureFrequency(out), 880, 25);
});

await check("…and keeps the length", () => {
  const source = sine(440, 1, 48000);
  const out = stretch.pitchShift(source, 12);
  closeTo(pcmMod.frameCount(out) / 48000, 1, 0.03);
});

await check("pitch shifting down works too", () => {
  const out = stretch.pitchShift(sine(880, 1, 48000), -12);
  closeTo(measureFrequency(out), 440, 20);
});

await check("stretchToDuration hits the duration asked for", () => {
  const out = stretch.stretchToDuration(sine(440, 0.8, 48000), 1.2);
  closeTo(pcmMod.frameCount(out) / 48000, 1.2, 0.03);
});

// ---------------------------------------------------------------------------

section("space");

await check("a delay extends the buffer and puts an echo where it said it would", () => {
  const click = pcmMod.createPcm(1, 4800, 48000);
  click.channels[0][100] = 1;
  const out = space.delay(click, { timeMs: 100, feedback: 0.5, mix: 1 });
  assert.ok(pcmMod.frameCount(out) > 4800, "the tail must not be truncated");
  const echoAt = 100 + Math.round(0.1 * 48000);
  assert.ok(Math.abs(out.channels[0][echoAt]) > 0.4, `expected an echo at frame ${echoAt}`);
});

await check("…and its repeats decay rather than repeating forever at one level", () => {
  const click = pcmMod.createPcm(1, 4800, 48000);
  click.channels[0][100] = 1;
  const out = space.delay(click, { timeMs: 50, feedback: 0.5, mix: 1 });
  const step = Math.round(0.05 * 48000);
  const first = Math.abs(out.channels[0][100 + step]);
  const second = Math.abs(out.channels[0][100 + step * 2]);
  assert.ok(second < first * 0.75, `each repeat should be quieter (${first.toFixed(3)} then ${second.toFixed(3)})`);
});

await check("reverb extends the buffer and its tail decays", () => {
  const click = pcmMod.createPcm(1, 4800, 48000);
  click.channels[0][100] = 1;
  const out = space.reverb(click, { roomSize: 0.6, mix: 1 });
  assert.ok(pcmMod.frameCount(out) > 4800 * 2, "a reverb tail is longer than its input");
  const early = pcmMod.rms({ ...out, channels: [out.channels[0].slice(5000, 15000)] });
  const late = pcmMod.rms({ ...out, channels: [out.channels[0].slice(60000, 70000)] });
  assert.ok(early > 0, "there should be a tail at all");
  assert.ok(late < early, `the tail should decay (${early.toExponential(2)} then ${late.toExponential(2)})`);
});

await check("reverb output stays finite (no runaway feedback)", () => {
  const out = space.reverb(sine(440, 0.5, 48000, { amplitude: 0.7 }), { roomSize: 1, mix: 1 });
  assert.equal(Number.isFinite(pcmMod.peak(out)), true);
  assert.ok(pcmMod.peak(out) < 20, `peak ${pcmMod.peak(out)} suggests the feedback path is unstable`);
});

await check("chorus keeps the length and actually changes the signal", () => {
  const source = sine(440, 0.5, 48000, { amplitude: 0.5 });
  const out = space.modulatedDelay(source, space.CHORUS);
  assert.equal(pcmMod.frameCount(out), pcmMod.frameCount(source));
  let diff = 0;
  for (let i = 5000; i < 15000; i++) diff += Math.abs(out.channels[0][i] - source.channels[0][i]);
  assert.ok(diff > 100, "a chorus that changes nothing is not applied");
});

// ---------------------------------------------------------------------------

section("generators");

await check("a tone comes out at the frequency requested", () => {
  closeTo(measureFrequency(gen.tone(1000, 0.5, { sampleRate: 48000 })), 1000, 5);
});

await check("non-sine shapes have the right peak and period", () => {
  const square = gen.tone(500, 0.2, { wave: "square", amplitude: 0.4 });
  closeTo(pcmMod.peak(square), 0.4, 1e-6);
  closeTo(measureFrequency(square), 500, 5);
});

await check("a chirp sweeps from one frequency to the other", () => {
  const out = gen.chirp(200, 4000, 1, { sampleRate: 48000 });
  const head = { sampleRate: 48000, channels: [out.channels[0].slice(0, 8000)] };
  const tail = { sampleRate: 48000, channels: [out.channels[0].slice(40000, 48000)] };
  assert.ok(measureFrequency(head) < 700, `should start low, measured ${measureFrequency(head).toFixed(0)}Hz`);
  assert.ok(measureFrequency(tail) > 2500, `should end high, measured ${measureFrequency(tail).toFixed(0)}Hz`);
});

await check("noise is reproducible from its seed", () => {
  const a = gen.noise(0.1, { seed: 42 });
  const b = gen.noise(0.1, { seed: 42 });
  const c = gen.noise(0.1, { seed: 43 });
  assert.deepEqual([...a.channels[0].slice(0, 20)], [...b.channels[0].slice(0, 20)], "same seed, same noise");
  assert.equal(
    a.channels[0].slice(0, 20).every((v, i) => v === c.channels[0][i]),
    false,
    "a different seed must give different noise",
  );
});

await check("stereo noise is uncorrelated unless asked otherwise", () => {
  const wide = gen.noise(0.2, { channels: 2, seed: 7 });
  assert.ok(
    Math.abs(pcmMod.correlation(wide.channels[0], wide.channels[1])) < 0.15,
    "identical channels would collapse to the centre",
  );
  const mono = gen.noise(0.2, { channels: 2, seed: 7, correlated: true });
  closeTo(pcmMod.correlation(mono.channels[0], mono.channels[1]), 1, 1e-6);
});

await check("pink and brown noise really are darker than white", () => {
  // Measured, not assumed: high-passed energy relative to total should fall as
  // the spectrum tilts down.
  const brightness = (pcm) => {
    const high = filters.applyBiquad(pcm, { type: "highpass", frequency: 4000 });
    return pcmMod.rms(high) / Math.max(1e-9, pcmMod.rms(pcm));
  };
  const white = brightness(gen.noise(0.5, { colour: "white", seed: 3 }));
  const pink = brightness(gen.noise(0.5, { colour: "pink", seed: 3 }));
  const brown = brightness(gen.noise(0.5, { colour: "brown", seed: 3 }));
  assert.ok(pink < white, `pink (${pink.toFixed(3)}) should be darker than white (${white.toFixed(3)})`);
  assert.ok(brown < pink, `brown (${brown.toFixed(3)}) should be darker than pink (${pink.toFixed(3)})`);
});

// ---------------------------------------------------------------------------

section("FFT");

await check("forward then inverse returns the original", () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const original = new Float64Array(n);
  const random = gen.seededRandom(5);
  for (let i = 0; i < n; i++) original[i] = re[i] = random() * 2 - 1;
  fftMod.fft(re, im, false);
  fftMod.fft(re, im, true);
  for (let i = 0; i < n; i += 31) closeTo(re[i], original[i], 1e-9, `sample ${i}`);
});

await check("a sine lands in the bin it should", () => {
  const n = 1024;
  const sampleRate = 48000;
  const frequency = (sampleRate / n) * 64; // exactly bin 64
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  fftMod.fft(re, im, false);
  const mags = fftMod.magnitudes(re, im);
  let peakBin = 0;
  for (let i = 1; i < mags.length; i++) if (mags[i] > mags[peakBin]) peakBin = i;
  assert.equal(peakBin, 64);
});

await check("a non-power-of-two length is refused, not silently wrong", () => {
  nodeAssert.throws(() => fftMod.fft(new Float64Array(1000), new Float64Array(1000)), /power of two/);
});

// ---------------------------------------------------------------------------

section("noise reduction");

await check("a profile needs enough noise to be built from", () => {
  nodeAssert.throws(
    () => denoiseMod.captureNoiseProfile(gen.noise(0.01, { seed: 1 }), 0, 480),
    /at least/,
  );
});

await check("spectral subtraction removes hiss and keeps the tone underneath", () => {
  const sampleRate = 48000;
  const clean = sine(440, 2, sampleRate, { amplitude: 0.5 });
  const hiss = gen.noise(2, { sampleRate, amplitude: 0.05, seed: 11 });
  // First half second is noise only — the profile region.
  const noisy = pcmMod.clonePcm(clean);
  for (let i = 0; i < pcmMod.frameCount(noisy); i++) {
    noisy.channels[0][i] = (i < 24000 ? 0 : clean.channels[0][i]) + hiss.channels[0][i];
  }

  const profile = denoiseMod.captureNoiseProfile(noisy, 0, 24000);
  const out = denoiseMod.denoise(noisy, profile, { amount: 2, floorDb: -30 });

  const noiseBefore = pcmMod.rms({ ...noisy, channels: [noisy.channels[0].slice(2000, 20000)] });
  const noiseAfter = pcmMod.rms({ ...out, channels: [out.channels[0].slice(2000, 20000)] });
  assert.ok(noiseAfter < noiseBefore * 0.5, `hiss should drop (${noiseBefore.toFixed(4)} → ${noiseAfter.toFixed(4)})`);

  const toneAfter = pcmMod.rms({ ...out, channels: [out.channels[0].slice(60000, 90000)] });
  assert.ok(toneAfter > 0.25, `the tone must survive, got RMS ${toneAfter.toFixed(3)}`);
});

await check("a profile from a different sample rate is refused by name", () => {
  const profile = denoiseMod.captureNoiseProfile(gen.noise(1, { sampleRate: 48000, seed: 2 }), 0, 48000);
  nodeAssert.throws(
    () => denoiseMod.denoise(gen.noise(1, { sampleRate: 44100, seed: 2 }), profile, {}),
    /48000 Hz but this sound is 44100/,
  );
});

// ---------------------------------------------------------------------------

section("effect registry");

const fx = await import("../src/editor/audio/effects.js");

await check("every effect declares a label, a group and applies cleanly at its defaults", () => {
  const source = sine(440, 0.3, 48000, { amplitude: 0.4, channels: 2 });
  const profile = denoiseMod.captureNoiseProfile(gen.noise(1, { seed: 4 }), 0, 48000);
  for (const [id, effect] of Object.entries(fx.EFFECTS)) {
    assert.ok(effect.label, `${id} has no label`);
    assert.ok(effect.group, `${id} has no group`);
    const out = fx.applyEffect(id, source, fx.defaultParams(id), null, { noiseProfile: profile });
    assert.ok(out?.channels?.length > 0, `${id} returned nothing usable`);
    assert.equal(Number.isFinite(pcmMod.peak(out)), true, `${id} produced non-finite samples`);
  }
});

await check("an unknown effect names the ones that exist", () => {
  nodeAssert.throws(() => fx.applyEffect("nope", sine(440, 0.1, 48000), {}), /Available: /);
});

await check("out-of-range parameters are clamped, not passed through", () => {
  // A scripted caller passing ratio 0 would otherwise divide by zero deep
  // inside the compressor and blame something unrelated.
  const out = fx.applyEffect("compressor", sine(440, 0.2, 48000, { amplitude: 0.5 }), { ratio: 0, thresholdDb: -200 });
  assert.equal(Number.isFinite(pcmMod.peak(out)), true);
});

await check("noise reduction refuses to run without a profile", () => {
  nodeAssert.throws(
    () => fx.applyEffect("denoise", sine(440, 0.2, 48000), fx.defaultParams("denoise")),
    /needs a noise profile/,
  );
});

await check("whole-buffer effects ignore a selection instead of tearing at its edges", () => {
  const source = sine(440, 1, 48000);
  const whole = fx.applyEffect("tempo", source, { factor: 2 }, [0, 48000]);
  const partial = fx.applyEffect("tempo", source, { factor: 2 }, [1000, 2000]);
  assert.equal(pcmMod.frameCount(whole), pcmMod.frameCount(partial), "the range must have been ignored");
});

await check("selection-capable effects really do confine themselves to the range", () => {
  const source = pcmConst(1, 10000, 0.5);
  const out = fx.applyEffect("amplify", source, { db: -60 }, [2000, 4000]);
  assert.ok(out.channels[0][3000] < 0.01, "inside the range should be attenuated");
  closeTo(out.channels[0][8000], 0.5, 1e-6, "outside it must be untouched");
});

await check("defaults round-trip through defaultParams", () => {
  const p = fx.defaultParams("compressor");
  assert.equal(p.ratio, 4);
  assert.equal(p.autoMakeup, true);
});

await check("groups cover every effect exactly once", () => {
  const grouped = fx.effectGroups().flatMap((g) => g.items.map((i) => i.id));
  assert.equal(grouped.length, Object.keys(fx.EFFECTS).length);
  assert.equal(new Set(grouped).size, grouped.length);
});

// ---------------------------------------------------------------------------

section("Ogg container");

const ogg = await import("../src/editor/audio/ogg.js");

/**
 * A deliberately naive, table-free CRC to check the table-driven one against.
 * The table is built with bit arithmetic at module load and a wrong table
 * produces a file that is structurally perfect and plays as nothing — which
 * looks like a codec problem, not a container one, and costs an afternoon.
 */
function referenceCrc(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

const bytesOf = (...values) => Uint8Array.from(values);

await check("the table-driven Ogg CRC agrees with a bitwise reference", () => {
  for (const sample of [bytesOf(), bytesOf(0), bytesOf(1, 2, 3, 4, 5), new TextEncoder().encode("OggS test payload")]) {
    assert.equal(ogg.oggCrc32(sample), referenceCrc(sample), "table and bitwise CRC disagree");
  }
});

await check("the Ogg CRC is the unreflected variant, not the usual zlib one", () => {
  // Pinned so nobody "fixes" this to a standard CRC-32 later: Ogg uses the same
  // polynomial with no input/output reflection and no final XOR, and swapping
  // in zlib's would produce files every player rejects.
  assert.equal(ogg.oggCrc32(new TextEncoder().encode("123456789")), 0x89a1897f);
});

await check("lacing gives a 255-byte packet a trailing zero segment", () => {
  // The single most common hand-written-Ogg bug. Without the zero terminator a
  // demuxer reads a 255-byte packet as continuing into the next one, and it
  // only ever shows up on packets of exactly 255, 510, 765 … bytes.
  assert.equal(ogg.segmentsFor(254), 1);
  assert.equal(ogg.segmentsFor(255), 2);
  assert.equal(ogg.segmentsFor(256), 2);
  assert.equal(ogg.segmentsFor(510), 3);
});

await check("packets round-trip through the muxer at every awkward length", () => {
  const lengths = [0, 1, 254, 255, 256, 509, 510, 511, 1275, 4000];
  const packets = lengths.map((length, index) => ({
    data: Uint8Array.from({ length }, (_, i) => (i * 7 + index * 31) & 0xff),
    granule: (index + 1) * 960,
  }));
  const { pages } = ogg.packOggPages({ serial: 1234, packets, bos: true, eos: true });
  const joined = new Uint8Array(pages.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const page of pages) { joined.set(page, offset); offset += page.length; }

  const parsed = ogg.parseOggPages(joined);
  assert.equal(parsed.truncated, false, "a packet was left unterminated");
  assert.equal(parsed.packets.length, packets.length, "packet count changed");
  for (let i = 0; i < packets.length; i++) {
    assert.deepEqual(Array.from(parsed.packets[i]), Array.from(packets[i].data), `packet ${i} (${lengths[i]} bytes) came back different`);
  }
  assert.ok(parsed.pages.every((p) => p.crcOk), "a page CRC did not verify");
});

await check("a packet larger than one page splits and reassembles", () => {
  // 70 KB is past the 65025-byte maximum a single page can carry, so this
  // exercises the continued-page path that Opus itself never reaches — and
  // that a muxer would otherwise corrupt silently.
  const big = Uint8Array.from({ length: 70000 }, (_, i) => (i * 13) & 0xff);
  const { pages } = ogg.packOggPages({ serial: 7, packets: [{ data: big, granule: 960 }], bos: true, eos: true });
  assert.ok(pages.length >= 2, `expected a split, got ${pages.length} page(s)`);
  const joined = new Uint8Array(pages.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const page of pages) { joined.set(page, offset); offset += page.length; }
  const parsed = ogg.parseOggPages(joined);
  assert.equal(parsed.packets.length, 1);
  assert.deepEqual(Array.from(parsed.packets[0]), Array.from(big));
  assert.equal(parsed.pages[1].continued, true, "the second page must be flagged as continuing the first");
  assert.equal(parsed.pages[0].granulePosition, -1, "a page on which no packet finishes carries granule -1");
});

/** A stand-in for what `AudioEncoder` hands back: N 20 ms packets. */
const fakeOpusPackets = (count, bytes = 120) =>
  Array.from({ length: count }, (_, i) => ({
    data: Uint8Array.from({ length: bytes }, (_, j) => (i + j) & 0xff),
    frames: 960,
  }));

await check("a muxed Opus stream has the header pages the spec demands", () => {
  const file = ogg.muxOpusOgg({ packets: fakeOpusPackets(50), channels: 2, preSkip: 312, inputSampleRate: 44100 });
  assert.equal(ogg.looksLikeOgg(file), true);
  const { pages, packets } = ogg.parseOggPages(file);

  assert.equal(pages[0].bos, true, "the first page must be beginning-of-stream");
  assert.equal(pages[0].segmentSizes.length, 1, "OpusHead must be alone on the first page");
  assert.equal(new TextDecoder().decode(packets[0].subarray(0, 8)), "OpusHead");
  assert.equal(new TextDecoder().decode(packets[1].subarray(0, 8)), "OpusTags");
  assert.equal(pages[1].bos, false, "OpusTags must begin its own page, not share the BOS one");
  assert.equal(pages[pages.length - 1].eos, true, "the last page must be end-of-stream");
  assert.ok(pages.every((page, index) => page.sequence === index), "page sequence numbers must be contiguous from 0");
  assert.ok(pages.every((page) => page.crcOk), "a page CRC did not verify");
  assert.equal(packets.length, 52, "2 header packets + 50 audio packets");
});

await check("OpusHead carries the channel count, pre-skip and original rate", () => {
  const head = ogg.opusHead({ channels: 1, preSkip: 312, inputSampleRate: 22050 });
  const view = new DataView(head.buffer);
  assert.equal(head[8], 1, "version");
  assert.equal(head[9], 1, "channels");
  assert.equal(view.getUint16(10, true), 312, "pre-skip");
  // Informational, but it is the only record of what the sound was before we
  // resampled it to Opus's 48 kHz.
  assert.equal(view.getUint32(12, true), 22050, "input sample rate");
  assert.equal(head[18], 0, "mapping family");
});

await check("Ogg Opus refuses more than stereo rather than silently downmixing", () => {
  nodeAssert.throws(() => ogg.opusHead({ channels: 6 }), /mapping family 0/);
});

await check("granule positions include pre-skip and rise monotonically", () => {
  const file = ogg.muxOpusOgg({ packets: fakeOpusPackets(30), channels: 1, preSkip: 312 });
  const { pages } = ogg.parseOggPages(file);
  const audio = pages.slice(2);
  assert.equal(pages[0].granulePosition, 0, "header pages carry granule 0");
  assert.equal(pages[1].granulePosition, 0);
  for (let i = 1; i < audio.length; i++) {
    assert.ok(audio[i].granulePosition >= audio[i - 1].granulePosition, "granule went backwards");
  }
  assert.equal(audio[audio.length - 1].granulePosition, 312 + 30 * 960, "final granule must be pre-skip + total frames");
});

await check("finalGranule trims the encoder's padding, and is clamped to what exists", () => {
  // Opus encodes whole 20 ms frames, so the last one runs past the real end of
  // the sound. The final granule is what tells the decoder to stop early —
  // without it a loop gains up to 20 ms of silence at the wrap.
  const packets = fakeOpusPackets(10);
  const trimmed = ogg.parseOggPages(ogg.muxOpusOgg({ packets, channels: 1, preSkip: 312, finalGranule: 312 + 9000 }));
  const last = trimmed.pages[trimmed.pages.length - 1];
  assert.equal(last.granulePosition, 312 + 9000);

  const overshoot = ogg.parseOggPages(ogg.muxOpusOgg({ packets, channels: 1, preSkip: 312, finalGranule: 312 + 999999 }));
  const clamped = overshoot.pages[overshoot.pages.length - 1];
  assert.equal(clamped.granulePosition, 312 + 10 * 960, "asking for samples that were never encoded must clamp");
});

await check("the trim still applies when the encoder's last packet advances nothing", () => {
  // Chromium's WebCodecs encoder ends with a zero-duration chunk, so the last
  // two packets share a granule. An implementation that rewrites only the
  // final packet and floors it at the previous packet's granule finds the
  // floor already equals the untrimmed value and silently does nothing —
  // 20 ms of silence on the end of every file, which is a gap at every loop
  // wrap. Found by reading the granules out of a real encode.
  const packets = [...fakeOpusPackets(10), { data: Uint8Array.from([1, 2, 3]), frames: 0 }];
  const file = ogg.muxOpusOgg({ packets, channels: 1, preSkip: 312, finalGranule: 312 + 9000 });
  const { pages } = ogg.parseOggPages(file);
  assert.equal(pages[pages.length - 1].granulePosition, 312 + 9000, "the trim was defeated by the zero-length tail packet");
  const audioPages = pages.slice(2).map((p) => p.granulePosition);
  assert.deepEqual(audioPages, [...audioPages].sort((a, b) => a - b), "granules must stay non-decreasing");
});

await check("a stream declared shorter than one page still keeps its granules ordered", () => {
  const file = ogg.muxOpusOgg({ packets: fakeOpusPackets(200), channels: 1, preSkip: 312, finalGranule: 312 + 960 });
  const granules = ogg.parseOggPages(file).pages.slice(2).map((p) => p.granulePosition);
  assert.deepEqual(granules, [...granules].sort((a, b) => a - b));
  assert.equal(granules[granules.length - 1], 312 + 960);
});

await check("a long stream is broken into several pages, each still valid", () => {
  const file = ogg.muxOpusOgg({ packets: fakeOpusPackets(500), channels: 2 });
  const { pages } = ogg.parseOggPages(file);
  assert.ok(pages.length > 10, `expected many pages, got ${pages.length}`);
  assert.ok(pages.every((page) => page.crcOk));
  assert.ok(pages.every((page) => page.segmentSizes.length <= 255), "a page exceeded the 255-segment limit");
  assert.equal(pages.filter((page) => page.eos).length, 1, "exactly one end-of-stream page");
});

// ---------------------------------------------------------------------------

section("seamless loop");

const loopMod = await import("../src/editor/audio/loop.js");

/** Deterministic noise — a signal with no periodicity of its own to confuse a search. */
function seededNoise(seconds, sampleRate = 48000, seed = 7, { channels = 1 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const out = pcmMod.createPcm(channels, frames, sampleRate);
  let state = seed >>> 0;
  for (let i = 0; i < frames; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const value = (state / 4294967296) * 2 - 1;
    for (let c = 0; c < channels; c++) out.channels[c][i] = value * 0.4;
  }
  return out;
}

await check("the loop wrap is made of two adjacent samples of the original", () => {
  // The whole design rests on this: `out[last]` is source[bodyEnd - 1] and
  // `out[0]` is source[bodyEnd], so there is no step to click at, regardless
  // of where the loop points fell or whether they sat on a zero crossing.
  const source = seededNoise(3);
  const built = loopMod.makeSeamlessLoop(source, { loopStart: 4800, loopEnd: 96000, crossfadeSeconds: 0.2 });
  const out = built.pcm.channels[0];
  closeTo(out[out.length - 1], source.channels[0][built.loopEnd - 1], 1e-6, "last sample");
  closeTo(out[0], source.channels[0][built.loopEnd], 1e-6, "first sample");
});

await check("a loop made this way wraps far more smoothly than a plain cut", () => {
  // Tonal, not noise: white noise is *already* discontinuous sample to sample,
  // so a random cut through it happens to wrap acceptably and the comparison
  // would prove nothing. On a tone the two cases are orders of magnitude apart.
  const source = sine(137, 3, 48000, { amplitude: 0.5 });
  const cut = pcmMod.slicePcm(source, 4800, 96000);
  const built = loopMod.makeSeamlessLoop(source, { loopStart: 4800, loopEnd: 96000, crossfadeSeconds: 0.2 }).pcm;
  const cutSeam = loopMod.seamAnalysis(cut);
  const loopSeam = loopMod.seamAnalysis(built);
  assert.ok(loopSeam.clickRatio * 10 < cutSeam.clickRatio, `loop ${loopSeam.clickRatio} should beat cut ${cutSeam.clickRatio}`);
  assert.equal(loopSeam.smooth, true, `the loop's own seam should read as smooth (${JSON.stringify(loopSeam)})`);
  assert.equal(cutSeam.smooth, false, `a raw cut through a tone should not (${JSON.stringify(cutSeam)})`);
});

await check("seamAnalysis calls a quarter-cycle cut of a sine what it is", () => {
  // A quarter cycle ends on the peak while the loop restarts at zero: the wrap
  // jumps the full amplitude. An absolute threshold cannot catch this — the
  // ratio against the waveform's own step size is what does. (A HALF cycle
  // would have been a poor test: a sine's half period ends back at zero, so
  // that cut genuinely does loop cleanly.)
  const rate = 48000;
  const chopped = pcmMod.slicePcm(sine(100, 1, rate, { amplitude: 0.5 }), 0, Math.round(rate / 100 / 4));
  const analysis = loopMod.seamAnalysis(chopped);
  assert.equal(analysis.smooth, false, `expected a click, got ${JSON.stringify(analysis)}`);
  assert.ok(analysis.clickRatio > 10, `clickRatio ${analysis.clickRatio}`);
});

await check("the click measure does not shrink just because the file is long", () => {
  // The stride bug: sampling `|ch[i + stride] - ch[i]|` rather than adjacent
  // pairs made a long file's "typical step" enormous, so a real click scored
  // as clean — and only on long files, which is where nobody would look.
  // Both end a quarter cycle past a whole number of cycles, so both have the
  // same full-amplitude wrap step. Only the length differs.
  const short = pcmMod.slicePcm(sine(100, 1, 48000, { amplitude: 0.5 }), 0, 120);
  const long = pcmMod.slicePcm(sine(100, 31, 48000, { amplitude: 0.5 }), 0, 30 * 48000 + 120);
  const shortRatio = loopMod.seamAnalysis(short).clickRatio;
  const longRatio = loopMod.seamAnalysis(long).clickRatio;
  assert.ok(longRatio > shortRatio * 0.5, `a 30 s file scored ${longRatio} where a 0.0025 s one scored ${shortRatio}`);
  assert.equal(loopMod.seamAnalysis(long).smooth, false);
});

await check("the search finds a period it was given", () => {
  // Four copies of the same second: every whole-second boundary is a perfect
  // loop point, and nothing else is.
  const period = seededNoise(1, 48000, 99);
  const repeated = pcmMod.concatPcm(period, period, period, period);
  const found = loopMod.analyzeLoop(repeated, { minSeconds: 0.5, crossfadeSeconds: 0.25 });
  assert.ok(found.candidates.length > 0, found.reason ?? "no candidates");
  const best = found.candidates[0];
  const offBy = Math.abs(best.seconds - Math.round(best.seconds));
  assert.ok(offBy < 0.05, `best loop was ${best.seconds}s, expected a whole number of seconds`);
  assert.ok(best.score > 0.9, `a perfect repeat should score near 1, got ${best.score}`);
});

await check("the search says so rather than guessing when nothing is short enough", () => {
  const found = loopMod.analyzeLoop(seededNoise(0.5), { minSeconds: 5, crossfadeSeconds: 0.25 });
  assert.equal(found.candidates.length, 0);
  assert.match(found.reason, /too short/);
});

await check("the crossfade is clamped to half the loop", () => {
  const source = seededNoise(2);
  const built = loopMod.makeSeamlessLoop(source, { loopStart: 0, loopEnd: 48000, crossfadeSeconds: 10 });
  assert.ok(built.crossfadeFrames <= 24000, `crossfade ${built.crossfadeFrames} exceeds half the loop`);
});

await check("a loop that runs to the end of the sound reports that it had to shorten", () => {
  const source = seededNoise(2);
  const built = loopMod.makeSeamlessLoop(source, { loopStart: 0, loopEnd: pcmMod.frameCount(source), crossfadeSeconds: 0.25 });
  // There is no audio after the end to fade in, so the loop gives up its own
  // tail for the job. That is fine — silently returning a shorter loop than
  // was asked for without saying so would not be.
  assert.equal(built.usedTrailingAudio, false);
  assert.equal(pcmMod.frameCount(built.pcm), pcmMod.frameCount(source) - built.crossfadeFrames);
});

await check("equal-power crossfade keeps the level steady across the seam", () => {
  // Two linear fades summed dip ~3 dB in the middle, which on a loop is a hole
  // that pulses once per repeat. Measured on stationary noise, where the two
  // sides are genuinely uncorrelated and constant power is the correct rule.
  const source = seededNoise(4);
  const built = loopMod.makeSeamlessLoop(source, { loopStart: 0, loopEnd: 96000, crossfadeSeconds: 0.25 }).pcm;
  const inFade = pcmMod.rms(built, 0, 12000);
  const steady = pcmMod.rms(built, 24000, 36000);
  const differenceDb = Math.abs(20 * Math.log10(inFade / steady));
  assert.ok(differenceDb < 1.5, `crossfade region is ${differenceDb.toFixed(2)} dB off the rest of the loop`);
});

await check("autoLoop on a periodic bed returns a clean seam and its reasoning", () => {
  const period = seededNoise(1, 48000, 3);
  const result = loopMod.autoLoop(pcmMod.concatPcm(period, period, period), { minSeconds: 0.5, crossfadeSeconds: 0.2 });
  assert.ok(result.chosen, "should have chosen a candidate");
  assert.equal(result.seam.smooth, true, JSON.stringify(result.seam));
});

await check("repeatLoop lays the loop end to end", () => {
  const source = seededNoise(0.5);
  const repeated = loopMod.repeatLoop(source, 3);
  assert.equal(pcmMod.frameCount(repeated), pcmMod.frameCount(source) * 3);
  closeTo(repeated.channels[0][pcmMod.frameCount(source)], source.channels[0][0], 1e-6);
});

await check("the seamless-loop effect treats a selection as the loop region", () => {
  const source = seededNoise(4);
  const out = fx.applyEffect("seamlessLoop", source, { crossfadeMs: 200 }, [48000, 144000]);
  // 2 s selected, and there is real audio after it, so the loop keeps its full
  // length rather than eating into itself.
  closeTo(pcmMod.frameCount(out), 96000, 2, "selected region should be the loop");
});

await check("mono-ize folds to one channel", () => {
  const stereo = sine(440, 0.5, 48000, { channels: 2 });
  const out = fx.applyEffect("mono", stereo, {});
  assert.equal(out.channels.length, 1);
  assert.equal(fx.EFFECTS.mono.changesChannels, true, "callers rely on this flag to narrow the document");
});

await check("a document narrows when its only track is mono-ized", () => {
  // setTrackPcm only ever WIDENS, so without reconcileChannels the mixdown
  // writes two identical channels and the file is still stereo — the sound
  // still would not spatialise and the fix would have done nothing.
  const document_ = doc.createDocument(sine(440, 0.2, 48000, { channels: 2 }));
  assert.equal(document_.channels, 2);
  doc.setTrackPcm(document_, document_.tracks[0].id, fx.applyEffect("mono", document_.tracks[0].pcm, {}));
  assert.equal(document_.channels, 2, "setTrackPcm alone cannot narrow — that is the trap");
  doc.reconcileChannels(document_);
  assert.equal(document_.channels, 1);
  assert.equal(doc.mixdown(document_).channels.length, 1);
});

// ---------------------------------------------------------------------------

section("variations");

const variations = await import("../src/editor/audio/variations.js");

await check("the same seed always produces the same set", () => {
  const source = sine(220, 0.2, 48000, { amplitude: 0.4 });
  const a = variations.makeVariations(source, { count: 4, seed: 12 });
  const b = variations.makeVariations(source, { count: 4, seed: 12 });
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].semitones, b[i].semitones, `variation ${i} pitch`);
    assert.deepEqual(Array.from(a[i].pcm.channels[0].slice(0, 64)), Array.from(b[i].pcm.channels[0].slice(0, 64)));
  }
});

await check("a different seed produces a different set", () => {
  const source = sine(220, 0.2, 48000, { amplitude: 0.4 });
  const a = variations.makeVariations(source, { count: 4, seed: 1 });
  const b = variations.makeVariations(source, { count: 4, seed: 2 });
  assert.ok(a.some((v, i) => v.semitones !== b[i].semitones), "two seeds gave identical jitter");
});

await check("variations keep the length, so a set stays rhythmically interchangeable", () => {
  const source = sine(220, 0.4, 48000, { amplitude: 0.4 });
  const frames = pcmMod.frameCount(source);
  for (const variant of variations.makeVariations(source, { count: 6, pitchCents: 300, seed: 5 })) {
    // Varispeed would have changed this, which is exactly why pitchShift is
    // used instead — eight footsteps of eight lengths sound like a limp.
    closeTo(pcmMod.frameCount(variant.pcm), frames, 64, `variation ${variant.index}`);
  }
});

await check("jitter stays inside the range it was given", () => {
  for (const variant of variations.makeVariations(sine(220, 0.2), { count: 20, pitchCents: 150, gainDb: 2, seed: 9 })) {
    assert.ok(Math.abs(variant.semitones) <= 1.5, `pitch ${variant.semitones}`);
    assert.ok(Math.abs(variant.db) <= 2, `gain ${variant.db}`);
  }
});

await check("includeOriginal keeps the first one untouched", () => {
  const source = sine(220, 0.2, 48000, { amplitude: 0.4 });
  const set = variations.makeVariations(source, { count: 3, seed: 4, includeOriginal: true });
  assert.equal(set[0].original, true);
  assert.deepEqual(Array.from(set[0].pcm.channels[0].slice(0, 32)), Array.from(source.channels[0].slice(0, 32)));
});

await check("variation names zero-pad so they sort correctly past nine", () => {
  assert.equal(variations.variationName("step.wav", 1, 8), "step_01.wav");
  assert.equal(variations.variationName("step.wav", 10, 12), "step_10.wav");
  assert.equal(variations.variationName("step.ogg", 3, 100), "step_003.wav");
});

await check("an empty sound refuses rather than writing eight silences", () => {
  nodeAssert.throws(() => variations.makeVariations(pcmMod.createPcm(1, 0, 48000), { count: 2 }), /nothing to make variations of/);
});

// ---------------------------------------------------------------------------

section("export sizes");

const audioFileMod = await import("../src/editor/audio/encodeOpus.js");

await check("the Opus estimate is proportional to bitrate and duration", () => {
  const oneSecond = audioFileMod.estimateOpusBytes(1, 96000);
  const tenSeconds = audioFileMod.estimateOpusBytes(10, 96000);
  assert.ok(tenSeconds > oneSecond * 9 && tenSeconds < oneSecond * 11, `${oneSecond} → ${tenSeconds}`);
  assert.ok(audioFileMod.estimateOpusBytes(10, 192000) > tenSeconds * 1.8);
  // The number people actually care about: a web build's audio shrinks by
  // more than an order of magnitude.
  const wavBytes = 44 + 10 * 48000 * 2 * 3;
  assert.ok(wavBytes / tenSeconds > 10, `only ${(wavBytes / tenSeconds).toFixed(1)}x smaller than WAV`);
});

await check("Opus encoding is correctly reported as unavailable under node", () => {
  // node has no WebCodecs, and the editor must degrade to "Save as WAV" rather
  // than throwing halfway through a save.
  assert.equal(audioFileMod.opusEncodingAvailable(), false);
});

// ---------------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} audio check(s) failed`);
  process.exit(1);
}
console.log("\nall audio checks passed");
