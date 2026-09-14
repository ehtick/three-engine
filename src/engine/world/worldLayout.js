import { createValleyFields } from './landscapeFields.js';
import { createWaterDomain } from '../../modules/water/worldWaterDomain.js';
import { planSettlements, entranceFor, fitPadFeathers } from './settlements.js';
import { WORLD_EXTENTS, worldParameter } from './worldConfig.js';
import { getLandscapeSteps } from '../terrain/landscapeGenerator.js';
import { worldLandscapeOptions } from '../terrain/proceduralTerrain.js';

/**
 * Bounded, renderer-independent layout: basins, watercourses, landform ridges
 * and cliff escarpments, settlements and the lanes between them. Every distance scales with the world
 * extent, and every count is a maximum — siting may return fewer when the
 * generated terrain has nowhere valid to put them. No fixed template is
 * transformed into place.
 */
export const WORLD_LAYOUT_LIMITS = Object.freeze({
  extents: WORLD_EXTENTS, maxLakes: worldParameter('layout.lakeCount').max,
  maxHouses: worldParameter('layout.houseCount').max, maxSettlements: worldParameter('settlement.count').max,
  roadSlope: .55, roadShoreMargin: .8,
});

const TAU = Math.PI * 2;
const ALWAYS_RUN = { due: () => false };
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export function worldRandom(seed, channel, index = 0) {
  // Mix these independently: (seed ^ channel) swaps X/Z streams when adjacent
  // seeds and adjacent channel numbers share the same low-bit difference.
  let value = Math.imul(seed + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(channel + 0x6d2b79f5, 0xc2b2ae35) ^ Math.imul(index + 1, 0x27d4eb2f);
  value = Math.imul(value ^ value >>> 16, 0x7feb352d);
  value = Math.imul(value ^ value >>> 15, 0x846ca68b);
  return ((value ^ value >>> 16) >>> 0) / 4294967296;
}
function number(value, fallback, min, max, name, integer = false) {
  const next = value ?? fallback;
  if (!Number.isFinite(next) || next < min || next > max || integer && !Number.isInteger(next)) throw new RangeError(`World layout ${name} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}`);
  return next;
}
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segmentDistance(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
  const t = length2 ? clamp(((x - a[0]) * dx + (z - a[1]) * dz) / length2) : 0;
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
}
function polygonDistance(x, z, points) {
  let inside = false, nearest = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    nearest = Math.min(nearest, segmentDistance(x, z, a, b));
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? -nearest : nearest;
}
function organicLake(seed, index, center, radiusX, radiusZ, level, depth) {
  const angle = worldRandom(seed, 110, index) * TAU, c = Math.cos(angle), s = Math.sin(angle);
  const phases = [0, 1, 2].map(channel => worldRandom(seed, 120 + channel, index) * TAU);
  const points = Array.from({ length: 56 }, (_, vertex) => {
    const a = vertex / 56 * TAU;
    const radius = 1 + (.10 + worldRandom(seed, 130, index) * .07) * Math.sin(a * 3 + phases[0]) + .055 * Math.sin(a * 5 + phases[1]) + .025 * Math.cos(a * 8 + phases[2]);
    const x = Math.cos(a) * radiusX * radius, z = Math.sin(a) * radiusZ * radius;
    return [center[0] + c * x - s * z, center[1] + s * x + c * z];
  });
  return { id: index ? `lake/${index}` : 'lake', center: [...center], points, level, depth };
}

/** Basins and watercourses. Rivers descend to a basin they can actually reach;
 * tributaries join their main reach at its own elevation, never above it. */
function makeWater(seed, extent, config) {
  const { lakeCount, lakeSize, lakeDepth, riverCount, tributaries, riverWidth, riverDepth, riverFall, meander } = config;
  const half = extent / 2, span = extent / 128;
  const center = [(-.133 + worldRandom(seed, 2) * .266) * extent, (-.133 + worldRandom(seed, 3) * .266) * extent];
  const wanted = lakeCount === 1 ? 1 : 1 + Math.floor(worldRandom(seed, 1) * lakeCount);
  const main = organicLake(seed, 0, center, (10 + worldRandom(seed, 4) * 7) * span * lakeSize,
    (8 + worldRandom(seed, 5) * 5) * span * lakeSize, 0, lakeDepth);
  const lakes = [main];
  for (let index = 1; index < wanted; index++) {
    for (let attempt = 0; attempt < 160; attempt++) {
      const key = index * 200 + attempt;
      const next = [(-.336 + worldRandom(seed, 21, key) * .672) * extent, (-.336 + worldRandom(seed, 22, key) * .672) * extent];
      const rx = (4.5 + worldRandom(seed, 23, index) * 4) * span * lakeSize, rz = (4 + worldRandom(seed, 24, index) * 3) * span * lakeSize;
      const radius = Math.max(rx, rz) * 1.25;
      if (lakes.some(body => polygonDistance(...next, body.points) < radius + 7 * span)) continue;
      lakes.push(organicLake(seed, index, next, rx, rz, (.8 + worldRandom(seed, 25, index) * 2.8) * span,
        (.8 + worldRandom(seed, 26, index) * 1.2) * lakeDepth / 2));
      break;
    }
  }

  const rivers = [];
  // A candidate reach is kept only if the shared water domain still compiles
  // with it: connected hydrology is validated here, not discovered as a crash
  // once terrain, buoyancy and the GPU raster are already reading the layout.
  const accept = candidate => {
    try { createWaterDomain({ lakes, rivers: [...rivers, candidate] }); } catch { return false; }
    rivers.push(candidate); return true;
  };
  for (let index = 0; index < riverCount; index++) {
    // Try several drainage directions: a course that would cross a second basin
    // at the wrong level is replaced, not silently dropped from the world.
    for (let attempt = 0; attempt < 6; attempt++) if (course(index, attempt)) break;
  }
  return { lakes, rivers };

  function course(index, attempt) {
    const target = lakes[index % lakes.length];
    const width = riverWidth * (index ? .72 : 1);
    const angle = (worldRandom(seed, 6, index) + index / Math.max(1, riverCount) + attempt / 6.7) * TAU;
    const direction = [Math.cos(angle), Math.sin(angle)], side = [-direction[1], direction[0]];
    // Solve the upstream boundary in this drainage direction, then keep the
    // entire finite-width river inside the terrain square.
    const safe = half - 5 - width / 2;
    const reach = Math.min(...direction.map((component, axis) => Math.abs(component) < 1e-8 ? Infinity : (safe + Math.sign(component) * target.center[axis]) / Math.abs(component)));
    if (!Number.isFinite(reach) || reach < width * 3) return false;
    const amplitude = (2 + worldRandom(seed, 7, index) * 9) * span * meander;
    const phase = worldRandom(seed, 8, index) * TAU, secondPhase = worldRandom(seed, 9, index) * TAU;
    const mouth = Math.max(...target.points.map(point => distance(point, target.center))) + width / 2 + 4 * span;
    const rise = target.level + riverFall * (.55 + worldRandom(seed, 10, index) * .75);
    const points = Array.from({ length: 57 }, (_, i) => {
      const t = i / 56, remaining = reach * (1 - t);
      const lateral = amplitude * Math.sin(Math.PI * t) * (.66 * Math.sin(TAU * t + phase) + .34 * Math.sin(TAU * 2 * t + secondPhase));
      return [target.center[0] - direction[0] * remaining + side[0] * lateral,
        target.level + (rise - target.level) * Math.pow(clamp((remaining - mouth) / Math.max(1, reach - mouth)), 1.25),
        target.center[1] - direction[1] * remaining + side[1] * lateral];
    });
    const id = index ? `river/${index}` : 'river';

    // Plan the junctions before the reach is published: a confluence needs a
    // level landing on both sides, and flattening to the downstream value keeps
    // the whole course monotonically descending.
    const spacing = reach / 56, branches = [];
    let lastJunction = -Infinity;
    for (let branch = 0; branch < tributaries; branch++) {
      const key = index * 37 + branch;
      const at = Math.round((.28 + worldRandom(seed, 60, key) * .5) * 56);
      const sideWidth = Math.max(1.2, width * (.42 + worldRandom(seed, 64, key) * .22));
      const flat = Math.ceil((width / 2 + sideWidth / 2 + 1.5) / Math.max(.05, spacing)) + 1;
      if (at - flat <= 1 || at + flat >= 55 || at - lastJunction < flat * 2 + 2) continue;
      const level = points[at + flat][1];
      for (let i = at - flat; i <= at + flat; i++) points[i][1] = level;
      lastJunction = at;
      branches.push({ key, at, sideWidth, flat, level });
    }
    if (!accept({ id, points, width, depth: riverDepth, downstream: target.id })) return false;

    for (const { key, at, sideWidth, flat, level } of branches) {
      const junction = points[at];
      const away = worldRandom(seed, 61, key) < .5 ? 1 : -1;
      const heading = angle + Math.PI / 2 * away + (worldRandom(seed, 62, key) - .5) * .9;
      const step = [Math.cos(heading), Math.sin(heading)];
      const room = Math.min(...step.map((component, axis) => Math.abs(component) < 1e-8 ? Infinity : (safe - Math.sign(component) * junction[axis * 2]) / Math.abs(component)));
      const length = Math.min(room, extent * (.16 + worldRandom(seed, 63, key) * .18));
      if (!Number.isFinite(length) || length < width * 4) continue;
      const climb = riverFall * (.35 + worldRandom(seed, 65, key) * .5);
      const wobble = amplitude * .55 * meander, wobblePhase = worldRandom(seed, 66, key) * TAU;
      const across = [-step[1], step[0]];
      const landing = Math.max(1, Math.ceil((width / 2 + sideWidth / 2 + 1.5) / (length / 24)));
      // Ordered source to mouth like every other reach: the far end is the high
      // source and the last points are a level landing into the confluence.
      const branchPoints = Array.from({ length: 25 }, (_, i) => {
        const t = 1 - i / 24, along = length * t;
        const lateral = wobble * Math.sin(Math.PI * t) * Math.sin(TAU * t + wobblePhase);
        const y = i >= 24 - landing ? level : level + climb * Math.pow(t, 1.2);
        return [junction[0] + step[0] * along + across[0] * lateral, y, junction[2] + step[1] * along + across[1] * lateral];
      });
      accept({ id: `${id}/branch-${key}`, points: branchPoints, width: sideWidth, depth: riverDepth * .7, downstream: id });
    }
    return true;
  }
}

/** A routed lane must clear the whole plot, not most of it: the pad rectangle
 * is already the building's footprint plus its working margin. */
function inBuilding(x, z, house, padding = 0) {
  const angle = house.rotation[1], c = Math.cos(angle), s = Math.sin(angle), dx = x - house.position[0], dz = z - house.position[2];
  return Math.abs(c * dx - s * dz) < house.halfWidth + padding && Math.abs(s * dx + c * dz) < house.halfDepth + padding;
}

/** Native field and world-space clearance/grade tests are also used to shorten
 * routes. A diagonal or smoothed shortcut cannot cut through a wet corner. */
function* routeGrid(fields, houses, width, extent, maxGrade, network = null, clock = ALWAYS_RUN) {
  const step = clamp(Math.round(extent / 64), 2, 6), half = extent / 2 - 4, n = Math.round(half * 2 / step) + 1;
  const valid = new Uint8Array(n * n), heights = new Float64Array(n * n);
  const linkChecks = new Map();
  const point = index => [index % n * step - half, Math.floor(index / n) * step - half];
  const index = ([x, z]) => clamp(Math.round((z + half) / step), 0, n - 1) * n + clamp(Math.round((x + half) / step), 0, n - 1);
  const clear = (x, z) => {
    const field = fields.sample(x, z);
    return field && field.shore >= width / 2 + WORLD_LAYOUT_LIMITS.roadShoreMargin && field.slope <= WORLD_LAYOUT_LIMITS.roadSlope - .01 && !houses.some(house => inBuilding(x, z, house, width / 2));
  };
  for (let id = 0; id < valid.length; id++) {
    if ((id & 63) === 0 && clock.due()) yield 'roads';
    const [x, z] = point(id), field = fields.sample(x, z); heights[id] = field ? field.height : 0;
    valid[id] = clear(x, z) ? 1 : 0;
  }
  const segmentClear = (a, b) => {
    // River-segment level gradients and pad shoulders can change inside one
    // terrain cell. Sub-cell checks must also constrain long simplified lanes.
    const length = distance(a, b), samples = Math.max(1, Math.ceil(length / .25));
    let previous = fields.sampleHeight(...a);
    if (previous === null) return false;
    for (let sample = 0; sample <= samples; sample++) {
      const t = sample / samples, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      if (!clear(x, z)) return false;
      const height = fields.sampleHeight(x, z);
      if (sample && Math.abs(height - previous) / (length / samples) > maxGrade - .015) return false;
      previous = height;
    }
    return true;
  };
  function* route(startPoint, endPoint) {
    const start = index(startPoint), end = index(endPoint);
    if (start === end || !valid[start] || !valid[end] || distance(point(start), startPoint) > 1e-8 || distance(point(end), endPoint) > 1e-8) return null;
    const costs = new Float64Array(valid.length).fill(Infinity), previous = new Int32Array(valid.length).fill(-1);
    const closed = new Uint8Array(valid.length), queue = [];
    const push = entry => { let i = queue.length; queue.push(entry); while (i) { const p = (i - 1) >> 1; if (queue[p][1] <= entry[1]) break; queue[i] = queue[p]; i = p; } queue[i] = entry; };
    const pop = () => { const top = queue[0], last = queue.pop(); if (queue.length) { let i = 0; while (i * 2 + 1 < queue.length) { let child = i * 2 + 1; if (child + 1 < queue.length && queue[child + 1][1] < queue[child][1]) child++; if (queue[child][1] >= last[1]) break; queue[i] = queue[child]; i = child; } queue[i] = last; } return top[0]; };
    costs[start] = 0; push([start, 0]);
    let visited = 0;
    while (queue.length) {
      // A search over a large world is thousands of expansions, each of which
      // sub-samples the field; without a safe point it is a visible hitch.
      // Every 16 cells: a visit samples the terrain several times, and on the
      // 09-14 landscape 256 visits between clock checks were a 1.8 s block.
      if ((++visited & 15) === 0 && clock.due()) yield 'roads';
      const current = pop(); if (closed[current]) continue; closed[current] = 1;
      if (current === end) {
        const points = []; for (let at = end; at !== -1; at = previous[at]) points.push(point(at)); points.reverse();
        const compact = [points[0]];
        for (let from = 0; from < points.length - 1;) {
          let to = points.length - 1; while (to > from + 1 && !segmentClear(points[from], points[to])) to--;
          compact.push(points[to]); from = to;
        }
        return compact;
      }
      const cx = current % n, cz = Math.floor(current / n), a = point(current);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dz) || cx + dx < 0 || cx + dx >= n || cz + dz < 0 || cz + dz >= n) continue;
        const next = current + dz * n + dx;
        if (!valid[next] || closed[next]) continue;
        const b = point(next), length = Math.hypot(dx, dz) * step, rise = Math.abs(heights[next] - heights[current]);
        if (rise / length > maxGrade) continue;
        // Running along a road that already exists is nearly free, so a new lane
        // joins the network instead of laying a second surface beside it.
        const shared = network && onNetwork(network, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2) ? .06 : 1;
        const linkKey = Math.min(current, next) * valid.length + Math.max(current, next);
        let passable = linkChecks.get(linkKey);
        if (passable === undefined) { passable = segmentClear(a, b); linkChecks.set(linkKey, passable); }
        if (!passable) continue;
        const cost = costs[current] + (length + rise * 8) * shared;
        if (cost >= costs[next]) continue;
        costs[next] = cost; previous[next] = current; push([next, cost + distance(b, point(end))]);
      }
    }
    return null;
  }
  return { route, snap: value => point(index(value)) };
}

const padOf = house => ({ id: house.id, center: [...house.position], angle: house.rotation[1],
  halfWidth: house.halfWidth, halfDepth: house.halfDepth, feather: house.feather });

/** Insert points so a road samples the ground it crosses closely enough to
 * follow it. A 4 m step cannot follow a 4 m wide street it crosses. */
function densify(points, spacing) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], steps = Math.max(1, Math.ceil(distance(a, b) / spacing));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Where two road centrelines cross, as a parameter on each segment. */
function crossing(a1, a2, b1, b2) {
  const ax = a2[0] - a1[0], az = a2[1] - a1[1], bx = b2[0] - b1[0], bz = b2[1] - b1[1];
  const denominator = ax * bz - az * bx;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((b1[0] - a1[0]) * bz - (b1[1] - a1[1]) * bx) / denominator;
  const u = ((b1[0] - a1[0]) * az - (b1[1] - a1[1]) * ax) / denominator;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return { t, u, point: [a1[0] + ax * t, a1[1] + az * t] };
}

/** Split every road where it crosses another so the two share that vertex. */
function splitAtCrossings(roads) {
  for (const road of roads) road.pinned = new Set();
  for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
    const a = roads[i], b = roads[j], inserts = [[], []];
    for (let ai = 1; ai < a.points.length; ai++) for (let bi = 1; bi < b.points.length; bi++) {
      const hit = crossing(a.points[ai - 1], a.points[ai], b.points[bi - 1], b.points[bi]);
      if (hit) { inserts[0].push({ index: ai, point: hit.point }); inserts[1].push({ index: bi, point: hit.point }); }
    }
    for (const [road, list] of [[a, inserts[0]], [b, inserts[1]]]) {
      if (!list.length) continue;
      list.sort((x, y) => y.index - x.index);
      for (const { index, point } of list) road.points.splice(index, 0, point);
    }
  }
  // ⛔ T-junctions: a lane that ENDS on a street never crosses it, so it never
  // got a shared vertex, and the ground where they met took whichever reach was
  // nearest — a 10 cm step at seed 4294967295 on the 09-14 landscape. Snap every
  // road end that lies on another road's carriageway onto a vertex of that road.
  for (const road of roads) for (const end of [0, road.points.length - 1]) {
    const p = road.points[end];
    let best = null;
    for (const other of roads) {
      if (other === road) continue;
      for (let i = 1; i < other.points.length; i++) {
        const a = other.points[i - 1], b = other.points[i], dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
        if (length2 < 1e-12) continue;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length2));
        const q = [a[0] + dx * t, a[1] + dz * t], gap = distance(p, q);
        // Only an end routed onto the carriageway itself: a building entrance a
        // couple of metres off a street must keep its own lane end (snapping it
        // across dragged lane/cottage through the plot at seed 895).
        if (gap <= .6 && (!best || gap < best.gap)) best = { other, i, q, gap };
      }
    }
    if (!best) continue;
    const { other, i, q } = best;
    let shared = distance(q, other.points[i - 1]) <= .3 ? other.points[i - 1] : distance(q, other.points[i]) <= .3 ? other.points[i] : null;
    if (!shared) { shared = q; other.points.splice(i, 0, shared); }
    road.points[end] = shared;
  }
  // Three roads meeting produce three crossings a few millimetres apart. Merge
  // vertices that are effectively the same place onto one exact coordinate, or
  // the network keeps two profiles for a junction that only exists once.
  const junctions = [];
  for (const road of roads) road.points.forEach((point, index) => {
    const existing = junctions.find(other => distance(other.point, point) <= .3);
    if (existing) { existing.users.add(road); road.points[index] = existing.point; }
    else junctions.push({ point, users: new Set([road]) });
  });
  for (const junction of junctions) {
    if (junction.users.size < 2) continue;
    for (const road of junction.users) road.points.forEach((point, index) => { if (point === junction.point) road.pinned.add(index); });
  }
  // A merged vertex can now coincide with its own neighbour; drop the duplicate.
  for (const road of roads) {
    const points = [], pinned = new Set();
    for (const point of road.points) {
      if (points.length && distance(points.at(-1), point) < 1e-9) continue;
      if (road.pinned.has(road.points.indexOf(point))) pinned.add(points.length);
      points.push(point);
    }
    road.points = points; road.pinned = pinned;
  }
  return roads;
}

/** Bring one road's profile inside its grade limit without moving a junction.
 * Junctions are shared vertices; letting them drift would tear the network. */
function relaxProfile(road, maxGrade) {
  const { points, elevations, pinned } = road, n = points.length;
  const spans = points.slice(1).map((point, index) => Math.max(1e-4, distance(points[index], point)));
  for (let pass = 0; pass < 64; pass++) {
    let worst = 0;
    for (let direction = 0; direction < 2; direction++) {
      for (let step = 0; step < n - 1; step++) {
        const i = direction ? n - 2 - step : step, j = i + 1;
        const limit = maxGrade * spans[i], difference = elevations[j] - elevations[i];
        const excess = Math.abs(difference) - limit;
        if (excess <= 1e-9) continue;
        worst = Math.max(worst, excess);
        const sign = Math.sign(difference);
        const movable = [!pinned.has(i), !pinned.has(j)];
        if (movable[0] && movable[1]) { elevations[i] += sign * excess / 2; elevations[j] -= sign * excess / 2; }
        else if (movable[0]) elevations[i] += sign * excess;
        else if (movable[1]) elevations[j] -= sign * excess;
      }
    }
    if (worst <= 1e-9) break;
  }
  return road;
}

/**
 * Give the whole road network one consistent surface.
 *
 * Every road samples the same ground and shares its junction vertices, so two
 * roads cannot disagree about the height where they meet. Each reach is then
 * relaxed to its grade limit with those junctions held, which is what makes a
 * street on a hillside walkable instead of merely painted on.
 */
function* gradeRoadNetwork(roads, fields, maxGrade, clock = ALWAYS_RUN) {
  splitAtCrossings(roads);
  for (const road of roads) {
    if (clock.due()) yield 'roads';
    // Sliced: a long street densified to 1.5 m is hundreds of terrain samples
    // (a 1 s block on the 09-14 landscape when sampled in one go).
    road.elevations = new Array(road.points.length);
    for (let i = 0; i < road.points.length; i++) {
      if ((i & 31) === 31 && clock.due()) yield 'roads';
      const [x, z] = road.points[i];
      road.elevations[i] = fields.sampleHeight(x, z) ?? 0;
    }
    relaxProfile(road, maxGrade);
  }
  // Relaxation moved unpinned vertices; junctions stayed put, so the shared
  // heights still agree. Drop the working set before the layout is serialized.
  for (const road of roads) delete road.pinned;
  return roads;
}

/** True where an existing road already surfaces this ground. */
function onNetwork(roads, x, z, slack = .4) {
  for (const road of roads) {
    const keep = road.width / 2 + slack;
    for (let i = 1; i < road.points.length; i++) {
      if (segmentDistance(x, z, road.points[i - 1], road.points[i]) <= keep) return true;
    }
  }
  return false;
}

/**
 * Split a routed lane into the pieces that are genuinely new surface.
 *
 * A lane that runs along an existing road must not lay a second, slightly
 * different profile over it: two overlapping corridors disagree about the
 * ground between them. Each new run keeps one point on the network at either
 * end, so the spur still meets the road it joins.
 */
function newRuns(lane, network) {
  if (!network.length) return [lane];
  const on = lane.points.map(([x, z]) => onNetwork(network, x, z));
  const runs = [];
  for (let start = 0; start < lane.points.length;) {
    if (on[start]) { start++; continue; }
    let end = start;
    while (end + 1 < lane.points.length && !on[end + 1]) end++;
    const from = Math.max(0, start - 1), to = Math.min(lane.points.length - 1, end + 1);
    if (to - from >= 1) runs.push([from, to]);
    start = end + 1;
  }
  return runs.map(([from, to], index) => ({ ...lane, id: index ? `${lane.id}#${index + 1}` : lane.id,
    points: lane.points.slice(from, to + 1) }));
}

/** Connect places with routed lanes, returning the lanes and any place the
 * router could not reach without an invented bridge or hillside cut. */
function* connect(fields, nodes, buildings, width, extent, maxGrade, prefix, existing = [], clock = ALWAYS_RUN) {
  // `served` is the third outcome, and leaving it out is what let a house end
  // up on no road at all: a route whose whole length is already covered by the
  // network trims to nothing, so the node is joined and yet no lane carries its
  // name. It is not unreachable — it is standing on a street that never learned
  // its address. Naming that street is the difference.
  const lanes = [], unreachable = [], served = new Map(), network = [...existing];
  if (nodes.length < 2) return { lanes, unreachable, served };
  const grid = yield* routeGrid(fields, buildings, width, extent, maxGrade, network, clock);
  const connected = [nodes[0]];
  for (const node of nodes.slice(1)) {
    const neighbors = [...connected].sort((a, b) => distance(node.at, a.at) - distance(node.at, b.at));
    let joined = false;
    for (const neighbor of neighbors) {
      const points = yield* grid.route(grid.snap(node.at), grid.snap(neighbor.at));
      if (!points) continue;
      const runs = newRuns({ id: `${prefix}/${node.id}`, kind: 'lane', from: node.id, to: neighbor.id, points, width }, network);
      if (runs.length) { lanes.push(...runs); network.push(...runs); }
      else { const road = nearestRoad(network, node.at, width * 2 + 6); if (road) served.set(node.id, road); }
      connected.push(node); joined = true; break;
    }
    if (!joined) unreachable.push(node.id);
  }
  return { lanes, unreachable, served };
}

/** The road a point already stands on, or null. Used to give an address to a
 * node whose connecting lane was entirely absorbed by the existing network. */
function nearestRoad(network, at, reach) {
  let best = null, bestDistance = reach;
  for (const road of network) {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1], b = road.points[i];
      const dx = b[0] - a[0], dz = b[1] - a[1], span = dx * dx + dz * dz;
      const t = span > 1e-12 ? Math.max(0, Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dz) / span)) : 0;
      const gap = Math.hypot(at[0] - a[0] - dx * t, at[1] - a[1] - dz * t);
      if (gap < bestDistance) { bestDistance = gap; best = road.id; }
    }
  }
  return best;
}

/** Drive the whole layout now: tests, export and the runtime player. */
export function createWorldLayout(options = {}) {
  const steps = worldLayoutSteps(options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

/** Resumable layout. Site scoring, street growth and road routing all sample
 * the shared fields thousands of times; each is a safe point for the caller. */
export function* worldLayoutSteps(options = {}) {
  const clock = options.clock ?? ALWAYS_RUN;
  const seed = number(options.seed, 894, 0, 0xffffffff, 'seed', true);
  const extent = number(options.extent, 128, 96, 1024, 'extent');
  if (!WORLD_EXTENTS.includes(extent)) throw new RangeError(`World layout extent must be one of ${WORLD_EXTENTS.join(', ')}`);
  const geography = options.geography ?? {}, terrain = options.terrain ?? {}, waterConfig = options.water ?? {};
  const settlementConfig = options.settlement ?? {};
  const lakeCount = number(options.lakeCount, 2, 1, WORLD_LAYOUT_LIMITS.maxLakes, 'lakeCount', true);
  const houseCount = options.buildings === false ? 0 : number(options.houseCount, 5, 0, WORLD_LAYOUT_LIMITS.maxHouses, 'houseCount', true);
  const riverMeander = number(options.riverMeander, .65, 0, 1, 'riverMeander');
  const settlementSpread = number(options.settlementSpread, .65, 0, 1, 'settlementSpread');
  const riverWidth = number(options.riverWidth ?? geography.riverWidth, 5, 2, 24, 'riverWidth');
  const laneWidth = number(options.pathWidth ?? settlementConfig.laneWidth ?? geography.pathWidth, 2.2, .6, 8, 'laneWidth');
  const maxGrade = number(settlementConfig.maxGrade, .35, .08, 1, 'maxGrade');

  const water = makeWater(seed, extent, {
    lakeCount, lakeSize: waterConfig.lakeSize ?? 1, lakeDepth: waterConfig.lakeDepth ?? geography.lakeDepth ?? 2,
    riverCount: waterConfig.riverCount ?? 1, tributaries: waterConfig.tributaries ?? 0,
    riverWidth, riverDepth: waterConfig.riverDepth ?? geography.riverDepth ?? 1.2,
    riverFall: waterConfig.riverFall ?? 3, meander: riverMeander,
  });
  const layout = {
    version: 1, seed, extent, ...water,
    // Landforms belong to the landscape now (style, levels, towers, plates):
    // the layout carries no analytic ridges or escarpments (09-14).
    ridges: [], escarpments: [],
    settlements: [], buildings: [], buildingPads: [], lanes: [],
    requested: { lakeCount, houseCount, riverMeander, settlementSpread },
  };
  const fieldOptions = { ...geography, terrain, water: waterConfig, seed, extent, riverWidth, pathWidth: laneWidth, layout };
  // The landscape's macro build (0.5-1.3 s for a streamed 2048 m extent) used to
  // run inside the first field evaluation as one block. Build it sliced first;
  // every `createValleyFields` below then finds it in the landscape cache.
  yield* getLandscapeSteps(worldLandscapeOptions(terrain, { seed, extent }), clock);
  const bare = createValleyFields(fieldOptions);
  yield 'layout';

  const plan = planSettlements({
    fields: bare, extent, budget: houseCount, footprint: options.footprint ?? null,
    random: (channel, index = 0) => worldRandom(seed, 500 + channel, index),
    settlement: {
      count: settlementConfig.count ?? 1, pattern: settlementConfig.pattern ?? 'cluster', spread: settlementSpread,
      waterAffinity: settlementConfig.waterAffinity ?? .5, plotFrontage: settlementConfig.plotFrontage ?? 22,
      setback: settlementConfig.setback ?? 4.5, orientationJitter: settlementConfig.orientationJitter ?? .25,
      roadWidth: settlementConfig.roadWidth ?? 4, maxGrade, outbuildings: settlementConfig.outbuildings ?? .3,
      landmark: settlementConfig.landmark ?? true, buildingScale: settlementConfig.buildingScale ?? 1,
    },
  });
  layout.settlements = plan.settlements;
  layout.buildings = plan.buildings;
  layout.buildingPads = plan.buildings.map(padOf);
  layout.lanes = plan.roads.map(road => ({ ...road, kind: road.kind ?? 'street', points: densify(road.points, 1.5), elevations: [] }));
  yield 'roads';
  yield* gradeRoadNetwork(layout.lanes, bare, maxGrade, clock);
  layout.siting = plan.report;

  // Lanes between places are routed on the field that already carries the pads
  // and streets, so a connecting path cannot cut across a lot or a main street.
  if (plan.settlements.length > 1 || plan.buildings.some(building => !building.street)) {
    const graded = createValleyFields(fieldOptions);
    const nodes = plan.settlements.map(place => ({ id: place.id, at: place.center }));
    for (const building of plan.buildings) if (!building.street) nodes.push({ id: building.id, at: building.entrance });
    const { lanes, unreachable, served } = yield* connect(graded, nodes, plan.buildings, laneWidth, extent, maxGrade, 'lane', layout.lanes, clock);
    for (const building of plan.buildings) if (!building.street && served.has(building.id)) building.street = served.get(building.id);
    layout.lanes.push(...lanes.map(lane => ({ ...lane, points: densify(lane.points, 1.5), elevations: [] })));
    yield* gradeRoadNetwork(layout.lanes, bare, maxGrade, clock);
    if (unreachable.length) layout.unconnected = unreachable;
  }
  layout.actual = { lakes: layout.lakes.length, rivers: layout.rivers.length, houses: layout.buildings.length,
    settlements: layout.settlements.length, lanes: layout.lanes.length };
  return layout;
}

/** Refit paths to authored house poses without moving or deleting any house.
 * Unreachable entrances are reported explicitly; a manual placement never
 * receives an invented bridge or loses its authored pose to make routing pass. */
export function refitWorldLayout(source, options = {}) {
  const steps = refitWorldLayoutSteps(source, options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

export function* refitWorldLayoutSteps(source, { geography = {}, terrain = {}, water = {}, settlement = {}, riverWidth, pathWidth, clock = ALWAYS_RUN } = {}) {
  const layout = structuredClone(source);
  const extent = layout.extent, maxGrade = settlement.maxGrade ?? .35;
  const width = pathWidth ?? settlement.laneWidth ?? geography.pathWidth ?? source.lanes.find(lane => lane.kind === 'lane')?.width ?? 2.2;
  // An authored move can take a house off the street it was planned on. Once it
  // no longer fronts that street it needs its own routed lane, which is also
  // how an unreachable authored pose gets reported instead of silently kept.
  const streets = new Map(layout.lanes.filter(lane => lane.kind !== 'lane').map(lane => [lane.id, lane]));
  layout.buildings = layout.buildings.map(house => {
    const street = streets.get(house.street);
    const fronts = street && street.points.some(([x, z]) =>
      Math.hypot(x - house.position[0], z - house.position[2]) <= house.halfDepth + street.width / 2 + 6);
    return { ...house, street: fronts ? house.street : null,
      entrance: entranceFor(house.position[0], house.position[2], house.rotation[1], house.halfDepth) };
  });
  layout.buildingPads = layout.buildings.map(padOf);
  // Streets belong to the settlement plan and keep their shape; only the lanes
  // that connect places are re-routed around the authored poses.
  layout.lanes = layout.lanes.filter(lane => lane.kind !== 'lane');
  const fieldOptions = { ...geography, terrain, water, seed: layout.seed, extent, layout,
    ...(riverWidth === undefined ? {} : { riverWidth }), pathWidth: width };
  const fields = createValleyFields(fieldOptions);
  const nodes = [];
  const seen = new Set();
  for (const place of layout.settlements ?? []) { nodes.push({ id: place.id, at: place.center }); seen.add(place.id); }
  for (const house of layout.buildings) if (!house.street) nodes.push({ id: house.id, at: house.entrance });
  const { lanes, unreachable, served } = yield* connect(fields, nodes, layout.buildings, width, extent, maxGrade, 'lane', layout.lanes, clock);
  for (const house of layout.buildings) if (!house.street && served.has(house.id)) house.street = served.get(house.id);
  layout.lanes.push(...lanes.map(lane => ({ ...lane, points: densify(lane.points, 1.5), elevations: [] })));
  yield* gradeRoadNetwork(layout.lanes, createValleyFields({ ...fieldOptions, layout: { ...layout, lanes: [] } }), maxGrade, clock);
  // An authored move changes which plots and roads a pad is crowded by, so its
  // blend is refitted; otherwise a neighbour's skirt tilts the moved house.
  fitPadFeathers(layout.buildings, layout.lanes, extent);
  layout.buildingPads = layout.buildings.map(padOf);
  layout.unconnected = unreachable;
  layout.actual = { lakes: layout.lakes.length, rivers: layout.rivers.length, houses: layout.buildings.length,
    settlements: (layout.settlements ?? []).length, lanes: layout.lanes.length };
  return layout;
}
