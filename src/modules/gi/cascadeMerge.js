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
import { Fn, If, Loop, float, floor, instanceIndex, instancedArray, max, mod, smoothstep, vec3, vec4 } from "three/tsl";
import { octahedralTexelIndex } from "./cascadeTrace.js";

/**
 * Builds merged-result buffers + merge computes for a cascade array made by
 * createRadianceCascades. Returns `mergeComputes` already ordered coarse →
 * fine (dispatch them in that order, after all trace computes).
 *
 * @param {Array} cascades from createRadianceCascades
 * @param {object} [opts]
 * @param {[number, number, number]} [opts.sky] radiance for rays that escape
 *   the outermost cascade. Default black — the spike's sealed-room checks
 *   depend on escapes contributing nothing.
 */
// Blocker penetration (in FIELD voxels) over which a parent probe fades out of
// the merge. Matches the final gather's tolerance — see the long note at the
// use site for why a binary cut is what produced the lattice artifact.
// `globalThis.__giMergeVisTol` overrides it for harness A/Bs (read per build,
// not at module load — the harness sets it after the module is imported).
const DEFAULT_MERGE_VIS_TOLERANCE = 1.75;

export function createCascadeMerge(cascades, { sky = [0, 0, 0] } = {}) {
  const MERGE_VIS_TOLERANCE = Number(globalThis.__giMergeVisTol) || DEFAULT_MERGE_VIS_TOLERANCE;
  for (const cascade of cascades) {
    cascade.merged = instancedArray(cascade.probeCount * cascade.dirCount, "vec4");
    cascade.mergedAverages = instancedArray(cascade.probeCount, "vec3");
  }

  const mergeComputes = [];
  // Per-probe means of the merged field — read ONLY by the debug gizmos,
  // so the caller dispatches them only while a probe debug view is open.
  const averageComputes = [];

  for (let level = cascades.length - 1; level >= 0; level--) {
    const cascade = cascades[level];
    const parent = cascades[level + 1] ?? null;
    const { dirCount, dirRes, probeCount, rays, merged } = cascade;

    const merge = Fn(() => {
      const own = rays.element(instanceIndex).toVar();
      const out = vec4(0, 0, 0, -1).toVar();

      If(own.w.greaterThan(0), () => {
        out.assign(own);
      }).Else(() => {
        if (!parent) {
          out.assign(vec4(sky[0], sky[1], sky[2], -1));
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
            // Tolerance tracks the FIELD's voxel quantization, as in the
            // gather — that is the actual error in `parentRay.w`.
            const rel = childPos.sub(parentPos).toVar();
            const dist = rel.length().toVar();
            const visTol = float(cascade.world.cellMax).mul(MERGE_VIS_TOLERANCE);
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

            // Mean of the 4 angular children from the parent's MERGED field
            // (same-frame data — the parent merge already ran this submit).
            const rowBase = parentProbeIdx.mul(parent.dirCount).add(parentDirBase);
            const s0 = parent.merged.element(rowBase.toInt()).xyz;
            const s1 = parent.merged.element(rowBase.add(1).toInt()).xyz;
            const s2 = parent.merged.element(rowBase.add(parent.dirRes).toInt()).xyz;
            const s3 = parent.merged.element(rowBase.add(parent.dirRes).add(1).toInt()).xyz;
            const parentRad = s0.add(s1).add(s2).add(s3).mul(0.25);

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

  return { mergeComputes, averageComputes };
}
