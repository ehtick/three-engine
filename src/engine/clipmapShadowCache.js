import { Object3D, Object3DNode, Material, ShadowNode, VSMShadowMap } from "three/webgpu";
import { renderGroup } from "three/tsl";

// A retained depth texture exists only while a stable map mixes static and
// moving casters (plus color when transmitted shadows sample it). shadow.map
// remains the native combined map, including its PCF.
const MATERIAL_VALUES = ["version", "visible", "side", "shadowSide", "alphaTest", "alphaHash",
  "opacity", "transparent", "depthWrite", "depthTest", "depthFunc", "displacementScale",
  "displacementBias", "clipShadows", "clipIntersection", "wireframe"];
const NODE_VALUES = ["positionNode", "castShadowPositionNode", "vertexNode", "depthNode",
  "colorNode", "opacityNode", "alphaTestNode", "shadowNode", "castShadowNode", "maskNode", "maskShadowNode"];
const same = (a, b) => !!a && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const appendMatrix = (out, matrix) => { if (matrix) out.push(...matrix.elements); };

function appendAttribute(out, attribute) {
  out.push(attribute, attribute?.version, attribute?.count, attribute?.itemSize,
    attribute?.normalized, attribute?.usage, attribute?.data, attribute?.data?.version);
}

function appendTexture(out, texture) {
  out.push(texture, texture?.version, texture?.source, texture?.source?.version,
    texture?.mapping, texture?.channel, texture?.wrapS, texture?.wrapT,
    texture?.minFilter, texture?.magFilter, texture?.flipY);
  if (!texture) return;
  // Texture transforms can change without needsUpdate/version changing.
  out.push(texture.offset?.x, texture.offset?.y, texture.repeat?.x, texture.repeat?.y,
    texture.center?.x, texture.center?.y, texture.rotation, texture.matrixAutoUpdate);
  // With automatic transforms this matrix is derived from the values above
  // during the draw. Its first lazy update must not look like an authored edit.
  if (texture.matrixAutoUpdate === false) appendMatrix(out, texture.matrix);
}

function appendValue(out, value) {
  if (value?.isMatrix4 || value?.isMatrix3) out.push(...value.elements);
  else if (value?.isVector2) out.push(value.x, value.y);
  else if (value?.isVector3) out.push(value.x, value.y, value.z);
  else if (value?.isVector4 || value?.isQuaternion) out.push(value.x, value.y, value.z, value.w);
  else if (value?.isColor) out.push(value.r, value.g, value.b);
  else if (value?.isTexture) appendTexture(out, value);
  else out.push(value);
}

// Per-draw updaters whose inputs this cache already compares: object and
// instance transforms (motion), the shadow camera (map key), material fields
// (receipts below) and uniform groups, which only schedule an upload.
const INSTANCE_UPDATERS = new Set(["InstanceNode", "InstancedMeshNode"]);
function benignUpdater(node) {
  if (node.isUniformGroup || node.isMaterialReferenceNode || node instanceof Object3DNode) return true;
  if (INSTANCE_UPDATERS.has(node.constructor?.type)) return true;
  return node.isUniformNode === true && node.groupNode === renderGroup && /^camera/i.test(node.name ?? "");
}
const nodeLabel = (node) => `${node.constructor?.type ?? node.constructor?.name ?? "node"}${node.name ? `:${node.name}` : ""}`;

// What three actually BUILT for a caster's shadow draw. A node graph cannot be
// judged by walking it: `Fn` bodies stay opaque until build (foliage wind reads
// a JS-driven `time` uniform inside one). 09-14: calling every graph animated
// classified all 54 casters of the Complex scene as moving, so no clipmap level
// ever held. Until its first shadow draw is observed, a graph stays moving.
function readBuiltState(state, verdict) {
  for (const list of [state.updateNodes, state.updateBeforeNodes, state.updateAfterNodes]) {
    for (const node of list || []) {
      if (node.isMaterialReferenceNode && node.property) verdict.materialProperties.add(node.property);
      if (benignUpdater(node)) continue;
      verdict.animated = true;
      verdict.reasons.add(nodeLabel(node));
    }
  }
  for (const group of state.bindings || []) {
    for (const binding of group.bindings || []) {
      if (binding.isStorageBuffer) {
        verdict.animated = true;
        verdict.reasons.add(`storage:${binding.name}`);
        continue;
      }
      for (const uniform of binding.uniforms || []) {
        const node = uniform.nodeUniform?.node;
        // Plain uniforms: a changed value is motion (see `describeCaster`).
        if (node && node.updateType === "none") verdict.uniforms.add(node);
      }
      const texture = binding.textureNode?.value;
      if (!texture) continue;
      if (texture.isRenderTargetTexture || texture.isVideoTexture || texture.isStorageTexture) {
        verdict.animated = true;
        verdict.reasons.add(`texture:${binding.name}`);
      } else verdict.textures.add(binding.textureNode);
    }
  }
  verdict.revision++;
}

function describeCaster(object, built) {
  const geometry = object.geometry;
  const observed = built && built.material === object.material ? built : null;
  const motion = [object.count];
  const reasons = [];
  appendMatrix(motion, object.matrixWorld);
  appendAttribute(motion, object.instanceMatrix);
  const vertices = [];
  appendAttribute(vertices, geometry?.attributes?.position);
  const values = [object, object.parent, object.layers.mask, geometry, geometry?.drawRange?.start,
    geometry?.drawRange?.count, object.count, object.frustumCulled, object.renderOrder];
  appendMatrix(values, object.matrixWorld);
  appendAttribute(values, geometry?.index);
  for (const name of Object.keys(geometry?.attributes || {}).sort()) {
    values.push(name);
    appendAttribute(values, geometry.attributes[name]);
  }
  for (const group of geometry?.groups || []) values.push(group.start, group.count, group.materialIndex);
  appendAttribute(values, object.instanceMatrix);
  appendAttribute(values, object.instanceColor);
  let animated = false;
  const animate = (reason) => { animated = true; reasons.push(reason); };
  if (object.isSkinnedMesh) animate("skinned");
  if (object.morphTargetInfluences?.length) animate("morph");
  if (object.isBatchedMesh) animate("batched");
  if (object.userData?.vfxSimulation) animate("vfx");
  // Unknown callbacks may mutate buffers/uniforms only when the shadow draws.
  for (const name of ["onBeforeRender", "onAfterRender", "onBeforeShadow", "onAfterShadow"]) {
    if (object[name] !== Object3D.prototype[name]) animate(`object.${name}`);
  }
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) {
    values.push(material);
    if (!material) continue;
    for (const name of MATERIAL_VALUES) values.push(material[name]);
    // A node graph read nothing a version tracks until its build is observed.
    if (!observed && NODE_VALUES.some((name) => material[name])) animate("graph not yet observed");
    if (material.onBeforeRender !== Material.prototype.onBeforeRender) animate("material.onBeforeRender");
    if (material.onBeforeCompile !== Material.prototype.onBeforeCompile) animate("material.onBeforeCompile");
    for (const name of Object.keys(material).sort()) {
      if (material[name]?.isTexture) {
        values.push(name);
        appendTexture(values, material[name]);
        if (material[name].isVideoTexture || material[name].isRenderTargetTexture) animate(`texture:${name}`);
      }
    }
    for (const plane of material.clippingPlanes || []) {
      values.push(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    }
    if (observed) for (const property of observed.materialProperties) appendValue(values, material[property]);
  }
  if (observed) {
    if (observed.animated) for (const reason of observed.reasons) animate(reason);
    values.push(observed.revision);
    for (const node of observed.uniforms) appendValue(motion, node.value);
    for (const node of observed.textures) appendTexture(values, node.value);
  }
  return { values, animated, motion, vertices, geometry, reasons, builtRevision: observed?.revision ?? -1 };
}

/** Shared by all levels; strong references never outlive current casters. */
export class ClipmapShadowCache {
  constructor() {
    this.records = new Map();
    this.staticObjects = new Set();
    this.movingObjects = new Set();
    this.promoted = new WeakSet();
    this.built = new WeakMap();
    this.staticRevision = 0;
    this.revision = 0;
    this.generation = 0;
    this._frameId = undefined;
    this._pruneFrameId = undefined;
    this._scene = null;
    this.stats = { walks: 0, staticCasters: 0, movingCasters: 0, movingReasons: {} };
  }

  /** Records what a caster's shadow draw was built from (`readBuiltState`). */
  observe(renderObject) {
    const object = renderObject?.object;
    if (!object) return;
    let state;
    try { state = renderObject.getNodeBuilderState?.(); } catch { return; }
    if (!state) return;
    let verdict = this.built.get(object);
    if (!verdict || verdict.material !== object.material) {
      verdict = { material: object.material, states: new WeakSet(), animated: false, reasons: new Set(),
        uniforms: new Set(), textures: new Set(), materialProperties: new Set(), revision: 0 };
      this.built.set(object, verdict);
    }
    if (verdict.states.has(state)) return;
    verdict.states.add(state);
    readBuiltState(state, verdict);
  }

  prepare(scene, renderer, frameId) {
    if (frameId !== undefined && this._frameId === frameId && this._scene === scene) return this;
    this._frameId = frameId;
    this._scene = scene;
    this.stats.walks++;
    const seen = new Set();
    const movingReasons = {};
    let staticChanged = false;
    let changed = false;
    scene.traverseVisible((object) => {
      if (!object.isMesh || object.castShadow !== true) return;
      seen.add(object);
      const description = describeCaster(object, this.built.get(object));
      const previous = this.records.get(object);
      const differs = !previous || !same(previous.values, description.values);
      // A mover leaves the static map on its first changed frame. It remains
      // moving, so subsequent frames do not re-render the static environment.
      // A newly observed build changes what motion lists; compare from then on.
      const moved = previous && ((previous.builtRevision === description.builtRevision
        && !same(previous.motion, description.motion))
        || (previous.geometry === description.geometry && !same(previous.vertices, description.vertices)));
      if (moved) this.promoted.add(object);
      const moving = description.animated || this.promoted.has(object);
      if (!previous || previous.moving !== moving || (!moving && differs)) staticChanged = true;
      if (differs || description.animated || previous?.moving !== moving) changed = true;
      this.records.set(object, { ...description, moving });
      (moving ? this.movingObjects : this.staticObjects).add(object);
      (moving ? this.staticObjects : this.movingObjects).delete(object);
      if (moving) {
        for (const reason of description.animated ? description.reasons : ["promoted (moved or uniform changed)"]) {
          movingReasons[reason] = (movingReasons[reason] ?? 0) + 1;
        }
      }
    });
    for (const [object, record] of this.records) {
      if (seen.has(object)) continue;
      this.records.delete(object);
      this.staticObjects.delete(object);
      this.movingObjects.delete(object);
      if (!record.moving) staticChanged = true;
      changed = true;
    }
    if (staticChanged) this.staticRevision++;
    if (changed) this.revision++;
    this.stats.staticCasters = this.staticObjects.size;
    this.stats.movingCasters = this.movingObjects.size;
    this.stats.movingReasons = movingReasons;
    return this;
  }

  /** Release removed casters while a moving light bypasses full descriptions. */
  prune(scene, frameId) {
    if (frameId !== undefined && this._pruneFrameId === frameId && this._scene === scene) return;
    this._pruneFrameId = frameId;
    let changed = false;
    let staticChanged = false;
    for (const [object, record] of this.records) {
      let parent = object;
      while (parent && parent !== scene && parent.visible !== false) parent = parent.parent;
      if (object.castShadow === true && object.isMesh && parent === scene && scene.visible !== false) continue;
      this.records.delete(object);
      this.staticObjects.delete(object);
      this.movingObjects.delete(object);
      staticChanged ||= !record.moving;
      changed = true;
    }
    if (staticChanged) this.staticRevision++;
    if (changed) this.revision++;
    this.stats.staticCasters = this.staticObjects.size;
    this.stats.movingCasters = this.movingObjects.size;
  }

  invalidate() {
    this.generation++;
    this.staticRevision++;
    this.revision++;
    this._frameId = undefined;
  }

  dispose() {
    this.records.clear();
    this.staticObjects.clear();
    this.movingObjects.clear();
    this.promoted = new WeakSet();
    this.built = new WeakMap();
    this._scene = null;
    this.invalidate();
  }
}

function mapKey(node, renderer) {
  const { shadow, shadowMap } = node;
  const key = [shadowMap, shadowMap.depthTexture, shadowMap.depthTexture.version,
    shadow.mapSize.x, shadow.mapSize.y, shadow.camera.layers.mask, renderer.shadowMap.type,
    renderer.shadowMap.transmitted, renderer.reversedDepthBuffer];
  appendMatrix(key, shadow.camera.matrixWorld);
  appendMatrix(key, shadow.camera.projectionMatrix);
  for (const plane of renderer.clippingPlanes || []) key.push(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  return key;
}

/** Only successful native draws may become a receipt, including async warm-up. */
function renderWithReceipt(renderer, render) {
  const pipelines = renderer._pipelines;
  const original = pipelines?.isReady;
  const state = pipelines?.__asyncRenderPipelines;
  const deferred = state?.deferred;
  const buildsDeferred = state?.buildsDeferred;
  const parkedDraws = state?.parkedDraws;
  let complete = true;
  if (original) {
    pipelines.isReady = function (object) {
      const ready = original.call(this, object);
      const data = this.get?.(object);
      // A stand-in preserves the picture while recompiling, but must never be
      // committed as the new material's permanently cached shadow.
      if (!ready || object.__previousDraw || data?.__standIn) complete = false;
      return ready;
    };
  }
  try {
    render();
  } finally {
    if (original) pipelines.isReady = original;
  }
  return complete && deferred === state?.deferred && buildsDeferred === state?.buildsDeferred
    && parkedDraws === state?.parkedDraws;
}

/** Lets the cache read each shadow draw's built node state while `render` runs. */
function renderObserved(renderer, cache, render) {
  const nodes = renderer._nodes;
  const original = nodes?.updateForRender;
  if (typeof original !== "function") return render();
  const own = Object.prototype.hasOwnProperty.call(nodes, "updateForRender");
  nodes.updateForRender = function (renderObject) {
    cache.observe(renderObject);
    return original.apply(this, arguments);
  };
  try {
    return render();
  } finally {
    if (own) nodes.updateForRender = original;
    else delete nodes.updateForRender;
  }
}

/**
 * Which foliage LOD tier (0 near, 1 mid, 2 impostor) clipmap `level` of
 * `levels` draws: null (skip), "force" (every instance the tier's mesh holds
 * casts, whatever its viewer-distance weight) or "natural" (the tier's own
 * per-plant crossfade). Finest level: near geometry; second: mid geometry;
 * middle levels: mid + impostor handing over at the colour mid→impostor band;
 * outermost: impostors. Where two levels meet, the clipmap's coverage blend is
 * the smooth transition between their LODs (09-14 owner: "make a smooth
 * transition from one to the other").
 */
export function foliageShadowTierRule(tier, level, levels) {
  const last = Math.max(0, levels - 1);
  if (tier === 0) return level === 0 ? "force" : null;
  if (tier === 1) {
    if (level === 0) return null;
    if (level === 1) return last === 1 ? "natural" : "force";
    return level < last || level === 2 ? "natural" : null;
  }
  if (tier === 2) return level >= 2 || (level === last && level > 0) ? "natural" : null;
  return "natural";
}

export class ClipmapLevelShadowNode extends ShadowNode {
  constructor(light, shadow, index, { cache, enabled = true, levels = 3 } = {}) {
    super(light, shadow);
    this.levels = levels;
    this.cache = cache || new ClipmapShadowCache();
    this._ownsCache = !cache;
    this.cacheEnabled = enabled;
    this.levelIndex = index;
    this.shadow.clipmapCacheOwned = true;
    this._staticMap = null;
    this._staticReceipt = null;
    this._combinedReceipt = null;
    this._lastMapKey = null;
    this._staticColor = false;
    this.stats = { staticRenders: 0, movingRenders: 0, fullRenders: 0, holds: 0, copies: 0,
      incomplete: 0, bypasses: 0, mapChanges: 0, allStaticRenders: 0 };
  }

  invalidateCache() {
    this._staticReceipt = null;
    this._combinedReceipt = null;
  }

  renderShadow(frame) {
    const { renderer, scene } = frame;
    const { shadow, shadowMap, cache } = this;
    shadow.updateMatrices(this.light);
    shadowMap.setSize(shadow.mapSize.width, shadow.mapSize.height, shadowMap.depth);
    const key = mapKey(this, renderer);
    const mapChanged = !same(this._lastMapKey, key);
    // A moving sun or snapped volume cannot reuse the previous raster. Do not
    // traverse the scene to classify it, allocate a cache, or copy a map that
    // will immediately be obsolete; ordinary native shadow rendering suffices.
    if (mapChanged) cache.prune(scene, frame.frameId);
    else cache.prepare(scene, renderer, frame.frameId);
    const combinedKey = [...key, cache.revision, cache.generation];
    if (!mapChanged && renderer.shadowMap.type !== VSMShadowMap && same(this._combinedReceipt, combinedKey)) {
      this.stats.holds++;
      return;
    }
    const originalFunction = renderer.getRenderObjectFunction();
    const originalClear = renderer.autoClear;
    const originalName = scene.name;
    scene.name = `Shadow Clipmap ${this.levelIndex + 1} [ ${this.light.name || this.light.id} ]`;
    // Foliage casts a LOD chosen by the level, not by each plant's distance
    // (`foliageShadowTierRule`). "force" makes the mesh cast every instance it
    // holds (`userData.foliageShadowForce`, read by the foliage material's
    // per-object uniform while this draw runs). `__foliageShadowLevels = false`
    // restores the per-plant LOD shadows in every level.
    const level = this.levelIndex;
    const levels = this.levels;
    const drawCaster = (object, args) => {
      const tier = object.userData?.foliageShadowTier;
      if (tier === undefined || globalThis.__foliageShadowLevels === false) return originalFunction(object, ...args);
      const rule = foliageShadowTierRule(tier, level, levels);
      if (!rule) return;
      if (rule !== "force") return originalFunction(object, ...args);
      object.userData.foliageShadowForce = true;
      try { originalFunction(object, ...args); } finally { object.userData.foliageShadowForce = false; }
    };
    const draw = (objects, clear) => {
      renderer.autoClear = clear;
      renderer.setRenderObjectFunction((object, ...args) => {
        if (!objects || objects.has(object)) drawCaster(object, args);
      });
      return renderObserved(renderer, cache, () => renderWithReceipt(renderer, () => renderer.render(scene, shadow.camera)));
    };
    this._combinedReceipt = null;
    try {
      // VSM receives additional non-casters and performs a blur after this
      // hook; keep its full native path. WebGL has different depth-copy rules.
      const split = !mapChanged && this.cacheEnabled && renderer.backend?.isWebGPUBackend === true
        && renderer.shadowMap.type !== VSMShadowMap && cache.staticObjects.size > 0
        && cache.movingObjects.size > 0;
      let complete;
      if (!split) {
        this._disposeStaticMap();
        this.stats.bypasses++;
        if (mapChanged) this.stats.mapChanges++;
        else if (cache.movingObjects.size === 0) this.stats.allStaticRenders++;
        this.stats.fullRenders++;
        complete = draw(null, true);
      } else {
        const staticKey = [...key, cache.staticRevision, cache.generation];
        if (!same(this._staticReceipt, staticKey)) {
          this._staticReceipt = null;
          this.stats.staticRenders++;
          complete = draw(cache.staticObjects, true);
          if (complete) {
            this._ensureStaticMap(renderer);
            this._copy(renderer, shadowMap, this._staticMap);
            this._staticReceipt = [...mapKey(this, renderer), cache.staticRevision, cache.generation];
          }
        } else {
          this._copy(renderer, this._staticMap, shadowMap);
          complete = true;
        }
        if (cache.movingObjects.size > 0) {
          this.stats.movingRenders++;
          complete = draw(cache.movingObjects, false) && complete;
        }
      }
      if (complete) {
        this._lastMapKey = mapKey(this, renderer);
        this._combinedReceipt = [...this._lastMapKey, cache.revision, cache.generation];
      } else this.stats.incomplete++;
    } finally {
      renderer.autoClear = originalClear;
      renderer.setRenderObjectFunction(originalFunction);
      scene.name = originalName;
    }
  }

  _ensureStaticMap(renderer) {
    const { shadowMap } = this;
    const color = renderer.shadowMap.transmitted === true;
    if (this._staticMap && (this._staticColor !== color
      || this._staticMap.width !== shadowMap.width || this._staticMap.height !== shadowMap.height)) {
      this._disposeStaticMap();
    }
    if (this._staticMap) return;
    const target = this._staticMap = shadowMap.clone();
    this._staticColor = color;
    target.depthTexture.name = `ClipmapStaticDepth${this.levelIndex}`;
    if (color) {
      target.texture.name = `ClipmapStaticColor${this.levelIndex}`;
      renderer.initRenderTarget(target);
    } else {
      // Three's initRenderTarget requires a color attachment. This cache is
      // only copied, never rendered into, so initialize the depth texture on
      // its own and allocate no color texture or framebuffer attachment.
      target.textures.length = 0;
      renderer.initTexture(target.depthTexture);
    }
  }

  _disposeStaticMap() {
    if (this._staticMap) {
      // initTexture owns a texture disposal listener; initRenderTarget owns
      // both attachments via the target listener. Do not destroy either twice.
      if (!this._staticColor) this._staticMap.depthTexture.dispose();
      this._staticMap.dispose();
    }
    this._staticMap = null;
    this._staticReceipt = null;
  }

  _copy(renderer, source, destination) {
    if (this._staticColor) {
      renderer.copyTextureToTexture(source.texture, destination.texture);
      this.stats.copies++;
    }
    renderer.copyTextureToTexture(source.depthTexture, destination.depthTexture);
    this.stats.copies++;
  }

  _reset() {
    this._disposeStaticMap();
    this._lastMapKey = null;
    this.invalidateCache();
    super._reset();
  }

  dispose() {
    if (this._ownsCache) this.cache.dispose();
    super.dispose();
  }
}

export const createClipmapLevelShadowNode = (light, shadow, index, options) =>
  new ClipmapLevelShadowNode(light, shadow, index, options);
