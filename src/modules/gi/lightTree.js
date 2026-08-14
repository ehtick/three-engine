// LIGHT TREE — ONE representation for every emissive mesh.
// docs/GI_NEXT_ARCHITECTURE.md §7 item 1 (the CPU half; no GPU in this file).
//
// ══ WHY ═════════════════════════════════════════════════════════════════════
//
// Today an emissive mesh is either PROMOTED into one of `MAX_EMITTERS = 4`
// analytic uniform slots (exact silhouette, full energy) or it is not (field
// transport only, ~17% of the energy). Promotion RANKS BY POWER, so the
// ordering churns as objects spawn and despawn, and every boundary crossing is
// a ~6x light pop fired exactly when the player shoots. `giScreen.js:754`
// allocates MAX_EMITTERS shadow vars PER RESOLVE PIXEL and `:763` loops the
// slots, so the screen emitter pass is O(lights x pixels) by construction.
//
// Four symptoms, one cause: there are TWO representations and a cap deciding
// which one you get. This module builds the single representation. No cap, no
// promotion, no ranking, no second path — **so the pop cannot happen**. The
// per-shading-point cost becomes O(log n): descend the tree by importance,
// pick 1-2 lights, return the pdf, and let the caller cast ONE shadow ray.
//
// ══ WHAT REUSES WHAT ════════════════════════════════════════════════════════
//
//   · the BVH itself is `dynamicObjects.buildBvhWords` — the SAME builder the
//     static shadow BVH and every per-object BVH8 use, with the SAME 28-word
//     wide-node layout, the SAME ref encoding and the SAME slot-tagged
//     stride-10 triangle format. Each emitter enters the build as ONE proxy
//     triangle whose AABB is exactly the emitter's world AABB, tagged with its
//     emitter index (`triSlotOf`), so SAH quality, leaf packing and the
//     traversal word layout are inherited rather than re-derived.
//   · emitter attributes come from `voxelizeOnce.resolveMaterialSurface` — the
//     SAME resolver the voxel path uses. §6.6 makes this point for the surface
//     cache and it applies here identically: if the tree's notion of an
//     emitter's colour differs from the voxel path's, an object crossing
//     between them steps hue. That exact bug has been made once in this module
//     already (the "mean albedo" word in dynamicObjects.js exists because an
//     adopted mover's colour went missing when it left the voxel field).
//   · the irradiance model mirrors `giLight.sphereLightFactor` /
//     `giLight.boxLightFactor` term for term, and the sphere-vs-oriented-box
//     `kind` split mirrors `GISystem#refreshEmitterSlots`. A promoted emitter
//     and a tree-sampled emitter must deliver the SAME number or the migration
//     itself is a visible change.
//
// ══ WORD LAYOUT (relative to `baseWord`, exactly like dynamicObjects) ════════
//
// One contiguous u32 block, uploaded the way the BVH pool already is (a
// one-shot staging copy into the reserved tail of the occupancy `bits`
// buffer — zero new bindings). Offsets stored INSIDE the block are relative to
// the block base, so a consumer only ever needs `baseWord`. Values are raw u32
// where they are counts/offsets/ids and bitcast f32 where they are geometry or
// radiometry — the same split `buildBvhWords` itself uses (refs raw, bounds
// f32, slot word raw).
//
//   HEADER — 16 words at +0
//     0   emitterCount                                            (u32)
//     1   nodeBase     — start of the buildBvhWords node words     (u32)
//     2   triBase      — stride-10 proxy tris, +9 = emitter index  (u32)
//     3   attrBase     — cluster attribute records                 (u32)
//     4   emitterBase  — emitter records                           (u32)
//     5   nodeCount                                               (u32)
//     6   arity (4)                                               (u32)
//     7   totalPower  Phi over every emitter                      (f32)
//     8..10  root mean emission axis                              (f32)
//     11  root cos(theta_o)                                       (f32)
//     12  root cos(theta_e)                                       (f32)
//     13  maxDepth  — deepest internal node, traversal stack size (u32)
//     14  version (1)                                             (u32)
//     15  totalWords — the whole block, for the staging copy       (u32)
//
//   NODES — `buildBvhWords(proxy, 4)` output, VERBATIM. 28 words per node:
//     +0..3    child refs (0 empty | bit31 leaf: start[0..23], count[24..30]
//              | else child node index + 1)
//     +4+c*6   child c AABB (min.xyz, max.xyz) f32 — EXACT, not quantized
//     Arity 4 (not the 8-wide compressed format the mesh BVHs default to)
//     because the importance function reads these bounds as a *measure* — a
//     conservatively-widened child box is harmless for a slab test but skews
//     the subtended solid angle that drives the sampling probability. 4-wide
//     is also the only format whose bounds are exact f32 in place.
//
//   PROXY TRIANGLES — stride 10, `buildBvhWords`' slot-tagged format:
//     +0..8  the proxy triangle (unused by the sampler; kept because it IS the
//            builder's format and a future ray-vs-emitter test can use it)
//     +9     EMITTER INDEX (raw u32) — the slot word, reused as the id
//
//   CLUSTER ATTRIBUTES — 8 words at attrBase + (node*4 + childSlot)*8:
//     +0   Phi of the subtree under this child slot                (f32)
//     +1..3 mean emission axis (unit)                             (f32)
//     +4   cos(theta_o) — cone half-angle bounding every descendant normal
//     +5   cos(theta_e) — emission half-angle about each normal (pi/2 diffuse)
//     +6   emitter count under this slot                          (u32)
//     +7   reserved
//     Attributes live PER CHILD SLOT rather than per node because the descent
//     needs every sibling's importance at the parent — one cache line, no
//     pointer chase. The root's own totals are in the header for the same
//     reason (it has no parent to hold them).
//
//   EMITTER RECORDS — 32 words at emitterBase + i*32:
//     +0..5   world AABB (min.xyz, max.xyz)                        (f32)
//     +6..8   emissive radiance RGB, premultiplied by emissiveIntensity —
//             `resolveMaterialSurface`, byte-for-byte what the voxel path
//             composites                                          (f32)
//     +9      power Phi = pi * area * mean(RGB)                    (f32)
//     +10..12 mean emission axis (unit, world)                     (f32)
//     +13     cos(theta_o)                                         (f32)
//     +14     cos(theta_e)                                         (f32)
//     +15     world surface area                                   (f32)
//     +16..18 shape centre (world)                                 (f32)
//     +19     angular radius — sphere radius, or the Cauchy mean-projected-
//             area equivalent for boxes (giLight.emitterAngularRadius)  (f32)
//     +20     kind: 0 sphere, 1 oriented box (giLight slot `kind`)  (u32)
//     +21..23 box world half extents, floored at 0.005 like the slots (f32)
//     +24..26 box axis X (unit, world)                             (f32)
//     +27..29 box axis Y (unit; axis Z = cross(X, Y))              (f32)
//     +30     mesh id                                              (u32)
//     +31     instance id (0xffffffff = whole mesh)                (u32)
//
// ══ THE SAMPLER ═════════════════════════════════════════════════════════════
//
// Importance-weighted descent, PBRT-v4 / Conty & Kulla "Importance Sampling of
// Many Lights" with Cycles' adaptive splitting. Two invariants make it usable
// as an NEE estimator, and both are load-bearing:
//
//   1. THE PDF IS RETURNED. A sampler without its pdf is unusable — the NEE
//      estimator is sum(f(e) / p(e)) over the sampled set, and `p` is the
//      MARGINAL INCLUSION probability (which is not the descent probability
//      once splitting is on). `lightTreeSelectPdf` recomputes it independently
//      from the packed words for any emitter, which is what MIS needs and what
//      makes the unbiasedness test able to fail.
//   2. IMPORTANCE IS A CONSERVATIVE BOUND, never a heuristic that can reach
//      zero on a light that contributes. Every cluster's cone CONTAINS its
//      descendants' cones and every cluster's bounds CONTAIN their bounds, so
//      `importance(cluster) == 0` implies every member's contribution is 0.
//      Break that and the estimator is biased, silently, in exactly the
//      lighting conditions nobody screenshots.
//
// Splitting is depth- and ratio-gated, never budget-gated: a budget would make
// the decision depend on traversal ORDER, and then the pdf could not be
// recomputed for an arbitrary emitter. `maxSplitDepth = 1` gives the "1-2
// lights" of §7 exactly.
import * as THREE from "three/webgpu";
import { buildBvhWords } from "./dynamicObjects.js";
import { resolveMaterialSurface } from "./voxelizeOnce.js";

export const LIGHT_TREE_ARITY = 4;
export const LT_HEADER_WORDS = 16;
export const LT_NODE_WORDS = 28; // buildBvhWords' node stride (both arities)
export const LT_TRI_WORDS = 10; // slot-tagged triangle stride
export const LT_ATTR_WORDS = 8;
export const LT_EMITTER_WORDS = 32;
export const LT_VERSION = 1;
export const LT_NO_INSTANCE = 0xffffffff;

/** Emitter kinds — the same codes giLight's emitter slots use. */
export const LT_KIND = { sphere: 0, box: 1 };

// ═════════════════════════════════════════════════════════════ small vec math
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const safeSqrt = (x) => Math.sqrt(x > 0 ? x : 0);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.sqrt(dot3(a, a));
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm3 = (a) => {
  const l = len3(a);
  return l > 1e-20 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
};
const angleBetween = (a, b) => Math.acos(clamp(dot3(a, b), -1, 1));

/** Rodrigues rotation of `v` about the unit axis `k` by `angle` radians. */
function rotateAbout(v, k, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross3(k, v);
  const kd = dot3(k, v) * (1 - c);
  return [
    v[0] * c + kv[0] * s + k[0] * kd,
    v[1] * c + kv[1] * s + k[1] * kd,
    v[2] * c + kv[2] * s + k[2] * kd,
  ];
}

/**
 * Conservative union of two direction cones (PBRT-v4 `DirectionCone::Union`).
 * The result CONTAINS both inputs — the invariant that keeps `importance`
 * from ever zeroing a cluster whose members can still emit toward the point.
 */
export function coneUnion(axisA, cosA, axisB, cosB) {
  if (cosA <= -1 + 1e-9) return { axis: axisA.slice(), cosTheta: -1 };
  if (cosB <= -1 + 1e-9) return { axis: axisB.slice(), cosTheta: -1 };
  const thetaA = Math.acos(clamp(cosA, -1, 1));
  const thetaB = Math.acos(clamp(cosB, -1, 1));
  const thetaD = angleBetween(axisA, axisB);
  if (Math.min(thetaD + thetaB, Math.PI) <= thetaA) return { axis: axisA.slice(), cosTheta: cosA };
  if (Math.min(thetaD + thetaA, Math.PI) <= thetaB) return { axis: axisB.slice(), cosTheta: cosB };
  const thetaO = (thetaA + thetaD + thetaB) / 2;
  if (thetaO >= Math.PI) return { axis: axisA.slice(), cosTheta: -1 };
  const wr = cross3(axisA, axisB);
  if (dot3(wr, wr) < 1e-24) return { axis: axisA.slice(), cosTheta: -1 };
  return { axis: rotateAbout(axisA, norm3(wr), thetaO - thetaA), cosTheta: Math.cos(thetaO) };
}

// ═══════════════════════════════════════════════════ CPU: emitter description

/**
 * Describes one emissive placement as a light-tree emitter, or null when the
 * mesh emits nothing.
 *
 * NO PROMOTION GATE. `GISystem#buildEntries` qualifies emitters at
 * `peak >= 0.5` because it only has 4 analytic slots to hand out and has to
 * spend them on lamps; the tree has no slots to run out of, so the only thing
 * that disqualifies a mesh here is emitting literally nothing. `minPeak` is a
 * knob for callers who want a dim-emitter cull as a *perf* choice, and it
 * defaults to admitting everything.
 *
 * @param {THREE.Mesh} mesh
 * @param {{ instanceId?: number, matrixWorld?: THREE.Matrix4, minPeak?: number,
 *           thetaE?: number, maxConeTris?: number }} [options]
 *   `matrixWorld` overrides the mesh's own — this is how an InstancedMesh
 *   contributes one emitter PER INSTANCE. (Promotion cannot: one emitter slot
 *   is described by one `mesh.matrixWorld`, so every instance promoted to the
 *   prototype's position — see the `seenEmitterMesh` note in GISystem. The
 *   tree has no such constraint, which is a second capability the cap was
 *   hiding.)
 */
export function emitterFromMesh(mesh, options = {}) {
  const geometry = mesh?.geometry;
  const position = geometry?.attributes?.position;
  if (!position || position.count < 3) return null;

  // THE SHARED RESOLVER (§6.6). Not `material.emissive` — engine material
  // assets carry the real value in `emissiveNode` and the top-level field sits
  // at stale black.
  const surface = resolveMaterialSurface(mesh.material, mesh.name);
  const rgb = [
    (surface.emissive.r ?? 0) * surface.emissiveIntensity,
    (surface.emissive.g ?? 0) * surface.emissiveIntensity,
    (surface.emissive.b ?? 0) * surface.emissiveIntensity,
  ];
  const peak = Math.max(rgb[0], rgb[1], rgb[2]);
  if (!(peak > (options.minPeak ?? 0))) return null;

  let matrix = options.matrixWorld ?? null;
  if (!matrix) {
    mesh.updateWorldMatrix(true, false);
    matrix = mesh.matrixWorld;
  }
  const m = matrix.elements;
  // A mirrored transform flips winding, and with it the outward normal — the
  // emission cone would point INTO the mesh without this.
  const flip = matrix.determinant() < 0 ? -1 : 1;

  const index = geometry.index;
  const triCount = Math.floor((index ? index.count : position.count) / 3);
  if (triCount < 1) return null;
  const posArray = position.array;
  const idxArray = index ? index.array : null;
  const xf = (vi, out) => {
    const x = posArray[vi * 3];
    const y = posArray[vi * 3 + 1];
    const z = posArray[vi * 3 + 2];
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  };

  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const c = [0, 0, 0];
  const bmin = [Infinity, Infinity, Infinity];
  const bmax = [-Infinity, -Infinity, -Infinity];
  let area = 0;
  const nsum = [0, 0, 0];
  // Pass 1 — world AABB, total area, area-weighted normal sum (the cone axis).
  for (let t = 0; t < triCount; t++) {
    const i0 = idxArray ? idxArray[t * 3] : t * 3;
    const i1 = idxArray ? idxArray[t * 3 + 1] : t * 3 + 1;
    const i2 = idxArray ? idxArray[t * 3 + 2] : t * 3 + 2;
    xf(i0, a); xf(i1, b); xf(i2, c);
    for (let k = 0; k < 3; k++) {
      if (a[k] < bmin[k]) bmin[k] = a[k];
      if (b[k] < bmin[k]) bmin[k] = b[k];
      if (c[k] < bmin[k]) bmin[k] = c[k];
      if (a[k] > bmax[k]) bmax[k] = a[k];
      if (b[k] > bmax[k]) bmax[k] = b[k];
      if (c[k] > bmax[k]) bmax[k] = c[k];
    }
    const n = cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    const twoA = len3(n);
    if (twoA < 1e-20) continue;
    area += twoA * 0.5;
    nsum[0] += n[0] * 0.5 * flip;
    nsum[1] += n[1] * 0.5 * flip;
    nsum[2] += n[2] * 0.5 * flip;
  }
  if (!(area > 0) || !Number.isFinite(bmin[0])) return null;

  // Pass 2 — the cone half-angle: the widest deviation of any face normal from
  // the mean axis. A closed body's normals span the sphere, which falls out as
  // cos(theta_o) = -1 and an emitter that is never gated by direction.
  let axis = [0, 1, 0];
  let cosThetaO = -1;
  if (len3(nsum) > 1e-9 * area) {
    axis = norm3(nsum);
    let minDot = 1;
    for (let t = 0; t < triCount; t++) {
      const i0 = idxArray ? idxArray[t * 3] : t * 3;
      const i1 = idxArray ? idxArray[t * 3 + 1] : t * 3 + 1;
      const i2 = idxArray ? idxArray[t * 3 + 2] : t * 3 + 2;
      xf(i0, a); xf(i1, b); xf(i2, c);
      const n = cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
      const l = len3(n);
      if (l < 1e-20) continue;
      const d = (n[0] * axis[0] + n[1] * axis[1] + n[2] * axis[2]) * flip / l;
      if (d < minDot) minDot = d;
      if (minDot <= -1 + 1e-6) break; // already the whole sphere
    }
    cosThetaO = clamp(minDot, -1, 1);
  }
  // Lambertian emission about each normal. Kept as a stored word rather than a
  // constant so a future spot/IES emitter narrows it without a format change.
  const thetaE = options.thetaE ?? Math.PI / 2;
  const cosThetaE = Math.cos(clamp(thetaE, 0, Math.PI));

  // SHAPE — verbatim `GISystem#refreshEmitterSlots`. Full spheres keep the
  // sphere model; EVERYTHING else is an oriented box from the local AABB
  // carried through matrixWorld, which is exact for the box/plane primitives
  // users actually build lamps from.
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const scale = new THREE.Vector3();
  matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  const maxScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
  const params = geometry.parameters;
  const fullSphere =
    geometry.type === "SphereGeometry" &&
    (params?.phiLength ?? Math.PI * 2) > Math.PI * 2 - 1e-3 &&
    (params?.thetaLength ?? Math.PI) > Math.PI - 1e-3;

  let kind = LT_KIND.box;
  const centre = [0, 0, 0];
  let angularRadius = 0;
  const half = [0.005, 0.005, 0.005];
  let bx = [1, 0, 0];
  let by = [0, 1, 0];
  const bs = geometry.boundingSphere;
  const bb = geometry.boundingBox;
  const cv = new THREE.Vector3();
  if (fullSphere) {
    kind = LT_KIND.sphere;
    cv.copy(bs.center).applyMatrix4(matrix);
    centre[0] = cv.x; centre[1] = cv.y; centre[2] = cv.z;
    angularRadius = bs.radius * maxScale;
  } else {
    cv.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2).applyMatrix4(matrix);
    centre[0] = cv.x; centre[1] = cv.y; centre[2] = cv.z;
    const halfLocal = [
      (bb.max.x - bb.min.x) / 2,
      (bb.max.y - bb.min.y) / 2,
      (bb.max.z - bb.min.z) / 2,
    ];
    const axes = [];
    for (let k = 0; k < 3; k++) {
      const col = [m[k * 4], m[k * 4 + 1], m[k * 4 + 2]];
      const l = len3(col);
      axes.push(l > 1e-8 ? [col[0] / l, col[1] / l, col[2] / l] : [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0]);
      half[k] = Math.max(halfLocal[k] * l, 0.005);
    }
    bx = axes[0];
    by = axes[1];
    // Cauchy: the mean projected area of a convex body is surface/4, so the
    // disc-equivalent radius is sqrt(2(hx*hy + hy*hz + hz*hx)/pi). Same line as
    // the emitter slots — the angular size that drives penumbra k and glow.
    angularRadius = Math.sqrt(((half[0] * half[1] + half[1] * half[2] + half[2] * half[0]) * 2) / Math.PI);
  }

  // THE BOUND MUST CONTAIN THE SHAPE THAT IS EVALUATED, not just the triangles
  // it was measured from. `emitterIrradiance` integrates the sphere/OBB model,
  // and both can poke outside the triangle AABB — a tessellated sphere's true
  // surface sits outside its own hull, and the 0.005 half-extent floor thickens
  // a plane. If the AABB did not cover them, `clusterImportance`'s subtended
  // angle and horizon test would be evaluated against a smaller body than the
  // one delivering light, which is the one way this estimator can go biased at
  // grazing angles.
  if (kind === LT_KIND.sphere) {
    for (let k = 0; k < 3; k++) {
      bmin[k] = Math.min(bmin[k], centre[k] - angularRadius);
      bmax[k] = Math.max(bmax[k], centre[k] + angularRadius);
    }
  } else {
    const bz = cross3(bx, by);
    for (let k = 0; k < 3; k++) {
      const reach = Math.abs(bx[k]) * half[0] + Math.abs(by[k]) * half[1] + Math.abs(bz[k]) * half[2];
      bmin[k] = Math.min(bmin[k], centre[k] - reach);
      bmax[k] = Math.max(bmax[k], centre[k] + reach);
    }
  }

  const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
  return {
    mesh,
    instanceId: options.instanceId ?? -1,
    min: bmin,
    max: bmax,
    rgb,
    // Lambertian emitter: Phi = pi * A * L. Scalar (channel mean) because the
    // descent needs ONE importance; the estimator still carries full RGB.
    power: Math.PI * area * mean,
    area,
    axis,
    cosThetaO,
    cosThetaE,
    centre,
    angularRadius,
    kind,
    half,
    bx,
    by,
    meshId: mesh.id >>> 0,
  };
}

/**
 * Every emissive placement under `source` (an Object3D to traverse, or an
 * array of meshes). InstancedMesh members are expanded per instance — see the
 * `matrixWorld` note on emitterFromMesh.
 */
export function collectEmitters(source, options = {}) {
  const meshes = [];
  if (Array.isArray(source)) meshes.push(...source);
  else if (source?.traverse) source.traverse((o) => { if (o.isMesh) meshes.push(o); });
  else if (source?.isMesh) meshes.push(source);

  const out = [];
  const tmp = new THREE.Matrix4();
  for (const mesh of meshes) {
    if (mesh.visible === false && !mesh.userData?.batchedInto && !mesh.userData?.cameraHidden) continue;
    if (mesh.userData?.__giDebug) continue;
    if (mesh.isInstancedMesh) {
      mesh.updateWorldMatrix(true, false);
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, tmp);
        const world = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, tmp);
        const e = emitterFromMesh(mesh, { ...options, instanceId: i, matrixWorld: world });
        if (e) out.push(e);
      }
      continue;
    }
    const e = emitterFromMesh(mesh, options);
    if (e) out.push(e);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════ CPU: the packing

/** Words a tree over `emitterCount` emitters can need, for tail reservation. */
export function estimateLightTreeWords(emitterCount) {
  if (emitterCount < 1) return 0;
  // Worst case one leaf per emitter: nodes <= emitterCount, and every node
  // costs 28 node words + arity*8 attribute words.
  const n = emitterCount;
  return LT_HEADER_WORDS + n * (LT_NODE_WORDS + LIGHT_TREE_ARITY * LT_ATTR_WORDS) + n * LT_TRI_WORDS + n * LT_EMITTER_WORDS;
}

/**
 * Builds the light tree over `emitters` (from emitterFromMesh/collectEmitters)
 * and packs the whole thing into one u32 block ready to stage into the bits
 * tail at any `baseWord`.
 *
 * @returns {{ words: Uint32Array, layout: object, emitterCount: number,
 *             nodeCount: number, totalPower: number, maxDepth: number,
 *             emitters: Array }} or null when there is nothing to light with.
 */
export function buildLightTree(emitters, options = {}) {
  const list = (emitters ?? []).filter((e) => e && e.power > 0);
  if (list.length < 1) return null;
  const arity = LIGHT_TREE_ARITY;

  // ── the BVH, through the SHARED builder ───────────────────────────────────
  // One proxy triangle per emitter, chosen so its AABB IS the emitter's world
  // AABB: (min) , (max.x, min.y, max.z) , (max). A sequential index is what
  // lets `triSlotOf` recover the ORIGINAL triangle id (= emitter index) after
  // MeshBVH's in-place reorder — the same contract buildStaticSceneBvhWords
  // relies on for its slot tags.
  const proxy = new Float32Array(list.length * 9);
  const eps = options.boundsEpsilon ?? 1e-5;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const o = i * 9;
    // Widen by a hair so a zero-thickness emitter (an emissive plane) still
    // has a non-degenerate build box. Widening is conservative in both roles
    // it plays: a superset AABB can only OVER-state a cluster's importance,
    // never drop a light.
    const pad = [0, 1, 2].map((k) => eps * (Math.abs(e.max[k] - e.min[k]) + 1));
    proxy[o] = e.min[0] - pad[0]; proxy[o + 1] = e.min[1] - pad[1]; proxy[o + 2] = e.min[2] - pad[2];
    proxy[o + 3] = e.max[0] + pad[0]; proxy[o + 4] = e.min[1] - pad[1]; proxy[o + 5] = e.max[2] + pad[2];
    proxy[o + 6] = e.max[0] + pad[0]; proxy[o + 7] = e.max[1] + pad[1]; proxy[o + 8] = e.max[2] + pad[2];
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(proxy, 3));
  const index = new Uint32Array(list.length * 3);
  for (let i = 0; i < index.length; i++) index[i] = i;
  geom.setIndex(new THREE.BufferAttribute(index, 1));
  const packed = buildBvhWords(geom, arity, (origTri) => origTri >>> 0, options.strategy ?? null);
  geom.dispose();
  if (!packed) return null;

  const nodeCount = packed.nodeWords / LT_NODE_WORDS;
  const nodeBase = LT_HEADER_WORDS;
  const triBase = nodeBase + packed.nodeWords;
  const attrBase = triBase + packed.triWords;
  const emitterBase = attrBase + nodeCount * arity * LT_ATTR_WORDS;
  const totalWords = emitterBase + list.length * LT_EMITTER_WORDS;

  const words = new Uint32Array(totalWords);
  const f32 = new Float32Array(words.buffer);
  words.set(packed.words, nodeBase);

  // ── emitter records ───────────────────────────────────────────────────────
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const b = emitterBase + i * LT_EMITTER_WORDS;
    f32[b] = e.min[0]; f32[b + 1] = e.min[1]; f32[b + 2] = e.min[2];
    f32[b + 3] = e.max[0]; f32[b + 4] = e.max[1]; f32[b + 5] = e.max[2];
    f32[b + 6] = e.rgb[0]; f32[b + 7] = e.rgb[1]; f32[b + 8] = e.rgb[2];
    f32[b + 9] = e.power;
    f32[b + 10] = e.axis[0]; f32[b + 11] = e.axis[1]; f32[b + 12] = e.axis[2];
    f32[b + 13] = e.cosThetaO;
    f32[b + 14] = e.cosThetaE;
    f32[b + 15] = e.area;
    f32[b + 16] = e.centre[0]; f32[b + 17] = e.centre[1]; f32[b + 18] = e.centre[2];
    f32[b + 19] = e.angularRadius;
    words[b + 20] = e.kind >>> 0;
    f32[b + 21] = e.half[0]; f32[b + 22] = e.half[1]; f32[b + 23] = e.half[2];
    f32[b + 24] = e.bx[0]; f32[b + 25] = e.bx[1]; f32[b + 26] = e.bx[2];
    f32[b + 27] = e.by[0]; f32[b + 28] = e.by[1]; f32[b + 29] = e.by[2];
    words[b + 30] = e.meshId >>> 0;
    words[b + 31] = e.instanceId >= 0 ? e.instanceId >>> 0 : LT_NO_INSTANCE;
  }

  // ── cluster attributes, bottom-up over the packed nodes ───────────────────
  // Written from the PACKED words (not the pre-pack node objects), so a
  // packing bug shows up here rather than being papered over.
  let maxDepth = 0;
  const leafAggregate = (start, count) => {
    let power = 0;
    let cone = null;
    let cosE = -1;
    for (let j = 0; j < count; j++) {
      const id = words[triBase + (start + j) * LT_TRI_WORDS + 9];
      const e = list[id];
      power += e.power;
      cone = cone ? coneUnion(cone.axis, cone.cosTheta, e.axis, e.cosThetaO) : { axis: e.axis.slice(), cosTheta: e.cosThetaO };
      cosE = Math.max(cosE, e.cosThetaE);
    }
    return { power, axis: cone.axis, cosThetaO: cone.cosTheta, cosThetaE: cosE, count };
  };
  const visit = (nodeIndex, depth) => {
    if (depth > maxDepth) maxDepth = depth;
    const nb = nodeBase + nodeIndex * LT_NODE_WORDS;
    let power = 0;
    let cone = null;
    let cosE = -1;
    let count = 0;
    for (let c = 0; c < arity; c++) {
      const ref = words[nb + c];
      if (ref === 0) continue;
      const agg = (ref & 0x80000000)
        ? leafAggregate(ref & 0x00ffffff, (ref >>> 24) & 0x7f)
        : visit(ref - 1, depth + 1);
      const ab = attrBase + (nodeIndex * arity + c) * LT_ATTR_WORDS;
      f32[ab] = agg.power;
      f32[ab + 1] = agg.axis[0]; f32[ab + 2] = agg.axis[1]; f32[ab + 3] = agg.axis[2];
      f32[ab + 4] = agg.cosThetaO;
      f32[ab + 5] = agg.cosThetaE;
      words[ab + 6] = agg.count >>> 0;
      words[ab + 7] = 0;
      power += agg.power;
      count += agg.count;
      cosE = Math.max(cosE, agg.cosThetaE);
      cone = cone
        ? coneUnion(cone.axis, cone.cosTheta, agg.axis, agg.cosThetaO)
        : { axis: agg.axis.slice(), cosTheta: agg.cosThetaO };
    }
    if (!cone) cone = { axis: [0, 1, 0], cosTheta: -1 };
    return { power, axis: cone.axis, cosThetaO: cone.cosTheta, cosThetaE: cosE, count };
  };
  const root = visit(0, 0);

  // ── header ────────────────────────────────────────────────────────────────
  words[0] = list.length >>> 0;
  words[1] = nodeBase >>> 0;
  words[2] = triBase >>> 0;
  words[3] = attrBase >>> 0;
  words[4] = emitterBase >>> 0;
  words[5] = nodeCount >>> 0;
  words[6] = arity >>> 0;
  f32[7] = root.power;
  f32[8] = root.axis[0]; f32[9] = root.axis[1]; f32[10] = root.axis[2];
  f32[11] = root.cosThetaO;
  f32[12] = root.cosThetaE;
  words[13] = maxDepth >>> 0;
  words[14] = LT_VERSION;
  words[15] = totalWords >>> 0;

  return {
    words,
    emitters: list,
    emitterCount: list.length,
    nodeCount,
    totalPower: root.power,
    maxDepth,
    triCount: packed.triCount,
    layout: {
      headerWords: LT_HEADER_WORDS,
      nodeBase, nodeWords: packed.nodeWords,
      triBase, triWords: packed.triWords,
      attrBase, attrWords: nodeCount * arity * LT_ATTR_WORDS,
      emitterBase, emitterWords: list.length * LT_EMITTER_WORDS,
      totalWords, arity,
    },
  };
}

// ═══════════════════════════════════════════════════════════ CPU: the reading

/**
 * A read-only view over a packed block, at `baseWord` inside any u32 array —
 * the CPU mirror of what the WGSL descent will do with `bits`. Everything the
 * sampler needs is read THROUGH this, so the tests exercise the real layout
 * rather than the builder's intermediate objects.
 */
export function readLightTree(words, baseWord = 0) {
  const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
  const b = baseWord;
  if (words[b + 14] !== LT_VERSION) {
    throw new Error(`lightTree: bad version word ${words[b + 14]} at ${b} (expected ${LT_VERSION})`);
  }
  const arity = words[b + 6];
  const view = {
    words, f32, baseWord: b,
    emitterCount: words[b],
    nodeBase: b + words[b + 1],
    triBase: b + words[b + 2],
    attrBase: b + words[b + 3],
    emitterBase: b + words[b + 4],
    nodeCount: words[b + 5],
    arity,
    totalPower: f32[b + 7],
    rootAxis: [f32[b + 8], f32[b + 9], f32[b + 10]],
    rootCosThetaO: f32[b + 11],
    rootCosThetaE: f32[b + 12],
    maxDepth: words[b + 13],
    totalWords: words[b + 15],
    /** Path from the root to each emitter: [{node, slot}...] + leaf siblings. */
    locate: new Array(words[b]).fill(null),
  };

  view.childRef = (node, slot) => words[view.nodeBase + node * LT_NODE_WORDS + slot];
  view.childBounds = (node, slot, out) => {
    const p = view.nodeBase + node * LT_NODE_WORDS + 4 + slot * 6;
    out[0] = f32[p]; out[1] = f32[p + 1]; out[2] = f32[p + 2];
    out[3] = f32[p + 3]; out[4] = f32[p + 4]; out[5] = f32[p + 5];
    return out;
  };
  view.childAttr = (node, slot, out) => {
    const p = view.attrBase + (node * arity + slot) * LT_ATTR_WORDS;
    out.power = f32[p];
    out.axis[0] = f32[p + 1]; out.axis[1] = f32[p + 2]; out.axis[2] = f32[p + 3];
    out.cosThetaO = f32[p + 4];
    out.cosThetaE = f32[p + 5];
    out.count = words[p + 6];
    return out;
  };
  view.leafEmitterId = (start, j) => words[view.triBase + (start + j) * LT_TRI_WORDS + 9];
  view.emitter = (i) => {
    const p = view.emitterBase + i * LT_EMITTER_WORDS;
    return {
      index: i,
      min: [f32[p], f32[p + 1], f32[p + 2]],
      max: [f32[p + 3], f32[p + 4], f32[p + 5]],
      rgb: [f32[p + 6], f32[p + 7], f32[p + 8]],
      power: f32[p + 9],
      axis: [f32[p + 10], f32[p + 11], f32[p + 12]],
      cosThetaO: f32[p + 13],
      cosThetaE: f32[p + 14],
      area: f32[p + 15],
      centre: [f32[p + 16], f32[p + 17], f32[p + 18]],
      angularRadius: f32[p + 19],
      kind: words[p + 20],
      half: [f32[p + 21], f32[p + 22], f32[p + 23]],
      bx: [f32[p + 24], f32[p + 25], f32[p + 26]],
      by: [f32[p + 27], f32[p + 28], f32[p + 29]],
      meshId: words[p + 30],
      instanceId: words[p + 31],
    };
  };

  // Emitter -> descent path, walked out of the PACKED words. The pdf query
  // needs it (there are no parent pointers in the node format, and adding some
  // would change a layout three other traversals already share).
  const walk = (node, path) => {
    for (let slot = 0; slot < arity; slot++) {
      const ref = view.childRef(node, slot);
      if (ref === 0) continue;
      const next = path.concat([{ node, slot }]);
      if (ref & 0x80000000) {
        const start = ref & 0x00ffffff;
        const count = (ref >>> 24) & 0x7f;
        for (let j = 0; j < count; j++) {
          const id = view.leafEmitterId(start, j);
          view.locate[id] = { path: next, leafStart: start, leafCount: count, leafSlot: j };
        }
      } else {
        walk(ref - 1, next);
      }
    }
  };
  walk(0, []);
  return view;
}

// ═════════════════════════════════════════════════ the importance / pdf model

// PBRT-v4 helpers: cos/sin of (A - B) clamped so that A < B reads as 0 rather
// than wrapping negative.
const cosSubClamped = (sinA, cosA, sinB, cosB) => (cosA > cosB ? 1 : cosA * cosB + sinA * sinB);
const sinSubClamped = (sinA, cosA, sinB, cosB) => (cosA > cosB ? 0 : sinA * cosB - cosA * sinB);

/**
 * Importance of one cluster (bounds + power + cone) at a shading point —
 * PBRT-v4 `LightBounds::Importance`, which is Conty & Kulla's measure.
 *
 * This is a CONSERVATIVE BOUND, not a heuristic: it returns 0 only when the
 * cluster provably emits nothing toward `P`. Every caller depends on that —
 * a cluster that can reach `P` but scores 0 would be sampled with probability
 * 0 and its light silently deleted from an otherwise "unbiased" estimator.
 *
 * @param {number[]} bounds [minx,miny,minz,maxx,maxy,maxz]
 * @param {number[]|null} N receiver normal, or null for a point receiver
 */
export function clusterImportance(bounds, power, axis, cosThetaO, cosThetaE, P, N) {
  if (!(power > 0)) return 0;
  const cx = (bounds[0] + bounds[3]) * 0.5;
  const cy = (bounds[1] + bounds[4]) * 0.5;
  const cz = (bounds[2] + bounds[5]) * 0.5;
  const dx = P[0] - cx, dy = P[1] - cy, dz = P[2] - cz;
  let d2 = dx * dx + dy * dy + dz * dz;
  const diag = Math.sqrt(
    (bounds[3] - bounds[0]) ** 2 + (bounds[4] - bounds[1]) ** 2 + (bounds[5] - bounds[2]) ** 2,
  );
  // PBRT's own near-field clamp (`d2 = max(d2, Length(diagonal)/2)`); kept
  // verbatim, units and all, because it only ever raises d2 — a variance knob,
  // never a zero.
  d2 = Math.max(d2, diag / 2, 1e-12);
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const wi = d > 1e-12 ? [dx / d, dy / d, dz / d] : [0, 1, 0];

  const radius = diag * 0.5;
  let cosThetaU;
  if (d <= radius) cosThetaU = -1; // P inside the cluster: every direction
  else cosThetaU = safeSqrt(1 - (radius / d) ** 2);
  const sinThetaU = safeSqrt(1 - cosThetaU * cosThetaU);

  const cosTheta = clamp(dot3(axis, wi), -1, 1);
  const sinTheta = safeSqrt(1 - cosTheta * cosTheta);
  const sinThetaO = safeSqrt(1 - cosThetaO * cosThetaO);
  const cosThetaX = cosSubClamped(sinTheta, cosTheta, sinThetaO, cosThetaO);
  const sinThetaX = sinSubClamped(sinTheta, cosTheta, sinThetaO, cosThetaO);
  const cosThetaP = cosSubClamped(sinThetaX, cosThetaX, sinThetaU, cosThetaU);
  if (cosThetaP <= cosThetaE) return 0;

  let importance = (power * cosThetaP) / d2;
  if (N) {
    // Receiver cosine, widened by the cluster's subtended angle: zero only
    // when the WHOLE bounding sphere sits at or below the horizon, which is
    // exactly when no part of the emitter can be seen from the surface.
    const cosThetaI = Math.max(0, dot3(wi, N));
    const sinThetaI = safeSqrt(1 - cosThetaI * cosThetaI);
    importance *= cosSubClamped(sinThetaI, cosThetaI, sinThetaU, cosThetaU);
  }
  return importance > 0 ? importance : 0;
}

/** Importance of a single emitter leaf, read from its record. Exported since
 * §12.70 W4b: the tile-cut rig's CPU mirror ranks with exactly this. */
export function emitterImportance(view, id, P, N) {
  const p = view.emitterBase + id * LT_EMITTER_WORDS;
  const f = view.f32;
  const bounds = [f[p], f[p + 1], f[p + 2], f[p + 3], f[p + 4], f[p + 5]];
  return clusterImportance(
    bounds, f[p + 9], [f[p + 10], f[p + 11], f[p + 12]], f[p + 13], f[p + 14], P, N,
  );
}

// ═══════════════════════════════════════════════════════════════ the sampling

export const LT_DEFAULT_OPTIONS = {
  /** Deepest node at which a split may happen. 1 => at most 2 lights (§7). */
  maxSplitDepth: 1,
  /** Split when the node's bounding radius exceeds this fraction of |P - c|. */
  splitRatio: 0.5,
};

const scratchAttr = () => ({ power: 0, axis: [0, 0, 0], cosThetaO: -1, cosThetaE: 0, count: 0 });

/** Union of a node's non-empty child boxes — the node's own extent. */
function nodeBounds(view, node, out) {
  out[0] = out[1] = out[2] = Infinity;
  out[3] = out[4] = out[5] = -Infinity;
  const tmp = [0, 0, 0, 0, 0, 0];
  for (let slot = 0; slot < view.arity; slot++) {
    if (view.childRef(node, slot) === 0) continue;
    view.childBounds(node, slot, tmp);
    for (let k = 0; k < 3; k++) {
      if (tmp[k] < out[k]) out[k] = tmp[k];
      if (tmp[k + 3] > out[k + 3]) out[k + 3] = tmp[k + 3];
    }
  }
  return out;
}

/**
 * Adaptive-splitting predicate. Deterministic in (node, depth, P) ONLY — no
 * sample budget, no traversal state. A budget-gated split would make the
 * decision depend on the order children were visited, and then
 * `lightTreeSelectPdf` could not reproduce the inclusion probability of an
 * arbitrary emitter, which is the one thing the estimator cannot do without.
 */
function shouldSplit(view, node, depth, P, opts) {
  if (depth >= (opts.maxSplitDepth ?? LT_DEFAULT_OPTIONS.maxSplitDepth)) return false;
  const bnd = nodeBounds(view, node, [0, 0, 0, 0, 0, 0]);
  const radius = 0.5 * Math.sqrt((bnd[3] - bnd[0]) ** 2 + (bnd[4] - bnd[1]) ** 2 + (bnd[5] - bnd[2]) ** 2);
  const cx = (bnd[0] + bnd[3]) * 0.5, cy = (bnd[1] + bnd[4]) * 0.5, cz = (bnd[2] + bnd[5]) * 0.5;
  const d = Math.sqrt((P[0] - cx) ** 2 + (P[1] - cy) ** 2 + (P[2] - cz) ** 2);
  return radius > (opts.splitRatio ?? LT_DEFAULT_OPTIONS.splitRatio) * Math.max(d, 1e-6);
}

/**
 * Raw child importances at (P, N), plus the bookkeeping both probability
 * models need: how many slots are live, their importance sum, and which slot
 * is the strongest (ties break on slot index, so the answer is a pure function
 * of the packed words and the shading point).
 */
function childWeights(view, node, P, N) {
  const attr = scratchAttr();
  const bnd = [0, 0, 0, 0, 0, 0];
  const imp = new Array(view.arity).fill(0);
  let sum = 0;
  let live = 0;
  let top = -1;
  let best = -1;
  for (let slot = 0; slot < view.arity; slot++) {
    if (view.childRef(node, slot) === 0) continue;
    live++;
    view.childBounds(node, slot, bnd);
    view.childAttr(node, slot, attr);
    const v = clusterImportance(bnd, attr.power, attr.axis, attr.cosThetaO, attr.cosThetaE, P, N);
    imp[slot] = v;
    sum += v;
    if (v > best) { best = v; top = slot; }
  }
  return { imp, sum, live, top };
}

/**
 * CHOOSE-ONE probabilities: pick a single child, proportional to importance.
 * When every child scores zero (the cluster provably emits nothing here) the
 * choice falls back to UNIFORM — the pdf stays well-defined and strictly
 * positive, and the contribution it weights is zero anyway. A zero pdf on a
 * zero contribution is a 0/0 waiting to become a NaN in a shader.
 */
function chooseProbabilities(view, node, w, out) {
  for (let slot = 0; slot < view.arity; slot++) {
    if (view.childRef(node, slot) === 0) { out[slot] = 0; continue; }
    out[slot] = w.sum > 0 ? w.imp[slot] / w.sum : 1 / w.live;
  }
  return out;
}

/**
 * SPLIT inclusion probabilities: the strongest child is taken with certainty
 * and exactly ONE of the rest is sampled among themselves — so a split node
 * yields exactly two lights, never four. §7 asks for "1-2 lights"; a 4-wide
 * node splitting into all of its children would quadruple the shadow rays the
 * whole design exists to keep at one.
 */
function splitProbabilities(view, node, w, out) {
  const others = w.sum - w.imp[w.top];
  for (let slot = 0; slot < view.arity; slot++) {
    if (view.childRef(node, slot) === 0) { out[slot] = 0; continue; }
    if (slot === w.top) { out[slot] = 1; continue; }
    out[slot] = others > 0 ? w.imp[slot] / others : 1 / (w.live - 1);
  }
  return out;
}

/** Selection probability of each emitter inside one leaf, same fallback rule. */
function leafProbabilities(view, start, count, P, N, out) {
  let sum = 0;
  for (let j = 0; j < count; j++) {
    const imp = emitterImportance(view, view.leafEmitterId(start, j), P, N);
    out[j] = imp;
    sum += imp;
  }
  if (sum > 0) for (let j = 0; j < count; j++) out[j] /= sum;
  else for (let j = 0; j < count; j++) out[j] = 1 / count;
  return out;
}

/**
 * Importance-weighted descent. Returns 1-2 samples as
 * `[{ index, pdf }]` where `pdf` is the MARGINAL INCLUSION probability of that
 * emitter — the number the NEE estimator divides by:
 *
 *     L_direct = sum over samples of  f(emitter) / pdf
 *
 * @param view      readLightTree(...)
 * @param P         shading point [x,y,z]
 * @param N         shading normal [x,y,z] (or null)
 * @param rng       () => [0,1)
 */
export function sampleLightTree(view, P, N, rng, options = {}) {
  const opts = { ...LT_DEFAULT_OPTIONS, ...options };
  const out = [];
  const descend = (node, depth, prob) => {
    const take = (slot, slotProb) => {
      const ref = view.childRef(node, slot);
      if (ref === 0 || !(slotProb > 0)) return;
      if (ref & 0x80000000) {
        const start = ref & 0x00ffffff;
        const count = (ref >>> 24) & 0x7f;
        const lp = leafProbabilities(view, start, count, P, N, new Array(count));
        let u = rng();
        let j = 0;
        for (; j < count - 1; j++) {
          if (u < lp[j]) break;
          u -= lp[j];
        }
        const pdf = slotProb * lp[j];
        if (pdf > 0) out.push({ index: view.leafEmitterId(start, j), pdf });
        return;
      }
      descend(ref - 1, depth + 1, slotProb);
    };
    const pick = (p, skip) => {
      let total = 0;
      for (let slot = 0; slot < view.arity; slot++) if (slot !== skip) total += p[slot];
      if (!(total > 0)) return -1;
      let u = rng() * total;
      let chosen = -1;
      for (let slot = 0; slot < view.arity; slot++) {
        if (slot === skip || p[slot] <= 0) continue;
        chosen = slot;
        if (u < p[slot]) break;
        u -= p[slot];
      }
      return chosen;
    };

    const w = childWeights(view, node, P, N);
    if (w.live < 1) return;
    const p = new Array(view.arity).fill(0);
    if (w.live >= 2 && shouldSplit(view, node, depth, P, opts)) {
      splitProbabilities(view, node, w, p);
      take(w.top, prob); // certainty — the split branch
      const other = pick(p, w.top);
      if (other >= 0) take(other, prob * p[other]);
      return;
    }
    chooseProbabilities(view, node, w, p);
    const chosen = pick(p, -1);
    if (chosen < 0) return;
    take(chosen, prob * p[chosen]);
  };
  descend(0, 0, 1);
  return out;
}

/**
 * The MARGINAL INCLUSION PROBABILITY of `index` at (P, N) — recomputed from
 * the packed words, independently of any sample. This is what MIS weights need
 * and what makes "is the estimator unbiased" a testable question rather than a
 * claim: an estimator whose returned pdf disagrees with this walk is wrong on
 * one side or the other.
 */
export function lightTreeSelectPdf(view, P, N, index, options = {}) {
  const opts = { ...LT_DEFAULT_OPTIONS, ...options };
  const loc = view.locate[index];
  if (!loc) return 0;
  let pdf = 1;
  const probs = new Array(view.arity).fill(0);
  for (let d = 0; d < loc.path.length; d++) {
    const { node, slot } = loc.path[d];
    const w = childWeights(view, node, P, N);
    if (w.live >= 2 && shouldSplit(view, node, d, P, opts)) {
      // The strongest child is taken with certainty; the others share one
      // stochastic pick among themselves. Mirrors sampleLightTree exactly —
      // the two must not be able to drift, which is why both go through
      // childWeights/splitProbabilities rather than re-deriving the rule.
      if (slot === w.top) continue;
      splitProbabilities(view, node, w, probs);
      pdf *= probs[slot];
    } else {
      chooseProbabilities(view, node, w, probs);
      pdf *= probs[slot];
    }
    if (pdf <= 0) return 0;
  }
  const lp = leafProbabilities(view, loc.leafStart, loc.leafCount, P, N, new Array(loc.leafCount));
  return pdf * lp[loc.leafSlot];
}

// ═══════════════════════════════════════════════════════ the estimated integral

/**
 * Horizon-aware sphere-light factor — the CPU mirror of
 * `giLight.sphereLightFactor`, term for term. Equals cosTheta while the sphere
 * is fully above the receiver's horizon, and Hermite-fades through the partial
 * band instead of dying with cosTheta (a lamp RESTING on the floor lights it).
 */
export function sphereLightFactorCpu(cosTheta, sinR) {
  const t = clamp((cosTheta + sinR) / Math.max(sinR * 2, 1e-4), 0, 1);
  const horizon = sinR * t * t;
  return cosTheta >= sinR ? cosTheta : horizon;
}

/**
 * Exact Lambert form factor of an oriented box — the CPU mirror of
 * `giLight.boxLightFactor` (Baum et al. contour integral, per receiver-facing
 * face, each face clamped at 0). Same winding, same epsilons.
 */
export function boxLightFactorCpu(P, N, centre, half, bx, by, bz) {
  let F = 0;
  const neg = (v) => [-v[0], -v[1], -v[2]];
  const mul = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
  const faces = [
    [bx, half[0], mul(by, half[1]), mul(bz, half[2])],
    [neg(bx), half[0], mul(bz, half[2]), mul(by, half[1])],
    [by, half[1], mul(bz, half[2]), mul(bx, half[0])],
    [neg(by), half[1], mul(bx, half[0]), mul(bz, half[2])],
    [bz, half[2], mul(bx, half[0]), mul(by, half[1])],
    [neg(bz), half[2], mul(by, half[1]), mul(bx, half[0])],
  ];
  for (const [w, hw, eu, ev] of faces) {
    const fc = [centre[0] + w[0] * hw, centre[1] + w[1] * hw, centre[2] + w[2] * hw];
    const toP = [P[0] - fc[0], P[1] - fc[1], P[2] - fc[2]];
    if (dot3(toP, w) <= 1e-4) continue;
    const corner = (su, sv) => norm3([
      fc[0] + eu[0] * su + ev[0] * sv - P[0],
      fc[1] + eu[1] * su + ev[1] * sv - P[1],
      fc[2] + eu[2] * su + ev[2] * sv - P[2],
    ]);
    const u0 = corner(1, 1), u1 = corner(1, -1), u2 = corner(-1, -1), u3 = corner(-1, 1);
    const edge = (a, b) => {
      const c = cross3(a, b);
      const l = Math.max(len3(c), 1e-6);
      return Math.acos(clamp(dot3(a, b), -1, 1)) * ((c[0] * N[0] + c[1] * N[1] + c[2] * N[2]) / l);
    };
    const faceSum = (edge(u0, u1) + edge(u1, u2) + edge(u2, u3) + edge(u3, u0)) * 0.5;
    if (faceSum > 0) F += faceSum;
  }
  return F;
}

/**
 * Unoccluded RGB irradiance one emitter puts on (P, N) — the term an NEE
 * estimator multiplies by visibility. Shape model and both factors are the
 * ones `giLight.emitterSlotFactor` already uses for promoted slots, so a
 * tree-sampled emitter and a (today) promoted one deliver the same number.
 *
 * The emission-cone gate is what keeps the estimator unbiased: it is a SUBSET
 * of `clusterImportance`'s acceptance region (which additionally widens by the
 * subtended angle theta_u), so `contribution > 0` implies `importance > 0` at
 * every ancestor. Reverse those and lights vanish where the cone is tight.
 */
export function emitterIrradiance(view, index, P, N) {
  const e = view.emitter(index);
  const d = [P[0] - e.centre[0], P[1] - e.centre[1], P[2] - e.centre[2]];
  const dist = len3(d);
  if (!(dist > 1e-9)) return [0, 0, 0];
  const wi = [d[0] / dist, d[1] / dist, d[2] / dist];
  // Emission cone: is P within (theta_o + theta_e) of the mean normal?
  const theta = angleBetween(e.axis, wi);
  const thetaO = Math.acos(clamp(e.cosThetaO, -1, 1));
  if (Math.cos(Math.max(theta - thetaO, 0)) <= e.cosThetaE) return [0, 0, 0];

  let factor;
  if (e.kind === LT_KIND.box) {
    const bz = cross3(e.bx, e.by);
    factor = boxLightFactorCpu(P, N, e.centre, e.half, e.bx, e.by, bz);
  } else {
    const sinR = clamp(e.angularRadius / Math.max(dist, 1e-6), 0, 1);
    // `wi` points emitter -> P (the importance convention); the receiver's
    // cosine is against the direction P -> emitter.
    const cosT = clamp(-dot3(wi, N), -1, 1);
    factor = Math.PI * sinR * sinR * sphereLightFactorCpu(cosT, sinR);
  }
  if (!(factor > 0)) return [0, 0, 0];
  return [e.rgb[0] * factor, e.rgb[1] * factor, e.rgb[2] * factor];
}

/** Brute-force sum over EVERY emitter — the reference the estimator must hit. */
export function lightTreeReference(view, P, N) {
  const out = [0, 0, 0];
  for (let i = 0; i < view.emitterCount; i++) {
    const f = emitterIrradiance(view, i, P, N);
    out[0] += f[0]; out[1] += f[1]; out[2] += f[2];
  }
  return out;
}

/**
 * One NEE estimate at (P, N): sample 1-2 lights, weight each by 1/pdf.
 * Unbiased — E[estimate] = lightTreeReference(view, P, N) — which is exactly
 * what `scripts/run-gi-light-tree-test.mjs` measures.
 */
export function estimateLightTree(view, P, N, rng, options = {}) {
  const samples = sampleLightTree(view, P, N, rng, options);
  const out = [0, 0, 0];
  for (const s of samples) {
    if (!(s.pdf > 0)) continue;
    const f = emitterIrradiance(view, s.index, P, N);
    out[0] += f[0] / s.pdf;
    out[1] += f[1] / s.pdf;
    out[2] += f[2] / s.pdf;
  }
  return out;
}
