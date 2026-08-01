// SPIKE (not production integration — see scripts/run-gi-bvh-spike.mjs).
//
// Question: can three-mesh-bvh's packed BVH be traversed in WGSL on this
// r185 WebGPU/TSL stack, correctly and fast?
//
// PACKING PATH: storage buffers, not DataTextures.
//   The task's first choice was three-mesh-bvh's `MeshBVHUniformStruct`
//   (float bounds DataTexture + uint contents DataTexture, from
//   node_modules/three-mesh-bvh/src/webgl/MeshBVHUniformStruct.js) with a
//   fallback to storage buffers if uint textures fight the WebGPU backend.
//   The installed three-mesh-bvh (0.9.13) turned out to be a much newer
//   major version than the task assumed: it ships its own native WebGPU/TSL
//   BVH module (node_modules/three-mesh-bvh/src/webgpu/), and that module's
//   OWN raycast traversal (src/webgpu/bvh_ray_functions.wgsl.js,
//   `bvhIntersectFirstHit`) packs node/index/position data as raw
//   `ptr<storage, array<T>, read>` buffers — NOT textures. Combined with
//   zero precedent for uint DataTextures anywhere in this repo's TSL compute
//   code (src/modules/gi uses instancedArray/storage buffers exclusively,
//   e.g. voxelizeOnce.js), that is strong evidence textures are the wrong
//   tool here, so this spike goes straight to storage buffers (an
//   explicitly acceptable spike vehicle per the task) rather than staging a
//   doomed texture attempt for its own sake.
//
// LAYOUT: 4 flat, homogeneous storage buffers (scalar f32 / u32 element
// type only — never vec3, to sidestep WGSL's storage-array vec3 stride
// (align 16, size 12 => 16-byte stride) which would silently mismatch a
// tightly-packed (12-byte-stride) JS Float32Array):
//   bounds   : array<f32>  length nodeCount*6   (min.xyz, max.xyz)
//   contents : array<u32>  length nodeCount*2   (offset, splitAxisOrCount)
//   index    : array<u32>  length triCount*3    (flat triangle vertex ids)
//   position : array<f32>  length vertexCount*3 (flat vertex positions)
// This mirrors the packed node layout three-mesh-bvh already builds on the
// CPU (core/Constants.js BYTES_PER_NODE=32 = 8 uint32 per node: 6 f32 bounds
// + rightChildOrTriangleOffset (u32) + splitAxisOrTriangleCount (u32), see
// core/utils/nodeBufferUtils.js) — bounds/contents below are copied
// straight out of `bvh._roots[0]` with no re-derivation.
//
// Rays are passed BY VALUE (vec3f params), not through a buffer — only the
// 4 BVH data arrays are `ptr<storage>` params, keeping the raw-WGSL surface
// small.
import { MeshBVH } from "three-mesh-bvh";
import { attributeArray, wgslFn } from "three/tsl";

const BYTES_PER_NODE = 32; // 6 f32 (24B) + 2 u32 (8B), see three-mesh-bvh core/Constants.js
const UINT32_PER_NODE = BYTES_PER_NODE / 4; // 8

/**
 * Builds a MeshBVH for `geometry` and packs it into GPU storage-buffer
 * nodes ready to feed to {@link bvhIntersectFirstHitFn}.
 *
 * Named `buildBvhTextures` to match the spike's spec'd deliverable name —
 * despite the name, this returns TSL StorageBufferNodes, not DataTextures
 * (see file header for why).
 *
 * @param {THREE.BufferGeometry} geometry indexed geometry with a position attribute
 * @param {object} [bvhOptions] forwarded to `new MeshBVH(geometry, options)`
 * @returns {{
 *   bvh: MeshBVH, geometry: THREE.BufferGeometry,
 *   nodeCount: number, triCount: number, vertexCount: number,
 *   boundsBuffer: import('three/webgpu').StorageBufferNode,
 *   contentsBuffer: import('three/webgpu').StorageBufferNode,
 *   indexBuffer: import('three/webgpu').StorageBufferNode,
 *   positionBuffer: import('three/webgpu').StorageBufferNode,
 * }}
 */
export function buildBvhTextures(geometry, bvhOptions = {}) {
  if (!geometry.index) {
    throw new Error("bvhGpu.buildBvhTextures: geometry must be indexed (spike scope only).");
  }

  const bvh = new MeshBVH(geometry, bvhOptions);

  // A plain single-group geometry (no multi-material ranges) always builds
  // exactly one root. Multi-root (indirect / grouped) BVHs are out of scope
  // for this spike — fail loudly rather than silently traversing only the
  // first root.
  if (bvh._roots.length !== 1) {
    throw new Error(
      `bvhGpu.buildBvhTextures: expected exactly 1 BVH root for spike scope, got ${bvh._roots.length} ` +
        `(geometry likely has multiple groups — not handled by this spike).`,
    );
  }

  const root = bvh._roots[0];
  const nodeCount = root.byteLength / BYTES_PER_NODE;
  const rootF32 = new Float32Array(root);
  const rootU32 = new Uint32Array(root);

  const boundsData = new Float32Array(nodeCount * 6);
  const contentsData = new Uint32Array(nodeCount * 2);
  for (let i = 0; i < nodeCount; i++) {
    const base = i * UINT32_PER_NODE;
    const b6 = i * 6;
    // bounds: first 6 f32 of the node (min.xyz, max.xyz) — byte-identical
    // to what three-mesh-bvh's own CPU raycastFirst reads.
    boundsData[b6 + 0] = rootF32[base + 0];
    boundsData[b6 + 1] = rootF32[base + 1];
    boundsData[b6 + 2] = rootF32[base + 2];
    boundsData[b6 + 3] = rootF32[base + 3];
    boundsData[b6 + 4] = rootF32[base + 4];
    boundsData[b6 + 5] = rootF32[base + 5];
    // contents: uint32[6] = rightChildOrTriangleOffset, uint32[7] =
    // splitAxisOrTriangleCount (leaf flag lives in its upper 16 bits).
    contentsData[i * 2 + 0] = rootU32[base + 6];
    contentsData[i * 2 + 1] = rootU32[base + 7];
  }

  const indexAttr = geometry.index;
  const triCount = indexAttr.count / 3;
  const indexData = new Uint32Array(indexAttr.count);
  for (let i = 0; i < indexAttr.count; i++) indexData[i] = indexAttr.getX(i);

  const posAttr = geometry.attributes.position;
  const vertexCount = posAttr.count;
  const positionData = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positionData[i * 3 + 0] = posAttr.getX(i);
    positionData[i * 3 + 1] = posAttr.getY(i);
    positionData[i * 3 + 2] = posAttr.getZ(i);
  }

  // .toReadOnly() so the generated top-level `var<storage, ...>` binding's
  // access mode matches the `read` annotation hand-written into
  // bvhIntersectFirstHitFn's ptr<storage, array<T>, read> parameters below.
  const boundsBuffer = attributeArray(boundsData, "float").toReadOnly();
  const contentsBuffer = attributeArray(contentsData, "uint").toReadOnly();
  const indexBuffer = attributeArray(indexData, "uint").toReadOnly();
  const positionBuffer = attributeArray(positionData, "float").toReadOnly();

  return { bvh, geometry, nodeCount, triCount, vertexCount, boundsBuffer, contentsBuffer, indexBuffer, positionBuffer };
}

/**
 * BVH first-hit traversal ported to WGSL, faithful to three-mesh-bvh's
 * iterative stack algorithm (near-child-first ordering via the node's split
 * axis, slab AABB test, leaf triangle loop) — cross-checked against both
 * the classic GLSL (node_modules/three-mesh-bvh/src/webgl/glsl/
 * bvh_ray_functions.glsl.js) and that same library's own WGSL port
 * (src/webgpu/bvh_ray_functions.wgsl.js `bvhIntersectFirstHit`), re-authored
 * here against the flat scalar-array layout `buildBvhTextures` produces
 * (their version uses `array<vec3u>`/`array<vec3f>`/a custom `BVHNode`
 * struct instead).
 *
 * Triangle leaf test is standard Möller–Trumbore (double-sided: the sign of
 * `det` is not used to cull backfaces, matching `bvh.raycastFirst(ray,
 * THREE.DoubleSide)` on the CPU side for a fair comparison).
 *
 * Signature: (ro, rd, bounds, contents, index, position) -> vec4f(t, u, v,
 * triIndexAsFloat). t < 0 on miss.
 */
export const bvhIntersectFirstHitFn = wgslFn(/* wgsl */ `

	fn bvhIntersectFirstHit(
		ro: vec3f,
		rd: vec3f,
		bounds: ptr<storage, array<f32>, read>,
		contents: ptr<storage, array<u32>, read>,
		indices: ptr<storage, array<u32>, read>,
		positions: ptr<storage, array<f32>, read>
	) -> vec4f {

		var stack: array<u32, 64>;
		var stackPtr: i32 = 0;
		stack[0] = 0u;

		var bestT: f32 = 1e20;
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

			let boundsHit = bvhSlab( ro, rd, bmin, bmax, bestT );
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

					let ti = ( offset + i ) * 3u;
					let i0 = indices[ ti ];
					let i1 = indices[ ti + 1u ];
					let i2 = indices[ ti + 2u ];

					let pa = vec3f( positions[ i0 * 3u ], positions[ i0 * 3u + 1u ], positions[ i0 * 3u + 2u ] );
					let pb = vec3f( positions[ i1 * 3u ], positions[ i1 * 3u + 1u ], positions[ i1 * 3u + 2u ] );
					let pc = vec3f( positions[ i2 * 3u ], positions[ i2 * 3u + 1u ], positions[ i2 * 3u + 2u ] );

					let hit = intersectTriMT( ro, rd, pa, pb, pc );
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

	fn bvhSlab( ro: vec3f, rd: vec3f, bmin: vec3f, bmax: vec3f, bestT: f32 ) -> f32 {

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

	fn intersectTriMT( ro: vec3f, rd: vec3f, a: vec3f, b: vec3f, c: vec3f ) -> vec4f {

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
