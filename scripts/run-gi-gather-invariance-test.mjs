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
// The direction set is a hand-mirror of `octahedralDirection` (srcOctahedral.js),
// which is TSL and cannot run here. It is transcribed operation-for-operation;
// `step(0, x)` is `x >= 0 ? 1 : 0`.

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** JS mirror of srcOctahedral.js's octahedralDirection. */
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
 * SOLID ANGLE OF AN OCTAHEDRAL TEXEL — the closed form, and the proposed fix.
 *
 * The octahedral map sends (fx, fy) in [-1,1]² to the unnormalized direction
 * v = (nx, ny, nz), then normalizes. For a parameterization projected onto the
 * sphere, dω = (v · (∂v/∂fx × ∂v/∂fy)) / |v|³ · dfx dfy. On the upper sheet
 * v = (fx, fy, 1-|fx|-|fy|), so ∂v/∂fx = (1,0,-sx), ∂v/∂fy = (0,1,-sy), their
 * cross is (sx, sy, 1), and
 *   v · (sx, sy, 1) = fx·sx + fy·sy + 1 - |fx| - |fy| = 1
 * identically. The lower sheet is the mirror image and gives the same thing. So
 *
 *   dω ∝ 1 / |v|³
 *
 * with |v| taken BEFORE normalization. It is 1 at the map centre (+Z) and at the
 * axis corners, and 1/0.707³ = 2.83 at the diagonal midpoints — which is the
 * 2.73x spread the Jacobian integration measures, at 8x8 texel averaging.
 *
 * One reciprocal-cube per direction, from a quantity `octahedralDirection`
 * already computes and throws away.
 */
function texelSolidAngle(idx, res) {
  const u = idx % res;
  const v = Math.floor(idx / res);
  const fx = ((u + 0.5) / res) * 2 - 1;
  const fy = ((v + 0.5) / res) * 2 - 1;
  const nz = 1 - Math.abs(fx) - Math.abs(fy);
  const fold = Math.max(-nz, 0);
  const nx = fx - (fx >= 0 ? 1 : -1) * fold;
  const ny = fy - (fy >= 0 ? 1 : -1) * fold;
  const len = Math.hypot(nx, ny, nz);
  return 1 / (len * len * len);
}

/**
 * THE ESTIMATOR — cascadeGather.js:906-939, legacy path.
 * E = π · (Σ L·cos·w / Σ cos·w). With w ≡ 1 this is the SHIPPED form, which
 * assumes every direction carries the same solid angle. With w = texel solid
 * angle it is the proposed fix. Both stay exact for uniform L by construction,
 * so the fix cannot regress the one property the current form does have.
 */
function gatherE(res, N, L, weighted = false) {
  let sumL = 0;
  let sumCos = 0;
  for (let d = 0; d < res * res; d++) {
    const dir = octDir(d, res);
    const w = weighted ? texelSolidAngle(d, res) : 1;
    const c = Math.max(dot(dir, N), 0) * w;
    sumL += L(dir) * c;
    sumCos += c;
  }
  return (Math.PI * sumL) / Math.max(sumCos, 1e-3);
}

console.log("gi-gather-invariance:");

// ── (0) THE CHEAP FORM OF THE WEIGHT ─────────────────────────────────────────
// 1/|v|³ needs the UNNORMALIZED direction, which the shader computes and throws
// away. But the octahedral map places that vector on the octahedron |x|+|y|+|z| = 1
// (upper sheet: |fx| + |fy| + (1-|fx|-|fy|) = 1; the folded lower sheet gives the
// same, e.g. f = (0.8, 0.8) -> v = (0.2, 0.2, -0.6)). So for a NORMALIZED d,
//   |v| = 1 / (|dx| + |dy| + |dz|)   and   Δω ∝ (|dx| + |dy| + |dz|)³
// which is 3 abs, 2 adds and 2 muls on a value the gather loop already holds —
// no second decode. Verify the identity before building on it.
{
  let worst = 0;
  for (const res of [2, 4, 8, 16, 32]) {
    for (let d = 0; d < res * res; d++) {
      const dir = octDir(d, res);
      const cheap = (Math.abs(dir[0]) + Math.abs(dir[1]) + Math.abs(dir[2])) ** 3;
      const exact = texelSolidAngle(d, res);
      worst = Math.max(worst, Math.abs(cheap / exact - 1));
    }
  }
  check(
    "(|dx|+|dy|+|dz|)³ equals 1/|v|³ — the weight is free from the normalized direction",
    worst < 1e-9,
    `worst relative error ${worst.toExponential(2)}`,
  );
}

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
  // TWO SEPARATE PROPERTIES, and conflating them is how a first draft of this
  // test produced a meaningless failure for BOTH estimators. At 16 directions a
  // 40° cap is genuinely under-resolved and no normalization can rescue it — so
  // "invariant across 16..4096 directions" is not a property any correct gather
  // has. What a correct gather must have is (a) the right LIMIT, and (b)
  // invariance once the source is actually resolved.
  const RESOLVED_FROM = 16; // res 16 = 256 directions
  for (const weighted of [false, true]) {
    const ratios = [];
    const resolved = [];
    const row = [];
    for (const res of [4, 8, 16, 32, 64]) {
      const r = gatherE(res, N, L, weighted) / analytic;
      ratios.push(r);
      if (res >= RESOLVED_FROM) resolved.push(r);
      row.push(`${res * res}d:${r.toFixed(3)}`);
    }
    const limit = ratios[ratios.length - 1];
    const drift = Math.max(...resolved) / Math.min(...resolved);
    const tag = weighted ? "Δω-weighted" : "SHIPPED    ";
    console.log(
      `  [cap 40°] ${tag} estimate/analytic — ${row.join("  ")}   limit ${limit.toFixed(3)}  resolved-spread ${drift.toFixed(3)}x`,
    );
    check(
      `converges to the ANALYTIC value (${weighted ? "Δω-weighted" : "shipped"})`,
      Math.abs(limit - 1) < 0.05,
      `limit is ${limit.toFixed(3)}x analytic — off by ${((limit - 1) * 100).toFixed(0)}%`,
    );
    check(
      `is invariant once RESOLVED, 256..4096 directions (${weighted ? "Δω-weighted" : "shipped"})`,
      drift < 1.08,
      `spread ${drift.toFixed(3)}x`,
    );
  }
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
  // AT TWO RESOLUTIONS, to tell BIAS from QUANTIZATION. A genuine area-weighting
  // bias is a property of the map and does not shrink when you add directions; a
  // point-sampling residual does. Reporting one resolution cannot distinguish
  // them, and the difference decides whether there is anything left to fix.
  for (const weighted of [false, true]) {
    const spreads = [];
    for (const r0 of [res, res * 2]) {
      const ratios = [];
      for (const [name, N] of frames) {
        const L = (d) => (dot(d, N) >= Math.cos(alpha) ? 1 : 0);
        const r = gatherE(r0, N, L, weighted) / analytic;
        ratios.push(r);
        if (r0 === res) {
          console.log(
            `  [off-axis] ${weighted ? "Δω" : "  "} ${name.padEnd(24)} estimate/analytic ${r.toFixed(4)}`,
          );
        }
      }
      spreads.push(Math.max(...ratios) / Math.min(...ratios));
    }
    const tag = weighted ? "Δω-weighted" : "shipped";
    console.log(
      `  [off-axis] ${tag}: spread ${spreads[0].toFixed(3)}x at ${res * res}d, ` +
        `${spreads[1].toFixed(3)}x at ${res * res * 4}d ` +
        // Compare DEVIATIONS FROM 1, not the ratios themselves: 1.128 -> 1.031 is
        // a 4x reduction in error but only a 9% reduction in the ratio, so a
        // ratio comparison mislabels a converging estimator as biased.
        `(${spreads[1] - 1 < (spreads[0] - 1) * 0.8 ? "SHRINKING -> quantization" : "PERSISTENT -> real bias"})`,
    );
    check(
      `the answer does not depend on where the source sits (${tag})`,
      spreads[1] < 1.1,
      `${spreads[1].toFixed(3)}x spread at ${res * res * 4} directions`,
    );
  }
}

// ── (6) THE CASCADE LADDER'S ANGULAR FOOTPRINT ───────────────────────────────
// Radiance Cascades' whole premise is that angular resolution rises with
// distance exactly fast enough that the LINEAR footprint of one direction stays
// roughly constant — that is what lets a coarse probe lattice resolve distant
// geometry. Interval n has length t0·2^n and dirRes 2^n, so footprint
// ≈ sqrt(4π/dirCount)·distance is invariant across the ladder. By construction.
//
// EXCEPT FOR THE LAST CASCADE. `cascadeTrace.js:163` reads
//     const intervalLen = isLast ? float(farTU) : t0U.mul(BRANCH ** level);
// so the outermost cascade is a CATCH-ALL: its interval is the whole volume
// (farT = 2·max(size)) rather than its ladder value, while its direction count
// is only the ladder's. Its angular resolution is therefore sized for the START
// of its interval and used all the way to the far edge of the world.
//
// Anything beyond that break is under-resolved, which is precisely the
// hit-or-miss regime measured in (4): a source smaller than the footprint is
// sampled by luck, and moving it makes the luck change frame to frame. So this
// computes where the break starts for a given config — i.e. how far away an
// object has to be before it is allowed to flicker.
{
  const cfg = (name, t0, c0DirRes, cascadeCount, sizeMax, voxelSize) => {
    console.log(`  [ladder] ${name}: probeSpacing ${t0}, c0DirRes ${c0DirRes}, cascades ${cascadeCount}, voxel ${voxelSize}, size ${sizeMax}`);
    const farT = sizeMax * 2;
    let worst = 0;
    let best = Infinity;
    let breakAt = null;
    for (let n = 0; n < cascadeCount; n++) {
      const tMin = t0 * (2 ** n - 1);
      const isLast = n === cascadeCount - 1;
      const len = isLast ? farT : t0 * 2 ** n;
      const far = tMin + len;
      const dirCount = (c0DirRes * 2 ** n) ** 2;
      const ang = Math.sqrt((4 * Math.PI) / dirCount);
      const fp = ang * far;
      const ratio = fp / voxelSize;
      if (ratio > 1.5 && breakAt === null) breakAt = tMin;
      worst = Math.max(worst, ratio);
      best = Math.min(best, ratio);
      console.log(
        `  [ladder]   c${n}: ${tMin.toFixed(2)}-${far.toFixed(2)}m  ${String(dirCount).padStart(5)} dirs  ` +
          `footprint ${fp.toFixed(2)}m = ${ratio.toFixed(1)}x voxel${isLast ? "   <- CATCH-ALL interval" : ""}`,
      );
    }
    return { worst, best, breakAt };
  };
  // REAL values, read from the running editor's build log — NOT the stored props.
  // `autoFit` is on, so `probeSpacing` is whatever the fit chose and the stored
  // 0.25 is ignored entirely:
  //   [gi] built: 42.9x19.8x27.5m (auto-fit custom, voxel 0.34, probes 1.10),
  //        128x59x82 cells, c0 39x18x25, 5 cascades (branch 2)
  // Using the stored props here produced a footprint table that was wrong by 4x
  // and a conclusion ("under-resolved only beyond 3.8m") that did not survive
  // the real numbers.
  const user = cfg("user Sponza (from the build log)", 1.1, 4, 5, 42.9, 0.34);
  console.log(
    `  [ladder] worst footprint ${user.worst.toFixed(1)}x voxel size — ` +
      "a source SMALLER than the footprint is sampled hit-or-miss",
  );
  // NOT "footprint <= 1.5 voxels". That criterion is unreachable by construction
  // and asserting it would condemn a correctly-configured RC field: closing it
  // on this scene needs c0DirRes 32 (vs 4) or a 5.8x finer probe grid, i.e. 64x
  // or 195x the cost. Footprint ~2-5 voxels IS the RC design point — the merge
  // and the 8-probe trilinear gather are what make it work for area sources.
  //
  // What is NOT acceptable is relying on ray marching for sources smaller than
  // the footprint. Those get sampled by luck (case 4), and moving them makes the
  // luck change frame to frame. So the invariant is about the LADDER'S SHAPE:
  // the footprint must be roughly CONSTANT across cascades, which is the entire
  // premise of RC. A level that breaks that pattern is a real defect, and the
  // catch-all last interval does exactly that.
  const consistent = user.worst / user.best;
  console.log(`  [ladder] footprint consistency across the ladder: ${consistent.toFixed(1)}x (RC premise: ~1x)`);
  check(
    "the angular footprint is CONSTANT across cascades (the RC invariant)",
    consistent < 2,
    `${consistent.toFixed(1)}x spread — the last interval is a catch-all (farT, not its ladder value), ` +
      "so its direction count is sized for the START of an interval that runs to the edge of the world",
  );

  // HOW MANY CASCADES WOULD IT TAKE? The ladder reaches t0·(2^n − 1); once that
  // covers farT the last interval is no longer a catch-all and the invariant
  // holds all the way out. Cost is the reason this is not obviously free, so
  // price it: directions go x4 per level while the probe grid goes /8 — until
  // the grid floors at 1x1x1 (`Math.max(1, round(c0Grid/div))` in
  // cascadeTrace.js), after which each level is a straight x4. Rays per level is
  // the honest cost proxy.
  // Real values from the build log, not the stored props (see above).
  const t0 = 1.1;
  const farT = 85.8; // 2 x max axis, 42.9m
  const c0DirRes = 4;
  const gx = 39;
  const gy = 18;
  const gz = 25; // c0 39x18x25, and MAX_PROBE_AXIS is 48 so this is not clamped
  console.log("  [cost]   cascades needed for the ladder to cover the volume:");
  let cum0 = null;
  for (let count = 5; count <= 10; count++) {
    const reach = t0 * (2 ** (count - 1) - 1);
    let rays = 0;
    let worstFp = 0;
    for (let n = 0; n < count; n++) {
      const div = 2 ** n;
      const probes =
        Math.max(1, Math.round(gx / div)) * Math.max(1, Math.round(gy / div)) * Math.max(1, Math.round(gz / div));
      const dirCount = (c0DirRes * div) ** 2;
      rays += probes * dirCount;
      const tMin = t0 * (2 ** n - 1);
      const len = n === count - 1 ? farT : t0 * 2 ** n;
      worstFp = Math.max(worstFp, Math.sqrt((4 * Math.PI) / dirCount) * (tMin + len));
    }
    if (cum0 === null) cum0 = rays;
    console.log(
      `  [cost]     ${count} cascades: ladder reaches ${reach.toFixed(1).padStart(6)}m  ` +
        `worst footprint ${(worstFp / 0.34).toFixed(1).padStart(5)}x voxel  ` +
        `rays ${(rays / 1e6).toFixed(1)}M (${(rays / cum0).toFixed(2)}x of 5-cascade)`,
    );
  }
}

if (failures) {
  console.error(`gi-gather-invariance: ${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("gi-gather-invariance: all cases PASS");
