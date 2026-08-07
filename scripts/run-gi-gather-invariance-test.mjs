// GATHER INVARIANCE — is the irradiance estimator direction-count invariant?
//
// *** THIS GATE CURRENTLY FAILS, AND THAT IS ITS PURPOSE. ***
// It is registered as `npm run gate:gi-gather`, NOT as a `test:` script, because
// it is the acceptance criterion for §1g of docs/GI_NEXT_ARCHITECTURE.md rather
// than a regression guard. It describes the invariants a correct gather must
// satisfy; every failing line is a defect that is currently in the shipped
// module. When 1g lands, this goes green and can be promoted to `test:`.
//
// What it currently reports, all of it real:
//   1. c0DirRes 2 is DEGENERATE — at res 2 every one of the 4 octahedral texel
//      centres lands exactly on the equator (nz = 0), so a surface facing ±Z
//      gathers exactly ZERO indirect. Not "coarse": blind, in a whole axis.
//   2. Octahedral texels vary 2.73x in solid angle, and the estimator never
//      writes Δω down — so it is silently area-weighted, and the same source
//      reads 1.46x at the pole vs 0.75x at the map corner (1.95x spread).
//   3. Even a well-resolved 40° source drifts 2.1x across 16..4096 directions
//      instead of converging.
//   4. Sources below the texel scale are hit-or-miss, which is the emissive
//      flicker under motion.
//
// THE QUESTION THIS SETTLES. Indirect brightness moves when `c0DirRes` moves,
// which a convergent transport must not do (§1g of docs/GI_NEXT_ARCHITECTURE.md).
// Measured: bleed-rig far field 2.031e-3 / 1.339e-3 / 6.864e-4 at c0DirRes
// 4 / 8 / 16, and on the user's Sponza a 2 -> 4 change moved the indirect-only
// pixels +73%. Two very different bugs produce that, and they need opposite fixes:
//
//   (A) THE ESTIMATOR IS BIASED. `cascadeGather.js:939` computes
//       E = π · (Σ L·cosθ / Σ cosθ). That is self-normalizing and exact for
//       uniform L at ANY direction count — but only if every direction carries
//       the SAME solid angle, because the formula never writes Δω down. The
//       octahedral map's texels are not obviously equal-area. If they are not,
//       the estimator is silently weighting by texel area and the answer depends
//       on where in the sphere the light sits. That is a real normalization bug
//       and belongs in the gather.
//
//   (B) SMALL SOURCES ARE UNDER-RESOLVED. A source subtending less than one
//       texel still fills a whole texel, so it contributes L·Δω instead of L·Ω —
//       an OVER-estimate of Δω/Ω, which falls as 1/N as the texel shrinks toward
//       the source. Not a normalization bug at all; it is angular resolution, it
//       is unfixable by renormalizing, and its fix is next-event estimation /
//       the light tree (Phase 3), not a scale factor.
//
// (B) also predicts the far-field falloff being too flat: a distant emitter's
// solid angle falls as 1/d², so once it drops below one texel the estimate stops
// falling with distance and the exponent bends up — which is the -2.18-vs-2.72
// gap §1.3 has been chasing since the beginning.
//
// So: run the estimator on analytically-known radiance fields, on CPU, in
// milliseconds. Uniform L and a LARGE cap isolate (A); a sub-texel cap isolates
// (B). If the large cases are invariant and only the small one drifts, the
// normalization is CORRECT and the whole 1g framing changes.
//
// The direction set is a hand-mirror of `octahedralDirection` (cascadeTrace.js:25),
// which is TSL and cannot run here. It is transcribed operation-for-operation;
// `step(0, x)` is `x >= 0 ? 1 : 0`.

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** JS mirror of cascadeTrace.js's octahedralDirection. */
function octDir(idx, res) {
  const u = idx % res;
  const v = Math.floor(idx / res);
  const fx = ((u + 0.5) / res) * 2 - 1;
  const fy = ((v + 0.5) / res) * 2 - 1;
  const nz = 1 - Math.abs(fx) - Math.abs(fy);
  const fold = Math.max(-nz, 0);
  const sx = fx >= 0 ? 1 : -1;
  const sy = fy >= 0 ? 1 : -1;
  const nx = fx - sx * fold;
  const ny = fy - sy * fold;
  const len = Math.hypot(nx, ny, nz);
  return [nx / len, ny / len, nz / len];
}

/** Direction for an arbitrary continuous point in the octahedral square. */
function octDirUV(fx, fy) {
  const nz = 1 - Math.abs(fx) - Math.abs(fy);
  const fold = Math.max(-nz, 0);
  const sx = fx >= 0 ? 1 : -1;
  const sy = fy >= 0 ? 1 : -1;
  const nx = fx - sx * fold;
  const ny = fy - sy * fold;
  const len = Math.hypot(nx, ny, nz);
  return [nx / len, ny / len, nz / len];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * THE ESTIMATOR UNDER TEST — cascadeGather.js:906-939, legacy path.
 * E = π · (Σ L·cos / Σ cos) over all dirCount directions, cos clamped at 0.
 */
function gatherE(res, N, L) {
  let sumL = 0;
  let sumCos = 0;
  for (let d = 0; d < res * res; d++) {
    const dir = octDir(d, res);
    const c = Math.max(dot(dir, N), 0);
    sumL += L(dir) * c;
    sumCos += c;
  }
  return (Math.PI * sumL) / Math.max(sumCos, 1e-3);
}

console.log("gi-gather-invariance:");

// ── (1) IS THE OCTAHEDRAL MAP EQUAL-AREA? ────────────────────────────────────
// The estimator never writes Δω down, so it is only unbiased if every texel
// carries the same solid angle. Measure that directly by integrating the map's
// Jacobian per texel. Total must come to 4π (a check on the integrator itself).
{
  const res = 8;
  const FINE = 2048;
  const area = new Float64Array(res * res);
  let total = 0;
  const h = 1e-4;
  for (let j = 0; j < FINE; j++) {
    for (let i = 0; i < FINE; i++) {
      const fx = ((i + 0.5) / FINE) * 2 - 1;
      const fy = ((j + 0.5) / FINE) * 2 - 1;
      const d0 = octDirUV(fx, fy);
      const du = octDirUV(fx + h, fy);
      const dv = octDirUV(fx, fy + h);
      // |∂d/∂u × ∂d/∂v| — the solid angle per unit square of the map.
      const a = [(du[0] - d0[0]) / h, (du[1] - d0[1]) / h, (du[2] - d0[2]) / h];
      const b = [(dv[0] - d0[0]) / h, (dv[1] - d0[1]) / h, (dv[2] - d0[2]) / h];
      const cx = a[1] * b[2] - a[2] * b[1];
      const cy = a[2] * b[0] - a[0] * b[2];
      const cz = a[0] * b[1] - a[1] * b[0];
      const jac = Math.hypot(cx, cy, cz) * (2 / FINE) * (2 / FINE);
      const tu = Math.min(res - 1, Math.floor(((fx + 1) / 2) * res));
      const tv = Math.min(res - 1, Math.floor(((fy + 1) / 2) * res));
      area[tv * res + tu] += jac;
      total += jac;
    }
  }
  const min = Math.min(...area);
  const max = Math.max(...area);
  const mean = total / area.length;
  console.log(`  [map] total solid angle ${total.toFixed(4)} (4π = ${(4 * Math.PI).toFixed(4)})`);
  console.log(`  [map] per-texel Δω min ${min.toFixed(5)} max ${max.toFixed(5)} mean ${mean.toFixed(5)} — max/min ${(max / min).toFixed(3)}x`);
  check("the integrator reproduces 4π", Math.abs(total - 4 * Math.PI) < 0.05, `${total}`);
  // This is the (A)-vs-(B) discriminator. Report the spread either way; only
  // fail if it is large enough to matter at the magnitudes we are chasing.
  check(
    "octahedral texels are near-equal solid angle (else the estimator is area-weighted)",
    max / min < 1.6,
    `max/min = ${(max / min).toFixed(3)}x — the estimator silently weights by texel area`,
  );
}

// ── (2) UNIFORM RADIANCE — must be EXACT at every direction count ────────────
// E = ∫L cosθ dω = πL for uniform L. The estimator is algebraically exact here
// regardless of Δω, so a failure means the direction set itself is broken
// (missing/duplicated directions, a bad fold).
{
  const N = [0, 0, 1];
  let worst = 0;
  const row = [];
  for (const res of [2, 4, 8, 16, 32]) {
    const E = gatherE(res, N, () => 1);
    const err = Math.abs(E / Math.PI - 1);
    worst = Math.max(worst, err);
    row.push(`${res * res}d:${(E / Math.PI).toFixed(4)}`);
  }
  console.log(`  [uniform] E/π by direction count — ${row.join("  ")}`);
  check("uniform radiance is exact at every direction count", worst < 1e-9, `worst error ${worst.toExponential(2)}`);
}

// ── (3) A LARGE SOURCE — isolates (A) ────────────────────────────────────────
// A cone of half-angle α about the normal, uniform radiance 1:
//   E = 2π∫₀^α cosθ sinθ dθ = π sin²α — exact, no approximation.
// At α = 40° even c0DirRes 2 has directions inside the cone, so any drift here
// is the estimator, not resolution.
{
  const N = [0, 0, 1];
  const alpha = (40 * Math.PI) / 180;
  const analytic = Math.PI * Math.sin(alpha) ** 2;
  const L = (d) => (dot(d, N) >= Math.cos(alpha) ? 1 : 0);
  const ratios = [];
  const row = [];
  for (const res of [4, 8, 16, 32, 64]) {
    const r = gatherE(res, N, L) / analytic;
    ratios.push(r);
    row.push(`${res * res}d:${r.toFixed(3)}`);
  }
  console.log(`  [cap 40°] estimate/analytic — ${row.join("  ")}`);
  const drift = Math.max(...ratios) / Math.min(...ratios);
  check(
    "a WELL-RESOLVED source is direction-count invariant",
    drift < 1.15,
    `spread ${drift.toFixed(3)}x across 16..4096 directions — the estimator itself drifts`,
  );
}

// ── (4) A SUB-TEXEL SOURCE — isolates (B), AND MY FIRST PREDICTION WAS WRONG ──
// I predicted a smooth over-estimate decaying as 1/N, on the reasoning that a
// sub-texel source "fills a whole texel". It does not, because the directions
// are POINT SAMPLES at texel centres, not area integrals over texels. A source
// smaller than the texel spacing is therefore MISSED ENTIRELY unless a texel
// centre happens to land inside it, in which case it is counted at full texel
// weight. Not a smooth bias — a hit-or-miss switch.
//
// That is a much worse failure mode than the one I guessed, and it is the
// mechanism behind the user's "emissive lighting is jumpy as hell when the
// emissive light is moving": as a small emitter moves, the direction from a
// receiver to it sweeps across texel-centre boundaries, so its contribution
// POPS between full weight and nothing. Spatially the same switch across
// neighbouring probes reads as dither.
//
// So the assertion is not "over-estimated" but "wildly unreliable, in both
// directions" — which is what a moving source turns into flicker.
{
  const N = [0, 0, 1];
  const alpha = (2 * Math.PI) / 180;
  const analytic = Math.PI * Math.sin(alpha) ** 2;
  const L = (d) => (dot(d, N) >= Math.cos(alpha) ? 1 : 0);
  const row = [];
  const vals = [];
  for (const res of [4, 8, 16, 32, 64, 128]) {
    const r = gatherE(res, N, L) / analytic;
    vals.push({ res, r });
    row.push(`${res * res}d:${r.toFixed(1)}x`);
  }
  console.log(`  [cap 2°]  estimate/analytic — ${row.join("  ")}`);
  const missed = vals.filter((v) => v.r < 0.01).length;
  const hit = vals.filter((v) => v.r > 2).length;
  console.log(`  [cap 2°]  ${missed}/${vals.length} direction counts MISS the source entirely; ${hit} over-count it >2x`);
  check(
    "a sub-texel source is hit-or-miss, never approximately right",
    missed > 0 && hit > 0,
    `missed=${missed} over=${hit} — expected both failure modes present`,
  );

  // THE FLICKER ITSELF. Sweep the source across the sphere at FIXED resolution
  // and read the estimate as a time series — this is exactly what a moving
  // emitter does to a static receiver.
  //
  // Source size matters here and the first draft of this got it wrong: a 2° cone
  // is below the texel scale at EVERY resolution tested, so it is missed in all
  // 200 frames and the series is flat zero — a real defect, but not flicker.
  // Flicker needs a source COMPARABLE to the texel spacing (≈ sqrt(4π/N)), which
  // is the regime a moving emissive panel at room distance actually occupies.
  // Sweep several sizes around that scale rather than guessing one.
  const res = 16;
  const texelRad = Math.sqrt((4 * Math.PI) / (res * res)); // ≈ angular texel size
  console.log(`  [sweep]   at ${res * res} directions the texel scale is ${((texelRad * 180) / Math.PI).toFixed(1)}°`);
  let worstPeakMean = 0;
  let anyDropout = false;
  for (const mult of [0.25, 0.5, 1.0]) {
    const a2 = texelRad * mult;
    const truth = Math.PI * Math.sin(a2) ** 2;
    const series = [];
    for (let i = 0; i < 400; i++) {
      const th = (i / 400) * 0.8;
      const axis = [Math.sin(th), 0, Math.cos(th)];
      const Lm = (d) => (dot(d, axis) >= Math.cos(a2) ? 1 : 0);
      series.push(gatherE(res, N, Lm));
    }
    const mean = series.reduce((s, x) => s + x, 0) / series.length;
    const zero = series.filter((x) => x < 1e-6).length;
    const peak = Math.max(...series);
    const pm = mean > 0 ? peak / mean : Infinity;
    worstPeakMean = Math.max(worstPeakMean, pm);
    if (zero > 0) anyDropout = true;
    console.log(
      `  [sweep]   source ${((a2 * 180) / Math.PI).toFixed(1)}° (${mult}x texel): ` +
        `${zero}/400 frames see NOTHING, peak/mean ${Number.isFinite(pm) ? pm.toFixed(1) : "inf"}x, ` +
        `mean/analytic ${(mean / truth).toFixed(2)}x`,
    );
  }
  check(
    "a MOVING source near the texel scale does not flicker",
    !anyDropout && worstPeakMean < 2,
    `frames drop to zero and peaks run up to ${Number.isFinite(worstPeakMean) ? worstPeakMean.toFixed(1) : "inf"}x the mean` +
      " — this is the reported emissive jumpiness ('sometimes fine, sometimes jumps all over the place')",
  );
}

// ── (5) OFF-AXIS — does the answer depend on WHERE the source sits? ──────────
// If the texels are not equal-area, a well-resolved source of FIXED solid angle
// should read differently depending on its direction. This is (A)'s fingerprint
// and it is independent of resolution.
{
  const res = 32;
  const alpha = (30 * Math.PI) / 180;
  const analytic = Math.PI * Math.sin(alpha) ** 2;
  // Cone axis = N so the analytic form holds; rotate the whole frame instead, so
  // the source lands on different parts of the octahedral map each time.
  const frames = [
    ["+Z (texel centre-ish)", [0, 0, 1]],
    ["+X (map edge)", [1, 0, 0]],
    ["+Y", [0, 1, 0]],
    ["diagonal (map corner)", [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]],
    ["-Z (fold seam)", [0, 0, -1]],
  ];
  const ratios = [];
  for (const [name, N] of frames) {
    const L = (d) => (dot(d, N) >= Math.cos(alpha) ? 1 : 0);
    const r = gatherE(res, N, L) / analytic;
    ratios.push(r);
    console.log(`  [off-axis] ${name.padEnd(24)} estimate/analytic ${r.toFixed(4)}`);
  }
  const spread = Math.max(...ratios) / Math.min(...ratios);
  check(
    "the answer does not depend on where the source sits",
    spread < 1.1,
    `${spread.toFixed(3)}x spread across directions — area-weighting bias`,
  );
}

if (failures) {
  console.error(`gi-gather-invariance: ${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("gi-gather-invariance: all cases PASS");
