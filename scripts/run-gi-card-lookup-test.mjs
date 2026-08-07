// SURFACE RADIANCE CACHE — CPU ground truth for the §6.4 GPU LOOKUP
// (src/modules/gi/surfaceCacheGpu.js against src/modules/gi/surfaceCache.js).
//
// The companion to run-gi-surface-cache-test.mjs, and deliberately the other
// half of it: that test proves the PACKER writes what it means to, this one
// proves the LOOKUP reads back exactly what the packer wrote. Same arbitration
// discipline, because "which class" is the diagnostic value:
//
//   STRUCTURE bug — the lookup's card choice, (s, t), depth or uv disagrees
//                   with `cardProject`'s, or a reconstruction misses by more
//                   than 2 texels. Axis order, sign mirroring, the [-1,1]→[0,1]
//                   remap, the EPS guard, the word offsets and the active-flag
//                   gate all land here. Hard fail, count must be 0.
//   EPSILON class — both routes agree and the reconstruction misses by 1–2
//                   texels: texel-centre quantisation on a card the
//                   screen-projection formula made coarse. Tolerated tail ≤2%.
//
// The shader cannot be run here (no GPU, and a compute kernel is not testable
// from node), so what is under test is `surfaceCacheGpu.js`'s JS MIRROR of the
// same arithmetic — written line-by-line against the TSL body, sharing the
// CARD_AXIS_ROT table with it so the two cannot drift. That mirror is then held
// against `cardProject`/`cardUnproject`, which are the packer's own ground
// truth. A shader edit that is not also a mirror edit is caught by review; a
// mirror edit that breaks the packer contract is caught here.
//
// Covers: (a) the branchless argmax equals the packer's branchy `cardSlotFor`
// over a dense set of normals, (b) card choice + (s,t) + depth + uv round-trip
// for thousands of surface points on each of the six three.js default
// geometries (plus a BVH-path mesh), (c) the bilinear half-texel inset is
// load-bearing at silhouettes and inert inside the card, (d) ONE fallback path
// for demoted objects and inactive slots, (e) the atlas allocation matches
// §6.3's tier ladder, (f) object block word +23 is now claimed EXACTLY ONCE.
//
// Run: node scripts/run-gi-card-lookup-test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three/webgpu";
import { classifyDynamicShape } from "../src/modules/gi/dynamicObjects.js";
import {
  CARD_SLOTS, CARD_WORDS, SRC_ATLAS_SIZE, SRC_ATLAS_TIERS,
  atlasBytes, buildSurfaceCache, cardProject, cardSlotFor, cardUnproject, decodeCard,
  extractLocalTriangles, sampleSurface,
} from "../src/modules/gi/surfaceCache.js";
import {
  CARD_AXIS_ROT, CARD_EPS, cardArgmaxSlot, cardLookupMirror, cardRectWords, cardStFromLocal,
  cardUvFromSt, createSurfaceCacheAtlas, snapAtlasTier,
} from "../src/modules/gi/surfaceCacheGpu.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const mk = (geometry, name) => {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.name = name;
  mesh.updateMatrixWorld(true);
  return mesh;
};

// ═════════════════════ 1. THE ARGMAX — branchless vs the packer's branchy form
// `cardSlotFor` is written with if/else-if; the shader cannot branch that way,
// so surfaceCacheGpu re-expresses it as two booleans. Two different routes to
// one decision: a tie-break slip in either shows up as a disagreement instead of
// as two matching wrong answers.
{
  const dirs = [];
  // Fibonacci sphere — dense, deterministic, no Math.random.
  const N = 8192;
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    dirs.push([Math.cos(ga * i) * r, y, Math.sin(ga * i) * r]);
  }
  // The cases an argmax gets wrong: exact axes, exact 45° ties on every pair,
  // the triple tie, and every sign of each.
  const s2 = Math.SQRT1_2, s3 = 1 / Math.sqrt(3);
  for (const base of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [s2, s2, 0], [s2, 0, s2], [0, s2, s2], [s3, s3, s3]]) {
    for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
      dirs.push([base[0] * sx, base[1] * sy, base[2] * sz]);
    }
  }
  dirs.push([0, 0, 0]); // degenerate normal — both routes must still pick a slot
  let mismatch = 0;
  let first = "";
  for (const [x, y, z] of dirs) {
    const want = cardSlotFor(x, y, z);
    const got = cardArgmaxSlot(x, y, z).slot;
    if (want !== got) {
      mismatch++;
      if (!first) first = `n=(${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}) packer=${want} lookup=${got}`;
    }
  }
  check(
    "branchless argmax == cardSlotFor over a dense normal set (incl. every tie)",
    mismatch === 0,
    `${dirs.length} normals, mismatches=${mismatch}${first ? ` first: ${first}` : ""}`,
  );

  // The rotation table is DERIVED in surfaceCacheGpu; pin it against
  // cardProject's own `ia = (axis+1)%3, ib = (axis+2)%3, axis` convention.
  let rotOk = CARD_AXIS_ROT.length === 3;
  for (let a = 0; a < 3 && rotOk; a++) {
    const r = CARD_AXIS_ROT[a];
    if (r[0] !== (a + 1) % 3 || r[1] !== (a + 2) % 3 || r[2] !== a) rotOk = false;
  }
  check("CARD_AXIS_ROT is (ia, ib, axis) for every axis", rotOk, JSON.stringify(CARD_AXIS_ROT));

  // The layer term: §6.2's depth peel indexes `layer*6 + axis*2 + signBit`.
  const layered = cardArgmaxSlot(0, -1, 0, 3);
  check(
    "argmax slot carries the depth-peel layer",
    layered.slot === 3 * CARD_SLOTS + 1 * 2 + 1 && cardArgmaxSlot(0, -1, 0).slot === 3,
    `layer 3, n=-Y → slot ${layered.slot}`,
  );
}

// ══════════════════ 2. THE SIX DEFAULT GEOMETRIES — card + uv against the packer
//
// The whole set is built through `buildSurfaceCache` with a NON-ZERO
// `poolBaseWord`, and the mirror then indexes a simulated region array exactly
// the way the shader indexes `bits`: `region[cardTableRel + slot*8]`, with
// `cardTableRel` relative to the region base. A card table published at the
// wrong base reads another object's rects, so this is not a formality.
const cases = [
  { name: "box", mesh: mk(new THREE.BoxGeometry(1.4, 1.0, 0.8), "box"), distance: 4 },
  { name: "plane", mesh: mk(new THREE.PlaneGeometry(2, 1.5), "plane"), distance: 6 },
  { name: "sphere", mesh: mk(new THREE.SphereGeometry(0.8, 32, 24), "sphere"), distance: 9 },
  { name: "capsule", mesh: mk(new THREE.CapsuleGeometry(0.4, 1.0, 8, 24), "capsule"), distance: 14 },
  { name: "cylinder", mesh: mk(new THREE.CylinderGeometry(0.6, 0.3, 1.6, 32), "cylinder"), distance: 22 },
  { name: "cone", mesh: mk(new THREE.ConeGeometry(0.7, 1.5, 32), "cone"), distance: 40 },
  // Not one of the six: the BVH path, so the mesh branch of `cardPlan` is
  // exercised by the same arithmetic.
  { name: "torus-knot", mesh: mk(new THREE.TorusKnotGeometry(0.7, 0.22, 48, 12), "torus-knot"), distance: 7 },
];

const POOL_BASE = 4096;
for (const c of cases) c.shape = classifyDynamicShape(c.mesh);
const built = buildSurfaceCache({
  objects: cases.map((c, i) => ({ mesh: c.mesh, shape: c.shape, distance: c.distance, objIndex: i })),
  poolBaseWord: POOL_BASE,
  detectConcavity: false,
});
// The bits region as the GPU sees it: the card block sits at POOL_BASE, and
// every `cardTableRel` is an offset into THIS array.
const region = new Uint32Array(POOL_BASE + built.words.length);
region.set(built.words, POOL_BASE);

check(
  "whole-set build packed every case",
  built.entries.every((e) => e.words) && built.demoted.length === 0,
  `objects=${built.stats.objects} cards=${built.stats.cardsAllocated} poolWords=${built.poolWords} ` +
    `atlas=${(built.stats.atlasOccupancy * 100).toFixed(2)}%`,
);

let clampedTotal = 0;
for (const [ci, c] of cases.entries()) {
  const entry = built.entries[ci];
  const he = [c.shape.halfExtents.x, c.shape.halfExtents.y, c.shape.halfExtents.z];
  const tris = extractLocalTriangles(c.mesh.geometry, c.shape.center);
  const { samples } = sampleSurface(tris, 4000, 0x2b31 + ci * 7919);

  let within = 0;
  let epsilonClass = 0;
  let structBugs = 0;
  let slotBugs = 0;
  let uvBugs = 0;
  let outsideRect = 0;
  let inactive = 0;
  let maxTexels = 0;
  let maxUvDelta = 0;
  let maxStDelta = 0;
  for (const [si, p] of samples.entries()) {
    // GROUND TRUTH: the packer's own choice + projection, through the PACKED
    // record (decoded from the same region words the mirror reads).
    const slot = cardSlotFor(p.nx, p.ny, p.nz);
    const packed = decodeCard(region, slot, entry.cardTableRel);
    if (!packed.active) { inactive++; continue; }
    const ref = cardProject(packed, p.x, p.y, p.z, he);

    // UNDER TEST: the shader's route — argmax, rotation table, word fetch, uv.
    const got = cardLookupMirror({
      words: region,
      cardTableRel: entry.cardTableRel,
      pLocal: [p.x, p.y, p.z],
      nLocal: [p.nx, p.ny, p.nz],
      halfExtents: he,
      atlasSize: built.stats.atlasSize,
    });

    if (got.slot !== slot || !got.valid) {
      slotBugs++;
      if (slotBugs <= 2) {
        console.error(
          `  STRUCTURE slot bug on sample ${si} of ${c.name}: packer=${slot} lookup=${got.slot} valid=${got.valid}`,
        );
      }
      continue;
    }

    // (s, t, depth) must be bit-comparable: same formula, same EPS guard.
    const stDelta = Math.max(
      Math.abs(got.s - ref.s), Math.abs(got.t - ref.t), Math.abs(got.depth - ref.depth),
    );
    maxStDelta = Math.max(maxStDelta, stDelta);
    // uv BEFORE the atlas inset must equal cardProject's uv exactly — that
    // isolates "the clamp moved it" from "the arithmetic is wrong".
    const uvDelta = Math.max(Math.abs(got.rawU - ref.u), Math.abs(got.rawV - ref.v));
    maxUvDelta = Math.max(maxUvDelta, uvDelta);
    if (stDelta > 1e-6 || uvDelta > 1e-7) {
      uvBugs++;
      if (uvBugs <= 2) {
        console.error(
          `  STRUCTURE uv bug on sample ${si} of ${c.name}: slot=${slot} axis=${packed.axis} ` +
            `sign=${packed.sign} Δst=${stDelta.toExponential(2)} Δuv=${uvDelta.toExponential(2)} ` +
            `(lookup s=${got.s.toFixed(6)} t=${got.t.toFixed(6)} vs packer s=${ref.s.toFixed(6)} t=${ref.t.toFixed(6)})`,
        );
      }
      continue;
    }

    // The bilinear-safety property: the CLAMPED uv can never leave its own
    // card's rect inset by half a texel, or a hardware bilinear tap reaches
    // into the gutter (or a neighbour) — the thing §6.4 does not mention.
    const half = 0.5 / built.stats.atlasSize;
    const inRect = got.u >= packed.u0 + half - 1e-12 && got.u <= packed.u0 + packed.du - half + 1e-12 &&
      got.v >= packed.v0 + half - 1e-12 && got.v <= packed.v0 + packed.dv - half + 1e-12;
    if (!inRect) outsideRect++;
    if (got.clamped) clampedTotal++;

    // Reconstruction: the packer's exact inverse, fed the LOOKUP's uv. Lands
    // within a texel of the original surface point or it is not the same map.
    const back = cardUnproject(packed, got.u, got.v, got.depth, he);
    const ia = (packed.axis + 1) % 3, ib = (packed.axis + 2) % 3;
    const texelU = (2 * Math.max(he[ia], CARD_EPS)) / packed.resU;
    const texelV = (2 * Math.max(he[ib], CARD_EPS)) / packed.resV;
    const pv = [p.x, p.y, p.z];
    const err = Math.max(
      Math.abs(back[ia] - pv[ia]) / texelU,
      Math.abs(back[ib] - pv[ib]) / texelV,
    );
    maxTexels = Math.max(maxTexels, err);
    if (err > 2) {
      structBugs++;
      if (structBugs <= 2) {
        console.error(
          `  STRUCTURE reconstruction bug on sample ${si} of ${c.name}: err=${err.toFixed(3)} texels ` +
            `slot=${slot} res=${packed.resU}x${packed.resV}`,
        );
      }
    } else if (err > 1) epsilonClass++;
    else within++;
  }
  const rate = epsilonClass / Math.max(1, samples.length);
  const bugs = structBugs + slotBugs + uvBugs;
  const ok = bugs === 0 && outsideRect === 0 && rate <= 0.02 && within > 0 &&
    inactive / samples.length <= 0.02;
  check(
    `lookup ${c.name}`,
    ok,
    `within-1-texel=${within} epsilon-class=${epsilonClass} structure-bugs=${bugs}/${samples.length} ` +
      `(slot=${slotBugs} uv=${uvBugs} recon=${structBugs}) outside-rect=${outsideRect} ` +
      `inactive=${inactive} maxΔst=${maxStDelta.toExponential(1)} maxΔuv=${maxUvDelta.toExponential(1)} ` +
      `maxΔ=${maxTexels.toFixed(3)} texels`,
  );
}

// ═════════════════════════════ 3. THE HALF-TEXEL INSET IS LOAD-BEARING
// It has to fire somewhere (silhouettes reach s=0/1, which is the rect BORDER,
// where a bilinear tap straddles the gutter) and nowhere else.
{
  check(
    "bilinear inset fires at card silhouettes",
    clampedTotal > 0,
    `${clampedTotal} border sample(s) pulled back inside their rect`,
  );

  const c = cases[0];
  const entry = built.entries[0];
  const he = [c.shape.halfExtents.x, c.shape.halfExtents.y, c.shape.halfExtents.z];
  const packed = decodeCard(region, 0, entry.cardTableRel);
  const half = 0.5 / built.stats.atlasSize;
  // A point dead-centre on the +X card: interior, must pass through untouched.
  const centre = cardLookupMirror({
    words: region, cardTableRel: entry.cardTableRel, pLocal: [he[0], 0, 0],
    nLocal: [1, 0, 0], halfExtents: he, atlasSize: built.stats.atlasSize,
  });
  // A point on the card's own silhouette: s = 1 exactly → the rect border.
  const edge = cardLookupMirror({
    words: region, cardTableRel: entry.cardTableRel, pLocal: [he[0], he[1], he[2]],
    nLocal: [1, 0, 0], halfExtents: he, atlasSize: built.stats.atlasSize,
  });
  const edgeRawAtBorder = Math.abs(edge.rawU - (packed.u0 + packed.du)) < 1e-9 ||
    Math.abs(edge.rawU - packed.u0) < 1e-9 ||
    Math.abs(edge.rawV - (packed.v0 + packed.dv)) < 1e-9 ||
    Math.abs(edge.rawV - packed.v0) < 1e-9;
  check(
    "inset is inert inside the card and exactly half a texel at the border",
    !centre.clamped && edge.clamped && edgeRawAtBorder &&
      Math.abs(Math.max(Math.abs(edge.u - edge.rawU), Math.abs(edge.v - edge.rawV)) - half) < 1e-9,
    `centre clamped=${centre.clamped}; silhouette raw=(${edge.rawU.toFixed(6)},${edge.rawV.toFixed(6)}) → ` +
      `(${edge.u.toFixed(6)},${edge.v.toFixed(6)}), half-texel=${half.toExponential(2)}`,
  );

  // And the reason it matters: without it, that silhouette sample sits ON the
  // rect boundary, where hardware bilinear averages in the unwritten gutter.
  check(
    "un-inset silhouette uv would straddle the atlas gutter",
    edge.rawU >= packed.u0 + packed.du - 1e-9 || edge.rawV >= packed.v0 + packed.dv - 1e-9 ||
      edge.rawU <= packed.u0 + 1e-9 || edge.rawV <= packed.v0 + 1e-9,
    `rect=(${packed.u0.toFixed(6)},${packed.v0.toFixed(6)},${packed.du.toFixed(6)},${packed.dv.toFixed(6)})`,
  );
}

// ═══════════════════════════════ 4. ONE FALLBACK PATH (§6.7, and §6.4's hole)
// Demoted object and inactive slot must be the SAME flag, not two behaviours.
{
  const plane = cases[1];
  const entry = built.entries[1];
  const he = [plane.shape.halfExtents.x, plane.shape.halfExtents.y, plane.shape.halfExtents.z];

  // (a) inactive slot: a plane allocates 2 of its 6, so a +X normal lands in a
  //     slot that was packed all-zero.
  const inactiveHit = cardLookupMirror({
    words: region, cardTableRel: entry.cardTableRel, pLocal: [0, 0, 0],
    nLocal: [1, 0, 0], halfExtents: he, atlasSize: built.stats.atlasSize,
  });
  // (b) demoted object / never built: word +23 is the 0 sentinel.
  const demotedHit = cardLookupMirror({
    words: region, cardTableRel: 0, pLocal: [0, 0, 0],
    nLocal: [0, 0, 1], halfExtents: he, atlasSize: built.stats.atlasSize,
  });
  // (c) the control: the plane's own +Z card IS active.
  const goodHit = cardLookupMirror({
    words: region, cardTableRel: entry.cardTableRel, pLocal: [0, 0, 0],
    nLocal: [0, 0, 1], halfExtents: he, atlasSize: built.stats.atlasSize,
  });
  check(
    "inactive slot and demoted object take the SAME fallback flag",
    inactiveHit.valid === false && demotedHit.valid === false && goodHit.valid === true &&
      inactiveHit.slot === 0 && demotedHit.slot === 4,
    `inactive(slot ${inactiveHit.slot}).valid=${inactiveHit.valid} ` +
      `demoted(rel 0, slot ${demotedHit.slot}).valid=${demotedHit.valid} active.valid=${goodHit.valid}`,
  );

  // The plane's degenerate half extent is what forces the EPS guard: without
  // it `cardProject` divides by zero and the two halves disagree about NaN.
  const st = cardStFromLocal(2, 1, [0.3, -0.2, 0], he);
  const refSt = cardProject(decodeCard(region, 4, entry.cardTableRel), 0.3, -0.2, 0, he);
  check(
    "EPS guard matches the packer on a genuinely zero half extent",
    Number.isFinite(st.s) && Number.isFinite(st.t) && Number.isFinite(st.depth) &&
      Math.abs(st.s - refSt.s) < 1e-9 && Math.abs(st.t - refSt.t) < 1e-9 &&
      Math.abs(st.depth - refSt.depth) < 1e-9,
    `he=[${he.join(", ")}] → s=${st.s.toFixed(6)} t=${st.t.toFixed(6)} depth=${st.depth}`,
  );

  // The word fetch itself: the mirror reads u0/v0/du/dv as f32 bitcast out of
  // u32 words and flags raw, at `cardTableRel + slot*8`. Held against decodeCard.
  let wordOk = true;
  let wordDetail = "";
  for (let slot = 0; slot < CARD_SLOTS; slot++) {
    const a = cardRectWords(region, entry.cardTableRel, slot);
    const b = decodeCard(region, slot, entry.cardTableRel);
    if (a.u0 !== b.u0 || a.v0 !== b.v0 || a.du !== b.du || a.dv !== b.dv ||
        a.active !== b.active || a.flags !== b.flags) {
      wordOk = false;
      wordDetail = `slot ${slot}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
    }
  }
  check(
    "the lookup's 5 word reads == decodeCard, at cardTableRel + slot*8",
    wordOk && CARD_WORDS === 8,
    wordDetail || `${CARD_SLOTS} slots × ${CARD_WORDS} words`,
  );
}

// ══════════════════════════════════ 5. ATLAS ALLOCATION (§6.3's three planes)
{
  const atlas = createSurfaceCacheAtlas();
  const planes = [atlas.srcMaterial, atlas.srcGeometry, atlas.srcRadiance];
  const fmtOk = planes.every((t) => t.type === THREE.HalfFloatType && t.format === THREE.RGBAFormat &&
    t.image.width === SRC_ATLAS_SIZE && t.image.height === SRC_ATLAS_SIZE && t.isStorageTexture);
  check(
    "three rgba16f atlas planes at the default tier",
    fmtOk && atlas.size === SRC_ATLAS_SIZE && atlas.stats.bytes === atlasBytes(SRC_ATLAS_SIZE),
    `${atlas.size}² × 3 = ${(atlas.stats.bytes / 1e6).toFixed(1)}MB`,
  );
  // Bilinear across the card is the entire point of §6.4 — and only srcRadiance
  // is ever filtered; the other two are per-texel lighting-pass inputs.
  check(
    "only srcRadiance is filtered, and only srcRadiance is a hot-path binding",
    atlas.srcRadiance.minFilter === THREE.LinearFilter &&
      atlas.srcRadiance.magFilter === THREE.LinearFilter &&
      atlas.srcMaterial.minFilter === THREE.NearestFilter &&
      atlas.srcGeometry.minFilter === THREE.NearestFilter &&
      Object.keys(atlas.hotBindings()).length === 1 &&
      atlas.hotBindings().srcRadiance === atlas.srcRadiance &&
      Object.keys(atlas.lightingTargets()).length === 3,
    `hot=${Object.keys(atlas.hotBindings()).join(",")} lighting=${Object.keys(atlas.lightingTargets()).join(",")} ` +
      `(§6.5: 1 of 16 sampled, 3 of 4 storage — and NEVER folded into the resolve)`,
  );
  // Every plane must get a distinct forced version, or three's bind-group cache
  // keeps pointing at a disposed texture (createGiTargets' documented trap).
  const versions = new Set(planes.map((t) => t.version));
  const second = createSurfaceCacheAtlas();
  check(
    "atlas textures carry a forced non-zero version (bind-group invalidation)",
    versions.size === 1 && [...versions][0] > 0 && second.srcRadiance.version !== atlas.srcRadiance.version,
    `gen ${[...versions][0]} → ${second.srcRadiance.version}`,
  );
  second.dispose();

  // Tiering, from surfaceCache's ladder — not from a number in the GPU file.
  const budget = createSurfaceCacheAtlas({ budgetBytes: 30 * 1024 * 1024 });
  check(
    "atlas size comes from surfaceCache's tier ladder",
    budget.size === 1024 && snapAtlasTier(1500) === 1024 && snapAtlasTier(99999) === SRC_ATLAS_TIERS[0] &&
      snapAtlasTier(1) === SRC_ATLAS_TIERS[SRC_ATLAS_TIERS.length - 1],
    `30MB budget → ${budget.size}² (${(atlasBytes(budget.size) / 1e6).toFixed(1)}MB), tiers=[${SRC_ATLAS_TIERS}]`,
  );
  budget.dispose();
  atlas.dispose();

  // The inset is computed from the atlas edge, so a tier change must move it.
  const rect = { u0: 0.25, v0: 0.5, du: 0.125, dv: 0.0625 };
  const big = cardUvFromSt(rect, 0, 0, 2048);
  const small = cardUvFromSt(rect, 0, 0, 512);
  check(
    "half-texel inset scales with the atlas tier",
    Math.abs(big.u - (rect.u0 + 0.5 / 2048)) < 1e-12 && Math.abs(small.u - (rect.u0 + 0.5 / 512)) < 1e-12,
    `2048²→+${(big.u - rect.u0).toExponential(2)}  512²→+${(small.u - rect.u0).toExponential(2)}`,
  );
}

// ══════════════ 6. WORD +23 IS NOW CLAIMED — EXACTLY ONCE, BY THE CARD TABLE
// The inverse of run-gi-surface-cache-test.mjs's reservation scan. That test
// asserts word +23 is UNCLAIMED ("writes=0 reads=0") so a second feature taking
// it goes red; the surface cache is its one legitimate claimant, so from here
// the assertion is EXACTLY ONE write and EXACTLY ONE read. Two writes means two
// features are sharing a word again.
{
  const src = readFileSync(
    fileURLToPath(new URL("../src/modules/gi/dynamicObjects.js", import.meta.url)), "utf8",
  );
  const writes = src.match(/\bwm\(\s*\w+\s*,\s*23\s*,/g) ?? [];
  const reads = src.match(/\bob\.add\(uint\(23\)\)/g) ?? [];
  check(
    "object-block word +23 is claimed exactly once, by the card table",
    writes.length === 1 && reads.length === 1,
    `writes=${writes.length} reads=${reads.length} (run-gi-surface-cache-test.mjs's ` +
      `"still free" assertion is the pre-claim form of this one and must flip)`,
  );
  check(
    "dynamicObjects exposes the card-table writer, the allocator and the GPU frame",
    /\bsetCardTable\s*\(/.test(src) && /\ballocPoolWords\s*\(/.test(src) && /\bcardFrameAt\s*\(/.test(src),
    "setCardTable / allocPoolWords / cardFrameAt",
  );
  // The word-layout comment used to say `16 + i*40` while DYN_HEADER_RESERVED
  // is 48. Anything deriving offsets from that comment is wrong by 32 words.
  check(
    "the word-layout comment no longer claims the 16-word header",
    !/^\/\/\s+16 \+ i\*40/m.test(src),
    "block offsets derive from DYN_HEADER_RESERVED + i*OBJ_WORDS",
  );
}

// ═══════════════ 7. §6.4 AS WRITTEN IS WRONG — each omission, measured
//
// The arithmetic above agrees with `cardProject` operation for operation, so on
// its own it only proves the transcription. What makes it a TEST is this arm:
// every deviation §6.4's prose invites is applied as a mutant and shown to move
// the answer by texels. A mutant that does NOT move the answer means the suite
// cannot see that class of bug, and the check goes red for that reason.
{
  const c = cases[0]; // 1.4 × 1.0 × 0.8 — deliberately asymmetric on all three
  const entry = built.entries[0];
  const he = [c.shape.halfExtents.x, c.shape.halfExtents.y, c.shape.halfExtents.z];
  const tris = extractLocalTriangles(c.mesh.geometry, c.shape.center);
  const { samples } = sampleSurface(tris, 3000, 0x77aa);
  const atlasSize = built.stats.atlasSize;

  /** Worst texel-scale (s, t) deviation of a mutant from the real lookup. */
  const measure = (mutate) => {
    let worst = 0;
    let broken = 0;
    let outOfRange = 0;
    for (const p of samples) {
      const pick = cardArgmaxSlot(p.nx, p.ny, p.nz);
      const rect = cardRectWords(region, entry.cardTableRel, pick.slot);
      if (!rect.active) continue;
      const good = cardStFromLocal(pick.axis, pick.sign, [p.x, p.y, p.z], he);
      const bad = mutate(pick, [p.x, p.y, p.z], he);
      if (!Number.isFinite(bad.s) || !Number.isFinite(bad.t)) { broken++; continue; }
      if (bad.s < 0 || bad.s > 1 || bad.t < 0 || bad.t > 1) outOfRange++;
      // Deviation in texels of the card it lands on.
      const resU = Math.round(rect.du * atlasSize);
      const resV = Math.round(rect.dv * atlasSize);
      worst = Math.max(worst, Math.abs(bad.s - good.s) * resU, Math.abs(bad.t - good.t) * resV);
    }
    return { worst, broken, outOfRange };
  };

  const rot = (axis) => CARD_AXIS_ROT[axis];
  // (A) §6.4's "/halfExtents → [0,1]²": no affine remap, so the card is halved
  //     and half of it mirrors.
  const noRemap = measure(({ axis, sign }, p, h) => {
    const r = rot(axis);
    return { s: (p[r[0]] * sign) / Math.max(h[r[0]], CARD_EPS), t: p[r[1]] / Math.max(h[r[1]], CARD_EPS) };
  });
  // (B) the missing sign mirror on s — invisible on a symmetric object, a
  //     left/right flip in exactly the three negative-sign cards.
  const noMirror = measure(({ axis }, p, h) => {
    const r = rot(axis);
    return {
      s: (p[r[0]] / Math.max(h[r[0]], CARD_EPS) + 1) * 0.5,
      t: (p[r[1]] / Math.max(h[r[1]], CARD_EPS) + 1) * 0.5,
    };
  });
  // (C) "the two ⊥ coords" taken in the other order — a transposed card.
  const swapped = measure(({ axis, sign }, p, h) => {
    const r = rot(axis);
    return {
      s: ((p[r[1]] * sign) / Math.max(h[r[1]], CARD_EPS) + 1) * 0.5,
      t: (p[r[0]] / Math.max(h[r[0]], CARD_EPS) + 1) * 0.5,
    };
  });
  check(
    "§6.4's (s, t) omissions each move the sample by texels",
    noRemap.worst > 2 && noRemap.outOfRange > 0 && noMirror.worst > 2 && swapped.worst > 2,
    `no-remap: ${noRemap.worst.toFixed(1)} texels (${noRemap.outOfRange} samples outside [0,1]²) · ` +
      `no-sign-mirror: ${noMirror.worst.toFixed(1)} texels · swapped-axes: ${swapped.worst.toFixed(1)} texels`,
  );

  // (D) `argmax |dot(nLocal, ±e_k)|` alone names 3 states for a 6-slot table.
  let signCollisions = 0;
  for (const p of samples) {
    const pick = cardArgmaxSlot(p.nx, p.ny, p.nz);
    if (pick.axis * 2 !== pick.slot) signCollisions++; // a negative-facing sample
  }
  check(
    "the sign bit is load-bearing: an axis-only argmax mis-addresses the table",
    signCollisions > samples.length * 0.3,
    `${signCollisions}/${samples.length} samples face a NEGATIVE axis — they would all read the ` +
      `+axis card without \`slot = axis*2 + (n[axis] < 0)\``,
  );

  // (G) the EPS guard, on the one shape that actually has a zero half extent.
  const planeHe = [
    cases[1].shape.halfExtents.x, cases[1].shape.halfExtents.y, cases[1].shape.halfExtents.z,
  ];
  const unguarded = (planeHe[2] - 0 * 1) / (2 * planeHe[2]);
  check(
    "the EPS guard is what keeps a plane finite",
    !Number.isFinite(unguarded) && Number.isFinite(cardStFromLocal(2, 1, [0, 0, 0], planeHe).depth),
    `unguarded depth on he.z=${planeHe[2]} → ${unguarded}; guarded → ` +
      `${cardStFromLocal(2, 1, [0, 0, 0], planeHe).depth}`,
  );
}

if (failures) {
  console.error(`gi-card-lookup: ${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("gi-card-lookup: all cases PASS");
