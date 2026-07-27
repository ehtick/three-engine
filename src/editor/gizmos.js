import * as THREE from "three/webgpu";
import { EDITOR_LAYER } from "../engine/editorLayers.js";
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

const INITIAL_VERTICES = 2048;

/** Reused across conversions so `gizmos.box(entity.position, …)` allocates nothing. */
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Accepts a Vector3, a [x,y,z] tuple or three numbers, into `out`. */
function toVec(out, x, y, z) {
  if (typeof x === "number") return out.set(x, y ?? 0, z ?? 0);
  if (Array.isArray(x)) return out.set(x[0] ?? 0, x[1] ?? 0, x[2] ?? 0);
  if (x && typeof x === "object") return out.set(x.x ?? 0, x.y ?? 0, x.z ?? 0);
  return out.set(0, 0, 0);
}

/**
 * The drawing surface handed to `onDrawGizmos`. Holds the vertex/colour arrays
 * and the current colour + transform, in the style of an immediate-mode API
 * (`setColor` then draw, like Unity's `Gizmos.color`).
 */
class GizmoBuffer {
  constructor() {
    this.positions = new Float32Array(INITIAL_VERTICES * 3);
    this.colors = new Float32Array(INITIAL_VERTICES * 3);
    this.count = 0; // vertices written this frame
    this._color = new THREE.Color(0x44ff88);
    this._matrix = null;
  }

  begin() {
    this.count = 0;
    this._color.setHex(0x44ff88);
    this._matrix = null;
  }

  /** Doubles capacity until `needed` vertices fit, preserving what's written. */
  #ensure(needed) {
    const capacity = this.positions.length / 3;
    if (this.count + needed <= capacity) return;
    let next = capacity || INITIAL_VERTICES;
    while (next < this.count + needed) next *= 2;
    const positions = new Float32Array(next * 3);
    const colors = new Float32Array(next * 3);
    positions.set(this.positions.subarray(0, this.count * 3));
    colors.set(this.colors.subarray(0, this.count * 3));
    this.positions = positions;
    this.colors = colors;
  }

  #vertex(v) {
    if (this._matrix) v.applyMatrix4(this._matrix);
    const i = this.count * 3;
    this.positions[i] = v.x;
    this.positions[i + 1] = v.y;
    this.positions[i + 2] = v.z;
    this.colors[i] = this._color.r;
    this.colors[i + 1] = this._color.g;
    this.colors[i + 2] = this._color.b;
    this.count++;
  }

  // ---- public drawing API (this is what scripts see) ------------------------

  /** Colour for subsequent draws: `"#ff0"`, `0xff0000`, a Color, or r,g,b in 0..1. */
  color(value, g, b) {
    if (typeof value === "number" && typeof g === "number") this._color.setRGB(value, g, b ?? 0);
    else this._color.set(value);
    return this;
  }

  /** Transform applied to every subsequent vertex. Pass null to clear it.
   *  `gizmos.transform(entity.object3D.matrixWorld)` draws in local space. */
  transform(matrix) {
    this._matrix = matrix ?? null;
    return this;
  }

  line(from, to) {
    this.#ensure(2);
    this.#vertex(toVec(_a, from));
    this.#vertex(toVec(_b, to));
    return this;
  }

  /** A line from `origin` along `direction` (scaled by `length`). */
  ray(origin, direction, length = 1) {
    toVec(_a, origin);
    toVec(_b, direction).multiplyScalar(length).add(_a);
    return this.line(_a.clone(), _b);
  }

  /** Axis-aligned wire box. `size` is the full extent, not the half-extent. */
  box(center, size = 1) {
    toVec(_a, center);
    const s = typeof size === "number" ? _b.set(size, size, size) : toVec(_b, size);
    const hx = s.x / 2;
    const hy = s.y / 2;
    const hz = s.z / 2;
    const { x, y, z } = _a;
    const corners = [
      [x - hx, y - hy, z - hz], [x + hx, y - hy, z - hz],
      [x + hx, y - hy, z + hz], [x - hx, y - hy, z + hz],
      [x - hx, y + hy, z - hz], [x + hx, y + hy, z - hz],
      [x + hx, y + hy, z + hz], [x - hx, y + hy, z + hz],
    ];
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    this.#ensure(edges.length * 2);
    for (const [i, j] of edges) {
      this.#vertex(_c.fromArray(corners[i]));
      this.#vertex(_c.fromArray(corners[j]));
    }
    return this;
  }

  /** Wire circle in the plane whose normal is `normal` (default +Y). */
  circle(center, radius = 1, normal = [0, 1, 0], segments = 32) {
    toVec(_a, center);
    toVec(_b, normal).normalize();
    // Any vector not parallel to the normal gives a valid in-plane basis.
    const up = Math.abs(_b.y) > 0.99 ? _c.set(1, 0, 0) : _c.set(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, _b).normalize().multiplyScalar(radius);
    const forward = new THREE.Vector3().crossVectors(_b, right).normalize().multiplyScalar(radius);
    const point = new THREE.Vector3();
    this.#ensure(segments * 2);
    for (let i = 0; i < segments; i++) {
      for (const step of [i, i + 1]) {
        const t = (step / segments) * Math.PI * 2;
        point
          .copy(_a)
          .addScaledVector(right, Math.cos(t))
          .addScaledVector(forward, Math.sin(t));
        this.#vertex(point);
      }
    }
    return this;
  }

  /** Wire sphere drawn as three great circles — the standard editor idiom;
   *  a full wireframe sphere is visual noise at gizmo scale. */
  sphere(center, radius = 1, segments = 32) {
    this.circle(center, radius, [0, 1, 0], segments);
    this.circle(center, radius, [1, 0, 0], segments);
    this.circle(center, radius, [0, 0, 1], segments);
    return this;
  }

  /** Small three-axis cross marking a position. */
  point(position, size = 0.1) {
    toVec(_a, position);
    const { x, y, z } = _a;
    this.#ensure(6);
    this.#vertex(_c.set(x - size, y, z));
    this.#vertex(_c.set(x + size, y, z));
    this.#vertex(_c.set(x, y - size, z));
    this.#vertex(_c.set(x, y + size, z));
    this.#vertex(_c.set(x, y, z - size));
    this.#vertex(_c.set(x, y, z + size));
    return this;
  }

  /** Open polyline through `points`. */
  polyline(points, closed = false) {
    if (!points?.length) return this;
    for (let i = 0; i < points.length - 1; i++) this.line(points[i], points[i + 1]);
    if (closed && points.length > 2) this.line(points[points.length - 1], points[0]);
    return this;
  }
}

const buffer = new GizmoBuffer();

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
  engine.scene.add(mesh);
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
}

function scriptHosts() {
  if (hosts) return hosts;
  hosts = [];
  for (const entity of engine.entities.values()) {
    const script = entity.components.get("script");
    if (script?.dispatchEditor) hosts.push([entity.id, script]);
  }
  return hosts;
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
    if (mesh) {
      engine.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh = null;
      geometry = null;
    }
  };
  return stopPass;
}
