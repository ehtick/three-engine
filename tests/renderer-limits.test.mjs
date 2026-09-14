import test from "node:test";
import assert from "node:assert/strict";
import { resolveRendererLimits } from "../src/engine/sceneSettings.js";

/**
 * `resolveRendererLimits` is one function with one hard rule — NEVER ask for
 * more than the adapter advertises, because `requiredLimits` is a hard
 * requirement and `requestDevice` REJECTS on a miss, turning a working
 * renderer into no renderer at all. Nothing covered it until 2026-09-12, when
 * a limit it had never asked for (`maxSampledTexturesPerShaderStage`, baseline
 * 16) cost the Foliage scene every pipeline that touched it:
 *
 *   The number of sampled textures (17) in the Fragment stage exceeds the
 *   maximum per-stage limit (16). This adapter supports a higher
 *   maxSampledTexturesPerShaderStage of 48…
 *
 * A pipeline that fails at creation never becomes ready, so three caches
 * nothing for that material and re-mints its node graph forever — the editor
 * rebuilt "Foliage · living surface" 52 times while sitting idle. These tests
 * pin the two halves that matter: we ask for the headroom when it exists, and
 * we ask for nothing at all when it does not.
 */

/** Installs a fake `navigator.gpu` for one call and restores whatever was there. */
async function withAdapter(limits, fn) {
  const hadNavigator = "navigator" in globalThis;
  const previous = globalThis.navigator;
  const adapter = limits === null ? null : { limits, info: {} };
  // `navigator` is a getter-only global in newer Node, so define over it.
  Object.defineProperty(globalThis, "navigator", {
    value: { gpu: { requestAdapter: async () => adapter } },
    configurable: true,
    writable: true,
  });
  try {
    return await fn();
  } finally {
    if (hadNavigator) {
      Object.defineProperty(globalThis, "navigator", {
        value: previous,
        configurable: true,
        writable: true,
      });
    } else delete globalThis.navigator;
  }
}

/** Every limit at exactly the WebGPU baseline — the portable device. */
const BASELINE = {
  maxUniformBuffersPerShaderStage: 12,
  maxStorageTexturesPerShaderStage: 4,
  maxSampledTexturesPerShaderStage: 16,
  maxStorageBufferBindingSize: 134217728,
  maxBufferSize: 268435456,
  maxStorageBuffersPerShaderStage: 8,
};

/** A desktop discrete adapter, as reported by the NVIDIA Lovelace this was found on. */
const DESKTOP = {
  maxUniformBuffersPerShaderStage: 15,
  maxStorageTexturesPerShaderStage: 8,
  maxSampledTexturesPerShaderStage: 48,
  maxStorageBufferBindingSize: 2147483644,
  maxBufferSize: 2147483648,
  maxStorageBuffersPerShaderStage: 16,
};

test("a baseline adapter is asked for nothing — today's behaviour, unchanged", async () => {
  const { requiredLimits } = await withAdapter(BASELINE, resolveRendererLimits);
  assert.equal(requiredLimits, undefined, "a baseline device must get an empty ask");
});

test("no ask ever exceeds what the adapter advertises", async () => {
  for (const adapter of [BASELINE, DESKTOP]) {
    const { requiredLimits = {} } = await withAdapter(adapter, resolveRendererLimits);
    for (const [key, value] of Object.entries(requiredLimits)) {
      assert.ok(
        value <= adapter[key],
        `asked for ${key}=${value} from an adapter offering ${adapter[key]} — requestDevice would REJECT`,
      );
    }
  }
});

test("sampled textures: the headroom is requested when the adapter has it", async () => {
  const { requiredLimits } = await withAdapter(DESKTOP, resolveRendererLimits);
  assert.equal(
    requiredLimits.maxSampledTexturesPerShaderStage,
    32,
    "a 48-texture adapter should be asked for the engine's 32, not left on the baseline 16",
  );
});

test("sampled textures: an adapter at the baseline is not asked", async () => {
  const { requiredLimits = {} } = await withAdapter(
    { ...DESKTOP, maxSampledTexturesPerShaderStage: 16 },
    resolveRendererLimits,
  );
  assert.ok(
    !("maxSampledTexturesPerShaderStage" in requiredLimits),
    "asking a baseline-16 adapter for 16 is legal but pointless; the ask must stay absent",
  );
});

test("the harness cap lowers an ask and never raises one", async () => {
  const previous = globalThis.__engineLimitsCap;
  globalThis.__engineLimitsCap = {
    maxSampledTexturesPerShaderStage: 16,
    maxStorageBuffersPerShaderStage: 8,
  };
  try {
    const { requiredLimits } = await withAdapter(DESKTOP, resolveRendererLimits);
    assert.equal(requiredLimits.maxSampledTexturesPerShaderStage, 16);
    assert.equal(requiredLimits.maxStorageBuffersPerShaderStage, 8);
  } finally {
    if (previous === undefined) delete globalThis.__engineLimitsCap;
    else globalThis.__engineLimitsCap = previous;
  }
});

test("no WebGPU at all falls through to the baseline rather than throwing", async () => {
  const { requiredLimits } = await withAdapter(null, resolveRendererLimits);
  assert.equal(requiredLimits, undefined);
});
