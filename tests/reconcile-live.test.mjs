/**
 * `reconcileScene`'s two audiences.
 *
 * Leaving Play restores an authored snapshot onto a scene a game just finished
 * mutating: every `resetOnStop` component must be re-attached, because its
 * runtime state (a sound mid-playback, a sprite parked on frame 7, a script's
 * fields) diverged even where its props did not.
 *
 * The browser preview's live update restores an authored EDIT onto a scene
 * that is still running, and needs the opposite: the running game is the thing
 * being debugged. Restarting every script because an unrelated entity moved is
 * indistinguishable from the page reload the whole live-update path exists to
 * avoid — which is exactly how it was first reported.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Entity } from "../src/engine/Entity.js";
import { Component } from "../src/engine/components/Component.js";
import { registerComponent } from "../src/engine/components/registry.js";
import { reconcileScene, serializeScene, SCENE_VERSION } from "../src/engine/serialize.js";

/** Stands in for ScriptComponent/SoundComponent: state outside the props. */
let attachCount = 0;
class StatefulComponent extends Component {
  static type = "test-stateful";
  static resetOnStop = true;
  static defaults = { tag: "a" };
  static schema = [{ key: "tag", label: "Tag", type: "string" }];
  onAttach() {
    attachCount++;
  }
}
class PlainComponent extends Component {
  static type = "test-plain";
  static defaults = { note: "" };
  static schema = [{ key: "note", label: "Note", type: "string" }];
}
registerComponent(StatefulComponent);
registerComponent(PlainComponent);

function makeEngine() {
  const engine = {
    sceneName: "Test",
    settings: {},
    entities: new Map(),
    rootEntities: [],
    viewOnlyComponents: new Set(),
    config: {},
    emit() {},
    on: () => () => {},
    applySettings: async () => {},
    batchHierarchy: async (fn) => fn(),
    getEntity: (id) => engine.entities.get(id) ?? null,
    createEntity({ id, name, parent = null } = {}) {
      const entity = new Entity(engine, { id, name });
      engine.entities.set(entity.id, entity);
      if (parent) entity.setParent(parent);
      else engine.rootEntities.push(entity);
      return entity;
    },
    destroyEntity(entity) {
      for (const child of [...entity.children]) engine.destroyEntity(child);
      engine.entities.delete(entity.id);
      const index = engine.rootEntities.indexOf(entity);
      if (index !== -1) engine.rootEntities.splice(index, 1);
    },
  };
  return engine;
}

/** A scene with a moving entity and a stateful one beside it. */
function seed() {
  const engine = makeEngine();
  const mover = engine.createEntity({ id: "mover", name: "Mover" });
  mover.addComponent("test-plain", { note: "hello" });
  const actor = engine.createEntity({ id: "actor", name: "Actor" });
  actor.addComponent("test-stateful", { tag: "a" });
  return { engine, mover, actor };
}

test("a live edit elsewhere leaves stateful components running", async () => {
  const { engine, mover } = seed();
  const snapshot = serializeScene(engine);
  attachCount = 0;

  // What the editor writes when the author drags one entity.
  snapshot.entities.find((e) => e.id === "mover").position = [5, 0, 0];
  snapshot.version = SCENE_VERSION;

  await reconcileScene(engine, snapshot, { resetStatefulComponents: false });

  assert.equal(attachCount, 0, "the untouched stateful component was restarted");
  assert.deepEqual(mover.getTransform().position, [5, 0, 0], "the edit was not applied");
});

test("leaving Play still re-attaches every stateful component", async () => {
  const { engine } = seed();
  const snapshot = serializeScene(engine);
  attachCount = 0;

  await reconcileScene(engine, snapshot);

  assert.equal(attachCount, 1, "play-stop must reset runtime state it cannot see");
});

test("a live edit TO a stateful component still re-attaches it", async () => {
  const { engine, actor } = seed();
  const snapshot = serializeScene(engine);
  attachCount = 0;

  snapshot.entities
    .find((e) => e.id === "actor")
    .components.find((c) => c.type === "test-stateful").props.tag = "b";

  await reconcileScene(engine, snapshot, { resetStatefulComponents: false });

  assert.equal(attachCount, 1, "an edited stateful component must pick its new props up");
  assert.equal(actor.getComponent("test-stateful").props.tag, "b");
});

test("a live edit applies structure changes without rebuilding survivors", async () => {
  const { engine, actor } = seed();
  const snapshot = serializeScene(engine);
  attachCount = 0;

  // The author deletes the mover and adds a new entity.
  snapshot.entities = snapshot.entities.filter((e) => e.id !== "mover");
  snapshot.entities.push({
    id: "added",
    name: "Added",
    position: [1, 2, 3],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    enabledInEditor: true,
    enabledInGame: true,
    components: [{ type: "test-plain", props: { note: "new" } }],
    children: [],
  });

  await reconcileScene(engine, snapshot, { resetStatefulComponents: false });

  assert.equal(engine.getEntity("mover"), null, "the deleted entity survived");
  assert.equal(engine.getEntity("added")?.name, "Added", "the added entity is missing");
  assert.ok(engine.getEntity("actor"), "an untouched entity was destroyed");
  assert.equal(attachCount, 0, "an untouched stateful component was restarted");
});
