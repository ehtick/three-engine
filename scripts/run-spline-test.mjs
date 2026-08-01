/**
 * Splines / paths as a scene tool (roadmap item 16).
 *
 * Almost everything that makes a spline system usable or useless is arithmetic
 * you cannot see in a screenshot: whether "distance" means distance, whether
 * the frame flips at an inflection point, whether a cart travels the same route
 * at 30Hz and 240Hz, whether a swept road's triangles face the way its normals
 * claim. All of that lives here. The one thing that genuinely needs a GPU and
 * an editor — dragging a knot handle and seeing the road move — is in
 * `smoke:spline`.
 */
import assert from "node:assert/strict";
import { inspect } from "node:util";

// Same instrument note as the pool suite: node builds an AssertionError's
// message EAGERLY, walking entity → engine → the whole three.js scene graph.
// One wrong expectation then kills the process instead of failing a check.
inspect.defaultOptions.depth = 0;
inspect.defaultOptions.getters = false;

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
const { Spline, SplineFrame, advanceAlong, normalizeKnot } = await import("../src/engine/spline/splineMath.js");
const { buildSplineGeometry, buildProfile } = await import("../src/engine/spline/splineGeometry.js");
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

const knot = (x, y, z, extra = {}) => ({ position: [x, y, z], ...extra });
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------

section("curve evaluation");

await check("a two-knot straight path is exactly as long as the gap between its knots", () => {
  const spline = new Spline([knot(0, 0, 0), knot(0, 0, 10)]);
  assert.ok(near(spline.length, 10, 1e-3), `${spline.length}`);
});

await check("every authoring mode passes through its knots", () => {
  const knots = [knot(0, 0, 0), knot(3, 0, 1), knot(6, 0, -2), knot(9, 0, 0)];
  for (const type of ["catmullrom", "bezier", "linear"]) {
    const spline = new Spline(knots, { type });
    const start = spline.pointAtDistance(0, V());
    const end = spline.pointAtDistance(spline.length, V());
    assert.ok(start.distanceTo(V(0, 0, 0)) < 1e-4, `${type} start ${start.toArray()}`);
    assert.ok(end.distanceTo(V(9, 0, 0)) < 1e-3, `${type} end ${end.toArray()}`);
  }
});

await check("a linear spline IS the polyline — no bulge between knots", () => {
  const spline = new Spline([knot(0, 0, 0), knot(10, 0, 0), knot(10, 0, 10)], { type: "linear" });
  assert.ok(near(spline.length, 20, 1e-3), `${spline.length}`);
  const quarter = spline.pointAtDistance(5, V());
  assert.ok(quarter.distanceTo(V(5, 0, 0)) < 1e-3, `${quarter.toArray()}`);
});

await check("catmull-rom tension 0 degenerates to the polyline, tension 1 does not", () => {
  const knots = [knot(0, 0, 0), knot(5, 0, 0), knot(5, 0, 5)];
  const slack = new Spline(knots, { type: "catmullrom", tension: 0 });
  const taut = new Spline(knots, { type: "catmullrom", tension: 1 });
  assert.ok(near(slack.length, 10, 1e-3), `${slack.length}`);
  // A smooth curve through a right-angle corner bulges PAST it, so it is
  // longer than the polyline, not shorter — the opposite of the intuition.
  assert.ok(taut.length > slack.length + 0.1, `${taut.length} vs ${slack.length}`);
});

await check("bezier handles actually bend the curve", () => {
  const straight = new Spline([knot(0, 0, 0, { handleOut: [1, 0, 0] }), knot(10, 0, 0, { handleIn: [-1, 0, 0] })], { type: "bezier" });
  const bowed = new Spline([knot(0, 0, 0, { handleOut: [0, 8, 0] }), knot(10, 0, 0, { handleIn: [0, 8, 0] })], { type: "bezier" });
  assert.ok(near(straight.length, 10, 1e-2), `${straight.length}`);
  assert.ok(bowed.length > 14, `${bowed.length}`);
  assert.ok(bowed.pointAt(0.5, V()).y > 3, "the bow should lift the middle");
});

await check("a closed spline includes the segment back to the first knot", () => {
  const square = [knot(0, 0, 0), knot(10, 0, 0), knot(10, 0, 10), knot(0, 0, 10)];
  const open = new Spline(square, { type: "linear" });
  const closed = new Spline(square, { type: "linear", closed: true });
  assert.equal(open.segmentCount, 3);
  assert.equal(closed.segmentCount, 4);
  assert.ok(near(closed.length - open.length, 10, 1e-3), `${closed.length} vs ${open.length}`);
});

await check("a degenerate path (0 or 1 knot) is inert rather than NaN", () => {
  for (const knots of [[], [knot(1, 2, 3)]]) {
    const spline = new Spline(knots);
    assert.equal(spline.valid, false);
    assert.equal(spline.length, 0);
    const p = spline.pointAtDistance(5, V());
    assert.ok(Number.isFinite(p.x + p.y + p.z), `${p.toArray()}`);
  }
});

section("arc length — the parameter every consumer actually asks for");

await check("equal distance steps are equal steps in SPACE, even with wildly uneven segments", () => {
  // One 1-unit segment followed by a 30-unit one. Stepping the raw curve
  // parameter here travels 30x faster on the second half; stepping arc length
  // must not.
  const spline = new Spline([knot(0, 0, 0), knot(1, 0, 0), knot(31, 0, 0)], { type: "linear" });
  const step = spline.length / 20;
  let min = Infinity;
  let max = 0;
  const a = V();
  const b = V();
  for (let i = 0; i < 20; i++) {
    spline.pointAtDistance(i * step, a);
    spline.pointAtDistance((i + 1) * step, b);
    const d = a.distanceTo(b);
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  assert.ok(max / min < 1.02, `spacing varied ${min.toFixed(4)}..${max.toFixed(4)}`);
});

await check("t is a fraction of LENGTH, not of the parameter", () => {
  const spline = new Spline([knot(0, 0, 0), knot(1, 0, 0), knot(31, 0, 0)], { type: "linear" });
  const mid = spline.pointAt(0.5, V());
  assert.ok(near(mid.x, 15.5, 1e-2), `${mid.x}`);
});

await check("the point at a distance lies ON the curve, not on the chord between samples", () => {
  // Two samples per segment is the coarsest table allowed; a lerp between them
  // would cut visibly inside a tight arc.
  const spline = new Spline([knot(-5, 0, 0), knot(0, 0, 5), knot(5, 0, 0)], { samplesPerSegment: 2 });
  const dense = new Spline([knot(-5, 0, 0), knot(0, 0, 5), knot(5, 0, 0)], { samplesPerSegment: 64 });
  const coarse = spline.pointAt(0.5, V());
  const fine = dense.pointAt(0.5, V());
  assert.ok(coarse.distanceTo(fine) < 0.15, `${coarse.toArray()} vs ${fine.toArray()}`);
});

await check("distance is clamped, not wrapped — a query past the end returns the end", () => {
  const spline = new Spline([knot(0, 0, 0), knot(0, 0, 4)], { type: "linear" });
  const past = spline.pointAtDistance(400, V());
  assert.ok(past.distanceTo(V(0, 0, 4)) < 1e-4, `${past.toArray()}`);
});

section("frames — the reason this isn't a Frenet frame");

await check("an S-curve in the XZ plane keeps its normal up THROUGH the inflection", () => {
  // The textbook Frenet normal points at the centre of curvature, so it flips
  // through 180° exactly here — a road that turns itself inside out mid-length.
  const spline = new Spline([knot(0, 0, 0), knot(5, 0, 5), knot(10, 0, -5), knot(15, 0, 0)]);
  const frame = new SplineFrame();
  for (let i = 0; i <= 40; i++) {
    spline.frameAtDistance((i / 40) * spline.length, frame);
    assert.ok(frame.normal.y > 0.9, `normal tipped over at ${i}: ${frame.normal.toArray()}`);
  }
});

await check("a dead straight path still has a defined frame (Frenet has none)", () => {
  const spline = new Spline([knot(0, 0, 0), knot(0, 0, 5), knot(0, 0, 10)], { type: "linear" });
  const frame = spline.frameAtDistance(5, new SplineFrame());
  assert.ok(frame.normal.length() > 0.99, `${frame.normal.toArray()}`);
  assert.ok(frame.normal.y > 0.99, `${frame.normal.toArray()}`);
});

await check("the frame is orthonormal everywhere, including over a vertical climb", () => {
  const spline = new Spline([knot(0, 0, 0), knot(0, 5, 2), knot(0, 10, 0), knot(3, 12, -3)]);
  const frame = new SplineFrame();
  for (let i = 0; i <= 30; i++) {
    spline.frameAtDistance((i / 30) * spline.length, frame);
    assert.ok(near(frame.tangent.length(), 1, 1e-3), `tangent ${frame.tangent.length()}`);
    assert.ok(near(frame.normal.length(), 1, 1e-3), `normal ${frame.normal.length()}`);
    assert.ok(Math.abs(frame.tangent.dot(frame.normal)) < 1e-3, `not perpendicular at ${i}`);
    assert.ok(near(frame.binormal.length(), 1, 1e-3), `binormal ${frame.binormal.length()}`);
  }
});

await check("consecutive frames never jump — the transport is minimal, not per-sample guesswork", () => {
  const spline = new Spline([knot(0, 0, 0), knot(4, 2, 3), knot(8, -1, 6), knot(12, 3, 2), knot(16, 0, 0)]);
  const a = new SplineFrame();
  const b = new SplineFrame();
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    spline.frameAtDistance((i / 200) * spline.length, a);
    spline.frameAtDistance(((i + 1) / 200) * spline.length, b);
    worst = Math.max(worst, a.normal.angleTo(b.normal));
  }
  assert.ok(worst < 0.2, `biggest normal jump was ${(worst * 57.3).toFixed(1)}°`);
});

await check("a closed loop's seam is twist-free — the residual is spread, not dumped at the join", () => {
  const spline = new Spline(
    [knot(10, 0, 0), knot(0, 4, 10), knot(-10, 0, 0), knot(0, -4, -10)],
    { closed: true },
  );
  const start = spline.frameAtDistance(0, new SplineFrame());
  const end = spline.frameAtDistance(spline.length, new SplineFrame());
  const angle = start.normal.angleTo(end.normal);
  assert.ok(angle < 0.02, `the loop came back ${(angle * 57.3).toFixed(1)}° twisted`);
});

await check("per-knot roll banks the frame", () => {
  const flat = new Spline([knot(0, 0, 0), knot(0, 0, 10)], { type: "linear" });
  const banked = new Spline([knot(0, 0, 0, { roll: 0 }), knot(0, 0, 10, { roll: 90 })], { type: "linear" });
  assert.ok(flat.frameAtDistance(10, new SplineFrame()).normal.y > 0.99);
  const rolled = banked.frameAtDistance(10, new SplineFrame());
  assert.ok(Math.abs(rolled.normal.y) < 0.02, `90° of roll should lay the normal flat: ${rolled.normal.toArray()}`);
  const half = banked.frameAtDistance(5, new SplineFrame());
  assert.ok(near(half.normal.y, Math.cos(Math.PI / 4), 0.02), `roll should interpolate: ${half.normal.toArray()}`);
});

await check("orientation puts the requested axis on the tangent", () => {
  const spline = new Spline([knot(0, 0, 0), knot(10, 0, 0)], { type: "linear" });
  const back = spline.quaternionAtDistance(5, new THREE.Quaternion(), "-Z");
  const forward = spline.quaternionAtDistance(5, new THREE.Quaternion(), "+Z");
  assert.ok(V(0, 0, -1).applyQuaternion(back).distanceTo(V(1, 0, 0)) < 1e-4);
  assert.ok(V(0, 0, 1).applyQuaternion(forward).distanceTo(V(1, 0, 0)) < 1e-4);
});

section("closest point");

await check("a point beside the path projects onto it, in arc-length terms", () => {
  const spline = new Spline([knot(0, 0, 0), knot(10, 0, 0), knot(20, 0, 0)], { type: "linear" });
  const hit = spline.closestPoint(V(7, 4, 0));
  assert.ok(near(hit.distance, 7, 0.05), `${hit.distance}`);
  assert.ok(near(hit.t, 7 / 20, 0.01), `${hit.t}`);
  assert.ok(hit.point.distanceTo(V(7, 0, 0)) < 0.05, `${hit.point.toArray()}`);
});

await check("a point past the end clamps to the end rather than extrapolating", () => {
  const spline = new Spline([knot(0, 0, 0), knot(10, 0, 0)], { type: "linear" });
  const hit = spline.closestPoint(V(50, 0, 0));
  assert.ok(near(hit.distance, 10, 1e-3), `${hit.distance}`);
});

section("advancing along a path");

await check("loop wraps and keeps going", () => {
  const r = advanceAlong(9, 3, 10, "loop", 1);
  assert.ok(near(r.distance, 2), `${r.distance}`);
  assert.equal(r.direction, 1);
});

await check("ping-pong reflects and flips direction", () => {
  const r = advanceAlong(9, 3, 10, "pingPong", 1);
  assert.ok(near(r.distance, 8), `${r.distance}`);
  assert.equal(r.direction, -1);
});

await check("ping-pong survives a delta LONGER than the path (a hitch, or timeScale 20)", () => {
  const r = advanceAlong(0, 45, 10, "pingPong", 1);
  assert.ok(r.distance >= 0 && r.distance <= 10, `${r.distance}`);
  assert.ok(near(r.distance, 5), `${r.distance}`);
  assert.ok(Number.isFinite(r.distance));
});

await check("once/clamp reports finished exactly at the end", () => {
  assert.equal(advanceAlong(5, 1, 10, "once", 1).finished, false);
  const done = advanceAlong(9.5, 1, 10, "once", 1);
  assert.equal(done.finished, true);
  assert.ok(near(done.distance, 10));
});

await check("a zero-length path can't hang the loop", () => {
  const r = advanceAlong(0, 5, 0, "loop", 1);
  assert.equal(r.finished, true);
  assert.ok(Number.isFinite(r.distance));
});

section("SplineComponent");

const splineEngine = (props = {}, knots) => {
  const engine = new Engine();
  const entity = engine.createEntity({ name: "Path" });
  const component = entity.addComponent("spline", {
    knots: knots ?? [knot(0, 0, 0), knot(10, 0, 0)],
    type: "linear",
    ...props,
  });
  engine.scene.updateMatrixWorld(true);
  return { engine, entity, component };
};

await check("length and sampling come straight off the component", () => {
  const { component } = splineEngine();
  assert.ok(near(component.length, 10, 1e-3), `${component.length}`);
  assert.ok(component.pointAt(5, V()).distanceTo(V(5, 0, 0)) < 1e-3);
});

await check("knots are LOCAL — moving and rotating the path entity moves the whole path", () => {
  const { entity, component } = splineEngine();
  entity.object3D.position.set(0, 3, 0);
  entity.object3D.rotation.set(0, Math.PI / 2, 0);
  entity.object3D.updateMatrixWorld(true);
  const world = component.worldPointAt(10, V());
  // +X rotated 90° about Y lands on -Z, then lifted by 3.
  assert.ok(world.distanceTo(V(0, 3, -10)) < 1e-3, `${world.toArray()}`);
});

await check("a world frame's DIRECTIONS are rotated, not translated", () => {
  const { entity, component } = splineEngine();
  entity.object3D.position.set(100, 0, 0);
  entity.object3D.updateMatrixWorld(true);
  const frame = component.worldFrameAt(5, new SplineFrame());
  // Running the tangent through the full matrix (the classic slip) would give
  // something ~100 long pointing back at the origin.
  assert.ok(near(frame.tangent.length(), 1, 1e-4), `${frame.tangent.length()}`);
  assert.ok(frame.tangent.distanceTo(V(1, 0, 0)) < 1e-4, `${frame.tangent.toArray()}`);
  assert.ok(frame.position.distanceTo(V(105, 0, 0)) < 1e-3, `${frame.position.toArray()}`);
});

await check("a scaled path really is longer in the world", () => {
  const { entity, component } = splineEngine();
  entity.object3D.scale.setScalar(3);
  entity.object3D.updateMatrixWorld(true);
  assert.ok(near(component.length, 10, 1e-3), "local length is unchanged by scale");
  assert.ok(near(component.worldLength, 30, 1e-2), `${component.worldLength}`);
});

await check("closestPoint takes a WORLD point and answers in path units", () => {
  const { entity, component } = splineEngine();
  entity.object3D.position.set(0, 0, 50);
  entity.object3D.updateMatrixWorld(true);
  const hit = component.closestPoint(V(4, 2, 50));
  assert.ok(near(hit.distance, 4, 0.05), `${hit.distance}`);
});

await check("adding, moving and removing knots rebuilds the curve and bumps the version", () => {
  const { component } = splineEngine();
  const before = component.version;
  component.addKnot([10, 0, 10]);
  assert.ok(component.version > before);
  assert.ok(near(component.length, 20, 1e-2), `${component.length}`);
  component.removeKnot(2);
  assert.ok(near(component.length, 10, 1e-2), `${component.length}`);
  component.setKnot(1, { position: [20, 0, 0] });
  assert.ok(near(component.length, 20, 1e-2), `${component.length}`);
});

await check("a bare [x,y,z] knot normalizes rather than producing NaN", () => {
  const spline = new Spline([[0, 0, 0], [5, 0, 0]], { type: "linear" });
  assert.ok(near(spline.length, 5, 1e-3), `${spline.length}`);
  const n = normalizeKnot([1, 2, 3]);
  assert.deepEqual(n.position, [1, 2, 3]);
  assert.equal(n.roll, 0);
});

const { DebugBuffer } = await import("../src/engine/debugDraw.js");

await check("the curve draws a gizmo without being selected — an invisible path is unfindable", () => {
  const { component } = splineEngine();
  const buffer = new DebugBuffer();
  buffer.begin();
  component.onDrawGizmos(buffer);
  assert.ok(buffer.count > 0, "alwaysDraw should have drawn the curve");
  const unselected = buffer.count;
  buffer.begin();
  component.onDrawGizmosSelected(buffer);
  assert.ok(buffer.count > unselected, "selection should add knots and frame ticks");
});

section("SplineFollower — patrol routes, carts, platforms");

const followerEngine = (followerProps = {}, splineProps = {}, knots) => {
  const engine = new Engine();
  const path = engine.createEntity({ name: "Path" });
  path.addComponent("spline", {
    knots: knots ?? [knot(0, 0, 0), knot(10, 0, 0)],
    type: "linear",
    ...splineProps,
  });
  const cart = engine.createEntity({ name: "Cart" });
  const follower = cart.addComponent("splineFollower", { path: path.id, ...followerProps });
  engine.scene.updateMatrixWorld(true);
  return { engine, path, cart, follower };
};

/** Runs `seconds` of game time at a fixed frame rate, exactly as the tick does. */
const run = (engine, seconds, hz = 60) => {
  const dt = 1 / hz;
  const steps = Math.round(seconds * hz);
  for (let i = 0; i < steps; i++) engine.paths.update(dt);
};

await check("a follower lands on its path the moment it is added", () => {
  const { cart } = followerEngine({ position: 4 });
  assert.ok(cart.object3D.position.distanceTo(V(4, 0, 0)) < 1e-3, `${cart.object3D.position.toArray()}`);
});

await check("speed is distance per second of GAME time", () => {
  const { engine, follower } = followerEngine({ speed: 2, wrap: "clamp" });
  engine.playing = true;
  run(engine, 1);
  assert.ok(near(follower.position, 2, 0.02), `${follower.position}`);
});

await check("the same route at 30Hz and 240Hz ends in the same place", () => {
  const slow = followerEngine({ speed: 3, wrap: "loop" });
  const fast = followerEngine({ speed: 3, wrap: "loop" });
  slow.engine.playing = true;
  fast.engine.playing = true;
  run(slow.engine, 4, 30);
  run(fast.engine, 4, 240);
  assert.ok(near(slow.follower.position, fast.follower.position, 0.01), `${slow.follower.position} vs ${fast.follower.position}`);
});

await check("a stopped editor doesn't advance the patrol", () => {
  const { engine, follower } = followerEngine({ speed: 5 });
  run(engine, 2);
  assert.equal(follower.position, 0);
});

await check("loop wraps round; once stops at the end and fires exactly one event", () => {
  const looped = followerEngine({ speed: 6, wrap: "loop" });
  looped.engine.playing = true;
  run(looped.engine, 2);
  assert.ok(near(looped.follower.position, 2, 0.05), `${looped.follower.position}`);

  const once = followerEngine({ speed: 6, wrap: "once" });
  let events = 0;
  once.engine.on("path-completed", () => events++);
  once.engine.playing = true;
  run(once.engine, 4);
  assert.ok(near(once.follower.position, 10, 1e-3), `${once.follower.position}`);
  assert.equal(events, 1, `fired ${events} times`);
  assert.equal(once.follower.finished, true);
});

await check("ping-pong turns round at both ends", () => {
  const { engine, follower } = followerEngine({ speed: 10, wrap: "pingPong" });
  engine.playing = true;
  run(engine, 1.5);
  // 15 units of travel on a 10 unit path: out (10) then back (5).
  assert.ok(near(follower.position, 5, 0.1), `${follower.position}`);
});

await check("heading alignment stays upright over a dip; frame alignment does not", () => {
  const dip = [knot(0, 0, 0), knot(5, -4, 0), knot(10, 0, 0)];
  const upright = followerEngine({ position: 2.5, align: "heading" }, {}, dip);
  const banked = followerEngine({ position: 2.5, align: "frame" }, {}, dip);
  const up = V(0, 1, 0);
  const uprightUp = up.clone().applyQuaternion(upright.cart.object3D.quaternion);
  const bankedUp = up.clone().applyQuaternion(banked.cart.object3D.quaternion);
  assert.ok(uprightUp.y > 0.999, `heading should keep the model level: ${uprightUp.toArray()}`);
  assert.ok(bankedUp.y < 0.99, `frame should follow the slope: ${bankedUp.toArray()}`);
});

await check("the forward axis choice really flips which way the model faces", () => {
  const back = followerEngine({ position: 5, align: "heading", forward: "-Z" });
  const front = followerEngine({ position: 5, align: "heading", forward: "+Z" });
  const backDir = V(0, 0, -1).applyQuaternion(back.cart.object3D.quaternion);
  const frontDir = V(0, 0, 1).applyQuaternion(front.cart.object3D.quaternion);
  assert.ok(backDir.distanceTo(V(1, 0, 0)) < 1e-3, `${backDir.toArray()}`);
  assert.ok(frontDir.distanceTo(V(1, 0, 0)) < 1e-3, `${frontDir.toArray()}`);
});

await check("the offset is in the PATH's frame, so a lane stays a lane round a corner", () => {
  const corner = [knot(0, 0, 0), knot(10, 0, 0), knot(10, 0, 10)];
  const { cart, follower } = followerEngine({ position: 0, offset: [0, 0, 0], align: "none" }, { type: "linear" }, corner);
  follower.props.offset = [2, 0, 0];
  follower.apply();
  const onFirstLeg = cart.object3D.position.clone();
  follower.props.position = 20;
  follower.apply();
  const onSecondLeg = cart.object3D.position.clone();
  // The binormal is the traveller's right: heading +X it is +Z, heading +Z it
  // is -X. A world-space offset would put both 2 units along the same axis.
  assert.ok(near(onFirstLeg.z, 2, 0.05), `${onFirstLeg.toArray()}`);
  assert.ok(near(onSecondLeg.x, 8, 0.05), `${onSecondLeg.toArray()}`);
});

await check("turning preview off gives the authored transform back", () => {
  const { cart, follower } = followerEngine({ position: 7 });
  assert.ok(cart.object3D.position.x > 6, "preview should have moved it onto the path");
  follower.setProp("preview", false);
  assert.ok(cart.object3D.position.distanceTo(V(0, 0, 0)) < 1e-6, `${cart.object3D.position.toArray()}`);
});

await check("removing the follower restores the authored transform too", () => {
  const { cart } = followerEngine({ position: 7 });
  cart.removeComponent("splineFollower");
  assert.ok(cart.object3D.position.distanceTo(V(0, 0, 0)) < 1e-6, `${cart.object3D.position.toArray()}`);
});

await check("an empty path reference means 'the spline on my own entity'", () => {
  const engine = new Engine();
  const entity = engine.createEntity({ name: "Both" });
  entity.addComponent("spline", { knots: [knot(0, 0, 0), knot(8, 0, 0)], type: "linear" });
  const follower = entity.addComponent("splineFollower", { position: 8, align: "none" });
  assert.ok(near(follower.pathLength, 8, 1e-3), `${follower.pathLength}`);
});

await check("a follower pointing at nothing is inert, not a crash", () => {
  const engine = new Engine();
  const cart = engine.createEntity({ name: "Cart" });
  const follower = cart.addComponent("splineFollower", { path: "nope", speed: 4 });
  engine.playing = true;
  run(engine, 1);
  assert.equal(follower.position, 0);
  assert.ok(cart.object3D.position.distanceTo(V(0, 0, 0)) < 1e-9);
});

await check("progress is a 0..1 readout a UI can bind to", () => {
  const { follower } = followerEngine({ position: 2.5 });
  assert.ok(near(follower.progress, 0.25, 1e-3), `${follower.progress}`);
});

await check("position is a plain prop — which is what makes a timeline able to key it", async () => {
  const { animatableProperties, valueTypeFor } = await import("../src/engine/timeline/propertyBinding.js");
  const keys = animatableProperties("splineFollower").map((p) => p.key);
  assert.ok(keys.includes("position"), keys.join(", "));
  assert.equal(valueTypeFor("splineFollower", "position"), "number");
  // And the camera rail's, for the same reason — a cutscene keys the shot.
  assert.equal(valueTypeFor("vcam", "dollyPosition"), "number");
});

section("camera rails (item 7 riding item 16)");

const dollyEngine = (vcamProps = {}, knots) => {
  const engine = new Engine();
  const track = engine.createEntity({ name: "Track" });
  track.addComponent("spline", {
    knots: knots ?? [knot(0, 0, 0), knot(20, 0, 0)],
    type: "linear",
  });
  const cam = engine.createEntity({ name: "Cam" });
  // Offset zeroed: the shared default (eye height) is applied in the TRACK's
  // frame for a dolly, which is correct but would muddy these position checks.
  const vcam = cam.addComponent("vcam", { body: "dolly", dollyPath: track.id, aim: "none", offset: [0, 0, 0], ...vcamProps });
  engine.scene.updateMatrixWorld(true);
  return { engine, track, cam, vcam };
};

await check("track position is NORMALISED — 0.5 is halfway along by length", () => {
  const { vcam } = dollyEngine({ dollyPosition: 0.5 });
  const pose = vcam.evaluate(0.016, { snap: true });
  assert.ok(pose.position.distanceTo(V(10, 0, 0)) < 1e-2, `${pose.position.toArray()}`);
});

await check("auto dolly slides the camera to the player's projection on the rail", () => {
  const { engine, vcam } = dollyEngine({ autoDolly: true });
  const player = engine.createEntity({ name: "Player" });
  player.object3D.position.set(14, 0, 6);
  engine.scene.updateMatrixWorld(true);
  vcam.setProp("follow", player.id);
  const pose = vcam.evaluate(0.016, { snap: true });
  assert.ok(near(pose.position.x, 14, 0.1), `${pose.position.toArray()}`);
  assert.ok(Math.abs(pose.position.z) < 0.1, "it must stay ON the rail, not chase the player off it");
});

await check("the pivot offset rides the track's frame, so a raised rail stays raised", () => {
  const { vcam } = dollyEngine({ dollyPosition: 0.25, offset: [0, 3, 0] });
  const pose = vcam.evaluate(0.016, { snap: true });
  assert.ok(pose.position.distanceTo(V(5, 3, 0)) < 1e-2, `${pose.position.toArray()}`);
});

await check("a dolly camera needs no follow target — a cutscene rail is complete on its own", () => {
  const { vcam } = dollyEngine({ dollyPosition: 1 });
  const pose = vcam.evaluate(0.016, { snap: true });
  assert.ok(pose.position.distanceTo(V(20, 0, 0)) < 1e-2, `${pose.position.toArray()}`);
});

await check("aim 'path' faces along the rail", () => {
  const { vcam } = dollyEngine({ dollyPosition: 0.5, aim: "path" });
  const pose = vcam.evaluate(0.016, { snap: true });
  const facing = V(0, 0, -1).applyQuaternion(pose.quaternion);
  assert.ok(facing.distanceTo(V(1, 0, 0)) < 1e-2, `${facing.toArray()}`);
});

await check("a half-wired dolly stays where the author put it instead of snapping to the origin", () => {
  const engine = new Engine();
  const cam = engine.createEntity({ name: "Cam" });
  cam.object3D.position.set(3, 4, 5);
  engine.scene.updateMatrixWorld(true);
  const vcam = cam.addComponent("vcam", { body: "dolly", dollyPath: "", aim: "none" });
  const pose = vcam.evaluate(0.016, { snap: true });
  assert.ok(pose.position.distanceTo(V(3, 4, 5)) < 1e-4, `${pose.position.toArray()}`);
});

section("swept geometry — roads, fences, pipes");

const flatRoad = new Spline([knot(0, 0, 0), knot(20, 0, 0)], { type: "linear" });

await check("a road ring count follows the density, and every ring has the profile's points", () => {
  const data = buildSplineGeometry(flatRoad, { profile: "road", width: 4, density: 1 });
  assert.equal(data.ringCount, 21);
  assert.equal(data.positions.length / 3, 21 * 2);
  assert.equal(data.indices.length, 20 * 6);
});

await check("a flat road's normals point UP", () => {
  const data = buildSplineGeometry(flatRoad, { profile: "road", width: 4, density: 1 });
  for (let i = 0; i < data.normals.length; i += 3) {
    assert.ok(data.normals[i + 1] > 0.999, `normal ${i / 3} was ${data.normals.slice(i, i + 3)}`);
  }
});

await check("the winding AGREES with the normals — the mirrored-impostor failure, one dimension down", () => {
  // A road whose triangles wind the other way is lit from below: perfectly
  // plausible geometry, invisible from the only side anyone looks at.
  const data = buildSplineGeometry(flatRoad, { profile: "road", width: 4, density: 1 });
  const a = V();
  const b = V();
  const c = V();
  const n = V();
  for (let i = 0; i < data.indices.length; i += 3) {
    a.fromArray(data.positions, data.indices[i] * 3);
    b.fromArray(data.positions, data.indices[i + 1] * 3);
    c.fromArray(data.positions, data.indices[i + 2] * 3);
    n.copy(b).sub(a).cross(V().copy(c).sub(a));
    if (n.lengthSq() < 1e-12) continue;
    assert.ok(n.normalize().y > 0.9, `triangle ${i / 3} faces ${n.toArray()}`);
  }
});

await check("V runs on ARC LENGTH, so the texture doesn't stretch on a long segment", () => {
  const uneven = new Spline([knot(0, 0, 0), knot(1, 0, 0), knot(31, 0, 0)], { type: "linear" });
  const data = buildSplineGeometry(uneven, { profile: "road", density: 1, uvScale: 0.5 });
  const vs = [];
  for (let i = 0; i < data.uvs.length; i += 2) vs.push(data.uvs[i + 1]);
  assert.ok(near(Math.max(...vs), uneven.length * 0.5, 1e-3), `${Math.max(...vs)}`);
  // Every ring is an equal step of distance, so every V step must be equal too.
  const step = vs[2] - vs[0];
  for (let r = 1; r < data.ringCount - 1; r++) {
    assert.ok(near(vs[r * 2] - vs[(r - 1) * 2], step, 1e-3), `ring ${r} stepped differently`);
  }
});

await check("U spans the profile, so a road texture maps across the width", () => {
  const data = buildSplineGeometry(flatRoad, { profile: "road", width: 6, density: 1 });
  const us = [];
  for (let i = 0; i < data.uvs.length; i += 2) us.push(data.uvs[i]);
  assert.ok(near(Math.min(...us), 0), `${Math.min(...us)}`);
  assert.ok(near(Math.max(...us), 1), `${Math.max(...us)}`);
});

await check("a tube is closed round its profile and caps add geometry only when asked", () => {
  const bare = buildSplineGeometry(flatRoad, { profile: "tube", radius: 0.5, sides: 8, density: 1, capEnds: false });
  const capped = buildSplineGeometry(flatRoad, { profile: "tube", radius: 0.5, sides: 8, density: 1, capEnds: true });
  // Closed profile: 8 columns, not 7.
  assert.equal(bare.indices.length, 20 * 8 * 6);
  assert.ok(capped.positions.length > bare.positions.length, "caps should add vertices");
  assert.equal(capped.indices.length, bare.indices.length + 2 * 8 * 3);
});

await check("a tube's normals point outward from its axis", () => {
  const data = buildSplineGeometry(flatRoad, { profile: "tube", radius: 0.5, sides: 12, density: 1, capEnds: false });
  const p = V();
  const n = V();
  for (let i = 0; i < data.positions.length; i += 3) {
    p.fromArray(data.positions, i);
    n.fromArray(data.normals, i);
    // The axis is the X line at y=z=0, so the outward direction is (0, y, z).
    const outward = V(0, p.y, p.z).normalize();
    assert.ok(n.dot(outward) > 0.9, `vertex ${i / 3} normal ${n.toArray()} vs outward ${outward.toArray()}`);
  }
});

await check("a banked road really banks — roll reaches the swept vertices", () => {
  const banked = new Spline([knot(0, 0, 0, { roll: 0 }), knot(20, 0, 0, { roll: 45 })], { type: "linear" });
  const data = buildSplineGeometry(banked, { profile: "road", width: 4, density: 1 });
  const last = data.ringCount - 1;
  const left = V().fromArray(data.positions, (last * 2) * 3);
  const right = V().fromArray(data.positions, (last * 2 + 1) * 3);
  assert.ok(Math.abs(left.y - right.y) > 2.5, `the far ring should be tilted: ${left.toArray()} ${right.toArray()}`);
});

await check("the optional matrix moves the sweep into another entity's space", () => {
  const matrix = new THREE.Matrix4().makeTranslation(0, 5, 0);
  const data = buildSplineGeometry(flatRoad, { profile: "road", density: 1, matrix });
  for (let i = 0; i < data.positions.length; i += 3) {
    assert.ok(near(data.positions[i + 1], 5, 1e-4), `${data.positions[i + 1]}`);
    assert.ok(near(data.normals[i + 1], 1, 1e-4), "a translation must not rotate the normals");
  }
});

await check("an invalid path sweeps nothing rather than throwing", () => {
  const data = buildSplineGeometry(new Spline([knot(0, 0, 0)]), { profile: "road" });
  assert.equal(data.positions.length, 0);
  assert.equal(data.indices.length, 0);
});

await check("every built-in profile produces a manifold-ish, finite mesh", () => {
  for (const profile of ["road", "wall", "tube", "box"]) {
    const data = buildSplineGeometry(flatRoad, { profile, density: 1, capEnds: true });
    assert.ok(data.positions.length > 0, `${profile} produced nothing`);
    for (const v of data.positions) assert.ok(Number.isFinite(v), `${profile} produced NaN`);
    for (const v of data.normals) assert.ok(Number.isFinite(v), `${profile} produced a NaN normal`);
    const max = data.positions.length / 3;
    for (const i of data.indices) assert.ok(i < max, `${profile} indexed past its vertices`);
  }
});

await check("buildProfile('road') is ordered so the sweep faces up (reversing it is the classic bug)", () => {
  const road = buildProfile("road", { width: 4 });
  assert.ok(road.points[0].x > road.points[1].x, "road profile must run +x → -x");
  assert.equal(road.closed, false);
  assert.equal(buildProfile("tube", { sides: 6 }).points.length, 6);
  assert.equal(buildProfile("tube").closed, true);
});

section("SplineMesh component");

const meshEngine = (props = {}) => {
  const engine = new Engine();
  const road = engine.createEntity({ name: "Road" });
  road.addComponent("spline", { knots: [knot(0, 0, 0), knot(30, 0, 0)], type: "linear" });
  const component = road.addComponent("splineMesh", { profile: "road", width: 6, density: 1, ...props });
  engine.scene.updateMatrixWorld(true);
  return { engine, road, component };
};

await check("the mesh sweeps its own entity's spline with no wiring", () => {
  const { component } = meshEngine();
  assert.ok(component.triangleCount > 0, `${component.triangleCount}`);
  assert.equal(component.triangleCount, 30 * 2);
});

await check("editing a knot rebuilds the road", () => {
  const { road, component } = meshEngine();
  const before = component.triangleCount;
  road.getComponent("spline").addKnot([30, 0, 30]);
  component.rebuild();
  assert.ok(component.triangleCount > before, `${component.triangleCount} vs ${before}`);
});

await check("a rebuild is coalesced — a hundred knot drags queue ONE re-sweep", () => {
  const { component } = meshEngine();
  let queued = 0;
  const engine = component.entity.engine;
  const original = engine.onPreRender.bind(engine);
  engine.onPreRender = (fn) => {
    queued++;
    return original(fn);
  };
  for (let i = 0; i < 100; i++) component.invalidate();
  assert.equal(queued, 1, `queued ${queued} rebuilds`);
});

await check("a spline mesh can sweep ANOTHER entity's path, in its own space", () => {
  const engine = new Engine();
  const path = engine.createEntity({ name: "Path" });
  path.object3D.position.set(0, 10, 0);
  path.addComponent("spline", { knots: [knot(0, 0, 0), knot(10, 0, 0)], type: "linear" });
  const kerb = engine.createEntity({ name: "Kerb" });
  engine.scene.updateMatrixWorld(true);
  const component = kerb.addComponent("splineMesh", { path: path.id, profile: "road", density: 1 });
  const y = component.geometry.getAttribute("position").getY(0);
  // The kerb sits at the origin, the path 10 above it: the swept vertices must
  // land at +10 in the kerb's local space, not at 0.
  assert.ok(near(y, 10, 1e-3), `${y}`);
});

await check("a spline mesh with no path draws nothing instead of a stray triangle", () => {
  const engine = new Engine();
  const entity = engine.createEntity({ name: "Orphan" });
  const component = entity.addComponent("splineMesh", { path: "missing" });
  assert.equal(component.triangleCount, 0);
  assert.equal(component.mesh.visible, false);
});

section("Instancer along a path — fences, sleepers, bollards");

const instancerEngine = (props = {}, knots, onSameEntity = false) => {
  const engine = new Engine();
  const path = engine.createEntity({ name: "Path" });
  path.addComponent("spline", {
    knots: knots ?? [knot(0, 0, 0), knot(20, 0, 0)],
    type: "linear",
  });
  const host = onSameEntity ? path : engine.createEntity({ name: "Fence" });
  host.addComponent("mesh", { geometry: "box" });
  engine.scene.updateMatrixWorld(true);
  const component = host.addComponent("instancer", {
    mode: "path",
    pathEntity: onSameEntity ? "" : path.id,
    count: 5,
    ...props,
  });
  return { engine, path, host, component };
};

/** Instance positions, in the space the InstancedMesh is actually parented to. */
const instancePositions = (component) => {
  const mesh = component.instancedMesh;
  const out = [];
  const m = new THREE.Matrix4();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    out.push(new THREE.Vector3().setFromMatrixPosition(m));
  }
  return out;
};

await check("count distribution spreads copies evenly, endpoints included", () => {
  const { component } = instancerEngine({ count: 5, pathAlign: "none" });
  const positions = instancePositions(component);
  assert.equal(positions.length, 5);
  assert.ok(positions[0].distanceTo(V(0, 0, 0)) < 1e-3, `${positions[0].toArray()}`);
  assert.ok(positions[4].distanceTo(V(20, 0, 0)) < 1e-3, `${positions[4].toArray()}`);
  assert.ok(near(positions[1].x, 5, 1e-3), `${positions[1].x}`);
});

await check("the spacing is ARC LENGTH, so an uneven path still places them evenly", () => {
  // One 1-unit segment then a 30-unit one: parameter spacing would pile four of
  // the five copies into the first metre.
  const { component } = instancerEngine(
    { count: 5, pathAlign: "none" },
    [knot(0, 0, 0), knot(1, 0, 0), knot(31, 0, 0)],
  );
  const positions = instancePositions(component);
  const gaps = [];
  for (let i = 1; i < positions.length; i++) gaps.push(positions[i].distanceTo(positions[i - 1]));
  assert.ok(Math.max(...gaps) / Math.min(...gaps) < 1.02, `gaps ${gaps.map((g) => g.toFixed(2))}`);
});

await check("spacing distribution follows the LENGTH — a longer fence gets more posts", () => {
  const short = instancerEngine({ pathDistribution: "spacing", pathSpacing: 2, count: 100, pathAlign: "none" });
  assert.equal(short.component.instancedMesh.count, 11); // 0, 2, … 20
  const long = instancerEngine(
    { pathDistribution: "spacing", pathSpacing: 2, count: 100, pathAlign: "none" },
    [knot(0, 0, 0), knot(40, 0, 0)],
  );
  assert.equal(long.component.instancedMesh.count, 21);
  // …and the posts already placed did not move, which is the whole reason this
  // mode exists alongside `count`.
  const a = instancePositions(short.component)[3];
  const b = instancePositions(long.component)[3];
  assert.ok(a.distanceTo(b) < 1e-6, `${a.toArray()} vs ${b.toArray()}`);
});

await check("spacing never runs past the allocated buffer", () => {
  const { component } = instancerEngine({ pathDistribution: "spacing", pathSpacing: 0.1, count: 8, pathAlign: "none" });
  assert.equal(component.instancedMesh.count, 8);
});

await check("a closed path doesn't stack its last copy on its first", () => {
  const square = [knot(0, 0, 0), knot(10, 0, 0), knot(10, 0, 10), knot(0, 0, 10)];
  const engine = new Engine();
  const path = engine.createEntity({ name: "Ring" });
  path.addComponent("spline", { knots: square, type: "linear", closed: true });
  const host = engine.createEntity({ name: "Posts" });
  host.addComponent("mesh", { geometry: "box" });
  engine.scene.updateMatrixWorld(true);
  const component = host.addComponent("instancer", { mode: "path", pathEntity: path.id, count: 4, pathAlign: "none" });
  const positions = instancePositions(component);
  assert.equal(positions.length, 4);
  assert.ok(positions[0].distanceTo(positions[3]) > 5, `first and last landed together: ${positions[3].toArray()}`);
});

await check("tangent alignment turns the copies to follow a corner, and keeps them upright", () => {
  const corner = [knot(0, 0, 0), knot(10, 0, 0), knot(10, 0, 10)];
  const { component } = instancerEngine({ count: 3, pathAlign: "tangent", pathForward: "-Z" }, corner);
  const mesh = component.instancedMesh;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const facings = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    q.setFromRotationMatrix(m);
    facings.push(V(0, 0, -1).applyQuaternion(q));
    // Upright: a fence post must not lean, whatever the path does.
    assert.ok(V(0, 1, 0).applyQuaternion(q).y > 0.999, `copy ${i} leaned`);
  }
  assert.ok(facings[0].distanceTo(V(1, 0, 0)) < 0.2, `${facings[0].toArray()}`);
  assert.ok(facings[2].distanceTo(V(0, 0, 1)) < 0.2, `${facings[2].toArray()}`);
});

await check("frame alignment leans with a banked path, unlike tangent", () => {
  const banked = [knot(0, 0, 0, { roll: 30 }), knot(20, 0, 0, { roll: 30 })];
  const upright = instancerEngine({ count: 2, pathAlign: "tangent" }, banked);
  const leaning = instancerEngine({ count: 2, pathAlign: "frame" }, banked);
  const readUp = (component) => {
    const m = new THREE.Matrix4();
    component.instancedMesh.getMatrixAt(0, m);
    return V(0, 1, 0).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(m));
  };
  assert.ok(readUp(upright.component).y > 0.999);
  assert.ok(near(readUp(leaning.component).y, Math.cos(Math.PI / 6), 0.02), `${readUp(leaning.component).toArray()}`);
});

await check("the offset is in the path's frame, so a kerb line hugs a corner", () => {
  const corner = [knot(0, 0, 0), knot(10, 0, 0), knot(10, 0, 10)];
  const { component } = instancerEngine({ count: 3, pathAlign: "none", pathOffset: [2, 1, 0] }, corner);
  const positions = instancePositions(component);
  // Binormal is the traveller's right: +Z on the first leg, -X on the second.
  assert.ok(near(positions[0].z, 2, 0.05) && near(positions[0].y, 1, 0.05), `${positions[0].toArray()}`);
  assert.ok(near(positions[2].x, 8, 0.05), `${positions[2].toArray()}`);
});

await check("offset jitter is seeded — the same seed lays the same scatter twice", () => {
  const a = instancerEngine({ count: 6, pathAlign: "none", pathJitter: [2, 0, 0], seed: 7 });
  const b = instancerEngine({ count: 6, pathAlign: "none", pathJitter: [2, 0, 0], seed: 7 });
  const c = instancerEngine({ count: 6, pathAlign: "none", pathJitter: [2, 0, 0], seed: 8 });
  const pa = instancePositions(a.component);
  const pb = instancePositions(b.component);
  const pc = instancePositions(c.component);
  assert.ok(pa.every((p, i) => p.distanceTo(pb[i]) < 1e-9), "same seed must reproduce");
  assert.ok(pa.some((p, i) => p.distanceTo(pc[i]) > 1e-3), "a different seed must differ");
  assert.ok(pa.some((p) => Math.abs(p.z) > 0.01), "jitter should actually move something");
});

await check("an empty path reference uses the spline on the instancer's own entity", () => {
  const { component } = instancerEngine({ count: 3, pathAlign: "none" }, undefined, true);
  assert.equal(component.instancedMesh.count, 3);
  assert.ok(instancePositions(component)[2].distanceTo(V(20, 0, 0)) < 1e-3);
});

await check("a foreign path's transform moves the instances, not the instancer's", () => {
  const { path, component } = instancerEngine({ count: 2, pathAlign: "none" });
  path.object3D.position.set(0, 5, 0);
  path.object3D.updateMatrixWorld(true);
  component.onPropChanged("count");
  const positions = instancePositions(component);
  assert.ok(near(positions[0].y, 5, 1e-3), `${positions[0].toArray()}`);
});

await check("editing a knot re-lays the instances — on the next frame, and without rebuilding the buffer", () => {
  const { engine, path, component } = instancerEngine({ count: 3, pathAlign: "none" });
  const before = component.instancedMesh;
  assert.ok(instancePositions(component)[2].distanceTo(V(20, 0, 0)) < 1e-3);
  path.getComponent("spline").setKnot(1, { position: [40, 0, 0] });
  // Coalesced to the next frame, like the spline mesh: dragging a knot must not
  // re-lay a thousand fence posts once per pointer event.
  assert.ok(instancePositions(component)[2].distanceTo(V(20, 0, 0)) < 1e-3, "it should not have re-laid yet");
  for (const fn of [...engine.preRenderCallbacks]) fn();
  assert.ok(instancePositions(component)[2].distanceTo(V(40, 0, 0)) < 1e-3, `${instancePositions(component)[2].toArray()}`);
  assert.equal(component.instancedMesh, before, "the InstancedMesh must be reused, not re-allocated");
});

await check("a hundred knot drags queue ONE re-lay", () => {
  const { engine, path, component } = instancerEngine({ count: 3, pathAlign: "none" });
  let queued = 0;
  const original = engine.onPreRender.bind(engine);
  engine.onPreRender = (fn) => {
    queued++;
    return original(fn);
  };
  const spline = path.getComponent("spline");
  for (let i = 0; i < 100; i++) spline.setKnot(1, { position: [10 + i * 0.1, 0, 0] });
  assert.equal(queued, 1, `queued ${queued} re-lays`);
});

await check("a path-mode instancer with no path draws nothing rather than piling up on the origin", () => {
  const engine = new Engine();
  const host = engine.createEntity({ name: "Fence" });
  host.addComponent("mesh", { geometry: "box" });
  const component = host.addComponent("instancer", { mode: "path", pathEntity: "missing", count: 5 });
  assert.equal(component.instancedMesh.count, 0);
});

// ---------------------------------------------------------------------------

console.log(failures ? `\n${failures} check(s) failed` : "\nAll spline checks passed");
process.exit(failures ? 1 : 0);
