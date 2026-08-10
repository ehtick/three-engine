// SPLIT RADIANCE CASCADES — PHASE 0: the CPU reference suite.
//
// No GPU, no adapter, no headless WebGPU shim. Everything here is plain JS over
// src/modules/gi/srcMath.js + srcConfig.js + srcRef.js, which is the point: the
// GPU kernels are diffed against this mirror later, so this suite has to be
// trustworthy while the GPU path is the thing under suspicion.
//
// docs/GI_SRC_REBUILD_PLAN.md §7 Phase 0. The gate for starting Phase 1.
//
// WHAT EACH ARM IS FOR — every one of them is a bug this module has already
// shipped once, in the dense backend, in a different costume:
//
//   equal-area     bins must subtend EQUAL solid angle, or a bin average is
//                  silently area-weighted. That exact error cost 1.95x
//                  position-dependent brightness through the octahedral map
//                  (see octahedralTexelWeight's header) and was invisible for
//                  months because it converged to a WRONG constant, not to
//                  noise.
//   parent-map     the 4->1 mapping must be exact integer halving, and the
//                  four children of a parent must be CONTIGUOUS in Morton
//                  order. Contiguity is a performance claim; exactness is a
//                  correctness one.
//   r2             low-discrepancy coverage, and the property Alg. 3 depends
//                  on: a CONTIGUOUS SEGMENT of R2 is itself well-distributed.
//   key            the 32-bit key must be a bijection over its window and must
//                  NEVER pack to zero (zero is the hashmap's EMPTY sentinel —
//                  a probe that packs to 0 silently does not exist).
//   hashmap        insert/find under a collision storm; first-writer-wins.
//   raybudget      Alg. 3: counts propagate up exactly, offsets partition the
//                  sequence with no gap, no overlap, no index used twice.
//   split          interval containment, nearer-cascades-transparent, and
//                  NOTHING deposited above the owning cascade (the guide has
//                  this wrong; the authors rejected upward extension for bias).
//   sparse         missing interpolation corners renormalize, never vote black.
//   furnace        uniform emissive enclosure, albedo 1 -> exactly 1.0. Exact,
//                  not approximate: that is what the pi*sum(L cos)/sum(cos)
//                  normalization buys, and it is why the multibounce loop's
//                  gain is provably < 1 (R4).
//   boundary       sweep an emissive shell across every interval boundary. A
//                  GAP drops light; an OVERLAP double-counts it. Both read as
//                  a ring at a fixed world radius, which is the single most
//                  recognizable RC artifact there is.
//   transport      merged irradiance vs brute-force Monte Carlo over the SAME
//                  scene trace, with the MC estimator's own standard error as
//                  the arbiter. Includes a CANARY with a deliberately broken
//                  merge, because a convergence test that cannot fail proves
//                  nothing.
//
// Run: node scripts/run-gi-src-ref-test.mjs
import {
  CASCADE_COUNT,
  W0,
  binCount,
  binGridWidth,
  cascadeReach,
  intervalBoundaries,
  intervalLength,
  lodAtDistance,
  lodBlend,
  lodRadius,
  lodShellWeight,
  lodShells,
  probeSpacing,
  describeSrcHierarchy,
  GAMMA,
  BETA,
  LOD0_REACH,
  MAX_LOOP_ALBEDO,
} from "../src/modules/gi/srcConfig.js";
// THE REAL CLOSED FORM, not a local re-derivation. `refSphereAt` is what the
// engine's NEE evaluates per emitter kind (plan §4.4), so the Phase-5 arms use
// it directly — a private copy of pi*sin^2(alpha)*cos(theta) would have passed
// this suite while the engine shipped the horizon-faded version. It costs one
// `three/webgpu` import in bare node (~100ms) and buys the absence of a twin.
import { refSphereAt } from "../src/modules/gi/emitterShapes.js";
import {
  KEY_AXIS_OFFSET,
  KEY_AXIS_RANGE,
  KEY_EMPTY,
  binCenterXY,
  binChildren,
  binDir,
  binMorton,
  binParent,
  decodeDir,
  dirToBin,
  encodeDir,
  mortonToBin,
  octahedralDirection,
  octahedralTexelWeight,
  octahedralUV,
  packProbeKey,
  preAverage,
  R2_ALPHA1,
  R2_ALPHA2,
  r2Point,
  rayDirection,
  resolveBin,
  splitCascade,
  splitDeposits,
  sparseGather,
  trilinearCorners,
  unpackProbeKey,
} from "../src/modules/gi/srcMath.js";
import {
  SrcProbeMap,
  ancestorChain,
  assignRays,
  bakeProbeIrradiance,
  brutePointIrradiance,
  buildProbes,
  clampLoopAlbedo,
  emitterIrradianceExact,
  emitterIrradianceNee,
  faceForward,
  fillOctahedralBorder,
  gatherPixel,
  hashUnitFloat,
  makeHitShader,
  makeSecondaryCache,
  makeSrcConfig,
  makeVisibility,
  mergeCascades,
  resolveProbes,
  runSrcFrame,
  sampleTile,
  shadeTrace,
  sunIrradiance,
  traceAndDeposit,
} from "../src/modules/gi/srcRef.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── deterministic PRNG (mulberry32 — never Math.random in a harness) ────────
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

/** Uniform point on the sphere — the measure the equal-area arms test against. */
function randomDir(rng) {
  const z = rng() * 2 - 1;
  const phi = rng() * 2 * Math.PI;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(phi), r * Math.sin(phi), z];
}

console.log("── HIERARCHY ────────────────────────────────────────────────────");
{
  const h = describeSrcHierarchy(0.5);
  console.log(
    `   beta=${h.beta} gamma=${h.gamma} N=${h.cascadeCount} w0=${h.w0} ` +
    `s0=${h.spacing0} r0=${h.r0.toFixed(3)} reach=${h.reachLod0.toFixed(2)}m`,
  );
  for (const c of h.cascades) {
    console.log(
      `   c${c.cascade}: bins=${c.bins} grid=${c.binGrid[0]}x${c.binGrid[1]} ` +
      `spacing=${c.spacingLod0.toFixed(3)}m interval=${c.intervalLod0.toFixed(3)}m`,
    );
  }
  check("|D0| = 32 (paper reference config)", binCount(0, W0) === 32, `got ${binCount(0, W0)}`);
  check("bins scale by beta per cascade",
    [0, 1, 2].every((i) => binCount(i + 1, W0) === BETA * binCount(i, W0)),
    `${[0, 1, 2, 3].map((i) => binCount(i, W0)).join(" -> ")}`);
  check("intervals scale by gamma per cascade",
    [0, 1, 2].every((i) =>
      Math.abs(intervalLength(i + 1, 0, 0.5) - GAMMA * intervalLength(i, 0, 0.5)) < 1e-12),
    `${[0, 1, 2, 3].map((i) => intervalLength(i, 0, 0.5).toFixed(2)).join(" -> ")}`);
  check("probe spacing doubles per cascade AND per LOD",
    Math.abs(probeSpacing(1, 0, 0.5) - 2 * probeSpacing(0, 0, 0.5)) < 1e-12 &&
    Math.abs(probeSpacing(0, 1, 0.5) - 2 * probeSpacing(0, 0, 0.5)) < 1e-12);
}

console.log("── EQUAL-AREA CYLINDRICAL BINS ──────────────────────────────────");
{
  // 1. Round-trip: a bin's centre direction must land back in that bin.
  let roundTripOk = true;
  let worstBin = "";
  for (const w of [4, 8, 16, 32]) {
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < 2 * w; i++) {
        const d = binDir(i, j, w);
        const back = dirToBin(d[0], d[1], d[2], w);
        if (back.i !== i || back.j !== j) {
          roundTripOk = false;
          worstBin = `w=${w} (${i},${j}) -> (${back.i},${back.j})`;
        }
      }
    }
  }
  check("bin centre round-trips to its own bin", roundTripOk, worstBin || "all widths 4..32");

  // 2. decode/encode are inverses on the open square.
  const rng = makeRng(0xc0ffee);
  let worstXY = 0;
  for (let n = 0; n < 20000; n++) {
    const x = rng();
    const y = rng();
    const d = decodeDir(x, y);
    const back = encodeDir(d[0], d[1], d[2]);
    // Azimuth wraps, so compare on the circle.
    let dx = Math.abs(back.x - x);
    dx = Math.min(dx, 1 - dx);
    worstXY = Math.max(worstXY, dx, Math.abs(back.y - y));
  }
  check("decodeDir/encodeDir are inverses", worstXY < 1e-9, `worst err ${worstXY.toExponential(2)}`);

  // 3. Directions are UNIT.
  let worstLen = 0;
  for (let n = 0; n < 20000; n++) {
    const d = decodeDir(rng(), rng());
    worstLen = Math.max(worstLen, Math.abs(Math.hypot(d[0], d[1], d[2]) - 1));
  }
  check("decoded directions are unit length", worstLen < 1e-12, `worst |len-1| ${worstLen.toExponential(2)}`);

  // 4. EQUAL AREA — the property the whole payload design rests on. Histogram
  //    uniformly-sampled sphere directions into bins; every bin must receive
  //    1/|D| of them within binomial noise. This is what makes a bin average
  //    a solid-angle-weighted average with NO Jacobian correction, and it is
  //    exactly the property the octahedral map lacks (2.73x variation).
  for (const w of [4, 8]) {
    const n = binCount(0, w) * 4000;
    const hist = new Uint32Array(binCount(0, w));
    for (let s = 0; s < n; s++) {
      const d = randomDir(rng);
      const b = dirToBin(d[0], d[1], d[2], w);
      hist[b.j * (2 * w) + b.i]++;
    }
    const expected = n / hist.length;
    // 6 sigma of a binomial with p = 1/|D| — generous enough that noise never
    // fails it, tight enough that a real area bias (which is a large multiple,
    // not a few percent) always does.
    const sigma = Math.sqrt(expected * (1 - 1 / hist.length));
    let worst = 0;
    for (const v of hist) worst = Math.max(worst, Math.abs(v - expected) / sigma);
    check(`bins subtend equal solid angle (w=${w}, |D|=${hist.length})`, worst < 6,
      `worst deviation ${worst.toFixed(2)} sigma`);
  }
}

console.log("── 4->1 PARENT MAPPING + MORTON CONTIGUITY ──────────────────────");
{
  // Consistency: binning at width 2w then halving == binning at width w.
  const rng = makeRng(0xbeef);
  let consistent = true;
  let detail = "";
  for (const w of [4, 8, 16]) {
    for (let n = 0; n < 20000; n++) {
      const d = randomDir(rng);
      const fine = dirToBin(d[0], d[1], d[2], 2 * w);
      const par = binParent(fine.i, fine.j);
      const coarse = dirToBin(d[0], d[1], d[2], w);
      if (par.i !== coarse.i || par.j !== coarse.j) {
        consistent = false;
        detail = `w=${w} fine(${fine.i},${fine.j})->parent(${par.i},${par.j}) != coarse(${coarse.i},${coarse.j})`;
        break;
      }
    }
  }
  check("parent of a fine bin == the coarse bin of the same direction", consistent,
    detail || "widths 4,8,16 x 20k dirs");

  // Every parent has exactly 4 children and they map back.
  let childrenOk = true;
  for (let j = 0; j < 8; j++) {
    for (let i = 0; i < 16; i++) {
      for (const c of binChildren(i, j)) {
        const p = binParent(c.i, c.j);
        if (p.i !== i || p.j !== j) childrenOk = false;
      }
    }
  }
  check("binChildren/binParent are inverse", childrenOk);

  // MORTON CONTIGUITY: morton(2i+dx, 2j+dy) == 4*morton(i,j) + dx + 2*dy.
  // This is the claim that lets the merge read four child bins as one aligned
  // fetch. It must hold on the 2w x w NON-SQUARE grid too, where i carries one
  // more bit than j.
  let mortonOk = true;
  let mortonDetail = "";
  for (let j = 0; j < 16 && mortonOk; j++) {
    for (let i = 0; i < 32 && mortonOk; i++) {
      const base = binMorton(i, j) * 4;
      const kids = binChildren(i, j);
      for (let k = 0; k < 4; k++) {
        if (binMorton(kids[k].i, kids[k].j) !== base + k) {
          mortonOk = false;
          mortonDetail = `parent(${i},${j}) child ${k} morton=${binMorton(kids[k].i, kids[k].j)} want ${base + k}`;
        }
      }
    }
  }
  check("a parent's 4 children are contiguous in Morton order", mortonOk,
    mortonDetail || "morton(2i+dx,2j+dy) = 4*morton(i,j)+dx+2dy");

  // Morton round-trip, and no two bins share a Morton index within a cascade.
  let bijectionOk = true;
  for (const w of [4, 8, 16]) {
    const seen = new Set();
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < 2 * w; i++) {
        const m = binMorton(i, j);
        if (seen.has(m)) bijectionOk = false;
        seen.add(m);
        const back = mortonToBin(m);
        if (back.i !== i || back.j !== j) bijectionOk = false;
      }
    }
  }
  check("binMorton is injective and round-trips", bijectionOk);
}

console.log("── R2 SEQUENCE ──────────────────────────────────────────────────");
{
  // Coverage: R2 points must fill [0,1)^2 far more evenly than random. Compare
  // worst-cell occupancy on a grid against the same count of PRNG points.
  const N = 4096;
  const G = 16;
  const gridR2 = new Uint32Array(G * G);
  for (let n = 0; n < N; n++) {
    const p = r2Point(n);
    gridR2[Math.min(G - 1, Math.floor(p.y * G)) * G + Math.min(G - 1, Math.floor(p.x * G))]++;
  }
  const rng = makeRng(0x51ee);
  const gridRnd = new Uint32Array(G * G);
  for (let n = 0; n < N; n++) {
    gridRnd[Math.min(G - 1, Math.floor(rng() * G)) * G + Math.min(G - 1, Math.floor(rng() * G))]++;
  }
  const spread = (g) => {
    let lo = Infinity;
    let hi = 0;
    for (const v of g) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return { lo, hi };
  };
  const sr = spread(gridR2);
  const sn = spread(gridRnd);
  check("R2 fills the square more evenly than random",
    sr.hi - sr.lo < sn.hi - sn.lo,
    `R2 range ${sr.lo}..${sr.hi} vs random ${sn.lo}..${sn.hi} (expected ${N / (G * G)})`);
  check("R2 leaves no empty cell at 16x", sr.lo > 0, `min occupancy ${sr.lo}`);

  // THE PROPERTY ALG. 3 DEPENDS ON: a CONTIGUOUS SEGMENT of R2 is itself
  // well-distributed. If this failed, handing a probe a contiguous slice would
  // be no better than handing it a random one, and the whole ray-budgeting
  // hierarchy would buy nothing.
  // The bar is a RANDOM CONTROL, not an absolute number. An absolute threshold
  // here is a guess dressed as a gate (a 256-point set on 64 cells has mean 4,
  // so a range of 4 is 2..6 — excellent, and my first threshold of 3 failed it
  // for no reason). What the property actually claims is "better than random",
  // and that is what gets measured.
  let worstSegment = 0;
  const rngSeg = makeRng(0x2222);
  let worstRandom = 0;
  for (const start of [0, 137, 4096, 65536]) {
    const seg = 256;
    const g = new Uint32Array(8 * 8);
    const gr = new Uint32Array(8 * 8);
    for (let n = start; n < start + seg; n++) {
      const p = r2Point(n);
      g[Math.min(7, Math.floor(p.y * 8)) * 8 + Math.min(7, Math.floor(p.x * 8))]++;
      gr[Math.min(7, Math.floor(rngSeg() * 8)) * 8 + Math.min(7, Math.floor(rngSeg() * 8))]++;
    }
    const s = spread(g);
    const sr = spread(gr);
    worstSegment = Math.max(worstSegment, s.hi - s.lo);
    worstRandom = Math.max(worstRandom, sr.hi - sr.lo);
  }
  check("a contiguous R2 segment is better distributed than random",
    worstSegment < worstRandom,
    `R2 worst cell range ${worstSegment} vs random ${worstRandom} (mean occupancy 4)`);
  check("no contiguous R2 segment leaves a cell empty at 8x8", worstSegment <= 6,
    `worst range ${worstSegment}`);

  // ── THE HIGH-INDEX ARM: the sequence must survive f32, because the GPU has
  //    nothing else. The float form `fract(0.5 + alpha*n)` loses the fractional
  //    part to the integer part as alpha*n grows — at plan §9's ~2M rays/frame
  //    an f32 evaluation can express EIGHT distinct values, so the last
  //    cascade's 2048 bins would be fed by eight azimuths. The f64 mirror never
  //    sees it, which is precisely why it is gated here rather than left to the
  //    GPU twin test to discover: this arm fails against the float form on the
  //    CPU, in bare node, with no adapter in the loop.
  //
  //    The control is the SAME measurement at n = 0, so the arm cannot pass by
  //    being loose — it asserts that starting two million indices in changes
  //    nothing, which for an exact fixed-point recurrence is true by
  //    construction and for a float one is catastrophically false.
  {
    const f32 = new Float32Array(1);
    const asF32 = (v) => { f32[0] = v; return f32[0]; };
    const floatFormF32 = (n) => {
      const x = asF32(asF32(0.5) + asF32(asF32(R2_ALPHA1) * n));
      const y = asF32(asF32(0.5) + asF32(asF32(R2_ALPHA2) * n));
      return { x: x - Math.floor(x), y: y - Math.floor(y) };
    };
    const coverage = (gen, base) => {
      const g = new Uint32Array(G * G);
      for (let n = 0; n < N; n++) {
        const p = gen(base + n);
        g[Math.min(G - 1, Math.floor(p.y * G)) * G + Math.min(G - 1, Math.floor(p.x * G))]++;
      }
      return spread(g);
    };
    const HIGH = 2_000_000;
    const near = coverage((n) => r2Point(n), 0);
    const far = coverage((n) => r2Point(n), HIGH);
    const farFloat = coverage(floatFormF32, HIGH);
    check("R2 coverage at n=2e6 is identical to n=0 (fixed point does not decay)",
      far.lo === near.lo && far.hi === near.hi,
      `n=0 ${near.lo}..${near.hi} vs n=${HIGH} ${far.lo}..${far.hi}`);
    check("R2 leaves no empty cell at n=2e6", far.lo > 0, `min occupancy ${far.lo}`);
    // The CANARY. A gate that cannot fail proves nothing: this is the form the
    // GPU would run if anyone re-derived the sequence in floats, measured with
    // the shader's own precision.
    check("CANARY: the f32 FLOAT form does collapse at n=2e6 (this is why fixed point)",
      farFloat.lo === 0 && (farFloat.hi - farFloat.lo) > 4 * (far.hi - far.lo),
      `float-f32 ${farFloat.lo}..${farFloat.hi} vs fixed ${far.lo}..${far.hi} (expected ${N / (G * G)})`);
  }

  // Hemisphere fold: every direction must be in the normal's hemisphere and unit.
  let foldOk = true;
  let worstDot = 1;
  for (let n = 0; n < 5000; n++) {
    const nrm = randomDir(makeRng(n + 1));
    const d = rayDirection(n, nrm[0], nrm[1], nrm[2]);
    const dot = d[0] * nrm[0] + d[1] * nrm[1] + d[2] * nrm[2];
    if (!(dot >= 0)) foldOk = false;
    if (Math.abs(Math.hypot(d[0], d[1], d[2]) - 1) > 1e-9) foldOk = false;
    worstDot = Math.min(worstDot, dot);
  }
  check("hemisphere fold keeps every ray on the front side", foldOk,
    `min dot ${worstDot.toExponential(2)}`);
}

console.log("── 32-BIT PROBE KEY ─────────────────────────────────────────────");
{
  // BIJECTION over the whole window, at every LOD, both caches. Sampled rather
  // than exhaustive (15 x 2 x 512^3 is 4e9), but the sampling covers every
  // corner and edge of the window explicitly — the places an off-by-one lives.
  const rng = makeRng(0xd00d);
  const edge = [-KEY_AXIS_OFFSET, -KEY_AXIS_OFFSET + 1, -1, 0, 1,
    KEY_AXIS_RANGE - KEY_AXIS_OFFSET - 2, KEY_AXIS_RANGE - KEY_AXIS_OFFSET - 1];
  let bijectionOk = true;
  let neverZero = true;
  let detail = "";
  const trial = (lod, secondary, cx, cy, cz) => {
    const key = packProbeKey(lod, secondary, cx, cy, cz);
    if (key === KEY_EMPTY) {
      bijectionOk = false;
      detail = `lod=${lod} sec=${secondary} cell=(${cx},${cy},${cz}) packed to EMPTY`;
      return;
    }
    neverZero = neverZero && key !== 0;
    const u = unpackProbeKey(key);
    if (!u || u.lod !== lod || u.secondary !== secondary ||
        u.cx !== cx || u.cy !== cy || u.cz !== cz) {
      bijectionOk = false;
      detail = `lod=${lod} sec=${secondary} cell=(${cx},${cy},${cz}) -> ${JSON.stringify(u)}`;
    }
  };
  for (let lod = 0; lod < 15; lod++) {
    for (const secondary of [false, true]) {
      for (const cx of edge) for (const cy of edge) for (const cz of edge) {
        trial(lod, secondary, cx, cy, cz);
      }
      for (let n = 0; n < 400; n++) {
        const pick = () => Math.floor(rng() * KEY_AXIS_RANGE) - KEY_AXIS_OFFSET;
        trial(lod, secondary, pick(), pick(), pick());
      }
    }
  }
  check("probe key is a bijection over its LOD window", bijectionOk, detail || "15 LODs x 2 caches");
  // THE ONE THAT MATTERS MOST: nothing valid may pack to zero, because zero is
  // EMPTY. Without the LOD+1 bias, cell (-256,-256,-256) at LOD 0 primary packs
  // to exactly 0 — a probe at the camera's own cell that silently never exists.
  check("no valid key packs to zero (EMPTY sentinel is unreachable)", neverZero);
  const nastiest = packProbeKey(0, false, -KEY_AXIS_OFFSET, -KEY_AXIS_OFFSET, -KEY_AXIS_OFFSET);
  check("the unbiased-layout zero collision is gone", nastiest !== 0,
    `lod0/primary/(-256,-256,-256) -> 0x${nastiest.toString(16)}`);

  // Out-of-window must REFUSE (return EMPTY), never silently wrap into a
  // different probe's identity.
  const outside = [
    packProbeKey(0, false, -KEY_AXIS_OFFSET - 1, 0, 0),
    packProbeKey(0, false, 0, KEY_AXIS_RANGE - KEY_AXIS_OFFSET, 0),
    packProbeKey(15, false, 0, 0, 0),
    packProbeKey(-1, false, 0, 0, 0),
  ];
  check("out-of-window cells refuse rather than wrap",
    outside.every((k) => k === KEY_EMPTY), `got ${outside.map((k) => k.toString()).join(",")}`);

  // The window must actually be big enough for the LOD it serves: an LOD shell
  // reaches ~2^lod * s0 * some constant, and a 512-cell axis must cover it.
  const s0 = 0.5;
  let windowOk = true;
  const rows = [];
  for (let lod = 0; lod < 10; lod++) {
    const spacing = probeSpacing(0, lod, s0);
    const windowSpan = KEY_AXIS_RANGE * spacing;
    // The shell this LOD owns ends where the next LOD begins: 2^(lod+1) * s0.
    const shellOuter = Math.pow(2, lod + 1) * s0;
    if (windowSpan < 2 * shellOuter) windowOk = false;
    rows.push(`L${lod}:${windowSpan.toFixed(0)}m/${(2 * shellOuter).toFixed(0)}m`);
  }
  check("9-bit window covers every LOD shell it serves", windowOk, rows.join(" "));
}

console.log("── HASHMAP ──────────────────────────────────────────────────────");
{
  const map = new SrcProbeMap(4096);
  const keys = [];
  const rng = makeRng(0xfeed);
  for (let n = 0; n < 3000; n++) {
    const lod = Math.floor(rng() * 10);
    const pick = () => Math.floor(rng() * 64) - 32;
    const key = packProbeKey(lod, false, pick(), pick(), pick());
    if (key !== KEY_EMPTY) keys.push(key);
  }
  const unique = [...new Set(keys)];
  const slots = new Map();
  for (const key of keys) {
    const slot = map.insert(key, (k, i) => ({ key: k, index: i }));
    if (!slots.has(key)) slots.set(key, slot);
    else if (slots.get(key) !== slot) {
      check("insert is idempotent per key", false, `key 0x${key.toString(16)} moved slot`);
    }
  }
  check("insert creates exactly one probe per unique key",
    map.probes.length === unique.length, `${map.probes.length} probes / ${unique.length} unique keys`);
  check("find agrees with insert for every key",
    unique.every((k) => map.find(k) === slots.get(k)));
  check("find on an absent key returns -1", map.find(packProbeKey(14, true, 300, 300, 300)) === -1);
  check("EMPTY is never a valid lookup", map.find(KEY_EMPTY) === -1);
  const avgSteps = map.probeSteps / Math.max(1, keys.length);
  check("linear probing stays short (hash avalanches)", avgSteps < 3,
    `${avgSteps.toFixed(2)} steps/op, load factor ${map.loadFactor.toFixed(3)}`);

  // COLLISION STORM: a map filled near capacity must still be correct, and must
  // report -1 rather than corrupt when full.
  const tiny = new SrcProbeMap(8);
  let inserted = 0;
  let refused = 0;
  for (let n = 1; n <= 64; n++) {
    const key = packProbeKey(0, false, n, 0, 0);
    const slot = tiny.insert(key, (k, i) => ({ key: k, index: i }));
    if (slot >= 0) inserted++; else refused++;
  }
  check("a full map refuses rather than corrupts",
    inserted === tiny.probes.length && inserted + refused === 64 && inserted <= tiny.capacity,
    `${inserted} inserted, ${refused} refused, capacity ${tiny.capacity}`);
}

console.log("── SPLIT ASSIGNMENT ─────────────────────────────────────────────");
{
  const s0 = 0.5;
  const bounds = intervalBoundaries(0, s0);
  console.log(`   boundaries: ${bounds.map((b) => b.toFixed(3)).join(", ")}`);

  // CONTIGUITY: r_i = r0*(gamma^(i+1)-1)/(gamma-1). A gap is a distance band no
  // cascade owns (light silently dropped); an overlap double-counts it.
  const r0 = s0 * 1.6;
  let contiguousOk = true;
  for (let i = 0; i < bounds.length; i++) {
    const want = r0 * (Math.pow(GAMMA, i + 1) - 1) / (GAMMA - 1);
    if (Math.abs(bounds[i] - want) > 1e-9) contiguousOk = false;
  }
  check("interval boundaries are contiguous partial sums", contiguousOk);

  // Every distance in (0, reach] belongs to exactly ONE cascade.
  let coverOk = true;
  let coverDetail = "";
  const reach = cascadeReach(0, s0);
  for (let n = 1; n <= 20000; n++) {
    const d = (n / 20000) * reach;
    const k = splitCascade(d, bounds);
    if (k >= bounds.length) { coverOk = false; coverDetail = `d=${d} unowned`; break; }
    const lo = k === 0 ? 0 : bounds[k - 1];
    if (!(d > lo - 1e-12 && d <= bounds[k] + 1e-12)) {
      coverOk = false;
      coverDetail = `d=${d} -> c${k} but interval is (${lo},${bounds[k]}]`;
      break;
    }
  }
  check("every distance in (0, reach] is owned by exactly one cascade", coverOk, coverDetail);
  check("a distance past reach escapes to sky",
    splitCascade(reach * 1.001, bounds) === bounds.length);

  // THE DEPOSIT SHAPE — the item the companion guide gets wrong.
  const L = [2, 3, 4];
  for (let k = 0; k < bounds.length; k++) {
    const mid = k === 0 ? bounds[0] * 0.5 : (bounds[k - 1] + bounds[k]) * 0.5;
    const deps = splitDeposits(mid, L, bounds);
    const owning = deps.filter((d) => d.cascade === k);
    const nearer = deps.filter((d) => d.cascade < k);
    const above = deps.filter((d) => d.cascade > k);
    const ok =
      owning.length === 1 && owning[0].transmittance === 0 &&
      owning[0].radiance[0] === L[0] &&
      nearer.length === k && nearer.every((d) => d.transmittance === 1 && d.radiance[0] === 0) &&
      above.length === 0;
    check(`hit in c${k}: owning gets (L,T=0), ${k} nearer get (0,T=1), NOTHING above`, ok,
      `deps=${deps.map((d) => `c${d.cascade}(${d.radiance[0]},${d.transmittance})`).join(" ")}`);
  }
  const miss = splitDeposits(-1, L, bounds);
  check("a miss is transparent in every cascade and carries no radiance",
    miss.length === bounds.length &&
    miss.every((d) => d.transmittance === 1 && d.radiance.every((v) => v === 0)),
    `${miss.length} deposits`);

  // Radiance must never appear above the owning cascade under ANY distance.
  let nothingAbove = true;
  for (let n = 1; n <= 5000; n++) {
    const d = (n / 5000) * reach;
    const k = splitCascade(d, bounds);
    for (const dep of splitDeposits(d, L, bounds)) {
      if (dep.cascade > k) nothingAbove = false;
    }
  }
  check("no deposit is ever made above the owning cascade (5k distances)", nothingAbove);
}

console.log("── RESOLVE + SPARSE INTERPOLATION ───────────────────────────────");
{
  check("a zero-count bin resolves to UNKNOWN, not black",
    resolveBin(0, 0, 0, 0, 0) === null);
  const r = resolveBin(6, 9, 12, 1.5, 3);
  check("resolve divides sums by count",
    r && Math.abs(r.radiance[0] - 2) < 1e-12 && Math.abs(r.transmittance - 0.5) < 1e-12,
    r ? `L=${r.radiance.join(",")} T=${r.transmittance}` : "null");

  check("preAverage of all-unknown is unknown", preAverage([null, null, null, null]) === null);
  const pa = preAverage([
    { radiance: [1, 1, 1], transmittance: 1 },
    null,
    { radiance: [3, 3, 3], transmittance: 0 },
    null,
  ]);
  check("preAverage renormalizes over the children that exist",
    pa && Math.abs(pa.radiance[0] - 2) < 1e-12 && Math.abs(pa.transmittance - 0.5) < 1e-12,
    pa ? `L=${pa.radiance[0]} T=${pa.transmittance}` : "null");

  // Trilinear weights must sum to 1 everywhere.
  const rng = makeRng(0x7777);
  let worstSum = 0;
  for (let n = 0; n < 5000; n++) {
    const corners = trilinearCorners(rng() * 20 - 10, rng() * 20 - 10, rng() * 20 - 10, 0, 0, 0, 0.7);
    worstSum = Math.max(worstSum, Math.abs(corners.reduce((a, c) => a + c.weight, 0) - 1));
  }
  check("trilinear weights sum to 1", worstSum < 1e-12, `worst |sum-1| ${worstSum.toExponential(2)}`);

  // THE RENORMALIZATION RULE. A constant field sampled through a lattice with
  // MISSING corners must return that constant exactly — not a fraction of it.
  // "Missing corner votes black" is the single most common way a sparse gather
  // grows dark seams, and it is what R1 forbids.
  const present = new Set(["0,0,0", "1,0,0", "0,1,0"]);
  const corners = trilinearCorners(0.3, 0.4, 0.2, 0, 0, 0, 1);
  const g = sparseGather(
    corners,
    (cx, cy, cz) => (present.has(`${cx},${cy},${cz}`) ? 5 : null),
    (acc, v, w) => acc + v * w,
    () => 0,
  );
  check("sparse gather of a constant field returns the constant despite missing corners",
    g && Math.abs(g.value / g.weight - 5) < 1e-12,
    g ? `${(g.value / g.weight).toFixed(6)} from weight ${g.weight.toFixed(4)}` : "null");
  const none = sparseGather(corners, () => null, (a) => a, () => 0);
  check("sparse gather with no corners at all returns null (never 0)", none === null);
}

console.log("── LOD SELECTION + BLEND ────────────────────────────────────────");
{
  const s0 = 0.5;
  // ── THE REACH IS PINNED HERE, AND THIS ARM CAUGHT ITS ARRIVAL ────────────
  //
  // This block used to read `lodAtDistance(s0·8) === 3`, which is the OLD law
  // (`log2(cheb/s₀)`) written out as a number. Introducing `LOD0_REACH` turned
  // it red, correctly and immediately, because 8·s₀ is now deep inside LOD 0.
  // It is rewritten through `lodRadius` — the law's own inverse — so the next
  // change to the law moves the expectation with it instead of turning a
  // correct implementation into a failing test.
  //
  // The constant itself gets its own assertion rather than riding along
  // implicitly: everything downstream (probe density, memory, the shape of the
  // Cornell render) is a function of it, so a silent edit should not be a
  // silent behaviour change.
  check("LOD0_REACH is 64 — one quarter-degree of angular probe spacing",
    LOD0_REACH === 64, `LOD0_REACH = ${LOD0_REACH}`);
  check("LOD 0 is a BALL of radius LOD0_REACH·s₀, not a thin first shell",
    lodAtDistance(0.4, s0) === 0 && lodAtDistance(lodRadius(0, s0) * 0.999, s0) === 0,
    `lod(0.4m) = ${lodAtDistance(0.4, s0)}, ` +
    `lod(${(lodRadius(0, s0) * 0.999).toFixed(2)}m) = ${lodAtDistance(lodRadius(0, s0) * 0.999, s0)}`);
  check("LOD grows as log2 of Chebyshev/(LOD0_REACH·s0)",
    Math.abs(lodAtDistance(lodRadius(3, s0), s0) - 3) < 1e-12,
    `lod(${lodRadius(3, s0)}m) = ${lodAtDistance(lodRadius(3, s0), s0)}`);
  // The whole point of the constant, stated as a number a reader can check:
  // probe spacing at the far edge of a LOD is a fixed FRACTION of the distance,
  // and that fraction is what used to be ~1 radian.
  const edge = lodRadius(4, s0);
  const angular = probeSpacing(0, 4, s0) / edge;
  check("angular probe spacing is under a degree, not the old ~57°",
    angular < 0.0175, `${(angular * 180 / Math.PI).toFixed(3)}° at ${edge}m`);
  check("LOD clamps to maxLods-1", lodAtDistance(1e9, s0, 10) === 9);

  // CONTINUITY — R1, measured on the quantity that actually matters.
  //
  // `lodBlend` alone JUMPS at integer lodF and that is not a bug: just below
  // lodF=1 the shells are {LOD0:0, LOD1:1} and just above they are {LOD1:1} —
  // the same shell at the same weight, so nothing pops. Measuring lodBlend
  // directly (my first attempt) reports a 1.0 discontinuity that no pixel can
  // ever see. What must be continuous is the WEIGHT ASSIGNED TO A FIXED
  // INTEGER LOD, because that is what a fly-through samples.
  let weightsOk = true;
  let worstJump = 0;
  let worstAt = 0;
  const STEPS = 200000;
  const prev = new Map();
  for (let n = 0; n <= STEPS; n++) {
    const lodF = (n / STEPS) * 6;
    const shells = lodShells(lodF, 10);
    const sum = shells.reduce((a, s) => a + s.weight, 0);
    if (Math.abs(sum - 1) > 1e-12) weightsOk = false;
    for (const s of shells) if (s.weight < 0 || s.weight > 1) weightsOk = false;
    for (let lod = 0; lod <= 6; lod++) {
      const w = lodShellWeight(lodF, lod, 10);
      const p = prev.get(lod) ?? w;
      const jump = Math.abs(w - p);
      if (jump > worstJump) { worstJump = jump; worstAt = lodF; }
      prev.set(lod, w);
    }
  }
  check("LOD shell weights are in [0,1] and sum to 1", weightsOk);
  check("the weight of a fixed LOD is continuous in lodF (no hard flip)",
    worstJump < 1e-3, `worst step ${worstJump.toExponential(2)} at lodF=${worstAt.toFixed(4)}`);
  check("blend is 0 below the overlap band and 1 at the top",
    lodBlend(0.5) === 0 && Math.abs(lodBlend(0.999999) - 1) < 1e-4,
    `lodBlend(0.5)=${lodBlend(0.5)} lodBlend(~1)=${lodBlend(0.999999).toFixed(4)}`);
  check("a single shell is used away from the overlap band",
    lodShells(2.4, 10).length === 1 && lodShells(2.4, 10)[0].lod === 2);
  check("two shells inside the overlap band", lodShells(2.95, 10).length === 2);
}

console.log("── OCTAHEDRAL IRRADIANCE TILE + BORDER ──────────────────────────");
{
  // The tile is sampled BILINEARLY in the surface normal, so the octahedral
  // seams have to be continuous. The square's centre is +Z, its four CORNERS
  // are all -Z, and its edges run out to those corners — so the -Z pole sits
  // exactly where bilinear filtering has nothing to interpolate toward unless
  // the 1-texel border carries the wrapped values.
  //
  // THIS IS THE ARM THAT GUARDS A REAL, MEASURED BUG. Without the border, all
  // four taps for n = (0,0,-1) clamp onto one interior corner texel whose own
  // direction at 6x6 is (0.236, 0.236, -0.943) — 19.4 degrees off axis. The
  // probe then reports a tilted normal's irradiance: +32% on a -Z-facing
  // receiver in the transport arm, with a blue cast borrowed from the +X wall,
  // and INVARIANT to probe spacing, ray count and angular resolution. An
  // axis-aligned error nothing converges away.
  //
  // A smooth analytic field makes the seam test exact: bake a tile whose
  // irradiance is a known smooth function of direction, then walk a great
  // circle straight through the pole and look for a step.
  const interior = 6;
  const size = interior + 2;

  // The tile's addressing rests on octahedralDirection and octahedralUV being
  // exact inverses — this math is reused verbatim from cascadeTrace.js, where it
  // was earned, so the arm exists to catch a TRANSCRIPTION error rather than a
  // design one.
  let worstOct = 0;
  for (let v = 0; v < 32; v++) {
    for (let u = 0; u < 32; u++) {
      const d = octahedralDirection(u, v, 32);
      const back = octahedralUV(d[0], d[1], d[2], 32);
      worstOct = Math.max(worstOct, Math.abs(back.u - (u + 0.5)), Math.abs(back.v - (v + 0.5)));
    }
  }
  check("octahedralDirection/octahedralUV are inverses", worstOct < 1e-9,
    `worst texel-coord error ${worstOct.toExponential(2)}`);
  // RELATIVE TEXEL SOLID ANGLE. Equal-area cylindrical bins made this
  // unnecessary for the cascade PAYLOAD (the paper's measured choice), but the
  // irradiance TILE is octahedral and its texels genuinely do vary in solid
  // angle — which is why `octahedralTexelWeight` exists and why ignoring it
  // cost the dense backend a 1.95x position-dependent brightness error.
  //
  // What gets asserted is the IDENTITY, not a remembered ratio. For the map
  // v(fx,fy) = (fx, fy, 1-|fx|-|fy|), dw = (v . (dv/dfx x dv/dfy)) / |v|^3, and
  // that cross product is (sign fx, sign fy, 1) whose dot with v is identically
  // 1 — so dw is proportional to 1/|v|^3, and since |v| = 1/s for a normalized
  // direction, dw is proportional to s^3. Checking the closed form against the
  // numerically-evaluated Jacobian is the claim; a ratio between two hand-picked
  // directions is just a number, and the first version of this line attached an
  // inherited "2.73x" to a pair that actually gives 5.196.
  let worstJacobian = 0;
  for (let n = 0; n < 4000; n++) {
    // Sample the map, not the sphere, so both sheets and the fold are covered.
    const fx = ((n * 7919) % 1997) / 1997 * 2 - 1;
    const fy = ((n * 6271) % 1999) / 1999 * 2 - 1;
    if (Math.abs(fx) + Math.abs(fy) > 1) continue; // upper sheet only
    const vz = 1 - Math.abs(fx) - Math.abs(fy);
    const vlen = Math.hypot(fx, fy, vz);
    if (!(vlen > 1e-6)) continue;
    const d = [fx / vlen, fy / vlen, vz / vlen];
    const analytic = 1 / (vlen * vlen * vlen);
    const closed = octahedralTexelWeight(d[0], d[1], d[2]);
    worstJacobian = Math.max(worstJacobian, Math.abs(closed - analytic) / analytic);
  }
  check("octahedralTexelWeight equals the map's analytic Jacobian",
    worstJacobian < 1e-9, `worst relative error ${worstJacobian.toExponential(2)}`);
  const wAxis = octahedralTexelWeight(0, 0, 1);
  const wDiag = octahedralTexelWeight(1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3));
  check("texel solid angle is non-uniform (which is why the weight exists)",
    Math.abs(wDiag / wAxis - Math.pow(3, 1.5)) < 1e-9,
    `axis-to-body-diagonal ratio ${(wDiag / wAxis).toFixed(4)} = 3^1.5`);

  // Build a tile directly (bypassing the cascade machinery) from a smooth field.
  const field = (d) => 1 + 0.5 * d[0] + 0.25 * d[1] - 0.75 * d[2];
  const tile = new Float32Array(size * size * 3);
  for (let v = 0; v < interior; v++) {
    for (let u = 0; u < interior; u++) {
      const d = octahedralDirection(u, v, interior);
      const val = field(d);
      const o = ((v + 1) * size + (u + 1)) * 3;
      tile[o] = val;
      tile[o + 1] = val;
      tile[o + 2] = val;
    }
  }
  fillOctahedralBorder(tile, interior, size);

  // 1. Interior texel centres must read back their own value exactly — proves
  //    the interior offset is right and the border did not overwrite payload.
  let worstCentre = 0;
  for (let v = 0; v < interior; v++) {
    for (let u = 0; u < interior; u++) {
      const d = octahedralDirection(u, v, interior);
      const got = sampleTile(tile, interior, d[0], d[1], d[2]);
      worstCentre = Math.max(worstCentre, Math.abs(got[0] - field(d)));
    }
  }
  check("a texel centre samples back its own value", worstCentre < 1e-5,
    `worst ${worstCentre.toExponential(2)}`);

  // 2. CONTINUITY THROUGH THE POLE. Walk a great circle in the x-z plane; the
  //    sampled value must never step. A missing border shows up here as a jump
  //    exactly at z = -1.
  let worstStep = 0;
  let stepAt = 0;
  let prev = null;
  const STEPS = 20000;
  for (let n = 0; n <= STEPS; n++) {
    const a = (n / STEPS) * 2 * Math.PI;
    const d = [Math.sin(a), 0, Math.cos(a)];
    const got = sampleTile(tile, interior, d[0], d[1], d[2])[0];
    if (prev != null && Math.abs(got - prev) > worstStep) {
      worstStep = Math.abs(got - prev);
      stepAt = a;
    }
    prev = got;
  }
  // A smooth field over 20k samples of a great circle moves ~1e-3 per step at
  // most; a seam discontinuity is orders of magnitude larger.
  check("tile is continuous across the octahedral seam and through the -Z pole",
    worstStep < 5e-3,
    `worst step ${worstStep.toExponential(2)} at angle ${(stepAt * 180 / Math.PI).toFixed(1)} deg`);

  // 3. SYMMETRY AT THE POLE. The four taps around -Z must be symmetric, so a
  //    field that is antisymmetric in x and y must read its pole value with no
  //    x/y contamination. This is the exact failure the border removes: the
  //    old clamped corner leaked +x+y bias into every -Z-facing surface.
  const antisym = (d) => 10 * d[0] + 10 * d[1];
  const tile2 = new Float32Array(size * size * 3);
  for (let v = 0; v < interior; v++) {
    for (let u = 0; u < interior; u++) {
      const d = octahedralDirection(u, v, interior);
      const o = ((v + 1) * size + (u + 1)) * 3;
      tile2[o] = antisym(d);
    }
  }
  fillOctahedralBorder(tile2, interior, size);
  const atPole = sampleTile(tile2, interior, 0, 0, -1)[0];
  check("no x/y bias leaks into a -Z-facing sample (the 19.4 deg corner bug)",
    Math.abs(atPole) < 1e-4,
    `an x/y-antisymmetric field reads ${atPole.toExponential(2)} at the -Z pole (want 0)`);
  // And the control: the SAME field at +Z, which is the tile centre and has
  // never been in doubt — if this also read 0 the instrument would be measuring
  // nothing at all.
  const atPlusZ = sampleTile(tile2, interior, 0.7, 0.7, 0.14)[0];
  check("CONTROL: the instrument does see x/y variation elsewhere",
    Math.abs(atPlusZ) > 1, `off-pole sample reads ${atPlusZ.toFixed(3)}`);
}

// ═══════════════════════════════════════════════════════════ SCENE FIXTURES
//
// An analytic closed room, so `sceneTrace` is exact and the brute-force arbiter
// shares it with the estimator. The room's faces carry CONSTANT radiance —
// which makes these arms a pure TRANSPORT test: shading is not in the loop, so
// a failure can only be the cascade structure.

function makeRoom({ half = 4, height = 6, faceRadiance, occluder = null }) {
  // faceRadiance(faceIndex) -> [r,g,b]; faces 0..5 = -x,+x,-y,+y,-z,+z
  const min = [-half, 0, -half];
  const max = [half, height, half];
  return function sceneTrace(origin, dir) {
    // Exit distance from inside the box: the smallest positive slab crossing.
    let best = Infinity;
    let face = -1;
    for (let a = 0; a < 3; a++) {
      const d = dir[a];
      if (Math.abs(d) < 1e-12) continue;
      const lo = (min[a] - origin[a]) / d;
      const hi = (max[a] - origin[a]) / d;
      if (lo > 1e-6 && lo < best) { best = lo; face = a * 2; }
      if (hi > 1e-6 && hi < best) { best = hi; face = a * 2 + 1; }
    }
    if (occluder) {
      // Axis-aligned occluder box — nearest ENTRY, if the ray enters it first.
      let t0 = -Infinity;
      let t1 = Infinity;
      for (let a = 0; a < 3; a++) {
        const d = dir[a];
        if (Math.abs(d) < 1e-12) {
          if (origin[a] < occluder.min[a] || origin[a] > occluder.max[a]) { t0 = Infinity; break; }
          continue;
        }
        let lo = (occluder.min[a] - origin[a]) / d;
        let hi = (occluder.max[a] - origin[a]) / d;
        if (lo > hi) { const t = lo; lo = hi; hi = t; }
        t0 = Math.max(t0, lo);
        t1 = Math.min(t1, hi);
      }
      if (t0 <= t1 && t0 > 1e-6 && t0 < best) {
        return { t: t0, radiance: occluder.radiance };
      }
    }
    if (face < 0) return { t: -1, radiance: [0, 0, 0] };
    return { t: best, radiance: faceRadiance(face) };
  };
}

/** A grid of receiver pixels on the room floor, all facing up. */
function floorPixels(half, step) {
  const pixels = [];
  for (let z = -half + step * 0.5; z < half; z += step) {
    for (let x = -half + step * 0.5; x < half; x += step) {
      pixels.push({ position: [x, 0, z], normal: [0, 1, 0] });
    }
  }
  return pixels;
}

console.log("── FURNACE ──────────────────────────────────────────────────────");
{
  // Uniform emissive enclosure, radiance 1 in every direction. The estimator
  // must return E = pi EXACTLY (so albedo/pi * E = albedo, flat 1.0 at albedo
  // 1) at any bin count and any ray count. This is the whole reason the
  // normalization is pi*sum(L cos)/sum(cos) rather than dw*sum(L cos).
  const trace = makeRoom({ faceRadiance: () => [1, 1, 1] });
  const cfg = makeSrcConfig({ spacing0: 0.5, raysPerPixel: 2, forceLod: 0, sky: [0, 0, 0] });
  const pixels = floorPixels(4, 0.5);
  const frame = runSrcFrame(cfg, pixels, trace);

  // 1. Every POPULATED merged c0 bin must read exactly radiance 1.
  let worstBin = 0;
  let populated = 0;
  for (let c = 0; c < cfg.cascadeCount; c++) {
    for (const values of frame.merged[c]) {
      for (const v of values) {
        if (!v) continue;
        populated++;
        for (let k = 0; k < 3; k++) worstBin = Math.max(worstBin, Math.abs(v.radiance[k] - 1));
      }
    }
  }
  check("every populated merged bin reads exactly 1 in a furnace", worstBin < 1e-9,
    `worst |L-1| = ${worstBin.toExponential(2)} over ${populated} bins`);

  // 2. Irradiance tiles must read pi wherever they carry data.
  //
  // THE TOLERANCE IS f32, NOT f64, and that distinction is the whole reason
  // this line has a comment. Tiles are Float32Array because that is what the
  // GPU atlas is (rgba16f/rgba32f), so pi itself is only representable to ~6e-8
  // relative. A 1e-9 bar here does not test the estimator, it tests the storage
  // format, and it fails for a reason that has nothing to do with GI. What IS
  // exact is the merged bin value above (f64, error 0.00e+0) — that is where
  // the "exactly 1.0" claim lives.
  const F32_EPS = 1e-6;
  let worstTile = 0;
  let texels = 0;
  // The backing array is (6+2)^2 — interior payload plus the octahedral border —
  // so the denominator has to be the BORDERED size. Dividing by 6*6 reported
  // 154% coverage, which is the kind of number that looks like a pass and is
  // actually an arithmetic error in the instrument.
  const totalTexels = frame.tiles.length * 8 * 8 * 3;
  for (const tile of frame.tiles) {
    for (let i = 0; i < tile.length; i++) {
      if (tile[i] === 0) continue;
      texels++;
      worstTile = Math.max(worstTile, Math.abs(tile[i] - Math.PI));
    }
  }
  check("furnace irradiance is pi at every tile texel carrying data", worstTile < F32_EPS,
    `worst |E-pi| = ${worstTile.toExponential(2)} over ${texels} texels (f32 eps ~2e-7)`);

  // COVERAGE IS NOT AN INVARIANT — it is a measurement, and asserting full
  // coverage was wrong. These pixels all face +Y, so their rays only ever
  // sample the upper hemisphere; a tile texel pointing DOWN has genuinely
  // received no information and reading 0 there is correct, not a dead texel.
  // Zeroing versus "unknown" only matters where a consumer looks, and the
  // consumer looks along the surface normal, which is always covered.
  const coverage = texels / totalTexels;
  check("tile coverage exceeds a hemisphere for single-sided pixels", coverage > 0.5,
    `${(coverage * 100).toFixed(1)}% of ${totalTexels} texels (upper hemisphere only, by construction)`);

  // 3. And the screen gather — the number a material actually samples:
  //    albedo/pi * E at albedo 1 must be flat 1.0.
  let worstPixel = 0;
  for (const px of pixels) {
    const e = gatherPixel(cfg, frame.built, frame.tiles, px.position, px.normal);
    for (let k = 0; k < 3; k++) worstPixel = Math.max(worstPixel, Math.abs(e[k] / Math.PI - 1));
  }
  check("furnace screen gather is flat 1.0 at albedo 1", worstPixel < F32_EPS,
    `worst |out-1| = ${worstPixel.toExponential(2)} over ${pixels.length} pixels`);

  console.log(
    `   probes: ${frame.built.cascades.map((m, i) => `c${i}=${m.probes.length}`).join(" ")}` +
    `  rays=${frame.rays.totalRays} deposits=${frame.stats.deposits}`,
  );
}

console.log("── INTERVAL BOUNDARY CONTINUITY ─────────────────────────────────");
{
  // Sweep a single emissive surface across every interval boundary and watch
  // the delivered irradiance. A GAP between intervals drops the light for a
  // band of radii; an OVERLAP doubles it. Either reads as a RING at a fixed
  // world radius — the most recognizable RC artifact there is, and the reason
  // the boundaries are partial sums rather than independently chosen.
  //
  // The measurement is a shrinking cubic room whose faces all read 1: the
  // delivered irradiance must be pi at EVERY size, because a closed enclosure
  // of uniform radiance is a furnace regardless of its radius.
  const cfg = makeSrcConfig({ spacing0: 0.5, raysPerPixel: 4, forceLod: 0 });
  const bounds = intervalBoundaries(0, 0.5);
  const radii = [];
  for (const b of bounds) {
    radii.push(b * 0.7, b * 0.95, b, b * 1.05, b * 1.4);
  }
  let worst = 0;
  let worstAt = 0;
  const samples = [];
  for (const r of radii) {
    if (r < 0.2 || r > 40) continue;
    const trace = makeRoom({ half: r, height: 2 * r, faceRadiance: () => [1, 1, 1] });
    const pixels = [{ position: [0, r, 0], normal: [0, 1, 0] }];
    const local = makeSrcConfig({ ...cfg, camera: [0, r, 0], anchor: [0, r, 0] });
    const frame = runSrcFrame(local, pixels, trace);
    const e = gatherPixel(local, frame.built, frame.tiles, [0, r, 0], [0, 1, 0]);
    const err = Math.abs(e[0] / Math.PI - 1);
    samples.push(`${r.toFixed(2)}m:${(e[0] / Math.PI).toFixed(6)}`);
    if (err > worst) { worst = err; worstAt = r; }
  }
  // f32 tile storage again — see the furnace arm's note. The claim being tested
  // is that no interval boundary drops or doubles light, and a boundary fault
  // is a whole-percent effect, not a 3e-8 one.
  check("uniform enclosure delivers pi at every radius across all boundaries",
    worst < 1e-6, `worst ${worst.toExponential(2)} at r=${worstAt.toFixed(2)}m`);
  console.log(`   ${samples.join("  ")}`);
}

console.log("── ALG. 3 RAY BUDGETING ─────────────────────────────────────────");
{
  const cfg = makeSrcConfig({ spacing0: 0.5, raysPerPixel: 2, forceLod: 0 });
  const pixels = floorPixels(4, 0.35);
  const built = buildProbes(cfg, pixels);
  const rays = assignRays(cfg, built);

  check("total rays == pixels x raysPerPixel",
    rays.totalRays === pixels.length * cfg.raysPerPixel,
    `${rays.totalRays} vs ${pixels.length * cfg.raysPerPixel}`);

  // Counts propagate up EXACTLY.
  let countsOk = true;
  for (let c = 1; c < cfg.cascadeCount; c++) {
    for (const parent of built.cascades[c].probes) {
      const sum = parent.children.reduce(
        (a, i) => a + built.cascades[c - 1].probes[i].rayCount, 0);
      if (sum !== parent.rayCount) countsOk = false;
    }
  }
  check("each probe's ray count is the sum of its children's", countsOk);

  // Offsets PARTITION the sequence: no gap, no overlap, every index used once.
  const used = new Uint8Array(rays.totalRays);
  let doubleUsed = 0;
  for (let p = 0; p < pixels.length; p++) {
    const base = rays.pixelRayBase[p];
    for (let r = 0; r < cfg.raysPerPixel; r++) {
      if (used[base + r]) doubleUsed++;
      used[base + r] = 1;
    }
  }
  let unused = 0;
  for (const u of used) if (!u) unused++;
  check("R2 indices partition [0, totalRays) exactly",
    doubleUsed === 0 && unused === 0, `${doubleUsed} reused, ${unused} unused`);

  // THE CONTIGUITY PROPERTY: children of one parent occupy adjacent segments,
  // and their union is exactly the parent's segment. This is what makes a
  // coarse probe's bins semi-uniformly covered.
  let contiguousOk = true;
  let detail = "";
  for (let c = 1; c < cfg.cascadeCount && contiguousOk; c++) {
    for (const parent of built.cascades[c].probes) {
      let cursor = parent.rayOffset;
      for (const i of parent.children) {
        const child = built.cascades[c - 1].probes[i];
        if (child.rayOffset !== cursor) {
          contiguousOk = false;
          detail = `c${c} parent@${parent.rayOffset} child expected ${cursor} got ${child.rayOffset}`;
          break;
        }
        cursor += child.rayCount;
      }
      if (cursor !== parent.rayOffset + parent.rayCount) {
        contiguousOk = false;
        detail = `c${c} parent segment [${parent.rayOffset},${parent.rayOffset + parent.rayCount}) filled to ${cursor}`;
      }
    }
  }
  check("children of one parent occupy contiguous segments covering it exactly",
    contiguousOk, detail || "all cascades");

  // Ancestor chains must be complete — a broken chain is a cascade that
  // silently receives no deposits.
  let chainsOk = true;
  for (let i = 0; i < built.cascades[0].probes.length; i++) {
    const chain = ancestorChain(built, i, cfg.cascadeCount);
    if (chain.some((s) => s < 0)) chainsOk = false;
  }
  check("every c0 probe has a complete ancestor chain", chainsOk,
    `${built.cascades[0].probes.length} c0 probes`);

  console.log(
    `   probes: ${built.cascades.map((m, i) =>
      `c${i}=${m.probes.length}(load ${m.loadFactor.toFixed(2)})`).join(" ")}`,
  );
  // The claim from plan §4.2: per-cascade BIN totals stay near constant,
  // because surface probes fall ~4x per cascade while bins rise 4x. Print it
  // rather than assert it — the real number depends on the surface, and a
  // hard threshold here would be a guess dressed as a gate.
  const binTotals = built.cascades.map((m, i) => m.probes.length * binCount(i, cfg.w0));
  console.log(`   bin totals per cascade: ${binTotals.join(" ")} (plan predicts ~constant)`);
}

console.log("── TRANSPORT vs BRUTE-FORCE MONTE CARLO ─────────────────────────");
{
  // A room with distinctly coloured faces and an occluder block. The estimator
  // and the arbiter share the SAME sceneTrace, so any disagreement is the
  // cascade structure and nothing else.
  const FACE = [
    [0.9, 0.1, 0.1], // -x  red
    [0.1, 0.2, 0.9], // +x  blue
    [0.05, 0.05, 0.05], // -y floor, near black
    [1.0, 1.0, 0.9], // +y ceiling, bright
    [0.2, 0.8, 0.2], // -z  green
    [0.8, 0.7, 0.2], // +z  amber
  ];
  const occluder = {
    min: [-1, 0, -1], max: [1, 2.5, 1], radiance: [0.02, 0.02, 0.02],
  };
  const trace = makeRoom({ half: 4, height: 6, faceRadiance: (f) => FACE[f], occluder });

  // Receivers spread around the occluder so some are shadowed by it and some
  // see the ceiling directly — a uniform-radiance test cannot distinguish a
  // correct merge from one that lost its transmittance.
  //
  // ALL OF THEM SIT >= 2*s0 FROM ANY SURFACE, deliberately. A receiver closer
  // than a probe spacing to a wall measures the paper's own listed limitation
  // (interpolation light-leak: the gather's 8 corners straddle the wall and
  // include probes behind it), NOT the transport. That leak gets its own arm
  // below with its own tracked bound, because burying it in this arm's
  // tolerance would hide a real regression behind a known bias.
  const probesAt = [
    { position: [2.5, 0, 2.5], normal: [0, 1, 0] },   // floor, sees ceiling
    { position: [-2.5, 0, 0], normal: [0, 1, 0] },    // floor, red wall nearby
    { position: [0, 3, 2.5], normal: [0, 0, -1] },    // facing the occluder
    { position: [2.5, 2, 0], normal: [-1, 0, 0] },    // facing the occluder side
  ];

  // TANGENTIAL jitter — pixels stay ON the receiver's plane.
  //
  // The first version jittered all three axes, which pushed pixels 0.1m THROUGH
  // the walls. A pixel outside the room is not a gbuffer sample any renderer
  // could produce, and `makeRoom` traced it as an entry rather than an exit, so
  // those rays deposited a wall's radiance at a nonsense distance. That is how
  // the near-wall receiver came out 30% bright: the instrument was feeding the
  // estimator invalid geometry and then blaming the estimator (R14 — validate
  // the instrument on a known-good pair before trusting a number from it).
  const pixels = [];
  for (const p of probesAt) {
    const n = p.normal;
    // Any two vectors spanning the plane perpendicular to n.
    const up = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const t1 = [
      up[1] * n[2] - up[2] * n[1],
      up[2] * n[0] - up[0] * n[2],
      up[0] * n[1] - up[1] * n[0],
    ];
    const t2 = [
      n[1] * t1[2] - n[2] * t1[1],
      n[2] * t1[0] - n[0] * t1[2],
      n[0] * t1[1] - n[1] * t1[0],
    ];
    const rng = makeRng(0x1000 + p.position[0] * 31 + p.position[2] * 7);
    for (let k = 0; k < 400; k++) {
      const a = (rng() - 0.5) * 1.2;
      const b = (rng() - 0.5) * 1.2;
      pixels.push({
        position: [
          p.position[0] + t1[0] * a + t2[0] * b,
          p.position[1] + t1[1] * a + t2[1] * b,
          p.position[2] + t1[2] * a + t2[2] * b,
        ],
        normal: n,
      });
    }
  }
  // ── THE ARBITER IS CONVERGENCE, NOT A TOLERANCE ────────────────────────
  //
  // The estimator is biased BY DESIGN: a probe averages the rays of every pixel
  // in its cell, so the result is blurred at the s0 scale. Near a dark occluder
  // 1.5m away that blur is worth tens of percent — the paper lists it
  // ("overblurred hard contact shadows", the San Miguel plant) and SRC does not
  // claim to fix it.
  //
  // So an absolute pass/fail bar here would be a number chosen to make today's
  // build pass, which is worth nothing. What separates BLUR from a BUG is how
  // the error behaves as s0 shrinks: discretization error must fall toward zero,
  // and a structural fault (lost transmittance, a dropped interval, a
  // double-counted cascade) must NOT — it is a constant factor, and refining the
  // lattice cannot touch it.
  //
  // Ray budget scales x4 per halving of s0 so that rays-per-probe stays roughly
  // constant; otherwise the finer arm is starved rather than sharper and the
  // sweep measures noise instead of bias.
  const SWEEP = [
    { spacing0: 0.5, raysPerPixel: 32 },
    { spacing0: 0.25, raysPerPixel: 128 },
    { spacing0: 0.125, raysPerPixel: 512 },
  ];
  const refs = probesAt.map((p) =>
    brutePointIrradiance(p.position, p.normal, trace, [0, 0, 0], 200000, 7));
  const worstByLevel = [];
  const chromaByLevel = [];
  let frame05 = null;
  let cfg05 = null;
  for (const level of SWEEP) {
    const cfg = makeSrcConfig({
      spacing0: level.spacing0, raysPerPixel: level.raysPerPixel,
      forceLod: 0, sky: [0, 0, 0], camera: [0, 2, 0], anchor: [0, 0, 0],
    });
    const frame = runSrcFrame(cfg, pixels, trace);
    if (level.spacing0 === 0.5) { frame05 = frame; cfg05 = cfg; }
    let worstLevel = 0;
    let worstChroma = 0;
    const rows = [];
    for (let i = 0; i < probesAt.length; i++) {
      const p = probesAt[i];
      const est = gatherPixel(cfg, frame.built, frame.tiles, p.position, p.normal);
      const ref = refs[i];
      const worst = Math.max(...[0, 1, 2].map((k) =>
        Math.abs(est[k] - ref.irradiance[k]) / Math.max(1e-6, ref.irradiance[k])));
      // CHROMA is the sharper structural test: a merge that loses transmittance
      // or double-counts a cascade over-weights whichever face the damaged
      // cascade happened to see, which rotates the HUE — and hue survives an
      // overall scale error that an energy check would absorb.
      const norm = (v) => {
        const s = v[0] + v[1] + v[2];
        return s > 1e-9 ? v.map((c) => c / s) : [0, 0, 0];
      };
      const a = norm(est);
      const b = norm(ref.irradiance);
      const chroma = Math.max(...[0, 1, 2].map((k) => Math.abs(a[k] - b[k])));
      worstLevel = Math.max(worstLevel, worst);
      worstChroma = Math.max(worstChroma, chroma);
      rows.push(`(${p.position.join(",")}):${(worst * 100).toFixed(1)}%`);
    }
    worstByLevel.push(worstLevel);
    chromaByLevel.push(worstChroma);
    console.log(
      `   s0=${level.spacing0.toString().padEnd(5)} rpp=${String(level.raysPerPixel).padStart(3)} ` +
      `worst ${(worstLevel * 100).toFixed(1)}%  chroma ${worstChroma.toFixed(4)}   ${rows.join(" ")}`,
    );
  }
  for (let i = 0; i < probesAt.length; i++) {
    const p = probesAt[i];
    console.log(
      `   ref (${p.position.join(",")}) n=(${p.normal.join(",")}) = ` +
      `[${refs[i].irradiance.map((v) => v.toFixed(4)).join(", ")}] ` +
      `+-[${refs[i].stderr.map((v) => v.toFixed(4)).join(", ")}]`,
    );
  }
  // ── WHAT THIS SWEEP ASSERTS, AND WHY IT IS NOT MONOTONICITY ─────────────
  //
  // The sweep's JOB was diagnostic and it did it: a plateau at 25-32% that
  // moved for neither s0 nor w0 is what exposed the missing octahedral border
  // (see fillOctahedralBorder). With the border in place every receiver sits at
  // 3-9% and the level-to-level differences are smaller than the fixture's own
  // noise — each halving of s0 quarters the pixels feeding a probe, so the
  // finer arms trade blur for sampling noise rather than strictly improving.
  //
  // Asserting monotonicity at that scale would be asserting noise, and a flaky
  // gate is worse than no gate: it trains you to re-run until green. So the
  // stable claims are BOUNDEDNESS at every level and NON-DIVERGENCE across
  // them; the per-level numbers stay printed as the diagnostic they are.
  check("every receiver is within 12% at every spacing",
    worstByLevel.every((v) => v < 0.12),
    worstByLevel.map((v) => `${(v * 100).toFixed(1)}%`).join(" -> "));
  check("refinement does not diverge",
    worstByLevel[2] < worstByLevel[0] * 2.5,
    `${(worstByLevel[0] * 100).toFixed(1)}% -> ${(worstByLevel[2] * 100).toFixed(1)}% over 4x refinement`);
  check("chromaticity stays bounded (no cascade systematically over-weighted)",
    chromaByLevel.every((v) => v < 0.03), chromaByLevel.map((v) => v.toFixed(4)).join(" -> "));

  // ── THE ANGULAR AXIS ───────────────────────────────────────────────────
  //
  // |D0| = 32 means a c0 bin is ~0.39 sr, and the final gather's angular
  // resolution IS c0's — the merge averages the finer cascades DOWN into it by
  // construction. So there is an accuracy floor that only w0 can move, and it
  // is WORST FOR SURFACES FACING THE PARAMETERIZATION'S POLE (world +-Z):
  // every bin in the polar cap converges at the pole, so the 8 bins carrying
  // the highest cosine each smear a 60-degree cone of very different radiance.
  //
  // That makes it an AXIS-ALIGNED artifact, which is the part that matters for
  // a game: a wall facing -Z is systematically wrong relative to an otherwise
  // identical wall facing -X. It is not noise, it does not average out over the
  // frame, and no amount of temporal accumulation touches it. Naming it and
  // giving it a number is what lets a quality tier be chosen on evidence
  // (SRC_QUALITY's ultra tier is w0=8 for exactly this reason).
  // RAYS SCALE WITH BINS. w0 x2 is bins x4 per cascade, so holding the ray
  // budget fixed starves the finer arm and the sweep measures sampling noise
  // instead of angular resolution — the same trap the spatial sweep avoids by
  // scaling rpp with probe count.
  const ANGULAR = [{ w0: 4, rpp: 128 }, { w0: 8, rpp: 512 }, { w0: 16, rpp: 2048 }];
  const angularWorst = [];
  const poleVsEquator = [];
  for (const { w0, rpp } of ANGULAR) {
    const cfg = makeSrcConfig({
      spacing0: 0.25, raysPerPixel: rpp, w0,
      forceLod: 0, sky: [0, 0, 0], camera: [0, 2, 0], anchor: [0, 0, 0],
    });
    const frame = runSrcFrame(cfg, pixels, trace);
    let worst = 0;
    let poleErr = 0;
    let equatorErr = 0;
    const rows = [];
    for (let i = 0; i < probesAt.length; i++) {
      const p = probesAt[i];
      const est = gatherPixel(cfg, frame.built, frame.tiles, p.position, p.normal);
      const e = Math.max(...[0, 1, 2].map((k) =>
        Math.abs(est[k] - refs[i].irradiance[k]) / Math.max(1e-6, refs[i].irradiance[k])));
      worst = Math.max(worst, e);
      // |n.z| == 1 is the pole; the others are equatorial in this layout.
      if (Math.abs(p.normal[2]) > 0.9) poleErr = Math.max(poleErr, e);
      else equatorErr = Math.max(equatorErr, e);
      rows.push(`${(e * 100).toFixed(1)}%`);
    }
    angularWorst.push(worst);
    poleVsEquator.push({ pole: poleErr, equator: equatorErr });
    console.log(
      `   w0=${String(w0).padStart(2)} |D0|=${String(2 * w0 * w0).padStart(4)} rpp=${String(rpp).padStart(4)}  ` +
      `worst ${(worst * 100).toFixed(1)}%  pole ${(poleErr * 100).toFixed(1)}%  ` +
      `equator ${(equatorErr * 100).toFixed(1)}%   ${rows.join(" ")}`,
    );
  }
  check("every receiver is within 12% at every angular resolution",
    angularWorst.every((v) => v < 0.12),
    angularWorst.map((v) => `${(v * 100).toFixed(1)}%`).join(" -> "));
  // THE REGRESSION GUARD FOR THE BORDER BUG. Before the octahedral border
  // existed, the pole-facing receiver was 21.7 percentage points worse than the
  // equator-facing ones and NOTHING moved it. An axis-aligned penalty of that
  // size means an identical wall reads differently depending which way it
  // faces, so the invariant is that the penalty stays SMALL — not that it
  // shrinks with w0, which it no longer needs to.
  check("no axis-aligned penalty for pole-facing surfaces (border regression guard)",
    poleVsEquator.every((p) => p.pole - p.equator < 0.05),
    poleVsEquator.map((p) => `${((p.pole - p.equator) * 100).toFixed(1)}pp`).join(" -> "));

  // ── CANARY. A convergence test can be fooled by an error that also shrinks,
  //    so the canary here is a SCALE fault: it does not shrink with spacing, and
  //    the monotonic-convergence arm must reject it.
  {
    const broken = mergeCascades(cfg05, frame05.built, frame05.resolved);
    for (let c = 0; c < cfg05.cascadeCount; c++) {
      for (const values of broken[c]) {
        for (const v of values) if (v) v.radiance = v.radiance.map((x) => x * 1.6);
      }
    }
    const tiles = bakeProbeIrradiance(cfg05, frame05.built, broken);
    let worst = 0;
    for (let i = 0; i < probesAt.length; i++) {
      const est = gatherPixel(cfg05, frame05.built, tiles, probesAt[i].position, probesAt[i].normal);
      worst = Math.max(worst, ...[0, 1, 2].map((k) =>
        Math.abs(est[k] - refs[i].irradiance[k]) / Math.max(1e-6, refs[i].irradiance[k])));
    }
    check("CANARY: a 1.6x energy fault is far outside the converged bar",
      worst > 0.35, `broken worst ${(worst * 100).toFixed(1)}% vs converged ${(worstByLevel[2] * 100).toFixed(1)}%`);
  }
}

console.log("── KNOWN LIMITATION: NEAR-GEOMETRY INTERPOLATION LEAK ───────────");
{
  // A receiver closer to a wall than one probe spacing has interpolation
  // corners on BOTH sides of it, so the gather mixes in probes that see the room
  // from behind. The paper lists this (brightened shadows in the Sponza cutouts)
  // and SRC does not fix it; C(-1) screen-space merging is the proposed remedy
  // and is explicitly a later experiment.
  //
  // It gets a NUMBER and a bound anyway. An unbounded known bias is how a real
  // regression hides: "that's the leak" stays unfalsifiable until the leak has a
  // measured size a change can be seen to move.
  const FACE = () => [1, 1, 1];
  const trace = makeRoom({ half: 4, height: 6, faceRadiance: FACE });
  const receiver = { position: [0, 3, 3.7], normal: [0, 0, -1] }; // 0.3m from z=+4
  // Pixels ON the receiver's own plane, so the probes it interpolates actually
  // exist — the first version measured a point with no probes within reach and
  // reported 0.000, which is an instrument fault, not a leak.
  const pixels = [];
  const rng = makeRng(0x9911);
  for (let k = 0; k < 900; k++) {
    pixels.push({
      position: [(rng() - 0.5) * 3, 3 + (rng() - 0.5) * 3, 3.7],
      normal: [0, 0, -1],
    });
  }
  const cfg = makeSrcConfig({
    spacing0: 0.5, raysPerPixel: 32, forceLod: 0, camera: [0, 3, 0], anchor: [0, 0, 0],
  });
  const frame = runSrcFrame(cfg, pixels, trace);
  const est = gatherPixel(cfg, frame.built, frame.tiles, receiver.position, receiver.normal);
  // In a uniform furnace the correct answer is pi regardless of position, so the
  // leak's size is directly readable — no MC needed, no noise floor.
  const ratio = est[0] / Math.PI;
  check("near-wall leak in a furnace stays within 1.15x of correct",
    ratio > 0.85 && ratio < 1.15,
    `${(0.3 / cfg.spacing0).toFixed(1)} spacings from the wall: delivered/correct = ${ratio.toFixed(4)}`);
}

console.log("── OCCLUSION IS ACTUALLY TRANSPORTED ────────────────────────────");
{
  // A control the plan's R14 demands: the instrument must be able to tell the
  // two arms apart before any measurement means anything. Same room, occluder
  // on vs off — if the merged result is identical, the occluder never entered
  // the transport and every number above is measuring nothing.
  const FACE = () => [1, 1, 1];
  const open = makeRoom({ half: 4, height: 6, faceRadiance: FACE });
  const blocked = makeRoom({
    half: 4, height: 6, faceRadiance: FACE,
    occluder: { min: [-2, 1.5, -2], max: [2, 2.0, 2], radiance: [0, 0, 0] },
  });
  const cfg = makeSrcConfig({ spacing0: 0.5, raysPerPixel: 16, forceLod: 0 });
  const pixels = floorPixels(4, 0.5);
  const a = runSrcFrame(cfg, pixels, open);
  const b = runSrcFrame(cfg, pixels, blocked);
  const at = (frame) => gatherPixel(cfg, frame.built, frame.tiles, [0, 0, 0], [0, 1, 0])[0] / Math.PI;
  const lit = at(a);
  const dark = at(b);
  check("a ceiling occluder measurably darkens the floor beneath it",
    dark < lit * 0.75, `open=${lit.toFixed(4)} blocked=${dark.toFixed(4)}`);
  check("the open arm is still a furnace (1.0 to f32 precision)", Math.abs(lit - 1) < 1e-6,
    `${lit.toFixed(12)}`);
}

// ═══════════════════════════════════════════ PHASE 5: HIT SHADING FIXTURES
//
// Everything above traces a room whose faces carry CONSTANT radiance, which is
// deliberate: it makes those arms pure transport tests, because shading is not
// in the loop. Phase 5 puts shading in the loop, so it needs a scene that
// reports SURFACES rather than radiance — position, normal, albedo, emissive,
// and whether the surface hit IS one of the NEE lights (R5's flag).
//
// The split is the same one the GPU has: `createSrcSceneTrace` returns a
// record and `createSrcDepositFrame` takes `shadeHit` separately. Composing
// them with `shadeTrace` is what lets the brute-force arbiter run the EXACT
// shading the estimator ran — an arbiter with its own copy of the shading
// measures the difference between two shading implementations, which is not
// the question anyone is asking.

/** Faces 0..5 = -x,+x,-y,+y,-z,+z, with the OUTWARD (out-of-medium) normal. */
const FACE_NORMAL = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/**
 * A closed room with an optional emissive sphere and an optional occluder box.
 * Returns a GEOMETRY trace: `{ t, position, normal, surface }`, never radiance.
 *
 * `flipNormals` returns every normal the other way round. Nothing physical
 * changes — a record normal's sign is a property of how the gradient was
 * sampled, not of the surface — so shading must be invariant to it, and that is
 * what `faceForward` is for.
 */
function makeShadedScene({
  half = 4, height = 6, surfaces, sphere = null, occluder = null, flipNormals = false,
}) {
  const min = [-half, 0, -half];
  const max = [half, height, half];
  const orient = (n) => (flipNormals ? [-n[0], -n[1], -n[2]] : [n[0], n[1], n[2]]);
  return function geometryTrace(origin, dir) {
    let best = Infinity;
    let normal = null;
    let id = -1;
    for (let a = 0; a < 3; a++) {
      const d = dir[a];
      if (Math.abs(d) < 1e-12) continue;
      const lo = (min[a] - origin[a]) / d;
      const hi = (max[a] - origin[a]) / d;
      if (lo > 1e-6 && lo < best) { best = lo; id = a * 2; }
      if (hi > 1e-6 && hi < best) { best = hi; id = a * 2 + 1; }
    }
    if (id >= 0) normal = FACE_NORMAL[id];
    if (sphere) {
      // Ray-sphere, nearest positive root (works from inside and outside).
      const o = [origin[0] - sphere.center[0], origin[1] - sphere.center[1], origin[2] - sphere.center[2]];
      const b = o[0] * dir[0] + o[1] * dir[1] + o[2] * dir[2];
      const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - sphere.radius * sphere.radius;
      const disc = b * b - c;
      if (disc > 0) {
        const sq = Math.sqrt(disc);
        const t = -b - sq > 1e-6 ? -b - sq : -b + sq;
        if (t > 1e-6 && t < best) {
          best = t;
          id = 6; // the sphere
          const px = origin[0] + dir[0] * t;
          const py = origin[1] + dir[1] * t;
          const pz = origin[2] + dir[2] * t;
          const inv = 1 / sphere.radius;
          normal = [
            (px - sphere.center[0]) * inv,
            (py - sphere.center[1]) * inv,
            (pz - sphere.center[2]) * inv,
          ];
        }
      }
    }
    if (occluder) {
      let t0 = -Infinity;
      let t1 = Infinity;
      let axis = -1;
      let sign = 1;
      for (let a = 0; a < 3; a++) {
        const d = dir[a];
        if (Math.abs(d) < 1e-12) {
          if (origin[a] < occluder.min[a] || origin[a] > occluder.max[a]) { t0 = Infinity; break; }
          continue;
        }
        let lo = (occluder.min[a] - origin[a]) / d;
        let hi = (occluder.max[a] - origin[a]) / d;
        let s = -1;
        if (lo > hi) { const t = lo; lo = hi; hi = t; s = 1; }
        if (lo > t0) { t0 = lo; axis = a; sign = s; }
        t1 = Math.min(t1, hi);
      }
      if (t0 <= t1 && t0 > 1e-6 && t0 < best) {
        best = t0;
        id = 7; // the occluder
        normal = [0, 0, 0];
        normal[axis] = sign;
      }
    }
    if (id < 0) return { t: -1 };
    return {
      t: best,
      position: [
        origin[0] + dir[0] * best,
        origin[1] + dir[1] * best,
        origin[2] + dir[2] * best,
      ],
      normal: orient(normal),
      surface: surfaces(id),
    };
  };
}

/**
 * An OPEN scene: a ground plane, an optional occluder, an optional sphere, and
 * sky above. Rays that go up escape.
 *
 * ══ A SUN CANNOT BE TESTED INSIDE A CLOSED BOX, AND THAT COST AN ARM ═══════
 *
 * The first version of the sun arms used `makeShadedScene`'s room, and every
 * shadow ray reported OCCLUDED — correctly, because the room has a ceiling and
 * a ceiling is between every point and the sun. Every sun measurement read
 * zero, which looks exactly like a broken shadow ray and is in fact a correct
 * one in a fixture that cannot admit sunlight. The fixture is the thing that
 * has to change; the physics was right the whole time.
 */
function makeOpenScene({ surfaces, occluder = null, sphere = null, flipNormals = false }) {
  const room = makeShadedScene({
    half: 1e6, height: 1e6, surfaces, occluder, sphere, flipNormals,
  });
  return function geometryTrace(origin, dir) {
    const hit = room(origin, dir);
    if (!hit || hit.t < 0) return { t: -1 };
    // A hit on the far walls of a 1e6 box is the sky: nothing is there.
    if (hit.t > 1e5) return { t: -1 };
    return hit;
  };
}

/** `surfaceAt` for the fixture: the trace already resolved it. */
const fixtureSurfaceAt = (hit) => ({
  position: hit.position,
  normal: hit.normal,
  albedo: hit.surface.albedo ?? [0, 0, 0],
  emissive: hit.surface.emissive ?? [0, 0, 0],
  emitter: hit.surface.emitter ?? -1,
  mover: hit.surface.mover ?? false,
});

/**
 * A sphere emitter in the form `emitterIrradianceNee` consumes, backed by
 * `emitterShapes.js`'s OWN closed form.
 *
 * Importing the real `refSphereAt` rather than re-deriving `π·sin²α·cosθ` here
 * is the point: §12.21 spent a unit learning that two implementations of one
 * table drift, and the closed form NEE evaluates in the engine is this one,
 * horizon fade and all. A local copy would have passed this suite while the
 * engine used something else.
 */
function makeSphereEmitter({ center, radius, radiance }) {
  return {
    center, radius, radiance,
    irradianceAt(P, N) {
      const f = refSphereAt(P, N, center, radius);
      return [radiance[0] * f, radiance[1] * f, radiance[2] * f];
    },
    // The near surface point, pulled a hair toward the receiver so the shadow
    // ray stops SHORT of the emitter's own geometry. Aiming at the centre with
    // `maxT = |c-P|` makes every light self-occluded — the emitter is the first
    // thing the ray hits — and the scene goes black with no error anywhere.
    sampleTarget(P) {
      const d = [center[0] - P[0], center[1] - P[1], center[2] - P[2]];
      const dist = Math.max(1e-6, Math.hypot(d[0], d[1], d[2]));
      const k = (dist - radius * 1.001) / dist;
      return [P[0] + d[0] * k, P[1] + d[1] * k, P[2] + d[2] * k];
    },
  };
}

console.log("── HIT SHADING: R4, THE IN-LOOP ALBEDO CEILING ──────────────────");
{
  // R4 is a claim about a FIXED-POINT ITERATION, so it gets tested three ways:
  // the clamp's algebra, the gain it implies, and the iteration actually run.
  const below = [0.8, 0.5, 0.2];
  const clampedBelow = clampLoopAlbedo(below);
  check("an albedo at or under the ceiling is passed through bit-exactly",
    clampedBelow.every((v, i) => v === below[i]), `[${clampedBelow.join(", ")}]`);

  const cases = [[1, 1, 1], [1.4, 0.2, 0.05], [0.95, 0.9, 0.91], [3, -1, 0.5]];
  let worstPeak = 0;
  for (const a of cases) worstPeak = Math.max(worstPeak, Math.max(...clampLoopAlbedo(a)));
  check("no albedo survives the ceiling — peak <= MAX_LOOP_ALBEDO",
    worstPeak <= MAX_LOOP_ALBEDO + 1e-12,
    `worst peak ${worstPeak.toFixed(6)} vs ceiling ${MAX_LOOP_ALBEDO}`);

  // CHROMATICITY. Both a per-channel clamp and a scale satisfy the bound; only
  // one of them keeps the colour, and colour bleed is what this module is FOR.
  // The number is what makes the choice a decision rather than a preference.
  const chroma = (v) => { const s = v[0] + v[1] + v[2]; return s > 0 ? v.map((c) => c / s) : [0, 0, 0]; };
  const warmWhite = [1.0, 0.95, 0.9];
  const scaled = clampLoopAlbedo(warmWhite);
  const perChannel = warmWhite.map((v) => Math.min(v, MAX_LOOP_ALBEDO));
  const shiftScaled = Math.max(...chroma(scaled).map((v, i) => Math.abs(v - chroma(warmWhite)[i])));
  const shiftClamp = Math.max(...chroma(perChannel).map((v, i) => Math.abs(v - chroma(warmWhite)[i])));
  check("scaling preserves chromaticity where a per-channel clamp does not",
    shiftScaled < 1e-12 && shiftClamp > 1e-3,
    `scale shift ${shiftScaled.toExponential(1)} vs per-channel clamp ${shiftClamp.toExponential(2)} on ${warmWhite.join("/")}`);

  // ── THE ITERATION ITSELF ────────────────────────────────────────────────
  //
  // A closed box, every wall diffuse, one emissive ceiling, and the secondary
  // cache wired to the PREVIOUS frame's tiles. That is plan §4.1 step [J] in
  // miniature, and it is the only configuration in which R4 can actually fail.
  //
  // In a closed enclosure the form-factor matrix has row sums of exactly 1, so
  // the multibounce operator is `rho * F` and its spectral radius is `rho`. The
  // increments must therefore fall geometrically with ratio -> rho, and the sum
  // must be finite. The unclamped rho = 1 arm is the same measurement with the
  // ceiling removed, and it is what proves the instrument can see a divergence
  // rather than merely reporting convergence.
  const boxPixels = [];
  {
    const H = 1;
    const step = 0.25;
    for (let a = -H + step * 0.5; a < H; a += step) {
      for (let b = step * 0.5; b < 2 * H; b += step) {
        boxPixels.push({ position: [-H, b, a], normal: [1, 0, 0] });
        boxPixels.push({ position: [H, b, a], normal: [-1, 0, 0] });
        boxPixels.push({ position: [a, b, -H], normal: [0, 0, 1] });
        boxPixels.push({ position: [a, b, H], normal: [0, 0, -1] });
      }
      for (let b = -H + step * 0.5; b < H; b += step) {
        boxPixels.push({ position: [a, 0, b], normal: [0, 1, 0] });
        boxPixels.push({ position: [a, 2 * H, b], normal: [0, -1, 0] });
      }
    }
  }
  const runLoop = (albedo, ceiling, iterations, cacheSpacing = null) => {
    const surfaces = (id) => ({
      albedo,
      emissive: id === 3 ? [1, 1, 1] : [0, 0, 0], // +y ceiling emits
      emitter: -1,
    });
    const geometry = makeShadedScene({ half: 1, height: 2, surfaces });
    const cfg = makeSrcConfig({
      spacing0: 0.5, raysPerPixel: 8, forceLod: 0, sky: [0, 0, 0],
      camera: [0, 1, 0], anchor: [0, 1, 0],
    });
    // ── THE CACHE'S OWN LATTICE (§4.1 step [J]: "2 LODs coarser") ──────────
    // `makeSecondaryCache` needs no parameter for this: a coarser cache IS a
    // frame built at a coarser spacing0, handed to the same function. The cost
    // is one extra solve per iteration here, which is exactly what step [J]
    // costs on the GPU.
    const cacheCfg = cacheSpacing
      ? makeSrcConfig({ ...cfg, spacing0: cacheSpacing })
      : cfg;
    let prev = null;
    const series = [];
    for (let k = 0; k < iterations; k++) {
      const secondary = prev ? makeSecondaryCache(cacheCfg, prev.built, prev.tiles) : null;
      const shade = makeHitShader({
        surfaceAt: fixtureSurfaceAt, secondary, maxLoopAlbedo: ceiling,
      });
      const traced = shadeTrace(geometry, shade);
      const frame = runSrcFrame(cfg, boxPixels, traced);
      const e = gatherPixel(cfg, frame.built, frame.tiles, [0, 0, 0], [0, 1, 0]);
      series.push(e[0]);
      prev = cacheSpacing ? runSrcFrame(cacheCfg, boxPixels, traced) : frame;
    }
    return series;
  };
  const ratios = (series) => {
    const out = [];
    for (let k = 2; k < series.length; k++) {
      const num = series[k] - series[k - 1];
      const den = series[k - 1] - series[k - 2];
      out.push(Math.abs(den) > 1e-12 ? num / den : 0);
    }
    return out;
  };

  const clamped = runLoop([1, 1, 1], MAX_LOOP_ALBEDO, 11);
  const clampedRatios = ratios(clamped);
  const tailOf = (r) => r.slice(-4);
  console.log(`   rho=1 clamped to ${MAX_LOOP_ALBEDO}: E = ${clamped.map((v) => v.toFixed(4)).join(" -> ")}`);
  console.log(`      increment ratios: ${clampedRatios.map((v) => v.toFixed(4)).join(" ")}`);

  // ══ THE CLAIM IS ASYMPTOTIC, AND THE FIRST VERSION ASSERTED MORE ══════════
  //
  // "every increment ratio < 1" failed at 1.2494 on the SECOND increment, and
  // the assertion was the thing that was wrong. This is a power iteration: the
  // ratio converges to the operator's spectral radius, it does not start there.
  // Bounce 0 is a small bright ceiling seen directly; bounce 1 redistributes it
  // over every wall, which is a larger transfer than bounce 0 was — so the
  // early ratios carry the GEOMETRY of each successive redistribution and only
  // the tail carries rho. R4 is a statement about the fixed point, so the tail
  // is where it lives.
  const tail = tailOf(clampedRatios);
  check("the multibounce iteration CONTRACTS in the tail — every late ratio < 1 (R4)",
    tail.every((r) => r < 1), `tail ${tail.map((v) => v.toFixed(4)).join(" ")}`);
  check("and the contraction rate IS the clamped albedo, not the authored one",
    Math.abs(tail[tail.length - 1] - MAX_LOOP_ALBEDO) < 0.05,
    `tail ratio ${tail[tail.length - 1].toFixed(4)} vs ceiling ${MAX_LOOP_ALBEDO} (authored albedo was 1.0)`);
  // The bound the ratio implies, checked as a bound: a geometric series with
  // ratio rho starting at E_0 sums to at most E_0/(1-rho). 10x, not infinity —
  // that is the entire content of "provably < 1".
  const bound = clamped[0] / (1 - MAX_LOOP_ALBEDO);
  check("the accumulated series stays under E_0/(1-rho), the bound the ceiling buys",
    clamped[clamped.length - 1] < bound,
    `E = ${clamped[clamped.length - 1].toFixed(4)} vs bound ${bound.toFixed(4)} (= ${clamped[0].toFixed(4)}/${(1 - MAX_LOOP_ALBEDO).toFixed(1)})`);

  // CANARY: the same box with the ceiling lifted to 1.0. A closed enclosure at
  // albedo 1 conserves every photon forever, so the series must NOT converge —
  // and if the instrument reports contraction here, its green above is worth
  // nothing.
  const unclamped = runLoop([1, 1, 1], 1.0, 11);
  const unclampedRatios = ratios(unclamped);
  const unclampedTail = tailOf(unclampedRatios);
  console.log(`   rho=1 UNCLAMPED: E = ${unclamped.map((v) => v.toFixed(4)).join(" -> ")}`);
  console.log(`      increment ratios: ${unclampedRatios.map((v) => v.toFixed(4)).join(" ")}`);
  const unclampedRate = unclampedTail[unclampedTail.length - 1];
  check("CANARY: at albedo 1 with no ceiling the loop does NOT contract",
    unclampedRate > 0.97,
    `tail ratio ${unclampedRate.toFixed(4)} unclamped vs ${tail[tail.length - 1].toFixed(4)} clamped`);
  check("the ceiling is what separates them (the two arms differ)",
    unclamped[unclamped.length - 1] > clamped[clamped.length - 1] * 1.15,
    `E_final ${unclamped[unclamped.length - 1].toFixed(4)} vs ${clamped[clamped.length - 1].toFixed(4)}`);

  // ══ THE CACHE IS ALLOWED TO BE COARSER, AND HERE IS WHAT THAT COSTS ═══════
  //
  // §4.1 step [J] runs the secondary cache "2 LODs coarser" — a 4x spacing —
  // because a bounce that has already been blurred once does not need the fine
  // lattice. The property that has to survive is R4's: coarsening changes the
  // fixed point, it must not change the contraction.
  //
  // It also has a limit nobody wrote down, and the numbers below are it: the
  // coarsening is bounded by SCENE SCALE, not chosen freely. This 2m box at
  // s0 = 0.5 has a 2m cache lattice at 2 LODs coarser — one probe for the whole
  // room — so the coarse arm under-transports by construction. On a Sponza-scale
  // scene the same 4x is a 2m cache in a 30m nave and costs far less. Read the
  // drop as a property of the ratio (cache spacing / scene size), not as a
  // verdict on the coarsening.
  const coarse1 = runLoop([1, 1, 1], MAX_LOOP_ALBEDO, 11, 1.0);
  const coarse2 = runLoop([1, 1, 1], MAX_LOOP_ALBEDO, 11, 2.0);
  const rate = (series) => tailOf(ratios(series)).slice(-1)[0];
  console.log(`   secondary cache spacing 0.5 (same) / 1.0 (1 LOD) / 2.0 (2 LODs) in a 2m box:`);
  console.log(`      E_final ${clamped[clamped.length - 1].toFixed(4)} / ` +
    `${coarse1[coarse1.length - 1].toFixed(4)} / ${coarse2[coarse2.length - 1].toFixed(4)}` +
    `   contraction ${rate(clamped).toFixed(4)} / ${rate(coarse1).toFixed(4)} / ${rate(coarse2).toFixed(4)}`);
  check("a coarser secondary cache still contracts — R4 survives step [J]'s coarsening",
    rate(coarse1) < 1 && rate(coarse2) < 1,
    `${rate(coarse1).toFixed(4)} at 1 LOD, ${rate(coarse2).toFixed(4)} at 2 LODs coarser`);
  // ── AND IT BRIGHTENS, WHICH IS THE OPPOSITE OF WHAT I ASSERTED FIRST ────
  //
  // The first version of this check said a coarse cache "costs energy
  // monotonically, never gains any" — reasoning that averaging over a bigger
  // cell can only blur light away. It failed at +4%, and the reason is a
  // limitation this suite already has an arm for: the near-geometry
  // interpolation leak is proportional to PROBE SPACING, so a 4x coarser cache
  // has 4x the spacing over which its trilinear corners can straddle a wall.
  // Leak is one-sided BRIGHT, so coarsening [J] does not lose energy — it
  // invents some.
  //
  // That matters more here than at the primary field because this one is in a
  // FEEDBACK LOOP: a leak that brightens the cache brightens the next bounce
  // that reads it. R4 is what stops that from running away, and the contraction
  // rates above (0.9001 at every coarsening) are the evidence that it does —
  // the fixed point moves, the rate does not. Bound the movement, name the
  // direction, and let the GPU side choose the coarsening against a real scene
  // rather than against this 2m box.
  const drift = coarse2[coarse2.length - 1] / clamped[clamped.length - 1] - 1;
  check("coarsening moves the fixed point by a bounded amount, and the direction is BRIGHT (leak)",
    drift > 0 && drift < 0.1,
    `+${(drift * 100).toFixed(2)}% at 4x coarser, in a box exactly one coarse cell wide`);
}

console.log("── HIT SHADING: THE RECORD NORMAL + THE SHADOW LIFT ─────────────");
{
  // faceForward is one line and it decides whether half the geometry in a
  // closed room is lit at all.
  let flipOk = true;
  const rng = makeRng(0x51de);
  for (let k = 0; k < 2000; k++) {
    const n = randomDir(rng);
    const d = randomDir(rng);
    const f = faceForward(n, d);
    if (f[0] * d[0] + f[1] * d[1] + f[2] * d[2] > 1e-12) flipOk = false;
    // It is a SIGN choice, never a new direction.
    const same = f.every((v, i) => v === n[i]);
    const opp = f.every((v, i) => v === -n[i]);
    if (!same && !opp) flipOk = false;
  }
  check("faceForward always opposes the incoming ray, and only ever flips the sign",
    flipOk, "2000 random (normal, dir) pairs");

  // The invariance that matters: a scene whose record normals are all reported
  // the other way round must shade IDENTICALLY. This is the arm that fails if
  // faceForward is dropped, and it fails by a factor of two-ish rather than a
  // rounding difference — the far face of every wall goes black.
  const surfaces = () => ({ albedo: [0.6, 0.6, 0.6], emissive: [0, 0, 0], emitter: -1 });
  // TILTED, so more than one face of the slab is lit — a sun straight up lights
  // exactly the top face and the invariance below would be asserting that three
  // black hits are equal to three black hits.
  const sunDir = [0.5, 0.75, 0.35];
  const sunLen = Math.hypot(...sunDir);
  const sun = { direction: sunDir.map((v) => v / sunLen), irradiance: [3, 3, 3] };
  // A slab the rays can hit from BOTH sides — the whole point of the arm is the
  // face whose record normal points away from the ray. A ground plane alone
  // only ever gets hit from above and the flip is untestable on it.
  const slab = { min: [-2, 2, -2], max: [2, 2.4, 2] };
  const outward = makeOpenScene({ surfaces, occluder: slab });
  const inward = makeOpenScene({ surfaces, occluder: slab, flipNormals: true });
  const shadeOf = (geometry) => makeHitShader({
    surfaceAt: fixtureSurfaceAt, sun, visibility: makeVisibility(geometry, 0.1),
  });
  const shots = [
    { from: [0, 6, 0], dir: [0, -1, 0] },      // onto the slab's top
    { from: [0, 0.1, 0], dir: [0, 1, 0] },     // onto its UNDERSIDE
    { from: [5, 2.2, 0], dir: [-1, 0, 0] },    // its +x side
    { from: [0, 0.2, 5], dir: [-0.2, 0.35, -1] },
  ];
  let worstFlip = 0;
  let lit = 0;
  for (const shot of shots) {
    const len = Math.hypot(...shot.dir);
    const d = shot.dir.map((v) => v / len);
    const a = shadeTrace(outward, shadeOf(outward))(shot.from, d, 1);
    const b = shadeTrace(inward, shadeOf(inward))(shot.from, d, 1);
    if (a.radiance[0] > 0) lit++;
    for (let k = 0; k < 3; k++) worstFlip = Math.max(worstFlip, Math.abs(a.radiance[k] - b.radiance[k]));
  }
  check("shading is invariant to the record normal's reported SIGN",
    worstFlip === 0 && lit >= 2,
    `worst channel difference ${worstFlip.toExponential(2)} over ${shots.length} hits, ${lit} of them lit`);

  // ── THE LIFT IS THE VOXEL'S (R2), AND THIS MEASURES WHAT THAT COSTS ─────
  //
  // `createSrcVisibility` starts its shadow ray 0.75 voxels off the surface. So
  // an occluder CLOSER to a surface than that is stepped over and its contact
  // shadow is lost. That is not a bug to fix with a smaller epsilon — a smaller
  // one re-acnes the surface at the same voxel scale — it is the medium's
  // quantization showing through, and R2's whole point is that the number comes
  // from the voxel rather than from probe spacing or from taste.
  //
  // What is worth having is the THRESHOLD, measured, so a lost contact shadow
  // can be recognized instead of investigated.
  check("makeVisibility refuses to invent a bias when it is not told the voxel size",
    (() => { try { makeVisibility(outward, 0); return false; } catch { return true; } })(),
    "a caller that does not know its medium cannot cast a correct shadow ray");

  const VOXEL = 0.2;
  const lift = 0.75 * VOXEL;
  const heights = [0.02, 0.08, 0.14, 0.16, 0.2, 0.35];
  const lost = [];
  for (const h of heights) {
    const plate = { min: [-1, h, -1], max: [1, h + 0.02, 1] };
    const geometry = makeOpenScene({ surfaces, occluder: plate });
    const visibility = makeVisibility(geometry, VOXEL);
    const shade = makeHitShader({ surfaceAt: fixtureSurfaceAt, sun, visibility });
    // The ground point directly under the plate. The hit record is built here
    // rather than traced: a ray aimed down at it would hit the PLATE first, and
    // the question is what the ground beneath the plate receives.
    const r = shade({
      position: [0, 0, 0], normal: [0, 1, 0], surface: surfaces(2),
    }, [0, -1, 0], 1);
    lost.push({ h, lit: r[0] > 1e-9 });
  }
  const firstShadowed = lost.find((r) => !r.lit);
  console.log(`   voxel ${VOXEL}m, lift ${lift.toFixed(3)}m: ` +
    lost.map((r) => `${r.h.toFixed(2)}m:${r.lit ? "LIT" : "shadowed"}`).join(" "));
  check("contact shadows survive exactly where the occluder clears the lift",
    lost.every((r) => r.lit === (r.h < lift)) && !!firstShadowed,
    `threshold at ${lift.toFixed(3)}m = 0.75 x voxel — occluders nearer than that are stepped over, by construction`);
}

console.log("── HIT SHADING: THE SUN ─────────────────────────────────────────");
{
  const surfaces = () => ({ albedo: [1, 1, 1], emissive: [0, 0, 0], emitter: -1 });
  const geometry = makeOpenScene({ surfaces });
  const sun = { direction: [0, 1, 0], irradiance: [2, 2, 2] };

  // The cosine law, exactly — not within a tolerance. E = E_perp * cos(theta).
  let worstCos = 0;
  const rng = makeRng(0x5a11);
  let backFacing = 0;
  for (let k = 0; k < 500; k++) {
    const n = randomDir(rng);
    const e = sunIrradiance(sun, [0, 3, 0], n, null);
    const cos = n[1];
    const expect = cos > 0 ? 2 * cos : 0;
    if (cos <= 0) backFacing++;
    worstCos = Math.max(worstCos, Math.abs(e[0] - expect));
  }
  check("the sun term is E_perp x cos(theta), exactly", worstCos < 1e-15,
    `worst ${worstCos.toExponential(2)} over 500 normals (${backFacing} back-facing)`);

  // A BACK-FACING surface must cost NOTHING. The early-out is most of what the
  // sun term costs on the GPU, and an implementation that traces first and
  // multiplies by cos afterward is correct and twice the price.
  const counting = { rays: 0 };
  const countingVis = (p, n, l, m) => { counting.rays++; return makeVisibility(geometry, 0.1)(p, n, l, m); };
  sunIrradiance(sun, [0, 3, 0], [0, -1, 0], countingVis);
  check("a back-facing surface casts no shadow ray at all", counting.rays === 0,
    `${counting.rays} shadow rays for cos < 0`);
  sunIrradiance(sun, [0, 3, 0], [0, 1, 0], countingVis);
  check("a front-facing surface casts exactly one", counting.rays === 1, `${counting.rays}`);

  // Shadowed vs lit, through the geometry — the R14 control. If these do not
  // differ, the shadow ray never entered the calculation and every sun number
  // above is measuring an unoccluded analytic formula.
  const plate = { min: [-1, 2, -1], max: [1, 2.2, 1] };
  const shadowed = makeOpenScene({ surfaces, occluder: plate });
  const litE = sunIrradiance(sun, [0, 0.5, 0], [0, 1, 0], makeVisibility(geometry, 0.1));
  const darkE = sunIrradiance(sun, [0, 0.5, 0], [0, 1, 0], makeVisibility(shadowed, 0.1));
  check("the shadow ray actually occludes (control: same point, occluder on/off)",
    litE[0] > 1.9 && darkE[0] === 0, `lit ${litE[0].toFixed(4)} vs shadowed ${darkE[0].toFixed(4)}`);

  // And end to end: albedo/pi * E_sun at a hit.
  const shade = makeHitShader({
    surfaceAt: fixtureSurfaceAt, sun, visibility: makeVisibility(geometry, 0.1),
  });
  const r = shadeTrace(geometry, shade)([0, 3, 0], [0, -1, 0], 1);
  // ALBEDO 1 DOES NOT SURVIVE THE LOOP — the expected value carries R4's
  // ceiling, and that is the cross-check: an implementation that forgot the
  // clamp lands on 2/pi = 0.6366 here, which is 11% brighter and looks fine.
  const expect = MAX_LOOP_ALBEDO * 2 / Math.PI;
  check("a sunlit hit returns clamp(albedo)/pi x E", Math.abs(r.radiance[0] - expect) < 1e-12,
    `${r.radiance[0].toFixed(9)} vs ${expect.toFixed(9)} (unclamped would be ${(2 / Math.PI).toFixed(4)})`);
  check("CONTROL: the same hit with no sun is black",
    shadeTrace(geometry, makeHitShader({ surfaceAt: fixtureSurfaceAt }))([0, 3, 0], [0, -1, 0], 1)
      .radiance.every((v) => v === 0), "sun on/off differ");
}

console.log("── HIT SHADING: EMITTER NEE ─────────────────────────────────────");
{
  const emitters = [
    makeSphereEmitter({ center: [-2, 4, -2], radius: 0.3, radiance: [40, 8, 8] }),
    makeSphereEmitter({ center: [2, 4.5, 1], radius: 0.5, radiance: [6, 30, 6] }),
    makeSphereEmitter({ center: [0, 5, 3], radius: 0.2, radiance: [8, 8, 50] }),
    makeSphereEmitter({ center: [3, 1, -3], radius: 0.4, radiance: [20, 20, 20] }),
  ];
  const P = [0, 0.2, 0];
  const N4 = [0, 1, 0];
  const exact = emitterIrradianceExact(emitters, P, N4, null);

  // ══ THE PDF IS SCALAR AND THE SIGNAL IS NOT — WHICH IS THE WHOLE FINDING ══
  //
  // With `p_i ∝ luminance(E_i)`, `E_i/p_i = Σ_j E_j` holds in LUMINANCE for
  // whichever i is drawn: one sample is not an unbiased estimate of the total
  // luminance, it IS the total luminance, exactly, for every ray index.
  //
  // It does NOT hold per channel, and the first version of this arm asserted
  // that it did (it failed at 7.4x). The reason is worth writing down because
  // it is a property of every importance-sampled NEE and it will show up on the
  // GPU as coloured noise nobody expected: the pdf is one scalar and the signal
  // has three components, so a draw that is exact in the ranked quantity
  // redistributes the OTHER two. A red emitter drawn in place of a blue one of
  // equal luminance returns the right amount of light in the wrong hue.
  //
  // So: variance in a monochrome scene is zero, and all residual variance under
  // full visibility is CHROMATIC. That also says what the fix is if it ever
  // matters — rank on the channel being estimated, or spend more samples — and
  // it says the noise floor cannot be blamed on the tree.
  let worstLum = 0;
  let worstChannel = 0;
  const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  for (let n = 0; n < 4000; n++) {
    const est = emitterIrradianceNee(emitters, P, N4, null, n, { samples: 1 });
    worstLum = Math.max(worstLum, Math.abs(lum(est) - lum(exact)) / lum(exact));
    for (let k = 0; k < 3; k++) {
      worstChannel = Math.max(worstChannel, Math.abs(est[k] - exact[k]) / Math.max(1e-9, exact[k]));
    }
  }
  check("one-sample NEE is EXACT in the quantity its pdf ranks on (luminance)",
    worstLum < 1e-12, `worst relative ${worstLum.toExponential(2)} over 4000 ray indices`);
  console.log(`   per-channel spread of the same 4000 draws: ${(worstChannel * 100).toFixed(0)}% ` +
    `— chromatic variance, not energy loss (the pdf is scalar, the signal is not)`);

  // The monochrome control, which is what turns the paragraph above into a
  // measurement: make every emitter grey and the per-channel error collapses to
  // the luminance error. If it did not, the explanation would be wrong.
  const grey = emitters.map((e) => makeSphereEmitter({
    center: e.center, radius: e.radius, radiance: [lum(e.radiance), lum(e.radiance), lum(e.radiance)],
  }));
  const greyExact = emitterIrradianceExact(grey, P, N4, null);
  let worstGrey = 0;
  for (let n = 0; n < 4000; n++) {
    const est = emitterIrradianceNee(grey, P, N4, null, n, { samples: 1 });
    for (let k = 0; k < 3; k++) {
      worstGrey = Math.max(worstGrey, Math.abs(est[k] - greyExact[k]) / Math.max(1e-9, greyExact[k]));
    }
  }
  check("CONTROL: with grey emitters the per-channel error collapses to zero too",
    worstGrey < 1e-12, `worst relative ${worstGrey.toExponential(2)} — the spread above is chroma and nothing else`);

  // Every emitter must be REACHABLE. A light with a nonzero contribution and a
  // zero pick probability is energy that vanishes with no error anywhere — R1's
  // rule about rejection weights, wearing a sampling costume.
  const picked = new Set();
  for (let n = 0; n < 4000; n++) {
    for (let i = 0; i < emitters.length; i++) {
      const one = emitterIrradianceNee([emitters[i]], P, N4, null, n, { samples: 1 });
      if (one[0] + one[1] + one[2] > 0) picked.add(i);
    }
  }
  // ...and, in the multi-emitter draw, that all four are actually drawn.
  const drawn = new Set();
  for (let n = 0; n < 4000; n++) {
    const u = hashUnitFloat(n * 0x9e37);
    let acc = 0;
    const lum = emitters.map((e) => {
      const E = e.irradianceAt(P, N4);
      return 0.2126 * E[0] + 0.7152 * E[1] + 0.0722 * E[2];
    });
    const total = lum.reduce((a, b) => a + b, 0);
    for (let i = 0; i < emitters.length; i++) {
      acc += lum[i] / total;
      if (u < acc) { drawn.add(i); break; }
    }
  }
  check("every contributing emitter is reachable by the sampler",
    picked.size === emitters.length && drawn.size === emitters.length,
    `${drawn.size}/${emitters.length} drawn, ${picked.size}/${emitters.length} deliver`);

  // ══ WITH OCCLUSION: CONVERGENCE, AND WHAT A WORSE IMPORTANCE COSTS ════════
  //
  // Visibility is the only source of variance here, so this is the number that
  // says what the light tree's bounds-based ranking will actually pay. Uniform
  // importance is the worst-case stand-in for "a ranking that knows nothing".
  const surfaces = (id) => ({
    albedo: [0.5, 0.5, 0.5], emissive: [0, 0, 0], emitter: id === 6 ? 0 : -1,
  });
  const blocker = { min: [-3, 2, -3], max: [0.2, 2.3, 3] };
  const geometry = makeShadedScene({ half: 4, height: 6, surfaces, occluder: blocker });
  const visibility = makeVisibility(geometry, 0.1);
  const truth = emitterIrradianceExact(emitters, P, N4, visibility);
  const meanOf = (importance) => {
    const acc = [0, 0, 0];
    const sq = [0, 0, 0];
    // THE VARIANCE IS MEASURED IN LUMINANCE, because that is what the pdf ranks
    // on. A per-channel standard error mixes in the chromatic spread the arm
    // above just isolated, and that spread is the SAME for both importances —
    // so it swamps the difference and reports 1.17x for a change that is worth
    // much more. Compare estimators in the quantity they estimate.
    const S = 20000;
    let sum = 0;
    let sumSq = 0;
    for (let n = 0; n < S; n++) {
      const est = emitterIrradianceNee(emitters, P, N4, visibility, n, { samples: 1, importance });
      const l = lum(est);
      sum += l;
      sumSq += l * l;
      for (let k = 0; k < 3; k++) { acc[k] += est[k]; sq[k] += est[k] * est[k]; }
    }
    const meanLum = sum / S;
    return {
      meanLum,
      stderrLum: Math.sqrt(Math.max(0, sumSq / S - meanLum * meanLum) / S),
      mean: acc.map((v) => v / S),
    };
  };
  const good = meanOf(null);
  const flat = meanOf(() => 1);
  const truthLum = lum(truth);
  check("NEE converges to the all-emitters answer within its own standard error",
    Math.abs(good.meanLum - truthLum) < 3 * good.stderrLum,
    `${good.meanLum.toFixed(5)} vs ${truthLum.toFixed(5)} (3-sigma = ${(3 * good.stderrLum).toExponential(2)})`);
  check("a uniform importance is unbiased too — the cost is variance, not energy",
    Math.abs(flat.meanLum - truthLum) < 3 * flat.stderrLum,
    `${flat.meanLum.toFixed(5)} vs ${truthLum.toFixed(5)} (3-sigma = ${(3 * flat.stderrLum).toExponential(2)})`);
  const ratio = flat.stderrLum / Math.max(1e-12, good.stderrLum);
  console.log(`   luminance stderr: contribution-importance ${good.stderrLum.toExponential(2)}, ` +
    `uniform ${flat.stderrLum.toExponential(2)} — ${ratio.toFixed(2)}x`);
  console.log(`   (a ${ratio.toFixed(1)}x standard error is ${(ratio * ratio).toFixed(0)}x the samples ` +
    `for equal noise — the price of a ranking that knows nothing, and the ceiling on what a light tree can lose)`);
  check("contribution-proportional importance is measurably better than uniform",
    ratio > 1.5, `${ratio.toFixed(2)}x the standard error at equal sample count`);

  // ══ STRATIFICATION: MORE SAMPLES MUST BUY THE USUAL 1/sqrt(S) ═════════════
  //
  // `neeSamples` exists so a quality tier can spend on light sampling without
  // spending on rays. The claim it has to earn is that the extra samples are
  // STRATIFIED — the draw is `(s + hash)/S`, one per stratum — and stratified
  // draws over a piecewise-constant cdf beat independent ones. Asserting only
  // "the mean is still right" would pass on a loop that draws the same light S
  // times and divides by S.
  const stderrAt = (S) => {
    let sum = 0;
    let sumSq = 0;
    const ROUNDS = 8000;
    for (let n = 0; n < ROUNDS; n++) {
      const l = lum(emitterIrradianceNee(emitters, P, N4, visibility, n, { samples: S }));
      sum += l;
      sumSq += l * l;
    }
    const m = sum / ROUNDS;
    return { mean: m, stderr: Math.sqrt(Math.max(0, sumSq / ROUNDS - m * m) / ROUNDS) };
  };
  const s1 = stderrAt(1);
  const s4 = stderrAt(4);
  const gain = s1.stderr / Math.max(1e-12, s4.stderr);
  console.log(`   neeSamples 1 -> 4: stderr ${s1.stderr.toExponential(2)} -> ` +
    `${s4.stderr.toExponential(2)} (${gain.toFixed(2)}x; independent draws would give 2.00x)`);
  check("4 stratified NEE samples are unbiased and at least as good as 1/sqrt(S)",
    Math.abs(s4.mean - truthLum) < 3 * s4.stderr && gain > 1.9,
    `${gain.toFixed(2)}x variance reduction, mean ${s4.mean.toFixed(5)} vs ${truthLum.toFixed(5)}`);

  // ══ A BROKEN IMPORTANCE MUST LOSE VARIANCE, NEVER ENERGY ══════════════════
  //
  // The pathological input: an importance function that ranks a CONTRIBUTING,
  // VISIBLE emitter at zero. R1 says it must still be reachable, and the floor
  // is what makes it so.
  //
  // The first version zero-ranked `emitters[0]`, which the blocker occludes —
  // so the arm was asserting that an emitter delivering nothing still delivers
  // nothing, and it passed with the floor doing no work at all. An arm whose
  // subject contributes zero cannot fail. The dominant VISIBLE emitter is the
  // one that makes the question real.
  //
  // What the floor buys and what it does not: energy survives (the estimator is
  // still unbiased), and the worst single-sample weight is bounded by
  // `contributors / floorFraction` rather than by luck. It does NOT make a
  // broken ranking usable — the variance blow-up printed below is the number
  // that says so, and `stats.importanceFloored` is the detector. The floor is
  // a diagnosis, not a repair.
  const visibleDominant = emitters[1];
  const zeroRanked = (e) => (e === visibleDominant ? 0 : lum(e.irradianceAt(P, N4)));
  const stats = { importanceFloored: 0 };
  let sum = 0;
  let sumSq = 0;
  let peak = 0;
  const DRAWS = 200000;
  for (let n = 0; n < DRAWS; n++) {
    const est = emitterIrradianceNee(emitters, P, N4, visibility, n, { samples: 1, importance: zeroRanked, stats });
    const l = lum(est);
    sum += l;
    sumSq += l * l;
    peak = Math.max(peak, l);
  }
  const brokenMean = sum / DRAWS;
  const brokenStderr = Math.sqrt(Math.max(0, sumSq / DRAWS - brokenMean * brokenMean) / DRAWS);
  console.log(`   zero-ranked VISIBLE emitter: mean ${brokenMean.toFixed(5)} vs truth ${truthLum.toFixed(5)} ` +
    `(3-sigma ${(3 * brokenStderr).toExponential(2)}), worst single sample ${peak.toFixed(1)} ` +
    `= ${(peak / truthLum).toFixed(0)}x the mean, floored ${stats.importanceFloored} times`);
  console.log(`   its stderr is ${(brokenStderr / good.stderrLum).toFixed(0)}x the correct ranking's — ` +
    `the floor keeps the energy and hands back the variance`);
  check("an emitter ranked at zero importance still delivers its energy",
    Math.abs(brokenMean - truthLum) < 3 * brokenStderr,
    `${((brokenMean - truthLum) / truthLum * 100).toFixed(2)}% off over ${DRAWS} draws, inside its own 3-sigma`);
  // contributors / floorFraction is the analytic ceiling on the weight; the
  // point of asserting it is that the bound is a PROPERTY of the floor rather
  // than an observation about this fixture.
  const weightBound = 4 / (1 / 1024);
  check("and the floor bounds the firefly it would otherwise create",
    stats.importanceFloored > 0 && peak / truthLum < weightBound,
    `worst weight ${(peak / truthLum).toFixed(0)}x vs the bound ${weightBound} = contributors/floorFraction`);
}

console.log("── HIT SHADING: R5, THE EMITTER ENERGY HANDOFF ──────────────────");
{
  // ══ ONE LIGHT, TWO REPRESENTATIONS, ONE ENERGY ════════════════════════════
  //
  // R5: "two representations of one light must agree on energy before caps or
  // clustering matter." §4.4 puts an emissive mesh in two places at once — NEE
  // samples it analytically at every hit, and a ray that lands ON it picks up
  // its emission — and resolves the double count with a flag: the hit emission
  // is ZEROED when the surface is an NEE light.
  //
  // ══ THE FIRST VERSION OF THIS ARM COMPARED TWO DIFFERENT QUANTITIES ═══════
  //
  // It measured a floor receiver's irradiance with NEE off (which is the light
  // arriving DIRECTLY from the emitter) against the same receiver with NEE on
  // and the emission zeroed (which is the light arriving after bouncing off the
  // walls). Those are the direct and indirect terms; they have no reason to be
  // equal, and the arm read a 100% gap while both halves were correct.
  //
  // The two representations only meet AT A SHADING POINT. So:
  //
  //   analytic:   emitterIrradianceExact(H, n̂)  — the closed form + one
  //               visibility ray, which is what NEE evaluates
  //   geometric:  MC over H's hemisphere with the emitter as the ONLY emissive
  //               surface and every albedo zero, which is what a ray that lands
  //               on the emitter reports
  //
  // Both are "the irradiance the emitter delivers to H", and R5 is the claim
  // that swapping one for the other changes no energy. It is an approximation
  // by construction — an analytic form factor times a single binary visibility
  // cannot resolve a partially-occluded emitter — and it is the SAME
  // approximation the screen chain's analytic emitter direct already makes, so
  // the arm bounds the gap rather than abolishing it.
  const emitter = makeSphereEmitter({ center: [0, 4, 0], radius: 0.9, radiance: [12, 10, 8] });
  const sphere = { center: emitter.center, radius: emitter.radius };
  // Every albedo ZERO: the geometric arm must measure the emitter and nothing
  // else. With reflective walls the MC would also carry the bounce, which the
  // analytic form factor does not claim to include, and the "gap" would be the
  // whole indirect term.
  const emissiveOnly = (id) => ({
    albedo: [0, 0, 0],
    emissive: id === 6 ? emitter.radiance : [0, 0, 0],
    emitter: id === 6 ? 0 : -1,
  });
  const geometry = makeShadedScene({ half: 4, height: 6, surfaces: emissiveOnly, sphere });
  const visibility = makeVisibility(geometry, 0.1);
  const emissionPath = makeHitShader({ surfaceAt: fixtureSurfaceAt });

  const points = [
    { position: [0, 0.05, 0], normal: [0, 1, 0], where: "under it" },
    { position: [2.2, 0.05, 1.4], normal: [0, 1, 0], where: "off to one side" },
    { position: [-3.9, 2.5, 0], normal: [1, 0, 0], where: "on a wall" },
  ];
  let worstGap = 0;
  const rows = [];
  for (const p of points) {
    const geometric = brutePointIrradiance(p.position, p.normal,
      shadeTrace(geometry, emissionPath), [0, 0, 0], 400000, 11);
    const analytic = emitterIrradianceExact([emitter], p.position, p.normal, visibility);
    const gap = Math.max(...[0, 1, 2].map((k) =>
      Math.abs(analytic[k] - geometric.irradiance[k]) / Math.max(1e-9, geometric.irradiance[k])));
    worstGap = Math.max(worstGap, gap);
    rows.push(`${p.where}: analytic ${analytic[0].toFixed(5)} vs geometric ` +
      `${geometric.irradiance[0].toFixed(5)} (${(gap * 100).toFixed(2)}%)`);
  }
  for (const row of rows) console.log(`   ${row}`);
  check("the analytic and hit-emission representations agree on energy within 4%",
    worstGap < 0.04,
    `worst handoff gap ${(worstGap * 100).toFixed(2)}% (closed form + 1 visibility ray vs direct hits)`);

  // ── THE DOUBLE COUNT AT FRAME LEVEL ─────────────────────────────────────
  //
  // Now the flag itself, through the whole transport. NEE lights the walls, the
  // walls bounce, and the floor collects — that is SRC's job, indirect only,
  // because the pixel's own direct emitter light comes from the screen chain
  // (§4.4: "analytic emitter direct + emitter shadows at pixels stay in the
  // screen chain unchanged"). If a ray that lands on the emitter ALSO reports
  // its emission, that direct light is delivered a second time through SRC, and
  // the flag is the only thing standing between the two.
  //
  // The excess is not a factor of two — direct and indirect are not equal — so
  // the arm asserts a LARGE, one-sided excess and prints the size. A number
  // this big is not a tuning question.
  const room = (flagged) => (id) => ({
    albedo: [0.6, 0.6, 0.6],
    emissive: id === 6 ? emitter.radiance : [0, 0, 0],
    emitter: id === 6 && flagged ? 0 : -1,
  });
  const cfg = makeSrcConfig({
    spacing0: 0.5, raysPerPixel: 12, forceLod: 0, sky: [0, 0, 0],
    camera: [0, 2, 0], anchor: [0, 2, 0],
  });
  const pixels = floorPixels(4, 0.5);
  const frameFor = (flagged) => {
    const g = makeShadedScene({ half: 4, height: 6, surfaces: room(flagged), sphere });
    const shade = makeHitShader({
      surfaceAt: fixtureSurfaceAt, emitters: [emitter],
      visibility: makeVisibility(g, 0.1), neeEmitters: true,
    });
    const frame = runSrcFrame(cfg, pixels, shadeTrace(g, shade));
    // THE MEAN OVER THE WHOLE FLOOR, not one point. A single gather sees the
    // ~8 probes around it, and the rays that land on a small emitter are spread
    // thinly across the floor's probes — the first version read one point,
    // found 1.00x, and the double count was really there the whole time in
    // probes the sample never touched. An energy claim wants an energy
    // statistic.
    let sum = 0;
    for (const px of pixels) {
      sum += gatherPixel(cfg, frame.built, frame.tiles, px.position, px.normal)[0];
    }
    return { E: [sum / pixels.length], shade };
  };
  const flagged = frameFor(true);
  const unflagged = frameFor(false);
  const excess = unflagged.E[0] / Math.max(1e-12, flagged.E[0]);
  console.log(`   floor E: flagged ${flagged.E[0].toFixed(5)} (indirect only) ` +
    `vs unflagged ${unflagged.E[0].toFixed(5)} — ${excess.toFixed(2)}x`);
  check("CANARY: an unflagged emitter delivers its light through SRC as well",
    excess > 1.5, `${excess.toFixed(2)}x the indirect-only answer`);
  check("the flag is what suppresses it — the shader counts the zeroings",
    flagged.shade.stats.emissiveZeroed > 0 && unflagged.shade.stats.emissiveZeroed === 0,
    `flagged zeroed ${flagged.shade.stats.emissiveZeroed} hits, unflagged zeroed ${unflagged.shade.stats.emissiveZeroed}`);
}

console.log("── HIT SHADING: MOVERS ARE NOT A BRANCH ─────────────────────────");
{
  // §4.4 gives movers "header mean albedo/emissive Lambert shading", which is
  // the same expression with the surface read from a different place. So the
  // testable claim is an ABSENCE: two hits with identical albedo/emissive must
  // shade identically whatever `mover` says. A mover-shaped `if` in the shader
  // is the shape of the bug where a moving crate lights the room differently
  // from the identical static one beside it, and that bug is invisible until
  // someone picks the crate up.
  const sun = { direction: [0.3, 0.9, 0.2], irradiance: [4, 3.5, 3] };
  const len = Math.hypot(...sun.direction);
  sun.direction = sun.direction.map((v) => v / len);
  const shade = makeHitShader({ surfaceAt: fixtureSurfaceAt, sun });
  const base = {
    position: [1, 2, -0.5], normal: [0, 0, 1],
    surface: { albedo: [0.7, 0.3, 0.2], emissive: [0.1, 0.1, 0.1], emitter: -1 },
  };
  const asStatic = shade({ ...base, surface: { ...base.surface, mover: false } }, [0, 0, -1], 3);
  const asMover = shade({ ...base, surface: { ...base.surface, mover: true } }, [0, 0, -1], 3);
  check("a mover hit and a static hit with the same surface shade identically",
    asStatic.every((v, i) => v === asMover[i]),
    `[${asStatic.map((v) => v.toFixed(6))}] vs [${asMover.map((v) => v.toFixed(6))}]`);
}

console.log("── HIT SHADING: BOUNCE COLOUR REACHES THE SCREEN ────────────────");
{
  // ══ THE HEADLINE, AND THE CONTROL THAT MAKES IT MEAN ANYTHING ═════════════
  //
  // `shadeHit` being null is why the current frame shows sky visibility with no
  // bounce colour, and a Cornell box with no red on the white block is the
  // CORRECT picture of Phase 4. This is the picture of Phase 5: one red wall,
  // one green wall, a luminaire, and a floor that must pick up their hue.
  //
  // ══ A BOUNCE NEEDS SOMETHING TO BOUNCE, AND THE FIRST VERSION HAD NOTHING ═
  //
  // The first version lit the room with an emissive CEILING and no analytic
  // light at all. A hit on a wall then shades `emissive + rho/pi * E` with
  // E = 0 — every wall returns black, the only nonzero radiance in the room is
  // the ceiling's own emission, and the floor reads a flawless neutral 3.12.
  // That is a correct single bounce of a light that reaches surfaces by no
  // path. Colour bleed is a SECOND transport: something has to light the wall
  // before the wall can tint anything, and in SRC that "something" is the hit
  // shading's own direct term — NEE, here — or the secondary cache.
  const RED = [0.8, 0.08, 0.08];
  const GREEN = [0.08, 0.8, 0.08];
  const WHITE = [0.75, 0.75, 0.75];
  // A BROAD, DIM luminaire rather than a small bright one. Both deliver the same
  // power; a point-like source is a high-frequency term that a probe averaging
  // over a 0.4m cell cannot represent, so it would put the arbiter comparison
  // below into the paper's own blur limitation instead of measuring transport.
  const emitter = makeSphereEmitter({ center: [0, 3.2, 0], radius: 0.6, radiance: [11, 11, 11] });
  const sphere = { center: emitter.center, radius: emitter.radius };
  const surfaces = (id) => ({
    albedo: id === 6 ? [0, 0, 0] : id === 0 ? RED : id === 1 ? GREEN : WHITE,
    emissive: id === 6 ? emitter.radiance : [0, 0, 0],
    // FLAGGED: the luminaire is represented analytically (R5), so a ray landing
    // on it must not also report its emission.
    emitter: id === 6 ? 0 : -1,
  });
  const geometry = makeShadedScene({ half: 2, height: 4, surfaces, sphere });
  const shade = makeHitShader({
    surfaceAt: fixtureSurfaceAt, emitters: [emitter],
    visibility: makeVisibility(geometry, 0.1),
  });
  const cfg = makeSrcConfig({
    spacing0: 0.4, raysPerPixel: 96, forceLod: 0, sky: [0, 0, 0],
    camera: [0, 2, 0], anchor: [0, 2, 0],
  });
  // Receivers on all six faces so the transport has something to carry between.
  //
  // ══ THE PIXEL GRID HAS TO FOLLOW s0, AND NOT DOING IT READ AS 100% ═══════
  //
  // A fixed 0.4m pixel grid feeding a 0.2m lattice leaves lattice nodes with no
  // pixel on them, and a query point sitting exactly ON such a node puts all
  // eight of its trilinear weights on corners that do not exist — the gather
  // renormalizes over an empty set and returns 0, which the sweep read as
  // "refining s0 made the error 100%". The transport was fine; the instrument
  // had starved the finer level. A gbuffer is denser than the probe lattice by
  // construction, so the fixture has to be too.
  const shellPixels = (step) => {
    const out = [];
    const H = 2;
    for (let a = -H + step * 0.5; a < H; a += step) {
      for (let b = step * 0.5; b < 2 * H; b += step) {
        out.push({ position: [-H, b, a], normal: [1, 0, 0] });
        out.push({ position: [H, b, a], normal: [-1, 0, 0] });
        out.push({ position: [a, b, -H], normal: [0, 0, 1] });
        out.push({ position: [a, b, H], normal: [0, 0, -1] });
      }
      for (let b = -H + step * 0.5; b < H; b += step) {
        out.push({ position: [a, 0, b], normal: [0, 1, 0] });
        out.push({ position: [a, 2 * H, b], normal: [0, -1, 0] });
      }
    }
    return out;
  };
  const pixels = shellPixels(0.2);
  const dark = runSrcFrame(cfg, pixels, shadeTrace(geometry, () => [0, 0, 0]));
  const lit = runSrcFrame(cfg, pixels, shadeTrace(geometry, shade));
  const at = (frame, p) => gatherPixel(cfg, frame.built, frame.tiles, p, [0, 1, 0]);
  const darkFloor = at(dark, [0, 0, 0]);
  const litFloor = at(lit, [0, 0, 0]);
  check("CONTROL: with hit shading absent the floor receives exactly zero",
    darkFloor.every((v) => v === 0), `[${darkFloor.join(", ")}]`);
  check("with hit shading the floor is lit", litFloor[0] > 0.05,
    `centre floor E = [${litFloor.map((v) => v.toFixed(4))}]`);

  // THE HUE. Near the red wall the floor must be redder than at the centre, and
  // near the green wall greener — a scalar brightness check cannot tell bounce
  // colour from a global gain, and a global gain is what a broken merge looks
  // like.
  const chroma = (v) => { const s = v[0] + v[1] + v[2]; return s > 1e-12 ? v.map((c) => c / s) : [0, 0, 0]; };
  const nearRed = chroma(at(lit, [-1.5, 0, 0]));
  const centre = chroma(litFloor);
  const nearGreen = chroma(at(lit, [1.5, 0, 0]));
  console.log(`   floor chromaticity: near-red [${nearRed.map((v) => v.toFixed(3))}]  ` +
    `centre [${centre.map((v) => v.toFixed(3))}]  near-green [${nearGreen.map((v) => v.toFixed(3))}]`);
  check("the floor picks up the red wall's hue near it",
    nearRed[0] > centre[0] + 0.01 && nearRed[0] > nearGreen[0] + 0.02,
    `r fraction ${nearRed[0].toFixed(4)} vs centre ${centre[0].toFixed(4)} vs near-green ${nearGreen[0].toFixed(4)}`);
  check("and the green wall's, on the other side",
    nearGreen[1] > centre[1] + 0.01 && nearGreen[1] > nearRed[1] + 0.02,
    `g fraction ${nearGreen[1].toFixed(4)} vs centre ${centre[1].toFixed(4)} vs near-red ${nearRed[1].toFixed(4)}`);

  // ── AND THE TRANSPORT, AGAINST THE ARBITER, WITH SHADING IN THE LOOP ────
  //
  // Everything above this line is structure; this is the only arm in the suite
  // where the estimator and the arbiter disagree about SHADING as well as
  // transport, and it is the one that would catch a hit shader that is
  // self-consistent and wrong.
  //
  // The bar is the same one the unshaded transport arm uses and for the same
  // reason: the estimator is blurred at the s0 scale BY DESIGN, so an absolute
  // tolerance would be a number chosen to make today's build pass. What
  // separates blur from a bug is whether the error falls as s0 shrinks. Rays
  // scale x4 per halving so rays-per-probe stays constant — otherwise the finer
  // arm is starved rather than sharper and the sweep measures noise.
  //
  // Receivers stay >= 2*s0 from every wall for the reason the unshaded arm
  // spells out; nearer than that measures the paper's own interpolation leak,
  // which has its own arm and its own bound.
  const shadedTrace = shadeTrace(geometry, shade);
  const points = [
    { position: [0, 0.02, 0], normal: [0, 1, 0] },
    { position: [-1.0, 0.02, 0.6], normal: [0, 1, 0] },
    { position: [0.6, 0.02, -1.0], normal: [0, 1, 0] },
  ];
  const refs = points.map((p) =>
    brutePointIrradiance(p.position, p.normal, shadedTrace, [0, 0, 0], 200000, 23));
  const SWEEP = [
    { spacing0: 0.4, step: 0.2, rpp: 96 },
    { spacing0: 0.2, step: 0.1, rpp: 96 },
  ];
  const worstByLevel = [];
  for (const level of SWEEP) {
    const levelCfg = makeSrcConfig({
      spacing0: level.spacing0, raysPerPixel: level.rpp, forceLod: 0, sky: [0, 0, 0],
      camera: [0, 2, 0], anchor: [0, 2, 0],
    });
    // Pixels scale with s0, so rays-per-probe is held constant by the GRID
    // rather than by the ray budget — which is what a real gbuffer does when
    // resolveScale follows quality, and it avoids the starvation above.
    const levelPixels = level.step === 0.2 ? pixels : shellPixels(level.step);
    const frame = level.spacing0 === 0.4 ? lit : runSrcFrame(levelCfg, levelPixels, shadedTrace);
    let worstLevel = 0;
    const rows = [];
    for (let i = 0; i < points.length; i++) {
      const est = gatherPixel(levelCfg, frame.built, frame.tiles, points[i].position, points[i].normal);
      const e = Math.max(...[0, 1, 2].map((k) =>
        Math.abs(est[k] - refs[i].irradiance[k]) / Math.max(1e-6, refs[i].irradiance[k])));
      worstLevel = Math.max(worstLevel, e);
      rows.push(`(${points[i].position.map((v) => v.toFixed(1))}):${(e * 100).toFixed(1)}%`);
    }
    worstByLevel.push(worstLevel);
    console.log(`   s0=${level.spacing0} step=${level.step} rpp=${String(level.rpp).padStart(3)} ` +
      `vs brute-force MC over the same shading: ${rows.join(" ")}`);
  }
  check("shaded transport is bounded against the arbiter at every spacing",
    worstByLevel.every((v) => v < 0.2),
    worstByLevel.map((v) => `${(v * 100).toFixed(1)}%`).join(" -> "));
  check("and refining s0 does not diverge (blur, not a structural fault)",
    worstByLevel[1] < worstByLevel[0] * 1.5,
    `${(worstByLevel[0] * 100).toFixed(1)}% -> ${(worstByLevel[1] * 100).toFixed(1)}% over a halving`);

  // CANARY, the same shape the unshaded transport arm uses: a scale fault in
  // the SHADING (not the merge) must be far outside the converged bar, or the
  // two checks above are passing on a range wide enough to hide one.
  //
  // IT DARKENS RATHER THAN BRIGHTENS, and the first version did the opposite
  // and nearly passed: x1.6 on a 0.75 albedo is 1.2, which MAX_LOOP_ALBEDO
  // clamps straight back to 0.9 — a 1.2x fault, 11.6% of error, inside the bar.
  // R4's ceiling absorbing an injected fault is the ceiling working; it just
  // makes a brightening canary a poor instrument for anything else.
  {
    const brightShade = makeHitShader({
      surfaceAt: (hit, dir) => {
        const s0 = fixtureSurfaceAt(hit, dir);
        return { ...s0, albedo: s0.albedo.map((v) => v * 0.55) };
      },
      emitters: [emitter], visibility: makeVisibility(geometry, 0.1),
    });
    const broken = runSrcFrame(cfg, pixels, shadeTrace(geometry, brightShade));
    let worstBroken = 0;
    for (let i = 0; i < points.length; i++) {
      const est = gatherPixel(cfg, broken.built, broken.tiles, points[i].position, points[i].normal);
      worstBroken = Math.max(worstBroken, ...[0, 1, 2].map((k) =>
        Math.abs(est[k] - refs[i].irradiance[k]) / Math.max(1e-6, refs[i].irradiance[k])));
    }
    check("CANARY: a 0.55x albedo fault in the hit shading is far outside the bar",
      worstBroken > 0.35,
      `broken worst ${(worstBroken * 100).toFixed(1)}% vs converged ${(worstByLevel[1] * 100).toFixed(1)}%`);
  }
}

console.log("─────────────────────────────────────────────────────────────────");
if (failures) {
  console.error(`gi-src-ref: ${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("gi-src-ref: all cases PASS");
