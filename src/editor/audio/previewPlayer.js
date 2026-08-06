/**
 * One audition player for the whole editor.
 *
 * Every surface that lets you hear a sound without opening the Audio Editor —
 * a library search result, the Inspector's asset preview, anything added later
 * — plays through this. Two reasons, and the second is the one that bit:
 *
 *  1. **Only one thing plays at a time, everywhere.** Auditioning a Freesound
 *     result while the Inspector is still playing the asset you selected is
 *     never what anyone wants, and a per-panel player cannot know about the
 *     others without every panel importing every other panel.
 *  2. **One player means one progress bar.** When each surface owned its own
 *     `<audio>` and its own scrub UI they drifted apart in look and behaviour,
 *     which is exactly what a user notices.
 *
 * VM-singleton for the reason in `singleton.js`: Vite can evaluate this module
 * more than once (`foo.js` and `foo.js?t=…`), and a per-copy module-level `let`
 * would leave two panels talking to two different players — one of which nobody
 * can stop.
 */
import { vmSingleton } from "../singleton.js";

const state = vmSingleton("audioPreviewPlayer", () => ({
  el: null,
  key: null,          // which caller owns playback right now
  playing: false,
  position: 0,        // seconds
  duration: 0,
  error: null,
  raf: 0,
  listeners: new Set(),
}));

function notify() {
  for (const fn of state.listeners) {
    try {
      fn(snapshot());
    } catch (err) {
      console.error(`audio preview subscriber: ${err.message}`);
    }
  }
}

function snapshot() {
  return {
    key: state.key,
    playing: state.playing,
    position: state.position,
    duration: state.duration,
    error: state.error,
  };
}

function element() {
  if (state.el || typeof Audio === "undefined") return state.el;
  const el = new Audio();
  el.preload = "metadata";
  el.addEventListener("ended", () => stopPreview());
  el.addEventListener("error", () => {
    // The element's own failures (404, 401, an unsupported codec) never reach
    // the play() promise, so they have to be caught here or they're silent.
    state.error = describeMediaError(el.error);
    state.playing = false;
    stopTicking();
    notify();
  });
  el.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(el.duration)) {
      state.duration = el.duration;
      notify();
    }
  });
  state.el = el;
  return el;
}

function describeMediaError(error) {
  switch (error?.code) {
    case 1: return "Playback was aborted.";
    case 2: return "Network error while loading this sound.";
    case 3: return "This file could not be decoded.";
    case 4: return "This sound could not be loaded (it may be restricted).";
    default: return "This sound could not be played.";
  }
}

// Position comes from the media element every frame rather than from a timer:
// a timer drifts against playback, and a progress bar that drifts is worse than
// none because it points at the wrong moment while you're trying to find one.
function startTicking() {
  if (state.raf || typeof requestAnimationFrame === "undefined") return;
  const tick = () => {
    if (!state.playing) {
      state.raf = 0;
      return;
    }
    const el = state.el;
    if (el) {
      state.position = el.currentTime;
      if (Number.isFinite(el.duration) && el.duration !== state.duration) state.duration = el.duration;
    }
    notify();
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function stopTicking() {
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = 0;
}

/** Subscribes to player state. Fires immediately with the current snapshot. */
export function subscribePreview(fn) {
  state.listeners.add(fn);
  fn(snapshot());
  return () => state.listeners.delete(fn);
}

export const previewState = snapshot;

/**
 * How many scrubbers are currently listening. Diagnostic only — it exists
 * because "a hidden panel stopped paying for its subscriptions" is otherwise
 * unobservable: dockview detaches the DOM either way, so counting elements
 * proves nothing about whether React is still running behind them.
 */
export const previewSubscriberCount = () => state.listeners.size;

/** True when `key` is the one currently playing. */
export const isPreviewing = (key) => state.playing && state.key === key;

/**
 * Plays `src` on behalf of `key`. Any other caller's playback stops first.
 * Resolves true when playback actually started.
 */
export async function playPreview(key, src, { duration = 0 } = {}) {
  const el = element();
  if (!el || !src) return false;
  el.pause();
  state.key = key;
  state.error = null;
  state.position = 0;
  // A caller that already knows the duration (a decoded asset, a search result)
  // gets a correct progress bar before any bytes arrive; otherwise it fills in
  // on loadedmetadata.
  state.duration = duration || 0;
  if (el.src !== src) el.src = src;
  el.currentTime = 0;
  state.playing = true;
  notify();
  startTicking();
  try {
    await el.play();
    return true;
  } catch (err) {
    state.playing = false;
    state.error = err?.name === "NotAllowedError" ? "The browser blocked playback." : "Couldn't play this sound.";
    stopTicking();
    notify();
    return false;
  }
}

export function stopPreview() {
  const el = state.el;
  if (el) el.pause();
  state.playing = false;
  stopTicking();
  notify();
}

export function togglePreview(key, src, options) {
  if (isPreviewing(key)) {
    stopPreview();
    return Promise.resolve(false);
  }
  return playPreview(key, src, options);
}

/** Seeks to a 0..1 position within whatever is loaded. */
export function seekPreview(ratio) {
  const el = state.el;
  if (!el || !state.duration) return;
  const time = Math.max(0, Math.min(1, ratio)) * state.duration;
  el.currentTime = time;
  state.position = time;
  notify();
}

/** Drops ownership without stopping — for a component unmounting mid-play. */
export function releasePreview(key) {
  if (state.key === key) stopPreview();
}
