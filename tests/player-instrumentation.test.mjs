/**
 * What a shipped player pays for, and the MSAA options three actually honours.
 *
 *   · Freeze ledger OFF at install (the player's default): the hot per-call
 *     device wrappers — writeBuffer, submit, createBindGroup, … — are not
 *     installed at all. The old code wrapped every one in rest-args + apply
 *     and bypassed inside. Two things riding the same install must survive:
 *     the async in-flight count (asyncRenderPipelines' busy gate reads it) and
 *     canonical WGSL (the browser shader cache keys on the text).
 *   · rendererConstructorOptions: three r185 folds `samples || antialias ? 4
 *     : 0`, and WebGPU has only 1× and 4×, so "2×"/"1×" silently meant 4×.
 *   · GPU timestamps are a host decision (player off) with a dev override.
 *   · TRAA is gated on the post scene pass's samples, not the renderer setting.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { freeze, installGpuCallLedger } from "../src/engine/freezeLedger.js";
import * as sceneSettings from "../src/engine/sceneSettings.js";

function fakeDevice(log) {
  return {
    queue: {
      writeBuffer(...args) { log.push(["writeBuffer", ...args.slice(3)]); },
      submit(buffers) { log.push(["submit", buffers]); },
      writeTexture() {},
      copyExternalImageToTexture() {},
    },
    createBindGroup() { return {}; },
    createBuffer() { return {}; },
    createTexture() { return {}; },
    createShaderModule(descriptor) { log.push(["module", descriptor.code]); return {}; },
    createRenderPipelineAsync() { return new Promise((resolve) => setTimeout(() => resolve({}), 20)); },
  };
}

test("ledger off at install: hot device calls stay unwrapped; in-flight count and canonical WGSL survive", async () => {
  const log = [];
  const device = fakeDevice(log);
  const hot = {
    writeBuffer: device.queue.writeBuffer,
    submit: device.queue.submit,
    createBindGroup: device.createBindGroup,
    createBuffer: device.createBuffer,
    createTexture: device.createTexture,
  };
  freeze.enabled = false;
  try {
    assert.equal(installGpuCallLedger(device), true);
    assert.equal(device.queue.writeBuffer, hot.writeBuffer, "writeBuffer must not be wrapped");
    assert.equal(device.queue.submit, hot.submit, "submit must not be wrapped");
    assert.equal(device.createBindGroup, hot.createBindGroup);
    assert.equal(device.createBuffer, hot.createBuffer);
    assert.equal(device.createTexture, hot.createTexture);

    const before = freeze.asyncInFlight.size;
    const pipeline = device.createRenderPipelineAsync({ label: "renderPipeline_x" });
    assert.equal(freeze.asyncInFlight.size, before + 1, "the busy gate still sees a pipeline in flight");
    await pipeline;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(freeze.asyncInFlight.size, before, "and sees it land");

    device.createShaderModule({ label: "compute_k", code: "var<storage> NodeBuffer_77 : array<u32>;" });
    assert.deepEqual(log.at(-1), ["module", "var<storage> NodeBuffer_0 : array<u32>;"], "WGSL is still canonicalised");
  } finally {
    freeze.enabled = true;
  }
});

test("ledger on: fixed-arity writeBuffer/submit pass every argument through and count bytes", () => {
  const log = [];
  const device = fakeDevice(log);
  freeze.enabled = true;
  freeze.logging = false;
  installGpuCallLedger(device);
  const writes = freeze.gpu.writes;
  const bytes = freeze.gpu.writeBytes;
  device.queue.writeBuffer({}, 0, new Float32Array(16), 4, 8);
  assert.deepEqual(log.at(-1), ["writeBuffer", 4, 8], "the optional tail reaches the device");
  assert.equal(freeze.gpu.writes, writes + 1);
  assert.equal(freeze.gpu.writeBytes - bytes, 32, "size is in elements for a typed view");
  device.queue.writeBuffer({}, 0, new Float32Array(16));
  assert.equal(freeze.gpu.writeBytes - bytes, 32 + 64);
  device.queue.submit(["cb"]);
  assert.deepEqual(log.at(-1), ["submit", ["cb"]]);
});

test("MSAA options hand three a count it honours (WebGPU: 1× or 4×)", () => {
  const opts = (renderer) => sceneSettings.rendererConstructorOptions({ renderer });
  // three r185 Renderer.js:275, precedence included.
  const threeSamples = ({ antialias, samples }) => ((samples || antialias === true) ? 4 : 0);
  assert.equal(threeSamples(opts({ antialias: true, samples: 1 })), 0, "1× is off, not 4×");
  assert.equal(threeSamples(opts({ antialias: true, samples: 2 })), 0, "2× does not exist on WebGPU");
  assert.deepEqual(
    [opts({ antialias: true, samples: 8 }).samples, opts({ antialias: true, samples: 8 }).antialias],
    [4, true],
    "8× clamps to 4×",
  );
  assert.equal(threeSamples(opts({})), 4, "defaults stay 4×");
  assert.deepEqual(
    [opts({ antialias: false, samples: 4 }).samples, opts({ antialias: false, samples: 4 }).antialias],
    [0, false],
  );
});

test("GPU timestamps: the host decides, the dev global overrides both ways", () => {
  const ts = (host) => sceneSettings.rendererConstructorOptions({ renderer: {} }, host).trackTimestamp;
  try {
    assert.equal(ts(undefined), true, "editor: on");
    assert.equal(ts({ trackTimestamp: false }), false, "player: off");
    globalThis.__engineTrackTimestamp = true;
    assert.equal(ts({ trackTimestamp: false }), true);
    globalThis.__engineTrackTimestamp = false;
    assert.equal(ts({ trackTimestamp: true }), false);
  } finally {
    delete globalThis.__engineTrackTimestamp;
  }
});

test("TRAA gate reads the scene pass's samples, not the renderer setting", () => {
  assert.equal(sceneSettings.passSampleCount({ samples: 1 }, 4), 1, "the post pass is 1× on a 4× renderer → TRAA allowed");
  assert.equal(sceneSettings.passSampleCount(undefined, 4), 4, "a pass with no samples option inherits the renderer (PassNode.setup)");
  assert.equal(sceneSettings.passSampleCount({ samples: 2 }, 0), 1, "WebGPU rounds 2 down");
});
