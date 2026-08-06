// EXACT-DYNAMIC BVH4 CORRECTNESS — CPU ground truth for the packed structure
// the WGSL traversal reads (dynamicObjects.js buildBvh4Words).
//
// The GPU smoke arm (?dynobj=2) proves the pipeline COMPILES and the mover
// leaves the occupancy; this suite proves the intersections are RIGHT: a CPU
// traversal of the exact packed words (line-for-line the WGSL algorithm —
// same ref encoding, same slab test, same Möller–Trumbore epsilons) must
// agree with THREE.Raycaster (double-sided) on thousands of random rays over
// several geometry classes. Any packing/collapse/layout bug shows up as a
// hit/miss or t disagreement here, with no GPU in the loop.
//
// Run: node scripts/run-gi-dynobj-bvh4-test.mjs
import * as THREE from "three/webgpu";
import { buildBvhWords } from "../src/modules/gi/dynamicObjects.js";

// ── CPU mirror of the WGSL traversals (bvh4TraceWgsl / bvh8TraceWgsl) ───────
// Line-for-line the shader algorithm, including the compressed 8-wide node
// decode (origin + power-of-two step + u8 boxes).
function traceBvh(arity, words, nodeBase, triBase, roL, rdL, tMin, tMax) {
  const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
  const stack = [1]; // root internal ref
  let bestT = tMax;
  let found = false;
  const nz = (x) => (Math.abs(x) < 1e-9 ? (x >= 0 ? 1e-9 : -1e-9) : x);
  const inv = [1 / nz(rdL[0]), 1 / nz(rdL[1]), 1 / nz(rdL[2])];
  let guard = 0;
  while (stack.length > 0 && guard++ < 768) {
    const nref = stack.pop();
    if (nref === 0) continue;
    if (nref & 0x80000000) {
      const triStart = nref & 0x00ffffff;
      const triCount = (nref >>> 24) & 0x7f;
      for (let j = 0; j < triCount; j++) {
        const tw = triBase + (triStart + j) * 9;
        const ax = f32[tw], ay = f32[tw + 1], az = f32[tw + 2];
        const bx = f32[tw + 3], by = f32[tw + 4], bz = f32[tw + 5];
        const cx = f32[tw + 6], cy = f32[tw + 7], cz = f32[tw + 8];
        const e1 = [bx - ax, by - ay, bz - az];
        const e2 = [cx - ax, cy - ay, cz - az];
        const h = [rdL[1] * e2[2] - rdL[2] * e2[1], rdL[2] * e2[0] - rdL[0] * e2[2], rdL[0] * e2[1] - rdL[1] * e2[0]];
        const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
        if (Math.abs(det) < 1e-10) continue;
        const invDet = 1 / det;
        const s = [roL[0] - ax, roL[1] - ay, roL[2] - az];
        const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) * invDet;
        const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
        const v = (rdL[0] * q[0] + rdL[1] * q[1] + rdL[2] * q[2]) * invDet;
        const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * invDet;
        if (u >= -1e-4 && v >= -1e-4 && u + v <= 1.0001 && t > tMin && t < bestT) {
          bestT = t;
          found = true;
        }
      }
      continue;
    }
    const hits = [];
    if (arity === 8) {
      const nb = nodeBase + (nref - 1) * 28;
      const ox = f32[nb], oy = f32[nb + 1], oz = f32[nb + 2];
      const ep = words[nb + 3];
      const sx = 2 ** ((ep & 0xff) - 128);
      const sy = 2 ** (((ep >>> 8) & 0xff) - 128);
      const sz = 2 ** (((ep >>> 16) & 0xff) - 128);
      for (let ci = 0; ci < 8; ci++) {
        const cref = words[nb + 4 + ci];
        if (cref === 0) continue;
        const qa = words[nb + 12 + ci * 2];
        const qb = words[nb + 13 + ci * 2];
        const bmin = [ox + (qa & 0xff) * sx, oy + ((qa >>> 8) & 0xff) * sy, oz + ((qa >>> 16) & 0xff) * sz];
        const bmax = [ox + ((qa >>> 24) & 0xff) * sx, oy + (qb & 0xff) * sy, oz + ((qb >>> 8) & 0xff) * sz];
        let te = tMin;
        let tx = bestT;
        for (let a = 0; a < 3; a++) {
          const t0 = (bmin[a] - roL[a]) * inv[a];
          const t1 = (bmax[a] - roL[a]) * inv[a];
          te = Math.max(te, Math.min(t0, t1));
          tx = Math.min(tx, Math.max(t0, t1));
        }
        if (tx < te) continue;
        hits.push([te, cref]);
      }
    } else {
      const nb = nodeBase + (nref - 1) * 28;
      for (let ci = 0; ci < 4; ci++) {
        const cref = words[nb + ci];
        if (cref === 0) continue;
        const bb = nb + 4 + ci * 6;
        let te = tMin;
        let tx = bestT;
        for (let a = 0; a < 3; a++) {
          const t0 = (f32[bb + a] - roL[a]) * inv[a];
          const t1 = (f32[bb + 3 + a] - roL[a]) * inv[a];
          te = Math.max(te, Math.min(t0, t1));
          tx = Math.min(tx, Math.max(t0, t1));
        }
        if (tx < te) continue;
        hits.push([te, cref]);
      }
    }
    hits.sort((a, b) => a[0] - b[0]);
    for (let i = hits.length - 1; i >= 0; i--) stack.push(hits[i][1]);
  }
  return found ? bestT : -1;
}

// ── deterministic PRNG (no Math.random in harnesses — reproducible failures) ─
let seed = 0x2f6e2b1;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const cases = [
  { name: "torus-knot", geometry: new THREE.TorusKnotGeometry(0.8, 0.25, 64, 16) },
  { name: "icosphere", geometry: new THREE.IcosahedronGeometry(1, 3) },
  { name: "cone", geometry: new THREE.ConeGeometry(0.7, 1.6, 24, 4) },
  {
    name: "non-indexed-soup",
    geometry: (() => {
      // 300 random triangles in a 2-unit cube, NON-indexed — exercises the
      // generated-index path and irregular leaf shapes.
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(300 * 9);
      for (let i = 0; i < pos.length; i++) pos[i] = (rand() * 2 - 1) * 1.0;
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      return g;
    })(),
  },
];

// Brute-force nearest hit over the WHOLE packed triangle pool with the SAME
// Möller–Trumbore epsilons the traversal uses. The arbiter: a ray where the
// traversal differs from THIS is a structure/traversal bug (hard fail); a ray
// where both agree but three's Raycaster differs is intersector-epsilon class
// (different barycentric/det epsilons on sliver triangles — tolerated tail).
function bruteForce(words, triBase, triCount, roL, rdL, tMin, tMax) {
  const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
  let bestT = tMax;
  let found = false;
  for (let ti = 0; ti < triCount; ti++) {
    const tw = triBase + ti * 9;
    const ax = f32[tw], ay = f32[tw + 1], az = f32[tw + 2];
    const bx = f32[tw + 3], by = f32[tw + 4], bz = f32[tw + 5];
    const cx = f32[tw + 6], cy = f32[tw + 7], cz = f32[tw + 8];
    const e1 = [bx - ax, by - ay, bz - az];
    const e2 = [cx - ax, cy - ay, cz - az];
    const h = [rdL[1] * e2[2] - rdL[2] * e2[1], rdL[2] * e2[0] - rdL[0] * e2[2], rdL[0] * e2[1] - rdL[1] * e2[0]];
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-10) continue;
    const invDet = 1 / det;
    const s = [roL[0] - ax, roL[1] - ay, roL[2] - az];
    const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) * invDet;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (rdL[0] * q[0] + rdL[1] * q[1] + rdL[2] * q[2]) * invDet;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * invDet;
    if (u >= -1e-4 && v >= -1e-4 && u + v <= 1.0001 && t > tMin && t < bestT) {
      bestT = t;
      found = true;
    }
  }
  return found ? bestT : -1;
}

let failures = 0;
const arms = [];
for (const arity of [4, 8]) {
  for (const c of cases) arms.push({ ...c, arity });
}
for (const [caseIndex, { name: baseName, geometry, arity }] of arms.entries()) {
  const name = `${baseName}@bvh${arity}`;
  const packed = buildBvhWords(geometry, arity);
  if (!packed) {
    console.error(`FAIL ${name}: buildBvhWords returned null`);
    failures++;
    continue;
  }
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  raycaster.far = 100;

  // Independent deterministic stream per case — failures reproduce standalone.
  seed = 0x1234567 + caseIndex * 7919;
  const RAYS = 3000;
  let hitAgree = 0;
  let missAgree = 0;
  let epsilonClass = 0;
  let structureBugs = 0;
  let maxDt = 0;
  for (let i = 0; i < RAYS; i++) {
    // Origins on a sphere of radius 3, directions biased through the volume
    // (plus a tail of fully random directions for grazing coverage).
    const o = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize().multiplyScalar(3);
    const target = i % 4 === 3
      ? new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).multiplyScalar(4)
      : new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).multiplyScalar(0.9);
    const d = target.sub(o).normalize();

    raycaster.set(o, d);
    const hits = raycaster.intersectObject(mesh, false);
    const refT = hits.length ? hits[0].distance : -1;

    const ro = [o.x, o.y, o.z];
    const rd = [d.x, d.y, d.z];
    const t = traceBvh(arity, packed.words, 0, packed.nodeWords, ro, rd, 1e-5, 100);

    if (refT < 0 && t < 0) { missAgree++; continue; }
    if (refT >= 0 && t >= 0) {
      const dt = Math.abs(refT - t);
      maxDt = Math.max(maxDt, dt);
      if (dt < 1e-3) { hitAgree++; continue; }
    }
    // Arbitration: does the traversal at least match brute force over its own
    // packed pool? If yes the tree is sound and the delta vs three is the
    // known epsilon tail; if no the structure/traversal is broken.
    const bruteT = bruteForce(packed.words, packed.nodeWords, packed.triCount, ro, rd, 1e-5, 100);
    const agreesBrute = (bruteT < 0 && t < 0) || (bruteT >= 0 && t >= 0 && Math.abs(bruteT - t) < 1e-6);
    if (agreesBrute) epsilonClass++;
    else {
      structureBugs++;
      if (structureBugs <= 3) {
        console.error(`  structure bug on ray ${i}: raycaster=${refT.toFixed(5)} trace=${t.toFixed(5)} brute=${bruteT.toFixed(5)}`);
      }
    }
  }
  const ok = structureBugs === 0 && epsilonClass / RAYS <= 0.02 && (hitAgree + missAgree) > 0;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}: tris=${packed.triCount} nodes=${packed.nodeWords / 28} ` +
      `words=${packed.words.length} — agree hit=${hitAgree} miss=${missAgree} ` +
      `epsilon-class=${epsilonClass} structure-bugs=${structureBugs}/${RAYS} maxΔt=${maxDt.toExponential(2)}`,
  );
  if (!ok) failures++;
}

if (failures) {
  console.error(`gi-dynobj-bvh4: ${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("gi-dynobj-bvh4: all cases PASS");
