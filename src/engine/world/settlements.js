/**
 * Procedural settlements: where people build, how their streets run and which
 * plot each building stands on. Everything is derived from the shared landscape
 * fields, so a settlement cannot appear in a lake, on a cliff or across a road
 * it is supposed to face.
 *
 * The planner is renderer-independent and a pure function of its inputs. It
 * returns plain JSON so a layout can be serialized, diffed and replayed.
 */

const TAU = Math.PI * 2;
const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export const SETTLEMENT_PATTERNS = Object.freeze(['scattered', 'cluster', 'street', 'grid']);

/**
 * Building roles. `families` selects construction families from the building
 * generator by congruence, so a role reliably reads as a barn or a hall rather
 * than only carrying a label; `scale` and the pad give it its own footprint.
 */
export const BUILDING_ROLES = Object.freeze({
  house: { families: [0, 2, 3], scale: 1, feather: 2.6 },
  barn: { families: [1], scale: 1.14, feather: 2.8 },
  hall: { families: [2], scale: 1.38, feather: 3.2 },
});

/** Used when the caller supplies no building generator; the real dimensions
 * come from `footprint(variationSeed, role)` so a pad is sized for the building
 * that will actually stand on it. */
const DEFAULT_FOOTPRINT = Object.freeze({ width: 11, depth: 7 });

/** A seed for the building generator that lands in one construction family. */
function familySeed(random, role, index) {
  const families = BUILDING_ROLES[role].families;
  const family = families[Math.floor(random(70 + index) * families.length) % families.length];
  return (Math.floor(random(71 + index) * 0x3fffffff) * 4 + family) >>> 0;
}

function rectanglesOverlap(a, b, margin) {
  // Separating-axis test on both rectangles' own axes: settlements rotate their
  // plots to their street, so an axis-aligned bound would refuse valid lots.
  const dx = b.center[0] - a.center[0], dz = b.center[2] - a.center[2];
  for (const owner of [a, b]) {
    const other = owner === a ? b : a;
    const c = Math.cos(owner.angle), s = Math.sin(owner.angle);
    const along = Math.abs(c * dx - s * dz), across = Math.abs(s * dx + c * dz);
    const relative = other.angle - owner.angle, rc = Math.abs(Math.cos(relative)), rs = Math.abs(Math.sin(relative));
    if (along > owner.halfWidth + other.halfWidth * rc + other.halfDepth * rs + margin) return false;
    if (across > owner.halfDepth + other.halfWidth * rs + other.halfDepth * rc + margin) return false;
  }
  return true;
}

/** Conservative clearance between two plots: the largest separating-axis gap,
 * which is never more than the true distance between the rectangles. */
function rectangleGap(a, b) {
  const dx = b.center[0] - a.center[0], dz = b.center[2] - a.center[2];
  let gap = -Infinity;
  for (const owner of [a, b]) {
    const other = owner === a ? b : a;
    const c = Math.cos(owner.angle), s = Math.sin(owner.angle);
    const along = Math.abs(c * dx - s * dz), across = Math.abs(s * dx + c * dz);
    const relative = other.angle - owner.angle, rc = Math.abs(Math.cos(relative)), rs = Math.abs(Math.sin(relative));
    gap = Math.max(gap, along - owner.halfWidth - other.halfWidth * rc - other.halfDepth * rs);
    gap = Math.max(gap, across - owner.halfDepth - other.halfWidth * rs - other.halfDepth * rc);
  }
  return gap;
}

/** Ground under one lot: its level and the cut its pad would need, or a reason
 * the spot is wet, too steep or too broken to build on. */
function padAt(fields, x, z, angle, halfWidth, halfDepth, limits) {
  const c = Math.cos(angle), s = Math.sin(angle);
  let low = Infinity, high = -Infinity, total = 0, samples = 0;
  for (const u of [-1, -.5, 0, .5, 1]) for (const v of [-1, 0, 1]) {
    const px = x + c * u * halfWidth - s * v * halfDepth, pz = z + s * u * halfWidth + c * v * halfDepth;
    const field = fields.sample(px, pz);
    if (!field) return { reason: 'bounds' };
    if (field.shore < limits.shore) return { reason: 'water' };
    if (field.slope > limits.slope) return { reason: 'slope' };
    low = Math.min(low, field.height); high = Math.max(high, field.height);
    total += field.height; samples++;
  }
  if (high - low > limits.drop) return { reason: 'slope' };
  return { level: total / samples, drop: high - low };
}

/** True when a plot keeps clear of every carriageway, including the side
 * streets it does not front. A lot the road runs through is not a lot. */
function clearOfRoads(box, roads, margin) {
  const c = Math.cos(box.angle), s = Math.sin(box.angle);
  for (const road of roads) {
    const keep = road.width / 2 + margin;
    // ⛔ THE CIRCUMRADIUS OF THE GROWN RECTANGLE, NOT THE GROWN CIRCUMRADIUS.
    // `hypot(hw, hd) + keep` is smaller than `hypot(hw + keep, hd + keep)`, so
    // this early-out skipped segments that genuinely clipped a plot corner —
    // seed 896's main street ran 27 cm inside the house that fronts it, and no
    // amount of care in the test below could see a segment it never reached.
    const reach = Math.hypot(box.halfWidth + keep, box.halfDepth + keep);
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1], b = road.points[i];
      const dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
      const t = length2 ? clamp(((box.center[0] - a[0]) * dx + (box.center[2] - a[1]) * dz) / length2) : 0;
      const px = a[0] + dx * t, pz = a[1] + dz * t;
      if (Math.hypot(px - box.center[0], pz - box.center[2]) > reach) continue;
      // ⛔ CLIPPED, NOT SAMPLED. This walked the segment in one-metre steps and
      // so could step straight over a corner: seed 896 put a main street 20 cm
      // inside the plot of the very house that fronts it. A slab clip in the
      // plot's own frame is exact at any length, and cheaper than stepping.
      const ax = a[0] - box.center[0], az = a[1] - box.center[2];
      const lax = c * ax - s * az, laz = s * ax + c * az;
      const ldx = c * dx - s * dz, ldz = s * dx + c * dz;
      let enter = 0, leave = 1;
      for (const [origin, delta, limit] of [[lax, ldx, box.halfWidth + keep], [laz, ldz, box.halfDepth + keep]]) {
        if (Math.abs(delta) < 1e-12) { if (Math.abs(origin) > limit) { enter = 1; leave = 0; } continue; }
        const first = (-limit - origin) / delta, second = (limit - origin) / delta;
        enter = Math.max(enter, Math.min(first, second));
        leave = Math.min(leave, Math.max(first, second));
      }
      if (enter <= leave) return false;
    }
  }
  return true;
}

/** Distance from a plot to the nearest carriageway edge. A pad may flatten its
 * own ground but must not reach across a road and put a step in it. */
function roadGap(box, roads) {
  const c = Math.cos(box.angle), s = Math.sin(box.angle);
  let gap = Infinity;
  for (const road of roads) {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1], b = road.points[i];
      const dx = b[0] - a[0], dz = b[1] - a[1], steps = Math.max(2, Math.ceil(Math.hypot(dx, dz)));
      for (let step = 0; step <= steps; step++) {
        const u = step / steps, ox = a[0] + dx * u - box.center[0], oz = a[1] + dz * u - box.center[2];
        const lx = Math.abs(c * ox - s * oz) - box.halfWidth, lz = Math.abs(s * ox + c * oz) - box.halfDepth;
        gap = Math.min(gap, Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) - road.width / 2);
      }
    }
  }
  return gap;
}

/** Grow a street outwards from a point, following ground it can actually climb. */
function growStreet(fields, start, heading, options) {
  const { step, length, maxGrade, width, random, key, wander = 1 } = options;
  const points = [[...start]];
  let at = [...start], direction = heading, travelled = 0, previous = fields.sampleHeight(...start);
  const turns = [0, .12, -.12, .25, -.25, .42, -.42, .62, -.62];
  while (travelled < length) {
    let best = null;
    for (const turn of turns) {
      const angle = direction + turn * wander;
      const next = [at[0] + Math.sin(angle) * step, at[1] + Math.cos(angle) * step];
      const field = fields.sample(...next);
      // Cross-slope is allowed: a lane along a hillside is normal. The grade the
      // road itself climbs is the constraint that keeps it walkable.
      if (!field || field.shore < width / 2 + .8 || field.slope > maxGrade * 2.6) continue;
      const grade = Math.abs(field.height - previous) / step;
      if (grade > maxGrade) continue;
      // The whole segment must be dry, not just its endpoints: a straight step
      // between two dry points can still clip the inside of a river bend.
      const samples = Math.max(2, Math.ceil(step / .4));
      let dry = true;
      for (let sample = 1; sample < samples && dry; sample++) {
        const t = sample / samples;
        const between = fields.sample(at[0] + (next[0] - at[0]) * t, at[1] + (next[1] - at[1]) * t);
        dry = !!between && between.shore >= width / 2 + .8;
      }
      if (!dry) continue;
      const cost = grade * 9 + Math.abs(turn) * 1.7 + random(key + points.length) * .35;
      if (!best || cost < best.cost) best = { cost, angle, next, height: field.height };
    }
    if (!best) break;
    points.push(best.next); travelled += step; at = best.next; direction = best.angle; previous = best.height;
  }
  return points;
}

/** Plot frontages spaced by arc length along a street, centre outwards. */
function streetStations(street, frontage) {
  const points = street.points, stations = [];
  let travelled = 0, next = frontage / 2, total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  for (let i = 1; i < points.length; i++) {
    const length = distance(points[i - 1], points[i]);
    while (next <= travelled + length && length > 1e-6) {
      const t = (next - travelled) / length;
      const point = [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
      const a = points[Math.max(0, i - 2)], b = points[Math.min(points.length - 1, i + 1)];
      stations.push({ street, point, tangent: Math.atan2(b[0] - a[0], b[1] - a[1]), rank: Math.abs(next - total / 2) });
      next += frontage;
    }
    travelled += length;
  }
  return stations;
}

/** Contour heading at a point: the direction with the least elevation change. */
function contourHeading(fields, x, z, fallback) {
  const here = fields.sample(x, z);
  if (!here || here.slope < 1e-4) return fallback;
  const step = 1e-3;
  const gx = (fields.sampleHeight(x + step, z) - fields.sampleHeight(x - step, z)) / (2 * step);
  const gz = (fields.sampleHeight(x, z + step) - fields.sampleHeight(x, z - step)) / (2 * step);
  return Math.atan2(-gz, gx);
}

function scoreSites(fields, extent, options) {
  // ⛔ A WORLD WITH NOWHERE TO LIVE IS A BUG, NOT A SEED. Judged once at the
  // strict thresholds, seed 7 — a steep valley with two lakes — scored zero
  // sites and generated no settlement, no road and no house at all. Somewhere
  // is always the flattest, driest place in a world; the standards for calling
  // it a village are what give way, in order, and the report says which pass
  // answered so a strained siting is visible rather than silent.
  for (const [rank, tolerance] of [{ slope: .30, around: .34, short: 2 },
    { slope: .42, around: .48, short: 4 }, { slope: .60, around: .70, short: 7 }].entries()) {
    const sites = scorePass(fields, extent, options, tolerance);
    if (sites.length) { sites.relaxed = rank; return sites; }
  }
  const empty = []; empty.relaxed = 3; return empty;
}

function scorePass(fields, extent, { random, waterAffinity, probe }, tolerance) {
  const half = extent / 2, step = Math.max(3, extent / 40), sites = [];
  for (let z = -half + step; z < half; z += step) for (let x = -half + step; x < half; x += step) {
    const field = fields.sample(x, z);
    if (!field || field.shore < probe * .5 || field.slope > tolerance.slope) continue;
    // Judge the neighbourhood, not one vertex: a settlement needs a workable
    // area, and a single flat sample on a steep hillside is not one.
    let flat = 0, checks = 0;
    for (let i = 0; i < 8; i++) {
      const angle = i / 8 * TAU, around = fields.sample(x + Math.cos(angle) * probe, z + Math.sin(angle) * probe);
      checks++;
      if (around && around.slope < tolerance.around && around.shore > 1.5) flat++;
    }
    if (flat < checks - tolerance.short) continue;
    // Real settlements sit near fresh water but above it. Affinity chooses how
    // strongly the seed is pulled toward the shore.
    const nearWater = Math.exp(-Math.max(0, field.shore - probe) / (extent * .12));
    const score = field.slope * -3.2 + nearWater * waterAffinity * 2.6 + flat / checks * 1.4
      + random(Math.round((x + half) * 7 + (z + half) * 977)) * .8;
    sites.push({ x, z, score, level: field.height });
  }
  sites.sort((a, b) => b.score - a.score || a.x - b.x || a.z - b.z);
  return sites;
}

/**
 * Plan every settlement in the world.
 *
 * `fields` exposes `sample(x,z)`/`sampleHeight(x,z)` for the landscape before
 * any settlement exists; `footprint(variationSeed, role)` returns the building
 * generator's real `{width, depth}` so pads match what gets built. Returns
 * `{ settlements, buildings, roads, report }` with stable ids.
 */
export function planSettlements({ fields, extent = 128, random, settlement = {}, budget = 5, footprint = null } = {}) {
  const {
    count = 1, pattern = 'cluster', spread = .65, waterAffinity = .5, plotFrontage = 22,
    setback = 4.5, orientationJitter = .25, roadWidth = 4, maxGrade = .35, outbuildings = .3,
    landmark = true, buildingScale = 1,
  } = settlement;
  if (!SETTLEMENT_PATTERNS.includes(pattern)) throw new RangeError(`Unknown settlement plan ${pattern}`);
  const settlements = [], buildings = [], roads = [], taken = [];
  // Why a requested building did not appear. The editor reports this instead of
  // silently returning a smaller village than the author asked for.
  const report = { requested: Math.max(0, budget), sites: 0, stations: 0, slope: 0, water: 0, bounds: 0, overlap: 0 };
  if (budget <= 0 || count <= 0) return { settlements, buildings, roads, report };
  const limits = { shore: 2.2, slope: .52, drop: 4.2 };
  const wanted = Math.min(count, budget);
  const perSettlement = Math.max(1, Math.round(budget / wanted));
  const townRadius = clamp(Math.sqrt(perSettlement) * plotFrontage * (.35 + spread * .35) + 11, 15, extent * .32);
  // Siting judges a settlement's core, so the candidate pool does not shrink as
  // the budget grows: a bigger town is a longer street, not a stricter site.
  const sites = scoreSites(fields, extent, { random, waterAffinity, probe: clamp(townRadius * .45, 9, 18) });
  report.sites = sites.length; report.relaxed = sites.relaxed;

  /** Pad geometry for one building: its real footprint plus a working margin. */
  const lotFor = (role, variationSeed) => {
    const spec = BUILDING_ROLES[role], scale = spec.scale * buildingScale;
    const box = footprint?.(variationSeed, role) ?? DEFAULT_FOOTPRINT;
    return { scale, feather: spec.feather, halfWidth: box.width / 2 * scale + 1.3, halfDepth: box.depth / 2 * scale + 1.3 };
  };

  for (let index = 0; index < wanted && buildings.length < budget; index++) {
    const site = sites.find(candidate => settlements.every(other => distance([candidate.x, candidate.z], other.center) > townRadius * 1.35 + 10));
    if (!site) break;
    const place = plan(index ? `settlement/${index}` : 'settlement', index, site, Math.min(perSettlement, budget - buildings.length));
    if (!place.buildings.length) { sites.splice(sites.indexOf(site), 1); index--; continue; }
    settlements.push(place.settlement); buildings.push(...place.buildings); roads.push(...place.roads);
  }
  return { settlements, buildings, roads, report };

  function plan(id, index, site, quota) {
    const key = index * 9973, centre = [site.x, site.z];
    const streets = [], placed = [], made = [];
    const step = clamp(plotFrontage * .18, 2.5, 5);
    const heading = pattern === 'scattered' ? 0 : contourHeading(fields, site.x, site.z, random(key + 1) * TAU);
    const reach = Math.max(plotFrontage * 2, townRadius * (pattern === 'street' ? 1.9 : 1.2));

    if (pattern !== 'scattered') {
      // A grid keeps its axis straighter, but still needs enough freedom to get
      // round an obstacle; a street that stops after 20 m is not a town plan.
      const wander = pattern === 'grid' ? .6 : 1;
      const forward = growStreet(fields, centre, heading, { step, length: reach, maxGrade, width: roadWidth, random, key: key + 10, wander });
      const back = growStreet(fields, centre, heading + Math.PI, { step, length: reach, maxGrade, width: roadWidth, random, key: key + 40, wander });
      const main = [...back.slice(1).reverse(), ...forward];
      if (main.length >= 3) streets.push({ id: `${id}/street`, kind: 'main', points: main, width: roadWidth });
    }
    if (streets.length && (pattern === 'grid' || pattern === 'cluster')) {
      // Side streets grow from arc-length stations on the main street, so a
      // block follows the ground instead of being stamped from a flat plan and
      // a short main street still gets its junction.
      const main = streets[0], width = roadWidth * .78;
      const sides = pattern === 'grid' ? [1, -1] : [random(key + 5) < .5 ? 1 : -1];
      const limit = pattern === 'grid' ? 4 : 1;
      // A cluster gets one branch, at the middle of whatever street it grew.
      const mainLength = main.points.slice(1).reduce((sum, point, index) => sum + distance(main.points[index], point), 0);
      const crossings = streetStations(main, pattern === 'grid' ? plotFrontage * 1.5 : Math.max(plotFrontage, mainLength));
      let built = 0;
      for (let index = 0; index < crossings.length && built < limit; index++) {
        const at = crossings[index];
        for (const side of sides) {
          const points = growStreet(fields, at.point, at.tangent + side * Math.PI / 2,
            { step, length: townRadius * .9, maxGrade, width, random, key: key + 200 + index * 7 + side, wander: pattern === 'grid' ? .6 : 1 });
          if (points.length < 3) continue;
          streets.push({ id: `${id}/side-${index}-${side > 0 ? 'a' : 'b'}`, kind: 'street', points, width });
          built++;
        }
      }
    }

    const tryPlace = (x, z, angle, role, source) => {
      if (placed.length >= quota) return false;
      const number = buildings.length + placed.length;
      const variationSeed = familySeed(random, role, key + number);
      const lot = lotFor(role, variationSeed);
      const yaw = angle + (random(key + 900 + placed.length) - .5) * orientationJitter * .9;
      // The pad's shortest possible blend must still fit inside the terrain, so
      // a plot near the boundary is refused rather than feathered off the edge.
      const ac = Math.abs(Math.cos(yaw)), as = Math.abs(Math.sin(yaw)), edge = extent / 2;
      if (Math.abs(x) + (lot.halfWidth + .7) * ac + (lot.halfDepth + .7) * as > edge ||
        Math.abs(z) + (lot.halfWidth + .7) * as + (lot.halfDepth + .7) * ac > edge) { report.bounds++; return false; }
      const pad = padAt(fields, x, z, yaw, lot.halfWidth, lot.halfDepth, limits);
      if (pad.reason) { report[pad.reason]++; return false; }
      const box = { center: [x, pad.level, z], angle: yaw, halfWidth: lot.halfWidth, halfDepth: lot.halfDepth };
      if ([...taken, ...placed].some(other => rectanglesOverlap(box, other, 1.4))) { report.overlap++; return false; }
      if (!clearOfRoads(box, streets, .35)) { report.overlap++; return false; }
      const building = {
        id: number ? `house/${number}` : 'cottage', settlement: id, role, scale: lot.scale,
        position: [x, pad.level, z], rotation: [0, yaw, 0],
        halfWidth: lot.halfWidth, halfDepth: lot.halfDepth,
        // A deeper cut needs a longer blend, or the pad reads as a cliff edge.
        feather: lot.feather + pad.drop * 1.15,
        variationSeed, entrance: entranceFor(x, z, yaw, lot.halfDepth), street: source ?? null,
      };
      made.push(building);
      placed.push({ ...box, id: building.id });
      return true;
    };

    if (streets.length) {
      const stations = streets.flatMap(street => streetStations(street, plotFrontage));
      stations.sort((a, b) => a.rank - b.rank || a.point[0] - b.point[0]);
      report.stations += stations.length;
      let hall = landmark && quota >= 5;
      for (let station = 0; station < stations.length && placed.length < quota; station++) {
        const at = stations[station];
        // Both frontages of a street get plots; houses on one side only reads as
        // a film set rather than a village.
        for (const side of random(key + 600 + station) < .5 ? [1, -1] : [-1, 1]) {
          if (placed.length >= quota) break;
          const role = hall ? 'hall' : random(key + 700 + placed.length * 3 + side) < outbuildings ? 'barn' : 'house';
          const preview = lotFor(role, familySeed(random, role, key + buildings.length + placed.length));
          const normal = at.tangent + side * Math.PI / 2;
          const offset = at.street.width / 2 + setback + preview.halfDepth;
          const x = at.point[0] + Math.sin(normal) * offset, z = at.point[1] + Math.cos(normal) * offset;
          // The entrance face (local +Z) looks back at the street it fronts.
          if (tryPlace(x, z, normal + Math.PI, role, at.street.id)) hall = false;
        }
      }
    }
    // Scattered plans, and any budget the streets could not absorb, fall back to
    // free siting around the centre so a difficult site still yields a hamlet.
    const bound = extent / 2 - 8;
    for (let attempt = 0; placed.length < quota && attempt < 260; attempt++) {
      const angle = random(key + 1000 + attempt) * TAU;
      const radius = townRadius * (.22 + random(key + 2000 + attempt) * (pattern === 'scattered' ? 1.45 : 1.05));
      const x = centre[0] + Math.cos(angle) * radius, z = centre[1] + Math.sin(angle) * radius;
      if (Math.abs(x) > bound || Math.abs(z) > bound) { report.bounds++; continue; }
      const role = random(key + 3000 + attempt) < outbuildings ? 'barn' : 'house';
      const facing = streets.length ? contourHeading(fields, x, z, angle) + Math.PI / 2
        : Math.atan2(centre[0] - x, centre[1] - z) + (random(key + 4000 + attempt) - .5) * 1.2;
      tryPlace(x, z, facing, role, null);
    }
    taken.push(...placed);
    fitPadFeathers(made, streets, extent);
    return {
      settlement: {
        id, pattern, center: [site.x, site.z], radius: townRadius,
        kind: made.length >= 18 ? 'town' : made.length >= 7 ? 'village' : 'hamlet',
        buildings: made.map(building => building.id), roads: streets.map(street => street.id),
      },
      buildings: made, roads: streets,
    };
  }
}

/**
 * Shorten each pad's blend until it fits.
 *
 * A pad flattens its own rectangle exactly, so no other pad's feather may reach
 * inside it, no feather may run off the terrain, and none may repave a road.
 * Dense plots therefore get a shorter blend rather than a level that quietly
 * drifts under a neighbour's skirt. Re-run this whenever a building moves.
 */
export function fitPadFeathers(buildings, roads, extent, base = null) {
  const boxes = buildings.map(building => ({ id: building.id, center: [...building.position],
    angle: building.rotation[1], halfWidth: building.halfWidth, halfDepth: building.halfDepth }));
  buildings.forEach((building, index) => {
    const own = boxes[index];
    let clearance = Infinity;
    for (let other = 0; other < boxes.length; other++) if (other !== index) clearance = Math.min(clearance, rectangleGap(own, boxes[other]));
    const c = Math.abs(Math.cos(own.angle)), s = Math.abs(Math.sin(own.angle)), edge = extent / 2;
    for (const [position, hw, hd] of [[own.center[0], c, s], [own.center[2], s, c]]) {
      clearance = Math.min(clearance, (edge - Math.abs(position) - own.halfWidth * hw - own.halfDepth * hd) / Math.max(1e-6, hw + hd));
    }
    clearance = Math.min(clearance, roadGap(own, roads));
    const wanted = base?.get(building.id) ?? building.feather;
    building.feather = Math.max(.35, Math.min(wanted, clearance - .05));
  });
  return buildings;
}

/** Where a building's door meets its plot, snapped to the shared route grid. */
export function entranceFor(x, z, angle, halfDepth, snap = 2) {
  return [Math.round((x + Math.sin(angle) * (halfDepth + 2.5)) / snap) * snap,
    Math.round((z + Math.cos(angle) * (halfDepth + 2.5)) / snap) * snap];
}
