import test from "node:test";
import assert from "node:assert/strict";

import { Entity } from "../src/engine/Entity.js";
import { registerBuiltInComponents } from "../src/engine/index.js";
import { MeshComponent } from "../src/engine/components/MeshComponent.js";

registerBuiltInComponents();

function fakeEngine() {
  return {
    emit() {},
    viewOnlyComponents: new Set(),
  };
}

test("getComponent / addComponent / removeComponent accept component classes", () => {
  const entity = new Entity(fakeEngine(), { name: "Box" });
  const mesh = entity.addComponent(MeshComponent, { geometry: "sphere" });
  assert.equal(mesh.type, "mesh");
  assert.equal(entity.getComponent(MeshComponent), mesh);
  assert.equal(entity.getComponent("mesh"), mesh);
  assert.deepEqual(entity.findComponents(MeshComponent), [mesh]);

  entity.removeComponent(MeshComponent);
  assert.equal(entity.getComponent(MeshComponent), undefined);
  assert.equal(entity.getComponent("mesh"), undefined);
});

test("getComponent rejects values without a type string", () => {
  const entity = new Entity(fakeEngine(), { name: "X" });
  assert.throws(() => entity.getComponent(null), /Expected a component type/);
  assert.throws(() => entity.getComponent(42), /Expected a component type/);
});
