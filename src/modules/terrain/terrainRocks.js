import * as THREE from 'three/webgpu';
import { attribute, positionWorld } from 'three/tsl';
import { buildRockLibrarySteps, instanceScale } from '../../engine/rocks/rockLibrary.js';
import { placeRocks, rockKindsFor } from '../../engine/rocks/rockPlacement.js';

/**
 * Stone for a terrain rectangle (09-14): the rock library's SDF-meshed
 * variants, placed by `rockPlacement.js` from the landscape's own cliff and
 * tower masks, drawn as one InstancedMesh per variant. Owned by the Terrain
 * module; World calls the same builder with its composed heights and an
 * `accept` that keeps stone off water, roads and building pads.
 *
 * The library is cached per (style, kinds): every terrain of a style shares
 * one set of meshes, so only the first build of a style pays the meshing
 * (~1-2 s; T4 moves it into the world worker).
 */

const libraries = new Map();
const clamp = (v, lo = 0, hi = 1) => v < lo ? lo : v > hi ? hi : v;
const smoothstep = (lo, hi, v) => { const t = clamp((v - lo) / (hi - lo)); return t * t * (3 - 2 * t); };

function styleSeed(style) {
  let h = 0x811c9dc5;
  for (let i = 0; i < style.length; i++) h = Math.imul(h ^ style.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Resumable: meshing a style's library is the expensive part of stone
 * (~1-2 s), so callers with a frame loop drive this with a clock. */
export function* rockLibraryStepsFor(landscape, variants = 3, clock = { due: () => false }) {
  const kinds = rockKindsFor(landscape, variants);
  const columnar = (landscape.rockMix?.columns ?? 0) > .5 ? 1 : 0;
  const key = JSON.stringify([landscape.options.style, kinds, columnar]);
  let library = libraries.get(key);
  if (!library) {
    // Default `lodShares` (~22 % / ~5 %): the World streamer draws those LODs
    // past its first ring (`worldStreaming.js`, ROCK_LOD_DISTANCES).
    library = yield* buildRockLibrarySteps({ seed: styleSeed(landscape.options.style), kinds, columnar }, clock);
    libraries.set(key, library);
    while (libraries.size > 6) libraries.delete(libraries.keys().next().value);
  }
  return { library, kinds };
}

export function rockLibraryFor(landscape, variants = 3) {
  const steps = rockLibraryStepsFor(landscape, variants);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

/** Vertex colour carries the stone tint, cavity occlusion and moss on tops. */
export function variantGeometry(variant, palette) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(variant.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(variant.normals, 3));
  const rock = new THREE.Color(palette?.rock ?? '#858177'), moss = new THREE.Color(palette?.grass ?? '#5f7a3a').multiplyScalar(.8);
  const color = new THREE.Color(), colors = new Float32Array(variant.positions.length);
  for (let v = 0; v < variant.positions.length / 3; v++) {
    const ny = variant.normals[v * 3 + 1], ao = variant.occlusion ? variant.occlusion[v] : .8;
    color.copy(rock).lerp(moss, smoothstep(.72, .95, ny) * .6).multiplyScalar(.4 + .6 * ao);
    color.toArray(colors, v * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(variant.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

export function createRockMaterial() {
  // ⛔ 09-14: NOT `vertexColors: true` — colorNode below already multiplies the
  // `color` attribute, and three multiplies it AGAIN when the flag is on, so every
  // picked colour rendered squared (a #9bbd28 meadow as dark olive-brown).
  const material = new THREE.MeshStandardNodeMaterial({ roughness: .92, metalness: 0 });
  // A faint bedding banding along world height; the SDF already carries the form.
  material.colorNode = attribute('color', 'vec3').mul(positionWorld.y.mul(1.9).add(positionWorld.x.mul(.07)).sin().mul(.035).add(1));
  material.name = 'Terrain stone';
  return material;
}

/**
 * @param {{ landscape: object, x0: number, z0: number, size: number,
 *   groundAt?: (x:number, z:number) => number, accept?: (x:number, z:number, radius:number) => boolean,
 *   material?: THREE.Material | null, variants?: number,
 *   library?: object | null, kinds?: Record<string, number> | null, placements?: object[] | null }} options  coordinates are landscape metres
 */
export function createTerrainStone({ landscape, x0, z0, size, groundAt = null, accept = null, material = null, variants = 3, library: prebuilt = null, kinds: prebuiltKinds = null, placements: prebuiltPlacements = null }) {
  // A caller that sliced the meshing and placement (TerrainComponent) hands both in.
  const { library, kinds } = prebuilt ? { library: prebuilt, kinds: prebuiltKinds } : rockLibraryFor(landscape, variants);
  const placements = prebuiltPlacements ?? placeRocks(landscape, { x0, z0, size, variants: kinds, groundAt, accept });
  const group = new THREE.Group();
  group.name = 'Terrain stone';
  const buckets = new Map();
  for (const placement of placements) {
    const list = library.variants[placement.kind];
    if (!list?.length) continue;
    const variant = list[placement.variant % list.length], key = `${placement.kind}:${variant.index}`;
    if (!buckets.has(key)) buckets.set(key, { variant, items: [] });
    buckets.get(key).items.push(placement);
  }
  const ownedMaterial = material ? null : createRockMaterial();
  const drawMaterial = material ?? ownedMaterial;
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), position = new THREE.Vector3(), scale = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const geometries = [];
  let triangles = 0;
  for (const { variant, items } of buckets.values()) {
    const geometry = variantGeometry(variant, landscape.palette);
    geometries.push(geometry);
    const mesh = new THREE.InstancedMesh(geometry, drawMaterial, items.length);
    items.forEach((placement, index) => {
      const [sx, sy, sz] = instanceScale(placement, variant);
      matrix.compose(position.fromArray(placement.position), rotation.setFromAxisAngle(up, placement.yaw), scale.set(sx, sy, sz));
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    mesh.name = `Stone · ${variant.kind} ${variant.index}`;
    mesh.userData.worldStudyRole = 'rock';
    triangles += variant.indices.length / 3 * items.length;
    group.add(mesh);
  }
  const counts = {};
  for (const placement of placements) counts[placement.kind] = (counts[placement.kind] ?? 0) + 1;
  group.userData.stats = { placements: placements.length, counts, drawCalls: group.children.length, triangles };
  let disposed = false;
  return {
    group, placements,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const geometry of geometries) geometry.dispose();
      ownedMaterial?.dispose();
      group.removeFromParent();
    },
  };
}
