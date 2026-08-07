// LIGHT TREE CORRECTNESS — CPU ground truth for the many-light NEE structure
// (src/modules/gi/lightTree.js, docs/GI_NEXT_ARCHITECTURE.md §7 item 1).
//
// Same shape as scripts/run-gi-dynobj-bvh4-test.mjs: no GPU in the loop, a
// deterministic PRNG so every failure reproduces standalone, and — the part
// that matters — an ARBITER that separates a STRUCTURE BUG from an
// EPSILON-CLASS disagreement. There the arbiter was brute force over the same
// packed triangle pool; here it is brute force over every emitter, plus the
// Monte-Carlo standard error of the estimator itself. An estimate that misses
// the reference by more than its own error bars is a broken pdf; one that
// misses by less is sampling noise and nothing else.
//
// WHAT EACH ARM IS FOR (all four §7 symptoms have a test):
//   structure  — the packed block round-trips, no emitter is lost, cluster
//                bounds/power/cones are conservative supersets of their
//                subtrees. A leaked emitter here IS the cap, rebuilt by hand.
//   colour     — emitter radiance equals resolveMaterialSurface's answer.
//                §6.6: two notions of an emitter's colour = a hue step when an
//                object crosses between the two paths. Already made once.
//   pdf        — sum of selection probabilities is exactly 1 (no splitting) /
//                exactly the expected sample count (splitting), every emitter
//                that contributes has p > 0, and the sampler's empirical
//                frequencies match the independently-recomputed pdf.
//   unbiased   — the estimator converges to brute force. Includes a CANARY
//                arm with a deliberately wrong pdf, which must be caught: a
//                convergence test that cannot fail proves nothing.
//   flat-in-N  — §7's acceptance criterion. Per-lamp delivered contribution
//                must not depend on how many lamps exist.
//   ranking    — permuting emitter power must not change relative delivery.
//                Under MAX_EMITTERS this is exactly what pops; with one
//                representation there is no ranking left to churn.
//
// Run: node scripts/run-gi-light-tree-test.mjs
import * as THREE from "three/webgpu";
import {
  LT_EMITTER_WORDS, LT_HEADER_WORDS, LT_NODE_WORDS, LT_VERSION, LIGHT_TREE_ARITY,
  buildLightTree, collectEmitters, emitterIrradiance, estimateLightTree,
  estimateLightTreeWords, lightTreeReference, lightTreeSelectPdf, readLightTree,
  sampleLightTree,
} from "../src/modules/gi/lightTree.js";
import { resolveMaterialSurface } from "../src/modules/gi/voxelizeOnce.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── deterministic PRNG (no Math.random in harnesses) ────────────────────────
// mulberry32, NOT the `seed*1103515245 & 0x7fffffff` LCG the other GI
// harnesses use. That one multiplies a 31-bit seed by a 30-bit constant, which
// overflows the 53-bit mantissa — so it is not even the generator it looks
// like, and its serial correlation is enormous. Ray-hit suites never notice
// (they compare per-ray answers, not frequencies); this suite measures
// SAMPLING FREQUENCIES against a computed pdf at 5 sigma, where a bad stream
// reads as a pdf bug. Every arithmetic step below is exact 32-bit.
let rngState = 0x2f6e2b1 >>> 0;
const rand = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const reseed = (s) => { rngState = s >>> 0; };

// ── scene builders ──────────────────────────────────────────────────────────
const lampMesh = (position, rgb, size = 0.4, intensity = 1) => {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshStandardMaterial({
      emissive: new THREE.Color(rgb[0], rgb[1], rgb[2]),
      emissiveIntensity: intensity,
    }),
  );
  mesh.position.set(position[0], position[1], position[2]);
  mesh.updateMatrixWorld(true);
  return mesh;
};

/** N lamps scattered on a shell around the origin — a real 3D tree, not a row. */
const scatterScene = (n, { rgb = [1, 1, 1], jitterSeed = 0x51f3 } = {}) => {
  reseed(jitterSeed);
  const meshes = [];
  for (let i = 0; i < n; i++) {
    // Fibonacci-ish shell, upper hemisphere so every lamp is above a +Y
    // receiver at the origin (the shading point every arm uses).
    const a = i * 2.399963;
    const y = 0.25 + (i / Math.max(n, 1)) * 0.7;
    const r = Math.sqrt(Math.max(1 - y * y, 1e-3)) * (2.5 + rand() * 2.5);
    meshes.push(lampMesh([Math.cos(a) * r, 1.2 + y * 2.5, Math.sin(a) * r], rgb));
  }
  return meshes;
};

/**
 * N IDENTICAL lamps on a ring — the flat-in-N rig. Per-lamp delivery is the
 * same number for every lamp by construction, so total/N is directly the
 * quantity §7 says must not depend on N.
 *
 * THE ROTATION IS LOAD-BEARING. Without `rotation.y = -a` the lamps stay
 * axis-aligned, so a lamp on the +X axis presents one face to the origin and
 * a lamp at 45 degrees presents two — a cube seen corner-on has sqrt(2) the
 * projected area of one seen face-on. The ANALYTIC per-lamp value then rises
 * ~11% from N=4 to N=8 purely because the new lamps sit at the diagonals, and
 * the rig reports a light-count dependence that is entirely its own. (Measured
 * before this line existed: 7.111e-3 at N=1/4 vs 7.847e-3 at N=8.) Rotating
 * each lamp to face the centre makes every lamp geometrically identical, which
 * is what "per-lamp delivery must not depend on N" actually needs.
 */
const ringScene = (n, radius = 3.5, height = 2.2, rgb = [1, 1, 1]) => {
  const meshes = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const mesh = lampMesh([Math.cos(a) * radius, height, Math.sin(a) * radius], rgb);
    mesh.rotation.y = -a; // local +X -> outward radial, for every lamp alike
    mesh.updateMatrixWorld(true);
    meshes.push(mesh);
  }
  return meshes;
};

const build = (meshes) => {
  const built = buildLightTree(collectEmitters(meshes));
  if (!built) return null;
  // Read back through a NON-ZERO baseWord: the block is destined for the tail
  // of the occupancy `bits` buffer, so every internal offset must be
  // base-relative. A hard-coded absolute offset passes at base 0 and corrupts
  // everything in the real buffer — exactly the class of bug the
  // dynamicObjectWordOffset region already had to get right once.
  const pad = 137;
  const hosted = new Uint32Array(pad + built.words.length + 11);
  hosted.set(built.words, pad);
  return { built, view: readLightTree(hosted, pad), hosted, pad };
};

// ═══════════════════════════════════════════ 1. STRUCTURE + POWER + CONES
const SWEEP = [1, 4, 8, 32, 128];
const trees = new Map();
for (const n of SWEEP) {
  const meshes = scatterScene(n);
  const made = build(meshes);
  if (!made) { check(`structure N=${n}`, false, "buildLightTree returned null"); continue; }
  const { built, view } = made;
  trees.set(n, { ...made, meshes });

  const problems = [];
  if (view.emitterCount !== n) problems.push(`emitterCount ${view.emitterCount} != ${n} (an emitter was DROPPED — that is the cap)`);
  if (built.words.length !== built.layout.totalWords) problems.push(`words ${built.words.length} != header totalWords ${built.layout.totalWords}`);
  if (view.totalWords !== built.words.length) problems.push(`view.totalWords ${view.totalWords} mismatch`);
  if (view.arity !== LIGHT_TREE_ARITY) problems.push(`arity ${view.arity}`);
  if (built.layout.nodeBase !== LT_HEADER_WORDS) problems.push(`nodeBase ${built.layout.nodeBase}`);
  if (built.layout.nodeWords !== built.nodeCount * LT_NODE_WORDS) problems.push("node stride");
  if (built.layout.emitterWords !== n * LT_EMITTER_WORDS) problems.push("emitter stride");

  // Every emitter reachable exactly once, from the packed leaf slot words.
  const seen = new Uint32Array(n);
  const walkLeaves = (node) => {
    for (let s = 0; s < view.arity; s++) {
      const ref = view.childRef(node, s);
      if (ref === 0) continue;
      if (ref & 0x80000000) {
        const start = ref & 0x00ffffff;
        const count = (ref >>> 24) & 0x7f;
        for (let j = 0; j < count; j++) seen[view.leafEmitterId(start, j)]++;
      } else walkLeaves(ref - 1);
    }
  };
  walkLeaves(0);
  const missing = [...seen].filter((c) => c === 0).length;
  const dupes = [...seen].filter((c) => c > 1).length;
  if (missing) problems.push(`${missing} emitter(s) unreachable`);
  if (dupes) problems.push(`${dupes} emitter(s) in >1 leaf`);

  // Bounds/power/cone conservativeness, bottom-up over the packed words.
  const attr = { power: 0, axis: [0, 0, 0], cosThetaO: -1, cosThetaE: 0, count: 0 };
  const bnd = [0, 0, 0, 0, 0, 0];
  let worstPower = 0;
  let boundsViolations = 0;
  let coneViolations = 0;
  const subtree = (node, s) => {
    const ref = view.childRef(node, s);
    const ids = [];
    if (ref & 0x80000000) {
      const start = ref & 0x00ffffff;
      const count = (ref >>> 24) & 0x7f;
      for (let j = 0; j < count; j++) ids.push(view.leafEmitterId(start, j));
    } else {
      for (let k = 0; k < view.arity; k++) {
        if (view.childRef(ref - 1, k) !== 0) ids.push(...subtree(ref - 1, k));
      }
    }
    return ids;
  };
  const verifyNode = (node) => {
    let sum = 0;
    for (let s = 0; s < view.arity; s++) {
      if (view.childRef(node, s) === 0) continue;
      view.childAttr(node, s, attr);
      view.childBounds(node, s, bnd);
      const ids = subtree(node, s);
      if (ids.length !== attr.count) problems.push(`node ${node} slot ${s}: count ${attr.count} != ${ids.length}`);
      let power = 0;
      const cAxis = attr.axis.slice();
      const cTheta = Math.acos(Math.max(-1, Math.min(1, attr.cosThetaO)));
      for (const id of ids) {
        const e = view.emitter(id);
        power += e.power;
        for (let k = 0; k < 3; k++) {
          if (e.min[k] < bnd[k] - 1e-4 || e.max[k] > bnd[k + 3] + 1e-4) boundsViolations++;
        }
        // The cluster cone must CONTAIN the emitter cone, or importance can
        // reach zero on a light that still emits at the point — silent bias.
        const d = cAxis[0] * e.axis[0] + cAxis[1] * e.axis[1] + cAxis[2] * e.axis[2];
        const between = Math.acos(Math.max(-1, Math.min(1, d)));
        const eTheta = Math.acos(Math.max(-1, Math.min(1, e.cosThetaO)));
        if (between + eTheta > cTheta + 1e-4 && cTheta < Math.PI - 1e-4) coneViolations++;
      }
      worstPower = Math.max(worstPower, Math.abs(power - attr.power) / Math.max(power, 1e-9));
      sum += attr.power;
      const ref = view.childRef(node, s);
      if (!(ref & 0x80000000)) verifyNode(ref - 1);
    }
    return sum;
  };
  const rootSum = verifyNode(0);
  if (boundsViolations) problems.push(`${boundsViolations} emitter AABB(s) outside their packed cluster bounds`);
  if (coneViolations) problems.push(`${coneViolations} emitter cone(s) outside their packed cluster cone`);
  if (worstPower > 1e-5) problems.push(`node power sum off by ${worstPower.toExponential(2)} rel`);

  let emitterPowerSum = 0;
  for (let i = 0; i < n; i++) emitterPowerSum += view.emitter(i).power;
  const rootErr = Math.abs(rootSum - view.totalPower) / Math.max(view.totalPower, 1e-9);
  const totalErr = Math.abs(emitterPowerSum - view.totalPower) / Math.max(view.totalPower, 1e-9);
  if (rootErr > 1e-5) problems.push(`root children power ${rootSum} != header ${view.totalPower}`);
  if (totalErr > 1e-5) problems.push(`sum of emitter powers ${emitterPowerSum} != header ${view.totalPower}`);

  check(
    `structure N=${n}`,
    problems.length === 0,
    `nodes=${built.nodeCount} depth=${built.maxDepth} words=${built.words.length} ` +
      `Phi=${view.totalPower.toFixed(4)} powerErr=${worstPower.toExponential(1)}` +
      (problems.length ? ` :: ${problems.join("; ")}` : ""),
  );
}

// ════════════════════════════════ 2. COLOUR PARITY WITH THE SHARED RESOLVER
// §6.6, and the bug this module has already made once: if the tree's notion of
// an emitter's colour differs from the voxel path's, an object crossing
// between them steps hue. Both must come from resolveMaterialSurface.
{
  const meshes = [
    lampMesh([2, 2, 0], [1, 0.2, 0.05], 0.4, 3),      // saturated red, intensity 3
    lampMesh([-2, 2, 0], [0.05, 0.1, 1], 0.4, 1),     // saturated blue — peak 1
    lampMesh([0, 2, 2], [0.02, 0.03, 0.04], 0.4, 1),  // DIM: peak 0.04
  ];
  // A graph-authored emissive (colorNode/emissiveNode), which is where the
  // resolver earns its keep — material.emissive alone reads black here.
  const graphLamp = lampMesh([0, 2, -2], [0, 0, 0], 0.4, 1);
  graphLamp.material.emissiveNode = { value: new THREE.Color(0.3, 0.9, 0.2) };
  meshes.push(graphLamp);

  const made = build(meshes);
  const { view } = made;
  const problems = [];
  if (view.emitterCount !== meshes.length) {
    problems.push(`${view.emitterCount}/${meshes.length} admitted — the tree has NO promotion gate, every emitter belongs`);
  }
  for (let i = 0; i < view.emitterCount; i++) {
    const e = view.emitter(i);
    const mesh = meshes.find((m) => m.id === e.meshId);
    if (!mesh) { problems.push(`emitter ${i} has no source mesh`); continue; }
    const s = resolveMaterialSurface(mesh.material, mesh.name);
    const want = [s.emissive.r * s.emissiveIntensity, s.emissive.g * s.emissiveIntensity, s.emissive.b * s.emissiveIntensity];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(want[k] - e.rgb[k]) > 1e-6) {
        problems.push(`emitter ${i} channel ${k}: tree ${e.rgb[k]} vs resolver ${want[k]}`);
      }
    }
  }
  // The dim lamp (peak 0.04) is the one GISystem's `peak >= 0.5` promotion
  // gate rejects outright. Under the cap it lights the scene only through the
  // voxel field at ~17% of its energy; here it must simply be present.
  const dim = view.emitterCount >= 3 && [...Array(view.emitterCount).keys()].some((i) => view.emitter(i).rgb[2] < 0.1 && view.emitter(i).rgb[2] > 0.03);
  if (!dim) problems.push("the sub-promotion-threshold lamp is missing");
  check("colour parity with resolveMaterialSurface", problems.length === 0, problems.join("; ") || `${view.emitterCount} emitters, incl. graph-authored + sub-gate`);
}

// ═════════════════════════════════════════════════════ 3. THE PDF IS EXACT
const SHADING = [
  { P: [0, 0, 0], N: [0, 1, 0] },
  { P: [1.4, 0.6, -0.9], N: [0.3, 0.9, 0.31] },
  { P: [-2.2, 1.1, 1.7], N: [-0.6, 0.5, 0.62] },
];
for (const [pi, pt] of SHADING.entries()) {
  const N = [pt.N[0], pt.N[1], pt.N[2]];
  const l = Math.hypot(N[0], N[1], N[2]);
  N[0] /= l; N[1] /= l; N[2] /= l;
  for (const n of SWEEP) {
    const t = trees.get(n);
    if (!t) continue;
    const { view } = t;
    const problems = [];

    // (a) no splitting: the descent picks exactly one light, so the selection
    //     probabilities must be a probability distribution — sum to 1.
    let sum1 = 0;
    for (let i = 0; i < view.emitterCount; i++) sum1 += lightTreeSelectPdf(view, pt.P, N, i, { maxSplitDepth: 0 });
    if (Math.abs(sum1 - 1) > 1e-9) problems.push(`sum p = ${sum1} != 1 (no split)`);

    // (b) splitting: p is a MARGINAL INCLUSION probability, so the sum is the
    //     expected number of sampled lights — which must match what the
    //     sampler actually returns, and must stay in [1, 2] ("1-2 lights").
    let sum2 = 0;
    for (let i = 0; i < view.emitterCount; i++) sum2 += lightTreeSelectPdf(view, pt.P, N, i, {});
    if (!(sum2 >= 1 - 1e-9 && sum2 <= 2 + 1e-9)) problems.push(`expected sample count ${sum2} outside [1,2]`);
    reseed(0x9e37 + pi * 7919 + n);
    let drawn = 0;
    const TRIALS = 20000;
    for (let k = 0; k < TRIALS; k++) drawn += sampleLightTree(view, pt.P, N, rand, {}).length;
    if (Math.abs(drawn / TRIALS - sum2) > 1e-6) {
      problems.push(`sampler draws ${(drawn / TRIALS).toFixed(6)} lights vs pdf sum ${sum2.toFixed(6)}`);
    }

    // (c) SUPPORT. Every emitter with a non-zero contribution must have a
    //     non-zero probability of being sampled, or the estimator is biased
    //     no matter how the weights are normalised.
    let unsupported = 0;
    let contributing = 0;
    for (let i = 0; i < view.emitterCount; i++) {
      const f = emitterIrradiance(view, i, pt.P, N);
      if (f[0] + f[1] + f[2] <= 0) continue;
      contributing++;
      if (!(lightTreeSelectPdf(view, pt.P, N, i, {}) > 0)) unsupported++;
    }
    if (unsupported) problems.push(`${unsupported}/${contributing} contributing emitters have p = 0`);

    // (d) the sampler realises the pdf it reports: empirical inclusion
    //     frequency vs the independently recomputed probability.
    reseed(0x1c0ffee + pi * 31 + n);
    const M = 60000;
    const hits = new Float64Array(view.emitterCount);
    for (let k = 0; k < M; k++) for (const s of sampleLightTree(view, pt.P, N, rand, {})) hits[s.index]++;
    let worstZ = 0;
    for (let i = 0; i < view.emitterCount; i++) {
      const p = lightTreeSelectPdf(view, pt.P, N, i, {});
      const sigma = Math.sqrt(Math.max(p * (1 - p), 1e-12) / M);
      worstZ = Math.max(worstZ, Math.abs(hits[i] / M - p) / sigma);
    }
    if (worstZ > 5) problems.push(`empirical frequency ${worstZ.toFixed(2)} sigma off the reported pdf`);

    check(
      `pdf N=${n} @P${pi}`,
      problems.length === 0,
      `sum(nosplit)=${sum1.toFixed(9)} E[lights]=${sum2.toFixed(4)} contributing=${contributing} maxZ=${worstZ.toFixed(2)}` +
        (problems.length ? ` :: ${problems.join("; ")}` : ""),
    );
  }
}

// ═══════════════════════════════════════════════ 4. THE ESTIMATOR IS UNBIASED
//
// THE ARBITER. Monte-Carlo the tree, weight each sample by 1/pdf, and compare
// against the brute-force sum over every emitter. Classification mirrors the
// dynobj suite's structure-bug/epsilon-class split:
//   · outside 4 sigma AND worse than 1% relative  -> STRUCTURE BUG (a wrong
//     pdf, a lost light, a mis-read record). Hard fail.
//   · outside 4 sigma but within 1%              -> epsilon class (float
//     accumulation over 10^5 weighted samples). Reported, tolerated.
//   · inside 4 sigma                             -> converged.
function mcEstimate(view, P, N, opts, M, { pdfScale = null } = {}) {
  const mean = [0, 0, 0];
  const m2 = [0, 0, 0];
  // Per-emitter Welford too. Without it the ranking arm has no error bars and
  // "delivery moved by 22%" cannot be told apart from "that dim lamp was
  // sampled 300 times out of 200000" — which is not a bug, it is importance
  // sampling doing its job.
  // Untouched emitters contribute an exact zero to a trial, so plain
  // sum/sum-of-squares over the TOUCHED entries is already the full-M moment —
  // no need to walk every emitter every trial.
  const perSum = new Float64Array(view.emitterCount);
  const perSumSq = new Float64Array(view.emitterCount);
  const trial = new Float64Array(view.emitterCount);
  for (let k = 1; k <= M; k++) {
    const samples = sampleLightTree(view, P, N, rand, opts);
    const est = [0, 0, 0];
    for (const s of samples) {
      // `pdfScale` is the CANARY: corrupting the pdf must break convergence.
      const pdf = pdfScale ? s.pdf * pdfScale(s.index) : s.pdf;
      if (!(pdf > 0)) continue;
      const f = emitterIrradiance(view, s.index, P, N);
      est[0] += f[0] / pdf; est[1] += f[1] / pdf; est[2] += f[2] / pdf;
      trial[s.index] += f[0] / pdf;
    }
    for (let c = 0; c < 3; c++) {
      const d = est[c] - mean[c];
      mean[c] += d / k;
      m2[c] += d * (est[c] - mean[c]);
    }
    for (const s of samples) {
      const v = trial[s.index];
      if (v === 0) continue;
      perSum[s.index] += v;
      perSumSq[s.index] += v * v;
      trial[s.index] = 0;
    }
  }
  const stderr = m2.map((v) => Math.sqrt(v / Math.max(M - 1, 1) / M));
  const perEmitter = new Float64Array(view.emitterCount);
  const perStderr = new Float64Array(view.emitterCount);
  for (let i = 0; i < perEmitter.length; i++) {
    perEmitter[i] = perSum[i] / M;
    const variance = Math.max(perSumSq[i] / M - perEmitter[i] * perEmitter[i], 0);
    perStderr[i] = Math.sqrt(variance / M);
  }
  return { mean, stderr, perEmitter, perStderr };
}

const classify = (label, mean, stderr, ref, extra = "") => {
  const err = Math.abs(mean - ref);
  const rel = err / Math.max(Math.abs(ref), 1e-12);
  const band = Math.max(4 * stderr, 1e-9);
  if (err <= band) { check(label, true, `est=${mean.toExponential(6)} ref=${ref.toExponential(6)} rel=${(rel * 100).toFixed(3)}% (within 4σ=${band.toExponential(2)})${extra}`); return "ok"; }
  if (rel <= 0.01) { console.log(`PASS ${label} — epsilon class: rel=${(rel * 100).toFixed(3)}% > 4σ but < 1%${extra}`); return "epsilon"; }
  check(label, false, `STRUCTURE BUG: est=${mean.toExponential(6)} ref=${ref.toExponential(6)} rel=${(rel * 100).toFixed(3)}% vs 4σ=${band.toExponential(2)}${extra}`);
  return "bug";
};

for (const n of SWEEP) {
  const t = trees.get(n);
  if (!t) continue;
  const P = [0, 0, 0];
  const N = [0, 1, 0];
  const ref = lightTreeReference(t.view, P, N);
  for (const [name, opts] of [["choose-1", { maxSplitDepth: 0 }], ["split-2", {}]]) {
    reseed(0x5eed01 + n * 104729 + name.length);
    const M = 120000;
    const { mean, stderr } = mcEstimate(t.view, P, N, opts, M);
    classify(`unbiased N=${n} ${name}`, mean[0], stderr[0], ref[0], ` M=${M}`);
  }
}

// The canary. A pdf inflated by 25% on half the emitters must be DETECTED by
// exactly the criterion above — otherwise the convergence arms above are
// decoration and a real pdf bug would ship green.
{
  const t = trees.get(32);
  const P = [0, 0, 0];
  const N = [0, 1, 0];
  const ref = lightTreeReference(t.view, P, N);
  reseed(0xbadbad);
  const M = 120000;
  const { mean, stderr } = mcEstimate(t.view, P, N, {}, M, { pdfScale: (i) => (i % 2 === 0 ? 1.25 : 1) });
  const err = Math.abs(mean[0] - ref[0]);
  const caught = err > Math.max(4 * stderr[0], 1e-9) && err / ref[0] > 0.01;
  check(
    "canary: a corrupted pdf is caught",
    caught,
    `est=${mean[0].toExponential(6)} ref=${ref[0].toExponential(6)} rel=${((mean[0] - ref[0]) / ref[0] * 100).toFixed(2)}%`,
  );
}

// ══════════════════════════════════════════ 5. DELIVERY IS FLAT IN LIGHT COUNT
//
// §7's acceptance criterion, and the direct measurement of the ~6× promotion
// pop: N identical lamps on a ring, all at the same distance from the shading
// point, so every lamp's delivered contribution is the same number and
// total/N IS the per-lamp delivery. Under MAX_EMITTERS = 4 this reads
// full-energy up to 4 lamps and collapses toward the ~17% transport-only value
// beyond; with one representation it must not move at all.
{
  const P = [0, 0, 0];
  const N = [0, 1, 0];
  const rows = [];
  let baseline = null;
  let worst = 0;
  for (const n of SWEEP) {
    const made = build(ringScene(n));
    const { view } = made;
    if (view.emitterCount !== n) { check(`flat-in-N: N=${n} admitted`, false, `${view.emitterCount} of ${n}`); continue; }
    const refPerLamp = lightTreeReference(view, P, N)[0] / n;
    reseed(0xf1a7 + n * 7919);
    const M = 150000;
    const { mean, stderr } = mcEstimate(view, P, N, {}, M);
    const perLamp = mean[0] / n;
    const perLampErr = stderr[0] / n;
    // Analytic per-lamp value first — a tree that quietly drops lamps fails
    // here before any MC noise argument can be made.
    const analyticOff = Math.abs(refPerLamp - (baseline?.refPerLamp ?? refPerLamp)) / Math.max(refPerLamp, 1e-12);
    if (baseline === null) baseline = { refPerLamp, perLamp };
    const drift = Math.abs(perLamp - baseline.perLamp) / Math.max(baseline.perLamp, 1e-12);
    worst = Math.max(worst, drift);
    rows.push(`N=${n}:${perLamp.toExponential(4)}±${perLampErr.toExponential(1)}`);
    check(
      `flat-in-N N=${n}`,
      analyticOff < 1e-6 && Math.abs(perLamp - refPerLamp) <= Math.max(4 * perLampErr, 1e-12) + 0.004 * refPerLamp,
      `perLamp=${perLamp.toExponential(6)} analytic=${refPerLamp.toExponential(6)} drift-vs-N1=${(drift * 100).toFixed(3)}%`,
    );
  }
  check("flat-in-N: per-lamp delivery independent of N", worst < 0.02, `max drift ${(worst * 100).toFixed(3)}% across N=${SWEEP.join(",")}\n     ${rows.join("  ")}`);
}

// ═══════════════════════════════════════════════════ 6. RANKING IS GONE
//
// Promotion RANKS BY POWER and keeps the top 4, so permuting the strengths of
// a fixed set of lamps reshuffles which ones are exact and which are
// transport-only — the churn §7 names. Here: same positions, permuted powers.
// Every lamp's delivery per unit emitted radiance must be IDENTICAL between
// the two builds, because nothing in the structure depends on the ordering.
{
  const P = [0, 0, 0];
  const N = [0, 1, 0];
  const positions = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    positions.push([Math.cos(a) * (3 + (i % 3)), 2 + (i % 4) * 0.4, Math.sin(a) * (3 + (i % 3))]);
  }
  // 12 distinct strengths spanning both sides of promotion's `peak >= 0.5`
  // gate — under the cap, permuting these changes WHICH four are exact.
  const strengths = [0.08, 0.2, 0.35, 0.5, 0.7, 0.9, 1.2, 1.6, 2.1, 2.9, 4.0, 6.0];
  const permutation = [7, 0, 11, 3, 5, 9, 1, 6, 2, 10, 4, 8];

  const runOne = (order, seedBase) => {
    const meshes = positions.map((p, i) => lampMesh(p, [1, 1, 1], 0.4, strengths[order[i]]));
    const made = build(meshes);
    const { view } = made;
    // Map emitter index -> the POSITION it sits at (order is a build detail).
    const posOf = new Array(view.emitterCount).fill(-1);
    for (let i = 0; i < view.emitterCount; i++) {
      const e = view.emitter(i);
      posOf[i] = meshes.findIndex((m) => m.id === e.meshId);
    }
    reseed(seedBase);
    const M = 250000;
    const { mean, stderr, perEmitter, perStderr } = mcEstimate(view, P, N, {}, M);
    // Delivery PER UNIT EMITTED RADIANCE — the "relative delivery" §7 names.
    // It is pure geometry once ranking is gone, so it must be invariant under
    // any permutation of the strengths across a fixed set of positions.
    const byPosition = new Array(positions.length).fill(0);
    const sigmaByPosition = new Array(positions.length).fill(0);
    const refByPosition = new Array(positions.length).fill(0);
    for (let i = 0; i < view.emitterCount; i++) {
      const scale = view.emitter(i).rgb[0];
      byPosition[posOf[i]] = perEmitter[i] / scale;
      sigmaByPosition[posOf[i]] = perStderr[i] / scale;
      refByPosition[posOf[i]] = emitterIrradiance(view, i, P, N)[0] / scale;
    }
    return { view, mean, stderr, byPosition, sigmaByPosition, refByPosition, ref: lightTreeReference(view, P, N) };
  };

  const identity = [...Array(12).keys()];
  const A = runOne(identity, 0x515a11);
  const B = runOne(permutation, 0x515a22);

  const problems = [];
  if (A.view.emitterCount !== 12 || B.view.emitterCount !== 12) {
    problems.push(`admitted ${A.view.emitterCount}/${B.view.emitterCount} of 12 — a cap survived`);
  }
  // The ANALYTIC per-unit-radiance delivery must be bit-for-bit invariant:
  // it is pure geometry once the ranking is gone.
  let worstAnalytic = 0;
  for (let i = 0; i < positions.length; i++) {
    worstAnalytic = Math.max(worstAnalytic, Math.abs(A.refByPosition[i] - B.refByPosition[i]) / Math.max(A.refByPosition[i], 1e-12));
  }
  if (worstAnalytic > 1e-9) problems.push(`analytic relative delivery moved by ${(worstAnalytic * 100).toFixed(4)}% under the permutation`);

  // And the SAMPLED delivery must agree within its own noise — this is what
  // would move if the sampler had any power-order-dependent truncation.
  // Against the ARM'S OWN error bars, not a flat percentage: a lamp at 0.08
  // strength next to one at 6.0 is deliberately sampled rarely, so its
  // estimate is noisy by design and a fixed 6% gate would call importance
  // sampling a bug.
  let worstZ = 0;
  let worstIndex = -1;
  for (let i = 0; i < positions.length; i++) {
    const sigma = Math.sqrt(A.sigmaByPosition[i] ** 2 + B.sigmaByPosition[i] ** 2);
    const z = Math.abs(A.byPosition[i] - B.byPosition[i]) / Math.max(sigma, 1e-18);
    if (z > worstZ) { worstZ = z; worstIndex = i; }
  }
  if (worstZ > 5) problems.push(`sampled relative delivery at position ${worstIndex} moved ${worstZ.toFixed(1)}σ under the permutation`);

  check("ranking: permuting power leaves relative delivery unchanged", problems.length === 0,
    `analyticΔ=${worstAnalytic.toExponential(2)} sampled maxZ=${worstZ.toFixed(2)}` + (problems.length ? ` :: ${problems.join("; ")}` : ""));

  classify("ranking: arm A converges", A.mean[0], A.stderr[0], A.ref[0]);
  classify("ranking: arm B converges", B.mean[0], B.stderr[0], B.ref[0]);
}

// ═════════════════════════════ 7. THE PUBLIC ESTIMATOR + THE SIZING ESTIMATE
{
  const t = trees.get(32);
  const P = [0, 0, 0];
  const N = [0, 1, 0];
  const ref = lightTreeReference(t.view, P, N)[0];
  reseed(0xe57);
  const M = 80000;
  let mean = 0;
  let m2 = 0;
  for (let k = 1; k <= M; k++) {
    const v = estimateLightTree(t.view, P, N, rand)[0];
    const d = v - mean;
    mean += d / k;
    m2 += d * (v - mean);
  }
  classify("estimateLightTree (public entry point) converges", mean, Math.sqrt(m2 / (M - 1) / M), ref, ` M=${M}`);

  // The tail reservation must never under-size the block it will hold — an
  // under-reserved region is a silent overwrite of whatever the occupancy
  // buffer put after it, which is how a GI tail bug looks like a shadow bug.
  let sizingOk = true;
  const rows = [];
  for (const n of SWEEP) {
    const tree = trees.get(n);
    if (!tree) continue;
    const budget = estimateLightTreeWords(n);
    rows.push(`${n}:${tree.built.words.length}/${budget}`);
    if (tree.built.words.length > budget) sizingOk = false;
  }
  check("estimateLightTreeWords bounds the real block", sizingOk, `used/budget ${rows.join(" ")}`);
}

// ═══════════════════════════════════════════════════════════ 8. HEADER SANITY
{
  const t = trees.get(32);
  const w = t.built.words;
  const ok =
    w[0] === 32 && w[6] === LIGHT_TREE_ARITY && w[14] === LT_VERSION &&
    w[1] === LT_HEADER_WORDS && w[15] === w.length &&
    w[2] > w[1] && w[3] > w[2] && w[4] > w[3];
  check("header words round-trip", ok, `count=${w[0]} nodeBase=${w[1]} triBase=${w[2]} attrBase=${w[3]} emitterBase=${w[4]} arity=${w[6]} version=${w[14]} total=${w[15]}`);
}

if (failures) {
  console.error(`gi-light-tree: ${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("gi-light-tree: all cases PASS");
