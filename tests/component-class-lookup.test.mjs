import test from "node:test";
import assert from "node:assert/strict";

import { Entity } from "../src/engine/Entity.js";
import { registerBuiltInComponents } from "../src/engine/index.js";
import { MeshComponent } from "../src/engine/components/MeshComponent.js";
import { LightComponent } from "../src/engine/components/LightComponent.js";

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

  // Authored props are mirrored on the instance (get/set → props / setProp).
  assert.equal(mesh.geometry, "sphere");
  mesh.geometry = "box";
  assert.equal(mesh.props.geometry, "box");
  assert.equal(mesh.geometry, "box");

  entity.removeComponent(MeshComponent);
  assert.equal(entity.getComponent(MeshComponent), undefined);
  assert.equal(entity.getComponent("mesh"), undefined);
});

test("getComponent rejects values without a type string", () => {
  const entity = new Entity(fakeEngine(), { name: "X" });
  assert.throws(() => entity.getComponent(null), /Expected a component type/);
  assert.throws(() => entity.getComponent(42), /Expected a component type/);
});

test("prop accessors do not collide with LightComponent CSM runtime state", () => {
  const entity = new Entity(
    {
      emit() {},
      viewOnlyComponents: new Set(),
      onPreRender() {
        return () => {};
      },
      on() {
        return () => {};
      },
    },
    { name: "Sun" },
  );
  const light = entity.addComponent(LightComponent);
  assert.equal(light.csm, false);
  light.csm = true;
  assert.equal(light.props.csm, true);
  assert.equal(light.csm, true);
  // Runtime CSM handle is private (#csm); the boolean prop must stay a boolean.
  assert.equal(typeof light.csm, "boolean");
});
