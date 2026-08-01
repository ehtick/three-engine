/**
 * Impostors (roadmap item 14, second half).
 *
 * Everything here is a decision, not a picture: which octahedral frame a
 * direction maps to, whether the shader's reconstruction of a bake camera's
 * basis matches the camera that was actually used, whether five hundred trees
 * share one atlas, and whether a hidden impostor stops drawing. An impostor
 * that samples the wrong frame looks like an object facing slightly the wrong
 * way — an art bug, not a maths bug — which is exactly why the maths is pinned
 * down here instead of in a screenshot.
 *
 * The bake itself needs a GPU and lives in `npm run smoke:impostor`.
 */
import assert from "node:assert/strict";

const stubElement = () => ({
  style: {},
  appendChild() {},
  removeChild() {},
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  classList: { add() {}, remove() {} },
  parentElement: null,
});
globalThis.document ??= {
  body: stubElement(),
  createElement: stubElement,
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
globalThis.window ??= {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  performance: globalThis.performance,
  crypto: globalThis.crypto,
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const THREE = await import("three/webgpu");
const { octEncode, octDecode, frameUv, frameDirection, frameWeights, frameBasis, tileOrigin } =
  await import("../src/engine/lod/octahedral.js");
const { impostorCacheKey } = await import("../src/engine/lod/impostorBake.js");
const { Engine, registerBuiltInComponents } = await import("../src/engine/index.js");

registerBuiltInComponents();

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};
const section = (title) => console.log(`\n${title}`);

const norm = (x, y, z) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A stand-in for a baked atlas: only the geometry of it matters off-GPU. */
const fakeAtlas = (radius = 2, center = [0, 1, 0]) => ({
  center: new THREE.Vector3(...center),
  radius,
  frames: 8,
  tile: 64,
  hemisphere: true,
  albedo: {},
  normal: {},
  dispose() {
    this.disposed = true;
  },
});

const fakeMaterial = () => ({
  dispose() {
    this.disposed = true;
  },
});

// ---------------------------------------------------------------------------

section("octahedral mapping");

await check("a direction survives the round trip through the hemispherical map", () => {
  for (const dir of [
    norm(0, 1, 0),
    norm(1, 1, 0),
    norm(0, 1, 1),
    norm(-1, 2, 0.5),
    norm(0.3, 0.1, -0.9),
    norm(1, 0, 0),
  ]) {
    const [u, v] = octEncode(dir[0], dir[1], dir[2], true);
    const back = octDecode(u, v, true);
    assert.ok(dot3(dir, back) > 0.9999, `${dir} -> ${u},${v} -> ${back}`);
  }
});

await check("the full-sphere map round-trips below the horizon too", () => {
  for (const dir of [norm(0, -1, 0), norm(1, -1, 0), norm(-0.4, -0.6, 0.7), norm(0, -0.2, -1)]) {
    const [u, v] = octEncode(dir[0], dir[1], dir[2], false);
    const back = octDecode(u, v, false);
    assert.ok(dot3(dir, back) > 0.9999, `${dir} -> ${u},${v} -> ${back}`);
  }
});

await check("the hemispherical map spends the WHOLE square on the upper half", () => {
  // Straight up is the centre, and the four horizon directions are the corners:
  // that is the property that buys twice the detail per frame.
  const up = octEncode(0, 1, 0, true);
  assert.ok(Math.abs(up[0] - 0.5) < 1e-9 && Math.abs(up[1] - 0.5) < 1e-9);
  const corners = [octEncode(1, 0, 0, true), octEncode(-1, 0, 0, true), octEncode(0, 0, 1, true), octEncode(0, 0, -1, true)];
  for (const [u, v] of corners) {
    const onEdge = u < 1e-9 || u > 1 - 1e-9 || v < 1e-9 || v > 1 - 1e-9;
    assert.ok(onEdge, `horizon should land on the square's border, got ${u},${v}`);
  }
});

await check("a direction below the horizon folds onto it rather than wrapping to an unbaked frame", () => {
  const below = octDecode(...octEncode(...norm(0.2, -0.9, 0.1), true), true);
  assert.ok(below[1] >= -1e-6, `folded direction should not point down: ${below}`);
});

await check("every encoded uv stays inside the unit square", () => {
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2;
    const dir = norm(Math.cos(a), 0.3 + (i % 7) * 0.1, Math.sin(a));
    const [u, v] = octEncode(dir[0], dir[1], dir[2], true);
    assert.ok(u >= -1e-9 && u <= 1 + 1e-9 && v >= -1e-9 && v <= 1 + 1e-9, `${u},${v}`);
  }
});

// ---------------------------------------------------------------------------

section("frame grid");

await check("frames sit on the CLOSED grid, so the horizon really is baked", () => {
  assert.deepEqual(frameUv(0, 0, 8), [0, 0]);
  assert.deepEqual(frameUv(7, 7, 8), [1, 1]);
  // A tile, by contrast, is an area on the open grid — conflating the two puts
  // every sample half a tile off.
  assert.deepEqual(tileOrigin(0, 0, 8), [0, 0]);
  assert.deepEqual(tileOrigin(7, 7, 8), [7 / 8, 7 / 8]);
});

await check("the centre frame of a hemispherical atlas looks straight down", () => {
  const dir = frameDirection(4, 4, 9, true);
  assert.ok(dir[1] > 0.999, `${dir}`);
});

await check("three frames, weights summing to 1, for any direction", () => {
  for (let i = 0; i < 100; i++) {
    const a = (i / 100) * Math.PI * 2;
    const dir = norm(Math.cos(a) * 0.7, 0.2 + (i % 5) * 0.15, Math.sin(a) * 0.7);
    const weights = frameWeights(dir, 8, true);
    assert.equal(weights.length, 3);
    const total = weights.reduce((sum, w) => sum + w.weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${total}`);
    for (const w of weights) {
      assert.ok(w.weight >= -1e-9, `negative weight ${w.weight}`);
      assert.ok(w.col >= 0 && w.col < 8 && w.row >= 0 && w.row < 8, `${w.col},${w.row}`);
    }
  }
});

await check("a direction exactly on a frame gets that frame at full weight", () => {
  const dir = frameDirection(3, 5, 8, true);
  const weights = frameWeights(dir, 8, true);
  const exact = weights.find((w) => w.col === 3 && w.row === 5);
  assert.ok(exact, "the frame the direction came from should be one of the three");
  assert.ok(exact.weight > 0.999, `${exact.weight}`);
});

await check("the blend is continuous — the weighted direction tracks the real one", () => {
  // What stops the pop: nudging the camera must move the blended view smoothly,
  // not switch it. Reconstructing the direction from the weights and comparing
  // is the closest a headless test gets to looking at it.
  let worst = 0;
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const dir = norm(Math.cos(a), 0.6, Math.sin(a));
    const blended = [0, 0, 0];
    for (const w of frameWeights(dir, 8, true)) {
      const d = frameDirection(w.col, w.row, 8, true);
      blended[0] += d[0] * w.weight;
      blended[1] += d[1] * w.weight;
      blended[2] += d[2] * w.weight;
    }
    const back = norm(...blended);
    worst = Math.max(worst, 1 - dot3(dir, back));
  }
  assert.ok(worst < 0.01, `blended direction drifted by ${worst}`);
});

await check("a direction on the cell's split diagonal gets the same answer from either side", () => {
  const frames = 8;
  const n = frames - 1;
  // Just below and just above the anti-diagonal of one cell.
  const below = octDecode((2 + 0.4999) / n, (3 + 0.5) / n, true);
  const above = octDecode((2 + 0.5001) / n, (3 + 0.5) / n, true);
  const a = frameWeights(below, frames, true);
  const b = frameWeights(above, frames, true);
  const heaviest = (list) => list.slice().sort((x, y) => y.weight - x.weight)[0];
  const ha = heaviest(a);
  const hb = heaviest(b);
  assert.ok(Math.abs(ha.col - hb.col) <= 1 && Math.abs(ha.row - hb.row) <= 1, "the seam must not jump frames");
});

// ---------------------------------------------------------------------------

section("frame basis");

await check("the basis is orthonormal and perpendicular to the view direction", () => {
  for (const dir of [norm(1, 1, 1), norm(0, 1, 0), norm(0, -1, 0), norm(-1, 0.2, 0.3)]) {
    const { right, up } = frameBasis(dir);
    assert.ok(Math.abs(Math.hypot(...right) - 1) < 1e-9);
    assert.ok(Math.abs(Math.hypot(...up) - 1) < 1e-9);
    assert.ok(Math.abs(dot3(right, up)) < 1e-9);
    assert.ok(Math.abs(dot3(right, dir)) < 1e-9);
  }
});

await check("it matches the camera the bake actually uses — the one agreement that must hold", () => {
  // If these two ever disagree, every texel is sampled from the wrong place and
  // the impostor looks like a slightly wrong model rather than a broken lookup.
  const center = new THREE.Vector3(1, 2, -3);
  for (const dir of [norm(1, 1, 1), norm(0, 1, 0), norm(0.2, 0.05, -1), norm(-0.7, 0.7, 0)]) {
    const basis = frameBasis(dir);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.up.set(...basis.reference);
    camera.position.set(center.x + dir[0] * 4, center.y + dir[1] * 4, center.z + dir[2] * 4);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    assert.ok(right.dot(new THREE.Vector3(...basis.right)) > 0.9999, `right mismatch for ${dir}`);
    assert.ok(up.dot(new THREE.Vector3(...basis.up)) > 0.9999, `up mismatch for ${dir}`);
  }
});

await check("the poles pick a stable reference instead of letting lookAt nudge the matrix", () => {
  const down = frameBasis(norm(0, -1, 0));
  const up = frameBasis(norm(0, 1, 0));
  assert.deepEqual(down.reference, [0, 0, 1]);
  assert.deepEqual(up.reference, [0, 0, 1]);
  assert.ok(Number.isFinite(down.right[0]) && Math.abs(Math.hypot(...down.right) - 1) < 1e-9);
});

// ---------------------------------------------------------------------------

section("atlas sharing");

/** A prop entity with `count` mesh children, the shape of an LOD chain. */
function propEngine({ withImpostor = true, geometry = null } = {}) {
  const engine = new Engine();
  const group = engine.createEntity({ name: "Tree" });
  const lod0 = engine.createEntity({ name: "Tree_LOD0" });
  lod0.setParent(group);
  lod0.addComponent("mesh", { geometry: "box" });
  if (geometry) lod0.getComponent("mesh").mesh.geometry = geometry;
  let impostor = null;
  if (withImpostor) {
    const level = engine.createEntity({ name: "Tree_Impostor" });
    level.setParent(group);
    impostor = level.addComponent("impostor", {});
  }
  engine.scene.updateMatrixWorld(true);
  return { engine, group, lod0, impostor };
}

await check("two props built from the same mesh produce the same cache key", () => {
  const shared = new THREE.BoxGeometry(1, 1, 1);
  const a = propEngine({ geometry: shared });
  const b = propEngine({ geometry: shared });
  assert.equal(
    impostorCacheKey(a.lod0.object3D, a.impostor.bakeSettings()),
    impostorCacheKey(b.lod0.object3D, b.impostor.bakeSettings()),
    "five hundred trees must bake once",
  );
});

await check("a scaled copy is a different key — sharing one atlas would resize the prop", () => {
  const shared = new THREE.BoxGeometry(1, 1, 1);
  const a = propEngine({ geometry: shared });
  const b = propEngine({ geometry: shared });
  b.lod0.object3D.scale.set(2, 2, 2);
  b.lod0.object3D.updateMatrix();
  assert.notEqual(
    impostorCacheKey(a.lod0.object3D, a.impostor.bakeSettings()),
    impostorCacheKey(b.lod0.object3D, b.impostor.bakeSettings()),
  );
});

await check("changing a bake setting changes the key", () => {
  const { lod0, impostor } = propEngine();
  const before = impostorCacheKey(lod0.object3D, impostor.bakeSettings());
  impostor.props.frames = 16;
  assert.notEqual(before, impostorCacheKey(lod0.object3D, impostor.bakeSettings()));
});

// ---------------------------------------------------------------------------

section("source resolution");

await check("an unset source means the sibling above it — an LOD chain needs no wiring", () => {
  const { lod0, impostor } = propEngine();
  assert.equal(impostor.resolveSource(), lod0.object3D);
});

await check("an explicit source wins, and pointing it at itself resolves to nothing", () => {
  const { engine, impostor } = propEngine();
  const other = engine.createEntity({ name: "Other" });
  other.addComponent("mesh", {});
  impostor.props.source = other.id;
  assert.equal(impostor.resolveSource(), other.object3D);
  impostor.props.source = impostor.entity.id;
  assert.equal(impostor.resolveSource(), null, "an impostor of itself is not a thing");
});

await check("a source that does not exist yet resolves to null rather than throwing", () => {
  const { impostor } = propEngine();
  impostor.props.source = "nope";
  assert.equal(impostor.resolveSource(), null);
});

await check("a second impostor is never picked as a source", () => {
  const { engine, group, impostor } = propEngine();
  const second = engine.createEntity({ name: "Second" });
  second.setParent(group);
  second.addComponent("impostor", {});
  // Reordering so the other impostor comes first in the child list.
  group.children.reverse();
  const source = impostor.resolveSource();
  assert.ok(source && !source.userData.impostorQuad);
  assert.notEqual(source, second.object3D);
});

// ---------------------------------------------------------------------------

section("instance data");

await check("the centre follows the entity's world transform", () => {
  const { impostor } = propEngine();
  const atlas = fakeAtlas(2, [0, 1, 0]);
  impostor.entity.object3D.position.set(10, 0, -5);
  impostor.entity.object3D.updateMatrixWorld(true);
  const data = impostor.instanceData(atlas);
  assert.ok(Math.abs(data.center.x - 10) < 1e-6);
  assert.ok(Math.abs(data.center.y - 1) < 1e-6, "the atlas centre rides along");
  assert.ok(Math.abs(data.center.z + 5) < 1e-6);
});

await check("scaling the prop scales its billboard", () => {
  const { impostor } = propEngine();
  const atlas = fakeAtlas(2);
  const plain = impostor.instanceData(atlas).size;
  impostor.entity.object3D.scale.set(3, 3, 3);
  impostor.entity.object3D.updateMatrixWorld(true);
  assert.ok(Math.abs(impostor.instanceData(atlas).size - plain * 3) < 1e-6);
});

await check("rotating the prop rotates the axes the shader gets back into bake space with", () => {
  const { impostor } = propEngine();
  const atlas = fakeAtlas(2, [0, 0, 0]);
  impostor.entity.object3D.rotation.set(0, Math.PI / 2, 0);
  impostor.entity.object3D.updateMatrixWorld(true);
  const data = impostor.instanceData(atlas);
  assert.ok(Math.abs(data.axisX.z + 1) < 1e-6, `axisX should have swung to -Z: ${data.axisX.toArray()}`);
  assert.ok(Math.abs(data.axisY.y - 1) < 1e-6);
});

await check("a hidden impostor reports size 0 — the buffer is never compacted", () => {
  const { impostor } = propEngine();
  const atlas = fakeAtlas(2);
  assert.ok(impostor.instanceData(atlas).size > 0);
  impostor.entity._lodHidden = true;
  assert.equal(impostor.instanceData(atlas).size, 0, "an LOD-hidden level must stop drawing");
  impostor.entity._lodHidden = false;
  impostor.entity.object3D.visible = false;
  assert.equal(impostor.instanceData(atlas).size, 0, "so must a disabled ancestor");
  impostor.entity.object3D.visible = true;
  impostor.setEnabled(false);
  assert.equal(impostor.instanceData(atlas).size, 0);
});

await check("no atlas means no instance, rather than a white quad in the middle of the scene", () => {
  const { impostor } = propEngine();
  assert.equal(impostor.instanceData(null).size, 0);
  assert.equal(impostor.ready, false);
});

// ---------------------------------------------------------------------------

section("the shared draw");

/** Attaches `count` impostors to one fabricated atlas and syncs the system. */
function batchedEngine(count = 3) {
  const engine = new Engine();
  const atlas = fakeAtlas(2, [0, 1, 0]);
  const material = fakeMaterial();
  const components = [];
  // One geometry across every copy, which is what a prop dropped five hundred
  // times really looks like: `.geom` assets come out of a refcounted shared
  // cache, so the instances are literally the same buffer. (A primitive box
  // builds its own geometry per component, and correctly does NOT share an
  // atlas with another one — different objects, different silhouettes as far
  // as the cache can know.)
  const shared = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < count; i++) {
    const group = engine.createEntity({ name: `Tree${i}` });
    const source = engine.createEntity({ name: `Tree${i}_LOD0` });
    source.setParent(group);
    source.addComponent("mesh", {});
    source.getComponent("mesh").mesh.geometry = shared;
    const level = engine.createEntity({ name: `Tree${i}_Impostor` });
    level.setParent(group);
    level.object3D.position.set(i * 10, 0, 0);
    const component = level.addComponent("impostor", {});
    components.push(component);
  }
  engine.scene.updateMatrixWorld(true);
  // Stand in for a completed bake: every component resolves to the same source
  // shape, so they all land in one cache entry, exactly as a real bake would.
  const key = impostorCacheKey(components[0].resolveSource(), components[0].bakeSettings());
  engine.impostors.cache.set(key, { atlas, material, refs: 0 });
  for (const component of components) {
    engine.impostors.cancel(component);
    engine.impostors.request(component);
  }
  engine.impostors.update();
  return { engine, components, atlas, key };
}

await check("every impostor sharing an atlas lands in ONE draw", () => {
  const { engine, components } = batchedEngine(5);
  assert.equal(engine.impostors.batches.size, 1, "one batch, not five");
  const batch = [...engine.impostors.batches.values()][0];
  assert.equal(batch.members.length, 5);
  assert.equal(batch.geometry.instanceCount, 5);
  assert.ok(components.every((c) => c.ready));
});

await check("the instance buffer holds each prop's own centre", () => {
  const { engine } = batchedEngine(3);
  const batch = [...engine.impostors.batches.values()][0];
  const centers = batch.geometry.attributes.aCenter.array;
  assert.ok(Math.abs(centers[0] - 0) < 1e-6);
  assert.ok(Math.abs(centers[3] - 10) < 1e-6);
  assert.ok(Math.abs(centers[6] - 20) < 1e-6);
  assert.ok(Math.abs(centers[1] - 1) < 1e-6, "the atlas centre offset is baked into each instance");
});

await check("hiding one prop writes a zero size and leaves the others alone", () => {
  const { engine, components } = batchedEngine(3);
  const batch = [...engine.impostors.batches.values()][0];
  components[1].entity._lodHidden = true;
  engine.impostors.update();
  const sizes = batch.geometry.attributes.aSize.array;
  assert.ok(sizes[0] > 0);
  assert.equal(sizes[1], 0, "a hidden impostor must stop rasterising without a rebuild");
  assert.ok(sizes[2] > 0);
  assert.equal(batch.geometry.instanceCount, 3, "the buffer is not compacted");
});

await check("the batch's bounds cover every visible member, and it hides when none are", () => {
  const { engine, components } = batchedEngine(3);
  const batch = [...engine.impostors.batches.values()][0];
  assert.ok(batch.mesh.visible);
  assert.ok(batch.mesh.boundingSphere.radius >= 10, `${batch.mesh.boundingSphere.radius}`);
  for (const component of components) component.entity._lodHidden = true;
  engine.impostors.update();
  assert.equal(batch.mesh.visible, false, "an all-hidden batch should not be submitted at all");
});

await check("shadow flags split the batch, because they cannot vary within one draw", () => {
  const { engine, components } = batchedEngine(3);
  components[2].props.castShadow = false;
  components[2].onPropChanged("castShadow");
  engine.impostors.update();
  assert.equal(engine.impostors.batches.size, 2, "one prop's shadow setting must not decide the forest's");
});

await check("the last component out frees the atlas", () => {
  const { engine, components, atlas } = batchedEngine(2);
  engine.impostors.release(components[0]);
  assert.equal(atlas.disposed, undefined, "still in use by the second one");
  engine.impostors.release(components[1]);
  assert.equal(engine.impostors.batches.size, 0);
  assert.equal(atlas.disposed, true);
  assert.equal(engine.impostors.cache.size, 0);
});

await check("detaching the component takes its instance with it", () => {
  const { engine, components } = batchedEngine(3);
  components[1].entity.removeComponent("impostor");
  const batch = [...engine.impostors.batches.values()][0];
  assert.equal(batch.members.length, 2);
  engine.impostors.update();
  assert.equal(batch.geometry.instanceCount, 2);
});

await check("a component asking twice does not queue twice", () => {
  const engine = new Engine();
  const entity = engine.createEntity({ name: "Lone" });
  const component = entity.addComponent("impostor", {});
  engine.impostors.request(component);
  engine.impostors.request(component);
  assert.equal(engine.impostors.queue.length, 1);
});

await check("a component whose source is not there yet stays queued instead of failing", () => {
  const engine = new Engine();
  const entity = engine.createEntity({ name: "Lone" });
  const component = entity.addComponent("impostor", { source: "later" });
  // No renderer, so the drain bails before it ever looks at the source; the
  // request must still be waiting when one appears.
  engine.impostors.update();
  assert.equal(engine.impostors.queue.length, 1);
  assert.equal(component.ready, false);
});

await check("disposing the system drops every batch out of the scene", () => {
  const { engine } = batchedEngine(3);
  const proxies = engine.scene.children.filter((child) => child.userData.impostorBatch);
  assert.equal(proxies.length, 1);
  engine.impostors.dispose();
  assert.equal(engine.scene.children.filter((child) => child.userData.impostorBatch).length, 0);
});

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? "all impostor checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
