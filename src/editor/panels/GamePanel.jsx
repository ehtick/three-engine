import { useEffect, useRef, useState } from "react";
import { Play, Square, Pause, StepForward, Maximize2, Volume2, VolumeX } from "lucide-react";
import { usePlayStore } from "../store/playStore.js";
import { toggle as togglePlay, togglePaused, stepFrame } from "../playMode.js";
import { StatsOverlay } from "../overlays/StatsOverlay.jsx";
import { ensureEngine } from "../engineInstance.js";
import {
  claimCanvas,
  releaseCanvas,
  onCanvasOwnerChanged,
  getSharedCanvas,
  resizeSharedCanvas,
} from "../viewportCanvas.js";

/**
 * The Game view — what the player sees, at the shape the player will see it.
 *
 * It shows the SAME renderer canvas as the viewport rather than a second
 * renderer (see viewportCanvas.js for why), claiming it at a higher priority
 * while playing and handing it straight back on Stop. Everything here is about
 * the two questions the viewport can't answer:
 *
 *   - "does my HUD survive 21:9 / portrait?" → aspect + fixed-resolution
 *     presets, letterboxed with a real black surround instead of stretching
 *   - "what is this costing?" → the stats overlay, on by default here because
 *     the number that matters is the one the game produces, not the one the
 *     editor viewport produces with gizmos and helpers in the frame
 *
 * Aspect presets constrain the *rendered* size, not just the CSS box: the
 * renderer is resized to the letterboxed rectangle, so a 9:16 preset really
 * renders a portrait frame and a UI anchored to the bottom-right really moves.
 * Scaling a 16:9 canvas down with CSS would have looked identical and proved
 * nothing.
 */

/** `null` aspect = fill the panel; `resolution` pins the backing-store size. */
const ASPECTS = [
  { id: "free", label: "Free Aspect", aspect: null },
  { id: "16:9", label: "16:9", aspect: 16 / 9 },
  { id: "16:10", label: "16:10", aspect: 16 / 10 },
  { id: "21:9", label: "21:9 Ultrawide", aspect: 21 / 9 },
  { id: "4:3", label: "4:3", aspect: 4 / 3 },
  { id: "1:1", label: "1:1 Square", aspect: 1 },
  { id: "9:16", label: "9:16 Portrait", aspect: 9 / 16 },
  { id: "1080p", label: "1920 × 1080", aspect: 16 / 9, resolution: [1920, 1080] },
  { id: "720p", label: "1280 × 720", aspect: 16 / 9, resolution: [1280, 720] },
  { id: "1080x1920", label: "1080 × 1920 (phone)", aspect: 9 / 16, resolution: [1080, 1920] },
];

const ASPECT_STORAGE_KEY = "engine.game.aspect";
const MAXIMIZE_STORAGE_KEY = "engine.game.maximizeOnPlay";

function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode — the preference just doesn't stick */
  }
}

/**
 * The largest box of `aspect` that fits inside `width` × `height`. A fixed
 * `resolution` preset is never scaled UP past 1:1 — showing a 1080p target
 * blown up on a small panel would misrepresent both the framing and the
 * sharpness the player gets.
 */
function letterbox(width, height, preset) {
  if (!preset?.aspect) return { width, height, scale: 1 };
  let boxW = width;
  let boxH = width / preset.aspect;
  if (boxH > height) {
    boxH = height;
    boxW = height * preset.aspect;
  }
  if (preset.resolution) {
    const [rw, rh] = preset.resolution;
    const scale = Math.min(1, boxW / rw, boxH / rh);
    return { width: rw * scale, height: rh * scale, scale };
  }
  return { width: boxW, height: boxH, scale: 1 };
}

export function GamePanel() {
  const containerRef = useRef(null);
  const stageRef = useRef(null);
  const playing = usePlayStore((s) => s.playing);
  const paused = usePlayStore((s) => s.paused);
  const [aspectId, setAspectId] = useState(() => readPref(ASPECT_STORAGE_KEY, "free"));
  const [maximizeOnPlay, setMaximizeOnPlay] = useState(() => readPref(MAXIMIZE_STORAGE_KEY, false));
  const [muted, setMuted] = useState(false);
  const [aspectOpen, setAspectOpen] = useState(false);
  const [hasCanvas, setHasCanvas] = useState(false);
  const [rendered, setRendered] = useState(null);
  const preset = ASPECTS.find((a) => a.id === aspectId) ?? ASPECTS[0];

  // Keep the latest preset reachable from the ResizeObserver without
  // re-installing it on every dropdown change.
  const presetRef = useRef(preset);
  presetRef.current = preset;

  // --- canvas ownership ------------------------------------------------------
  // Claims ONLY while playing, at a priority that outranks the viewport's.
  //
  // Holding a low-priority claim while stopped looked tidier but was wrong: the
  // Game view would then show the scene through the EDITOR camera whenever the
  // viewport tab was hidden, which is not what this panel means. Stopped, it
  // shows its placeholder and the canvas belongs to the viewport.
  useEffect(() => {
    const stage = stageRef.current;
    ensureEngine();
    if (!stage || !playing) return undefined;
    claimCanvas("game", stage, 1);
    return () => releaseCanvas("game", stage);
  }, [playing]);

  useEffect(() => {
    const update = (owner) => setHasCanvas(owner === "game");
    const unsub = onCanvasOwnerChanged(update);
    return unsub;
  }, []);

  // --- sizing ---------------------------------------------------------------
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const fit = () => {
      const canvas = getSharedCanvas();
      const parent = stage.parentElement;
      if (!canvas || !parent) return;
      const box = letterbox(parent.clientWidth, parent.clientHeight, presetRef.current);
      if (!(box.width > 0) || !(box.height > 0)) return;
      stage.style.width = `${box.width}px`;
      stage.style.height = `${box.height}px`;
      // Inline, because `.viewport-canvas` sets 100%/100% and the stage is the
      // element being letterboxed — the canvas has to fill the stage exactly.
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      if (resizeSharedCanvas("game", box.width, box.height)) {
        setRendered({
          width: Math.round(canvas.width),
          height: Math.round(canvas.height),
          css: [Math.round(box.width), Math.round(box.height)],
        });
      }
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage.parentElement ?? stage);
    const unsub = onCanvasOwnerChanged(() => fit());
    return () => {
      observer.disconnect();
      unsub();
    };
  }, [aspectId, hasCanvas]);

  // --- maximize on play -----------------------------------------------------
  useEffect(() => {
    if (!playing || !maximizeOnPlay) return;
    let cancelled = false;
    (async () => {
      const { maximizePanel } = await import("../EditorShell.jsx");
      if (!cancelled) maximizePanel("game", true);
    })();
    return () => {
      cancelled = true;
    };
  }, [playing, maximizeOnPlay]);

  useEffect(() => {
    if (playing || !maximizeOnPlay) return;
    let cancelled = false;
    (async () => {
      const { maximizePanel } = await import("../EditorShell.jsx");
      if (!cancelled) maximizePanel("game", false);
    })();
    return () => {
      cancelled = true;
    };
  }, [playing, maximizeOnPlay]);

  const toggleMute = async () => {
    const live = await ensureEngine();
    const next = !muted;
    setMuted(next);
    live.audio?.setMasterVolume?.(next ? 0 : 1);
  };

  return (
    <div className="game-panel" ref={containerRef}>
      <div className="game-toolbar">
        <button
          className={`toolbar-btn${playing ? " is-active" : ""}`}
          onClick={() => togglePlay()}
          title={playing ? "Stop (Ctrl+P)" : "Play (Ctrl+P)"}
        >
          {playing ? <Square size={13} /> : <Play size={13} />}
        </button>
        {playing && (
          <>
            <button
              className={`toolbar-btn${paused ? " is-active" : ""}`}
              onClick={() => togglePaused()}
              title="Pause (Ctrl+Shift+P)"
            >
              <Pause size={13} />
            </button>
            <button className="toolbar-btn" onClick={() => stepFrame()} title="Step one frame (Ctrl+.)">
              <StepForward size={13} />
            </button>
          </>
        )}
        <div className="game-toolbar-sep" />
        <div className="dropdown-wrap">
          <button
            className={`toolbar-btn${aspectOpen ? " active" : ""}`}
            title="Aspect ratio / resolution"
            onClick={() => setAspectOpen((v) => !v)}
          >
            {preset.label}
          </button>
          {aspectOpen && (
            <>
              <div className="dropdown-overlay" onClick={() => setAspectOpen(false)} />
              <div className="dropdown-menu">
                {ASPECTS.map((a) => (
                  <button
                    key={a.id}
                    className="dropdown-item layers-item"
                    onClick={() => {
                      setAspectId(a.id);
                      writePref(ASPECT_STORAGE_KEY, a.id);
                      setAspectOpen(false);
                    }}
                  >
                    <span className="layers-item-label">
                      <span className={`layers-dot ${a.id === aspectId ? "on" : "off"}`} />
                      {a.label}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button
          className={`toolbar-btn${maximizeOnPlay ? " is-active" : ""}`}
          onClick={() => {
            const next = !maximizeOnPlay;
            setMaximizeOnPlay(next);
            writePref(MAXIMIZE_STORAGE_KEY, next);
          }}
          title="Maximize this panel while playing"
        >
          <Maximize2 size={13} />
        </button>
        <button
          className={`toolbar-btn${muted ? " is-active" : ""}`}
          onClick={toggleMute}
          title={muted ? "Unmute game audio" : "Mute game audio"}
        >
          {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
        <div className="game-toolbar-spacer" />
        {rendered && (
          <span className="game-res-badge" title="Rendered backing-store size (device pixels)">
            {rendered.width} × {rendered.height}
          </span>
        )}
      </div>

      <div className="game-stage-area">
        <div className="game-stage" ref={stageRef}>
          {!hasCanvas && (
            <div className="game-placeholder">
              <Play size={26} />
              <span>Press Play to run the game here</span>
              <span className="game-placeholder-hint">
                The viewport keeps the picture until then — there is one renderer, shared.
              </span>
            </div>
          )}
        </div>
        {playing && <StatsOverlay forceVisible />}
      </div>
    </div>
  );
}
