import test from "node:test";
import assert from "node:assert/strict";
import { FOLIAGE_CHOICES, foliageEntitySpec, foliagePreset, isFoliageSurface } from "../src/editor/foliagePresets.js";

test("every authoring preset has species-sized geometry and ordered distance levels", () => {
  for (const { species } of FOLIAGE_CHOICES) {
    const props = foliagePreset(species);
    assert.equal(props.species, species);
    assert.ok(props.height > 0 && props.width > 0);
    assert.ok(props.density > 0);
    assert.ok(props.lodNear < props.lodFar && props.lodFar < props.maxDistance);
    assert.ok(props.minScale <= props.maxScale);
    assert.match(props.leafColor, /^#[0-9a-f]{6}$/i);
  }
  assert.ok(foliagePreset("grass").height < foliagePreset("oak").height / 4);
  assert.ok(foliagePreset("grass").density > foliagePreset("oak").density * 10);
  for (const species of ["oak", "birch", "pine"]) {
    const props = foliagePreset(species);
    for (const key of ["leafDensity", "leafSize", "branchDensity", "crownSpread"]) assert.equal(props[key], 1);
    assert.equal(props.crownBase, 0);
  }
  assert.equal(foliagePreset("grass").leafDensity, undefined, "tree shape controls are not meadow presets");
});

test("a scatter is a referenced child; a standalone plant honors the cursor", () => {
  const scatter = foliageEntitySpec({ species: "wildflowers", parentId: "terrain-id", surfaceId: "terrain-id" });
  assert.equal(scatter.parentId, "terrain-id");
  assert.equal(scatter.components[0].props.surface, "terrain-id");
  assert.equal(scatter.components[0].props.distribution, "scatter");
  assert.equal(scatter.transform, undefined, "the child uses the surface's local origin");
  const cursor = [10, 2, -4];
  const single = foliageEntitySpec({ position: cursor });
  assert.equal(single.components[0].props.distribution, "single");
  assert.deepEqual(single.transform.position, cursor);
  cursor[0] = 20;
  assert.equal(single.transform.position[0], 10);
});

test("surface picker admits deep imported groups and rejects non-surfaces and cycles", () => {
  const records = {
    root: { id: "root", components: {}, childIds: ["folder"] },
    folder: { id: "folder", components: {}, childIds: ["mesh"] },
    mesh: { id: "mesh", components: { mesh: {} }, childIds: [] },
    light: { id: "light", components: { light: {} }, childIds: [] },
    cycle: { id: "cycle", components: {}, childIds: ["cycle"] },
  };
  const read = (id) => records[id];
  assert.equal(isFoliageSurface(records.root, read), true);
  assert.equal(isFoliageSurface(records.light, read), false);
  assert.equal(isFoliageSurface(records.cycle, read), false);
  assert.equal(isFoliageSurface(null, read), false);
  assert.equal(isFoliageSurface({ id: "live", getComponent: (key) => key === "terrain" ? {} : null }), true);
});
