/**
 * Phase 0 CPU water-domain prototype. World-space metres, Y-up; independent of
 * Three, production Water slots, rendering, terrain and fluid simulation.
 *
 * Lakes are simple (possibly concave) polygons. Rivers are directed downhill
 * polylines with round caps and a constant full width. The nearest centerline
 * segment determines a river's surface grade and horizontal unit flow. Equal
 * distance ties use segment order; between bodies, lakes take precedence, then
 * lexical IDs. This makes a junction independent of input collection order.
 *
 * `depth` is the supplied design depth, NOT a terrain/physics measurement. The
 * inferred bed is surface - depth; terrain carving/intersection validation and
 * bathymetry must happen before this can become a production physical domain.
 * `shoreDistance` is nonnegative footprint clearance. At overlaps it is the
 * maximum constituent clearance: a conservative lower bound on distance to the
 * union shoreline, not an exact shoreline SDF. No fake dry seam is introduced.
 *
 * A lake mouth must contain a flat river segment at the lake level. Requiring
 * this across intersecting footprints, rather than only the centerline endpoint,
 * prevents a sloped strip cutting across a flat lake with mismatched edges.
 * River-to-river junctions likewise require flat landing reaches. General
 * graded confluence surfaces and smooth cross-sections at sharp polyline bends
 * need a later surface solver; nearest-centerline sampling does not provide it.
 */

export const WATER_DOMAIN_DRY_HEIGHT = -1_000_000;
const EPSILON = 1e-7;
const MAX_RASTER_TEXELS = 16_777_216;

function fail(message) {
  throw new RangeError(`World water domain: ${message}`);
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    fail(`${label} must be a finite float32-representable number`);
  }
  return value;
}

function positive(value, label) {
  finite(value, label);
  if (value <= EPSILON) fail(`${label} must be positive and larger than ${EPSILON}`);
  return value;
}

function level(value, depth, label) {
  finite(value, label);
  finite(value - depth, `${label} inferred bed`);
  if (Math.fround(value) <= WATER_DOMAIN_DRY_HEIGHT || Math.fround(value - depth) <= WATER_DOMAIN_DRY_HEIGHT) {
    fail(`${label} and inferred bed must exceed dry sentinel ${WATER_DOMAIN_DRY_HEIGHT}`);
  }
  if (Math.fround(value) === Math.fround(value - depth)) fail(`${label} depth is lost at float32 precision`);
  return value;
}

function point(value, dimensions, label) {
  if (!Array.isArray(value) || value.length !== dimensions) fail(`${label} must have ${dimensions} coordinates`);
  return value.map((coordinate, axis) => finite(coordinate, `${label}[${axis}]`));
}

function cross(ax, az, bx, bz) { return ax * bz - az * bx; }
function clamp(value) { return Math.max(0, Math.min(1, value)); }
function samePoint(a, b) { return a[0] === b[0] && a[1] === b[1]; }

function project(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length2 = dx * dx + dz * dz;
  const t = length2 > 0 ? clamp(((x - a[0]) * dx + (z - a[1]) * dz) / length2) : 0;
  return { t, distance: Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) };
}

// Includes touches and collinear overlap, not only proper crossings.
function segmentIntersection(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1];
  const sx = d[0] - c[0], sz = d[1] - c[1];
  const denominator = cross(rx, rz, sx, sz);
  const scale = Math.max(1, Math.hypot(rx, rz), Math.hypot(sx, sz));
  if (Math.abs(denominator) > EPSILON * scale) {
    const t = cross(c[0] - a[0], c[1] - a[1], sx, sz) / denominator;
    const u = cross(c[0] - a[0], c[1] - a[1], rx, rz) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return { t, u, distance: 0 };
  }
  let closest = { t: 0, u: 0, distance: Infinity };
  for (const [p, t] of [[a, 0], [b, 1]]) {
    const q = project(p[0], p[1], c, d);
    if (q.distance < closest.distance) closest = { t, u: q.t, distance: q.distance };
  }
  for (const [p, u] of [[c, 0], [d, 1]]) {
    const q = project(p[0], p[1], a, b);
    if (q.distance < closest.distance) closest = { t: q.t, u, distance: q.distance };
  }
  return closest;
}

function polygonSample(x, z, points) {
  let inside = false, distance = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    distance = Math.min(distance, project(x, z, a, b).distance);
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return { inside: inside || distance <= EPSILON, distance };
}

function boundsOf(points, radius = 0) {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const [x, z] of points) {
    bounds.minX = Math.min(bounds.minX, x - radius);
    bounds.minZ = Math.min(bounds.minZ, z - radius);
    bounds.maxX = Math.max(bounds.maxX, x + radius);
    bounds.maxZ = Math.max(bounds.maxZ, z + radius);
  }
  for (const [key, value] of Object.entries(bounds)) finite(value, `bounds.${key}`);
  return bounds;
}

function inBounds(x, z, bounds) {
  return x >= bounds.minX - EPSILON && x <= bounds.maxX + EPSILON &&
    z >= bounds.minZ - EPSILON && z <= bounds.maxZ + EPSILON;
}

function overlapBounds(a, b) {
  return a.maxX + EPSILON >= b.minX && b.maxX + EPSILON >= a.minX &&
    a.maxZ + EPSILON >= b.minZ && b.maxZ + EPSILON >= a.minZ;
}

function normalizeLake(source, id) {
  if (!Array.isArray(source.points)) fail(`lake ${id} points must be an array`);
  const points = source.points.map((p, index) => point(p, 2, `lake ${id} point ${index}`));
  if (points.length > 1 && samePoint(points[0], points.at(-1))) points.pop();
  if (points.length < 3) fail(`lake ${id} needs at least three distinct points`);
  let area2 = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= EPSILON) fail(`lake ${id} has a degenerate edge`);
    area2 += cross(a[0] - points[0][0], a[1] - points[0][1], b[0] - points[0][0], b[1] - points[0][1]);
    const c = points[(i + 2) % points.length];
    const abx = b[0] - a[0], abz = b[1] - a[1], bcx = c[0] - b[0], bcz = c[1] - b[1];
    if (Math.abs(cross(abx, abz, bcx, bcz)) <= EPSILON && abx * bcx + abz * bcz < 0) {
      fail(`lake ${id} has a folded edge`);
    }
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      if (segmentIntersection(a, b, points[j], points[(j + 1) % points.length]).distance <= EPSILON) {
        fail(`lake ${id} polygon self-intersects`);
      }
    }
  }
  if (!Number.isFinite(area2) || Math.abs(area2) <= EPSILON) fail(`lake ${id} polygon has zero or infeasible area`);
  const depth = positive(source.depth, `lake ${id} depth`);
  return { id, kind: "lake", points, depth, height: level(source.level, depth, `lake ${id} level`), bounds: boundsOf(points) };
}

function normalizeRiver(source, id) {
  if (!Array.isArray(source.points) || source.points.length < 2) fail(`river ${id} needs at least two points`);
  const points = source.points.map((p, index) => point(p, 3, `river ${id} point ${index}`));
  const radius = positive(source.width, `river ${id} width`) / 2;
  const depth = positive(source.depth, `river ${id} depth`);
  const segments = [];
  for (let i = 0; i < points.length; i++) {
    level(points[i][1], depth, `river ${id} point ${i} height`);
    if (i === 0) continue;
    const from = points[i - 1], to = points[i];
    const a = [from[0], from[2]], b = [to[0], to[2]];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length <= EPSILON) fail(`river ${id} has a degenerate or vertical reach`);
    if (to[1] > from[1]) fail(`river ${id} runs uphill at point ${i}`);
    const segment = { a, b, fromY: from[1], toY: to[1], flow: [(b[0] - a[0]) / length, (b[1] - a[1]) / length] };
    const previous = segments.at(-1);
    if (previous && previous.flow[0] * segment.flow[0] + previous.flow[1] * segment.flow[1] < -1 + EPSILON) {
      fail(`river ${id} doubles back along the previous reach`);
    }
    for (let j = 0; j < segments.length - 1; j++) {
      const other = segments[j];
      if (segmentIntersection(a, b, other.a, other.b).distance <= EPSILON) fail(`river ${id} centerline self-intersects`);
    }
    segments.push(segment);
  }
  return { id, kind: "river", depth, radius, segments, bounds: boundsOf(points.map(p => [p[0], p[2]]), radius) };
}

function lakesIntersect(a, b) {
  if (polygonSample(...a.points[0], b.points).inside || polygonSample(...b.points[0], a.points).inside) return true;
  for (let i = 0; i < a.points.length; i++) {
    for (let j = 0; j < b.points.length; j++) {
      if (segmentIntersection(a.points[i], a.points[(i + 1) % a.points.length], b.points[j], b.points[(j + 1) % b.points.length]).distance <= EPSILON) return true;
    }
  }
  return false;
}

function reachIntersectsLake(segment, radius, lake) {
  if (polygonSample(...segment.a, lake.points).inside || polygonSample(...segment.b, lake.points).inside) return true;
  for (let i = 0; i < lake.points.length; i++) {
    if (segmentIntersection(segment.a, segment.b, lake.points[i], lake.points[(i + 1) % lake.points.length]).distance <= radius + EPSILON) return true;
  }
  return false;
}

function heightAt(segment, t) { return segment.fromY + (segment.toY - segment.fromY) * t; }

function validateConnections(bodies) {
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      if (!overlapBounds(a.bounds, b.bounds)) continue;
      if (a.kind === "lake" && b.kind === "lake") {
        if (Math.abs(a.height - b.height) > EPSILON && lakesIntersect(a, b)) fail(`intersecting lakes ${a.id} and ${b.id} disagree on level`);
      } else if (a.kind === "lake" || b.kind === "lake") {
        const lake = a.kind === "lake" ? a : b, river = a.kind === "river" ? a : b;
        for (const segment of river.segments) {
          if (reachIntersectsLake(segment, river.radius, lake) &&
              (Math.abs(segment.fromY - lake.height) > EPSILON || Math.abs(segment.toY - lake.height) > EPSILON)) {
            fail(`river ${river.id} needs a level mouth reach agreeing with lake ${lake.id}`);
          }
        }
      } else {
        for (const sa of a.segments) {
          for (const sb of b.segments) {
            const contact = segmentIntersection(sa.a, sa.b, sb.a, sb.b);
            if (contact.distance <= a.radius + b.radius + EPSILON) {
              if (Math.abs(heightAt(sa, contact.t) - heightAt(sb, contact.u)) > EPSILON) {
                fail(`overlapping rivers ${a.id} and ${b.id} disagree on junction height`);
              }
              if (Math.abs(sa.fromY - sa.toY) > EPSILON || Math.abs(sb.fromY - sb.toY) > EPSILON) {
                fail(`overlapping rivers ${a.id} and ${b.id} need flat landing reaches at their junction`);
              }
            }
          }
        }
      }
    }
  }
}

/** Compile detached input data; later mutations of the source cannot alter queries. */
export function createWaterDomain({ lakes = [], rivers = [] } = {}) {
  if (!Array.isArray(lakes) || !Array.isArray(rivers)) fail("lakes and rivers must be arrays");
  const ids = new Set();
  function compile(source, normalize) {
    if (!source || typeof source !== "object" || typeof source.id !== "string" || !source.id.trim()) fail("each body needs a nonempty string id");
    if (ids.has(source.id)) fail(`duplicate body id ${source.id}`);
    ids.add(source.id);
    return normalize(source, source.id);
  }
  const bodies = [...lakes.map(source => compile(source, normalizeLake)), ...rivers.map(source => compile(source, normalizeRiver))];
  bodies.sort((a, b) => (a.kind !== b.kind ? (a.kind === "lake" ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  validateConnections(bodies);
  let bounds = null;
  for (const body of bodies) {
    if (!bounds) bounds = { ...body.bounds };
    else {
      bounds.minX = Math.min(bounds.minX, body.bounds.minX);
      bounds.minZ = Math.min(bounds.minZ, body.bounds.minZ);
      bounds.maxX = Math.max(bounds.maxX, body.bounds.maxX);
      bounds.maxZ = Math.max(bounds.maxZ, body.bounds.maxZ);
    }
  }
  if (bounds) Object.freeze(bounds);

  function sampleUnchecked(x, z) {
    let selected = null, clearance = 0;
    for (const body of bodies) {
      if (!inBounds(x, z, body.bounds)) continue;
      let height, flow, shoreDistance;
      if (body.kind === "lake") {
        const query = polygonSample(x, z, body.points);
        if (!query.inside) continue;
        height = body.height; flow = [0, 0]; shoreDistance = query.distance;
      } else {
        let nearest = null, projection = { distance: Infinity };
        for (const segment of body.segments) {
          const candidate = project(x, z, segment.a, segment.b);
          if (candidate.distance < projection.distance) { nearest = segment; projection = candidate; }
        }
        if (projection.distance > body.radius + EPSILON) continue;
        height = heightAt(nearest, projection.t); flow = [...nearest.flow];
        shoreDistance = Math.max(0, body.radius - projection.distance);
      }
      clearance = Math.max(clearance, shoreDistance);
      if (!selected) selected = { id: body.id, height, depth: body.depth, flow, shoreDistance };
    }
    if (selected) selected.shoreDistance = clearance;
    return selected;
  }

  function sample(x, z) {
    finite(x, "sample x"); finite(z, "sample z");
    return sampleUnchecked(x, z);
  }

  /**
   * Row-major RGBA32F: [surface Y, inferred bed Y, flow X, flow Z].
   * Rows increase toward +Z, columns toward +X. Samples are at texel CENTERS:
   * x=minX+(column+0.5)*(maxX-minX)/width, and the corresponding formula for Z.
   * Dry=[WATER_DOMAIN_DRY_HEIGHT,WATER_DOMAIN_DRY_HEIGHT,0,0]. Consumers must use
   * nearest sampling / explicit wet-aware interpolation; linear interpolation
   * across the sentinel would invent giant depths. Each call owns a new buffer.
   */
  function rasterize({ minX, minZ, maxX, maxZ, width, height } = {}) {
    for (const [name, value] of Object.entries({ minX, minZ, maxX, maxZ })) finite(value, `raster ${name}`);
    if (maxX <= minX || maxZ <= minZ) fail("raster bounds must have positive area");
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_RASTER_TEXELS) {
      fail(`raster width and height must be positive integers with at most ${MAX_RASTER_TEXELS} texels`);
    }
    const packed = new Float32Array(width * height * 4);
    const stepX = (maxX - minX) / width, stepZ = (maxZ - minZ) / height;
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const query = sampleUnchecked(minX + (column + 0.5) * stepX, minZ + (row + 0.5) * stepZ);
        const offset = (row * width + column) * 4;
        packed[offset] = query ? query.height : WATER_DOMAIN_DRY_HEIGHT;
        packed[offset + 1] = query ? query.height - query.depth : WATER_DOMAIN_DRY_HEIGHT;
        if (query) { packed[offset + 2] = query.flow[0]; packed[offset + 3] = query.flow[1]; }
      }
    }
    return packed;
  }

  return Object.freeze({ bounds, sample, rasterize });
}
