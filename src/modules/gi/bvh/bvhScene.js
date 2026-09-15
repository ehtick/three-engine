// Multi-mesh BVH scene for exact reflections (GI Phase 3 v1 — see
// docs/GI_PLAN.md). Builds on the spike's proven packing + traversal
// (bvhGpu.js: 512/512 agreement with CPU raycastFirst, 7-11 M rays/s) by
// concatenating EVERY eligible mesh's BLAS into 4 shared flat storage
// buffers, plus a per-mesh uniform table (world→local transform, world
// AABB, buffer offsets) refreshed every frame from matrixWorld — a moving
// mesh is a uniform update, the same "refit is free" contract giField's
// world bundle already keeps (see createGiField's header comment).
//
// TWO-LEVEL STRUCTURE: per-mesh BLAS (built once per geometry, cached) +
// a per-frame-updated transform/AABB table walked by a runtime loop
// (`meshCountUniform`, not a JS-time constant) inside `firstHit`. This is
// deliberately NOT the "single wgslFn takes every per-mesh array as a raw
// ptr parameter" shape: the outer mesh loop, the world-AABB reject, and the
// worldToLocal transform are all plain TSL (`Loop`/`If`/mat4 math) — the
// SAME proven idiom slotRegistry.js already uses for its own per-slot
// uniform arrays (`this.worldToLocal.element(s)` etc.) — and only the
// expensive part (the actual BLAS stack traversal) stays hand-written WGSL,
// faithfully ported from the spike with 4 added offsets. This sidesteps any
// question of whether a `uniformArray` can be threaded through a `wgslFn`'s
// raw `ptr<uniform, array<T,N>, read>` parameter (never proven anywhere in
// this codebase) while keeping the one thing that DOES need to be real WGSL
// (the stack loop) exactly as validated.
//
// ELIGIBILITY (v1 scope): mesh.isMesh, indexed geometry, NOT SkinnedMesh,
// tris <= MAX_TRIS_PER_BVH_MESH. Skinned meshes are a DOCUMENTED v1 gap —
// they simply do not appear in exact reflections (the SDF `mirrorTraceFn`
// path remains the fallback for everything this module excludes). Capacity
// MAX_BVH_MESHES; scenes with more seat only the first N (console.warn).
//
// PER-GEOMETRY BLAS CACHE: a WeakMap keyed by geometry object, holding the
// pack at the geometry's CONTENT REVISION (`staticBvhGeometryRevision`: id +
// position/index/uv version and count), so N mesh instances sharing one
// geometry build the BVH once, and an in-place edit of the SAME object (a
// terrain stroke, the BMesh editor) misses instead of handing back the pre-
// edit triangles. The build itself runs OFF the main thread when it can:
// `prewarmGeometryBlas` fills the cache from `bvhBlasWorker.js`, and
// `buildBvhScene` stays synchronous and hits it (falling back to a main-
// thread MeshBVH build for anything still cold).
//
// CRITICAL — DO NOT normalize the local-space ray direction: with an
// unnormalized `rd` (world `rd` transformed by the mesh's worldToLocal
// LINEAR part, translation dropped), the ray parameter `t` is IDENTICAL in
// local and world space — the slab test and Möller-Trumbore are both
// parameter-form-safe (t solves a linear equation whose scale cancels on
// both sides). Normalizing would rescale t per-mesh and require converting
// every hit back to world units before comparing across meshes. Miss = t < 0.
import * as THREE from "three/webgpu";
import { If, Loop, attributeArray, cross, float, fract, mat3, max, min, select, texture, uniform, uniformArray, vec2, vec3, vec4, wgslFn } from "three/tsl";
import { MeshBVH } from "three-mesh-bvh";
import { resolveMaterialAlbedo } from "../materialNodeBindings.js";
import { freeze } from "../../../engine/freezeLedger.js";
import { staticBvhGeometryRevision } from "../staticBvhBuildCache.js";

/**
 * Hard cap on meshes seated into one BVH scene — bounds per-frame loop cost.
 * 64 → 128 (2026-08-22): at 64 the user's Level (87 eligible) left 23 meshes
 * UNSEATED, and every reflection ray flew straight through them — "the
 * mirror grabs emission from behind the walls" plus white env speckle where
 * rays escaped the scene entirely. Seat-by-size had already fixed WHICH
 * meshes overflowed; past ~85 eligible nothing but a bigger table fixes THAT
 * they overflow. The per-ray cost is a TLAS AABB loop bounded by the LIVE
 * meshCountUniform, so a 64-mesh scene pays exactly what it paid — only
 * scenes that actually seat more pay more, and the prepass they feed has
 * been stride-2 + half-res-shaded since the same day.
 *
 * 128 → 512 (2026-09-10): a ball pool is 350 SMALL meshes, and seat-by-size
 * put every one of them in the overflow — 238 balls outside the BVH, casting
 * no traced shadow at all, which reads as "some objects don't even have
 * shadows" and a floor that stays lit under a metre of balls. The same "only
 * scenes that actually seat more pay more" argument applies: the TLAS loop is
 * bounded by the live count, so nothing that fits in 128 changes. What DOES
 * change is that a scene of many small movers now pays a ~3× longer TLAS
 * loop per ray — measure before assuming a scene at this scale still clears
 * the frame budget.
 */
export const MAX_BVH_MESHES = 512;
/** Per-mesh triangle cap — a single 150k-tri BLAS is already a deep tree. */
export const MAX_TRIS_PER_BVH_MESH = 150_000;

const BYTES_PER_NODE = 32; // 6 f32 (24B) + 2 u32 (8B) — three-mesh-bvh core/Constants.js
const UINT32_PER_NODE = BYTES_PER_NODE / 4; // 8

// geometry -> { revision, packed } — `packed` is { nodeCount, triCount,
// vertexCount, bounds, contents, index, position, uv, boundsMin, boundsMax },
// or null for a geometry the BVH cannot seat (multi-root after degrouping).
//
// KEYED BY CONTENT REVISION, NOT IDENTITY ALONE (2026-09-10). Terrain
// sculpting edits the position attribute of the SAME BufferGeometry object,
// and an identity-only lookup kept returning the pre-stroke pack: the scene-
// level resync saw the edit (`giBvhContentKey` mixes `position.version`) and
// rebuilt the whole scene around triangles this cache had frozen. Still a
// WeakMap, so a disposed geometry stays collectable.
const blasCache = new WeakMap();
// Scratch for the seat-by-size ranking below (never held across calls).
const _capScale = new THREE.Vector3();

/**
 * Receipt counters. `syncBuilds` is the number of MeshBVH builds paid ON THE
 * MAIN THREAD — the freeze class `prewarmGeometryBlas` exists to remove, so a
 * warm scene leaves it untouched; `asyncBuilds` were packed from the worker
 * (or an injected builder) and cost the main thread only the copy and pack.
 */
export const blasBuildStats = { syncBuilds: 0, syncMs: 0, asyncBuilds: 0, asyncMs: 0, workerFailures: 0 };

/**
 * "warm" — cached at the geometry's current revision; "stale" — cached at an
 * older one (an in-place edit since); "cold" — never packed.
 */
export function blasCacheState(geometry) {
  const cached = blasCache.get(geometry);
  if (!cached) return "cold";
  return cached.revision === staticBvhGeometryRevision(geometry) ? "warm" : "stale";
}

/** The cached pack at the geometry's CURRENT revision; undefined when cold or stale. */
export function peekGeometryBlas(geometry) {
  const cached = blasCache.get(geometry);
  return cached && cached.revision === staticBvhGeometryRevision(geometry) ? cached.packed : undefined;
}

/**
 * Geometry-level eligibility: indexed, has positions, within the per-mesh
 * triangle cap. The mesh-level half (isMesh, not skinned) is
 * `selectBvhMeshes`'s. Single-root-ness is only known after a build — a
 * multi-root geometry is cached as `null` at its revision and counts as warm.
 */
export function blasEligibleGeometry(geometry) {
  const index = geometry?.index;
  if (!index || !geometry.attributes?.position) return false;
  return index.count / 3 <= MAX_TRIS_PER_BVH_MESH;
}

function boxFromRoot(rootF32) {
  return new THREE.Box3(
    new THREE.Vector3(rootF32[0], rootF32[1], rootF32[2]),
    new THREE.Vector3(rootF32[3], rootF32[4], rootF32[5]),
  );
}

/**
 * Packs an ALREADY-BUILT MeshBVH's single root into flat CPU typed arrays,
 * byte-identical in layout to bvhGpu.js's `buildBvhTextures` (see that
 * file's header for why: three-mesh-bvh's packed node = 6 f32 bounds + 2 u32
 * contents, read straight out of `bvh._roots[0]`). Returns null for
 * multi-root geometry (multi-material groups) — out of scope, same as the
 * spike, callers treat it as an exclusion.
 *
 * The triangle order the roots' leaf offsets refer to is the order the BUILD
 * left the index in — so the index is read off `bvh.geometry`, which is
 * `geometry` itself for a main-thread build (three-mesh-bvh partitions the
 * live index in place) and a proxy over the returned array for a worker
 * build (`blasFromWorkerResult`), where the live index is never touched.
 * Positions and UVs come from `geometry`, which no build reorders.
 */
export function packGeometryBlasFrom(geometry, bvh) {
  const roots = bvh?._roots;
  if (!roots || roots.length !== 1) {
    console.warn(`[gi] bvh: skipping a geometry (${roots?.length ?? 0} BVH roots after degrouping — unexpected, likely a non-contiguous draw range)`);
    return null;
  }

  const root = roots[0];
  const nodeCount = root.byteLength / BYTES_PER_NODE;
  const rootF32 = new Float32Array(root);
  const rootU32 = new Uint32Array(root);

  const bounds = new Float32Array(nodeCount * 6);
  const contents = new Uint32Array(nodeCount * 2);
  for (let i = 0; i < nodeCount; i++) {
    const base = i * UINT32_PER_NODE;
    const b6 = i * 6;
    bounds[b6 + 0] = rootF32[base + 0];
    bounds[b6 + 1] = rootF32[base + 1];
    bounds[b6 + 2] = rootF32[base + 2];
    bounds[b6 + 3] = rootF32[base + 3];
    bounds[b6 + 4] = rootF32[base + 4];
    bounds[b6 + 5] = rootF32[base + 5];
    contents[i * 2 + 0] = rootU32[base + 6];
    contents[i * 2 + 1] = rootU32[base + 7];
  }

  const indexAttr = bvh.geometry?.index ?? geometry.index;
  const triCount = indexAttr.count / 3;
  const index = new Uint32Array(indexAttr.count);
  for (let i = 0; i < indexAttr.count; i++) index[i] = indexAttr.getX(i);

  const posAttr = geometry.attributes.position;
  const vertexCount = posAttr.count;
  const position = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    position[i * 3 + 0] = posAttr.getX(i);
    position[i * 3 + 1] = posAttr.getY(i);
    position[i * 3 + 2] = posAttr.getZ(i);
  }

  // Per-vertex UV, packed with the SAME vertex numbering as `position` (see
  // buildBvhScene: both get concatenated at `positionOffset`, so a hit's
  // vertex index resolves into either buffer identically). Missing UVs
  // (no attribute) fill 0.5 — the atlas sample then lands mid-tile, a
  // stable, harmless color rather than reading whatever garbage sits at
  // attribute-less coordinates.
  const uvAttr = geometry.attributes.uv;
  const uv = new Float32Array(vertexCount * 2);
  if (uvAttr) {
    for (let i = 0; i < vertexCount; i++) {
      uv[i * 2 + 0] = uvAttr.getX(i);
      uv[i * 2 + 1] = uvAttr.getY(i);
    }
  } else {
    uv.fill(0.5);
  }

  // The per-mesh AABB (the TLAS slab reject in `firstHit`) is the ROOT'S
  // box — the union of exactly the triangles packed above — never
  // `geometry.boundingBox`: three does not recompute that on an attribute
  // edit, so after a sculpt it still described the flat terrain and every
  // mirror ray towards the raised part was rejected before the BLAS saw it.
  // The same box is also mirrored onto a geometry that arrives without one
  // (MeshBVH's own `setBoundingBox` side effect), so a main-thread and a
  // worker build leave the geometry in the same state.
  const rootBox = boxFromRoot(rootF32);
  if (!geometry.boundingBox) geometry.boundingBox = rootBox.clone();

  return {
    nodeCount, triCount, vertexCount,
    bounds, contents, index, position, uv,
    boundsMin: rootBox.min,
    boundsMax: rootBox.max,
  };
}

/**
 * Main-thread build + pack, on a cache miss only. This is the path
 * `prewarmGeometryBlas` exists to keep cold: a 700k-triangle terrain is one
 * to two seconds here, inside whatever frame called `buildBvhScene`.
 */
export function packGeometryBlas(geometry) {
  const revision = staticBvhGeometryRevision(geometry);
  const cached = blasCache.get(geometry);
  if (cached && cached.revision === revision) return cached.packed;

  // Standard three geometries define per-face/segment material GROUPS even
  // with a single material assigned — BoxGeometry always calls addGroup()
  // 6 times (one per face) regardless of how many materials the mesh
  // actually has. three-mesh-bvh builds ONE BVH ROOT PER GROUP
  // unconditionally (core/build/geometryUtils.js getPrimitiveGroupRanges
  // reads geometry.groups directly, no check for
  // "do these groups actually differ in material") to keep triangles from
  // migrating across a group boundary during the build — a concern for
  // multi-material rendering, irrelevant here (the BVH never looks up
  // per-triangle material; v1's hit shading reads one constant albedo per
  // MESH from the SDF atlas slot regardless). Without stripping groups,
  // every analytic box (walls, this exact floor/lamp rig) hit the
  // multi-root guard below and silently vanished from exact reflections —
  // the opposite of "walls are just box tris, include them". Swap
  // `.groups` out for the build only; synchronous, no yield point before
  // the restore, so this never races the renderer reading it mid-frame.
  // (The worker path builds a groupless copy — the same single root.)
  const savedGroups = geometry.groups;
  geometry.groups = [];
  const t0 = performance.now();
  const span = freeze.begin("gi:bvh/blasBuild(sync)");
  let bvh;
  try {
    bvh = new MeshBVH(geometry);
  } finally {
    geometry.groups = savedGroups;
    freeze.end(span);
  }
  blasBuildStats.syncBuilds++;
  blasBuildStats.syncMs += performance.now() - t0;
  const packed = packGeometryBlasFrom(geometry, bvh);
  blasCache.set(geometry, { revision, packed });
  return packed;
}

// ── Off-thread builds ──────────────────────────────────────────────────────
//
// ONE persistent worker (`bvhBlasWorker.js`), created on first use and kept
// for the session; each job posts COPIES of the position/index arrays and
// gets the packed roots + reordered index back by transfer. The live
// geometry's attributes are never detached (three-mesh-bvh's own
// GenerateMeshBVHWorker transfers them — see the worker file's header).

let _blasWorker = null;          // { worker, pending: Map<id, { resolve, reject }>, nextId }
let _blasWorkerDead = false;     // a worker that errored is not retried this session
let _blasFallbackWarned = false; // "builds stay on the main thread" is said once

function blasWorkerAvailable() {
  return !_blasWorkerDead
    && globalThis.__giBvhWorker !== false
    && typeof Worker === "function";
}

function warnBlasFallbackOnce(reason) {
  if (_blasFallbackWarned) return;
  _blasFallbackWarned = true;
  console.warn(`[gi] bvh: ${reason} — BLAS builds stay on the main thread`);
}

function retireBlasWorker(error) {
  const client = _blasWorker;
  _blasWorker = null;
  _blasWorkerDead = true;
  if (client) {
    try { client.worker.terminate(); } catch { /* already gone */ }
    for (const job of client.pending.values()) job.reject(error);
    client.pending.clear();
  }
  warnBlasFallbackOnce(`worker unavailable (${error?.message ?? error})`);
}

function ensureBlasWorker() {
  if (_blasWorker) return _blasWorker;
  const worker = new Worker(new URL("./bvhBlasWorker.js", import.meta.url), { type: "module" });
  const client = { worker, pending: new Map(), nextId: 1 };
  worker.onmessage = ({ data }) => {
    const job = client.pending.get(data?.id);
    if (!job) return;
    client.pending.delete(data.id);
    if (data.error) job.reject(new Error(`bvh worker: ${data.error}`));
    else job.resolve(data);
  };
  // A broken worker (a module that failed to load, an out-of-memory build)
  // fails every pending job; the callers fall back to the sync build.
  worker.onerror = (event) => retireBlasWorker(new Error(event?.message || "worker error"));
  _blasWorker = client;
  return client;
}

/** Terminates the persistent worker (idle cleanup); the next prewarm recreates it. */
export function disposeBlasWorker() {
  const client = _blasWorker;
  _blasWorker = null;
  if (!client) return;
  try { client.worker.terminate(); } catch { /* already gone */ }
  const error = new Error("bvh worker disposed");
  for (const job of client.pending.values()) job.reject(error);
  client.pending.clear();
}

/**
 * Flat COPIES of the arrays the build reads — the live attributes stay
 * attached to the geometry the renderer is drawing. A plain float32 position
 * / integer index is one memcpy (a Uint16 index widens to Uint32 in the same
 * pass); anything else (interleaved, normalized) goes through the accessor.
 */
function copyBlasArrays(geometry) {
  const posAttr = geometry.attributes.position;
  let position;
  if (!posAttr.isInterleavedBufferAttribute && !posAttr.normalized && posAttr.itemSize === 3 && posAttr.array instanceof Float32Array) {
    position = posAttr.array.slice(0, posAttr.count * 3);
  } else {
    position = new Float32Array(posAttr.count * 3);
    for (let i = 0; i < posAttr.count; i++) {
      position[i * 3 + 0] = posAttr.getX(i);
      position[i * 3 + 1] = posAttr.getY(i);
      position[i * 3 + 2] = posAttr.getZ(i);
    }
  }
  const indexAttr = geometry.index;
  let index;
  if (!indexAttr.isInterleavedBufferAttribute && ArrayBuffer.isView(indexAttr.array)) {
    index = new Uint32Array(indexAttr.array.subarray(0, indexAttr.count));
  } else {
    index = new Uint32Array(indexAttr.count);
    for (let i = 0; i < indexAttr.count; i++) index[i] = indexAttr.getX(i);
  }
  return { position, index };
}

/**
 * Wraps a worker result as a MeshBVH over a PROXY geometry: the live
 * geometry's position attribute (shared, never copied or reordered) plus the
 * index the worker's build left reordered. `packGeometryBlasFrom` reads the
 * index off `bvh.geometry` for exactly this reason.
 */
export function blasFromWorkerResult(geometry, { roots, index }) {
  const proxy = new THREE.BufferGeometry();
  proxy.setAttribute("position", geometry.attributes.position);
  proxy.setIndex(new THREE.BufferAttribute(index, 1, false));
  return MeshBVH.deserialize({ version: 1, roots, index, indirectBuffer: null }, proxy, { setIndex: false });
}

/** Default off-thread builder: copy out, build in the worker, wrap. */
async function buildBlasInWorker(geometry) {
  const client = ensureBlasWorker();
  const { position, index } = freeze.run("gi:bvh/blasCopy", () => copyBlasArrays(geometry));
  const id = client.nextId++;
  const data = await new Promise((resolve, reject) => {
    client.pending.set(id, { resolve, reject });
    try {
      client.worker.postMessage({ id, position, index, options: null }, [position.buffer, index.buffer]);
    } catch (error) {
      client.pending.delete(id);
      reject(error);
    }
  });
  return blasFromWorkerResult(geometry, data);
}

/**
 * Fills the BLAS cache for `geometries` OFF the main thread, one build at a
 * time, so the `buildBvhScene` that follows finds every seated geometry warm
 * and pays no MeshBVH build inside its frame. Skips what is ineligible or
 * already warm; a geometry edited WHILE its build ran is dropped (`stale`)
 * rather than cached against triangles that no longer exist — the next
 * prewarm builds the current revision. When there is no worker (node, a
 * worker that died, `__giBvhWorker = false`) or a build fails, the geometry
 * is built on the main thread here instead, so the contract "warm after
 * resolve" holds either way — the receipt says which happened.
 *
 * @param {Iterable<import("three").BufferGeometry>} geometries
 * @param {{ signal?: AbortSignal|null, builder?: ((geometry: object, ctx: { signal: AbortSignal|null }) => Promise<object>)|null }} [options]
 *   `builder` injects the off-thread build (tests run under node, which has
 *   no Worker). It resolves to a MeshBVH-shaped object — `_roots`, and
 *   `geometry.index` in the build's triangle order; `blasFromWorkerResult`
 *   makes one from `bvhBlasWorker.js`'s output.
 * @returns {Promise<{ built: number, warm: number, stale: number, failed: number, fallback: number, ineligible: number, ms: number, worker: boolean }>}
 */
export async function prewarmGeometryBlas(geometries, { signal = null, builder = null } = {}) {
  const receipt = { built: 0, warm: 0, stale: 0, failed: 0, fallback: 0, ineligible: 0, ms: 0, worker: false };
  const t0 = performance.now();
  const seen = new Set();
  for (const geometry of geometries ?? []) {
    if (!geometry || seen.has(geometry)) continue;
    seen.add(geometry);
    if (signal?.aborted) break;
    if (!blasEligibleGeometry(geometry)) { receipt.ineligible++; continue; }
    const revision = staticBvhGeometryRevision(geometry);
    const cached = blasCache.get(geometry);
    if (cached && cached.revision === revision) { receipt.warm++; continue; }

    let build = builder;
    if (!build && blasWorkerAvailable()) build = buildBlasInWorker;
    if (!build) {
      warnBlasFallbackOnce("no worker available");
      packGeometryBlas(geometry);
      receipt.fallback++;
      continue;
    }

    let bvh = null;
    const tb = performance.now();
    try {
      bvh = await build(geometry, { signal });
    } catch (error) {
      receipt.failed++;
      if (!builder) blasBuildStats.workerFailures++;
      warnBlasFallbackOnce(`off-thread build failed (${error?.message ?? error})`);
      packGeometryBlas(geometry);
      receipt.fallback++;
      continue;
    }
    if (staticBvhGeometryRevision(geometry) !== revision) { receipt.stale++; continue; }
    const packed = freeze.run("gi:bvh/blasPack", () => packGeometryBlasFrom(geometry, bvh));
    blasCache.set(geometry, { revision, packed });
    blasBuildStats.asyncBuilds++;
    blasBuildStats.asyncMs += performance.now() - tb;
    receipt.built++;
    if (!builder) receipt.worker = true;
  }
  receipt.ms = performance.now() - t0;
  return receipt;
}

/**
 * Single-mesh BLAS traversal, ported from bvhGpu.js's `bvhIntersectFirstHitFn`
 * with 4 offsets added so it can read a mesh's slice out of the SHARED
 * concatenated buffers (`bvhScene` packs every mesh back-to-back). Faithful
 * copy of the spike's stack algorithm and Möller-Trumbore leaf test — see
 * that file for the algorithm's provenance/cross-checks. Named distinctly
 * (bvhMesh* not bvh*) so this can coexist in a shader with bvhGpu.js's own
 * functions without a WGSL duplicate-definition risk.
 *
 * `rootIndex` seeds the stack instead of `0u`: every three-mesh-bvh root's
 * node 0 is its own root, and this scene stores it at flat index
 * `nodeOffset` once concatenated, so `rootIndex === nodeOffset` in v1
 * (kept as a distinct parameter for a future multi-root/TLAS extension).
 * `indexOffset` is in TRIANGLE units (not raw index-element units) and
 * `positionOffset` in VERTEX units — both match the units three-mesh-bvh's
 * own per-leaf `offset`/index values already use, so only ONE addition is
 * needed before the `*3u` that turns them into flat array indices.
 *
 * Signature: (ro, rd, maxT, nodeOffset, indexOffset, positionOffset,
 * rootIndex, bounds, contents, indices, positions) -> vec4f(t, u, v,
 * triIndexAsFloat). t < 0 on miss (including "nothing closer than maxT").
 */
const bvhMeshFirstHitFn = wgslFn(/* wgsl */ `

	fn bvhMeshFirstHit(
		ro: vec3f,
		rd: vec3f,
		maxT: f32,
		nodeOffset: u32,
		indexOffset: u32,
		positionOffset: u32,
		rootIndex: u32,
		bounds: ptr<storage, array<f32>, read>,
		contents: ptr<storage, array<u32>, read>,
		indices: ptr<storage, array<u32>, read>,
		positions: ptr<storage, array<f32>, read>
	) -> vec4f {

		var stack: array<u32, 64>;
		var stackPtr: i32 = 0;
		stack[0] = rootIndex;

		var bestT: f32 = maxT;
		var bestU: f32 = 0.0;
		var bestV: f32 = 0.0;
		var bestTri: f32 = -1.0;

		loop {

			if ( stackPtr < 0 ) {
				break;
			}

			let nodeIndex = stack[ stackPtr ];
			stackPtr = stackPtr - 1;

			let nb = nodeIndex * 6u;
			let bmin = vec3f( bounds[ nb ], bounds[ nb + 1u ], bounds[ nb + 2u ] );
			let bmax = vec3f( bounds[ nb + 3u ], bounds[ nb + 4u ], bounds[ nb + 5u ] );

			let boundsHit = bvhMeshSlab( ro, rd, bmin, bmax, bestT );
			if ( boundsHit < 0.0 ) {
				continue;
			}

			let nc = nodeIndex * 2u;
			let offset = contents[ nc ];
			let splitAxisOrCount = contents[ nc + 1u ];
			let isLeaf = ( splitAxisOrCount & 0xffff0000u ) != 0u;

			if ( isLeaf ) {

				let triCount = splitAxisOrCount & 0x0000ffffu;
				for ( var i: u32 = 0u; i < triCount; i = i + 1u ) {

					let ti = ( indexOffset + offset + i ) * 3u;
					let i0 = indices[ ti ] + positionOffset;
					let i1 = indices[ ti + 1u ] + positionOffset;
					let i2 = indices[ ti + 2u ] + positionOffset;

					let pa = vec3f( positions[ i0 * 3u ], positions[ i0 * 3u + 1u ], positions[ i0 * 3u + 2u ] );
					let pb = vec3f( positions[ i1 * 3u ], positions[ i1 * 3u + 1u ], positions[ i1 * 3u + 2u ] );
					let pc = vec3f( positions[ i2 * 3u ], positions[ i2 * 3u + 1u ], positions[ i2 * 3u + 2u ] );

					let hit = bvhMeshIntersectTriMT( ro, rd, pa, pb, pc );
					if ( hit.w > 0.5 && hit.x < bestT ) {
						bestT = hit.x;
						bestU = hit.y;
						bestV = hit.z;
						bestTri = f32( offset + i );
					}

				}

			} else {

				let splitAxis = splitAxisOrCount & 0x0000ffffu;
				let leftIndex = nodeIndex + 1u;
				let rightIndex = nodeIndex + offset;
				let leftToRight = rd[ splitAxis ] >= 0.0;
				let c1 = select( rightIndex, leftIndex, leftToRight );
				let c2 = select( leftIndex, rightIndex, leftToRight );

				stackPtr = stackPtr + 1;
				stack[ stackPtr ] = c2;

				stackPtr = stackPtr + 1;
				stack[ stackPtr ] = c1;

			}

		}

		let outT = select( -1.0, bestT, bestTri >= 0.0 );
		return vec4f( outT, bestU, bestV, bestTri );

	}

	fn bvhMeshSlab( ro: vec3f, rd: vec3f, bmin: vec3f, bmax: vec3f, bestT: f32 ) -> f32 {

		let invDir = 1.0 / rd;
		let t0 = ( bmin - ro ) * invDir;
		let t1 = ( bmax - ro ) * invDir;
		let tsmall = min( t0, t1 );
		let tbig = max( t0, t1 );
		let tmin = max( max( tsmall.x, tsmall.y ), tsmall.z );
		let tmax = min( min( tbig.x, tbig.y ), tbig.z );
		let entry = max( tmin, 0.0 );

		if ( tmax < entry || entry > bestT ) {
			return -1.0;
		}
		return entry;

	}

	fn bvhMeshIntersectTriMT( ro: vec3f, rd: vec3f, a: vec3f, b: vec3f, c: vec3f ) -> vec4f {

		let edge1 = b - a;
		let edge2 = c - a;
		let h = cross( rd, edge2 );
		let det = dot( edge1, h );

		if ( abs( det ) < 1e-8 ) {
			return vec4f( -1.0, 0.0, 0.0, 0.0 );
		}

		let invDet = 1.0 / det;
		let s = ro - a;
		let u = dot( s, h ) * invDet;
		let q = cross( s, edge1 );
		let v = dot( rd, q ) * invDet;
		let t = dot( edge2, q ) * invDet;

		let baryOk = u >= -1e-4 && v >= -1e-4 && ( u + v ) <= 1.0001 && t > 1e-5;
		let hitFlag = select( 0.0, 1.0, baryOk );

		return vec4f( t, u, v, hitFlag );

	}

` );

// Tile grid for the seated albedo atlas (buildAlbedoAtlas). Tiles are keyed
// by MATERIAL, not by mesh, and the per-mesh `albedoTile` uniform carries the
// rect — the grid is NOT sized to MAX_BVH_MESHES.
//
// ⚠ It used to be: tile index === mesh table index, "GRID² >= MAX_BVH_MESHES".
// The cap went 128 → 512 (ball pool) and the grid stayed 12, so meshes 144+
// got tile rects below the 3072 target and every GPU blit pass failed
// validation ("Scissor rect (x, 4608, 256, 0) is not contained in the render
// area", then "Invalid CommandBuffer" for the rest of the frame; 2026-09-14,
// 327-mesh scene). The last tile is a swatch sheet (ALBEDO_SWATCH_PX) for
// map-less and over-cap materials, so every mesh has a valid rect.
//
// Exported so giScreen.js's blitBvhAtlasTiles can compute the same per-tile
// pixel rects when it GPU-renders tiles the canvas 2D path here could not draw.
export const ALBEDO_ATLAS_TILE = 256;
export const ALBEDO_ATLAS_GRID = 12;
export const ALBEDO_ATLAS_SIZE = ALBEDO_ATLAS_TILE * ALBEDO_ATLAS_GRID; // 3072
/** Textured tiles; the last grid tile is the swatch sheet. */
const ALBEDO_TEXTURE_TILES = ALBEDO_ATLAS_GRID * ALBEDO_ATLAS_GRID - 1; // 143
/** Flat-colour swatches inside the last tile: 16x16 of 16 px = 256 colours. */
const ALBEDO_SWATCH_PX = 16;
const ALBEDO_SWATCH_GRID = ALBEDO_ATLAS_TILE / ALBEDO_SWATCH_PX;

/**
 * Bakes one atlas of per-mesh albedo (GI Phase 3 v2 — texture-at-hit, see
 * docs/GI_PLAN.md): a 3072x3072 canvas, 12x12 grid of 256x256 tiles, one
 * tile per textured MATERIAL (see ALBEDO_ATLAS_GRID). A mesh whose material carries a
 * drawable `.map` gets its actual texture image drawn into its tile — this
 * is what retires the old "one mean color per mesh" approximation
 * (`giField.js`'s `hitSurfaceFn`/`atlas.albedo`) for BVH reflection hits.
 * Anything else — no map, or the source image fails to draw (a KTX2/Basis-
 * compressed texture has no CPU-readable pixels: its `.image` is a
 * `{data,width,height}` record, not a CanvasImageSource, so `ctx.drawImage`
 * throws) — solid-fills the tile with `material.color` as a placeholder AND
 * records it in `pendingGpuTiles` (GI Phase 3 v4 — GPU atlas blit, see
 * `blitBvhAtlasTiles` in giScreen.js): the compute pass's texture sampler
 * can read a compressed GPU texture natively (the hardware decodes it), so
 * a later GPU render pass re-samples `map` directly and overwrites the
 * placeholder — the only way a compressed texture's real pixels ever reach
 * this atlas.
 *
 * FLIP: the atlas is created with `flipY = false` (so `firstHit`'s
 * `tileOrigin + fract(uv) * tileScale` sampling needs no extra flip), which
 * means each SOURCE image must be pre-flipped into its tile here to still
 * land in three's normal UV orientation — get this backwards and textured
 * reflections render upside down (still texture-VARYING, just flipped;
 * verified against a render, not derived from first principles here). The
 * GPU blit path does NOT need this compensation: it never goes through the
 * CPU/canvas upload pipeline `flipY` governs — it samples `map` with
 * three's ordinary UV convention via a real texture-sample instruction and
 * relays it through a QuadMesh, the same orientation-preserving idiom every
 * postprocessing pass in this three.js build already relies on.
 */
function makeAtlasCanvas(size = ALBEDO_ATLAS_SIZE) {
  return typeof document !== "undefined"
    ? Object.assign(document.createElement("canvas"), { width: size, height: size })
    : new OffscreenCanvas(size, size);
}

/**
 * Draws ONE material into tile `i`. Returns whether real texture pixels
 * landed (as opposed to the flat-colour placeholder). Shared by the seated
 * per-mesh atlas and the §18.17 per-slot one so the FLIP convention and the
 * compressed-texture fallback can never drift between them.
 */
function drawAlbedoTile(ctx, material, i, pendingGpuTiles, tilePx = ALBEDO_ATLAS_TILE, grid = ALBEDO_ATLAS_GRID) {
  const tileX = (i % grid) * tilePx;
  const tileY = Math.floor(i / grid) * tilePx;
  const { map, tint } = resolveMaterialAlbedo(material);
  let drew = false;
  if (map) {
    const image = map.image ?? map.source?.data;
    if (image && image.width > 0 && image.height > 0) {
      ctx.save();
      try {
        // Local tile space (0,0)-(TILE,TILE), Y-flipped so the source
        // image's row 0 lands at the BOTTOM of the tile — see the FLIP
        // note above.
        ctx.translate(tileX, tileY + tilePx);
        ctx.scale(1, -1);
        ctx.drawImage(image, 0, 0, tilePx, tilePx);
        drew = true;
      } catch {
        drew = false;
      } finally {
        ctx.restore();
      }
    }
  }
  if (!drew) {
    ctx.fillStyle = tintStyle(tint);
    ctx.fillRect(tileX, tileY, tilePx, tilePx);
  }
  // GPU-blit candidate: the canvas draw failed for any reason (no
  // CPU-readable image, zero-size, a decode error — `!drew`), or the map
  // is flatly a compressed texture. For a CompressedTexture `drew` is
  // already false in every observed case (caught by the try/catch above),
  // but the explicit `isCompressedTexture` check keeps this correct even
  // if some future/other path lets a compressed map through the canvas
  // silently — the GPU sample is the authoritative one either way, so it
  // still gets queued to overwrite whatever the canvas produced.
  const tinted = Math.abs((tint.r ?? 1) - 1) > 1e-5
    || Math.abs((tint.g ?? 1) - 1) > 1e-5
    || Math.abs((tint.b ?? 1) - 1) > 1e-5;
  if (map && (!drew || map.isCompressedTexture || tinted)) {
    pendingGpuTiles.push({ map, tileIndex: i, tint: { r: tint.r, g: tint.g, b: tint.b } });
  }
  return drew;
}

function tintStyle(tint) {
  const channel = (value) => Math.round(Math.min(1, Math.max(0, Number(value) || 0)) * 255);
  return `rgb(${channel(tint.r)}, ${channel(tint.g)}, ${channel(tint.b)})`;
}

/**
 * One flat swatch on the seated atlas's swatch sheet: a map-less material's
 * colour, or an over-cap textured material squeezed to ALBEDO_SWATCH_PX (a
 * rough colour, never a hole). Never queued for the GPU blit — a swatch is
 * sampled at its centre, so there is no texture detail for the GPU to add.
 */
function drawAlbedoSwatch(ctx, material, x, y) {
  const { map, tint } = resolveMaterialAlbedo(material);
  const image = map ? (map.image ?? map.source?.data) : null;
  let drew = false;
  if (image && image.width > 0 && image.height > 0) {
    try {
      ctx.drawImage(image, x, y, ALBEDO_SWATCH_PX, ALBEDO_SWATCH_PX);
      drew = true;
    } catch {
      drew = false; // compressed / not CPU-readable — tint only
    }
  }
  ctx.save();
  if (drew) ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = tintStyle(tint);
  ctx.fillRect(x, y, ALBEDO_SWATCH_PX, ALBEDO_SWATCH_PX);
  ctx.restore();
}

function finishAtlas(canvas) {
  const atlasTexture = new THREE.CanvasTexture(canvas);
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTexture.flipY = false;
  atlasTexture.minFilter = THREE.LinearFilter;
  atlasTexture.magFilter = THREE.LinearFilter;
  atlasTexture.generateMipmaps = false;
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  atlasTexture.needsUpdate = true;
  return atlasTexture;
}

function buildAlbedoAtlas(entries) {
  const canvas = makeAtlasCanvas();
  const ctx = canvas.getContext("2d");
  let texturedCount = 0;
  // Tiles the canvas 2D path above could not draw — consumed exactly once by
  // blitBvhAtlasTiles (giScreen.js), which clears this back to [] once the
  // GPU pass has overwritten them for real (see that function's comment).
  const pendingGpuTiles = [];
  const sheetX = (ALBEDO_TEXTURE_TILES % ALBEDO_ATLAS_GRID) * ALBEDO_ATLAS_TILE;
  const sheetY = Math.floor(ALBEDO_TEXTURE_TILES / ALBEDO_ATLAS_GRID) * ALBEDO_ATLAS_TILE;
  const swatchCapacity = ALBEDO_SWATCH_GRID * ALBEDO_SWATCH_GRID;
  // material -> [originU, originV, scale]; scale 0 = a swatch sampled at its centre.
  const rectOfMaterial = new Map();
  let tiles = 0;
  let swatches = 0;
  const tileRects = entries.map((entry) => {
    const material = Array.isArray(entry.mesh.material) ? entry.mesh.material[0] : entry.mesh.material;
    let rect = rectOfMaterial.get(material);
    if (rect) return rect;
    if (resolveMaterialAlbedo(material).map && tiles < ALBEDO_TEXTURE_TILES) {
      const i = tiles++;
      if (drawAlbedoTile(ctx, material, i, pendingGpuTiles)) texturedCount++;
      rect = [(i % ALBEDO_ATLAS_GRID) / ALBEDO_ATLAS_GRID, Math.floor(i / ALBEDO_ATLAS_GRID) / ALBEDO_ATLAS_GRID, ALBEDO_ATLAS_TILE / ALBEDO_ATLAS_SIZE];
    } else {
      // Past the sheet's capacity swatches wrap: shared colours, still in bounds.
      const s = swatches++ % swatchCapacity;
      const x = sheetX + (s % ALBEDO_SWATCH_GRID) * ALBEDO_SWATCH_PX;
      const y = sheetY + Math.floor(s / ALBEDO_SWATCH_GRID) * ALBEDO_SWATCH_PX;
      drawAlbedoSwatch(ctx, material, x, y);
      const half = ALBEDO_SWATCH_PX / 2;
      rect = [(x + half) / ALBEDO_ATLAS_SIZE, (y + half) / ALBEDO_ATLAS_SIZE, 0];
    }
    rectOfMaterial.set(material, rect);
    return rect;
  });
  if (swatches > swatchCapacity) {
    console.warn(`[gi] bvh atlas: ${swatches} flat materials exceed the ${swatchCapacity}-swatch sheet — extras share colours in reflections`);
  }
  return { atlasTexture: finishAtlas(canvas), texturedCount, pendingGpuTiles, tileRects };
}

/**
 * Per-slot atlas geometry — the SAME 12x12 grid as the seated atlas, at HALF
 * the tile size.
 *
 * ⚠ VRAM, not taste. A second 3072-square atlas is 37 MB of canvas texture
 * plus a 75 MB half-float blit target beside the pair the seated atlas already
 * holds, on a module whose worst production failure to date is a GPU device
 * lost to memory pressure. 128 px per material costs 9 + 19 MB and is spent on
 * a REFLECTION, traced at half resolution, of a texture — the magnification
 * limit on a flat mirror bites long before the tile does.
 * `__giReflectAtlasTile` overrides for an A/B.
 */
export const SLOT_ATLAS_GRID = ALBEDO_ATLAS_GRID;
export const SLOT_ATLAS_TILES = SLOT_ATLAS_GRID * SLOT_ATLAS_GRID;

/**
 * §18.17 — THE PER-SLOT ALBEDO ATLAS: what makes one-BVH reflections
 * TEXTURED (2026-08-26, user: "for reflections we average color of the mesh,
 * we need texture sampling, as average color won't work for many cases").
 *
 * §17 R7a replaced the seated <=128-mesh BVH with the one world-space BVH8 so
 * that every prop appears in a mirror — and paid for it by dropping the
 * texture lookup the old path had, because that path resolved UVs from
 * per-mesh vertex buffers the world BVH does not carry. Hits have shaded from
 * the occupancy slot MEAN albedo ever since, which is why the user Sponza
 * reflects flat red and green curtains instead of patterned ones.
 *
 * The missing half is a tile the world BVH can address. Tiles are keyed by
 * MATERIAL, not by slot: a scene is placements-many (hundreds) but
 * materials-few (Sponza: 25), so 144 tiles cover real scenes, where a
 * per-slot atlas at the same tile size would be a 200 MB canvas. Slots beyond
 * the cap, and slots whose material has no map, keep the palette mean — the
 * pre-§18.17 picture, per slot, never a hole.
 *
 * Returns the atlas plus `tileOfSlot` (Map slot -> tile index); the caller
 * turns that into the per-slot uniform the reflect prepass indexes.
 */
export function buildSlotAlbedoAtlas(placements) {
  const raw = Number(globalThis.__giReflectAtlasTile);
  const tilePx = Number.isFinite(raw) ? Math.max(16, Math.min(512, Math.round(raw))) : 128;
  const size = tilePx * SLOT_ATLAS_GRID;
  const canvas = makeAtlasCanvas(size);
  const ctx = canvas.getContext("2d");
  const pendingGpuTiles = [];
  const tileOfMaterial = new Map();
  const tileOfSlot = new Map();
  let texturedCount = 0;
  let overflow = 0;
  for (const p of placements ?? []) {
    const material = Array.isArray(p.mesh?.material) ? p.mesh.material[0] : p.mesh?.material;
    // NO MAP, NO TILE — and this is not just an economy. A tile for a map-less
    // material is a flat fill of `material.color`, while the per-slot palette
    // already holds `resolveMaterialSurface`'s answer for that mesh, which
    // accounts for things a raw `.color` does not (a compressed map's GPU
    // average, an emissive promotion). Taking the tile there would REPLACE a
    // better number with a worse one, and it would spend a scarce tile doing
    // it. Only a real texture beats the mean.
    if (!resolveMaterialAlbedo(material).map) continue;
    let tile = tileOfMaterial.get(material);
    if (tile == null) {
      if (tileOfMaterial.size >= SLOT_ATLAS_TILES) { overflow++; continue; }
      tile = tileOfMaterial.size;
      tileOfMaterial.set(material, tile);
      if (drawAlbedoTile(ctx, material, tile, pendingGpuTiles, tilePx, SLOT_ATLAS_GRID)) texturedCount++;
    }
    tileOfSlot.set(p.slot, tile);
  }
  if (tileOfMaterial.size === 0) return null;
  return {
    atlasTexture: finishAtlas(canvas),
    tileOfSlot,
    materialCount: tileOfMaterial.size,
    texturedCount,
    overflow,
    pendingGpuTiles,
    // Geometry travels WITH the atlas: blitBvhAtlasTiles reads these off the
    // object it is handed, so the two atlases can differ in tile size without
    // either one carrying the other's constants.
    atlasSize: size,
    atlasTile: tilePx,
    atlasGrid: SLOT_ATLAS_GRID,
  };
}

/**
 * Which of `meshes` the BVH scene seats, and which it can only cover with a
 * live AABB (`dynamicMeshes`) — shared by `buildBvhScene` and the prewarm so
 * the set warmed off-thread is exactly the set the build will pack. Warnings
 * are returned rather than printed: the build prints them once; the prewarm's
 * earlier look at the same list must not print them twice.
 */
export function selectBvhMeshes(meshes) {
  const eligible = [];
  // Real geometry the BVH cannot see (skinned/unindexed/over-cap). These
  // are NOT dropped silently: their live world AABBs feed the coverage
  // flag (`dynamicBlocked`) so pixels whose mirror ray could cross them
  // fall back to the SDF trace — BVH-alone ERASED rigged characters from
  // every mirror (user-reported regression).
  const dynamicMeshes = [];
  const excludedNames = [];
  const warnings = [];
  for (const mesh of meshes) {
    if (!mesh?.isMesh) continue;
    if (mesh.isSkinnedMesh) {
      excludedNames.push(mesh.name || "mesh");
      dynamicMeshes.push(mesh);
      continue;
    }
    const geometry = mesh.geometry;
    if (!geometry?.index) {
      excludedNames.push(mesh.name || "mesh");
      dynamicMeshes.push(mesh);
      continue;
    }
    const triCount = geometry.index.count / 3;
    if (triCount > MAX_TRIS_PER_BVH_MESH) {
      warnings.push(`[gi] bvh: skipping "${mesh.name || "mesh"}" (${Math.round(triCount)} tris > ${MAX_TRIS_PER_BVH_MESH} bvh cap)`);
      dynamicMeshes.push(mesh);
      continue;
    }
    eligible.push(mesh);
  }
  if (excludedNames.length) {
    warnings.push(`[gi] bvh: excluded (skinned/unindexed): ${excludedNames.join(", ")} — SDF fallback via coverage flag`);
  }
  let seated = eligible;
  if (eligible.length > MAX_BVH_MESHES) {
    // SEAT BY SIZE, NOT WALK ORDER (2026-08-21): with more eligible meshes
    // than seats, "the first 64" left whole WALLS unseated on scene-walk
    // luck — mirror rays flew straight through them, "proved" the
    // environment visible, and the env-on-miss term drew SKY inside a
    // closed room (user's mirror slab). Ranking by world-AABB surface area
    // before the cut makes the overflow the smallest props, whose absence
    // from reflections is barely visible. Same cadence as the atlas bake
    // (mesh-set changes only), so the sort costs nothing per frame.
    const worldArea = (mesh) => {
      const g = mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox;
      _capScale.setFromMatrixScale(mesh.matrixWorld);
      const x = (b.max.x - b.min.x) * Math.abs(_capScale.x);
      const y = (b.max.y - b.min.y) * Math.abs(_capScale.y);
      const z = (b.max.z - b.min.z) * Math.abs(_capScale.z);
      return 2 * (x * y + y * z + z * x);
    };
    const ranked = eligible
      .map((mesh) => [mesh, worldArea(mesh)])
      .sort((a, b) => b[1] - a[1])
      .map((pair) => pair[0]);
    warnings.push(`[gi] bvh: ${eligible.length} eligible meshes exceed the ${MAX_BVH_MESHES}-mesh cap — seating the ${MAX_BVH_MESHES} LARGEST (overflow: smallest props)`);
    seated = ranked.slice(0, MAX_BVH_MESHES);
    dynamicMeshes.push(...ranked.slice(MAX_BVH_MESHES));
  }
  return { seated, dynamicMeshes, warnings };
}

/**
 * The seated geometries whose BLAS is missing or stale at their current
 * revision — what to hand `prewarmGeometryBlas` before the next
 * `buildBvhScene`, so that build finds a warm cache. Empty means the build
 * will pay no main-thread MeshBVH.
 */
export function coldBlasGeometries(meshes) {
  const { seated } = selectBvhMeshes(meshes);
  const cold = [];
  const seen = new Set();
  for (const mesh of seated) {
    const geometry = mesh.geometry;
    if (seen.has(geometry)) continue;
    seen.add(geometry);
    if (blasCacheState(geometry) !== "warm") cold.push(geometry);
  }
  return cold;
}
/**
 * Builds a multi-mesh BVH scene from `meshes` (the SAME mesh list the GI
 * mesh-SDF atlas entries cover — see GISystem's `#syncBvhScene`). Filters to
 * eligible meshes, concatenates their BLASes into 4 shared storage buffers,
 * and returns a scene object whose `firstHit(ro, rd, maxT)` traces a ray
 * through the whole set (world-AABB reject per mesh, local-space BLAS
 * traversal, smallest t wins — see bvhMeshFirstHitFn above and the
 * CRITICAL note on unnormalized local rays at the top of this file).
 *
 * Rebuild cost lives here (new concatenated buffers + a fresh `firstHit`
 * closure over them) — call this again whenever the mesh SET changes
 * (add/remove/topology), never for a pure transform change (that's
 * `refreshTransforms()`, cheap, every frame).
 */
export function buildBvhScene(meshes) {
  const { seated: capped, dynamicMeshes, warnings } = selectBvhMeshes(meshes);
  for (const line of warnings) console.warn(line);

  const entries = [];
  let totalNodes = 0;
  let totalTris = 0;
  let totalVerts = 0;
  for (const mesh of capped) {
    const packed = packGeometryBlas(mesh.geometry);
    if (!packed) {
      // Multi-root (multi-material-group) geometry — rare, out of scope.
      console.warn(`[gi] bvh: skipping "${mesh.name || "mesh"}" (multi-group geometry not supported)`);
      dynamicMeshes.push(mesh);
      continue;
    }
    entries.push({
      mesh, packed,
      nodeOffset: totalNodes, indexOffset: totalTris, positionOffset: totalVerts,
      boundsMin: packed.boundsMin, boundsMax: packed.boundsMax,
    });
    totalNodes += packed.nodeCount;
    totalTris += packed.triCount;
    totalVerts += packed.vertexCount;
  }

  // ⚠ `let`, NOT `const`, AND `dispose()` NULLS THEM. Every closure in this
  // function shares one scope, so `firstHit`/`refreshTransforms` pin these five
  // arrays for as long as the scene object lives — and clearing `attr.array`
  // (releaseStorageAttributes) frees nothing while they do. The typed-array
  // census (run-gi-heap-retainer.mjs, ALLOC_CENSUS=1) measured it: 69 MB per
  // BVH generation on Bistro, 25 of 25 allocations still live after three
  // rebuilds and three gc()s, growing +5 arrays a rebuild forever.
  let boundsData = new Float32Array(Math.max(1, totalNodes * 6));
  let contentsData = new Uint32Array(Math.max(1, totalNodes * 2));
  let indexData = new Uint32Array(Math.max(1, totalTris * 3));
  let positionData = new Float32Array(Math.max(1, totalVerts * 3));
  // Concatenated with the SAME per-vertex numbering as positionData (both
  // indexed by `positionOffset`) — the hit-albedo lookup in `firstHit`
  // resolves a UV at exactly the global vertex id it resolves a position at.
  let uvData = new Float32Array(Math.max(1, totalVerts * 2));
  for (const entry of entries) {
    boundsData.set(entry.packed.bounds, entry.nodeOffset * 6);
    contentsData.set(entry.packed.contents, entry.nodeOffset * 2);
    indexData.set(entry.packed.index, entry.indexOffset * 3);
    positionData.set(entry.packed.position, entry.positionOffset * 3);
    uvData.set(entry.packed.uv, entry.positionOffset * 2);
  }

  // .toReadOnly() so the generated `var<storage,...>` binding's access mode
  // matches the `read` annotation in bvhMeshFirstHitFn's ptr parameters.
  const boundsBuffer = attributeArray(boundsData, "float").toReadOnly();
  const contentsBuffer = attributeArray(contentsData, "uint").toReadOnly();
  const indexBuffer = attributeArray(indexData, "uint").toReadOnly();
  const positionBuffer = attributeArray(positionData, "float").toReadOnly();
  // Flat f32, NEVER vec2-typed — the same 16-byte storage-array stride trap
  // documented at the top of this file for vec3 positions would silently
  // misalign a tightly-packed (8-byte-stride) JS Float32Array here too.
  const uvBuffer = attributeArray(uvData, "float").toReadOnly();

  // Per-mesh table, capacity-fixed at MAX_BVH_MESHES (like slotRegistry's
  // capacity padding): the shader loop bound is the LIVE `meshCountUniform`
  // node, not a JS constant, so seating fewer/more meshes on a later sync
  // never changes the compute's WGSL — only the buffers above (rebuilt
  // wholesale) and these uniforms (rewritten in place) change.
  const capacity = MAX_BVH_MESHES;
  const worldToLocal = uniformArray(Array.from({ length: capacity }, () => new THREE.Matrix4()));
  const aabbMin = uniformArray(Array.from({ length: capacity }, () => new THREE.Vector4()));
  const aabbMax = uniformArray(Array.from({ length: capacity }, () => new THREE.Vector4()));
  // x=nodeOffset, y=indexOffset (tri units), z=positionOffset (vertex units), w=rootIndex.
  const offsets = uniformArray(Array.from({ length: capacity }, () => new THREE.Vector4()));
  const meshCountUniform = uniform(entries.length, "int");
  // x=ox, y=oy (both 0..1 atlas UV, tile origin), z=tileScale (TILE/ATLAS_SIZE,
  // or 0 for a flat swatch), w=1. Capacity-fixed at MAX_BVH_MESHES like the
  // tables above; indexed by mesh, but the rect is its MATERIAL's tile (see
  // buildAlbedoAtlas) — meshes sharing a material share a tile.
  const albedoTile = uniformArray(Array.from({ length: capacity }, () => new THREE.Vector4()));

  // Coverage table for meshes the BVH can't see (skinned etc.): live world
  // AABBs only — no triangles. The reflect pass slab-tests these to set the
  // per-pixel "SDF fallback needed" flag.
  const DYNAMIC_CAPACITY = 8;
  if (dynamicMeshes.length > DYNAMIC_CAPACITY) {
    console.warn(`[gi] bvh: ${dynamicMeshes.length} dynamic (BVH-excluded) meshes exceed the ${DYNAMIC_CAPACITY} coverage slots — extras won't trigger the SDF fallback`);
  }
  const dynamic = dynamicMeshes.slice(0, DYNAMIC_CAPACITY);
  const dynMin = uniformArray(Array.from({ length: DYNAMIC_CAPACITY }, () => new THREE.Vector4()));
  const dynMax = uniformArray(Array.from({ length: DYNAMIC_CAPACITY }, () => new THREE.Vector4()));
  const dynCountUniform = uniform(dynamic.length, "int");

  entries.forEach((entry, i) => {
    offsets.array[i].set(entry.nodeOffset, entry.indexOffset, entry.positionOffset, entry.nodeOffset);
  });

  // Albedo atlas: built once per scene (mesh-SET cadence, same as the BLAS
  // buffers above — a per-frame transform update never touches this), so a
  // moving mesh is still free and only add/remove/material-swap repaints it.
  const { atlasTexture, texturedCount, pendingGpuTiles, tileRects } = buildAlbedoAtlas(entries);
  tileRects.forEach(([ox, oy, scale], i) => {
    albedoTile.array[i].set(ox, oy, scale, 1);
  });
  // Persistent TextureNode wrapping the atlas — kept as a real JS reference
  // (not a fresh `texture(atlasTexture, uv)` built inline per call) so
  // blitBvhAtlasTiles (giScreen.js) can later repoint `.value` at a GPU-blit
  // render target's texture WITHOUT rebuilding the compute graph `firstHit`
  // below gets baked into. This works because TSL's `.sample()`/`.level()`
  // chain off a node clones it but sets the clone's `referenceNode` back to
  // this original (see TextureNode.getBase()) — the clone's `.value`
  // getter/setter then delegates all the way up to THIS node, so mutating
  // `atlasTextureNode.value` reaches the compiled shader exactly like
  // GISystem's `_giBvhReflectNode.value = ...` swap does for the reflect
  // target itself.
  const atlasTextureNode = texture(atlasTexture);

  const scene = {
    meshes: entries.map((entry) => entry.mesh),
    meshCount: entries.length,
    nodeCount: totalNodes,
    triCount: totalTris,
    vertexCount: totalVerts,
    texturedCount,
    boundsBuffer, contentsBuffer, indexBuffer, positionBuffer, uvBuffer,
    /**
     * The five BLAS buffers. On Bistro they are the largest single allocation
     * any GI rebuild makes (positions + indices + UVs over every static
     * triangle), and nothing destroyed them before this: the scene object is
     * retired-then-`dispose()`d, and `dispose()` only touched the atlas
     * texture. `GISystem#drainRetiredTargets` reads this list and routes it
     * through `releaseStorageAttributes` on the same 3-frame delay the
     * textures get, for the same "used in a submit" reason.
     */
    get storageAttributes() {
      return [boundsBuffer, contentsBuffer, indexBuffer, positionBuffer, uvBuffer]
        .map((n) => n?.value).filter(Boolean);
    },
    worldToLocal, aabbMin, aabbMax, offsets, meshCountUniform,
    albedoTile, atlasTexture, atlasTextureNode,
    // Tiles blitBvhAtlasTiles (giScreen.js) still needs to GPU-render
    // (compressed source textures the canvas atlas above could only
    // solid-fill). That function clears this back to [] once it has run,
    // which doubles as its own "nothing to do" no-op check.
    pendingGpuTiles,
    // Set by blitBvhAtlasTiles the first time it actually renders something;
    // disposed alongside the rest of this scene below — the retire-not-
    // dispose delay GISystem's #retireTargets applies to the whole scene
    // object already covers this the same way it covers atlasTexture.
    blitTarget: null,

    /** Per-frame: re-derive worldToLocal + world AABB from live matrices. Cheap — see the atlas's own refreshTransforms. */
    refreshTransforms() {
      const corner = _scratchCorner;
      for (let i = 0; i < entries.length; i++) {
        const { mesh, boundsMin, boundsMax } = entries[i];
        worldToLocal.array[i].copy(mesh.matrixWorld).invert();
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let c = 0; c < 8; c++) {
          corner.set(
            c & 1 ? boundsMax.x : boundsMin.x,
            c & 2 ? boundsMax.y : boundsMin.y,
            c & 4 ? boundsMax.z : boundsMin.z,
          );
          corner.applyMatrix4(mesh.matrixWorld);
          if (corner.x < minX) minX = corner.x;
          if (corner.y < minY) minY = corner.y;
          if (corner.z < minZ) minZ = corner.z;
          if (corner.x > maxX) maxX = corner.x;
          if (corner.y > maxY) maxY = corner.y;
          if (corner.z > maxZ) maxZ = corner.z;
        }
        aabbMin.array[i].set(minX, minY, minZ, aabbMin.array[i].w);
        aabbMax.array[i].set(maxX, maxY, maxZ, aabbMax.array[i].w);
      }
      // Dynamic (BVH-excluded) coverage AABBs — skinned meshes MOVE every
      // frame, so these refresh with the rest. A removed mesh writes an
      // inverted box the slab test can never hit.
      for (let i = 0; i < dynamic.length; i++) {
        const mesh = dynamic[i];
        if (!mesh.parent) {
          dynMin.array[i].set(1, 1, 1, 0);
          dynMax.array[i].set(-1, -1, -1, 0);
          continue;
        }
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let c = 0; c < 8; c++) {
          corner.set(
            c & 1 ? bb.max.x : bb.min.x,
            c & 2 ? bb.max.y : bb.min.y,
            c & 4 ? bb.max.z : bb.min.z,
          );
          corner.applyMatrix4(mesh.matrixWorld);
          if (corner.x < minX) minX = corner.x;
          if (corner.y < minY) minY = corner.y;
          if (corner.z < minZ) minZ = corner.z;
          if (corner.x > maxX) maxX = corner.x;
          if (corner.y > maxY) maxY = corner.y;
          if (corner.z > maxZ) maxZ = corner.z;
        }
        dynMin.array[i].set(minX, minY, minZ, 0);
        dynMax.array[i].set(maxX, maxY, maxZ, 0);
      }
    },

    /**
     * 1 when the ray (ro, rd) could hit a BVH-excluded mesh EARLIER than
     * `tHit` (the BVH result; < 0 = miss → tested out to maxT) — i.e. the
     * BVH answer alone can't be trusted for this pixel and the consumer
     * must union in the SDF trace. Same slab + `.toVar()` discipline as
     * `firstHit` (the raw-boolean-in-Loop codegen trap is real).
     */
    dynamicBlocked(roIn, rdIn, tHitIn, maxTIn) {
      const ro = vec3(roIn).toVar();
      const rd = vec3(rdIn).toVar();
      const tHit = float(tHitIn).toVar();
      const bound = float(maxTIn).toVar();
      If(tHit.greaterThanEqual(0), () => {
        bound.assign(tHit);
      });
      const blocked = float(0).toVar();
      Loop({ start: 0, end: dynCountUniform, name: "bvhDyn" }, ({ bvhDyn }) => {
        const bmin = dynMin.element(bvhDyn).xyz.toVar();
        const bmax = dynMax.element(bvhDyn).xyz.toVar();
        const invDir = vec3(1).div(rd).toVar();
        const s0 = bmin.sub(ro).mul(invDir).toVar();
        const s1 = bmax.sub(ro).mul(invDir).toVar();
        const tsmall = min(s0, s1).toVar();
        const tbig = max(s0, s1).toVar();
        const tminA = max(max(tsmall.x, tsmall.y), tsmall.z).toVar();
        const tmaxA = min(min(tbig.x, tbig.y), tbig.z).toVar();
        const entry = tminA.max(0).toVar();
        const aabbHit = tmaxA.greaterThanEqual(entry).and(entry.lessThanEqual(bound)).toVar();
        If(aabbHit, () => {
          blocked.assign(1);
        });
      });
      return blocked;
    },

    /**
     * bvhSceneFirstHit(ro, rd, maxT) -> { t, albedo, hasAlbedo, normal },
     * t < 0 = miss. Loops the live mesh table (world-AABB slab reject first
     * — cheap, TSL, no buffer reads beyond the per-mesh uniforms), transforms
     * into local space (UNNORMALIZED rd — see the file header), and calls the
     * shared BLAS traversal with that mesh's buffer offsets. Keeps the
     * smallest t by shrinking the search bound passed to each subsequent
     * mesh (an AABB whose entry is already beyond the current best can never
     * win). All existing callers destructure `.t` only, so that keeps
     * working unchanged.
     *
     * `albedo`/`hasAlbedo` (GI Phase 3 v2 — texture-at-hit) and `normal`
     * (GI Phase 3 v3 — exact hit normal, see giScreen.js/giLight.js's
     * striping-fix comments) are resolved AFTER the mesh loop, from the
     * winning hit's mesh/triangle/barycentrics (bestMesh/bestTri/bestUV,
     * tracked alongside bestT with the SAME `.toVar()` discipline — see the
     * warning comment below). Doing the lookup here, not in the caller,
     * keeps the index/uv/position/atlas buffers encapsulated in this module.
     */
    firstHit(roIn, rdIn, maxTIn) {
      const ro = vec3(roIn).toVar();
      const rd = vec3(rdIn).toVar();
      const searchT = float(maxTIn).toVar();
      const bestT = float(-1).toVar();
      // Hit provenance for the post-loop albedo lookup: which mesh (table
      // index, same as offsets/aabbMin/worldToLocal's `i`), which triangle
      // WITHIN that mesh (mesh-LOCAL — matches bvhMeshFirstHitFn's own
      // `bestTri = f32(offset + i)`, see its leaf loop), and the
      // Möller-Trumbore barycentric (u, v) at the hit.
      const bestMesh = float(-1).toVar();
      const bestTri = float(-1).toVar();
      const bestUV = vec2(0, 0).toVar();
      Loop({ start: 0, end: meshCountUniform, name: "bvhMesh" }, ({ bvhMesh }) => {
        // Every intermediate is hoisted into a `.toVar()` — NOT style, a
        // correctness requirement measured here: passing the raw (un-var'd)
        // boolean expression straight into `If(...)` below, built from
        // `.element(bvhMesh)` reads inside this Loop, silently produced a
        // wrong condition (the AABB test read back as always-false at
        // runtime even though the SAME math in isolation, or hoisted through
        // a `.toVar()`, evaluates correctly) — every mesh's slab test failed
        // and `firstHit` returned a permanent miss. Root cause not fully
        // chased into three's WGSL codegen; the fix is reproduced and
        // confirmed via scripts/_diag-*.mjs (see git history / GI_PLAN.md
        // notes) — hoist through `.toVar()` before branching on it.
        const bmin = aabbMin.element(bvhMesh).xyz.toVar();
        const bmax = aabbMax.element(bvhMesh).xyz.toVar();
        const invDir = vec3(1).div(rd).toVar();
        const s0 = bmin.sub(ro).mul(invDir).toVar();
        const s1 = bmax.sub(ro).mul(invDir).toVar();
        const tsmall = min(s0, s1).toVar();
        const tbig = max(s0, s1).toVar();
        const tminA = max(max(tsmall.x, tsmall.y), tsmall.z).toVar();
        const tmaxA = min(min(tbig.x, tbig.y), tbig.z).toVar();
        const entry = tminA.max(0).toVar();
        const aabbHit = tmaxA.greaterThanEqual(entry).and(entry.lessThanEqual(searchT)).toVar();
        If(aabbHit, () => {
          const local = worldToLocal.element(bvhMesh);
          const roLocal = local.mul(vec4(ro, 1)).xyz.toVar();
          // NOT normalized — see the CRITICAL note at the top of this file.
          const rdLocal = local.mul(vec4(rd, 0)).xyz.toVar();
          const off = offsets.element(bvhMesh).toVar();
          const hit = bvhMeshFirstHitFn(
            roLocal, rdLocal, searchT,
            off.x.toUint(), off.y.toUint(), off.z.toUint(), off.w.toUint(),
            boundsBuffer, contentsBuffer, indexBuffer, positionBuffer,
          ).toVar();
          If(hit.x.greaterThanEqual(0), () => {
            searchT.assign(hit.x);
            bestT.assign(hit.x);
            bestMesh.assign(bvhMesh.toFloat());
            bestTri.assign(hit.w);
            bestUV.assign(vec2(hit.y, hit.z));
          });
        });
      });

      // Hit albedo: resolve the winning triangle's vertex UVs and sample the
      // atlas. Mirrors EXACTLY how bvhMeshFirstHitFn resolves its own vertex
      // indices in the leaf loop (`ti = (indexOffset + offset + i) * 3u`,
      // `i0 = indices[ti] + positionOffset`): the global (concatenated-
      // buffer) triangle index is the mesh's indexOffset (offsets.y, TRIANGLE
      // units) + bestTri, stored indices are mesh-LOCAL so the global vertex
      // index is the raw stored index + the mesh's positionOffset (offsets.z,
      // VERTEX units) — uvBuffer is concatenated with that SAME per-vertex
      // numbering (see buildBvhScene), so it reads at the identical global
      // vertex id positionBuffer would.
      const albedo = vec3(0.5).toVar();
      const hasAlbedo = float(0).toVar();
      // Exact hit normal (GI Phase 3 v3 — striping fix, see giScreen.js's
      // "STRIPING FIX" comment on createGiBvhReflect): default matches
      // giField.js createHitSurfaceFn's own miss default (world up).
      const normal = vec3(0, 1, 0).toVar();
      If(bestT.greaterThanEqual(0), () => {
        const meshIdx = bestMesh.toInt().toVar();
        const off = offsets.element(meshIdx).toVar();
        const triIdx = off.y.toUint().add(bestTri.toUint()).toVar();
        const ti = triIdx.mul(3).toVar();
        const i0 = indexBuffer.element(ti).add(off.z.toUint()).toVar();
        const i1 = indexBuffer.element(ti.add(1)).add(off.z.toUint()).toVar();
        const i2 = indexBuffer.element(ti.add(2)).add(off.z.toUint()).toVar();
        const uv0 = vec2(uvBuffer.element(i0.mul(2)), uvBuffer.element(i0.mul(2).add(1))).toVar();
        const uv1 = vec2(uvBuffer.element(i1.mul(2)), uvBuffer.element(i1.mul(2).add(1))).toVar();
        const uv2 = vec2(uvBuffer.element(i2.mul(2)), uvBuffer.element(i2.mul(2).add(1))).toVar();
        // Möller-Trumbore convention (bvhMeshIntersectTriMT above): the hit
        // point = (1-u-v)*a + u*b + v*c for triangle (a,b,c) = (vertex i0,
        // i1, i2) — u weights vertex i1, v weights vertex i2, matching
        // bestUV = (hit.y, hit.z) exactly (that function returns
        // vec4f(t, u, v, hitFlag)).
        const bu = bestUV.x.toVar();
        const bv = bestUV.y.toVar();
        const uv = uv0.mul(float(1).sub(bu).sub(bv)).add(uv1.mul(bu)).add(uv2.mul(bv)).toVar();
        const tile = albedoTile.element(meshIdx).toVar();
        const atlasUV = vec2(tile.x, tile.y).add(fract(uv).mul(tile.z)).toVar();
        // Explicit .level(0) — required for a texture() sample inside a
        // compute shader (no fragment-stage derivatives to pick a mip).
        // Sampled off the PERSISTENT `atlasTextureNode` (not a fresh
        // `texture(atlasTexture, ...)` call) so a later GPU atlas blit can
        // repoint it at a render target without rebuilding this graph — see
        // that node's own comment above.
        albedo.assign(atlasTextureNode.sample(atlasUV).level(0).rgb);
        hasAlbedo.assign(1);

        // Exact face normal: the SAME 3 vertices (i0,i1,i2 — SAME global
        // indices the UV fetch above already resolved) read from
        // positionBuffer instead of uvBuffer, same offset math throughout.
        const p0 = vec3(
          positionBuffer.element(i0.mul(3)), positionBuffer.element(i0.mul(3).add(1)), positionBuffer.element(i0.mul(3).add(2)),
        ).toVar();
        const p1 = vec3(
          positionBuffer.element(i1.mul(3)), positionBuffer.element(i1.mul(3).add(1)), positionBuffer.element(i1.mul(3).add(2)),
        ).toVar();
        const p2 = vec3(
          positionBuffer.element(i2.mul(3)), positionBuffer.element(i2.mul(3).add(1)), positionBuffer.element(i2.mul(3).add(2)),
        ).toVar();
        const nLocal = cross(p1.sub(p0), p2.sub(p0)).normalize().toVar();
        // World normal = transpose(worldToLocal) · nLocal, NOT
        // worldToLocal · nLocal (that maps POINTS/DIRECTIONS world→local —
        // exactly what `roLocal`/`rdLocal` above use — a normal needs the
        // INVERSE-TRANSPOSE of the local→world matrix instead, or a
        // non-uniform scale tilts it off-perpendicular). `worldToLocal` IS
        // already `inverse(matrixWorld)` (see refreshTransforms above), so
        // the inverse-transpose collapses to a plain transpose here — no
        // second inverse needed. (For an affine matrix — no projective row
        // — the upper-left 3x3 of the inverse equals the inverse of the
        // upper-left 3x3, so mat3(worldToLocal) == inverse(mat3(matrixWorld)),
        // matching what three's own `transformNormal(n, matrixWorld)` helper
        // computes internally — cross-checked against that formula, not
        // just re-derived.)
        const local = worldToLocal.element(meshIdx);
        const normalMatrix = mat3(local).transpose().toVar();
        const nWorld = normalMatrix.mul(nLocal).normalize().toVar();
        // Oppose the WORLD ray so `hitPoint + n·offset` (giLight.js) always
        // moves toward the ray's origin side, whichever winding/face side
        // the ray actually hit.
        const nFacing = select(nWorld.dot(rd).greaterThan(0), nWorld.negate(), nWorld).toVar();
        normal.assign(nFacing);
      });

      return { t: bestT, albedo, hasAlbedo, normal };
    },

    dispose() {
      entries.length = 0;
      // See the `let` note above the five arrays. The GPU buffers themselves
      // are destroyed by the caller's retire queue (`storageAttributes`
      // above); this is the JS side, which no attribute release can reach
      // because THIS SCOPE holds it.
      boundsData = null;
      contentsData = null;
      indexData = null;
      positionData = null;
      uvData = null;
      atlasTexture?.dispose?.();
      this.blitTarget?.dispose?.();
    },
  };

  scene.refreshTransforms();
  return scene;
}

const _scratchCorner = new THREE.Vector3();
