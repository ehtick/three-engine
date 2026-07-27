// PER-BUILDER TSL FUNCTIONS — the mechanism that lets GI's hot bodies
// (slot SDF sample, detail refinement, shadow/mirror sphere traces) be REAL
// WGSL functions in EVERY shader instead of being stamped out inline at each
// call site.
//
// THE PROBLEM. TSL only emits a `fn foo(...)` when an `Fn()` has a layout
// (TSLCore ShaderCallNodeInternal: `if (shaderNode.layout)` → buildFunctionNode,
// else the body is built straight into the caller). Without one, a mirror
// material inlined ~57 copies of the 5-branch slot-sample body — 4 emitter
// shadow traces and 1 mirror trace, each carrying 10 inlined detail-slot
// samples, plus 7 more in the reflection hit-surface gradient. That is what
// made GI fragment shaders 180-250kB of WGSL, and the driver needs seconds
// per shader that size.
//
// THE TRAP that made "just add layouts" unsafe: `NodeBuilder.buildFunctionNode`
// caches the GENERATED CODE per backend, keyed by the Fn instance. A body that
// reads buffers/textures therefore bakes in the binding names of whichever
// shader built it FIRST; every other shader including it references undeclared
// buffers ("unresolved value 'NodeBuffer_…'") and the whole GI field goes flat.
// A shared Fn is only safe with a layout if exactly one shader uses it.
//
// THE FIX. Hand each NodeBuilder its OWN Fn instance, so three's cache key is
// unique per shader and every shader generates the function against its own
// bindings. Builders are per material/compute build and are dropped afterwards,
// so the cache dies with them (the Fn instances hang off the builder itself).
//
// Getting at the builder is the only awkward part: node graphs are constructed
// eagerly in JS, long before any builder exists. An Fn body, however, receives
// the builder as its second argument — so each public entry point is a thin
// INLINED wrapper Fn whose only job is to look up the per-builder instance and
// forward the call. The wrapper costs nothing in the generated code (its
// parameters are the caller's own expressions).
import { Fn } from "three/tsl";

// Symbol so the cache is invisible to three. Writes tunnel through the
// `secureNodeBuilder` Proxy TSL hands the body (it traps `get` only), so the
// map always lands on — and is read back from — the real builder.
const FN_CACHE = Symbol("giPerBuilderFn");

/**
 * The Fn instance belonging to `token` for this builder, created on first use.
 * `create` receives a WGSL-safe layout name unique within the shader.
 */
export function builderFn(builder, token, create) {
  let cache = builder[FN_CACHE];
  if (cache === undefined) {
    cache = new Map();
    builder[FN_CACHE] = cache;
  }
  let fn = cache.get(token);
  if (fn === undefined) {
    // Index suffix keeps names unique when two instances of the same helper
    // meet in one shader (e.g. two shadow traces at different step counts).
    fn = create(`${token.name}_${cache.size}`);
    cache.set(token, fn);
  }
  return fn;
}

// A/B ESCAPE HATCH, dev/harness only (`globalThis.__giNoLayouts = true` before
// a GI build). Reverts to the previous shipped codegen: layouts only on the
// four helper instances that were provably single-shader, everything else
// inlined at each call site. Kept so the per-shader-function win stays
// measurable on the same machine — cross-session wave timings are not
// comparable (CPU contention swings them 3-5×).
const PRE_LAYOUT_NAMES = new Set([
  "giResolveGather",
  "giFeedbackGather",
  "giResolveShadowTrace",
  "giFeedbackShadowTrace",
]);

const skipLayout = (name) => globalThis.__giNoLayouts === true && !PRE_LAYOUT_NAMES.has(name);

/**
 * Declares a GI helper that compiles to one WGSL function per shader.
 *
 * @param {object} spec
 * @param {string} spec.name    WGSL function name prefix (identifier-safe)
 * @param {string} spec.type    return type ("float", "vec3", …)
 * @param {Array<{name: string, type: string}>} spec.inputs  layout parameters
 * @param {Function} spec.body  (…params) => node — built once per shader
 * @returns {Function} (…args) => node
 */
export function sharedFn({ name, type, inputs, body }) {
  // Identity of THIS helper, stable across builders — the per-builder map key.
  const token = { name };
  let wrapper = null;
  return (...args) => {
    // SPREAD, never index. TSL hands an Fn body a proxy over its parameters,
    // but the shape underneath differs: a plain call carries an ARRAY (numeric
    // keys), while a layout'd function's body is invoked with an object keyed
    // by the layout's input NAMES (NodeBuilder.flowShaderNode). `params[0]` is
    // undefined in the second case — the iterator is the one accessor that
    // yields the parameters in order for both.
    wrapper ??= Fn((params, builder) => {
      const fn = builderFn(builder, token, (layoutName) => {
        const inner = Fn((innerParams) => body(...innerParams));
        if (!skipLayout(name)) inner.setLayout({ name: layoutName, type, inputs });
        return inner;
      });
      return fn(...params);
    });
    return wrapper(...args);
  };
}
