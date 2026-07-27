// Opens real `.geom` files the way Edit Mode does and measures what happened to
// their UVs. Diagnostic probe, not a test — point it at a project:
//
//   node scripts/run-geom-open-uv-probe.mjs "C:/Users/.../GAME" [limit]
//
// Two metrics, because the obvious one has a blind spot:
//
//   drift    for each output corner, how far its UV is from the nearest UV the
//            source had AT THAT POSITION. Catches a corner inventing a UV.
//            Blind to a corner stealing a *neighbour's* UV at the same position,
//            which is exactly what a UV seam is.
//
//   lost     distinct (position, uv) pairs the source had and the output does
//            not. A seam is two pairs at one position; drop one and the faces
//            that used it silently jump to the other island's mapping. This is
//            the metric that sees it.

import fs from "node:fs";
import path from "node:path";
import { decodeGeometryAsset, geometryFromAsset } from "../src/engine/geometryAsset.js";
import { meshFromBufferGeometry } from "../src/editor/mesh/io.js";
import { tessellate } from "../src/editor/mesh/tessellate.js";

const root = process.argv[2] ?? "C:/Users/Khudiiash/Documents/GAME";
const limit = Number(process.argv[3] ?? 12);

const QUANTUM = 1e5;
const posKey = (x, y, z) => `${Math.round(x * QUANTUM)},${Math.round(y * QUANTUM)},${Math.round(z * QUANTUM)}`;
const uvKey = (u, v) => `${Math.round(u * QUANTUM)},${Math.round(v * QUANTUM)}`;

function loadGeom(file) {
  const buffer = fs.readFileSync(file);
  const array = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const isBinary = buffer.byteLength >= 12 && new DataView(array).getUint32(0, true) === 0x4d4f4547;
  const definition = isBinary ? decodeGeometryAsset(array) : JSON.parse(buffer.toString("utf8"));
  return { geometry: geometryFromAsset(definition), definition };
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.toLowerCase().endsWith(".geom")) out.push(full);
  }
  return out;
}

const files = walk(root).slice(0, limit);
console.log(`\nprobing ${files.length} .geom files under ${root}\n`);

for (const file of files) {
  let geometry;
  let definition;
  try {
    ({ geometry, definition } = loadGeom(file));
  } catch (error) {
    console.log(`  ERR  ${path.relative(root, file)} — ${error.message}`);
    continue;
  }
  const uv = geometry.getAttribute("uv");
  const position = geometry.getAttribute("position");
  if (!uv || !geometry.index) {
    console.log(`  --   ${path.relative(root, file)} — no uv attribute or no index`);
    continue;
  }

  // Only corners a non-degenerate triangle actually references can be expected
  // to survive; anything else is legitimately dropped.
  const index = geometry.index.array;
  const used = new Set();
  for (let triangle = 0; triangle * 3 < index.length; triangle++) {
    const ring = [index[triangle * 3], index[triangle * 3 + 1], index[triangle * 3 + 2]];
    const keys = ring.map((vertex) => posKey(position.getX(vertex), position.getY(vertex), position.getZ(vertex)));
    if (new Set(keys).size < 3) continue;
    for (const vertex of ring) used.add(vertex);
  }

  const sourcePairs = new Set();
  const uvsAt = new Map();
  for (const vertex of used) {
    const pk = posKey(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
    const uk = uvKey(uv.getX(vertex), uv.getY(vertex));
    sourcePairs.add(`${pk}#${uk}`);
    if (!uvsAt.has(pk)) uvsAt.set(pk, new Set());
    uvsAt.get(pk).add(uk);
  }
  const seamPositions = [...uvsAt.values()].filter((set) => set.size > 1).length;

  const started = Date.now();
  const mesh = meshFromBufferGeometry(geometry);
  const result = tessellate(mesh);
  const elapsed = Date.now() - started;

  const outputPairs = new Set();
  let offenders = 0;
  let worst = 0;
  const corners = result.uvs.length / 2;
  for (let corner = 0; corner < corners; corner++) {
    const pk = posKey(result.positions[corner * 3], result.positions[corner * 3 + 1], result.positions[corner * 3 + 2]);
    const u = result.uvs[corner * 2];
    const v = result.uvs[corner * 2 + 1];
    outputPairs.add(`${pk}#${uvKey(u, v)}`);
    const candidates = uvsAt.get(pk);
    if (!candidates) continue;
    let nearest = Infinity;
    for (const key of candidates) {
      const [su, sv] = key.split(",").map((value) => Number(value) / QUANTUM);
      nearest = Math.min(nearest, Math.hypot(u - su, v - sv));
    }
    if (nearest > 1e-5) offenders++;
    worst = Math.max(worst, nearest);
  }

  let lost = 0;
  for (const pair of sourcePairs) if (!outputPairs.has(pair)) lost++;

  const tag = lost || offenders ? "BAD " : "ok  ";
  console.log(
    `  ${tag} ${path.relative(root, file)}\n`
    + `        source ${position.count} verts / ${index.length / 3} tris`
    + ` | editMesh ${definition.editMesh ? "yes" : "NO"}`
    + ` | hiddenEdges ${definition.hiddenEdges?.length ? "yes" : "no"}`
    + ` | ${seamPositions} seam positions\n`
    + `        opened ${mesh.verts.size} verts / ${mesh.faces.size} faces -> ${corners} corners in ${elapsed}ms\n`
    + `        drift ${offenders}/${corners} corners (worst ${worst.toFixed(4)})`
    + ` | LOST ${lost}/${sourcePairs.size} distinct (position, uv) pairs`,
  );
}
