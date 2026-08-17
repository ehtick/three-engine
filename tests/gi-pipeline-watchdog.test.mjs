// The §12.56 compute-pipeline watchdog re-rolls a `createComputePipelineAsync`
// that never settles. It shipped broken and stayed broken silently, because a
// failed re-roll looks exactly like the wedge it was trying to heal: the pass
// keeps being skipped and the console gains one more line.
//
// THE HAZARD, precisely: three does not hand `device.createComputePipeline` a
// fresh descriptor. `WebGPUPipelineUtils.createComputePipeline` fills a
// MODULE-LEVEL SINGLETON (`_computePipelineDescriptor`, class
// GPUComputePipelineDescriptor) and calls `.reset()` on the very next line —
// nulling `layout` and `compute`. GISystem's interceptor used to keep a
// reference to that object for the retry, so every retry re-asked the driver
// with `layout: null` and was rejected:
//
//   Failed to read the 'layout' property from 'GPUPipelineDescriptorBase':
//   The provided value 'null' is not a valid enum value of type GPUAutoLayoutMode
//
// This test drives the real interceptor with a fake backend/device that
// reproduces the reset, and asserts the retry sees a USABLE descriptor. No GPU,
// no browser — the bug is pure object lifetime.
import { strict as assert } from "node:assert";
import test from "node:test";

import { installAsyncComputePipelines } from "../src/modules/gi/GISystem.js";

/** three's reusable descriptor, reproduced field for field. */
class FakeComputePipelineDescriptor {
  constructor() {
    this.label = "";
    this.layout = null;
    this.compute = null;
  }
  reset() {
    this.label = "";
    this.layout = null;
    this.compute = null;
  }
}

function makeHarness() {
  const singleton = new FakeComputePipelineDescriptor();
  const asyncCalls = [];
  const store = new Map();

  const device = {
    createShaderModule: (desc) => ({ __module: desc?.label ?? "" }),
    createComputePipeline: () => ({ __sync: true }),
    createComputePipelineAsync(descriptor) {
      // Snapshot what the driver would actually have READ, synchronously —
      // exactly as WebGPU does — so a descriptor mutated afterwards cannot
      // launder a broken call into a passing assertion.
      asyncCalls.push({ label: descriptor?.label, layout: descriptor?.layout, compute: descriptor?.compute });
      return new Promise(() => {}); // THE WEDGE: never settles, ever.
    },
  };

  const backend = {
    device,
    get(key) {
      let data = store.get(key);
      if (!data) store.set(key, (data = {}));
      return data;
    },
    // Stands in for WebGPUPipelineUtils.createComputePipeline: fill the shared
    // descriptor, create, reset. The reset is the whole point of the fake.
    createComputePipeline(computePipeline, _bindings) {
      singleton.label = "computePipeline_compute_emitterShadowPass";
      singleton.compute = { module: device.createShaderModule({ label: "emitterShadow" }), entryPoint: "main" };
      singleton.layout = { __pipelineLayout: true };
      this.get(computePipeline).pipeline = device.createComputePipeline(singleton);
      singleton.reset();
    },
    compute() {},
  };

  const renderer = { backend, compute() {} };
  return { renderer, backend, device, singleton, asyncCalls };
}

test("a wedged pipeline is re-rolled with a descriptor the driver can actually read", async () => {
  const { renderer, backend, singleton, asyncCalls } = makeHarness();
  installAsyncComputePipelines(renderer);

  const pipeline = { id: 1 };
  backend.createComputePipeline(pipeline, []);

  // The fake must reproduce the hazard, or the test proves nothing.
  assert.equal(singleton.layout, null, "three's singleton descriptor must be reset after creation");
  assert.equal(asyncCalls.length, 1, "the interceptor should have gone async exactly once");
  assert.ok(asyncCalls[0].layout, "the FIRST create is synchronous with the fill, so it always had a layout");

  // Now make the pipeline look pending-forever and dispatch through it: the
  // skip path is where the watchdog lives.
  const previousRetryMs = globalThis.__giPipelineRetryMs;
  globalThis.__giPipelineRetryMs = 1;
  try {
    await new Promise((resolve) => setTimeout(resolve, 20)); // outlive the retry window
    backend.compute({}, { __giPassName: "emitterShadowPass" }, [], pipeline, [1, 1, 1]);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.__giPipelineRetryMs = previousRetryMs;
  }

  assert.equal(asyncCalls.length, 2, "the watchdog should have re-rolled the wedged pipeline");
  const reroll = asyncCalls[1];
  assert.ok(reroll.layout, "THE REGRESSION: the re-roll must carry a real layout, not the reset singleton's null");
  assert.ok(reroll.compute?.module, "the re-roll must carry the original compute stage");
  assert.equal(reroll.label, "computePipeline_compute_emitterShadowPass", "and the original label");
});

test("the retry descriptor is a copy, so a later reset of three's singleton cannot blank it", async () => {
  const { renderer, backend, singleton, asyncCalls } = makeHarness();
  installAsyncComputePipelines(renderer);

  const pipeline = { id: 2 };
  backend.createComputePipeline(pipeline, []);
  // A SECOND pipeline goes through the same singleton — under the old code
  // every pending entry aliased this one object, so one reset blanked them all.
  backend.createComputePipeline({ id: 3 }, []);
  singleton.reset();

  const previousRetryMs = globalThis.__giPipelineRetryMs;
  globalThis.__giPipelineRetryMs = 1;
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    backend.compute({}, { __giPassName: "srcGather" }, [], pipeline, [1, 1, 1]);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.__giPipelineRetryMs = previousRetryMs;
  }

  const reroll = asyncCalls.at(-1);
  assert.ok(reroll.layout, "the first pipeline's retry must survive a second pipeline reusing the singleton");
});

// ── THE THUNDERING HERD (Bistro, 2026-08-16) ────────────────────────────────
// The watchdog's quiet gate is evaluated PER PIPELINE, so on a boot where the
// whole wave is still pending it passes for every pipeline on the same tick.
// Measured live: 41 pipelines (src#16…src#56) re-rolled inside one millisecond,
// each one a duplicate compile handed to the driver that was already the
// bottleneck — which keeps it busy without settling anything, re-arms the gate,
// and earns attempts 2/3/4. 70 kernels became 591 pipeline compiles summing
// 3366 s, and the scene never finished loading.
test("a wave of wedged pipelines yields ONE re-roll per window, not one per pipeline", async () => {
  const { renderer, backend, asyncCalls } = makeHarness();
  installAsyncComputePipelines(renderer);

  const pipelines = [];
  for (let i = 0; i < 12; i++) {
    const pipeline = { id: 100 + i };
    pipelines.push(pipeline);
    backend.createComputePipeline(pipeline, []);
  }
  const afterCreates = asyncCalls.length;
  assert.equal(afterCreates, 12, "each pipeline goes async once on creation");

  const previousRetryMs = globalThis.__giPipelineRetryMs;
  globalThis.__giPipelineRetryMs = 1;
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Every one of them is dispatched and skipped on the same tick — the exact
    // shape of a boot wave where nothing has compiled yet.
    for (const pipeline of pipelines) {
      backend.compute({}, { __giPassName: "src" }, [], pipeline, [1, 1, 1]);
    }
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.__giPipelineRetryMs = previousRetryMs;
  }

  const rerolls = asyncCalls.length - afterCreates;
  assert.equal(
    rerolls,
    1,
    `THE REGRESSION: ${rerolls} re-rolls from one tick of 12 wedged pipelines — the lease must serialise them`,
  );
});

// The lease is a timestamp, not a boolean, because the re-roll of a wedged
// pipeline can itself never settle. A boolean would be taken once and never
// released, leaving the watchdog permanently disabled — a silent, page-lifetime
// version of the very wedge it exists to heal.
test("a re-roll that never settles does not disable the watchdog forever", async () => {
  const { renderer, backend, asyncCalls } = makeHarness();
  installAsyncComputePipelines(renderer);

  const first = { id: 200 };
  const second = { id: 201 };
  backend.createComputePipeline(first, []);
  backend.createComputePipeline(second, []);
  const afterCreates = asyncCalls.length;

  const previousRetryMs = globalThis.__giPipelineRetryMs;
  globalThis.__giPipelineRetryMs = 1;
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    backend.compute({}, { __giPassName: "src" }, [], first, [1, 1, 1]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asyncCalls.length - afterCreates, 1, "the first wedged pipeline re-rolls");

    // That re-roll never settles (the fake never does). Outlive the lease and
    // dispatch the OTHER wedged pipeline: it must still get its turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    backend.compute({}, { __giPassName: "src" }, [], second, [1, 1, 1]);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.__giPipelineRetryMs = previousRetryMs;
  }

  assert.equal(
    asyncCalls.length - afterCreates,
    2,
    "THE REGRESSION: the lease expired but no second re-roll fired — the watchdog is locked out",
  );
});
