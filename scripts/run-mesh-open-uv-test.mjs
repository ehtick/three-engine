// Does *opening* a mesh in the geometry editor preserve its UVs?
//
// Every other UV test drives an operator. This one drives nothing: it loads a
// geometry through `meshFromBufferGeometry` and asks whether the UVs that come
// back out of `tessellate` are the ones that went in. That is the path the user
// takes by double-clicking a mesh, and it has to be a no-op.
//
// The check is per render corner rather than per face, because the failure this
// is hunting shows up as a handful of corners picking up a *neighbouring*
// island's UV — the face still has a plausible-looking, non-degenerate mapping,
// so `run-mesh-uv-test.mjs`'s degeneracy check sails straight past it.
//
// Run: node scripts/run-mesh-open-uv-test.mjs

import * as THREE from "three/webgpu";
import { assetFromMesh, meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { geometryFromAsset } from "../src/engine/geometryAsset.js";
import { tessellate } from "../src/editor/mesh/tessellate.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const QUANTUM = 1e5;
const posKey = (x, y, z) => `${Math.round(x * QUANTUM)},${Math.round(y * QUANTUM)},${Math.round(z * QUANTUM)}`;

/** Every (position -> set of UVs) pair the source geometry actually contains. */
function sourceUVsByPosition(geometry) {
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const table = new Map();
  for (let index = 0; index < position.count; index++) {
    const key = posKey(position.getX(index), position.getY(index), position.getZ(index));
    if (!table.has(key)) table.set(key, []);
    table.get(key).push([uv.getX(index), uv.getY(index)]);
  }
  return table;
}

/**
 * How far each loaded corner's UV is from the closest UV the source had at that
 * same position. Zero means the corner kept a UV it was actually given; a large
 * number means it was handed some other corner's.
 */
function cornerUVDrift(geometry) {
  const table = sourceUVsByPosition(geometry);
  const mesh = meshFromBufferGeometry(geometry);
  const result = tessellate(mesh);
  let worst = 0;
  let offenders = 0;
  let corners = 0;
  for (let index = 0; index < result.uvs.length / 2; index++) {
    const key = posKey(result.positions[index * 3], result.positions[index * 3 + 1], result.positions[index * 3 + 2]);
    const candidates = table.get(key);
    if (!candidates) continue;
    corners++;
    const u = result.uvs[index * 2];
    const v = result.uvs[index * 2 + 1];
    const nearest = Math.min(...candidates.map(([su, sv]) => Math.hypot(u - su, v - sv)));
    if (nearest > 1e-5) offenders++;
    worst = Math.max(worst, nearest);
  }
  return { worst, offenders, corners, mesh };
}

/**
 * UV area per unit of surface area, per face. A mesh with a uniform mapping
 * (a box, a plane) should come back with the density it went in with; a corner
 * that grabbed the wrong island shears the face and moves this.
 */
function uvDensity(face) {
  let uvArea = 0;
  let worldArea = 0;
  const loops = face.loops;
  for (let index = 1; index + 1 < loops.length; index++) {
    const [a, b, c] = [loops[0], loops[index], loops[index + 1]];
    uvArea += Math.abs((b.uv[0] - a.uv[0]) * (c.uv[1] - a.uv[1]) - (c.uv[0] - a.uv[0]) * (b.uv[1] - a.uv[1])) / 2;
    const ab = [b.v.co[0] - a.v.co[0], b.v.co[1] - a.v.co[1], b.v.co[2] - a.v.co[2]];
    const ac = [c.v.co[0] - a.v.co[0], c.v.co[1] - a.v.co[1], c.v.co[2] - a.v.co[2]];
    worldArea += Math.hypot(
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ) / 2;
  }
  return worldArea > 1e-12 ? uvArea / worldArea : 0;
}

const fixtures = [
  ["box 2x2x2", new THREE.BoxGeometry(2, 2, 2), 0.25],
  ["box 2 seg", new THREE.BoxGeometry(2, 2, 2, 2, 2, 2), 0.25],
  ["box 3 seg", new THREE.BoxGeometry(2, 2, 2, 3, 3, 3), 0.25],
  ["box 1x2x4", new THREE.BoxGeometry(1, 2, 4), null],
  ["plane 4 seg", new THREE.PlaneGeometry(2, 2, 4, 4), 0.25],
  ["sphere", new THREE.SphereGeometry(1, 24, 16), null],
  ["cylinder", new THREE.CylinderGeometry(1, 1, 2, 24), null],
  ["torus", new THREE.TorusGeometry(1, 0.4, 16, 32), null],
  ["cone", new THREE.ConeGeometry(1, 2, 24), null],
];

console.log("\n--- opening a mesh must not touch its UVs ---");
for (const [name, geometry] of fixtures) {
  const { worst, offenders, corners } = cornerUVDrift(geometry);
  check(
    `${name}: every corner keeps a UV it was given`,
    offenders === 0,
    `${offenders}/${corners} corners moved, worst drift ${worst.toFixed(4)}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Seams                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The drift check above has one blind spot, and it is the important one.
 *
 * A UV seam is two different UVs at the SAME position — the wrap on a sphere,
 * the join between two atlas islands on a flat wall. Loading welds vertices by
 * position, so both of those render vertices become one kernel vertex, and a
 * corner that picks up the wrong one of the two still measures as zero drift:
 * the UV it ended up with genuinely does exist at that position. It just
 * belongs to the island next door, so the texture on that face jumps.
 *
 * Counting distinct (position, uv) pairs sees it. Every pair a triangle
 * referenced has to come back out, or some corner was silently re-pointed.
 */
const uvKey = (u, v) => `${Math.round(u * QUANTUM)},${Math.round(v * QUANTUM)}`;

function lostUVPairs(geometry) {
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const index = geometry.index ? geometry.index.array : null;
  const cornerCount = index ? index.length : position.count;

  // Only corners a non-degenerate triangle actually uses can be expected back.
  const used = new Set();
  for (let triangle = 0; triangle * 3 < cornerCount; triangle++) {
    const ring = [0, 1, 2].map((k) => (index ? index[triangle * 3 + k] : triangle * 3 + k));
    const keys = ring.map((vertex) => posKey(position.getX(vertex), position.getY(vertex), position.getZ(vertex)));
    if (new Set(keys).size < 3) continue;
    for (const vertex of ring) used.add(vertex);
  }

  const source = new Set();
  const seamPositions = new Map();
  for (const vertex of used) {
    const pk = posKey(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
    source.add(`${pk}#${uvKey(uv.getX(vertex), uv.getY(vertex))}`);
    seamPositions.set(pk, (seamPositions.get(pk) ?? new Set()).add(uvKey(uv.getX(vertex), uv.getY(vertex))));
  }

  const result = tessellate(meshFromBufferGeometry(geometry));
  const out = new Set();
  for (let corner = 0; corner < result.uvs.length / 2; corner++) {
    const pk = posKey(result.positions[corner * 3], result.positions[corner * 3 + 1], result.positions[corner * 3 + 2]);
    out.add(`${pk}#${uvKey(result.uvs[corner * 2], result.uvs[corner * 2 + 1])}`);
  }
  const lost = [...source].filter((pair) => !out.has(pair));
  const seams = [...seamPositions.values()].filter((set) => set.size > 1).length;
  return { lost: lost.length, total: source.size, seams };
}

console.log("\n--- and must not drop a seam's second UV ---");
for (const [name, geometry] of fixtures) {
  const { lost, total, seams } = lostUVPairs(geometry);
  check(
    `${name}: every (position, uv) pair survives`,
    lost === 0,
    `${lost}/${total} lost across ${seams} seam positions`,
  );
}

console.log("\n--- and the mapping density has to survive too ---");
for (const [name, geometry, expected] of fixtures) {
  if (expected === null) continue;
  const mesh = meshFromBufferGeometry(geometry);
  const values = [...mesh.faces].map(uvDensity);
  const off = values.filter((value) => Math.abs(value - expected) > 1e-4);
  check(
    `${name}: uniform density preserved`,
    off.length === 0,
    `${off.length}/${values.length} off ${expected}, range ${Math.min(...values).toFixed(4)}..${Math.max(...values).toFixed(4)}`,
  );
}

/* -------------------------------------------------------------------------- */
/* The write that opening performs                                             */
/* -------------------------------------------------------------------------- */

/**
 * Opening a primitive in Edit Mode is not read-only: `ensureGeometryAsset`
 * makes the mesh single-user by running it through the kernel and writing a
 * `.geom`. Whatever that write loses is lost permanently, before the user has
 * touched anything — so the geometry that comes back off disk has to carry the
 * same UVs as the one that went in.
 */
console.log("\n--- and the .geom that opening writes must round-trip ---");
for (const [name, geometry] of fixtures) {
  const asset = assetFromMesh(meshFromBufferGeometry(geometry));
  // Through JSON, exactly as `ensureGeometryAsset` writes it.
  const reloaded = geometryFromAsset(JSON.parse(JSON.stringify(asset)));
  const uv = reloaded.getAttribute("uv");
  if (!uv) {
    check(`${name}: reopens with UVs`, false, "the uv attribute is gone");
    continue;
  }
  const { lost, total } = lostUVPairs(reloaded);
  const before = lostUVPairs(geometry);
  check(
    `${name}: survives the write opening performs`,
    lost === 0 && total >= before.total,
    `${lost}/${total} lost after reload (source had ${before.total} pairs)`,
  );
}

/* -------------------------------------------------------------------------- */
/* Shading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Opening must not re-shade the mesh either.
 *
 * `addFace` defaults a face to smooth, and a mesh rebuilt from triangles took
 * that default — so a CUBE came back with every corner normal averaged across
 * the three faces meeting there, 54.7° from where it started, and was saved
 * that way by the write entering Edit Mode performs. On screen that is a soft,
 * inflated, wrongly lit box the moment you press Tab.
 *
 * The source normals say which faces were flat; `polygonIsSmooth` reads them,
 * and `tessellate` stops averaging across hard edges so a cylinder's rim keeps
 * the wall and the cap apart.
 */
const normalKey = (x, y, z) => posKey(x, y, z);

function worstNormalDrift(geometry) {
  const asset = assetFromMesh(meshFromBufferGeometry(geometry));
  const reloaded = geometryFromAsset(JSON.parse(JSON.stringify(asset)));
  const sourcePosition = geometry.getAttribute("position");
  const sourceNormal = geometry.getAttribute("normal");
  const outPosition = reloaded.getAttribute("position");
  const outNormal = reloaded.getAttribute("normal");
  if (!sourceNormal || !outNormal) return { worst: 0, off: 0, corners: 0 };

  const source = new Map();
  for (let index = 0; index < sourcePosition.count; index++) {
    const key = normalKey(sourcePosition.getX(index), sourcePosition.getY(index), sourcePosition.getZ(index));
    if (!source.has(key)) source.set(key, []);
    source.get(key).push([sourceNormal.getX(index), sourceNormal.getY(index), sourceNormal.getZ(index)]);
  }

  let worst = 0;
  let off = 0;
  let corners = 0;
  for (let index = 0; index < outPosition.count; index++) {
    const candidates = source.get(normalKey(outPosition.getX(index), outPosition.getY(index), outPosition.getZ(index)));
    if (!candidates) continue;
    corners++;
    const n = [outNormal.getX(index), outNormal.getY(index), outNormal.getZ(index)];
    const best = Math.max(...candidates.map((c) => c[0] * n[0] + c[1] * n[1] + c[2] * n[2]));
    if (best < 0.999) off++;
    worst = Math.max(worst, (Math.acos(Math.max(-1, Math.min(1, best))) * 180) / Math.PI);
  }
  return { worst, off, corners };
}

console.log("\n--- and must not re-shade the mesh ---");
// A welded pole or apex genuinely cannot keep one normal per surrounding
// triangle without per-loop custom normals, and Blender's own cone behaves the
// same way; those are allowed a wider budget than the flat-shaded cases.
const SHADING_BUDGET = { sphere: 5, cone: 64, torus: 2 };
for (const [name, geometry] of fixtures) {
  const { worst, off, corners } = worstNormalDrift(geometry);
  const budget = SHADING_BUDGET[name.split(" ")[0]] ?? 0.5;
  check(
    `${name}: shading survives opening`,
    worst <= budget,
    `${off}/${corners} corners re-shaded, worst ${worst.toFixed(1)}° (budget ${budget}°)`,
  );
}

console.log(failures ? `\n${failures} FAILED` : "\nopening is a no-op for UVs");
process.exit(failures ? 1 : 0);
