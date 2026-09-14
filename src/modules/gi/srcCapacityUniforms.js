// SRC CAPACITY UNIFORMS — keep the bin store's sizes OUT of the kernel text.
//
// ══ WHY ══════════════════════════════════════════════════════════════════════
//
// Chromium keys Dawn's compiled-shader disk cache on the shader module's
// SOURCE TEXT (`wgslStable.js` carries the mechanics and the receipts), and
// every SRC kernel used to bake the pool's capacities as WGSL LITERALS at
// graph-build time — `uint(info.binBase)`, the `lo/hi` cascade partition,
// `store.blockLiveBase + info.blockBase`, the tile-atlas strides. A pool that
// moved therefore produced different text for the SAME graph, the cache key
// missed, and every grow re-compiled the ~200 kB kernels from scratch
// (measured 2026-09-12: "a pool grow = 68-kernel recompile, 73 s"; the boot
// audit's two same-boot rebuilds differed in exactly 21 lines out of 6,639 —
// every one of these literals).
//
// The fix: the same JS numbers flow into `uniform()` nodes instead. The WGSL
// declares a value-free `var<uniform>`, the text becomes identical for every
// capacity vector, and a grow costs a uniform write instead of a compile wave.
// The values are set once at factory time — a pool change rebuilds the graphs
// anyway, so nothing needs to track a live pool.
//
// `scripts/gi-src-wgsl-stability.html` is the receipt machine: it builds the
// chain under two capacity vectors and asserts the module text is identical.
//
// ⚠ f32 EXACTNESS. A uniform is f32, so a value is represented exactly only up
// to 2^24. The shipped BIN_BUDGET keeps `binHi` (the largest family) at
// ~10 M — two octaves of headroom — but the guard below fails LOUDLY rather
// than letting a grown pool read a bin base off by a few hundred slots. This
// is the uniform-era twin of the `Number.isInteger(base)` guards the chains
// already run (which a literal made a compile error and a uniform would make
// a silent wrong-index).

import { uniform } from "three/tsl";
import * as THREE from "three/webgpu";

const F32_EXACT = 2 ** 24;
const COMPONENTS = ["x", "y", "z", "w"];

/**
 * One scalar f32 uniform from a JS value — the per-cascade form (probe and
 * hash region sizes, a backed capacity). Same guards, same reasoning.
 */
export function scalarUniform(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`srcCapacityUniforms: ${name} = ${value} is not a whole block/base offset`);
  }
  if (value >= F32_EXACT) {
    throw new Error(
      `srcCapacityUniforms: ${name} = ${value} crosses 2^24 and an f32 uniform would round it — ` +
      "shrink the pool or move this family back to per-build literals",
    );
  }
  return uniform(value);
}

/**
 * One vec4 uniform from plain JS values — for the small per-cascade base
 * families that don't come off a store object (the merge's corner records).
 * Same guards, same reasoning as `cascadeUniform`.
 */
export function valuesUniform(values, name) {
  if (values.length > 4) {
    throw new Error(`srcCapacityUniforms: ${name} — ${values.length} values, the uniforms hold four`);
  }
  const v = new THREE.Vector4();
  for (let c = 0; c < values.length; c++) {
    const value = values[c];
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`srcCapacityUniforms: ${name}[${c}] = ${value} is not a whole block/base offset`);
    }
    if (value >= F32_EXACT) {
      throw new Error(
        `srcCapacityUniforms: ${name}[${c}] = ${value} crosses 2^24 and an f32 uniform would round it — ` +
        "shrink the pool or move this family back to per-build literals",
      );
    }
    v.setComponent(c, value);
  }
  return uniform(v);
}

/**
 * One vec4 uniform from a per-cascade JS value. Cascades beyond 4 do not
 * exist (the design is fixed at four), and unused components stay zero —
 * the JS loops that consume them unroll over the real cascades only.
 */
function cascadeUniform(cascades, valueOf, name) {
  return valuesUniform(cascades.map(valueOf), name);
}

/** The `c` component of a capacity uniform, for a JS-known cascade index. */
export const capAt = (u, c) => u[COMPONENTS[c]];

/**
 * The bin partition — where each cascade's bins start, and where they end —
 * as uniforms. `binBase` addresses the shared payload/scratch arrays; `binHi`
 * is the `lo + bins·blockCapacity` end the keep/resolve chains partition
 * `binTotal` with.
 */
export function binPartitionUniforms(bins) {
  return {
    binBase: cascadeUniform(bins.cascades, (i) => i.binBase, "binBase"),
    binHi: cascadeUniform(bins.cascades, (i) => i.binBase + i.bins * i.blockCapacity, "binHi"),
  };
}

/**
 * The per-cascade PROBE TABLE region — where each cascade's probe records
 * start, and how many slots it holds — for the passes that index the table
 * directly (the ray partition, the merge's corner resolve, the seed).
 */
export function probeRegionUniforms(cascades) {
  return {
    probeBase: cascadeUniform(cascades, (i) => i.probeBase, "probeBase"),
    probeCapacity: cascadeUniform(cascades, (i) => i.probeCapacity, "probeCapacity"),
  };
}

/**
 * The per-cascade block-array bases — `store.<region>Base + blockBase` — as
 * uniforms. Each family only exists when its feature is armed, matching the
 * branches that consume it; an unarmed uniform would be a binding nothing
 * reads.
 */
export function blockChainUniforms(store, bins, {
  live = false,
  stamp = false,
  held = false,
  stack = false,
  influx = false,
  surprise = false,
} = {}) {
  const out = {};
  if (live) {
    out.liveBase = cascadeUniform(bins.cascades, (i) => store.blockLiveBase + i.blockBase, "liveBase");
  }
  if (stamp) {
    out.stampBase = cascadeUniform(bins.cascades, (i) => store.blockStampBase + i.blockBase, "stampBase");
  }
  if (held) {
    out.heldBase = cascadeUniform(bins.cascades, (i) => store.blockHeldBase + i.blockBase, "heldBase");
  }
  // The block FREE STACK's region — where released blocks wait to be claimed
  // (srcProbes' age/compact passes push and pop it).
  if (stack) {
    out.stackBase = cascadeUniform(bins.cascades, (i) => store.blockStackBase + i.blockBase, "stackBase");
  }
  if (influx) {
    out.influxBase = cascadeUniform(bins.cascades, (i) => store.blockInfluxBase + i.blockBase, "influxBase");
  }
  if (surprise) {
    out.surpriseBase = cascadeUniform(bins.cascades, (i) => store.blockSurpriseBase + i.blockBase, "surpriseBase");
  }
  return out;
}
