/**
 * Runtime debug drawing (roadmap item 9).
 *
 * What's worth testing here isn't "does a line have two vertices" — it's the
 * lifetime rules, because those are what make the feature usable or a leak:
 * an immediate shape must vanish the frame after it stops being drawn, a timed
 * shape must survive frames where nobody draws anything at all, and neither may
 * grow the buffer without bound.
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
const { DebugBuffer, DebugDraw } = await import("../src/engine/debugDraw.js");
const { DEBUG_LAYER, EDITOR_LAYER } = await import("../src/engine/editorLayers.js");
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

/** A DebugDraw over a bare scene — no renderer needed to test the buffer. */
function debugDraw() {
  const engine = { scene: new THREE.Scene() };
  return new DebugDraw(engine);
}
/** One frame: draw, then flush, then advance the clock. */
const frame = (debug, draw, dt = 1 / 60) => {
  draw?.(debug);
  debug.flush();
  debug.tick(dt);
};

// ---------------------------------------------------------------------------

section("shapes");

await check("a line writes exactly two vertices", () => {
  const buffer = new DebugBuffer();
  buffer.begin();
  buffer.line([0, 0, 0], [1, 2, 3]);
  assert.equal(buffer.count, 2);
  assert.deepEqual([...buffer.positions.slice(0, 6)], [0, 0, 0, 1, 2, 3]);
});

await check("a box is twelve edges and honours its rotation", () => {
  const buffer = new DebugBuffer();
  buffer.begin();
  buffer.box([0, 0, 0], 2);
  assert.equal(buffer.count, 24, "12 edges");
  // Every corner of a 2-unit cube is √3 from the centre, whatever the rotation.
  const rotated = new DebugBuffer();
  rotated.begin();
  rotated.box([0, 0, 0], 2, new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.7, 0.2)));
  for (let i = 0; i < rotated.count; i++) {
    const v = new THREE.Vector3().fromArray(rotated.positions, i * 3);
    assert.ok(Math.abs(v.length() - Math.sqrt(3)) < 1e-5, `corner at ${v.length()}`);
  }
});

await check("a sphere is three great circles at the right radius", () => {
  const buffer = new DebugBuffer();
  buffer.begin();
  buffer.sphere([5, 0, 0], 2, 16);
  assert.equal(buffer.count, 3 * 16 * 2, "three circles");
  const centre = new THREE.Vector3(5, 0, 0);
  for (let i = 0; i < buffer.count; i++) {
    const v = new THREE.Vector3().fromArray(buffer.positions, i * 3);
    assert.ok(Math.abs(v.distanceTo(centre) - 2) < 1e-5, `point at ${v.distanceTo(centre)}`);
  }
});

await check("an arrow adds a head that points the right way", () => {
  const buffer = new DebugBuffer();
  buffer.begin();
  buffer.arrow([0, 0, 0], [10, 0, 0]);
  assert.equal(buffer.count, 6, "shaft plus two head lines");
  // Every head vertex sits at or near the tip, never near the tail — that's
  // what makes the direction readable at a glance.
  for (let i = 2; i < buffer.count; i++) {
    const v = new THREE.Vector3().fromArray(buffer.positions, i * 3);
    assert.ok(v.x > 5, `head vertex at x=${v.x} should be at the far end`);
  }
});

await check("the transform matrix applies to subsequent vertices", () => {
  const buffer = new DebugBuffer();
  buffer.begin();
  buffer.transform(new THREE.Matrix4().makeTranslation(10, 0, 0));
  buffer.line([0, 0, 0], [1, 0, 0]);
  assert.deepEqual([...buffer.positions.slice(0, 6)], [10, 0, 0, 11, 0, 0]);
  buffer.transform(null);
  buffer.line([0, 0, 0], [1, 0, 0]);
  assert.deepEqual([...buffer.positions.slice(6, 12)], [0, 0, 0, 1, 0, 0], "and clears");
});

await check("colour is per-vertex, so shapes keep the colour they were drawn with", () => {
  const buffer = new DebugBuffer();
  buffer.begin();
  buffer.color("#ff0000").line([0, 0, 0], [1, 0, 0]);
  buffer.color("#0000ff").line([0, 0, 0], [1, 0, 0]);
  assert.deepEqual([...buffer.colors.slice(0, 3)], [1, 0, 0]);
  assert.deepEqual([...buffer.colors.slice(6, 9)], [0, 0, 1]);
});

await check("the buffer grows past its initial capacity without losing anything", () => {
  const buffer = new DebugBuffer();
  buffer.begin();
  for (let i = 0; i < 4000; i++) buffer.line([i, 0, 0], [i, 1, 0]);
  assert.equal(buffer.count, 8000);
  assert.deepEqual([...buffer.positions.slice(0, 3)], [0, 0, 0], "the first vertex survived the regrow");
  assert.deepEqual([...buffer.positions.slice(7998 * 3, 7998 * 3 + 3)], [3999, 0, 0], "and the last is there");
});

// ---------------------------------------------------------------------------

section("lifetime");

await check("an immediate shape lasts exactly one frame", () => {
  const debug = debugDraw();
  frame(debug, (d) => d.line([0, 0, 0], [1, 0, 0]));
  assert.equal(debug.buffer.count, 2, "drawn");
  frame(debug, null);
  assert.equal(debug.buffer.count, 0, "and gone once nothing draws it");
  assert.equal(debug.mesh.visible, false, "with the mesh hidden rather than left stale");
});

await check("a timed shape survives frames where nothing is drawn", () => {
  // The property that makes `duration` worth having: a raycast fired inside a
  // collision handler exists for one frame, and one frame at 120fps is not
  // something a person can see.
  const debug = debugDraw();
  frame(debug, (d) => d.line([0, 0, 0], [1, 0, 0], "#f00", 0.5));
  assert.equal(debug.buffer.count, 2);
  for (let i = 0; i < 20; i++) frame(debug, null);
  assert.equal(debug.buffer.count, 2, "still there a third of a second later");
  assert.equal(debug.mesh.visible, true);
  for (let i = 0; i < 20; i++) frame(debug, null);
  assert.equal(debug.buffer.count, 0, "and expires on schedule");
});

await check("timed and immediate shapes coexist without duplicating", () => {
  const debug = debugDraw();
  frame(debug, (d) => d.line([0, 0, 0], [1, 0, 0], "#f00", 1));
  frame(debug, (d) => d.line([0, 0, 0], [0, 1, 0]));
  assert.equal(debug.buffer.count, 4, "one retained replay plus one fresh line");
  frame(debug, null);
  assert.equal(debug.buffer.count, 2, "the immediate one dropped, the timed one stayed");
});

await check("timed shapes are timed in REAL seconds, not game seconds", () => {
  // A debug line's duration is a human's "let me look at it for two seconds".
  // Bullet time must not stretch it to thirteen, and a paused game must not
  // leave it on screen forever.
  const engine = new Engine();
  engine.debug.line([0, 0, 0], [1, 0, 0], "#f00", 0.5);
  engine.setTimeScale(0.1);
  for (let i = 0; i < 40; i++) {
    engine.debug.tick(1 / 60); // the engine feeds this the UNSCALED delta
    engine.debug.flush();
  }
  assert.equal(engine.debug.retained.length, 0, "expired after 0.66 real seconds");
});

await check("clear() drops everything, and Stop clears it", () => {
  const engine = new Engine();
  engine.playing = true;
  engine.debug.line([0, 0, 0], [1, 0, 0], "#f00", 10);
  assert.equal(engine.debug.retained.length, 1);
  engine.setPlaying(false);
  assert.equal(engine.debug.retained.length, 0, "a line drawn on the last frame of Play doesn't outlive it");
});

await check("disabling it makes every call a no-op", () => {
  const debug = debugDraw();
  debug.setEnabled(false);
  frame(debug, (d) => {
    d.line([0, 0, 0], [1, 0, 0]);
    d.sphere([0, 0, 0], 1, "#f00", 5);
  });
  assert.equal(debug.buffer.count, 0);
  assert.equal(debug.retained.length, 0, "not even the timed one");
  debug.setEnabled(true);
  frame(debug, (d) => d.line([0, 0, 0], [1, 0, 0]));
  assert.equal(debug.buffer.count, 2, "and re-enabling works");
});

await check("runaway timed shapes are capped and warned about once", () => {
  const debug = debugDraw();
  const warnings = [];
  const original = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    // The mistake this guards: `debug.line(a, b, c, 0.5)` inside an update loop.
    for (let i = 0; i < 20000; i++) debug.line([0, 0, 0], [1, 0, 0], "#f00", 60);
  } finally {
    console.warn = original;
  }
  assert.ok(debug.retained.length <= 8192, `capped at ${debug.retained.length}`);
  assert.equal(warnings.length, 1, "warned exactly once, not 12000 times");
  assert.ok(warnings[0].includes("one-shot events"), warnings[0]);
});

// ---------------------------------------------------------------------------

section("engine wiring");

await check("debug drawing lives on its own layer, not the editor one", () => {
  // It has to be visible in Play mode and the Game view — the two views that
  // switch the editor layer off.
  const engine = new Engine();
  engine.debug.line([0, 0, 0], [1, 0, 0]);
  engine.debug.flush();
  const mesh = engine.scene.getObjectByName("__debugDraw");
  assert.ok(mesh, "the mesh was added to the scene");
  assert.ok(mesh.layers.isEnabled(DEBUG_LAYER), "on the debug layer");
  assert.ok(!mesh.layers.isEnabled(EDITOR_LAYER), "not the editor layer");
  assert.equal(mesh.frustumCulled, false, "and never culled — its bounds change every frame");
});

await check("a game camera is set up to see it", () => {
  const engine = new Engine();
  const entity = engine.createEntity({ name: "Cam" });
  const camera = entity.addComponent("camera", {}).camera;
  assert.ok(camera.layers.isEnabled(DEBUG_LAYER), "otherwise it draws into Play mode and shows nothing");
});

await check("one draw call, however many shapes", () => {
  const engine = new Engine();
  for (let i = 0; i < 500; i++) engine.debug.sphere([i, 0, 0], 1);
  engine.debug.flush();
  const meshes = [];
  engine.scene.traverse((o) => o.isLineSegments && meshes.push(o));
  assert.equal(meshes.length, 1, "500 spheres, one LineSegments");
  assert.equal(meshes[0].geometry.drawRange.count, 500 * 3 * 32 * 2);
});

await check("text degrades quietly when there is no DOM to rasterize with", () => {
  // Headless (the player's server-side smoke, this test) has no canvas. Text
  // must be a no-op there, not a throw that takes the frame down with it.
  const debug = debugDraw();
  const canvas = document.createElement;
  document.createElement = () => ({ getContext: () => null });
  try {
    debug.text([0, 1, 0], "chasing", "#fff");
    debug.flush();
  } finally {
    document.createElement = canvas;
  }
  assert.ok(true, "no throw");
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall debug draw checks passed");
process.exit(failures ? 1 : 0);
