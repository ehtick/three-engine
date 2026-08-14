// @ts-check
import { engine } from "./engineInstance.js";
import { oncePerVm } from "./singleton.js";
import { editorFrameRateFor, shouldSuspendViewport } from "./framePolicy.js";
import { onAssetInvalidated } from "./assetLoader.js";
import { useHistoryStore } from "./commands/CommandBus.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { isViewportFreezeEnabled, onViewportFreezeChanged } from "./viewportFreeze.js";

// Re-exported so existing importers (and the smokes) keep working.
export { editorFrameRateFor, shouldSuspendViewport };

const SAMPLE_MS = 250;
const UI_PRIORITY_MS = 350;

/**
 * How long an unfocused viewport keeps drawing after something changed.
 *
 * Not one frame. A single frame is right for a value that lands instantly and
 * wrong for almost everything real: a material recompiles, a texture decodes, a
 * model finishes loading, a camera focus eases toward its target. Each of those
 * completes some frames AFTER the change that caused it, and a one-frame wake
 * paints the moment before the result exists.
 */
const DIRTY_MS = 500;

/** Frame cap while catching up on a change nobody is watching directly. */
const DIRTY_FPS = 20;

/**
 * How long a startup/compile pin outlives its last positive signal. Long
 * enough to bridge the boot chain's phase gaps (scene parse → spawn →
 * geometry → materials → GI queue), short enough that idle savings resume
 * within a few seconds of the last real work.
 */
const PIN_SETTLE_MS = 2500;

function isViewportGesture(target) {
  return !!target?.closest?.("canvas.viewport-canvas, .geometry-editor-canvas");
}

/**
 * Which canvas a direct gesture is happening on, or null.
 *
 * "main" is the engine's own viewport; "geometry" is the geometry editor's
 * separate canvas and renderer. The distinction matters because the two are
 * paced differently: a gesture on the main canvas must never be capped, while a
 * gesture on the geometry canvas means the ENGINE loop is the competition — it
 * may be catching up on an autosave or a GI rebuild behind a detached tab, and
 * every frame it renders there is stolen from the orbit the user is actually
 * performing.
 */
function gestureSurface(target) {
  if (target?.closest?.("canvas.viewport-canvas")) return "main";
  if (target?.closest?.(".geometry-editor-canvas")) return "geometry";
  return null;
}

/** The live viewport canvas, or null before one exists. */
function viewportCanvas() {
  return document.querySelector("canvas.viewport-canvas");
}

/**
 * On screen at all: not behind an inactive dock tab, not in a minimised window,
 * not covered by some other maximized group.
 *
 * Measured from the element rather than tracked through dockview's events,
 * because dockview DETACHES an inactive tab's element without unmounting its
 * React component (see EditorShell) — so a detached, zero-sized canvas IS the
 * signal, and reading it needs no bookkeeping to keep in sync.
 */
function viewportVisible() {
  if (typeof document === "undefined" || document.hidden) return false;
  const canvas = viewportCanvas();
  if (!canvas || !canvas.isConnected) return false;
  const rect = canvas.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

/**
 * True when the viewport's dock group is the one the user is working in.
 *
 * Dockview marks the focused group `dv-active-group`. The geometry editor and
 * the Game view draw through the same canvas and share its group, so they count
 * as the viewport being focused — they ARE the viewport.
 *
 * The pointer being over the canvas counts too, whatever the dock says. Half
 * the viewport's own shortcuts are gated on hover rather than focus (F to frame
 * the selection is the one that bit us), so a pointer on the canvas means the
 * user is both looking at it and able to drive it.
 */
function viewportFocused() {
  const canvas = viewportCanvas();
  const group = canvas?.closest?.(".dv-groupview");
  // No dock (the exported player, a test harness) means nothing is competing
  // for the main thread — treat that as focused rather than freezing forever.
  if (!group) return true;
  if (group.classList.contains("dv-active-group")) return true;
  return !!canvas?.matches?.(":hover");
}

/**
 * Stops the viewport rendering whenever nobody is looking at it, and shares the
 * main thread when it is rendering something heavy.
 *
 * Installed once after the engine exists. It never limits Play mode and it
 * never slows direct canvas gestures such as orbiting or a transform drag.
 */
export function installEditorFramePacing() {
  if (!oncePerVm("editorFramePacing.install")) return;

  let interactiveUntil = 0;
  let dirtyUntil = 0;
  // A pressed pointer dragging on a viewport canvas, plus a short tail after
  // wheel zooms (which have no up event to end on).
  /** @type {"main" | "geometry" | null} */
  let gestureHeld = null;
  /** @type {"main" | "geometry" | null} */
  let gestureWheeled = null;
  let gestureWheelUntil = 0;
  // See the pin block in apply(): bridges sub-sample gaps between the boot
  // chain's pin signals, and covers the pre-entity scene-file phase at
  // install time.
  let pinnedUntil = performance.now() + PIN_SETTLE_MS;
  let applied = -1;
  // Whether WE stopped the loop. Never restart one somebody else stopped —
  // Play/Stop and scene loading own that flag too.
  let suspended = false;
  /** @type {number[] | null} */
  let lastCamera = null;

  // `start`/`stop` drive the render loop itself. They are deliberately NOT on
  // the scripting `Engine` surface in engine.d.ts — a gameplay script that
  // stops the loop has ended the game — so the host reaches them through an
  // explicit cast rather than by widening what every script can call.
  const host = /** @type {{ start(): void, stop(): void, loopActive: boolean }} */ (
    /** @type {unknown} */ (engine)
  );

  /**
   * Something changed what the viewport would draw.
   *
   * Coalesced into a deadline rather than acted on directly: several of these
   * sources fire hundreds of times a second (`hierarchy-changed` during a drag
   * is the worst of them), and waking per event is a render loop with extra
   * steps — which is exactly what the first version of this turned out to be.
   */
  const wake = () => {
    dirtyUntil = performance.now() + DIRTY_MS;
  };

  /**
   * Has the editor camera moved since the last sample?
   *
   * Polled rather than subscribed because a camera can be moved from anywhere:
   * Frame Selected, an orbit gesture, a script, a virtual-camera preview, a
   * focus tween. There is no single event that covers them all, and missing one
   * means a viewport that is silently wrong. Eleven floats every 250ms costs
   * nothing and cannot miss a case — this is what makes pressing F actually
   * show you the new framing.
   *
   * Reads the LOCAL pose, never `matrixWorld`: world matrices are recomputed
   * during a render, so a suspended viewport's would be frozen at whatever it
   * was when we stopped — blind precisely when this needs to see.
   */
  const cameraMoved = () => {
    const camera = engine.camera;
    if (!camera) return false;
    const pose = [
      camera.position.x, camera.position.y, camera.position.z,
      camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w,
      camera.zoom ?? 1,
      camera.fov ?? 0,
      camera.near ?? 0,
      camera.far ?? 0,
    ];
    if (!lastCamera) {
      lastCamera = pose;
      return false;
    }
    for (let i = 0; i < pose.length; i++) {
      if (Math.abs(lastCamera[i] - pose[i]) > 1e-6) {
        lastCamera = pose;
        return true;
      }
    }
    return false;
  };

  /** The canvas a direct gesture is live on right now, or null. */
  const activeGesture = () => {
    if (gestureHeld) return gestureHeld;
    return performance.now() < gestureWheelUntil ? gestureWheeled : null;
  };

  const apply = () => {
    if (cameraMoved()) wake();

    // STARTUP MUST RUN AT FULL SPEED, FOCUSED OR NOT. The whole scene-boot
    // chain is frame-driven: mesh/model assets stream in, GI's per-frame tick
    // polls "are assets settled" and only then launches its compile wave
    // (`engine.renderSuspended`). Suspending or DIRTY_FPS-capping the loop
    // during any of those phases stretches a ~4s boot into "GI initializes
    // for over 20 seconds" — or forever in headless (measured: 22.7s pinned
    // vs still-not-ready at 234s unpinned on the real project) — because
    // after a reload the focused panel is usually NOT the viewport.
    // `__editorKeepRendering` is the HARNESS hatch: headless suites are never
    // focused, so without it every probe reads a sleeping engine ("GI never
    // built" with no error anywhere — the signature that burned a session).
    const sceneStreaming = () => {
      for (const entity of engine.entities?.values?.() ?? []) {
        const model = entity.getComponent?.("model");
        if (model?.props?.path && !model.root) return true;
        if (entity.getComponent?.("mesh")?.assetLoadsPending) return true;
      }
      return false;
    };
    const pinnedNow =
      engine.renderSuspended === true ||
      engine.modules?.get?.("gi")?.system?._rebuildQueued === true ||
      globalThis.__editorKeepRendering === true ||
      sceneStreaming();
    // HYSTERESIS, both ends. The boot chain flaps between pin signals —
    // scene-file parse (no entities yet), entity spawn, geometry loads,
    // material loads, the GI queue — with sub-sample gaps between phases;
    // sampled raw, each gap suspends the loop and the next phase waits for a
    // wake (measured: a 22.7s pinned boot ran 36.6s on raw signals). The
    // install-time pin covers the pre-entity phase, where nothing is
    // queryable yet but the scene file is already streaming.
    if (pinnedNow) pinnedUntil = performance.now() + PIN_SETTLE_MS;
    const pinned = pinnedNow || performance.now() < pinnedUntil;
    // The frame after a pin releases still has work to show (the composited
    // field, the freshly decoded mesh) — give it a normal catch-up window.
    if (pinned) wake();

    const idle =
      !pinned &&
      shouldSuspendViewport({
        playing: engine.playing,
        visible: viewportVisible(),
        focused: viewportFocused(),
        freeze: isViewportFreezeEnabled(),
      });
    // A change still settling keeps the loop alive even when nobody is looking
    // directly: the alternative is a viewport that is only correct for whoever
    // happens to be watching it at the time.
    const catchingUp = performance.now() < dirtyUntil;

    // A live drag on the geometry editor's canvas owns the main thread. The
    // geometry editor renders through its own canvas and requestAnimationFrame
    // loop, so the engine loop at that moment is painting a viewport that is
    // hidden behind the geometry tab — catching up on an autosave, or pinned
    // UNCAPPED for seconds by the GI rebuild each geometry save queues — and
    // every one of those frames is stolen from the orbit the user is actually
    // performing. That is the "viewport randomly starts throttling while I
    // orbit" report: the bursts follow the edits. Play mode is exempt as
    // always. The deferred work resumes the moment the gesture ends; a GI
    // rebuild finishing an orbit later is invisible, a stuttering orbit is not.
    const gesture = engine.playing ? null : activeGesture();
    if (gesture === "geometry") {
      if (!viewportVisible()) {
        if (!suspended && host.loopActive) {
          suspended = true;
          host.stop();
        }
        return;
      }
      // Both canvases are on screen (a split layout): keep the main viewport
      // moving, but at the catch-up rate rather than full speed.
      if (suspended) {
        suspended = false;
        host.start();
      }
      if (applied !== DIRTY_FPS) {
        applied = DIRTY_FPS;
        engine.setFrameRateLimit(DIRTY_FPS);
      }
      return;
    }

    if (idle && !catchingUp) {
      if (!suspended && host.loopActive) {
        suspended = true;
        host.stop();
      }
      return;
    }

    if (suspended) {
      suspended = false;
      host.start();
    }

    const workMs = engine.stats?.readout?.workMs ?? 0;
    const next = pinned
      ? 0
      : idle
        ? DIRTY_FPS
        : editorFrameRateFor(workMs, {
            interacting: performance.now() < interactiveUntil,
            playing: engine.playing,
            gesture: gesture === "main",
          });
    if (next === applied) return;
    applied = next;
    engine.setFrameRateLimit(next);
  };

  const prioritizeUi = (event) => {
    if (engine.playing || isViewportGesture(event.target)) return;
    interactiveUntil = performance.now() + UI_PRIORITY_MS;
    apply();
  };

  window.addEventListener("pointerdown", prioritizeUi, true);
  window.addEventListener("pointermove", prioritizeUi, true);
  window.addEventListener("wheel", prioritizeUi, { capture: true, passive: true });
  window.addEventListener("keydown", prioritizeUi, true);

  // Direct canvas gestures. Held pointers are counted rather than flagged so a
  // second touch releasing early cannot end a drag that is still going; wheel
  // zooms have no up event, so they run on a short tail instead.
  let gesturePointers = 0;
  const onGesturePointerDown = (event) => {
    const surface = gestureSurface(event.target);
    if (!surface) return;
    gesturePointers += 1;
    gestureHeld = surface;
    apply();
  };
  const onGesturePointerEnd = () => {
    if (!gestureHeld) return;
    gesturePointers = Math.max(0, gesturePointers - 1);
    if (gesturePointers) return;
    gestureHeld = null;
    apply();
  };
  const onGestureLost = () => {
    gesturePointers = 0;
    gestureHeld = null;
    apply();
  };
  const onGestureWheel = (event) => {
    const surface = gestureSurface(event.target);
    if (!surface) return;
    gestureWheeled = surface;
    gestureWheelUntil = performance.now() + 300;
    apply();
  };
  window.addEventListener("pointerdown", onGesturePointerDown, true);
  window.addEventListener("pointerup", onGesturePointerEnd, true);
  window.addEventListener("pointercancel", onGesturePointerEnd, true);
  window.addEventListener("blur", onGestureLost);
  window.addEventListener("wheel", onGestureWheel, { capture: true, passive: true });
  // Clicking into or out of the viewport changes the answer immediately;
  // waiting up to a sample interval to resume makes it feel sticky.
  window.addEventListener("focusin", apply, true);
  window.addEventListener("pointerdown", apply, true);
  document.addEventListener("visibilitychange", apply);
  engine.on("play-changed", apply);
  // Turning the toggle off has to restart the loop now, not at the next sample
  // — the user clicked it because they want to see the viewport moving.
  onViewportFreezeChanged(apply);

  // Everything that changes what the viewport would draw.
  engine.on("hierarchy-changed", wake);
  engine.on("settings-changed", wake);
  engine.on("entity-spawned", wake);
  engine.on("renderer-rebuilt", wake);
  // A texture saved in the Texture Editor, a material recompiled, a geometry
  // rewritten — all land here.
  onAssetInvalidated(wake);
  // EVERY scene mutation goes through the command bus — that is the rule the
  // whole editor is built on — and each one refreshes the history store. So
  // this single subscription covers the entire Inspector, the Hierarchy, the
  // gizmos and undo/redo without enumerating any of them.
  useHistoryStore.subscribe(wake);
  // Selection drives the outline and the gizmo, which are drawn, not DOM.
  useSelectionStore.subscribe(wake);

  setInterval(apply, SAMPLE_MS);
}
