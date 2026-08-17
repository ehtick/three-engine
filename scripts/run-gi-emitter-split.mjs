// SPARSE EMITTER SPLITTING — one glTF mesh is not one light.
// src/modules/gi/lightTree.js §13.7h, docs/GI_SPATIAL_REBUILD_PLAN.md.
//
//   node scripts/run-gi-emitter-split.mjs
//
// ══ WHAT THIS IS FOR ════════════════════════════════════════════════════════
//
// A glTF splits by MATERIAL, so a whole run of party bulbs, every downlight in
// a ceiling, or every window pane on a facade arrives as ONE mesh. Fitting one
// shape to it produced this, measured on the user's Bistro cafe (2026-08-17,
// live emitter ledger):
//
//   P=1.8e+1 area=3.8e-2m² fill=0.000 rgb=0.0/0.0/0.0 r=12.03m
//
// A twelve-metre fitted radius standing in for 380 cm² of bulb, with §13.7g's
// sparse-fill correction then damping the radiance to literally zero. Nineteen
// of that scene's ninety-five emitters were in that state, delivering nothing,
// with no error printed anywhere.
//
// So this suite is built around the two ways the fix can be wrong, not around
// the way it can be right:
//
//   · IT MUST NOT TOUCH ANYTHING THAT ALREADY WORKED. Every lamp in every
//     existing scene is a solid mesh, and the split must pass those through
//     BIT-IDENTICAL — not "close", identical, because the acceptance test is
//     the only thing standing between a working scene and a silent refit.
//   · IT MUST CONSERVE ENERGY. Splitting is a change of MODEL, not of content:
//     the same triangles at the same radiance emit the same total power, so
//     sum(power of the pieces) must equal the single fit's power exactly.
//
// Everything runs on the CPU with no GPU and no renderer: `collectEmitters` is
// pure geometry, and a rig that needed a device could not assert on exact
// equality.
import * as THREE from "three/webgpu";
import {
  collectEmitters, emitterFromMesh, splitSparseEmitter, triangleClusters,
} from "../src/modules/gi/lightTree.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const emissive = (strength = 40) => {
  const m = new THREE.MeshStandardMaterial({ color: 0x111111 });
  m.emissive = new THREE.Color(strength, strength * 0.9, strength * 0.7);
  m.emissiveIntensity = 1;
  return m;
};

/**
 * `count` separate bulb shells welded into ONE BufferGeometry, DRAPED so the
 * run spans all three axes. This is the Bistro string light, reproduced:
 * separate closed pieces sharing no vertex, inside one enormous bounding box.
 *
 * ⚠ THE ZIG-ZAG IS LOAD-BEARING, and a straight line along X is the mistake
 * this comment exists to stop being made again. Sparsity is
 * `area / crossSection`, and a straight string's bounding box is a PENCIL — its
 * widest cross-section is only length x bulb-diameter, so 12 bulbs on a line
 * measure fill 0.31 and are not sparse at all. The live case measured 0.0035
 * because a real string is draped across a courtyard: 2.4 x 1.3 x 5.9 m. A rig
 * that lays them in a line tests a case the fix was not written for and passes
 * for the wrong reason.
 */
function makeStringLights({ count = 12, radius = 0.025, spacing = 0.5 } = {}) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const g = new THREE.SphereGeometry(radius, 8, 6);
    // X strictly increasing (the placement assertions key on it); Y and Z drape.
    g.translate(i * spacing, (i % 2) * 1.5, (i % 3) * 1.2);
    parts.push(g.toNonIndexed());
  }
  // Concatenate positions by hand rather than pulling in BufferGeometryUtils:
  // the merge helper welds, and welding is precisely the thing under test.
  let total = 0;
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  let at = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, at);
    at += g.attributes.position.array.length;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.Mesh(geometry, emissive());
}

// ── 1. THE FIT, BEFORE AND AFTER ───────────────────────────────────────────

{
  const mesh = makeStringLights({ count: 12 });
  const single = emitterFromMesh(mesh, {});
  const split = collectEmitters([mesh]);

  check(
    "unsplit, a 12-bulb string fits ONE emitter that fills almost none of it",
    single.fill < 0.02,
    `fill ${single.fill.toExponential(2)}, r ${single.angularRadius.toFixed(2)}m`,
  );
  check(
    "unsplit, the fill damping drives its radiance toward zero",
    single.rgb[0] < single.rgb[0] / single.fill * 0.05,
    `rgb ${single.rgb.map((v) => v.toFixed(3)).join("/")}`,
  );
  check(
    "split, the string becomes one emitter per bulb",
    split.length === 12,
    `${split.length} emitters, ${split.splitStats.split} mesh(es) split`,
  );
  check(
    "split, every bulb fills its own fitted shape",
    split.every((e) => e.fill >= 0.999),
    `min fill ${Math.min(...split.map((e) => e.fill)).toFixed(3)}`,
  );
  check(
    "split, every bulb is bulb-sized instead of string-sized",
    split.every((e) => e.angularRadius < 0.05),
    `max r ${Math.max(...split.map((e) => e.angularRadius)).toFixed(4)}m vs ${single.angularRadius.toFixed(2)}m unsplit`,
  );
  check(
    "split, the authored radiance survives — nothing is damped",
    split.every((e) => Math.abs(e.rgb[0] - 40) < 1e-4),
    `rgb[0] ${split[0].rgb[0].toFixed(4)} (authored 40)`,
  );

  // ── ENERGY. The invariant that says this is a re-FIT and not a re-LIGHT.
  const sum = split.reduce((a, e) => a + e.power, 0);
  check(
    "total emitted power is conserved exactly across the split",
    Math.abs(sum - single.power) < single.power * 1e-6,
    `${sum.toExponential(6)} vs ${single.power.toExponential(6)}`,
  );
  const areaSum = split.reduce((a, e) => a + e.area, 0);
  check(
    "and so is total surface area — no triangle is dropped or double-counted",
    Math.abs(areaSum - single.area) < single.area * 1e-6,
    `${areaSum.toExponential(6)}m² vs ${single.area.toExponential(6)}m²`,
  );

  // The bulbs must land WHERE THE GEOMETRY IS, not averaged into one ball.
  // This is the half of the bug the radiance number cannot express: even at a
  // corrected radiance, every receiver in the cafe stood INSIDE the 12 m
  // sphere, where the sphere-irradiance model has no meaning at all.
  const xs = split.map((e) => e.centre[0]).sort((a, b) => a - b);
  const spread = xs[xs.length - 1] - xs[0];
  check(
    "the pieces are placed along the string, not collapsed onto its centroid",
    spread > 5 && xs.every((x, i) => i === 0 || x - xs[i - 1] > 0.4),
    `centres span ${spread.toFixed(2)}m at ~${(spread / 11).toFixed(2)}m apart`,
  );
}

// ── 2. WHAT MUST NOT CHANGE ────────────────────────────────────────────────
//
// The regression half. Every lamp anyone has already authored is a solid mesh,
// and this suite is worthless if it only proves the new case works.

const solids = [
  ["a box lamp", new THREE.BoxGeometry(0.4, 0.1, 0.4)],
  ["a flat emissive panel", new THREE.PlaneGeometry(2, 1)],
  ["a sphere bulb", new THREE.SphereGeometry(0.1, 16, 12)],
  ["a cylinder tube", new THREE.CylinderGeometry(0.03, 0.03, 2, 12)],
];
for (const [name, geometry] of solids) {
  const mesh = new THREE.Mesh(geometry, emissive());
  mesh.position.set(1, 2, 3);
  mesh.rotation.set(0.3, 0.7, 0.1);
  mesh.updateMatrixWorld(true);
  const before = emitterFromMesh(mesh, { split: false });
  const after = collectEmitters([mesh]);
  const same =
    after.length === 1 &&
    after[0].fill === before.fill &&
    after[0].power === before.power &&
    after[0].angularRadius === before.angularRadius &&
    after[0].rgb.every((v, i) => v === before.rgb[i]) &&
    after[0].centre.every((v, i) => v === before.centre[i]) &&
    after[0].half.every((v, i) => v === before.half[i]);
  check(
    `${name} passes through BIT-IDENTICAL`,
    same,
    `${after.length} emitter(s), fill ${after[0]?.fill?.toFixed(4)}`,
  );
}

{
  // ⚠ THE CASE CONNECTIVITY DELIBERATELY DOES NOT SPLIT. A long diagonal tube
  // has a bounding box far bigger than itself — fill is genuinely low — but it
  // is ONE light, and cutting it into segments would pay N times the per-frame
  // tile-cut cost for the same wrong answer. §13.7g's damping is the correct
  // treatment here and must keep firing.
  const g = new THREE.CylinderGeometry(0.02, 0.02, 4, 8);
  g.rotateZ(Math.PI / 4);
  const mesh = new THREE.Mesh(g, emissive());
  mesh.updateMatrixWorld(true);
  const out = collectEmitters([mesh]);
  check(
    "a single connected diagonal tube is NOT split — it is one light",
    out.length === 1,
    `${out.length} emitter(s), fill ${out[0].fill.toFixed(4)} (still damped, correctly)`,
  );
  check(
    "and it is still sparse enough that the damping is what saves it",
    out[0].fill < 0.5,
    `fill ${out[0].fill.toFixed(4)}`,
  );
}

{
  // ⚠ THE CASE WHERE SPLITTING CANNOT HELP, and the reason the acceptance test
  // exists at all. Four CO-LOCATED copies of one diagonal tube, offset by a
  // couple of millimetres so they are separate connected pieces: connectivity
  // happily cuts them apart, but each piece's fitted shape is the parent's
  // shape and each holds a quarter of the area — so the fill goes DOWN and the
  // placement does not move at all. Four emitters, four identical wrong shapes,
  // four times the per-frame tile-cut cost. It must be refused.
  //
  // Two earlier drafts of this arm asserted refusal on premises that were
  // simply wrong, and both are worth naming because they look like this one:
  //   · six quads SCATTERED along X — splitting is exactly right there. Each
  //     lands where its own geometry is instead of at the group's centroid,
  //     which is half the bug, even though every piece stays individually
  //     sparse. SPARSE IS NOT THE SAME QUESTION AS CO-LOCATED.
  //   · four tubes CROSSING at the origin — also right to split. The parent's
  //     box is the union of four orientations and is far larger than any one
  //     tube's, so the pieces really are better shapes.
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const a = new THREE.CylinderGeometry(0.02, 0.02, 4, 8).toNonIndexed();
    a.rotateZ(Math.PI / 4);
    a.translate(i * 0.002, i * 0.002, 0);
    parts.push(a);
  }
  let total = 0;
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  let at = 0;
  for (const g of parts) { pos.set(g.attributes.position.array, at); at += g.attributes.position.array.length; }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mesh = new THREE.Mesh(geometry, emissive());
  mesh.updateMatrixWorld(true);
  const single = emitterFromMesh(mesh, { split: false });
  const out = collectEmitters([mesh]);
  check(
    "co-located pieces are REFUSED — the same wrong shape N times is not a fix",
    out.length === 1,
    out.length === 1
      ? `refused (fill ${single.fill.toExponential(2)}, r ${single.angularRadius.toFixed(2)}m kept whole)`
      : `accepted ${out.length} pieces at r ${out.map((e) => e.angularRadius.toFixed(2)).join("/")}m vs parent ${single.angularRadius.toFixed(2)}m`,
  );
}

// ── 3. DETERMINISM ─────────────────────────────────────────────────────────
//
// ⚠ NOT A STYLE POINT. `#refreshLightTree` re-runs `collectEmitters` on the
// same meshes whenever a lamp moves or dims, and the packed records are
// addressed BY INDEX. If the split produced a different order — or a different
// count — for identical inputs, the first repack would renumber every record
// in the tree and the whole scene's lighting would jump.

{
  const build = () => collectEmitters([makeStringLights({ count: 9 })]);
  const a = build();
  const b = build();
  const identical =
    a.length === b.length &&
    a.every((e, i) => e.power === b[i].power && e.centre.every((v, k) => v === b[i].centre[k]));
  check(
    "two collections of the same mesh agree exactly, in the same order",
    identical,
    `${a.length} vs ${b.length} emitters`,
  );

  // The same mesh MOVED must give the same pieces in the same order — this is
  // the actual refresh path, and the clusters are cached on the geometry in
  // LOCAL index space precisely so a world-matrix change cannot reorder them.
  const mesh = makeStringLights({ count: 9 });
  const still = collectEmitters([mesh]);
  mesh.position.set(7, -3, 11);
  mesh.updateMatrixWorld(true);
  const moved = collectEmitters([mesh]);
  const tracked =
    still.length === moved.length &&
    still.every((e, i) => Math.abs((e.centre[0] + 7) - moved[i].centre[0]) < 1e-4);
  check(
    "moving the mesh moves every piece by the same offset, order preserved",
    tracked,
    `${moved.length} emitters`,
  );
}

// ── 4. THE BUDGET ──────────────────────────────────────────────────────────
//
// Emitter count is a PER-FRAME cost: the §12.70 tile cut scans every record
// per screen tile. A 400-bulb chandelier must not quietly become 400 lights.

{
  const mesh = makeStringLights({ count: 80, spacing: 0.15 });
  const single = emitterFromMesh(mesh, { split: false });
  const capped = collectEmitters([mesh], { maxClusters: 16 });
  check(
    "a mesh with more pieces than the cap merges neighbours instead",
    capped.length === 16,
    `${capped.length} emitters from 80 bulbs`,
  );
  // ⚠ NOT a fill assertion, and that is the point. Fill barely moves under
  // merging (see `splitSparseEmitter`'s scale-invariance note) — what a capped
  // split buys is PLACEMENT: light delivered from 16 shapes along the run
  // instead of from one ball centred on the whole thing.
  check(
    "and the merged groups are far better placed than the whole string",
    capped.every((e) => e.angularRadius < single.angularRadius * 0.4),
    `max r ${Math.max(...capped.map((e) => e.angularRadius)).toFixed(3)}m vs ${single.angularRadius.toFixed(3)}m unsplit`,
  );
  const sum = capped.reduce((a, e) => a + e.power, 0);
  check(
    "capping still conserves power",
    Math.abs(sum - single.power) < single.power * 1e-6,
    `${sum.toExponential(6)} vs ${single.power.toExponential(6)}`,
  );

  // Scene-wide budget: three strings, room for one and a bit.
  const meshes = [makeStringLights({ count: 10 }), makeStringLights({ count: 10 }), makeStringLights({ count: 10 })];
  meshes[1].position.y = 3; meshes[2].position.y = 6;
  for (const m of meshes) m.updateMatrixWorld(true);
  const budgeted = collectEmitters(meshes, { maxSplitEmitters: 12 });
  check(
    "the scene-wide budget bounds how many emitters splitting may add",
    budgeted.length <= 3 + 12,
    `${budgeted.length} emitters, +${budgeted.splitStats.added} added`,
  );
}

// ── 5. THE HATCH ───────────────────────────────────────────────────────────

{
  const mesh = makeStringLights({ count: 12 });
  globalThis.__giEmitterSplit = false;
  const off = collectEmitters([mesh]);
  globalThis.__giEmitterSplit = undefined;
  const on = collectEmitters([mesh]);
  check(
    "`__giEmitterSplit = false` restores the single-fit behaviour for A/B",
    off.length === 1 && on.length === 12,
    `off ${off.length}, on ${on.length}`,
  );
}

// ── 6. THE CLUSTERING ITSELF ───────────────────────────────────────────────

{
  const mesh = makeStringLights({ count: 5 });
  const clusters = triangleClusters(mesh.geometry, 32);
  const seen = new Set();
  for (const c of clusters) for (const t of c) seen.add(t);
  const triCount = mesh.geometry.attributes.position.count / 3;
  check(
    "clustering partitions the triangles — every one used exactly once",
    clusters.length === 5 && seen.size === triCount &&
      clusters.reduce((a, c) => a + c.length, 0) === triCount,
    `${clusters.length} clusters over ${triCount} triangles`,
  );
  check(
    "the cluster list is cached on the geometry, not recomputed per call",
    triangleClusters(mesh.geometry, 32) === clusters,
    "same array identity on the second call",
  );
  const solid = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), emissive());
  check(
    "a single connected mesh reports nothing to split",
    triangleClusters(solid.geometry, 32) === null,
    "null, i.e. one piece",
  );
  check(
    "splitSparseEmitter refuses a mesh it cannot cut",
    splitSparseEmitter(solid, emitterFromMesh(solid, { split: false }), {}) === null,
    "null",
  );
}

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
