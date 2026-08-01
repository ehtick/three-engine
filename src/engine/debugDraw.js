import * as THREE from "three/webgpu";
import { DEBUG_LAYER } from "./editorLayers.js";

/**
 * Runtime debug drawing — `engine.debug.line(...)`, callable from gameplay
 * scripts and visible in the viewport and the game view.
 *
 *     this.engine.debug.ray(muzzle, forward, 50, "#ff0", 1);
 *     this.engine.debug.sphere(this.target.position, 0.5, "#f0f");
 *     this.engine.debug.text(this.entity.position, this.state, "#fff");
 *
 * This is what makes physics queries, camera rigs and pathfinding debuggable at
 * all: a raycast that misses, a boom arm that clips, an agent that walks into a
 * wall are each invisible until something draws them, and printing three
 * numbers to the console is not the same as seeing where the line went.
 *
 * ## One buffer, one draw call
 *
 * Every line every caller draws lands in a SINGLE `LineSegments` with vertex
 * colours. A three.js object per shape costs a draw call each and makes the
 * frame cost scale with how much debug drawing someone left on — and debug
 * drawing is only useful if it is cheap enough that nobody thinks twice about
 * adding one more.
 *
 * ## Immediate mode, with an escape hatch
 *
 * A call with no duration lasts one frame, so a script draws unconditionally
 * every frame and never cleans up: no handles, no dispose, nothing leaked when
 * a script is deleted mid-session, and the drawing vanishes the instant the
 * code stops running.
 *
 * A `duration` keeps the shape alive for that many seconds. That is not a
 * convenience — it is the only way to see a one-shot event. A raycast fired
 * inside a collision handler exists for a single frame, and a single frame of a
 * red line at 120fps is not something a human can see.
 */

const INITIAL_VERTICES = 2048;
// Retained shapes are meant to be the rare path (one-shot events). This cap
// exists because `debug.line(a, b, c, 0.5)` in an update loop is an easy
// mistake to make, and it turns into an unbounded allocation with no symptom
// other than the editor slowly dying.
const MAX_RETAINED = 8192;
const MAX_TEXT = 512;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _arrowTail = new THREE.Vector3();
const _arrowTip = new THREE.Vector3();
const _arrowDir = new THREE.Vector3();
const _arrowSide = new THREE.Vector3();
const _arrowBase = new THREE.Vector3();

/** Accepts a Vector3, an [x,y,z] tuple or three numbers, into `out`. */
export function toVec(out, x, y, z) {
  if (typeof x === "number") return out.set(x, y ?? 0, z ?? 0);
  if (Array.isArray(x)) return out.set(x[0] ?? 0, x[1] ?? 0, x[2] ?? 0);
  if (x && typeof x === "object") return out.set(x.x ?? 0, x.y ?? 0, x.z ?? 0);
  return out.set(0, 0, 0);
}

/**
 * The vertex writer. Holds the position/colour arrays plus the current colour
 * and transform, in the style of an immediate-mode API (`color()` then draw,
 * like Unity's `Gizmos.color`).
 *
 * Shared by the runtime debug system and the editor's `onDrawGizmos` pass —
 * two drawing surfaces with different lifetimes and different layers, but
 * exactly the same shapes.
 */
export class DebugBuffer {
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

  /** Doubles capacity until `needed` vertices fit, preserving what's written.
   *  Never shrinks: a scene that once drew 50k vertices will draw them again
   *  next frame, and re-allocating a 600KB buffer every time the count dips is
   *  worse than holding it. */
  ensure(needed) {
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

  vertex(v) {
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

  /** Appends a block of raw vertices/colours (used to replay retained shapes). */
  append(positions, colors, vertexCount) {
    this.ensure(vertexCount);
    this.positions.set(positions.subarray(0, vertexCount * 3), this.count * 3);
    this.colors.set(colors.subarray(0, vertexCount * 3), this.count * 3);
    this.count += vertexCount;
  }

  // ---- drawing --------------------------------------------------------------

  /** Colour for subsequent draws: `"#ff0"`, `0xff0000`, a Color, or r,g,b in 0..1. */
  color(value, g, b) {
    if (typeof value === "number" && typeof g === "number") this._color.setRGB(value, g, b ?? 0);
    else if (value != null) this._color.set(value);
    return this;
  }

  /** Transform applied to every subsequent vertex. Pass null to clear it.
   *  `gizmos.transform(entity.object3D.matrixWorld)` draws in local space. */
  transform(matrix) {
    this._matrix = matrix ?? null;
    return this;
  }

  line(from, to) {
    this.ensure(2);
    this.vertex(toVec(_a, from));
    this.vertex(toVec(_b, to));
    return this;
  }

  /** A line from `origin` along `direction` (scaled by `length`). */
  ray(origin, direction, length = 1) {
    toVec(_c, origin);
    toVec(_d, direction).multiplyScalar(length).add(_c);
    this.ensure(2);
    this.vertex(_c);
    this.vertex(_d);
    return this;
  }

  /**
   * A ray with a head, so the direction is readable. Plain lines are
   * ambiguous about which end is which, which matters constantly — a normal, a
   * velocity and a "from A to B" all look identical without the head.
   */
  arrow(from, to, headSize = 0) {
    // Dedicated scratch, not the shared _a/_b/_c: this function holds five
    // live vectors at once across two `ensure`/`vertex` rounds, and reusing the
    // general scratch means one of them gets silently overwritten mid-shape.
    const tail = _arrowTail.copy(toVec(_a, from));
    const tip = _arrowTip.copy(toVec(_b, to));
    this.ensure(2);
    this.vertex(_c.copy(tail));
    this.vertex(_c.copy(tip));
    const dir = _arrowDir.copy(tip).sub(tail);
    const length = dir.length();
    if (length < 1e-6) return this;
    dir.divideScalar(length);
    const head = headSize > 0 ? headSize : Math.min(length * 0.2, 0.35);
    // Any vector not parallel to the direction gives a valid perpendicular.
    const side = _arrowSide.set(0, 1, 0);
    if (Math.abs(dir.dot(side)) > 0.99) side.set(1, 0, 0);
    side.crossVectors(dir, side).normalize().multiplyScalar(head * 0.5);
    const base = _arrowBase.copy(tip).addScaledVector(dir, -head);
    this.ensure(4);
    this.vertex(_c.copy(base).add(side));
    this.vertex(_c.copy(tip));
    this.vertex(_c.copy(base).sub(side));
    this.vertex(_c.copy(tip));
    return this;
  }

  /** Wire box. `size` is the full extent, not the half-extent. */
  box(center, size = 1, quaternion = null) {
    toVec(_a, center);
    const s = typeof size === "number" ? _b.set(size, size, size) : toVec(_b, size);
    const hx = s.x / 2;
    const hy = s.y / 2;
    const hz = s.z / 2;
    const cx = _a.x;
    const cy = _a.y;
    const cz = _a.z;
    const local = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz],
      [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz],
    ];
    const corners = local.map(([x, y, z]) => {
      const v = new THREE.Vector3(x, y, z);
      if (quaternion) v.applyQuaternion(quaternion);
      return v.set(v.x + cx, v.y + cy, v.z + cz);
    });
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    this.ensure(edges.length * 2);
    for (const [i, j] of edges) {
      this.vertex(_c.copy(corners[i]));
      this.vertex(_c.copy(corners[j]));
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
    this.ensure(segments * 2);
    for (let i = 0; i < segments; i++) {
      for (const step of [i, i + 1]) {
        const t = (step / segments) * Math.PI * 2;
        point
          .copy(_a)
          .addScaledVector(right, Math.cos(t))
          .addScaledVector(forward, Math.sin(t));
        this.vertex(point);
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

  /** Upright capsule — the shape a character controller actually is. */
  capsule(center, radius = 0.5, height = 1, segments = 24) {
    toVec(_a, center);
    const half = Math.max(height / 2 - radius, 0);
    const top = _c.copy(_a).setY(_a.y + half);
    this.circle(top.clone(), radius, [0, 1, 0], segments);
    const bottom = _c.copy(_a).setY(_a.y - half);
    this.circle(bottom.clone(), radius, [0, 1, 0], segments);
    // Two side lines per axis is enough to read the silhouette; a full
    // hemisphere mesh at this scale is noise.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      this.line(
        [_a.x + dx * radius, _a.y + half, _a.z + dz * radius],
        [_a.x + dx * radius, _a.y - half, _a.z + dz * radius],
      );
    }
    return this;
  }

  /** Small three-axis cross marking a position. */
  point(position, size = 0.1) {
    toVec(_a, position);
    const { x, y, z } = _a;
    this.ensure(6);
    this.vertex(_c.set(x - size, y, z));
    this.vertex(_c.set(x + size, y, z));
    this.vertex(_c.set(x, y - size, z));
    this.vertex(_c.set(x, y + size, z));
    this.vertex(_c.set(x, y, z - size));
    this.vertex(_c.set(x, y, z + size));
    return this;
  }

  /** Open polyline through `points`. */
  polyline(points, closed = false) {
    if (!points?.length) return this;
    for (let i = 0; i < points.length - 1; i++) this.line(points[i], points[i + 1]);
    if (closed && points.length > 2) this.line(points[points.length - 1], points[0]);
    return this;
  }

  /** Red/green/blue axis triad for a transform — which way is this thing facing? */
  axes(matrix, size = 0.5) {
    const origin = new THREE.Vector3().setFromMatrixPosition(matrix);
    const columns = [
      [new THREE.Vector3().setFromMatrixColumn(matrix, 0), "#ff4d4d"],
      [new THREE.Vector3().setFromMatrixColumn(matrix, 1), "#4dff77"],
      [new THREE.Vector3().setFromMatrixColumn(matrix, 2), "#4d9dff"],
    ];
    const previous = this._color.clone();
    for (const [axis, hex] of columns) {
      this.color(hex);
      this.line(origin, axis.normalize().multiplyScalar(size).add(origin));
    }
    this._color.copy(previous);
    return this;
  }
}

/**
 * The engine-facing debug drawing system (`engine.debug`).
 *
 * Wraps a `DebugBuffer` with durations, a text layer, and a mesh on
 * `DEBUG_LAYER` — a layer of its own so a camera can turn all of it off at
 * once, and so the GI/SDF and batching systems (which walk entities, not raw
 * scene children) never see it.
 */
export class DebugDraw {
  constructor(engine) {
    this.engine = engine;
    this.enabled = true;
    this.buffer = new DebugBuffer();
    /** @type {Array<{expiry:number,positions:Float32Array,colors:Float32Array,count:number}>} */
    this.retained = [];
    this.mesh = null;
    this.textRoot = null;
    this._texts = []; // pooled sprites
    this._textUsed = 0;
    this._retainedWarned = false;
    // Wall-clock, not game time: a debug line drawn from a paused-game
    // inspector should still time out, and one drawn during bullet time should
    // not linger for six real seconds because timeScale was 0.15.
    this._clock = 0;
    // Marks the transition into a fresh frame. Callers draw during update; the
    // buffer is uploaded during pre-render, so "begin" has to be lazy rather
    // than tied to a callback that may run before or after them.
    this._dirty = false;
  }

  /** Called once per frame from the engine, with the UNSCALED delta. */
  tick(dt) {
    this._clock += dt;
  }

  #begin() {
    if (this._dirty) return;
    this.buffer.begin();
    this._textUsed = 0;
    this._dirty = true;
    // Replay everything still alive. Compacting here (rather than on a timer)
    // means an expired shape costs exactly one array shuffle, once.
    let write = 0;
    for (let i = 0; i < this.retained.length; i++) {
      const entry = this.retained[i];
      if (entry.expiry < this._clock) continue;
      this.retained[write++] = entry;
      if (entry.text) this.#emitText(entry);
      else this.buffer.append(entry.positions, entry.colors, entry.count);
    }
    this.retained.length = write;
  }

  /**
   * Runs a draw call, capturing its vertices into a retained entry when it has
   * a duration.
   *
   * The capture is a copy of whatever the shape wrote — so a retained sphere
   * costs one allocation at draw time and nothing per frame afterwards, and
   * `duration` needs no special case in any individual shape function.
   */
  #draw(color, duration, fn) {
    if (!this.enabled) return this;
    this.#begin();
    const start = this.buffer.count;
    this.buffer.color(color ?? 0x44ff88);
    fn(this.buffer);
    if (!(duration > 0)) return this;
    const count = this.buffer.count - start;
    if (count <= 0) return this;
    if (this.retained.length >= MAX_RETAINED) {
      if (!this._retainedWarned) {
        this._retainedWarned = true;
        console.warn(
          `engine.debug: over ${MAX_RETAINED} timed shapes are alive. Timed shapes are for ` +
            "one-shot events — calling one with a duration every frame accumulates.",
        );
      }
      return this;
    }
    this.retained.push({
      expiry: this._clock + duration,
      positions: this.buffer.positions.slice(start * 3, this.buffer.count * 3),
      colors: this.buffer.colors.slice(start * 3, this.buffer.count * 3),
      count,
    });
    return this;
  }

  // ---- public API -----------------------------------------------------------

  line(from, to, color, duration = 0) {
    return this.#draw(color, duration, (b) => b.line(from, to));
  }

  ray(origin, direction, length = 1, color, duration = 0) {
    return this.#draw(color, duration, (b) => b.ray(origin, direction, length));
  }

  arrow(from, to, color, duration = 0, headSize = 0) {
    return this.#draw(color, duration, (b) => b.arrow(from, to, headSize));
  }

  box(center, size = 1, color, duration = 0, quaternion = null) {
    return this.#draw(color, duration, (b) => b.box(center, size, quaternion));
  }

  sphere(center, radius = 1, color, duration = 0, segments = 32) {
    return this.#draw(color, duration, (b) => b.sphere(center, radius, segments));
  }

  circle(center, radius = 1, normal = [0, 1, 0], color, duration = 0, segments = 32) {
    return this.#draw(color, duration, (b) => b.circle(center, radius, normal, segments));
  }

  capsule(center, radius = 0.5, height = 1, color, duration = 0) {
    return this.#draw(color, duration, (b) => b.capsule(center, radius, height));
  }

  point(position, size = 0.1, color, duration = 0) {
    return this.#draw(color, duration, (b) => b.point(position, size));
  }

  polyline(points, color, duration = 0, closed = false) {
    return this.#draw(color, duration, (b) => b.polyline(points, closed));
  }

  /** Red/green/blue triad for an Object3D or a Matrix4. */
  axes(target, size = 0.5, duration = 0) {
    const matrix = target?.isMatrix4 ? target : target?.matrixWorld;
    if (!matrix) return this;
    return this.#draw(null, duration, (b) => b.axes(matrix, size));
  }

  /** Screen-facing label at a world position. */
  text(position, message, color = "#ffffff", duration = 0, size = 0.3) {
    if (!this.enabled) return this;
    this.#begin();
    const entry = {
      text: String(message ?? ""),
      position: toVec(new THREE.Vector3(), position),
      color,
      size,
      expiry: this._clock + duration,
    };
    this.#emitText(entry);
    if (duration > 0 && this.retained.length < MAX_RETAINED) this.retained.push(entry);
    return this;
  }

  /** Drops every timed shape. Called on Stop. */
  clear() {
    this.retained.length = 0;
    this.buffer.begin();
    this._textUsed = 0;
    this._retainedWarned = false;
    if (this.mesh) this.mesh.visible = false;
    for (const sprite of this._texts) sprite.visible = false;
  }

  setEnabled(value) {
    this.enabled = !!value;
    if (!this.enabled) this.clear();
  }

  // ---- rendering ------------------------------------------------------------

  /** Uploads this frame's vertices. Called from the engine's pre-render stage. */
  flush() {
    if (!this._dirty) {
      // Nothing drew this frame. Retained shapes still have to be replayed, or
      // a timed line vanishes on the first frame nobody calls a draw function.
      if (this.retained.length) this.#begin();
      else {
        // Reset the buffer even though nothing will be uploaded. Leaving last
        // frame's count behind means anything that inspects the buffer between
        // frames (a test, an overlay, a stats readout) reports shapes that are
        // no longer on screen.
        this.buffer.begin();
        this._textUsed = 0;
        if (this.mesh) this.mesh.visible = false;
        for (let i = 0; i < this._texts.length; i++) this._texts[i].visible = false;
        return;
      }
    }
    this._dirty = false;
    for (let i = this._textUsed; i < this._texts.length; i++) this._texts[i].visible = false;
    if (!this.buffer.count) {
      if (this.mesh) this.mesh.visible = false;
      return;
    }
    this.#ensureMesh();
    this.mesh.visible = true;
    const geometry = this.mesh.geometry;
    const position = geometry.getAttribute("position");
    if (position.array !== this.buffer.positions) {
      geometry.setAttribute("position", new THREE.BufferAttribute(this.buffer.positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(this.buffer.colors, 3));
    }
    geometry.getAttribute("position").needsUpdate = true;
    geometry.getAttribute("color").needsUpdate = true;
    geometry.setDrawRange(0, this.buffer.count);
  }

  #ensureMesh() {
    if (this.mesh) return this.mesh;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.buffer.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(this.buffer.colors, 3));
    this.mesh = new THREE.LineSegments(
      geometry,
      // `depthTest: false` so a shape inside geometry — a trigger volume in a
      // wall, a ray that ends inside the thing it hit — is still visible. The
      // whole point is showing what you can't see.
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.mesh.name = "__debugDraw";
    this.mesh.frustumCulled = false; // the buffer's bounds change every frame
    this.mesh.renderOrder = 998;
    this.mesh.layers.set(DEBUG_LAYER);
    this.engine.scene.add(this.mesh);
    return this.mesh;
  }

  /** Grabs a pooled sprite and points it at this label. */
  #emitText(entry) {
    if (typeof document === "undefined") return; // headless
    if (this._textUsed >= MAX_TEXT) return;
    let sprite = this._texts[this._textUsed];
    if (!sprite) {
      sprite = new THREE.Sprite(
        new THREE.SpriteNodeMaterial({ transparent: true, depthTest: false, sizeAttenuation: true }),
      );
      sprite.layers.set(DEBUG_LAYER);
      sprite.renderOrder = 999;
      sprite.frustumCulled = false;
      this._texts.push(sprite);
      this.engine.scene.add(sprite);
    }
    this._textUsed++;
    const texture = textTexture(entry.text, entry.color);
    if (!texture) return;
    sprite.material.map = texture;
    sprite.material.needsUpdate = true;
    sprite.position.copy(entry.position);
    sprite.scale.set(entry.size * texture.userData.aspect, entry.size, 1);
    sprite.visible = true;
  }

  dispose() {
    if (this.mesh) {
      this.engine.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    for (const sprite of this._texts) {
      this.engine.scene.remove(sprite);
      sprite.material.dispose();
    }
    this._texts.length = 0;
    this.retained.length = 0;
  }
}

/**
 * Rasterised label cache.
 *
 * Debug text is overwhelmingly the same handful of strings frame after frame
 * ("idle", "chasing", a rounded number), so caching by content makes the steady
 * state free. The cap keeps a script that prints a changing float from filling
 * VRAM with single-use textures.
 */
const MAX_TEXT_TEXTURES = 256;
const textCache = new Map();

function textTexture(text, color) {
  const key = `${text}|${color}`;
  const cached = textCache.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return null;
  const fontPx = 48;
  const font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.font = font;
  const width = Math.max(2, Math.ceil(ctx.measureText(text).width) + 16);
  const height = Math.ceil(fontPx * 1.4);
  canvas.width = width;
  canvas.height = height;
  // Setting the canvas size resets the 2D context, so the font has to be
  // re-applied after the resize or every label renders at the 10px default.
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  // A dark halo, not a filled background: debug text sits over arbitrary
  // scenery and has to stay legible over both a white wall and a black one,
  // without a rectangle hiding what you were trying to look at.
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(text, width / 2, height / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.userData.aspect = width / height;
  if (textCache.size >= MAX_TEXT_TEXTURES) {
    const oldest = textCache.keys().next().value;
    textCache.get(oldest)?.dispose();
    textCache.delete(oldest);
  }
  textCache.set(key, texture);
  return texture;
}
