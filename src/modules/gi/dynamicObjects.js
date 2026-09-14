// EXACT DYNAMIC OBJECTS — analytic OBB + object-local BVH4 intersections for
// movers, replacing per-frame world-space voxel rebuilds.
// Implements docs/dynamic_gi_exact_dynamic_objects.md (phase 1 + the rigid-mesh
// acceleration, per the user's BVH4 directive).
//
// ══ WHY ═════════════════════════════════════════════════════════════════════
//
// A rotating rigid object re-voxelized every frame changes its voxel MEMBERSHIP
// discontinuously: cells enter/leave the occupied set in whole-voxel quanta, so
// the direct silhouette pops in chunks and the field's injected cells appear in
// one place while vanishing from another (sessions 31/31d measured both — the
// CELLBURST 0→5.81-lum single-frame pop and the BURST membership-frame spikes).
// Coverage weighting, records, and band-limits all soften the SAMPLING of that
// churn; none remove its SOURCE. This module removes the source: an adopted
// mover contributes NO bits, NO records, NO membership — every GI ray
// intersects its exact analytic surface instead, which rotates continuously.
//
// ══ REPRESENTATION ══════════════════════════════════════════════════════════
//
//   Box / Plane geometry          → analytic OBB (slab test, local space)
//   Sphere geometry               → analytic sphere (ellipsoid under scale)
//   Capsule geometry              → analytic capsule
//   Cylinder / Cone geometry      → analytic conical frustum + caps
//   (partial sweeps / open-ended  → BVH — they are not the analytic solid)
//   every OTHER rigid geometry    → object-local wide BVH, exact triangle
//     (custom + torus/knot/…)       leaves (three-mesh-bvh collapsed,
//                                   traversed in raw WGSL, compressed 8-wide)
//   skinned / morphing            → not adopted (stay on the voxel path)
//   mesh.userData.giTrace         → override: "voxel" | "bvh" | "obb"
//   mesh.userData.giMobility      → "static" (never adopt) | "dynamic" (pin)
//
// Rays transform into object space with the UN-normalized inverse-transformed
// direction, so the ray parameter t is preserved 1:1 with world t (the doc's
// hard rule — normalizing would rescale every comparison against the DDA).
//
// ══ ZERO NEW BINDINGS ═══════════════════════════════════════════════════════
//
// The composed cascade/shadow kernels sit AT the portable 8-storage-buffer
// stage limit, and the resolve/composite sit at the 12-uniform-buffer wall.
// So NOTHING here binds anything new in those kernels: the per-object header
// (inverse world matrix, half extents, type, swept bounds) AND the BVH4
// node/triangle pool live in a reserved tail region of the occupancy `bits`
// buffer, which every consumer already binds. Data flows in through two tiny
// dedicated kernels that sit far below every wall:
//   · a persistent header-sync compute (uniformArray → bits words, ~1k threads)
//   · a one-shot staging copy per adopted GEOMETRY (BVH words → bits region)
// Until those kernels land (async pipeline compile), the header's count word
// reads 0 and every trace is a no-op — safe by construction, no ordering hazard.
//
// ══ WORD LAYOUT (relative to `baseWord` = occupancyField.dynamicObjectWordOffset) ══
//
//   0            objectCount (f32 value, bitcast-stored like every word here)
//   1..15        reserved
//   16..31       static-BVH slot-disable mask (raw u32 — STATIC_MASK_WORD_BASE)
//   32..47       reserved
//   DYN_HEADER_RESERVED + i*OBJ_WORDS   per-object block, OBJ_WORDS = 40.
//   DYN_HEADER_RESERVED IS 48, not the 16 an earlier version of this block
//   claimed — derive every offset from the exported constants, never from a
//   number written here:
//     +0..15     inverse OBB world matrix, column-major (obbWorld⁻¹ where
//                obbWorld = mesh.matrixWorld × translate(localBoxCenter))
//     +16..18    local half extents
//     +19        type: 0 inactive · 1 OBB · 2 BVH mesh · 3 sphere ·
//                4 capsule · 5 conical frustum (DYN_TYPE)
//     +20        BVH node base (word offset relative to baseWord)
//     +21        BVH triangle base (relative)
//     +22        max world scale factor (local→world distance approximation)
//     +23        SURFACE-CACHE CARD TABLE base (word offset relative to
//                baseWord, exactly like +20/+21) — 0 = no cards, take the
//                mean-albedo fallback in +34..39. Written by setCardTable from
//                surfaceCache.js's `cardTableRel`; read by cardFrameAt. This
//                word was "reserved" until 2026-08-07; the surface radiance
//                cache is its ONE claimant (docs/GI_NEXT_ARCHITECTURE.md §6.3).
//     +24..26    swept-bounds world min (prev ∪ curr, pre-expanded)
//     +27        swept retain factor: 0 = inactive · else the EMA retain
//                scale for cells inside (translation-scaled — ~1 rotating
//                in place, 0.35 translating fast)
//     +28..30    swept-bounds world max
//     +31..33    shape params: sphere [r,-,-] · capsule [r, halfSeg,-] ·
//                frustum [rBottom, rTop, halfHeight]
//     +34..36    MEAN ALBEDO (rgb) — the colour a cascade ray shades an exact
//                dynamic hit with. An adopted mover has left the voxel field
//                (its occupancy slot is parked and its atlas slot cleared), so
//                the trilinear radiance sample at its hit point reads the
//                SURROUNDING room and the mover contributes none of its own
//                colour. Measured 2026-08-07 on the mover-bounce rig: a red box
//                on the voxel path put 16.1% red excess on the floor beside it;
//                the same box adopted put 0.0% — the red/white frames were
//                pixel-identical. Mean per OBJECT, not per texel: per-texel
//                would need textures bound in the compute pass, and the gap
//                being closed here is wrong-vs-right, not right-vs-detailed.
//     +37..39    MEAN EMISSIVE (rgb), premultiplied by emissiveIntensity
//   HEADER_WORDS = dynHeaderWords(maxObjects) = DYN_HEADER_RESERVED +
//   maxObjects*OBJ_WORDS, then the pool (BVH blocks + surface-cache card
//   tables, one bump allocator — allocPoolWords).
//
// BVH4 node = 28 words: [ref0..ref3, then 4× (min.xyz,max.xyz) f32].
// BVH8 node = 28 words (the COMPRESSED format, default): [origin.xyz f32,
//   packed exponents (3×i8), 8 child refs, then 8× quantized bounds —
//   per child 2 words of u8×6 (qmin.xyz, qmax.xyz) against origin + 2^exp].
//   Quantization is CONSERVATIVE both ways (floor mins, ceil maxs, decode
//   expands by nothing further) so a compressed AABB can only be LARGER than
//   the true child bounds — a false-positive slab hit costs a descend, never
//   a miss. 28 words per 8 children vs 28 per 4 = 2× node compression.
// Child ref encoding (both formats): 0 = empty slot · bit31 set = leaf
// (bits 0..23 triangle start index, bits 24..30 count) · else internal node
// index + 1 (so 0 stays unambiguous — node 0 is the root, never a child).
// Triangle = 9 f32 words (v0,v1,v2 local space), flat, no index indirection.
// ONE traversal arity compiles per build (`__giDynBvhArity` — 8 default,
// 4 = the uncompressed A/B arm): both functions in every trace kernel would
// double the added WGSL, and kernel size is a first-class boot cost.
import * as THREE from "three/webgpu";
import { MeshBVH, SAH, AVERAGE, CENTER } from "three-mesh-bvh";

/** Split-strategy names for the static-scene build (`__giStaticBvhStrategy`). */
export const BVH_STRATEGY = { sah: SAH, average: AVERAGE, center: CENTER };
import {
  Fn, If, Loop, float, floatBitsToUint, instanceIndex, instancedArray, int,
  select, uint, uintBitsToFloat, uniform, uniformArray, vec2, vec3, vec4, wgslFn,
} from "three/tsl";
import { createGpuGridBvh } from "./gpuGridBvh.js";
import { sharedFn } from "./giFn.js";
import { resolveMaterialSurface } from "./voxelizeOnce.js";
import { octDecodeTSL, octEncodeTSL } from "./rayHit/rayHitTSL.js";
import {
  STATIC_BVH_FORMAT_PLACEMENT,
  STATIC_BVH_FORMAT_WORLD,
  normalizeStaticBvhFormat,
} from "./staticBvhFormats.js";

export const OBJ_WORDS = 40;
// Header words 0..15: count + reserved. Words 16..31: the STATIC-BVH
// slot-disable mask (512 slots, raw u32 — adopted movers' static triangles
// are masked out of the shadow BVH live). 32..47: reserved. Object blocks
// follow.
export const DYN_HEADER_RESERVED = 48;
export const STATIC_MASK_WORD_BASE = 16;
export const STATIC_MASK_WORDS = 16;
const DEFAULT_MAX_OBJECTS = 16;

// ── §11.57 MOVER CLUSTERS (2026-09-11) ───────────────────────────────────────
// After the object blocks: a two-level acceleration over the movers. Every
// trace used to visit EVERY adopted mover per ray — load its 4×4, transform
// the ray, slab-test, self-exclusion — 34 times per ray on Sponza (10 cloth
// grids + a character's bone capsules), ~2.8 ms of the build's frame. The CPU
// now buckets the active movers into ≤ DYN_CLUSTER_MAX spatial groups each
// frame (a 2×2×2 split of their union by centre), writes each group's union
// box and member list here, and the kernel slab-tests the group boxes first,
// descending only into the groups the ray segment crosses. The per-object
// code is untouched — it is the same closure, called per member.
//   +0            cluster count (f32)
//   +1 .. +64     DYN_CLUSTER_MAX × [min.xyz, max.xyz, first, count] (f32)
//   +65 ..        member slot indices (f32), maxObjects of them
export const DYN_CLUSTER_MAX = 8;
export const DYN_CLUSTER_STRIDE = 8;
export function dynClusterWords(maxObjects = DEFAULT_MAX_OBJECTS) {
  return 1 + DYN_CLUSTER_MAX * DYN_CLUSTER_STRIDE + maxObjects;
}

/** Header words for a given object capacity. */
export function dynHeaderWords(maxObjects = DEFAULT_MAX_OBJECTS) {
  return DYN_HEADER_RESERVED + maxObjects * OBJ_WORDS + dynClusterWords(maxObjects);
}

/**
 * Bucket mover boxes into at most `maxClusters` groups: a 2×2×2 split of the
 * union of all boxes at its centre, each item placed by ITS centre, each
 * group's box the union of its members (so a curtain straddling the split
 * is fully covered by its own group). Pure, so `tests/gi-mover-clusters`
 * can pin it. An item with an invalid box (NaN, inverted) gets an unbounded
 * one — never culled, only ever conservative. Members are sorted by slot so
 * the table is byte-stable for an unchanged scene.
 * @param {Array<{slot:number, mn:number[], mx:number[]}>} items
 */
export function clusterMoverBoxes(items, maxClusters = DYN_CLUSTER_MAX) {
  const BIG = 1e30;
  const valid = (b) => Number.isFinite(b.mn[0]) && Number.isFinite(b.mn[1]) && Number.isFinite(b.mn[2])
    && Number.isFinite(b.mx[0]) && Number.isFinite(b.mx[1]) && Number.isFinite(b.mx[2])
    && b.mn[0] <= b.mx[0] && b.mn[1] <= b.mx[1] && b.mn[2] <= b.mx[2];
  const boxes = items.map((it) => (valid(it) ? it : { slot: it.slot, mn: [-BIG, -BIG, -BIG], mx: [BIG, BIG, BIG] }));
  if (!boxes.length) return { clusters: [], members: [] };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let a = 0; a < 3; a++) {
      const c = (b.mn[a] + b.mx[a]) * 0.5;
      if (Number.isFinite(c)) { lo[a] = Math.min(lo[a], c); hi[a] = Math.max(hi[a], c); }
    }
  }
  const mid = lo.map((v, a) => (Number.isFinite(v) && Number.isFinite(hi[a]) ? (v + hi[a]) * 0.5 : 0));
  const buckets = new Map();
  for (const b of boxes) {
    let cell = 0;
    for (let a = 0; a < 3; a++) {
      const c = (b.mn[a] + b.mx[a]) * 0.5;
      if (Number.isFinite(c) && c >= mid[a]) cell |= 1 << a;
    }
    cell %= Math.max(1, maxClusters);
    let bucket = buckets.get(cell);
    if (!bucket) buckets.set(cell, (bucket = { mn: [BIG, BIG, BIG], mx: [-BIG, -BIG, -BIG], slots: [] }));
    for (let a = 0; a < 3; a++) {
      bucket.mn[a] = Math.min(bucket.mn[a], b.mn[a]);
      bucket.mx[a] = Math.max(bucket.mx[a], b.mx[a]);
    }
    bucket.slots.push(b.slot);
  }
  const clusters = [];
  const members = [];
  for (const cell of [...buckets.keys()].sort((a, b) => a - b)) {
    const bucket = buckets.get(cell);
    bucket.slots.sort((a, b) => a - b);
    clusters.push({ mn: bucket.mn, mx: bucket.mx, first: members.length, count: bucket.slots.length });
    members.push(...bucket.slots);
  }
  return { clusters, members };
}

// ═══════════════════════════════════════════════════════ CPU: classification
/** Shape type codes as stored in the header's type word. */
export const DYN_TYPE = { obb: 1, mesh: 2, sphere: 3, capsule: 4, frustum: 5 };

const TWO_PI = Math.PI * 2;
const fullSweep = (v, target) => Math.abs((v ?? target) - target) < 1e-3;

// ═══════════════════════════════ TWO INDEPENDENT AXES (user directive, 33)
// MOBILITY ("does this move?") and TRACE ("what surface do rays intersect?")
// are orthogonal, and conflating them into one `giDynamic` list was a real
// trap: the only values that promised exact triangles ("bvh") or a box
// ("obb") ALSO pinned the object as a mover. A user who wants exact shadows
// on static architecture — the whole point of the static shadow BVH — had no
// way to say so, and picking a trace value dragged 30 Sponza meshes into the
// per-ray mover loop (measured: 16 adopted at the cap, and every shadow ray
// then walks 16 object BVHs instead of one shared world BVH).
//
// Static geometry already gets EXACT TRIANGLE shadows for free from the
// world-space static BVH. Mobility "dynamic" buys nothing there and costs a
// lot; it is for objects that actually move.
const LEGACY_GI_DYNAMIC = {
  static: { mobility: "static", trace: "auto" },
  voxel: { mobility: "auto", trace: "voxel" },
  none: { mobility: "auto", trace: "voxel" },
  dynamic: { mobility: "dynamic", trace: "auto" },
  bvh: { mobility: "dynamic", trace: "bvh" },
  obb: { mobility: "dynamic", trace: "obb" },
};

/** Reads a mesh's GI mobility: "auto" | "static" | "dynamic". */
export function giMobilityOf(mesh) {
  const m = mesh?.userData?.giMobility;
  if (m === "static" || m === "dynamic" || m === "auto") return m;
  const legacy = LEGACY_GI_DYNAMIC[mesh?.userData?.giDynamic];
  return legacy?.mobility ?? "auto";
}

/**
 * Reads a mesh's GI trace representation:
 * "auto" | "voxel" | "bvh" | "obb" | "none".
 *
 * "none" (2026-09-13, foliage GI policy) is stronger than "voxel": "voxel"
 * still seats the mesh into the occupancy field/atlas as a voxelized
 * occluder+bounce source; "none" means the mesh contributes NOTHING to the
 * field at all — no atlas slot, no static-BVH triangles, no SDF bake, not
 * counted in any tier tally (see GISystem.js `#placementsOf`, which returns
 * no placements for it). The surface still RECEIVES GI: that is a per-pixel
 * field lookup in its material shader and does not depend on being seated
 * here. Meant for grass/ground-cover rings and impostor tiers, where seating
 * every blade/billboard instance would blow the instance and SDF-bake budget
 * for no visible occlusion gain.
 */
export function giTraceOf(mesh) {
  const t = mesh?.userData?.giTrace;
  if (t === "voxel" || t === "bvh" || t === "obb" || t === "auto" || t === "none") return t;
  const legacy = LEGACY_GI_DYNAMIC[mesh?.userData?.giDynamic];
  return legacy?.trace ?? "auto";
}

/**
 * Pure seating decision for one mesh, shared by `GISystem.js#placementsOf`
 * (the ONLY place that decides which instances get an atlas slot / SDF bake /
 * static-BVH triangle) and this module's own tests — a private class method
 * cannot be unit-tested directly, so the actual policy lives here instead of
 * being reimplemented for a test double.
 *
 *   - `giTraceOf(mesh) === "none"`: 0 seats (foliage rings/impostor tiers —
 *     no atlas slot, no bake, no static-BVH triangle, not counted anywhere).
 *   - a plain (non-instanced) mesh: 1 seat, unaffected by `giInstanceCap`
 *     (the cap narrows an InstancedMesh's per-mesh budget; a single mesh has
 *     no per-instance budget to narrow).
 *   - an InstancedMesh: `min(mesh.count, cap)`, where `cap` is
 *     `userData.giInstanceCap` when set (NEVER widening past `hardCap` — a
 *     tag asking for more than the hard ceiling is clamped, not honoured),
 *     else `hardCap` (`MAX_INSTANCES_PER_MESH` in GISystem.js).
 *
 * Returns `{ seats, cap, isInstanced }`: `cap` is the effective per-mesh
 * ceiling (for the "N occupy slots" warning), `seats` is how many of
 * `mesh.count` actually claim one.
 */
export function giSeatPlanOf(mesh, hardCap) {
  if (giTraceOf(mesh) === "none") return { seats: 0, cap: 0, isInstanced: !!mesh?.isInstancedMesh };
  if (!mesh?.isInstancedMesh) return { seats: 1, cap: 1, isInstanced: false };
  const tagged = Number(mesh.userData?.giInstanceCap);
  const cap = tagged > 0 ? Math.min(hardCap, tagged) : hardCap;
  const seats = Math.max(0, Math.min(mesh.count ?? 0, cap));
  return { seats, cap, isInstanced: true };
}

/**
 * Decides how a mesh would be represented if adopted as a dynamic object.
 * Returns { type, center, halfExtents, params } or null (not adoptable —
 * deforming meshes stay on the voxel path, which remains correct for them,
 * just softer).
 *
 * THE RULES (user directive, 2026-08-06):
 *   · every three.js DEFAULT geometry with a closed-form intersection gets
 *     the exact ANALYTIC shape: Box/Plane → OBB, Sphere → sphere (ellipsoid
 *     under non-uniform scale — the inverse matrix carries it), Capsule →
 *     capsule, Cylinder/Cone → conical frustum with caps. Partial sweeps and
 *     open-ended primitives are NOT the analytic solid and take the BVH.
 *   · every OTHER geometry — custom, and defaults with no closed form
 *     (torus, torus-knot, polyhedra, lathe, extrude…) — gets the exact
 *     triangle BVH. Their triangles ARE the rendered border.
 *   · `mesh.userData.giTrace` overrides the representation: "voxel" (never go
 *     exact — keep the voxel path), "bvh" (force triangles), "obb" (force the
 *     bounding box). MOBILITY is not decided here — see giMobilityOf; a
 *     "static" mesh is simply never offered to this function.
 */
export function classifyDynamicShape(mesh) {
  if (!mesh?.geometry) return null;
  const tag = giTraceOf(mesh);
  if (tag === "voxel") return null;
  if (mesh.isSkinnedMesh) return null;
  const geometry = mesh.geometry;
  if (geometry.morphAttributes?.position?.length) return null;
  const pos = geometry.attributes?.position;
  if (!pos || pos.count < 3) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const halfExtents = new THREE.Vector3().subVectors(bb.max, bb.min).multiplyScalar(0.5);
  const center = new THREE.Vector3().addVectors(bb.max, bb.min).multiplyScalar(0.5);
  const asMesh = () => {
    const triCount = geometry.index ? geometry.index.count / 3 : pos.count / 3;
    const maxTris = Number(globalThis.__giDynMeshMaxTris) || 120000;
    if (triCount < 1 || triCount > maxTris) return null;
    return { type: "mesh", center, halfExtents };
  };
  if (tag === "bvh") return asMesh();
  if (tag === "obb") return { type: "obb", center, halfExtents };

  // ── AN ASSET CAN DECLARE ITS OWN CLOSED FORM ────────────────────────────
  //
  // Everything below switches on `geometry.type`, which only a three.js
  // primitive carries — a `.geom` asset loads as a bare BufferGeometry, so a
  // 350-ball pool authored against a SHARED sphere asset (the only way
  // engine/batching.js will instance it, see MeshComponent's per-entity
  // `geometryFactories`) classified as 350 BVH-mesh movers at ~320 triangles
  // each. That is unaffordable per ray, and it is also wrong: the thing IS a
  // sphere, and a sphere costs ~10 ALU exactly.
  //
  // `geometryAsset.js` has always carried `meta.giRayProxy` onto
  // `geometry.userData` and NOTHING has ever read it. This is that reader:
  // a `.geom.meta` of `{ "giRayProxy": { "type": "sphere", "radius": 0.5 } }`
  // says "trace me as this closed form", in the geometry's own local units.
  const proxy = geometry.userData?.giRayProxy;
  if (proxy?.type === "sphere" && Number.isFinite(proxy.radius)) {
    return { type: "sphere", center, halfExtents, params: [proxy.radius, 0, 0] };
  }
  if (proxy?.type === "capsule" && Number.isFinite(proxy.radius)) {
    return { type: "capsule", center, halfExtents, params: [proxy.radius, (proxy.height ?? 0) / 2, 0] };
  }
  if (proxy?.type === "obb") return { type: "obb", center, halfExtents };

  const p = geometry.parameters;
  switch (geometry.type) {
    case "BoxGeometry":
    case "PlaneGeometry": // a zero-thickness OBB IS the exact rectangle
      return { type: "obb", center, halfExtents };
    case "SphereGeometry":
      if (p && fullSweep(p.phiLength, TWO_PI) && fullSweep(p.thetaLength, Math.PI)) {
        return { type: "sphere", center, halfExtents, params: [p.radius ?? 1, 0, 0] };
      }
      break;
    case "CapsuleGeometry":
      if (p) {
        // r185 names the mid-section length `height` (older three: `length`).
        return { type: "capsule", center, halfExtents, params: [p.radius ?? 1, (p.height ?? p.length ?? 1) / 2, 0] };
      }
      break;
    case "CylinderGeometry":
      if (p && fullSweep(p.thetaLength, TWO_PI) && !p.openEnded) {
        return { type: "frustum", center, halfExtents, params: [p.radiusBottom ?? 1, p.radiusTop ?? 1, (p.height ?? 1) / 2] };
      }
      break;
    case "ConeGeometry":
      if (p && fullSweep(p.thetaLength, TWO_PI) && !p.openEnded) {
        return { type: "frustum", center, halfExtents, params: [p.radius ?? 1, 0, (p.height ?? 1) / 2] };
      }
      break;
    default:
      break;
  }

  // Anonymized-box fallback (imported/parameter-stripped boxes): a geometry
  // whose every vertex sits on a CORNER of its local bounding box is exactly
  // its OBB. Degenerate-flat only via the typed Plane path above — an unknown
  // flat mesh takes the BVH (its triangles are still exact).
  const minExtent = Math.min(halfExtents.x, halfExtents.y, halfExtents.z);
  if (pos.count <= 40 && minExtent > 1e-4) {
    let corners = true;
    for (let i = 0; i < pos.count && corners; i++) {
      for (let a = 0; a < 3; a++) {
        const v = pos.getComponent(i, a);
        const mn = bb.min.getComponent(a);
        const mx = bb.max.getComponent(a);
        const eps = (mx - mn) * 1e-3 + 1e-6;
        if (Math.abs(v - mn) > eps && Math.abs(v - mx) > eps) { corners = false; break; }
      }
    }
    if (corners) return { type: "obb", center, halfExtents };
  }

  return asMesh();
}

// ═══════════════════════════════════════════════════════ CPU: BVH4 packing
/**
 * f32 -> IEEE half, the standard bit-twiddle (no `Float16Array` dependency —
 * it is too new to assume in every runtime this build has to load in, and a
 * silent `undefined` here would write zeroed UVs, i.e. every reflected surface
 * showing one corner texel of its texture).
 *
 * Half is chosen over f32 for the static BVH's UV region because that region
 * is sized against a scene whose triangle soup already costs >100 MB on the
 * user's Bistro: 3 words per triangle instead of 6. The precision that buys is
 * ~2^-11 RELATIVE, so a UV inside [0,1] resolves to well under a texel of a
 * 256-px atlas tile, and a heavily TILED UV (0..20) lands within ~2 px — the
 * error is in a reflection, of a texture, at half resolution.
 */
const HALF_F32 = new Float32Array(1);
const HALF_U32 = new Uint32Array(HALF_F32.buffer);
function toHalfBits(value) {
  HALF_F32[0] = value;
  const x = HALF_U32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = (x >>> 12) & 0x07ff;
  if (exp === 0xff) return sign | 0x7c00 | (x & 0x007fffff ? 0x0200 : 0);
  if (exp > 142) return sign | 0x7bff;          // overflow -> largest finite
  if (exp < 103) return sign;                   // underflow -> signed zero
  if (exp < 113) {                              // subnormal half
    mant |= 0x0800;
    return sign | ((mant >>> (114 - exp)) + ((mant >>> (113 - exp)) & 1));
  }
  return (sign | ((exp - 112) << 10) | (mant >>> 1)) + (mant & 1);
}

/** Two floats into one u32 the way WGSL's `unpack2x16float` reads it back. */
function packHalf2(u, v) {
  return ((toHalfBits(v) << 16) | toHalfBits(u)) >>> 0;
}

/** Uncompressed 4-wide build (the `__giDynBvhArity=4` A/B arm). */
export function buildBvh4Words(geometry) {
  return buildBvhWords(geometry, 4);
}

/** Compressed 8-wide build — the default mesh acceleration. */
export function buildBvh8Words(geometry) {
  return buildBvhWords(geometry, 8);
}

/**
 * Builds an object-local wide BVH with exact triangle leaves for `geometry`
 * and packs it into the u32 word layout the WGSL traversal reads. Built ONCE
 * per unique geometry (rigid objects only ever update their transform — the
 * doc's rule). The binary three-mesh-bvh tree is collapsed `log2(arity)`
 * levels, which preserves its SAH quality while dividing the traversal's pop
 * count; arity 8 additionally quantizes child bounds (see the header note).
 */
export function buildBvhWords(geometry, arity = 8, triSlotOf = null, strategy = null, triUvOf = null) {
  const srcPos = geometry.attributes.position;
  const positions = srcPos.array.slice(0, srcPos.count * 3);
  let index;
  if (geometry.index) {
    index = geometry.index.array.slice();
  } else {
    index = srcPos.count > 65535 ? new Uint32Array(srcPos.count) : new Uint16Array(srcPos.count);
    for (let i = 0; i < srcPos.count; i++) index[i] = i;
  }
  // `triSlotOf(originalTriIndex)` turns on SLOT-TAGGED triangles (stride 10:
  // 9 vertex floats + an occupancy-slot id word) — the static-scene BVH's
  // format, where a per-slot mask lets adopted movers leave the shadow set
  // without a rebuild. Only valid for SEQUENTIALLY-INDEXED soups (the
  // original triangle id is recovered as idx[3t]/3).
  const TRI_WORDS = triSlotOf ? 10 : 9;
  // Fresh geometry: MeshBVH reorders the index in place, and the render
  // geometry must never be mutated by a GI acceleration build.
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(index, 1));
  const bvh = new MeshBVH(geom, {
    // `maxLeafTris` until three-mesh-bvh renamed it; the old spelling still
    // works but logs a deprecation warning on EVERY scene load, which is the
    // kind of console noise that trains people to ignore the console.
    targetLeafSize: 8,
    indirect: false,
    ...(strategy != null ? { strategy } : null),
  });
  if (bvh._roots.length !== 1) {
    // Multi-group geometry builds multiple roots; out of scope — caller keeps
    // the voxel path for this mesh.
    geom.dispose();
    return null;
  }
  const root = bvh._roots[0];
  const u32 = new Uint32Array(root);
  const f32 = new Float32Array(root);
  const isLeaf = (n) => (u32[n * 8 + 7] & 0xffff0000) !== 0;
  const off = (n) => u32[n * 8 + 6];
  const cnt = (n) => u32[n * 8 + 7] & 0xffff;
  const idx = geom.index.array;
  const pos = geom.attributes.position.array;

  const nodes = [];
  const tris = [];
  const triSlots = [];
  // §18.17 — three packed UV pairs per triangle, in the SAME leaf order as
  // `tris`, so the WGSL's `triStart + j` indexes both without a second map.
  const triUvs = [];
  const makeLeafRef = (n) => {
    const start = tris.length / 9;
    const c = Math.min(cnt(n), 127);
    const o = off(n);
    for (let t = 0; t < c; t++) {
      const ti = (o + t) * 3;
      for (let k = 0; k < 3; k++) {
        const vi = idx[ti + k] * 3;
        tris.push(pos[vi], pos[vi + 1], pos[vi + 2]);
      }
      if (triSlotOf) triSlots.push(triSlotOf(idx[ti] / 3) >>> 0);
      if (triUvOf) {
        // MeshBVH reorders the index in place; `idx[ti]/3` recovers the
        // ORIGINAL triangle id exactly as the slot lookup above does (the
        // sequential-index precondition in buildStaticSceneBvhWords).
        const uv = triUvOf(idx[ti] / 3);
        if (uv) {
          triUvs.push(packHalf2(uv[0], uv[1]), packHalf2(uv[2], uv[3]), packHalf2(uv[4], uv[5]));
        } else {
          // No UV for this placement — mid-tile, which reads as the tile's
          // own centre texel rather than as black.
          const half = packHalf2(0.5, 0.5);
          triUvs.push(half, half, half);
        }
      }
    }
    return (0x80000000 | (start & 0xffffff) | (c << 24)) >>> 0;
  };
  // Collapse log2(arity) binary levels under `n` into one wide node's slots;
  // a leaf encountered early simply occupies a slot at that depth.
  const collapseDepth = arity === 8 ? 3 : 2;
  const kidsOf = (n) => {
    const out = [];
    const expand = (c, d) => {
      if (d === 0 || isLeaf(c)) { out.push(c); return; }
      expand(c + 1, d - 1);
      expand(c + off(c), d - 1);
    };
    expand(n + 1, collapseDepth - 1);
    expand(n + off(n), collapseDepth - 1);
    return out;
  };
  const build = (n) => {
    const kids = kidsOf(n);
    const nodeIndex = nodes.length;
    const node = { refs: new Array(arity).fill(0), bsrc: new Array(arity).fill(-1) };
    nodes.push(node);
    kids.forEach((c, i) => {
      node.bsrc[i] = c;
      node.refs[i] = isLeaf(c) ? makeLeafRef(c) : build(c) + 1;
    });
    return nodeIndex;
  };
  if (isLeaf(0)) {
    // Tiny mesh: the whole thing is one leaf — wrap it in a single node so
    // the traversal always starts at an internal root.
    const node = { refs: new Array(arity).fill(0), bsrc: new Array(arity).fill(-1) };
    nodes.push(node);
    node.bsrc[0] = 0;
    node.refs[0] = makeLeafRef(0);
  } else {
    build(0);
  }

  const NODE_WORDS = 28;
  const nodeWords = nodes.length * NODE_WORDS;
  const triCount = tris.length / 9;
  // The UV region is PARALLEL, not interleaved: the traversal's inner loop
  // touches word 9 (the slot) of every candidate triangle and the vertices of
  // most, and widening that stride would cost every shadow ray cache lines it
  // never reads. Only the WINNING triangle's UV is fetched, once, after the
  // loop.
  const uvRel = triUvOf ? nodeWords + triCount * TRI_WORDS : 0;
  const uvWordCount = triUvOf ? triCount * 3 : 0;
  const words = new Uint32Array(nodeWords + triCount * TRI_WORDS + uvWordCount);
  const wf = new Float32Array(words.buffer);
  if (arity === 8) {
    // COMPRESSED 8-wide: per-node origin + per-axis power-of-two step,
    // children as u8-quantized boxes. floor/ceil keep every quantized box a
    // SUPERSET of the true child bounds — compression can widen a slab hit,
    // never lose one.
    nodes.forEach((node, i) => {
      const base = i * 28;
      let ox = Infinity, oy = Infinity, oz = Infinity;
      let mx = -Infinity, my = -Infinity, mz = -Infinity;
      for (let c = 0; c < 8; c++) {
        const src = node.bsrc[c];
        if (src < 0) continue;
        const b = src * 8;
        ox = Math.min(ox, f32[b]); oy = Math.min(oy, f32[b + 1]); oz = Math.min(oz, f32[b + 2]);
        mx = Math.max(mx, f32[b + 3]); my = Math.max(my, f32[b + 4]); mz = Math.max(mz, f32[b + 5]);
      }
      if (!Number.isFinite(ox)) { ox = oy = oz = 0; mx = my = mz = 0; }
      const expOf = (extent) => Math.max(-100, Math.ceil(Math.log2(Math.max(extent, 1e-12) / 255)));
      const ex = expOf(mx - ox), ey = expOf(my - oy), ez = expOf(mz - oz);
      const sx = 2 ** ex, sy = 2 ** ey, sz = 2 ** ez;
      wf[base] = ox; wf[base + 1] = oy; wf[base + 2] = oz;
      words[base + 3] = ((ex + 128) & 0xff) | (((ey + 128) & 0xff) << 8) | (((ez + 128) & 0xff) << 16);
      for (let c = 0; c < 8; c++) {
        words[base + 4 + c] = node.refs[c];
        const src = node.bsrc[c];
        let q;
        if (src < 0) {
          // Inverted quantized box (min 255, max 0) — the slab test can
          // never pass an empty slot.
          q = [255, 255, 255, 0, 0, 0];
        } else {
          const b = src * 8;
          const qDown = (v, o, s) => Math.min(255, Math.max(0, Math.floor((v - o) / s)));
          const qUp = (v, o, s) => Math.min(255, Math.max(0, Math.ceil((v - o) / s)));
          q = [
            qDown(f32[b], ox, sx), qDown(f32[b + 1], oy, sy), qDown(f32[b + 2], oz, sz),
            qUp(f32[b + 3], ox, sx), qUp(f32[b + 4], oy, sy), qUp(f32[b + 5], oz, sz),
          ];
        }
        words[base + 12 + c * 2] = q[0] | (q[1] << 8) | (q[2] << 16) | (q[3] << 24);
        words[base + 13 + c * 2] = q[4] | (q[5] << 8);
      }
    });
  } else {
    nodes.forEach((node, i) => {
      const base = i * 28;
      for (let c = 0; c < 4; c++) {
        words[base + c] = node.refs[c];
        const bb = base + 4 + c * 6;
        const src = node.bsrc[c];
        if (src < 0) {
          // Inverted bounds: the slab test can never pass, so an empty slot
          // costs one AABB test and no branch bookkeeping.
          wf[bb] = 1; wf[bb + 1] = 1; wf[bb + 2] = 1;
          wf[bb + 3] = -1; wf[bb + 4] = -1; wf[bb + 5] = -1;
        } else {
          for (let k = 0; k < 6; k++) wf[bb + k] = f32[src * 8 + k];
        }
      }
    });
  }
  if (triSlotOf) {
    // Stride-10 triangles: 9 f32 vertex words + a RAW u32 slot-id word (the
    // masked traversal reads it unbitcast).
    for (let t = 0; t < triCount; t++) {
      const base = nodeWords + t * 10;
      for (let k = 0; k < 9; k++) wf[base + k] = tris[t * 9 + k];
      words[base + 9] = triSlots[t];
    }
  } else {
    wf.set(tris, nodeWords);
  }
  if (triUvOf) words.set(triUvs, uvRel);
  geom.dispose();
  return { words, nodeWords, triWords: triCount * TRI_WORDS, triCount, arity, uvRel, uvWordCount };
}

/**
 * ONE world-space BVH8 over every STATIC placement — the shadow channels'
 * exact scene ("light by voxels, shadows by BVH"). Triangles carry their
 * occupancy-slot id so an adopting mover's static copy can be masked out the
 * same frame (no stale-pose ghosts), and a demotion rebuilds at current
 * poses. Instances are baked per placement (world-space soup — necessary,
 * and what makes the traversal transform-free).
 *
 * @param items [{ positions: Float32Array, index: TypedArray|null,
 *                 matrix: THREE.Matrix4, slot: number }]
 */
export function buildStaticSceneBvhWords(items, strategy = null, { uvs = false } = {}) {
  let triTotal = 0;
  for (const it of items) {
    triTotal += Math.floor((it.index ? it.index.length : it.positions.length / 3) / 3);
  }
  if (triTotal < 1) return null;
  const soup = new Float32Array(triTotal * 9);
  const triSlot = new Uint32Array(triTotal);
  // §18.17 — per-triangle UVs for textured reflection hits, built ONLY when
  // the caller asked (i.e. when a reflection consumer exists). 6 floats per
  // triangle here, 3 packed words on the GPU. A scene with reflections off
  // never allocates it.
  const triUv = uvs ? new Float32Array(triTotal * 6) : null;
  const v = new THREE.Vector3();
  let t = 0;
  for (const it of items) {
    const n = Math.floor((it.index ? it.index.length : it.positions.length / 3) / 3);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const vi = it.index ? it.index[i * 3 + k] : i * 3 + k;
        v.set(it.positions[vi * 3], it.positions[vi * 3 + 1], it.positions[vi * 3 + 2]).applyMatrix4(it.matrix);
        const o = t * 9 + k * 3;
        soup[o] = v.x; soup[o + 1] = v.y; soup[o + 2] = v.z;
        if (triUv) {
          const u = t * 6 + k * 2;
          // A placement whose geometry carries no UV attribute writes 0.5 —
          // the tile centre, so it reads as a flat sample of its own texture
          // rather than as a corner artefact.
          triUv[u] = it.uvs ? it.uvs[vi * 2] : 0.5;
          triUv[u + 1] = it.uvs ? it.uvs[vi * 2 + 1] : 0.5;
        }
      }
      triSlot[t] = it.slot >>> 0;
      t++;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(soup, 3));
  // Sequential index — what makes idx[3t]/3 recover the original triangle id
  // for the slot lookup after MeshBVH's in-place reorder.
  const index = new Uint32Array(triTotal * 3);
  for (let i = 0; i < index.length; i++) index[i] = i;
  geom.setIndex(new THREE.BufferAttribute(index, 1));
  const uvScratch = triUv ? new Float32Array(6) : null;
  const packed = buildBvhWords(
    geom, 8, (origTri) => triSlot[origTri], strategy,
    triUv ? (origTri) => { uvScratch.set(triUv.subarray(origTri * 6, origTri * 6 + 6)); return uvScratch; } : null,
  );
  geom.dispose();
  return packed;
}

// ═══════════════════════════════════════════════════ WGSL: BVH4 traversal
// Raw WGSL (the proven bvhGpu.js vehicle): TSL has no local arrays, and a
// stackful traversal needs one. Near-child-first ordering via a 4-element
// insertion sort keeps first-hit early-out effective; `bestT` prunes both the
// AABB tests and the deferred stack entries. The `bits` pointer's access mode
// matches the storage binding every composed COMPUTE kernel already uses —
// fragment consumers (the debug material) compose the OBB part only.
const bvh4TraceWgsl = wgslFn(/* wgsl */ `

	fn giDynBvh4(
		roL: vec3f, rdL: vec3f, tMin: f32, tMax: f32,
		nodeBase: u32, triBase: u32,
		bits: ptr<storage, array<u32>, read_write>
	) -> vec4f {

		var stack: array<u32, 28>;
		var sp: i32 = 0;
		stack[0] = 1u;

		var bestT: f32 = tMax;
		var found: f32 = -1.0;
		var bestN: vec3f = vec3f(0.0, 0.0, 1.0);
		let inv = vec3f(1.0 / dynNz(rdL.x), 1.0 / dynNz(rdL.y), 1.0 / dynNz(rdL.z));
		var guard: u32 = 0u;

		loop {
			if (sp < 0 || guard > 768u) { break; }
			guard = guard + 1u;
			let nref = stack[sp];
			sp = sp - 1;
			if (nref == 0u) { continue; }

			if ((nref & 0x80000000u) != 0u) {
				let triStart = nref & 0x00ffffffu;
				let triCount = (nref >> 24u) & 0x7fu;
				for (var j: u32 = 0u; j < triCount; j = j + 1u) {
					let tw = triBase + (triStart + j) * 9u;
					let a = vec3f(bitcast<f32>(bits[tw]), bitcast<f32>(bits[tw + 1u]), bitcast<f32>(bits[tw + 2u]));
					let b = vec3f(bitcast<f32>(bits[tw + 3u]), bitcast<f32>(bits[tw + 4u]), bitcast<f32>(bits[tw + 5u]));
					let c = vec3f(bitcast<f32>(bits[tw + 6u]), bitcast<f32>(bits[tw + 7u]), bitcast<f32>(bits[tw + 8u]));
					let e1 = b - a;
					let e2 = c - a;
					let h = cross(rdL, e2);
					let det = dot(e1, h);
					if (abs(det) < 1e-10) { continue; }
					let invDet = 1.0 / det;
					let s = roL - a;
					let u = dot(s, h) * invDet;
					let q = cross(s, e1);
					let v = dot(rdL, q) * invDet;
					let t = dot(e2, q) * invDet;
					if (u >= -1e-4 && v >= -1e-4 && (u + v) <= 1.0001 && t > tMin && t < bestT) {
						bestT = t;
						found = 1.0;
						bestN = cross(e1, e2);
					}
				}
				continue;
			}

			let nb = nodeBase + (nref - 1u) * 28u;
			var ct: array<f32, 4>;
			var cr: array<u32, 4>;
			var cn: i32 = 0;
			for (var ci: u32 = 0u; ci < 4u; ci = ci + 1u) {
				let cref = bits[nb + ci];
				if (cref == 0u) { continue; }
				let bb = nb + 4u + ci * 6u;
				let bmin = vec3f(bitcast<f32>(bits[bb]), bitcast<f32>(bits[bb + 1u]), bitcast<f32>(bits[bb + 2u]));
				let bmax = vec3f(bitcast<f32>(bits[bb + 3u]), bitcast<f32>(bits[bb + 4u]), bitcast<f32>(bits[bb + 5u]));
				let t0 = (bmin - roL) * inv;
				let t1 = (bmax - roL) * inv;
				let tn = min(t0, t1);
				let tf = max(t0, t1);
				let te = max(max(tn.x, tn.y), max(tn.z, tMin));
				let tx = min(min(tf.x, tf.y), min(tf.z, bestT));
				if (tx < te) { continue; }
				ct[cn] = te;
				cr[cn] = cref;
				cn = cn + 1;
			}
			for (var ai: i32 = 1; ai < cn; ai = ai + 1) {
				let kt = ct[ai];
				let kr = cr[ai];
				var bi: i32 = ai - 1;
				loop {
					if (bi < 0 || ct[bi] <= kt) { break; }
					ct[bi + 1] = ct[bi];
					cr[bi + 1] = cr[bi];
					bi = bi - 1;
				}
				ct[bi + 1] = kt;
				cr[bi + 1] = kr;
			}
			for (var pi: i32 = cn - 1; pi >= 0; pi = pi - 1) {
				if (sp >= 27) { break; }
				sp = sp + 1;
				stack[sp] = cr[pi];
			}
		}

		if (found < 0.0) { return vec4f(-1.0, 0.0, 0.0, 1.0); }
		return vec4f(bestT, normalize(bestN));
	}

	fn dynNz(x: f32) -> f32 {
		if (abs(x) < 1e-9) { return select(-1e-9, 1e-9, x >= 0.0); }
		return x;
	}

`);

// Compressed 8-wide traversal — decodes each node's origin + power-of-two
// steps once, then slab-tests the 8 u8-quantized child boxes. Same ref
// encoding, same leaf loop, same near-first ordered push as the 4-wide arm.
const bvh8TraceWgsl = wgslFn(/* wgsl */ `

	fn giDynBvh8(
		roL: vec3f, rdL: vec3f, tMin: f32, tMax: f32,
		nodeBase: u32, triBase: u32,
		bits: ptr<storage, array<u32>, read_write>
	) -> vec4f {

		var stack: array<u32, 44>;
		var sp: i32 = 0;
		stack[0] = 1u;

		var bestT: f32 = tMax;
		var found: f32 = -1.0;
		var bestN: vec3f = vec3f(0.0, 0.0, 1.0);
		let inv = vec3f(1.0 / dynNz8(rdL.x), 1.0 / dynNz8(rdL.y), 1.0 / dynNz8(rdL.z));
		var guard: u32 = 0u;

		loop {
			if (sp < 0 || guard > 768u) { break; }
			guard = guard + 1u;
			let nref = stack[sp];
			sp = sp - 1;
			if (nref == 0u) { continue; }

			if ((nref & 0x80000000u) != 0u) {
				let triStart = nref & 0x00ffffffu;
				let triCount = (nref >> 24u) & 0x7fu;
				for (var j: u32 = 0u; j < triCount; j = j + 1u) {
					let tw = triBase + (triStart + j) * 9u;
					let a = vec3f(bitcast<f32>(bits[tw]), bitcast<f32>(bits[tw + 1u]), bitcast<f32>(bits[tw + 2u]));
					let b = vec3f(bitcast<f32>(bits[tw + 3u]), bitcast<f32>(bits[tw + 4u]), bitcast<f32>(bits[tw + 5u]));
					let c = vec3f(bitcast<f32>(bits[tw + 6u]), bitcast<f32>(bits[tw + 7u]), bitcast<f32>(bits[tw + 8u]));
					let e1 = b - a;
					let e2 = c - a;
					let h = cross(rdL, e2);
					let det = dot(e1, h);
					if (abs(det) < 1e-10) { continue; }
					let invDet = 1.0 / det;
					let s = roL - a;
					let u = dot(s, h) * invDet;
					let q = cross(s, e1);
					let v = dot(rdL, q) * invDet;
					let t = dot(e2, q) * invDet;
					if (u >= -1e-4 && v >= -1e-4 && (u + v) <= 1.0001 && t > tMin && t < bestT) {
						bestT = t;
						found = 1.0;
						bestN = cross(e1, e2);
					}
				}
				continue;
			}

			let nb = nodeBase + (nref - 1u) * 28u;
			let org = vec3f(bitcast<f32>(bits[nb]), bitcast<f32>(bits[nb + 1u]), bitcast<f32>(bits[nb + 2u]));
			let ep = bits[nb + 3u];
			let step = vec3f(
				exp2(f32(i32(ep & 0xffu) - 128)),
				exp2(f32(i32((ep >> 8u) & 0xffu) - 128)),
				exp2(f32(i32((ep >> 16u) & 0xffu) - 128))
			);
			var ct: array<f32, 8>;
			var cr: array<u32, 8>;
			var cn: i32 = 0;
			for (var ci: u32 = 0u; ci < 8u; ci = ci + 1u) {
				let cref = bits[nb + 4u + ci];
				if (cref == 0u) { continue; }
				let qa = bits[nb + 12u + ci * 2u];
				let qb = bits[nb + 13u + ci * 2u];
				let bmin = org + vec3f(f32(qa & 0xffu), f32((qa >> 8u) & 0xffu), f32((qa >> 16u) & 0xffu)) * step;
				let bmax = org + vec3f(f32((qa >> 24u) & 0xffu), f32(qb & 0xffu), f32((qb >> 8u) & 0xffu)) * step;
				let t0 = (bmin - roL) * inv;
				let t1 = (bmax - roL) * inv;
				let tn = min(t0, t1);
				let tf = max(t0, t1);
				let te = max(max(tn.x, tn.y), max(tn.z, tMin));
				let tx = min(min(tf.x, tf.y), min(tf.z, bestT));
				if (tx < te) { continue; }
				ct[cn] = te;
				cr[cn] = cref;
				cn = cn + 1;
			}
			for (var ai: i32 = 1; ai < cn; ai = ai + 1) {
				let kt = ct[ai];
				let kr = cr[ai];
				var bi: i32 = ai - 1;
				loop {
					if (bi < 0 || ct[bi] <= kt) { break; }
					ct[bi + 1] = ct[bi];
					cr[bi + 1] = cr[bi];
					bi = bi - 1;
				}
				ct[bi + 1] = kt;
				cr[bi + 1] = kr;
			}
			for (var pi: i32 = cn - 1; pi >= 0; pi = pi - 1) {
				if (sp >= 43) { break; }
				sp = sp + 1;
				stack[sp] = cr[pi];
			}
		}

		if (found < 0.0) { return vec4f(-1.0, 0.0, 0.0, 1.0); }
		return vec4f(bestT, normalize(bestN));
	}

	fn dynNz8(x: f32) -> f32 {
		if (abs(x) < 1e-9) { return select(-1e-9, 1e-9, x >= 0.0); }
		return x;
	}

`);

/** Build-time traversal arity — ONE arm compiles per GI build (see header). */
export function dynBvhArity() {
  return Number(globalThis.__giDynBvhArity) === 4 ? 4 : 8;
}

// STATIC PLACEMENT BVH (SBV2): a balanced binary TLAS over placement records,
// each of which points at a shared object-local compressed BVH8. The whole
// artifact lives in the same occupancy `bits` buffer as the legacy world-space
// BVH, so this adds no storage binding. All offsets in the SBV2 block are
// relative to `packedBase`; the mask remains in the dynamic header.
//
// One entry point serves both production result shapes. `detail == 0` returns
// the legacy shadow vec4 (t + world normal); `detail != 0` returns the exact-
// reflection packing (t, oct normal, UV, slot). Keeping one traversal body is
// important: shadow, RTAO, reflection-hit shadowing and exact reflections must
// not acquire subtly different TLAS decoders.
//
// The decoder fails closed on a malformed header/region and bounds every stack,
// loop and indirect word address. Valid production trees are balanced (TLAS
// depth <= 10 at the 512-slot occupancy cap); the 32-entry TLAS stack therefore
// retains ample headroom without making corrupt topology unbounded.
const staticPlacementTraceWgsl = wgslFn(/* wgsl */ `
	fn giStaticPlacementBvh8(
		roW: vec3f, rdW: vec3f, tMin: f32, tMax: f32,
		packedBase: u32, maskBase: u32, detail: u32,
		bits: ptr<storage, array<u32>, read_write>
	) -> vec4f {
		let capacity = arrayLength(bits);
		if (packedBase > capacity || capacity - packedBase < 16u) {
			return vec4f(-1.0, 0.0, 0.0, select(1.0, -1.0, detail != 0u));
		}
		// "SBV2", version 1. The CPU/disk verifier is the primary integrity
		// gate; these checks make a stale or torn upload a bounded miss too.
		if (bits[packedBase] != 0x32564253u || bits[packedBase + 1u] != 1u) {
			return vec4f(-1.0, 0.0, 0.0, select(1.0, -1.0, detail != 0u));
		}
		let total = bits[packedBase + 3u];
		if (total < 16u || total > capacity - packedBase) {
			return vec4f(-1.0, 0.0, 0.0, select(1.0, -1.0, detail != 0u));
		}

		let tlasOffset = bits[packedBase + 4u];
		let tlasWords = bits[packedBase + 5u];
		let placementOffset = bits[packedBase + 6u];
		let placementWords = bits[packedBase + 7u];
		let blasOffset = bits[packedBase + 8u];
		let blasWords = bits[packedBase + 9u];
		let triOffset = bits[packedBase + 10u];
		let triWords = bits[packedBase + 11u];
		let uvOffset = bits[packedBase + 12u];
		let uvWords = bits[packedBase + 13u];
		let placementCount = bits[packedBase + 15u];
		if (!giSbSpan(tlasOffset, tlasWords, total) ||
			!giSbSpan(placementOffset, placementWords, total) ||
			!giSbSpan(blasOffset, blasWords, total) ||
			!giSbSpan(triOffset, triWords, total) ||
			(uvWords != 0u && !giSbSpan(uvOffset, uvWords, total)) ||
			tlasWords < 8u || tlasWords % 8u != 0u ||
			placementWords % 24u != 0u || placementCount == 0u ||
			placementCount > placementWords / 24u ||
			blasWords < 28u || triWords < 9u) {
			return vec4f(-1.0, 0.0, 0.0, select(1.0, -1.0, detail != 0u));
		}
		if (maskBase > capacity || capacity - maskBase < 16u) {
			return vec4f(-1.0, 0.0, 0.0, select(1.0, -1.0, detail != 0u));
		}

		let tlasBase = packedBase + tlasOffset;
		let placementsBase = packedBase + placementOffset;
		let blasEnd = packedBase + blasOffset + blasWords;
		let triEnd = packedBase + triOffset + triWords;
		let uvEnd = select(0u, packedBase + uvOffset + uvWords, uvWords != 0u);
		let nodeCount = tlasWords / 8u;
		let invW = vec3f(1.0 / giSbNz(rdW.x), 1.0 / giSbNz(rdW.y), 1.0 / giSbNz(rdW.z));

		var stack: array<u32, 32>;
		var stackNear: array<f32, 32>;
		var sp: i32 = 0;
		stack[0] = 0u;
		stackNear[0] = giSbNodeNear(roW, invW, tMin, tMax, tlasBase, bits);
		var bestT = tMax;
		var bestN = vec3f(0.0, 0.0, 1.0);
		var bestSlot = 0xffffffffu;
		var bestTri = 0u;
		var bestU = 0.0;
		var bestV = 0.0;
		var bestUvBase = 0u;
		var found = false;
		var guard = 0u;

		loop {
			if (sp < 0 || guard >= 2048u) { break; }
			guard = guard + 1u;
			let node = stack[sp];
			let nodeNear = stackNear[sp];
			sp = sp - 1;
			if (node >= nodeCount || nodeNear < tMin || nodeNear > bestT) { continue; }
			let nb = tlasBase + node * 8u;
			let leftRef = bits[nb + 6u];
			let rightRef = bits[nb + 7u];

			if ((leftRef & 0x80000000u) != 0u) {
				// A valid leaf has exactly one placement reference.
				if (rightRef != 0u) { continue; }
				let placementIndex = leftRef & 0x7fffffffu;
				if (placementIndex >= placementCount) { continue; }
				let pb = placementsBase + placementIndex * 24u;
				let flags = bits[pb + 21u];
				if ((flags & 1u) == 0u) { continue; }
				let slot = bits[pb + 20u];
				// Production occupancy slots are 0..511. A future wider registry is
				// conservatively unmasked rather than indexing outside today's mask.
				if (slot < 512u &&
					(bits[maskBase + (slot >> 5u)] & (1u << (slot & 31u))) != 0u) {
					continue;
				}

				let nodeRel = bits[pb + 16u];
				let triRel = bits[pb + 17u];
				let uvRel = bits[pb + 19u];
				if (nodeRel < blasOffset || nodeRel >= blasOffset + blasWords ||
					triRel < triOffset || triRel >= triOffset + triWords ||
					(uvRel != 0u && (uvWords == 0u || uvRel < uvOffset || uvRel >= uvOffset + uvWords))) {
					continue;
				}

				let c0 = vec3f(bitcast<f32>(bits[pb]), bitcast<f32>(bits[pb + 1u]), bitcast<f32>(bits[pb + 2u]));
				let c1 = vec3f(bitcast<f32>(bits[pb + 4u]), bitcast<f32>(bits[pb + 5u]), bitcast<f32>(bits[pb + 6u]));
				let c2 = vec3f(bitcast<f32>(bits[pb + 8u]), bitcast<f32>(bits[pb + 9u]), bitcast<f32>(bits[pb + 10u]));
				let c3 = vec3f(bitcast<f32>(bits[pb + 12u]), bitcast<f32>(bits[pb + 13u]), bitcast<f32>(bits[pb + 14u]));
				let roL = c0 * roW.x + c1 * roW.y + c2 * roW.z + c3;
				// Deliberately unnormalised: local and world rays retain one t.
				let rdL = c0 * rdW.x + c1 * rdW.y + c2 * rdW.z;
				let hit = giSbBlasTrace(
					roL, rdL, tMin, bestT,
					packedBase + nodeRel, blasEnd,
					packedBase + triRel, triEnd, bits
				);
				if (hit.t >= tMin &&
					(hit.t < bestT || (hit.t == bestT && slot < bestSlot))) {
					bestT = hit.t;
					let nRaw = normalize(vec3f(dot(c0, hit.n), dot(c1, hit.n), dot(c2, hit.n)));
					bestN = select(nRaw, -nRaw, dot(nRaw, rdW) > 0.0);
					bestSlot = slot;
					bestTri = hit.tri;
					bestU = hit.u;
					bestV = hit.v;
					bestUvBase = select(0u, packedBase + uvRel, uvRel != 0u);
					found = true;
				}
				continue;
			}

			// Internal refs are nodeIndex+1, preserving zero as empty/invalid.
			if (leftRef == 0u || rightRef == 0u ||
				(leftRef & 0x80000000u) != 0u || (rightRef & 0x80000000u) != 0u) {
				continue;
			}
			let left = leftRef - 1u;
			let right = rightRef - 1u;
			var leftNear = -1.0;
			var rightNear = -1.0;
			if (left < nodeCount) {
				leftNear = giSbNodeNear(roW, invW, tMin, bestT, tlasBase + left * 8u, bits);
			}
			if (right < nodeCount) {
				rightNear = giSbNodeNear(roW, invW, tMin, bestT, tlasBase + right * 8u, bits);
			}
			let leftHit = leftNear >= tMin;
			let rightHit = rightNear >= tMin;
			if (leftHit && rightHit) {
				if (sp <= 29) {
					let nearNode = select(right, left, leftNear <= rightNear);
					let farNode = select(left, right, leftNear <= rightNear);
					let nearT = min(leftNear, rightNear);
					let farT = max(leftNear, rightNear);
					sp = sp + 1;
					stack[sp] = farNode;
					stackNear[sp] = farT;
					sp = sp + 1;
					stack[sp] = nearNode;
					stackNear[sp] = nearT;
				}
			} else if ((leftHit || rightHit) && sp < 31) {
				sp = sp + 1;
				stack[sp] = select(right, left, leftHit);
				stackNear[sp] = select(rightNear, leftNear, leftHit);
			}
		}

		if (!found) {
			return vec4f(-1.0, 0.0, 0.0, select(1.0, -1.0, detail != 0u));
		}
		if (detail == 0u) { return vec4f(bestT, bestN); }

		let oe = giSbOctEnc(bestN) * 0.5 + vec2f(0.5);
		let nq = vec2u(clamp(oe, vec2f(0.0), vec2f(0.99999)) * 4095.0);
		var uv = vec2f(0.5);
		if (bestUvBase != 0u && bestUvBase <= uvEnd && bestTri <= (uvEnd - bestUvBase) / 3u &&
			uvEnd - bestUvBase >= 3u && bestTri < (uvEnd - bestUvBase) / 3u) {
			let uw = bestUvBase + bestTri * 3u;
			let uv0 = unpack2x16float(bits[uw]);
			let uv1 = unpack2x16float(bits[uw + 1u]);
			let uv2 = unpack2x16float(bits[uw + 2u]);
			uv = uv0 * (1.0 - bestU - bestV) + uv1 * bestU + uv2 * bestV;
		}
		let fuv = fract(uv);
		let uq = vec2u(clamp(fuv, vec2f(0.0), vec2f(0.99999)) * 4095.0);
		return vec4f(bestT, f32(nq.x * 4096u + nq.y), f32(uq.x * 4096u + uq.y), f32(bestSlot));
	}

	struct GiSbBlasHit {
		t: f32,
		n: vec3f,
		tri: u32,
		u: f32,
		v: f32,
	}

	fn giSbSpan(offset: u32, count: u32, total: u32) -> bool {
		return offset <= total && count <= total - offset;
	}

	fn giSbNz(x: f32) -> f32 {
		if (abs(x) < 1e-9) { return select(-1e-9, 1e-9, x >= 0.0); }
		return x;
	}

	fn giSbNodeNear(
		ro: vec3f, inv: vec3f, tMin: f32, tMax: f32, nb: u32,
		bits: ptr<storage, array<u32>, read_write>
	) -> f32 {
		let bmin = vec3f(bitcast<f32>(bits[nb]), bitcast<f32>(bits[nb + 1u]), bitcast<f32>(bits[nb + 2u]));
		let bmax = vec3f(bitcast<f32>(bits[nb + 3u]), bitcast<f32>(bits[nb + 4u]), bitcast<f32>(bits[nb + 5u]));
		let a = (bmin - ro) * inv;
		let b = (bmax - ro) * inv;
		let near = min(a, b);
		let far = max(a, b);
		let enter = max(max(near.x, near.y), max(near.z, tMin));
		let exit = min(min(far.x, far.y), min(far.z, tMax));
		return select(-1.0, enter, exit >= enter);
	}

	fn giSbBlasTrace(
		roL: vec3f, rdL: vec3f, tMin: f32, tMax: f32,
		nodeBase: u32, nodeEnd: u32, triBase: u32, triEnd: u32,
		bits: ptr<storage, array<u32>, read_write>
	) -> GiSbBlasHit {
		var stack: array<u32, 44>;
		var sp: i32 = 0;
		stack[0] = 1u;
		var bestT = tMax;
		var bestN = vec3f(0.0, 0.0, 1.0);
		var bestTri = 0u;
		var bestU = 0.0;
		var bestV = 0.0;
		var found = false;
		let inv = vec3f(1.0 / giSbNz(rdL.x), 1.0 / giSbNz(rdL.y), 1.0 / giSbNz(rdL.z));
		var guard = 0u;
		loop {
			if (sp < 0 || guard >= 768u) { break; }
			guard = guard + 1u;
			let nref = stack[sp];
			sp = sp - 1;
			if (nref == 0u) { continue; }
			if ((nref & 0x80000000u) != 0u) {
				let triStart = nref & 0x00ffffffu;
				let triCount = (nref >> 24u) & 0x7fu;
				let triCapacity = select(0u, (triEnd - triBase) / 9u, triBase <= triEnd);
				for (var j = 0u; j < triCount; j = j + 1u) {
					let tri = triStart + j;
					if (tri >= triCapacity) { continue; }
					let tw = triBase + tri * 9u;
					let a = vec3f(bitcast<f32>(bits[tw]), bitcast<f32>(bits[tw + 1u]), bitcast<f32>(bits[tw + 2u]));
					let b = vec3f(bitcast<f32>(bits[tw + 3u]), bitcast<f32>(bits[tw + 4u]), bitcast<f32>(bits[tw + 5u]));
					let c = vec3f(bitcast<f32>(bits[tw + 6u]), bitcast<f32>(bits[tw + 7u]), bitcast<f32>(bits[tw + 8u]));
					let e1 = b - a;
					let e2 = c - a;
					let h = cross(rdL, e2);
					let det = dot(e1, h);
					if (abs(det) < 1e-10) { continue; }
					let invDet = 1.0 / det;
					let s = roL - a;
					let u = dot(s, h) * invDet;
					let q = cross(s, e1);
					let v = dot(rdL, q) * invDet;
					let t = dot(e2, q) * invDet;
					if (u >= -1e-4 && v >= -1e-4 && u + v <= 1.0001 && t > tMin && t < bestT) {
						bestT = t;
						bestN = cross(e1, e2);
						bestTri = tri;
						bestU = u;
						bestV = v;
						found = true;
					}
				}
				continue;
			}

			let nodeIndex = nref - 1u;
			if (nodeBase > nodeEnd || nodeIndex >= (nodeEnd - nodeBase) / 28u) { continue; }
			let nb = nodeBase + nodeIndex * 28u;
			let org = vec3f(bitcast<f32>(bits[nb]), bitcast<f32>(bits[nb + 1u]), bitcast<f32>(bits[nb + 2u]));
			let ep = bits[nb + 3u];
			let step = vec3f(
				exp2(f32(i32(ep & 0xffu) - 128)),
				exp2(f32(i32((ep >> 8u) & 0xffu) - 128)),
				exp2(f32(i32((ep >> 16u) & 0xffu) - 128))
			);
			var childNear: array<f32, 8>;
			var childRef: array<u32, 8>;
			var childCount: i32 = 0;
			for (var child = 0u; child < 8u; child = child + 1u) {
				let cref = bits[nb + 4u + child];
				if (cref == 0u) { continue; }
				let qa = bits[nb + 12u + child * 2u];
				let qb = bits[nb + 13u + child * 2u];
				let bmin = org + vec3f(f32(qa & 0xffu), f32((qa >> 8u) & 0xffu), f32((qa >> 16u) & 0xffu)) * step;
				let bmax = org + vec3f(f32((qa >> 24u) & 0xffu), f32(qb & 0xffu), f32((qb >> 8u) & 0xffu)) * step;
				let a = (bmin - roL) * inv;
				let b = (bmax - roL) * inv;
				let near = min(a, b);
				let far = max(a, b);
				let enter = max(max(near.x, near.y), max(near.z, tMin));
				let exit = min(min(far.x, far.y), min(far.z, bestT));
				if (exit < enter) { continue; }
				childNear[childCount] = enter;
				childRef[childCount] = cref;
				childCount = childCount + 1;
			}
			for (var i: i32 = 1; i < childCount; i = i + 1) {
				let keyNear = childNear[i];
				let keyRef = childRef[i];
				var j = i - 1;
				loop {
					if (j < 0 || childNear[j] <= keyNear) { break; }
					childNear[j + 1] = childNear[j];
					childRef[j + 1] = childRef[j];
					j = j - 1;
				}
				childNear[j + 1] = keyNear;
				childRef[j + 1] = keyRef;
			}
			for (var i = childCount - 1; i >= 0; i = i - 1) {
				if (sp >= 43) { break; }
				sp = sp + 1;
				stack[sp] = childRef[i];
			}
		}
		return GiSbBlasHit(select(-1.0, bestT, found), bestN, bestTri, bestU, bestV);
	}

	fn giSbOctEnc(n: vec3f) -> vec2f {
		let l1 = 1.0 / max(abs(n.x) + abs(n.y) + abs(n.z), 1e-12);
		let x = n.x * l1;
		let y = n.y * l1;
		if (n.z < 0.0) {
			return vec2f(
				(1.0 - abs(y)) * select(-1.0, 1.0, x >= 0.0),
				(1.0 - abs(x)) * select(-1.0, 1.0, y >= 0.0)
			);
		}
		return vec2f(x, y);
	}

`);

// STATIC-SCENE traversal: identical to giDynBvh8 except stride-10 triangles
// whose 10th word is an occupancy-slot id checked against a 512-bit disable
// mask (adopted movers' static copies are masked out live). Compiled ONLY
// into the shadow kernels that carry the static-BVH arm.
const bvh8MaskedTraceWgsl = wgslFn(/* wgsl */ `

	fn giStaticBvh8(
		roL: vec3f, rdL: vec3f, tMin: f32, tMax: f32,
		nodeBase: u32, triBase: u32, maskBase: u32, anyHit: u32,
		bits: ptr<storage, array<u32>, read_write>
	) -> vec4f {

		var stack: array<u32, 44>;
		var sp: i32 = 0;
		stack[0] = 1u;

		var bestT: f32 = tMax;
		var found: f32 = -1.0;
		var bestN: vec3f = vec3f(0.0, 0.0, 1.0);
		let inv = vec3f(1.0 / statNz8(rdL.x), 1.0 / statNz8(rdL.y), 1.0 / statNz8(rdL.z));
		var guard: u32 = 0u;

		loop {
			if (sp < 0 || guard > 1024u) { break; }
			guard = guard + 1u;
			let nref = stack[sp];
			sp = sp - 1;
			if (nref == 0u) { continue; }

			if ((nref & 0x80000000u) != 0u) {
				let triStart = nref & 0x00ffffffu;
				let triCount = (nref >> 24u) & 0x7fu;
				for (var j: u32 = 0u; j < triCount; j = j + 1u) {
					let tw = triBase + (triStart + j) * 10u;
					let slotId = bits[tw + 9u];
					if ((bits[maskBase + (slotId >> 5u)] & (1u << (slotId & 31u))) != 0u) { continue; }
					// (any-hit early-out lives at the acceptance test below)
					let a = vec3f(bitcast<f32>(bits[tw]), bitcast<f32>(bits[tw + 1u]), bitcast<f32>(bits[tw + 2u]));
					let b = vec3f(bitcast<f32>(bits[tw + 3u]), bitcast<f32>(bits[tw + 4u]), bitcast<f32>(bits[tw + 5u]));
					let c = vec3f(bitcast<f32>(bits[tw + 6u]), bitcast<f32>(bits[tw + 7u]), bitcast<f32>(bits[tw + 8u]));
					let e1 = b - a;
					let e2 = c - a;
					let h = cross(rdL, e2);
					let det = dot(e1, h);
					if (abs(det) < 1e-10) { continue; }
					let invDet = 1.0 / det;
					let s = roL - a;
					let u = dot(s, h) * invDet;
					let q = cross(s, e1);
					let v = dot(rdL, q) * invDet;
					let t = dot(e2, q) * invDet;
					if (u >= -1e-4 && v >= -1e-4 && (u + v) <= 1.0001 && t > tMin && t < bestT) {
						bestT = t;
						found = 1.0;
						bestN = cross(e1, e2);
					}
				}
				continue;
			}

			let nb = nodeBase + (nref - 1u) * 28u;
			let org = vec3f(bitcast<f32>(bits[nb]), bitcast<f32>(bits[nb + 1u]), bitcast<f32>(bits[nb + 2u]));
			let ep = bits[nb + 3u];
			let step = vec3f(
				exp2(f32(i32(ep & 0xffu) - 128)),
				exp2(f32(i32((ep >> 8u) & 0xffu) - 128)),
				exp2(f32(i32((ep >> 16u) & 0xffu) - 128))
			);
			var ct: array<f32, 8>;
			var cr: array<u32, 8>;
			var cn: i32 = 0;
			for (var ci: u32 = 0u; ci < 8u; ci = ci + 1u) {
				let cref = bits[nb + 4u + ci];
				if (cref == 0u) { continue; }
				let qa = bits[nb + 12u + ci * 2u];
				let qb = bits[nb + 13u + ci * 2u];
				let bmin = org + vec3f(f32(qa & 0xffu), f32((qa >> 8u) & 0xffu), f32((qa >> 16u) & 0xffu)) * step;
				let bmax = org + vec3f(f32((qa >> 24u) & 0xffu), f32(qb & 0xffu), f32((qb >> 8u) & 0xffu)) * step;
				let t0 = (bmin - roL) * inv;
				let t1 = (bmax - roL) * inv;
				let tn = min(t0, t1);
				let tf = max(t0, t1);
				let te = max(max(tn.x, tn.y), max(tn.z, tMin));
				let tx = min(min(tf.x, tf.y), min(tf.z, bestT));
				if (tx < te) { continue; }
				ct[cn] = te;
				cr[cn] = cref;
				cn = cn + 1;
			}
			for (var ai: i32 = 1; ai < cn; ai = ai + 1) {
				let kt = ct[ai];
				let kr = cr[ai];
				var bi: i32 = ai - 1;
				loop {
					if (bi < 0 || ct[bi] <= kt) { break; }
					ct[bi + 1] = ct[bi];
					cr[bi + 1] = cr[bi];
					bi = bi - 1;
				}
				ct[bi + 1] = kt;
				cr[bi + 1] = kr;
			}
			for (var pi: i32 = cn - 1; pi >= 0; pi = pi - 1) {
				if (sp >= 43) { break; }
				sp = sp + 1;
				stack[sp] = cr[pi];
			}
		}

		if (found < 0.0) { return vec4f(-1.0, 0.0, 0.0, 1.0); }
		return vec4f(bestT, normalize(bestN));
	}

	fn statNz8(x: f32) -> f32 {
		if (abs(x) < 1e-9) { return select(-1e-9, 1e-9, x >= 0.0); }
		return x;
	}

`);

// §17 R7 — the CLOSEST-HIT REFLECTION variant of the static traversal.
//
// Same tree, same 512-bit mask, same acceptance test — plus it KEEPS what
// the shadow fn discards: the winning triangle's OCCUPANCY SLOT (word 9 is
// already loaded for the mask test), its interpolated UV (§18.17, from the
// parallel UV region), and its normal — four values in one vec4f:
//
//     x = t (< 0 miss)
//     y = octahedral normal, two 12-bit fields (hi*4096 + lo), each 0..4095
//         mapping [-1,1]; an INTEGER-VALUED f32, exact below 2^24
//     z = fract(uv), same 12-bit pair encoding; 0.5,0.5 with no UV region
//     w = slot as a plain integer-valued f32, -1 on miss
//
// giScreen's `unpack12` is the decoder; both halves are packed rather than
// bitcast for the reason the miss-value note below spells out.
//
// A SEPARATE wgslFn rather than a widened shared one, deliberately: the
// shadow fn's return shape is compiled into every shadow consumer, and
// widening it would recompile all of them for a field none reads. This
// variant is emitted ONLY into kernels that call `traceStaticBvhSlot`
// (today: the reflection prepass). Helper names carry the C8 suffix so the
// two wgslFns can never collide if a future kernel includes both.
const bvh8ClosestSlotTraceWgsl = wgslFn(/* wgsl */ `

	fn giStaticBvh8Slot(
		roL: vec3f, rdL: vec3f, tMin: f32, tMax: f32,
		nodeBase: u32, triBase: u32, uvBase: u32, maskBase: u32,
		bits: ptr<storage, array<u32>, read_write>
	) -> vec4f {

		var stack: array<u32, 44>;
		var sp: i32 = 0;
		stack[0] = 1u;

		var bestT: f32 = tMax;
		var found: f32 = -1.0;
		var bestN: vec3f = vec3f(0.0, 0.0, 1.0);
		var bestSlot: u32 = 0u;
		// §18.17: the winning triangle's global index + its barycentrics, so
		// the UV can be resolved ONCE after the loop instead of interpolated
		// for every candidate the traversal rejects.
		var bestTri: u32 = 0u;
		var bestU: f32 = 0.0;
		var bestV: f32 = 0.0;
		let inv = vec3f(1.0 / statNzC8(rdL.x), 1.0 / statNzC8(rdL.y), 1.0 / statNzC8(rdL.z));
		var guard: u32 = 0u;

		loop {
			if (sp < 0 || guard > 1024u) { break; }
			guard = guard + 1u;
			let nref = stack[sp];
			sp = sp - 1;
			if (nref == 0u) { continue; }

			if ((nref & 0x80000000u) != 0u) {
				let triStart = nref & 0x00ffffffu;
				let triCount = (nref >> 24u) & 0x7fu;
				for (var j: u32 = 0u; j < triCount; j = j + 1u) {
					let tw = triBase + (triStart + j) * 10u;
					let slotId = bits[tw + 9u];
					if ((bits[maskBase + (slotId >> 5u)] & (1u << (slotId & 31u))) != 0u) { continue; }
					let a = vec3f(bitcast<f32>(bits[tw]), bitcast<f32>(bits[tw + 1u]), bitcast<f32>(bits[tw + 2u]));
					let b = vec3f(bitcast<f32>(bits[tw + 3u]), bitcast<f32>(bits[tw + 4u]), bitcast<f32>(bits[tw + 5u]));
					let c = vec3f(bitcast<f32>(bits[tw + 6u]), bitcast<f32>(bits[tw + 7u]), bitcast<f32>(bits[tw + 8u]));
					let e1 = b - a;
					let e2 = c - a;
					let h = cross(rdL, e2);
					let det = dot(e1, h);
					if (abs(det) < 1e-10) { continue; }
					let invDet = 1.0 / det;
					let s = roL - a;
					let u = dot(s, h) * invDet;
					let q = cross(s, e1);
					let v = dot(rdL, q) * invDet;
					let t = dot(e2, q) * invDet;
					if (u >= -1e-4 && v >= -1e-4 && (u + v) <= 1.0001 && t > tMin && t < bestT) {
						bestT = t;
						found = 1.0;
						bestN = cross(e1, e2);
						bestSlot = slotId;
						bestTri = triStart + j;
						bestU = u;
						bestV = v;
					}
				}
				continue;
			}

			let nb = nodeBase + (nref - 1u) * 28u;
			let org = vec3f(bitcast<f32>(bits[nb]), bitcast<f32>(bits[nb + 1u]), bitcast<f32>(bits[nb + 2u]));
			let ep = bits[nb + 3u];
			let step = vec3f(
				exp2(f32(i32(ep & 0xffu) - 128)),
				exp2(f32(i32((ep >> 8u) & 0xffu) - 128)),
				exp2(f32(i32((ep >> 16u) & 0xffu) - 128))
			);
			var ct: array<f32, 8>;
			var cr: array<u32, 8>;
			var cn: i32 = 0;
			for (var ci: u32 = 0u; ci < 8u; ci = ci + 1u) {
				let cref = bits[nb + 4u + ci];
				if (cref == 0u) { continue; }
				let qa = bits[nb + 12u + ci * 2u];
				let qb = bits[nb + 13u + ci * 2u];
				let bmin = org + vec3f(f32(qa & 0xffu), f32((qa >> 8u) & 0xffu), f32((qa >> 16u) & 0xffu)) * step;
				let bmax = org + vec3f(f32((qa >> 24u) & 0xffu), f32(qb & 0xffu), f32((qb >> 8u) & 0xffu)) * step;
				let t0 = (bmin - roL) * inv;
				let t1 = (bmax - roL) * inv;
				let tn = min(t0, t1);
				let tf = max(t0, t1);
				let te = max(max(tn.x, tn.y), max(tn.z, tMin));
				let tx = min(min(tf.x, tf.y), min(tf.z, bestT));
				if (tx < te) { continue; }
				ct[cn] = te;
				cr[cn] = cref;
				cn = cn + 1;
			}
			for (var ai: i32 = 1; ai < cn; ai = ai + 1) {
				let kt = ct[ai];
				let kr = cr[ai];
				var bi: i32 = ai - 1;
				loop {
					if (bi < 0 || ct[bi] <= kt) { break; }
					ct[bi + 1] = ct[bi];
					cr[bi + 1] = cr[bi];
					bi = bi - 1;
				}
				ct[bi + 1] = kt;
				cr[bi + 1] = kr;
			}
			for (var pi: i32 = cn - 1; pi >= 0; pi = pi - 1) {
				if (sp >= 43) { break; }
				sp = sp + 1;
				stack[sp] = cr[pi];
			}
		}

		// ⚠ The slot rides as a PLAIN integer-valued f32 (exact to 16.7M),
		// never a bitcast: a const bitcast<f32>(0xffffffffu) is a NaN the WGSL
		// parser REJECTS outright ("value -nan cannot be represented"), and a
		// runtime bitcast of a small slot id is a DENORMAL any float op may
		// flush to zero. -1 marks a miss (consumers only read .w when t >= 0).
		if (found < 0.0) { return vec4f(-1.0, 0.0, 0.0, -1.0); }
		// ── §18.17: FOUR VALUES INTO THREE LANES, WITHOUT A BITCAST ─────────
		//
		// t, a normal, a UV and a slot do not fit a vec4f one-per-lane, and
		// the obvious fix — bitcast a packed half pair into an f32 lane — is
		// the trap this file's slot comment already documents from the other
		// side: such a pattern can be a NaN or a denormal, and any float op on
		// the way out may flush or reject it.
		//
		// So both pairs ride as PLAIN INTEGER-VALUED FLOATS. 12 bits per
		// component packs to at most 4095*4096+4095 = 2^24-1, which f32
		// represents EXACTLY — no rounding on the way out, no decode drift.
		// 12 bits of octahedral normal is ~0.05 degrees; 12 bits of a
		// fractional UV is 1/4096, finer than a texel of a 256-px atlas tile.
		let oe = giOctEncC8(normalize(bestN)) * 0.5 + vec2f(0.5);
		let nq = vec2u(clamp(oe, vec2f(0.0), vec2f(0.99999)) * 4095.0);
		var uv = vec2f(0.5, 0.5);
		if (uvBase != 0u) {
			let uw = uvBase + bestTri * 3u;
			let uv0 = unpack2x16float(bits[uw]);
			let uv1 = unpack2x16float(bits[uw + 1u]);
			let uv2 = unpack2x16float(bits[uw + 2u]);
			// Interpolate FIRST, wrap second: a triangle whose UVs straddle a
			// wrap (0.9 -> 1.1) is continuous in raw UV and discontinuous in
			// fract(), so wrapping the corners would smear the whole triangle.
			uv = uv0 * (1.0 - bestU - bestV) + uv1 * bestU + uv2 * bestV;
		}
		let fuv = fract(uv);
		let uq = vec2u(clamp(fuv, vec2f(0.0), vec2f(0.99999)) * 4095.0);
		return vec4f(
			bestT,
			f32(nq.x * 4096u + nq.y),
			f32(uq.x * 4096u + uq.y),
			f32(bestSlot),
		);
	}

	// Twin of rayHitTSL's octEncodeTSL (signNotZero: 0 encodes as +1).
	fn giOctEncC8(n: vec3f) -> vec2f {
		let l1 = 1.0 / max(abs(n.x) + abs(n.y) + abs(n.z), 1e-12);
		let x = n.x * l1;
		let y = n.y * l1;
		if (n.z < 0.0) {
			return vec2f(
				(1.0 - abs(y)) * select(-1.0, 1.0, x >= 0.0),
				(1.0 - abs(x)) * select(-1.0, 1.0, y >= 0.0)
			);
		}
		return vec2f(x, y);
	}

	fn statNzC8(x: f32) -> f32 {
		if (abs(x) < 1e-9) { return select(-1e-9, 1e-9, x >= 0.0); }
		return x;
	}

`);

// ═══════════════════════════ TSL: analytic default-primitive intersections
/**
 * Sphere / capsule / conical-frustum ray intersection in OBJECT-LOCAL space
 * (the caller already transformed the ray; t is world-exact because the local
 * direction is un-normalized). ONE WGSL function per shader, shared by every
 * trace variant — pure ALU, no buffers, so the per-builder sharedFn cache
 * keeps the kernel-size cost to a single emission.
 *
 * Returns vec4(t, localNormal) with t < 0 = miss; the normal is UN-normalized
 * (the caller applies the covariant world transform and normalizes once).
 * prm: sphere [r,-,-] · capsule [r, halfSegment,-] · frustum [rBottom, rTop, halfHeight].
 */
const dynShapeHitFn = sharedFn({
  name: "giDynShapeHit",
  type: "vec4",
  inputs: [
    { name: "roL", type: "vec3" },
    { name: "rdL", type: "vec3" },
    { name: "tMin", type: "float" },
    { name: "tMax", type: "float" },
    { name: "shapeType", type: "float" },
    { name: "prm", type: "vec3" },
  ],
  body: (roL, rdL, tMin, tMax, shapeType, prm) => {
    const bestT = float(-1).toVar();
    const bestN = vec3(0, 1, 0).toVar();
    const accept = (t, n) => {
      If(
        t.greaterThanEqual(tMin).and(t.lessThan(tMax))
          .and(bestT.lessThan(0).or(t.lessThan(bestT))),
        () => {
          bestT.assign(t);
          bestN.assign(n);
        },
      );
    };
    If(shapeType.lessThan(3.5), () => {
      // SPHERE (ellipsoid under non-uniform scale — the matrix carries it).
      const r = prm.x.max(1e-6).toVar();
      const a = rdL.dot(rdL).max(1e-12).toVar();
      const b = roL.dot(rdL).toVar(); // half-b
      const cq = roL.dot(roL).sub(r.mul(r)).toVar();
      const disc = b.mul(b).sub(a.mul(cq)).toVar();
      If(disc.greaterThanEqual(0), () => {
        const sq = disc.sqrt().toVar();
        const tN = b.negate().sub(sq).div(a).toVar();
        const tF = b.negate().add(sq).div(a).toVar();
        // Inside the sphere: surface is behind → occlude from tMin, matching
        // the OBB's enter = max(tEnter, t0) semantics.
        If(tN.greaterThanEqual(tMin), () => {
          accept(tN, roL.add(rdL.mul(tN)).div(r));
        }).ElseIf(tF.greaterThanEqual(tMin), () => {
          accept(tMin, rdL.negate());
        });
      });
    }).ElseIf(shapeType.lessThan(4.5), () => {
      // CAPSULE: Y segment ±halfSegment, radius r.
      const r = prm.x.max(1e-6).toVar();
      const hs = prm.y.max(0).toVar();
      const a = rdL.x.mul(rdL.x).add(rdL.z.mul(rdL.z)).toVar();
      const b = roL.x.mul(rdL.x).add(roL.z.mul(rdL.z)).toVar();
      const cq = roL.x.mul(roL.x).add(roL.z.mul(roL.z)).sub(r.mul(r)).toVar();
      If(a.greaterThan(1e-12), () => {
        const disc = b.mul(b).sub(a.mul(cq)).toVar();
        If(disc.greaterThanEqual(0), () => {
          const tS = b.negate().sub(disc.sqrt()).div(a).toVar();
          const y = roL.y.add(rdL.y.mul(tS)).toVar();
          If(y.abs().lessThanEqual(hs), () => {
            const pH = roL.add(rdL.mul(tS));
            accept(tS, vec3(pH.x, 0, pH.z).div(r));
          });
        });
      });
      // End caps: hemispheres at (0, ±hs, 0) — gated to the half beyond the
      // segment so interior-side sphere hits don't pre-empt the true surface.
      for (const sgn of [1, -1]) {
        const ro2 = roL.sub(vec3(0, hs.mul(sgn), 0)).toVar();
        const a2 = rdL.dot(rdL).max(1e-12).toVar();
        const b2 = ro2.dot(rdL).toVar();
        const c2 = ro2.dot(ro2).sub(r.mul(r)).toVar();
        const d2 = b2.mul(b2).sub(a2.mul(c2)).toVar();
        If(d2.greaterThanEqual(0), () => {
          const tC = b2.negate().sub(d2.sqrt()).div(a2).toVar();
          const pH = ro2.add(rdL.mul(tC)).toVar();
          If(pH.y.mul(sgn).greaterThanEqual(0), () => {
            accept(tC, pH.div(r));
          });
        });
      }
    }).Else(() => {
      // CONICAL FRUSTUM (cylinder rT==rB, cone rT==0): radius grows linearly
      // rB→rT from y=-hh to +hh; the side is a quadratic in t, the caps are
      // radius-bounded plane hits. kAt >= 0 rejects the mirror cone.
      const rB = prm.x.max(0).toVar();
      const rT = prm.y.max(0).toVar();
      const hh = prm.z.max(1e-6).toVar();
      const s = rT.sub(rB).div(hh.mul(2)).toVar();
      const k0 = rB.add(s.mul(roL.y.add(hh))).toVar();
      const trySide = (t) => {
        const y = roL.y.add(rdL.y.mul(t)).toVar();
        const kAt = rB.add(s.mul(y.add(hh))).toVar();
        If(y.abs().lessThanEqual(hh).and(kAt.greaterThanEqual(0)), () => {
          const pH = roL.add(rdL.mul(t));
          accept(t, vec3(pH.x, kAt.mul(s).negate(), pH.z));
        });
      };
      const a = rdL.x.mul(rdL.x).add(rdL.z.mul(rdL.z)).sub(s.mul(s).mul(rdL.y).mul(rdL.y)).toVar();
      const b = roL.x.mul(rdL.x).add(roL.z.mul(rdL.z)).sub(k0.mul(s).mul(rdL.y)).toVar(); // half-b
      const cq = roL.x.mul(roL.x).add(roL.z.mul(roL.z)).sub(k0.mul(k0)).toVar();
      If(a.abs().greaterThan(1e-10), () => {
        const disc = b.mul(b).sub(a.mul(cq)).toVar();
        If(disc.greaterThanEqual(0), () => {
          const sq = disc.sqrt().toVar();
          trySide(b.negate().sub(sq).div(a).toVar());
          trySide(b.negate().add(sq).div(a).toVar());
        });
      }).Else(() => {
        // Ray parallel to the cone slope: the quadratic degenerates linear.
        If(b.abs().greaterThan(1e-12), () => {
          trySide(cq.negate().div(b.mul(2)).toVar());
        });
      });
      If(rdL.y.abs().greaterThan(1e-12), () => {
        for (const [sgn, rc] of [[1, rT], [-1, rB]]) {
          const t = hh.mul(sgn).sub(roL.y).div(rdL.y).toVar();
          const px = roL.x.add(rdL.x.mul(t)).toVar();
          const pz = roL.z.add(rdL.z.mul(t)).toVar();
          If(px.mul(px).add(pz.mul(pz)).lessThanEqual(rc.mul(rc)), () => {
            accept(t, vec3(0, sgn, 0));
          });
        }
      });
    });
    return vec4(bestT, bestN);
  },
});

// ═══════════════════════════════════════════════ SURFACE-CACHE card slot (§6.4)
/**
 * The card slot an OBJECT-SPACE normal addresses: `axis*2 + (n[axis] < 0)`,
 * branchless, over `argmax |dot(n, ±e_k)|`.
 *
 * WHY IT LIVES HERE AND NOT AT THE HIT SITE. `trace({objId: true})` hands back
 * an oct-packed WORLD normal, and the object header carries only M⁻¹ — the
 * object-space geometric normal would need Mᵀ, which is stored nowhere, and
 * `M⁻¹·nWorld` ranks the same as `Mᵀ·nWorld` ONLY under uniform scale. So the
 * slot has to be decided INSIDE `traceDynBody`, where the exact local normal is
 * already in hand, and ride out packed into `bestObj` (see its note).
 *
 * Byte-for-byte the same decision as `surfaceCache.cardSlotFor` and
 * `surfaceCacheGpu.cardArgmaxSlot`; `run-gi-card-lookup-test.mjs` pins those two
 * against `cardProject`'s ground truth over a dense normal set, so this is the
 * third writing of one rule and must not drift from it.
 */
const cardSlotFromLocalNormal = (nL) => {
  const n = vec3(nL).toVar();
  const a = n.abs().toVar();
  const useY = a.y.greaterThan(a.x).and(a.y.greaterThanEqual(a.z)).toVar();
  const useZ = useY.not().and(a.z.greaterThan(a.x)).and(a.z.greaterThan(a.y)).toVar();
  const axisN = select(useY, n.y, select(useZ, n.z, n.x)).toVar();
  const axis = select(useY, float(1), select(useZ, float(2), float(0)));
  return axis.mul(2).add(select(axisN.lessThan(0), float(1), float(0))).toVar();
};

/**
 * Object index and card slot out of the packed `bestObj` the objId trace
 * returns (`i*8 + slot`). A miss is -1 and stays negative through the split
 * (`floor(-1/8) = -1`), so a caller's existing `>= 0` gate is unchanged.
 */
export const OBJ_SLOT_STRIDE = 8;

// ══════════════════════════════════════════════════════════ the object set
/**
 * Creates the dynamic-object set bound to one occupancy field build.
 * Adoption KEYS persist across rebuilds in GISystem; this object owns the
 * per-build GPU state (header uniforms, header-sync compute, BVH pool
 * allocator, staged uploads) and the TSL/WGSL trace closures.
 */
export function createDynamicObjectSet({ bits, baseWord, capacityWords, maxObjects, isPromotedEmitter = null }) {
  // ── THE CEILING WAS 64, AND ITS STATED REASON DOES NOT BIND ─────────────
  //
  // "f32-exact card ids" (see writeSurface): the packed value is
  // objectIndex*8 + cardSlot, so MAX = 64 maxes it at 509 — and f32 is exact
  // to 2^24. 512 objects pack to 4095, which is exact by four orders of
  // magnitude. The real cost of a big set is the PER-RAY LOOP (one swept-AABB
  // reject per mover), which is why the tier defaults stay small; a scene that
  // seats more pays more, and one that seats 16 pays exactly what it paid.
  //
  // Raised for the ball pool (2026-09-10): 350 moving spheres could not all be
  // exact movers, so a ball that lost the race kept its STATIC triangles at the
  // authored pose (shadow frozen in place) while one that won was masked OUT of
  // the static BVH (shadow gone). Both symptoms are the cap.
  const MAX = Math.min(512, Math.max(4, maxObjects ?? (Number(globalThis.__giMaxDynamicObjects) || DEFAULT_MAX_OBJECTS)));
  const HEADER_WORDS = dynHeaderWords(MAX);
  const enabled = capacityWords >= HEADER_WORDS;
  const poolWords = Math.max(0, capacityWords - HEADER_WORDS);
  // The mesh (BVH) path only compiles when the pool could actually hold a
  // mesh — the traversal function is real WGSL in EVERY trace kernel, and
  // compiling it for a pool that can't fit a single BVH is pure boot cost.
  const poolCapacity = poolWords >= 1024 ? poolWords : 0;
  const arity = dynBvhArity();
  const bvhTraceWgsl = arity === 8 ? bvh8TraceWgsl : bvh4TraceWgsl;

  // CPU mirror of the header words + its uniform staging (vec4-packed).
  const mirror = new Float32Array(HEADER_WORDS);
  const headerVecCount = Math.ceil(HEADER_WORDS / 4);
  const headerUniform = uniformArray(
    Array.from({ length: headerVecCount }, () => new THREE.Vector4()),
    "vec4",
  );
  let headerDirty = true;

  // The static-BVH slot-disable mask travels as RAW u32 — it must not ride
  // the float header path (arbitrary bit patterns include NaNs, which float
  // plumbing may canonicalize into corrupted masks).
  const staticMaskUniform = uniformArray(new Array(STATIC_MASK_WORDS).fill(0), "uint");

  // ── THE STATIC BVH'S BASES ARE RUNTIME UNIFORMS, NOT COMPILE-TIME LITERALS.
  //
  // These used to be passed to the traversal as `uint(info.nodeBase)` /
  // `uint(info.triBase)`, which are CONSTANT nodes: three bakes them into the
  // WGSL as literals when the shadow kernel is compiled, once, at GI build
  // time. `attachStaticBvh` then repointed them at runtime — and nothing
  // recompiled, so the change was invisible to every kernel already built.
  //
  // `nodeBase` is always the region offset and never moves, so this looked
  // harmless for a long time. `triBase` is `nodeBase + packed.nodeWords`, and
  // nodeWords is the BVH's node count: it moves whenever the tree SHAPE
  // changes. So after a debounced rebuild (#maybeRebuildStaticBvh — spawned
  // projectiles, a demoted mover, exiting play mode, any placement add/remove)
  // the kernel traversed the NEW node array at the correct base while fetching
  // triangle vertices from the OLD triangle base. Every leaf test then read
  // whatever words happened to live there, missed, and the sun's GI shadows
  // vanished from the whole scene — permanently, until something forced a full
  // GI rebuild. It was intermittent for exactly one reason: a rebuild whose
  // node count happened to land unchanged left triBase valid and looked fine.
  // (User report 2026-08-16: "gi shadows disappear when scene changes"; the
  // same mechanism is behind the older "shadows break after exiting playmode".)
  //
  // Two uniform reads per traversal — against a 44-deep stack walk, free.
  const staticNodeBaseUniform = uniform(0, "uint");
  const staticTriBaseUniform = uniform(0, "uint");
  // §18.17 — base of the PARALLEL per-triangle UV region (3 packed words per
  // triangle). 0 means "this build has no UV region", and the traversal
  // returns the tile-centre UV there, so a scene that never asked for one is
  // bit-identical to the pre-§18.17 picture.
  const staticUvBaseUniform = uniform(0, "uint");

  // Persistent header-sync compute: uniform vec4s → bitcast f32 words in the
  // bits region (mask words pass through raw). Its own pipeline, 3 bindings —
  // nowhere near any wall.
  const headerCompute = enabled
    ? Fn(() => {
        const w = instanceIndex.toVar();
        const v = headerUniform.element(w.div(4).toInt());
        const c = w.mod(4);
        const f = select(c.equal(uint(0)), v.x,
          select(c.equal(uint(1)), v.y, select(c.equal(uint(2)), v.z, v.w))).toVar();
        const inMask = w.greaterThanEqual(uint(STATIC_MASK_WORD_BASE))
          .and(w.lessThan(uint(STATIC_MASK_WORD_BASE + STATIC_MASK_WORDS)));
        const word = select(
          inMask,
          staticMaskUniform.element(w.sub(uint(STATIC_MASK_WORD_BASE)).toInt()),
          floatBitsToUint(f),
        );
        bits.element(uint(baseWord).add(w)).assign(word);
      })().compute(HEADER_WORDS)
    : null;

  // BVH pool allocator: bump pointer over the region tail, deduped per
  // geometry key (200 shared crates = one upload). Freed blocks are not
  // recycled within a build — adoption churn is rare and the next full field
  // rebuild resets everything.
  const geoBlocks = new Map();
  let nextWord = HEADER_WORDS;
  let gridRefitFrame = 0;
  const pendingComputes = [];
  // Persistent re-uploadable regions (createRegionUploader) — one pipeline
  // each, offered to the dispatcher only on the frames their bytes changed.
  const regionUploaders = [];

  const entries = new Map();
  const slots = new Array(MAX).fill(null);

  const wm = (i, w, v) => { if (mirror[i * OBJ_WORDS + DYN_HEADER_RESERVED + w] !== v) { mirror[i * OBJ_WORDS + DYN_HEADER_RESERVED + w] = v; headerDirty = true; } };
  const objWordBase = (i) => DYN_HEADER_RESERVED + i * OBJ_WORDS;
  // §11.57 cluster table (see dynClusterWords): absolute header words.
  const CLUSTER_BASE = DYN_HEADER_RESERVED + MAX * OBJ_WORDS;
  const MEMBER_BASE = CLUSTER_BASE + 1 + DYN_CLUSTER_MAX * DYN_CLUSTER_STRIDE;
  const wa = (w, v) => { if (mirror[w] !== v) { mirror[w] = v; headerDirty = true; } };
  const clusterItems = [];
  const writeClusterTable = () => {
    clusterItems.length = 0;
    for (let i = 0; i < MAX; i++) {
      if (!slots[i]) continue;
      const b = objWordBase(i);
      if (!(mirror[b + 19] > 0)) continue;
      clusterItems.push({
        slot: i,
        mn: [mirror[b + 24], mirror[b + 25], mirror[b + 26]],
        mx: [mirror[b + 28], mirror[b + 29], mirror[b + 30]],
      });
    }
    const { clusters, members } = clusterMoverBoxes(clusterItems, DYN_CLUSTER_MAX);
    wa(CLUSTER_BASE, clusters.length);
    for (let c = 0; c < DYN_CLUSTER_MAX; c++) {
      const cb = CLUSTER_BASE + 1 + c * DYN_CLUSTER_STRIDE;
      const cl = clusters[c];
      if (cl) {
        wa(cb, cl.mn[0]); wa(cb + 1, cl.mn[1]); wa(cb + 2, cl.mn[2]);
        wa(cb + 3, cl.mx[0]); wa(cb + 4, cl.mx[1]); wa(cb + 5, cl.mx[2]);
        wa(cb + 6, cl.first); wa(cb + 7, cl.count);
      } else {
        for (let k = 0; k < DYN_CLUSTER_STRIDE; k++) wa(cb + k, 0);
      }
    }
    for (let j = 0; j < members.length; j++) wa(MEMBER_BASE + j, members[j]);
    set.stats.clusters = clusters.length;
  };

  const syncHeaderUniform = () => {
    for (let k = 0; k < headerVecCount; k++) {
      headerUniform.array[k].set(
        mirror[k * 4] ?? 0, mirror[k * 4 + 1] ?? 0, mirror[k * 4 + 2] ?? 0, mirror[k * 4 + 3] ?? 0,
      );
    }
  };

  const publishCount = () => {
    let hi = 0;
    for (let i = 0; i < MAX; i++) if (slots[i]) hi = i + 1;
    if (mirror[0] !== hi) { mirror[0] = hi; headerDirty = true; }
  };

  const scratchM = new THREE.Matrix4();
  const scratchInv = new THREE.Matrix4();
  const scratchProxyM = new THREE.Matrix4();
  const scratchV = new THREE.Vector3();

  /**
   * Writes the mover's MEAN albedo/emissive into header words 34..39.
   *
   * `resolveMaterialSurface` is the same resolver the voxel path uses for a
   * slot's mean colour — deliberately, so an adopted mover and its voxel self
   * agree about what colour it is. A second convention here would show up as a
   * hue step every time a mesh crossed the adopt/demote boundary.
   *
   * Returns true when anything changed (caller decides whether to re-sync).
   */
  const writeSurface = (entry) => {
    const mesh = entry.mesh;
    const material = Array.isArray(mesh?.material) ? mesh.material[0] : mesh?.material;
    // PROMOTED EMITTERS MUST NOT SHIP THEIR EMISSIVE HERE — this is the exact
    // counterpart of GISystem's #slotSurface, which zeroes `emissive` for a
    // promoted entry so the voxel field does not re-emit light the analytic
    // emitter slot is already delivering. The exact-dynamic path had no such
    // guard: `writeSurface` published the raw material emissive unconditionally,
    // and giField shades an exact hit as `surf.emissive + albedo*irr`, so an
    // emissive mesh that was BOTH promoted (peak >= 0.5, holds one of the four
    // analytic slots) AND adoption-eligible had its own light counted twice from
    // the moment it first moved — adoption is triggered by first motion, and
    // outside Play it only demotes after ~30s at rest. Stationary: correct.
    // Moving: a step change. Which is the shape of "sometimes emissive looks
    // fine when moving, sometimes lighting jumps all over the place".
    const promoted = isPromotedEmitter?.(mesh) === true;
    // Promotion is part of the stamp: it can flip without the material changing
    // (a brighter emissive elsewhere takes the slot), and the early-out below
    // would otherwise keep publishing the stale emissive forever.
    const stamp = `${material?.id ?? -1}:${material?.version ?? 0}:${promoted ? "P" : "-"}`;
    // ⭐ A PROVISIONAL ANSWER MUST NOT BE CACHED AS A FINAL ONE.
    //
    // `resolveMaterialSurface` multiplies the constant colour by the MEAN of
    // the albedo map, and that mean is not always available on the first ask —
    // a texture still decoding, or a compressed one queued on the GPU averager,
    // both make it answer with the constant factor alone. On Sponza's curtains
    // that constant is `#cacaca`, so the first resolve says "near white" about
    // a scarlet banner.
    //
    // None of the three parts of the stamp above moves when the mean finally
    // lands — a texture average changes no material id, no material version and
    // no promotion — so before this guard the white stuck for the life of the
    // scene while the STATIC palette next to it corrected itself on the next
    // fingerprint scan. Same mesh, two different colours, depending only on
    // whether it had ever moved. (user, 2026-09-11: "it reflects white light
    // for some reason, not taking the color of the cloth".)
    //
    // Re-resolving while pending is a cache probe per mover per frame, and it
    // stops the moment the mean arrives.
    if (entry.surfaceStamp === stamp && entry.surfacePending !== true) return false;
    entry.surfaceStamp = stamp;
    const s = resolveMaterialSurface(mesh?.material, mesh?.name);
    entry.surfacePending = s.pending === true;
    const i = entry.index;
    // Per-proxy override first (see `albedoOverride` in adopt): a bone
    // proxy's colour comes from the skin texture, not the (white) material.
    const o = entry.albedoOverride;
    wm(i, 34, o ? o[0] : (s.color?.r ?? 1));
    wm(i, 35, o ? o[1] : (s.color?.g ?? 1));
    wm(i, 36, o ? o[2] : (s.color?.b ?? 1));
    // Premultiplied: the shading site wants one number, and the voxel bake
    // already folds intensity in the same place.
    const k = promoted ? 0 : (s.emissiveIntensity ?? 1);
    wm(i, 37, (s.emissive?.r ?? 0) * k);
    wm(i, 38, (s.emissive?.g ?? 0) * k);
    wm(i, 39, (s.emissive?.b ?? 0) * k);
    // Diagnostics only — the header mirror is closure-private, and "did the
    // mover's colour actually reach the GPU" is the first question every
    // bounce measurement asks.
    const surface = {
      albedo: o ? [...o] : [s.color?.r ?? 1, s.color?.g ?? 1, s.color?.b ?? 1],
      emissive: [(s.emissive?.r ?? 0) * k, (s.emissive?.g ?? 0) * k, (s.emissive?.b ?? 0) * k],
    };
    // A pending re-probe that resolved to the same numbers is not a change,
    // and must not bill the caller a header re-upload every frame for as long
    // as a texture takes to decode.
    const same = entry.surface &&
      entry.surface.albedo.every((v, n) => v === surface.albedo[n]) &&
      entry.surface.emissive.every((v, n) => v === surface.emissive[n]);
    entry.surface = surface;
    return !same;
  };

  /**
   * Publishes an object's SURFACE-CACHE CARD TABLE base into header word +23 —
   * `buildSurfaceCache`'s `cardTableRel`, a word offset relative to `baseWord`,
   * the same convention the BVH bases in words +20/+21 use. 0 is the "no cards"
   * sentinel (a demoted or not-yet-built object), and word 0 of the region is
   * the object-count word, so it can never be a legal table start.
   *
   * The card WORDS themselves go in through `allocPoolWords` + the existing
   * `queueRegionUpload`; this only publishes where they are.
   */
  const setCardTableAt = (index, cardTableRel) => {
    const rel = Number.isFinite(cardTableRel) ? Math.max(0, Math.trunc(cardTableRel)) : 0;
    wm(index, 23, rel);
  };

  const worldMatrixOf = (entry) => {
    const { mesh, instanceId } = entry;
    // PROXY ENTRIES (skinned bone capsules) are not placed by the mesh's own
    // world matrix — a SkinnedMesh's `matrixWorld` cancels out of the vertex
    // position entirely and the BONES carry the pose. `matrixOf` rebuilds the
    // matrix from live bone transforms; a false return means the segment
    // collapsed this frame, and keeping the previous matrix is strictly better
    // than publishing a zero-scale occluder that blinks out of existence.
    if (entry.matrixOf) {
      entry.matrixOf(scratchProxyM) && entry.proxyMatrix.copy(scratchProxyM);
      return entry.proxyMatrix;
    }
    if (instanceId == null || !mesh.isInstancedMesh) return mesh.matrixWorld;
    mesh.getMatrixAt(instanceId, scratchM);
    scratchM.premultiply(mesh.matrixWorld);
    return scratchM;
  };

  /**
   * The shared trace body. Loops the header's object blocks: broad-phase +
   * analytic OBB slab test; type-2 objects refine through the BVH4. The pen
   * accumulator uses the closest-approach clearance to each bounding box so
   * near-misses fade shadow verdicts continuously — the same band-limit
   * contract the voxel marchers follow (WIDTH only, never admission).
   */
  const traceDynBody = (o, d, t0, t1, penK, penW, exclP, meshes, objId, exclN = null) => {
    const rw = (rel) => bits.element(uint(baseWord).add(rel));
    const rf = (rel) => uintBitsToFloat(rw(rel));
    const count = rf(uint(0)).toInt().min(int(MAX)).toVar();
    const bestT = float(1e30).toVar();
    const bestHit = float(0).toVar();
    const bestCode = float(-1).toVar();
    // WHICH object won, AND WHICH SURFACE-CACHE CARD its hit lands on, packed
    // as `i*OBJ_SLOT_STRIDE + slot` (slot 0..5). Rides the return's `pen` slot,
    // which is meaningless in the no-penumbra variant this flag is only ever
    // paired with — cheaper than stealing bits from the oct-packed normal,
    // which every shadow consumer reads.
    //
    // THE SLOT IS PACKED HERE BECAUSE IT CAN ONLY BE COMPUTED HERE. §6.4's
    // lookup indexes the card table by the OBJECT-SPACE normal's argmax, and
    // the object-space normal exists exactly once in the whole pipeline: as
    // `nL`, in this function, BEFORE the covariant transform to world and
    // BEFORE the double-sided flip (the packer's cards face OUTWARD, so the
    // flipped normal would address the opposite card on every back-side hit).
    // See `cardSlotFromLocalNormal`. Exact in f32: MAX ≤ 64 objects ⇒ ≤ 509.
    //
    // Always packed, not gated on the surface cache being on: `dynObj` has
    // exactly ONE consumer (giField's createOccupancySceneTrace), which splits
    // it, and a second trace variant would double this kernel's WGSL for a
    // multiply.
    const bestObj = objId ? float(-1).toVar() : null;
    const penAcc = float(1).toVar();

    // §11.57: the per-object body is one closure, run per member of each
    // cluster the ray crosses (default) or per object (`__giMoverClusters
    // = false`, the flat scan this replaced — a build-time hatch).
    const perObject = ({ i }) => {
      const ob = uint(DYN_HEADER_RESERVED).add(i.toUint().mul(uint(OBJ_WORDS))).toVar();
      const type = rf(ob.add(uint(19))).toVar();
      If(type.greaterThan(0.5), () => {
        const c0 = vec3(rf(ob.add(uint(0))), rf(ob.add(uint(1))), rf(ob.add(uint(2)))).toVar();
        const c1 = vec3(rf(ob.add(uint(4))), rf(ob.add(uint(5))), rf(ob.add(uint(6)))).toVar();
        const c2 = vec3(rf(ob.add(uint(8))), rf(ob.add(uint(9))), rf(ob.add(uint(10)))).toVar();
        const c3 = vec3(rf(ob.add(uint(12))), rf(ob.add(uint(13))), rf(ob.add(uint(14)))).toVar();
        const he = vec3(rf(ob.add(uint(16))), rf(ob.add(uint(17))), rf(ob.add(uint(18)))).toVar();
        // Shape parameters (sphere r / capsule r+halfSeg / frustum radii+hh) —
        // read once, used by both the pen clearance and the analytic branch.
        const prm = vec3(rf(ob.add(uint(31))), rf(ob.add(uint(32))), rf(ob.add(uint(33)))).toVar();
        const roL = c0.mul(o.x).add(c1.mul(o.y)).add(c2.mul(o.z)).add(c3).toVar();
        // NOT normalized — preserves the world ray parameter exactly.
        const rdL = c0.mul(d.x).add(c1.mul(d.y)).add(c2.mul(d.z)).toVar();
        const nz = (c) => select(c.abs().lessThan(1e-9), select(c.greaterThanEqual(0), float(1e-9), float(-1e-9)), c);
        const inv = vec3(float(1).div(nz(rdL.x)), float(1).div(nz(rdL.y)), float(1).div(nz(rdL.z))).toVar();
        const tA = he.negate().sub(roL).mul(inv).toVar();
        const tB = he.sub(roL).mul(inv).toVar();
        const tn = tA.min(tB).toVar();
        const tf = tA.max(tB).toVar();
        const tEnter = tn.x.max(tn.y).max(tn.z).toVar();
        const tExit = tf.x.min(tf.y).min(tf.z).toVar();

        const scale = rf(ob.add(uint(22))).max(1e-6).toVar();
        // Self-exclusion: skip when the exclude point lies ON this shape's
        // surface. OBB: |d| < 3 cm (an exact adoptee IS the surface, convex,
        // so it can never legitimately shadow itself). §14 Q2 — sphere and
        // capsule join with a SIGNED test, on-or-INSIDE: a bone-capsule proxy
        // is fat, the receiver's true skin sits centimetres inside the shell,
        // and `|d|` would exclude only a hairline band while the whole limb
        // kept grazing its own proxy into dark self-shadow bands. Slack
        // scales with the shape's own radius (floored at the OBB's 3 cm).
        // A DIFFERENT capsule (another limb, another rig) still occludes —
        // the test is per-object, and overlapping joint capsules both contain
        // the joint skin, which is exactly the right admission there.
        const excluded = exclP != null
          ? (() => {
              const exL = c0.mul(exclP.x).add(c1.mul(exclP.y)).add(c2.mul(exclP.z)).add(c3).toVar();
              // EXACT ADOPTEES ARE NOT FAT (2026-09-11). The signed slack
              // below — 15 % of the radius, 6 cm on a 0.4 m ball — exists for
              // bone capsules whose skin sits inside the shell. On an EXACT
              // sphere it excluded the ball from every receiver within 6 cm
              // of its surface: the floor under it and the neighbour it rests
              // on. Those receivers' shadow rays then passed straight through
              // the one sphere that should have blocked them, which lit a
              // ring around every contact — the "white dashed halo" along
              // the lower silhouettes of the ball pool, surviving every bias
              // and upsample change because the trace itself said "lit".
              // With the receiver's NORMAL supplied, a sphere is excluded
              // only when the receiver FACES OUT OF IT (n · (P − C) > 0.5):
              // a receiver on the sphere's own surface, or skin inside a
              // joint sphere. A floor point under a ball faces INTO it and
              // keeps the ball as its occluder. Callers without a normal
              // (transport rays, RTAO) keep the old distance-only test.
              const nL = exclN != null
                ? c0.mul(exclN.x).add(c1.mul(exclN.y)).add(c2.mul(exclN.z)).toVar()
                : null;
              const facesOut = nL != null
                ? exL.dot(nL).div(exL.length().max(1e-6).mul(nL.length().max(1e-6))).greaterThan(0.5)
                : null;
              const qe = exL.abs().sub(he);
              const de = qe.max(vec3(0)).length().add(qe.x.max(qe.y.max(qe.z)).min(0));
              const deSphere = exL.length().sub(prm.x);
              const deCapsule = vec3(
                exL.x,
                exL.y.sub(exL.y.clamp(prm.y.negate(), prm.y)),
                exL.z,
              ).length().sub(prm.x);
              const slackW = prm.x.mul(scale).mul(0.15).max(0.03);
              // §14 round 6: the OBB test went SIGNED (on-or-INSIDE), same
              // reasoning as sphere/capsule below — a skinned flesh box is
              // joint-grown past the vertex span now, so the receiver's skin
              // can sit centimetres INSIDE it, where the old |d| surface
              // band re-admitted the box as its own occluder. `de` is an
              // SDF (negative inside); a classified exact OBB adoptee is
              // unchanged by this — its receivers sit ON the surface, where
              // signed and |d| agree.
              const boxTest = type.lessThan(1.5)
                .and(de.mul(scale).lessThan(0.03));
              const sphereTest = (facesOut != null
                ? type.greaterThan(2.5).and(type.lessThan(3.5)).and(facesOut)
                : type.greaterThan(2.5).and(type.lessThan(3.5)))
                .and(deSphere.mul(scale).lessThan(slackW));
              const capsuleTest = type.greaterThan(3.5).and(type.lessThan(4.5))
                .and(deCapsule.mul(scale).lessThan(slackW));
              return boxTest.or(sphereTest).or(capsuleTest);
            })()
          : null;

        if (penK != null) {
          // Closest-approach clearance through the same r(t) band the
          // marchers use — exact signed distance for spheres/capsules, the
          // bounding box (a conservative superset) for everything else.
          const rdLen2 = rdL.dot(rdL).max(1e-12);
          const tc = roL.negate().dot(rdL).div(rdLen2).clamp(t0, t1).toVar();
          const pL = roL.add(rdL.mul(tc)).toVar();
          const q = pL.abs().sub(he).toVar();
          const dBox = q.max(vec3(0)).length().add(q.x.max(q.y.max(q.z)).min(0));
          const dSphere = pL.length().sub(prm.x);
          const dCapsule = vec3(pL.x, pL.y.sub(pL.y.clamp(prm.y.negate(), prm.y)), pL.z).length().sub(prm.x);
          const dLocal = select(
            type.greaterThan(2.5).and(type.lessThan(3.5)), dSphere,
            select(type.greaterThan(3.5).and(type.lessThan(4.5)), dCapsule, dBox),
          ).toVar();
          const dWorld = dLocal.mul(scale).max(0).toVar();
          const rBand = penW != null
            ? tc.div(penK).max(penW).max(1e-5)
            : tc.div(penK).max(1e-5);
          const penObj = dWorld.div(rBand).clamp(0, 1);
          if (excluded != null) {
            penAcc.assign(penAcc.min(select(excluded, float(1), penObj)));
          } else {
            penAcc.assign(penAcc.min(penObj));
          }
        }

        const enter = tEnter.max(t0).toVar();
        const overlaps = tExit.greaterThanEqual(enter)
          .and(enter.lessThan(t1))
          .and(enter.lessThan(bestT));
        const admitted = excluded != null ? overlaps.and(excluded.not()) : overlaps;
        If(admitted, () => {
          If(type.lessThan(1.5), () => {
            // OBB: hit at the entry face.
            const axis = select(
              tn.x.greaterThanEqual(tn.y).and(tn.x.greaterThanEqual(tn.z)), int(0),
              select(tn.y.greaterThanEqual(tn.z), int(1), int(2)),
            ).toVar();
            const comp = (v) => select(axis.equal(int(0)), v.x, select(axis.equal(int(1)), v.y, v.z));
            const s = comp(rdL).sign().negate().toVar();
            const nW = vec3(comp(c0), comp(c1), comp(c2)).mul(s).normalize().toVar();
            const oct = octEncodeTSL(nW).mul(0.5).add(0.5).toVar();
            bestT.assign(enter);
            // §11.15: a ray born INSIDE the box (its entry is behind the
            // origin) is a hit at tMin whose normal faces the ray — flag it 2
            // so a consumer can tell it from a real front face. See srcBvhTrace.
            bestHit.assign(select(tEnter.lessThan(t0), float(2), float(1)));
            bestCode.assign(oct.x.mul(4095).floor().mul(4096).add(oct.y.mul(4095).floor()));
            // The OBB branch already HAS the card slot: `axis` is the entry
            // face's axis and `s` its outward local sign, which is exactly
            // `argmax |dot(nLocal, ±e_k)|` for an axis-aligned face — no
            // argmax needed, 2 ALU.
            if (objId) {
              bestObj.assign(
                i.toFloat().mul(OBJ_SLOT_STRIDE)
                  .add(axis.toFloat().mul(2))
                  .add(select(s.lessThan(0), float(1), float(0))),
              );
            }
          }).ElseIf(type.lessThan(2.5), () => {
            if (meshes) {
              // Wide-BVH exact-triangle refinement in object-local space
              // (compressed 8-wide by default; `__giDynBvhArity=4` = the
              // uncompressed A/B arm — one arm compiles per build).
              const nodeBase = uint(baseWord).add(rf(ob.add(uint(20))).toUint()).toVar();
              const triBase = uint(baseWord).add(rf(ob.add(uint(21))).toUint()).toVar();
              const r = bvhTraceWgsl(roL, rdL, t0.max(0), t1.min(bestT), nodeBase, triBase, bits).toVar();
              If(r.x.greaterThanEqual(0).and(r.x.lessThan(bestT)), () => {
                const nL = r.yzw.toVar();
                // Covariant normal transform: n_world_i = dot(col_i, n_local).
                const nRaw = vec3(c0.dot(nL), c1.dot(nL), c2.dot(nL)).normalize().toVar();
                // Double-sided: always face back at the ray, matching the DDA
                // face-normal convention every consumer assumes.
                const nW = select(nRaw.dot(d).greaterThan(0), nRaw.negate(), nRaw).toVar();
                const oct = octEncodeTSL(nW).mul(0.5).add(0.5).toVar();
                bestT.assign(r.x);
                // §11.15: the hit flag carries the RAW side — 1 reached from
                // outside, 2 from inside (the normal above is flipped to face
                // the ray, so this is the only place the sign survives).
                bestHit.assign(select(nRaw.dot(d).greaterThan(0), float(2), float(1)));
                bestCode.assign(oct.x.mul(4095).floor().mul(4096).add(oct.y.mul(4095).floor()));
                // `nL`, NOT `nRaw`/`nW`: object space, and before the
                // double-sided flip. The cards face outward.
                if (objId) bestObj.assign(i.toFloat().mul(OBJ_SLOT_STRIDE).add(cardSlotFromLocalNormal(nL)));
              });
            }
          }).Else(() => {
            // ANALYTIC DEFAULT PRIMITIVES (sphere / capsule / frustum) — one
            // shared intersector per shader, exact under any rigid transform
            // + scale (the local-space ray carries it).
            const rs = dynShapeHitFn(roL, rdL, t0, t1.min(bestT), type, prm).toVar();
            If(rs.x.greaterThanEqual(0).and(rs.x.lessThan(bestT)), () => {
              const nL = rs.yzw.toVar();
              const nRaw = vec3(c0.dot(nL), c1.dot(nL), c2.dot(nL)).normalize().toVar();
              const nW = select(nRaw.dot(d).greaterThan(0), nRaw.negate(), nRaw).toVar();
              const oct = octEncodeTSL(nW).mul(0.5).add(0.5).toVar();
              bestT.assign(rs.x);
              // §11.15: 1 outside, 2 inside — see the mesh branch. The sphere
              // intersector's inside case reports the hit AT tMin with the
              // normal facing the ray, so that case is read off the distance.
              bestHit.assign(select(nRaw.dot(d).greaterThan(0).or(rs.x.lessThanEqual(t0)), float(2), float(1)));
              bestCode.assign(oct.x.mul(4095).floor().mul(4096).add(oct.y.mul(4095).floor()));
              // Same rule as the BVH branch: the UNFLIPPED object-space normal.
              if (objId) bestObj.assign(i.toFloat().mul(OBJ_SLOT_STRIDE).add(cardSlotFromLocalNormal(nL)));
            });
          });
        });
      });
    };
    if (globalThis.__giMoverClusters === false) {
      Loop({ start: int(0), end: count, type: "int", condition: "<" }, perObject);
    } else {
      // The group boxes are padded by the penumbra band's widest radius so
      // an object the ray only PASSES NEAR — which still darkens `penAcc` —
      // is never culled away; the pad is zero for a plain hit query.
      const pad = penK != null
        ? (penW != null ? float(t1).div(penK).max(penW) : float(t1).div(penK)).max(0).toVar()
        : float(0);
      const nzW = (c) => select(c.abs().lessThan(1e-9), select(c.greaterThanEqual(0), float(1e-9), float(-1e-9)), c);
      const invW = vec3(float(1).div(nzW(d.x)), float(1).div(nzW(d.y)), float(1).div(nzW(d.z))).toVar();
      const clusterCount = rf(uint(CLUSTER_BASE)).toInt().min(int(DYN_CLUSTER_MAX)).toVar();
      Loop({ start: int(0), end: clusterCount, type: "int", condition: "<" }, ({ i: c }) => {
        const cb = uint(CLUSTER_BASE + 1).add(c.toUint().mul(uint(DYN_CLUSTER_STRIDE))).toVar();
        const mn = vec3(rf(cb), rf(cb.add(uint(1))), rf(cb.add(uint(2)))).sub(pad).toVar();
        const mx = vec3(rf(cb.add(uint(3))), rf(cb.add(uint(4))), rf(cb.add(uint(5)))).add(pad).toVar();
        const tA = mn.sub(o).mul(invW).toVar();
        const tB = mx.sub(o).mul(invW).toVar();
        const tn = tA.min(tB).toVar();
        const tf = tA.max(tB).toVar();
        const tEnter = tn.x.max(tn.y).max(tn.z).max(t0).toVar();
        const tExit = tf.x.min(tf.y).min(tf.z).min(t1).toVar();
        If(tEnter.lessThanEqual(tExit), () => {
          const first = rf(cb.add(uint(6))).toInt().toVar();
          const last = first.add(rf(cb.add(uint(7))).toInt()).toVar();
          Loop({ start: first, end: last, type: "int", condition: "<" }, ({ i: j }) => {
            const idx = rf(uint(MEMBER_BASE).add(j.toUint())).toInt().toVar();
            perObject({ i: idx });
          });
        });
      });
    }

    return vec4(
      bestHit,
      select(bestHit.greaterThan(0.5), bestT, float(-1)),
      objId ? bestObj : penAcc,
      bestCode,
    );
  };

  const set = {
    enabled,
    maxObjects: MAX,
    headerWords: HEADER_WORDS,
    /** Tests only: the CPU header mirror (`tests/gi-mover-clusters`). */
    debugMirror() { return mirror; },
    poolCapacity,
    /** Bumped whenever any adopted transform changed — feeds the wake hash. */
    version: 0,
    /** Diagnostics. */
    stats: { adopted: 0, meshUploadsQueued: 0, poolWordsUsed: 0, overflowRejected: 0 },

    has(key) { return entries.has(key); },
    count() { return entries.size; },
    /** Iterates live entries — the caller must not mutate during iteration
     *  except through release() on a COPIED key list. */
    forEachEntry(fn) { for (const entry of [...entries.values()]) fn(entry); },

    // ═════════════════════════════════════════ static-scene shadow BVH
    /** Info for the world-space static BVH riding this bits buffer. */
    staticBvh: null,

    /**
     * Registers the static-scene BVH region (absolute word offsets).
     *
     * Live for every already-compiled kernel: the bases ride uniforms (see the
     * block above them). Call this only once the words those bases describe
     * are actually on the GPU — the pair is atomic, and a base pointing at a
     * region that still holds the previous build is the same garbage-read as
     * the stale-literal bug this replaced.
     */
    attachStaticBvh({ nodeBase, triBase = 0, uvBase = 0, format = STATIC_BVH_FORMAT_WORLD, base = null }) {
      const selectedFormat = normalizeStaticBvhFormat(format);
      // SBV2 points this uniform at its 16-word header. Legacy retains the
      // historical meaning: the first compressed world-space BVH8 node.
      const rootBase = selectedFormat === STATIC_BVH_FORMAT_PLACEMENT
        ? Number(base ?? nodeBase) >>> 0
        : Number(nodeBase) >>> 0;
      set.staticBvh = { nodeBase: rootBase, triBase, uvBase, format: selectedFormat, base: rootBase };
      staticNodeBaseUniform.value = rootBase;
      staticTriBaseUniform.value = triBase >>> 0;
      staticUvBaseUniform.value = uvBase >>> 0;
    },

    /**
     * Reserves `count` words in the region tail through the SAME bump allocator
     * the BVH pool uses, and returns both offsets the callers need: `rel` (what
     * goes into a header word, relative to `baseWord`) and `abs` (what
     * `queueRegionUpload` takes). Null when the region is full.
     *
     * ONE allocator, deliberately: the surface cache's card tables and the BVH
     * blocks share this region, and a second bump pointer over the same words
     * would overlap silently. Never recycled inside a build — the next full
     * field rebuild resets everything, same as the BVH pool.
     */
    allocPoolWords(count) {
      const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
      if (!enabled || n === 0) return null;
      if (nextWord + n > capacityWords) {
        set.stats.overflowRejected++;
        if (globalThis.__giDynObjectsDebug) {
          console.warn(`[gi] dynamic-objects: pool full (${nextWord}+${n} > ${capacityWords}) — allocation refused`);
        }
        return null;
      }
      const rel = nextWord;
      nextWord += n;
      set.stats.poolWordsUsed = nextWord - HEADER_WORDS;
      return { rel, abs: baseWord + rel, words: n };
    },

    /**
     * Publishes an adopted object's card-table base (header word +23). `key` is
     * the adoption key; returns false when the object is not adopted, which is
     * the normal race after a demotion.
     */
    setCardTable(key, cardTableRel) {
      const entry = entries.get(key);
      if (!entry) return false;
      setCardTableAt(entry.index, cardTableRel);
      return true;
    },

    /**
     * A RE-UPLOADABLE region: reserves `maxWords` and returns a handle whose
     * `write(words)` refreshes it, as often as every frame.
     *
     * `queueRegionUpload` below cannot do this. It builds a fresh staging
     * buffer AND a fresh compute per call, which is a new pipeline per call —
     * fine for a build-time upload, ruinous for anything that tracks a moving
     * object (§12.70 W5: the light tree's records are static words, so a lamp
     * that moves lights from its bake pose until the next full GI rebuild).
     * Here the pipeline and the staging buffer are made ONCE and only the
     * attribute's bytes are re-sent, which is the same contract the header
     * sync above runs on.
     *
     * The handle rides `pendingDispatch`/`confirmDispatch` exactly like the
     * header does: it is offered only while dirty, and the dirty flag clears
     * only once the frame actually dispatched it (a skipped-pipeline frame
     * retries rather than losing the write).
     */
    createRegionUploader(maxWords) {
      const n = Number.isFinite(maxWords) ? Math.max(0, Math.trunc(maxWords)) : 0;
      if (!enabled || n === 0) return null;
      const alloc = set.allocPoolWords(n);
      if (!alloc) return null;
      const staging = instancedArray(new Uint32Array(alloc.words), "uint");
      const compute = Fn(() => {
        bits.element(uint(alloc.abs).add(instanceIndex)).assign(staging.element(instanceIndex));
      })().compute(alloc.words);
      const handle = {
        abs: alloc.abs,
        rel: alloc.rel,
        capacity: alloc.words,
        dirty: false,
        /** false = `words` does not fit; the region keeps its last contents. */
        write(words) {
          if (words.length > alloc.words) return false;
          const array = staging.value.array;
          array.set(words);
          // Zero the tail: a shrinking tree would otherwise leave the previous
          // build's words readable past the new header's extents.
          if (words.length < array.length) array.fill(0, words.length);
          staging.value.needsUpdate = true;
          handle.dirty = true;
          return true;
        },
      };
      regionUploaders.push({ handle, compute });
      return handle;
    },

    /**
     * One-shot upload of arbitrary words into the bits buffer (the static
     * BVH's build/rebuild path — same staging pattern as geometry blocks).
     */
    queueRegionUpload(absWordStart, words) {
      const staging = instancedArray(words, "uint");
      const copy = Fn(() => {
        bits.element(uint(absWordStart).add(instanceIndex)).assign(staging.element(instanceIndex));
      })().compute(words.length);
      const block = { uploaded: false };
      pendingComputes.push({ compute: copy, block });
      return block;
    },

    /** Masks a static slot's triangles out of the shadow BVH (adoption). */
    setStaticMaskBit(slot, on) {
      if (slot < 0 || slot >= STATIC_MASK_WORDS * 32) return;
      const idx = slot >> 5;
      const bit = (1 << (slot & 31)) >>> 0;
      const prev = staticMaskUniform.array[idx] >>> 0;
      const next = on ? (prev | bit) >>> 0 : (prev & ~bit) >>> 0;
      if (next === prev) return;
      staticMaskUniform.array[idx] = next;
      headerDirty = true;
    },

    /** Rebuild support: mask = exactly the given adopted slots. */
    resetStaticMask(slots) {
      for (let i = 0; i < STATIC_MASK_WORDS; i++) staticMaskUniform.array[i] = 0;
      for (const slot of slots ?? []) {
        if (slot >= 0 && slot < STATIC_MASK_WORDS * 32) {
          staticMaskUniform.array[slot >> 5] = (staticMaskUniform.array[slot >> 5] | (1 << (slot & 31))) >>> 0;
        }
      }
      headerDirty = true;
    },

    /**
     * Static-scene hit (masked exact triangles, world space).
     * Returns the packed vec4 node: x = t (< 0 miss), yzw = geometric normal.
     * `anyHit` (the SHADOW default) returns the first blocker found under
     * near-first child ordering instead of the exact nearest — half the work,
     * and visibility is a boolean question. Pass `{ anyHit: false }` where the
     * hit POINT matters (reflection/gather style rays).
     */
    traceStaticBvh(origin, dir, tMin, tMax, { anyHit = globalThis.__giShadowAnyHit !== false } = {}) {
      const info = set.staticBvh;
      if (!info) return null;
      if (info.format === STATIC_BVH_FORMAT_PLACEMENT) {
        // detail=0 preserves the legacy shadow result (t + world normal).
        // The shipped legacy traversal computes the closest blocker even when
        // anyHit is requested; SBV2 deliberately preserves that visible
        // blocker-distance contract.
        return staticPlacementTraceWgsl(
          vec3(origin), vec3(dir), float(tMin), float(tMax),
          staticNodeBaseUniform, uint(baseWord + STATIC_MASK_WORD_BASE), uint(0), bits,
        ).toVar();
      }
      // `info` gates COMPILATION (no BVH ⇒ the arm is not emitted at all); the
      // bases themselves come from the uniforms, so a later rebuild moves them
      // without a recompile.
      return bvh8MaskedTraceWgsl(
        vec3(origin), vec3(dir), float(tMin), float(tMax),
        staticNodeBaseUniform, staticTriBaseUniform,
        uint(baseWord + STATIC_MASK_WORD_BASE), uint(anyHit ? 1 : 0), bits,
      ).toVar();
    },

    /**
     * §17 R7 — closest static hit WITH the winning triangle's occupancy
     * slot AND its interpolated UV (§18.17), for reflection-style rays.
     * Packed vec4: x = t (< 0 miss), y = 12+12-bit octahedral normal,
     * z = 12+12-bit fract(uv), w = slot as an integer-valued float (-1 on
     * miss) — see the wgslFn's own banner. Compiles its own wgslFn —
     * see bvh8ClosestSlotTraceWgsl's header for why the shadow fn's return
     * is not widened instead. Same live base/mask uniforms, so rebuilds
     * repoint it without a recompile exactly like the shadow arm.
     */
    traceStaticBvhSlot(origin, dir, tMin, tMax) {
      const info = set.staticBvh;
      if (!info) return null;
      if (info.format === STATIC_BVH_FORMAT_PLACEMENT) {
        return staticPlacementTraceWgsl(
          vec3(origin), vec3(dir), float(tMin), float(tMax),
          staticNodeBaseUniform, uint(baseWord + STATIC_MASK_WORD_BASE), uint(1), bits,
        ).toVar();
      }
      return bvh8ClosestSlotTraceWgsl(
        vec3(origin), vec3(dir), float(tMin), float(tMax),
        staticNodeBaseUniform, staticTriBaseUniform, staticUvBaseUniform,
        uint(baseWord + STATIC_MASK_WORD_BASE), bits,
      ).toVar();
    },

    /**
     * Adopts a mesh placement. `shape` comes from classifyDynamicShape.
     * Returns false when full / over pool budget (caller keeps the voxel path).
     */
    adopt(key, mesh, instanceId, shape) {
      if (!enabled || entries.has(key)) return entries.has(key);
      let index = -1;
      for (let i = 0; i < MAX; i++) if (!slots[i]) { index = i; break; }
      if (index < 0) return false;
      // A proxy must arrive with a VALID first matrix. `worldMatrixOf` keeps the
      // previous one when `matrixOf` fails, and at adoption there is no previous
      // one — an identity matrix would seat a unit capsule at the world origin,
      // shadowing whatever happens to be standing there. Refusing lets the
      // caller retry on the next frame, by which time the pose has settled.
      if (shape.matrixOf && !shape.matrixOf(scratchProxyM)) return false;

      let geoBlock = null;
      if (shape.type === "mesh") {
        if (shape.gpuGrid) {
          const grid = shape.gpuGrid;
          const geoKey = `gpu-grid:${mesh.geometry.id}`;
          geoBlock = geoBlocks.get(geoKey);
          if (!geoBlock) {
            const gpu = createGpuGridBvh({ bits, absStart: baseWord + nextWord, positionAttribute: grid.positionAttribute, resolution: grid.resolution, corners: grid.corners ?? null, arity });
            if (nextWord + gpu.wordCount > capacityWords) { set.stats.overflowRejected++; return false; }
            geoBlock = { rel: nextWord, nodeWords: gpu.nodeWords, words: gpu.wordCount, refs: 0, uploaded: false, gpu };
            nextWord += gpu.wordCount;
            set.stats.poolWordsUsed = nextWord - HEADER_WORDS;
            geoBlocks.set(geoKey, geoBlock);
          }
        } else {
          const srcPos = mesh.geometry.attributes.position;
          const geoKey = `${mesh.geometry.id}:${srcPos.version ?? 0}`;
          geoBlock = geoBlocks.get(geoKey);
          if (!geoBlock) {
            const packed = buildBvhWords(mesh.geometry, arity);
            if (!packed) return false;
            if (nextWord + packed.words.length > capacityWords) {
              set.stats.overflowRejected++;
              if (globalThis.__giDynObjectsDebug) {
                console.warn(`[gi] dynamic-objects: BVH pool full (${nextWord}+${packed.words.length} > ${capacityWords}) — "${mesh.name}" stays voxelized`);
              }
              return false;
            }
            geoBlock = {
              key: geoKey,
              rel: nextWord,
              nodeWords: packed.nodeWords,
              words: packed.words.length,
              refs: 0,
              uploaded: false,
            };
            nextWord += packed.words.length;
            set.stats.poolWordsUsed = nextWord - HEADER_WORDS;
            geoBlocks.set(geoKey, geoBlock);
            // One-shot staging copy. The staging buffer uploads its INITIAL
            // content (the only upload semantics that need no update-path
            // trust), the compute copies it into the bits region, then both
            // are dropped.
            const staging = instancedArray(packed.words, "uint");
            const absStart = baseWord + geoBlock.rel;
            const copy = Fn(() => {
              bits.element(uint(absStart).add(instanceIndex)).assign(staging.element(instanceIndex));
            })().compute(packed.words.length);
            pendingComputes.push({ compute: copy, block: geoBlock });
            set.stats.meshUploadsQueued++;
          }
        }
        geoBlock.refs++;
      }

      const entry = {
        key, mesh, instanceId, index,
        type: shape.type,
        center: shape.center.clone(),
        halfExtents: shape.halfExtents.clone(),
        geoBlock,
        gpuGrid: shape.gpuGrid ?? null,
        // Optional per-proxy albedo (linear RGB), overriding the material
        // resolver in `writeSurface`. Skinned bone proxies use it: their
        // material's BASE colour is usually white (the character's colour
        // lives in the skin TEXTURE), which made every reflected character
        // a grey mannequin. skinnedProxy's fit samples the texture per bone.
        albedoOverride: Array.isArray(shape.albedo) ? shape.albedo : null,
        // Skinned bone-capsule proxies: `matrixOf(out)` fills `out` from live
        // bone transforms (see skinnedProxy.js). `proxyMatrix` is the entry's
        // OWN storage, because `sync` holds the returned matrix across the
        // frame in `entry.prev` and a shared scratch would alias.
        matrixOf: shape.matrixOf ?? null,
        proxyMatrix: shape.matrixOf ? new THREE.Matrix4().copy(scratchProxyM) : null,
        prev: new THREE.Matrix4().makeScale(0, 0, 0), // sentinel → first sync always writes
        movedFrames: 0,
        prevBounds: new THREE.Box3(),
        currBounds: new THREE.Box3(),
        boundsValid: false,
        published: false,
      };
      slots[index] = entry;
      entries.set(key, entry);
      set.stats.adopted++;

      // Static header fields. A mesh type publishes 0 until its geometry
      // block has actually landed on the GPU — until then the object simply
      // does not exist for rays, which is the safe direction. Analytic types
      // need no upload and publish on the first sync.
      wm(index, 16, entry.halfExtents.x);
      wm(index, 17, entry.halfExtents.y);
      wm(index, 18, entry.halfExtents.z);
      wm(index, 19, 0);
      wm(index, 20, geoBlock ? geoBlock.rel : 0);
      wm(index, 21, geoBlock ? geoBlock.rel + geoBlock.nodeWords : 0);
      // No cards until a surface-cache build says otherwise — a freshly adopted
      // mover shades from the mean albedo, which is the safe direction.
      setCardTableAt(index, 0);
      const prm = shape.params ?? [0, 0, 0];
      wm(index, 31, prm[0] ?? 0);
      wm(index, 32, prm[1] ?? 0);
      wm(index, 33, prm[2] ?? 0);
      writeSurface(entry);
      publishCount();
      if (globalThis.__giDynObjectsDebug) {
        console.log(`[gi] dynamic-objects: adopted "${mesh.name}" as ${shape.type} (slot ${index})`);
      }
      return true;
    },

    release(key) {
      const entry = entries.get(key);
      if (!entry) return;
      if (entry.geoBlock) entry.geoBlock.refs--;
      const base = objWordBase(entry.index);
      mirror.fill(0, base, base + OBJ_WORDS);
      headerDirty = true;
      slots[entry.index] = null;
      entries.delete(key);
      publishCount();
    },

    /**
     * Per-frame transform sync. Reads live matrices, rewrites the header
     * mirror for changed objects, maintains swept bounds. Returns true when
     * anything changed (the caller mixes `version` into the wake hash).
     */
    sync(sweptExpand = 0.5) {
      // Largest per-frame mover translation, metres — consumed by SRC's
      // motion-adaptive α (§12.38) as the occluder half of "is the scene
      // moving". Reset on every path, including the empty ones, or a released
      // last mover would leave the scene reading "moving" forever.
      this.lastMotion = 0;
      if (!enabled) return false;
      if (entries.size === 0) {
        // A released-last-object header still has to reach the GPU, or the
        // stale count resurrects a ghost occluder.
        if (headerDirty) syncHeaderUniform();
        return false;
      }
      let changed = false;
      for (const entry of entries.values()) {
        const i = entry.index;
        const M = worldMatrixOf(entry);
        if (entry.gpuGrid) {
          const sphere = entry.mesh.geometry.boundingSphere;
          const extent = sphere ? sphere.radius + sphere.center.length() : 1;
          entry.halfExtents.setScalar(extent);
          wm(i, 16, extent); wm(i, 17, extent); wm(i, 18, extent);
        }
        const moved = !!entry.gpuGrid || !entry.prev.equals(M);
        if (!moved) entry.restFrames = (entry.restFrames ?? 0) + 1;
        if (moved) {
          entry.restFrames = 0;
          const pe = entry.prev.elements, me = M.elements;
          // Translation, plus rotation expressed as CORNER displacement
          // (basis-column delta × the largest half-extent) — a box spinning in
          // place translates nothing yet re-shadows everything around it, and
          // the rotating-cube arm is this module's named worst case (§12.24).
          const rotDelta = Math.hypot(me[0] - pe[0], me[1] - pe[1], me[2] - pe[2]) *
            Math.max(entry.halfExtents.x, entry.halfExtents.y, entry.halfExtents.z);
          this.lastMotion = Math.max(
            this.lastMotion,
            Math.hypot(me[12] - pe[12], me[13] - pe[13], me[14] - pe[14]) + rotDelta,
          );
          entry.prev.copy(M);
          // obbWorld = M × translate(center): the local box becomes symmetric
          // ±halfExtents around the object-space origin.
          scratchInv.copy(M);
          if (entry.center.lengthSq() > 0) {
            scratchInv.multiply(new THREE.Matrix4().makeTranslation(entry.center.x, entry.center.y, entry.center.z));
          }
          const obbWorld = scratchInv;
          // World AABB of the OBB via the |M| trick.
          const e = obbWorld.elements;
          const cx = e[12], cy = e[13], cz = e[14];
          const hx = entry.halfExtents.x, hy = entry.halfExtents.y, hz = entry.halfExtents.z;
          const ex = Math.abs(e[0]) * hx + Math.abs(e[4]) * hy + Math.abs(e[8]) * hz;
          const ey = Math.abs(e[1]) * hx + Math.abs(e[5]) * hy + Math.abs(e[9]) * hz;
          const ez = Math.abs(e[2]) * hx + Math.abs(e[6]) * hy + Math.abs(e[10]) * hz;
          if (entry.boundsValid) entry.prevBounds.copy(entry.currBounds);
          entry.currBounds.min.set(cx - ex, cy - ey, cz - ez);
          entry.currBounds.max.set(cx + ex, cy + ey, cz + ez);
          if (!entry.boundsValid) { entry.prevBounds.copy(entry.currBounds); entry.boundsValid = true; }

          const scaleMax = Math.max(
            scratchV.set(e[0], e[1], e[2]).length(),
            scratchV.set(e[4], e[5], e[6]).length(),
            scratchV.set(e[8], e[9], e[10]).length(),
          );
          const inv = new THREE.Matrix4().copy(obbWorld).invert();
          const ie = inv.elements; // column-major, exactly the layout the shader reads
          for (let k = 0; k < 16; k++) wm(i, k, ie[k]);
          wm(i, 22, Math.max(scaleMax, 1e-6));

          // Swept bounds: prev ∪ curr, expanded so the neighbouring field
          // cells whose shadowing this object changed drop history too.
          const mnx = Math.min(entry.prevBounds.min.x, entry.currBounds.min.x) - sweptExpand;
          const mny = Math.min(entry.prevBounds.min.y, entry.currBounds.min.y) - sweptExpand;
          const mnz = Math.min(entry.prevBounds.min.z, entry.currBounds.min.z) - sweptExpand;
          const mxx = Math.max(entry.prevBounds.max.x, entry.currBounds.max.x) + sweptExpand;
          const mxy = Math.max(entry.prevBounds.max.y, entry.currBounds.max.y) + sweptExpand;
          const mxz = Math.max(entry.prevBounds.max.z, entry.currBounds.max.z) + sweptExpand;
          wm(i, 24, mnx); wm(i, 25, mny); wm(i, 26, mnz);
          wm(i, 28, mxx); wm(i, 29, mxy); wm(i, 30, mxz);
          // TRANSLATION-SCALED history cut (word 27 carries the EMA retain
          // factor, 0 = inactive). An object ROTATING IN PLACE keeps a
          // near-stationary AABB — cutting history there just re-exposes the
          // receiving lattice's cell steps as visible jumps (the field EMA is
          // what integrates them; user-reported on the rotating cube). A
          // TRANSLATING object genuinely invalidates the cells it sweeps —
          // low retain there prevents ghost trails. The per-axis
          // overlap/union ratio of prev vs curr bounds separates the two:
          // ~1 in-place → factor ~1 (no cut), →0 under fast translation →
          // factor 0.35 (the original invalidation strength).
          const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
          const un = (a0, a1, b0, b1) => Math.max(a1, b1) - Math.min(a0, b0);
          const axisRatio = (a0, a1, b0, b1) => {
            const u = un(a0, a1, b0, b1);
            return u > 1e-6 ? ov(a0, a1, b0, b1) / u : 1;
          };
          const overlap =
            axisRatio(entry.prevBounds.min.x, entry.prevBounds.max.x, entry.currBounds.min.x, entry.currBounds.max.x) *
            axisRatio(entry.prevBounds.min.y, entry.prevBounds.max.y, entry.currBounds.min.y, entry.currBounds.max.y) *
            axisRatio(entry.prevBounds.min.z, entry.prevBounds.max.z, entry.currBounds.min.z, entry.currBounds.max.z);
          wm(i, 27, Math.min(1, 0.35 + 0.65 * overlap));
          entry.movedFrames = 3;
          changed = true;
        } else if (entry.movedFrames > 0) {
          entry.movedFrames--;
          if (entry.movedFrames === 0) { wm(i, 27, 0); changed = true; }
        }
        // Type publishes once the geometry (if any) is on the GPU.
        const ready = entry.type !== "mesh" || entry.geoBlock?.uploaded === true;
        const typeVal = ready ? (DYN_TYPE[entry.type] ?? 0) : 0;
        if (!entry.published && ready) { entry.published = true; }
        wm(i, 19, typeVal);
        // Live material swaps/edits: an adopted mover is excluded from the
        // voxel path's content refresh, so this is the ONLY place its colour
        // can be re-read. Guarded by an id:version stamp — a string compare
        // per mover per frame, against a node-graph walk that is not.
        if (writeSurface(entry)) changed = true;
      }
      // §11.57: the mover clusters follow whatever this sync wrote — the
      // swept boxes at words 24..30 of every PUBLISHED slot (type > 0).
      writeClusterTable();
      if (changed) set.version++;
      if (headerDirty) syncHeaderUniform();
      return changed;
    },

    /**
     * Computes to dispatch this frame (header sync + queued geometry copies).
     * The caller reports back which ones actually ran via confirmDispatch —
     * skipped-pipeline frames just retry next tick.
     */
    gpuGridComputes() { return [...geoBlocks.values()].flatMap(block => block.gpu?.computes ?? []); },

    pendingDispatch() {
      if (!enabled) return [];
      const out = [];
      if (headerDirty && headerCompute) out.push(headerCompute);
      for (const r of regionUploaders) if (r.handle.dirty) out.push(r.compute);
      for (const p of pendingComputes) out.push(p.compute);
      // `__giGridRefitStride = N` (dev, default 1): refit each GPU-grid proxy
      // every Nth frame, round-robin, once it has uploaded — the pricing arm
      // for the per-cloth refit dispatches (one serial thread each).
      const stride = Math.max(1, Math.round(Number(globalThis.__giGridRefitStride) || 1));
      const phase = (gridRefitFrame++) % stride;
      let n = 0;
      for (const entry of entries.values()) {
        const block = entry.geoBlock;
        if (!block?.gpu) continue;
        if (stride > 1 && block.uploaded && (n++ % stride) !== phase) continue;
        out.push(...block.gpu.computes);
      }
      return out;
    },

    /** `skipped` = the giSkippedComputes set after this frame's dispatch. */
    confirmDispatch(skipped) {
      if (headerCompute && headerDirty && !skipped.has(headerCompute)) headerDirty = false;
      for (const r of regionUploaders) {
        if (r.handle.dirty && !skipped.has(r.compute)) r.handle.dirty = false;
      }
      for (let i = pendingComputes.length - 1; i >= 0; i--) {
        const p = pendingComputes[i];
        if (!skipped.has(p.compute)) {
          p.block.uploaded = true;
          pendingComputes.splice(i, 1);
        }
      }
      let gridsReady = true;
      for (const entry of entries.values()) {
        const block = entry.geoBlock;
        if (!block?.gpu) continue;
        const ready = block.gpu.computes.every(compute => !skipped.has(compute));
        if (ready) block.uploaded = true;
        else gridsReady = false;
      }
      // Header is only truly live once geometry states are also published.
      return gridsReady && !headerDirty && pendingComputes.length === 0;
    },

    // ═════════════════════════════════════════════════ GPU: trace closures
    // Everything below closes over `bits` + `baseWord` (per-builder sharedFn
    // bodies, the giFn contract) and reads the header words directly — zero
    // new bindings in any composed kernel.

    _traceVariants: new Map(),

    /**
     * Nearest exact dynamic hit along a ray.
     * Returns { hit, t, pen, normal } nodes. `pen` is an analytic clearance
     * term from each object's bounding OBB through the marchers' own
     * r(t) = max(t/k, penWidth) band — WIDTH ONLY, never admission (the
     * session-28 rule): occlusion verdicts come from the exact shapes alone.
     */
    trace(origin, dir, tMin, tMax, opts = {}) {
      const pen = opts.penumbraK != null;
      const pw = pen && opts.penWidth != null;
      const meshes = opts.meshes !== false && poolCapacity > 0;
      const excl = opts.excludePoint != null;
      // The receiver NORMAL beside the exclude point (see the sphere test in
      // traceDynBody): only meaningful with a point, and its own variant.
      const exclN = excl && opts.excludeNormal != null;
      // `objId` returns the winning object's index in the pen slot. Mutually
      // exclusive with penumbra by construction — they share the slot, and no
      // consumer wants both (penumbra is a shadow-ray term; the index is for
      // shading a transport-ray hit).
      const objId = opts.objId === true && !pen;
      const key = `${pen ? 1 : 0}${pw ? 1 : 0}${meshes ? 1 : 0}${excl ? 1 : 0}${objId ? 1 : 0}${exclN ? 1 : 0}`;
      let fn = set._traceVariants.get(key);
      if (fn === undefined) {
        fn = sharedFn({
          name: `giDynTrace${key}`,
          type: "vec4",
          inputs: [
            { name: "origin", type: "vec3" },
            { name: "dir", type: "vec3" },
            { name: "tMin", type: "float" },
            { name: "tMax", type: "float" },
            ...(pen ? [{ name: "penK", type: "float" }] : []),
            ...(pw ? [{ name: "penW", type: "float" }] : []),
            ...(excl ? [{ name: "excl", type: "vec3" }] : []),
            ...(exclN ? [{ name: "excln", type: "vec3" }] : []),
          ],
          // Trailing-optional positional mapping, same idiom as the hybrid
          // marcher: each optional input occupies the next free seat.
          body: (...params) => {
            const [o, d, t0, t1] = params;
            let seat = 4;
            const penK = pen ? params[seat++] : null;
            const penW = pw ? params[seat++] : null;
            const exclP = excl ? params[seat++] : null;
            const exclNv = exclN ? params[seat++] : null;
            return traceDynBody(o, d, t0, t1, penK, penW, exclP, meshes, objId, exclNv);
          },
        });
        set._traceVariants.set(key, fn);
      }
      const args = [vec3(origin), vec3(dir), float(tMin), float(tMax)];
      if (pen) args.push(float(opts.penumbraK));
      if (pw) args.push(float(opts.penWidth));
      if (excl) args.push(vec3(opts.excludePoint));
      if (exclN) args.push(vec3(opts.excludeNormal));
      const packed = fn(...args).toVar();
      // §11.15: x is 0 miss / 1 hit from outside / 2 hit from INSIDE the
      // mover. `hit` stays the 0/1 every consumer tests; `inside` is the
      // new bit (a ray born inside a skinned capsule — the deposit drops it).
      const hitRaw = packed.x.toVar();
      const hit = select(hitRaw.greaterThan(0.5), float(1), float(0)).toVar();
      const inside = hitRaw.greaterThan(1.5).toVar();
      const t = packed.y.toVar();
      // Shared slot: the pen accumulator, or the PACKED winner
      // (`objIndex*OBJ_SLOT_STRIDE + cardSlot`, < 0 on a miss) when the caller
      // asked for it. Split it with `splitObj` — never index a header with it.
      const penOut = objId ? float(1) : packed.z.toVar();
      const obj = objId ? packed.z.toVar() : null;
      // Oct-packed 2×12-bit world normal (exact in f32); < 0 ⇒ miss.
      const code = packed.w.toVar();
      const oy = code.mod(4096).div(4095).mul(2).sub(1);
      const ox = code.div(4096).floor().div(4095).mul(2).sub(1);
      const normal = select(
        code.lessThan(0),
        vec3(dir).negate(),
        octDecodeTSL(vec2(ox, oy)),
      ).toVar();
      return { hit, t, pen: penOut, normal, obj, inside };
    },

    /**
     * Splits the packed winner `trace({objId: true})` returns into the object
     * index and its SURFACE-CACHE card slot.
     *
     * A miss is -1 and stays negative (`floor(-1/8) = -1`), so the caller's
     * existing `>= 0` gate is unchanged — that is why the pack is a plain
     * multiply rather than a bitfield.
     *
     * @returns {{index: any, slot: any}} both float nodes
     */
    splitObj(packed) {
      const p = float(packed).toVar();
      const index = p.div(OBJ_SLOT_STRIDE).floor().toVar();
      return { index, slot: p.sub(index.mul(OBJ_SLOT_STRIDE)).toVar() };
    },

    /**
     * Forces the next sync to re-publish this entry's surface words. Needed
     * when an `albedoOverride` ARRAY was mutated in place after adoption —
     * skinned per-bone colours resolving late on the GPU (KTX2 textures the
     * fit's CPU sampler could not read) — because `writeSurface`'s stamp
     * only watches the material, not the override's contents.
     */
    touchSurface(key) {
      const entry = entries.get(key);
      if (entry) entry.surfaceStamp = null;
    },

    /**
     * Mean surface of object `idx` (header words 34..39) — the albedo and
     * emissive a transport ray shades an exact dynamic hit with. `idx` is the
     * OBJECT INDEX (i.e. `splitObj(...).index`, not the raw packed value); a
     * negative index reads object 0's words, so callers must gate on the index
     * themselves (a branch they already have, since a static hit needs no
     * lookup).
     */
    surfaceAt(idx) {
      const rf = (rel) => uintBitsToFloat(bits.element(uint(baseWord).add(rel)));
      const ob = uint(DYN_HEADER_RESERVED)
        .add(float(idx).max(0).toUint().min(uint(MAX - 1)).mul(uint(OBJ_WORDS)))
        .toVar();
      return {
        albedo: vec3(rf(ob.add(uint(34))), rf(ob.add(uint(35))), rf(ob.add(uint(36)))).toVar(),
        emissive: vec3(rf(ob.add(uint(37))), rf(ob.add(uint(38))), rf(ob.add(uint(39)))).toVar(),
      };
    },

    /**
     * Everything the SURFACE-CACHE card lookup needs about object `idx`, read
     * in ONE object-block pass (surfaceCacheGpu.js's `createCardRadianceSampler`
     * consumes exactly this):
     *
     *   cardTableRel — word +23, the card-table base relative to `baseWord`
     *                  (0 = no cards → the words 34..39 mean-albedo fallback)
     *   pLocal       — `invWorld · P`, words 0..15. The OBB-CENTRED local space
     *                  the card packer projects in, and the same expression
     *                  `traceDynBody` builds `roL` from.
     *   halfExtents  — words 16..18, what the card's (s, t) normalises against.
     *
     * `idx` is the float index `trace({objId: true})` returns; like
     * `surfaceAt`, a negative index reads object 0, so callers gate on the
     * index themselves.
     */
    cardFrameAt(idx, P) {
      const rf = (rel) => uintBitsToFloat(bits.element(uint(baseWord).add(rel)));
      const ob = uint(DYN_HEADER_RESERVED)
        .add(float(idx).max(0).toUint().min(uint(MAX - 1)).mul(uint(OBJ_WORDS)))
        .toVar();
      const c0 = vec3(rf(ob.add(uint(0))), rf(ob.add(uint(1))), rf(ob.add(uint(2)))).toVar();
      const c1 = vec3(rf(ob.add(uint(4))), rf(ob.add(uint(5))), rf(ob.add(uint(6)))).toVar();
      const c2 = vec3(rf(ob.add(uint(8))), rf(ob.add(uint(9))), rf(ob.add(uint(10)))).toVar();
      const c3 = vec3(rf(ob.add(uint(12))), rf(ob.add(uint(13))), rf(ob.add(uint(14)))).toVar();
      const p = vec3(P).toVar();
      return {
        cardTableRel: rf(ob.add(uint(23))).toVar(),
        pLocal: c0.mul(p.x).add(c1.mul(p.y)).add(c2.mul(p.z)).add(c3).toVar(),
        halfExtents: vec3(rf(ob.add(uint(16))), rf(ob.add(uint(17))), rf(ob.add(uint(18)))).toVar(),
      };
    },

    /**
     * The FORWARD obb-world matrix of object `idx`, as its four columns —
     * local → world, the direction `cardFrameAt` does not go.
     *
     * WHY IT IS COMPUTED RATHER THAN STORED. The header carries M⁻¹ and
     * nothing else (words 0..15), because every existing consumer transforms
     * world → local: the slab test, the BVH ray, the analytic intersectors and
     * the card lookup all start from a world ray. The SURFACE-CACHE LIGHTING
     * PASS (§6.6) is the first consumer that starts from a CARD TEXEL — an
     * (s, t) in object space — and has to get out to world space to light it,
     * and there is no spare object-block word to publish M in (0..39 are all
     * claimed, +23 by the card table itself). So the 3×3 is inverted here:
     * ~30 ALU, ONCE PER TEXEL, not per ray, against a per-texel cost that
     * already contains a trace and a light loop.
     *
     * `ok` is 0 on a singular (zero-scale) matrix — the caller must skip the
     * texel rather than write inf.
     */
    cardWorldAt(idx) {
      const rf = (rel) => uintBitsToFloat(bits.element(uint(baseWord).add(rel)));
      const ob = uint(DYN_HEADER_RESERVED)
        .add(float(idx).max(0).toUint().min(uint(MAX - 1)).mul(uint(OBJ_WORDS)))
        .toVar();
      // Columns of M⁻¹ (column-major, exactly how `traceDynBody` reads them).
      const a0 = vec3(rf(ob.add(uint(0))), rf(ob.add(uint(1))), rf(ob.add(uint(2)))).toVar();
      const a1 = vec3(rf(ob.add(uint(4))), rf(ob.add(uint(5))), rf(ob.add(uint(6)))).toVar();
      const a2 = vec3(rf(ob.add(uint(8))), rf(ob.add(uint(9))), rf(ob.add(uint(10)))).toVar();
      const a3 = vec3(rf(ob.add(uint(12))), rf(ob.add(uint(13))), rf(ob.add(uint(14)))).toVar();
      // Adjugate rows: for A = [a0 a1 a2] (columns), the ROWS of A⁻¹·det are
      // a1×a2, a2×a0, a0×a1.
      const r0 = a1.cross(a2).toVar();
      const r1 = a2.cross(a0).toVar();
      const r2 = a0.cross(a1).toVar();
      const det = a0.dot(r0).toVar();
      const ok = det.abs().greaterThan(1e-20).toVar();
      const inv = float(1).div(select(ok, det, float(1))).toVar();
      // COLUMNS of A⁻¹ are the components of those rows, transposed.
      const c0 = vec3(r0.x, r1.x, r2.x).mul(inv).toVar();
      const c1 = vec3(r0.y, r1.y, r2.y).mul(inv).toVar();
      const c2 = vec3(r0.z, r1.z, r2.z).mul(inv).toVar();
      // p_local = A·p_world + a3  ⇒  p_world = A⁻¹·p_local − A⁻¹·a3.
      const c3 = c0.mul(a3.x).add(c1.mul(a3.y)).add(c2.mul(a3.z)).negate().toVar();
      return {
        c0, c1, c2, c3,
        ok: select(ok, float(1), float(0)).toVar(),
        /** local → world for a POINT. */
        point: (p) => c0.mul(p.x).add(c1.mul(p.y)).add(c2.mul(p.z)).add(c3).toVar(),
        /** local → world for a DIRECTION (no translation, NOT normalized —
         *  its length carries the scale, which the card's ray parameter needs). */
        dir: (d) => c0.mul(d.x).add(c1.mul(d.y)).add(c2.mul(d.z)).toVar(),
      };
    },

    /**
     * Feedback-history invalidation factor at a field cell center: 1 outside
     * every swept region, reduced inside one — the doc's "affected dynamic
     * region: low history weight". Reads the same header words (bits is
     * already bound in the feedback kernel).
     */
    sweptFactorAt(p) {
      const rw = (rel) => bits.element(uint(baseWord).add(rel));
      const rf = (rel) => uintBitsToFloat(rw(rel));
      const count = rf(uint(0)).toInt().min(int(MAX)).toVar();
      const factor = float(1).toVar();
      const pv = vec3(p).toVar();
      Loop({ start: int(0), end: count, type: "int", condition: "<" }, ({ i }) => {
        const ob = uint(DYN_HEADER_RESERVED).add(i.toUint().mul(uint(OBJ_WORDS))).toVar();
        // Word 27 = the object's translation-scaled retain factor (see the
        // sync writer): 0 inactive, ~1 rotating in place (full smoothing —
        // the receiving lattice's steps need the EMA), 0.35 translating fast.
        const fObj = rf(ob.add(uint(27))).toVar();
        const mn = vec3(rf(ob.add(uint(24))), rf(ob.add(uint(25))), rf(ob.add(uint(26)))).toVar();
        const mx = vec3(rf(ob.add(uint(28))), rf(ob.add(uint(29))), rf(ob.add(uint(30)))).toVar();
        const inside = fObj.greaterThan(0.01)
          .and(pv.x.greaterThanEqual(mn.x)).and(pv.y.greaterThanEqual(mn.y)).and(pv.z.greaterThanEqual(mn.z))
          .and(pv.x.lessThanEqual(mx.x)).and(pv.y.lessThanEqual(mx.y)).and(pv.z.lessThanEqual(mx.z));
        factor.assign(select(inside, factor.min(fObj), factor));
      });
      return factor;
    },
  };
  return set;
}

// ═══════════════════════════════════════════════════════ trace composition
/**
 * Wraps the occupancy field's public trace functions so EVERY consumer —
 * cascade transport, field/screen/emitter shadow marches, the debug view —
 * resolves the nearest of (static voxel hit, exact dynamic hit) through one
 * call. The unified-query contract from the doc.
 *
 * `opts.dynamics`: false = static only (the parent-vis prepass, which only
 * re-runs on composite frames and must stay geometry-pure), "obb" = analytic
 * objects only (fragment-shader consumers — the WGSL BVH traversal is
 * compute-only by policy).
 */
export function composeFieldDynamics(field, dyn) {
  if (!dyn?.enabled) return field;

  const mergeHit = (r, o, d, tMin, tMax, opts, hasKind) => {
    const wantPen = opts.penumbraK != null;
    // `dynObj`: the caller wants to know WHICH mover it hit, so it can shade
    // the hit from that object's surface instead of sampling voxel radiance
    // the mover is no longer part of (the transport rays — see giField's
    // createOccupancySceneTrace).
    const wantObj = opts.dynObj === true && !wantPen;
    const dr = dyn.trace(o, d, tMin, tMax, {
      penumbraK: wantPen ? opts.penumbraK : null,
      penWidth: wantPen && opts.penWidth != null ? opts.penWidth : null,
      meshes: opts.dynamics !== "obb",
      excludePoint: opts.excludePoint ?? null,
      excludeNormal: opts.excludeNormal ?? null,
      objId: wantObj,
    });
    const better = dr.hit.greaterThan(0.5)
      .and(float(r.hit).lessThan(0.5).or(dr.t.lessThan(r.t)))
      .toVar();
    const out = { ...r };
    out.hit = select(better, float(1), r.hit).toVar();
    out.t = select(better, dr.t, r.t).toVar();
    if (r.normal != null) out.normal = select(better, dr.normal, r.normal).toVar();
    if (wantPen && r.pen != null) out.pen = float(r.pen).min(dr.pen).toVar();
    // Dynamic hits report as the exact-triangle acceptance class — verdict
    // maps stay honest and the exhaustion gates (kind > 3.5) never fire.
    if (hasKind && r.kind != null) out.kind = select(better, float(2), float(r.kind)).toVar();
    if (wantObj) out.dynObj = select(better, dr.obj, float(-1)).toVar();
    return out;
  };

  const wrap = (name, hasKind) => {
    const base = field[name];
    if (!base) return;
    field[name] = (o, d, tMin, tMax, opts = {}) => {
      const r = base(o, d, tMin, tMax, opts);
      if (opts.dynamics === false) return r;
      return mergeHit(r, o, d, tMin, tMax, opts, hasKind);
    };
  };
  wrap("traceOccupancy", false);
  wrap("traceHybridBrick", false);
  wrap("traceHybridPlane", true);
  // traceOccupancyCone (the legacy density-cone arm) is deliberately not
  // composed: it is an opt-in A/B arm, and its transmittance contract has no
  // nearest-hit to merge — the analytic-width default path covers dynamics.
  field.dynamicObjects = dyn;
  return field;
}
