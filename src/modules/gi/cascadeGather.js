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
import { Fn, If, Loop, Return, float, floor, instanceIndex, instancedArray, max, mix, mod, select, smoothstep, step, vec3, vec4 } from "three/tsl";
import { octahedralTexelIndex, octahedralUV } from "./cascadeTrace.js";
import { sharedFn } from "./giFn.js";
import { sphereLightFactor } from "./giLight.js";



/**
 * Per-probe AMBIENT-CUBE irradiance, precomputed once per frame from the
 * merged c0 field: for each probe, 6 axis irradiances
 * E_axis = π · Σ(L·cos)/Σcos over the c0 directions (the exact same
 * normalization the per-pixel gather used to evaluate inline). Receivers
 * then pay 8 probes × (1 irradiance fetch + 1 visibility fetch) instead of
 * 8 × dirCount radiance reads — ~5× fewer reads per pixel AND per feedback
 * cell, with an identical integral (it's the same sum, hoisted).
 */
export function createProbeIrradiance(cascades) {
  const c0 = cascades[0];
  const { dirCount } = c0;
  const probeCount = c0.probeCount;
  const buffer = instancedArray(new Float32Array(probeCount * 6 * 4), "vec4");

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
    buffer.element(instanceIndex).assign(vec4(irradiance, 1));
  })().compute(probeCount * 6);

  return { buffer, compute };
}

/**
 * @param {Array} cascades from createRadianceCascades (uses cascades[0])
 * @returns {(P, N) => vec3} TSL irradiance sampler
 */
export function createIrradianceGather(cascades, probeIrradiance = null, fieldCellMax = null, name = "giGather") {
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
  const visTolerance = quantization.mul(1.75);
  const minProbeCell = cellX.min(cellY).min(cellZ);

  const gatherFn = sharedFn({
    name,
    type: "vec3",
    inputs: [
      { name: "P", type: "vec3" },
      { name: "N", type: "vec3" },
    ],
    body: (P, N) => {
      // Uniform-derived values hoisted into locals BEFORE the 8-corner loop —
      // uniform-buffer loads inside loops multiply driver pipeline-compile
      // time (see sdfScene's shadow-trace note).
      const minVec = vec3(world.min).toVar();
      const probeCellVec = vec3(cellX, cellY, cellZ).toVar();
      const minProbeCellV = float(minProbeCell).toVar();
      const visTolV = float(visTolerance).toVar();
      const fcX = P.x.sub(minVec.x).div(probeCellVec.x).sub(0.5);
      const fcY = P.y.sub(minVec.y).div(probeCellVec.y).sub(0.5);
      const fcZ = P.z.sub(minVec.z).div(probeCellVec.z).sub(0.5);
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
            weight.mulAssign(smoothstep(minProbeCellV.mul(-0.6), minProbeCellV.mul(-0.05), planeDist));
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
          const ex = probeIrradiance
            .element(base6.add(select(N.x.greaterThanEqual(0), float(0), float(1))).toInt()).xyz;
          const ey = probeIrradiance
            .element(base6.add(2).add(select(N.y.greaterThanEqual(0), float(0), float(1))).toInt()).xyz;
          const ez = probeIrradiance
            .element(base6.add(4).add(select(N.z.greaterThanEqual(0), float(0), float(1))).toInt()).xyz;
          const nn = N.mul(N);
          const probeE = ex.mul(nn.x).add(ey.mul(nn.y)).add(ez.mul(nn.z));
          acc.addAssign(probeE.mul(weight));
          cosAcc.addAssign(weight);
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

      // Fast path: acc already carries per-probe irradiance E — normalize by
      // the probe weights. Legacy path: E = π · (Σ L·cos / Σ cos), the
      // cosine-weighted AVERAGE radiance times π — exact for uniform L at any
      // direction count and bounded E ≤ π·max(L), so the feedback loop's gain
      // stays ≤ albedo < 1 (always convergent). All-probes-rejected → 0.
      if (probeIrradiance) {
        return acc.div(max(cosAcc, 1e-3));
      }
      return acc.div(max(cosAcc, 1e-3)).mul(Math.PI);
    },
  });
  return (P, N) => gatherFn(vec3(P), vec3(N));
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
    return acc;
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
  const gather = createIrradianceGather(cascades, options.probeIrradiance ?? null, world.cellMax, "giFeedbackGather");
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
  const gridDiagonal = options.gridDiagonal ?? 1e4;

  return Fn(() => {
    // Temporal ingest of streamed bakes: staging holds the latest CPU bake
    // (worker cadence, 10-15Hz); base lerps toward it every frame so bake
    // swaps spread over ~100ms instead of popping — this is the moving-
    // object flicker fix. Occupancy SNAPS (geometry presence is binary) and
    // radiance snaps with it on occupancy change, otherwise a mover's
    // leading edge would blend up from black and dim.
    const staging = volume.stagingBuffer.element(instanceIndex).toVar();
    const prev = volume.baseBuffer.element(instanceIndex).toVar();
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
              const shadow = shadowTrace(origin, dir, maxT, float(20), ndotl);
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

      // Promoted emitters: sphere-area direct, E = color·min(π, πr²/d²)·cos,
      // SDF-shadowed with k from the emitter's angular size (same model the
      // receiver-side material term uses — the two stay in agreement).
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
            // resting on a surface still lights the cells around it (the
            // factor is ~0 for cosθ ≤ −sinR, so wall backs stay dark).
            const cosTheta = dir.dot(normal).toVar();
            const sinR = float(slot.radius).div(dist).clamp(0, 1).toVar();
            const factor = sphereLightFactor(cosTheta, sinR).toVar();
            const solidAngle = float(Math.PI).mul(sinR).mul(sinR);
            // Dim-cell cutoff with the same SMOOTH fade as the analytic
            // gate above (a binary skip rings at the iso-luminance edge).
            const emitterEnergy = vec3(slot.color).mul(solidAngle).mul(factor);
            const emitterCellLum = emitterEnergy.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
            If(factor.greaterThan(1e-4).and(emitterCellLum.greaterThan(0.002)), () => {
              const origin = cellCenter.add(normal.mul(normalLiftV));
              const k = dist.div(float(slot.radius).max(0.05)).clamp(1.2, 48);
              const maxT = dist.sub(float(slot.radius)).sub(normalLiftV).max(0);
              const shadow = float(1).toVar();
              If(maxT.greaterThan(normalLiftV), () => {
                shadow.assign(
                  shadowTrace(
                    origin, dir, maxT, k, cosTheta.max(0),
                    // Exclusion = lamp body + ~2 cells, NOT a fixed 2m — a
                    // fixed radius exempted nearby walls from occluding.
                    vec3(slot.center), float(slot.radius).mul(1.5).add(normalLiftV.mul(2)),
                  ),
                );
              });
              const direct = rawAlbedo
                .mul(vec3(slot.color))
                .mul(solidAngle.mul(factor).mul(1 / Math.PI))
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
      const irradiance = gather(cellCenter.add(normal.mul(normalLiftV)), normal).max(vec3(0)).min(vec3(1e4));
      // Albedo clamped to 0.9: a pure-white (albedo 1.0) enclosed room makes
      // the feedback series diverge even at gain 1 — real surfaces never
      // reflect 100%, and the clamp guarantees loop gain ≤ 0.9·gainUniform.
      // Accumulates onto `out` (which already carries base + analytic direct).
      const albedo = surface.xyz.min(vec3(0.9));
      const bounceTerm = albedo.mul(irradiance).div(Math.PI).mul(gainUniform);
      out.assign(vec4(out.xyz.add(bounceTerm), 1));
      indirect.addAssign(bounceTerm);
    });
    volume.radianceBuffer.element(instanceIndex).assign(out);
    if (volume.indirectBuffer) {
      volume.indirectBuffer.element(instanceIndex).assign(vec4(indirect, base.w));
    }
  })().compute(cellCount);
}
