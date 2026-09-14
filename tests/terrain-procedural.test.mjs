// Procedural landform generation lives on the Terrain component itself
// (src/engine/terrain/proceduralTerrain.js, the style-driven landscape since
// 09-14); World only consumes it through an overlay
// (TerrainComponent#setShapeOverlay). See docs/TERRAIN_PLAN.md.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { MeshComponent } from "../src/engine/components/MeshComponent.js";
import { TerrainComponent } from "../src/modules/terrain/TerrainComponent.js";
import { createTerrainShape, fillHeightfield, landscapeOptionsFromProps, ALWAYS_FILL_NOW, PROCEDURAL_TERRAIN_PARAMS } from "../src/engine/terrain/proceduralTerrain.js";
import { getLandscape } from "../src/engine/terrain/landscapeGenerator.js";
import { createShapeOverlay } from "../src/engine/world/landscapeFields.js";
import { prepareWorldPlan } from "../src/modules/world/worldPlan.js";
import { createWorldDocument } from "../src/engine/world/worldDocument.js";
import { erodeHeightfield } from "../src/engine/terrain/terrainErosion.js";

/** A fake engine matching tests/terrain-attach.test.mjs's pattern — no GPU,
 *  no onPreRender by default (a standalone Terrain must still finish a
 *  procedural fill synchronously when nothing ticks it). */
function makeEngine({ withPreRender = false } = {}) {
  const listeners = new Map();
  const engine = {
    entities: new Map(), playing: false, scene: new THREE.Scene(),
    getEntity(id) { return this.entities.get(id); },
    on(name, fn) { const group = listeners.get(name) ?? new Set(); listeners.set(name, group); group.add(fn); return () => group.delete(fn); },
    emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args); },
  };
  if (withPreRender) engine.onPreRender = (fn) => engine.on("preRender", fn);
  return engine;
}

function makeTerrain(props, { withPreRender = false } = {}) {
  const engine = makeEngine({ withPreRender });
  const entity = new Entity(engine, { id: "terrain", name: "Terrain" });
  engine.entities.set(entity.id, entity);
  entity.addComponent(new MeshComponent({ geometry: "plane" }));
  const terrain = entity.addComponent(new TerrainComponent(props));
  return { engine, entity, terrain };
}

const drive = (generator) => { let result = generator.next(); while (!result.done) result = generator.next(); return result.value; };

test("the Procedural group is the eight landscape controls, nothing else", () => {
  assert.deepEqual(PROCEDURAL_TERRAIN_PARAMS.map((param) => param.key), ["style", "height", "scale", "levels", "wildness", "erosion", "rocks", "water"]);
  const rows = TerrainComponent.schema.filter((row) => row.section === "Procedural").map((row) => row.key);
  assert.deepEqual(rows, ["procedural", "proceduralSeed", "style", "height", "scale", "levels", "wildness", "erosion", "rocks", "water"]);
});

test("a bare procedural terrain produces a non-flat grid, deterministic per seed", () => {
  const props = { size: 32, resolution: 12, procedural: true, style: "highlands", rocks: 0 };
  const { terrain: a } = makeTerrain({ ...props, proceduralSeed: 7 });
  const { terrain: b } = makeTerrain({ ...props, proceduralSeed: 7 });
  const { terrain: c } = makeTerrain({ ...props, proceduralSeed: 8 });
  assert.ok(a.heightsArray.some((h) => Math.abs(h - a.heightsArray[0]) > 0.5), "highlands are not flat");
  assert.deepEqual(a.heightsArray, b.heightsArray, "the same seed reproduces the exact same grid");
  assert.notDeepEqual(a.heightsArray, c.heightsArray, "a different seed produces a different grid");
  const y = a.geometry.getAttribute("position").array.filter((_, i) => i % 3 === 1);
  assert.deepEqual(Float32Array.from(y), a.heightsArray, "the rendered geometry carries these heights");
});

test("a sliced fill equals a whole fill byte-for-byte, including a cold landscape build", () => {
  const options = { seed: 41, extent: 40, style: "canyon" };
  const whole = drive(fillHeightfield(getLandscape(options), { size: 40, resolution: 24, clock: ALWAYS_FILL_NOW }));
  let ticks = 0;
  const clock = { due: () => (ticks++ % 3 === 0) };
  const sliced = drive(fillHeightfield((sliceClock) => (function* () { return getLandscape({ ...options }); })(sliceClock), { size: 40, resolution: 24, clock }));
  assert.ok(ticks > 3, "the sliced clock actually got consulted repeatedly");
  assert.deepEqual(whole, sliced);
});

test("a sculpt delta survives a style control change", () => {
  const { terrain } = makeTerrain({ size: 20, resolution: 8, procedural: true, proceduralSeed: 3, style: "hills", levels: .2, rocks: 0 });
  const baseBefore = terrain._proceduralBase.slice();
  const index = 14;
  terrain.applyHeightBrush(new THREE.Vector3(0, 0, 0), { tool: "raise", radius: 50, strength: 2 });
  terrain.commitHeights();
  const delta = terrain.heightsArray[index] - baseBefore[index];
  assert.ok(Math.abs(delta) > 0.01, "the stroke actually moved this vertex");
  assert.notEqual(terrain.props.heightEdits, "", "the delta landed in heightEdits");
  assert.equal(terrain.props.heights, "", "heights stays untouched while procedural is on");
  terrain.setProp("height", 1.8);
  assert.notDeepEqual(terrain._proceduralBase, baseBefore, "the base actually changed");
  assert.ok(Math.abs((terrain.heightsArray[index] - terrain._proceduralBase[index]) - delta) < 1e-4, "the authored delta rides the new base unchanged");
});

test("an owner's overlay samples are used verbatim, and a matching key skips a repeat fill", () => {
  const { terrain } = makeTerrain({ size: 10, resolution: 4, procedural: true, proceduralSeed: 1, rocks: 0 });
  const samples = Float32Array.from({ length: 25 }, (_, i) => 100 + i);
  const owner = {};
  terrain.setShapeOverlay(owner, { key: "plan-1", samples });
  assert.deepEqual(terrain._proceduralBase, samples);
  assert.deepEqual(terrain.heightsArray, samples, "no edits yet, so the rendered grid is exactly the samples");
  const stale = terrain._proceduralBase;
  terrain.setShapeOverlay(owner, { key: "plan-1", samples: Float32Array.from({ length: 25 }, () => -1) });
  assert.equal(terrain._proceduralBase, stale, "unchanged key: the component keeps the base it already has");
  const fresh = Float32Array.from({ length: 25 }, () => 42);
  terrain.setShapeOverlay(owner, { key: "plan-2", samples: fresh });
  assert.deepEqual(terrain._proceduralBase, fresh);
  terrain.clearShapeOverlay(owner);
  assert.equal(terrain._shapeOverlay, null);
});

test("a live style change ticks over onPreRender and lands exactly the landscape's grid", () => {
  const { engine, terrain } = makeTerrain({ size: 24, resolution: 10, procedural: true, proceduralSeed: 2, style: "meadow", rocks: 0 }, { withPreRender: true });
  const before = terrain.heightsArray.slice();
  terrain.setProp("style", "canyon");
  // A cold landscape (macro build + erosion) spans many 6 ms slices; tick
  // until the fill reports done rather than guessing a frame count.
  for (let i = 0; i < 5000 && terrain._proceduralUnsub; i++) engine.emit("preRender");
  assert.equal(terrain._proceduralUnsub, null, "the sliced fill finished");
  assert.notDeepEqual(terrain.heightsArray, before, "the new style is actually reflected");
  const expected = drive(fillHeightfield(getLandscape(landscapeOptionsFromProps(terrain.props)), { size: 24, resolution: 10 }));
  assert.deepEqual(terrain.heightsArray, expected);
});

test("chunk tiles: two terrains cut from one landscape share their border vertices exactly", () => {
  const shared = { size: 32, resolution: 16, procedural: true, proceduralSeed: 11, proceduralExtent: 128, style: "shattered", rocks: 0 };
  const { terrain: left } = makeTerrain({ ...shared, proceduralOrigin: [-16, 0] });
  const { terrain: right } = makeTerrain({ ...shared, proceduralOrigin: [16, 0] });
  const cols = 17;
  for (let r = 0; r < cols; r++) assert.equal(left.heightsArray[r * cols + 16], right.heightsArray[r * cols], `row ${r} matches across the seam`);
  assert.notDeepEqual(left.heightsArray, right.heightsArray, "the tiles are different ground");
});

test("the Stone control builds instanced rock structures, and stoneLayer:false or Stone 0 builds none", () => {
  const props = { size: 96, resolution: 32, procedural: true, proceduralSeed: 5, style: "canyon", levels: .8, rocks: .8 };
  const { terrain, entity } = makeTerrain(props);
  assert.ok(terrain._stone, "a rocky canyon terrain has stone");
  const stats = terrain._stone.group.userData.stats;
  assert.ok(stats.placements > 0 && stats.drawCalls > 0 && stats.drawCalls <= 30, `stone is instanced: ${JSON.stringify(stats)}`);
  assert.ok(entity.object3D.children.includes(terrain._stone.group), "the stone group rides the terrain entity");
  for (const mesh of terrain._stone.group.children) assert.ok(mesh.isInstancedMesh && mesh.count > 0);
  terrain.setProp("stoneLayer", false);
  assert.equal(terrain._stone, null, "a World-owned terrain draws no stone of its own");
  const { terrain: bare } = makeTerrain({ ...props, rocks: 0 });
  assert.equal(bare._stone, null);
});

test("World's terrain feature carries no heights; its base grid is procedural plus a shape overlay", () => {
  const document = createWorldDocument({ surfaceMode: "procedural", sky: "off", forestDensity: 0, groundDensity: 0,
    layout: { mode: "study" }, settlement: { editableBuildings: false } });
  const plan = prepareWorldPlan(document);
  try {
    const terrainFeature = plan.generated.find((feature) => feature.id === "terrain");
    assert.equal(Object.hasOwn(terrainFeature.props, "heights"), false, "no baked heights prop");
    assert.equal(terrainFeature.props.procedural, true);
    assert.equal(typeof terrainFeature.props.proceduralSeed, "number");
    assert.equal(terrainFeature.props.heightEdits, "", "no sculpt yet");
    assert.equal(terrainFeature.props.proceduralExtent, document.settings.extent);
    assert.equal(terrainFeature.props.stoneLayer, false, "World draws the stone itself");
    for (const key of ["style", "height", "scale", "levels", "wildness", "erosion", "rocks"]) {
      assert.ok(key in terrainFeature.props, `${key} is one of the Procedural props World hands the terrain`);
    }
    assert.equal(Object.hasOwn(plan.features.find((feature) => feature.id === "terrain").props, "heights"), false);
    const overlay = createShapeOverlay(plan.fields, { key: plan.fieldKey, samples: plan.baseHeights });
    assert.equal(overlay.samples, plan.baseHeights);
    assert.equal(overlay.evaluate(5, -3, -999), plan.fields.sampleHeight(5, -3));
    assert.equal(overlay.evaluate(1e6, 1e6, -999), -999, "outside the field's extent falls back to the given base height");
  } finally {
    plan.dispose();
  }
});

test("a Terrain fed World's own fields and samples matches World's baked grid exactly", () => {
  const document = createWorldDocument({ surfaceMode: "procedural", sky: "off", forestDensity: 0, groundDensity: 0,
    layout: { mode: "study" }, settlement: { editableBuildings: false } });
  const plan = prepareWorldPlan(document);
  try {
    const terrainFeature = plan.generated.find((feature) => feature.id === "terrain");
    const { terrain } = makeTerrain({ ...terrainFeature.props }, { withPreRender: false });
    terrain.setShapeOverlay({}, createShapeOverlay(plan.fields, { key: plan.fieldKey, samples: plan.baseHeights }));
    assert.deepEqual(terrain.heightsArray, plan.baseHeights);
  } finally {
    plan.dispose();
  }
});

// `erodeHeightfield` (terrainErosion.js) is the stream-power pass the landscape
// runs on its macro grid; exercised here directly against a baked grid.
function bakeRawGrid(shape, extent, resolution) {
  const cols = resolution + 1, half = extent / 2, step = extent / resolution;
  const heights = new Float32Array(cols * cols);
  const work = {};
  for (let r = 0; r < cols; r++) {
    const z = -half + r * step;
    for (let c = 0; c < cols; c++) { shape.evaluate(c * step - half, z, work); heights[r * cols + c] = work.height; }
  }
  return heights;
}
function sumOf(heights) { let total = 0; for (const h of heights) total += h; return total; }

test("erosion: deterministic, no NaN/Infinity, and 0 is a byte-identical no-op", () => {
  const extent = 128, resolution = 96, step = extent / resolution;
  const raw = bakeRawGrid(createTerrainShape({ seed: 41, extent, terrain: { style: "highlands", erosion: 0 } }), extent, resolution);
  const a = raw.slice(), b = raw.slice();
  erodeHeightfield(a, resolution, { seed: 7, strength: .6, cellSize: step });
  erodeHeightfield(b, resolution, { seed: 7, strength: .6, cellSize: step });
  assert.deepEqual(a, b, "the same input erodes to the exact same grid");
  for (const h of a) assert.ok(Number.isFinite(h), "no NaN/Infinity anywhere in an eroded grid");
  const zero = raw.slice();
  erodeHeightfield(zero, resolution, { seed: 1, strength: 0, cellSize: step });
  assert.deepEqual(zero, raw, "erosion 0 keeps the raw grid byte-identical");
});

test("erosion: conserves total volume within 3%, and finishes 385x385 within budget", () => {
  const extent = 256, resolution = 384, step = extent / resolution;
  const raw = bakeRawGrid(createTerrainShape({ seed: 894, extent, terrain: { style: "hills" } }), extent, resolution);
  const eroded = raw.slice();
  const start = performance.now();
  erodeHeightfield(eroded, resolution, { seed: 1, strength: .6, cellSize: step });
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 700, `erosion at 385x385 finishes within budget (${elapsed.toFixed(1)} ms)`);
  const drift = Math.abs(sumOf(eroded) - sumOf(raw)) / Math.max(1, Math.abs(sumOf(raw)));
  assert.ok(drift <= .03, `total volume is conserved within 3% (${(drift * 100).toFixed(2)}%)`);
});
