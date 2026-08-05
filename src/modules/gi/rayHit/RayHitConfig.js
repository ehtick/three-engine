/**
 * Stable runtime identifiers for the GI ray/scene query.
 *
 * OccupancyLegacy and the Phase-1 HybridBrickBox path are implemented. Later
 * modes deliberately resolve back to legacy until their GPU path is complete,
 * so selecting an experimental mode can never silently turn GI off.
 */
export const RayHitMode = Object.freeze({
  OccupancyLegacy: 0,
  HybridBrickBox: 1,
  HybridPlane: 2,
  HybridPlaneCoverage: 3,
  HybridExactComplex: 4,
});

export const RAY_HIT_MODE_OPTIONS = Object.freeze([
  "occupancy-legacy",
  "hybrid-brick-box",
  "hybrid-plane",
  "hybrid-plane-coverage",
  "hybrid-exact-complex",
]);

const MODE_BY_NAME = Object.freeze({
  "occupancy-legacy": RayHitMode.OccupancyLegacy,
  "hybrid-brick-box": RayHitMode.HybridBrickBox,
  "hybrid-plane": RayHitMode.HybridPlane,
  "hybrid-plane-coverage": RayHitMode.HybridPlaneCoverage,
  "hybrid-exact-complex": RayHitMode.HybridExactComplex,
});

export function normalizeRayHitMode(value) {
  if (Number.isInteger(value) && value >= RayHitMode.OccupancyLegacy && value <= RayHitMode.HybridExactComplex) {
    return value;
  }
  return MODE_BY_NAME[String(value ?? "").toLowerCase()] ?? RayHitMode.OccupancyLegacy;
}

export function rayHitModeName(mode) {
  return RAY_HIT_MODE_OPTIONS[normalizeRayHitMode(mode)];
}

/**
 * `rayHitMode: "auto"` — the mode follows the QUALITY PRESET, which is the
 * right default because the ladder's whole trade is memory/cost vs hit
 * precision and that is exactly what the presets already arbitrate.
 *
 * high/custom land on EXACT-COMPLEX, not plane-coverage. The original
 * "can't tell the modes apart in a still" evaluation predates the record
 * march: with shadows resolved through the records, the difference is
 * exactly where a still shows it — a non-axis-aligned caster's silhouette
 * cells contain an EDGE (two faces), which fails the simple-plane fit, and
 * without a triangle pool every such cell falls back to occupied-box hits.
 * That quantized every rotated cube's and every trim/arch edge's shadow to
 * full voxels while the flat-face interiors stayed sub-voxel exact. The
 * triangle pool's memory cost (~2 tris x 36 B per failed-fit cell) is the
 * price of correct silhouettes and the presets that can afford it pay it;
 * low/medium keep the lean modes.
 */
const AUTO_MODE_BY_QUALITY = Object.freeze({
  // low was HybridBrickBox until 2026-08-05. With the sun-disc stochastic
  // shadow arm the records ARE the shadow quality: box hits quantize every
  // silhouette to whole voxels (low's voxels are the biggest), and the box
  // arm's origin lift leaves a dead zone ~1 voxel deep that the per-pixel
  // jittered rays escape through — the "holes in the voxel mesh, light leaks"
  // report. Plane records at low's small grid cost little and fix both.
  low: RayHitMode.HybridPlane,
  medium: RayHitMode.HybridPlane,
  high: RayHitMode.HybridExactComplex,
  ultra: RayHitMode.HybridExactComplex,
});

export function resolveAutoRayHitMode(quality) {
  return AUTO_MODE_BY_QUALITY[String(quality ?? "").toLowerCase()] ?? RayHitMode.HybridExactComplex;
}

/**
 * Resolves authoring properties and diagnostic globals into one immutable
 * build configuration. All four hybrid phases are implemented: HybridBrickBox
 * (Phase 1), HybridPlane (Phase 2), HybridPlaneCoverage (Phase 3) and
 * HybridExactComplex (Phase 4). Unknown future values keep the explicit
 * legacy fallback so a stale saved mode can never silently turn GI off.
 *
 * `enableSkipDistance` is an OPT-OUT, not an opt-in: the conservative coarse
 * pyramid ride in the hybrid traces shipped always-on inside Phase 1, so this
 * flag is only the Phase-5 A/B kill switch. It defaults ON; set
 * `globalThis.__giRayHitSkipDistance = false` or the component prop
 * `rayHitSkipDistance: false` to disable it for a comparison run.
 *
 * `enableShadowRecords` is the matching Phase-5 kill switch for RECORD-AWARE
 * SHADOW DISTANCE: the soft-shadow oracle sharpening an occupied neighbour's
 * voxel-AABB gap with that voxel's fitted SIMPLE plane, which is what unstairs
 * the shadow silhouettes. It defaults ON too; `__giRayHitShadowRecords = false`
 * or the prop `rayHitShadowRecords: false` reverts to the pure box gap, and the
 * two arms differ in WGSL (a separate compiled oracle variant), not in a runtime
 * predicate.
 */
export function resolveRayHitConfig(props = {}, runtime = globalThis) {
  const rawMode = runtime.__giRayHitMode ?? props.rayHitMode;
  const autoMode = String(rawMode ?? "").toLowerCase() === "auto";
  const requestedMode = autoMode
    ? resolveAutoRayHitMode(props.quality)
    : normalizeRayHitMode(rawMode);
  const activeMode = requestedMode >= RayHitMode.HybridBrickBox &&
    requestedMode <= RayHitMode.HybridExactComplex
    ? requestedMode
    : RayHitMode.OccupancyLegacy;
  return Object.freeze({
    requestedMode,
    activeMode,
    autoMode,
    fallbackToLegacy: requestedMode !== activeMode,
    enableProfiling: runtime.__giRayHitProfiling === true || props.rayHitProfiling === true,
    enableSkipDistance: runtime.__giRayHitSkipDistance !== false && props.rayHitSkipDistance !== false,
    enableShadowRecords: runtime.__giRayHitShadowRecords !== false && props.rayHitShadowRecords !== false,
    enableRayConeLOD: runtime.__giRayHitConeLOD === true,
    enableDynamicOverlay: runtime.__giRayHitDynamicOverlay === true,
    enableComplexTriangles: runtime.__giRayHitComplexTriangles === true,
    visualizeTraversal: runtime.__giRayHitVisualizeTraversal === true,
    validateAgainstLegacy: runtime.__giRayHitValidateLegacy === true,
    validateAgainstCPU: runtime.__giRayHitValidateCPU === true,
  });
}
