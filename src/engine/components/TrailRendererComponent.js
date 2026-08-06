import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { buildRibbon } from "../vfx/ribbon.js";
import { RibbonMesh, entitySubtreeVisible } from "../vfx/ribbonMesh.js";
import { createRibbonMaterial, applyRibbonWrap } from "../vfx/vfxMaterial.js";
import { loadTextureAsset } from "../textureAsset.js";

const _color = new THREE.Color();
const _worldPosition = new THREE.Vector3();

function toLinearRgba(hex, alpha) {
  _color.set(hex ?? "#ffffff");
  return [_color.r, _color.g, _color.b, alpha ?? 1];
}

// A trail is a moving object's recent history, not a data structure someone
// should be able to fill by accident. At 60fps with the default 0.05m spacing
// this is ~34 seconds of continuous sprinting.
const MAX_POINTS = 2048;

/**
 * A ribbon that follows a moving object and fades away behind it — sword arcs,
 * rocket exhaust, projectile streaks, a dash afterimage (roadmap item 13).
 *
 * ## The points are world-space, and that is the entire point
 *
 * A trail records where the object *was*. Parent the strip to the object and
 * the history moves with it, which turns a sword arc into a rigid ribbon
 * bolted to the blade. So the mesh hangs off the scene root, the recorded
 * points are absolute, and the component carries the entity's visibility across
 * by hand (see `entitySubtreeVisible`).
 *
 * ## Sampled after the pose is final
 *
 * The tick runs in the late-update stage, after the animator, after IK, after
 * bone-attachment sync. A trail on a weapon parented to a hand bone that
 * sampled during `onUpdate` would record the PREVIOUS frame's pose — and a
 * sword trail that lags the sword by one frame is exactly the artefact nobody
 * can name but everybody sees.
 *
 * ## The tail is cut, not popped
 *
 * The oldest point is not simply deleted when it expires: the tail vertex is
 * interpolated to the position it should have at exactly `time` seconds old, so
 * the trail retreats smoothly. Deleting whole points makes the end of the trail
 * twitch backwards by one segment at a time, which reads as a stutter and gets
 * blamed on the frame rate.
 */
export class TrailRendererComponent extends Component {
  static type = "trail";
  static label = "Trail Renderer";
  static tags = ["vfx", "3d", "play-mode"];
  // The recorded history is runtime state, not props — leaving Play must not
  // leave a streak from wherever the object got to back to its authored spot.
  static resetOnStop = true;
  static defaults = {
    time: 1,
    minVertexDistance: 0.05,
    emitting: true,
    startWidth: 0.2,
    endWidth: 0,
    startColor: "#ffffff",
    endColor: "#ffffff",
    startAlpha: 1,
    endAlpha: 0,
    texture: "",
    textureMode: "stretch",
    tiling: 1,
    alignment: "view",
    blending: "alpha",
  };
  static schema = [
    { key: "time", label: "Time", type: "number", min: 0.01, step: 0.05 },
    { key: "minVertexDistance", label: "Min Vertex Dist", type: "number", min: 0.001, step: 0.01 },
    { key: "emitting", label: "Emitting", type: "boolean" },
    { key: "startWidth", label: "Start Width", type: "number", min: 0, step: 0.01 },
    { key: "endWidth", label: "End Width", type: "number", min: 0, step: 0.01 },
    { key: "startColor", label: "Start Color", type: "color" },
    { key: "startAlpha", label: "Start Alpha", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "endColor", label: "End Color", type: "color" },
    { key: "endAlpha", label: "End Alpha", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "texture", label: "Texture", type: "asset", exts: ["png", "jpg", "jpeg", "webp"] },
    { key: "textureMode", label: "Texture Mode", type: "select", options: ["stretch", "tile"], showIf: (props) => !!props.texture },
    { key: "tiling", label: "Tiling", type: "number", min: 0.01, step: 0.1, showIf: (props) => !!props.texture },
    { key: "alignment", label: "Alignment", type: "select", options: ["view", "local"] },
    { key: "blending", label: "Blending", type: "select", options: ["alpha", "additive"] },
  ];

  onAttach() {
    this.generation = (this.generation ?? 0) + 1;
    this.loadedTexture = null;
    /** Oldest first: `[{x, y, z, birth}, …]`. The last entry is the head and
     *  tracks the entity every frame until it is far enough to be committed. */
    this.points = [];
    this.ribbon = new RibbonMesh(this.#buildMaterial(), { name: "__trailRenderer" });
    this.ribbon.mesh.userData.entityId = this.entity.id;
    this.ribbon.mesh.userData.noBatch = true;
    this.ribbon.mesh.userData.noDecal = true;
    this.ribbon.mesh.matrixAutoUpdate = false;
    this.ribbon.mesh.matrix.identity();
    this.ribbon.mesh.matrixWorld.identity();
    this.entity.engine?.scene.add(this.ribbon.mesh);
    if (this.props.texture) this.#loadTexture(this.props.texture);
    // Order 200: after the animator (0), after IK (0) and after bone-attachment
    // sync (100), so a trail on an attached weapon samples the final pose.
    this.unsubTick = this.entity.engine?.onLateUpdate(() => this.tick(), 200);
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    this.unsubTick?.();
    this.unsubTick = null;
    this.ribbon?.dispose();
    this.ribbon = null;
    this.loadedTexture?.dispose();
    this.loadedTexture = null;
    this.points = [];
  }

  onDisable() {
    if (this.ribbon) this.ribbon.mesh.visible = false;
  }

  #buildMaterial() {
    return createRibbonMaterial({
      alignment: this.props.alignment,
      blending: this.props.blending,
      map: this.loadedTexture,
      color: 0xffffff,
      opacity: 1,
    });
  }

  async #loadTexture(path) {
    const generation = this.generation;
    try {
      const texture = await loadTextureAsset(path, { colorSpace: THREE.SRGBColorSpace });
      if (generation !== this.generation || !this.ribbon) {
        texture.dispose();
        return;
      }
      applyRibbonWrap(texture, this.props.textureMode);
      this.loadedTexture?.dispose();
      this.loadedTexture = texture;
      this.#swapMaterial();
    } catch (err) {
      console.warn(`Trail renderer texture failed to load: ${path}`, err);
    }
  }

  #swapMaterial() {
    if (!this.ribbon) return;
    const old = this.ribbon.mesh.material;
    this.ribbon.setMaterial(this.#buildMaterial());
    old?.dispose?.();
  }

  // ---- simulation -----------------------------------------------------------

  /** One frame of recording + rebuild. Public so a test can drive it. */
  tick() {
    if (!this.ribbon) return;
    const engine = this.entity.engine;
    if (!this.enabled) {
      this.ribbon.mesh.visible = false;
      return;
    }
    // Game time, deliberately: a trail is part of the world, so bullet time
    // must stretch it and a pause must freeze it exactly where it is.
    const now = engine?.elapsedTime ?? 0;
    if (this.props.emitting !== false) this.#record(now);
    this.#expire(now);
    this.#rebuild(now);
  }

  #record(now) {
    this.entity.object3D.updateWorldMatrix(true, false);
    _worldPosition.setFromMatrixPosition(this.entity.object3D.matrixWorld);
    const points = this.points;
    if (points.length < 2) {
      // The first sample seeds BOTH the anchor and the head. One point is not a
      // ribbon, so a trail that never got a second sample would render nothing
      // at all — including the frame an object is spawned and destroyed in.
      points.length = 0;
      points.push({ x: _worldPosition.x, y: _worldPosition.y, z: _worldPosition.z, birth: now });
      points.push({ x: _worldPosition.x, y: _worldPosition.y, z: _worldPosition.z, birth: now });
      return;
    }
    // The head ALWAYS tracks the object, every frame, so the ribbon stays
    // attached to it rather than lagging up to `minVertexDistance` behind.
    const head = points[points.length - 1];
    head.x = _worldPosition.x;
    head.y = _worldPosition.y;
    head.z = _worldPosition.z;
    head.birth = now;

    // Committing means pushing a NEW head and letting the old one stay where it
    // is. The distance is measured from the last committed vertex to the head —
    // measuring to the raw object position instead leaves the freshly committed
    // vertex still a full `minVertexDistance` from its anchor, so the very next
    // frame commits a second, duplicate vertex at the same spot.
    const anchor = points[points.length - 2];
    const dx = head.x - anchor.x;
    const dy = head.y - anchor.y;
    const dz = head.z - anchor.z;
    const minDistance = Math.max(1e-4, this.props.minVertexDistance ?? 0.05);
    if (dx * dx + dy * dy + dz * dz >= minDistance * minDistance && points.length < MAX_POINTS) {
      points.push({ x: head.x, y: head.y, z: head.z, birth: now });
    }
  }

  #expire(now) {
    const lifetime = Math.max(1e-4, this.props.time ?? 1);
    const points = this.points;
    // Drop a point only once the one AFTER it has also expired — the survivor
    // is what the tail is interpolated toward, so removing it eagerly is what
    // makes the end of the trail jump.
    while (points.length >= 2 && now - points[1].birth >= lifetime) points.shift();
    if (points.length === 1 && now - points[0].birth >= lifetime) points.length = 0;
  }

  #rebuild(now) {
    const points = this.points;
    const lifetime = Math.max(1e-4, this.props.time ?? 1);
    const count = points.length;
    if (count < 2) {
      this.ribbon.buffer.vertexCount = 0;
      this.ribbon.buffer.indexCount = 0;
      this.ribbon.upload();
      return;
    }
    if (!this._flat || this._flat.length < count * 3) {
      this._flat = new Float32Array(count * 3 * 2);
      this._params = new Float32Array(count * 2);
    }
    // Written head-first (newest → oldest) so `t` runs 0..1 from the object
    // outward: "start" colour/width means at the object, which is what an
    // author means by the start of a trail.
    for (let i = 0; i < count; i++) {
      const p = points[count - 1 - i];
      this._flat[i * 3] = p.x;
      this._flat[i * 3 + 1] = p.y;
      this._flat[i * 3 + 2] = p.z;
      this._params[i] = Math.min(1, Math.max(0, (now - p.birth) / lifetime));
    }
    // Smooth tail: the oldest point is past its lifetime, so cut the last
    // segment where the trail should actually end right now.
    const oldest = points[0];
    const oldestAge = now - oldest.birth;
    if (oldestAge > lifetime && count >= 2) {
      const next = points[1];
      const nextAge = now - next.birth;
      const span = oldestAge - nextAge;
      const u = span > 1e-6 ? (oldestAge - lifetime) / span : 0;
      const last = count - 1;
      this._flat[last * 3] = oldest.x + (next.x - oldest.x) * u;
      this._flat[last * 3 + 1] = oldest.y + (next.y - oldest.y) * u;
      this._flat[last * 3 + 2] = oldest.z + (next.z - oldest.z) * u;
      this._params[last] = 1;
    }

    buildRibbon(this.ribbon.buffer, this._flat, count, {
      params: this._params,
      startWidth: this.props.startWidth,
      endWidth: this.props.endWidth,
      startColor: toLinearRgba(this.props.startColor, this.props.startAlpha),
      endColor: toLinearRgba(this.props.endColor, this.props.endAlpha),
      textureMode: this.props.textureMode,
      tiling: this.props.tiling,
    });
    this.ribbon.upload();
    this.ribbon.mesh.visible =
      this.enabled && this.ribbon.buffer.indexCount > 0 && entitySubtreeVisible(this.entity);
  }

  // ---- script API -----------------------------------------------------------

  /** Drops the recorded history. The trail vanishes this frame — what a
   *  teleport needs, since the alternative is a streak across the level. */
  clear() {
    this.points = [];
    if (this.ribbon) {
      this.ribbon.buffer.vertexCount = 0;
      this.ribbon.buffer.indexCount = 0;
      this.ribbon.upload();
    }
    return this;
  }

  setEmitting(value) {
    this.setProp("emitting", !!value);
    return this;
  }

  get pointCount() {
    return this.points.length;
  }

  onPropChanged(key) {
    if (!this.ribbon) {
      super.onPropChanged(key);
      return;
    }
    if (key === "texture") {
      if (this.props.texture) {
        this.#loadTexture(this.props.texture);
      } else {
        this.loadedTexture?.dispose();
        this.loadedTexture = null;
        this.#swapMaterial();
      }
      return;
    }
    if (key === "alignment" || key === "blending") {
      this.#swapMaterial();
      return;
    }
    if (key === "textureMode") applyRibbonWrap(this.loadedTexture, this.props.textureMode);
    // Everything else is read on the next tick.
  }
}
