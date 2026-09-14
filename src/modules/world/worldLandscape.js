import * as THREE from 'three/webgpu';
import { attribute, bumpMap, mix, normalWorldGeometry, positionWorld, texture, triplanarTexture, vec2, vec3 } from 'three/tsl';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { worldRandom } from '../../engine/world/worldLayout.js';
import { applyGroundSurfaceMaps } from './worldSurfaceMaps.js';

// Phase-0 geology specimen. All positions/dimensions are metres; sampling and
// geometry are deterministic CPU work. Materials bind sampled textures only.
const clamp = THREE.MathUtils.clamp;
const smooth = THREE.MathUtils.smoothstep;
const TAU = Math.PI * 2;
const LIMITS = Object.freeze({ outcrops: 12, boulders: 76, talus: 144, pebbles: 180, spires: 28, spireCeiling: 112 });
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
// Every angular rock piece re-creases at this one shared, narrow angle. A 6-8
// sided joint block's adjacent side faces sit 45-60 degrees apart (360/n); any
// crease threshold anywhere near that (the old .28-.43*PI = 50-77 degrees)
// smooths those neighbours together and the whole prism reads as a smooth
// rounded column — a pillar's rounded cap — regardless of its proportions.
// 20 degrees stays below the tightest n=8 case, so every side facets.
const FACET_ANGLE = Math.PI / 9;

function randomStream(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function hash(x, z, seed = 481) {
  let value = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ seed;
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967296;
}

function tiledNoise(u, v, cells, seed, rows = cells) {
  const x = u * cells, z = v * rows, ix = Math.floor(x), iz = Math.floor(z);
  const tx = x - ix, tz = z - iz, sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const value = (a, b) => hash((a % cells + cells) % cells, (b % rows + rows) % rows, seed);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(value(ix, iz), value(ix + 1, iz), sx),
    THREE.MathUtils.lerp(value(ix, iz + 1), value(ix + 1, iz + 1), sx), sz);
}

// Eroded bedding is predominantly directional. Each seam has its own height
// and interrupted run, while rare cross-joints terminate within those beds.
// No per-cell face colors or closed crack network: these read as fitted paving.
function stoneRelief(u, v) {
  const warp = (tiledNoise(u, v, 3, 621) - .5) * .58 + (tiledNoise(u, v, 9, 953) - .5) * .10;
  const bedding = v * 9 + warp, row = Math.floor(bedding), wrappedRow = (row % 9 + 9) % 9;
  const seamHeight = .20 + hash(wrappedRow, 0, 371) * .56;
  const exposedRun = smooth(tiledNoise(u, (wrappedRow + .5) / 9, 7, 683, 9), .35, .72);
  const seam = (1 - smooth(Math.abs(bedding - row - seamHeight), .015, .065)) * exposedRun;
  const cross = u * 5 + (tiledNoise(u, v, 3, 897) - .5) * .45;
  const column = Math.floor(cross), wrappedColumn = (column % 5 + 5) % 5;
  const jointHeight = .23 + hash(wrappedColumn, 0, 421) * .50;
  const joint = (1 - smooth(Math.abs(cross - column - jointHeight), .012, .045))
    * smooth(tiledNoise(u, v, 4, 827, 7), .60, .82);
  const broad = tiledNoise(u, v, 3, 991);
  const layers = tiledNoise(u, v + warp / 9, 4, 983, 23);
  return .46 + (broad - .5) * .13 + (layers - .5) * .10 - seam * .085 - joint * .045;
}

function detailTexture() {
  const size = 256, data = new Uint8Array(size * size * 4);
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const u = (x + .5) / size, v = (z + .5) / size;
    const broad = tiledNoise(u, v, 4, 732), soil = tiledNoise(u, v, 17, 219), grit = tiledNoise(u, v, 61, 993);
    const i = (z * size + x) * 4;
    data[i] = Math.round((.39 + soil * .23 + grit * .07) * 255);
    data[i + 1] = Math.round((.34 + grit * .30 + hash(x, z) * .10) * 255);
    data[i + 2] = Math.round((stoneRelief(u, v) + (soil - .5) * .018) * 255);
    data[i + 3] = Math.round((.25 + broad * .50) * 255);
  }
  const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  map.name = 'World landscape · packed soil, grit, stone relief and weathering';
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.minFilter = THREE.LinearMipmapLinearFilter; map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = true; map.anisotropy = 4; map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  return map;
}

function sampleStone(map, scale) {
  const normal = normalWorldGeometry.abs().pow(4);
  const weights = normal.div(normal.x.add(normal.y).add(normal.z));
  const bedHeight = positionWorld.y.add(positionWorld.x.mul(.14)).sub(positionWorld.z.mul(.09));
  // Both cliff projections share world height as V. Ordinary triplanar YZ/XY
  // mapping turns horizontal bedding vertical on one side of a formation.
  return texture(map, vec2(positionWorld.z, bedHeight).mul(scale)).mul(weights.x)
    .add(texture(map, positionWorld.xz.mul(scale)).mul(weights.y))
    .add(texture(map, vec2(positionWorld.x, bedHeight).mul(scale)).mul(weights.z));
}

function makeRockMaterial(map, style) {
  const stylized = style === 'stylized';
  // ⛔ 09-14: NOT `vertexColors: true` — colorNode below already multiplies the
  // `color` attribute, and three multiplies it AGAIN when the flag is on, so every
  // picked colour rendered squared (a #9bbd28 meadow as dark olive-brown).
  const material = new THREE.MeshStandardNodeMaterial({ roughness: .87, metalness: 0 });
  // Mapping weights must use the unperturbed normal: this sampled height also
  // feeds normalNode, so reading the final normal here introduces feedback.
  const projectionNormal = normalWorldGeometry.abs().pow(4);
  const rock = sampleStone(map, .16);
  const weather = texture(map, positionWorld.xz.mul(.09));
  const modulation = rock.b.sub(.46).mul(stylized ? .25 : .60).add(1)
    .mul(weather.a.sub(.5).mul(stylized ? .12 : .25).add(1));
  const mineral = mix(vec3(.94, .97, .94), vec3(1.07, 1.03, .94), weather.a.smoothstep(.27, .72));
  // ⛔ THIS WAS PURE WHITE. `mineral` is a weathering TINT (it only ever
  // strays a few percent from 1), not a base albedo — but colorNode used it
  // alone, so every rock rendered at ~0.94-1.07 regardless of the grey-brown/
  // moss/wet-contact colour `add()` paints into the `color` vertex attribute
  // below. That attribute is the actual stone albedo; mineral only modulates it.
  material.colorNode = attribute('color', 'vec3').mul(mineral).mul(modulation);
  const normalRock = sampleStone(map, .16);
  const normalGrit = triplanarTexture(texture(map), null, null, 1.9, positionWorld, projectionNormal);
  material.normalNode = bumpMap(normalRock.b.mul(.90).add(normalGrit.g.mul(.035)), stylized ? .11 : .26);
  // Wet contact vertices are darker; reuse their existing color for roughness
  // rather than adding another per-vertex buffer or a world field binding.
  material.roughnessNode = attribute('color', 'vec3').r.mul(1.8).add(.34).clamp(.44, .96);
  material.name = `World landscape · ${style} layered stone`;
  return material;
}

/** Ground consumes the caller's terrain vertex colors. The returned disposer
 * owns both materials and their shared texture; it is safe to call twice. */
export function createLandscapeMaterials({ style = 'natural', extent = 128, detailMaps = null, surfaceScale = 1, surfaceBump = 1 } = {}) {
  const map = detailTexture(), stylized = style === 'stylized';
  const detailScale = 1 / clamp(finite(surfaceScale, 1), .5, 2), bumpStrength = clamp(finite(surfaceBump, 1), 0, 2);
  // ⛔ 09-14: NOT `vertexColors: true` — colorNode below already multiplies the
  // `color` attribute, and three multiplies it AGAIN when the flag is on, so every
  // picked colour rendered squared (a #9bbd28 meadow as dark olive-brown).
  const groundMaterial = new THREE.MeshStandardNodeMaterial({ roughness: .94, metalness: 0 });
  const soil = texture(map, positionWorld.xz.mul(.68 * detailScale));
  const grain = texture(map, positionWorld.xz.mul(5.4 * detailScale));
  const broad = texture(map, positionWorld.xz.mul(.055));
  const rock = sampleStone(map, .12 * detailScale);
  // A 35–50 degree exposure must read as rock, not a faint addition of rock
  // grain to soil. Weathering breaks up both the boundary and the stone faces.
  const exposure = normalWorldGeometry.y.abs().oneMinus().add(broad.a.sub(.5).mul(.075)).smoothstep(.10, .38);
  // Keep normal sampling separate from color: cached sample results cannot
  // be shifted by BumpMapNode's derivative contexts after color compiled them.
  const normalSoil = texture(map, positionWorld.xz.mul(.68 * detailScale));
  const normalGrain = texture(map, positionWorld.xz.mul(5.4 * detailScale));
  const normalRock = sampleStone(map, .12 * detailScale);
  const soilRelief = normalSoil.r.mul(.29).add(normalGrain.g.mul(.025));
  const relief = mix(soilRelief, normalRock.b.mul(.95).add(normalSoil.r.mul(.045)), exposure);
  const soilColor = vec3(soil.r.sub(.5).mul(stylized ? .16 : .38).add(1)
    .mul(grain.g.sub(.5).mul(stylized ? .05 : .10).add(1))
    .mul(broad.a.sub(.5).mul(stylized ? .16 : .35).add(1)));
  const stoneColor = mix(vec3(.90, .94, .90), vec3(1.11, 1.035, .90), broad.a.smoothstep(.27, .72))
    .mul(rock.b.sub(.46).mul(stylized ? .30 : .70).add(1))
    .mul(broad.a.sub(.5).mul(stylized ? .15 : .28).add(1));
  // Use the function form: TSL's chained t.mix(a, b) treats t as the factor.
  // ⛔ THIS WAS GREYSCALE. The plan already computes a real palette per vertex —
  // meadow, forest, shore, exposed rock, river bed — uploads it as the `color`
  // attribute, and this node ignored it, so procedural ground rendered as
  // uniform sand no matter what the landscape underneath it actually was.
  groundMaterial.colorNode = mix(soilColor, stoneColor, exposure).mul(attribute('color', 'vec3'));
  groundMaterial.normalNode = bumpMap(relief, (stylized ? .11 : .24) * bumpStrength);
  groundMaterial.roughnessNode = mix(soil.r.mul(.16).add(.80), rock.a.mul(.14).add(.78), exposure);
  groundMaterial.name = `World landscape · ${style} soil and grass relief`;
  groundMaterial.userData.landscape = { extent: clamp(finite(extent, 128), 16, 512), mapping: 'world metres', packedTextures: 1,
    surfaceMode: 'procedural', surfaceScale: 1 / detailScale, surfaceBump: bumpStrength };
  if (detailMaps) applyGroundSurfaceMaps(groundMaterial, detailMaps, { scale: surfaceScale, bump: surfaceBump });
  const rockMaterial = makeRockMaterial(map, style);
  let disposed = false;
  return { groundMaterial, rockMaterial, dispose() {
    if (disposed) return;
    disposed = true; groundMaterial.dispose(); rockMaterial.dispose(); map.dispose();
  } };
}

// Unequal polygon sides and wedge faces form joint-bounded stone. Four rings
// retain broad planar fractures while their independent edge cuts chip the
// silhouette; no rectangular footprint or repeated chamfer is required.
function fracturedBlock(width, height, depth, random, weathered = false, foundation = false) {
  const n = 6 + Math.floor(random() * 3), phase = random() * TAU;
  const outline = Array.from({ length: n }, (_, i) => {
    const angle = phase + (i + (random() - .5) * .30) / n * TAU;
    const radius = .40 + random() * .10;
    return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius,
      lowerCut: .04 + random() * (weathered ? .22 : .14), upperCut: .035 + random() * (weathered ? .24 : .20),
      topScale: (weathered ? .54 : .70) + random() * (weathered ? .38 : .26) };
  });
  const leanX = (random() - .5) * .12, leanZ = (random() - .5) * .12;
  const wedgeX = (random() - .5) * .36, wedgeZ = (random() - .5) * .28;
  const positions = [], indices = [];
  for (let row = 0; row < 4; row++) for (const { x, z, lowerCut, upperCut, topScale } of outline) {
    const y = [-.5, -.5 + lowerCut, .5 - upperCut, .5][row];
    const scale = [1 - lowerCut, 1, topScale, topScale * (1 - upperCut)][row];
    positions.push((x * scale + leanX * (y + .5)) * width,
      (y + x * wedgeX + z * wedgeZ) * height, (z * scale + leanZ * (y + .5)) * depth);
  }
  for (let row = 0; row < 3; row++) for (let j = 0; j < n; j++) {
    const next = (j + 1) % n, a = row * n + j, b = row * n + next, c = (row + 1) * n + j, d = (row + 1) * n + next;
    indices.push(a, c, b, b, c, d);
  }
  for (let j = 1; j < n - 1; j++) { indices.push(0, j, j + 1); indices.push(3 * n, 3 * n + j + 1, 3 * n + j); }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices);
  // A temporary CPU marker survives expansion to triangle vertices; it is
  // removed after the foundation meets the terrain, before any GPU upload.
  if (foundation) geometry.setAttribute('stoneFoot', new THREE.Float32BufferAttribute(
    Array.from({ length: positions.length / 3 }, (_, i) => i < n ? 1 : 0), 1));
  geometry.computeVertexNormals();
  // ⛔ THIS USED TO WIDEN THE CREASE ANGLE FOR "weathered" PIECES (up to 77
  // degrees) so their top and sides would blend smooth — that softening is
  // exactly what turned a jointed hexagonal/octagonal prism into a rounded
  // capsule. `weathered` still relaxes the outline's cuts and taper below;
  // it must never relax the shading. Every piece facets at the same angle.
  const result = toCreasedNormals(geometry, FACET_ANGLE);
  geometry.dispose();
  return result;
}

// A jittered convex-ish hull for boulders: an icosahedron (12 verts, 20
// angular faces) scaled anisotropically and perturbed per-vertex, so it reads
// as a flattened, faceted lump — never a smooth ball, never a tall body.
// height/width are the caller's contract (boulders keep height <= .7*width);
// this function only adds irregularity and marks the resting foot.
function ellipsoidHull(width, height, depth, random) {
  const geometry = new THREE.IcosahedronGeometry(1, 0);
  geometry.deleteAttribute('uv'); geometry.deleteAttribute('normal');
  const p = geometry.attributes.position;
  let minY = Infinity;
  const jitters = new Float32Array(p.count * 3);
  for (let i = 0; i < jitters.length; i++) jitters[i] = .82 + random() * .36;
  for (let i = 0; i < p.count; i++) {
    const px = p.getX(i) * jitters[i * 3] * width * .5;
    const py = p.getY(i) * jitters[i * 3 + 1] * height * .5;
    const pz = p.getZ(i) * jitters[i * 3 + 2] * depth * .5;
    p.setXYZ(i, px, py, pz);
    minY = Math.min(minY, py);
  }
  const foot = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) if (p.getY(i) < minY + height * .3) foot[i] = 1;
  geometry.setAttribute('stoneFoot', new THREE.Float32BufferAttribute(foot, 1));
  geometry.computeVertexNormals();
  const result = toCreasedNormals(geometry, FACET_ANGLE);
  geometry.dispose();
  return result;
}

function shorePebble(width, height, depth, random) {
  const phase = random() * TAU, geometry = new THREE.SphereGeometry(1, 10, 7);
  geometry.deleteAttribute('uv'); geometry.deleteAttribute('normal');
  const p = geometry.attributes.position;
  let minY = Infinity;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const irregularity = 1 + Math.sin(x * 3.1 + z * 2.3 + phase) * .095 + Math.sin(y * 4.2 - z * 1.7) * .045;
    const py = y * height * .5 * irregularity;
    p.setXYZ(i, x * width * .5 * irregularity, py, z * depth * .5 * irregularity);
    minY = Math.min(minY, py);
  }
  // Mark the lowest slice as the foundation ring, exactly like fracturedBlock's
  // row 0, so a pebble settles per-vertex onto the real ground instead of
  // sitting at the single coarse radial estimate anchoredStone placed it at.
  const foot = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) if (p.getY(i) < minY + height * .22) foot[i] = 1;
  geometry.setAttribute('stoneFoot', new THREE.Float32BufferAttribute(foot, 1));
  const rounded = mergeVertices(geometry, 1e-5); geometry.dispose(); rounded.computeVertexNormals();
  const result = rounded.toNonIndexed(); rounded.dispose();
  return result;
}

/** Returns three bounded merged draws. Optional rockMaterial is borrowed; when
 * omitted the group owns its own material/texture. sample uses dry-positive
 * shore (also accepts signedShore), plus normalized rock/forest/path fields and
 * the rise/run slope. */
export function createLandscapeRocks({ sample, seed = 894, extent = 128, style = 'natural', rockMaterial } = {}) {
  if (typeof sample !== 'function') throw new TypeError('Landscape rocks require a terrain sampler');
  extent = clamp(finite(extent, 128), 16, 512);
  const random = randomStream(seed), half = extent / 2, group = new THREE.Group();
  group.name = 'World landscape · exposed strata, fallen stone and shore pebbles';
  const parts = { outcrops: [], talus: [], shore: [] };
  const stats = { seed: Number(seed) >>> 0, outcrops: 0, boulders: 0, talus: 0, pebbles: 0, spires: 0, stonePieces: 0, triangles: 0, drawCalls: 0, samples: 0, groundedVertices: 0, maxFoundationGap: -Infinity };
  const formations = [], placements = [];
  const base = new THREE.Color(style === 'stylized' ? '#999782' : '#858b84');
  const warm = new THREE.Color(style === 'stylized' ? '#b5a17d' : '#9d927c');
  const moss = new THREE.Color(style === 'stylized' ? '#7d9456' : '#617348');
  const read = (x, z) => {
    const value = sample(x, z); stats.samples++;
    if (!value || !Number.isFinite(value.height)) throw new TypeError('Landscape sampler must return finite height');
    return { height: value.height, shore: finite(value.shore ?? value.signedShore ?? value.signedshore, 1000),
      rock: clamp(finite(value.rock, 0), 0, 1), forest: clamp(finite(value.forest, 0), 0, 1), path: clamp(finite(value.path, 0), 0, 1),
      slope: Math.max(0, finite(value.slope, 0)) };
  };
  const permitted = (x, z, radius, environment) => Math.abs(x) + radius < half - .5 && Math.abs(z) + radius < half - .5 &&
    Math.hypot(x - 22, z - 6) > 12 + radius && environment.path < .10;
  const color = new THREE.Color(), point = new THREE.Vector3(), normal = new THREE.Vector3();
  const add = (geometry, kind, x, y, z, yaw, environment, tint = 1, sink = .18) => {
    geometry.rotateY(yaw); geometry.translate(x, y, z);
    let positions = geometry.attributes.position, foot = geometry.attributes.stoneFoot;
    let foundationMinY = Infinity;
    if (foot) {
      for (let i = 0; i < positions.count; i++) if (foot.getX(i) > .5) {
        const ground = read(positions.getX(i), positions.getZ(i)).height;
        const baseY = Math.min(positions.getY(i), ground - sink);
        positions.setY(i, baseY); foundationMinY = Math.min(foundationMinY, baseY);
        stats.groundedVertices++; stats.maxFoundationGap = Math.max(stats.maxFoundationGap, positions.getY(i) - ground);
      }
      geometry.deleteAttribute('stoneFoot');
      // ⛔ The recreased result used to be discarded here, so every foundation
      // ring kept its pre-snap normals from before it moved to meet the
      // ground — a stale-lighting seam exactly where the rock touches the
      // slope. Rebind to the settled geometry instead of throwing it away.
      const settled = toCreasedNormals(geometry, FACET_ANGLE);
      geometry.dispose(); geometry = settled; positions = geometry.attributes.position;
    }
    const normals = geometry.attributes.normal, colors = new Float32Array(positions.count * 3);
    const wet = 1 - smooth(Math.abs(environment.shore), .25, 3.2), oxidized = random() * .50;
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i); normal.fromBufferAttribute(normals, i);
      const variation = .90 + tiledNoise(point.x * .04, point.z * .04, 4, 157) * .20;
      const contact = 1 - smooth(point.y - environment.height, .02, .45);
      color.copy(base).lerp(warm, oxidized).multiplyScalar(tint * variation);
      const mossAmount = smooth(normal.y, .18, .88) * (.08 + environment.forest * .34) * (.6 + .4 * Math.sin(point.x + point.z * .7));
      color.lerp(moss, mossAmount).multiplyScalar(1 - contact * (.12 + wet * .37));
      color.toArray(colors, i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts[kind].push(geometry); stats.stonePieces++;
    return foundationMinY;
  };
  // shape: 'block' (talus — angular jointed fragments, kept loose and tilted),
  // 'ellipsoid' (boulders — a flattened faceted hull resting on its widest
  // face, never tilted onto a corner) or 'pebble' (shore stones — small,
  // smooth, water-rounded). Only 'block' gets the random lean: an ellipsoid
  // or pebble already reads as settled, and tilting one onto an edge is what
  // used to make a "boulder" look like it was caught mid-tip.
  const anchoredStone = (x, z, width, height, depth, kind, shape = 'block') => {
    const rounded = shape === 'pebble', resting = shape !== 'block';
    const radius = Math.hypot(width, depth) * .65 + (rounded ? 0 : height * .16);
    // Talus can scatter past the source formation's footprint. Reject it before
    // querying a finite-domain terrain, including the footprint sample margin.
    if (Math.abs(x) + radius >= half - .5 || Math.abs(z) + radius >= half - .5) return false;
    const environment = read(x, z);
    if (!permitted(x, z, radius, environment) || environment.shore < -.7) return false;
    // A slab reads as embedded strata, not a dropped box, when its long axis
    // runs along the contour instead of a heading unrelated to the ground.
    // Rounded pebbles and resting boulders are near-isotropic, so skip the
    // extra samples for them.
    const gx = resting ? 0 : read(x + .8, z).height - read(x - .8, z).height;
    const gz = resting ? 0 : read(x, z + .8).height - read(x, z - .8).height;
    const yaw = !resting && Math.hypot(gx, gz) > .05 ? Math.atan2(-gz, -gx) + Math.PI / 2 + (random() - .5) * .7 : random() * TAU;
    // Sample beneath the footprint, not just the origin; bury the lower edge
    // into sloping terrain so it cannot hover on the downhill side.
    let lowest = environment.height;
    for (const angle of [yaw, yaw + Math.PI / 2, yaw + Math.PI, yaw + Math.PI * 1.5]) {
      const edge = read(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
      if (edge.path > .15) return false;
      lowest = Math.min(lowest, edge.height);
    }
    const weathered = shape === 'block' && (environment.shore < 4 || random() < .35);
    // ⛔ THESE NEVER GOT A FOUNDATION. Only the outcrop/spire base course asked
    // for the per-vertex ground snap below; a boulder or talus stone was
    // placed once at a single rigid Y derived from four coarse radial
    // samples, then (non-resting shapes) tilted at random — on any real slope
    // that is a rock floating on its downhill corner or knifing into the
    // ground on its uphill one, which either flickers (z-fighting with the
    // terrain) or visibly hovers as the camera moves.
    const geometry = shape === 'pebble' ? shorePebble(width, height, depth, random)
      : shape === 'ellipsoid' ? ellipsoidHull(width, height, depth, random)
      : fracturedBlock(width, height, depth, random, weathered, true);
    if (shape === 'block') {
      geometry.rotateX((random() - .5) * .48);
      geometry.rotateZ((random() - .5) * .52);
    }
    const y = lowest + height * (resting ? .09 : .17);
    // Sunk a quarter of its own height so the true rock/soil contact line
    // sits below whatever the visible base looks like, never a knife-edge.
    // Resting shapes (boulders, pebbles) sit mostly on top of the ground.
    const sink = resting ? Math.max(.12, height * .15) : Math.max(.18, height * .25);
    const foundationMinY = add(geometry, kind, x, y, z, yaw, environment, .86 + random() * .28, sink);
    placements.push({ kind: rounded ? 'pebble' : kind, position: [x, y, z], footprintRadius: radius,
      // The real, un-inflated shape the mesh was built from — not the padded
      // collision-clearance radius above. That radius scales the spacing
      // between formations; it is not the piece's visible width, and using
      // it as one let a narrow, tall spire's height clear an "aspect" check
      // sized off a footprint 1.5-3x wider than the stone actually is.
      extentLong: Math.max(width, depth), extentShort: Math.min(width, depth),
      groundHeight: environment.height, lowestGroundHeight: lowest, height, foundationMinY });
    return true;
  };

  // Jittered candidates choose exposed geology from the caller's actual field.
  // Shared regional strike/dip keeps the beds coherent, while individual joint
  // blocks fracture, taper and offset instead of repeating identical stacks.
  const cells = Math.min(18, Math.max(3, Math.ceil(extent / 11))), step = extent / cells;
  const candidates = [];
  for (let iz = 0; iz < cells; iz++) for (let ix = 0; ix < cells; ix++) {
    const x = -half + (ix + .2 + random() * .6) * step, z = -half + (iz + .2 + random() * .6) * step;
    const environment = read(x, z);
    if (environment.rock > .44 && environment.shore > 3 && permitted(x, z, 5, environment)) candidates.push({ x, z, environment, rank: environment.rock + random() * .22 });
  }
  candidates.sort((a, b) => b.rank - a.rank);
  for (const candidate of candidates) {
    if (stats.outcrops >= LIMITS.outcrops) break;
    const { x, z, environment } = candidate;
    // ⛔ THIS USED TO BE A LAYERED WALL: `layers` (3-5) courses each split into
    // `pieces` (1-3) joint blocks, whose vertical "course" thickness was set
    // by the COURSE COUNT alone and never checked against how narrow a joint
    // split it into. A course of ~1.6-4 m could still be cut into a ~1.2 m
    // sliver — a joint block taller than it is wide, i.e. a pillar, hiding
    // inside a formation whose overall footprint looked fine. Slabs are built
    // directly at slab scale now: 2-5 of them, each with its own height kept
    // a fixed, small fraction of its own length, so no piece can be sliced
    // narrower than it is tall.
    const buttress = 1 + smooth(environment.slope, 1, 1.6) * 1.15;
    const clusterLength = Math.min((4.4 + random() * 4.6) * buttress, 11);
    const clusterDepth = clusterLength * (.55 + random() * .22);
    const radius = Math.hypot(clusterLength, clusterDepth) * .58;
    if (!permitted(x, z, radius, environment) || formations.some(f => Math.hypot(f.x - x, f.z - z) < f.radius + radius * .8)) continue;
    // The strike (long axis) runs along the contour, perpendicular to the
    // downhill direction, so a slab reads as embedded bedding rather than a
    // dropped box facing an arbitrary heading.
    const gx = read(x + 1, z).height - read(x - 1, z).height, gz = read(x, z + 1).height - read(x, z - 1).height;
    const downYaw = Math.hypot(gx, gz) > .03 ? Math.atan2(-gz, -gx) : random() * TAU;
    const contourYaw = downYaw + Math.PI / 2;
    let lowest = environment.height, clear = true;
    for (let i = 0; i < 8; i++) {
      const edge = read(x + Math.cos(i / 8 * TAU) * radius, z + Math.sin(i / 8 * TAU) * radius);
      lowest = Math.min(lowest, edge.height); clear &&= edge.path < .15 && edge.shore > .8;
    }
    if (!clear) continue;
    // A shared regional dip (30-60 degrees) tilts every slab in the cluster
    // the same way about the strike above, so the cluster reads as one
    // fractured stratum rather than stones tilted independently at random.
    const dip = (30 + random() * 30) * Math.PI / 180 * (random() < .5 ? -1 : 1);
    const sliceCount = 2 + Math.floor(random() * 4); // 2-5 angular slabs
    let foundationMinY = Infinity;
    for (let slice = 0; slice < sliceCount; slice++) {
      const sliceLength = clusterLength * (.32 + random() * .30);
      const sliceWidth = sliceLength * (.42 + random() * .18); // short horizontal axis, always well under sliceLength
      // Height stays a fixed fraction of the slab's own length — comfortably
      // under both the 0.6x bedding cap and the 0.7x/0.85x aspect test —
      // instead of a course thickness computed independently of how the
      // course happened to get sliced into joint blocks.
      const sliceHeight = Math.min(sliceLength * (.16 + random() * .14), 2.2);
      const along = (random() - .5) * clusterLength * .68, across = (random() - .5) * clusterDepth * .5;
      const px = x + Math.cos(contourYaw) * along + Math.cos(contourYaw + Math.PI / 2) * across;
      const pz = z + Math.sin(contourYaw) * along + Math.sin(contourYaw + Math.PI / 2) * across;
      const geometry = fracturedBlock(sliceLength, sliceHeight, sliceWidth, random, slice > 0, true);
      // The dip must rotate the slab about its own long (contour) axis
      // before that axis is turned to face contourYaw in world space —
      // otherwise it tilts around the wrong axis once yawed.
      geometry.rotateX(dip + (random() - .5) * .12);
      geometry.rotateY(contourYaw + (random() - .5) * .18);
      const py = environment.height - sliceHeight * .15 + (random() - .5) * sliceHeight * .3;
      // Sunk 30% of its own height so the rock/soil line sits below the
      // visible base, never a knife-edge against the slope.
      const sink = Math.max(.18, sliceHeight * .3);
      const result = add(geometry, 'outcrops', px, py, pz, 0, environment, .86 + random() * .28, sink);
      foundationMinY = Math.min(foundationMinY, result);
      placements.push({ kind: 'outcrop', position: [px, py, pz], footprintRadius: radius,
        extentLong: Math.max(sliceLength, sliceWidth), extentShort: Math.min(sliceLength, sliceWidth),
        groundHeight: environment.height, lowestGroundHeight: lowest, height: sliceHeight, foundationMinY: result });
    }
    formations.push({ x, z, radius }); stats.outcrops++;
    for (let i = 0; i < 12 && stats.talus < LIMITS.talus; i++) {
      const angle = downYaw + (random() - .5) * 2.2, distance = radius * (.65 + random() * .8), size = .25 + random() * .85;
      if (anchoredStone(x + Math.cos(angle) * distance, z + Math.sin(angle) * distance, size * 1.5, size * .5, size, 'talus')) stats.talus++;
    }
  }
  for (let i = 0; i < 1200 && stats.boulders < LIMITS.boulders; i++) {
    const x = (random() - .5) * extent * .94, z = (random() - .5) * extent * .94, environment = read(x, z);
    if (environment.shore < .2 || environment.path > .10 || (environment.rock < .28 && !(environment.shore < 6 && random() < .35))) continue;
    if (formations.some(f => Math.hypot(f.x - x, f.z - z) < f.radius * .85)) continue;
    // Flattened ellipsoidal hull: height stays well under 0.7x its own
    // width, and it rests on its widest face — see `anchoredStone`'s 'ellipsoid'
    // shape, which skips the random tilt a fractured block would otherwise get.
    const size = .55 + random() * (environment.rock > .5 ? 1.5 : .75);
    const boulderWidth = size * (1.1 + random() * .45);
    if (anchoredStone(x, z, boulderWidth, boulderWidth * (.30 + random() * .26), boulderWidth * (.75 + random() * .35), 'talus', 'ellipsoid')) stats.boulders++;
  }
  // Rounded water-worn stones occur in small bars along the shore; isolated
  // uniform specks across the entire landscape would read as procedural noise.
  for (let i = 0; i < 1500 && stats.pebbles < LIMITS.pebbles; i++) {
    const x = (random() - .5) * extent * .93, z = (random() - .5) * extent * .93, environment = read(x, z);
    if (environment.shore < -.45 || environment.shore > 2.8 || environment.path > .10) continue;
    for (let j = 0; j < 5 && stats.pebbles < LIMITS.pebbles; j++) {
      const px = x + (random() - .5) * 2.1, pz = z + (random() - .5) * 2.1, local = read(px, pz);
      if (local.shore < -.65 || local.shore > 3.2) continue;
      const size = .10 + random() * .35;
      if (anchoredStone(px, pz, size * (1.2 + random() * .5), size * (.42 + random() * .25), size, 'shore', 'pebble')) stats.pebbles++;
    }
  }

  // Tors crown the high, dry stone the layered outcrops only skirt.
  // ⛔ THESE USED TO BE THIN, TALL SPIRES (up to 14 m on a ~1-3 m footprint) —
  // the "vertical capsule pillar" the owner's screenshot showed. The fix that
  // shipped before this one only capped height against `radius`, a padded
  // collision-clearance value fixed at `max(width*1.5, 2.2)` — 1.5-3x the
  // block's own visible width — so a 1.15-1.95 m-wide, ~4.8 m-tall column
  // still passed a "height <= 1.1x footprint" check sized off the wrong
  // footprint. There is no "height" body left to cap here: a tor is now
  // always a STACK of 2-3 individually flattened slabs (each kept a fixed,
  // small fraction of its own footprint, exactly like an outcrop slab), so
  // there is never a single tall body to measure in the first place — only
  // the stack's total height can exceed a slab's own footprint, and stacking
  // several flat stones is a cairn, not a pillar. Candidates ride their own
  // worldRandom channels (51-53, clear of the ridge 31-37 and cliff 41-47
  // blocks) and a private geometry stream, so tor tuning can never move a
  // single bed, boulder or pebble above.
  const spireRandom = randomStream((seed ^ 0x5f1e3d9) >>> 0);
  const spireLimit = Math.min(LIMITS.spireCeiling, Math.round(LIMITS.spires * (extent / 128) ** 2));
  // A finer grid than the outcrops': only a fraction of cells read as high dry
  // stone, and the pinnacles need the extra candidates to stay scattered.
  const spireCells = Math.min(24, Math.max(6, Math.ceil(extent / 8))), spireStep = extent / spireCells;
  const pinnacles = [];
  for (let iz = 0; iz < spireCells; iz++) for (let ix = 0; ix < spireCells; ix++) {
    const key = iz * spireCells + ix;
    const x = -half + (ix + .2 + worldRandom(seed, 51, key) * .6) * spireStep, z = -half + (iz + .2 + worldRandom(seed, 52, key) * .6) * spireStep;
    const environment = read(x, z);
    // Tors sit only on steep rock-mask cells: rock alone (the old gate) also
    // matches gentle, grass-covered rocky ground, which read as menhirs
    // planted in a lawn. Slope must cross into genuinely steep terrain too.
    if (environment.rock > .6 && environment.shore > 3 && environment.slope > .45) {
      pinnacles.push({ x, z, environment, rank: environment.rock + smooth(environment.slope, .5, 1.5) * .4 + worldRandom(seed, 53, key) * .18 });
    }
  }
  pinnacles.sort((a, b) => b.rank - a.rank);
  for (const pinnacle of pinnacles) {
    if (stats.spires >= spireLimit) break;
    const { x, z, environment } = pinnacle;
    const steep = smooth(environment.slope, .6, 1.6);
    const stackSlabs = 2 + Math.floor(spireRandom() * 2); // a stack of 2-3 flattened slabs, never one tall body
    const baseLength = (1.6 + spireRandom() * 1.9) * (1 + steep * .3);
    const radius = Math.max(baseLength * .95, 1.7);
    if (!permitted(x, z, radius, environment)) continue;
    if (formations.some(f => Math.hypot(f.x - x, f.z - z) < f.radius + radius * .9)) continue;
    let lowest = environment.height, clear = true;
    for (let i = 0; i < 8; i++) {
      const edge = read(x + Math.cos(i / 8 * TAU) * radius, z + Math.sin(i / 8 * TAU) * radius);
      lowest = Math.min(lowest, edge.height); clear &&= edge.path < .15 && edge.shore > .8;
    }
    if (!clear) continue;
    const stackYaw = spireRandom() * TAU;
    let stackBottom = Math.max(lowest - .3, environment.height - baseLength * .3);
    for (let slab = 0; slab < stackSlabs; slab++) {
      const taper = 1 - slab / stackSlabs * .32;
      const slabLength = baseLength * taper * (.85 + spireRandom() * .3);
      const slabWidth = slabLength * (.58 + spireRandom() * .22); // short horizontal axis
      // Flattened like an outcrop slab, well under the aspect test's 0.7x/
      // 0.85x margins — a tor is a stack of these, never a tall single body.
      const slabHeight = Math.min(slabLength * (.18 + spireRandom() * .14), 1.6);
      const offsetAngle = spireRandom() * TAU, offset = slab === 0 ? 0 : slabWidth * (.10 + spireRandom() * .22);
      const px = x + Math.cos(offsetAngle) * offset, pz = z + Math.sin(offsetAngle) * offset;
      // Only the base slab asks for a ground snap (fracturedBlock's
      // `foundation` flag); every slab above rests on the one below it, not
      // on the terrain, so it must not be pulled down to a local ground
      // sample of its own.
      const geometry = fracturedBlock(slabLength, slabHeight, slabWidth, spireRandom, slab > 0, slab === 0);
      geometry.rotateY(stackYaw + (spireRandom() - .5) * .6);
      const py = stackBottom + slabHeight * .5;
      const sink = slab === 0 ? Math.max(.18, slabHeight * .3) : .1;
      const foundationMinY = add(geometry, 'outcrops', px, py, pz, 0, environment, .84 + spireRandom() * .3, sink);
      placements.push({ kind: 'spire', stack: stats.spires, slab, position: [px, py, pz], footprintRadius: radius,
        extentLong: Math.max(slabLength, slabWidth), extentShort: Math.min(slabLength, slabWidth),
        groundHeight: environment.height, lowestGroundHeight: lowest, height: slabHeight, foundationMinY });
      // Slabs overlap a little where they meet, like real stacked stones,
      // instead of sitting edge to edge with a visible gap between them.
      stackBottom += slabHeight * (.7 + spireRandom() * .2);
    }
    formations.push({ x, z, radius }); stats.spires++;
  }

  let ownedMap = null;
  if (!rockMaterial) { ownedMap = detailTexture(); rockMaterial = makeRockMaterial(ownedMap, style); }
  for (const [kind, geometries] of Object.entries(parts)) {
    if (!geometries.length) continue;
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) throw new Error(`Could not merge ${kind} landscape geometry`);
    merged.computeBoundingBox(); merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, rockMaterial);
    mesh.name = `Landscape · ${kind}`; mesh.castShadow = mesh.receiveShadow = true;
    mesh.frustumCulled = true; // explicit: a merged draw's bound must gate it, not an inherited default.
    mesh.userData.worldStudyRole = 'rock'; mesh.userData.landscapeKind = kind;
    group.add(mesh); stats.triangles += (merged.index?.count ?? merged.attributes.position.count) / 3;
  }
  stats.drawCalls = group.children.length;
  if (!stats.groundedVertices) stats.maxFoundationGap = 0;
  group.userData.stats = stats;
  group.userData.placements = placements;
  group.userData.limits = LIMITS;
  let disposed = false;
  group.userData.dispose = () => {
    if (disposed) return;
    disposed = true; for (const mesh of group.children) mesh.geometry.dispose();
    if (ownedMap) { rockMaterial.dispose(); ownedMap.dispose(); }
    group.removeFromParent();
  };
  return group;
}
