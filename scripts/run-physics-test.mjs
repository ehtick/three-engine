/**
 * Physics gameplay layer (src/modules/physics-rapier/).
 *
 * Rapier runs headlessly in Node (its wasm is inlined), so this drives the
 * REAL PhysicsSystem against a real world — no stubs, no mocks. What it checks
 * is the layer above Rapier: that a collider lands on the layer you gave it,
 * that the matrix actually stops pairs from colliding, that queries filter the
 * way a gameplay programmer expects (and can exclude the shooter), and that
 * joints hold two bodies together.
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
// TRAP, and the reason physics was never testable headlessly in this repo:
// Rapier's wasm-bindgen glue picks a BROWSER code path the moment `window`
// exists, and then calls `window.performance.now()`. A stub `window` without
// `performance` hands it undefined, and the wasm traps with a bare
// "unreachable" — no panic message, no stack into Rust, and every later Rapier
// call then fails with "recursive use of an object detected...", which sends
// you looking for a re-entrancy bug that does not exist. Forward the real
// `performance` (and `crypto`, which the same glue reaches for).
globalThis.window ??= {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  performance: globalThis.performance,
  crypto: globalThis.crypto,
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const { Engine, registerBuiltInComponents, applyEngineModules } = await import("../src/engine/index.js");
const { PhysicsLayers } = await import("../src/modules/physics-rapier/layers.js");
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

/**
 * A live engine with the physics module enabled and the world built. The
 * module's setup resolves as soon as the JS loads and finishes the wasm init
 * in the background, so wait for `engine.physics` before touching it.
 */
async function world({ layers = null, build = () => {} } = {}) {
  const engine = new Engine();
  if (layers) engine.config.physicsLayers = layers;
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  build(engine);
  engine.setPlaying(true); // builds the Rapier world from the entity tree
  return {
    engine,
    physics: engine.physics,
    // Physics steps on a fixed 1/60 accumulator, so a "frame" here is one step.
    step: (n = 1) => {
      for (let i = 0; i < n; i++) engine.physics.update(1 / 60);
    },
  };
}

function box(engine, name, position, props = {}) {
  const entity = engine.createEntity({ name });
  entity.object3D.position.set(...position);
  entity.addComponent("collider", { shape: "box", size: [1, 1, 1], ...props.collider });
  if (props.rigidbody !== null) entity.addComponent("rigidbody", { bodyType: "dynamic", ...props.rigidbody });
  return entity;
}

console.log("physics — layers");

await check("layer matrix is symmetric even when authored lopsided", () => {
  const layers = new PhysicsLayers({ names: ["A", "B", "C"], matrix: [0b011, 0b111, 0b111] });
  // A says it does not hit C, C says it hits A. One of them has to win, and
  // "they do not collide" is the only answer physics can actually express.
  assert.equal(layers.collides("A", "C"), false);
  assert.equal(layers.collides("C", "A"), false);
});

await check("groupsFor packs membership and filter the way Rapier reads them", () => {
  const layers = new PhysicsLayers({ names: ["A", "B"], matrix: [0b01, 0b10] });
  const groups = layers.groupsFor("B");
  assert.equal(groups >>> 16, 0b10, "membership is the layer's own bit");
  assert.equal(groups & 0xffff, 0b10, "filter is the matrix row");
});

await check("unknown layer names fall back to Default rather than throwing", () => {
  const layers = new PhysicsLayers({ names: ["Default", "Player"] });
  assert.equal(layers.indexOf("Nonexistent"), 0);
  assert.equal(layers.has("Nonexistent"), false);
});

await check("maskFor(null) means every layer", () => {
  const layers = new PhysicsLayers({ names: ["A", "B", "C"] });
  assert.equal(layers.maskFor(null), 0xffff);
  assert.equal(layers.maskFor(["B"]), 0b010);
  assert.equal(layers.maskFor(["A", "C"]), 0b101);
});

console.log("physics — world");

await check("a dynamic body falls and a static floor stops it", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "Floor", [0, -0.5, 0], { rigidbody: null, collider: { size: [20, 1, 20] } });
      box(engine, "Crate", [0, 5, 0]);
    },
  });
  w.step(180);
  const y = [...w.engine.entities.values()].find((e) => e.name === "Crate")?.object3D.position.y;
  assert.ok(y > 0.4 && y < 0.7, `crate should rest on the floor, got y=${y}`);
});

await check("the layer matrix stops a pair from colliding", async () => {
  // Projectile does NOT collide with Player, but does collide with Ground.
  const names = ["Default", "Player", "Projectile", "Ground"];
  const matrix = [0b1111, 0b1011, 0b1101, 0b1111];
  const w = await world({
    layers: { names, matrix },
    build: (engine) => {
      box(engine, "Player", [0, 0, 0], {
        rigidbody: null,
        collider: { size: [4, 4, 4], layer: "Player" },
      });
      box(engine, "Bullet", [0, 6, 0], {
        collider: { layer: "Projectile" },
        rigidbody: { bodyType: "dynamic", gravityScale: 1 },
      });
    },
  });
  w.step(180);
  const bullet = [...w.engine.entities.values()].find((e) => e.name === "Bullet");
  assert.ok(
    bullet.object3D.position.y < -2,
    `bullet should fall THROUGH the player it cannot hit, got y=${bullet.object3D.position.y}`,
  );
});

await check("...and the same pair collides once the matrix allows it", async () => {
  const names = ["Default", "Player", "Projectile", "Ground"];
  const w = await world({
    layers: { names, matrix: null }, // null = everything collides
    build: (engine) => {
      box(engine, "Player", [0, 0, 0], {
        rigidbody: null,
        collider: { size: [4, 4, 4], layer: "Player" },
      });
      box(engine, "Bullet", [0, 6, 0], { collider: { layer: "Projectile" } });
    },
  });
  w.step(180);
  const bullet = [...w.engine.entities.values()].find((e) => e.name === "Bullet");
  assert.ok(
    bullet.object3D.position.y > 1.5,
    `bullet should land on the player, got y=${bullet.object3D.position.y}`,
  );
});

console.log("physics — queries");

await check("raycast reports the entity, point, normal and distance", async () => {
  const w = await world({
    build: (engine) => box(engine, "Target", [0, 0, 0], { rigidbody: null }),
  });
  const hit = w.physics.raycast([0, 5, 0], [0, -1, 0], 20);
  assert.ok(hit, "expected a hit");
  assert.equal(hit.entity?.name, "Target");
  assert.ok(Math.abs(hit.distance - 4.5) < 0.05, `distance ${hit.distance}`);
  assert.ok(hit.normal[1] > 0.9, `normal should point up, got ${hit.normal}`);
});

await check("raycast layer filter ignores everything else", async () => {
  const w = await world({
    layers: { names: ["Default", "Player", "Enemy"] },
    build: (engine) => {
      box(engine, "Near", [0, 2, 0], { rigidbody: null, collider: { layer: "Player" } });
      box(engine, "Far", [0, 0, 0], { rigidbody: null, collider: { layer: "Enemy" } });
    },
  });
  assert.equal(w.physics.raycast([0, 6, 0], [0, -1, 0], 20)?.entity?.name, "Near", "unfiltered hits the nearest");
  assert.equal(
    w.physics.raycast([0, 6, 0], [0, -1, 0], 20, { layers: ["Enemy"] })?.entity?.name,
    "Far",
    "filtered skips the Player-layer collider in front",
  );
});

await check("a layer that collides with nothing is still raycastable", async () => {
  // The reason queries do not reuse the collision matrix. A trigger volume
  // that collides with nothing must still answer "what is under the cursor".
  const names = ["Default", "Ghost"];
  const matrix = [0b01, 0b00];
  const w = await world({
    layers: { names, matrix },
    build: (engine) => box(engine, "Ghost", [0, 0, 0], { rigidbody: null, collider: { layer: "Ghost" } }),
  });
  const hit = w.physics.raycast([0, 6, 0], [0, -1, 0], 20, { layers: ["Ghost"] });
  assert.equal(hit?.entity?.name, "Ghost");
});

await check("exclude ignores the shooter's own colliders", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "Shooter", [0, 5, 0], { rigidbody: null });
      box(engine, "Target", [0, 0, 0], { rigidbody: null });
    },
  });
  const shooter = [...w.engine.entities.values()].find((e) => e.name === "Shooter");
  // Firing from inside your own collider is the normal case for a muzzle.
  assert.equal(w.physics.raycast([0, 5, 0], [0, -1, 0], 20)?.entity?.name, "Shooter", "hits itself without exclude");
  assert.equal(
    w.physics.raycast([0, 5, 0], [0, -1, 0], 20, { exclude: shooter })?.entity?.name,
    "Target",
    "excluded, so it reaches the target",
  );
});

await check("exclude covers the entity's whole subtree", async () => {
  const w = await world({
    build: (engine) => {
      const player = engine.createEntity({ name: "Player" });
      player.object3D.position.set(0, 5, 0);
      const weapon = engine.createEntity({ name: "Weapon", parent: player });
      weapon.addComponent("collider", { shape: "box", size: [1, 1, 1] });
      box(engine, "Target", [0, 0, 0], { rigidbody: null });
    },
  });
  const player = [...w.engine.entities.values()].find((e) => e.name === "Player");
  const hit = w.physics.raycast([0, 5, 0], [0, -1, 0], 20, { exclude: player });
  assert.equal(hit?.entity?.name, "Target", "the child weapon collider was excluded too");
});

await check("raycastAll returns every hit, nearest first", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "A", [0, 3, 0], { rigidbody: null });
      box(engine, "B", [0, 1, 0], { rigidbody: null });
      box(engine, "C", [0, -1, 0], { rigidbody: null });
    },
  });
  const hits = w.physics.raycastAll([0, 8, 0], [0, -1, 0], 30);
  assert.deepEqual(hits.map((h) => h.entity.name), ["A", "B", "C"]);
});

await check("spherecast has thickness a ray does not", async () => {
  // Two boxes with a 0.4-wide gap between them. A ray straight down the gap
  // misses; a 0.5-radius sphere cannot fit and must hit.
  const w = await world({
    build: (engine) => {
      box(engine, "Left", [-0.7, 0, 0], { rigidbody: null });
      box(engine, "Right", [0.7, 0, 0], { rigidbody: null });
    },
  });
  assert.equal(w.physics.raycast([0, 6, 0], [0, -1, 0], 20), null, "the ray slips through the gap");
  const hit = w.physics.spherecast([0, 6, 0], 0.5, [0, -1, 0], 20);
  assert.ok(hit, "the sphere is too fat to fit and hits");
  assert.ok(["Left", "Right"].includes(hit.entity?.name), hit.entity?.name);
});

await check("overlapSphere finds everything inside it, once per entity", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "Near", [1, 0, 0], { rigidbody: null });
      box(engine, "Also", [-1, 0, 0], { rigidbody: null });
      box(engine, "Far", [50, 0, 0], { rigidbody: null });
    },
  });
  const found = w.physics.overlapSphere([0, 0, 0], 3).map((e) => e.name).sort();
  assert.deepEqual(found, ["Also", "Near"]);
});

await check("overlapBox respects the layer filter", async () => {
  const w = await world({
    layers: { names: ["Default", "Pickup"] },
    build: (engine) => {
      box(engine, "Coin", [0, 0, 0], { rigidbody: null, collider: { layer: "Pickup" } });
      box(engine, "Wall", [0.5, 0, 0], { rigidbody: null });
    },
  });
  const found = w.physics.overlapBox([0, 0, 0], [2, 2, 2], { layers: ["Pickup"] });
  assert.deepEqual(found.map((e) => e.name), ["Coin"]);
});

console.log("physics — joints");

await check("a hinge holds a body to the world instead of letting it fall", async () => {
  const w = await world({
    build: (engine) => {
      const door = box(engine, "Door", [0, 3, 0]);
      // With no connected entity the world anchor is created AT the door's
      // pose, so both anchors are the same local offset — the hinge line runs
      // down the door's left edge.
      door.addComponent("joint", { kind: "hinge", anchor: [-0.5, 0, 0], connectedAnchor: [-0.5, 0, 0], axis: [0, 1, 0] });
    },
  });
  w.step(180);
  const door = [...w.engine.entities.values()].find((e) => e.name === "Door");
  assert.ok(
    Math.abs(door.object3D.position.y - 3) < 0.3,
    `a hinged door should stay at its pivot height, got y=${door.object3D.position.y}`,
  );
});

await check("a fixed joint carries one body along with another", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "Anchor", [0, 3, 0], { rigidbody: { bodyType: "kinematic" } });
      const hung = box(engine, "Hung", [0, 1, 0]);
      hung.addComponent("joint", {
        kind: "fixed",
        connectedEntity: [...engine.entities.values()].find((e) => e.name === "Anchor").id,
        anchor: [0, 0, 0],
        connectedAnchor: [0, -2, 0],
      });
    },
  });
  w.step(120);
  const hung = [...w.engine.entities.values()].find((e) => e.name === "Hung");
  assert.ok(
    hung.object3D.position.y > 0.5,
    `a fixed joint to a kinematic anchor should hold it up, got y=${hung.object3D.position.y}`,
  );
});

await check("a joint naming a missing entity warns instead of crashing the build", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(String(args[0]));
  try {
    const w = await world({
      build: (engine) => {
        const e = box(engine, "Lonely", [0, 3, 0]);
        e.addComponent("joint", { kind: "hinge", connectedEntity: "does-not-exist" });
      },
    });
    w.step(10);
    assert.ok(warnings.some((m) => m.includes("connected entity not found")), warnings.join(" | "));
  } finally {
    console.warn = original;
  }
});

console.log("physics — events");

await check("a body that spawns already inside a trigger still reports entering it", async () => {
  // The world is primed with a zero-length step so queries work before the
  // first frame; if that step drained the event queue, this overlap would be
  // swallowed and the trigger would never fire.
  const w = await world({
    build: (engine) => {
      box(engine, "Zone", [0, 0, 0], { rigidbody: null, collider: { size: [4, 4, 4], isSensor: true } });
      box(engine, "Spawned", [0, 0, 0], { rigidbody: { bodyType: "dynamic", gravityScale: 0 } });
    },
  });
  const triggers = [];
  w.engine.on("trigger", ({ a, b, started }) => triggers.push(`${a.name}->${b.name}:${started}`));
  w.step(3);
  assert.ok(triggers.length > 0, "expected a trigger event on the first tick");
  assert.ok(triggers[0].includes("true"), triggers.join(", "));
});

await check("collision events reach every script on both entities", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "Ground", [0, -0.5, 0], { rigidbody: null, collider: { size: [10, 1, 10] } });
      box(engine, "Faller", [0, 3, 0]);
    },
  });
  const collisions = [];
  w.engine.on("collision", ({ a, b, started }) => collisions.push(`${a.name}/${b.name}:${started}`));
  w.step(120);
  assert.ok(collisions.some((c) => c.includes("true")), `expected a collision, got ${collisions.join(", ")}`);
});

console.log("physics — character controller");

await check("the character capsule honours its layer", async () => {
  // Player does not collide with Debris, so the character walks through it.
  const names = ["Default", "Player", "Debris"];
  const matrix = [0b111, 0b011, 0b101];
  const w = await world({
    layers: { names, matrix },
    build: (engine) => {
      box(engine, "Floor", [0, -0.5, 0], { rigidbody: null, collider: { size: [40, 1, 40] } });
      box(engine, "Rubble", [1.5, 0.5, 0], { rigidbody: null, collider: { size: [1, 1, 1], layer: "Debris" } });
      const player = engine.createEntity({ name: "Player" });
      player.object3D.position.set(0, 1, 0);
      player.addComponent("charactercontroller", { radius: 0.3, height: 1, layer: "Player" });
    },
  });
  const player = [...w.engine.entities.values()].find((e) => e.name === "Player");
  player.getComponent("charactercontroller").move([4, 0, 0]);
  w.step(60);
  assert.ok(
    player.object3D.position.x > 1.9,
    `the player should pass through debris it cannot collide with, x=${player.object3D.position.x.toFixed(2)}`,
  );
});

await check("a character is carried by the moving platform it stands on", async () => {
  const w = await world({
    build: (engine) => {
      const platform = engine.createEntity({ name: "Platform" });
      platform.object3D.position.set(0, 0, 0);
      platform.addComponent("rigidbody", { bodyType: "kinematic" });
      platform.addComponent("collider", { shape: "box", size: [6, 1, 6] });

      const player = engine.createEntity({ name: "Player" });
      player.object3D.position.set(0, 1.2, 0);
      player.addComponent("charactercontroller", { radius: 0.3, height: 1 });
    },
  });
  const platform = [...w.engine.entities.values()].find((e) => e.name === "Platform");
  const player = [...w.engine.entities.values()].find((e) => e.name === "Player");
  w.step(30); // settle onto the platform
  const startX = player.object3D.position.x;

  // Drive the platform sideways, the way a script or animation would.
  for (let i = 0; i < 60; i++) {
    platform.object3D.position.x += 0.05;
    w.step(1);
  }
  const carried = player.object3D.position.x - startX;
  assert.ok(carried > 1.5, `the player should ride the platform (~3 units), moved ${carried.toFixed(2)}`);
  assert.equal(player.getComponent("charactercontroller").getPlatform()?.name, "Platform");
});

console.log(failures ? `\n${failures} failing` : "\nall physics checks passed");
process.exit(failures ? 1 : 0);
