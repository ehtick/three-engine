import { createWaterDomain } from '../../modules/water/worldWaterDomain.js';
import { createLandscapeNoise } from './landscapeNoise.js';
import { createTerrainShape } from './terrainShape.js';
import { WORLD_PARAMETERS } from './worldConfig.js';

// Shared CPU landscape fields for procedural World layouts and the retained
// Phase 0 study fixture. Native terrain and vegetation consume the same samples.
const TAU = Math.PI * 2;
const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (lo, hi, value) => { const t = clamp((value - lo) / (hi - lo)); return t * t * (3 - 2 * t); };
const smoothDerivative = (lo, hi, value) => { const t = (value - lo) / (hi - lo); return t > 0 && t < 1 ? 6 * t * (1 - t) / (hi - lo) : 0; };
// C-infinity soft max/min: identical to Math.max/min once |a-b| >> eps, but
// rounded through their crossing instead of a hard kink there. Derivatives
// below are exact (dSoftMax/da = 1 - dSoftMax/db, and symmetrically for min).
const softMax = (a, b, eps) => (a + b + Math.hypot(a - b, eps)) / 2;
const softMaxDb = (a, b, eps) => (1 + (b - a) / Math.hypot(a - b, eps)) / 2;
const softMin = (a, b, eps) => (a + b - Math.hypot(a - b, eps)) / 2;
const softMinDb = (a, b, eps) => (1 - (b - a) / Math.hypot(a - b, eps)) / 2;
// Two water bodies can sit equally close to a dry point (their shared medial
// line): the level/slope payload used to hard-switch there, producing a real
// step in the ground wherever a lake's basin met a differently-leveled pond.
// This bandwidth blends that payload smoothly over a few metres either side
// of the tie instead.
const WATER_BODY_BLEND = 0.5;
// Rounding width for the underwater bed's max-depth floor (softMax above).
const BED_FLOOR_ROUND = 0.3;
// Rounding width for the shoulder's rise-vs-gap smooth-min cap (softMin below).
const SHOULDER_ROUND_CAP = 0.35;
// Streaming only: metres inside the region border over which roads give way to
// the streamed landscape (the wider ground blend is `borderBlend`).
const BORDER_EDGE = 4;

const groupDefaults = group => Object.fromEntries(WORLD_PARAMETERS.filter(parameter => parameter.path.startsWith(`${group}.`))
  .map(parameter => [parameter.path.slice(group.length + 1), parameter.default]));
const DEFAULT_TERRAIN = Object.freeze(groupDefaults('terrain'));
const DEFAULT_WATER = Object.freeze(groupDefaults('water'));

function number(value, fallback, lo, hi, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) {
    throw new RangeError(`Valley fields: ${name} must be finite and between ${lo} and ${hi}`);
  }
  return value;
}

export { createLandscapeNoise } from './landscapeNoise.js';

function ellipse(cx, cz, rx, rz, count = 48) {
  return Array.from({ length: count }, (_, i) => {
    const angle = i / count * TAU;
    return [cx + Math.cos(angle) * rx, cz + Math.sin(angle) * rz];
  });
}

function riverX(a, b, c, d, t) {
  // Hermite X(Z) retains a shared tangent while Z stays monotone, including
  // larger extents whose upstream control intervals have very different lengths.
  const dz = c[1] - b[1], m0 = (c[0] - a[0]) / (c[1] - a[1]), m1 = (d[0] - b[0]) / (d[1] - b[1]);
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * b[0] + (t3 - 2 * t2 + t) * m0 * dz + (-2 * t3 + 3 * t2) * c[0] + (t3 - t2) * m1 * dz;
}

function compilePolygon(source) {
  const points = source.points;
  const edges = points.map((a, i) => {
    const b = points[(i + 1) % points.length], dx = b[0] - a[0], dz = b[1] - a[1];
    return { ax: a[0], az: a[1], bx: b[0], bz: b[1], dx, dz, inverse: 1 / (dx * dx + dz * dz) };
  });
  return { id: source.id, kind: 'lake', height: source.level, depth: source.depth, edges,
    minX: Math.min(...points.map(p => p[0])), maxX: Math.max(...points.map(p => p[0])),
    minZ: Math.min(...points.map(p => p[1])), maxZ: Math.max(...points.map(p => p[1])) };
}

function compileRiver(source) {
  const radius = source.width / 2;
  const edges = source.points.slice(1).map((b, i) => {
    const a = source.points[i], dx = b[0] - a[0], dz = b[2] - a[2];
    return { ax: a[0], az: a[2], dx, dz, inverse: 1 / (dx * dx + dz * dz), y: a[1], dy: b[1] - a[1] };
  });
  return { id: source.id, kind: 'river', radius, depth: source.depth, edges,
    minX: Math.min(...source.points.map(p => p[0])) - radius, maxX: Math.max(...source.points.map(p => p[0])) + radius,
    minZ: Math.min(...source.points.map(p => p[2])) - radius, maxZ: Math.max(...source.points.map(p => p[2])) + radius };
}

/**
 * Roads that carry an elevation profile grade their own corridor: the ground
 * inside the carriageway takes the road's height and eases back to the terrain
 * over a feather. Segments are binned so the per-sample cost stays constant as
 * a town grows from one lane to a full street network.
 *
 * Overlapping roads are applied widest first. A narrow lane was routed on the
 * ground the main streets had already graded, so laying it down last keeps the
 * two profiles continuous where they meet instead of stepping between them.
 */
function compileCorridors(paths) {
  const roads = [];
  for (const path of paths) {
    if (!Array.isArray(path.elevations)) continue;
    const half = path.width / 2, feather = Math.max(1.2, path.width * .85), segments = [];
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1], b = path.points[i];
      const dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
      if (length2 < 1e-9) continue;
      segments.push({ road: roads.length, ax: a[0], az: a[1], dx, dz, inverse: 1 / length2,
        y: path.elevations[i - 1], dy: path.elevations[i] - path.elevations[i - 1] });
    }
    if (segments.length) roads.push({ half, feather, margin: Math.max(.35, feather * .2), reach: half + feather, width: path.width, segments });
  }
  if (!roads.length) return null;
  const cell = Math.max(6, ...roads.map(road => road.reach * 2));
  const bins = new Map(), key = (cx, cz) => cx * 0x10000 + cz;
  for (const road of roads) for (const segment of road.segments) {
    const minX = Math.min(segment.ax, segment.ax + segment.dx) - road.reach, maxX = Math.max(segment.ax, segment.ax + segment.dx) + road.reach;
    const minZ = Math.min(segment.az, segment.az + segment.dz) - road.reach, maxZ = Math.max(segment.az, segment.az + segment.dz) + road.reach;
    for (let cz = Math.floor(minZ / cell); cz <= Math.floor(maxZ / cell); cz++) for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell); cx++) {
      const id = key(cx, cz);
      if (!bins.has(id)) bins.set(id, []);
      bins.get(id).push(segment);
    }
  }
  // Reused between samples; `count` says how many entries of `hits` are live.
  const found = {};
  return { roads: roads.length, nearest(x, z) {
    const near = bins.get(key(Math.floor(x / cell), Math.floor(z / cell)));
    if (!near) return null;
    let best = null, best2 = Infinity;
    for (const segment of near) {
      const road = roads[segment.road];
      const t = clamp(((x - segment.ax) * segment.dx + (z - segment.az) * segment.dz) * segment.inverse);
      const ex = x - segment.ax - segment.dx * t, ez = z - segment.az - segment.dz * t, distance2 = ex * ex + ez * ez;
      if (distance2 >= best2 || distance2 > road.reach * road.reach) continue;
      best2 = distance2; best = { segment, road, t, ex, ez };
    }
    if (!best) return null;
    const { segment, road, t, ex, ez } = best, distance = Math.sqrt(best2), factor = distance > 1e-9 ? 1 / distance : 0;
    found.distance = distance; found.half = road.half; found.feather = road.feather;
    found.target = segment.y + segment.dy * t;
    found.gx = ex * factor; found.gz = ez * factor;
    // The road's own slope inside the corridor, so a graded ramp keeps its grade.
    found.tx = t > 0 && t < 1 ? segment.dy * segment.dx * segment.inverse : 0;
    found.tz = t > 0 && t < 1 ? segment.dy * segment.dz * segment.inverse : 0;
    return found;
  } };
}

/**
 * Default layout is the 128 m temperate study: organic lake at [-12,8], upland
 * ellipse [38,-32] at level 4, forest pond [-35,-38] at level 3, river and cottage
 * pad [22,2.2,6]. Larger extents extend the upper river and surrounding hills.
 *
 * sample(x,z[,out]) returns height, signed shore distance (dry positive), nearest
 * waterLevel, actual wet depth, moisture/forest/rock/path masks [0,1], and slope
 * as rise/run. Outside the extent returns null. sampleHeight omits mask work.
 * terrainStep declares the largest triangle grid spacing used by this study;
 * its conservative shore clearance is verified against 0.5 m triangles in tests.
 */
export function createValleyFields(options = {}) {
  const settings = {
    seed: number(options.seed ?? options.layout?.seed, 894, 0, 0xffffffff, 'seed') >>> 0,
    extent: number(options.extent ?? options.layout?.extent, 128, 96, 1024, 'extent'),
    relief: number(options.relief, 1, 0, 2.5, 'relief'),
    riverWidth: number(options.riverWidth, 5, 2, 24, 'riverWidth'),
    lakeDepth: number(options.lakeDepth, 2, 0.5, 12, 'lakeDepth'),
    riverDepth: number(options.riverDepth, 1.2, 0.4, 6, 'riverDepth'),
    shoreWidth: number(options.shoreWidth, 1, 0.4, 3, 'shoreWidth'),
    forestCover: number(options.forestCover, 0.72, 0, 1, 'forestCover'),
    rockiness: number(options.rockiness, 1, 0, 2, 'rockiness'),
    pathWidth: number(options.pathWidth, 2.2, 0.6, 8, 'pathWidth'),
    terrainStep: number(options.terrainStep, 0.5, 0.125, 2, 'terrainStep'),
    terrain: { ...DEFAULT_TERRAIN, ...options.terrain },
    water: { ...DEFAULT_WATER, ...options.water },
  };
  const { extent, seed, relief } = settings, half = extent / 2;
  // ⛔ 09-14 live probe: with streaming on, the composed region met the first
  // streamed chunk with a step (1.7 m at z=0, 15 m beside a border lake; mean
  // 0.96 m along the edge) because banks and shoulders never rejoin the raw
  // landscape before the border. When the region is cut from a larger
  // landscape, the ground eases back to the raw landscape over this band, so
  // at the border it IS the landscape the streamed tiles sample. Roads and pads
  // are applied after, so they stay exact.
  const borderBlend = (settings.terrain.landscapeExtent ?? extent) > extent ? Math.min(32, extent * .15) : 0;
  const banks = settings.water;
  const noise = createLandscapeNoise(seed), shapeNoise = createLandscapeNoise(seed ^ 0x459ac23), noiseWork = new Float64Array(3);
  const shapeWork = {};
  const phase = (shapeNoise(7.1, 3.7) + 1) * Math.PI;
  const lake = Array.from({ length: 72 }, (_, i) => {
    const a = i / 72 * TAU;
    const radius = 1 + 0.105 * Math.sin(a * 3 + phase) + 0.058 * Math.sin(a * 5 - phase * 0.7) + 0.026 * Math.cos(a * 8 + 1.7);
    return [-12 + Math.cos(a) * 16 * radius, 8 + Math.sin(a) * 12 * radius];
  });
  const startZ = -half + 2;
  const controls = [
    [6, startZ], [11 + shapeNoise(3, 9) * 1.6, mix(startZ, -18, 0.36)],
    [4 + shapeNoise(7, 4) * 1.8, mix(startZ, -18, 0.72)], [-5, -18], [-8.2, -9], [-10, 2],
  ];
  const riverPoints = [];
  for (let i = 0; i < controls.length - 1; i++) {
    const a = controls[Math.max(0, i - 1)], b = controls[i], c = controls[i + 1], d = controls[Math.min(controls.length - 1, i + 2)];
    for (let sample = 0; sample < 8; sample++) {
      const t = sample / 8, x = riverX(a, b, c, d, t), z = mix(b[1], c[1], t);
      const upstream = clamp((-z - 18) / (-startZ - 18));
      riverPoints.push([x, 2.6 * Math.pow(upstream, 1.18), z]);
    }
  }
  riverPoints.push([-10, 0, 2]);
  const pathPoints = [[22, 12], [20, 19], [9, 24.5], [-3, 26], [-17, 25], [-31, 21]];
  const recipe = options.layout ? structuredClone(options.layout) : {
    lakes: [
      { id: 'lake', points: lake, level: 0, depth: settings.lakeDepth },
      { id: 'upland-pond', points: ellipse(38, -32, 4, 3), level: 4, depth: 1 },
      { id: 'forest-pond', points: ellipse(-35, -38, 4, 4), level: 3, depth: 1 },
    ],
    rivers: [{ id: 'river', points: riverPoints, width: settings.riverWidth, depth: settings.riverDepth }],
    path: { points: pathPoints, width: settings.pathWidth },
    cottagePad: { center: [22, 2.2, 6], halfWidth: 9, halfDepth: 12, feather: 5 },
    escarpments: [],
  };
  if (options.layout && (recipe.version !== 1 || recipe.extent !== extent || !Array.isArray(recipe.lakes) || !recipe.lakes.length ||
      !Array.isArray(recipe.rivers) || !Array.isArray(recipe.ridges) || !Array.isArray(recipe.buildingPads) || !Array.isArray(recipe.lanes))) {
    throw new TypeError('Valley fields: layout must be a version 1 layout for this extent');
  }
  if (options.layout) {
    const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
    for (const ridge of recipe.ridges) if (!vector(ridge.center, 2) || !Number.isFinite(ridge.angle) ||
        ![ridge.amplitude, ridge.width, ridge.length].every(Number.isFinite) || ridge.amplitude < 0 || ridge.width <= 0 || ridge.length <= 0) throw new TypeError('Valley fields: invalid layout ridge');
    // Older layouts predate escarpments; a missing list is no cliffs at all.
    if (recipe.escarpments !== undefined && !Array.isArray(recipe.escarpments)) throw new TypeError('Valley fields: layout escarpments must be an array');
    for (const escarpment of recipe.escarpments ?? []) if (!vector(escarpment.center, 2) || !Number.isFinite(escarpment.angle) ||
        ![escarpment.length, escarpment.height, escarpment.faceWidth, escarpment.talus].every(Number.isFinite) ||
        escarpment.height < 0 || escarpment.faceWidth <= 0 || escarpment.length <= 0 || escarpment.talus < 0) throw new TypeError('Valley fields: invalid layout escarpment');
    for (const pad of recipe.buildingPads) if (!vector(pad.center, 3) || !Number.isFinite(pad.angle ?? 0) ||
        ![pad.halfWidth, pad.halfDepth, pad.feather].every(value => Number.isFinite(value) && value > 0)) throw new TypeError('Valley fields: invalid building pad');
    for (const lane of recipe.lanes) {
      if (!Array.isArray(lane.points) || lane.points.length < 2 || !lane.points.every(point => vector(point, 2)) ||
        !Number.isFinite(lane.width) || lane.width <= 0 || lane.points.slice(1).some((point, index) => point[0] === lane.points[index][0] && point[1] === lane.points[index][1])) throw new TypeError('Valley fields: invalid layout lane');
      // A graded road carries its own elevation profile, one per point.
      if (lane.elevations !== undefined && (!Array.isArray(lane.elevations) || lane.elevations.length !== lane.points.length ||
        !lane.elevations.every(Number.isFinite))) throw new TypeError('Valley fields: invalid layout lane elevations');
    }
  }
  const pads = structuredClone(options.layout ? recipe.buildingPads : [recipe.cottagePad]);
  const ridges = options.layout ? structuredClone(recipe.ridges) : null;
  const escarpments = options.layout ? structuredClone(recipe.escarpments ?? []) : null;
  const shape = createTerrainShape({ seed, extent, terrain: settings.terrain, relief, ridges, escarpments });
  const domain = createWaterDomain(recipe);
  // Private coefficients are detached from the inspectable recipe; callers may
  // serialize or edit its copy without silently changing an existing field.
  const bodies = recipe.lakes.map(compilePolygon).sort((a, b) => a.id.localeCompare(b.id));
  bodies.push(...recipe.rivers.map(compileRiver));
  const water = {}, result = {};
  const paths = options.layout ? recipe.lanes : [{ points: pathPoints, width: settings.pathWidth }];
  const pathEdges = paths.flatMap(path => path.points.slice(1).map((b, i) => {
    const a = path.points[i], dx = b[0] - a[0], dz = b[1] - a[1];
    return { ax: a[0], az: a[1], dx, dz, width: path.width, inverse: 1 / (dx * dx + dz * dz) };
  }));
  const corridors = compileCorridors(paths);

  function waterAt(x, z) {
    let closest = Infinity, wetLevel = NaN, wetDepth = 0, wetLX = 0, wetLZ = 0;
    let bestGX = 0, bestGZ = 0;
    // Every body's own payload (level, its own tangential slope, its own shore
    // gradient) is smooth by itself; only picking a single "closest" body was
    // the discontinuity. Collect them all — bodies are few — and blend below.
    const per = [];
    for (const body of bodies) {
      let best2 = Infinity, ex = 0, ez = 0, bestEdge = null, bestT = 0, inside = false;
      for (const edge of body.edges) {
        const t = clamp(((x - edge.ax) * edge.dx + (z - edge.az) * edge.dz) * edge.inverse);
        const dx = x - edge.ax - edge.dx * t, dz = z - edge.az - edge.dz * t, distance2 = dx * dx + dz * dz;
        if (distance2 < best2) { best2 = distance2; ex = dx; ez = dz; bestEdge = edge; bestT = t; }
        if (body.kind === 'lake' && (edge.az > z) !== (edge.bz > z) && x < edge.dx * (z - edge.az) / edge.dz + edge.ax) inside = !inside;
      }
      const distance = Math.sqrt(best2);
      const signed = body.kind === 'lake' ? (inside ? -distance : distance) : distance - body.radius;
      const level = body.kind === 'lake' ? body.height : bestEdge.y + bestEdge.dy * bestT;
      const lx = body.kind === 'lake' || bestT <= 0 || bestT >= 1 ? 0 : bestEdge.dy * bestEdge.dx * bestEdge.inverse;
      const lz = body.kind === 'lake' || bestT <= 0 || bestT >= 1 ? 0 : bestEdge.dy * bestEdge.dz * bestEdge.inverse;
      const factor = distance > 1e-9 ? (body.kind === 'lake' && inside ? -1 : 1) / distance : 0;
      const gx = ex * factor, gz = ez * factor;
      if (signed <= 1e-7 && Number.isNaN(wetLevel)) { wetLevel = level; wetDepth = body.depth; wetLX = lx; wetLZ = lz; }
      if (signed < closest) { closest = signed; bestGX = gx; bestGZ = gz; }
      per.push({ signed, level, depth: body.depth, lx, lz, gx, gz });
    }
    water.wet = Number.isFinite(wetLevel);
    // Bodies well outside the blend band contribute an entirely negligible
    // (but not exactly zero) softmin weight; dropping them once they are more
    // than a healthy multiple of WATER_BODY_BLEND behind the leader keeps the
    // overwhelming majority of the map bit-identical to the pre-blend, single
    // -body formulas (needed for anything that compares against an exact
    // constant, like a lake's own level) while still blending every real tie.
    const active = per.filter(candidate => candidate.signed - closest <= WATER_BODY_BLEND * 14);
    if (water.wet) {
      water.shore = closest; water.gx = bestGX; water.gz = bestGZ;
      water.level = wetLevel; water.depth = wetDepth; water.lx = wetLX; water.lz = wetLZ;
    } else if (active.length === 1) {
      const [only] = active;
      water.shore = closest; water.gx = bestGX; water.gz = bestGZ;
      water.level = only.level; water.depth = only.depth; water.lx = only.lx; water.lz = only.lz;
    } else {
      // Softmin weights over the (shift-invariant) `signed` distances: this is
      // exp(-signed_i/K) normalized, computed relative to `closest` only for
      // numeric range — the ratio, and so every derivative below, does not
      // depend on which body attains `closest`. Weight concentrates on the
      // true nearest body within a few WATER_BODY_BLEND of any tie, and decays
      // to the single-body case (recovering the old exact formulas) elsewhere.
      // `shore` itself is blended the same way: a hard min of several smooth
      // functions is continuous but its GRADIENT still kinks at a true tie
      // (whichever body "wins" swaps abruptly), which read as a second, finer
      // crease riding along the medial line even after the level jump above
      // was fixed. Blending shore too removes that residual kink as well.
      let sumRaw = 0, shore = 0, level = 0, depth = 0, lx = 0, lz = 0, gxBar = 0, gzBar = 0;
      let levelGX = 0, levelGZ = 0, shoreGX = 0, shoreGZ = 0;
      const raw = active.map(candidate => Math.exp(-(candidate.signed - closest) / WATER_BODY_BLEND));
      for (const value of raw) sumRaw += value;
      const weight = raw.map(value => value / sumRaw);
      for (let i = 0; i < active.length; i++) {
        const w = weight[i], candidate = active[i];
        shore += w * candidate.signed;
        level += w * candidate.level; depth += w * candidate.depth;
        lx += w * candidate.lx; lz += w * candidate.lz;
        gxBar += w * candidate.gx; gzBar += w * candidate.gz;
      }
      for (let i = 0; i < active.length; i++) {
        const w = weight[i], candidate = active[i];
        levelGX += w * candidate.gx * candidate.level; levelGZ += w * candidate.gz * candidate.level;
        shoreGX += w * candidate.gx * candidate.signed; shoreGZ += w * candidate.gz * candidate.signed;
      }
      // d/dx[sum(w_i * p_i)] = (weighted-avg(dSignedX) * P - weighted-avg(dSignedX * p_i)) / K
      //   + weighted-avg(dp_i/dx); the first term is the weights' own drift
      // between bodies, the second is each body's own within-body gradient
      // (signed_i's own gradient IS gx_i; level_i's is the river tangent lx_i).
      water.shore = shore;
      water.gx = (gxBar * shore - shoreGX) / WATER_BODY_BLEND + gxBar;
      water.gz = (gzBar * shore - shoreGZ) / WATER_BODY_BLEND + gzBar;
      water.level = level; water.depth = depth;
      water.lx = (gxBar * level - levelGX) / WATER_BODY_BLEND + lx;
      water.lz = (gzBar * level - levelGZ) / WATER_BODY_BLEND + lz;
    }
    return water;
  }

  function evaluate(x, z, masks) {
    waterAt(x, z);
    const shore = water.shore, sx = water.gx, sz = water.gz;
    shape.evaluate(x, z, shapeWork);
    const { n0, n0x, n0z, n2, n2x, n2z, outcrop, outcropX, outcropZ, upland } = shapeWork;
    let hills = shapeWork.height, hx = shapeWork.heightX, hz = shapeWork.heightZ;
    // The old analytic landform had no rock relief of its own, so the study
    // fixture lifted outcrops; a landscape (09-14) already carries its cliffs,
    // and lifting its knolls again put 8 m/m² bumps into gentle ground.
    if (!ridges && !shape.landscape) {
      // Rock exposure lifts the ground it breaks through, as it always has for
      // the study fixture; generated layouts get theirs from the same masks.
      hills += outcrop * settings.rockiness * 2.5;
      hx += outcropX * settings.rockiness * 2.5;
      hz += outcropZ * settings.rockiness * 2.5;
    }

    noise.gradient(x * 0.083 + 51.3, z * 0.083 - 8.2, noiseWork);
    const rough = banks.bankRoughness;
    const bankNoise = noiseWork[0] * rough, bnX = noiseWork[1] * 0.083 * rough, bnZ = noiseWork[2] * 0.083 * rough;
    // Bank geometry is one configurable profile: an underwater bed slope, an
    // alluvial beach, an optional flood terrace, then the shoulder climbing to
    // the surrounding land. Shore softness scales the whole thing horizontally.
    const bankSlope = (banks.bedSlope + bankNoise * banks.bedSlope * .317) / settings.shoreWidth;
    const clearance = 0.045 + settings.terrainStep * 0.14 / settings.shoreWidth;
    const unclamped = shore * bankSlope - clearance;
    // ⛔ A hard Math.max creased the lake floor along its exact max-depth
    // contour (a level line, so visually a straight-ish edge). softMax rounds
    // it through a third of a metre either side; the underwater floor is
    // unaffected everywhere it isn't already flat against that floor.
    const bedFloor = -water.depth;
    let bed = softMax(bedFloor, unclamped, BED_FLOOR_ROUND);
    const bedFloorWeight = softMaxDb(bedFloor, unclamped, BED_FLOOR_ROUND);
    let bx = bedFloorWeight * (sx * bankSlope + shore * bnX * banks.bedSlope * .317 / settings.shoreWidth);
    let bz = bedFloorWeight * (sz * bankSlope + shore * bnZ * banks.bedSlope * .317 / settings.shoreWidth);
    if (shore > 0) {
      // The underwater ramp rolls into an alluvial bench instead of continuing
      // uphill at the same angle. This only lowers dry vertices relative to the
      // original bank, retaining the wet triangle clearance at the exact shore.
      const apron = Math.max(1e-4, banks.beachWidth * settings.shoreWidth), decay = Math.exp(-shore / apron);
      const apronRise = apron * (1 - decay), floodSlope = (banks.beachGrade + bankNoise * banks.beachGrade * .327) / settings.shoreWidth;
      bed = bankSlope * apronRise + floodSlope * (shore - apronRise) - clearance;
      let along = floodSlope + (bankSlope - floodSlope) * decay;
      let across = (banks.bedSlope * .317 * apronRise + banks.beachGrade * .327 * (shore - apronRise)) / settings.shoreWidth;
      if (banks.bench > 0) {
        // A second, wider step: the floodplain terrace behind the beach. It only
        // ever removes rise, so the shore clearance above stays valid.
        const width = apron * 4.5, cut = banks.bench * floodSlope * width;
        const beyond = Math.max(0, shore - apronRise), fade = 1 - Math.exp(-beyond / width);
        bed -= cut * fade;
        const fadeSlope = Math.exp(-beyond / width) / width;
        along -= cut * fadeSlope;
        across -= 0;
      }
      bx = sx * along + bnX * across;
      bz = sz * along + bnZ * across;
    }
    const bedTexture = smooth(0.8, 2.8, -shore);
    bed += n2 * 0.055 * bedTexture;
    bx += n2x * 0.055 * bedTexture - n2 * 0.055 * smoothDerivative(0.8, 2.8, -shore) * sx;
    bz += n2z * 0.055 * bedTexture - n2 * 0.055 * smoothDerivative(0.8, 2.8, -shore) * sz;
    const bank = water.level + bed;
    bx += water.lx; bz += water.lz;
    // Limit the shoulder's elevation gain before meeting the original ridges.
    // A distance lerp between bank and hills adds (hills-bank)*blendDerivative:
    // tall uplands then produce a smooth, near-vertical wall in the same narrow
    // ring everywhere. This graded envelope rounds into the hillside without
    // making its rise proportional to that entire elevation gap.
    const shoulderStart = (banks.shoulderStart + bankNoise + n0 * 0.8) * settings.shoreWidth;
    const shoulderDistance = Math.max(0, shore - shoulderStart);
    let height = bank, heightX = bx, heightZ = bz;
    // P1-T-EROSION: how much of the FINAL height at this point is still the
    // raw, un-flattened landform (1) vs an authored bank/road/pad profile (0)
    // — hoisted out of the blocks below that already compute each piece,
    // purely so `worldPlanData.js` can fade its erosion correction out
    // exactly where the ground is a commanded flat (a lakebed, a road bed, a
    // building pad), instead of eroding gullies into ground that must stay
    // level. Read on in `evaluate`'s `result.naturalWeight` below.
    let hillWeight = 0;
    if (shoulderDistance > 0) {
      const dx = sx - (bnX + n0x * 0.8) * settings.shoreWidth;
      const dz = sz - (bnZ + n0z * 0.8) * settings.shoreWidth;
      const length = Math.max(.25, (banks.shoulderLength + n0 * 1.2) * settings.shoreWidth);
      const lx = n0x * 1.2 * settings.shoreWidth, lz = n0z * 1.2 * settings.shoreWidth;
      const u = shoulderDistance / length, decay = Math.exp(-u);
      const ramp = shoulderDistance - length * (1 - decay);
      const rampX = (1 - decay) * dx + (u * decay - (1 - decay)) * lx;
      const rampZ = (1 - decay) * dz + (u * decay - (1 - decay)) * lz;
      const reliefGrade = 0.85 + relief * 0.15;
      const wobble = banks.shoulderGrade * .229;
      const grade = (banks.shoulderGrade + n0 * wobble + outcrop * settings.rockiness * 0.075) * reliefGrade;
      const gradeX = (n0x * wobble + outcropX * settings.rockiness * 0.075) * reliefGrade;
      const gradeZ = (n0z * wobble + outcropZ * settings.rockiness * 0.075) * reliefGrade;
      const curvature = (0.006 + relief * 0.005) / settings.shoreWidth;
      const rise = grade * ramp + curvature * shoulderDistance * shoulderDistance;
      const riseX = gradeX * ramp + grade * rampX + 2 * curvature * shoulderDistance * dx;
      const riseZ = gradeZ * ramp + grade * rampZ + 2 * curvature * shoulderDistance * dz;
      const difference = hills - bank, direction = Math.sign(difference), gap = Math.abs(difference);
      // Polynomial smooth-min has weighted input gradients; it cannot add the
      // former height-gap derivative. Its bounded rounding fully recovers the
      // original hills once the shoulder has enough horizontal room to rise.
      // ⛔ Math.min(1.25, rise*0.3) creased wherever rise*0.3 crossed 1.25 (a
      // contour that moves with the terrain, so a wandering crease line, not
      // a fixed one). softMin rounds that cap the same way the profile it
      // feeds already rounds bank into hills.
      const roundingRaw = rise * 0.3;
      const rounding = softMin(1.25, roundingRaw, SHOULDER_ROUND_CAP);
      const roundingDerivative = softMinDb(1.25, roundingRaw, SHOULDER_ROUND_CAP) * 0.3;
      hillWeight = rounding > 1e-12 ? clamp(0.5 + 0.5 * (rise - gap) / rounding) : (gap < rise ? 1 : 0);
      const roundWeight = hillWeight * (1 - hillWeight);
      const gain = mix(rise, gap, hillWeight) - rounding * roundWeight;
      const riseWeight = direction * (1 - hillWeight - roundingDerivative * roundWeight);
      height += direction * gain;
      heightX = mix(bx, hx, hillWeight) + riseWeight * riseX;
      heightZ = mix(bz, hz, hillWeight) + riseWeight * riseZ;
    }
    hx = heightX; hz = heightZ;

    // Streaming: ease back to the raw landscape at the region border (see borderBlend).
    let borderWeight = 0;
    // The last few metres before the border, where even a road's graded skirt
    // must give way to the landscape (see the corridor block below).
    let edgeWeight = 0, edgeX = 0, edgeZ = 0;
    if (borderBlend > 0) {
      const ax = Math.abs(x), az = Math.abs(z), inset = half - Math.max(ax, az);
      borderWeight = 1 - smooth(0, borderBlend, inset);
      // d(inset)/dx is -sign(x) where |x| dominates, else 0 (and likewise for z).
      const insetX = ax >= az ? -Math.sign(x) : 0, insetZ = az > ax ? -Math.sign(z) : 0;
      edgeWeight = 1 - smooth(0, BORDER_EDGE, inset);
      const dEdge = -smoothDerivative(0, BORDER_EDGE, inset);
      edgeX = dEdge * insetX; edgeZ = dEdge * insetZ;
      if (borderWeight > 0) {
        const dWeight = -smoothDerivative(0, borderBlend, inset);
        const raw = shapeWork.height, previous = height;
        height = previous + (raw - previous) * borderWeight;
        hx = hx + (shapeWork.heightX - hx) * borderWeight + (raw - previous) * dWeight * insetX;
        hz = hz + (shapeWork.heightZ - hz) * borderWeight + (raw - previous) * dWeight * insetZ;
      }
    }

    // Roads grade the open ground first; the building pads below then cut their
    // own rectangles exactly. The planner keeps every pad's blend clear of a
    // carriageway, so the two never fight over the same metre of ground.
    // The network shares its junction vertices, so the nearest reach is enough:
    // two roads never disagree about the ground where they actually meet.
    let corridorWeight = 1;
    if (corridors) {
      const road = corridors.nearest(x, z);
      if (road) {
        const base = smooth(road.half, road.half + road.feather, road.distance);
        const baseDerivative = smoothDerivative(road.half, road.half + road.feather, road.distance);
        // Streaming: within BORDER_EDGE of the region border a road stops
        // grading, so where one reaches the edge it meets the streamed landscape
        // (a lane 2 m from the border left a 23 cm step). edgeWeight is 0 elsewhere.
        const blend = base + (1 - base) * edgeWeight;
        const previous = height, lift = previous - road.target;
        height = mix(road.target, height, blend);
        hx = hx * blend + lift * (baseDerivative * (1 - edgeWeight) * road.gx + (1 - base) * edgeX) + (1 - blend) * road.tx;
        hz = hz * blend + lift * (baseDerivative * (1 - edgeWeight) * road.gz + (1 - base) * edgeZ) + (1 - blend) * road.tz;
        corridorWeight = blend;
      }
    }

    let padBlend = 1;
    for (const pad of pads) {
      const c = Math.cos(pad.angle ?? 0), s = Math.sin(pad.angle ?? 0), dx = x - pad.center[0], dz = z - pad.center[2];
      // Same yaw convention as Three: local +Z faces [sin(yaw), cos(yaw)].
      const localX = c * dx - s * dz, localZ = s * dx + c * dz;
      const px = Math.abs(localX) - pad.halfWidth, pz = Math.abs(localZ) - pad.halfDepth;
      // ⛔ ROUNDED-RECTANGLE DISTANCE, NOT max(px, pz). The Chebyshev form
      // reaches `feather` along the axes but feather·√2 into the diagonals, so
      // a pad's skirt tilted the corner of a neighbour that the planner had
      // separated by exactly one feather — and a house that had passed every
      // separation check still stood on ground 5 cm off level. The planner's
      // guarantee is Euclidean; the falloff has to be too. Inside the rectangle
      // the old form is kept: there the blend and its derivative are both zero.
      let distance, lx, lz;
      if (px <= 0 && pz <= 0) {
        distance = Math.max(px, pz);
        lx = px >= pz ? Math.sign(localX) : 0;
        lz = px >= pz ? 0 : Math.sign(localZ);
      } else {
        const qx = Math.max(px, 0), qz = Math.max(pz, 0);
        distance = Math.hypot(qx, qz);
        const inverse = distance > 1e-12 ? 1 / distance : 0;
        lx = qx * inverse * Math.sign(localX);
        lz = qz * inverse * Math.sign(localZ);
      }
      const blend = smooth(0, pad.feather, distance), derivative = smoothDerivative(0, pad.feather, distance);
      const previousHeight = height;
      height = mix(pad.center[1], height, blend);
      const gx = lx * c + lz * s;
      const gz = lz * c - lx * s;
      hx = hx * blend + (previousHeight - pad.center[1]) * derivative * gx;
      hz = hz * blend + (previousHeight - pad.center[1]) * derivative * gz;
      padBlend *= blend;
    }

    result.height = height; result.shore = shore; result.waterLevel = water.level;
    result.depth = water.wet ? Math.max(0, water.level - height) : 0;
    result.slope = Math.hypot(hx, hz);
    // See the declaration above: 0 on a lakebed/beach still inside its
    // shoulder, on a road bed, or at a building pad's own centre; 1 once
    // fully clear of all three. `worldPlanData.js` scales its raw-relief
    // erosion correction by this so gullies/talus never disturb ground an
    // owner has commanded flat.
    result.naturalWeight = hillWeight * corridorWeight * padBlend;
    if (!masks) return result;

    let path2 = Infinity, laneMask = 0;
    for (const edge of pathEdges) {
      const t = clamp(((x - edge.ax) * edge.dx + (z - edge.az) * edge.dz) * edge.inverse);
      const distance2 = (x - edge.ax - edge.dx * t) ** 2 + (z - edge.az - edge.dz * t) ** 2;
      path2 = Math.min(path2, distance2);
      if (options.layout) laneMask = Math.max(laneMask, 1 - smooth(edge.width * .26, edge.width / 2 + .50, Math.sqrt(distance2)));
    }
    const dry = smooth(0.1, 0.9, shore), shoreGrass = smooth(0.8, 4.2, shore);
    const path = (options.layout ? laneMask : 1 - smooth(settings.pathWidth * 0.26, settings.pathWidth / 2 + 0.50, Math.sqrt(path2))) * dry;
    // Hollows in the fine relief hold damp ground on otherwise dry uplands.
    const gully = Math.pow(1 - Math.abs(n2), 7);
    const moisture = clamp(0.22 + 0.65 * Math.exp(-Math.max(0, shore) / 7.5) + n0 * 0.12 + gully * upland * 0.10);
    const grove = smooth(-0.48, 0.48, noise(x * 0.036 + 88.4, z * 0.036 - 17.6) + (settings.forestCover - 0.62) * 1.25);
    const forest = settings.forestCover === 0 ? 0 : grove * shoreGrass * (1 - smooth(0.58, 1.35, result.slope)) * (1 - path) * padBlend;
    const shoreRock = (1 - smooth(1.2, 5.5, Math.abs(shore))) * smooth(-0.04, 0.5, bankNoise) * 0.68;
    const rock = clamp((outcrop * 0.62 + smooth(0.45, 1.1, result.slope) * 0.70 + shoreRock) * settings.rockiness) * (1 - path * 0.94) * padBlend;
    result.moisture = water.wet ? 1 : moisture;
    result.forest = clamp(forest); result.rock = clamp(rock); result.path = clamp(path);
    return result;
  }

  function inExtent(x, z) {
    if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) {
      throw new RangeError('Valley fields: sample coordinates must be finite numbers');
    }
    return x >= -half && x <= half && z >= -half && z <= half;
  }
  function sample(x, z, out = {}) {
    if (!inExtent(x, z)) return null;
    const value = evaluate(x, z, true);
    for (const key of ['height', 'shore', 'waterLevel', 'depth', 'moisture', 'forest', 'rock', 'path', 'slope', 'naturalWeight']) out[key] = value[key];
    return out;
  }
  function sampleHeight(x, z) { return inExtent(x, z) ? evaluate(x, z, false).height : null; }
  // `shape` (the bare analytic landform, pre-bank/road/pad — see
  // `createTerrainShape`) is exposed so `worldPlanData.js` can bake and erode
  // the raw relief on its own grid, independent of this field's water/road/
  // pad composition (P1-T-EROSION; see `evaluate`'s `naturalWeight` above).
  return Object.freeze({ extent, domain, recipe, settings: Object.freeze(settings), sample, sampleHeight, shape });
}

/**
 * A `TerrainComponent#setShapeOverlay` descriptor built from an already
 * composed `createValleyFields` result (P1-T, 2026-09-13): World's own banks,
 * road corridors, building pads, ridges and escarpments on top of whatever
 * bare landform the Terrain component grows on its own from the shared
 * `terrain.*` params. `fields.sampleHeight` already runs that whole
 * composition (see `evaluate` above) — including the parts a bare Terrain
 * shape cannot reach at all (ridges/escarpments are folded into `fields`'s
 * own internal `createTerrainShape` call, not into Terrain's) — so `evaluate`
 * here trusts it outright rather than re-deriving the masks a partial
 * recomposition from `baseHeight` alone would need. `baseHeight` (Terrain's
 * own bare-landform value at that vertex) is used only as a fallback for a
 * point outside this field's extent.
 *
 * `samples` (typically the plan's own `baseHeights` — the pre-sculpt grid it
 * already walked once for its colour/ecology/grass pass, at the SAME
 * resolution Terrain's grid uses) lets the component skip the walk below
 * entirely: `fillHeightfield` copies it verbatim. `key` should be the plan's
 * `fieldKey` so an unrelated (scatter/look-only) regeneration — whose fields
 * are numerically identical — does not re-trigger a fill.
 */
export function createShapeOverlay(fields, { key = null, samples = null } = {}) {
  return {
    key,
    samples,
    evaluate(x, z, baseHeight) {
      const height = fields.sampleHeight(x, z);
      return height === null ? baseHeight : height;
    },
  };
}
