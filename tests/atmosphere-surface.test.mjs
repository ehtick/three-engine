import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three/webgpu';
import { float, normalMap, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { createSurfaceUniforms, patchMaterial, weatherAlbedo, weatherRoughness, weatherMetalness } from '../src/modules/atmosphere/weatherSurface.js';

// Build actual installed Three WGSL without creating an adapter/device. These
// tests gate shader control flow; the separate GPU fixture gates pixel parity.
function buildSurface({ branch = true, authored = false, patcher = null } = {}) {
  const previous = globalThis.__atmosphereDrySurfaceBranch;
  globalThis.__atmosphereDrySurfaceBranch = branch;
  const renderer = new THREE.WebGPURenderer({ canvas: { width: 64, height: 64, style: {}, addEventListener() {}, setAttribute() {} } });
  renderer.backend.device = { features: new Set() }; renderer.hasFeature = () => false;
  const maps = Array.from({ length: 3 }, () => new THREE.DataTexture(new Uint8Array([127, 150, 200, 255]), 1, 1));
  const geometry = new THREE.PlaneGeometry(), material = new THREE.MeshStandardNodeMaterial();
  try {
    const u = createSurfaceUniforms();
    u.snow.setName('surfaceSnow'); u.wetness.setName('surfaceWetness');
    u.sky.mapNode = texture(maps[0]);
    const base = authored ? texture(maps[1]).setName('authoredColorMap').rgb : vec3(.3, .4, .5);
    const roughness = authored ? uniform(0).setName('authoredRoughness') : float(.4);
    if (authored) material.normalNode = normalMap(texture(maps[2]).setName('authoredNormalMap'), vec2(.7));
    if (patcher) {
      // Keep the native setupDiffuseColor -> setupVariants -> lighting order.
      // A custom fragment node alone misses cached normals initialized by the
      // weather wrapper before later native lighting reuses them.
      material.colorNode = base; material.roughnessNode = roughness; material.metalnessNode = float(.6);
      patcher(material, u);
    } else {
      const color = weatherAlbedo(base, u);
      material.fragmentNode = vec4(color.r, weatherRoughness(roughness, u), weatherMetalness(float(.6), u), 1);
    }
    const builder = renderer.backend.createNodeBuilder(new THREE.Mesh(geometry, material), renderer);
    builder.scene = new THREE.Scene(); builder.camera = new THREE.PerspectiveCamera(); builder.build();
    return builder.fragmentShader;
  } finally {
    globalThis.__atmosphereDrySurfaceBranch = previous;
    geometry.dispose(); material.dispose(); maps.forEach(map => map.dispose());
  }
}

function readScopes(shader) {
  const scopes = [], reads = [], clamps = [];
  let branches = 0;
  for (const raw of shader.split('\n')) {
    const line = raw.split('//')[0];
    const weatherGuard = /if\s*\([^\n]*surfaceSnow\s*!=\s*0\.0[^\n]*surfaceWetness\s*!=\s*0\.0/.test(line);
    if (weatherGuard) branches++;
    for (const char of line) {
      if (char === '{') scopes.push(weatherGuard || scopes.includes(true));
      else if (char === '}') scopes.pop();
    }
    if (/texture(?:Sample|Load)\s*\(/.test(line)) reads.push({ line, guarded: scopes.includes(true) });
    if (/clamp\( object\.authoredRoughness, 0\.02, 1\.0 \)/.test(line)) clamps.push({ line, guarded: scopes.includes(true) });
  }
  return { branches, reads, clamps };
}

function requireDrySkip(shader) {
  const { branches, reads } = readScopes(shader);
  const weather = reads.filter(read => !/authored(?:Color|Normal)Map/.test(read.line));
  assert.equal(branches, 3, 'each material weather channel has real uniform control flow');
  assert.equal(weather.length, 10, 'the fixture contains actual noise and roof sampling');
  assert.ok(weather.every(read => read.guarded), 'no weather texture read executes in the dry branch');
}

test('composed weather WGSL skips every dry noise/roof tap; the legacy graph fails the same gate', () => {
  requireDrySkip(buildSurface());
  const old = buildSurface({ branch: false });
  assert.equal(readScopes(old).reads.length, 10, 'the old arm retains every original texture read');
  assert.throws(() => requireDrySkip(old), /uniform control flow/);
});

test('dry control flow preserves authored texture/normal evaluation and original roughness clamp', () => {
  const shader = buildSurface({ authored: true });
  requireDrySkip(shader);
  const { reads, clamps } = readScopes(shader);
  const authored = reads.filter(read => /authored(?:Color|Normal)Map/.test(read.line));
  assert.equal(authored.length, 2, 'both authored albedo and normal maps reach the composed shader');
  assert.ok(authored.every(read => !read.guarded), 'dry weather cannot skip the material it wraps');
  assert.ok(clamps.some(clamp => !clamp.guarded), 'dry roughness retains the original [0.02,1] clamp');
});

test('native weather wrapper initializes authored normals outside its branch; omitted initialization reproduces the dark-material bug', async () => {
  const requireNativeNormal = shader => {
    const normalReads = readScopes(shader).reads.filter(read => /authoredNormalMap/.test(read.line));
    assert.equal(normalReads.length, 1, 'native normal map reaches the actual patched material');
    assert.ok(normalReads.every(read => !read.guarded), 'native lighting must receive its normal even when weather is dry');
  };
  requireNativeNormal(buildSurface({ authored: true, patcher: patchMaterial }));
  // Execute the production wrapper with only its explicit initialization
  // omitted; leave the workspace source intact for concurrent profiling.
  const location = new URL('../src/modules/atmosphere/weatherSurface.js', import.meta.url);
  const source = (await readFile(location, 'utf8')).replace('  normalWorld.toStack();', '')
    .replace(/from\s+(['"])([^'"]+)\1/g, (_, quote, specifier) => `from ${quote}${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}${quote}`);
  const negative = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.throws(() => requireNativeNormal(buildSurface({ authored: true, patcher: negative.patchMaterial })), /native lighting must receive its normal/);
});
