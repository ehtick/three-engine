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
//   mesh.userData.giDynamic       → override: "voxel" | "bvh" | "obb"
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
//   16 + i*40    per-object block, OBJ_WORDS = 40:
//     +0..15     inverse OBB world matrix, column-major (obbWorld⁻¹ where
//                obbWorld = mesh.matrixWorld × translate(localBoxCenter))
//     +16..18    local half extents
//     +19        type: 0 inactive · 1 OBB · 2 BVH mesh · 3 sphere ·
//                4 capsule · 5 conical frustum (DYN_TYPE)
//     +20        BVH node base (word offset relative to baseWord)
//     +21        BVH triangle base (relative)
//     +22        max world scale factor (local→world distance approximation)
//     +23        reserved
//     +24..26    swept-bounds world min (prev ∪ curr, pre-expanded)
//     +27        swept retain factor: 0 = inactive · else the EMA retain
//                scale for cells inside (translation-scaled — ~1 rotating
//                in place, 0.35 translating fast)
//     +28..30    swept-bounds world max
//     +31..33    shape params: sphere [r,-,-] · capsule [r, halfSeg,-] ·
//                frustum [rBottom, rTop, halfHeight]
//     +34..39    reserved (albedo/emissive — phase 2 material evaluation)
//   HEADER_WORDS = 16 + maxObjects*40, then the BVH pool.
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
import { MeshBVH } from "three-mesh-bvh";
import {
  Fn, If, Loop, float, floatBitsToUint, instanceIndex, instancedArray, int,
  select, uint, uintBitsToFloat, uniformArray, vec2, vec3, vec4, wgslFn,
} from "three/tsl";
import { sharedFn } from "./giFn.js";
import { octDecodeTSL, octEncodeTSL } from "./rayHit/rayHitTSL.js";

export const OBJ_WORDS = 40;
// Header words 0..15: count + reserved. Words 16..31: the STATIC-BVH
// slot-disable mask (512 slots, raw u32 — adopted movers' static triangles
// are masked out of the shadow BVH live). 32..47: reserved. Object blocks
// follow.
export const DYN_HEADER_RESERVED = 48;
export const STATIC_MASK_WORD_BASE = 16;
export const STATIC_MASK_WORDS = 16;
const DEFAULT_MAX_OBJECTS = 16;

/** Header words for a given object capacity. */
export function dynHeaderWords(maxObjects = DEFAULT_MAX_OBJECTS) {
  return DYN_HEADER_RESERVED + maxObjects * OBJ_WORDS;
}

// ═══════════════════════════════════════════════════════ CPU: classification
/** Shape type codes as stored in the header's type word. */
export const DYN_TYPE = { obb: 1, mesh: 2, sphere: 3, capsule: 4, frustum: 5 };

const TWO_PI = Math.PI * 2;
const fullSweep = (v, target) => Math.abs((v ?? target) - target) < 1e-3;

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
 *   · `mesh.userData.giDynamic` overrides: "voxel" (never adopt — keep the
 *     voxel path), "bvh" (force triangles), "obb" (force the bounding box).
 */
export function classifyDynamicShape(mesh) {
  if (!mesh?.geometry) return null;
  const tag = mesh.userData?.giDynamic;
  // "static" is the user-facing pin (never adopt); "voxel" is its legacy
  // alias. "dynamic" pins ADOPTION EAGERNESS (GISystem adopts at load, no
  // motion needed) but classifies by geometry like auto.
  if (tag === "static" || tag === "voxel" || tag === "none" || tag === false) return null;
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
export function buildBvhWords(geometry, arity = 8, triSlotOf = null) {
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
  const bvh = new MeshBVH(geom, { maxLeafTris: 8, indirect: false });
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
  const words = new Uint32Array(nodeWords + triCount * TRI_WORDS);
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
  geom.dispose();
  return { words, nodeWords, triWords: triCount * TRI_WORDS, triCount, arity };
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
export function buildStaticSceneBvhWords(items) {
  let triTotal = 0;
  for (const it of items) {
    triTotal += Math.floor((it.index ? it.index.length : it.positions.length / 3) / 3);
  }
  if (triTotal < 1) return null;
  const soup = new Float32Array(triTotal * 9);
  const triSlot = new Uint32Array(triTotal);
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
  const packed = buildBvhWords(geom, 8, (origTri) => triSlot[origTri]);
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

// STATIC-SCENE traversal: identical to giDynBvh8 except stride-10 triangles
// whose 10th word is an occupancy-slot id checked against a 512-bit disable
// mask (adopted movers' static copies are masked out live). Compiled ONLY
// into the shadow kernels that carry the static-BVH arm.
const bvh8MaskedTraceWgsl = wgslFn(/* wgsl */ `

	fn giStaticBvh8(
		roL: vec3f, rdL: vec3f, tMin: f32, tMax: f32,
		nodeBase: u32, triBase: u32, maskBase: u32,
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

// ══════════════════════════════════════════════════════════ the object set
/**
 * Creates the dynamic-object set bound to one occupancy field build.
 * Adoption KEYS persist across rebuilds in GISystem; this object owns the
 * per-build GPU state (header uniforms, header-sync compute, BVH pool
 * allocator, staged uploads) and the TSL/WGSL trace closures.
 */
export function createDynamicObjectSet({ bits, baseWord, capacityWords, maxObjects }) {
  const MAX = Math.min(64, Math.max(4, maxObjects ?? (Number(globalThis.__giMaxDynamicObjects) || DEFAULT_MAX_OBJECTS)));
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
  const pendingComputes = [];

  const entries = new Map();
  const slots = new Array(MAX).fill(null);

  const wm = (i, w, v) => { if (mirror[i * OBJ_WORDS + DYN_HEADER_RESERVED + w] !== v) { mirror[i * OBJ_WORDS + DYN_HEADER_RESERVED + w] = v; headerDirty = true; } };
  const objWordBase = (i) => DYN_HEADER_RESERVED + i * OBJ_WORDS;

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
  const scratchV = new THREE.Vector3();

  const worldMatrixOf = (entry) => {
    const { mesh, instanceId } = entry;
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
  const traceDynBody = (o, d, t0, t1, penK, penW, exclP, meshes) => {
    const rw = (rel) => bits.element(uint(baseWord).add(rel));
    const rf = (rel) => uintBitsToFloat(rw(rel));
    const count = rf(uint(0)).toInt().min(int(MAX)).toVar();
    const bestT = float(1e30).toVar();
    const bestHit = float(0).toVar();
    const bestCode = float(-1).toVar();
    const penAcc = float(1).toVar();

    Loop({ start: int(0), end: count, type: "int", condition: "<" }, ({ i }) => {
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
        // Self-exclusion (OBB only — convex, so the exact receiver surface
        // can never legitimately shadow itself): skip when the exclude point
        // lies ON this box's surface.
        const excluded = exclP != null
          ? (() => {
              const exL = c0.mul(exclP.x).add(c1.mul(exclP.y)).add(c2.mul(exclP.z)).add(c3);
              const qe = exL.abs().sub(he);
              const de = qe.max(vec3(0)).length().add(qe.x.max(qe.y.max(qe.z)).min(0));
              return type.lessThan(1.5).and(de.mul(scale).abs().lessThan(0.03));
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
            bestHit.assign(1);
            bestCode.assign(oct.x.mul(4095).floor().mul(4096).add(oct.y.mul(4095).floor()));
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
                bestHit.assign(1);
                bestCode.assign(oct.x.mul(4095).floor().mul(4096).add(oct.y.mul(4095).floor()));
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
              bestHit.assign(1);
              bestCode.assign(oct.x.mul(4095).floor().mul(4096).add(oct.y.mul(4095).floor()));
            });
          });
        });
      });
    });

    return vec4(
      bestHit,
      select(bestHit.greaterThan(0.5), bestT, float(-1)),
      penAcc,
      bestCode,
    );
  };

  const set = {
    enabled,
    maxObjects: MAX,
    headerWords: HEADER_WORDS,
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

    /** Registers the static-scene BVH region (absolute word offsets). */
    attachStaticBvh({ nodeBase, triBase }) {
      set.staticBvh = { nodeBase, triBase };
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
     * Nearest static-scene hit (masked exact triangles, world space).
     * Returns the packed vec4 node: x = t (< 0 miss), yzw = geometric normal.
     */
    traceStaticBvh(origin, dir, tMin, tMax) {
      const info = set.staticBvh;
      if (!info) return null;
      return bvh8MaskedTraceWgsl(
        vec3(origin), vec3(dir), float(tMin), float(tMax),
        uint(info.nodeBase), uint(info.triBase),
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

      let geoBlock = null;
      if (shape.type === "mesh") {
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
        geoBlock.refs++;
      }

      const entry = {
        key, mesh, instanceId, index,
        type: shape.type,
        center: shape.center.clone(),
        halfExtents: shape.halfExtents.clone(),
        geoBlock,
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
      const prm = shape.params ?? [0, 0, 0];
      wm(index, 31, prm[0] ?? 0);
      wm(index, 32, prm[1] ?? 0);
      wm(index, 33, prm[2] ?? 0);
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
        const moved = !entry.prev.equals(M);
        if (!moved) entry.restFrames = (entry.restFrames ?? 0) + 1;
        if (moved) {
          entry.restFrames = 0;
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
      }
      if (changed) set.version++;
      if (headerDirty) syncHeaderUniform();
      return changed;
    },

    /**
     * Computes to dispatch this frame (header sync + queued geometry copies).
     * The caller reports back which ones actually ran via confirmDispatch —
     * skipped-pipeline frames just retry next tick.
     */
    pendingDispatch() {
      if (!enabled) return [];
      const out = [];
      if (headerDirty && headerCompute) out.push(headerCompute);
      for (const p of pendingComputes) out.push(p.compute);
      return out;
    },

    /** `skipped` = the giSkippedComputes set after this frame's dispatch. */
    confirmDispatch(skipped) {
      if (headerCompute && headerDirty && !skipped.has(headerCompute)) headerDirty = false;
      for (let i = pendingComputes.length - 1; i >= 0; i--) {
        const p = pendingComputes[i];
        if (!skipped.has(p.compute)) {
          p.block.uploaded = true;
          pendingComputes.splice(i, 1);
        }
      }
      // Header is only truly live once geometry states are also published.
      return !headerDirty && pendingComputes.length === 0;
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
      const key = `${pen ? 1 : 0}${pw ? 1 : 0}${meshes ? 1 : 0}${excl ? 1 : 0}`;
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
          ],
          // Trailing-optional positional mapping, same idiom as the hybrid
          // marcher: each optional input occupies the next free seat.
          body: (...params) => {
            const [o, d, t0, t1] = params;
            let seat = 4;
            const penK = pen ? params[seat++] : null;
            const penW = pw ? params[seat++] : null;
            const exclP = excl ? params[seat++] : null;
            return traceDynBody(o, d, t0, t1, penK, penW, exclP, meshes);
          },
        });
        set._traceVariants.set(key, fn);
      }
      const args = [vec3(origin), vec3(dir), float(tMin), float(tMax)];
      if (pen) args.push(float(opts.penumbraK));
      if (pw) args.push(float(opts.penWidth));
      if (excl) args.push(vec3(opts.excludePoint));
      const packed = fn(...args).toVar();
      const hit = packed.x.toVar();
      const t = packed.y.toVar();
      const penOut = packed.z.toVar();
      // Oct-packed 2×12-bit world normal (exact in f32); < 0 ⇒ miss.
      const code = packed.w.toVar();
      const oy = code.mod(4096).div(4095).mul(2).sub(1);
      const ox = code.div(4096).floor().div(4095).mul(2).sub(1);
      const normal = select(
        code.lessThan(0),
        vec3(dir).negate(),
        octDecodeTSL(vec2(ox, oy)),
      ).toVar();
      return { hit, t, pen: penOut, normal };
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
    const dr = dyn.trace(o, d, tMin, tMax, {
      penumbraK: wantPen ? opts.penumbraK : null,
      penWidth: wantPen && opts.penWidth != null ? opts.penWidth : null,
      meshes: opts.dynamics !== "obb",
      excludePoint: opts.excludePoint ?? null,
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
