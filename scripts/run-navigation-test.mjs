/**
 * Navigation (roadmap item 8): navmesh baking, path queries, agents and
 * off-mesh links.
 *
 * Recast's wasm runs headlessly in Node, so this drives the REAL recast — no
 * stubs. What it checks is the layer above it: that geometry collection finds
 * what it should and skips what it shouldn't, that the bake settings people
 * actually type (metres, degrees) reach recast as the voxel counts it wants,
 * that a path around a wall really goes around it, and that an off-mesh link
 * turns an impossible route into a possible one.
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
const { Engine, registerBuiltInComponents, applyEngineModules } = await import("../src/engine/index.js");
await import("../src/modules/index.js"); // registers the module catalog

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
const near = (actual, expected, tol, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: expected ~${expected}, got ${actual} (tolerance ${tol})`,
  );
const section = (title) => console.log(`\n${title}`);

/** An engine with navigation enabled and its wasm up. */
async function navScene(build = () => {}) {
  const engine = new Engine();
  await applyEngineModules(engine, ["navigation"]);
  await engine.modules.get("navigation")?.ready;
  build(engine);
  return { engine, nav: engine.navigation };
}

/** An axis-aligned box of walkable floor, as a real mesh entity. */
function floor(engine, { name = "Floor", size = [20, 0.4, 20], position = [0, -0.2, 0], tags = [] } = {}) {
  const entity = engine.createEntity({ name });
  entity.object3D.position.fromArray(position);
  if (tags.length) entity.tags = tags;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial());
  entity.object3D.add(mesh);
  entity.object3D.updateMatrixWorld(true);
  return entity;
}

const tick = (engine, dt) => {
  engine.cameraImpulse.update(dt);
  engine.debug.tick(dt);
  for (const fn of engine.updateCallbacks) fn(dt);
  for (const entry of [...engine.lateUpdateCallbacks]) entry.fn(dt);
};

// ---------------------------------------------------------------------------

section("module");

await check("the module installs a navigation system", async () => {
  const { engine, nav } = await navScene();
  assert.ok(nav, "engine.navigation exists");
  assert.equal(nav.isReady, false, "with no navmesh until something bakes one");
  assert.ok(engine.modules.get("navigation")?.system, "and the handle is live, not the placeholder");
});

// ---------------------------------------------------------------------------

section("geometry collection");

await check("meshes in the scene are collected in world space", async () => {
  const { nav } = await navScene((engine) => floor(engine, { position: [10, 0, 0] }));
  const { positions, indices, meshCount } = nav.collectGeometry();
  assert.equal(meshCount, 1);
  assert.ok(indices.length >= 36, `a box is 12 triangles, got ${indices.length / 3}`);
  // World space, not local: the floor was moved to x=10 and the vertices must
  // have moved with it, or everything bakes around the origin.
  let minX = Infinity;
  for (let i = 0; i < positions.length; i += 3) minX = Math.min(minX, positions[i]);
  near(minX, 0, 1e-4, "left edge of a 20-wide floor centred at x=10");
});

await check("entities tagged nav-ignore are skipped", async () => {
  const { nav } = await navScene((engine) => {
    floor(engine);
    floor(engine, { name: "Prop", size: [2, 2, 2], position: [0, 1, 0], tags: ["nav-ignore"] });
  });
  assert.equal(nav.collectGeometry().meshCount, 1, "the prop was excluded");
});

await check("an include tag flips it to opt-in", async () => {
  const { nav } = await navScene((engine) => {
    floor(engine, { name: "Walkable", tags: ["walkable"] });
    floor(engine, { name: "Decor", position: [0, 5, 0] });
  });
  assert.equal(nav.collectGeometry({ tag: "walkable" }).meshCount, 1);
  assert.equal(nav.collectGeometry().meshCount, 2, "and without the tag, everything is in");
});

await check("bounds filtering keeps whole triangles, never dangling indices", async () => {
  const { nav } = await navScene((engine) => {
    floor(engine, { name: "A", position: [0, -0.2, 0] });
    floor(engine, { name: "B", position: [100, -0.2, 0] });
  });
  const { positions, indices } = nav.collectGeometry({
    bounds: { center: new THREE.Vector3(0, 0, 0), size: new THREE.Vector3(40, 20, 40) },
  });
  assert.equal(indices.length % 3, 0, "still whole triangles");
  const vertexCount = positions.length / 3;
  for (const index of indices) {
    assert.ok(index >= 0 && index < vertexCount, `index ${index} outside 0..${vertexCount}`);
  }
  let maxX = -Infinity;
  for (let i = 0; i < positions.length; i += 3) maxX = Math.max(maxX, positions[i]);
  assert.ok(maxX < 50, `the far floor was excluded (max x ${maxX})`);
});

// ---------------------------------------------------------------------------

section("baking");

await check("baking an empty scene fails with an explanation, not a crash", async () => {
  const { nav } = await navScene();
  const result = nav.bake();
  assert.equal(result.success, false);
  assert.ok(/no walkable geometry/i.test(result.error), result.error);
});

await check("a flat floor bakes into a walkable navmesh", async () => {
  const { nav } = await navScene((engine) => floor(engine));
  const result = nav.bake({ agentRadius: 0.4, agentHeight: 1.8 });
  assert.ok(result.success, result.error);
  assert.ok(nav.isReady, "the navmesh is installed");
  assert.ok(result.stats.triangles > 0, "it reports what it consumed");
  const point = nav.sample(new THREE.Vector3(0, 1, 0));
  assert.ok(point, "the centre of the floor samples onto the mesh");
  near(point.y, 0, 0.5, "at floor height");
});

await check("the navmesh is inset by the agent radius", async () => {
  // The property that makes agent radius mean anything: a point right at the
  // floor's edge must NOT be walkable for an agent that wide. Asked through
  // `isOnNavMesh`, not `sample` — `sample` finds the nearest walkable spot and
  // would happily answer with one 1.5m away.
  const { nav } = await navScene((engine) => floor(engine, { size: [20, 0.4, 20] }));
  assert.ok(nav.bake({ agentRadius: 1.5 }).success);
  assert.ok(nav.isOnNavMesh(new THREE.Vector3(0, 0, 0)), "the middle is walkable");
  assert.ok(!nav.isOnNavMesh(new THREE.Vector3(9.9, 0, 0)), "the very edge is not");
  assert.ok(nav.sample(new THREE.Vector3(9.9, 0, 0)), "though the nearest walkable spot is still findable");
});

await check("a taller agent loses headroom it doesn't fit under", async () => {
  const { nav } = await navScene((engine) => {
    floor(engine);
    // A low ceiling over one half of the floor, 1m of clearance beneath it.
    floor(engine, { name: "Ceiling", size: [20, 0.4, 8], position: [0, 1.2, -6] });
  });
  const under = new THREE.Vector3(0, 0.1, -6);
  assert.ok(nav.bake({ agentHeight: 0.8 }).success);
  const shortAgent = nav.sample(under);
  assert.ok(shortAgent && shortAgent.y < 0.7, `a short agent fits underneath (found y=${shortAgent?.y})`);

  assert.ok(nav.bake({ agentHeight: 2.5 }).success);
  const tallAgent = nav.sample(under);
  // The floor under the ceiling is gone. What's left nearby is the ceiling's
  // own top face — which is walkable, and a metre and a half up.
  assert.ok(
    !tallAgent || tallAgent.y > 1,
    `a tall one does not (found y=${tallAgent?.y})`,
  );
});

await check("a baked navmesh round-trips through bytes", async () => {
  const { nav } = await navScene((engine) => floor(engine));
  assert.ok(nav.bake().success);
  const bytes = nav.toBytes();
  assert.ok(bytes?.length > 0, "exported something");

  const second = await navScene();
  assert.equal(second.nav.isReady, false);
  assert.ok(second.nav.fromBytes(bytes), "imported");
  assert.ok(second.nav.isReady);
  assert.ok(second.nav.sample(new THREE.Vector3(0, 0, 0)), "and it can be queried");
});

// ---------------------------------------------------------------------------

section("queries");

/** A U-shaped level: two arms with a wall between them. */
async function wallScene() {
  return navScene((engine) => {
    floor(engine, { name: "Floor", size: [20, 0.4, 20], position: [0, -0.2, 0] });
    floor(engine, { name: "Wall", size: [1, 4, 14], position: [0, 2, -3] });
  });
}

await check("a path around a wall actually goes around it", async () => {
  const { nav } = await wallScene();
  assert.ok(nav.bake({ agentRadius: 0.4 }).success);
  const from = new THREE.Vector3(-6, 0, -6);
  const to = new THREE.Vector3(6, 0, -6);
  const path = nav.findPath(from, to);
  assert.ok(path.length >= 2, `got ${path.length} corners`);
  const straight = from.distanceTo(to);
  let length = 0;
  for (let i = 1; i < path.length; i++) length += path[i].distanceTo(path[i - 1]);
  assert.ok(length > straight * 1.3, `detours around the wall (${length} vs ${straight} straight)`);
  // And every corner must be clear of the wall, or it isn't a route.
  for (const corner of path) {
    assert.ok(Math.abs(corner.x) > 0.4 || corner.z > 3.5, `corner ${corner.toArray()} is inside the wall`);
  }
});

await check("an unreachable destination returns an empty path, not a wrong one", async () => {
  const { nav } = await navScene((engine) => {
    floor(engine, { name: "Island A", size: [6, 0.4, 6], position: [0, -0.2, 0] });
    floor(engine, { name: "Island B", size: [6, 0.4, 6], position: [40, -0.2, 0] });
  });
  assert.ok(nav.bake().success);
  const path = nav.findPath(new THREE.Vector3(0, 0, 0), new THREE.Vector3(40, 0, 0));
  // Detour returns a partial path to the nearest reachable point; what matters
  // is that it never claims to arrive.
  const end = path[path.length - 1];
  if (path.length) assert.ok(end.distanceTo(new THREE.Vector3(40, 0, 0)) > 5, "doesn't pretend to arrive");
});

await check("sample() reports whether a point is on the navmesh", async () => {
  const { nav } = await navScene((engine) => floor(engine, { size: [10, 0.4, 10] }));
  assert.ok(nav.bake().success);
  assert.ok(nav.isOnNavMesh(new THREE.Vector3(0, 0.2, 0)), "just above the floor");
  assert.ok(!nav.isOnNavMesh(new THREE.Vector3(500, 0, 500)), "far off the map");
});

await check("randomPoint stays on the navmesh and inside the radius", async () => {
  const { nav } = await navScene((engine) => floor(engine, { size: [30, 0.4, 30] }));
  assert.ok(nav.bake().success);
  // Detour's sampler walks polygons rather than sampling a disc, so it happily
  // returns points beyond the radius; `randomPoint` rejects and retries so the
  // caller gets the contract they asked for.
  const centre = new THREE.Vector3(0, 0, 0);
  for (let i = 0; i < 20; i++) {
    const point = nav.randomPoint(centre, 5);
    assert.ok(point, "found one");
    const distance = Math.hypot(point.x - centre.x, point.z - centre.z);
    assert.ok(distance <= 5.01, `within the radius, got ${distance}`);
    assert.ok(nav.isOnNavMesh(point), "and walkable");
  }
});

await check("queries on an unbaked system return empty instead of throwing", async () => {
  const { nav } = await navScene();
  assert.deepEqual(nav.findPath([0, 0, 0], [1, 0, 1]), []);
  assert.equal(nav.sample([0, 0, 0]), null);
  assert.equal(nav.randomPoint([0, 0, 0], 5), null);
  assert.equal(nav.isOnNavMesh([0, 0, 0]), false);
});

// ---------------------------------------------------------------------------

section("off-mesh links");

await check("a link connects two islands the agent could not otherwise reach", async () => {
  const gap = 6;
  const build = (engine) => {
    floor(engine, { name: "A", size: [8, 0.4, 8], position: [-gap, -0.2, 0] });
    floor(engine, { name: "B", size: [8, 0.4, 8], position: [gap, -0.2, 0] });
  };
  const from = new THREE.Vector3(-gap, 0, 0);
  const to = new THREE.Vector3(gap, 0, 0);

  const without = await navScene(build);
  assert.ok(without.nav.bake().success);
  const unlinked = without.nav.findPath(from, to);
  const unlinkedEnd = unlinked.length ? unlinked[unlinked.length - 1] : from;
  assert.ok(unlinkedEnd.distanceTo(to) > 2, "no route across the gap to begin with");

  const withLink = await navScene((engine) => {
    build(engine);
    const jump = engine.createEntity({ name: "Jump" });
    jump.object3D.position.set(-gap + 3.5, 0, 0);
    jump.object3D.updateMatrixWorld(true);
    jump.addComponent("navlink", { end: [7, 0, 0], radius: 1, bidirectional: true, showGizmo: false });
  });
  const result = withLink.nav.bake();
  assert.ok(result.success, result.error);
  assert.equal(result.stats.links, 1, "the link reached recast");
  const linked = withLink.nav.findPath(from, to);
  assert.ok(linked.length >= 2, "a path exists now");
  const end = linked[linked.length - 1];
  assert.ok(end.distanceTo(to) < 2, `and it arrives (ended ${end.distanceTo(to)} away)`);
});

await check("a disabled link is left out of the bake", async () => {
  const { engine, nav } = await navScene((e) => {
    floor(e, { name: "A", size: [8, 0.4, 8], position: [-6, -0.2, 0] });
    floor(e, { name: "B", size: [8, 0.4, 8], position: [6, -0.2, 0] });
  });
  const jump = engine.createEntity({ name: "Jump" });
  jump.object3D.position.set(-2.5, 0, 0);
  jump.object3D.updateMatrixWorld(true);
  const link = jump.addComponent("navlink", { end: [7, 0, 0], radius: 1, showGizmo: false });
  assert.equal(nav.bake().stats.links, 1);
  link.setEnabled(false);
  assert.equal(nav.bake().stats.links, 0);
});

await check("a link's end offset is local, so a rotated prefab links the right way", async () => {
  const { engine } = await navScene((e) => floor(e));
  const ladder = engine.createEntity({ name: "Ladder" });
  ladder.object3D.rotation.y = Math.PI / 2;
  ladder.object3D.updateMatrixWorld(true);
  const link = ladder.addComponent("navlink", { end: [0, 0, 4], showGizmo: false });
  const { end } = link.endpoints();
  near(end.x, 4, 1e-4, "the offset rotated with the entity");
  near(end.z, 0, 1e-4, "instead of staying on world +Z");
});

// ---------------------------------------------------------------------------

section("agents");

await check("an agent joins the crowd and is snapped onto the navmesh", async () => {
  const { engine, nav } = await navScene((e) => floor(e));
  const meshEntity = engine.createEntity({ name: "NavMesh" });
  meshEntity.addComponent("navmesh", { showOverlay: false });
  assert.ok(nav.bake().success);

  const enemy = engine.createEntity({ name: "Enemy" });
  // Dropped a little above the floor, which is where anything placed in a
  // scene ends up — and which is OFF the navmesh as far as recast is concerned.
  enemy.object3D.position.set(2, 1.5, 2);
  const agent = enemy.addComponent("navagent", { radius: 0.4, speed: 3 });
  engine.playing = true;
  agent.rejoinCrowd();
  assert.ok(agent.agent, "joined");
  const position = agent.agent.position();
  near(position.y, 0, 0.6, "snapped down onto the floor rather than left hovering");
});

await check("an agent walks to its destination and stops there", async () => {
  const { engine, nav } = await navScene((e) => floor(e, { size: [30, 0.4, 30] }));
  assert.ok(nav.bake().success);
  const enemy = engine.createEntity({ name: "Enemy" });
  enemy.object3D.position.set(-8, 0, 0);
  const agent = enemy.addComponent("navagent", { radius: 0.4, speed: 4, stoppingDistance: 0.5 });
  engine.playing = true;
  agent.rejoinCrowd();

  assert.ok(agent.setDestination(new THREE.Vector3(8, 0, 0)), "accepted the destination");
  for (let i = 0; i < 60 * 12; i++) {
    tick(engine, 1 / 60);
    if (agent.isAtDestination) break;
  }
  assert.ok(agent.isAtDestination, `arrived (${agent.remainingDistance.toFixed(2)}m left)`);
  near(enemy.object3D.position.x, 8, 1.0, "at the destination");
});

await check("setDestination snaps to walkable ground and refuses the impossible", async () => {
  const { engine, nav } = await navScene((e) => floor(e, { size: [10, 0.4, 10] }));
  assert.ok(nav.bake().success);
  const enemy = engine.createEntity({ name: "Enemy" });
  const agent = enemy.addComponent("navagent", {});
  engine.playing = true;
  agent.rejoinCrowd();
  // A target on a ledge above still resolves to the reachable ground below.
  assert.ok(agent.setDestination(new THREE.Vector3(3, 3, 3)), "snapped down");
  near(agent.destination.y, 0, 1, "onto the floor");
  assert.equal(agent.setDestination(new THREE.Vector3(900, 0, 900)), false, "but nowhere near the map is a no");
});

await check("stop() halts the agent and resume() sends it on again", async () => {
  const { engine, nav } = await navScene((e) => floor(e, { size: [30, 0.4, 30] }));
  assert.ok(nav.bake().success);
  const enemy = engine.createEntity({ name: "Enemy" });
  enemy.object3D.position.set(-8, 0, 0);
  const agent = enemy.addComponent("navagent", { speed: 4 });
  engine.playing = true;
  agent.rejoinCrowd();
  agent.setDestination(new THREE.Vector3(8, 0, 0));
  for (let i = 0; i < 60; i++) tick(engine, 1 / 60);
  const moved = enemy.object3D.position.x;
  assert.ok(moved > -8, "it set off");

  agent.stop();
  // It decelerates rather than freezing mid-stride, so the property to check is
  // that it comes to REST and stays there — not that it halts on the frame.
  for (let i = 0; i < 90; i++) tick(engine, 1 / 60);
  assert.ok(agent.isStopped, "reports itself stopped");
  const resting = enemy.object3D.position.x;
  assert.ok(resting - moved < 2, `pulled up promptly (coasted ${(resting - moved).toFixed(2)}m)`);
  for (let i = 0; i < 90; i++) tick(engine, 1 / 60);
  near(enemy.object3D.position.x, resting, 1e-3, "and stayed put");

  agent.resume();
  for (let i = 0; i < 120; i++) tick(engine, 1 / 60);
  assert.ok(enemy.object3D.position.x > resting + 0.5, "and carried on afterwards");
});

await check("warp teleports without walking", async () => {
  const { engine, nav } = await navScene((e) => floor(e, { size: [30, 0.4, 30] }));
  assert.ok(nav.bake().success);
  const enemy = engine.createEntity({ name: "Enemy" });
  const agent = enemy.addComponent("navagent", {});
  engine.playing = true;
  agent.rejoinCrowd();
  agent.warp(new THREE.Vector3(10, 0, -10));
  tick(engine, 1 / 60);
  near(enemy.object3D.position.x, 10, 1, "arrived instantly");
  near(enemy.object3D.position.z, -10, 1, "on both axes");
});

await check("agents avoid each other instead of overlapping", async () => {
  // Two agents swapping places head-on. Without local avoidance they walk
  // through each other; with it they slide past.
  const { engine, nav } = await navScene((e) => floor(e, { size: [30, 0.4, 30] }));
  assert.ok(nav.bake().success);
  const make = (x, radius) => {
    const entity = engine.createEntity({ name: `A${x}` });
    entity.object3D.position.set(x, 0, 0);
    const agent = entity.addComponent("navagent", { radius, speed: 3, avoidance: true, separation: 3 });
    return { entity, agent };
  };
  const a = make(-6, 0.5);
  const b = make(6, 0.5);
  engine.playing = true;
  a.agent.rejoinCrowd();
  b.agent.rejoinCrowd();
  a.agent.setDestination(new THREE.Vector3(6, 0, 0));
  b.agent.setDestination(new THREE.Vector3(-6, 0, 0));

  let closest = Infinity;
  for (let i = 0; i < 60 * 10; i++) {
    tick(engine, 1 / 60);
    closest = Math.min(closest, a.entity.object3D.position.distanceTo(b.entity.object3D.position));
  }
  assert.ok(closest > 0.5, `never interpenetrated (closest ${closest.toFixed(2)}m, radii sum 1.0)`);
});

await check("the agent faces the way it is moving", async () => {
  const { engine, nav } = await navScene((e) => floor(e, { size: [30, 0.4, 30] }));
  assert.ok(nav.bake().success);
  const enemy = engine.createEntity({ name: "Enemy" });
  enemy.object3D.position.set(0, 0, 0);
  const agent = enemy.addComponent("navagent", { speed: 4, autoRotate: true, angularSpeed: 720 });
  engine.playing = true;
  agent.rejoinCrowd();
  agent.setDestination(new THREE.Vector3(10, 0, 0));
  for (let i = 0; i < 120; i++) tick(engine, 1 / 60);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(enemy.object3D.quaternion);
  assert.ok(forward.x > 0.8, `facing +X, got ${forward.toArray().map((n) => n.toFixed(2))}`);
});

await check("the crowd does not run while the editor is stopped", async () => {
  // An enemy that wanders off its spawn point every time you open the scene is
  // a scene that never stays saved.
  const { engine, nav } = await navScene((e) => floor(e, { size: [30, 0.4, 30] }));
  assert.ok(nav.bake().success);
  const enemy = engine.createEntity({ name: "Enemy" });
  enemy.object3D.position.set(-8, 0, 0);
  const agent = enemy.addComponent("navagent", { speed: 4 });
  engine.playing = true;
  agent.rejoinCrowd();
  agent.setDestination(new THREE.Vector3(8, 0, 0));
  engine.playing = false;
  for (let i = 0; i < 120; i++) tick(engine, 1 / 60);
  near(enemy.object3D.position.x, -8, 1e-6, "it never moved");
});

await check("agents and links authored before the wasm finished loading still work", async () => {
  // The race a scene load actually hits: `applyEngineModules` returns before
  // recast's wasm is up, so deserialization attaches every navigation component
  // while `engine.navigation` is still undefined.
  const engine = new Engine();
  const pending = applyEngineModules(engine, ["navigation"]);
  floor(engine, { name: "A", size: [8, 0.4, 8], position: [-6, -0.2, 0] });
  floor(engine, { name: "B", size: [8, 0.4, 8], position: [6, -0.2, 0] });
  const jump = engine.createEntity({ name: "Jump" });
  jump.object3D.position.set(-2.5, 0, 0);
  jump.object3D.updateMatrixWorld(true);
  jump.addComponent("navlink", { end: [5, 0, 0], radius: 1, showGizmo: false });
  const enemy = engine.createEntity({ name: "Enemy" });
  enemy.object3D.position.set(-6, 0, 0);
  const agent = enemy.addComponent("navagent", { speed: 4, stoppingDistance: 0.6 });
  assert.equal(engine.navigation, undefined, "the system really wasn't there yet");

  await pending;
  await engine.modules.get("navigation")?.ready;
  const result = engine.navigation.bake();
  assert.ok(result.success, result.error);
  assert.equal(result.stats.links, 1, "the link registered late and still reached the bake");

  engine.playing = true;
  agent.rejoinCrowd();
  assert.ok(engine.navigation.agents.has(agent), "and the agent is in the per-frame sync");
  assert.ok(agent.setDestination(new THREE.Vector3(6, 0, 0)));
  for (let i = 0; i < 60 * 15; i++) {
    tick(engine, 1 / 60);
    if (agent.isAtDestination) break;
  }
  assert.ok(agent.isAtDestination, `crossed the gap (${agent.remainingDistance.toFixed(2)}m left)`);
});

await check("a re-bake keeps existing agents working", async () => {
  const { engine, nav } = await navScene((e) => floor(e, { size: [30, 0.4, 30] }));
  assert.ok(nav.bake().success);
  const enemy = engine.createEntity({ name: "Enemy" });
  enemy.object3D.position.set(-8, 0, 0);
  const agent = enemy.addComponent("navagent", { speed: 4 });
  engine.playing = true;
  agent.rejoinCrowd();
  const first = agent.agent;

  // Re-baking destroys the crowd; without the rejoin every enemy in the level
  // would go inert until someone reloaded the scene.
  assert.ok(nav.bake().success);
  assert.ok(agent.agent, "still in a crowd");
  assert.notEqual(agent.agent, first, "a new one");
  agent.setDestination(new THREE.Vector3(8, 0, 0));
  for (let i = 0; i < 60 * 8; i++) {
    tick(engine, 1 / 60);
    if (agent.isAtDestination) break;
  }
  assert.ok(agent.isAtDestination, "and still able to walk somewhere");
});

// ---------------------------------------------------------------------------

section("navmesh component");

await check("the component bakes and reports what it built", async () => {
  const { engine } = await navScene((e) => floor(e));
  const holder = engine.createEntity({ name: "Navigation" });
  const navmesh = holder.addComponent("navmesh", { showOverlay: false, agentRadius: 0.4 });
  const result = navmesh.bake();
  assert.ok(result.success, result.error);
  assert.ok(result.stats.triangles > 0);
  assert.ok(engine.navigation.isReady);
});

await check("bake settings in metres reach recast as the right voxel counts", async () => {
  // The conversion nobody would notice being wrong until agents started
  // walking through walls: recast counts radius/height/climb in VOXELS.
  const { engine } = await navScene((e) => floor(e, { size: [20, 0.4, 20] }));
  const holder = engine.createEntity({ name: "Navigation" });
  const navmesh = holder.addComponent("navmesh", { showOverlay: false });
  navmesh.setProp("agentRadius", 2);
  navmesh.setProp("cellSize", 0.2);
  assert.ok(navmesh.bake().success);
  assert.ok(navmesh.navigation.isOnNavMesh(new THREE.Vector3(0, 0, 0)), "centre walkable");
  assert.ok(
    !navmesh.navigation.isOnNavMesh(new THREE.Vector3(8.5, 0, 0)),
    "a 2m-radius agent can't stand 1.5m from the edge",
  );
});

await check("the overlay appears only when asked for", async () => {
  const { engine } = await navScene((e) => floor(e));
  const holder = engine.createEntity({ name: "Navigation" });
  const navmesh = holder.addComponent("navmesh", { showOverlay: false });
  assert.ok(navmesh.bake().success);
  assert.equal(engine.scene.getObjectByName("__navmeshOverlay"), undefined, "off by request");
  navmesh.setProp("showOverlay", true);
  assert.ok(engine.scene.getObjectByName("__navmeshOverlay"), "and on when asked");
  navmesh.setProp("showOverlay", false);
  assert.equal(engine.scene.getObjectByName("__navmeshOverlay"), undefined, "and removed again");
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall navigation checks passed");
process.exit(failures ? 1 : 0);
