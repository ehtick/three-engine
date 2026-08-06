import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import {
  subscribePreview,
  togglePreview,
  seekPreview,
  releasePreview,
  isPreviewing,
} from "../audio/previewPlayer.js";
import { columnPeaks } from "../audio/peaks.js";

/**
 * The audition control, used everywhere a sound can be heard outside the Audio
 * Editor: library search rows and the Inspector's asset preview.
 *
 * One component rather than one per surface, because they were visibly
 * different and that's the sort of inconsistency people notice immediately. All
 * of them share the singleton in `previewPlayer.js`, so starting one stops the
 * others and the progress bar means the same thing in every context.
 *
 * The waveform behind the progress comes from whichever source the caller has:
 *
 *   - `waveformUrl` — a remote PNG (Freesound ships one per sound).
 *   - `peaks` + `pcm` — locally decoded audio (the Inspector).
 *   - neither — a plain progress track, which is what Commons and the Internet
 *     Archive get. It must not leave a hole; a track with no waveform still
 *     reads as a scrub bar.
 *
 * `resolveSrc` exists for the Internet Archive, whose result rows don't know
 * their audio URL until the item's metadata is fetched. It runs on the first
 * play, not for every row on screen.
 */
export function AudioScrubber({
  id,
  src = null,
  resolveSrc = null,
  waveformUrl = null,
  peaks = null,
  pcm = null,
  duration = 0,
  variant = "row",
  disabled = false,
  onError = null,
}) {
  const [player, setPlayer] = useState({ key: null, playing: false, position: 0, duration: 0, error: null });
  const [resolving, setResolving] = useState(false);
  const [localError, setLocalError] = useState(null);
  const resolvedRef = useRef(src);
  const trackRef = useRef(null);

  // Filter aggressively before touching React state.
  //
  // The player ticks every animation frame, and every mounted scrubber is
  // subscribed — including the whole Audio Library list, which dockview keeps
  // mounted while its tab is inactive (see the dockview note in the editor
  // docs). Naively calling setState on each notification meant ~30 components
  // re-rendering 60 times a second next to a WebGPU viewport, which froze the
  // editor outright while a sound played.
  //
  // A scrubber only cares about two things: whether it is the one playing, and
  // where its own playhead is. Everything else is somebody else's update.
  const lastRef = useRef(null);
  useEffect(
    () =>
      subscribePreview((next) => {
        const previous = lastRef.current;
        if (previous) {
          const mineNow = next.key === id;
          const wasMine = previous.key === id;
          // Not about us, and wasn't a moment ago either.
          if (!mineNow && !wasMine) return;
          // Ours, but nothing we draw has changed enough to matter. The
          // threshold is roughly one pixel of a few-hundred-pixel track.
          if (
            mineNow &&
            wasMine &&
            previous.playing === next.playing &&
            previous.error === next.error &&
            previous.duration === next.duration &&
            Math.abs(previous.position - next.position) < 0.02
          ) {
            return;
          }
        }
        lastRef.current = next;
        setPlayer(next);
      }),
    [id],
  );
  useEffect(() => {
    resolvedRef.current = src;
  }, [src]);
  // A row that scrolls out of a virtualised list, or an Inspector that changes
  // selection, must not leave its sound playing behind it.
  useEffect(() => () => releasePreview(id), [id]);

  const mine = player.key === id;
  const playing = mine && player.playing;
  const position = mine ? player.position : 0;
  // Prefer the caller's known duration: it's right before any bytes load, and
  // for a decoded asset it's exact.
  const total = duration || (mine ? player.duration : 0);
  const progress = total > 0 ? Math.max(0, Math.min(1, position / total)) : 0;

  const error = localError ?? (mine ? player.error : null);
  useEffect(() => {
    if (error) onError?.(error);
  }, [error, onError]);

  const toggle = useCallback(async () => {
    if (disabled) return;
    setLocalError(null);
    let target = resolvedRef.current;
    if (!target && resolveSrc) {
      setResolving(true);
      try {
        target = await resolveSrc();
        resolvedRef.current = target;
      } catch (err) {
        setLocalError(err.message ?? String(err));
        setResolving(false);
        return;
      }
      setResolving(false);
    }
    if (!target) {
      setLocalError("Nothing to play.");
      return;
    }
    await togglePreview(id, target, { duration });
  }, [id, disabled, resolveSrc, duration]);

  const seek = useCallback(
    (event) => {
      if (!mine || !total) return;
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      seekPreview((event.clientX - rect.left) / Math.max(1, rect.width));
    },
    [mine, total],
  );

  return (
    <div className={`audio-scrubber ${variant}${playing ? " playing" : ""}${waveformUrl || peaks ? "" : " bare-track"}`}>
      <button
        className="audio-scrubber-play"
        onClick={toggle}
        disabled={disabled || resolving}
        title={playing ? "Stop" : "Audition"}
        aria-label={playing ? "Stop" : "Play"}
      >
        {resolving ? <Loader2 size={13} className="audio-scrubber-spin" /> : playing ? <Pause size={13} /> : <Play size={13} />}
      </button>

      <div
        className="audio-scrubber-track"
        ref={trackRef}
        onPointerDown={seek}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={Math.round(total * 1000)}
        aria-valuenow={Math.round(position * 1000)}
      >
        {waveformUrl ? (
          <img className="audio-scrubber-wave" src={waveformUrl} alt="" loading="lazy" draggable={false} />
        ) : peaks ? (
          <PeaksCanvas peaks={peaks} pcm={pcm} />
        ) : null}
        {/* The played portion is tinted rather than overlaid with a solid bar,
            so the waveform stays readable underneath it. */}
        <div className="audio-scrubber-fill" style={{ width: `${progress * 100}%` }} />
        {mine && <div className="audio-scrubber-head" style={{ left: `${progress * 100}%` }} />}
      </div>

      {/* Nothing to say until there's a duration or something playing: a column
          of "0:00" on rows whose length the provider never reported is noise
          that looks like broken data. */}
      {variant !== "bare" && (total > 0 || mine) && (
        <span className="audio-scrubber-time">
          {formatClock(mine ? position : 0)}
          {total > 0 ? ` / ${formatClock(total)}` : ""}
        </span>
      )}
    </div>
  );
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Draws locally-decoded peaks, sized to the element rather than the data. */
function PeaksCanvas({ peaks, pcm }) {
  const canvasRef = useRef(null);
  const [width, setWidth] = useState(200);

  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth || 200));
    observer.observe(el);
    setWidth(el.clientWidth || 200);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const height = canvas.parentElement?.clientHeight || 28;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--aud-wave").trim() || "#6ba7ff";

    const channels = peaks.channels.length;
    const lane = height / channels;
    for (let c = 0; c < channels; c++) {
      const mid = lane * c + lane / 2;
      const cols = columnPeaks(peaks, pcm, c, 0, peaks.frames, Math.max(1, Math.floor(width)));
      for (let x = 0; x < cols.min.length; x++) {
        const top = mid - cols.max[x] * (lane / 2) * 0.9;
        const bottom = mid - cols.min[x] * (lane / 2) * 0.9;
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
    }
  }, [peaks, pcm, width]);

  return <canvas ref={canvasRef} className="audio-scrubber-canvas" />;
}
