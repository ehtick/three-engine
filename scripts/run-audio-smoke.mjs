// The audio modules, driven through the REAL editor behind the Tauri shim.
//
// `npm run test:audio` proves the DSP core and the container are correct. It
// cannot prove the thing that decides whether the feature works: that an edit
// reaches the file on disk, and — the one that would quietly destroy work —
// that a sound saved with a track stack comes BACK with those tracks the next
// time it is opened. A sidecar that writes correctly and reads back as one
// flattened track looks fine until the second editing session.
//
// It is also where the MCP/editor-API coverage for audio is exercised: the ops
// write real files, so they need a real filesystem, which `run-editor-api-smoke`
// (plain Chrome, no Tauri) does not have.
//
//   npx vite --port 5216
//   node scripts/run-audio-smoke.mjs [url]
//
// Env: HEADED=1 to watch, KEEP=1 to leave the scratch project behind,
//      SHOT=<path> to save a screenshot of the panel with an effect dialog open.
//
// START THE DEV SERVER FRESH — see run-editor-ui-smoke.mjs on Vite's `?t=`
// module twins.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { encodeWav, decodeWav } from "../src/editor/audio/wav.js";
import { createPcm } from "../src/editor/audio/pcm.js";
import { decodeAud, looksLikeAud } from "../src/editor/audio/container.js";

const url = process.argv[2] ?? "http://localhost:5216/";
const ROOT = path.join(os.tmpdir(), "audio-ui-smoke").replaceAll("\\", "/");
const MAIN = `${ROOT}/Audio/Thud.wav`;
const LAYER = `${ROOT}/Audio/Crack.wav`;
const AMBIENCE = `${ROOT}/Audio/Bed.wav`;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* scratch project: two tones and a scene to boot into                          */
/* -------------------------------------------------------------------------- */

const RATE = 48000;

function tone(freq, seconds, { amplitude = 0.5, channels = 1 } = {}) {
  const pcm = createPcm(channels, Math.round(seconds * RATE), RATE);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < pcm.channels[c].length; i++) {
      pcm.channels[c][i] = amplitude * Math.sin((2 * Math.PI * freq * i) / RATE);
    }
  }
  return pcm;
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "Audio"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "project.json"),
  JSON.stringify(
    { name: "AudioSmoke", version: 1, lastScene: "scenes/Main.scene", modules: ["audio-editor"] },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(ROOT, "scenes", "Main.scene"),
  JSON.stringify(
    {
      version: 1,
      name: "Main",
      settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
      entities: [{ id: "root", name: "Root", components: [] }],
    },
    null,
    2,
  ),
);
fs.writeFileSync(MAIN, Buffer.from(encodeWav(tone(440, 2), { bitDepth: 24 })));
fs.writeFileSync(LAYER, Buffer.from(encodeWav(tone(880, 1), { bitDepth: 24 })));

/**
 * An "ambience" with a period the loop finder must be able to recover: three
 * identical seconds of deterministic noise. The only clean loop points are the
 * whole-second boundaries, so a search that returns anything else is wrong in a
 * way a tone could not reveal (a tone loops cleanly every cycle).
 */
{
  const period = createPcm(1, RATE, RATE);
  let state = 12345;
  for (let i = 0; i < RATE; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    period.channels[0][i] = ((state / 4294967296) * 2 - 1) * 0.35;
  }
  const bed = createPcm(1, RATE * 3, RATE);
  for (let n = 0; n < 3; n++) bed.channels[0].set(period.channels[0], n * RATE);
  fs.writeFileSync(AMBIENCE, Buffer.from(encodeWav(bed, { bitDepth: 24 })));
}

const readWav = (file) => decodeWav(new Uint8Array(fs.readFileSync(file)));
const sidecarOf = (file) => `${file}.aud`;

/* -------------------------------------------------------------------------- */

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    // The editor's audio decode path uses a real AudioContext; without this,
    // headless Chrome refuses to start one and every decode of a compressed
    // file fails for a reason that has nothing to do with our code.
    "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, { writableRoot: ROOT });

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.stack ?? e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !/404|Failed to load resource/.test(m.text())) pageErrors.push(m.text());
});

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.evaluate(
  async ({ ROOT }) => {
    const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
    await useProjectStore.getState().openProject(ROOT);
    const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
    await openScenePath(`${ROOT}/scenes/Main.scene`);
  },
  { ROOT },
);
await settle(3000);

/* -------------------------------------------------------------------------- */
/* 1. the editor API / MCP ops, against real files                              */
/* -------------------------------------------------------------------------- */

console.log("\naudio ops (what an agent driving the editor can do)");

const ops = await page.evaluate(async ({ MAIN, LAYER, ROOT }) => {
  const Editor = globalThis.__editorApi;
  if (!Editor) return { fatal: "installEditorApi() never ran" };
  const out = {};
  try {
    out.info = await Editor.audio.info(MAIN);
    out.trim = await Editor.audio.edit(MAIN, "trim", { startSeconds: 0, endSeconds: 0.5 });
    out.afterTrim = await Editor.audio.info(MAIN);

    await Editor.audio.addTrack(MAIN, LAYER, { startSeconds: 0.1, gain: 0.5, pan: -0.5 });
    out.layered = await Editor.audio.tracks(MAIN);

    await Editor.audio.setTrack(MAIN, 1, { gain: 0.25, muted: true, name: "Layer" });
    out.patched = await Editor.audio.tracks(MAIN);

    await Editor.audio.removeTrack(MAIN, 1);
    out.pruned = await Editor.audio.tracks(MAIN);

    out.removeLastError = await Editor.audio
      .removeTrack(MAIN, 0)
      .then(() => null, (err) => err.message);

    out.badTrackError = await Editor.audio
      .setTrack(MAIN, 99, { gain: 1 })
      .then(() => null, (err) => err.message);

    // --- phase 2: processing ------------------------------------------------
    out.effects = await Editor.audio.effects();
    out.normalized = await Editor.audio.process(MAIN, "normalize", { targetDb: -6 });
    out.stretched = await Editor.audio.process(MAIN, "tempo", { factor: 2 });
    out.badEffect = await Editor.audio
      .process(MAIN, "not-an-effect", {})
      .then(() => null, (err) => err.message);
    out.denoiseWithoutProfile = await Editor.audio
      .process(MAIN, "denoise", {})
      .then(() => null, (err) => err.message);

    out.generated = await Editor.audio.generate(`${ROOT}/Audio/Wind.wav`, "noise", {
      seconds: 0.5, colour: "pink", seed: 3, channels: 2,
    });
    out.generatedInfo = await Editor.audio.info(out.generated.path);
  } catch (err) {
    out.fatal = `${err.message}\n${err.stack ?? ""}`;
  }
  return out;
}, { MAIN, LAYER, ROOT });

if (ops.fatal) {
  console.log(`  FAIL audio ops threw — ${ops.fatal}`);
  failed++;
} else {
  check(
    "audio.info reports rate, duration, channels and writability",
    ops.info.sampleRate === RATE &&
      Math.abs(ops.info.durationSeconds - 2) < 0.05 &&
      ops.info.channels === 1 &&
      ops.info.writableInPlace === true,
    JSON.stringify(ops.info),
  );
  check(
    "a never-edited file reports one track and no saved stack",
    ops.info.hasTrackStack === false && ops.info.trackCount === 1,
  );
  check(
    "audio.edit trim shortens the file on disk",
    Math.abs(ops.afterTrim.durationSeconds - 0.5) < 0.05,
    `${ops.trim.durationBefore}s → ${ops.trim.durationAfter}s`,
  );
  check("editing a WAV saves in place", ops.trim.savedInPlace === true);
  // Read from node's side of the filesystem, so this is independent of anything
  // the editor reports about itself. Compared against the LAST op's reported
  // duration rather than a literal, so adding an op below can't silently
  // invalidate it — the invariant is "what the ops claim is what's on disk".
  const onDisk = readWav(MAIN).channels[0].length / RATE;
  check(
    "what the ops report is what's actually in the file on disk",
    Math.abs(onDisk - (ops.stretched?.durationAfter ?? -1)) < 0.05,
    `disk ${onDisk.toFixed(3)}s vs reported ${ops.stretched?.durationAfter}s`,
  );
  check("the track stack persists as a sidecar", ops.afterTrim.hasTrackStack === true);
  check("audio.addTrack layers a second sound at an offset", ops.layered.tracks.length === 2 && Math.abs(ops.layered.tracks[1].startSeconds - 0.1) < 0.02);
  check(
    "audio.setTrack round-trips gain, mute and name",
    ops.patched.tracks[1].gain === 0.25 && ops.patched.tracks[1].muted === true && ops.patched.tracks[1].name === "Layer",
  );
  check("audio.removeTrack drops the track", ops.pruned.tracks.length === 1);
  check("removing the last track is refused", /at least one track/i.test(ops.removeLastError ?? ""));
  check("an out-of-range track index is refused by name", /no track 99/i.test(ops.badTrackError ?? ""), ops.badTrackError ?? "");

  console.log("\naudio processing (phase 2)");
  const allEffects = (ops.effects?.groups ?? []).flatMap((g) => g.effects);
  check("audio.effects describes every effect with its parameters", allEffects.length >= 15, `${allEffects.length} effects`);
  check(
    "…including ranges and units, so a caller doesn't have to guess",
    allEffects.every((e) => Object.values(e.params).every((p) => p.type !== "number" || (p.min != null && p.max != null))),
  );
  check(
    "audio.process normalize hits the target and reports the peak",
    Math.abs((ops.normalized?.peakDbAfter ?? -99) - -6) < 0.2,
    `peak after: ${ops.normalized?.peakDbAfter}dB`,
  );
  check(
    "audio.process time-stretch doubles the duration",
    Math.abs((ops.stretched?.durationAfter ?? 0) - (ops.stretched?.durationBefore ?? 0) * 2) < 0.05,
    `${ops.stretched?.durationBefore}s → ${ops.stretched?.durationAfter}s`,
  );
  check("an unknown effect names the ones that exist", /Available: /.test(ops.badEffect ?? ""), ops.badEffect ?? "");
  check(
    "noise reduction refuses without a profile region",
    /noiseProfileFrom|noise profile/i.test(ops.denoiseWithoutProfile ?? ""),
    ops.denoiseWithoutProfile ?? "",
  );
  check(
    "audio.generate writes a real file the editor can read back",
    ops.generatedInfo?.channels === 2 && Math.abs((ops.generatedInfo?.durationSeconds ?? 0) - 0.5) < 0.02,
    JSON.stringify(ops.generatedInfo ?? {}),
  );
  check("…and it exists on disk", fs.existsSync(path.join(ROOT, "Audio", "Wind.wav")));
}

/* -------------------------------------------------------------------------- */
/* 2. the sidecar, from node's side of the filesystem                           */
/* -------------------------------------------------------------------------- */

console.log("\nthe .aud sidecar (the second-session property)");

check("a sidecar was written beside the audio file", fs.existsSync(sidecarOf(MAIN)));
if (fs.existsSync(sidecarOf(MAIN))) {
  const bytes = new Uint8Array(fs.readFileSync(sidecarOf(MAIN)));
  check("…and it is a real container, not JSON", looksLikeAud(bytes));
  const restored = decodeAud(bytes);
  check("…that decodes outside the editor entirely", restored.tracks.length === 1 && restored.sampleRate === RATE);
  check(
    "…carrying the samples, not just the mix settings",
    restored.tracks[0].pcm.channels[0].some((v) => Math.abs(v) > 0.1),
  );
}

/* -------------------------------------------------------------------------- */
/* 3. the panel, opened on a real file                                          */
/* -------------------------------------------------------------------------- */

console.log("\nthe Audio Editor panel");

await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("audioEditor");
});
const panelAppeared = await page
  .waitForSelector(".audio-editor", { timeout: 30000 })
  .then(() => true, () => false);
check("the panel mounts", panelAppeared);

if (panelAppeared) {
  await settle(800);
  // The empty state lists the project's audio; clicking one opens it.
  const opened = await page.evaluate(async () => {
    const button = [...document.querySelectorAll(".aud-filelist button")].find((b) => /Thud/.test(b.textContent));
    if (!button) return { found: false, files: document.querySelectorAll(".aud-filelist button").length };
    button.click();
    return { found: true };
  });
  check("the empty state lists the project's audio files", opened.found === true, JSON.stringify(opened));

  if (opened.found) {
    const laneAppeared = await page
      .waitForSelector(".aud-lane canvas", { timeout: 20000 })
      .then(() => true, () => false);
    check("opening a sound draws a waveform lane", laneAppeared);

    if (laneAppeared) {
      await settle(700);
      const state = await page.evaluate(() => {
        const canvas = document.querySelector(".aud-lane canvas");
        const ctx = canvas.getContext("2d");
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
        return {
          painted,
          pixels: data.length / 4,
          heads: document.querySelectorAll(".aud-head").length,
          meta: document.querySelector(".aud-meta")?.textContent ?? "",
        };
      });
      // A blank canvas is exactly what a broken peaks path produces, and it
      // looks like "an empty sound" rather than like a bug.
      check("…that has actually been painted", state.painted > state.pixels * 0.01, `${state.painted}/${state.pixels} px`);
      check("…with one track head", state.heads === 1, `${state.heads} heads`);
      check("…and the file's real properties in the sub-bar", /48000 Hz/.test(state.meta) && /mono/.test(state.meta), state.meta);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 4. the effect dialog, and the preview loop it must not have                  */
/* -------------------------------------------------------------------------- */

if (panelAppeared) {
  console.log("\nthe effect dialog");

  const opened = await page.evaluate(() => {
    const menu = [...document.querySelectorAll(".aud-btn")].find((b) => /Effects/.test(b.textContent));
    if (!menu) return { found: false };
    menu.click();
    return { found: true };
  });
  check("the Effects menu opens", opened.found === true);

  if (opened.found) {
    await settle(250);
    const picked = await page.evaluate(() => {
      const item = [...document.querySelectorAll(".aud-menu-item")].find((b) => /^Compressor/.test(b.textContent));
      if (!item) return { found: false, items: document.querySelectorAll(".aud-menu-item").length };
      item.click();
      return { found: true };
    });
    check("…and an effect opens its dialog", picked.found === true, JSON.stringify(picked));

    if (picked.found) {
      const dialogAppeared = await page.waitForSelector(".aud-dialog", { timeout: 10000 }).then(() => true, () => false);
      check("the dialog renders", dialogAppeared);

      if (dialogAppeared) {
        await settle(400);
        const built = await page.evaluate(() => ({
          params: document.querySelectorAll(".aud-param").length,
          title: document.querySelector(".aud-dialog-title")?.textContent,
        }));
        check("…generated from the registry descriptor", built.params >= 5, `${built.params} parameters`);
        check("…titled for the effect", built.title === "Compressor", built.title ?? "");

        // THE check. Previewing writes to the document, which re-renders the
        // panel, which hands the dialog a fresh onPreview — if that re-runs the
        // preview, it loops forever and each pass compounds on the last. Both
        // symptoms are invisible in a screenshot, so measure instead: the
        // waveform must settle and stay settled.
        const sample = async () =>
          page.evaluate(() => {
            const c = document.querySelector(".aud-lane canvas");
            const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
            let painted = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
            return painted;
          });
        const first = await sample();
        await settle(1800);
        const second = await sample();
        await settle(1800);
        const third = await sample();
        check(
          "previewing settles instead of looping forever",
          first === second && second === third,
          `painted px over 3.6s: ${first} → ${second} → ${third}`,
        );

        // Cancel must put back exactly what was there before the dialog.
        const restored = await page.evaluate(async () => {
          const before = document.querySelector(".aud-peak")?.textContent ?? null;
          document.querySelector(".aud-dialog-close")?.click();
          await new Promise((r) => setTimeout(r, 400));
          return { before, after: document.querySelector(".aud-peak")?.textContent ?? null, gone: !document.querySelector(".aud-dialog") };
        });
        check("cancel closes the dialog", restored.gone === true);
        check("…and restores the pre-dialog audio", restored.before !== restored.after || restored.before === null, `${restored.before} → ${restored.after}`);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 4b. the export menu — sizes on screen BEFORE choosing a format               */
/* -------------------------------------------------------------------------- */

if (panelAppeared) {
  console.log("\nthe export menu");
  const exportMenu = await page.evaluate(async () => {
    const button = [...document.querySelectorAll(".aud-btn")].find((b) => /Export/.test(b.textContent));
    if (!button) return { found: false };
    button.click();
    await new Promise((r) => setTimeout(r, 250));
    const items = [...document.querySelectorAll(".aud-menu.right .aud-menu-item")].map((b) => b.textContent);
    const note = document.querySelector(".aud-menu.right .aud-menu-note")?.textContent ?? "";
    document.querySelector(".aud-menu-scrim")?.click();
    return { found: true, items, note };
  });
  check("the Export menu opens", exportMenu.found === true);
  check(
    "…offering Opus bitrates and WAV depths",
    (exportMenu.items ?? []).some((t) => /kbps/.test(t)) && (exportMenu.items ?? []).some((t) => /24-bit/.test(t)),
    JSON.stringify(exportMenu.items ?? []),
  );
  // Audio is usually the largest thing in a web build and nothing else in the
  // editor says so. A size that renders as NaN or 0 KB is worse than none.
  check(
    "…each priced before it is chosen",
    (exportMenu.items ?? []).every((t) => /\d+(\.\d+)?\s*(KB|MB)/.test(t)),
    JSON.stringify(exportMenu.items ?? []),
  );
}

/* -------------------------------------------------------------------------- */
/* 5. phase 3 — Ogg/Opus, the loop maker, variations                            */
/*                                                                              */
/* The Ogg muxer is proved under node by `npm run test:audio`. What node cannot  */
/* prove is the half that needs a browser: that WebCodecs' packets, wrapped in   */
/* our pages, produce a file the browser itself will decode back — and that it   */
/* comes back ALIGNED. Pre-skip is a number the encoder does not report; if it   */
/* is wrong the sound is silently shifted by a few milliseconds, which no        */
/* structural check can catch. So it is measured here rather than trusted.       */
/* -------------------------------------------------------------------------- */

console.log("\nOgg/Opus encoding (phase 3)");

const opus = await page.evaluate(async () => {
  const encodeMod = await globalThis.__importLive("/src/editor/audio/encodeOpus.js");
  const oggMod = await globalThis.__importLive("/src/editor/audio/ogg.js");
  const decodeMod = await globalThis.__importLive("/src/editor/audio/decode.js");
  const out = { available: encodeMod.opusEncodingAvailable() };
  if (!out.available) return out;

  const RATE = 48000;
  const frames = RATE; // exactly one second

  // A chirp, not a tone and not noise: a tone's autocorrelation repeats every
  // cycle so the alignment peak would be ambiguous, and Opus codes noise
  // parametrically so its waveform would not survive to be correlated at all.
  // A sweep has one unmistakable peak and lives in the range Opus reproduces
  // waveform-accurately.
  const source = { sampleRate: RATE, channels: [new Float32Array(frames)] };
  let phase = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    phase += (2 * Math.PI * (200 + t * 1800)) / RATE;
    source.channels[0][i] = 0.5 * Math.sin(phase);
  }

  try {
    const bytes = await encodeMod.encodeOpusOgg(source, { bitrate: 128000 });
    out.bytes = bytes.byteLength;
    out.looksLikeOgg = oggMod.looksLikeOgg(bytes);
    const parsed = oggMod.parseOggPages(bytes);
    out.pages = parsed.pages.length;
    out.allCrcOk = parsed.pages.every((p) => p.crcOk);
    // What the container itself claims the length is — the number the decoder
    // is supposed to trim to, and does not.
    out.declared = oggMod.opusStreamInfo(bytes);
    out.granules = parsed.pages.map((p) => p.granulePosition);
    out.packetCount = parsed.packets.length;

    // The real test: hand it back to the browser's own decoder.
    const decoded = await decodeMod.decodeAudioBytes(bytes);
    out.decodedRate = decoded.sampleRate;
    out.decodedFrames = decoded.channels[0].length;
    out.decodedChannels = decoded.channels.length;

    if (decoded.sampleRate === RATE) {
      // Cross-correlate against the original to find how far the decoded audio
      // has moved. A pre-skip that is not declared at all shows up here as a
      // ~312-sample shift; nothing structural would have noticed.
      const a = source.channels[0];
      const b = decoded.channels[0];
      const window = 20000;
      const offset = 10000;
      let bestLag = 0;
      let best = -Infinity;
      for (let lag = -1500; lag <= 1500; lag++) {
        let sum = 0;
        for (let i = 0; i < window; i += 2) {
          const j = offset + i + lag;
          if (j < 0 || j >= b.length) continue;
          sum += a[offset + i] * b[j];
        }
        if (sum > best) { best = sum; bestLag = lag; }
      }
      out.lagSamples = bestLag;
      out.lagMs = Math.round((bestLag / RATE) * 10000) / 10;
    }
  } catch (err) {
    out.error = err.message ?? String(err);
  }
  return out;
});

check("this browser has a WebCodecs Opus encoder", opus.available === true);
if (opus.available && !opus.error) {
  check("encoding produces a well-formed Ogg stream", opus.looksLikeOgg === true && opus.allCrcOk === true, `${opus.pages} pages, ${opus.bytes} bytes`);
  check(
    "…that is far smaller than the WAV it came from",
    opus.bytes > 0 && opus.bytes < 48000 * 3 * 0.35,
    `${opus.bytes} bytes vs ${48000 * 3} for 24-bit WAV`,
  );
  // A file our muxer wrote that the browser refuses to decode is the whole
  // failure mode this exists to rule out — and it looks like nothing at all.
  check("the browser decodes our own container back", opus.decodedFrames > 0, JSON.stringify({ frames: opus.decodedFrames, rate: opus.decodedRate }));
  // Tight on purpose. This started at 47688 — exactly 312 frames short, the
  // encoder's lookahead being lost off the END because flush() does not push
  // the pipeline's tail out. A loose tolerance here would have hidden it, and
  // 6.5 ms missing from the end of a loop is a gap at every wrap.
  check(
    "…at the right length, so nothing was lost off the end",
    Math.abs((opus.decodedFrames ?? 0) - 48000) <= 48,
    // The granules are printed because they are what diagnoses a failure here:
    // a trim that did not apply shows up as a final granule past the declared
    // length, and nothing else in the output would say so.
    `decoded ${opus.decodedFrames}, container declares ${opus.declared?.frames}, page granules ${JSON.stringify(opus.granules)}`,
  );
  if (opus.lagSamples !== undefined) {
    check(
      "…and in the right place, so the declared pre-skip is right",
      Math.abs(opus.lagSamples) <= 96,
      `decoded audio sits ${opus.lagSamples} samples (${opus.lagMs} ms) from the original`,
    );
  } else {
    console.log(`  note  alignment not measured — the AudioContext runs at ${opus.decodedRate} Hz, not 48000`);
  }
} else if (opus.error) {
  check("Opus encoding does not throw", false, opus.error);
}

console.log("\nthe phase-3 ops");

const phase3 = await page.evaluate(async ({ MAIN, AMBIENCE, ROOT }) => {
  const Editor = globalThis.__editorApi;
  const out = {};
  try {
    out.estimate = await Editor.audio.export(MAIN, { format: "ogg", estimateOnly: true });
    out.exported = await Editor.audio.export(MAIN, { format: "ogg", bitrate: 96000 });
    out.oggInfo = await Editor.audio.info(out.exported.path);
    // THE headline fix: before this, editing a .ogg wrote a sibling .wav.
    out.oggEdit = await Editor.audio.edit(out.exported.path, "trim", { startSeconds: 0, endSeconds: 0.3 });
    out.oggAfter = await Editor.audio.info(out.exported.path);

    out.analysis = await Editor.audio.loop(AMBIENCE, { analyzeOnly: true, minSeconds: 0.5, crossfadeSeconds: 0.2 });
    out.looped = await Editor.audio.loop(AMBIENCE, { minSeconds: 0.5, crossfadeSeconds: 0.2 });

    out.variations = await Editor.audio.variations(`${ROOT}/Audio/Crack.wav`, { count: 4, seed: 3 });
    out.monoed = await Editor.audio.process(`${ROOT}/Audio/Wind.wav`, "mono", {});
  } catch (err) {
    out.fatal = `${err.message}\n${err.stack ?? ""}`;
  }
  return out;
}, { MAIN, AMBIENCE, ROOT });

if (phase3.fatal) {
  check("the phase-3 ops run", false, phase3.fatal);
} else {
  check(
    "audio.export prices Ogg against WAV before writing anything",
    phase3.estimate?.estimate === true && phase3.estimate.timesSmallerThanWav > 8,
    `${phase3.estimate?.timesSmallerThanWav}x smaller`,
  );
  check(
    "audio.export writes a real .ogg and reports its size",
    phase3.exported?.bytes > 0 && phase3.exported.format === "ogg",
    JSON.stringify(phase3.exported ?? {}),
  );
  const oggOnDisk = phase3.exported?.path?.replace(/^.*Audio\//, "");
  check("…and it exists on disk, starting with OggS", (() => {
    if (!oggOnDisk) return false;
    const file = path.join(ROOT, "Audio", oggOnDisk);
    if (!fs.existsSync(file)) return false;
    const head = fs.readFileSync(file).subarray(0, 4).toString("latin1");
    return head === "OggS";
  })(), oggOnDisk ?? "");
  check("audio.info reads the .ogg back with the right duration", Math.abs((phase3.oggInfo?.durationSeconds ?? 0) - (phase3.exported?.durationSeconds ?? -1)) < 0.05, JSON.stringify(phase3.oggInfo ?? {}));
  // The whole point of the phase: a Freesound import is a .ogg, and until now
  // editing one could not save in place.
  check("an .ogg now reports itself as writable in place", phase3.oggInfo?.writableInPlace === true);
  check("…and editing one really does save in place", phase3.oggEdit?.savedInPlace === true, JSON.stringify(phase3.oggEdit ?? {}));
  check("…with the edit surviving a re-decode of the .ogg", Math.abs((phase3.oggAfter?.durationSeconds ?? 0) - 0.3) < 0.05, `${phase3.oggAfter?.durationSeconds}s`);

  const best = phase3.analysis?.candidates?.[0];
  check(
    "audio.loop finds the period it was given",
    best && Math.abs(best.loopLengthSeconds - Math.round(best.loopLengthSeconds)) < 0.05 && best.score > 0.9,
    JSON.stringify(best ?? phase3.analysis ?? {}),
  );
  check(
    "…and applying it leaves a seam that measures as clean",
    phase3.looped?.seam?.smooth === true,
    JSON.stringify(phase3.looped?.seam ?? {}),
  );
  check(
    "…using the audio that really followed the loop point",
    phase3.looped?.usedTrailingAudio === true,
    `usedTrailingAudio: ${phase3.looped?.usedTrailingAudio}`,
  );

  check("audio.variations writes a numbered set", phase3.variations?.count === 4, JSON.stringify(phase3.variations?.files?.map((f) => f.path.split("/").pop()) ?? []));
  check(
    "…as real, differently-pitched files on disk",
    (phase3.variations?.files ?? []).every((f) => fs.existsSync(f.path)) &&
      new Set((phase3.variations?.files ?? []).map((f) => f.semitones)).size > 1,
  );
  check("…zero-padded so they sort correctly", fs.existsSync(path.join(ROOT, "Audio", "Crack_01.wav")));
  // setTrackPcm only widens, so without reconcileChannels this reports 2 and
  // the file stays stereo — and a stereo file does not spatialise at all.
  check(
    "mono-ize really narrows the document, not just the track",
    phase3.monoed?.channelsAfter === 1 && phase3.monoed?.channelsBefore === 2,
    JSON.stringify({ before: phase3.monoed?.channelsBefore, after: phase3.monoed?.channelsAfter }),
  );
  check(
    "…and the file on disk is mono afterwards",
    readWav(path.join(ROOT, "Audio", "Wind.wav")).channels.length === 1,
  );
}

/* -------------------------------------------------------------------------- */

if (process.env.SHOT) {
  await page.evaluate(() => {
    const menu = [...document.querySelectorAll(".aud-btn")].find((b) => /Effects/.test(b.textContent));
    menu?.click();
  });
  await settle(250);
  await page.evaluate(() => {
    [...document.querySelectorAll(".aud-menu-item")].find((b) => /^Reverb/.test(b.textContent))?.click();
  });
  await settle(1200);
  const el = await page.$(".audio-editor");
  if (el) await el.screenshot({ path: process.env.SHOT });
}

const realErrors = pageErrors.filter((e) => !/ResizeObserver|WebGPU|GPUDevice/i.test(e));
check("no uncaught page errors", realErrors.length === 0, realErrors.slice(0, 2).join(" | "));

await browser.close();
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\nAUDIO-SMOKE ${failed === 0 ? "PASS" : "FAIL"} — ${passed}/${passed + failed} checks`);
process.exit(failed === 0 ? 0 : 1);
