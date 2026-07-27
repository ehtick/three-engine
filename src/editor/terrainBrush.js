import { engine } from "./engineInstance.js";
import { useSelectionStore } from "./store/selectionStore.js";

/**
 * Module-level "armed brush" state for the Terrain sculpt/paint tools —
 * mirrors the armFollowPick/armSurfacePick pattern in InspectorPanel.jsx.
 * The Inspector's Terrain section arms/disarms and edits settings; the
 * viewport's pointer handlers read the armed mode + settings while a
 * terrain entity is selected.
 */
let mode = null; // "sculpt" | "paint" | "erase" | "scatter" | null
let adjustment = null; // { key, startValue } while an F gesture is active
let scatterSourcePick = null; // { terrainEntityId, layerIndex }
const settings = {
  tool: "raise", // sculpt: "raise" | "lower" | "smooth" | "flatten"
  radius: 4,
  strength: 0.5,
  hardness: 0.5,
  // null keeps the classic hardness-exponent falloff; naming one of the shared
  // curves (see editor/brush.js) switches to the same set the mesh sculptor uses.
  falloff: null,
  activeLayer: 0, // paint: which of the up-to-4 layers to paint
  activeScatterLayer: 0,
  // Only the *brush gesture* lives here. How an instance is oriented, scaled and
  // seated is a property of the scatter layer (persisted with the terrain), not
  // of the brush — that way the settings survive a reload and can be re-tuned
  // after painting. See makeTerrainScatterLayer.
  scatterSpacing: 2,
  scatterJitter: 0.75,
};

const listeners = new Set();
function notify() {
  for (const cb of listeners) cb();
}

export function subscribeTerrainBrush(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getTerrainBrushMode() {
  return mode;
}

export function armTerrainBrush(nextMode) {
  mode = nextMode;
  notify();
}

export function disarmTerrainBrush() {
  mode = null;
  adjustment = null;
  notify();
}

export function getTerrainBrushSettings() {
  return settings;
}

export function setTerrainBrushSetting(key, value) {
  settings[key] = value;
  notify();
}

export function getTerrainBrushAdjustment() {
  return adjustment;
}

export function beginTerrainBrushAdjustment(key) {
  adjustment = { key, startValue: settings[key] };
  notify();
}

export function finishTerrainBrushAdjustment(cancel = false) {
  if (!adjustment) return false;
  if (cancel) settings[adjustment.key] = adjustment.startValue;
  adjustment = null;
  notify();
  return true;
}

export function armTerrainScatterSourcePick(terrainEntityId, layerIndex) {
  scatterSourcePick = { terrainEntityId, layerIndex };
  notify();
}

export function getTerrainScatterSourcePick() {
  return scatterSourcePick;
}

export function disarmTerrainScatterSourcePick() {
  if (!scatterSourcePick) return false;
  scatterSourcePick = null;
  notify();
  return true;
}

/** True when the primary selected entity carries a terrain component — the
 *  gate for terrain-only context keybindings below. */
function selectedTerrain() {
  const id = useSelectionStore.getState().ids[0];
  return id ? engine.getEntity(id)?.getComponent?.("terrain") : null;
}

/**
 * Context-based keyboard shortcuts, active ONLY while a terrain entity is
 * selected — so they never shadow the global editor keys elsewhere:
 *
 *   S    sculpt        P    paint         E    erase
 *   B    disarm brush  Esc  disarm brush
 *   [ / ]  shrink / grow brush radius
 *   Shift+[ / Shift+]  weaken / strengthen brush
 *
 * (Undo/redo — Ctrl+Z / Ctrl+Shift+Z — stay on the global command bus.)
 * Returns true when the event was consumed so the caller can stop it from
 * falling through to the global hotkeys (E in particular also toggles game
 * visibility).
 */
export function dispatchTerrainKeyAction(e) {
  if (e.metaKey || e.altKey) return false;
  const terrain = selectedTerrain();
  if (!terrain) return false;
  const key = (e.key || "").toLowerCase();
  if (adjustment) {
    if (key === "escape") return finishTerrainBrushAdjustment(true);
    if (key === "enter" || key === " ") return finishTerrainBrushAdjustment(false);
    return false;
  }
  if (key === "f" && mode) {
    beginTerrainBrushAdjustment(
      e.ctrlKey ? "hardness" : e.shiftKey ? (mode === "scatter" ? "scatterSpacing" : "strength") : "radius",
    );
    return true;
  }
  if (e.ctrlKey) return false;
  // "[" / "]" nudge the brush; Shift on the same physical keys ("{" / "}")
  // nudges strength. Any *other* Shift chord is left for the global hotkeys
  // (Shift+E etc.), so we reject it up front.
  const bracketKey = key === "[" || key === "]" || key === "{" || key === "}";
  if (e.shiftKey && !bracketKey) return false;
  switch (key) {
    case "s": armTerrainBrush("sculpt"); return true;
    case "p": armTerrainBrush("paint"); return true;
    case "e": armTerrainBrush("erase"); return true;
    case "c":
      if (!(terrain.props.scatterLayers?.length)) return false;
      armTerrainBrush("scatter"); return true;
    case "b":
    case "escape":
      if (!mode) return false; // let Esc do its normal thing when idle
      disarmTerrainBrush();
      return true;
    case "[": // shrink radius
      setTerrainBrushSetting("radius", Math.max(0.1, +(settings.radius - 1).toFixed(2)));
      return true;
    case "]": // grow radius
      setTerrainBrushSetting("radius", +(settings.radius + 1).toFixed(2));
      return true;
    case "{": // Shift+[ : weaken
      setTerrainBrushSetting("strength", Math.max(0.01, +(settings.strength - 0.05).toFixed(3)));
      return true;
    case "}": // Shift+] : strengthen
      setTerrainBrushSetting("strength", Math.min(1, +(settings.strength + 0.05).toFixed(3)));
      return true;
    default:
      return false;
  }
}
