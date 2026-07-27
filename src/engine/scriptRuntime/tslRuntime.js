/**
 * The `three/tsl` surface as user scripts see it.
 *
 * TSL (three's shading language) is not an exotic corner of this engine — the
 * material pipeline is TSL-native end to end (`materialAsset.js`,
 * `tslGraph.js`, `shaderGraph.js`, the GI module's compute passes). A script
 * that wants to drive a material node, author a custom `Fn`, or poke a
 * uniform needs the same `three/tsl` instance the engine builds graphs with,
 * so `linkEngineImports` rewrites `"three/tsl"` to this module.
 *
 * Same single-instance reasoning as `threeRuntime.js`: this re-exports the
 * bare `"three/tsl"` specifier, so the bundler hands it the identical module
 * the engine's own graph code uses. Node identity matters more here than
 * anywhere else — TSL nodes are compared and cached by reference during graph
 * construction, and a second copy of the library would produce nodes the
 * engine's builder does not recognise.
 */
export * from "three/tsl";

import * as TSL_NS from "three/tsl";
export default TSL_NS;

/** This module's own absolute URL — see `threeRuntime.js` for why. */
export const __SELF_URL__ = import.meta.url;
