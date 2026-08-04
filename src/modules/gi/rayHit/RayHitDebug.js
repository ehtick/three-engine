import { Fn, atomicAdd, atomicMax, atomicStore, instancedArray, uint } from "three/tsl";

/** One packed storage buffer keeps Phase-0 instrumentation to one binding. */
export const RayHitCounter = Object.freeze({
  Rays: 0,
  Hits: 1,
  Misses: 2,
  MacroSteps: 3,
  MaxMacroSteps: 4,
  BrickSteps: 5,
  MaxBrickSteps: 6,
  StepLimitExits: 7,
  MacroStepLimitExits: 8,
  BrickStepLimitExits: 9,
  InvalidNumerics: 10,
  LegacyFallbacks: 11,
  // Phase 2/3: simple-plane resolution inside the brick DDA.
  PlaneTests: 12,
  PlaneAccepts: 13,
  PlaneRejects: 14,
  SurfaceFallbacks: 15,
  // Phase 4: exact triangle-list resolution in complex cells.
  ComplexTests: 16,
  TriangleTests: 17,
  ComplexAccepts: 18,
  ComplexMisses: 19,
  // Phase 5: coarse pyramid-ride instrumentation. The ride has been on since
  // Phase 1 but was never measurable, so "the skip helps" was an assertion,
  // not a number. 24*4 = 96 B keeps the 16-byte alignment invariant.
  CoarseSteps: 20,
  CoarseSkipsL3: 21,
  CoarseSkipsL4: 22,
  CoarseDescends: 23,
  Count: 24,
});

const COUNTER_NAMES = Object.freeze([
  "rays",
  "hits",
  "misses",
  "macroSteps",
  "maxMacroSteps",
  "brickSteps",
  "maxBrickSteps",
  "stepLimitExits",
  "macroStepLimitExits",
  "brickStepLimitExits",
  "invalidNumerics",
  "legacyFallbacks",
  "planeTests",
  "planeAccepts",
  "planeRejects",
  "surfaceFallbacks",
  "complexTests",
  "triangleTests",
  "complexAccepts",
  "complexMisses",
  "coarseSteps",
  "coarseSkipsL3",
  "coarseSkipsL4",
  "coarseDescends",
]);

/**
 * Optional GPU instrumentation for the existing occupancy traversal.
 * Readback is explicit and diagnostic-only; no frame ever stalls for it.
 */
export function createRayHitDebugBuffer({ countLegacyFallbacks = false } = {}) {
  const buffer = instancedArray(new Uint32Array(RayHitCounter.Count), "uint").toAtomic();

  const resetCompute = Fn(() => {
    for (let i = 0; i < RayHitCounter.Count; i++) atomicStore(buffer.element(i), uint(0));
  })().compute(1);

  const recordTrace = ({
    hit,
    resolved,
    steps,
    brickSteps = uint(0),
    macroLimit = resolved.lessThan(0.5),
    brickLimit = uint(0),
    invalid,
    planeTests = null,
    planeAccepts = null,
    planeRejects = null,
    surfaceFallbacks = null,
    complexTests = null,
    triangleTests = null,
    complexAccepts = null,
    complexMisses = null,
    coarseSteps = null,
    coarseSkipsL3 = null,
    coarseSkipsL4 = null,
    coarseDescends = null,
  }) => {
    atomicAdd(buffer.element(RayHitCounter.Rays), uint(1));
    atomicAdd(buffer.element(RayHitCounter.MacroSteps), steps.toUint());
    atomicMax(buffer.element(RayHitCounter.MaxMacroSteps), steps.toUint());
    atomicAdd(buffer.element(RayHitCounter.BrickSteps), brickSteps.toUint());
    atomicMax(buffer.element(RayHitCounter.MaxBrickSteps), brickSteps.toUint());
    atomicAdd(buffer.element(RayHitCounter.Hits), hit.greaterThan(0.5).toUint());
    atomicAdd(buffer.element(RayHitCounter.Misses), hit.lessThanEqual(0.5).toUint());
    atomicAdd(buffer.element(RayHitCounter.StepLimitExits), resolved.lessThan(0.5).toUint());
    atomicAdd(buffer.element(RayHitCounter.MacroStepLimitExits), macroLimit.toUint());
    atomicAdd(buffer.element(RayHitCounter.BrickStepLimitExits), brickLimit.toUint());
    atomicAdd(buffer.element(RayHitCounter.InvalidNumerics), invalid.toUint());
    if (planeTests) atomicAdd(buffer.element(RayHitCounter.PlaneTests), planeTests.toUint());
    if (planeAccepts) atomicAdd(buffer.element(RayHitCounter.PlaneAccepts), planeAccepts.toUint());
    if (planeRejects) atomicAdd(buffer.element(RayHitCounter.PlaneRejects), planeRejects.toUint());
    if (surfaceFallbacks) atomicAdd(buffer.element(RayHitCounter.SurfaceFallbacks), surfaceFallbacks.toUint());
    if (complexTests) atomicAdd(buffer.element(RayHitCounter.ComplexTests), complexTests.toUint());
    if (triangleTests) atomicAdd(buffer.element(RayHitCounter.TriangleTests), triangleTests.toUint());
    if (complexAccepts) atomicAdd(buffer.element(RayHitCounter.ComplexAccepts), complexAccepts.toUint());
    if (complexMisses) atomicAdd(buffer.element(RayHitCounter.ComplexMisses), complexMisses.toUint());
    if (coarseSteps) atomicAdd(buffer.element(RayHitCounter.CoarseSteps), coarseSteps.toUint());
    if (coarseSkipsL3) atomicAdd(buffer.element(RayHitCounter.CoarseSkipsL3), coarseSkipsL3.toUint());
    if (coarseSkipsL4) atomicAdd(buffer.element(RayHitCounter.CoarseSkipsL4), coarseSkipsL4.toUint());
    if (coarseDescends) atomicAdd(buffer.element(RayHitCounter.CoarseDescends), coarseDescends.toUint());
    if (countLegacyFallbacks) atomicAdd(buffer.element(RayHitCounter.LegacyFallbacks), uint(1));
  };

  return {
    buffer,
    resetCompute,
    recordTrace,
    async readback(renderer) {
      const values = new Uint32Array(await renderer.getArrayBufferAsync(buffer.value));
      const stats = {};
      for (let i = 0; i < COUNTER_NAMES.length; i++) stats[COUNTER_NAMES[i]] = values[i] ?? 0;
      stats.averageMacroSteps = stats.rays > 0 ? stats.macroSteps / stats.rays : 0;
      stats.averageBrickSteps = stats.rays > 0 ? stats.brickSteps / stats.rays : 0;
      stats.hitRate = stats.rays > 0 ? stats.hits / stats.rays : 0;
      return stats;
    },
  };
}
