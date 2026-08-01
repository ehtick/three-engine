/**
 * Ribbon geometry — the shared core of the line renderer and the trail
 * renderer (roadmap item 13).
 *
 * A ribbon is a polyline given width: a strip of quads following a spine, with
 * width, colour and UVs varying along it. Lines and trails differ only in
 * *where the spine comes from* (authored points vs. a moving object's history),
 * which is why the geometry lives here and not in either component.
 *
 * ## The strip is built once per spine change, not once per frame
 *
 * The obvious implementation billboards on the CPU: for each point, compute the
 * side vector from the camera position and write two offset vertices. It is
 * also wrong in this editor. There are two live cameras — the viewport's orbit
 * camera and the game camera — plus a shadow pass, all rendering the SAME
 * geometry in the same frame, and a CPU-billboarded ribbon can only be correct
 * for one of them. It also re-uploads the whole buffer whenever the camera
 * moves, for a trail that hasn't changed.
 *
 * So this writes the *spine* — position, tangent, a side sign, a width and a
 * colour per vertex — and the material's vertex stage does the billboard from
 * whichever camera is drawing (see vfxMaterial.js). The buffer is then a pure
 * function of the points, and a static line costs nothing per frame.
 *
 * ## What the caller decides
 *
 * `params[i]` is the ramp coordinate of point i — what "start" and "end" mean
 * for the colour/width ramp. A line uses distance along itself; a trail uses
 * the point's AGE, which is not the same thing at all (a trail from an object
 * that stopped moving has all its length at one end of the age ramp). Passing
 * it in keeps that decision with the component that knows the answer.
 */

const _tangent = { x: 0, y: 0, z: 0 };

/** Growable typed-array set for one ribbon. Never shrinks — a trail that once
 *  reached 200 points will reach it again, and reallocating every time it dips
 *  costs more than the memory. */
export class RibbonBuffer {
  constructor() {
    this.pointCapacity = 0;
    this.positions = new Float32Array(0);
    this.tangents = new Float32Array(0);
    this.sides = new Float32Array(0);
    this.widths = new Float32Array(0);
    this.colors = new Float32Array(0);
    this.uvs = new Float32Array(0);
    this.indices = new Uint32Array(0);
    /** Vertices actually written (2 per spine point). */
    this.vertexCount = 0;
    /** Indices actually written (6 per segment). */
    this.indexCount = 0;
    /** Bounds of the spine, for a frustum-cullable bounding sphere. */
    this.center = [0, 0, 0];
    this.radius = 0;
    /** Bumped whenever the arrays are reallocated, so consumers know to
     *  re-point their BufferAttributes instead of just flagging an update. */
    this.generation = 0;
  }

  ensure(points) {
    if (points <= this.pointCapacity) return;
    let next = Math.max(this.pointCapacity || 8, 8);
    while (next < points) next *= 2;
    this.pointCapacity = next;
    this.positions = new Float32Array(next * 2 * 3);
    this.tangents = new Float32Array(next * 2 * 3);
    this.sides = new Float32Array(next * 2);
    this.widths = new Float32Array(next * 2);
    this.colors = new Float32Array(next * 2 * 4);
    this.uvs = new Float32Array(next * 2 * 2);
    // Closed ribbons need one segment more than an open one.
    this.indices = new Uint32Array(next * 6);
    this.generation++;
  }
}

/** Linear ramp between two rgba arrays, into `out`. */
function lerpColor(a, b, t, out) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  out[3] = a[3] + (b[3] - a[3]) * t;
  return out;
}

const _color = [0, 0, 0, 0];

/**
 * Writes one ribbon into `out`.
 *
 * `points` is a flat `[x,y,z, x,y,z, …]` array of `count` spine points, in the
 * space the mesh will be drawn in. Returns `out`.
 *
 * Options:
 *   params          per-point ramp coordinate (0..1). Defaults to normalized
 *                   arc length.
 *   closed          join the last point back to the first.
 *   startWidth/endWidth, startColor/endColor  the ramps, sampled at `params[i]`.
 *   pointWidths / pointColors  per-point overrides (a script driving colour
 *                   directly); when present the ramps are ignored.
 *   textureMode     "stretch" — u spans 0..1 over the whole ribbon (× tiling)
 *                   "tile"    — u advances one repeat per `tiling` world units,
 *                               so a long trail doesn't smear one texture over
 *                               forty metres.
 *   tiling          repeats (stretch) or world units per repeat (tile).
 */
export function buildRibbon(out, points, count, options = {}) {
  const {
    params = null,
    closed = false,
    startWidth = 0.1,
    endWidth = 0.1,
    startColor = [1, 1, 1, 1],
    endColor = [1, 1, 1, 1],
    pointWidths = null,
    pointColors = null,
    textureMode = "stretch",
    tiling = 1,
  } = options;

  out.vertexCount = 0;
  out.indexCount = 0;
  out.radius = 0;
  // A one-point ribbon is not degenerate geometry, it is *no* geometry: there
  // is no direction to give it width along. Callers must handle the empty
  // result rather than getting a zero-area quad that still costs a draw.
  if (count < 2) return out;

  out.ensure(closed ? count + 1 : count);

  const { positions, tangents, sides, widths, colors, uvs, indices } = out;

  // Pass 1: cumulative arc length. Needed for the default ramp AND for
  // world-unit texture tiling, so it is worth the extra walk.
  let total = 0;
  const distances = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const dx = points[i * 3] - points[(i - 1) * 3];
    const dy = points[i * 3 + 1] - points[(i - 1) * 3 + 1];
    const dz = points[i * 3 + 2] - points[(i - 1) * 3 + 2];
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
    distances[i] = total;
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    const x = points[i * 3];
    const y = points[i * 3 + 1];
    const z = points[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;

    // Tangent: the centred difference, so a corner splits the bend between its
    // two segments instead of shearing one of them. Endpoints fall back to
    // their single segment (or wrap, when closed).
    const prev = i > 0 ? i - 1 : closed ? count - 1 : i;
    const next = i < count - 1 ? i + 1 : closed ? 0 : i;
    _tangent.x = points[next * 3] - points[prev * 3];
    _tangent.y = points[next * 3 + 1] - points[prev * 3 + 1];
    _tangent.z = points[next * 3 + 2] - points[prev * 3 + 2];
    let length = Math.hypot(_tangent.x, _tangent.y, _tangent.z);
    if (length < 1e-9) {
      // Coincident neighbours (an object that stopped moving, a duplicated
      // authored point). Reuse the previous tangent rather than emitting a
      // zero vector, which the shader would normalize into NaN and the whole
      // ribbon would vanish — a spectacular failure for a duplicated point.
      if (i > 0) {
        _tangent.x = tangents[(i - 1) * 6];
        _tangent.y = tangents[(i - 1) * 6 + 1];
        _tangent.z = tangents[(i - 1) * 6 + 2];
      } else {
        _tangent.x = 1;
        _tangent.y = 0;
        _tangent.z = 0;
      }
      length = 1;
    }
    _tangent.x /= length;
    _tangent.y /= length;
    _tangent.z /= length;

    const t = params ? params[i] : total > 0 ? distances[i] / total : count > 1 ? i / (count - 1) : 0;
    const width = pointWidths ? pointWidths[i] : startWidth + (endWidth - startWidth) * t;
    const rgba = pointColors
      ? [pointColors[i * 4], pointColors[i * 4 + 1], pointColors[i * 4 + 2], pointColors[i * 4 + 3]]
      : lerpColor(startColor, endColor, t, _color);

    const u =
      textureMode === "tile"
        ? distances[i] / Math.max(1e-6, tiling)
        : (total > 0 ? distances[i] / total : 0) * tiling;

    for (let side = 0; side < 2; side++) {
      const v = i * 2 + side;
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      tangents[v * 3] = _tangent.x;
      tangents[v * 3 + 1] = _tangent.y;
      tangents[v * 3 + 2] = _tangent.z;
      sides[v] = side === 0 ? -1 : 1;
      widths[v] = width;
      colors[v * 4] = rgba[0];
      colors[v * 4 + 1] = rgba[1];
      colors[v * 4 + 2] = rgba[2];
      colors[v * 4 + 3] = rgba[3];
      uvs[v * 2] = u;
      uvs[v * 2 + 1] = side;
    }
  }

  out.vertexCount = count * 2;

  const segments = closed ? count : count - 1;
  let write = 0;
  for (let s = 0; s < segments; s++) {
    const a = s * 2;
    const b = ((s + 1) % count) * 2;
    indices[write++] = a;
    indices[write++] = a + 1;
    indices[write++] = b;
    indices[write++] = b;
    indices[write++] = a + 1;
    indices[write++] = b + 1;
  }
  out.indexCount = write;

  out.center[0] = (minX + maxX) / 2;
  out.center[1] = (minY + maxY) / 2;
  out.center[2] = (minZ + maxZ) / 2;
  // Half the diagonal, plus the widest half-width: the strip extends sideways
  // from the spine, and a bound that ignores it pops the ribbon out of view
  // early when the camera is looking along it.
  const halfDiagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
  let widest = 0;
  for (let i = 0; i < count * 2; i++) if (widths[i] > widest) widest = widths[i];
  out.radius = halfDiagonal + widest / 2;
  return out;
}

/**
 * Catmull-Rom subdivision of a polyline, for the line renderer's `smoothing`.
 *
 * A laser between two points needs none of this; a rope, a rail or a hose
 * authored from six points needs all of it, and asking the user to place forty
 * points instead is not a feature. `subdivisions` is the number of extra points
 * inserted per segment.
 *
 * Uses the centripetal parameterization (alpha = 0.5). The uniform version
 * overshoots — and an overshooting rope passes through the wall it was
 * carefully placed against, which is the same reason the timeline's `smooth`
 * interpolation clamps its tangents.
 */
export function smoothPolyline(points, count, subdivisions, closed = false, out = null) {
  if (subdivisions < 1 || count < 2) {
    const copy = out ?? new Float32Array(count * 3);
    copy.set(points.subarray ? points.subarray(0, count * 3) : points.slice(0, count * 3));
    return { points: copy, count };
  }
  const segments = closed ? count : count - 1;
  const outCount = segments * (subdivisions + 1) + (closed ? 0 : 1);
  const result = out && out.length >= outCount * 3 ? out : new Float32Array(outCount * 3);
  const at = (index, axis) => {
    let i = index;
    if (closed) i = ((i % count) + count) % count;
    else i = Math.min(count - 1, Math.max(0, i));
    return points[i * 3 + axis];
  };

  let write = 0;
  const p0 = [0, 0, 0], p1 = [0, 0, 0], p2 = [0, 0, 0], p3 = [0, 0, 0];
  for (let s = 0; s < segments; s++) {
    for (let axis = 0; axis < 3; axis++) {
      p0[axis] = at(s - 1, axis);
      p1[axis] = at(s, axis);
      p2[axis] = at(s + 1, axis);
      p3[axis] = at(s + 2, axis);
    }
    // Knot spacing from the 3D distances, computed once per segment: doing it
    // per axis would give each axis its own parameterization, which is not a
    // curve through the points at all.
    const knots = centripetalKnots(p0, p1, p2, p3);
    const steps = subdivisions + 1;
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      for (let axis = 0; axis < 3; axis++) {
        result[write * 3 + axis] = evalCatmullRom(p0[axis], p1[axis], p2[axis], p3[axis], knots, t);
      }
      write++;
    }
  }
  if (!closed) {
    result[write * 3] = points[(count - 1) * 3];
    result[write * 3 + 1] = points[(count - 1) * 3 + 1];
    result[write * 3 + 2] = points[(count - 1) * 3 + 2];
    write++;
  }
  return { points: result, count: write };
}

/** Centripetal knot vector for one Catmull-Rom segment (alpha = 0.5). The
 *  floor on each interval is what keeps two coincident control points from
 *  dividing by zero — an authored duplicate is a mistake, not a crash. */
function centripetalKnots(v0, v1, v2, v3) {
  const d = (a, b) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  const t0 = 0;
  const t1 = t0 + Math.max(1e-6, d(v0, v1));
  const t2 = t1 + Math.max(1e-6, d(v1, v2));
  const t3 = t2 + Math.max(1e-6, d(v2, v3));
  return [t0, t1, t2, t3];
}

/** One axis of a Catmull-Rom segment, evaluated with the shared knots. */
function evalCatmullRom(p0, p1, p2, p3, [t0, t1, t2, t3], t) {
  const tt = t1 + (t2 - t1) * t;
  const a1 = ((t1 - tt) / (t1 - t0)) * p0 + ((tt - t0) / (t1 - t0)) * p1;
  const a2 = ((t2 - tt) / (t2 - t1)) * p1 + ((tt - t1) / (t2 - t1)) * p2;
  const a3 = ((t3 - tt) / (t3 - t2)) * p2 + ((tt - t2) / (t3 - t2)) * p3;
  const b1 = ((t2 - tt) / (t2 - t0)) * a1 + ((tt - t0) / (t2 - t0)) * a2;
  const b2 = ((t3 - tt) / (t3 - t1)) * a2 + ((tt - t1) / (t3 - t1)) * a3;
  return ((t2 - tt) / (t2 - t1)) * b1 + ((tt - t1) / (t2 - t1)) * b2;
}
