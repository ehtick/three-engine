import assert from "node:assert/strict";
import test from "node:test";
import { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, Texture, DirectionalLight,
  RenderTarget, DepthTexture, PCFShadowMap, VSMShadowMap, BufferAttribute } from "three/webgpu";
import { ClipmapShadowCache, createClipmapLevelShadowNode } from "../src/engine/clipmapShadowCache.js";

function caster(name = "caster") {
  const object = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  object.name = name;
  object.castShadow = true;
  return object;
}

function fixture() {
  const scene = new Scene();
  scene.name = "authored scene";
  const fixed = caster("fixed");
  const mover = caster("mover");
  mover.userData.vfxSimulation = true;
  scene.add(fixed, mover);
  scene.updateMatrixWorld(true);
  const light = new DirectionalLight();
  light.position.set(10, 20, 30);
  light.updateMatrixWorld(true);
  light.target.updateMatrixWorld(true);
  const cache = new ClipmapShadowCache();
  const node = createClipmapLevelShadowNode(light, light.shadow, 0, { cache });
  const map = node.shadowMap = new RenderTarget(512, 512);
  map.depthTexture = new DepthTexture(512, 512);
  const contents = new Map();
  const calls = [];
  const state = { deferred: 0, buildsDeferred: 0, parkedDraws: 0 };
  const pipelines = {
    __asyncRenderPipelines: state,
    isReady(object) { return !object.pending; },
    get(object) { return object.pipelineData || {}; },
  };
  const renderer = {
    backend: { isWebGPUBackend: true },
    shadowMap: { type: PCFShadowMap },
    _pipelines: pipelines,
    autoClear: true,
    getRenderObjectFunction() { return this.callback; },
    setRenderObjectFunction(callback) { this.callback = callback; },
    initRenderTarget(target) { calls.push(["init", target]); },
    initTexture(texture) { calls.push(["initTexture", texture]); },
    copyTextureToTexture(source, destination) {
      contents.set(destination, new Map(contents.get(source) || []));
      calls.push(["copy", source, destination]);
    },
    render(currentScene) {
      calls.push(["render", this.autoClear]);
      if (this.autoClear) {
        contents.set(map.texture, new Map());
        contents.set(map.depthTexture, new Map());
      }
      currentScene.traverseVisible((object) => {
        if (object.isMesh) this.callback(object);
      });
    },
    callback(object) {
      if (!object.castShadow) return;
      if (renderer.throwOn === object) throw new Error("draw failed");
      const renderObject = { pending: renderer.pending === object,
        pipelineData: renderer.standIn === object ? { __standIn: {} } : {} };
      if (renderer.defer === object) { state.buildsDeferred++; return; }
      if (!pipelines.isReady(renderObject)) return;
      calls.push(["draw", object.name]);
      contents.get(map.texture).set(object.name, object.position.x);
      contents.get(map.depthTexture).set(object.name, object.position.x);
    },
  };
  let frameId = 0;
  return { scene, fixed, mover, cache, node, renderer, contents, calls, map,
    run() { scene.updateMatrixWorld(true); node.renderShadow({ renderer, scene, frameId: ++frameId }); },
    pixels() { return [...contents.get(map.depthTexture)]; },
    draws() { return calls.filter(([op]) => op === "draw").map(([, name]) => name); },
  };
}

test("all levels share one walk per frame and records release removed/hidden descendants", () => {
  const scene = new Scene();
  const parent = new Group();
  const object = caster();
  parent.add(object);
  scene.add(parent);
  scene.updateMatrixWorld(true);
  const cache = new ClipmapShadowCache();
  cache.prepare(scene, null, 1);
  cache.prepare(scene, null, 1);
  assert.equal(cache.stats.walks, 1);
  assert.equal(cache.staticObjects.size, 1);
  const revision = cache.staticRevision;
  parent.visible = false;
  cache.prepare(scene, null, 2);
  assert.equal(cache.records.size, 0);
  assert.ok(cache.staticRevision > revision);
  parent.visible = true;
  cache.prepare(scene, null, 3);
  assert.equal(cache.records.size, 1);
  scene.remove(parent);
  cache.prepare(scene, null, 4);
  assert.equal(cache.records.size, 0);
});

test("a first movement removes the caster from static history immediately and permanently", () => {
  const scene = new Scene();
  const object = caster();
  scene.add(object);
  const cache = new ClipmapShadowCache();
  scene.updateMatrixWorld(true);
  cache.prepare(scene, null, 1);
  const staticRevision = cache.staticRevision;
  object.position.x++;
  scene.updateMatrixWorld(true);
  cache.prepare(scene, null, 2);
  assert.equal(cache.staticObjects.size, 0);
  assert.equal(cache.movingObjects.size, 1);
  assert.ok(cache.staticRevision > staticRevision);
  const promotedRevision = cache.staticRevision;
  object.position.x++;
  scene.updateMatrixWorld(true);
  cache.prepare(scene, null, 3);
  assert.equal(cache.staticRevision, promotedRevision);
  cache.prepare(scene, null, 4);
  assert.equal(cache.movingObjects.size, 1);
});

test("geometry, buffers, material alpha, texture transforms and parent changes invalidate", () => {
  const edits = [
    object => { object.geometry = new BoxGeometry(2); },
    object => { object.geometry.attributes.position.needsUpdate = true; },
    object => { object.geometry.setAttribute("uv", new BufferAttribute(new Float32Array(48), 2)); },
    object => { object.geometry.index.needsUpdate = true; },
    object => { object.geometry.setDrawRange(0, 3); },
    object => { object.instanceMatrix = new BufferAttribute(new Float32Array(16), 16); },
    object => { object.material = new MeshStandardMaterial(); },
    object => { object.material.alphaTest = 0.8; },
    object => { object.material.map.needsUpdate = true; },
    object => { object.material.map.offset.x = 0.5; },
    object => { object.material.map = null; },
    (object, scene) => { const parent = new Group(); scene.add(parent); parent.add(object); },
  ];
  for (const edit of edits) {
    const scene = new Scene();
    const object = caster();
    object.material.map = new Texture();
    scene.add(object);
    scene.updateMatrixWorld(true);
    const cache = new ClipmapShadowCache();
    cache.prepare(scene, null, 1);
    const before = cache.revision;
    edit(object, scene);
    scene.updateMatrixWorld(true);
    cache.prepare(scene, null, 2);
    assert.ok(cache.revision > before, String(edit));
  }
});

test("asset/material boot swaps refresh static history without promoting the entire environment", () => {
  const f = fixture();
  f.run();
  f.run();
  f.fixed.geometry = new BoxGeometry(2);
  f.fixed.material = new MeshStandardMaterial({ alphaTest: 0.4 });
  f.run();
  assert.equal(f.cache.staticObjects.has(f.fixed), true);
  assert.equal(f.node.stats.staticRenders, 2);
  f.calls.length = 0;
  f.run();
  assert.deepEqual(f.draws(), ["mover"]);
  assert.equal(f.node.stats.staticRenders, 2);
});

test("a texture's first derived matrix update does not dirty captured static content", () => {
  const scene = new Scene();
  const object = caster();
  object.material.map = new Texture();
  object.material.map.repeat.set(3, 2);
  scene.add(object);
  const cache = new ClipmapShadowCache();
  cache.prepare(scene, null, 1);
  const revision = cache.staticRevision;
  object.material.map.updateMatrix();
  cache.prepare(scene, null, 2);
  assert.equal(cache.staticRevision, revision);
  object.material.map.matrixAutoUpdate = false;
  cache.prepare(scene, null, 3);
  const manualRevision = cache.staticRevision;
  object.material.map.matrix.elements[0]++;
  cache.prepare(scene, null, 4);
  assert.ok(cache.staticRevision > manualRevision);
});

test("unknown shader animation and callbacks stay moving even when all versions hold", () => {
  const edits = [
    object => { object.isSkinnedMesh = true; },
    object => { object.morphTargetInfluences = [0]; },
    object => { object.userData.vfxSimulation = true; },
    object => { object.material.positionNode = {}; },
    object => { object.material.shadowNode = {}; },
    object => { object.material.maskShadowNode = {}; },
    object => { object.onBeforeShadow = () => {}; },
    object => { object.onBeforeRender = () => {}; },
    object => { object.material.onBeforeCompile = () => {}; },
  ];
  for (const edit of edits) {
    const scene = new Scene();
    const object = caster();
    edit(object);
    scene.add(object);
    const cache = new ClipmapShadowCache();
    cache.prepare(scene, null, 1);
    assert.equal(cache.staticObjects.size, 0, String(edit));
    const revision = cache.revision;
    cache.prepare(scene, null, 2);
    assert.ok(cache.revision > revision, String(edit));
  }
});

// 09-14: every NodeMaterial graph used to count as animation, so a scene of
// node-material terrain/rock/buildings had zero static casters and no level
// ever held. The verdict now comes from the BUILT shadow draw (`Fn` bodies are
// opaque to a graph walk — foliage wind reads a JS-driven uniform inside one).
const builtState = ({ updateNodes = [], uniforms = [], bindings = [] } = {}) => ({
  updateNodes, updateBeforeNodes: [], updateAfterNodes: [],
  bindings: [{ bindings: [{ uniforms: uniforms.map((node) => ({ nodeUniform: { node } })) }, ...bindings] }],
});
const observeDraw = (cache, object, state) => cache.observe({ object, getNodeBuilderState: () => state });

test("a graph whose built draw holds only plain uniforms is static; a uniform that changes promotes it", async () => {
  const { uniform } = await import("three/tsl");
  const scene = new Scene();
  const object = caster();
  object.material.positionNode = {};
  scene.add(object);
  const cache = new ClipmapShadowCache();
  cache.prepare(scene, null, 1);
  assert.equal(cache.movingObjects.size, 1, "an unobserved graph stays moving");
  assert.equal(cache.stats.movingReasons["graph not yet observed"], 1);
  const wind = uniform(0);
  observeDraw(cache, object, builtState({ uniforms: [wind] }));
  cache.prepare(scene, null, 2);
  assert.equal(cache.staticObjects.size, 1, "observed with nothing updating itself: static");
  const revision = cache.staticRevision;
  cache.prepare(scene, null, 3);
  assert.equal(cache.staticRevision, revision, "an unchanged draw holds");
  wind.value = 1;
  cache.prepare(scene, null, 4);
  assert.equal(cache.movingObjects.size, 1, "a JS-driven uniform (wind time) that changes makes it a mover");
  wind.value = 2;
  const settled = cache.staticRevision;
  cache.prepare(scene, null, 5);
  assert.equal(cache.staticRevision, settled, "and it never redraws the static map again");
});

test("a hidden updater, storage or render-target texture in the built draw keeps the caster moving", async () => {
  const { uniform } = await import("three/tsl");
  const states = [
    builtState({ updateNodes: [uniform(0).onFrameUpdate(() => 0)] }),
    builtState({ bindings: [{ isStorageBuffer: true, name: "positions" }] }),
    builtState({ bindings: [{ name: "map", textureNode: { value: new RenderTarget(4, 4).texture } }] }),
  ];
  for (const state of states) {
    const scene = new Scene();
    const object = caster();
    object.material.positionNode = {};
    scene.add(object);
    const cache = new ClipmapShadowCache();
    observeDraw(cache, object, state);
    cache.prepare(scene, null, 1);
    assert.equal(cache.movingObjects.size, 1, JSON.stringify(cache.stats.movingReasons));
    assert.equal(cache.stats.movingReasons["graph not yet observed"], undefined);
  }
});

test("object, camera and material-reference updaters are already compared and stay static", async () => {
  const { modelWorldMatrix, cameraNear, materialReference } = await import("three/tsl");
  const scene = new Scene();
  const object = caster();
  object.material.positionNode = {};
  scene.add(object);
  const cache = new ClipmapShadowCache();
  observeDraw(cache, object, builtState({ updateNodes: [modelWorldMatrix, cameraNear, materialReference("opacity", "float")] }));
  cache.prepare(scene, null, 1);
  assert.equal(cache.staticObjects.size, 1, JSON.stringify(cache.stats.movingReasons));
  const revision = cache.staticRevision;
  object.material.opacity = .5;
  cache.prepare(scene, null, 2);
  assert.ok(cache.staticRevision > revision, "a referenced material field still redraws the static map");
});

test("a new material drops the old verdict until its own draw is observed", () => {
  const scene = new Scene();
  const object = caster();
  object.material.positionNode = {};
  scene.add(object);
  const cache = new ClipmapShadowCache();
  observeDraw(cache, object, builtState());
  cache.prepare(scene, null, 1);
  assert.equal(cache.staticObjects.size, 1);
  object.material = new MeshStandardMaterial();
  object.material.positionNode = {};
  cache.prepare(scene, null, 2);
  assert.equal(cache.movingObjects.size, 1);
});

test("first frame draws once; a stable mixed map captures only depth and then draws only movers", () => {
  const f = fixture();
  f.run();
  assert.deepEqual(f.draws(), ["fixed", "mover"]);
  assert.deepEqual(f.pixels(), [["fixed", 0], ["mover", 0]]);
  assert.equal(f.node.stats.staticRenders, 0);
  assert.equal(f.node.stats.copies, 0);
  assert.equal(f.node._staticMap, null);
  assert.equal(f.cache.stats.walks, 0);
  f.calls.length = 0;
  f.run();
  assert.deepEqual(f.draws(), ["fixed", "mover"]);
  assert.equal(f.node.stats.staticRenders, 1);
  assert.equal(f.node.stats.copies, 1);
  assert.equal(f.node._staticMap.depthTexture.compareFunction, f.map.depthTexture.compareFunction);
  assert.equal(f.node._staticMap.textures.length, 0);
  assert.equal(f.calls.some(([op]) => op === "init"), false);
  assert.equal(f.calls.filter(([op]) => op === "initTexture").length, 1);
  f.calls.length = 0;
  f.mover.position.x = 8;
  f.run();
  assert.deepEqual(f.draws(), ["mover"]);
  assert.deepEqual(f.pixels(), [["fixed", 0], ["mover", 8]]);
  assert.equal(f.node.stats.staticRenders, 1);
  assert.equal(f.node.stats.copies, 2);
  f.scene.remove(f.mover);
  f.calls.length = 0;
  f.run();
  assert.deepEqual(f.draws(), ["fixed"]);
  assert.deepEqual(f.pixels(), [["fixed", 0]]);
  assert.equal(f.node._staticMap, null);
  assert.equal(f.renderer.autoClear, true);
  assert.equal(f.scene.name, "authored scene");
  assert.equal(f.fixed.visible, true);
});

test("moving a formerly static caster removes its old silhouette before combining", () => {
  const f = fixture();
  const environment = caster("environment");
  f.scene.add(environment);
  f.run();
  f.run();
  f.fixed.position.x = 7;
  f.run();
  assert.deepEqual(f.pixels(), [["environment", 0], ["fixed", 7], ["mover", 0]]);
  const captures = f.node.stats.staticRenders;
  f.calls.length = 0;
  f.fixed.position.x = 9;
  f.run();
  assert.equal(f.node.stats.staticRenders, captures);
  assert.deepEqual(f.draws(), ["fixed", "mover"]);
});

test("a complete stationary map holds; map pose, size and force invalidation redraw", () => {
  const f = fixture();
  f.scene.remove(f.mover);
  f.run();
  f.run();
  f.calls.length = 0;
  f.run();
  assert.deepEqual(f.calls, []);
  assert.equal(f.node.stats.holds, 1);
  f.node.light.position.x += 2;
  f.node.light.updateMatrixWorld(true);
  f.run();
  assert.deepEqual(f.draws(), ["fixed"]);
  f.calls.length = 0;
  f.node.invalidateCache();
  f.run();
  assert.deepEqual(f.draws(), ["fixed"]);
  f.calls.length = 0;
  f.node.shadow.mapSize.set(256, 256);
  f.run();
  assert.deepEqual(f.draws(), ["fixed"]);
  assert.equal(f.node._staticMap, null);
  assert.equal(f.node.stats.copies, 0);
  assert.equal(f.node.stats.staticRenders, 0);
});

test("cache disabled redraws all moving-scene casters and never copies a split map", () => {
  const f = fixture();
  f.node.cacheEnabled = false;
  f.run();
  f.calls.length = 0;
  f.run();
  assert.deepEqual(f.draws(), ["fixed", "mover"]);
  assert.equal(f.node.stats.copies, 0);
});

test("a continuously rotating sun uses one native pass and never captures, copies or classifies", () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    f.calls.length = 0;
    f.node.light.position.x += 0.4;
    f.node.light.updateMatrixWorld(true);
    f.run();
    assert.equal(f.calls.filter(([op]) => op === "render").length, 1);
    assert.deepEqual(f.draws(), ["fixed", "mover"]);
    assert.equal(f.node._staticMap, null);
    assert.ok(f.node._combinedReceipt);
  }
  assert.equal(f.node.stats.fullRenders, 5);
  assert.equal(f.node.stats.mapChanges, 5);
  assert.equal(f.node.stats.bypasses, 5);
  assert.equal(f.node.stats.staticRenders, 0);
  assert.equal(f.node.stats.movingRenders, 0);
  assert.equal(f.node.stats.copies, 0);
  assert.equal(f.cache.stats.walks, 0);
});

test("resuming sun motion releases an old split cache and prunes removed casters without classification", () => {
  const f = fixture();
  f.run();
  f.run();
  assert.ok(f.node._staticMap);
  const captureCount = f.node.stats.staticRenders;
  const copies = f.node.stats.copies;
  const walks = f.cache.stats.walks;
  let disposed = 0;
  f.node._staticMap.depthTexture.addEventListener("dispose", () => disposed++);
  Object.defineProperty(f.fixed.material, "alphaTest", { get() { throw new Error("expensive classification entered"); } });
  for (let i = 0; i < 4; i++) {
    f.calls.length = 0;
    f.node.light.position.z += 0.3;
    f.node.light.updateMatrixWorld(true);
    if (i === 2) f.scene.remove(f.mover);
    f.run();
    assert.equal(f.calls.filter(([op]) => op === "render").length, 1);
    assert.equal(f.node._staticMap, null);
    assert.equal(f.node._staticReceipt, null);
  }
  assert.equal(disposed, 1);
  assert.equal(f.cache.stats.walks, walks);
  assert.equal(f.cache.records.has(f.mover), false);
  assert.equal(f.cache.records.has(f.fixed), true);
  assert.equal(f.node.stats.staticRenders, captureCount);
  assert.equal(f.node.stats.copies, copies);
});

test("transmitted shadows retain and restore color together with depth", () => {
  const f = fixture();
  f.renderer.shadowMap.transmitted = true;
  f.run();
  f.run();
  assert.equal(f.node._staticMap.textures.length, 1);
  assert.equal(f.node.stats.copies, 2);
  assert.equal(f.calls.filter(([op]) => op === "init").length, 1);
  assert.equal(f.calls.some(([op]) => op === "initTexture"), false);
  f.calls.length = 0;
  f.mover.position.x = 8;
  f.run();
  assert.deepEqual(f.draws(), ["mover"]);
  assert.equal(f.node.stats.copies, 4);
  assert.deepEqual([...f.contents.get(f.map.texture)], [["fixed", 0], ["mover", 8]]);
  assert.deepEqual(f.pixels(), [["fixed", 0], ["mover", 8]]);
});

test("cheap pruning preserves live history and releases invisible parent hierarchies", () => {
  const f = fixture();
  f.run();
  f.run();
  const revision = f.cache.staticRevision;
  f.cache.prune(f.scene, 10);
  assert.equal(f.cache.staticRevision, revision);
  const parent = new Group();
  f.scene.add(parent);
  parent.add(f.fixed);
  parent.visible = false;
  f.cache.prune(f.scene, 11);
  assert.equal(f.cache.records.has(f.fixed), false);
  assert.equal(f.cache.staticObjects.has(f.fixed), false);
  assert.ok(f.cache.staticRevision > revision);
});

test("pending pipelines from earlier frames and stand-ins cannot certify a static map", () => {
  for (const mode of ["pending", "standIn", "defer"]) {
    const f = fixture();
    f.renderer[mode] = f.fixed;
    f.run();
    f.run();
    assert.equal(f.node._staticReceipt, null, mode);
    assert.equal(f.node._combinedReceipt, null, mode);
    assert.equal(f.node.stats.fullRenders, 2, mode);
    assert.equal(f.node.stats.staticRenders, 0, mode);
    assert.equal(f.node.stats.copies, 0, mode);
    assert.equal(f.node._lastMapKey, null, mode);
    f.renderer[mode] = null;
    f.run();
    assert.equal(f.node._staticReceipt, null, mode);
    f.run();
    assert.ok(f.node._staticReceipt, mode);
    assert.equal(f.node.stats.copies, 1, mode);
  }
});

test("a failing native draw restores callbacks, isReady, clear mode and scene name", () => {
  const f = fixture();
  const callback = f.renderer.callback;
  const isReady = f.renderer._pipelines.isReady;
  f.renderer.throwOn = f.fixed;
  assert.throws(() => f.run(), /draw failed/);
  assert.equal(f.renderer.callback, callback);
  assert.equal(f.renderer._pipelines.isReady, isReady);
  assert.equal(f.renderer.autoClear, true);
  assert.equal(f.scene.name, "authored scene");
  assert.equal(f.node._staticReceipt, null);
  assert.equal(f.node._combinedReceipt, null);
});

test("retained targets are released on reset and VSM stays on the native path", () => {
  const f = fixture();
  f.run();
  f.run();
  let disposed = 0;
  let depthDisposed = 0;
  f.node._staticMap.addEventListener("dispose", () => disposed++);
  f.node._staticMap.depthTexture.addEventListener("dispose", () => depthDisposed++);
  f.node._reset();
  assert.equal(disposed, 1);
  assert.equal(depthDisposed, 1);
  assert.equal(f.node._staticMap, null);
  const vsm = fixture();
  vsm.scene.remove(vsm.mover);
  vsm.renderer.shadowMap.type = VSMShadowMap;
  vsm.run();
  vsm.run();
  assert.equal(vsm.node.stats.fullRenders, 2);
  assert.equal(vsm.node.stats.copies, 0);
});
