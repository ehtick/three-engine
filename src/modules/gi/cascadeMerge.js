// 3D Radiance Cascades — same-frame hierarchical merge (Phase 2).
//
// This is the pass the Shadertoy reference could not do: it merged
// temporally (reading last FRAME's coarser cascade) because Shadertoy has a
// single self-feedback buffer, and its comments blame exactly that for the
// flickering and light lag. Here each cascade's merge is its own compute
// dispatch, ordered coarsest → finest inside one renderer.compute(queue)
// submit, so cascade i reads cascade i+1's ALREADY-MERGED same-frame output.
//
// Per ray of cascade i:
//   hit in own interval  → radiance is its own (opaque hit blocks the far field)
//   miss                 → continue the ray into cascade i+1: 8 surrounding
//                          parent probes (trilinear) × the ray's 4 angular
//                          child directions, averaged.
//
// Spatial weighting adapts the reference's WeightedSample visibility proxy
// from its surfel/tangent-frame form to full 3D: each parent probe's stored
// hit distance in the direction toward the child probe is treated as an
// occlusion proxy — if the parent's own ray that way hit something closer
// than the child, that parent is behind a wall and its weight is zeroed.
// Approximate on purpose (a parent's annular interval doesn't cover its own
// near field), same spirit as the reference's "flatland assumption" note.
import { Fn, If, Loop, float, floor, instanceIndex, instancedArray, max, mix, mod, select, smoothstep, vec3, vec4 } from "three/tsl";
import { octahedralTexelIndex, octahedralUV } from "./cascadeTrace.js";
import { BURIED_PROBE_WEIGHT } from "./cascadeGather.js";

/**
 * Builds merged-result buffers + merge computes for a cascade array made by
 * createRadianceCascades. Returns `mergeComputes` already ordered coarse →
 * fine (dispatch them in that order, after all trace computes).
 *
 * @param {Array} cascades from createRadianceCascades
 * @param {object} [opts]
 * @param {[number, number, number]|object} [opts.sky] radiance for rays that
 *   escape the outermost cascade — a literal triple, or a TSL node (GISystem
 *   passes a uniform so the sky is a live control, not a rebuild). Default
 *   black; the sealed-room checks depend on escapes contributing nothing.
 *
 *   THIS IS THE SCENE'S SKY LIGHT, and it is the only way any enters GI.
 *   A ray only reaches here by leaving the volume without hitting anything —
 *   i.e. it found its way out to open air — so a CONSTANT radiance here is
 *   already correctly occluded: an interior gets sky only through whatever
 *   openings actually see it, at the solid angle they actually subtend. With
 *   it at black, the only thing that can light a shadowed surface is
 *   multi-bounce off directly-lit ones, and since each bounce loses a factor
 *   of albedo, shadows in an open scene (Sponza's courtyard) collapse to
 *   near-black while a reference renderer with an ordinary world colour keeps
 *   them open. That was the whole visible gap in the side-by-side.
 */
// Blocker penetration (in FIELD voxels) over which a parent probe fades out of
// the merge. Matches the final gather's tolerance — see the long note at the
// use site for why a binary cut is what produced the lattice artifact.
// `globalThis.__giMergeVisTol` overrides it for harness A/Bs (read per build,
// not at module load — the harness sets it after the module is imported).
const DEFAULT_MERGE_VIS_TOLERANCE = 1.75;

export function createCascadeMerge(cascades, { sky = [0, 0, 0], occupancyVoxel = null, occupancy = null } = {}) {
  const MERGE_VIS_TOLERANCE = Number(globalThis.__giMergeVisTol) || DEFAULT_MERGE_VIS_TOLERANCE;
  // See the use site: the visibility proxy's tolerance must track whatever the
  // rays actually traced. `min` with the field cell keeps it a tightening.
  const traceQuantization = occupancyVoxel
    ? vec3(occupancyVoxel).x.max(vec3(occupancyVoxel).y).max(vec3(occupancyVoxel).z)
        .min(float(cascades[0].world.cellMax))
    : float(cascades[0].world.cellMax);
  // Accepts a literal triple (tests, defaults) or a node/uniform (GISystem).
  const skyNode = Array.isArray(sky) ? vec3(sky[0], sky[1], sky[2]) : vec3(sky);
  for (const cascade of cascades) {
    cascade.merged = instancedArray(cascade.probeCount * cascade.dirCount, "vec4");
    cascade.mergedAverages = instancedArray(cascade.probeCount, "vec3");
  }

  const mergeComputes = [];
  // Per-probe means of the merged field — read ONLY by the debug gizmos,
  // so the caller dispatches them only while a probe debug view is open.
  const averageComputes = [];

  // ── THE PARENT'S RAY IS BLIND EXACTLY WHERE THE MERGE NEEDS IT MOST ───────
  //
  // Cascade i's rays start at `tMin = t0·(2^i − 1)` — the interval is an
  // ANNULUS, and everything nearer than tMin is a hole the parent never traced.
  // A parent whose ray toward the child found nothing stores w = -1, and the
  // proxy below treats w < 0 as "no blocker", i.e. FULL WEIGHT. That is absence
  // of evidence read as evidence of absence.
  //
  // Now put numbers on it (t0 IS the c0 probe spacing here — GISystem passes
  // `t0: probeSpacing`). Merging level L from its parent L+1:
  //     parent blind radius = t0·(2^(L+1) − 1)
  //     parent spacing      = t0·2^(L+1)
  // so the 8 corner parents sit at 0 … √3·2^(L+1)·t0 while the blind radius is
  // one whole t0 short of the spacing. At L=1 that is a 3·t0 hole against a
  // 4·t0 lattice: **every corner parent nearer than 3·t0 is invisible to the
  // proxy — and those are precisely the ones carrying the highest trilinear
  // weight.** The nearest, heaviest taps are the least verified ones, at every
  // level ≥ 1. A parent under a floor merges straight up into a child standing
  // in the room above, which is the reported "floor glows when the sun is
  // underneath", arriving in coarse-cascade-sized blocks that pop as the light
  // sweeps ("jumpy, squarish"), worst at `low` where the lattice is coarsest.
  //
  // Fix: ask the OCCUPANCY FIELD directly — march the segment child→parent and
  // record whether anything is in the way. Two properties make this cheap:
  //   · it depends only on the two POSITIONS, not on the ray direction, so it
  //     is hoisted out of the per-ray loop and costs one trace per (probe,
  //     corner) instead of one per (ray, corner) — dirCount× fewer, 16× at c0
  //     and 1024× at c5;
  //   · it depends only on GEOMETRY, so the caller re-runs these only on
  //     composite frames (when the pyramid changed), not every frame.
  // One shared buffer across all levels, because storage-buffer bindings are a
  // scarce resource in this module (see the 8-binding wall in the notes).
  const visOffsets = [];
  let visTotal = 0;
  for (let level = 0; level < cascades.length - 1; level++) {
    visOffsets.push(visTotal);
    visTotal += cascades[level].probeCount * 8;
  }
  const useParentVis = !!occupancy?.traceOccupancy && !globalThis.__giNoParentVis;
  const parentVis = useParentVis ? instancedArray(Math.max(1, visTotal), "float") : null;
  const visComputes = [];

  for (let level = cascades.length - 1; level >= 0; level--) {
    const cascade = cascades[level];
    const parent = cascades[level + 1] ?? null;
    const { dirCount, dirRes, probeCount, rays, merged } = cascade;
    const visBase = parent && parentVis ? visOffsets[level] : 0;

    // Parent lattice mapping, shared by the visibility prepass and the merge —
    // they MUST agree corner-for-corner or the prepass answers about a
    // different probe than the one being weighted.
    const parentCellOf = (world) => ({
      x: world.size.x.div(parent.grid.x),
      y: world.size.y.div(parent.grid.y),
      z: world.size.z.div(parent.grid.z),
    });
    const cornerAxes = (cf) => ({
      bx: mod(cf, 2),
      by: mod(floor(cf.div(2)), 2),
      bz: floor(cf.div(4)),
    });

    if (parent && parentVis) {
      const world = cascade.world;
      const pCell = parentCellOf(world);
      const visCompute = Fn(() => {
        const probeIdxF = instanceIndex.div(8).toFloat().toVar();
        const cf = instanceIndex.mod(8).toFloat().toVar();
        const childPos = cascade.probePositionOf(probeIdxF).toVar();
        const { bx, by, bz } = cornerAxes(cf);
        const px = floor(childPos.x.sub(world.min.x).div(pCell.x).sub(0.5))
          .add(bx).clamp(0, parent.grid.x - 1);
        const py = floor(childPos.y.sub(world.min.y).div(pCell.y).sub(0.5))
          .add(by).clamp(0, parent.grid.y - 1);
        const pz = floor(childPos.z.sub(world.min.z).div(pCell.z).sub(0.5))
          .add(bz).clamp(0, parent.grid.z - 1);
        const parentProbeIdx = pz.mul(parent.grid.y).add(py).mul(parent.grid.x).add(px);
        const parentPos = parent.probePositionOf(parentProbeIdx).toVar();
        const rel = parentPos.sub(childPos).toVar();
        const dist = rel.length().toVar();
        // Same self-bias as the transport rays (createOccupancySceneTrace): a
        // probe resting on a surface must not instantly hit the voxel it lives
        // in. If the child IS buried, every corner comes back blocked and the
        // epsilon cancels in the merge's normalization — no blackout.
        const bias = float(cascade.world.minCell).mul(0.25).toVar();
        const blocked = float(0).toVar();
        If(dist.greaterThan(bias.mul(4)), () => {
          // `dynamics: false` — this prepass re-runs only on composite frames
          // (geometry changes), so per-frame exact-dynamic objects must not
          // leak into it: a mover's stale verdict here would gate the merge
          // wrongly for whole frames. Movers never participated when they
          // were voxelized either (transform updates don't recomposite).
          const r = occupancy.traceOccupancy(
            childPos, rel.div(dist), bias, dist.sub(bias), { steps: 48, dynamics: false },
          );
          blocked.assign(r.hit);
        });
        parentVis.element(instanceIndex.add(visBase).toInt()).assign(blocked);
      })().compute(probeCount * 8);
      visComputes.push(visCompute);
    }

    const merge = Fn(() => {
      const own = rays.element(instanceIndex).toVar();
      const out = vec4(0, 0, 0, -1).toVar();

      If(own.w.greaterThan(0), () => {
        out.assign(own);
      }).Else(() => {
        if (!parent) {
          // Escaped the outermost cascade without hitting anything: it got
          // out to open air, so it brings the sky back. w stays -1 (miss), so
          // nothing downstream treats this as a surface hit.
          out.assign(vec4(skyNode, -1));
        } else {
          const rayIdx = instanceIndex.toFloat();
          const probeIdx = floor(rayIdx.div(dirCount));
          const dirIdx = mod(rayIdx, dirCount);
          const childPos = cascade.probePositionOf(probeIdx).toVar();

          // The ray's 4 angular children in the parent's (finer-angular)
          // octahedral tile: texel (u,v)@R subdivides into the 2x2 block at
          // (2u, 2v)@2R.
          const u = mod(dirIdx, dirRes);
          const v = floor(dirIdx.div(dirRes));
          const parentDirBase = v.mul(2).mul(parent.dirRes).add(u.mul(2));

          // Continuous coords of the child position in the parent's
          // cell-centered lattice. World params are UNIFORMS (see the
          // world bundle) so a refit re-maps the lattice with no recompile.
          const world = cascade.world;
          const cellX = world.size.x.div(parent.grid.x);
          const cellY = world.size.y.div(parent.grid.y);
          const cellZ = world.size.z.div(parent.grid.z);
          const fcX = childPos.x.sub(world.min.x).div(cellX).sub(0.5);
          const fcY = childPos.y.sub(world.min.y).div(cellY).sub(0.5);
          const fcZ = childPos.z.sub(world.min.z).div(cellZ).sub(0.5);
          const baseX = floor(fcX).toVar();
          const baseY = floor(fcY).toVar();
          const baseZ = floor(fcZ).toVar();
          const fracX = fcX.sub(baseX);
          const fracY = fcY.sub(baseY);
          const fracZ = fcZ.sub(baseZ);

          const acc = vec3(0).toVar();
          const weightSum = float(0).toVar();

          Loop({ start: 0, end: 8, name: "corner" }, ({ corner }) => {
            const cf = corner.toFloat();
            const bx = mod(cf, 2);
            const by = mod(floor(cf.div(2)), 2);
            const bz = floor(cf.div(4));
            const px = baseX.add(bx).clamp(0, parent.grid.x - 1);
            const py = baseY.add(by).clamp(0, parent.grid.y - 1);
            const pz = baseZ.add(bz).clamp(0, parent.grid.z - 1);
            const parentProbeIdx = pz.mul(parent.grid.y).add(py).mul(parent.grid.x).add(px).toVar();
            const parentPos = parent.probePositionOf(parentProbeIdx).toVar();

            const wx = mod(bx.add(1), 2).mul(fracX.oneMinus()).add(bx.mul(fracX));
            const wy = mod(by.add(1), 2).mul(fracY.oneMinus()).add(by.mul(fracY));
            const wz = mod(bz.add(1), 2).mul(fracZ.oneMinus()).add(bz.mul(fracZ));
            const weight = wx.mul(wy).mul(wz).toVar();

            // BURIED PARENTS CONTRIBUTE (almost) NOTHING — the merge's half of
            // the cut the final gather already got. A parent probe inside
            // geometry carries that geometry's own radiance, and the visibility
            // proxy below CANNOT catch it: the proxy asks "did the parent's ray
            // toward the child hit something first", and a probe buried in a
            // 0.2 m slab has an unobstructed ray out of the slab in most
            // directions, so it reports no blocker and keeps full weight.
            //
            // This path matters more than the gather's, not less. Coarse
            // cascades are where the probe lattice is metres wide, so a parent
            // buried in a floor is merged into children several metres away —
            // it is the mechanism by which a sun UNDER the floor reaches probes
            // standing in the room above, which the receiver-side plane cut
            // never sees because by then the light is already IN the fine
            // cascade's own radiance. Epsilon, not zero: `weightSum` below
            // normalizes, so an all-buried neighbourhood behaves exactly as it
            // did before (see BURIED_PROBE_WEIGHT).
            //
            // Combined with the inter-probe occlusion prepass by MIN, not by
            // product: "the worst evidence wins" keeps the floor at exactly
            // BURIED_PROBE_WEIGHT, which is what makes an all-rejected corner
            // set cancel cleanly in the normalization. Two multiplied epsilons
            // would not.
            const openness = float(1).toVar();
            if (occupancy?.occupiedAtWorld && !globalThis.__giNoBuriedProbeCut) {
              openness.assign(
                mix(float(1), float(BURIED_PROBE_WEIGHT), occupancy.occupiedAtWorld(parentPos, 0)),
              );
            }
            if (parentVis) {
              // Is there geometry BETWEEN this child and this parent — the
              // question the parent's own blind annulus cannot answer.
              // Precomputed per (probe, corner), refreshed only when geometry
              // changes, so this is one buffer read.
              const blockedTap = parentVis.element(
                probeIdx.toInt().mul(8).add(corner).add(visBase).toInt(),
              );
              openness.assign(
                openness.min(mix(float(1), float(BURIED_PROBE_WEIGHT), blockedTap)),
              );
            }
            weight.mulAssign(openness);

            // Visibility proxy: the parent's own ray toward the child.
            //
            // SOFT, NOT BINARY — this is the fix for the "dotted grid / quilted
            // lattice on flat walls" artifact (measured with
            // scripts/run-gi-rc-lattice.mjs). The old rule was
            // `if (parentRay.w < dist) weight = 0`, a hard flip, and the value
            // it flips on is QUANTIZED TWICE: the parent's hit distance is
            // stored per OCTAHEDRAL TEXEL, so the ray "toward the child" is
            // really the ray toward the nearest of dirCount coarse directions,
            // and the parent lattice itself is 2x coarser than the child's. On
            // a flat wall the parent probes' rays graze the wall, so which
            // parents get rejected flips per child probe in a pattern locked to
            // the PARENT lattice — the c0 field came out modulated at exactly
            // 2x the probe spacing, which is the grid of dots the user sees
            // (measured period 1.01m at ultra, where c0 spacing is 0.50m).
            // Fading over [tol, 2*tol] of blocker penetration turns that flip
            // into a ramp and the lattice disappears (interleaved A/B on the
            // user's scene at ultra: bandRMS 0.678 -> 0.223 and the residual's
            // period drops to the probe spacing, i.e. the ordinary trilinear
            // blend; wall brightness and GPU cost both unchanged),
            // while a genuinely occluded parent — one whose blocker is a real
            // wall, not a grazing quantization artifact — still reaches zero.
            // This is the SAME correction the final gather already had
            // (cascadeGather.js: "the hard zero produced visible blotch/scallop
            // boundaries"); the merge was simply never given it.
            // Tolerance tracks the TRACE MEDIUM's quantization, as in the
            // gather — that is the actual error in `parentRay.w`. With the
            // occupancy backend that medium is the pyramid, so it is a level-0
            // VOXEL (0.125–0.25 m) and not the 0.35 m composited field cell:
            // sized off the coarser number, this proxy cannot reject a parent
            // probe hidden behind anything thinner than ~0.6 m, which is most
            // floors — so a sun UNDER the floor merged its light straight up
            // into the room above.
            const rel = childPos.sub(parentPos).toVar();
            const dist = rel.length().toVar();
            const visTol = float(traceQuantization).mul(MERGE_VIS_TOLERANCE);
            If(dist.greaterThan(1e-4), () => {
              const towardChild = octahedralTexelIndex(rel.div(dist), parent.dirRes);
              const parentRay = parent.rays.element(
                parentProbeIdx.mul(parent.dirCount).add(towardChild).toInt(),
              );
              // `globalThis.__giHardMergeVis` restores the old binary cut for an
              // A/B (scripts/run-gi-rc-lattice.mjs HARDMERGE=1).
              if (globalThis.__giHardMergeVis) {
                If(parentRay.w.greaterThanEqual(0).and(parentRay.w.lessThan(dist.sub(0.01))), () => {
                  weight.assign(0);
                });
              } else {
                If(parentRay.w.greaterThanEqual(0), () => {
                  const penetration = dist.sub(parentRay.w);
                  weight.mulAssign(smoothstep(visTol, visTol.mul(2), penetration).oneMinus());
                });
              }
            });

            // Parent angular taps — PARALLAX-CORRECTED BY DEFAULT since
            // 2026-08-04 (`__giParallaxMerge = false`, BUILD-TIME, restores
            // the naive taps for A/B).
            //
            // THE BUG THE CORRECTION FIXES: the naive lookup reads the 4
            // angular children of the parent's MERGED field at the CHILD'S
            // BIN INDEX — ignoring parallax. A corner parent sits up to a
            // whole parent-spacing from the child, and at the level
            // answering distance d the spacing IS ~d; solid angle
            // ω(r) = A/r² is CONVEX in that displacement, so the trilinear
            // average over 8 displaced parents OVERESTIMATES far energy
            // (Jensen), one factor per merge level — while the near field
            // (own-interval hits, no merge) stays correct. Measured
            // (run-gi-bleed): d^-1.44 vs analytic d^-2.72 — the "colour
            // bleed reaches metres too far while the room under-fills"
            // Blender-parity gap.
            //
            // THE CORRECTION (v2, depth-guided): the naive block's `w` is
            // set ONLY for the parent's OWN-interval hits — exactly the
            // boundary-adjacent energy parallax distorts; far/inherited
            // energy keeps w = -1. Resolved depth → re-aim at
            // childPos + D·depth and take the TRANSLATED 2×2 box-mean (box
            // width = the child's bin, so small-source dilution is
            // preserved; snap to whole texels). No depth → the naive block
            // stands (far field: parallax negligible by 1/d).
            const rowBase = parentProbeIdx.mul(parent.dirCount).add(parentDirBase);
            const s0 = parent.merged.element(rowBase.toInt()).toVar();
            const s1 = parent.merged.element(rowBase.add(1).toInt()).toVar();
            const s2 = parent.merged.element(rowBase.add(parent.dirRes).toInt()).toVar();
            const s3 = parent.merged.element(rowBase.add(parent.dirRes).add(1).toInt()).toVar();
            const naiveRad = s0.xyz.add(s1.xyz).add(s2.xyz).add(s3.xyz).mul(0.25);
            // Estimator selection was MEASURED on run-gi-bleed (2026-08-04),
            // far-field exponent vs analytic -2.72 at shipped c0DirRes 4:
            //   naive (pre-fix)              -1.44   (the falloff bug)
            //   v1 endpoint + point-bilinear -2.35   (breaks dilution)
            //   v2 min-depth block re-aim    -2.66   ← SHIPPED
            //   v3 per-sub-bin re-aim        -3.77   (tap wobbles off small
            //                                         sources — rejected)
            // v2's known limit: at the DIAGNOSTIC c0DirRes 2 config it
            // over-steepens (-5.38) — wide bins mix floor-graze and distant
            // energy, and the block's min depth then over-corrects. No
            // shipping preset uses c0DirRes 2 (GISystem: `props.c0DirRes
            // === 2 ? 2 : 4`, presets never lower it), so the default stays
            // on; revisit if that ever changes.
            let parentRad;
            if (globalThis.__giParallaxMerge !== false) {
              const big = float(1e6);
              const dHit = select(s0.w.greaterThan(0), s0.w, big)
                .min(select(s1.w.greaterThan(0), s1.w, big))
                .min(select(s2.w.greaterThan(0), s2.w, big))
                .min(select(s3.w.greaterThan(0), s3.w, big))
                .toVar();
              const reproj = vec3(naiveRad).toVar();
              If(dHit.lessThan(big), () => {
                const target = childPos.add(cascade.directionOf(dirIdx).mul(dHit));
                const relAim = target.sub(parentPos).toVar();
                const lenAim = relAim.length().max(1e-4);
                const { u: pu, v: pv } = octahedralUV(relAim.div(lenAim), parent.dirRes);
                // A 2-texel-wide box centred on the re-aimed direction — box
                // width = the child's bin, so small-source dilution is
                // preserved; only the CENTER moves with parallax.
                //
                // THE CENTRE MUST MOVE CONTINUOUSLY, and until 2026-08-07 it
                // did not: the box was snapped to whole texels
                // (`floor(pu + 0.5) - 1`), so as a child probe slid across its
                // parent's cell the re-aimed tap INDEX jumped by a whole bin
                // and the merged radiance stepped with it. That step is the
                // user's "blocky indirect light", and it is the parallax
                // correction's own doing: with `__giParallaxMerge = false` the
                // naive tap has no re-aim to snap and the floor comes out
                // smooth. MEASURED on scripts/run-gi-block-size.mjs (emissive
                // panel, open floor, per-line-detrended relative modulation of
                // the floor patch): 14.71% with the snap, 4.58% with the whole
                // correction disabled — i.e. two thirds of ALL the structure on
                // that floor was this one floor().
                //
                // The continuous form is the same box mean, evaluated at a
                // fractional centre: interpolate between the two integer-
                // aligned boxes on each axis. Separably that is a 3-tap
                // [(1−f)/2, 1/2, f/2] kernel per axis (weights sum to 1 by
                // construction, so the box's WIDTH — and therefore the
                // dilution — is unchanged; only its position is now smooth).
                // Nine buffer reads instead of four, in a loop that is already
                // reading eight parent probes.
                //
                // `__giParallaxMergeSmooth = false` restores the snapped box
                // for an A/B. BUILD-TIME, like every other hatch here.
                const gx = pu.sub(1).toVar();
                const gy = pv.sub(1).toVar();
                const i0 = gx.floor().toVar();
                const j0 = gy.floor().toVar();
                const fu = gx.sub(i0).toVar();
                const fv = gy.sub(j0).toVar();
                if (globalThis.__giParallaxMergeSmooth === false) {
                  const bxA = pu.add(0.5).floor().sub(1).clamp(0, parent.dirRes - 2);
                  const byA = pv.add(0.5).floor().sub(1).clamp(0, parent.dirRes - 2);
                  const rowA = parentProbeIdx.mul(parent.dirCount).add(byA.mul(parent.dirRes)).add(bxA).toVar();
                  const r0 = parent.merged.element(rowA.toInt()).xyz;
                  const r1 = parent.merged.element(rowA.add(1).toInt()).xyz;
                  const r2 = parent.merged.element(rowA.add(parent.dirRes).toInt()).xyz;
                  const r3 = parent.merged.element(rowA.add(parent.dirRes).add(1).toInt()).xyz;
                  reproj.assign(r0.add(r1).add(r2).add(r3).mul(0.25));
                } else {
                  const wu = [fu.oneMinus().mul(0.5), float(0.5), fu.mul(0.5)];
                  const wv = [fv.oneMinus().mul(0.5), float(0.5), fv.mul(0.5)];
                  const box = vec3(0).toVar();
                  for (let a = 0; a < 3; a++) {
                    const ix = i0.add(a).clamp(0, parent.dirRes - 1);
                    for (let b = 0; b < 3; b++) {
                      const iy = j0.add(b).clamp(0, parent.dirRes - 1);
                      const idx = parentProbeIdx.mul(parent.dirCount).add(iy.mul(parent.dirRes)).add(ix);
                      box.addAssign(parent.merged.element(idx.toInt()).xyz.mul(wu[a].mul(wv[b])));
                    }
                  }
                  reproj.assign(box);
                }
              });
              parentRad = reproj;
            } else {
              parentRad = naiveRad;
            }

            acc.addAssign(parentRad.mul(weight));
            weightSum.addAssign(weight);
          });

          out.assign(vec4(acc.div(max(weightSum, 1e-3)), -1));
        }
      });

      merged.element(instanceIndex).assign(out);
    })().compute(probeCount * dirCount);

    const average = Fn(() => {
      const sum = vec3(0).toVar();
      const base = instanceIndex.toInt().mul(dirCount);
      Loop({ start: 0, end: dirCount, name: "d" }, ({ d }) => {
        sum.addAssign(merged.element(base.add(d)).xyz);
      });
      cascade.mergedAverages.element(instanceIndex).assign(sum.div(dirCount));
    })().compute(probeCount);

    mergeComputes.push(merge);
    averageComputes.push(average);
  }

  // visComputes depend ONLY on geometry + the probe lattice, so the caller
  // dispatches them on composite frames (and the first frame), not per frame.
  return { mergeComputes, averageComputes, visComputes };
}
