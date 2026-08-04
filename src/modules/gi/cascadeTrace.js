// 3D Radiance Cascades — cascade allocation + interval trace (Phase 1).
//
// Scene-agnostic: the caller supplies `sceneTrace(origin, dir)` returning
// `{ rad: vec3, t: float }` (t < 0 = miss), so the same hierarchy runs
// against the Phase 0-2 analytic test room and, later, the voxel grid.
//
// Cascade rules (adopted from the Shadertoy X3XfRM parameterization, moved
// from surfel/atlas space to a world-space full-sphere probe lattice):
//   - probe count halves per axis each cascade (spacing ×2)
//   - direction count ×4 each cascade (octahedral res ×2 per axis)
//   - ray interval length ×2 each cascade, contiguous: rays of cascade i
//     cover [t0·(2^i − 1), t0·(2^(i+1) − 1)); the last cascade's interval
//     extends to `farT` so escaped rays can composite sky in the merge.
//
// One compute thread per RAY (probe × direction). There is deliberately no
// per-direction loop inside the trace shader — a prior GI attempt hit
// multi-second pipeline-compile stalls from JS-unrolled direction loops, and
// per-ray threads sidestep the whole class.
import { Fn, If, Loop, Return, float, floor, instanceIndex, instancedArray, max, mod, step, uniform, vec2, vec3, vec4 } from "three/tsl";

/**
 * Octahedral texel-center direction for a dirIdx in a res×res tile.
 * Branchless lower-hemisphere fold (no If — whole-vector math only).
 */
export function octahedralDirection(dirIdxF, res) {
  const u = mod(dirIdxF, res);
  const v = floor(dirIdxF.div(res));
  const f = vec2(u, v).add(0.5).div(res).mul(2).sub(1);
  const ax = f.x.abs();
  const ay = f.y.abs();
  const nz = float(1).sub(ax).sub(ay);
  const fold = max(nz.negate(), 0);
  const sx = step(0, f.x).mul(2).sub(1);
  const sy = step(0, f.y).mul(2).sub(1);
  const nx = f.x.sub(sx.mul(fold));
  const ny = f.y.sub(sy.mul(fold));
  return vec3(nx, ny, nz).normalize();
}

/**
 * World direction → CONTINUOUS texel-space coords {u, v} in [0, res) of a
 * res×res octahedral tile. Branchless, mirrors the decode's fold exactly.
 */
export function octahedralUV(dir, res) {
  const inv = float(1).div(dir.x.abs().add(dir.y.abs()).add(dir.z.abs()));
  const px = dir.x.mul(inv);
  const py = dir.y.mul(inv);
  const sx = step(0, px).mul(2).sub(1);
  const sy = step(0, py).mul(2).sub(1);
  const foldedX = float(1).sub(py.abs()).mul(sx);
  const foldedY = float(1).sub(px.abs()).mul(sy);
  const inLower = step(dir.z, 0);
  const fx = px.mul(inLower.oneMinus()).add(foldedX.mul(inLower));
  const fy = py.mul(inLower.oneMinus()).add(foldedY.mul(inLower));
  return {
    u: fx.mul(0.5).add(0.5).mul(res),
    v: fy.mul(0.5).add(0.5).mul(res),
  };
}

/**
 * Inverse of octahedralDirection: world direction → texel index (float) in a
 * res×res octahedral tile (nearest texel).
 */
export function octahedralTexelIndex(dir, res) {
  const { u, v } = octahedralUV(dir, res);
  const ui = u.floor().clamp(0, res - 1);
  const vi = v.floor().clamp(0, res - 1);
  return vi.mul(res).add(ui);
}

/**
 * Cell-centered probe position for a probeIdx in a gx×gy×gz lattice spanning
 * the volume described by `world` ({min, size} UNIFORM vec3 nodes — see
 * createGiField's world bundle; uniforms so an auto-fit refit moves the
 * lattice without a shader recompile). Cell-centered (not corner-anchored)
 * so coarser cascades interleave between finer probes and no axis
 * degenerates when its count reaches 1.
 */
export function probeLatticePosition(probeIdxF, grid, world) {
  const gx = float(grid.x);
  const gy = float(grid.y);
  const ix = mod(probeIdxF, gx).floor();
  const iy = mod(floor(probeIdxF.div(gx)), gy).floor();
  const iz = floor(probeIdxF.div(gx.mul(gy)));
  return vec3(
    world.min.x.add(ix.add(0.5).mul(world.size.x.div(grid.x))),
    world.min.y.add(iy.add(0.5).mul(world.size.y.div(grid.y))),
    world.min.z.add(iz.add(0.5).mul(world.size.z.div(grid.z))),
  );
}

/**
 * Builds the cascade hierarchy: storage buffers + one trace compute per
 * cascade (+ one per-probe average compute, used by debug gizmos).
 *
 * @param {object} opts
 * @param {{min: THREE.Vector3, max: THREE.Vector3}} opts.bounds world AABB
 * @param {number} opts.cascadeCount
 * @param {{x: number, y: number, z: number}} opts.c0Grid probes per axis at c0
 * @param {number} opts.c0DirRes octahedral res at c0 (2 → 4 dirs)
 * @param {number} opts.t0 c0 interval length in world units
 * @param {number} opts.farT max distance for the outermost cascade
 * @param {Function} opts.sceneTrace (origin, dir) → { rad: vec3, t: float (<0 miss) }
 */
export function createRadianceCascades({ world, cascadeCount, c0Grid, c0DirRes, t0, farT = 1e4, sceneTrace, traceParity = null }) {
  const cascades = [];
  // Interval parameterization as UNIFORMS (world-space lengths derived from
  // the volume size) — an auto-fit refit rescales the intervals in place,
  // matching the probe lattice the world uniforms already moved.
  const t0U = uniform(t0);
  const farTU = uniform(farT);
  // INTERVAL BRANCHING FACTOR — how much longer each cascade's ray interval is
  // than its child's. This is the knob that decides whether the hierarchy is
  // self-consistent, and it was silently pinned to 2.
  //
  // The RC invariant: a ray's angular FOOTPRINT at the far end of its interval
  // (Δθ · t) must track the PROBE SPACING at that cascade, or a level resolves
  // angular detail its lattice cannot carry (or vice versa). Per level here:
  // angular resolution ×4 (dirRes ×2, dirCount = dirRes²), probe spacing ×2,
  // interval ×BRANCH. Footprint/spacing therefore scales as BRANCH/(2·2) per
  // level — CONSTANT only at BRANCH = 4. At the shipped BRANCH = 2 it halves
  // every level, so every cascade is over-resolved angularly relative to its
  // lattice, and a small distant source hit by one over-narrow ray gets
  // trilinearly smeared across a probe lattice metres wide.
  //
  // MEASURED CONSEQUENCE (scripts/run-gi-bleed.mjs, 2026-08-04): indirect falls
  // off as d^-1.44 against an analytic d^-2.72 — 3.2x too bright at 9m — and
  // the error is not a sampling artifact but a bias: halving c0DirRes changes
  // the ANSWER (exponent -1.44 → -2.03), which a convergent transport cannot
  // do. That non-convergence under angular refinement is this ratio drifting.
  //
  // BUILD-TIME, NOT LIVE. This function runs once per GI build, so setting the
  // global in the console does NOTHING until something forces a rebuild — the
  // user tried exactly that and reported "no difference". Harnesses set it via
  // evaluateOnNewDocument (before load); in the editor, set it and then toggle
  // a STRUCTURAL prop (see #structuralSignature — quality, cascadeCount,
  // reflections, …) to re-enter this function.
  //
  // DEFAULT STAYS 2 — BRANCH=4 was A/B'd on the bleed rig AND the user's
  // Sponza (2026-08-04) and REJECTED: it only looks like a fix at c0DirRes 4
  // (coincidence — at dirRes 2 it is WORSE than shipped), and on Sponza it
  // made colour bleed ~23% worse. The falloff bias's real home is the
  // gather/merge solid-angle normalization, not this ladder.
  const BRANCH = Number(globalThis.__giCascadeBranch ?? 2) || 2;

  for (let level = 0; level < cascadeCount; level++) {
    const div = 2 ** level;
    const grid = {
      x: Math.max(1, Math.round(c0Grid.x / div)),
      y: Math.max(1, Math.round(c0Grid.y / div)),
      z: Math.max(1, Math.round(c0Grid.z / div)),
    };
    const dirRes = c0DirRes * div;
    const dirCount = dirRes * dirRes;
    const probeCount = grid.x * grid.y * grid.z;
    // Geometric ladder with ratio BRANCH: interval n has length t0·BRANCH^n and
    // starts where its child ended, t0·(BRANCH^n − 1)/(BRANCH − 1). At
    // BRANCH = 2 this reproduces the previous tMin = t0·(2^n − 1) and
    // intervalLen = t0·2^n EXACTLY, so the default is byte-identical.
    const tMin = t0U.mul((BRANCH ** level - 1) / (BRANCH - 1));
    const isLast = level === cascadeCount - 1;
    const intervalLen = isLast ? float(farTU) : t0U.mul(BRANCH ** level);

    // Ray payload: rgb = interval radiance, w = hit distance from the PROBE
    // (not the interval start; the merge's visibility weighting wants the
    // probe-relative distance), or -1 for "no hit in this interval".
    const rays = instancedArray(probeCount * dirCount, "vec4");
    // Per-probe mean of own-interval radiance — debug-gizmo food.
    const averages = instancedArray(probeCount, "vec3");

    const probePositionOf = (probeIdxF) => probeLatticePosition(probeIdxF, grid, world);
    const directionOf = (dirIdxF) => octahedralDirection(dirIdxF, dirRes);

    const traceCompute = Fn(() => {
      const rayIdx = instanceIndex.toFloat();
      const probeIdx = floor(rayIdx.div(dirCount));
      const dirIdx = mod(rayIdx, dirCount);
      // TEMPORAL RAY REUSE (the cascade half of the feedback checkerboard).
      // The march is the expensive part of a cascade — ~1.6ms of a 3.8ms
      // awake frame on a 262k-tri scene — and it is re-run every frame even
      // when only a LIGHT moved. Tracing alternate probe ROWS per frame
      // halves it: a skipped thread simply doesn't write, so its ray keeps
      // last frame's value, and the merge/gather downstream sees a cage whose
      // 8 probes are at most one frame apart — the same argument the feedback
      // checker makes at cell level.
      //
      // Parity is per probe ROW (constant along x) so a whole 32-thread wave
      // shares the decision and an idle wave exits outright; a per-probe or
      // per-ray parity leaves every wave half-active, which costs a full wave
      // and saves only memory traffic. `parity < 0` = off (the sentinel
      // GISystem writes), which is what keeps this A/B-able live.
      if (traceParity) {
        const row = floor(probeIdx.div(grid.x));
        If(
          float(traceParity).greaterThanEqual(0).and(
            mod(row, 2).sub(traceParity).abs().greaterThan(0.5),
          ),
          () => {
            Return();
          },
        );
      }
      const origin = probePositionOf(probeIdx).toVar();
      const dir = directionOf(dirIdx).toVar();

      // Third arg: the interval length in world units (a JS number — trace
      // media use it to bound march step counts per cascade; the analytic
      // tracer ignores it).
      const start = origin.add(dir.mul(tMin));
      const { rad, t } = sceneTrace(start, dir, intervalLen);

      const out = vec4(0, 0, 0, -1).toVar();
      If(t.greaterThan(0).and(t.lessThanEqual(intervalLen)), () => {
        out.assign(vec4(rad, t.add(tMin)));
      });
      rays.element(instanceIndex).assign(out);
    })().compute(probeCount * dirCount);

    // One thread per PROBE: mean of the probe's own interval radiance.
    // Misses contribute black on purpose — an un-merged cascade is expected
    // to look dark/sparse; that contrast IS the Phase 1 vs Phase 2 visual.
    const averageCompute = Fn(() => {
      const sum = vec3(0).toVar();
      const base = instanceIndex.toInt().mul(dirCount);
      Loop({ start: 0, end: dirCount }, ({ i }) => {
        sum.addAssign(rays.element(base.add(i)).xyz);
      });
      averages.element(instanceIndex).assign(sum.div(dirCount));
    })().compute(probeCount);

    cascades.push({
      level,
      world,
      grid,
      dirRes,
      dirCount,
      probeCount,
      tMin,
      intervalLen,
      rays,
      averages,
      probePositionOf,
      directionOf,
      traceCompute,
      averageCompute,
    });
  }

  return { cascades, intervals: { t0: t0U, farT: farTU } };
}
