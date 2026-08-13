/**
 * GPU occlusion culling (roadmap item 14, second half).
 *
 * The failure mode of occlusion culling is objects that VANISH, so almost
 * everything here is an assertion that something is still drawn: a sphere that
 * pokes past the wall, an object next to an occluder rather than behind it, a
 * region of the depth buffer with sky in it. The one interesting positive — a
 * prop behind a wall really does get hidden, and the engine's own resolve pass
 * really does act on it — is driven end to end against a fabricated depth
 * buffer, because that is the only way to test it without a GPU.
 *
 * The depth PASS itself (the render, the readback, the layer tagging) needs a
 * GPU and lives in `npm run smoke:occlusion`.
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
const { DepthPyramid, projectSphere, isOccluded, createBounds } = await import(
  "../src/engine/culling/occlusionMath.js"
);
const { Engine, registerBuiltInComponents, OCCLUDER_LAYER } = await import("../src/engine/index.js");

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

const camera = (z = 0) => {
  const c = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  c.position.set(0, 0, z);
  c.updateMatrixWorld(true);
  c.updateProjectionMatrix();
  return c;
};
const project = (c, center, radius, out = createBounds()) => {
  const ok = projectSphere(center, radius, c.matrixWorldInverse, c.projectionMatrix, out);
  return { ok, out };
};

/** A depth buffer filled with one distance — "a wall across the whole frame". */
const flat = (value, w = 8, h = 8) => new Float32Array(w * h).fill(value);

// ---------------------------------------------------------------------------

section("projecting a sphere");

await check("a sphere in front of the camera lands inside the frame", () => {
  const c = camera();
  const { ok, out } = project(c, new THREE.Vector3(0, 0, -20), 1);
  assert.equal(ok, true);
  assert.ok(out.minU > 0.4 && out.maxU < 0.6, `${out.minU}..${out.maxU}`);
  assert.ok(out.minV > 0.4 && out.maxV < 0.6);
  assert.ok(Math.abs(out.nearDist - 19) < 1e-6, `${out.nearDist}`);
});

await check("a sphere behind the camera is refused, not culled", () => {
  const c = camera();
  // Reporting "occluded" for anything the frustum already rejects would double
  // count it and, worse, would mean this system's answer depended on maths that
  // is undefined behind the eye.
  assert.equal(project(c, new THREE.Vector3(0, 0, 20), 1).ok, false);
});

await check("a sphere the camera is inside is refused", () => {
  const c = camera();
  assert.equal(project(c, new THREE.Vector3(0, 0, -2), 5).ok, false);
});

await check("moving right moves the box right", () => {
  const c = camera();
  const middle = project(c, new THREE.Vector3(0, 0, -20), 1).out;
  const right = project(c, new THREE.Vector3(8, 0, -20), 1).out;
  assert.ok(right.minU > middle.maxU, `${right.minU} vs ${middle.maxU}`);
});

await check("a bigger sphere covers more of the frame, and a nearer one more again", () => {
  const c = camera();
  const small = project(c, new THREE.Vector3(0, 0, -20), 1).out;
  const big = project(c, new THREE.Vector3(0, 0, -20), 3).out;
  const near = project(c, new THREE.Vector3(0, 0, -10), 1).out;
  assert.ok(big.maxU - big.minU > small.maxU - small.minU);
  assert.ok(near.maxU - near.minU > small.maxU - small.minU);
});

await check("the box always CONTAINS the true projection — over-estimating is the safe direction", () => {
  // Every approximation in this file must fail towards drawing, so the box has
  // to be at least as big as the sphere's real silhouette. Sampling the sphere
  // and projecting the points is the check.
  const c = camera();
  const center = new THREE.Vector3(3, -1, -25);
  const radius = 2;
  const { out } = project(c, center, radius);
  const point = new THREE.Vector3();
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2;
    const b = ((i * 7) / 200) * Math.PI;
    point.set(
      center.x + radius * Math.cos(a) * Math.sin(b),
      center.y + radius * Math.sin(a) * Math.sin(b),
      center.z + radius * Math.cos(b),
    );
    point.project(c);
    const u = point.x * 0.5 + 0.5;
    const v = point.y * 0.5 + 0.5;
    assert.ok(u >= out.minU - 1e-6 && u <= out.maxU + 1e-6, `u ${u} outside ${out.minU}..${out.maxU}`);
    assert.ok(v >= out.minV - 1e-6 && v <= out.maxV + 1e-6, `v ${v} outside ${out.minV}..${out.maxV}`);
  }
});

await check("an off-screen sphere reports no box, leaving it to the frustum cull", () => {
  const c = camera();
  assert.equal(project(c, new THREE.Vector3(400, 0, -20), 1).ok, false);
});

// ---------------------------------------------------------------------------

section("the depth pyramid");

await check("each level is the MAX of the four below it", () => {
  const pyramid = new DepthPyramid();
  pyramid.build(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), 4, 4);
  assert.equal(pyramid.levels.length, 3);
  assert.deepEqual([...pyramid.levels[1].data], [6, 8, 14, 16]);
  assert.deepEqual([...pyramid.levels[2].data], [16]);
});

await check("an empty texel is infinitely FAR, so sky never occludes anything", () => {
  const pyramid = new DepthPyramid();
  pyramid.build(new Float32Array([0, 0, 0, 0]), 2, 2);
  assert.equal(pyramid.sampleMax(0, 0, 1, 1), Infinity);
  // The opposite convention — treating an untouched texel as near — would hide
  // the whole scene against an empty sky, which is the most expensive possible
  // way to get this wrong.
});

await check("odd sizes clamp rather than drop the last row, so screen edges stay covered", () => {
  const pyramid = new DepthPyramid();
  pyramid.build(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), 3, 3);
  assert.deepEqual([...pyramid.levels[1].data], [5, 6, 8, 9]);
});

await check("a big box reads a coarse level and still sees the farthest occluder", () => {
  const data = flat(10, 8, 8);
  data[0] = 100; // one distant texel in the corner
  const pyramid = new DepthPyramid();
  pyramid.build(data, 8, 8);
  assert.equal(pyramid.sampleMax(0, 0, 1, 1), 100, "the max must survive every reduction");
});

await check("a small box reads level 0 and sees only its own texels", () => {
  const data = flat(10, 8, 8);
  data[0] = 100;
  const pyramid = new DepthPyramid();
  pyramid.build(data, 8, 8);
  assert.equal(pyramid.sampleMax(0.6, 0.6, 0.7, 0.7), 10);
});

await check("an unbuilt pyramid answers 'infinitely far' — nothing is culled before there is data", () => {
  assert.equal(new DepthPyramid().sampleMax(0, 0, 1, 1), Infinity);
});

// ---------------------------------------------------------------------------

section("the test");

const pyramidOf = (value, w = 16, h = 16) => {
  const pyramid = new DepthPyramid();
  pyramid.build(flat(value, w, h), w, h);
  return pyramid;
};

await check("an object entirely behind the wall is occluded", () => {
  const pyramid = pyramidOf(10);
  assert.equal(isOccluded(pyramid, { minU: 0.4, minV: 0.4, maxU: 0.6, maxV: 0.6, nearDist: 40 }), true);
});

await check("an object in FRONT of the wall is not", () => {
  const pyramid = pyramidOf(10);
  assert.equal(isOccluded(pyramid, { minU: 0.4, minV: 0.4, maxU: 0.6, maxV: 0.6, nearDist: 5 }), false);
});

await check("an object poking past the wall's edge survives", () => {
  // Half wall, half sky — exactly the case a min-reduction gets wrong.
  const data = flat(0, 16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) data[y * 16 + x] = 10;
  const pyramid = new DepthPyramid();
  pyramid.build(data, 16, 16);
  assert.equal(isOccluded(pyramid, { minU: 0.4, minV: 0.4, maxU: 0.6, maxV: 0.6, nearDist: 40 }), false);
});

await check("the bias is relative, so it behaves the same near and far", () => {
  const near = pyramidOf(10);
  const far = pyramidOf(1000);
  // 1% past the occluder is inside the 2% margin at both scales.
  assert.equal(isOccluded(near, { minU: 0.4, minV: 0.4, maxU: 0.6, maxV: 0.6, nearDist: 10.1 }), false);
  assert.equal(isOccluded(far, { minU: 0.4, minV: 0.4, maxU: 0.6, maxV: 0.6, nearDist: 1010 }), false);
  assert.equal(isOccluded(near, { minU: 0.4, minV: 0.4, maxU: 0.6, maxV: 0.6, nearDist: 11 }), true);
  assert.equal(isOccluded(far, { minU: 0.4, minV: 0.4, maxU: 0.6, maxV: 0.6, nearDist: 1100 }), true);
});

// ---------------------------------------------------------------------------

section("the system, end to end");

/**
 * A wall across the view with a prop behind it, and a depth buffer that says
 * so. Everything except the GPU pass is real: real entities, the real
 * bounding-sphere cache, the engine's own visibility resolve.
 */
function occludedScene({ propZ = -60, propX = 0 } = {}) {
  const engine = new Engine();
  const wall = engine.createEntity({ name: "Wall" });
  wall.addComponent("mesh", {});
  wall.object3D.position.set(0, 0, -20);
  wall.object3D.scale.set(40, 40, 1);
  const prop = engine.createEntity({ name: "Prop" });
  prop.addComponent("mesh", {});
  prop.object3D.position.set(propX, 0, propZ);
  const view = camera();
  engine.camera = view;
  engine.scene.updateMatrixWorld(true);

  engine.occlusion.setEnabled(true);
  // Stand in for the GPU pass: the wall is 20 m away and fills the frame.
  engine.occlusion.pyramid.build(flat(20, 32, 32), 32, 32);
  engine.occlusion.captureView.copy(view.matrixWorldInverse);
  engine.occlusion.captureProjection.copy(view.projectionMatrix);
  return { engine, wall, prop };
}

/** The part of the engine's tick that consumes `_occluded`. */
const resolve = (engine) => {
  engine.occlusion.apply();
  for (const entity of engine.entities.values()) {
    entity.object3D.visible =
      entity.enabledInEditor !== false && entity._lodHidden !== true && entity._occluded !== true;
  }
};

await check("a prop behind the wall stops being drawn", () => {
  const { engine, prop } = occludedScene();
  resolve(engine);
  assert.equal(prop._occluded, true);
  assert.equal(prop.object3D.visible, false);
  assert.equal(engine.occlusion.stats.culled, 1);
});

await check("and comes back the moment it is no longer behind it", () => {
  const { engine, prop } = occludedScene();
  resolve(engine);
  assert.equal(prop.object3D.visible, false);
  prop.object3D.position.set(0, 0, -10); // now in front of the wall
  prop.object3D.updateMatrixWorld(true);
  resolve(engine);
  assert.equal(prop._occluded, false);
  assert.equal(prop.object3D.visible, true);
});

await check("the occluder itself is never culled against its own depth", () => {
  const { engine, wall } = occludedScene();
  engine.occlusion._occluderDirty = true;
  // Tag the wall the way the depth pass would.
  wall.object3D.traverse((object) => {
    if (object.isMesh) object.layers.enable(OCCLUDER_LAYER);
  });
  resolve(engine);
  assert.equal(wall._occluded, undefined, "an occluder must not vanish into its own buffer");
});

await check("turning the system off brings everything back", () => {
  const { engine, prop } = occludedScene();
  resolve(engine);
  assert.equal(prop._occluded, true);
  engine.occlusion.setEnabled(false);
  assert.equal(prop._occluded, false, "a disabled system must not leave the scene half missing");
  resolve(engine);
  assert.equal(prop.object3D.visible, true);
});

await check("reset() is the escape hatch a scene load needs", () => {
  const { engine, prop } = occludedScene();
  resolve(engine);
  assert.equal(prop._occluded, true);
  engine.occlusion.reset();
  assert.equal(prop._occluded, false);
  assert.equal(engine.occlusion.pyramid.ready, false, "a stale buffer describes a level that is gone");
});

await check("a batched member is skipped — hiding it would do nothing anyway", () => {
  const { engine, prop } = occludedScene();
  // A batched mesh draws through its proxy no matter what its own visibility
  // says, so culling it is a decision with no effect and a misleading stat.
  prop.getComponent("mesh").mesh.userData.batchedInto = {};
  resolve(engine);
  assert.equal(prop._occluded, undefined);
  assert.equal(engine.occlusion.stats.culled, 0);
});

await check("a batch PROXY is tested instead, which hides a hundred props at once", () => {
  const { engine } = occludedScene();
  const proxy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), null);
  proxy.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -60), 2);
  engine.batching.batches.push({ mesh: proxy, members: [] });
  resolve(engine);
  assert.equal(proxy.visible, false);
  // And back again: the proxy's flag has no other writer, so this system owns
  // restoring it.
  proxy.boundingSphere.center.set(0, 0, -10);
  resolve(engine);
  assert.equal(proxy.visible, true);
});

await check("an entity with no geometry is never counted as tested", () => {
  const { engine } = occludedScene();
  const empty = engine.createEntity({ name: "Empty" });
  resolve(engine);
  assert.equal(empty._occluded, undefined);
});

await check("with no depth buffer yet, nothing is culled at all", () => {
  const { engine, prop } = occludedScene();
  engine.occlusion.pyramid.clear();
  resolve(engine);
  assert.equal(prop._occluded, undefined);
  assert.equal(prop.object3D.visible, true);
});

await check("the test uses the camera the depth was CAPTURED with, not the one that moved since", () => {
  // Applying a stale buffer against the current camera is what makes occlusion
  // culling flicker whenever the player turns: the pixels describe one frame
  // and the projection another.
  const { engine, prop } = occludedScene();
  resolve(engine);
  assert.equal(prop._occluded, true);
  engine.camera.position.set(200, 0, 0);
  engine.camera.updateMatrixWorld(true);
  resolve(engine);
  assert.equal(prop._occluded, true, "the answer must not change until a new capture lands");
});

// ---------------------------------------------------------------------------

section("the occluder tag depends on a bounding sphere that must not go stale");

// ⚠ THIS IS THE BUG THAT MADE THE WHOLE FEATURE READ "occluded 0" IN A REAL
// SCENE while every test above passed. The tests build their occluders from
// primitive geometry, which exists on frame 1; a real scene's walls are
// `geometryAsset` meshes that render the declared primitive ("box") until the
// .geom lands a few hundred milliseconds later. `getEntityBoundingSphere`
// cached the placeholder's radius against a hash of the entity's TRANSLATION,
// and a geometry swap does not move anything — so a 25 m wall answered 0.866
// for the rest of the session, failed `minOccluderSize`, and the occluder list
// came out EMPTY. With no occluders the depth pass never runs, the pyramid is
// never built, and `apply()` returns before testing a single object.
const { getEntityBoundingSphere } = await import("../src/engine/viewFrustum.js");

await check("a geometry swap invalidates the cached bounding sphere", () => {
  const engine = new Engine();
  const wall = engine.createEntity({ name: "Wall" });
  const mesh = wall.addComponent("mesh", { geometry: "box" });
  engine.scene.updateMatrixWorld(true);

  const sphere = new THREE.Sphere();
  // Frame 1: frustum culling asks, and caches the placeholder unit box.
  getEntityBoundingSphere(wall, sphere);
  assert.ok(Math.abs(sphere.radius - Math.sqrt(3) / 2) < 1e-3, `placeholder ${sphere.radius}`);

  // The .geom asset lands. Same entity, same position, much bigger geometry.
  mesh.mesh.geometry.dispose();
  mesh.mesh.geometry = new THREE.BoxGeometry(42.9, 0.5, 27.5);
  engine.scene.updateMatrixWorld(true);

  getEntityBoundingSphere(wall, sphere);
  assert.ok(sphere.radius > 20, `after the swap the sphere is still ${sphere.radius}`);
});

await check("…so a wall whose geometry loaded late is still tagged as an occluder", () => {
  const engine = new Engine();
  const wall = engine.createEntity({ name: "Wall" });
  const mesh = wall.addComponent("mesh", { geometry: "box" });
  engine.scene.updateMatrixWorld(true);
  const sphere = new THREE.Sphere();
  getEntityBoundingSphere(wall, sphere); // poison the cache the way frame 1 does

  mesh.mesh.geometry.dispose();
  mesh.mesh.geometry = new THREE.BoxGeometry(42.9, 0.5, 27.5);
  engine.scene.updateMatrixWorld(true);

  engine.occlusion.setEnabled(true);
  engine.occlusion.refreshOccluders();
  assert.equal(engine.occlusion.stats.occluders, 1, "the wall was not counted as an occluder");
  assert.equal(mesh.mesh.layers.isEnabled(OCCLUDER_LAYER), true, "no OCCLUDER_LAYER bit");
});

await check("rescaling an entity invalidates it too", () => {
  // Scale changes the world-space radius while leaving the translation alone —
  // the same blind spot, reachable by dragging the scale gizmo.
  const engine = new Engine();
  const box = engine.createEntity({ name: "Box" });
  box.addComponent("mesh", { geometry: "box" });
  engine.scene.updateMatrixWorld(true);
  const sphere = new THREE.Sphere();
  getEntityBoundingSphere(box, sphere);
  const before = sphere.radius;

  box.object3D.scale.set(30, 30, 30);
  engine.scene.updateMatrixWorld(true);
  getEntityBoundingSphere(box, sphere);
  assert.ok(sphere.radius > before * 20, `${before} -> ${sphere.radius}`);
});

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? "all occlusion checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
