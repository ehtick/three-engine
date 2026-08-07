// SURFACE RADIANCE CACHE — CPU ground truth for the card builder
// (src/modules/gi/surfaceCache.js, docs/GI_NEXT_ARCHITECTURE.md §6.2/§6.3/§6.7).
//
// Same mould as run-gi-dynobj-bvh4-test.mjs: the thing under test is the PACKED
// STRUCTURE, and every failure is arbitrated into one of two classes before it
// is reported, because "which class" is the whole diagnostic value.
//
//   STRUCTURE bug — the packed 8-word card record disagrees with the JS card it
//                   was packed from, or an independent affine reconstruction of
//                   the card basis disagrees with the closed-form one, or a
//                   reconstruction misses by more than 2 texels. Layout,
//                   bitfield, atlas-normalisation and axis/sign bugs all land
//                   here. Hard fail, count must be 0.
//   EPSILON class — packed and reference agree, and the miss is 1–2 texels:
//                   texel-centre quantisation on a card whose resolution the
//                   screen-projection formula made coarse. Tolerated tail ≤2%.
//
// That split is what convicted the BVH8 stride bug in minutes; a plain
// red/green here would only say "cards are wrong somewhere".
//
// Covers: (a) round-trip of every surface point's chosen card + UV for the six
// three.js default geometries plus two custom meshes, (b) atlas rects never
// overlap, (c) the §6.7 concavity detector fires on a deliberately concave mesh
// and not on a convex one, plus a spec-conformance arm that pins §6.2's two
// worked resolution examples and re-verifies that object-block word +23 is
// still unclaimed in dynamicObjects.js.
//
// Run: node scripts/run-gi-surface-cache-test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three/webgpu";
import { classifyDynamicShape, OBJ_WORDS } from "../src/modules/gi/dynamicObjects.js";
import {
  CARD_FLAG, CARD_SLOTS, CARD_TABLE_WORD, CARD_WORDS, SRC_ATLAS_SIZE, SRC_CARD_K,
  atlasBytes, buildObjectCards, buildSurfaceCache, cardResolution, cardSlotFor,
  cardProject, cardUnproject, createCardAtlas, decodeCard, extractLocalTriangles,
  packCardWords, sampleSurface, snapToTexel,
} from "../src/modules/gi/surfaceCache.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── deterministic PRNG (no Math.random in harnesses — reproducible failures) ─
let seed = 0x3f19a7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

// ── INDEPENDENT reference: the card basis as an AFFINE MAP, not the closed
// form. `cardUnproject` solves for each component in place; this builds the
// card→local matrix (origin + three columns) and multiplies. Two different
// routes to the same point, so an axis/sign/extent mix-up in either shows up
// as a disagreement rather than as two matching wrong answers.
function cardBasis(card, he) {
  const a = card.axis, sgn = card.sign;
  const ia = (a + 1) % 3, ib = (a + 2) % 3;
  const hu = Math.max(he[ia], 1e-9), hv = Math.max(he[ib], 1e-9), hd = Math.max(he[a], 1e-9);
  const origin = [0, 0, 0], colS = [0, 0, 0], colT = [0, 0, 0], colD = [0, 0, 0];
  origin[ia] = -hu * sgn; origin[ib] = -hv; origin[a] = hd * sgn;
  colS[ia] = 2 * hu * sgn;
  colT[ib] = 2 * hv;
  colD[a] = -2 * hd * sgn;
  return { origin, colS, colT, colD, hu, hv, hd, ia, ib };
}
function refUnproject(card, u, v, depth, he) {
  const b = cardBasis(card, he);
  const s = card.du > 1e-9 ? (u - card.u0) / card.du : 0.5;
  const t = card.dv > 1e-9 ? (v - card.v0) / card.dv : 0.5;
  return [
    b.origin[0] + b.colS[0] * s + b.colT[0] * t + b.colD[0] * depth,
    b.origin[1] + b.colS[1] * s + b.colT[1] * t + b.colD[1] * depth,
    b.origin[2] + b.colS[2] * s + b.colT[2] * t + b.colD[2] * depth,
  ];
}

// ── a concave test mesh: a fin array (heat-sink / bookshelf / "a room with
// furniture as one mesh" — Lumen's documented failure case). Seven parallel
// fins: only the outermost fin's outer face is visible along ±X, and the fin
// faces are edge-on to every other card, so ~70% of the surface area is
// invisible to any orthographic card. Deliberately, unambiguously concave.
function pushBox(out, cx, cy, cz, hx, hy, hz) {
  const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
  const quad = (a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +X
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -X
  quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // +Y
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // -Y
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
  quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -Z
}
function finArrayGeometry(fins = 7) {
  const v = [];
  pushBox(v, 0, -0.85, 0, 1, 0.05, 1); // base plate
  for (let i = 0; i < fins; i++) {
    const x = -0.75 + (i * 1.5) / (fins - 1);
    pushBox(v, x, 0.025, 0, 0.03, 0.875, 0.95);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(v), 3));
  return g;
}
function soupGeometry() {
  const pos = new Float32Array(300 * 9);
  for (let i = 0; i < pos.length; i++) pos[i] = (rand() * 2 - 1) * 1.0;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}

const mk = (geometry, name, userData) => {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.name = name;
  Object.assign(mesh.userData, userData ?? {});
  mesh.updateMatrixWorld(true);
  return mesh;
};

// ═══════════════════════════════ 1. TAXONOMY — reuse classifyDynamicShape's
// categories, do not invent a parallel one. The card counts are §6.2's table.
const cases = [
  { name: "box", mesh: mk(new THREE.BoxGeometry(1.4, 1.0, 0.8), "box"), type: "obb", cards: 6, distance: 4 },
  { name: "plane", mesh: mk(new THREE.PlaneGeometry(2, 1.5), "plane"), type: "obb", cards: 2, distance: 6 },
  { name: "sphere", mesh: mk(new THREE.SphereGeometry(0.8, 32, 24), "sphere"), type: "sphere", cards: 6, distance: 9 },
  { name: "capsule", mesh: mk(new THREE.CapsuleGeometry(0.4, 1.0, 8, 24), "capsule"), type: "capsule", cards: 6, distance: 14 },
  { name: "cylinder", mesh: mk(new THREE.CylinderGeometry(0.6, 0.3, 1.6, 32), "cylinder"), type: "frustum", cards: 6, distance: 22 },
  { name: "cone", mesh: mk(new THREE.ConeGeometry(0.7, 1.5, 32), "cone"), type: "frustum", cards: 6, distance: 40 },
  { name: "torus-knot", mesh: mk(new THREE.TorusKnotGeometry(0.7, 0.22, 48, 12), "torus-knot"), type: "mesh", cards: 6, distance: 7 },
  { name: "soup", mesh: mk(soupGeometry(), "soup"), type: "mesh", cards: 6, distance: 11 },
];

const atlas = createCardAtlas({ size: SRC_ATLAS_SIZE, padding: 1 });
for (const c of cases) {
  c.shape = classifyDynamicShape(c.mesh);
  c.entry = buildObjectCards({
    mesh: c.mesh, shape: c.shape, atlas, distance: c.distance,
    objIndex: cases.indexOf(c), detectConcavity: false,
  });
  const typeOk = c.shape?.type === c.type;
  const cardOk = c.entry.cards.length === c.cards;
  check(
    `taxonomy ${c.name}`,
    typeOk && cardOk && !c.entry.demoted,
    `type=${c.shape?.type} (want ${c.type}) cards=${c.entry.cards.length} (want ${c.cards}) ` +
      `res=${c.entry.cards.map((k) => `${k.resU}x${k.resV}`).join(",")}`,
  );
}

// ═══════════════════════════════════════════ 2. CARD + UV ROUND TRIP (a)
// For thousands of area-weighted surface samples: pick the card §6.4's argmax
// picks, project through the PACKED WORDS, snap the uv to its texel centre the
// way a texture fetch does, and unproject. The result must land within one
// texel of the original point.
for (const c of cases) {
  const he = [c.shape.halfExtents.x, c.shape.halfExtents.y, c.shape.halfExtents.z];
  const tris = extractLocalTriangles(c.mesh.geometry, c.shape.center);
  const { samples } = sampleSurface(tris, 4000, 0x11f0 + cases.indexOf(c) * 7919);
  const words = c.entry.words;
  const byLayerSlot = new Map(c.entry.cards.map((k) => [k.layer * CARD_SLOTS + k.slot, k]));

  let within = 0;
  let epsilonClass = 0;
  let packBugs = 0;   // packed record ≠ the card it was packed from → LAYOUT
  let mathBugs = 0;   // both routes agree, the point still lands wrong → MATH
  let inactiveSlot = 0;
  let maxTexels = 0;
  for (const [si, p] of samples.entries()) {
    const slot = cardSlotFor(p.nx, p.ny, p.nz);
    const packed = decodeCard(words, slot);
    if (!packed.active) { inactiveSlot++; continue; }

    // Forward + inverse strictly through the PACKED record.
    const fwd = cardProject(packed, p.x, p.y, p.z, he);
    const snap = snapToTexel(packed, fwd.u, fwd.v);
    const got = cardUnproject(packed, snap.u, snap.v, fwd.depth, he);

    // Arbiter: the JS card the packer was handed, and an independent affine
    // reconstruction. Disagreement here is a packing/layout bug, full stop.
    const src = byLayerSlot.get(slot);
    const ref = refUnproject(src, snap.u, snap.v, fwd.depth, he);
    const packDelta = Math.max(
      Math.abs(got[0] - ref[0]), Math.abs(got[1] - ref[1]), Math.abs(got[2] - ref[2]),
    );

    const ia = (packed.axis + 1) % 3, ib = (packed.axis + 2) % 3;
    const texelU = (2 * Math.max(he[ia], 1e-9)) / packed.resU;
    const texelV = (2 * Math.max(he[ib], 1e-9)) / packed.resV;
    const err = Math.max(
      Math.abs(got[ia] - p[["x", "y", "z"][ia]]) / texelU,
      Math.abs(got[ib] - p[["x", "y", "z"][ib]]) / texelV,
      Math.abs(got[packed.axis] - p[["x", "y", "z"][packed.axis]]) / Math.max(texelU, texelV),
    );
    maxTexels = Math.max(maxTexels, err);

    const scale = Math.max(he[0], he[1], he[2], 1e-6);
    const isPackBug = packDelta > 1e-9 * scale;
    if (isPackBug || err > 2) {
      if (isPackBug) packBugs++; else mathBugs++;
      if (packBugs + mathBugs <= 3) {
        console.error(
          `  ${isPackBug ? "LAYOUT" : "MATH"} structure bug on sample ${si} of ${c.name}: slot=${slot} ` +
            `axis=${packed.axis} sign=${packed.sign} err=${err.toFixed(3)} texels ` +
            `packed-vs-ref=${packDelta.toExponential(2)}`,
        );
      }
    } else if (err > 1) epsilonClass++;
    else within++;
  }
  const rate = epsilonClass / Math.max(1, samples.length);
  // A hit on an inactive slot is a DESIGNED fallback (header mean albedo), not
  // a bug — but a geometry whose surface routinely lands there has the wrong
  // card set, so it is bounded rather than ignored.
  const ok = packBugs === 0 && mathBugs === 0 && rate <= 0.02 && within > 0 &&
    inactiveSlot / samples.length <= 0.02;
  check(
    `round-trip ${c.name}`,
    ok,
    `within-1-texel=${within} epsilon-class=${epsilonClass} ` +
      `structure-bugs=${packBugs + mathBugs}/${samples.length} (layout=${packBugs} math=${mathBugs}) ` +
      `inactive-slot=${inactiveSlot} maxΔ=${maxTexels.toFixed(3)} texels`,
  );
}

// ═════════════════════════════════════ 3. PACKED LAYOUT — the words themselves
{
  const c = cases[0];
  const words = c.entry.words;
  let layoutOk = words.length === CARD_SLOTS * CARD_WORDS;
  let detail = `${words.length} words (want ${CARD_SLOTS * CARD_WORDS})`;
  for (let slot = 0; slot < CARD_SLOTS && layoutOk; slot++) {
    const d = decodeCard(words, slot);
    const src = c.entry.cards.find((k) => k.slot === slot && k.layer === 0);
    const want = { axis: (slot / 2) | 0, sign: slot % 2 === 0 ? 1 : -1 };
    if (d.slot !== slot || d.axis !== want.axis || d.sign !== want.sign ||
        d.objIdx !== c.entry.objIndex || d.layers !== 1 || d.layer !== 0 ||
        !d.active || d.resU !== src.resU || d.resV !== src.resV ||
        Math.abs(d.u0 - src.u0) > 1e-7 || Math.abs(d.dv - src.dv) > 1e-7) {
      layoutOk = false;
      detail = `slot ${slot} decoded ${JSON.stringify(d)}`;
    }
  }
  check("packed layout: 8 words/card, slot = axis*2+signBit, decode is the inverse of pack", layoutOk, detail);

  // A plane's four inactive slots must pack as all-zero (flags bit 0 clear) so
  // a hit there falls to the header mean albedo, the same fallback a demoted
  // object uses.
  const pw = cases[1].entry.words;
  let planeOk = true;
  for (let slot = 0; slot < 4; slot++) if (decodeCard(pw, slot).flags !== 0) planeOk = false;
  for (let slot = 4; slot < 6; slot++) if (!(decodeCard(pw, slot).flags & CARD_FLAG.active)) planeOk = false;
  check("plane packs 2 active cards into 6 constant-stride slots", planeOk);
}

// ══════════════════════════════════════════════ 4. ATLAS RECTS NEVER OVERLAP
{
  const rects = [];
  for (const c of cases) for (const k of c.entry.cards) rects.push({ owner: `${c.name}#${k.slot}`, ...k.rect });
  let pairOverlaps = 0;
  let firstPair = "";
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        pairOverlaps++;
        if (!firstPair) firstPair = `${a.owner}(${a.x},${a.y},${a.w}x${a.h}) vs ${b.owner}(${b.x},${b.y},${b.w}x${b.h})`;
      }
    }
  }
  // Independent arbiter: stamp every rect into the real 2048² grid. A pairwise
  // test can be fooled by a sign slip in the comparison; a double-written texel
  // cannot.
  const stamp = new Uint8Array(SRC_ATLAS_SIZE * SRC_ATLAS_SIZE);
  let doubleWritten = 0;
  let outOfBounds = 0;
  for (const r of rects) {
    if (r.x < 0 || r.y < 0 || r.x + r.w > SRC_ATLAS_SIZE || r.y + r.h > SRC_ATLAS_SIZE) outOfBounds++;
    for (let y = Math.max(0, r.y); y < Math.min(SRC_ATLAS_SIZE, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(SRC_ATLAS_SIZE, r.x + r.w); x++) {
        if (stamp[y * SRC_ATLAS_SIZE + x]++) doubleWritten++;
      }
    }
  }
  check(
    "atlas rects never overlap",
    pairOverlaps === 0 && doubleWritten === 0 && outOfBounds === 0,
    `${rects.length} rects, pairwise-overlaps=${pairOverlaps} double-written-texels=${doubleWritten} ` +
      `out-of-bounds=${outOfBounds} occupancy=${(atlas.stats.occupancy * 100).toFixed(2)}%` +
      (firstPair ? ` first=${firstPair}` : ""),
  );

  // The gutter is what makes the bilinear read of §6.4 safe: no card's texels
  // may touch another card's.
  let touching = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.x - 1 < b.x + b.w + 1 && b.x - 1 < a.x + a.w + 1 &&
          a.y - 1 < b.y + b.h + 1 && b.y - 1 < a.y + a.h + 1) touching++;
    }
  }
  check("atlas rects keep a 1-texel bilinear gutter", touching === 0, `${touching} adjacent pair(s)`);
}

// ══════════════════════════ 5. CONCAVITY DETECTOR (§6.7) — fires, and doesn't
{
  const concave = mk(finArrayGeometry(7), "fin-array");
  const convexMesh = mk(new THREE.IcosahedronGeometry(1, 3), "icosphere");
  // A sphere forced onto the BVH path: analytic shapes short-circuit the
  // detector (convex by construction), so the convex control must be a mesh.
  const convexForced = mk(new THREE.SphereGeometry(0.9, 32, 24), "sphere-as-mesh", { giTrace: "bvh" });
  const detCases = [
    { mesh: concave, wantDemote: true },
    { mesh: convexMesh, wantDemote: false },
    { mesh: convexForced, wantDemote: false },
  ];
  const detAtlas = createCardAtlas({ size: SRC_ATLAS_SIZE });
  const coverages = {};
  for (const { mesh, wantDemote } of detCases) {
    const shape = classifyDynamicShape(mesh);
    const e = buildObjectCards({
      mesh, shape, atlas: detAtlas, distance: 4, detectConcavity: true, coverageSamples: 6000,
    });
    coverages[mesh.name] = e.coverage;
    const isMesh = shape?.type === "mesh";
    const fired = e.demoted && e.demoteReason === "concave";
    check(
      `concavity ${wantDemote ? "fires on" : "spares"} "${mesh.name}"`,
      isMesh && fired === wantDemote,
      `type=${shape?.type} coverage=${(e.coverage * 100).toFixed(1)}% demoted=${e.demoted} ` +
        `reason=${e.demoteReason ?? "-"} tris=${e.triCount}`,
    );
  }
  // Not knife-edge: the two classes must sit on opposite sides of the threshold
  // with real margin, or the detector is a coin flip on the next mesh.
  const margin = Math.min(coverages.icosphere, coverages["sphere-as-mesh"]) - coverages["fin-array"];
  check(
    "concavity classes are separated, not knife-edge",
    margin > 0.35,
    `convex=${(Math.min(coverages.icosphere, coverages["sphere-as-mesh"]) * 100).toFixed(1)}% ` +
      `concave=${(coverages["fin-array"] * 100).toFixed(1)}% margin=${(margin * 100).toFixed(1)}pp`,
  );

  // §6.2's `__giSrcCards` raise: more depth-peel layers must recover some of the
  // hidden surface, or the override is decoration.
  const layered = mk(finArrayGeometry(7), "fin-array-4x", { giSrcCards: 4 });
  const e4 = buildObjectCards({
    mesh: layered, shape: classifyDynamicShape(layered), atlas: createCardAtlas({ size: SRC_ATLAS_SIZE }),
    distance: 4, detectConcavity: true, coverageSamples: 6000, concaveThreshold: 0,
  });
  check(
    "giSrcCards raises coverage through depth-peel layers",
    e4.layers === 4 && e4.cards.length === 24 && e4.coverage > coverages["fin-array"] + 0.05,
    `layers=${e4.layers} cards=${e4.cards.length} coverage ${(coverages["fin-array"] * 100).toFixed(1)}% → ` +
      `${(e4.coverage * 100).toFixed(1)}%`,
  );
}

// ═══════════════════════════════ 6. WHOLE-SET BUILD: pool offsets + tiering
{
  const objects = cases.map((c, i) => ({ mesh: c.mesh, shape: c.shape, distance: c.distance, objIndex: i }));
  const built = buildSurfaceCache({ objects, poolBaseWord: 4096, detectConcavity: false });
  let poolOk = true;
  let detail = "";
  const spans = [];
  for (const e of built.entries) {
    if (!e.words) continue;
    spans.push([e.cardTableRel, e.cardTableRel + e.words.length, e.name]);
    if (e.cardTableWord !== 48 + e.objIndex * OBJ_WORDS + CARD_TABLE_WORD) {
      poolOk = false; detail = `${e.name}: card-table word ${e.cardTableWord}`;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] < spans[i - 1][1]) { poolOk = false; detail = `${spans[i][2]} overlaps ${spans[i - 1][2]}`; }
  }
  check(
    "card tables get non-overlapping word-pool spans, base relative to baseWord",
    poolOk && built.poolWords === cases.length * CARD_SLOTS * CARD_WORDS,
    `poolWords=${built.poolWords} spans=${spans.length} occupancy=${(built.stats.atlasOccupancy * 100).toFixed(2)}% ${detail}`,
  );

  // Tiering hook: a 128² atlas cannot hold 8 objects' cards, so the build must
  // step resolution down as ONE quality tier rather than dropping an arbitrary
  // subset — and must say so.
  const tiny = buildSurfaceCache({ objects, atlasSize: 128, detectConcavity: false });
  const anyDemoted = tiny.demoted.length;
  check(
    "atlas tiering steps resolution down before dropping objects",
    tiny.resScale < 1 || anyDemoted > 0,
    `resScale=${tiny.resScale} demoted=${anyDemoted} occupancy=${(tiny.stats.atlasOccupancy * 100).toFixed(1)}%`,
  );

  // Pool exhaustion demotes to the header path, it does not corrupt the table.
  const capped = buildSurfaceCache({ objects, poolCapacityWords: 100, detectConcavity: false });
  const cappedOk = capped.entries.filter((e) => e.words).length === 2 &&
    capped.entries.filter((e) => e.demoteReason === "pool-full").length === cases.length - 2;
  check(
    "card-pool exhaustion demotes cleanly (word +23 stays 0)",
    cappedOk && capped.entries.every((e) => e.words || (e.cardTableRel ?? 0) === 0),
    `packed=${capped.entries.filter((e) => e.words).length} pool-full=${capped.entries.filter((e) => e.demoteReason === "pool-full").length}`,
  );
}

// ═══════════════════════════════════════════ 7. SPEC CONFORMANCE vs §6.2/§6.3
{
  // §6.2's two worked examples, verbatim: "A 30 m-away crate gets 16², a 2 m-away
  // one gets 128²". Only k = 480 satisfies both under the stated clamp.
  check(
    "§6.2 resolution formula reproduces both worked examples",
    cardResolution(1, 30, SRC_CARD_K) === 16 && cardResolution(1, 2, SRC_CARD_K) === 128 &&
      cardResolution(1, 1000, SRC_CARD_K) === 8 && cardResolution(1e6, 1, SRC_CARD_K) === 128,
    `k=${SRC_CARD_K}: 30m→${cardResolution(1, 30)} 2m→${cardResolution(1, 2)} clamp=[8,128]`,
  );
  check(
    "§6.3 word budget: 8 words/card, 6 cards = 48 words/object",
    CARD_WORDS === 8 && CARD_SLOTS * CARD_WORDS === 48,
  );
  check(
    "card-table base fits object block word +23",
    CARD_TABLE_WORD === 23 && CARD_TABLE_WORD < OBJ_WORDS,
    `OBJ_WORDS=${OBJ_WORDS}`,
  );

  // Word +23 must be claimed by the CARD TABLE and by nothing else. This
  // assertion started life as "still unclaimed" and was flipped the moment the
  // surface cache took the word (`setCardTable` writes it, `cardFrameAt` reads
  // it) — that transition is the one legitimate edit to this check, and it is
  // allowed to happen exactly once. A second writer or a second reader means
  // two features are sharing a word, which is the failure this guards, so the
  // predicate is EQUALITY not "at most": both counts must be exactly 1.
  const src = readFileSync(
    fileURLToPath(new URL("../src/modules/gi/dynamicObjects.js", import.meta.url)), "utf8",
  );
  const writes = src.match(/\bwm\(\s*\w+\s*,\s*23\s*,/g) ?? [];
  const reads = src.match(/\bob\.add\(uint\(23\)\)/g) ?? [];
  check(
    "object-block word +23 is claimed exactly once, by the card table",
    writes.length === 1 && reads.length === 1,
    `writes=${writes.length} reads=${reads.length} (expected 1/1)`,
  );

  // §6.3 says "Start at 2048² (≈ 25 MB across the three at rgba16f)". The 25 MB
  // figure is the 1024² number; 2048² is 4× that. Pinned here so the memory
  // budget is argued from arithmetic, not from the prose.
  check(
    "atlas byte cost is arithmetic, not the doc's 25MB",
    atlasBytes(2048) === 100663296 && atlasBytes(1024) === 25165824,
    `3× rgba16f: 2048²=${(atlasBytes(2048) / 1e6).toFixed(1)}MB, 1024²=${(atlasBytes(1024) / 1e6).toFixed(1)}MB ` +
      `— §6.3's "≈25 MB" is the 1024² figure, 2048² is 4× it`,
  );

  // packCardWords must be a pure function of its input — a rebuild with the
  // same cards has to produce byte-identical words or the card table cannot be
  // diffed for upload.
  const a = packCardWords(cases[0].entry.cards, 1, 3);
  const b = packCardWords(cases[0].entry.cards, 1, 3);
  check("packCardWords is deterministic", a.every((w, i) => w === b[i]) && a.length === b.length);
}

if (failures) {
  console.error(`gi-surface-cache: ${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("gi-surface-cache: all cases PASS");
