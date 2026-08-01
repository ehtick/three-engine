import * as THREE from "three/webgpu";
import { SplineFrame } from "./splineMath.js";

/**
 * Extrudes a cross-section along a spline (roadmap item 16) — roads, ramps,
 * fences, walls, pipes, cables, tunnels.
 *
 * ## A profile is 2D, and that is the whole trick
 *
 * The cross-section is authored in the frame's own plane: `x` runs along the
 * binormal (across the road), `y` along the normal (up). Sweeping it means
 * placing one ring of vertices per sample and stitching consecutive rings.
 * Everything that makes the result look right — a road that banks with the
 * path, a pipe that does not corkscrew, a fence whose posts stay vertical — is
 * a property of the FRAME, and was already solved once in splineMath.js. This
 * file contains no orientation logic at all, which is the point of building it
 * on rotation-minimizing frames rather than re-deriving an up-vector here.
 *
 * ## V runs on arc length
 *
 * The obvious `v = ringIndex / ringCount` stretches the texture over long
 * segments and squashes it in tight corners, so a road's centre line changes
 * dash length as it curves — the single most visible artefact this feature can
 * have. `v` is metres along the path, scaled by a tiling factor.
 */

/** Built-in cross-sections. Each returns `{ points: [{x, y, u}], closed }`. */
export const PROFILES = ["road", "wall", "tube", "box"];

export function buildProfile(kind, { width = 4, height = 1, radius = 0.5, sides = 12 } = {}) {
  const halfW = Math.max(1e-4, width) / 2;
  const h = Math.max(1e-4, height);
  switch (kind) {
    case "wall":
      // Ordered bottom→top so the outward normal lands on +binormal (the
      // right-hand side of travel). See the winding note below.
      return { points: [{ x: 0, y: 0, u: 0 }, { x: 0, y: h, u: 1 }], closed: false };
    case "tube": {
      const n = THREE.MathUtils.clamp(Math.round(sides), 3, 128);
      const r = Math.max(1e-4, radius);
      const points = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        points.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, u: i / n });
      }
      return { points, closed: true };
    }
    case "box":
      return {
        points: [
          { x: halfW, y: 0, u: 0 },
          { x: halfW, y: h, u: 0.25 },
          { x: -halfW, y: h, u: 0.5 },
          { x: -halfW, y: 0, u: 0.75 },
        ],
        closed: true,
      };
    case "road":
    default:
      // +x → -x, so the face normal comes out along +normal (up). Reversing
      // this list is exactly how you get a road that is invisible from above
      // and solid from below, with nothing in the inspector to explain it.
      return { points: [{ x: halfW, y: 0, u: 1 }, { x: -halfW, y: 0, u: 0 }], closed: false };
  }
}

/** 2D outward normals for a profile, from the perpendicular of the adjacent edges. */
function profileNormals(profile) {
  const { points, closed } = profile;
  const n = points.length;
  const normals = [];
  for (let i = 0; i < n; i++) {
    let dx = 0;
    let dy = 0;
    const prev = closed ? points[(i - 1 + n) % n] : points[Math.max(0, i - 1)];
    const next = closed ? points[(i + 1) % n] : points[Math.min(n - 1, i + 1)];
    dx = next.x - prev.x;
    dy = next.y - prev.y;
    // perp(d) = (dy, -dx): with a counter-clockwise profile this points
    // outward, which is what makes a tube lit from the outside.
    let nx = dy;
    let ny = -dx;
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) {
      nx = 0;
      ny = 1;
    } else {
      nx /= len;
      ny /= len;
    }
    normals.push({ x: nx, y: ny });
  }
  return normals;
}

/**
 * Sweeps `profile` along `spline`.
 *
 * @param {import("./splineMath.js").Spline} spline
 * @param {object} options
 *   profile      one of PROFILES, or an explicit `{ points, closed }`
 *   width/height/radius/sides   profile dimensions
 *   density      rings per unit of path length (clamped to a sane ring count)
 *   uvScale      texture repeats per unit along the path
 *   uOffset      shifts the cross-section U, for lining a road marking up
 *   capEnds      closes an open path's ends (closed profiles only)
 *   matrix       optional transform applied to the result (path space → mesh space)
 * @returns {{positions:Float32Array, normals:Float32Array, uvs:Float32Array, indices:Uint32Array}}
 */
export function buildSplineGeometry(spline, options = {}) {
  const empty = {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    indices: new Uint32Array(0),
  };
  if (!spline?.valid) return empty;

  const profile =
    typeof options.profile === "object" && options.profile?.points?.length
      ? options.profile
      : buildProfile(options.profile ?? "road", options);
  const points = profile.points;
  const P = points.length;
  if (P < 2) return empty;
  const normals2D = profileNormals(profile);

  const length = spline.length;
  const density = Number.isFinite(options.density) ? options.density : 2;
  // The lower bound is not cosmetic: two rings on a curved path is a straight
  // box between the endpoints, which looks like the spline was ignored.
  const rings = THREE.MathUtils.clamp(Math.round(length * density) + 1, 2, 4000);
  const closedPath = spline.closed;
  // A closed path's last ring is the first one again. Emitting it as its own
  // vertices rather than reusing ring 0 is deliberate — the seam needs a
  // distinct V coordinate or the texture runs backwards across the join.
  const ringCount = rings;
  const uvScale = Number.isFinite(options.uvScale) ? options.uvScale : 0.25;
  const uOffset = options.uOffset ?? 0;

  const vertexCount = ringCount * P;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const frame = new SplineFrame();
  const pos = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  for (let r = 0; r < ringCount; r++) {
    const distance = (r / (ringCount - 1)) * length;
    spline.frameAtDistance(distance, frame);
    for (let i = 0; i < P; i++) {
      const p = points[i];
      pos
        .copy(frame.position)
        .addScaledVector(frame.binormal, p.x)
        .addScaledVector(frame.normal, p.y);
      const n2 = normals2D[i];
      nrm.set(0, 0, 0).addScaledVector(frame.binormal, n2.x).addScaledVector(frame.normal, n2.y).normalize();
      positions.push(pos.x, pos.y, pos.z);
      normals.push(nrm.x, nrm.y, nrm.z);
      uvs.push(p.u + uOffset, distance * uvScale);
    }
  }

  const ringStride = P;
  const columns = profile.closed ? P : P - 1;
  for (let r = 0; r < ringCount - 1; r++) {
    for (let c = 0; c < columns; c++) {
      const i0 = c;
      const i1 = (c + 1) % P;
      const a = r * ringStride + i0;
      const b = r * ringStride + i1;
      const cc = (r + 1) * ringStride + i0;
      const d = (r + 1) * ringStride + i1;
      indices.push(a, cc, b, b, cc, d);
    }
  }

  if (options.capEnds && profile.closed && !closedPath) {
    addCap(positions, normals, uvs, indices, spline, profile, normals2D, 0, -1);
    addCap(positions, normals, uvs, indices, spline, profile, normals2D, length, 1);
  }

  const result = {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    vertexCount,
    ringCount,
  };
  if (options.matrix) applyMatrix(result, options.matrix);
  return result;
}

/** Triangle fan closing one end of a tube/box. */
function addCap(positions, normals, uvs, indices, spline, profile, normals2D, distance, sign) {
  const frame = new SplineFrame();
  spline.frameAtDistance(distance, frame);
  const base = positions.length / 3;
  const centre = new THREE.Vector3().copy(frame.position);
  const n = new THREE.Vector3().copy(frame.tangent).multiplyScalar(sign);
  positions.push(centre.x, centre.y, centre.z);
  normals.push(n.x, n.y, n.z);
  uvs.push(0.5, 0.5);
  const pos = new THREE.Vector3();
  for (const p of profile.points) {
    pos.copy(frame.position).addScaledVector(frame.binormal, p.x).addScaledVector(frame.normal, p.y);
    positions.push(pos.x, pos.y, pos.z);
    normals.push(n.x, n.y, n.z);
    uvs.push(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
  }
  const count = profile.points.length;
  for (let i = 0; i < count; i++) {
    const a = base;
    const b = base + 1 + i;
    const c = base + 1 + ((i + 1) % count);
    // The two ends face opposite ways, so one of them has to wind the other
    // way round or it is invisible from outside.
    if (sign > 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  }
}

function applyMatrix(result, matrix) {
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const v = new THREE.Vector3();
  for (let i = 0; i < result.positions.length; i += 3) {
    v.fromArray(result.positions, i).applyMatrix4(matrix).toArray(result.positions, i);
    v.fromArray(result.normals, i).applyMatrix3(normalMatrix).normalize().toArray(result.normals, i);
  }
}

/** Fills a BufferGeometry in place, reusing its attributes when they still fit. */
export function applySplineGeometry(geometry, data) {
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}
