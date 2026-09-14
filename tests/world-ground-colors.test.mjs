import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { resolveGroundPalette } from "../src/modules/terrain/terrainGround.js";
import { worldStageKey } from "../src/modules/world/worldPlanData.js";
import { worldDefaultSettings } from "../src/engine/world/worldConfig.js";
import { grassSwardTones, deriveGrassBaseColor } from "../src/modules/foliage/grassField.js";
import { makeGroundPalette, paintGroundVertex, FIELD_STRIDE, effectiveSwardSettings, swardMeanColor, worldStreamPalette, terrainGroundColorProps } from "../src/modules/world/worldPlanData.js";

// 09-14 owner: terrain colour controls on the Terrain component, and grass that
// meets the terrain so its draw distance reads as a transition, not an edge.

test("Terrain custom colours override the style palette only when enabled", () => {
  const style = { grass: "#111111", soil: "#222222", rock: "#333333", snow: "#eeeeee" };
  assert.equal(resolveGroundPalette(style, { customColors: false, grassColor: "#abcdef" }), style);
  assert.deepEqual(resolveGroundPalette(style, { customColors: true, grassColor: "#00ff00", soilColor: "#884400", rockColor: "#777777" }),
    { grass: "#00ff00", soil: "#884400", rock: "#777777", snow: "#eeeeee" });
});

test("sward tones carry the renderer's sRGB clamps", () => {
  const { tip, base, dry } = grassSwardTones("#617e11", "#ffffff");
  const hsl = { h: 0, s: 0, l: 0 };
  tip.getHSL(hsl, THREE.SRGBColorSpace);
  assert.ok(hsl.s <= .6 + 1e-6 && hsl.l <= .48 + 1e-6, `tip ${JSON.stringify(hsl)}`);
  assert.deepEqual(base.toArray().map((v) => +v.toFixed(6)), deriveGrassBaseColor(tip.toArray()).map((v) => +v.toFixed(6)));
  dry.getHSL(hsl, THREE.SRGBColorSpace);
  assert.ok(hsl.s <= .5 + 1e-6 && hsl.l <= .54 + 1e-6, `dry ${JSON.stringify(hsl)}`);
});

test("the region palette paints ground toward the tones the blades are drawn with, not the raw swatch", () => {
  const grass = { enabled: true, density: .85, color: "#617e11", dryColor: "#a89b5c" };
  const palette = makeGroundPalette({ style: "natural", detailMaps: null, grassSettings: grass });
  const drawn = grassSwardTones(grass.color, grass.dryColor);
  assert.ok(palette.swardTip.equals(drawn.tip));
  assert.ok(palette.swardBase.equals(drawn.base));
  assert.ok(!palette.swardTip.equals(new THREE.Color(grass.color)), "saturated swatch must not be used raw");
});

test("the meadow population's own colour override wins over the World grass table", () => {
  const grass = { enabled: true, density: .85, color: "#7c9448", dryColor: "#a89b5c" };
  assert.equal(effectiveSwardSettings(grass, null), grass);
  assert.deepEqual(effectiveSwardSettings(grass, { leafColor: "#585a07", dryColor: "#2b590d", grassDensity: 1 }),
    { enabled: true, density: 1, color: "#585a07", dryColor: "#2b590d" });
});

test("streamed ground wears the Ground swatches exactly as picked, whatever the sward's colour", () => {
  const base = { grass: "#5f7a3a", soil: "#6f624c", rock: "#77736c", snow: null };
  const settings = { ground: { meadow: "#9bbd28", soil: "#8f8066", rock: "#dfdbd3" }, grass: { enabled: true, density: .85, color: "#585a07", dryColor: "#2b590d" } };
  assert.deepEqual(worldStreamPalette(base, settings), { grass: "#9bbd28", soil: "#8f8066", rock: "#dfdbd3", snow: null });
  assert.notEqual(`#${swardMeanColor(settings.grass).getHexString()}`, "#9bbd28");
});

test("a World's Terrain shows the Ground swatches as its colours", () => {
  assert.deepEqual(terrainGroundColorProps({ meadow: "#010203", soil: "#040506", rock: "#070809" }),
    { customColors: true, grassColor: "#010203", soilColor: "#040506", rockColor: "#070809" });
});

test("region ground under a sward keeps the picked terrain colour by default", () => {
  const grass = { enabled: true, density: 1, color: "#585a07", dryColor: "#2b590d" };
  const ground = { meadow: "#9bbd28", soil: "#8f8066", rock: "#dfdbd3" };
  // One deeply covered, dry, clean meadow vertex.
  const fieldCache = new Float32Array(FIELD_STRIDE); fieldCache[1] = 50; fieldCache[3] = .8;
  const grid = { resolution: 0, step: 1, half: 0 };
  const paint = () => {
    const tint = new Float32Array(3), colors = new Float32Array(3);
    paintGroundVertex(makeGroundPalette({ style: "natural", detailMaps: null, grassSettings: grass, groundSettings: ground }), fieldCache, 0, grid, 1, 0, tint, colors);
    return [...colors];
  };
  const picked = new THREE.Color(ground.meadow).toArray();
  const hueOf = (c) => { const l = Math.hypot(...c) || 1; return c.map((v) => v / l); };
  const near = (a, b) => Math.hypot(...hueOf(a).map((v, i) => v - hueOf(b)[i])) < .08;
  assert.ok(near(paint(), picked), `default keeps the meadow hue: ${paint()} vs ${picked}`);
  globalThis.__swardTintsGround = true;
  try { assert.ok(!near(paint(), picked), "the legacy pull (hatch on) drags it toward the olive sward"); }
  finally { delete globalThis.__swardTintsGround; }
});

test("a Ground colour edit is a look change: no data stage (field, scatter, grass pack) is invalidated", () => {
  const a = worldDefaultSettings(), b = structuredClone(a);
  b.ground = { ...b.ground, meadow: "#ff00ff", soil: "#00ff00", rock: "#0000ff" };
  for (const stage of ["layout", "field", "scatter"]) assert.equal(worldStageKey(b, [stage]), worldStageKey(a, [stage]), stage);
  assert.notEqual(worldStageKey(b, ["look"]), worldStageKey(a, ["look"]));
});
