/**
 * Sculpt brushes.
 *
 * A stroke is a sequence of dabs. Each dab gathers the vertices inside a sphere
 * and moves them by a falloff-weighted amount; what "moves them" means is the
 * brush. Everything here is plain arrays and pure geometry so a brush can be
 * unit tested without a renderer or a pointer.
 *
 * Two things make this usable on a real mesh rather than a toy one:
 *
 *  - A uniform spatial grid. Scanning every vertex per dab is fine for a cube
 *    and hopeless for anything sculptable, and a stroke fires dabs continuously
 *    while the mouse moves.
 *  - Displacements are scaled by the brush *radius*, not by absolute units, so
 *    a brush feels the same whatever the model's scale or the zoom level.
 *
 * Vertices are moved; topology is not touched. Adding detail under the brush is
 * `ops/dyntopo.js`, which runs between dabs.
 */

import { edgeOther, faceNormal, faceVerts, vertFaces, vertNormal } from "./bmesh.js";
import { createStroke, falloffWeight, strokeDabs } from "../brush.js";

const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length3 = (v) => Math.hypot(v[0], v[1], v[2]);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function normalize3(v) {
  const size = length3(v);
  return size < 1e-12 ? [0, 0, 0] : [v[0] / size, v[1] / size, v[2] / size];
}

/* -------------------------------------------------------------------------- */
/* Spatial index                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A uniform grid of vertices.
 *
 * `cellSize` should be near the brush radius: much smaller and a wide brush
 * visits thousands of empty cells, much larger and every query degenerates into
 * a linear scan. `sculptSession` re-derives it as the radius changes.
 */
export function buildSpatialIndex(mesh, cellSize = 0.25) {
  const size = Math.max(cellSize, 1e-4);
  const cells = new Map();
  for (const vert of mesh.verts) {
    const key = `${Math.floor(vert.co[0] / size)},${Math.floor(vert.co[1] / size)},${Math.floor(vert.co[2] / size)}`;
    let bucket = cells.get(key);
    if (!bucket) cells.set(key, (bucket = []));
    bucket.push(vert);
  }
  return { cells, size, count: mesh.verts.size };
}

/** Vertices within `radius` of `center`, each with its normalised distance. */
export function vertsInSphere(index, center, radius) {
  const found = [];
  const squared = radius * radius;
  const span = Math.ceil(radius / index.size);
  const base = [
    Math.floor(center[0] / index.size),
    Math.floor(center[1] / index.size),
    Math.floor(center[2] / index.size),
  ];
  for (let x = -span; x <= span; x++) {
    for (let y = -span; y <= span; y++) {
      for (let z = -span; z <= span; z++) {
        const bucket = index.cells.get(`${base[0] + x},${base[1] + y},${base[2] + z}`);
        if (!bucket) continue;
        for (const vert of bucket) {
          const delta = sub3(vert.co, center);
          const distance = dot3(delta, delta);
          if (distance <= squared) found.push({ vert, normalized: Math.sqrt(distance) / (radius || 1) });
        }
      }
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Brushes                                                                     */
/* -------------------------------------------------------------------------- */

export const BRUSHES = [
  { id: "draw", label: "Draw", hint: "Raise along the surface normal" },
  { id: "clay", label: "Clay", hint: "Fill towards a flattened surface" },
  { id: "inflate", label: "Inflate", hint: "Push along each vertex normal" },
  { id: "smooth", label: "Smooth", hint: "Relax towards neighbours" },
  { id: "flatten", label: "Flatten", hint: "Pull onto the local plane" },
  { id: "scrape", label: "Scrape", hint: "Cut peaks down to the plane" },
  { id: "fill", label: "Fill", hint: "Raise hollows up to the plane" },
  { id: "pinch", label: "Pinch", hint: "Draw vertices together" },
  { id: "crease", label: "Crease", hint: "Pinch and sink a sharp line" },
  { id: "grab", label: "Grab", hint: "Drag vertices with the cursor" },
  { id: "nudge", label: "Nudge", hint: "Push along the stroke direction" },
];

/** Brushes whose displacement comes from the pointer rather than the normal. */
export const DIRECTIONAL_BRUSHES = new Set(["grab", "nudge"]);

/** The area-average plane of an affected region: Blender's "area centre/normal". */
function areaPlane(samples) {
  let center = [0, 0, 0];
  let normal = [0, 0, 0];
  let total = 0;
  for (const { vert, weight } of samples) {
    if (weight <= 0) continue;
    center = add3(center, scale3(vert.co, weight));
    normal = add3(normal, scale3(vertNormal(vert), weight));
    total += weight;
  }
  if (total <= 0) return null;
  return { center: scale3(center, 1 / total), normal: normalize3(normal) };
}

/** Average of a vertex's edge-connected neighbours. */
function neighbourAverage(vert) {
  if (!vert.edges.size) return null;
  let sum = [0, 0, 0];
  for (const edge of vert.edges) sum = add3(sum, edgeOther(edge, vert).co);
  return scale3(sum, 1 / vert.edges.size);
}

/**
 * Applies one dab.
 *
 * `options.originals` is required by Grab: it drags from the positions captured
 * when the stroke began, so holding still does not creep and reversing the drag
 * returns the surface exactly.
 */
export function applyDab(mesh, options) {
  const {
    type = "draw",
    center,
    normal = [0, 1, 0],
    radius = 0.25,
    strength = 0.5,
    falloff = "smooth",
    invert = false,
    direction = [0, 0, 0],
    index,
    originals = null,
    weights = null,
  } = options;
  if (radius <= 0) return 0;

  // Grab supplies a weight map captured when the stroke began. Re-querying the
  // sphere each dab would re-weight vertices against their *moved* positions,
  // so dragging out and back would not return the surface to where it started.
  let samples;
  if (weights) {
    samples = [];
    for (const [vert, weight] of weights) if (weight > 0) samples.push({ vert, weight });
  } else {
    if (!index) return 0;
    samples = vertsInSphere(index, center, radius)
      .map(({ vert, normalized }) => ({ vert, weight: falloffWeight(normalized, falloff) }))
      .filter((sample) => sample.weight > 0);
  }
  if (!samples.length) return 0;

  const sign = invert ? -1 : 1;
  // Displacement scales with the radius so a brush behaves the same whatever
  // the model's scale or the current zoom.
  const amount = strength * radius * sign;
  const plane = ["clay", "flatten", "scrape", "fill"].includes(type) ? areaPlane(samples) : null;

  let moved = 0;
  // Smooth must read every neighbour before anything moves, or the result
  // depends on iteration order and the surface shears along it.
  const smoothTargets = type === "smooth" ? new Map(samples.map(({ vert }) => [vert, neighbourAverage(vert)])) : null;

  for (const { vert, weight } of samples) {
    const before = vert.co;
    let next = before;

    if (type === "draw") {
      next = add3(before, scale3(normal, amount * weight));
    } else if (type === "inflate") {
      next = add3(before, scale3(vertNormal(vert), amount * weight));
    } else if (type === "smooth") {
      const target = smoothTargets.get(vert);
      if (target) next = lerp3(before, target, Math.min(Math.abs(strength) * weight, 1));
    } else if (type === "grab") {
      const origin = originals?.get(vert) ?? before;
      next = add3(origin, scale3(direction, weight));
    } else if (type === "nudge") {
      // Travel across the surface, not into it.
      const tangential = sub3(direction, scale3(normal, dot3(direction, normal)));
      next = add3(before, scale3(tangential, weight));
    } else if (type === "pinch") {
      // Pull towards the brush axis rather than the point, so a stroke tightens
      // a ridge instead of bunching everything at one spot.
      const toCenter = sub3(center, before);
      const along = scale3(normal, dot3(toCenter, normal));
      next = add3(before, scale3(sub3(toCenter, along), Math.min(Math.abs(strength) * weight, 1) * sign));
    } else if (type === "crease") {
      const toCenter = sub3(center, before);
      const along = scale3(normal, dot3(toCenter, normal));
      const pinched = add3(before, scale3(sub3(toCenter, along), Math.min(Math.abs(strength) * weight, 1) * 0.5));
      next = add3(pinched, scale3(normal, -amount * weight * 0.5));
    } else if (plane) {
      const offset = dot3(sub3(before, plane.center), plane.normal);
      // Flatten pulls both ways; scrape only cuts down; fill only raises.
      const engaged = type === "flatten"
        || (type === "scrape" && offset * sign > 0)
        || (type === "fill" && offset * sign < 0)
        || type === "clay";
      if (engaged) {
        const target = sub3(before, scale3(plane.normal, offset));
        const blended = lerp3(before, target, Math.min(Math.abs(strength) * weight, 1));
        next = type === "clay" ? add3(blended, scale3(plane.normal, amount * weight * 0.5)) : blended;
      }
    }

    if (next !== before) {
      vert.co = [next[0], next[1], next[2]];
      moved++;
    }
  }
  return moved;
}

/* -------------------------------------------------------------------------- */
/* Symmetry                                                                    */
/* -------------------------------------------------------------------------- */

const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/** Mirrors a point and a direction across the enabled symmetry axes. */
export function symmetryDabs(center, normal, direction, symmetry) {
  const axes = Object.entries(symmetry ?? {}).filter(([, on]) => on).map(([axis]) => AXIS_INDEX[axis]);
  const dabs = [{ center, normal, direction }];
  // Every non-empty subset of the enabled axes, so X+Y gives four dabs.
  for (let mask = 1; mask < 1 << axes.length; mask++) {
    const mirrorCenter = [...center];
    const mirrorNormal = [...normal];
    const mirrorDirection = [...direction];
    for (let bit = 0; bit < axes.length; bit++) {
      if (!(mask & (1 << bit))) continue;
      const axis = axes[bit];
      mirrorCenter[axis] = -mirrorCenter[axis];
      mirrorNormal[axis] = -mirrorNormal[axis];
      mirrorDirection[axis] = -mirrorDirection[axis];
    }
    dabs.push({ center: mirrorCenter, normal: mirrorNormal, direction: mirrorDirection });
  }
  return dabs;
}

/** Applies a dab and its symmetric partners. */
export function applyStrokeDab(mesh, options) {
  const dabs = symmetryDabs(options.center, options.normal, options.direction ?? [0, 0, 0], options.symmetry);
  let moved = 0;
  for (const dab of dabs) {
    moved += applyDab(mesh, { ...options, center: dab.center, normal: dab.normal, direction: dab.direction });
  }
  return moved;
}

/* -------------------------------------------------------------------------- */
/* Stroke bookkeeping                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Tracks one drag: the spatial index, the captured positions Grab needs, and
 * dab spacing so a fast drag still lays a continuous line instead of a dotted
 * one, and a slow drag does not pile hundreds of dabs on one spot.
 */
export function beginStroke(mesh, { radius = 0.25, spacing = 0.35, brush = "draw" } = {}) {
  return {
    index: buildSpatialIndex(mesh, Math.max(radius * 0.5, 1e-3)),
    // Grab drags from where the surface was when the stroke started.
    originals: brush === "grab" ? new Map([...mesh.verts].map((vert) => [vert, [...vert.co]])) : null,
    weights: null,
    ...createStroke({ spacing }),
    radius,
  };
}

/**
 * Freezes the falloff weights for a Grab stroke, measured once against the
 * surface as it was when the drag started. Call at the first dab.
 */
export function captureGrabWeights(stroke, center, radius, falloff = "smooth") {
  const weights = new Map();
  for (const { vert, normalized } of vertsInSphere(stroke.index, center, radius)) {
    const weight = falloffWeight(normalized, falloff);
    if (weight > 0) weights.set(vert, weight);
  }
  stroke.weights = weights;
  return weights;
}

/** Rebuilds the index; call after dyntopo or any topology change mid-stroke. */
export function refreshStroke(stroke, mesh, radius = stroke.radius) {
  stroke.index = buildSpatialIndex(mesh, Math.max(radius * 0.5, 1e-3));
  stroke.radius = radius;
  return stroke;
}

/**
 * Interpolates dabs between the previous sample and this one.
 *
 * Returns the dab centres to apply. Pointer events arrive far apart during a
 * quick drag; without this a fast stroke leaves visible gaps.
 */
export function strokeDabPositions(stroke, point, radius) {
  return strokeDabs(stroke, point, radius);
}

/* -------------------------------------------------------------------------- */
/* Surface queries                                                             */
/* -------------------------------------------------------------------------- */

/** Area-weighted normal of the surface under a brush, for Draw and Nudge. */
export function surfaceNormalAt(index, center, radius) {
  const hits = vertsInSphere(index, center, radius);
  if (!hits.length) return null;
  let normal = [0, 0, 0];
  for (const { vert, normalized } of hits) {
    const weight = falloffWeight(normalized, "smooth");
    if (weight > 0) normal = add3(normal, scale3(vertNormal(vert), weight));
  }
  const unit = normalize3(normal);
  return length3(unit) ? unit : null;
}

/** Mean edge length, used to pick a sensible default detail size. */
export function averageEdgeLength(mesh) {
  let total = 0;
  let count = 0;
  for (const edge of mesh.edges) {
    total += length3(sub3(edge.v2.co, edge.v1.co));
    count++;
  }
  return count ? total / count : 0;
}

export { faceNormal, faceVerts, vertFaces };
