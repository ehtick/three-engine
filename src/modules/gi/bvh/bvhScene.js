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
// PER-GEOMETRY BLAS CACHE: keyed by geometry object identity (WeakMap), so
// N mesh instances sharing one geometry (an instanced prop, a duplicated
// wall) build the BVH once. v1 does NOT track content versioning the way
// the SDF cache's `contentKey` does (no `position.version` in the key) — an
// in-place geometry edit (BMesh editor) that mutates the SAME geometry
// object will not refresh cached BVH triangles until the object identity
// changes (e.g. a new geometry asset load). This mirrors the task's scoped
// ask ("keyed by geometry") and is an accepted v1 gap alongside the skinned
// exclusion.
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

/** Hard cap on meshes seated into one BVH scene — bounds per-frame loop cost. */
export const MAX_BVH_MESHES = 64;
/** Per-mesh triangle cap — a single 150k-tri BLAS is already a deep tree. */
export const MAX_TRIS_PER_BVH_MESH = 150_000;

const BYTES_PER_NODE = 32; // 6 f32 (24B) + 2 u32 (8B) — three-mesh-bvh core/Constants.js
const UINT32_PER_NODE = BYTES_PER_NODE / 4; // 8

// geometry -> { nodeCount, triCount, vertexCount, bounds, contents, index, position, boundsMin, boundsMax }
const blasCache = new WeakMap();

/**
 * Packs one geometry's MeshBVH into flat CPU typed arrays, byte-identical
 * in layout to bvhGpu.js's `buildBvhTextures` (see that file's header for
 * why: three-mesh-bvh's packed node = 6 f32 bounds + 2 u32 contents, read
 * straight out of `bvh._roots[0]`). Cached per geometry so repeated
 * instances / repeated builds reuse the same CPU work. Returns null for
 * multi-root geometry (multi-material groups) — out of scope, same as the
 * spike, callers treat it as an exclusion.
 */
function packGeometryBlas(geometry) {
  const cached = blasCache.get(geometry);
  if (cached) return cached;

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
  const savedGroups = geometry.groups;
  geometry.groups = [];
  let bvh;
  try {
    bvh = new MeshBVH(geometry);
  } finally {
    geometry.groups = savedGroups;
  }
  if (bvh._roots.length !== 1) {
    console.warn(`[gi] bvh: skipping a geometry (${bvh._roots.length} BVH roots after degrouping — unexpected, likely a non-contiguous draw range)`);
    blasCache.set(geometry, null);
    return null;
  }

  const root = bvh._roots[0];
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

  const indexAttr = geometry.index;
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

  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;

  const packed = {
    nodeCount, triCount, vertexCount,
    bounds, contents, index, position, uv,
    boundsMin: bb ? bb.min.clone() : new THREE.Vector3(-0.5, -0.5, -0.5),
    boundsMax: bb ? bb.max.clone() : new THREE.Vector3(0.5, 0.5, 0.5),
  };
  blasCache.set(geometry, packed);
  return packed;
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

// Tile grid for the per-mesh albedo atlas (buildAlbedoAtlas): 8x8 tiles of
// 256x256 == MAX_BVH_MESHES exactly, so the tile index IS the mesh table
// index (offsets/aabbMin/worldToLocal's own `i`) — no separate mesh->tile
// map to keep in sync. Bump one, check the other. Exported so giScreen.js's
// blitBvhAtlasTiles can compute the same per-tile pixel rects when it
// GPU-renders tiles the canvas 2D path here could not draw.
export const ALBEDO_ATLAS_TILE = 256;
export const ALBEDO_ATLAS_GRID = 8; // 8 * 8 === MAX_BVH_MESHES
export const ALBEDO_ATLAS_SIZE = ALBEDO_ATLAS_TILE * ALBEDO_ATLAS_GRID; // 2048

/**
 * Bakes one atlas of per-mesh albedo (GI Phase 3 v2 — texture-at-hit, see
 * docs/GI_PLAN.md): a 2048x2048 canvas, 8x8 grid of 256x256 tiles, tile
 * index === the mesh's table index. A mesh whose material carries a
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
function buildAlbedoAtlas(entries) {
  const canvas =
    typeof document !== "undefined"
      ? Object.assign(document.createElement("canvas"), { width: ALBEDO_ATLAS_SIZE, height: ALBEDO_ATLAS_SIZE })
      : new OffscreenCanvas(ALBEDO_ATLAS_SIZE, ALBEDO_ATLAS_SIZE);
  const ctx = canvas.getContext("2d");
  let texturedCount = 0;
  // Tiles the canvas 2D path above could not draw — consumed exactly once by
  // blitBvhAtlasTiles (giScreen.js), which clears this back to [] once the
  // GPU pass has overwritten them for real (see that function's comment).
  const pendingGpuTiles = [];
  entries.forEach((entry, i) => {
    const tileX = (i % ALBEDO_ATLAS_GRID) * ALBEDO_ATLAS_TILE;
    const tileY = Math.floor(i / ALBEDO_ATLAS_GRID) * ALBEDO_ATLAS_TILE;
    const material = Array.isArray(entry.mesh.material) ? entry.mesh.material[0] : entry.mesh.material;
    const map = material?.map;
    let drew = false;
    if (map) {
      const image = map.image ?? map.source?.data;
      if (image && image.width > 0 && image.height > 0) {
        ctx.save();
        try {
          // Local tile space (0,0)-(TILE,TILE), Y-flipped so the source
          // image's row 0 lands at the BOTTOM of the tile — see the FLIP
          // note above.
          ctx.translate(tileX, tileY + ALBEDO_ATLAS_TILE);
          ctx.scale(1, -1);
          ctx.drawImage(image, 0, 0, ALBEDO_ATLAS_TILE, ALBEDO_ATLAS_TILE);
          drew = true;
        } catch {
          drew = false;
        } finally {
          ctx.restore();
        }
      }
    }
    if (drew) {
      texturedCount++;
    } else {
      ctx.fillStyle = material?.color ? `#${material.color.getHexString()}` : "#808080";
      ctx.fillRect(tileX, tileY, ALBEDO_ATLAS_TILE, ALBEDO_ATLAS_TILE);
    }
    // GPU-blit candidate: the canvas draw failed for any reason (no
    // CPU-readable image, zero-size, a decode error — `!drew`), or the map
    // is flatly a compressed texture. For a CompressedTexture `drew` is
    // already false in every observed case (caught by the try/catch above),
    // but the explicit `isCompressedTexture` check keeps this correct even
    // if some future/other path lets a compressed map through the canvas
    // silently — the GPU sample is the authoritative one either way, so it
    // still gets queued to overwrite whatever the canvas produced.
    if (map && (!drew || map.isCompressedTexture)) {
      pendingGpuTiles.push({ map, tileIndex: i });
    }
  });

  const atlasTexture = new THREE.CanvasTexture(canvas);
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTexture.flipY = false;
  atlasTexture.minFilter = THREE.LinearFilter;
  atlasTexture.magFilter = THREE.LinearFilter;
  atlasTexture.generateMipmaps = false;
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  atlasTexture.needsUpdate = true;
  return { atlasTexture, texturedCount, pendingGpuTiles };
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
  const eligible = [];
  // Real geometry the BVH cannot see (skinned/unindexed/over-cap). These
  // are NOT dropped silently: their live world AABBs feed the coverage
  // flag (`dynamicBlocked`) so pixels whose mirror ray could cross them
  // fall back to the SDF trace — BVH-alone ERASED rigged characters from
  // every mirror (user-reported regression).
  const dynamicMeshes = [];
  const excludedNames = [];
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
      console.warn(`[gi] bvh: skipping "${mesh.name || "mesh"}" (${Math.round(triCount)} tris > ${MAX_TRIS_PER_BVH_MESH} bvh cap)`);
      dynamicMeshes.push(mesh);
      continue;
    }
    eligible.push(mesh);
  }
  if (excludedNames.length) {
    console.warn(`[gi] bvh: excluded (skinned/unindexed): ${excludedNames.join(", ")} — SDF fallback via coverage flag`);
  }
  let capped = eligible;
  if (eligible.length > MAX_BVH_MESHES) {
    console.warn(`[gi] bvh: ${eligible.length} eligible meshes exceed the ${MAX_BVH_MESHES}-mesh cap — seating the first ${MAX_BVH_MESHES}`);
    capped = eligible.slice(0, MAX_BVH_MESHES);
    dynamicMeshes.push(...eligible.slice(MAX_BVH_MESHES));
  }

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

  const boundsData = new Float32Array(Math.max(1, totalNodes * 6));
  const contentsData = new Uint32Array(Math.max(1, totalNodes * 2));
  const indexData = new Uint32Array(Math.max(1, totalTris * 3));
  const positionData = new Float32Array(Math.max(1, totalVerts * 3));
  // Concatenated with the SAME per-vertex numbering as positionData (both
  // indexed by `positionOffset`) — the hit-albedo lookup in `firstHit`
  // resolves a UV at exactly the global vertex id it resolves a position at.
  const uvData = new Float32Array(Math.max(1, totalVerts * 2));
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
  // x=ox, y=oy (both 0..1 atlas UV, tile origin), z=tileScale (TILE/ATLAS_SIZE), w=1.
  // Capacity-fixed at MAX_BVH_MESHES like the tables above — tile index i
  // IS the mesh table index (see buildAlbedoAtlas), so this needs no extra
  // indirection.
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
  const { atlasTexture, texturedCount, pendingGpuTiles } = buildAlbedoAtlas(entries);
  entries.forEach((entry, i) => {
    const tileX = i % ALBEDO_ATLAS_GRID;
    const tileY = Math.floor(i / ALBEDO_ATLAS_GRID);
    albedoTile.array[i].set(tileX / ALBEDO_ATLAS_GRID, tileY / ALBEDO_ATLAS_GRID, ALBEDO_ATLAS_TILE / ALBEDO_ATLAS_SIZE, 1);
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
      atlasTexture?.dispose?.();
      this.blitTarget?.dispose?.();
    },
  };

  scene.refreshTransforms();
  return scene;
}

const _scratchCorner = new THREE.Vector3();
