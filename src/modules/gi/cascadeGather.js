// 3D Radiance Cascades — final gather (Phase 4).
//
// Turns the merged c0 field into per-surface irradiance:
//   E(P, N) ≈ Σ_probes w_probe · Σ_dirs L_merged(dir) · max(dot(dir, N), 0) · Δω
// over the 8 c0 probes surrounding P (trilinear), Δω = 4π / dirCount.
// Diffuse response is then albedo · E / π at the material.
//
// The probe weighting reuses the SAME distance-visibility proxy as the
// merge (cascadeMerge.js): a probe whose own c0 ray toward P records a hit
// closer than |P − probe| is behind a surface relative to P — rejected.
// This is what keeps buried/behind-wall probes (visible as dark gizmos in
// the Phase 3 screenshots) from bleeding darkness or wrong-side light onto
// receivers. c0's interval starts at t = 0, so the proxy has no near-field
// blind zone at gather range (unlike the inter-cascade case).
//
// IMPORTANT (plan constraint): this is THE sampling implementation — the
// debug gizmos and any screen-space/deferred variant must call this same
// function, so a live-editor discrepancy can only implicate glue, not a
// second transport implementation. Direct material shading here deliberately
// bypasses any G-buffer/deferred-resolve layer (where the prior attempt's
// never-root-caused stripe bug lived).
import { Fn, If, Loop, Return, cos, float, floor, fract, instanceIndex, instancedArray, max, mix, mod, select, sin, smoothstep, sqrt, step, uniform, vec3, vec4 } from "three/tsl";
import { octahedralTexelIndex, octahedralUV } from "./cascadeTrace.js";
import { sharedFn } from "./giFn.js";
import { emitterAngularRadius, emitterSlotFactor, emitterSurfaceT } from "./giLight.js";



// RELATIVE weight a BURIED probe keeps (one inside geometry — see the gather's
// buried-probe note). Deliberately a small epsilon and NOT zero: every consumer
// of these weights divides by their sum, so when at least one open probe is in
// the neighbourhood a buried one is ~50x down and effectively gone, and when
// EVERY probe is buried the epsilon cancels in the normalization and the result
// is exactly what it was before this cut existed. That is the whole
// all-rejected safety net, for free — no second accumulator, no branch. A hard
// zero would have blacked out receivers deep inside thick geometry at the low
// preset, where probes are ~2 m apart.
export const BURIED_PROBE_WEIGHT = 0.02;

/**
 * Per-probe AMBIENT-CUBE irradiance, precomputed once per frame from the
 * merged c0 field: for each probe, 6 axis irradiances
 * E_axis = π · Σ(L·cos)/Σcos over the c0 directions (the exact same
 * normalization the per-pixel gather used to evaluate inline). Receivers
 * then pay 8 probes × (1 irradiance fetch + 1 visibility fetch) instead of
 * 8 × dirCount radiance reads — ~5× fewer reads per pixel AND per feedback
 * cell, with an identical integral (it's the same sum, hoisted).
 *
 * `w` carries the probe's OPENNESS (see BURIED_PROBE_WEIGHT), computed here
 * rather than at the receiver on purpose: it is a property of the probe, so
 * paying for it once per probe instead of 8× per shaded pixel makes the cut
 * free at the point of use — the gather already fetches this vec4.
 *
 * `smoothing` (0..1, 1 = off) is a per-probe EMA toward this frame's integral.
 * GEOMETRY IS STATIC AND ONLY LIGHT MOVES, so the fixed point is unchanged: a
 * still scene converges to exactly the unsmoothed answer within a few frames
 * and looks identical. What it removes is the frame-to-frame POPPING while a
 * light sweeps, which is what the probe lattice quantizes into blocks. A zero
 * `w` means "never written" (the buffer is zero-initialised and openness is
 * never 0), so a fresh build snaps instead of fading up from black.
 */
export function createProbeIrradiance(cascades, options = {}) {
  const c0 = cascades[0];
  const { dirCount } = c0;
  const probeCount = c0.probeCount;
  const buffer = instancedArray(new Float32Array(probeCount * 6 * 4), "vec4");
  const occupancy = options.occupancy ?? null;
  const smoothing = options.smoothing ?? null;

  const compute = Fn(() => {
    const probe = instanceIndex.div(6).toVar();
    const axisIdx = instanceIndex.mod(6).toVar();
    const compF = axisIdx.div(2).toFloat().toVar(); // 0:x 1:y 2:z
    const sgn = axisIdx.mod(2).toFloat().mul(-2).add(1).toVar(); // even:+ odd:-
    const axis = vec3(
      step(compF, 0.5),
      step(0.5, compF).mul(step(compF, 1.5)),
      step(1.5, compF),
    ).mul(sgn).toVar();

    const sumL = vec3(0).toVar();
    const sumCos = float(0).toVar();
    const rowBase = probe.toFloat().mul(dirCount).toVar();
    Loop({ start: 0, end: dirCount, name: "d" }, ({ d }) => {
      const dir = c0.directionOf(d.toFloat());
      const cosTheta = max(dir.dot(axis), 0);
      sumL.addAssign(c0.merged.element(rowBase.add(d).toInt()).xyz.mul(cosTheta));
      sumCos.addAssign(cosTheta);
    });
    const irradiance = sumL.div(max(sumCos, 1e-3)).mul(Math.PI);

    // OPENNESS — "is this probe inside geometry". CONTINUOUS, not a bit:
    // the binary cut made a MOVING object pop as it swallowed each probe —
    // the whole trilinear neighbourhood lost that probe in one frame, and a
    // sweeping sphere read as banded patches snapping at every lattice
    // crossing. Fade over the probe's last level-0 voxel of clearance
    // instead (the near-field oracle is continuous by design): the ramp is
    // narrow enough that a legitimate probe half a cell off a floor keeps
    // ~full weight, while a probe about to be swallowed ramps out over
    // ~0.16m of object travel. Fully buried still lands on
    // BURIED_PROBE_WEIGHT exactly as before.
    const openness = float(1).toVar();
    if (occupancy?.occupiedAtWorld && !globalThis.__giNoBuriedProbeCut) {
      const probePos = c0.probePositionOf(probe.toFloat());
      if (occupancy.freeRadiusAtWorld && occupancy.voxel) {
        // `voxel` is the field's live UNIFORM (a TSL node, not a Vector3 —
        // Math.max on it emits NaN into the WGSL), so take the max GPU-side;
        // it also keeps the fade width correct across refits.
        const vox = vec3(occupancy.voxel);
        const fadeR = vox.x.max(vox.y).max(vox.z);
        openness.assign(
          mix(
            float(BURIED_PROBE_WEIGHT),
            float(1),
            smoothstep(float(0), fadeR, occupancy.freeRadiusAtWorld(probePos, 1)),
          ),
        );
      } else {
        openness.assign(
          mix(float(1), float(BURIED_PROBE_WEIGHT), occupancy.occupiedAtWorld(probePos, 0)),
        );
      }
    }

    const value = vec3(irradiance).toVar();
    if (smoothing) {
      const prev = buffer.element(instanceIndex).toVar();
      // ADAPTIVE HYSTERESIS (the DDGI recipe for "smoothing hides flicker but
      // lighting reacts too slowly"): the EMA's alpha is not one number. For
      // SMALL relative changes — voxel-quantization popping, ray-set churn as
      // things cross cell boundaries — keep the user's heavy smoothing. For
      // LARGE relative changes — a light or object actually moved — ramp the
      // alpha up toward `probeSnapAlpha` so the probe converges in a few
      // frames instead of ~1/alpha. The ramp runs over relative luminance
      // delta [15%, 60%]: below it is noise (checker cadence and per-cell
      // churn measure well under 15% per frame at probe scale), above it is
      // signal. `__giProbeSnap = 0` restores the fixed-alpha EMA live.
      const base = float(smoothing).clamp(0.02, 1);
      const delta = irradiance.sub(prev.xyz).abs();
      const mag = prev.x.max(prev.y).max(prev.z)
        .max(irradiance.x.max(irradiance.y).max(irradiance.z))
        .max(1e-4);
      const rel = delta.x.max(delta.y).max(delta.z).div(mag);
      const boost = smoothstep(0.15, 0.6, rel);
      const adaptive = mix(base, float(probeSnapAlpha).max(base), boost);
      // prev.w == 0 ⇒ this slot has never been written (fresh build/refit):
      // take the integral outright rather than lerping up from black.
      const alpha = select(prev.w.lessThan(1e-3), float(1), adaptive);
      value.assign(mix(prev.xyz, irradiance, alpha));
    }
    buffer.element(instanceIndex).assign(vec4(value, openness));
  })().compute(probeCount * 6);

  return { buffer, compute };
}

/**
 * LIVE RECEIVER-GATHER SURFACE BIAS, as a fraction of a probe cell along the
 * receiver's normal. Default 0.5 — user-eye-tuned against their Blender
 * reference (2026-08-03); `__giGatherBias = 0` in the console restores the
 * unbiased cage. GISystem copies the override into it every tick (the
 * hatch-must-be-a-uniform rule), so it is tunable live.
 *
 * WHY IT EXISTS: on a CURVED receiver (the test-sphere report: "weird colour
 * transitions that depend on the probe positions") the visibility cuts below
 * change which of the 8 cage probes survive as the surface normal rotates
 * through the lattice — flat surfaces are immune (coplanar probes keep full
 * weight), curved ones show the surviving-set switching as banded patches.
 * Biasing the TRILINEAR CAGE POSITION off the surface (the standard DDGI
 * surface bias) moves the cage toward open space so the surviving set changes
 * less abruptly. ONLY the cage/tent coordinates use the biased point — every
 * visibility cut still measures the TRUE receiver position and normal, so the
 * leak defences (plane cut, angle cut, proxy, buried-probe) are unchanged.
 */
export const gatherBias = uniform(0.5);

/**
 * ADAPTIVE-HYSTERESIS SNAP ALPHA (see createProbeIrradiance's EMA): the
 * per-frame blend a probe ramps TOWARD when its irradiance changes a lot in
 * one frame. 0.35 ≈ converged in ~4 frames. Live via `__giProbeSnap`
 * (0 disables adaptivity — the EMA becomes the old fixed-alpha one).
 */
export const probeSnapAlpha = uniform(0.35);

/**
 * VIEW-DIRECTION component of the same bias (fraction of a probe cell toward
 * the CAMERA), live via `__giGatherViewBias`, default 0.5 (eye-tuned with
 * the normal component above). Normal bias alone
 * fails at SILHOUETTES: grazing pixels have a normal pointing sideways, the
 * cage still lands inside the object, and a curved receiver shows a dark
 * blob just inside its outline that no reasonable normal bias removes —
 * while cranking the normal bias instead trades accuracy (the cage samples
 * open air). Pulling the cage toward the viewer is the standard DDGI split.
 * Only the screen resolve passes a real view vector; field-cell and
 * reflection-hit gathers pass vec3(0) (a zero V = normal-bias only).
 */
export const gatherViewBias = uniform(0.5);

/**
 * @param {Array} cascades from createRadianceCascades (uses cascades[0])
 * @returns {(P, N) => vec3} TSL irradiance sampler
 */
export function createIrradianceGather(cascades, probeIrradiance = null, fieldCellMax = null, name = "giGather", occupancy = null) {
  const occupancyVoxel = occupancy?.voxel ?? null;
  const c0 = cascades[0];
  const { world, grid, dirCount, dirRes } = c0;
  // All world-space quantities are UNIFORM-derived nodes (world bundle) —
  // an auto-fit refit rescales the gather with zero recompiles.
  const cellX = world.size.x.div(grid.x);
  const cellY = world.size.y.div(grid.y);
  const cellZ = world.size.z.div(grid.z);
  // Visibility tolerance must absorb the FIELD's voxel quantization: a
  // probe ray toward a receiver ON a surface legitimately records its hit
  // up to ~a voxel diagonal early; tighter rejects valid probes in
  // scallops. CRITICAL: this must scale with the FIELD cell (the trace
  // medium's quantization), NOT the probe lattice spacing — auto-fit made
  // probes ~3× coarser than voxels, and a probe-scaled tolerance was fat
  // enough that probes behind a THIN partition passed the occlusion test
  // (their ray's hit at the partition read as "within tolerance") → rooms
  // lit through thin walls at fine field resolutions.
  const quantization = fieldCellMax != null ? float(fieldCellMax) : cellX.max(cellY).max(cellZ);
  const minProbeCell = cellX.min(cellY).min(cellZ);
  // The tolerance has to absorb the TRACE MEDIUM's quantization, and with the
  // occupancy backend that medium is the pyramid, not the composited field: a
  // c0 ray's recorded hit comes from a level-0 VOXEL (0.125–0.25 m), not from a
  // 0.35 m field cell. Sizing it off the coarser number made the proxy unable
  // to reject a probe hidden behind anything thinner than 0.61 m — which is
  // most floors — so it never fired where it was needed most.
  const traceQuantization = occupancyVoxel
    ? vec3(occupancyVoxel).x.max(vec3(occupancyVoxel).y).max(vec3(occupancyVoxel).z).min(quantization)
    : quantization;
  const visTolerance = traceQuantization.mul(1.75);
  // GEOMETRY SCALE vs PROBE SCALE — the distinction the leak turned on.
  //
  // "How far behind my surface's plane can a probe sit and still be on MY side
  // of the geometry?" is a question about how THICK the geometry is. It is not
  // a question about how coarse the probe lattice is. The plane cut below used
  // `minProbeCell`, so on a 40 m volume at `low` (probeAxis 20 → 2 m probes) it
  // kept full-strength probes up to **1.2 m below a floor** — and a probe below
  // the floor is looking straight at a sun that is under the floor. That is the
  // reported "floor glows when the light comes from below", and it arrives in
  // probe-cell-sized blocks ("flickers in large squares") because the rejection
  // state flips per probe octet. It scales with the probe lattice, which is
  // exactly why it is dramatically worse at the low preset.
  //
  // The same lesson is already written above for `visTolerance` — that one was
  // moved onto the field cell and these two were not.
  //
  // THE OCCUPANCY VOXEL IS THE RIGHT SCALE when there is one, finer still than
  // the field cell: it is literally "the thinnest geometry the transport can
  // resolve", which is exactly the question this cut asks. On the user's scene
  // that is 0.125–0.25 m against a 0.35 m field cell and a 1.25 m probe
  // spacing, so a probe under a floor is rejected roughly ten times sooner than
  // the original probe-scaled cut managed. It matters because the OTHER defence
  // — the distance-visibility proxy below — cannot see a floor thinner than its
  // own tolerance, so for thin geometry this cut is the only one that fires.
  //
  // Never LOOSER than the old behaviour: `min` keeps this a tightening.
  const geometryScale = traceQuantization.min(minProbeCell);

  const gatherFn = sharedFn({
    name,
    type: "vec3",
    inputs: [
      { name: "P", type: "vec3" },
      { name: "N", type: "vec3" },
      { name: "V", type: "vec3" },
    ],
    body: (P, N, V) => {
      // Uniform-derived values hoisted into locals BEFORE the 8-corner loop —
      // uniform-buffer loads inside loops multiply driver pipeline-compile
      // time (see giField's shadow-trace note).
      const minVec = vec3(world.min).toVar();
      const probeCellVec = vec3(cellX, cellY, cellZ).toVar();
      const minProbeCellV = float(minProbeCell).toVar();
      const geomScaleV = float(geometryScale).toVar();
      const visTolV = float(visTolerance).toVar();
      // Cage position, optionally biased along the normal and toward the
      // viewer (see gatherBias/gatherViewBias above). The cuts below
      // intentionally keep using the TRUE P/N.
      const cageOffset = N.mul(float(gatherBias)).add(V.mul(float(gatherViewBias)));
      const Pb = P.add(cageOffset.mul(minProbeCellV)).toVar();
      const fcX = Pb.x.sub(minVec.x).div(probeCellVec.x).sub(0.5);
      const fcY = Pb.y.sub(minVec.y).div(probeCellVec.y).sub(0.5);
      const fcZ = Pb.z.sub(minVec.z).div(probeCellVec.z).sub(0.5);
      const baseX = floor(fcX).toVar();
      const baseY = floor(fcY).toVar();
      const baseZ = floor(fcZ).toVar();
      const fracX = fcX.sub(baseX);
      const fracY = fcY.sub(baseY);
      const fracZ = fcZ.sub(baseZ);

      const acc = vec3(0).toVar();
      const cosAcc = float(0).toVar();

      Loop({ start: 0, end: 8, name: "corner" }, ({ corner }) => {
        const cf = corner.toFloat();
        const bx = cf.mod(2);
        const by = floor(cf.div(2)).mod(2);
        const bz = floor(cf.div(4));
        const px = baseX.add(bx).clamp(0, grid.x - 1);
        const py = baseY.add(by).clamp(0, grid.y - 1);
        const pz = baseZ.add(bz).clamp(0, grid.z - 1);
        const probeIdx = pz.mul(grid.y).add(py).mul(grid.x).add(px).toVar();
        // Same lattice math as c0.probePositionOf, but from the HOISTED
        // locals (cellN = sizeN/gridN identically) — keeps the loop body free
        // of uniform loads.
        const probePos = minVec.add(vec3(px, py, pz).add(0.5).mul(probeCellVec)).toVar();

        const wx = bx.add(1).mod(2).mul(fracX.oneMinus()).add(bx.mul(fracX));
        const wy = by.add(1).mod(2).mul(fracY.oneMinus()).add(by.mul(fracY));
        const wz = bz.add(1).mod(2).mul(fracZ.oneMinus()).add(bz.mul(fracZ));
        const weight = wx.mul(wy).mul(wz).toVar();

        // BURIED PROBES CONTRIBUTE NOTHING. A probe that lands INSIDE geometry
        // — and with a 1.25 m lattice against a 0.2 m floor slab, plenty do —
        // sees that geometry's own radiance in every direction at once, so it
        // reads uniformly bright and it sits right in the trilinear
        // neighbourhood of every surface receiver near it.
        //
        // Neither existing cut catches this, because both ask the SAME
        // question and it is a different one: the distance proxy and the plane
        // cut both test whether the probe is BEHIND geometry *relative to the
        // receiver*. Neither asks whether the probe is inside geometry at all.
        //
        // It is worst with a light UNDER the floor, which is how it was found:
        // the floor slab's underside cells are then the brightest thing in the
        // scene, the probes buried in that slab inherit it, and the floor above
        // — plus everything bouncing off it — glows. A level-0 occupancy bit at
        // the probe's own position is an exact answer to "is this probe inside
        // something". `__giNoBuriedProbeCut` is the A/B arm.
        //
        // WHERE IT IS EVALUATED: on the fast path, once per probe in
        // createProbeIrradiance, carried in `w` of a vec4 this loop already
        // fetches — so the cut costs one multiply per corner here instead of a
        // pyramid walk per corner per shaded pixel. Only the legacy path (no
        // precomputed irradiance) still asks the field directly.
        if (!probeIrradiance && occupancy?.occupiedAtWorld && !globalThis.__giNoBuriedProbeCut) {
          // Continuous burial ramp, matching createProbeIrradiance's fast
          // path (see the openness comment there — a moving object popped
          // as it swallowed each probe under the binary bit).
          if (occupancy.freeRadiusAtWorld && occupancy.voxel) {
            // GPU-side max — `voxel` is a uniform node, see the fast path.
            const vox = vec3(occupancy.voxel);
            const fadeR = vox.x.max(vox.y).max(vox.z);
            weight.mulAssign(
              mix(
                float(BURIED_PROBE_WEIGHT),
                float(1),
                smoothstep(float(0), fadeR, occupancy.freeRadiusAtWorld(probePos, 1)),
              ),
            );
          } else {
            weight.mulAssign(
              mix(float(1), float(BURIED_PROBE_WEIGHT), occupancy.occupiedAtWorld(probePos, 0)),
            );
          }
        }
        // Distance-visibility proxy: the probe's own raw c0 ray toward P.
        const rel = P.sub(probePos).toVar();
        const dist = rel.length().toVar();
        If(dist.greaterThan(1e-4), () => {
          const towardP = octahedralTexelIndex(rel.div(dist), dirRes);
          const probeRay = c0.rays.element(probeIdx.mul(dirCount).add(towardP).toInt());
          // Soft rejection: fade the probe out over [tol, 2·tol] of blocker
          // penetration instead of a binary cut — the hard zero produced
          // visible blotch/scallop boundaries where the rejection state
          // flipped between neighboring receivers.
          // SHORT-RANGE probes are exempt: at grazing incidence along a flat
          // surface (ceiling/wall/floor receivers), a nearby probe's own ray
          // toward the receiver clips the surface itself and the proxy
          // rejected valid probes in per-probe scallops — the dotted/quilted
          // lattice pattern all over flat surfaces. Within ~2 probe cells the
          // metric+angular plane cuts below already handle every
          // wrong-side/through-wall case; the proxy's real value is DISTANT
          // occluders (a probe across the room behind a column).
          // The short-range exemption is for COPLANAR probes only (the
          // scallop source). A short-range probe BEHIND the receiver's plane
          // (just below a thin ceiling, viewed from outside) must keep the
          // proxy: its ray toward the receiver hits the ceiling → rejected —
          // without this, tight ultra probe spacing leaked a bright bump
          // onto the ceiling top straight above the lamp.
          const behindPlane = rel.dot(N).greaterThan(0.02);
          // A/B escape hatches, dev/harness only (scripts/run-gi-rc-lattice.mjs).
          if (!globalThis.__giNoVisProxy) {
            If(
              probeRay.w
                .greaterThanEqual(0)
                .and(dist.greaterThan(minProbeCellV.mul(2)).or(behindPlane)),
              () => {
                const penetration = dist.sub(probeRay.w);
                weight.mulAssign(smoothstep(visTolV, visTolV.mul(2), penetration).oneMinus());
              },
            );
          }
          // BACKFACE rejection, METRIC not angular: a probe on the far side
          // of a thin wall/slab/ceiling carries the other side's light, and
          // the distance proxy above can't tell (its tolerance must absorb a
          // cell of quantization — more than the wall is thick). The old
          // angular fade smoothstep(-0.5, 0, dot(dirToProbe, N)) still gave
          // a probe 0.2m BEHIND a 0.12m slab ~40% weight → rooms lit through
          // partitions, and outside faces (ceiling tops, wall backs) showed
          // the trilinear-tent × rejection lattice as a dark-diamond
          // checkerboard. Cut by DISTANCE BEHIND THE RECEIVER'S PLANE
          // instead, scaled to the probe cell: probes more than ~0.6 cells
          // behind the surface are through-geometry for any thin occluder,
          // while coplanar probes (flat floors/walls) sit at planeDist ≈ 0
          // and keep full weight.
          // Both cuts multiply: the metric one alone let OBLIQUE far probes
          // through at coarse probe spacing (bright bump on the ceiling top
          // straight above the lamp at "low"), the angular one alone leaked
          // near-plane probes through thin slabs. Together: straight-behind
          // probes die by angle, near-behind by plane distance, coplanar
          // valid probes keep full weight from both.
          const planeDist = rel.negate().dot(N);
          if (!globalThis.__giNoPlaneCut) {
            // Scaled by the GEOMETRY scale, not the probe lattice — see
            // `geometryScale`. `__giPlaneCutProbeScale` restores the old
            // probe-scaled cut (the A/B arm: if the floor stops glowing but
            // tight interiors gain dark patches, this is the knob).
            const cut = globalThis.__giPlaneCutProbeScale ? minProbeCellV : geomScaleV;
            weight.mulAssign(smoothstep(cut.mul(-0.6), cut.mul(-0.05), planeDist));
          }
          if (!globalThis.__giNoAngleCut) {
            weight.mulAssign(smoothstep(-0.45, 0.0, rel.negate().div(dist).dot(N)));
          }
        });

        if (probeIrradiance) {
          // FAST PATH: precomputed ambient-cube irradiance (see
          // createProbeIrradiance — the same π·Σ(L·cos)/Σcos integral,
          // hoisted per probe per frame). Basis blend by N² is the standard
          // HL2 ambient-cube evaluation.
          const base6 = probeIdx.mul(6).toVar();
          // Full vec4 for the x axis: .w is this probe's OPENNESS (the
          // buried-probe cut, precomputed per probe — see createProbeIrradiance).
          const ex = probeIrradiance
            .element(base6.add(select(N.x.greaterThanEqual(0), float(0), float(1))).toInt()).toVar();
          const ey = probeIrradiance
            .element(base6.add(2).add(select(N.y.greaterThanEqual(0), float(0), float(1))).toInt()).xyz;
          const ez = probeIrradiance
            .element(base6.add(4).add(select(N.z.greaterThanEqual(0), float(0), float(1))).toInt()).xyz;
          const nn = N.mul(N);
          const probeE = ex.xyz.mul(nn.x).add(ey.mul(nn.y)).add(ez.mul(nn.z));
          const probeW = weight.mul(ex.w).toVar();
          acc.addAssign(probeE.mul(probeW));
          cosAcc.addAssign(probeW);
        } else {
          // Cosine-weighted radiance sum + cosine total for this probe.
          const probeE = vec3(0).toVar();
          const probeCos = float(0).toVar();
          const rowBase = probeIdx.mul(dirCount).toVar();
          Loop({ start: 0, end: dirCount, name: "d" }, ({ d }) => {
            const dir = c0.directionOf(d.toFloat());
            const cosTheta = max(dir.dot(N), 0);
            probeE.addAssign(c0.merged.element(rowBase.add(d).toInt()).xyz.mul(cosTheta));
            probeCos.addAssign(cosTheta);
          });
          acc.addAssign(probeE.mul(weight));
          cosAcc.addAssign(probeCos.mul(weight));
        }
      });

      // OUTSIDE-VOLUME FADE. Probe coordinates clamp at the lattice edge, so
      // a receiver beyond the volume read the BOUNDARY probes' values smeared
      // to infinity — a large floor plane extending past the volume showed
      // the boundary cells as giant streaks/stripes across everything outside
      // it (the "GI goes in weird stripes" report). Fade the gather out over
      // ~1.25 probe cells past the box instead: an honest "the field ends
      // here". Analytic emitter/light terms are volume-independent and keep
      // lighting those receivers.
      const sizeVec = probeCellVec.mul(vec3(grid.x, grid.y, grid.z));
      const rel0 = P.sub(minVec);
      const outsideVec = rel0.negate().max(rel0.sub(sizeVec)).max(vec3(0));
      const fadeDist = probeCellVec.x.max(probeCellVec.y).max(probeCellVec.z).mul(1.25);
      const edgeFade = smoothstep(float(0), fadeDist, outsideVec.length()).oneMinus();

      // Fast path: acc already carries per-probe irradiance E — normalize by
      // the probe weights. Legacy path: E = π · (Σ L·cos / Σ cos), the
      // cosine-weighted AVERAGE radiance times π — exact for uniform L at any
      // direction count and bounded E ≤ π·max(L), so the feedback loop's gain
      // stays ≤ albedo < 1 (always convergent). All-probes-rejected → 0.
      if (probeIrradiance) {
        return acc.div(max(cosAcc, 1e-3)).mul(edgeFade);
      }
      return acc.div(max(cosAcc, 1e-3)).mul(Math.PI).mul(edgeFade);
    },
  });
  // V (unit toward-camera) is optional — omitted = vec3(0) = no view bias,
  // for callers with no meaningful viewer (field cells, reflection hits).
  return (P, N, V = null) => gatherFn(vec3(P), vec3(N), V ? vec3(V) : vec3(0, 0, 0));
}

/**
 * Directional radiance lookup for GLOSSY REFLECTIONS: samples the merged
 * field of one cascade along a single direction (the reflection vector),
 * trilinear over 8 probes. Cascade level trades angular sharpness against
 * spatial accuracy (higher level = finer direction bins, sparser probes) —
 * level 2 gives ~11° bins at c0DirRes 4, a soft glossy look. Mirror-sharp
 * reflections are SSR's job (engine module); this is the everything-else
 * fallback the reference demo hard-codes analytically.
 */
export function createRadianceLookup(cascades, level = 2) {
  const c = cascades[Math.min(level, cascades.length - 1)];
  const { world, grid, dirRes, dirCount } = c;
  const cellX = world.size.x.div(grid.x);
  const cellY = world.size.y.div(grid.y);
  const cellZ = world.size.z.div(grid.z);

  return Fn(([P, R]) => {
    const fcX = P.x.sub(world.min.x).div(cellX).sub(0.5);
    const fcY = P.y.sub(world.min.y).div(cellY).sub(0.5);
    const fcZ = P.z.sub(world.min.z).div(cellZ).sub(0.5);
    const baseX = floor(fcX).toVar();
    const baseY = floor(fcY).toVar();
    const baseZ = floor(fcZ).toVar();
    const fracX = fcX.sub(baseX);
    const fracY = fcY.sub(baseY);
    const fracZ = fcZ.sub(baseZ);

    // Bilinear across DIRECTION texels as well as probes: nearest-texel
    // sampling showed the octahedral bins as hard triangular facets on
    // glossy surfaces. (Fold seams are clamped, not wrapped — residual seam
    // error is far below the facets this removes.)
    const octa = octahedralUV(R, dirRes);
    const du = octa.u.sub(0.5);
    const dv = octa.v.sub(0.5);
    const du0 = floor(du).clamp(0, dirRes - 1).toVar();
    const dv0 = floor(dv).clamp(0, dirRes - 1).toVar();
    const du1 = du0.add(1).clamp(0, dirRes - 1).toVar();
    const dv1 = dv0.add(1).clamp(0, dirRes - 1).toVar();
    const fu = du.sub(floor(du)).clamp(0, 1);
    const fv = dv.sub(floor(dv)).clamp(0, 1);

    const acc = vec3(0).toVar();
    Loop({ start: 0, end: 8, name: "corner" }, ({ corner }) => {
      const cf = corner.toFloat();
      const bx = cf.mod(2);
      const by = floor(cf.div(2)).mod(2);
      const bz = floor(cf.div(4));
      const px = baseX.add(bx).clamp(0, grid.x - 1);
      const py = baseY.add(by).clamp(0, grid.y - 1);
      const pz = baseZ.add(bz).clamp(0, grid.z - 1);
      const probeIdx = pz.mul(grid.y).add(py).mul(grid.x).add(px);
      const wx = bx.add(1).mod(2).mul(fracX.oneMinus()).add(bx.mul(fracX));
      const wy = by.add(1).mod(2).mul(fracY.oneMinus()).add(by.mul(fracY));
      const wz = bz.add(1).mod(2).mul(fracZ.oneMinus()).add(bz.mul(fracZ));
      const weight = wx.mul(wy).mul(wz);
      const rowBase = probeIdx.mul(dirCount);
      const s00 = c.merged.element(rowBase.add(dv0.mul(dirRes)).add(du0).toInt()).xyz;
      const s10 = c.merged.element(rowBase.add(dv0.mul(dirRes)).add(du1).toInt()).xyz;
      const s01 = c.merged.element(rowBase.add(dv1.mul(dirRes)).add(du0).toInt()).xyz;
      const s11 = c.merged.element(rowBase.add(dv1.mul(dirRes)).add(du1).toInt()).xyz;
      const filtered = s00
        .mul(fu.oneMinus().mul(fv.oneMinus()))
        .add(s10.mul(fu.mul(fv.oneMinus())))
        .add(s01.mul(fu.oneMinus().mul(fv)))
        .add(s11.mul(fu.mul(fv)));
      acc.addAssign(filtered.mul(weight));
    });
    // Same outside-volume fade as the gather (see createIrradianceGather):
    // glossy surfaces beyond the volume otherwise streak the clamped
    // boundary probes' radiance across their whole extent.
    const cellVec = vec3(cellX, cellY, cellZ);
    const sizeVec = cellVec.mul(vec3(grid.x, grid.y, grid.z));
    const rel0 = P.sub(vec3(world.min));
    const outsideVec = rel0.negate().max(rel0.sub(sizeVec)).max(vec3(0));
    const fadeDist = cellVec.x.max(cellVec.y).max(cellVec.z).mul(1.25);
    const edgeFade = smoothstep(float(0), fadeDist, outsideVec.length()).oneMinus();
    return acc.mul(edgeFade);
  });
}

/**
 * Multi-bounce feedback (plan §3.4): per occupied voxel, gather the merged
 * c0 irradiance at the cell and write `base + albedo · E/π · gain` into the
 * LIVE radiance buffer the cascade trace reads. This is the pass that makes
 * an emissive-only Cornell box bleed: without it, surfaces lit purely by GI
 * have black voxels and reflect nothing (bounce 2+ never enters the field).
 *
 * It is a feedback loop across frames (reads last frame's merged field),
 * but it carries only the secondary energy — gain is fixed and < the
 * scene's albedo ceiling, so it converges geometrically in a few frames
 * with no hysteresis or lag heuristics. Junction cells (low normal
 * reliability, stored in surface.w) get no feedback — their normal is
 * garbage — mirroring the direct-bake gate.
 *
 * Dispatch this FIRST in the per-frame queue (before traces/merges).
 */
export function createBounceFeedback(cascades, volume, gainUniform, blendUniform, options = {}) {
  const world = volume.world;
  // Private to the feedback compute — safe to emit as a WGSL function.
  const gather = createIrradianceGather(
    cascades, options.probeIrradiance ?? null, world.cellMax, "giFeedbackGather",
    volume.occupancyField ?? null,
  );
  const { res } = volume;
  const cellCount = res.x * res.y * res.z;
  const normalLift = world.minCell.mul(1.2);
  // Per-frame analytic direct light (the Shadertoy reference's behavior:
  // sunlight is evaluated at every hit every frame, never baked — a moving
  // light updates the whole field the same frame, smoothly). Slots are
  // uniforms: light moves/edits cost ZERO rebakes.
  const lightSlots = options.lightSlots ?? null;
  // Promoted emissive meshes (analytic sphere area lights) — stripped from
  // the baked field, injected here per frame instead.
  const emitterSlots = options.emitterSlots ?? null;
  const shadowTrace = options.shadowTrace ?? null;
  // ANALYTIC-LIGHT shadows may use a different tracer than emitter shadows.
  // GISystem passes the hierarchical occupancy DDA here: the sphere march over
  // the trilinear field TUNNELS through thin slabs at coarse presets — the
  // interpolated distance is not a true lower bound, so a step can leap a
  // 0.2 m floor and land in the open air beneath it, which was the
  // "sun below the floor leaks on every preset except ultra" report. The DDA
  // walks every voxel it crosses, so it cannot tunnel at any preset. Its
  // verdict is binary; the probe EMA (probeSmoothing) owns the smoothness.
  // Emitters stay on `shadowTrace` — they need the lamp-body exclusion and
  // their soft penumbrae, and they are not the leak path.
  const lightShadow = options.lightShadow ?? shadowTrace;
  const gridDiagonal = options.gridDiagonal ?? 1e4;
  // Low/medium cost halving, restructured (see GISystem's feedback-rate note):
  // when set (a 0/1 uniform flipping per frame), each dispatch updates only the
  // cells whose index parity matches — half the work per frame, every frame,
  // instead of all of it every other frame. Skipped cells keep last frame's
  // radiance (their buffers simply aren't rewritten), and adjacent cells are on
  // opposite parities, so the trilinear/probe averaging downstream always sees
  // a half-fresh neighbourhood — the field as a whole moves EVERY frame. The
  // old whole-pass skip stair-stepped the entire field at half the light's
  // rate, which read as flicker on exactly the presets meant to be cheap.
  const checkerParity = options.checkerParity ?? null;
  // RUNTIME uniform (0 or 1): 1 blends every field shadow to fully open.
  // A `globalThis` ternary was tried here first and it silently tested
  // NOTHING: this function body runs at shader BUILD time, so a flag set in
  // the console after load never reached the compiled pipeline. GISystem owns
  // the uniform and copies `__giNoFieldShadows` into it every tick.
  const fieldShadowOff = options.fieldShadowOff ?? null;
  // STOCHASTIC AREA-LIGHT VISIBILITY — the residual-flicker fix (2026-08-03).
  // The DDA/trace verdict per cell is deterministic per frame, so a sweeping
  // sun makes each cell's visibility a SQUARE WAVE (it flips at one exact
  // angle) and the probe EMA can only stretch that flip into a slow, very
  // visible fade — "smoothed but still there", the user's exact report.
  // Jittering ONLY the shadow-ray direction over the light's angular disc
  // (R2 sequence per cell per frame) makes the EMA integrate a true
  // fractional disc visibility: a real penumbra whose value moves
  // CONTINUOUSLY with the light, so there is no step left to smooth. The
  // energy/cos/gate terms stay on the UNJITTERED direction — irradiance from
  // a small disc is ~its center value, and stable `If` gates must not churn.
  // `jitter.angle` is a LIVE uniform (radians; 0 disables — the A/B hatch).
  const jitter = options.jitter ?? null;
  // FIELD-SIDE TEMPORAL EMA (GI_FLICKER_PLAN.md Phase 1) — the freeze
  // bisect's majority arm: the field had NO integrator of its own, so every
  // binary flip born in THIS pass (a shadow ray grazing a voxel edge, the
  // DDA's oracle re-picking samples as a mover re-voxelizes) stepped the
  // whole downstream pipeline in one frame; the probe EMA downstream is the
  // only accumulator and cannot absorb field-scale churn without lagging
  // light response badly (probeSmoothing low = flicker, high = slow — the
  // user's exact complaint). Blending AT THE SOURCE turns that flip into an
  // integrable signal. `fieldSmoothing` is the RETAIN weight (0 = off, this
  // frame's value outright — the pre-Phase-1 behaviour byte-for-byte; 1 =
  // frozen). GISystem defaults its uniform to 0.95 (user-confirmed live,
  // 2026-08-03) via `__giFieldSmoothing`.
  const fieldSmoothing = options.fieldSmoothing ?? null;

  return Fn(() => {
    // Temporal ingest of streamed bakes: staging holds the latest CPU bake
    // (worker cadence, 10-15Hz); base lerps toward it every frame so bake
    // swaps spread over ~100ms instead of popping — this is the moving-
    // object flicker fix. Occupancy SNAPS (geometry presence is binary) and
    // radiance snaps with it on occupancy change, otherwise a mover's
    // leading edge would blend up from black and dim.
    const staging = volume.stagingBuffer.element(instanceIndex).toVar();
    const prev = volume.baseBuffer.element(instanceIndex).toVar();
    // Read BEFORE this frame's write (same thread, same cell — no race):
    // last frame's radiance/indirect, for the EMA below. `prev.w` (the
    // BASE buffer's occupancy flag, read a line above) doubles as "was this
    // cell occupied last frame" — the same signal the base-ingest hysteresis
    // above already keys on.
    const prevRadiance = fieldSmoothing ? volume.radianceBuffer.element(instanceIndex).toVar() : null;
    const prevIndirect =
      fieldSmoothing && volume.indirectBuffer ? volume.indirectBuffer.element(instanceIndex).toVar() : null;
    const wasEmpty = prev.w.lessThan(0.5);
    const alpha = float(1).toVar();
    If(staging.w.sub(prev.w).abs().lessThan(0.5), () => {
      alpha.assign(blendUniform);
    });
    const base = vec4(mix(prev.xyz, staging.xyz, alpha), staging.w).toVar();
    volume.baseBuffer.element(instanceIndex).assign(base);
    If(base.w.lessThan(0.5), () => {
      // Cells that just became empty must clear the live field too — the
      // CPU no longer writes radianceBuffer directly.
      volume.radianceBuffer.element(instanceIndex).assign(vec4(0, 0, 0, 0));
      if (volume.indirectBuffer) {
        volume.indirectBuffer.element(instanceIndex).assign(vec4(0, 0, 0, 0));
      }
      Return();
    });
    // Checker skip AFTER the ingest and the empty-clear (both stay full-rate:
    // ingest is cheap and geometry disappearance must clear the same frame),
    // BEFORE everything expensive. A skipped cell's radiance/indirect buffers
    // are left untouched — that is the whole mechanism.
    if (checkerParity) {
      If(instanceIndex.toFloat().mod(2).sub(checkerParity).abs().greaterThan(0.5), () => {
        Return();
      });
    }
    const surface = volume.surfaceBuffer.element(instanceIndex).toVar();
    // Hoisted local (see the uniform-loads-in-loops notes elsewhere).
    const normalLiftV = float(normalLift).toVar();
    const out = vec4(base.xyz, 1).toVar();
    // Indirect-only accumulator (emissive base + bounce, NO analytic/emitter
    // direct) — reflection hits sample this and re-evaluate direct light per
    // pixel at the exact hit, which is what keeps mirror images crisp
    // instead of cell-blurred. Kept in lockstep with `out` below.
    const indirect = vec3(base.xyz).toVar();
    // Reliability gate matches the CPU direct bake's 0.35 threshold.
    If(surface.w.greaterThan(0.35), () => {
      const idx = instanceIndex.toFloat();
      const ix = mod(idx, res.x);
      const iy = mod(floor(idx.div(res.x)), res.y);
      const iz = floor(idx.div(res.x * res.y));
      const normal = volume.normalBuffer.element(instanceIndex).xyz;
      const cellCenter = vec3(
        ix.add(0.5).mul(world.cell.x).add(world.min.x),
        iy.add(0.5).mul(world.cell.y).add(world.min.y),
        iz.add(0.5).mul(world.cell.z).add(world.min.z),
      );
      // Per-cell R2 low-discrepancy channels, advanced per frame (see the
      // `jitter` note above): under the probe EMA (~50 frames) these
      // integrate to the disc average with far less residual variance than
      // white noise would leave.
      const jitterU1 = jitter
        ? fract(fract(sin(idx.mul(12.9898)).mul(43758.5453)).add(jitter.frame.mul(0.7548776662))).toVar()
        : null;
      const jitterU2 = jitter
        ? fract(fract(sin(idx.mul(78.233)).mul(24634.6345)).add(jitter.frame.mul(0.5698402909))).toVar()
        : null;
      // Perturbs `dir` inside a cone of half-angle `angle` (radians; small-
      // angle disc offset in the tangent plane). Exactly `dir` at angle 0,
      // which is what makes the angle uniform a live kill switch.
      const jitterDir = (dir, angle) => {
        const r = sqrt(jitterU1).mul(angle).toVar();
        const phi = jitterU2.mul(Math.PI * 2).toVar();
        const up = select(dir.y.abs().greaterThan(0.9), vec3(1, 0, 0), vec3(0, 1, 0));
        const t1 = dir.cross(up).normalize().toVar();
        const t2 = dir.cross(t1).toVar();
        return dir.add(t1.mul(r.mul(cos(phi)))).add(t2.mul(r.mul(sin(phi)))).normalize();
      };

      // Analytic direct light, evaluated fresh EVERY FRAME from uniform
      // slots (never baked): |ndotl| both-sides like the CPU bake, SDF-
      // traced occlusion (smooth as the light moves — no voxel popping),
      // Lambert /π. The CPU bake now carries emissive only.
      if (lightSlots?.length && shadowTrace) {
        const rawAlbedo = surface.xyz;
        for (const slot of lightSlots) {
          If(slot.active.greaterThan(0.5), () => {
            const isDir = float(slot.kind).toVar();
            const rel = vec3(slot.vector).sub(cellCenter).toVar();
            const pointDist = rel.length().max(1e-4).toVar();
            // vector holds: point → world position, directional → the
            // normalized direction TOWARD the light.
            const dir = mix(rel.div(pointDist), vec3(slot.vector), isDir).toVar();
            const dist = mix(pointDist, float(gridDiagonal), isDir).toVar();
            let atten = mix(float(1).div(pointDist.mul(pointDist).max(1)), float(1), isDir);
            // Match three's own PointLight `distance` cutoff (0 = infinite):
            // without this, a range-limited light kept feeding the GI field
            // past where the renderer's direct light dies.
            if (slot.range) {
              const range = float(slot.range);
              const ratio = pointDist.div(range.max(1e-4)).clamp(0, 1);
              const r2 = ratio.mul(ratio);
              const win = r2.mul(r2).oneMinus().clamp(0, 1);
              atten = atten.mul(mix(float(1), win.mul(win), step(1e-3, range).mul(isDir.oneMinus())));
            }
            // ONE-SIDED: the composite gives thin geometry a shell layer per
            // side, each with its own gradient normal — so a cell only takes
            // light from its own hemisphere. The old |ndotl| both-sides rule
            // (a triangle-normal-blindness workaround) lit the OUTSIDE shell
            // of walls from lights INSIDE the room = light through walls.
            const ndotl = dir.dot(normal).max(0).toVar();
            // Dim-cell cutoff, SMOOTH: cells below the trace-worthy band
            // neither march a shadow ray nor contribute (unshadowed dim
            // adds leak through walls and get amplified by the bounce
            // loop), but the contribution FADES over [0.002, 0.006] instead
            // of vanishing at a hard threshold — the old binary skip carved
            // a visible hard-edged ring into floors/walls at the exact
            // iso-luminance surface (the "light gets cut in a circle that
            // grows as the lamp nears the floor" report).
            const energy = vec3(slot.color).mul(atten.mul(ndotl)).toVar();
            const lum = energy.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
            If(ndotl.greaterThan(1e-4).and(lum.greaterThan(0.002)), () => {
              const origin = cellCenter.add(normal.mul(normalLiftV));
              const maxT = dist.sub(normalLiftV).max(0);
              // A/B HATCH FOR THE FLICKER (`__giNoFieldShadows`, live uniform).
              // This trace is the only light-direction-dependent term in the
              // field that can jump discontinuously once `bounce` is 0:
              // `min(k·d/t)` over an ADAPTIVE-step march of a VOXEL-QUANTIZED
              // distance oracle re-picks its sample set when the ray direction
              // moves, so a smooth light rotation gives a non-smooth penumbra.
              // Its step budget is 18 at `low` and 32 at `high`, which is why
              // the artifact would track the quality preset. Toggling on makes
              // the field unshadowed — leaks are expected; the only question is
              // whether the FLICKER stops.
              // Trace direction only — energy/gates stay on the exact dir.
              const traceDir = jitter ? jitterDir(dir, jitter.angle) : dir;
              let shadow = lightShadow(origin, traceDir, maxT, float(20), ndotl);
              if (fieldShadowOff) shadow = mix(shadow, float(1), fieldShadowOff);
              const direct = rawAlbedo
                .mul(energy)
                .mul(shadow)
                .mul(smoothstep(0.002, 0.006, lum))
                .mul(1 / Math.PI);
              out.assign(vec4(out.xyz.add(direct), out.w));
            });
          });
        }
      }

      // Promoted emitters: analytic area direct — sphere slots use the
      // horizon-aware sphere factor, box slots the exact per-face form
      // factor — SDF-shadowed with k from the emitter's angular size (the
      // SAME emitterSlotFactor the receiver-side material term uses, so the
      // two stay in agreement).
      if (emitterSlots?.length && shadowTrace) {
        const rawAlbedo = surface.xyz;
        for (const slot of emitterSlots) {
          If(slot.radius.greaterThan(0.001), () => {
            const rel = vec3(slot.center).sub(cellCenter).toVar();
            const dist = rel.length().max(1e-4).toVar();
            const dir = rel.div(dist).toVar();
            // ONE-SIDED (see the analytic-slot note above) — the outside
            // shell of a wall must never take the inside lamp's light.
            // Raw cosθ feeds the HORIZON-aware sphere factor: a lamp
            // resting on a surface still lights the cells around it. Box
            // slots are one-sided by construction (receiver-facing faces
            // integrate against the cell's own normal, horizon-clamped).
            const cosTheta = dir.dot(normal).toVar();
            const sinR = float(slot.radius).div(dist).clamp(0, 1).toVar();
            const factor = emitterSlotFactor(slot, cellCenter, normal, cosTheta, sinR).toVar();
            // Dim-cell cutoff with the same SMOOTH fade as the analytic
            // gate above (a binary skip rings at the iso-luminance edge).
            const emitterEnergy = vec3(slot.color).mul(factor);
            const emitterCellLum = emitterEnergy.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
            If(factor.greaterThan(1e-6).and(emitterCellLum.greaterThan(0.002)), () => {
              const origin = cellCenter.add(normal.mul(normalLiftV));
              const k = dist.div(float(emitterAngularRadius(slot)).max(0.05)).clamp(1.2, 48);
              const maxT = emitterSurfaceT(slot, origin, dir, dist).sub(normalLiftV).max(0);
              const shadow = float(1).toVar();
              If(maxT.greaterThan(normalLiftV), () => {
                // Exclusion = lamp body + ~2 cells, NOT a fixed 2m — a
                // fixed radius exempted nearby walls from occluding. Box
                // slots dilate their OBB instead of the bounding sphere
                // (a panel's sphere swallowed the ceiling above it → the
                // field itself carried light into the next room).
                const kindF = slot.kind ? float(slot.kind) : null;
                const exRadius = kindF
                  ? mix(float(slot.radius).mul(1.5).add(normalLiftV.mul(2)), normalLiftV.mul(2), kindF)
                  : float(slot.radius).mul(1.5).add(normalLiftV.mul(2));
                const exBox = kindF
                  ? { half: mix(vec3(-1), vec3(slot.half), kindF), bx: slot.bx, by: slot.by, bz: slot.bz }
                  : null;
                // The emitter's own disc is the jitter cone (sinR = its
                // angular radius from this cell) — the estimator still
                // shapes each ray's penumbra; the jitter is what removes
                // the sample-admission churn as the geometry/light moves.
                const eAngle = jitter
                  ? select(jitter.angle.greaterThan(1e-6), sinR.min(0.4), float(0))
                  : null;
                const traceDirE = jitter ? jitterDir(dir, eAngle) : dir;
                shadow.assign(
                  shadowTrace(
                    origin, traceDirE, maxT, k, cosTheta.max(0),
                    vec3(slot.center), exRadius, exBox,
                  ),
                );
              });
              // Same live hatch as the analytic block above.
              if (fieldShadowOff) shadow.assign(mix(shadow, float(1), fieldShadowOff));
              const direct = rawAlbedo
                .mul(vec3(slot.color))
                .mul(factor.mul(1 / Math.PI))
                .mul(shadow)
                .mul(smoothstep(0.002, 0.006, emitterCellLum));
              out.assign(vec4(out.xyz.add(direct), out.w));
            });
          });
        }
      }
      // FRONT hemisphere only. The old "gather both sides, keep brighter"
      // rule existed because accumulated triangle normals were unreliable on
      // thin geometry — SDF-gradient normals are per-side correct, and the
      // both-sides rule made every wall's OUTSIDE shell re-radiate the
      // room's energy (glowing wall backs, light pools outside). max/min:
      // WGSL min/max return the non-NaN operand → NaN scrub for the loop.
      const irradiance = gather(cellCenter.add(normal.mul(normalLiftV)), normal, vec3(0)).max(vec3(0)).min(vec3(1e4));
      // Albedo clamped to 0.9: a pure-white (albedo 1.0) enclosed room makes
      // the feedback series diverge even at gain 1 — real surfaces never
      // reflect 100%, and the clamp guarantees loop gain ≤ 0.9·gainUniform.
      // Accumulates onto `out` (which already carries base + analytic direct).
      const albedo = surface.xyz.min(vec3(0.9));
      const bounceTerm = albedo.mul(irradiance).div(Math.PI).mul(gainUniform);
      out.assign(vec4(out.xyz.add(bounceTerm), 1));
      indirect.addAssign(bounceTerm);
    });
    if (fieldSmoothing) {
      // Retain weight 0 for a cell that just went empty→occupied (the
      // `wasEmpty` test from the top) — takes `out`/`indirect` outright, no
      // fade-in from black through half-lit. Every other occupied cell
      // blends toward last frame's value at the source, which is what makes
      // a shadow-ray/DDA-oracle flip an integrable ramp instead of a step
      // the whole downstream (probe EMA, screen resolve) inherits.
      const fieldAlpha = float(fieldSmoothing).toVar();
      If(wasEmpty, () => { fieldAlpha.assign(0); });
      out.assign(vec4(mix(out.xyz, prevRadiance.xyz, fieldAlpha), out.w));
      if (prevIndirect) indirect.assign(mix(indirect, prevIndirect.xyz, fieldAlpha));
    }
    volume.radianceBuffer.element(instanceIndex).assign(out);
    if (volume.indirectBuffer) {
      volume.indirectBuffer.element(instanceIndex).assign(vec4(indirect, base.w));
    }
  })().compute(cellCount);
}
