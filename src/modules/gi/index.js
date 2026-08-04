import { GlobalIlluminationComponent } from "./GlobalIlluminationComponent.js";

/**
 * Global Illumination module — 3D Radiance Cascades.
 *
 * Port of the Shadertoy "Radiance Cascades 3D" (X3XfRM) approach to a
 * world-space probe lattice with a same-frame hierarchical merge in WebGPU
 * compute (the temporal merge — and its flicker/lag — was purely a Shadertoy
 * single-buffer limitation). See docs/shadertoy_*.glsl for the reference and
 * scripts/gi-rc-spike.* / gi-rc-voxel.* for the phase harnesses.
 */
export const giModule = {
  id: "gi",
  name: "Global Illumination",
  description: "Real-time GI via 3D radiance cascades over a single-bake voxel grid",
  version: "1.0.0",
  category: "Rendering",
  tags: ["gi", "lighting", "radiance-cascades", "webgpu"],
  components: [GlobalIlluminationComponent],
  async setup(engine) {
    const { GISystem } = await import("./GISystem.js");
    const system = new GISystem(engine);
    return {
      system,
      dispose: () => system.dispose(),
    };
  },
};

export { GlobalIlluminationComponent };
export { RayHitMode, RAY_HIT_MODE_OPTIONS, normalizeRayHitMode, rayHitModeName } from "./rayHit/RayHitConfig.js";
export { intersectRayTriangle, buildWorldTriangles, traceTrianglesExact, validateRayHits } from "./rayHit/RayHitValidator.js";
export {
  BRICK_RESOLUTION,
  BRICK_VOXEL_COUNT,
  MAX_MACRO_STEPS,
  MAX_BRICK_STEPS,
  MacroCellType,
  packMacroCellMetadata,
  unpackMacroCellMetadata,
  planHybridBrickLayout,
  buildHybridBrickWords,
  traceHybridBrickBoxesCpu,
} from "./rayHit/RayHitPacking.js";
