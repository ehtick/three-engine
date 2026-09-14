import { Box3, Matrix4, Vector3 } from "three/webgpu";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";

const worldUp = new Vector3(0, 1, 0);

/**
 * ⭐ PER-CASCADE CASTERS — GEOMETRIC (09-14, second cut).
 *
 * ⛔ THE FIRST CUT WAS A TIER TABLE (near+mid in cascade 0, mid+impostor in 1,
 * impostor in 2) and shadows popped in front of the owner: a foliage tier is
 * chosen by distance ÷ INSTANCE SCALE, so a 1.6× tree is still "near" at 45 m
 * and "mid" at 80 m — well inside the cascades the table had dropped it from.
 * Owner rule: "we must never see shadows suddenly appearing / disappearing".
 *
 * A caster is kept in a cascade whenever ANY shadow it can cast may land on a
 * receiver that cascade shades:
 *   receivers  — world distance from the viewer of every point whose linear
 *                depth selects this cascade: [z0 − fade, (z1 + fade) · sec(corner ray)]
 *                (distance ≥ depth; the frustum corner ray is the longest);
 *   caster     — the mesh publishes where its shadow weight can be live, in
 *                world metres from the viewer (`userData.shadowCasterRange`,
 *                already widened by its instance-scale bounds), and its tallest
 *                caster (`userData.shadowCasterHeight`);
 *   reach      — height · (1 + cot(sun elevation)): how far from its root a
 *                caster's shadow can fall, plus its own extent.
 * Kept iff the two ranges overlap after widening by reach. The only other skip
 * is a caster smaller than one texel of the cascade (a sub-texel blade cannot
 * cast a visible shadow). Meshes that publish nothing are always drawn.
 * `__csmCascadeCasters = false` draws every caster in every cascade.
 */
export function cascadeReceiverRange(csm, cascade) {
  const camera = csm?.camera, breaks = csm?.breaks;
  if (!camera?.isPerspectiveCamera || !breaks?.length || cascade >= breaks.length) return null;
  const depthFar = Math.min(csm.maxFar, camera.far);
  const edge0 = cascade === 0 ? 0 : breaks[cascade - 1], edge1 = breaks[cascade];
  // three's fade blend (CSMShadowNode._setupFade): margin = 0.25·edge², split around each edge.
  const fade0 = cascade === 0 ? 0 : .125 * edge0 * edge0, fade1 = cascade === breaks.length - 1 ? 0 : .125 * edge1 * edge1;
  const tanV = Math.tan(THREE_DEG * camera.fov * .5) / Math.max(1e-6, camera.zoom ?? 1), tanH = tanV * (camera.aspect || 1);
  const corner = Math.sqrt(1 + tanV * tanV + tanH * tanH);
  const shadowCamera = csm.lights?.[cascade]?.shadow?.camera, mapSize = csm.lights?.[cascade]?.shadow?.mapSize;
  const texel = shadowCamera && mapSize ? (shadowCamera.right - shadowCamera.left) / Math.max(1, mapSize.width) : 0;
  return { near: Math.max(0, (edge0 - fade0) * depthFar), far: (edge1 + fade1) * depthFar * corner, texel };
}

export function shadowReach(height, direction) {
  const y = direction ? -direction.y : NaN;
  if (!(y > 0)) return Infinity;
  const elevation = Math.asin(Math.min(1, y));
  const cot = 1 / Math.tan(Math.max(elevation, 3 * THREE_DEG));
  return height * (1 + cot);
}

export function csmCascadeCasts(object, receivers, reachFor) {
  if (globalThis.__csmCascadeCasters === false || !receivers) return true;
  const data = object?.userData, range = data?.shadowCasterRange, height = data?.shadowCasterHeight;
  if (!range || !(height > 0)) return true;
  if (height < receivers.texel) return false;
  const reach = reachFor(height);
  if (!Number.isFinite(reach)) return true;
  return range[1] + reach >= receivers.near && range[0] - reach <= receivers.far;
}

/** Runs one cascade's shadow render with its caster filter layered over the
 * shadow render-object function three installed for this pass. */
export function renderWithCascadeCasters(renderer, receivers, reachFor, render) {
  const drawShadow = renderer.getRenderObjectFunction();
  if (typeof drawShadow !== "function" || !receivers) return render();
  renderer.setRenderObjectFunction((object, ...args) => {
    if (csmCascadeCasts(object, receivers, reachFor)) drawShadow(object, ...args);
  });
  try { return render(); } finally { renderer.setRenderObjectFunction(drawShadow); }
}

const THREE_DEG = Math.PI / 180;

export class EngineCSMShadowNode extends CSMShadowNode {
  constructor(light, data = {}) {
    super(light, data);
    this._boundProjection = new Matrix4();
    this._boundCamera = null;
    this._boundSettings = [];
    this._lightWorld = new Vector3();
    this._targetWorld = new Vector3();
    this._directionWorld = new Vector3();
    this._orientation = new Matrix4();
    this._cameraToLight = new Matrix4();
    this._worldToParent = new Matrix4();
    this._bounds = new Box3();
    this._point = new Vector3();
    this._center = new Vector3();
  }

  updateFrustums() {
    super.updateFrustums();
    this._boundCamera = this.camera;
    this._boundProjection.copy(this.camera.projectionMatrix);
    this._boundSettings = [this.maxFar, this.mode, this.fade, this.cascades, this.customSplitsCallback];
  }

  _init(builder) {
    super._init(builder);
    // `shadow()` returns a node proxy whose set trap writes the instance, so
    // this shadows the prototype method `updateShadow` calls.
    this._shadowNodes.forEach((node, cascade) => {
      if (node.__cascadeCasters) return;
      const renderShadow = node.renderShadow, csm = this;
      node.renderShadow = function (frame) {
        const receivers = cascadeReceiverRange(csm, cascade);
        const direction = csm._directionWorld;
        return renderWithCascadeCasters(frame.renderer, receivers, height => shadowReach(height, direction), () => renderShadow.call(this, frame));
      };
      node.__cascadeCasters = true;
    });
    // Receipt for a live editor: which build of this node is actually running.
    globalThis.__csmCascadeCastersInstalled = (globalThis.__csmCascadeCastersInstalled ?? 0) + 1;
  }

  _initCascades() {
    // CameraComponent/Engine own projection updates. Upstream reconstructs the
    // matrix here, which would erase a supplied off-axis or custom projection.
    this.mainFrustum.setFromProjectionMatrix(this.camera.projectionMatrix, this.maxFar);
    this.mainFrustum.split(this.breaks, this.frustums);
  }

  prepare(camera, { force = false } = {}) {
    // setup() must retain ownership of lazy initialization, including renderer
    // depth conventions. Setting camera before _init() would bypass it entirely.
    if (!camera || this.mainFrustum === null) return;
    this.camera = camera;
    camera.updateWorldMatrix(true, false);
    const settings = this._boundSettings;
    if (force || camera !== this._boundCamera
      || !this._boundProjection.equals(camera.projectionMatrix)
      || settings[0] !== this.maxFar || settings[1] !== this.mode
      || settings[2] !== this.fade || settings[3] !== this.cascades
      || settings[4] !== this.customSplitsCallback) {
      this.updateFrustums();
    }
    this._poseCascades();
  }

  updateBefore() {
    // Still needed for the first lazy setup and renders outside Engine.#tick.
    this.prepare(this.camera);
  }

  _poseCascades() {
    const light = this.light;
    const parent = light.parent;
    if (!parent) return;
    light.updateWorldMatrix(true, false);
    light.target.updateWorldMatrix(true, false);
    this._lightWorld.setFromMatrixPosition(light.matrixWorld);
    this._targetWorld.setFromMatrixPosition(light.target.matrixWorld);
    this._directionWorld.subVectors(this._targetWorld, this._lightWorld).normalize();
    this._orientation.lookAt(this._lightWorld, this._targetWorld, worldUp);
    this._cameraToLight.copy(this._orientation).invert().multiply(this.camera.matrixWorld);
    this._worldToParent.copy(parent.matrixWorld).invert();

    for (let i = 0; i < this.frustums.length; i++) {
      const cascade = this.lights[i];
      const shadow = cascade.shadow;
      const camera = shadow.camera;
      const vertices = this.frustums[i].vertices;
      this._bounds.makeEmpty();
      for (let j = 0; j < 4; j++) {
        this._bounds.expandByPoint(this._point.copy(vertices.near[j]).applyMatrix4(this._cameraToLight));
        this._bounds.expandByPoint(this._point.copy(vertices.far[j]).applyMatrix4(this._cameraToLight));
      }
      this._bounds.getCenter(this._center);
      this._center.z = this._bounds.max.z + this.lightMargin;
      const texelX = (camera.right - camera.left) / shadow.mapSize.width;
      const texelY = (camera.top - camera.bottom) / shadow.mapSize.height;
      this._center.x = Math.floor(this._center.x / texelX) * texelX;
      this._center.y = Math.floor(this._center.y / texelY) * texelY;
      this._center.applyMatrix4(this._orientation);

      if (cascade.parent !== parent) parent.add(cascade);
      if (cascade.target.parent !== parent) parent.add(cascade.target);
      cascade.position.copy(this._center).applyMatrix4(this._worldToParent);
      cascade.target.position.copy(this._center).add(this._directionWorld).applyMatrix4(this._worldToParent);
      // Renderer scene traversal has already happened when updateBefore runs.
      // Resolve both now; preRender's freeze must also see these current inputs.
      cascade.updateWorldMatrix(false, false);
      cascade.target.updateWorldMatrix(false, false);
    }
  }
}
