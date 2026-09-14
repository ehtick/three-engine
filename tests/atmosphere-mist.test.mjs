import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three/webgpu";
import {
  WEATHER_CHANNELS, WEATHER_NAMES, WEATHER_PRESETS, blendWeather, scaleWeather, weatherPreset,
} from "../src/modules/atmosphere/weather.js";
import { createHeightFog, updateHeightFog } from "../src/modules/atmosphere/heightFogNode.js";
import { AtmosphereComponent } from "../src/modules/atmosphere/AtmosphereComponent.js";

/**
 * Valley mist (height fog). No GPU here: the claims that can break without
 * one are the weather channel's plumbing, the authored defaults that keep
 * every existing preset pixel-identical, and that the fog node builds as a
 * pure uniform-driven graph with no texture taps — the renderer's sampler
 * budget is already spent (see `heightFogNode.js`).
 */

test("every preset carries a finite mist channel", () => {
  assert.equal(typeof WEATHER_CHANNELS.mist, "number");
  for (const name of WEATHER_NAMES) {
    assert.ok(Object.hasOwn(WEATHER_PRESETS[name], "mist"), `${name} authors mist explicitly`);
    assert.ok(Number.isFinite(weatherPreset(name).mist), `${name}.mist is finite`);
  }
});

test("the documented preset values are the ones shipped", () => {
  // ⛔ Pixel-identity lives here: the weathers that must not change carry 0,
  // so their `conditions.mist` is 0, the mist uniform stays 0 and the fog
  // node collapses to the legacy FogExp2 term exactly.
  const expected = {
    clear: 0, fair: 0, cloudy: 0, overcast: 0.15, fog: 0.8,
    drizzle: 0.35, rain: 0.2, storm: 0.2, snow: 0, blizzard: 0.3,
  };
  for (const name of WEATHER_NAMES) assert.equal(WEATHER_PRESETS[name].mist, expected[name], name);
});

test("blending and severity interpolate mist like any channel", () => {
  const half = blendWeather(weatherPreset("clear"), weatherPreset("fog"), 0.5);
  assert.ok(Math.abs(half.mist - 0.4) < 1e-12);
  assert.equal(blendWeather(weatherPreset("clear"), weatherPreset("fog"), 7).mist, 0.8);
  // Severity blends towards CLEAR, so a weaker fog is less misty, never more.
  const mild = scaleWeather(weatherPreset("fog"), 0.25);
  assert.ok(mild.mist > 0 && mild.mist < 0.8);
});

test("the component's defaults keep the mist off", () => {
  // The node is installed at attach regardless; these are what keep every
  // existing scene's pixels identical.
  const d = AtmosphereComponent.defaults;
  assert.equal(d.heightFog, false);
  assert.equal(d.heightFogDensity, 0.35);
  assert.ok(Number.isFinite(d.heightFogBase) && d.heightFogBase === 0);
  assert.ok(d.heightFogFalloff > 0);
  assert.equal(d.heightFogNoise, 0.5);
});

test("the fog node builds without a renderer, all-zero by default", () => {
  const target = createHeightFog();
  assert.ok(target.node && target.uniforms, "factory shape");
  const u = target.uniforms;
  assert.equal(u.exp2Density.value, 0);
  assert.equal(u.mistDensity.value, 0);
  assert.equal(u.baseLevel.value, 0);
  assert.ok(u.falloff.value > 0);
  // ⛔ NO TEXTURE, EVER — the sampler budget is spent (foliage + GI sit at
  // the portable 16), so the banks are hashed value noise. Belt and braces:
  // walk the graph AND the source, because a future edit adding a `texture()`
  // call must fail here, not in a binding-limit validation error at runtime.
  let textures = 0;
  target.node.traverse((n) => { if (n.isTextureNode) textures++; });
  assert.equal(textures, 0);
});

test("the fog node source never samples a texture", async () => {
  const source = await readFile(new URL("../src/modules/atmosphere/heightFogNode.js", import.meta.url), "utf8");
  assert.ok(!/texture\s*\(/.test(source), "heightFogNode.js must stay procedural");
  // ⛔ The WGSL trap this module shares with the sky: a descending smoothstep
  // is UNDEFINED. Ascending edges only.
  for (const m of source.matchAll(/smoothstep\(([^,]+),([^,]+),/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (Number.isFinite(a) && Number.isFinite(b)) assert.ok(a < b, `smoothstep(${a}, ${b}) is descending`);
  }
});

test("the composed fog WGSL is sampler-free and really contains the mist", () => {
  // Built through the actual node builder, the same way atmosphere-surface
  // gates its control flow: a TSL graph that throws while building fails
  // silently as an invisible object, and a texture tap here would spend a
  // sampler the renderer no longer has — neither shows up without a build.
  const renderer = new THREE.WebGPURenderer({ canvas: { width: 64, height: 64, style: {}, addEventListener() {}, setAttribute() {} } });
  renderer.backend.device = { features: new Set() }; renderer.hasFeature = () => false;
  const target = createHeightFog();
  updateHeightFog(target, { exp2Density: 0.02, mistDensity: 0.002, baseLevel: 3, falloff: 8, noiseStrength: 0.5 });
  const geometry = new THREE.PlaneGeometry(), material = new THREE.MeshStandardNodeMaterial();
  try {
    const builder = renderer.backend.createNodeBuilder(new THREE.Mesh(geometry, material), renderer);
    builder.scene = new THREE.Scene(); builder.camera = new THREE.PerspectiveCamera();
    builder.fogNode = target.node;
    builder.build();
    const wgsl = builder.fragmentShader;
    assert.equal((wgsl.match(/textureSample|textureLoad/g) || []).length, 0, "no texture taps");
    assert.equal((wgsl.match(/var<storage/g) || []).length, 0, "no storage buffers");
    // The PCG hash's final shift-xor and the two-octave weights: proof the
    // noise — and therefore the whole factor chain feeding it — compiled in.
    assert.ok(wgsl.includes("2.3283064365386963e-10"), "the hashed lattice is in the shader");
    assert.ok((wgsl.match(/exp\(/g) || []).length >= 3, "exp2, mist distance and height falloff all compile");
  } finally {
    geometry.dispose(); material.dispose();
  }
});

test("updateHeightFog clamps garbage and passes the good through", () => {
  const target = createHeightFog();
  const u = target.uniforms;
  updateHeightFog(target, {
    mistDensity: NaN, exp2Density: -4, baseLevel: Infinity, falloff: -3,
    noiseStrength: 9, noiseScale: 0, driftX: NaN, driftY: 2.5, color: [0.1, NaN, 0.3],
  });
  assert.equal(u.mistDensity.value, 0, "NaN density becomes no mist");
  assert.equal(u.exp2Density.value, 0, "negative density clamps to 0");
  assert.equal(u.baseLevel.value, 0, "a non-finite base is 0, not NaN");
  assert.equal(u.falloff.value, 0.05, "falloff clamps to its floor");
  assert.equal(u.noiseStrength.value, 1);
  assert.ok(u.noiseScale.value >= 1e-5);
  assert.equal(u.drift.value.x, 0);
  assert.equal(u.drift.value.y, 2.5);
  assert.equal(u.color.value.g, 0.5, "NaN channel falls back");
  assert.ok(Math.abs(u.color.value.r - 0.1) < 1e-7 && Math.abs(u.color.value.b - 0.3) < 1e-7);
  updateHeightFog(target, { mistDensity: 0.004, baseLevel: -12.5, falloff: 8, driftX: 3.25 });
  assert.equal(u.mistDensity.value, 0.004);
  assert.equal(u.baseLevel.value, -12.5);
  assert.equal(u.drift.value.x, 3.25);
  // A null target is a no-op, not a throw — detach order must not matter.
  assert.doesNotThrow(() => updateHeightFog(null, { mistDensity: 1 }));
});
