import * as THREE from 'three/webgpu';
import { createValleyFields } from '../../src/engine/world/landscapeFields.js';
import { createValleyEcology, sampleValleyPlanting } from '../../src/engine/world/valleyEcology.js';
import { createLandscapeMaterials, createLandscapeRocks } from './worldLandscapeStudy.js';
import { createStudyWaterSurface } from './worldWaterSurfaceStudy.js';
import { createCottageStudy, describeCottageStudy } from './worldCottageStudy.js';
import { resolveFeatureEdits } from '../../src/engine/world/featureEdits.js';
import { normalizeArchitectureModel } from '../../src/modules/architecture/formModel.js';

// Phase 0 study, deliberately separate from a production World component.
export const STUDY_EXTENT = 128;
export const STUDY_CAMERAS = {
  valley: { eye: [58, 48, 76], at: [-3, 5, -9] },
  shore: { eye: [-4, 2.8, 24], at: [-17, .4, -7] },
  cottage: { eye: [29, 5.7, 16], at: [22, 4.8, 6] },
  forest: { eye: [-25, 5, 23], at: [-35, 6, 3] },
};
let defaultFields;
const studyFields = () => defaultFields ??= createValleyFields();
export function createStudyDomain() { return studyFields().domain; }
export function studySurface(x, z) { return studyFields().sample(x, z); }
function encode(values) {
  const bytes = new Uint8Array(values.buffer); let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}

/** CPU surface for the fixed study. Extend valid elevations by one grid-cell
 * diagonal so a triangle at a wet/dry boundary cannot interpolate toward the
 * packed dry sentinel. The fragment mask still reads the one shared field.
 * Grid interpolation and raster shoreline coverage remain approximations;
 * this does not certify exact production water-surface/terrain parity. */
export function createStudyWaterGeometry(domain) {
  const segments = 256, step = STUDY_EXTENT / segments;
  const geometry = new THREE.PlaneGeometry(STUDY_EXTENT, STUDY_EXTENT, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute('position');
  // Half-cell offsets match the packed field's resolution. Search nearest
  // first, with a fixed order for equal distances and no extra GPU texture.
  const neighbors = [];
  for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) {
    if (x || z) neighbors.push({ x: x * step / 2, z: z * step / 2, distance2: x * x + z * z });
  }
  neighbors.sort((a, b) => a.distance2 - b.distance2 || a.z - b.z || a.x - b.x);
  const bounds = domain.bounds, margin = step * Math.SQRT2;
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index), z = positions.getZ(index);
    let sample = domain.sample(x, z);
    if (!sample && bounds && x >= bounds.minX - margin && x <= bounds.maxX + margin &&
        z >= bounds.minZ - margin && z <= bounds.maxZ + margin) {
      for (const offset of neighbors) {
        sample = domain.sample(x + offset.x, z + offset.z);
        if (sample) break;
      }
    }
    positions.setY(index, (sample?.height ?? 0) + .025);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function createValleyStudy(engine, { style = 'natural', baseline = false, seed = 894, forestDensity = 1, groundDensity = 1,
  geography = {}, vegetation = {}, detailMaps = null, surfaceScale = 1, surfaceBump = 1, cottageVariation = 8, roofColor = null } = {}) {
  const start = performance.now(), owned = [], populations = [];
  const fields = createValleyFields({ ...geography, seed, extent: STUDY_EXTENT, terrainStep: .5 });
  const root = engine.createEntity({ name: 'World · valley study' });
  const ground = engine.createEntity({ name: 'Terrain specimen' }); ground.setParent(root);
  const terrain = ground.addComponent('terrain', { size: STUDY_EXTENT, resolution: 256, splatResolution: 32, castShadow: true });
  const heights = new Float32Array(257 * 257), colors = new Float32Array(heights.length * 3);
  const surfaceFields = new Float32Array(heights.length * 4);
  const natural = style === 'natural';
  const grass = new THREE.Color(natural ? '#85855a' : '#94ae67');
  const shore = new THREE.Color(natural ? '#8f8066' : '#b4a47f');
  const forestFloor = new THREE.Color(natural ? '#646448' : '#6e874b');
  const wetBed = new THREE.Color(natural ? '#686353' : '#89856b');
  const rock = new THREE.Color('#858177'), color = new THREE.Color();
  for (let r = 0; r <= 256; r++) for (let c = 0; c <= 256; c++) {
    const x = c / 2 - 64, z = r / 2 - 64, sample = fields.sample(x, z), i = r * 257 + c;
    heights[i] = sample.height;
    const planting = sampleValleyPlanting(seed, x, z, vegetation.patchiness ?? .65);
    surfaceFields[i * 4] = Math.max(sample.path, (1 - THREE.MathUtils.smoothstep(sample.shore, .05, 3.2)) * .97,
      sample.forest * .55, planting.bare * .46);
    surfaceFields[i * 4 + 1] = sample.rock;
    surfaceFields[i * 4 + 2] = sample.moisture;
    surfaceFields[i * 4 + 3] = sample.forest;
    color.copy(grass).lerp(forestFloor, sample.forest * .7);
    color.lerp(shore, (1 - THREE.MathUtils.smoothstep(sample.shore, .1, 2.8)) * .85);
    color.lerp(rock, sample.rock * .85).lerp(shore, sample.path * .92);
    if (sample.shore < 0) color.copy(wetBed).lerp(shore, .25 + .12 * Math.sin(x * 1.7 + z));
    // Photographic albedo is already the material color. The vertex channel
    // supplies only broad modulation, avoiding a second dark color tint.
    if (detailMaps) color.setRGB(1, 1, 1).multiplyScalar(1 - sample.forest * .10);
    color.multiplyScalar(.94 + Math.sin(x * .6 + z * .13) * Math.sin(z * .7) * .06);
    color.toArray(colors, i * 3);
  }
  terrain.setProp('heights', encode(heights));
  terrain.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  terrain.geometry.setAttribute('worldSurface', new THREE.BufferAttribute(surfaceFields, 4));
  const materials = createLandscapeMaterials({ style, extent: STUDY_EXTENT, detailMaps, surfaceScale, surfaceBump });
  const groundMaterial = materials.groundMaterial; terrain.mesh.material = groundMaterial;
  owned.push(materials);
  // Match the actual terrain triangles so groundcover never floats over a
  // continuous height sample that differs from the rendered half-metre grid.
  const heightAt = (x, z) => {
    const px = THREE.MathUtils.clamp((x + 64) * 2, 0, 255.999999), pz = THREE.MathUtils.clamp((z + 64) * 2, 0, 255.999999);
    const col = Math.floor(px), row = Math.floor(pz), a = px - col, b = pz - row, i = row * 257 + col;
    return a + b <= 1 ? heights[i] * (1 - a - b) + heights[i + 1] * a + heights[i + 257] * b
      : heights[i + 258] * (a + b - 1) + heights[i + 1] * (1 - b) + heights[i + 257] * (1 - a);
  };

  const domain = fields.domain, resolution = 512;
  const packed = domain.rasterize({ minX: -64, minZ: -64, maxX: 64, maxZ: 64, width: resolution, height: resolution });
  const domainTexture = new THREE.DataTexture(packed, resolution, resolution, THREE.RGBAFormat, THREE.FloatType);
  domainTexture.needsUpdate = true; domainTexture.name = 'World study · shared water domain';
  const shoreData = new Float32Array(packed.length);
  for (let row = 0; row < resolution; row++) for (let col = 0; col < resolution; col++) {
    const x = (col + .5) / resolution * STUDY_EXTENT - 64, z = (row + .5) / resolution * STUDY_EXTENT - 64;
    const sample = fields.sample(x, z), i = (row * resolution + col) * 4;
    shoreData[i] = sample.shore; shoreData[i + 1] = Math.max(0, sample.waterLevel - heightAt(x, z));
    shoreData[i + 2] = packed[i + 2]; shoreData[i + 3] = packed[i + 3];
  }
  const shoreTexture = new THREE.DataTexture(shoreData, resolution, resolution, THREE.RGBAFormat, THREE.FloatType);
  shoreTexture.needsUpdate = true; shoreTexture.name = 'World study · shore and actual depth';
  const waterGeometry = createStudyWaterGeometry(domain);
  const waterSurface = createStudyWaterSurface({ domainTexture, shoreTexture, style, extent: STUDY_EXTENT });
  const water = new THREE.Mesh(waterGeometry, waterSurface.material); water.frustumCulled = false; water.receiveShadow = true;
  root.object3D.add(water); owned.push(domainTexture, shoreTexture, waterGeometry, waterSurface);

  const rocks = createLandscapeRocks({ sample: fields.sample, seed, extent: STUDY_EXTENT, style, rockMaterial: materials.rockMaterial });
  root.object3D.add(rocks); owned.push({ dispose: () => rocks.userData.dispose() });

  let cottage, cottageState = null, cottageSeed = cottageVariation, cottageEdits = roofColor ? [{ id: 'roof-paint', kind: 'override', target: 'cottage', property: 'roofColor', value: roofColor }] : [];
  const regenerateCottage = ({ repaint, reset = false, reseed = false } = {}) => {
    if (baseline) return null;
    let nextEdits = reset ? [] : cottageEdits;
    if (repaint) nextEdits = [{ id: 'roof-paint', kind: 'override', target: 'cottage', property: 'roofColor', value: repaint }];
    const nextSeed = cottageSeed + Number(reseed);
    const architecture = describeCottageStudy({ style, seed: nextSeed });
    const generatedRoof = architecture.roofColor;
    const resolved = resolveFeatureEdits([{ id: 'cottage', kind: 'building', props: { roofColor: generatedRoof } }], nextEdits);
    const replacement = createCottageStudy(THREE, { style, seed: nextSeed, roofColor: resolved.features[0].props.roofColor });
    replacement.position.set(22, 2.2, 6);
    cottage?.removeFromParent(); cottage?.userData.dispose();
    cottage = replacement; root.object3D.add(cottage);
    cottageSeed = nextSeed; cottageEdits = nextEdits;
    cottageState = { seed: cottageSeed, architecture, generatedRoofColor: generatedRoof,
      roofColor: resolved.features[0].props.roofColor, edits: structuredClone(cottageEdits), orphanEdits: resolved.orphanEdits };
    return structuredClone(cottageState);
  };
  if (baseline) {
    const house = engine.createEntity({ name: 'Existing architecture baseline' }); house.setParent(root); house.position.set(22, 2.2, 6);
    house.addComponent('architecture', { model: normalizeArchitectureModel({ forms: [{ id: 'cottage', size: [8, 4, 6], color: '#d7c9aa', roof: 'hip', roofHeight: 2 }] }) });
  } else {
    regenerateCottage(); owned.push({ dispose: () => cottage?.userData.dispose() });
  }
  const ecology = createValleyEcology(fields, { seed, forestDensity, groundDensity, heightAt, vegetation });
  for (const population of ecology.groups) {
    const entity = engine.createEntity({ name: `World · ${population.id}` }); entity.setParent(root);
    const props = { ...population.props, placements: population.placements };
    if (!natural) props.leafColor = ['grass', 'wildflowers'].includes(props.species) ? '#93ad60' : '#75a45b';
    populations.push(entity.addComponent('foliage', props));
  }
  const off = engine.onUpdate(() => waterSurface.update(engine.elapsedTime ?? performance.now() / 1000));
  // Materials borrow maps; dispose them before retiring the shared textures.
  if (detailMaps) owned.push(detailMaps);
  return { root, terrain, fields, heightAt, ecology, water, waterSurface, rocks, shoreTexture, seed, forestDensity, groundDensity,
    surfaceMaps: detailMaps, surfaceScale, surfaceBump, vegetation: ecology.vegetation,
    domain, packed, domainTexture, populations, regenerateCottage, cpuBuildMs: performance.now() - start,
    get cottageState() { return structuredClone(cottageState); },
    get cottage() { return cottage; },
    prepareMaterials() { terrain.mesh.material = groundMaterial; },
    dispose() { this.depthPrepass?.dispose(); off(); engine.destroyEntity(root); owned.forEach(resource => resource.dispose()); },
  };
}
