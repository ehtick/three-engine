// @ts-check
import * as THREE from "three/webgpu";
import { EDITOR_LAYER } from "../engine/editorLayers.js";
import { DebugBuffer } from "../engine/debugDraw.js";
import { engine } from "./engineInstance.js";
import { useSelectionStore } from "./store/selectionStore.js";

/**
 * Script-drawn editor gizmos — Unity's `OnDrawGizmos`.
 *
 * A script defines `onDrawGizmos(gizmos)` (or `onDrawGizmosSelected(gizmos)`,
 * called only while its entity is selected) and draws wireframe shapes into the
 * viewport. Typical use is making invisible data visible while authoring: a
 * trigger volume, a patrol path, a spawn radius, where a raycast actually goes.
 *
 * ## One buffer, rebuilt per frame
 *
 * Everything every script draws lands in a SINGLE `LineSegments` with vertex
 * colours. The obvious implementation — a three object per shape, added and
 * removed as scripts draw — costs a draw call per gizmo and makes the frame
 * cost scale with how much debug drawing someone left switched on. Gizmos are
 * the thing you want to be free enough that nobody thinks twice about adding
 * one, so this fills two typed arrays and issues one draw.
 *
 * Capacity grows geometrically and never shrinks: a scene that once drew 50k
 * vertices will draw them again next frame, and re-allocating a 600KB buffer
 * every time the count dips is worse than holding it.
 *
 * ## Immediate-mode, deliberately
 *
 * `gizmos.*` calls do nothing but append vertices, and the buffer is cleared at
 * the start of each frame. So a script draws unconditionally every frame and
 * never has to clean up — no handles, no dispose, no leak when a script is
 * deleted mid-session. It also means gizmos vanish the instant the drawing code
 * stops running, which is the behaviour you want when you are toggling a
 * feature on and off while looking at it.
 *
 * The pass runs whether or not the editor is playing. The mesh lives on
 * `EDITOR_LAYER`, which play cameras don't render, so gizmos are invisible in
 * the game view and in a build without any extra gating.
 */

/**
 * The drawing surface handed to `onDrawGizmos` is the engine's shared
 * `DebugBuffer` — the same shapes, the same one-draw-call buffer, and one place
 * to fix a bug in the circle maths. What differs between the two surfaces is
 * only lifetime and layer, which is what this module and `DebugDraw` each own.
 */
const buffer = new DebugBuffer();

let mesh = null;
let geometry = null;
let unsubscribe = null;
let stopPass = null;

function ensureMesh() {
  if (mesh) return mesh;
  geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(buffer.positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(buffer.colors, 3));
  mesh = new THREE.LineSegments(
    geometry,
    // `depthTest: false` so a gizmo inside geometry (a trigger volume in a
    // wall) is still visible — the whole point is to show what you can't see.
    new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }),
  );
  mesh.name = "__scriptGizmos";
  mesh.frustumCulled = false; // the buffer's bounds change every frame
  mesh.renderOrder = 999;
  mesh.layers.set(EDITOR_LAYER);
  // `scene` is deliberately typed narrow for scripts (see the note atop
  // engine.d.ts) — editor internals still need the real THREE.Scene.
  /** @type {THREE.Scene} */ (engine.scene).add(mesh);
  return mesh;
}

/** Re-points the geometry at the (possibly re-allocated) typed arrays. */
function syncAttributes() {
  const position = geometry.getAttribute("position");
  if (position.array !== buffer.positions) {
    geometry.setAttribute("position", new THREE.BufferAttribute(buffer.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(buffer.colors, 3));
  }
  geometry.getAttribute("position").needsUpdate = true;
  geometry.getAttribute("color").needsUpdate = true;
  geometry.setDrawRange(0, buffer.count);
}

/**
 * Cached `[entityId, scriptComponent]` pairs, rebuilt only when the scene
 * changes shape or a script module (re)loads.
 *
 * Without this the pass walks every entity in the scene every frame just to
 * find the few with script components — O(scene) per frame for a feature most
 * projects don't use at all, in an editor that already runs 10k-entity scenes.
 * Both invalidating events already exist and already fire coalesced.
 */
let hosts = null;

function invalidateHosts() {
  hosts = null;
  gizmoComponents = null;
}

function scriptHosts() {
  if (hosts) return hosts;
  hosts = [];
  for (const entity of engine.entities.values()) {
    // `.components` is the internal Map, deliberately absent from the public
    // Entity surface (scripts use getComponent/findComponents instead).
    const script = /** @type {any} */ (entity).components.get("script");
    if (script?.dispatchEditor) hosts.push([entity.id, script]);
  }
  return hosts;
}

/**
 * Components that draw their own gizmo, cached like the script hosts.
 *
 * The same hook names, deliberately: a decal projector's box and a line
 * renderer's control points are the same kind of thing a script draws with
 * `onDrawGizmos` — invisible data made visible while authoring — and giving
 * them a second mechanism would mean a second buffer, a second layer and a
 * second set of shape functions to keep in step.
 */
let gizmoComponents = null;

function componentHosts() {
  if (gizmoComponents) return gizmoComponents;
  gizmoComponents = [];
  for (const entity of engine.entities.values()) {
    for (const component of /** @type {any} */ (entity).components.values()) {
      if (component.onDrawGizmos || component.onDrawGizmosSelected) {
        gizmoComponents.push([entity.id, component]);
      }
    }
  }
  return gizmoComponents;
}

function drawFrame() {
  buffer.begin();
  const selected = useSelectionStore.getState().ids;
  let drew = false;
  for (const [entityId, script] of scriptHosts()) {
    // `dispatchEditor` (not `dispatch`) so gizmos appear while the editor is
    // stopped, which is when authoring actually happens.
    if (script.dispatchEditor("onDrawGizmos", buffer)) drew = true;
    if (selected.includes(entityId) && script.dispatchEditor("onDrawGizmosSelected", buffer)) {
      drew = true;
    }
  }
  for (const [entityId, component] of componentHosts()) {
    if (component.enabled === false) continue;
    if (component.onDrawGizmos) {
      component.onDrawGizmos(buffer);
      drew = true;
    }
    if (component.onDrawGizmosSelected && selected.includes(entityId)) {
      component.onDrawGizmosSelected(buffer);
      drew = true;
    }
  }
  // Nothing drew and nothing is on screen: skip the buffer upload entirely so
  // the common case (no gizmo scripts in the project) costs one map walk.
  if (!drew && !mesh) return;
  ensureMesh();
  mesh.visible = buffer.count > 0;
  syncAttributes();
}

/** Starts the per-frame gizmo pass. Idempotent; returns a stop function. */
export function startGizmoPass() {
  if (stopPass) return stopPass;
  const unsubHierarchy = engine.on("hierarchy-changed", invalidateHosts);
  // A script module finishing its (re)load is when `dispatchEditor` starts
  // being able to reach a new `onDrawGizmos` — the hierarchy never changed.
  const unsubLoaded = engine.on("script-loaded", invalidateHosts);
  unsubscribe = engine.onPreRender(() => {
    try {
      drawFrame();
    } catch (err) {
      console.error("Gizmo pass failed:", err);
    }
  });
  stopPass = () => {
    unsubscribe?.();
    unsubHierarchy?.();
    unsubLoaded?.();
    unsubscribe = null;
    stopPass = null;
    hosts = null;
    gizmoComponents = null;
    if (mesh) {
      /** @type {THREE.Scene} */ (engine.scene).remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh = null;
      geometry = null;
    }
  };
  return stopPass;
}
