import test from "node:test";
import assert from "node:assert/strict";

import { Entity } from "../src/engine/Entity.js";
import { serializeEntity } from "../src/engine/serialize.js";
import { applyOverrides } from "../src/engine/prefab/resolve.js";

/**
 * A stand-in for the engine an Entity normally hangs off: the tag code only
 * ever touches `emit`, so an event sink is the whole surface it needs.
 */
function fakeEngine() {
  const events = [];
  return { emit: (name, payload) => events.push([name, payload]), events };
}

const makeEntity = (name = "Entity") => new Entity(fakeEngine(), { name });

/* ------------------------------- Entity tags ------------------------------ */

test("addTag ignores blanks and duplicates, and keeps the list sorted", () => {
  const entity = makeEntity();
  entity.addTag("enemy", "boss", "enemy", "  ", null);
  assert.deepEqual(entity.tags, ["boss", "enemy"]);
});

test("addTag accepts an array as well as varargs", () => {
  const entity = makeEntity();
  entity.addTag(["alpha", "beta"]);
  assert.deepEqual(entity.tags, ["alpha", "beta"]);
});

test("removeTag drops only what was asked for", () => {
  const entity = makeEntity();
  entity.addTag("a", "b", "c");
  entity.removeTag("b", "missing");
  assert.deepEqual(entity.tags, ["a", "c"]);
});

test("hasTag ORs arguments and ANDs arrays (PlayCanvas semantics)", () => {
  const entity = makeEntity();
  entity.addTag("enemy", "flying");

  assert.equal(entity.hasTag("enemy"), true);
  assert.equal(entity.hasTag("boss"), false);
  // OR across arguments
  assert.equal(entity.hasTag("boss", "enemy"), true);
  // AND within an array
  assert.equal(entity.hasTag(["enemy", "flying"]), true);
  assert.equal(entity.hasTag(["enemy", "boss"]), false);
  // OR of two AND clauses
  assert.equal(entity.hasTag(["enemy", "boss"], ["enemy", "flying"]), true);
  // An empty query matches nothing rather than everything — "find entities
  // with no filter" would otherwise silently return the whole scene.
  assert.equal(entity.hasTag(), false);
});

test("setTags normalises: trims, dedupes, drops blanks, sorts", () => {
  const entity = makeEntity();
  entity.setTags([" b ", "a", "a", ""]);
  assert.deepEqual(entity.tags, ["a", "b"]);
});

test("tag mutations emit exactly once, and no-ops emit nothing", () => {
  const engine = fakeEngine();
  const entity = new Entity(engine, { name: "E" });

  entity.addTag("x");
  assert.equal(engine.events.length, 1);
  assert.equal(engine.events[0][0], "entity-tags-changed");

  entity.addTag("x"); // duplicate
  entity.removeTag("nope"); // absent
  entity.setTags(["x"]); // identical
  assert.equal(engine.events.length, 1);
});

test("findByTag walks the subtree and includes self", () => {
  const root = makeEntity("Root");
  const child = makeEntity("Child");
  const grandchild = makeEntity("Grandchild");
  root.children.push(child);
  child.children.push(grandchild);

  root.addTag("level");
  grandchild.addTag("pickup");

  assert.deepEqual(root.findByTag("level").map((e) => e.name), ["Root"]);
  assert.deepEqual(root.findByTag("pickup").map((e) => e.name), ["Grandchild"]);
  assert.deepEqual(root.findByTag("level", "pickup").map((e) => e.name), ["Root", "Grandchild"]);
});

/* ----------------------------- Serialisation ------------------------------ */

test("tags round-trip through serializeEntity, and are omitted when empty", () => {
  const entity = makeEntity("Tagged");
  entity.getTransform = () => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });

  // Untagged entities must not carry a `"tags": []` — every entity in every
  // scene file would pay for it.
  assert.equal("tags" in serializeEntity(entity), false);

  entity.addTag("enemy");
  assert.deepEqual(serializeEntity(entity).tags, ["enemy"]);
});

/* --------------------------- Prefab tag overrides -------------------------- */

const node = (overrides = {}) => ({
  fid: "f1",
  fidPath: [],
  name: "Node",
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  viewOnly: false,
  enabledInEditor: true,
  enabledInGame: true,
  tags: [],
  components: [],
  children: [],
  ...overrides,
});

test("a 'tags' override replaces the prefab's tag list on the resolved tree", () => {
  const tree = node({ tags: ["base"] });
  const resolved = applyOverrides(tree, [{ t: [], k: "tags", v: ["boss", "elite"] }]);
  assert.deepEqual(resolved.tags, ["boss", "elite"]);
});

test("a 'tags' override can clear the prefab's tags entirely", () => {
  const tree = node({ tags: ["base"] });
  assert.deepEqual(applyOverrides(tree, [{ t: [], k: "tags", v: [] }]).tags, []);
});

test("a tags override on one node leaves siblings alone", () => {
  const tree = node({
    children: [
      node({ fid: "a", fidPath: ["a"], name: "A", tags: ["keep"] }),
      node({ fid: "b", fidPath: ["b"], name: "B", tags: ["also-keep"] }),
    ],
  });
  const resolved = applyOverrides(tree, [{ t: ["a"], k: "tags", v: ["changed"] }]);
  assert.deepEqual(resolved.children[0].tags, ["changed"]);
  assert.deepEqual(resolved.children[1].tags, ["also-keep"]);
});
