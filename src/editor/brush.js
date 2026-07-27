/**
 * The brush core shared by mesh sculpting and terrain sculpt/paint/scatter.
 *
 * These two work on genuinely different data — an arbitrary BMesh versus a
 * heightfield plus a splatmap — so they cannot share the operators themselves.
 * What they *can* share is what makes a brush feel like a brush:
 *
 *   - how far it reaches and how hard it falls off,
 *   - how dabs are laid out along a drag.
 *
 * Before this existed the two disagreed on both. Terrain used a single
 * hardness exponent while the mesh sculptor used Blender's named curves, and
 * terrain applied exactly one dab per pointer event, so a quick drag left a
 * dotted line instead of a stroke.
 *
 * Deliberately dimension-agnostic: points are plain number arrays, so terrain
 * can pass world XZ and the mesh sculptor can pass XYZ.
 */

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
const lerp = (a, b, t) => a + (b - a) * t;

/* -------------------------------------------------------------------------- */
/* Falloff                                                                     */
/* -------------------------------------------------------------------------- */

export const FALLOFF_CURVES = [
  { id: "smooth", label: "Smooth" },
  { id: "sphere", label: "Sphere" },
  { id: "root", label: "Root" },
  { id: "inverseSquare", label: "Inverse Square" },
  { id: "sharp", label: "Sharp" },
  { id: "linear", label: "Linear" },
  { id: "constant", label: "Constant" },
];

/**
 * Blender's proportional-editing / brush falloff curves.
 *
 * `normalized` is distance / radius, so 0 is the centre of the brush and 1 its
 * rim. Every curve returns 1 at the centre and exactly 0 at and beyond the rim,
 * which is what lets callers skip anything that weighs 0.
 */
export function falloffWeight(normalized, curve = "smooth") {
  const t = clamp01(normalized);
  if (t >= 1) return 0;
  switch (curve) {
    case "constant": return 1;
    case "linear": return 1 - t;
    case "sharp": return (1 - t) ** 2;
    case "root": return Math.sqrt(1 - t);
    case "sphere": return Math.sqrt(Math.max(0, 1 - t * t));
    case "inverseSquare": return 1 - t * t;
    default: return 0.5 + 0.5 * Math.cos(Math.PI * t);
  }
}

/**
 * Brush weight from either model.
 *
 * With no `curve`, falls back to the hardness exponent the terrain tools have
 * always used — `(1 - d/r) ^ lerp(0.4, 4, hardness)` — so existing terrain
 * strokes keep behaving exactly as they did. Naming a curve opts into the
 * shared set instead, which is how terrain gains them without a migration.
 */
export function brushWeight(normalized, { curve = null, hardness = 0.5 } = {}) {
  if (curve) return falloffWeight(normalized, curve);
  const t = clamp01(normalized);
  if (t >= 1) return 0;
  return (1 - t) ** lerp(0.4, 4, clamp01(hardness));
}

/* -------------------------------------------------------------------------- */
/* Stroke dabs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Stroke state. `spacing` is a fraction of the radius, so the dab rate follows
 * the brush size the way it does in Blender.
 */
export function createStroke({ spacing = 0.3 } = {}) {
  return { spacing: Math.max(spacing, 0.01), last: null, dabs: 0 };
}

const distanceBetween = (a, b) => {
  let total = 0;
  for (let axis = 0; axis < a.length; axis++) total += (a[axis] - b[axis]) ** 2;
  return Math.sqrt(total);
};

/**
 * The dab centres to apply for a new pointer sample.
 *
 * Pointer events arrive far apart during a quick drag, so the gap since the
 * last sample is filled in at `spacing * radius` intervals. The first sample of
 * a stroke always produces exactly one dab; a sample closer than one step
 * produces none, which stops a slow drag piling hundreds of dabs on one spot.
 *
 * The interpolation count is capped so that dragging across a large terrain
 * with a tiny brush cannot queue tens of thousands of dabs in one event.
 */
export function strokeDabs(stroke, point, radius, { maxPerEvent = 64 } = {}) {
  const step = Math.max(radius * stroke.spacing, 1e-4);
  if (!stroke.last) {
    stroke.last = [...point];
    stroke.dabs++;
    return [[...point]];
  }
  const distance = distanceBetween(point, stroke.last);
  if (distance < step) return [];
  const count = Math.min(Math.floor(distance / step), maxPerEvent);
  const positions = [];
  for (let index = 1; index <= count; index++) {
    const t = (index * step) / distance;
    positions.push(stroke.last.map((value, axis) => value + (point[axis] - value) * t));
  }
  stroke.last = [...positions[positions.length - 1]];
  stroke.dabs += positions.length;
  return positions;
}

/** Forgets the stroke's trail so the next sample starts a fresh dab. */
export function resetStroke(stroke) {
  stroke.last = null;
  return stroke;
}
