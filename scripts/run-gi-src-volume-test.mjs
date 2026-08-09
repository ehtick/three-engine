// SPLIT RADIANCE CASCADES — §12.5 STEP 1: IS THE SHADOW PATH ALLOWED TO DROP THE
// COMPOSITED DISTANCE FIELD?
//
// No GPU. Plain JS over src/modules/gi/srcVolumeRef.js, the Phase-0 pattern.
//
// THE QUESTION THIS DECIDES. §12.5 blocked the §5 deletion sweep on a quality
// claim: `distanceTexture` is a continuous distance the penumbra estimator needs,
// `freeRadiusAtWorld` is a staircase of voxel boxes, so swapping one for the other
// would reopen "dirty shadows". The claim is checkable, because in the shipping
// build the composite's own source IS that oracle (giField.js:216 —
// `minD.assign(occField.freeRadiusAtWorld(p, undefined, true, world.capWorld))`).
// The two arms are therefore the same function, one of them resampled onto the
// 0.33m radiance lattice and quantized to fp16. So the honest framing is not
// "can a staircase replace a smooth field" but "what does removing that low-pass
// cost, and what does it buy".
//
// ══ THE BAND EVERY NUMBER BELOW IS RESTRICTED TO, AND WHY IT IS NOT A DODGE ═══
//
// `freeRadiusAtWorld` is NOT globally conservative, deliberately: when its
// coarsest 2×2×2 is empty it returns the caller's saturation value, which
// occupancyField's own note explains as "the same overestimate the SDF makes".
// An empty top-level block only proves emptiness over [1, 2]·voxel·2^(L-1), so
// with `capWorld = 16·minCell` — 16 COARSE CELLS, 2.67× the oracle's own 16-VOXEL
// ceiling on a shipped preset — a point 1m from a wall can report 5.3m.
//
// The first version of this suite measured |d − truth| across that, and got mean
// errors of ~1.08m for BOTH arms: it was measuring the saturation gap, which the
// two arms share by construction, and it drowned the low-pass entirely. It also
// failed a conservativeness arm asserting a property the code never claimed, and
// a continuity arm whose worst "jump" was the cap↔real-distance flip. Three
// instrument faults, all of the §12.4 family, all fixed by one rule:
//
//   MEASURE ONLY WHERE THE VALUE IS USED AS A DISTANCE. Every consumer gates on
//   `d < 0.85·capWorld` precisely to throw saturated samples out of the estimator
//   ("open space, not an occluder"), so a saturated sample's numeric error never
//   reaches a pixel and comparing it measures nothing.
//
// The saturation gap is then measured on its own, as the FALSE-OPEN arm — because
// it is a real leak mechanism, it is identical in both arms, and sizing it is what
// says whether `capWorld` should keep being derived from the coarse cell at all.
// Both cap settings are run end to end so that decision has numbers.
//
// ══ WHAT EACH ARM IS FOR ══════════════════════════════════════════════════════
//
//   pyramid       the mirror itself. A clear parent must mean eight clear
//                 children (the DDA's skip depends on it) and out-of-range must
//                 read EMPTY, not sealed — get that backwards and every boundary
//                 case the arms differ on is hidden.
//   drift         REF_OCC_LEVELS must still equal occupancyField.js's OCC_LEVELS.
//   conservative  inside the used band the oracle must never report more free
//                 space than there is — that is the property a shadow trace is
//                 allowed to sphere-step on. The composite is measured, not
//                 asserted: trilinear interpolation of a 1-Lipschitz function
//                 overshoots between its samples, so it CANNOT be conservative,
//                 and the size of that overshoot is a leak budget oracle-direct
//                 does not spend.
//   false-open    how often each arm reports "open space" where truth says a
//                 wall is inside the cut. Shared mechanism, so this is a
//                 statement about `capWorld`, not about the arms.
//   accuracy      |arm − truth| in the used band. The claim is ORDINAL: the
//                 oracle is the composite's own source and cannot be worse than
//                 a low-passed, fp16-quantized copy of itself.
//   continuity    the one thing the low-pass genuinely provided. Worst per-step
//                 change along densely walked lines, counted only across steps
//                 where both samples are in the used band, and checked against
//                 the ladder's own predicted bound (0.5·voxel·2^L) so a
//                 violation means a mirror bug rather than a surprise.
//   width         THE DECIDING ARM. The estimator's output, not its input: a
//                 distance difference can be swallowed whole by the probe's gates
//                 or amplified by its `min` over twelve taps.
//   canary        the "block flag" oracle the near field exists to replace
//                 (nearField off) must FAIL accuracy and width. A comparison that
//                 cannot fail proves nothing (§12.4).
//
// Run: node scripts/run-gi-src-volume-test.mjs
import { readFileSync } from "node:fs";
import {
  REF_OCC_LEVELS,
  buildRefComposite,
  buildRefPyramid,
  refFreeRadius,
  refRoomScene,
  refTrueDistance,
  refWidthProbe,
  roundHalf,
} from "../src/modules/gi/srcVolumeRef.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stats = (values) => {
  if (!values.length) return { n: 0, mean: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted[sorted.length - 1],
  };
};
const fmt = (s, unit = "m") =>
  `mean ${s.mean.toFixed(4)}${unit} p95 ${s.p95.toFixed(4)}${unit} max ${s.max.toFixed(4)}${unit} (n=${s.n})`;

// ── the scene and the pyramid ────────────────────────────────────────────────

const scene = refRoomScene();
const pyr = buildRefPyramid(scene.res0, scene.isOccupied);
// Coarse lattice at the real ratio: 0.333m cells over 0.125m voxels, which is
// giField's `res` on the user's project. It is deliberately COARSER than the
// pyramid, and that ratio is the whole mechanism under test.
const COARSE = { x: 24, y: 24, z: 24 };
const minCell = (scene.bounds.max[0] - scene.bounds.min[0]) / COARSE.x;
// The largest emptiness proof the ladder can make: an empty 2×2×2 at the
// coarsest level bounds the free radius by [0.5, 1]·voxel·2^(LEVELS-1). Anything
// above this can only have come from the saturation branch.
const ORACLE_CEIL = scene.voxel * 2 ** (REF_OCC_LEVELS - 1);

console.log("─────────────────────────────────────────────────── §12.5 step 1");
console.log(
  `scene: ${scene.res0.x}³ voxels @ ${scene.voxel}m, coarse ${COARSE.x}³ @ ${minCell.toFixed(4)}m, ` +
  `occupied ${pyr.occupiedVoxels.length / 3} voxels`,
);
console.log(`oracle ceiling (voxel·2^${REF_OCC_LEVELS - 1}) = ${ORACLE_CEIL.toFixed(3)}m`);

// ── arm: the mirror is a mirror ─────────────────────────────────────────────

{
  const source = readFileSync(new URL("../src/modules/gi/occupancyField.js", import.meta.url), "utf8");
  const match = source.match(/export const OCC_LEVELS\s*=\s*(\d+)/);
  check("REF_OCC_LEVELS tracks occupancyField's OCC_LEVELS",
    !!match && Number(match[1]) === REF_OCC_LEVELS,
    `source=${match?.[1]} ref=${REF_OCC_LEVELS}`);

  let parentViolations = 0;
  for (let L = 1; L < REF_OCC_LEVELS; L++) {
    const l = pyr.plan[L];
    for (let z = 0; z < l.res.z; z++) {
      for (let y = 0; y < l.res.y; y++) {
        for (let x = 0; x < l.res.x; x++) {
          if (pyr.occupiedAt(x, y, z, L)) continue;
          for (let c = 0; c < 8; c++) {
            if (pyr.occupiedAt(x * 2 + (c & 1), y * 2 + ((c >> 1) & 1), z * 2 + ((c >> 2) & 1), L - 1)) {
              parentViolations++;
            }
          }
        }
      }
    }
  }
  check("a clear parent means eight clear children (the DDA cannot tunnel)",
    parentViolations === 0, `${parentViolations} violation(s)`);
  check("out of range reads EMPTY, not sealed",
    pyr.occupiedAt(-1, 5, 5, 0) === 0 && pyr.occupiedAt(scene.res0.x, 5, 5, 0) === 0);
  check("a point inside geometry reports zero free radius",
    refFreeRadius(pyr, [4, 0.06, 4], scene.grid, { cap: 5 }) === 0);
  check("f16 round-trip is a real quantization step",
    roundHalf(0.1) !== 0.1 && Math.abs(roundHalf(0.1) - 0.1) < 1e-4,
    `f16(0.1)=${roundHalf(0.1)}`);
  // The saturation branch has to FIRE somewhere, or the false-open arm below is
  // measuring an empty set. It fires on a FRACTION of open space, not on all of
  // it, and picking one hopeful point to assert it on is how the first version
  // of this check failed: an 8m box has a 4-voxel-wide top level, so the
  // coarsest 2×2×2 around a mid-room point still contains the back wall and the
  // oracle correctly returns a real 1m bound instead of the cap.
  let saturating = 0;
  const scanRng = makeRng(0x1234);
  for (let i = 0; i < 500; i++) {
    const p = [0.5 + scanRng() * 7, 0.5 + scanRng() * 7, 0.5 + scanRng() * 7];
    if (refFreeRadius(pyr, p, scene.grid, { cap: 99 }) === 99) saturating++;
  }
  check("the saturation branch fires in open space (it is what the cut gates)",
    saturating > 0, `${saturating}/500 sampled points saturate`);
}

// ── the shared free-space sample set ────────────────────────────────────────

const rng = makeRng(0x5121);
const samples = [];
{
  // Rejection-sample points strictly OUTSIDE geometry — a point inside an
  // occupied voxel is not a shadow-ray sample any march produces (§12.4's third
  // instrument fault: feeding an estimator invalid geometry, then blaming it for
  // the answer).
  const pad = scene.voxel * 1.01;
  while (samples.length < 4000) {
    const p = [
      pad + rng() * (scene.bounds.max[0] - 2 * pad),
      pad + rng() * (scene.bounds.max[1] - 2 * pad),
      pad + rng() * (scene.bounds.max[2] - 2 * pad),
    ];
    if (pyr.occupiedAt(
      Math.floor(p[0] / scene.voxel), Math.floor(p[1] / scene.voxel), Math.floor(p[2] / scene.voxel), 0,
    )) continue;
    samples.push(p);
  }
}

/**
 * The whole comparison at one `capWorld`. Run twice, because the cap is the
 * biggest single term in every number here and the two settings are a real
 * design choice: `16·minCell` is what giField's bundle carries today (and what
 * the A/B seam must keep, so the two arms differ only in the distance source),
 * while `voxel·2^(LEVELS-1)` makes the consumers' cut land exactly on the
 * samples the oracle actually saturated.
 */
function runComparison(capWorld, label, { gate }) {
  const capCut = capWorld * 0.85;
  const composite = buildRefComposite(pyr, scene.grid, { bounds: scene.bounds, res: COARSE, capWorld });
  const oracleAt = (p) => refFreeRadius(pyr, p, scene.grid, { cap: capWorld });
  const compositeAt = (p) => composite.sample(p);
  const compositeFlags = (p) => composite.sample(p, true);
  const truthAt = (p) => refTrueDistance(pyr, p, scene.grid, capWorld);
  // The canary: the "same 2×2×2 test at level 0 as everywhere else" oracle the
  // near field was written to replace. Its own comment records the symptom —
  // every point within a voxel of geometry reports 0, sphere tracing inflates
  // every occluder by a voxel, the whole scene goes visibly darker.
  const blockFlagAt = (p) => refFreeRadius(pyr, p, scene.grid, { cap: capWorld, nearField: false });

  console.log("");
  console.log(`══ ${label}: capWorld ${capWorld.toFixed(3)}m, cut ${capCut.toFixed(3)}m ` +
    `(${(capWorld / ORACLE_CEIL).toFixed(2)}× the oracle's ceiling)`);

  // ── false-open: the saturation gap, sized ────────────────────────────────
  let falseOpen = { oracle: 0, composite: 0, inCut: 0 };
  const gaps = [];
  for (const p of samples) {
    const truth = truthAt(p);
    if (truth >= capCut) continue;
    falseOpen.inCut++;
    if (oracleAt(p) >= capCut) {
      falseOpen.oracle++;
      gaps.push(capCut - truth);
    }
    if (compositeAt(p) >= capCut) falseOpen.composite++;
  }
  const gapStats = stats(gaps);
  console.log(
    `   false-open (reports "open space" where truth says a wall is inside the cut): ` +
    `oracle ${falseOpen.oracle}/${falseOpen.inCut} ` +
    `(${((100 * falseOpen.oracle) / Math.max(falseOpen.inCut, 1)).toFixed(1)}%), ` +
    `composite ${falseOpen.composite}/${falseOpen.inCut} ` +
    `(${((100 * falseOpen.composite) / Math.max(falseOpen.inCut, 1)).toFixed(1)}%)`,
  );
  if (gaps.length) console.log(`   ...and when it happens the wall is hidden by ${fmt(gapStats)}`);

  // ── the used band: both arms produced a real distance ────────────────────
  const band = [];
  for (const p of samples) {
    const truth = truthAt(p);
    const o = oracleAt(p);
    const cf = compositeFlags(p);
    if (truth >= capCut || o >= capCut || cf.value >= capCut) continue;
    band.push({ p, truth, o, c: cf.value, cSat: cf.anySaturated, k: blockFlagAt(p) });
  }
  console.log(`   used band: ${band.length}/${samples.length} samples ` +
    `(the rest saturate in at least one arm and are gated out of every estimator)`);

  const EPS = 1e-9;
  const oracleOver = band.filter((s) => s.o > s.truth + EPS);
  const compositeOver = band.filter((s) => s.c > s.truth + EPS);
  if (gate) {
    check("in the used band the oracle NEVER reports more free space than there is",
      oracleOver.length === 0,
      oracleOver.length
        ? `${oracleOver.length} violations, worst ${Math.max(...oracleOver.map((s) => s.o - s.truth)).toFixed(4)}m`
        : "0 violations");
  }
  // TWO overshoot mechanisms, and conflating them is what made the first
  // version of this arm report a 1.86m "trilinear" overshoot — 5.6 coarse cells,
  // which no Lipschitz argument permits. Interpolating two real distances
  // overshoots by under half a cell; interpolating against a SATURATED
  // neighbour blends in `capWorld` itself and reports metres of free space a
  // voxel from a wall. The gate belongs on the first; the second is a finding.
  const pure = compositeOver.filter((s) => !s.cSat);
  const smeared = compositeOver.filter((s) => s.cSat);
  const overPure = stats(pure.map((s) => s.c - s.truth));
  const overSmear = stats(smeared.map((s) => s.c - s.truth));
  console.log(
    `   composite overshoots truth on ${compositeOver.length}/${band.length} band samples ` +
    `(${((100 * compositeOver.length) / Math.max(band.length, 1)).toFixed(1)}%)`,
  );
  console.log(`     from interpolating real distances (${pure.length}): ${fmt(overPure)}`);
  console.log(`     from interpolating a SATURATED corner (${smeared.length}): ${fmt(overSmear)}`);
  if (gate) {
    check("the composite's non-saturated overshoot is the trilinear one (under a coarse cell)",
      overPure.max <= minCell,
      `worst ${overPure.max.toFixed(4)}m vs cell ${minCell.toFixed(4)}m`);
  }

  // ── accuracy ─────────────────────────────────────────────────────────────
  //
  // THE ORDINAL CLAIM THIS ARM STARTED WITH WAS WRONG, and the reason is worth
  // more than the claim was. The composite wins slightly on whole-band
  // |d − truth| — and it wins BY overshooting. Both arms are (mostly) lower
  // bounds, so averaging one upward moves it toward truth: the blur buys mean
  // absolute error with exactly the conservativeness it gives up. A gate on
  // |d − truth| therefore rewards the leak, which is why the decisive arm is the
  // penumbra width and why the gates here are on the CONTACT band and on the
  // mechanism.
  const o = stats(band.map((s) => Math.abs(s.o - s.truth)));
  const c = stats(band.map((s) => Math.abs(s.c - s.truth)));
  const k = stats(band.map((s) => Math.abs(s.k - s.truth)));
  console.log(`   |d − truth|  oracle-direct : ${fmt(o)}`);
  console.log(`                composited tex: ${fmt(c)}`);
  console.log(`                canary        : ${fmt(k)}`);
  const compositeWins = band.filter((s) => Math.abs(s.c - s.truth) < Math.abs(s.o - s.truth) - 1e-9);
  const boughtWithOvershoot = compositeWins.filter((s) => s.c > s.truth + 1e-9).length;
  console.log(
    `   the composite is closer to truth on ${compositeWins.length}/${band.length} samples; ` +
    `${boughtWithOvershoot} of those (${((100 * boughtWithOvershoot) / Math.max(compositeWins.length, 1)).toFixed(0)}%) ` +
    `it reached by reporting MORE free space than exists`,
  );
  // CONTACT BAND — within 2 voxels, which is where the estimator's contact
  // break, its own-plane exclusion and the hard-block safety net all decide.
  // This is the band the near field covers, so it is also where the canary must
  // separate; past it the ladder's [0.5,1]·voxel·2^L granularity takes over and
  // the blur's upward averaging genuinely reads closer to truth (see the hugging
  // rows below, where the crossover is visible at 3 voxels).
  const contact = band.filter((s) => s.truth < scene.voxel * 2);
  const co = stats(contact.map((s) => Math.abs(s.o - s.truth)));
  const cc = stats(contact.map((s) => Math.abs(s.c - s.truth)));
  const ck = stats(contact.map((s) => Math.abs(s.k - s.truth)));
  console.log(`   contact band (truth < 2 voxels, n=${contact.length}):`);
  console.log(`     oracle-direct : ${fmt(co)}`);
  console.log(`     composited tex: ${fmt(cc)}`);
  console.log(`     canary        : ${fmt(ck)}`);
  if (gate) {
    check("oracle-direct is more accurate than the composite at contact scale (mean)",
      co.mean < cc.mean, `${co.mean.toFixed(4)}m vs ${cc.mean.toFixed(4)}m`);
    check("oracle-direct is more accurate than the composite at contact scale (p95)",
      co.p95 < cc.p95, `${co.p95.toFixed(4)}m vs ${cc.p95.toFixed(4)}m`);
    check("CANARY: dropping the near field wrecks contact-scale accuracy",
      ck.mean > co.mean * 1.5, `${ck.mean.toFixed(4)}m vs ${co.mean.toFixed(4)}m`);
  }

  // ── the hugging-ray case, isolated ───────────────────────────────────────
  // The one the composite's undershoot forced `planeCut` up to 3.5 voxels and
  // the width probe's proportional gate down to 0.6·planeHeight for — a cost
  // paid in probe width against every occluder within 40% of a ray's
  // receiver-plane height. Truth here is exactly the height above the slab.
  const hugRng = makeRng(0x77aa);
  for (const h of [1.5, 2, 3, 4].map((v) => v * scene.voxel)) {
    const eo = [];
    const ec = [];
    for (let i = 0; i < 400; i++) {
      const p = [1 + hugRng() * 3, 2 * scene.voxel + h, 1 + hugRng() * 3];
      const truth = truthAt(p);
      eo.push(oracleAt(p) - truth);
      ec.push(compositeAt(p) - truth);
    }
    const meanO = eo.reduce((a, b) => a + b, 0) / eo.length;
    const meanC = ec.reduce((a, b) => a + b, 0) / ec.length;
    const sgn = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(4)}m (${(v / scene.voxel).toFixed(2)} vox)`;
    console.log(
      `   hugging floor @ ${(h / scene.voxel).toFixed(1)} vox: ` +
      `oracle |err| ${stats(eo.map(Math.abs)).mean.toFixed(4)}m signed ${sgn(meanO)}, ` +
      `composite |err| ${stats(ec.map(Math.abs)).mean.toFixed(4)}m signed ${sgn(meanC)}`,
    );
  }

  // ── continuity ───────────────────────────────────────────────────────────
  {
    const STEP = scene.voxel / 16;
    const predicted = 0.5 * scene.voxel * 2 ** (REF_OCC_LEVELS - 1);
    const worst = { oracle: 0, composite: 0 };
    const jumps = { oracle: [], composite: [] };
    const lineRng = makeRng(0x3311);
    for (let n = 0; n < 60; n++) {
      const a = [
        0.3 + lineRng() * (scene.bounds.max[0] - 0.6),
        0.3 + lineRng() * (scene.bounds.max[1] - 0.6),
        0.3 + lineRng() * (scene.bounds.max[2] - 0.6),
      ];
      let dir = [lineRng() * 2 - 1, lineRng() * 2 - 1, lineRng() * 2 - 1];
      const len = Math.hypot(...dir) || 1;
      dir = dir.map((v) => v / len);
      let prev = null;
      for (let s = 0; s < 300; s++) {
        const p = [a[0] + dir[0] * s * STEP, a[1] + dir[1] * s * STEP, a[2] + dir[2] * s * STEP];
        if (p.some((v, i) => v < 0 || v > scene.bounds.max[i])) break;
        const now = { o: oracleAt(p), c: compositeAt(p) };
        // Only across steps where BOTH samples are in the used band: the
        // cap↔real-distance flip is a 4.8m "jump" that no estimator ever sees,
        // and counting it made the first version of this arm report a 38×
        // smoothness regression that does not exist.
        if (prev && prev.o < capCut && now.o < capCut && prev.c < capCut && now.c < capCut) {
          const dO = Math.abs(now.o - prev.o);
          const dC = Math.abs(now.c - prev.c);
          jumps.oracle.push(dO);
          jumps.composite.push(dC);
          worst.oracle = Math.max(worst.oracle, dO);
          worst.composite = Math.max(worst.composite, dC);
        }
        prev = now;
      }
    }
    const so = stats(jumps.oracle);
    const sc = stats(jumps.composite);
    console.log(`   per-step |Δd| over ${(STEP * 1000).toFixed(1)}mm steps, in-band:`);
    console.log(`     oracle-direct : ${fmt(so)}`);
    console.log(`     composited tex: ${fmt(sc)}`);
    console.log(
      `   worst oracle jump ${worst.oracle.toFixed(4)}m = ${(worst.oracle / scene.voxel).toFixed(2)} voxels; ` +
      `ladder bound ${predicted.toFixed(4)}m`,
    );
    if (gate) {
      check("the oracle's worst in-band jump stays inside the ladder's own bound",
        worst.oracle <= predicted + 1e-9,
        `${worst.oracle.toFixed(4)}m vs ${predicted.toFixed(4)}m`);
    }
    console.log(
      `   SMOOTHNESS COST of dropping the low-pass: ${(so.mean / Math.max(sc.mean, 1e-12)).toFixed(2)}× mean step, ` +
      `${(worst.oracle / Math.max(worst.composite, 1e-12)).toFixed(2)}× worst step`,
    );
  }

  // ── the width probe: what actually reaches a pixel ────────────────────────
  const lift = 1.5 * scene.voxel;
  const planeCut = Math.max(minCell * 1.0, scene.voxel * 3.5);
  const common = { capWorld, minCell, planeCut, bounds: scene.bounds };
  const cfgRng = makeRng(0x9ded);
  const configs = [];
  for (let i = 0; i < 900; i++) {
    const from = [0.6 + cfgRng() * 5.2, 2 * scene.voxel + lift, 0.6 + cfgRng() * 5.2];
    const to = [0.4 + cfgRng() * 6.4, 0.8 + cfgRng() * 4.0, 0.4 + cfgRng() * 6.4];
    let dir = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const maxT = Math.hypot(...dir);
    if (maxT < 1) continue;
    dir = dir.map((v) => v / maxT);
    configs.push({
      origin: from, dir, tStart: scene.voxel * 3, maxT,
      // 1.2 is the emitter k the waffle-grid failure showed up at; 6 is sun-ish.
      k: [1.2, 2.5, 6][i % 3],
      cosRayNormal: dir[1], lift,
    });
  }
  const diffs = { oracle: [], composite: [], canary: [] };
  let differ = 0;
  let oracleCloser = 0;
  let compositeCloser = 0;
  for (const cfg of configs) {
    const wTruth = refWidthProbe(truthAt, { ...cfg, ...common }).width;
    const wOracle = refWidthProbe(oracleAt, { ...cfg, ...common }).width;
    const wComposite = refWidthProbe(compositeAt, { ...cfg, ...common }).width;
    const wCanary = refWidthProbe(blockFlagAt, { ...cfg, ...common }).width;
    diffs.oracle.push(Math.abs(wOracle - wTruth));
    diffs.composite.push(Math.abs(wComposite - wTruth));
    diffs.canary.push(Math.abs(wCanary - wTruth));
    if (Math.abs(wOracle - wComposite) > 1e-4) differ++;
    if (Math.abs(wOracle - wTruth) < Math.abs(wComposite - wTruth) - 1e-6) oracleCloser++;
    if (Math.abs(wComposite - wTruth) < Math.abs(wOracle - wTruth) - 1e-6) compositeCloser++;
  }
  const wo = stats(diffs.oracle);
  const wc = stats(diffs.composite);
  const wk = stats(diffs.canary);
  console.log(`   penumbra width vs TRUTH over ${configs.length} rays (width ∈ [0,1]):`);
  console.log(`     oracle-direct : ${fmt(wo, "")}`);
  console.log(`     composited tex: ${fmt(wc, "")}`);
  console.log(`     canary        : ${fmt(wk, "")}`);
  console.log(
    `   arms disagree on ${differ} rays; oracle closer to truth on ${oracleCloser}, ` +
    `composite closer on ${compositeCloser}`,
  );
  if (gate) {
    // A control before the comparison means anything: if the arms never
    // disagree, the battery is not exercising the distance source at all.
    check("the ray battery actually separates the two arms", differ > configs.length * 0.1,
      `${differ}/${configs.length}`);
    check("oracle-direct's penumbra is at least as true as the composite's (mean)",
      wo.mean <= wc.mean, `${wo.mean.toFixed(4)} vs ${wc.mean.toFixed(4)}`);
    check("oracle-direct wins on more rays than it loses",
      oracleCloser >= compositeCloser, `${oracleCloser} vs ${compositeCloser}`);
    // The canary separates by less here than at contact scale, and that is the
    // honest reading rather than a weak gate: the probe is the MID field by
    // construction (its own header says contact width is the march's job), so
    // removing the near field is exactly the change it is least sensitive to.
    // Contact-band accuracy above is where this canary bites.
    check("CANARY: the block-flag oracle produces a wronger penumbra than the near-field one",
      wk.mean > wo.mean, `${wk.mean.toFixed(4)} vs ${wo.mean.toFixed(4)}`);
  }

  // ── the hugging ray's FALSE DARKENING, the failure with the screenshots ───
  // The waffle-grid floor and the concentric moiré rings were both false
  // darkening of rays that nothing occludes. Truth says width 1; anything less
  // from an arm is that failure, and it is the one metric where a difference is
  // visible rather than statistical.
  const hugRng2 = makeRng(0xbeef);
  const falseDark = { oracle: 0, composite: 0, truthOpen: 0, oracleWorst: 1, compositeWorst: 1 };
  for (let i = 0; i < 500; i++) {
    const from = [0.8 + hugRng2() * 1.4, 2 * scene.voxel + lift, 3.4 + hugRng2() * 1.8];
    const dir = [1, 0.03 + hugRng2() * 0.05, 0];
    const len = Math.hypot(...dir);
    const cfg = {
      origin: from, dir: dir.map((v) => v / len), tStart: scene.voxel * 3, maxT: 4,
      k: 1.2, cosRayNormal: dir[1] / len, lift,
    };
    const wTruth = refWidthProbe(truthAt, { ...cfg, ...common }).width;
    if (wTruth < 0.999) continue;
    falseDark.truthOpen++;
    const wo2 = refWidthProbe(oracleAt, { ...cfg, ...common }).width;
    const wc2 = refWidthProbe(compositeAt, { ...cfg, ...common }).width;
    if (wo2 < 0.999) falseDark.oracle++;
    if (wc2 < 0.999) falseDark.composite++;
    falseDark.oracleWorst = Math.min(falseDark.oracleWorst, wo2);
    falseDark.compositeWorst = Math.min(falseDark.compositeWorst, wc2);
  }
  console.log(
    `   hugging rays truth says UNOCCLUDED: ${falseDark.truthOpen}; falsely darkened by ` +
    `oracle ${falseDark.oracle} (worst width ${falseDark.oracleWorst.toFixed(3)}), ` +
    `composite ${falseDark.composite} (worst ${falseDark.compositeWorst.toFixed(3)})`,
  );
  if (gate) {
    check("oracle-direct does not falsely darken more hugging rays than the composite",
      falseDark.oracle <= falseDark.composite,
      `${falseDark.oracle} vs ${falseDark.composite} of ${falseDark.truthOpen}`);
  }

  return { falseOpen, band: band.length, accuracy: { o, c }, width: { wo, wc, oracleCloser, compositeCloser } };
}

// THE GATED RUN is the A/B parity one: `16·minCell` is the constant giField's
// bundle carries, so it is the only setting in which the seam changes exactly
// one thing. The voxel-derived cap is reported beside it as the design question
// it answers.
const parity = runComparison(16 * minCell, "A/B PARITY — capWorld = 16·minCell (giField's bundle)", { gate: true });
const voxelCap = runComparison(ORACLE_CEIL, "DESIGN ARM — capWorld = voxel·2^(LEVELS-1) (the oracle's own ceiling)", { gate: false });

console.log("");
console.log("══ what the cap setting is worth");
console.log(
  `   false-open rate: ${((100 * parity.falseOpen.oracle) / Math.max(parity.falseOpen.inCut, 1)).toFixed(1)}% at ` +
  `16·minCell → ${((100 * voxelCap.falseOpen.oracle) / Math.max(voxelCap.falseOpen.inCut, 1)).toFixed(1)}% at the ceiling`,
);
console.log(
  `   in-band accuracy: ${parity.accuracy.o.mean.toFixed(4)}m → ${voxelCap.accuracy.o.mean.toFixed(4)}m; ` +
  `penumbra error ${parity.width.wo.mean.toFixed(4)} → ${voxelCap.width.wo.mean.toFixed(4)}`,
);

console.log("─────────────────────────────────────────────────────────────────");
if (failures) {
  console.error(`gi-src-volume: ${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("gi-src-volume: all cases PASS");
