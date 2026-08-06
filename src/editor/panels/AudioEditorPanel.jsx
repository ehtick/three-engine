import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioWaveform, Copy, Clipboard, Layers, Loader2, Package, Play, Plus, Redo2, Repeat,
  Save, Scissors, Shuffle, Square, Trash2, Undo2, Volume2, VolumeX, ZoomIn, ZoomOut,
} from "lucide-react";
import { useModulesStore, setModuleEnabled } from "../modules.js";
import { useProjectStore } from "../store/projectStore.js";
import { AUDIO_EXTENSIONS, listProjectEntries, withoutSidecars, extOf } from "../assetLoader.js";
import {
  openAudioDocument, saveAudioDocument, saveAsWav, canWriteInPlace,
  exportDocument, estimateDocumentBytes,
} from "../audioFile.js";
import { OPUS_BITRATES, opusEncodingAvailable } from "../audio/encodeOpus.js";
import { seamAnalysis } from "../audio/loop.js";
import { makeVariations, variationName } from "../audio/variations.js";
import * as doc from "../audio/auddoc.js";
import * as edits from "../audio/edits.js";
import { frameCount, peak } from "../audio/pcm.js";
import { buildPeaks, columnPeaks } from "../audio/peaks.js";
import { createPlayer } from "../audio/playback.js";
import { decodeAudioBytes } from "../audio/decode.js";
import * as historyMod from "../audio/history.js";
import { applyEffect, EFFECTS, effectGroups } from "../audio/effects.js";
import { captureNoiseProfile } from "../audio/denoise.js";
import { AudioEffectDialog } from "./AudioEffectDialog.jsx";
import { usePanelVisible } from "../usePanelVisible.js";

const HEAD_WIDTH = 168;
const LANE_HEIGHT = 76;

const formatBytes = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "0:00.000";
  const m = Math.floor(Math.abs(seconds) / 60);
  const s = Math.abs(seconds) % 60;
  return `${seconds < 0 ? "-" : ""}${m}:${s.toFixed(3).padStart(6, "0")}`;
};

/**
 * The Audio Editor: a multitrack waveform editor over one document.
 *
 * Three things about the implementation are load-bearing and easy to undo by
 * accident:
 *
 *  1. **The document lives in a ref, never in state.** A two-minute stereo
 *     track is 20 MB; putting it in `useState` means React holds it across
 *     renders and a drag that touched it would re-render the tree per frame.
 *     Structural changes bump a `version` counter instead, which is what the
 *     canvases repaint against.
 *  2. **Waveform peaks are cached per track.** Redrawing from raw samples on
 *     every scroll would read millions of samples per frame; `peaks.js` builds
 *     a min/max summary once per edit and the lanes read columns from it.
 *  3. **The playhead is animated from the audio clock**, not a timer, so it
 *     points at the sample you're actually hearing.
 */
export function AudioEditorPanel({ api } = {}) {
  // Hidden means idle, NOT unmounted: the open document lives in a ref here and
  // may hold unsaved edits, so throwing the panel away on a tab switch would
  // lose work. Stopping playback and its animation frame is the part that costs
  // something while nobody is looking.
  const visible = usePanelVisible(api);
  const moduleOn = useModulesStore((s) => s.enabled.includes("audio-editor"));
  const rootPath = useProjectStore((s) => s.rootPath);

  const docRef = useRef(null);
  const historyRef = useRef(historyMod.createHistory());
  const peaksRef = useRef(new Map()); // trackId -> peaks
  const clipboardRef = useRef(null);
  const playerRef = useRef(null);
  const [version, setVersion] = useState(0);

  const [path, setPath] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [files, setFiles] = useState([]);

  const [view, setView] = useState({ start: 0, end: 1 }); // visible frame range
  const [selection, setSelection] = useState(null); // { start, end } frames
  const [activeTrack, setActiveTrack] = useState(null);
  const [playhead, setPlayhead] = useState(0); // seconds
  const [playing, setPlaying] = useState(false);
  const [loopSelection, setLoopSelection] = useState(false);
  const [activeEffect, setActiveEffect] = useState(null);
  const [effectMenuOpen, setEffectMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const effectSnapshotRef = useRef(null);
  const noiseProfileRef = useRef(null);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  if (!playerRef.current && typeof window !== "undefined") playerRef.current = createPlayer();

  // ---- file list -----------------------------------------------------------

  useEffect(() => {
    if (!moduleOn || !rootPath) return;
    let alive = true;
    listProjectEntries(rootPath, 8).then((entries) => {
      if (!alive) return;
      const audio = withoutSidecars(entries).filter(
        (e) => !e.is_dir && AUDIO_EXTENSIONS.includes(extOf(e.name)) && extOf(e.name) !== "audio",
      );
      setFiles(audio.map((e) => ({ path: e.path.replaceAll("\\", "/"), name: e.name })));
    }, () => {});
    return () => { alive = false; };
  }, [moduleOn, rootPath, version]);

  // ---- open / save ---------------------------------------------------------

  const invalidatePeaks = useCallback((trackId) => {
    if (trackId) peaksRef.current.delete(trackId);
    else peaksRef.current.clear();
  }, []);

  const open = useCallback(async (target) => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await openAudioDocument(target);
      docRef.current = result.doc;
      historyRef.current = historyMod.createHistory();
      invalidatePeaks();
      setPath(result.path);
      setSelection(null);
      setActiveTrack(result.doc.tracks[0]?.id ?? null);
      setPlayhead(0);
      setDirty(false);
      setView({ start: 0, end: Math.max(1, doc.documentFrameCount(result.doc)) });
      setStatus(
        result.fileChangedOutside
          ? `${result.doc.tracks.length} track(s) restored — note the file on disk has changed since it was last saved here.`
          : result.fromSidecar
            ? `Opened ${result.doc.tracks.length} track(s) from the saved stack.`
            : null,
      );
      bump();
    } catch (err) {
      setStatus(err.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [bump, invalidatePeaks]);

  const save = useCallback(async (asWav = false) => {
    if (!docRef.current || !path) return;
    setBusy(true);
    try {
      const result = asWav || !canWriteInPlace(path)
        ? await saveAsWav(path, docRef.current)
        : await saveAudioDocument(path, docRef.current, {
            // An Opus encode of a long ambience takes seconds. A Save button
            // that just sits there reads as a hang, and the panel has nowhere
            // else to say what it's doing.
            onProgress: (fraction) => setStatus(`Encoding… ${Math.round(fraction * 100)}%`),
          });
      if (result.path !== path) setPath(result.path);
      setDirty(false);
      setStatus(
        result.wroteAudio
          ? `Saved ${result.path.split("/").pop()}${result.bytes ? ` — ${formatBytes(result.bytes)}` : ""}`
          : result.reason,
      );
      bump();
    } catch (err) {
      setStatus(err.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [path, bump]);

  /**
   * Write the mixdown out in another format.
   *
   * Ogg/Opus is the one that matters: audio is usually the largest thing in a
   * web build and nothing else in the editor says so, which is why the menu
   * shows the size each option would produce *before* it is chosen.
   */
  const exportAs = useCallback(async (format, options = {}) => {
    if (!docRef.current || !path) return;
    setExportOpen(false);
    setBusy(true);
    try {
      const target = path.replace(/\.[a-z0-9]+$/i, `.${format}`);
      const result = await exportDocument(docRef.current, target, {
        ...options,
        onProgress: (fraction) => setStatus(`Encoding… ${Math.round(fraction * 100)}%`),
      });
      setStatus(`Exported ${result.path.split("/").pop()} — ${formatBytes(result.bytes)}`);
      bump();
    } catch (err) {
      setStatus(err.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [path, bump]);

  /**
   * One footstep becomes eight. Written as siblings rather than into the open
   * document, because the point of a variation set is that it's a *set* of
   * files a SoundComponent picks between at random.
   */
  const writeVariations = useCallback(async (count = 8) => {
    const track = activeTrack ? doc.findTrack(docRef.current, activeTrack) : null;
    if (!track || !path) return;
    setEffectMenuOpen(false);
    setBusy(true);
    try {
      const { encodeWav } = await import("../audio/wav.js");
      const { writeBinaryFile } = await import("../assetLoader.js");
      const directory = path.slice(0, path.lastIndexOf("/"));
      const base = path.split("/").pop();
      const variants = makeVariations(track.pcm, { count });
      for (const variant of variants) {
        await writeBinaryFile(`${directory}/${variationName(base, variant.index, count)}`, encodeWav(variant.pcm, { bitDepth: 24 }));
      }
      await useProjectStore.getState().refresh();
      setStatus(`Wrote ${variants.length} variations beside ${base}.`);
      bump();
    } catch (err) {
      setStatus(err.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [activeTrack, path, bump]);

  // ---- editing -------------------------------------------------------------

  /**
   * The single funnel every destructive operation goes through: snapshot for
   * undo, apply, invalidate that track's peaks, mark dirty, repaint. Ops that
   * skipped any one of these steps is how a tool ends up with an undo stack
   * that's subtly out of sync with what's on screen.
   */
  const runEdit = useCallback((label, fn, { trackId = activeTrack } = {}) => {
    const document_ = docRef.current;
    const track = trackId ? doc.findTrack(document_, trackId) : null;
    if (!document_ || !track) return;
    historyMod.pushHistory(historyRef.current, document_, label);
    const next = fn(track.pcm, track);
    if (next) doc.setTrackPcm(document_, track.id, next);
    invalidatePeaks(track.id);
    setDirty(true);
    bump();
  }, [activeTrack, bump, invalidatePeaks]);

  const withSelection = useCallback((fn) => {
    const document_ = docRef.current;
    const track = activeTrack ? doc.findTrack(document_, activeTrack) : null;
    if (!track) return null;
    // No selection means "the whole track" — the same convention Audacity uses
    // and the one that makes a one-click Normalise or Fade actually work.
    const range = selection ?? { start: 0, end: frameCount(track.pcm) };
    return fn(track, range);
  }, [activeTrack, selection]);

  const doCopy = useCallback(() => {
    withSelection((track, range) => {
      clipboardRef.current = edits.copyRange(track.pcm, range.start, range.end);
      setStatus(`Copied ${(frameCount(clipboardRef.current) / track.pcm.sampleRate).toFixed(2)}s`);
    });
  }, [withSelection]);

  const doCut = useCallback(() => {
    withSelection((track, range) => {
      clipboardRef.current = edits.copyRange(track.pcm, range.start, range.end);
      runEdit("Cut", (pcm) => edits.deleteRange(pcm, range.start, range.end));
      setSelection(null);
    });
  }, [withSelection, runEdit]);

  const doPaste = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip) { setStatus("Nothing copied yet."); return; }
    withSelection((track, range) => {
      runEdit("Paste", (pcm) =>
        range.start === range.end
          ? edits.insertAt(pcm, range.start, clip)
          : edits.replaceRange(pcm, range.start, range.end, clip));
    });
  }, [withSelection, runEdit]);

  const doDelete = useCallback(() => {
    withSelection((track, range) => {
      runEdit("Delete", (pcm) => edits.deleteRange(pcm, range.start, range.end));
      setSelection(null);
    });
  }, [withSelection, runEdit]);

  const doSilence = useCallback(() => {
    withSelection((track, range) => runEdit("Silence", (pcm) => edits.silenceRange(pcm, range.start, range.end)));
  }, [withSelection, runEdit]);

  const doTrim = useCallback(() => {
    withSelection((track, range) => {
      runEdit("Trim", (pcm) => edits.trimToRange(pcm, range.start, range.end));
      setSelection(null);
    });
  }, [withSelection, runEdit]);

  const doDuplicate = useCallback(() => {
    withSelection((track, range) => runEdit("Duplicate", (pcm) => edits.duplicateRange(pcm, range.start, range.end)));
  }, [withSelection, runEdit]);

  const doReverse = useCallback(() => {
    withSelection((track, range) => runEdit("Reverse", (pcm) => edits.reverseRange(pcm, range.start, range.end)));
  }, [withSelection, runEdit]);

  const doTrimSilence = useCallback(() => {
    runEdit("Trim silence", (pcm) => edits.trimSilence(pcm));
    setSelection(null);
  }, [runEdit]);

  // ---- effects -------------------------------------------------------------
  //
  // Preview and Apply both run from a snapshot taken when the dialog opened,
  // never from whatever the last preview left behind. Two failures follow from
  // getting this wrong, and both are invisible until someone hits undo:
  // previews compound on each other as you drag a slider, and undo returns to
  // the last preview rather than to the state before the dialog.

  const effectRange = useCallback((track) => {
    const total = frameCount(effectSnapshotRef.current ?? track.pcm);
    return selection ? [selection.start, Math.min(selection.end, total)] : [0, total];
  }, [selection]);

  const openEffect = useCallback((id) => {
    const track = activeTrack ? doc.findTrack(docRef.current, activeTrack) : null;
    if (!track) { setStatus("Select a track first."); return; }
    if (EFFECTS[id]?.needsNoiseProfile && !noiseProfileRef.current) {
      setStatus("Select a region of noise only, then use Capture noise profile.");
      return;
    }
    effectSnapshotRef.current = track.pcm;
    setEffectMenuOpen(false);
    setActiveEffect(id);
  }, [activeTrack]);

  const previewEffect = useCallback((params) => {
    const document_ = docRef.current;
    const track = activeTrack ? doc.findTrack(document_, activeTrack) : null;
    const snapshot = effectSnapshotRef.current;
    if (!track || !snapshot || !activeEffect) return;
    try {
      const next = applyEffect(activeEffect, snapshot, params, effectRange(track), {
        noiseProfile: noiseProfileRef.current,
      });
      doc.setTrackPcm(document_, track.id, next);
      if (EFFECTS[activeEffect].changesChannels) doc.reconcileChannels(document_);
      invalidatePeaks(track.id);
      bump();
      setStatus(null);
    } catch (err) {
      setStatus(err.message ?? String(err));
    }
  }, [activeEffect, activeTrack, effectRange, invalidatePeaks, bump]);

  const applyEffectNow = useCallback((params) => {
    const document_ = docRef.current;
    const track = activeTrack ? doc.findTrack(document_, activeTrack) : null;
    const snapshot = effectSnapshotRef.current;
    if (!track || !snapshot || !activeEffect) return;
    try {
      // Restore FIRST, so the undo entry captures the pre-dialog state rather
      // than the last preview.
      doc.setTrackPcm(document_, track.id, snapshot);
      historyMod.pushHistory(historyRef.current, document_, EFFECTS[activeEffect].label);
      const result = applyEffect(activeEffect, snapshot, params, effectRange(track), { noiseProfile: noiseProfileRef.current });
      doc.setTrackPcm(document_, track.id, result);
      // Mono-ize is the one effect that NARROWS the document; setTrackPcm only
      // widens, so without this the mixdown would still write two identical
      // channels and the "make it spatialise" fix would silently do nothing.
      if (EFFECTS[activeEffect].changesChannels) doc.reconcileChannels(document_);
      invalidatePeaks(track.id);
      setDirty(true);

      if (activeEffect === "seamlessLoop") {
        // The seam is the whole point, so measure it rather than claiming it.
        // Selecting the result and arming loop playback means Space auditions
        // the wrap immediately — a loop you can't hear round is untested work.
        const seam = seamAnalysis(result);
        setSelection(null);
        setLoopSelection(true);
        setStatus(
          seam.smooth
            ? `Looped ${(frameCount(result) / document_.sampleRate).toFixed(2)}s — seam is clean. Press Space to hear it round.`
            : `Looped ${(frameCount(result) / document_.sampleRate).toFixed(2)}s — seam still steps ${seam.clickRatio}× the waveform's normal jump. Try a longer crossfade.`,
        );
      } else {
        setStatus(`Applied ${EFFECTS[activeEffect].label}`);
      }
      setActiveEffect(null);
      effectSnapshotRef.current = null;
      bump();
    } catch (err) {
      setStatus(err.message ?? String(err));
    }
  }, [activeEffect, activeTrack, effectRange, invalidatePeaks, bump]);

  const cancelEffect = useCallback(() => {
    const document_ = docRef.current;
    const track = activeTrack ? doc.findTrack(document_, activeTrack) : null;
    if (track && effectSnapshotRef.current) {
      doc.setTrackPcm(document_, track.id, effectSnapshotRef.current);
      invalidatePeaks(track.id);
      bump();
    }
    effectSnapshotRef.current = null;
    setActiveEffect(null);
  }, [activeTrack, invalidatePeaks, bump]);

  const captureProfile = useCallback(() => {
    const track = activeTrack ? doc.findTrack(docRef.current, activeTrack) : null;
    if (!track) return;
    if (!selection || selection.end - selection.start < 2048) {
      setStatus("Select at least ~0.05s of noise-only audio, then capture.");
      return;
    }
    try {
      noiseProfileRef.current = captureNoiseProfile(track.pcm, selection.start, selection.end);
      setStatus("Noise profile captured — Restore ▸ Noise reduction is now available.");
    } catch (err) {
      setStatus(err.message ?? String(err));
    }
  }, [activeTrack, selection]);

  const doUndo = useCallback(() => {
    const label = historyMod.undo(historyRef.current, docRef.current);
    if (!label) return;
    invalidatePeaks();
    setDirty(true);
    setStatus(`Undid ${label}`);
    bump();
  }, [bump, invalidatePeaks]);

  const doRedo = useCallback(() => {
    const label = historyMod.redo(historyRef.current, docRef.current);
    if (!label) return;
    invalidatePeaks();
    setDirty(true);
    setStatus(`Redid ${label}`);
    bump();
  }, [bump, invalidatePeaks]);

  // ---- transport -----------------------------------------------------------

  const togglePlay = useCallback(async () => {
    const player = playerRef.current;
    const document_ = docRef.current;
    if (!player || !document_) return;
    if (player.playing) {
      player.stop();
      setPlaying(false);
      return;
    }
    const mix = doc.mixdown(document_);
    if (frameCount(mix) === 0) return;
    // Loop with nothing selected means loop the whole sound — which is exactly
    // what auditioning a freshly made seamless loop requires, and requiring a
    // select-all first would be a pointless step.
    const range = !loopSelection
      ? null
      : selection && selection.end > selection.start
        ? [selection.start / document_.sampleRate, selection.end / document_.sampleRate]
        : [0, frameCount(mix) / document_.sampleRate];
    const ok = await player.play(mix, {
      fromSeconds: range ? range[0] : playhead,
      loopRange: range,
      onEnded: () => setPlaying(false),
    });
    setPlaying(ok);
  }, [loopSelection, selection, playhead]);

  // The playhead is read from the audio clock every frame while playing. A
  // `setInterval` would drift against it, which is worst precisely when someone
  // is trying to find an edit point by ear.
  useEffect(() => {
    if (!playing || !visible) return;
    let raf = 0;
    const tick = () => {
      const player = playerRef.current;
      if (!player?.playing) { setPlaying(false); return; }
      setPlayhead(player.position());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, visible]);

  useEffect(() => () => playerRef.current?.dispose(), []);

  // Audio playing from a panel you can no longer see is disorienting, and it
  // keeps the Web Audio graph alive for nothing.
  useEffect(() => {
    if (visible) return;
    playerRef.current?.stop();
    setPlaying(false);
  }, [visible]);

  // ---- keyboard ------------------------------------------------------------

  useEffect(() => {
    if (!moduleOn) return;
    const onKey = (e) => {
      const el = document.querySelector(".audio-editor");
      if (!el) return;
      // Hover, not focus: clicking a waveform lane never moves activeElement.
      // EditorChrome defers to us by the same test.
      if (!e.target.closest?.(".audio-editor") && !el.matches(":hover")) return;
      if (e.target.matches?.("input, textarea, select")) return;

      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (key === " " || e.code === "Space") { e.preventDefault(); togglePlay(); return; }
      if (ctrl && key === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
      if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
      if (ctrl && key === "s") { e.preventDefault(); save(); return; }
      if (ctrl && key === "c") { e.preventDefault(); doCopy(); return; }
      if (ctrl && key === "x") { e.preventDefault(); doCut(); return; }
      if (ctrl && key === "v") { e.preventDefault(); doPaste(); return; }
      if (ctrl && key === "a") {
        e.preventDefault();
        const track = activeTrack ? doc.findTrack(docRef.current, activeTrack) : null;
        if (track) setSelection({ start: 0, end: frameCount(track.pcm) });
        return;
      }
      if (key === "delete" || key === "backspace") { e.preventDefault(); doDelete(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [moduleOn, togglePlay, doUndo, doRedo, save, doCopy, doCut, doPaste, doDelete, activeTrack]);

  // ---- derived -------------------------------------------------------------

  const document_ = docRef.current;
  const totalFrames = document_ ? doc.documentFrameCount(document_) : 0;

  const peaksFor = useCallback((track) => {
    let cached = peaksRef.current.get(track.id);
    if (!cached) {
      cached = buildPeaks(track.pcm);
      peaksRef.current.set(track.id, cached);
    }
    return cached;
  }, []);

  const zoom = useCallback((factor) => {
    setView((v) => {
      const span = v.end - v.start;
      const centre = v.start + span / 2;
      const next = Math.max(64, Math.min(Math.max(totalFrames, 64), span * factor));
      const start = Math.max(0, Math.min(Math.max(0, totalFrames - next), centre - next / 2));
      return { start, end: start + next };
    });
  }, [totalFrames]);

  const zoomToSelection = useCallback(() => {
    if (selection && selection.end > selection.start) setView({ start: selection.start, end: selection.end });
    else setView({ start: 0, end: Math.max(1, totalFrames) });
  }, [selection, totalFrames]);

  // A newly opened document has no meaningful view until its length is known.
  useEffect(() => {
    if (totalFrames > 0 && view.end <= 1) setView({ start: 0, end: totalFrames });
  }, [totalFrames, view.end]);

  const addTrackFromFile = useCallback(async (target) => {
    if (!docRef.current) return;
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke("read_binary_file", { path: target });
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);
      const pcm = await decodeAudioBytes(bytes);
      historyMod.pushHistory(historyRef.current, docRef.current, "Add track");
      const track = doc.addTrack(docRef.current, pcm, { name: target.split("/").pop() });
      setActiveTrack(track.id);
      setDirty(true);
      bump();
    } catch (err) {
      setStatus(err.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [bump]);

  // ---- render --------------------------------------------------------------

  if (!moduleOn) {
    return (
      <div className="audio-editor">
        <div className="aud-gate">
          <AudioWaveform size={28} />
          <h3>Audio Editor</h3>
          <p>
            Edit sounds without leaving the engine: layer takes on separate tracks, cut and fade,
            and mix down to the file your scene already references. Enable the Audio Editor module
            to get started.
          </p>
          <button className="toolbar-btn wide" onClick={() => setModuleEnabled("audio-editor", true)}>
            Enable Audio Editor module
          </button>
        </div>
      </div>
    );
  }

  if (!document_) {
    return (
      <div className="audio-editor">
        <div className="aud-empty">
          <AudioWaveform size={26} />
          <h3>Open a sound to edit</h3>
          {!rootPath ? (
            <p>Open a project first.</p>
          ) : files.length === 0 ? (
            <p>No audio files in this project yet. Import some from the Audio Library panel.</p>
          ) : (
            <ul className="aud-filelist">
              {files.map((f) => (
                <li key={f.path}>
                  <button onClick={() => open(f.path)} disabled={busy}>
                    <AudioWaveform size={12} /> {f.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {status && <div className="aud-status">{status}</div>}
        </div>
      </div>
    );
  }

  const selectionSeconds = selection ? (selection.end - selection.start) / document_.sampleRate : 0;

  return (
    <div className="audio-editor">
      <div className="aud-toolbar">
        <button className="aud-btn" onClick={togglePlay} title="Play / stop (Space)">
          {playing ? <Square size={13} /> : <Play size={13} />}
        </button>
        <button
          className={`aud-btn${loopSelection ? " active" : ""}`}
          onClick={() => setLoopSelection((v) => !v)}
          title="Loop the selection while playing — the only way to judge a seam"
        >
          <Repeat size={13} />
        </button>
        <span className="aud-time">{formatTime(playhead)}</span>

        <span className="aud-sep" />

        <button className="aud-btn" onClick={doCut} title="Cut (Ctrl+X)"><Scissors size={13} /></button>
        <button className="aud-btn" onClick={doCopy} title="Copy (Ctrl+C)"><Copy size={13} /></button>
        <button className="aud-btn" onClick={doPaste} title="Paste (Ctrl+V)"><Clipboard size={13} /></button>
        <button className="aud-btn" onClick={doDelete} title="Delete selection (Del)"><Trash2 size={13} /></button>
        <button className="aud-btn text" onClick={doSilence} title="Replace the selection with silence">Silence</button>
        <button className="aud-btn text" onClick={doTrim} title="Keep only the selection">Trim</button>
        <button className="aud-btn text" onClick={doDuplicate} title="Insert a copy after the selection">Dup</button>
        <button className="aud-btn text" onClick={doReverse} title="Reverse the selection">Reverse</button>
        <button className="aud-btn text" onClick={doTrimSilence} title="Remove leading and trailing silence">Trim silence</button>

        <span className="aud-sep" />

        <div className="aud-menu-wrap">
          <button
            className={`aud-btn text${effectMenuOpen ? " active" : ""}`}
            onClick={() => setEffectMenuOpen((v) => !v)}
            title="Processing"
          >
            Effects ▾
          </button>
          {effectMenuOpen && (
            <>
              {/* Click-away catcher rather than a document listener: the panel
                  can be on an inactive dockview tab that stays mounted, and a
                  global listener there would swallow clicks elsewhere. */}
              <div className="aud-menu-scrim" onClick={() => setEffectMenuOpen(false)} />
              <div className="aud-menu">
                {effectGroups().map((group) => (
                  <div key={group.name} className="aud-menu-group">
                    <div className="aud-menu-label">{group.name}</div>
                    {group.items.map((item) => (
                      <button
                        key={item.id}
                        className="aud-menu-item"
                        onClick={() => openEffect(item.id)}
                        title={item.description ?? ""}
                      >
                        {item.label}
                        {item.needsNoiseProfile && !noiseProfileRef.current && (
                          <span className="aud-menu-hint">needs profile</span>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
                <div className="aud-menu-group">
                  <div className="aud-menu-label">Game</div>
                  <button
                    className="aud-menu-item"
                    onClick={() => writeVariations(8)}
                    title="Write eight pitch- and gain-jittered copies beside this file, for a SoundComponent to pick between"
                  >
                    <Shuffle size={11} /> Generate 8 variations
                    <span className="aud-menu-hint">new files</span>
                  </button>
                </div>
                <div className="aud-menu-group">
                  <div className="aud-menu-label">Restore</div>
                  <button className="aud-menu-item" onClick={() => { setEffectMenuOpen(false); captureProfile(); }}>
                    Capture noise profile
                    <span className="aud-menu-hint">from selection</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <button className="aud-btn" onClick={doUndo} disabled={!historyMod.canUndo(historyRef.current)} title={`Undo ${historyMod.undoLabel(historyRef.current) ?? ""} (Ctrl+Z)`}>
          <Undo2 size={13} />
        </button>
        <button className="aud-btn" onClick={doRedo} disabled={!historyMod.canRedo(historyRef.current)} title="Redo (Ctrl+Y)">
          <Redo2 size={13} />
        </button>

        <span className="aud-sep" />

        <button className="aud-btn" onClick={() => zoom(0.5)} title="Zoom in"><ZoomIn size={13} /></button>
        <button className="aud-btn" onClick={() => zoom(2)} title="Zoom out"><ZoomOut size={13} /></button>
        <button className="aud-btn text" onClick={zoomToSelection} title="Fit the selection, or the whole sound">Fit</button>

        <span className="aud-spacer" />

        <div className="aud-menu-wrap">
          <button
            className={`aud-btn text${exportOpen ? " active" : ""}`}
            onClick={() => setExportOpen((v) => !v)}
            title="Write this out in another format — with what it costs on disk"
          >
            <Package size={12} /> Export ▾
          </button>
          {exportOpen && (
            <>
              <div className="aud-menu-scrim" onClick={() => setExportOpen(false)} />
              <div className="aud-menu right">
                <div className="aud-menu-group">
                  <div className="aud-menu-label">Ogg / Opus</div>
                  {!opusEncodingAvailable() ? (
                    <div className="aud-menu-note">This browser has no Opus encoder.</div>
                  ) : (
                    OPUS_BITRATES.map((option) => (
                      <button
                        key={option.value}
                        className="aud-menu-item"
                        onClick={() => exportAs("ogg", { bitrate: option.value })}
                        title={option.hint}
                      >
                        {option.label}
                        <span className="aud-menu-hint">
                          ≈{formatBytes(estimateDocumentBytes(document_, { format: "ogg", bitrate: option.value }))}
                        </span>
                      </button>
                    ))
                  )}
                </div>
                <div className="aud-menu-group">
                  <div className="aud-menu-label">WAV</div>
                  {[16, 24, 32].map((depth) => (
                    <button key={depth} className="aud-menu-item" onClick={() => exportAs("wav", { bitDepth: depth })}>
                      {depth}-bit
                      <span className="aud-menu-hint">
                        {formatBytes(estimateDocumentBytes(document_, { format: "wav", bitDepth: depth }))}
                      </span>
                    </button>
                  ))}
                </div>
                {/* Audio is usually the largest thing in a web build and
                    nothing else in the editor tells anyone that. */}
                <div className="aud-menu-note">Web builds should ship Ogg — it is 15-20× smaller than WAV.</div>
              </div>
            </>
          )}
        </div>

        <button className="aud-btn primary" onClick={() => save()} disabled={busy} title="Save (Ctrl+S)">
          {busy ? <Loader2 size={13} className="aud-spin" /> : <Save size={13} />}
          {canWriteInPlace(path) ? "Save" : "Save as WAV"}
          {dirty ? " •" : ""}
        </button>
      </div>

      <div className="aud-subbar">
        <span className="aud-file" title={path}>{path?.split("/").pop()}</span>
        <span className="aud-meta">
          {document_.sampleRate} Hz · {document_.channels === 1 ? "mono" : `${document_.channels}ch`} ·{" "}
          {formatTime(totalFrames / document_.sampleRate)}
        </span>
        {selection && <span className="aud-meta">selection {selectionSeconds.toFixed(3)}s</span>}
        {status && <span className="aud-status inline">{status}</span>}
      </div>

      <div className="aud-body">
        {document_.tracks.map((track) => (
          <TrackRow
            key={track.id}
            track={track}
            docSampleRate={document_.sampleRate}
            active={track.id === activeTrack}
            view={view}
            selection={selection}
            playheadFrame={playhead * document_.sampleRate}
            peaks={peaksFor(track)}
            onActivate={() => setActiveTrack(track.id)}
            onSelect={setSelection}
            onChange={(patch, label) => {
              historyMod.pushHistory(historyRef.current, document_, label);
              Object.assign(track, patch);
              setDirty(true);
              bump();
            }}
            onRemove={() => {
              if (document_.tracks.length === 1) { setStatus("A document needs at least one track."); return; }
              historyMod.pushHistory(historyRef.current, document_, "Remove track");
              doc.removeTrack(document_, track.id);
              peaksRef.current.delete(track.id);
              if (activeTrack === track.id) setActiveTrack(document_.tracks[0]?.id ?? null);
              setDirty(true);
              bump();
            }}
          />
        ))}

        <div className="aud-addtrack">
          <Plus size={12} />
          <select
            value=""
            disabled={busy}
            onChange={(e) => { if (e.target.value) addTrackFromFile(e.target.value); e.target.value = ""; }}
          >
            <option value="">Add a track from a file…</option>
            {files.map((f) => (
              <option key={f.path} value={f.path}>{f.name}</option>
            ))}
          </select>
          <span className="aud-hint">
            <Layers size={11} /> Tracks layer like an impact: thud, crack, tail.
          </span>
        </div>
      </div>

      {activeEffect && (
        <AudioEffectDialog
          key={activeEffect}
          effectId={activeEffect}
          busy={busy}
          note={
            selection && !EFFECTS[activeEffect].wholeBufferOnly
              ? `Applying to the selection (${((selection.end - selection.start) / document_.sampleRate).toFixed(2)}s).`
              : null
          }
          onPreview={previewEffect}
          onApply={applyEffectNow}
          onCancel={cancelEffect}
        />
      )}
    </div>
  );
}

/** One track: its head (mix controls) and its waveform lane. */
function TrackRow({
  track, docSampleRate, active, view, selection, playheadFrame, peaks,
  onActivate, onSelect, onChange, onRemove,
}) {
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const [width, setWidth] = useState(600);

  const frames = frameCount(track.pcm);
  const trackPeak = useMemo(() => peak(track.pcm), [track.pcm]);

  // The lane is sized by its container, and the canvas backing store must
  // follow devicePixelRatio or the waveform is a blurry approximation of the
  // thing you're trying to make a sample-accurate cut in.
  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth || 600));
    observer.observe(el);
    setWidth(el.clientWidth || 600);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const height = LANE_HEIGHT;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(canvas);
    const waveColor = styles.getPropertyValue("--aud-wave").trim() || "#6ba7ff";
    const midColor = styles.getPropertyValue("--aud-mid").trim() || "#2a3140";

    const channels = track.pcm.channels.length;
    const laneHeight = height / channels;

    for (let c = 0; c < channels; c++) {
      const mid = laneHeight * c + laneHeight / 2;
      ctx.strokeStyle = midColor;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(width, mid);
      ctx.stroke();

      // The lane shows document time; a track that starts late is drawn offset,
      // so `view` is translated into the track's own frame space here.
      const from = view.start - track.start;
      const to = view.end - track.start;
      const cols = columnPeaks(peaks, track.pcm, c, from, to, Math.max(1, Math.floor(width)));

      ctx.fillStyle = waveColor;
      for (let x = 0; x < cols.min.length; x++) {
        const yTop = mid - cols.max[x] * (laneHeight / 2) * 0.92;
        const yBottom = mid - cols.min[x] * (laneHeight / 2) * 0.92;
        ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
      }
    }
  }, [track.pcm, track.start, peaks, view, width]);

  const frameAt = (clientX, rect) => {
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.round(view.start + ratio * (view.end - view.start));
  };

  const onPointerDown = (e) => {
    onActivate();
    const rect = e.currentTarget.getBoundingClientRect();
    const anchor = frameAt(e.clientX, rect);
    dragRef.current = { anchor, rect };
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect({ start: anchor, end: anchor });
  };

  const onPointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const current = frameAt(e.clientX, drag.rect);
    onSelect({ start: Math.min(drag.anchor, current), end: Math.max(drag.anchor, current) });
  };

  const onPointerUp = (e) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const span = Math.max(1, view.end - view.start);
  const toPercent = (frame) => ((frame - view.start) / span) * 100;
  const selectionVisible = selection && selection.end > selection.start;

  return (
    <div className={`aud-track${active ? " active" : ""}`} onPointerDown={onActivate}>
      <div className="aud-head" style={{ width: HEAD_WIDTH }}>
        <input
          className="aud-track-name"
          value={track.name}
          onChange={(e) => onChange({ name: e.target.value }, "Rename track")}
        />
        <div className="aud-head-row">
          <button
            className={`aud-mini${track.muted ? " on" : ""}`}
            onClick={() => onChange({ muted: !track.muted }, "Mute")}
            title="Mute"
          >
            {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
          </button>
          <button
            className={`aud-mini${track.solo ? " on solo" : ""}`}
            onClick={() => onChange({ solo: !track.solo }, "Solo")}
            title="Solo"
          >
            S
          </button>
          <button className="aud-mini danger" onClick={onRemove} title="Remove track">
            <Trash2 size={11} />
          </button>
        </div>
        <label className="aud-slider" title="Gain">
          <span>Vol</span>
          <input
            type="range" min="0" max="2" step="0.01" value={track.gain}
            onChange={(e) => onChange({ gain: Number(e.target.value) }, "Gain")}
          />
        </label>
        <label className="aud-slider" title="Pan">
          <span>Pan</span>
          <input
            type="range" min="-1" max="1" step="0.01" value={track.pan}
            onChange={(e) => onChange({ pan: Number(e.target.value) }, "Pan")}
          />
        </label>
        <div className={`aud-peak${trackPeak > 1 ? " over" : ""}`} title="Peak level">
          {trackPeak > 0 ? `${(20 * Math.log10(trackPeak)).toFixed(1)} dB` : "—∞"}
          {trackPeak > 1 ? " OVER" : ""}
        </div>
      </div>

      <div
        className="aud-lane"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} style={{ width: "100%", height: LANE_HEIGHT }} />
        {selectionVisible && (
          <div
            className="aud-selection"
            style={{ left: `${toPercent(selection.start)}%`, width: `${((selection.end - selection.start) / span) * 100}%` }}
          />
        )}
        <div className="aud-playhead" style={{ left: `${toPercent(playheadFrame)}%` }} />
        <div className="aud-lane-label">
          {(frames / docSampleRate).toFixed(2)}s
        </div>
      </div>
    </div>
  );
}
