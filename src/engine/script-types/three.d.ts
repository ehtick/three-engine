/**
 * Intentionally (almost) empty.
 *
 * This file used to `declare module "three"` and `declare module "three/webgpu"`
 * with a nine-symbol subset forwarded from `"engine"`. That was actively
 * harmful in two directions:
 *
 *   - It shadowed the real three typings. An ambient `declare module` wins over
 *     package resolution, so even with `@types/three` installed a script saw
 *     nine classes.
 *   - It disagreed with the runtime. The runtime now re-exports all ~630 three
 *     symbols (see `scriptRuntime/threeRuntime.js`), so a nine-symbol
 *     declaration means autocomplete hides almost everything that actually
 *     works — the mirror image of the old bug, where the types promised
 *     symbols the runtime did not have.
 *
 * `"three"`, `"three/webgpu"` and `"three/tsl"` now resolve to `@types/three`,
 * which ships version-matched declarations for all three entry points. Nothing
 * needs declaring here.
 *
 * One asymmetry worth knowing: at runtime `"three"` is routed to the
 * `three/webgpu` build (a superset — see `scriptRuntime.js` for why there must
 * only ever be one three instance), while for types `"three"` resolves to the
 * plain build's declarations. So a script that imports a WebGPU/TSL-only
 * symbol from bare `"three"` works but does not type-check. Import those from
 * `"three/webgpu"` and the two agree.
 */
export {};
