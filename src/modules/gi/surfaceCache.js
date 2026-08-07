// SURFACE RADIANCE CACHE — the CPU half (docs/GI_NEXT_ARCHITECTURE.md §6.2/§6.3/§6.7).
//
// Cards, not UVs. Each cached object gets K orthographic CARDS: a projection
// of the object onto one axis-aligned plane in OBJECT space, rasterized into a
// shared atlas rect. The hot-path lookup needs only the object's inverse world
// matrix and its half extents — header words 0..15 and 16..18, both already
// loaded for the slab test — so there is no mesh UV attribute, no per-triangle
// attribute fetch and no index indirection in the trace kernel.
//
// THIS FILE IS CPU ONLY. It builds and packs; it binds nothing, allocates no
// texture and imports no TSL. The GPU half (atlas textures, the card-lighting
// dispatch, the trace-side lookup) is a separate change.
//
// ══ WHERE THE DATA LIVES ══
//
// The card table rides the SAME reserved tail of the occupancy `bits` buffer
// that `OBJ_WORDS` and the BVH pool already use (`dynamicObjectWordOffset`),
// for the same reason: the composed kernels sit exactly at the portable
// 8-storage-buffer stage limit, so anything the trace must read has to arrive
// through a binding it already holds. Zero new storage bindings.
//
//   object block word +23  → card-table base, a word offset RELATIVE to
//                            `baseWord`, exactly like words +20/+21 carry the
//                            BVH node/triangle bases. 0 = "no cards" (word 0
//                            of the region is the object-count word, never a
//                            legal table start), which is also the sentinel
//                            words +20/+21 already use.
//
// VERIFIED FREE, 2026-08-07: word +23 is written by nothing — `wm(i, w, …)`
// in `dynamicObjects.js` covers 0..22, 24..39 and never 23 — and read by
// nothing: every `rf(ob.add(uint(N)))` in the tree uses N ∈ {0..18, 19..22,
// 24..39}. The layout comment already calls it "reserved".
//
// ══ THE TABLE ══
//
// 8 words per card — [u0, v0, du, dv, axis|sign, resU|resV, objIdx, flags] —
// 6 slots per layer, so 48 words per object at one layer, which is the figure
// §6.3 quotes. u0/v0/du/dv are f32 bitcast into the u32 word (the BVH pool's
// convention: one Uint32Array with a Float32Array view over it); the other
// four are raw u32 bitfields.
//
// FIXED STRIDE, ACTIVE FLAG. §6.2's table says "plane: 2 cards", but §6.4's
// lookup indexes the table by `argmax |dot(nLocal, ±e_k)|` — a slot index
// computed from the normal alone. A variable-length table cannot be indexed
// that way. So the table is ALWAYS 6 slots per layer and a plane simply marks
// four of them inactive (flags bit 0 clear, no atlas rect allocated): 2 cards
// of atlas memory, 6 slots of constant-stride indexing. A hit landing in an
// inactive slot falls back to the header mean albedo, which is exactly what a
// demoted object does too, so there is one fallback, not two.
import { DYN_HEADER_RESERVED, OBJ_WORDS } from "./dynamicObjects.js";

/** Words per card record. */
export const CARD_WORDS = 8;
/** Card slots per layer: 3 axes × 2 signs. Fixed — see the header note. */
export const CARD_SLOTS = 6;
/** Object-block word that carries the card-table base (relative to baseWord). */
export const CARD_TABLE_WORD = 23;
/** Atlas edge in texels. §6.3 says start at 2048². */
export const SRC_ATLAS_SIZE = 2048;
/** Degrade ladder, in the shape `dynamicObjectWords` already tiers. */
export const SRC_ATLAS_TIERS = [2048, 1024, 512];
/**
 * Screen-projection constant in `res = clamp(round(k·worldSize/distance), 8, 128)`.
 * 480 is the value that reproduces BOTH worked examples in §6.2: a 1 m crate at
 * 30 m → 16², the same crate at 2 m → 240 → clamped to 128².
 */
export const SRC_CARD_K = 480;
export const CARD_RES_MIN = 8;
export const CARD_RES_MAX = 128;

/** flags word bitfield. */
export const CARD_FLAG = {
  active: 1 << 0,
  /** Analytic shape (sphere/capsule/frustum/OBB): convex by construction. */
  analytic: 1 << 1,
  /** A perpendicular half extent collapsed — the projection has no area. */
  degenerate: 1 << 2,
};

/** Below this fraction of true surface area seen by the cards, demote (§6.7). */
export const SRC_CONCAVE_THRESHOLD = 0.65;

const EPS = 1e-9;

// ═══════════════════════════════════════════════════════════ small utilities

/** Byte cost of the three rgba16f atlases at a given edge (§6.3's memory row). */
export function atlasBytes(size) {
  return 3 * size * size * 8;
}

/** Largest tier whose three rgba16f atlases fit a byte budget. */
export function atlasTierForBudget(budgetBytes) {
  for (const size of SRC_ATLAS_TIERS) if (atlasBytes(size) <= budgetBytes) return size;
  return SRC_ATLAS_TIERS[SRC_ATLAS_TIERS.length - 1];
}

/**
 * The absolute word (relative to the dynamic region's `baseWord`) holding an
 * object's card-table base. Derived from the REAL layout constants so a change
 * to `OBJ_WORDS` cannot silently desync this file.
 */
export function cardTableWordOffset(objIndex) {
  return DYN_HEADER_RESERVED + objIndex * OBJ_WORDS + CARD_TABLE_WORD;
}

/** §6.2's screen-projected resolution, verbatim. */
export function cardResolution(worldSize, distance, k = SRC_CARD_K) {
  const d = Math.max(distance, 1e-3);
  const r = Math.round((k * Math.max(worldSize, 0)) / d);
  return Math.min(CARD_RES_MAX, Math.max(CARD_RES_MIN, r || CARD_RES_MIN));
}

/**
 * §6.4's card choice: `axis = argmax |dot(nLocal, ±e_k)|`, then the sign.
 * Returns the slot index within a layer, 0..5 — `axis*2 + (n[axis] < 0)`.
 */
export function cardSlotFor(nx, ny, nz) {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  let axis = 0;
  let v = nx;
  if (ay > ax && ay >= az) { axis = 1; v = ny; }
  else if (az > ax && az > ay) { axis = 2; v = nz; }
  return axis * 2 + (v < 0 ? 1 : 0);
}

/** The (axis, sign) a slot index encodes. */
export function slotAxisSign(slot) {
  return { axis: (slot / 2) | 0, sign: slot % 2 === 0 ? 1 : -1 };
}

/**
 * Depth-peel layer count. §6.2 offers `__giSrcCards` "to raise" the 6 cards of
 * a BVH mesh, but there is nowhere to put a 7th DIRECTION: word 4 encodes
 * axis|sign (6 states) and §6.4's argmax is over the 3 axis-aligned axes only.
 * So a raise can only mean more cards in the SAME six directions — depth-peel
 * layers, which is also the only thing that addresses the concave failure mode
 * the table cites it beside. 1 (default) … 4.
 */
export function cardLayerCount(mesh) {
  const raw = mesh?.userData?.giSrcCards ?? globalThis.__giSrcCards;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  // Accept either a layer count (1..4) or a total card count (a multiple of 6).
  const layers = n >= CARD_SLOTS ? Math.round(n / CARD_SLOTS) : Math.round(n);
  return Math.min(4, Math.max(1, layers));
}

// ═════════════════════════════════════════════════════════════ the card plan

/**
 * Which of the 6 slots get an atlas rect, from `classifyDynamicShape`'s
 * EXISTING taxonomy (`shape.type` ∈ obb | sphere | capsule | frustum | mesh).
 *
 *   obb            6 — or 2 when a half extent is zero: a zero-thickness OBB
 *                      IS the exact rectangle, and its other four projections
 *                      have no area at all.
 *   sphere/capsule/frustum   6, convex by construction
 *   mesh           6 (× `cardLayerCount` layers)
 */
export function cardPlan(shape, mesh = null) {
  if (!shape) return null;
  const he = [shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z];
  const maxHe = Math.max(he[0], he[1], he[2], EPS);
  const flat = he.map((h) => h <= maxHe * 1e-4);
  const analytic = shape.type !== "mesh";
  const layers = shape.type === "mesh" ? cardLayerCount(mesh) : 1;
  const slots = [];
  for (let slot = 0; slot < CARD_SLOTS; slot++) {
    const { axis, sign } = slotAxisSign(slot);
    const ia = (axis + 1) % 3;
    const ib = (axis + 2) % 3;
    // A card whose own PERPENDICULAR axes are non-degenerate has area. A card
    // along a collapsed axis (the plane's own normal) is the good one; a card
    // across it projects the plane edge-on into nothing.
    const degenerate = flat[ia] || flat[ib];
    slots.push({ slot, axis, sign, ia, ib, active: !degenerate, degenerate, analytic });
  }
  const activeSlots = slots.filter((s) => s.active).length;
  return { type: shape.type, analytic, layers, slots, activeSlots, halfExtents: he, flat };
}

// ══════════════════════════════════════════════════════ project / unproject

/**
 * Forward map, §6.4. `pLocal` is in the header's OBB-CENTERED local space —
 * the space `invWorld · P` produces, i.e. geometry-local minus `shape.center`.
 * Returns the atlas uv plus the normalised card-space (s, t) and depth.
 *
 * depth is object-space, 0 at the card's near plane and 1 at the far one, which
 * is the channel `srcGeometry.b` carries.
 */
export function cardProject(card, px, py, pz, he) {
  const p = [px, py, pz];
  const a = card.axis, sgn = card.sign;
  const ia = (a + 1) % 3, ib = (a + 2) % 3;
  const hu = Math.max(he[ia], EPS), hv = Math.max(he[ib], EPS), hd = Math.max(he[a], EPS);
  const s = ((p[ia] * sgn) / hu + 1) * 0.5;
  const t = (p[ib] / hv + 1) * 0.5;
  const depth = (hd - p[a] * sgn) / (2 * hd);
  return { s, t, depth, u: card.u0 + s * card.du, v: card.v0 + t * card.dv };
}

/** Exact inverse of `cardProject`. */
export function cardUnproject(card, u, v, depth, he) {
  const a = card.axis, sgn = card.sign;
  const ia = (a + 1) % 3, ib = (a + 2) % 3;
  const hu = Math.max(he[ia], EPS), hv = Math.max(he[ib], EPS), hd = Math.max(he[a], EPS);
  const s = card.du > EPS ? (u - card.u0) / card.du : 0.5;
  const t = card.dv > EPS ? (v - card.v0) / card.dv : 0.5;
  const p = [0, 0, 0];
  p[ia] = (s * 2 - 1) * hu * sgn;
  p[ib] = (t * 2 - 1) * hv;
  p[a] = (1 - depth * 2) * hd * sgn;
  return p;
}

/** Snaps an atlas uv to its texel centre, the way a texture fetch does. */
export function snapToTexel(card, u, v) {
  const i = Math.min(card.resU - 1, Math.max(0, Math.floor(((u - card.u0) / card.du) * card.resU)));
  const j = Math.min(card.resV - 1, Math.max(0, Math.floor(((v - card.v0) / card.dv) * card.resV)));
  return {
    i, j,
    u: card.u0 + ((i + 0.5) / card.resU) * card.du,
    v: card.v0 + ((j + 0.5) / card.resV) * card.dv,
  };
}

// ═══════════════════════════════════════════════════════════ atlas allocator

/**
 * Shelf allocator over a square atlas. Non-overlapping by construction: a
 * shelf owns a horizontal band and hands out left-to-right, and every rect is
 * inflated by `padding` on all four sides so bilinear filtering — the whole
 * reason cards beat the trilinear voxel read (§6.4) — cannot reach across a
 * card boundary into a neighbour's texels.
 */
export function createCardAtlas({ size = SRC_ATLAS_SIZE, padding = 1 } = {}) {
  const shelves = [];
  let top = 0;
  let usedTexels = 0;
  let rejected = 0;
  return {
    size,
    padding,
    /** @returns {{x:number,y:number,w:number,h:number}|null} interior rect, texels */
    alloc(w, h) {
      const aw = w + padding * 2;
      const ah = h + padding * 2;
      if (w <= 0 || h <= 0 || aw > size || ah > size) { rejected++; return null; }
      let best = null;
      for (const sh of shelves) {
        if (sh.h < ah || sh.x + aw > size) continue;
        if (!best || sh.h - ah < best.h - ah) best = sh;
      }
      if (best) {
        const rect = { x: best.x + padding, y: best.y + padding, w, h };
        best.x += aw;
        usedTexels += w * h;
        return rect;
      }
      if (top + ah > size) { rejected++; return null; }
      const shelf = { y: top, h: ah, x: aw };
      shelves.push(shelf);
      top += ah;
      usedTexels += w * h;
      return { x: padding, y: shelf.y + padding, w, h };
    },
    get stats() {
      return {
        size,
        shelves: shelves.length,
        usedTexels,
        rejected,
        occupancy: usedTexels / (size * size),
        bytes: atlasBytes(size),
      };
    },
  };
}

// ══════════════════════════════════════════════════ geometry → local triangles

/**
 * Flattens a BufferGeometry into OBB-centred local triangles: 9 floats per
 * triangle. Index or not, exactly like `buildBvhWords` treats it.
 */
export function extractLocalTriangles(geometry, center) {
  const pos = geometry?.attributes?.position;
  if (!pos) return null;
  const idx = geometry.index;
  const count = idx ? idx.count : pos.count;
  const triCount = Math.floor(count / 3);
  if (triCount < 1) return null;
  const out = new Float32Array(triCount * 9);
  const cx = center?.x ?? 0, cy = center?.y ?? 0, cz = center?.z ?? 0;
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k;
      out[t * 9 + k * 3 + 0] = pos.getX(vi) - cx;
      out[t * 9 + k * 3 + 1] = pos.getY(vi) - cy;
      out[t * 9 + k * 3 + 2] = pos.getZ(vi) - cz;
    }
  }
  return out;
}

function triNormal(tris, t) {
  const b = t * 9;
  const ux = tris[b + 3] - tris[b], uy = tris[b + 4] - tris[b + 1], uz = tris[b + 5] - tris[b + 2];
  const vx = tris[b + 6] - tris[b], vy = tris[b + 7] - tris[b + 1], vz = tris[b + 8] - tris[b + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len > EPS ? [nx / len, ny / len, nz / len, len * 0.5] : [0, 0, 0, 0];
}

/** Deterministic LCG — no `Math.random` in a build step that must reproduce. */
function makeRand(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Area-weighted surface samples: {x,y,z,nx,ny,nz,tri}[] in local space. */
export function sampleSurface(tris, count, seed = 0x5a17e5) {
  const triCount = tris.length / 9;
  const cum = new Float64Array(triCount);
  const normals = new Float32Array(triCount * 3);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    const [nx, ny, nz, area] = triNormal(tris, t);
    normals[t * 3] = nx; normals[t * 3 + 1] = ny; normals[t * 3 + 2] = nz;
    total += area;
    cum[t] = total;
  }
  const rand = makeRand(seed);
  const out = [];
  if (total <= EPS) return { samples: out, area: 0, normals };
  for (let i = 0; i < count; i++) {
    const target = rand() * total;
    let lo = 0, hi = triCount - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }
    const t = lo;
    let u = rand(), v = rand();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const b = t * 9;
    const ax = tris[b], ay = tris[b + 1], az = tris[b + 2];
    out.push({
      x: ax + u * (tris[b + 3] - ax) + v * (tris[b + 6] - ax),
      y: ay + u * (tris[b + 4] - ay) + v * (tris[b + 7] - ay),
      z: az + u * (tris[b + 5] - az) + v * (tris[b + 8] - az),
      nx: normals[t * 3], ny: normals[t * 3 + 1], nz: normals[t * 3 + 2],
      tri: t,
    });
  }
  return { samples: out, area: total, normals };
}

// ═════════════════════════════════════════════════════════════ rasterization

/**
 * Rasterizes the mesh into one card's texel grid, keeping the `layers` nearest
 * front-facing fragments per texel (a depth peel). Stores the winning TRIANGLE
 * index, not just the depth: the coverage test re-evaluates the winner's plane
 * at the sample's exact position, which removes the slope-dependent tolerance a
 * depth-only buffer would need.
 */
export function rasterizeCard(card, tris, he, layers = 1) {
  const { resU, resV, axis, sign } = card;
  const n = resU * resV;
  const depth = new Float32Array(n * layers).fill(Infinity);
  const tri = new Int32Array(n * layers).fill(-1);
  const triCount = tris.length / 9;
  const ia = (axis + 1) % 3, ib = (axis + 2) % 3;
  const hu = Math.max(he[ia], EPS), hv = Math.max(he[ib], EPS), hd = Math.max(he[axis], EPS);
  const S = [0, 0, 0], T = [0, 0, 0], D = [0, 0, 0];
  for (let t = 0; t < triCount; t++) {
    const nrm = triNormal(tris, t);
    // Front-facing wrt the card's view direction (the card looks along -dir).
    const facing = nrm[axis] * sign;
    if (facing <= 1e-6) continue;
    const b = t * 9;
    for (let k = 0; k < 3; k++) {
      const p = [tris[b + k * 3], tris[b + k * 3 + 1], tris[b + k * 3 + 2]];
      S[k] = ((p[ia] * sign) / hu + 1) * 0.5;
      T[k] = (p[ib] / hv + 1) * 0.5;
      D[k] = (hd - p[axis] * sign) / (2 * hd);
    }
    let i0 = Math.floor(Math.min(S[0], S[1], S[2]) * resU);
    let i1 = Math.ceil(Math.max(S[0], S[1], S[2]) * resU);
    let j0 = Math.floor(Math.min(T[0], T[1], T[2]) * resV);
    let j1 = Math.ceil(Math.max(T[0], T[1], T[2]) * resV);
    i0 = Math.max(0, i0); j0 = Math.max(0, j0);
    i1 = Math.min(resU, i1); j1 = Math.min(resV, j1);
    if (i1 <= i0 || j1 <= j0) continue;
    const e0s = S[1] - S[0], e0t = T[1] - T[0];
    const e1s = S[2] - S[0], e1t = T[2] - T[0];
    const det = e0s * e1t - e0t * e1s;
    if (Math.abs(det) < 1e-14) continue;
    const invDet = 1 / det;
    for (let j = j0; j < j1; j++) {
      const ty = (j + 0.5) / resV;
      for (let i = i0; i < i1; i++) {
        const tx = (i + 0.5) / resU;
        const ds = tx - S[0], dt = ty - T[0];
        const w1 = (ds * e1t - dt * e1s) * invDet;
        const w2 = (dt * e0s - ds * e0t) * invDet;
        if (w1 < -1e-6 || w2 < -1e-6 || w1 + w2 > 1 + 1e-6) continue;
        const d = D[0] + w1 * (D[1] - D[0]) + w2 * (D[2] - D[0]);
        // Insert into the per-texel ascending depth peel.
        const base = (j * resU + i) * layers;
        for (let l = 0; l < layers; l++) {
          if (d < depth[base + l]) {
            for (let m = layers - 1; m > l; m--) {
              depth[base + m] = depth[base + m - 1];
              tri[base + m] = tri[base + m - 1];
            }
            depth[base + l] = d;
            tri[base + l] = t;
            break;
          }
        }
      }
    }
  }
  return { depth, tri, resU, resV, layers };
}

/** Depth of triangle `t`'s plane at an exact card-space (s, t) position. */
function planeDepthAt(tris, t, axis, sign, he, s, tt) {
  const ia = (axis + 1) % 3, ib = (axis + 2) % 3;
  const hu = Math.max(he[ia], EPS), hv = Math.max(he[ib], EPS), hd = Math.max(he[axis], EPS);
  const b = t * 9;
  const S = [0, 0, 0], T = [0, 0, 0], D = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const p = [tris[b + k * 3], tris[b + k * 3 + 1], tris[b + k * 3 + 2]];
    S[k] = ((p[ia] * sign) / hu + 1) * 0.5;
    T[k] = (p[ib] / hv + 1) * 0.5;
    D[k] = (hd - p[axis] * sign) / (2 * hd);
  }
  const e0s = S[1] - S[0], e0t = T[1] - T[0];
  const e1s = S[2] - S[0], e1t = T[2] - T[0];
  const det = e0s * e1t - e0t * e1s;
  if (Math.abs(det) < 1e-14) return D[0];
  const invDet = 1 / det;
  const ds = s - S[0], dt = tt - T[0];
  const w1 = (ds * e1t - dt * e1s) * invDet;
  const w2 = (dt * e0s - ds * e0t) * invDet;
  return D[0] + w1 * (D[1] - D[0]) + w2 * (D[2] - D[0]);
}

/**
 * §6.7's concavity detector: what FRACTION of the mesh's true surface area do
 * the cards actually see?
 *
 * Measured against the lookup, not against the cards in general: a hit reads
 * the slot §6.4's argmax picks, so a point is "covered" only when ITS OWN
 * argmax card — at some depth-peel layer — is showing it. A point hidden behind
 * another surface in that card reads a neighbour's radiance, which is the exact
 * failure this detector exists to catch.
 */
export function cardCoverage({ cards, tris, he, layers = 1, samples = 4096, seed = 0x5a17e5 }) {
  const surf = sampleSurface(tris, samples, seed);
  if (!surf.samples.length) return { coverage: 1, samples: 0, area: 0, covered: 0, inactive: 0 };
  // One raster PER DIRECTION with `layers` depth peels — the layer-L card of a
  // direction shows that direction's L-th peel, so they share a grid.
  const byDir = new Map();
  for (const c of cards) {
    if (!c.active) continue;
    if (!byDir.has(c.slot)) byDir.set(c.slot, c);
    else if (c.layer < byDir.get(c.slot).layer) byDir.set(c.slot, c);
  }
  const rasterOf = new Map();
  let covered = 0;
  let inactive = 0;
  for (const p of surf.samples) {
    const slot = cardSlotFor(p.nx, p.ny, p.nz);
    const card = byDir.get(slot);
    if (!card) { inactive++; continue; }
    let r = rasterOf.get(slot);
    if (!r) { r = rasterizeCard(card, tris, he, layers); rasterOf.set(slot, r); }
    const { s, t, depth } = cardProject(card, p.x, p.y, p.z, he);
    const i = Math.min(r.resU - 1, Math.max(0, Math.floor(s * r.resU)));
    const j = Math.min(r.resV - 1, Math.max(0, Math.floor(t * r.resV)));
    const base = (j * r.resU + i) * r.layers;
    // A texel-scale margin: the winner's PLANE is evaluated at the sample's
    // exact position, so the only slack needed covers tessellation curvature
    // and one texel of silhouette extrapolation. `argmax` guarantees
    // |n·dir| ≥ 1/√3, which bounds that slope at √2 — hence 1.5/res.
    const margin = 0.01 + 1.5 / Math.max(r.resU, r.resV, 8);
    let seen = false;
    for (let l = 0; l < r.layers && !seen; l++) {
      const w = r.tri[base + l];
      if (w < 0) break;
      if (w === p.tri) { seen = true; break; }
      const dw = planeDepthAt(tris, w, card.axis, card.sign, he, s, t);
      if (Math.abs(depth - dw) <= margin) seen = true;
    }
    if (seen) covered++;
  }
  return {
    coverage: covered / surf.samples.length,
    samples: surf.samples.length,
    area: surf.area,
    covered,
    inactive,
  };
}

// ═══════════════════════════════════════════════════════════════════ packing

/**
 * Packs a card list into the 8-words-per-card table. Always emits
 * `CARD_SLOTS * layers` records so §6.4's `slot = axis*2 + signBit` (plus
 * `layer*6`) is a constant-stride index; missing slots are all-zero, i.e.
 * flags bit 0 clear.
 */
export function packCardWords(cards, layers = 1, objIndex = 0) {
  const slotCount = CARD_SLOTS * layers;
  const words = new Uint32Array(slotCount * CARD_WORDS);
  const f32 = new Float32Array(words.buffer);
  for (const c of cards) {
    const at = (c.layer * CARD_SLOTS + c.slot) * CARD_WORDS;
    f32[at + 0] = c.u0;
    f32[at + 1] = c.v0;
    f32[at + 2] = c.du;
    f32[at + 3] = c.dv;
    // axis|sign: axis in bits 0..1, sign bit in bit 2 (1 = negative). The slot
    // index rides bits 8..15 so a mis-ordered pack is caught by inspection
    // rather than by a wrong lookup three passes later.
    const signBit = c.sign < 0 ? 1 : 0;
    words[at + 4] = (c.axis & 3) | (signBit << 2) | ((c.slot & 0xff) << 8);
    words[at + 5] = (c.resU & 0xffff) | ((c.resV & 0xffff) << 16);
    words[at + 6] = objIndex >>> 0;
    words[at + 7] =
      (c.active ? CARD_FLAG.active : 0) |
      (c.analytic ? CARD_FLAG.analytic : 0) |
      (c.degenerate ? CARD_FLAG.degenerate : 0) |
      ((c.layer & 0xff) << 8) |
      ((layers & 0xff) << 16);
  }
  return words;
}

/** Decodes one packed card record. The inverse of `packCardWords`. */
export function decodeCard(words, slotIndex, wordBase = 0) {
  const at = wordBase + slotIndex * CARD_WORDS;
  const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
  const as = words[at + 4];
  const rs = words[at + 5];
  const fl = words[at + 7];
  return {
    u0: f32[at + 0], v0: f32[at + 1], du: f32[at + 2], dv: f32[at + 3],
    axis: as & 3,
    sign: (as >>> 2) & 1 ? -1 : 1,
    slot: (as >>> 8) & 0xff,
    resU: rs & 0xffff,
    resV: (rs >>> 16) & 0xffff,
    objIdx: words[at + 6],
    flags: fl,
    active: (fl & CARD_FLAG.active) !== 0,
    analytic: (fl & CARD_FLAG.analytic) !== 0,
    degenerate: (fl & CARD_FLAG.degenerate) !== 0,
    layer: (fl >>> 8) & 0xff,
    layers: (fl >>> 16) & 0xff,
  };
}

// ══════════════════════════════════════════════════════════════ the builder

function worldAxisScales(matrixWorld) {
  const e = matrixWorld?.elements;
  if (!e) return [1, 1, 1];
  return [
    Math.hypot(e[0], e[1], e[2]),
    Math.hypot(e[4], e[5], e[6]),
    Math.hypot(e[8], e[9], e[10]),
  ];
}

/**
 * Builds one object's card set.
 *
 * @param {object} o
 * @param {any}    o.mesh      the THREE.Mesh (matrixWorld + geometry + name)
 * @param {any}    o.shape     `classifyDynamicShape(mesh)` — its taxonomy, not a parallel one
 * @param {any}    o.atlas     `createCardAtlas()` result
 * @param {number} [o.distance] eye→object distance for the resolution formula
 * @param {number} [o.k]        `SRC_CARD_K`
 * @param {number} [o.objIndex] the dynamic-object slot this table belongs to
 * @param {number} [o.resScale] atlas tiering hook: scales every card's resolution
 * @param {boolean}[o.detectConcavity]
 * @param {number} [o.concaveThreshold]
 * @returns {{
 *   name: string, type: string, layers: number, cards: any[], words: Uint32Array|null,
 *   demoted: boolean, demoteReason: string|null, coverage: number, atlasTexels: number,
 *   objIndex: number, triCount: number,
 * }}
 */
export function buildObjectCards({
  mesh, shape, atlas, distance = 8, k = SRC_CARD_K, objIndex = 0, resScale = 1,
  detectConcavity = true, concaveThreshold = SRC_CONCAVE_THRESHOLD, coverageSamples = 4096,
}) {
  const plan = cardPlan(shape, mesh);
  const name = mesh?.name || `object#${objIndex}`;
  const out = {
    name, type: shape?.type ?? "none", layers: plan?.layers ?? 1, cards: [], words: null,
    demoted: false, demoteReason: null, coverage: 1, atlasTexels: 0, objIndex, triCount: 0,
  };
  if (!plan) { out.demoted = true; out.demoteReason = "unclassified"; out.coverage = 0; return out; }

  const he = plan.halfExtents;
  const scale = worldAxisScales(mesh?.matrixWorld);
  const dist = Math.max(distance, 0.05);

  // Resolution first, allocation second — a card whose rect will not fit is a
  // tiering event, not a silent shrink.
  const wanted = [];
  for (let layer = 0; layer < plan.layers; layer++) {
    for (const s of plan.slots) {
      if (!s.active) { wanted.push({ ...s, layer, resU: 0, resV: 0 }); continue; }
      const wU = 2 * he[s.ia] * scale[s.ia];
      const wV = 2 * he[s.ib] * scale[s.ib];
      const big = Math.max(wU, wV, EPS);
      const res = cardResolution(big, dist, k);
      const clampRes = (r) => Math.min(CARD_RES_MAX, Math.max(CARD_RES_MIN, Math.round(r * resScale) || CARD_RES_MIN));
      wanted.push({
        ...s, layer,
        resU: clampRes(res * (wU / big)),
        resV: clampRes(res * (wV / big)),
      });
    }
  }

  // Tall-first inside one object packs the shelves tighter.
  const order = wanted.filter((c) => c.active).sort((a, b) => b.resV - a.resV || b.resU - a.resU);
  for (const c of order) {
    const rect = atlas.alloc(c.resU, c.resV);
    if (!rect) {
      out.demoted = true;
      out.demoteReason = "atlas-full";
      out.coverage = 0;
      return out;
    }
    c.rect = rect;
    c.u0 = rect.x / atlas.size;
    c.v0 = rect.y / atlas.size;
    c.du = rect.w / atlas.size;
    c.dv = rect.h / atlas.size;
    out.atlasTexels += rect.w * rect.h;
  }
  const cards = wanted.filter((c) => c.active);
  out.cards = cards;

  // ── §6.7: concavity. Analytic shapes are convex by construction and have no
  // triangles the GPU would rasterize anyway, so the detector is a mesh-only
  // cost — and it is a real cost, hence the triangle guard below.
  if (detectConcavity && shape.type === "mesh" && mesh?.geometry) {
    const tris = extractLocalTriangles(mesh.geometry, shape.center);
    out.triCount = tris ? tris.length / 9 : 0;
    const maxTris = Number(globalThis.__giSrcConcaveMaxTris) || 200000;
    if (!tris) {
      out.demoted = true;
      out.demoteReason = "no-geometry";
      out.coverage = 0;
      return out;
    }
    if (out.triCount > maxTris) {
      // The module's rule about silent caps: say what was skipped.
      console.log(
        `[gi] surface-cache: "${name}" has ${out.triCount} tris (> ${maxTris}) — ` +
          `concavity detection SKIPPED, cards assumed valid`,
      );
    } else {
      const cov = cardCoverage({ cards, tris, he, layers: plan.layers, samples: coverageSamples });
      out.coverage = cov.coverage;
      out.coverageSamples = cov.samples;
      out.surfaceArea = cov.area;
      if (cov.coverage < concaveThreshold) {
        out.demoted = true;
        out.demoteReason = "concave";
        // §6.7: log the demotion BY NAME — "split this mesh" is a real answer.
        console.log(
          `[gi] surface-cache: DEMOTED "${name}" — cards see ${(cov.coverage * 100).toFixed(1)}% of its ` +
            `surface (< ${(concaveThreshold * 100).toFixed(0)}%); keeping the header mean-albedo path. ` +
            `Split the mesh into convex parts to cache it.`,
        );
        return out;
      }
    }
  }

  out.words = packCardWords(cards, plan.layers, objIndex);
  return out;
}

/**
 * Builds every object's cards into one atlas and one contiguous word block.
 *
 * TIERING HOOK (§6.3, "tier it like `dynamicObjectWords` already tiers"): if
 * any card fails to fit, the WHOLE build retries at half resolution before any
 * object is dropped — a uniform quality step is a far better failure than an
 * arbitrary subset of objects losing their cache. Only when the smallest tier
 * still overflows does an object demote, and it says so.
 *
 * @returns per-object entries carrying `cardTableRel`, the value that goes into
 *          object block word +23 (relative to `baseWord`, exactly like +20/+21).
 */
export function buildSurfaceCache({
  objects, atlasSize = SRC_ATLAS_SIZE, padding = 1, poolBaseWord = 0, poolCapacityWords = Infinity,
  distanceOf = null, eye = null, k = SRC_CARD_K, detectConcavity = true,
  concaveThreshold = SRC_CONCAVE_THRESHOLD, coverageSamples = 4096, resScales = [1, 0.5, 0.25],
} = {}) {
  const list = objects ?? [];
  let attempt = null;
  for (let ti = 0; ti < resScales.length; ti++) {
    const resScale = resScales[ti];
    const atlas = createCardAtlas({ size: atlasSize, padding });
    const entries = [];
    let overflow = 0;
    for (const [i, o] of list.entries()) {
      const mesh = o.mesh ?? o;
      const shape = o.shape;
      const distance = o.distance ?? (distanceOf ? distanceOf(mesh) : eyeDistance(mesh, eye));
      const e = buildObjectCards({
        mesh, shape, atlas, distance, k, objIndex: o.objIndex ?? i, resScale,
        detectConcavity, concaveThreshold, coverageSamples,
      });
      if (e.demoteReason === "atlas-full") overflow++;
      entries.push(e);
    }
    attempt = { atlas, entries, resScale, overflow };
    if (!overflow) break;
    if (ti < resScales.length - 1) {
      console.log(
        `[gi] surface-cache: atlas ${atlasSize}² full at res scale ${resScale.toFixed(2)} ` +
          `(${overflow} object(s) did not fit) — retrying at ${resScales[ti + 1].toFixed(2)}`,
      );
    } else {
      console.log(
        `[gi] surface-cache: atlas ${atlasSize}² still full at the smallest tier — ` +
          `${overflow} object(s) DEMOTED to the header mean-albedo path`,
      );
    }
  }

  // Word-pool layout: a bump allocator over the region tail, the same shape the
  // BVH pool uses (`nextWord` in createDynamicObjectSet). Never recycled inside
  // one build; the next field rebuild resets everything.
  let next = 0;
  const chunks = [];
  for (const e of attempt.entries) {
    if (!e.words) { e.cardTableRel = 0; continue; }
    if (next + e.words.length > poolCapacityWords) {
      e.cardTableRel = 0;
      e.words = null;
      e.demoted = true;
      e.demoteReason = "pool-full";
      console.log(`[gi] surface-cache: card pool full — "${e.name}" keeps the header mean-albedo path`);
      continue;
    }
    e.cardTableRel = poolBaseWord + next;
    e.cardTableWord = cardTableWordOffset(e.objIndex);
    chunks.push({ at: next, words: e.words });
    next += e.words.length;
  }
  const words = new Uint32Array(next);
  for (const c of chunks) words.set(c.words, c.at);

  const demoted = attempt.entries.filter((e) => e.demoted).map((e) => ({
    name: e.name, reason: e.demoteReason, coverage: e.coverage,
  }));
  const cardCount = attempt.entries.reduce((a, e) => a + (e.words ? e.cards.length : 0), 0);
  return {
    atlas: attempt.atlas,
    entries: attempt.entries,
    words,
    poolWords: next,
    resScale: attempt.resScale,
    demoted,
    stats: {
      objects: attempt.entries.length,
      cached: attempt.entries.length - demoted.length,
      demoted: demoted.length,
      cardsAllocated: cardCount,
      atlasOccupancy: attempt.atlas.stats.occupancy,
      atlasSize,
      atlasBytes: atlasBytes(atlasSize),
      poolWords: next,
      resScale: attempt.resScale,
    },
  };
}

function eyeDistance(mesh, eye) {
  if (!eye || !mesh?.matrixWorld) return 8;
  const e = mesh.matrixWorld.elements;
  return Math.max(0.05, Math.hypot(e[12] - eye.x, e[13] - eye.y, e[14] - eye.z));
}
