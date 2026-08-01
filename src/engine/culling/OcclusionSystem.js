import * as THREE from "three/webgpu";
import { positionView, vec4 } from "three/tsl";
import { DepthPyramid, createBounds, isOccluded, projectSphere } from "./occlusionMath.js";
import { getEntityBoundingSphere } from "../viewFrustum.js";
import { OCCLUDER_LAYER } from "../editorLayers.js";

/**
 * `engine.occlusion` — hides what the depth buffer says is already behind
 * something else (roadmap item 14).
 *
 * Frustum culling answers "could this be on screen"; this answers "would any of
 * it survive the wall in front of it". In an interior, a city street or
 * anything with real occluders that is the difference between drawing the level
 * and drawing the room.
 *
 * ## Why the decision comes back to the CPU
 *
 * "GPU occlusion culling" in a GPU-driven renderer means the culling compute
 * shader writes an indirect draw buffer and the CPU never learns what was
 * culled. three submits every draw from JavaScript, so a decision that stays on
 * the GPU cannot remove a single draw call — the win would be zero. What the
 * GPU is genuinely good at here is producing the DEPTH, so it does that: a
 * low-resolution pass over the large occluders, read back asynchronously, and
 * reduced into a Hi-Z pyramid on the CPU (`occlusionMath.js`) where the test is
 * a handful of samples per object.
 *
 * The readback is a quarter of a megabyte and never awaited on the critical
 * path — the results land a frame or two later and are applied then.
 *
 * ## Why the test uses the camera the depth was captured with
 *
 * Applying a stale depth buffer against the CURRENT camera is the mistake that
 * makes occlusion culling flicker whenever the player turns. The view and
 * projection matrices are captured alongside the pixels and the test projects
 * against those, so the buffer and the maths always describe the same frame.
 * What is left over is objects that MOVED in between, which can be culled for
 * one frame as they emerge from behind an occluder — a real limitation, and a
 * far smaller one than the camera moving every frame.
 *
 * ## Only big things are occluders
 *
 * Rendering the whole scene into the depth pass would double draw submission —
 * on a CPU-bound frame, spending exactly the resource this feature exists to
 * save. Only objects above `minOccluderSize` are drawn, tagged with their own
 * layer so the pass skips everything else without even walking it. A blade of
 * grass occludes nothing anyone can measure; a wall occludes half the level.
 *
 * ## What it writes, and the two things it must not break
 *
 *  - Visibility goes through `entity._occluded`, which the engine's per-frame
 *    resolve ANDs in — the same single-writer rule LOD groups follow. Writing
 *    `object3D.visible` here would be overwritten before it was ever drawn.
 *  - A BATCHED mesh cannot be hidden this way at all: it draws through its
 *    `InstancedMesh` proxy, which only re-reads visibility on rebuild, and
 *    invalidating the batch every time one prop went behind a wall would
 *    rebuild the scene's grouping every frame. Batched entities are therefore
 *    skipped, and the PROXIES are tested instead — one test that hides a
 *    hundred props at once, which is strictly better.
 *
 * ## The honest limitation
 *
 * An occluded object stops casting its shadow, because three's shadow pass
 * skips invisible objects. That is the standard trade (Unity and Unreal both
 * make it) and it is usually invisible — an object behind a wall normally has
 * its shadow behind the same wall — but it is not free, and `cullShadowCasters`
 * turns it off for scenes where it shows.
 */

/** Occluder depth is rendered at this width; height follows the aspect. A
 *  multiple of 64 so the readback rows need no unpadding on any backend. */
const DEFAULT_WIDTH = 256;

export class OcclusionSystem {
  constructor(engine) {
    this.engine = engine;
    this.enabled = false;
    /** World-space radius an object needs before it is worth rendering as an
     *  occluder. */
    this.minOccluderSize = 1.5;
    /** Relative depth margin; see `isOccluded`. */
    this.bias = 0.02;
    /** Cull objects that cast shadows (see the note above). */
    this.cullShadowCasters = true;
    this.width = DEFAULT_WIDTH;
    this.height = Math.round(DEFAULT_WIDTH * 9 / 16);

    this.pyramid = new DepthPyramid();
    this.bounds = createBounds();
    this.target = null;
    this.material = null;
    this.pending = false;
    /** The camera the pending/current depth buffer was captured with. */
    this.captureView = new THREE.Matrix4();
    this.captureProjection = new THREE.Matrix4();
    this.pendingView = new THREE.Matrix4();
    this.pendingProjection = new THREE.Matrix4();

    this._occluderDirty = true;
    this._occluders = [];
    this._hidden = new Set();
    this._hiddenProxies = new Set();
    this._unsubscribe = [];
    this.testedLastFrame = 0;
    this.culledLastFrame = 0;
    this._sphere = new THREE.Sphere();
  }

  setEnabled(value) {
    const next = !!value;
    if (next === this.enabled) return;
    this.enabled = next;
    if (next) {
      this._occluderDirty = true;
      const invalidate = () => {
        this._occluderDirty = true;
      };
      this._unsubscribe = [
        this.engine.on("hierarchy-changed", invalidate),
        this.engine.on("component-changed", invalidate),
      ];
    } else {
      for (const off of this._unsubscribe) off();
      this._unsubscribe = [];
      this.reset();
      this.#clearOccluderTags();
      this.#disposeTarget();
    }
  }

  /**
   * Forgets everything: every hidden object comes back and the depth buffer is
   * discarded. Called on scene load and on a camera teleport, where a stale
   * buffer describes a place that no longer exists — and where the symptom
   * ("half the new level is missing for a second") is exactly the kind of bug
   * that gets blamed on loading.
   */
  reset() {
    for (const entity of this._hidden) entity._occluded = false;
    this._hidden.clear();
    for (const proxy of this._hiddenProxies) proxy.visible = true;
    this._hiddenProxies.clear();
    this.pyramid.clear();
    this.culledLastFrame = 0;
    this.testedLastFrame = 0;
  }

  /* ---------------------------------------------------------------- render */

  #ensureTarget() {
    const canvas = this.engine.renderer?.domElement;
    const aspect = canvas && canvas.height > 0 ? canvas.width / canvas.height : 16 / 9;
    const height = Math.max(16, Math.round(this.width / Math.max(aspect, 0.05)));
    if (this.target && this.height === height) return this.target;
    this.#disposeTarget();
    this.height = height;
    this.target = new THREE.RenderTarget(this.width, height, {
      // One channel of real linear distance. A packed 8-bit depth would need a
      // range assumption per scene, and getting it wrong culls buildings.
      format: THREE.RedFormat,
      type: THREE.FloatType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.target.texture.colorSpace = THREE.NoColorSpace;
    return this.target;
  }

  #disposeTarget() {
    this.target?.dispose();
    this.target = null;
  }

  #ensureMaterial() {
    if (this.material) return this.material;
    const material = new THREE.MeshBasicNodeMaterial();
    material.name = "Occluder depth";
    // The GI gbuffer's lesson, and it costs the same here: MeshBasicNodeMaterial
    // ships with `lights = true`, so an override that shades nothing still
    // builds the whole scene lighting node and binds textures it never reads.
    material.lights = false;
    material.side = THREE.FrontSide;
    // WITHOUT THIS THE PASS DOES NOT RUN AT ALL. The target is `r32float` — one
    // channel, no alpha — and a material carrying the default alpha blend asks
    // for a pipeline whose blend factors read `src.a`. WebGPU rejects the
    // pipeline outright ("Color blending srcFactor is reading alpha, but the
    // format has no alpha channel"), the draw is dropped, and the buffer keeps
    // whatever was in it. The failure surfaces only as a validation message on
    // the console, so the system looks like it is working and simply culls the
    // wrong things.
    material.blending = THREE.NoBlending;
    material.transparent = false;
    // Nothing about this pass is a picture: tone mapping a distance in metres
    // would compress 200 m into "about 1".
    material.toneMapped = false;
    // View-space distance along the camera axis, in metres. Matches what
    // `projectSphere` computes for the object being tested, so the comparison
    // needs no conversion and no near/far constants.
    material.colorNode = vec4(positionView.z.negate(), 0, 0, 1);
    this.material = material;
    return material;
  }

  /**
   * Re-tags which meshes are occluders. Runs on a dirty flag rather than every
   * frame: the tag is a layer bit, and a layer bit is part of the batching key,
   * so writing it every frame would rebuild every batch in the scene forever.
   */
  #refreshOccluders() {
    this._occluderDirty = false;
    this._occluders.length = 0;
    const minRadius = this.minOccluderSize;
    for (const entity of this.engine.entities.values()) {
      const ok = getEntityBoundingSphere(entity, this._sphere);
      const isOccluder = ok && this._sphere.radius >= minRadius;
      entity.object3D.traverse((object) => {
        if (!object.isMesh && !object.isInstancedMesh) return;
        if (object.userData?.engineOwned) return;
        if (isOccluder) object.layers.enable(OCCLUDER_LAYER);
        else object.layers.disable(OCCLUDER_LAYER);
      });
      if (isOccluder) this._occluders.push(entity);
    }
    // Batch proxies stand in for their members, so they have to carry the tag
    // too — a batched wall is drawn by its proxy and by nothing else.
    for (const batch of this.engine.batching?.batches ?? []) {
      const template = batch.members[0];
      if (template?.layers.isEnabled(OCCLUDER_LAYER)) batch.mesh.layers.enable(OCCLUDER_LAYER);
      else batch.mesh.layers.disable(OCCLUDER_LAYER);
    }
  }

  #clearOccluderTags() {
    for (const entity of this.engine.entities.values()) {
      entity.object3D.traverse((object) => {
        if (object.isMesh || object.isInstancedMesh) object.layers.disable(OCCLUDER_LAYER);
      });
    }
    this._occluders.length = 0;
  }

  /**
   * Renders this frame's occluder depth and starts a readback. Called from the
   * engine's pre-render phase, after transforms are final.
   */
  render() {
    if (!this.enabled) return;
    const renderer = this.engine.renderer;
    const camera = this.engine.camera;
    if (!renderer || !camera || !this.engine.rendererReady) return;
    if (this.pending) return; // one readback in flight; the next frame will do
    if (this._occluderDirty) this.#refreshOccluders();
    if (this._occluders.length === 0) return;

    const target = this.#ensureTarget();
    const material = this.#ensureMaterial();
    const previousTarget = renderer.getRenderTarget();
    const previousOverride = this.engine.scene.overrideMaterial;
    const previousMask = camera.layers.mask;
    const previousTransparent = renderer.transparent;
    const previousClear = new THREE.Color();
    renderer.getClearColor(previousClear);
    const previousClearAlpha = renderer.getClearAlpha();
    const previousBackground = this.engine.scene.background;

    camera.updateMatrixWorld();
    this.pendingView.copy(camera.matrixWorldInverse);
    this.pendingProjection.copy(camera.projectionMatrix);

    try {
      // A transparent surface does not hide what is behind it, and an override
      // material would draw it as though it did — the "glass wall culls the
      // room" bug, which the GI gbuffer had to learn the same way.
      renderer.transparent = false;
      // Only the occluder layer: everything else is skipped without being
      // walked, which is the whole reason the tag exists.
      camera.layers.set(OCCLUDER_LAYER);
      // The scene background is drawn as a full-screen pass that IGNORES the
      // camera's layers, so it lands in this buffer as a distance equal to
      // whatever the sky's red channel happens to be — a fraction of a metre.
      // Every object in the level is then "behind" the sky and the whole scene
      // disappears. Empty sky has to stay empty (zero), which the pyramid reads
      // as infinitely far.
      this.engine.scene.background = null;
      this.engine.scene.overrideMaterial = material;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 1);
      renderer.render(this.engine.scene, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousClear, previousClearAlpha);
      this.engine.scene.background = previousBackground;
      this.engine.scene.overrideMaterial = previousOverride;
      camera.layers.mask = previousMask;
      renderer.transparent = previousTransparent;
    }

    this.pending = true;
    renderer
      .readRenderTargetPixelsAsync(target, 0, 0, this.width, this.height)
      .then((raw) => {
        if (!this.enabled) return;
        this.pyramid.build(unpad(raw, this.width, this.height), this.width, this.height);
        this.captureView.copy(this.pendingView);
        this.captureProjection.copy(this.pendingProjection);
      })
      .catch(() => {
        // A readback can fail across a device loss or a renderer swap. Losing
        // the buffer must never mean losing the scene, so the pyramid is
        // dropped and everything hidden comes back.
        this.reset();
      })
      .finally(() => {
        this.pending = false;
      });
  }

  /* ----------------------------------------------------------------- apply */

  /**
   * Tests every candidate against the most recent pyramid and writes
   * `_occluded`. Called from the engine's tick, immediately before the pass
   * that resolves visibility.
   */
  apply() {
    if (!this.enabled || !this.pyramid.ready) return;
    const view = this.captureView;
    const projection = this.captureProjection;
    let tested = 0;
    let culled = 0;

    for (const entity of this.engine.entities.values()) {
      const wasOccluded = entity._occluded === true;
      if (!this.#testable(entity)) {
        if (wasOccluded) {
          entity._occluded = false;
          this._hidden.delete(entity);
        }
        continue;
      }
      if (!getEntityBoundingSphere(entity, this._sphere)) {
        if (wasOccluded) {
          entity._occluded = false;
          this._hidden.delete(entity);
        }
        continue;
      }
      tested++;
      const visible = projectSphere(this._sphere.center, this._sphere.radius, view, projection, this.bounds);
      const occluded = visible && isOccluded(this.pyramid, this.bounds, this.bias);
      if (occluded) {
        culled++;
        entity._occluded = true;
        this._hidden.add(entity);
      } else if (wasOccluded) {
        entity._occluded = false;
        this._hidden.delete(entity);
      }
    }

    // Batch proxies are not entities, so nothing else resolves their
    // visibility — this system owns the flag outright and can write it.
    for (const batch of this.engine.batching?.batches ?? []) {
      const mesh = batch.mesh;
      if (!mesh.boundingSphere && !mesh.geometry?.boundingSphere) continue;
      const sphere = mesh.boundingSphere ?? mesh.geometry.boundingSphere;
      tested++;
      const projected = projectSphere(sphere.center, sphere.radius, view, projection, this.bounds);
      const occluded = projected && isOccluded(this.pyramid, this.bounds, this.bias);
      if (occluded) {
        culled++;
        mesh.visible = false;
        this._hiddenProxies.add(mesh);
      } else if (this._hiddenProxies.has(mesh)) {
        mesh.visible = true;
        this._hiddenProxies.delete(mesh);
      }
    }

    this.testedLastFrame = tested;
    this.culledLastFrame = culled;
  }

  /** Whether `entity` is a candidate for being hidden this frame. */
  #testable(entity) {
    // An entity the author or the LOD system already hid is not this system's
    // business, and claiming it would double-count the stats.
    if (entity._lodHidden === true) return false;
    const mesh = entity.components?.get("mesh")?.mesh;
    const model = entity.components?.get("model");
    if (!mesh && !model) return false;
    // A batched member draws through its proxy no matter what its own
    // visibility says; the proxy is tested instead (see the header).
    if (mesh?.userData.batchedInto) return false;
    if (!this.cullShadowCasters && mesh?.castShadow) return false;
    // An occluder can itself be occluded, but testing the wall you are standing
    // behind against the depth buffer it wrote is a coin flip against the bias.
    // Excluding them costs nothing: the objects worth culling are the ones that
    // are not big enough to be occluders in the first place.
    if (mesh?.layers.isEnabled(OCCLUDER_LAYER)) return false;
    return true;
  }

  get stats() {
    return {
      enabled: this.enabled,
      occluders: this._occluders.length,
      tested: this.testedLastFrame,
      culled: this.culledLastFrame,
    };
  }

  dispose() {
    this.setEnabled(false);
    this.material?.dispose();
    this.material = null;
    this.#disposeTarget();
  }
}

/**
 * Strips WebGPU's 256-byte row alignment out of a readback.
 *
 * A red-float buffer 256 texels wide is already aligned, so this is usually a
 * pass-through — but "usually" is exactly how a sheared depth buffer ships:
 * every row after the first drifts a little further, the pyramid is built from
 * a smeared image, and objects are culled in the wrong places.
 */
function unpad(raw, width, height) {
  const rowFloats = width;
  const paddedFloats = Math.ceil((width * 4) / 256) * 64;
  if (paddedFloats === rowFloats && raw.length >= rowFloats * height) return raw;
  const out = new Float32Array(rowFloats * height);
  for (let y = 0; y < height; y++) {
    const from = y * paddedFloats;
    const available = Math.max(0, Math.min(rowFloats, raw.length - from));
    if (available > 0) out.set(raw.subarray(from, from + available), y * rowFloats);
  }
  return out;
}
