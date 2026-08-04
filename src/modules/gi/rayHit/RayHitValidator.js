const EPSILON = 1e-9;

const xyz = (v) => Array.isArray(v) || ArrayBuffer.isView(v)
  ? { x: Number(v[0]), y: Number(v[1]), z: Number(v[2]) }
  : { x: Number(v.x), y: Number(v.y), z: Number(v.z) };

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const normalized = (v) => {
  const length = Math.hypot(v.x, v.y, v.z);
  return length > EPSILON
    ? { x: v.x / length, y: v.y / length, z: v.z / length }
    : { x: 0, y: 0, z: 0 };
};

/** Deterministic, double-precision Moller-Trumbore reference intersection. */
export function intersectRayTriangle(originValue, directionValue, aValue, bValue, cValue, options = {}) {
  const origin = xyz(originValue);
  const direction = xyz(directionValue);
  const a = xyz(aValue);
  const b = xyz(bValue);
  const c = xyz(cValue);
  const epsilon = options.epsilon ?? EPSILON;
  const minT = options.minT ?? 0;
  const maxT = options.maxT ?? Infinity;
  const doubleSided = options.doubleSided !== false;

  const edge1 = sub(b, a);
  const edge2 = sub(c, a);
  const p = cross(direction, edge2);
  const det = dot(edge1, p);
  if (doubleSided ? Math.abs(det) <= epsilon : det <= epsilon) return null;
  const invDet = 1 / det;
  const fromA = sub(origin, a);
  const u = dot(fromA, p) * invDet;
  if (u < -epsilon || u > 1 + epsilon) return null;
  const q = cross(fromA, edge1);
  const v = dot(direction, q) * invDet;
  if (v < -epsilon || u + v > 1 + epsilon) return null;
  const t = dot(edge2, q) * invDet;
  if (!Number.isFinite(t) || t < minT || t > maxT) return null;

  const geometricNormal = normalized(cross(edge1, edge2));
  const frontFace = dot(direction, geometricNormal) < 0;
  const normal = frontFace || !doubleSided
    ? geometricNormal
    : { x: -geometricNormal.x, y: -geometricNormal.y, z: -geometricNormal.z };
  return {
    t,
    u,
    v,
    frontFace,
    normal,
    position: {
      x: origin.x + direction.x * t,
      y: origin.y + direction.y * t,
      z: origin.z + direction.z * t,
    },
  };
}

const elementsOf = (matrix) => matrix?.elements ?? matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const transformPoint = (p, matrix) => {
  const e = elementsOf(matrix);
  const w = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15];
  const invW = w && w !== 1 ? 1 / w : 1;
  return {
    x: (e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12]) * invW,
    y: (e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13]) * invW,
    z: (e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14]) * invW,
  };
};

/**
 * Expands the occupancy builder's shared local geometry plus placements into
 * a small world-space triangle set. Intended for deterministic validation
 * scenes only, never the frame path.
 */
export function buildWorldTriangles(geometries, placements) {
  const byKey = new Map(geometries.map((geometry) => [geometry.key, geometry]));
  const triangles = [];
  placements.forEach((placement, placementIndex) => {
    const geometry = byKey.get(placement.geometryKey ?? placement.key);
    if (!geometry) return;
    const positions = geometry.positions;
    const indices = geometry.index ?? geometry.indices;
    const vertex = (index) => transformPoint({
      x: positions[index * 3],
      y: positions[index * 3 + 1],
      z: positions[index * 3 + 2],
    }, placement.matrix);
    const count = indices ? indices.length : Math.floor(positions.length / 3);
    for (let i = 0; i + 2 < count; i += 3) {
      triangles.push({
        a: vertex(indices ? indices[i] : i),
        b: vertex(indices ? indices[i + 1] : i + 1),
        c: vertex(indices ? indices[i + 2] : i + 2),
        placementIndex,
        triangleIndex: i / 3,
        materialId: placement.materialId ?? 0,
      });
    }
  });
  return triangles;
}

export function traceTrianglesExact(origin, direction, triangles, options = {}) {
  let nearest = null;
  for (const triangle of triangles) {
    const hit = intersectRayTriangle(origin, direction, triangle.a, triangle.b, triangle.c, {
      ...options,
      maxT: nearest ? Math.min(options.maxT ?? Infinity, nearest.t) : options.maxT,
    });
    if (hit && (!nearest || hit.t < nearest.t)) nearest = { ...hit, ...triangle };
  }
  return nearest;
}

const percentile = (sorted, p) => sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
  : 0;

/** Compares any candidate ray-hit function with exact CPU triangles. */
export function validateRayHits(rays, triangles, candidateTrace) {
  let falsePositives = 0;
  let falseNegatives = 0;
  const distanceErrors = [];
  const normalErrors = [];
  for (const ray of rays) {
    const exact = traceTrianglesExact(ray.origin, ray.direction, triangles, ray);
    const rawCandidate = candidateTrace(ray);
    // GPU queries use t < 0 as their miss sentinel. Normalize that contract
    // here so callers can compare the engine's result without wrapping it.
    const candidate = rawCandidate && Number.isFinite(rawCandidate.t)
      && rawCandidate.t >= (ray.minT ?? 0)
      && rawCandidate.t <= (ray.maxT ?? Infinity)
      ? rawCandidate
      : null;
    if (!exact && candidate) falsePositives++;
    else if (exact && !candidate) falseNegatives++;
    else if (exact && candidate) {
      distanceErrors.push(Math.abs(exact.t - candidate.t));
      if (candidate.normal) {
        const n = normalized(xyz(candidate.normal));
        const cosine = Math.min(1, Math.max(-1, dot(exact.normal, n)));
        normalErrors.push(Math.acos(cosine) * 180 / Math.PI);
      }
    }
  }
  distanceErrors.sort((a, b) => a - b);
  normalErrors.sort((a, b) => a - b);
  return {
    rays: rays.length,
    falsePositives,
    falseNegatives,
    falsePositiveRate: rays.length ? falsePositives / rays.length : 0,
    falseNegativeRate: rays.length ? falseNegatives / rays.length : 0,
    distanceErrorMedian: percentile(distanceErrors, 0.5),
    distanceErrorP95: percentile(distanceErrors, 0.95),
    normalErrorMedianDegrees: percentile(normalErrors, 0.5),
  };
}
