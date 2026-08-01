/**
 * LOD groups (roadmap item 14).
 *
 * The interesting behaviour is entirely in the decisions, not in the drawing:
 * which level a coverage picks, whether the choice survives a change of field
 * of view or a scaled-up prop, whether it stops flickering on a threshold, and
 * whether removing the component gives every level back. All of that is
 * testable without a GPU — and none of it is observable in a screenshot, which
 * is exactly why it belongs here.
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
const { screenCoverage, selectLod, fitLevels } = await import("../src/engine/lod/lodSelect.js");
const { LodSystem } = await import("../src/engine/lod/LodSystem.js");
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

const sphere = (x, y, z, r) => new THREE.Sphere(new THREE.Vector3(x, y, z), r);
const perspective = (fov = 50, z = 0) => {
  const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 1000);
  camera.position.set(0, 0, z);
  camera.updateMatrixWorld(true);
  return camera;
};

/**
 * A group whose children are `count` boxes of `size`, all at the origin — the
 * shape of a real LOD chain, where every level is the same object.
 */
function lodEngine({ count = 3, size = 2, levels, distance = 20, fov = 50 } = {}) {
  const engine = new Engine();
  const group = engine.createEntity({ name: "Prop" });
  for (let i = 0; i < count; i++) {
    const child = engine.createEntity({ name: `Prop_LOD${i}` });
    child.setParent(group);
    child.addComponent("mesh", { geometry: "box", width: size, height: size, depth: size });
  }
  const component = group.addComponent("lod", levels ? { levels } : {});
  const camera = perspective(fov, distance);
  engine.camera = camera;
  engine.scene.updateMatrixWorld(true);
  return { engine, group, component, camera };
}

/** Runs the LOD pass and the engine's visibility resolve, as a frame would. */
const resolve = (engine) => {
  engine.lod.update();
  const modeFlag = engine.playing ? "enabledInGame" : "enabledInEditor";
  for (const entity of engine.entities.values()) {
    entity.object3D.visible = entity[modeFlag] !== false && entity._lodHidden !== true;
  }
};

const visibleLevels = (group) =>
  group.children.map((child) => child.object3D.visible);

// ---------------------------------------------------------------------------

section("screen coverage");

await check("an object filling the frame reads 1, half the frame reads 0.5", () => {
  const camera = perspective(90, 0);
  // At 90° the frustum is 2·d tall, so a sphere of radius d/2 (diameter d)
  // covers exactly half the height.
  const d = 10;
  assert.ok(Math.abs(screenCoverage(sphere(0, 0, -d, d / 2), camera) - 0.5) < 1e-6);
  assert.ok(Math.abs(screenCoverage(sphere(0, 0, -d, d), camera) - 1) < 1e-6);
});

await check("halving the distance doubles the coverage", () => {
  const camera = perspective(50, 0);
  const near = screenCoverage(sphere(0, 0, -10, 1), camera);
  const far = screenCoverage(sphere(0, 0, -20, 1), camera);
  assert.ok(Math.abs(near - far * 2) < 1e-6, `${near} vs ${far}`);
});

await check("a narrower field of view makes the SAME object bigger — the whole reason this isn't a distance", () => {
  const wide = screenCoverage(sphere(0, 0, -30, 1), perspective(60, 0));
  const scoped = screenCoverage(sphere(0, 0, -30, 1), perspective(20, 0));
  assert.ok(scoped > wide * 2.5, `${scoped} vs ${wide}`);
});

await check("scaling the prop scales its coverage, so its switch distance moves with it", () => {
  const camera = perspective(50, 0);
  const small = screenCoverage(sphere(0, 0, -40, 1), camera);
  const big = screenCoverage(sphere(0, 0, -40, 4), camera);
  assert.ok(Math.abs(big - small * 4) < 1e-6, `${big} vs ${small}`);
});

await check("coverage is invariant to aspect ratio — it is a share of the HEIGHT", () => {
  const tall = new THREE.PerspectiveCamera(50, 9 / 16, 0.1, 1000);
  const wide = new THREE.PerspectiveCamera(50, 21 / 9, 0.1, 1000);
  tall.updateMatrixWorld(true);
  wide.updateMatrixWorld(true);
  const s = sphere(0, 0, -25, 2);
  assert.ok(Math.abs(screenCoverage(s, tall) - screenCoverage(s, wide)) < 1e-9);
});

await check("zoom counts as being nearer", () => {
  const camera = perspective(50, 0);
  const plain = screenCoverage(sphere(0, 0, -30, 1), camera);
  camera.zoom = 4;
  camera.updateProjectionMatrix();
  assert.ok(Math.abs(screenCoverage(sphere(0, 0, -30, 1), camera) - plain * 4) < 1e-6);
});

await check("an orthographic camera ignores distance entirely", () => {
  const camera = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.1, 1000);
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  const near = screenCoverage(sphere(0, 0, -10, 1), camera);
  const far = screenCoverage(sphere(0, 0, -900, 1), camera);
  assert.equal(near, far, "an isometric camera dollying back must not re-LOD the map");
  assert.ok(Math.abs(near - 2 / 10) < 1e-9, `${near}`);
});

await check("a camera inside the sphere reports full coverage rather than dividing by zero", () => {
  const camera = perspective(50, 0);
  const value = screenCoverage(sphere(0, 0, 0, 5), camera);
  assert.equal(value, 1);
  assert.ok(Number.isFinite(value));
});

await check("a degenerate sphere covers nothing", () => {
  assert.equal(screenCoverage(sphere(0, 0, -10, 0), perspective()), 0);
});

// ---------------------------------------------------------------------------

section("level selection");

const LEVELS = [0.5, 0.2, 0.05];

await check("coverage above the first threshold picks the finest level", () => {
  assert.equal(selectLod(0.9, LEVELS), 0);
  assert.equal(selectLod(0.5, LEVELS), 0, "the threshold itself belongs to the finer level");
});

await check("each band picks its own level", () => {
  assert.equal(selectLod(0.35, LEVELS), 1);
  assert.equal(selectLod(0.2, LEVELS), 1);
  assert.equal(selectLod(0.1, LEVELS), 2);
});

await check("below the last threshold the group is culled", () => {
  assert.equal(selectLod(0.01, LEVELS), -1);
});

await check("a final 0 means it never culls", () => {
  assert.equal(selectLod(0.000001, [0.5, 0.2, 0]), 2);
});

await check("no levels at all is culled, not level 0", () => {
  assert.equal(selectLod(1, []), -1);
});

await check("hysteresis holds the current level through the threshold", () => {
  // Sitting a hair below 0.5 would flip to level 1 without a dead-band.
  assert.equal(selectLod(0.49, LEVELS, { current: 0, hysteresis: 0.05 }), 0);
  // Far enough past it, the switch happens.
  assert.equal(selectLod(0.47, LEVELS, { current: 0, hysteresis: 0.05 }), 1);
});

await check("…and holds it from the other side too, or the band is a one-way valve", () => {
  assert.equal(selectLod(0.51, LEVELS, { current: 1, hysteresis: 0.05 }), 1);
  assert.equal(selectLod(0.53, LEVELS, { current: 1, hysteresis: 0.05 }), 0);
});

await check("a coverage oscillating across a threshold switches at most once", () => {
  let current = 0;
  let switches = 0;
  // Jitter of ±1% around the 0.5 boundary — a prop at a fixed distance with a
  // camera that breathes.
  for (let i = 0; i < 200; i++) {
    const coverage = 0.5 + Math.sin(i) * 0.005;
    const next = selectLod(coverage, LEVELS, { current, hysteresis: 0.05 });
    if (next !== current) switches++;
    current = next;
  }
  assert.ok(switches <= 1, `${switches} switches — a shimmer, and a batch rebuild each time`);
});

await check("with no hysteresis that same jitter thrashes — the dead-band is load-bearing", () => {
  let current = 0;
  let switches = 0;
  for (let i = 0; i < 200; i++) {
    const coverage = 0.5 + Math.sin(i) * 0.005;
    const next = selectLod(coverage, LEVELS, { current, hysteresis: 0 });
    if (next !== current) switches++;
    current = next;
  }
  assert.ok(switches > 20, `only ${switches} — the control case is not exercising the boundary`);
});

await check("a culled group does not un-cull until clearly back in range", () => {
  assert.equal(selectLod(0.051, LEVELS, { current: -1, hysteresis: 0.05 }), -1);
  assert.equal(selectLod(0.06, LEVELS, { current: -1, hysteresis: 0.05 }), 2);
});

await check("a big jump skips straight to the right level", () => {
  // A teleport, or a cut to another camera: the dead-band must not force the
  // chain to walk down one level per frame.
  assert.equal(selectLod(0.01, LEVELS, { current: 0, hysteresis: 0.05 }), -1);
});

section("threshold fitting");

await check("a new level gets a usable threshold, not 0", () => {
  const fitted = fitLevels([0.5], 3);
  assert.equal(fitted.length, 3);
  assert.equal(fitted[0], 0.5);
  assert.ok(fitted[1] > 0 && fitted[1] < 0.5, `${fitted[1]}`);
});

await check("the last level defaults to never culling", () => {
  assert.equal(fitLevels([], 3)[2], 0);
});

await check("authored thresholds survive a refit", () => {
  assert.deepEqual(fitLevels([0.8, 0.4, 0.1], 3), [0.8, 0.4, 0.1]);
});

await check("dropping a level truncates rather than reshuffling", () => {
  assert.deepEqual(fitLevels([0.8, 0.4, 0.1], 2), [0.8, 0.4]);
});

await check("an ascending entry is clamped — an unreachable level is worse than a wrong one", () => {
  const fitted = fitLevels([0.3, 0.9, 0.1], 3);
  assert.ok(fitted[1] <= fitted[0], `${fitted}`);
});

// ---------------------------------------------------------------------------

section("the component");

await check("the children are the levels, finest first", () => {
  const { component } = lodEngine({ count: 3 });
  assert.equal(component.levelCount, 3);
  assert.deepEqual(component.levelEntities.map((e) => e.name), ["Prop_LOD0", "Prop_LOD1", "Prop_LOD2"]);
});

await check("exactly one level is visible at a time", () => {
  const { engine, group } = lodEngine({ count: 3, distance: 8 });
  resolve(engine);
  assert.equal(visibleLevels(group).filter(Boolean).length, 1);
});

await check("moving the camera away steps down the chain", () => {
  const { engine, group, component, camera } = lodEngine({
    count: 3,
    size: 2,
    levels: [0.5, 0.2, 0],
  });
  const seen = [];
  for (const distance of [2.5, 6, 40]) {
    camera.position.set(0, 0, distance);
    camera.updateMatrixWorld(true);
    resolve(engine);
    seen.push(component.activeLevel);
  }
  assert.deepEqual(seen, [0, 1, 2], `got ${seen}`);
  assert.equal(visibleLevels(group).filter(Boolean).length, 1);
});

await check("a culled group draws nothing at all", () => {
  const { engine, group, component, camera } = lodEngine({ levels: [0.5, 0.2, 0.1] });
  camera.position.set(0, 0, 400);
  camera.updateMatrixWorld(true);
  resolve(engine);
  assert.equal(component.activeLevel, -1);
  assert.equal(visibleLevels(group).filter(Boolean).length, 0);
});

await check("adding a child adds a level without touching the authored thresholds", () => {
  const { engine, group, component } = lodEngine({ count: 2, levels: [0.6, 0.3] });
  const extra = engine.createEntity({ name: "Prop_LOD2" });
  extra.setParent(group);
  assert.equal(component.levelCount, 3);
  assert.deepEqual(component.thresholds.slice(0, 2), [0.6, 0.3]);
});

await check("a forced level pins the chain regardless of distance", () => {
  const { engine, component, camera } = lodEngine({ count: 3 });
  // Through setProp, so this also proves an inspector edit takes effect at
  // once rather than waiting for the hysteresis band to be left.
  component.setProp("forcedLevel", 2);
  for (const distance of [1, 500]) {
    camera.position.set(0, 0, distance);
    camera.updateMatrixWorld(true);
    resolve(engine);
    assert.equal(component.activeLevel, 2, `at ${distance}`);
  }
});

await check("a forced level past the end clamps instead of culling everything", () => {
  const { engine, component } = lodEngine({ count: 2 });
  component.setProp("forcedLevel", 9);
  resolve(engine);
  assert.equal(component.activeLevel, 1);
});

// ---------------------------------------------------------------------------

section("giving the levels back");

await check("removing the component restores every level", () => {
  const { engine, group } = lodEngine({ count: 3, distance: 60 });
  resolve(engine);
  assert.ok(visibleLevels(group).filter(Boolean).length <= 1);
  group.removeComponent("lod");
  resolve(engine);
  assert.deepEqual(visibleLevels(group), [true, true, true], "a deleted component must not leave the scene missing meshes");
});

await check("disabling the component restores every level", () => {
  const { engine, group, component } = lodEngine({ count: 3, distance: 60 });
  resolve(engine);
  component.setEnabled(false);
  resolve(engine);
  assert.deepEqual(visibleLevels(group), [true, true, true]);
});

await check("turning the system off restores every level", () => {
  const { engine, group } = lodEngine({ count: 3, distance: 60 });
  resolve(engine);
  engine.lod.setEnabled(false);
  resolve(engine);
  assert.deepEqual(visibleLevels(group), [true, true, true]);
});

await check("an author-disabled level stays hidden even when the camera asks for it", () => {
  const { engine, group } = lodEngine({ count: 3, distance: 3 });
  group.children[0].setEnabledInEditor(false);
  resolve(engine);
  assert.equal(group.children[0].object3D.visible, false, "LOD is a veto, not an override");
});

// ---------------------------------------------------------------------------

section("engine integration");

await check("the engine owns an LOD system", () => {
  const engine = new Engine();
  assert.ok(engine.lod instanceof LodSystem);
  assert.equal(engine.lod.stats.groups, 0);
});

await check("a level switch invalidates the static batches", () => {
  // A batched member is drawn through its proxy whatever its own `visible`
  // says, so a switch that doesn't invalidate leaves BOTH levels on screen.
  const { engine, camera } = lodEngine({ count: 3, levels: [0.5, 0.2, 0] });
  engine.batching._dirty = false;
  camera.position.set(0, 0, 2);
  camera.updateMatrixWorld(true);
  engine.lod.update();
  engine.batching._dirty = false;
  camera.position.set(0, 0, 60);
  camera.updateMatrixWorld(true);
  engine.lod.update();
  assert.equal(engine.batching._dirty, true);
});

await check("a frame with no switches invalidates nothing", () => {
  const { engine } = lodEngine({ count: 3, distance: 8 });
  engine.lod.update();
  engine.batching._dirty = false;
  engine.lod.update();
  assert.equal(engine.batching._dirty, false, "a static camera must not rebuild batches every frame");
});

await check("one hundred groups switching at once are one invalidation, not one hundred", () => {
  const engine = new Engine();
  const camera = perspective(50, 3);
  engine.camera = camera;
  for (let i = 0; i < 100; i++) {
    const group = engine.createEntity({ name: `P${i}` });
    for (let level = 0; level < 2; level++) {
      const child = engine.createEntity({ name: `P${i}_LOD${level}` });
      child.setParent(group);
      child.addComponent("mesh", { geometry: "box" });
    }
    group.addComponent("lod", { levels: [0.5, 0] });
  }
  engine.scene.updateMatrixWorld(true);
  // Let the chain settle first; the frame under test is the one where all
  // hundred groups cross a threshold together.
  engine.lod.update();
  let invalidations = 0;
  engine.batching.invalidate = () => invalidations++;
  camera.position.set(0, 0, 200);
  camera.updateMatrixWorld(true);
  engine.lod.update();
  assert.equal(engine.lod.stats.switches, 100, "all hundred should have moved");
  assert.equal(invalidations, 1);
});

await check("groups with no camera do nothing rather than throwing", () => {
  const { engine, group } = lodEngine({ count: 2 });
  engine.camera = null;
  engine.lod.update();
  assert.deepEqual(visibleLevels(group).length, 2);
});

await check("a group with no children is inert", () => {
  const engine = new Engine();
  engine.camera = perspective(50, 5);
  const entity = engine.createEntity({ name: "Empty" });
  const component = entity.addComponent("lod", {});
  engine.lod.update();
  assert.equal(component.activeLevel, null);
});

await check("the stats report what is culled — the number an author checks", () => {
  const { engine, camera } = lodEngine({ count: 2, levels: [0.5, 0.2] });
  camera.position.set(0, 0, 500);
  camera.updateMatrixWorld(true);
  engine.lod.update();
  assert.equal(engine.lod.stats.groups, 1);
  assert.equal(engine.lod.stats.culled, 1);
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall LOD checks passed");
process.exit(failures ? 1 : 0);
