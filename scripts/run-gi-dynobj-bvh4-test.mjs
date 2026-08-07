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

// ── analytic default primitives: formula ground truth vs THREE.Raycaster ────
// CPU mirrors of dynShapeHitFn's sphere/capsule/frustum math (same branches,
// same epsilons) against HI-tessellation meshes of the same primitives.
// Facet error at 128+ segments is ~3e-4·r, so the 8e-3 tolerance separates
// formula bugs (gross, sign-level) from silhouette-grazing facet noise.
function shapeHit(type, prm, ro, rd, tMin, tMax) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let bestT = -1;
  const accept = (t) => { if (t >= tMin && t < tMax && (bestT < 0 || t < bestT)) bestT = t; };
  if (type === "sphere") {
    const r = prm[0];
    const a = Math.max(dot(rd, rd), 1e-12);
    const b = dot(ro, rd);
    const c = dot(ro, ro) - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const tN = (-b - sq) / a;
      const tF = (-b + sq) / a;
      if (tN >= tMin) accept(tN);
      else if (tF >= tMin) accept(tMin);
    }
  } else if (type === "capsule") {
    const r = prm[0], hs = prm[1];
    const a = rd[0] * rd[0] + rd[2] * rd[2];
    const b = ro[0] * rd[0] + ro[2] * rd[2];
    const c = ro[0] * ro[0] + ro[2] * ro[2] - r * r;
    if (a > 1e-12) {
      const disc = b * b - a * c;
      if (disc >= 0) {
        const tS = (-b - Math.sqrt(disc)) / a;
        const y = ro[1] + rd[1] * tS;
        if (Math.abs(y) <= hs) accept(tS);
      }
    }
    for (const sgn of [1, -1]) {
      const ro2 = [ro[0], ro[1] - sgn * hs, ro[2]];
      const a2 = Math.max(dot(rd, rd), 1e-12);
      const b2 = dot(ro2, rd);
      const c2 = dot(ro2, ro2) - r * r;
      const d2 = b2 * b2 - a2 * c2;
      if (d2 >= 0) {
        const tC = (-b2 - Math.sqrt(d2)) / a2;
        if ((ro2[1] + rd[1] * tC) * sgn >= 0) accept(tC);
      }
    }
  } else if (type === "frustum") {
    const rB = prm[0], rT = prm[1], hh = prm[2];
    const s = (rT - rB) / (2 * hh);
    const k0 = rB + s * (ro[1] + hh);
    const trySide = (t) => {
      const y = ro[1] + rd[1] * t;
      const kAt = rB + s * (y + hh);
      if (Math.abs(y) <= hh && kAt >= 0) accept(t);
    };
    const a = rd[0] * rd[0] + rd[2] * rd[2] - s * s * rd[1] * rd[1];
    const b = ro[0] * rd[0] + ro[2] * rd[2] - k0 * s * rd[1];
    const c = ro[0] * ro[0] + ro[2] * ro[2] - k0 * k0;
    if (Math.abs(a) > 1e-10) {
      const disc = b * b - a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        trySide((-b - sq) / a);
        trySide((-b + sq) / a);
      }
    } else if (Math.abs(b) > 1e-12) {
      trySide(-c / (2 * b));
    }
    if (Math.abs(rd[1]) > 1e-12) {
      for (const [sgn, rc] of [[1, rT], [-1, rB]]) {
        const t = (sgn * hh - ro[1]) / rd[1];
        const px = ro[0] + rd[0] * t;
        const pz = ro[2] + rd[2] * t;
        if (px * px + pz * pz <= rc * rc) accept(t);
      }
    }
  }
  return bestT;
}

const { classifyDynamicShape, giMobilityOf, giTraceOf } = await import("../src/modules/gi/dynamicObjects.js");
const analyticCases = [
  { name: "sphere", geometry: new THREE.SphereGeometry(0.8, 128, 96) },
  { name: "capsule", geometry: new THREE.CapsuleGeometry(0.5, 1.2, 64, 128) },
  { name: "cylinder-frustum", geometry: new THREE.CylinderGeometry(0.6, 0.3, 1.6, 256) },
  { name: "cone", geometry: new THREE.ConeGeometry(0.7, 1.5, 256) },
];
for (const [ai, { name, geometry }] of analyticCases.entries()) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld(true);
  const shape = classifyDynamicShape(mesh);
  if (!shape || shape.type === "mesh" || shape.type === "obb") {
    console.error(`FAIL analytic:${name}: classified as ${shape?.type ?? "null"} — expected an analytic primitive`);
    failures++;
    continue;
  }
  const raycaster = new THREE.Raycaster();
  raycaster.far = 100;
  seed = 0x7f4a11 + ai * 104729;
  const RAYS = 3000;
  let agree = 0;
  let disagreements = 0;
  let maxDt = 0;
  for (let i = 0; i < RAYS; i++) {
    const o = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize().multiplyScalar(3);
    const target = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).multiplyScalar(i % 4 === 3 ? 4 : 0.8);
    const d = target.sub(o).normalize();
    raycaster.set(o, d);
    const hits = raycaster.intersectObject(mesh, false);
    const refT = hits.length ? hits[0].distance : -1;
    const t = shapeHit(shape.type, shape.params, [o.x, o.y, o.z], [d.x, d.y, d.z], 1e-5, 100);
    if (refT < 0 && t < 0) { agree++; continue; }
    if (refT >= 0 && t >= 0 && Math.abs(refT - t) < 8e-3) {
      maxDt = Math.max(maxDt, Math.abs(refT - t));
      agree++;
      continue;
    }
    disagreements++;
  }
  const rate = disagreements / RAYS;
  const ok = rate <= 0.02 && agree > 0;
  console.log(
    `${ok ? "PASS" : "FAIL"} analytic:${name} (${shape.type}): agree=${agree} ` +
      `disagree=${disagreements}/${RAYS} (${(rate * 100).toFixed(2)}%) maxΔt=${maxDt.toExponential(2)}`,
  );
  if (!ok) failures++;
}

// ── the two GI axes: MOBILITY (does it move) × TRACE (what rays intersect) ───
// They are independent by design. classifyDynamicShape answers TRACE only —
// mobility is GISystem's adoption decision — so a "static" mesh still
// classifies here; what makes it static is that it is never offered.
{
  const mk = (geometry, userData) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    Object.assign(mesh.userData, userData ?? {});
    return mesh;
  };
  const shapeOf = (geometry, userData) => classifyDynamicShape(mk(geometry, userData));
  const torus = new THREE.TorusKnotGeometry(0.8, 0.25, 24, 8);
  const sphere = new THREE.SphereGeometry(0.8, 24, 16);
  const tagChecks = [
    // TRACE axis
    ["trace voxel rejects the exact path", shapeOf(sphere, { giTrace: "voxel" }) === null],
    ["trace bvh forces triangles on a default primitive", shapeOf(sphere, { giTrace: "bvh" })?.type === "mesh"],
    ["trace obb forces the bounding box on a custom mesh", shapeOf(torus, { giTrace: "obb" })?.type === "obb"],
    ["trace auto keeps a sphere analytic", shapeOf(sphere, { giTrace: "auto" })?.type === "sphere"],
    ["untagged sphere stays analytic", shapeOf(sphere, null)?.type === "sphere"],
    ["untagged torus takes the BVH", shapeOf(torus, null)?.type === "mesh"],
    // MOBILITY axis — orthogonal: it must not change the representation
    ["mobility static still classifies (trace is a separate axis)", shapeOf(sphere, { giMobility: "static" })?.type === "sphere"],
    ["mobility static reads back as static", giMobilityOf(mk(sphere, { giMobility: "static" })) === "static"],
    ["mobility dynamic reads back as dynamic", giMobilityOf(mk(sphere, { giMobility: "dynamic" })) === "dynamic"],
    ["untagged mesh is mobility auto", giMobilityOf(mk(sphere, null)) === "auto"],
    ["mobility static + trace bvh is a legal pair", shapeOf(sphere, { giMobility: "static", giTrace: "bvh" })?.type === "mesh"],
    // LEGACY giDynamic migration — each old value meant a (mobility, trace) pair
    ["legacy static → mobility static", giMobilityOf(mk(sphere, { giDynamic: "static" })) === "static"],
    ["legacy voxel → trace voxel", giTraceOf(mk(sphere, { giDynamic: "voxel" })) === "voxel"],
    ["legacy voxel rejects the exact path", shapeOf(sphere, { giDynamic: "voxel" }) === null],
    ["legacy bvh → mobility dynamic", giMobilityOf(mk(sphere, { giDynamic: "bvh" })) === "dynamic"],
    ["legacy bvh → trace bvh", shapeOf(sphere, { giDynamic: "bvh" })?.type === "mesh"],
    ["legacy obb → trace obb", shapeOf(torus, { giDynamic: "obb" })?.type === "obb"],
    ["legacy dynamic → mobility dynamic, trace auto", giMobilityOf(mk(torus, { giDynamic: "dynamic" })) === "dynamic" &&
      shapeOf(torus, { giDynamic: "dynamic" })?.type === "mesh"],
    ["new tags win over a stale legacy tag", giMobilityOf(mk(sphere, { giDynamic: "dynamic", giMobility: "static" })) === "static"],
  ];
  for (const [label, ok] of tagChecks) {
    console.log(`${ok ? "PASS" : "FAIL"} tag: ${label}`);
    if (!ok) failures++;
  }
}

if (failures) {
  console.error(`gi-dynobj-bvh4: ${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("gi-dynobj-bvh4: all cases PASS");
